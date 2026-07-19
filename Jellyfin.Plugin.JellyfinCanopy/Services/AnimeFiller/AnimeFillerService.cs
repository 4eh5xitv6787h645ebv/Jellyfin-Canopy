using System.Globalization;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.AnimeFiller;

/// <summary>Bounded, single-flight classification core. Provider uncertainty always returns Unknown.</summary>
public sealed class AnimeFillerService
{
    private static readonly string[] MalKeys = ["MyAnimeList", "MyAnimeListId", "MAL"];
    private readonly IAnimeFillerProvider _provider;
    private readonly IPluginConfigProvider _configProvider;
    private readonly ILogger<AnimeFillerService> _logger;
    private readonly TimeProvider _timeProvider;
    private readonly BoundedTtlCache<int, CachedEpisodes> _episodeCache;
    private readonly BoundedTtlCache<string, CachedResolution> _resolutionCache;
    private readonly BoundedTtlCache<string, bool> _errorBackoff;
    private readonly BoundedSharedFlight<string, object?> _providerFlights;
    private readonly object _mappingsGate = new();
    private long _mappingsRevision = -1;
    private AnimeFillerMappings? _mappings;

    public AnimeFillerService(
        IAnimeFillerProvider provider,
        IPluginConfigProvider configProvider,
        ILogger<AnimeFillerService> logger)
        : this(provider, configProvider, logger, TimeProvider.System, 128)
    {
    }

    internal AnimeFillerService(
        IAnimeFillerProvider provider,
        IPluginConfigProvider configProvider,
        ILogger<AnimeFillerService> logger,
        TimeProvider timeProvider,
        int maximumActiveProviderKeys)
    {
        _provider = provider;
        _configProvider = configProvider;
        _logger = logger;
        _timeProvider = timeProvider;
        _episodeCache = new BoundedTtlCache<int, CachedEpisodes>(256, 256, timeProvider: timeProvider);
        _resolutionCache = new BoundedTtlCache<string, CachedResolution>(256, 256, comparer: StringComparer.Ordinal, timeProvider: timeProvider);
        _errorBackoff = new BoundedTtlCache<string, bool>(256, 256, comparer: StringComparer.Ordinal, timeProvider: timeProvider);
        _providerFlights = new BoundedSharedFlight<string, object?>(maximumActiveProviderKeys, StringComparer.Ordinal);
    }

    internal AnimeFillerMappings GetMappings()
    {
        var revision = _configProvider.ConfigurationRevision;
        lock (_mappingsGate)
        {
            if (_mappings is not null && _mappingsRevision == revision) return _mappings;
            _mappings = AnimeFillerMappingParser.Parse(_configProvider.ConfigurationOrNull?.AnimeFillerMappings);
            _mappingsRevision = revision;
            return _mappings;
        }
    }

    public async Task<AnimeFillerClassification> ClassifyAsync(
        AnimeSeriesIdentity identity,
        int providerEpisodeNumber,
        CancellationToken cancellationToken)
        => await ClassifyAsync(identity, providerEpisodeNumber, null, cancellationToken).ConfigureAwait(false);

    public async Task<AnimeFillerClassification> ClassifyAsync(
        AnimeSeriesIdentity identity,
        int? providerEpisodeNumber,
        string? episodeTitle,
        CancellationToken cancellationToken)
    {
        var config = _configProvider.ConfigurationOrNull;
        if (config?.AnimeFillerWarningsEnabled != true) return Unknown("disabled");
        var normalizedEpisodeTitle = AnimeFillerMappingParser.NormalizeTitle(episodeTitle);
        var hasExplicitEpisodeNumber = providerEpisodeNumber is > 0;
        if (!hasExplicitEpisodeNumber && normalizedEpisodeTitle.Length == 0) return Unknown("episode-number-unavailable");

        var mapping = GetMappings();
        int? malId;
        var transientResolutionFailure = false;
        string resolutionReason;
        if (mapping.TryResolve(identity.SeriesId, identity.SeasonNumber, out var manualMalId))
        {
            malId = manualMalId;
            resolutionReason = identity.SeasonNumber.HasValue && mapping.Seasons.ContainsKey((identity.SeriesId, identity.SeasonNumber.Value))
                ? "manual-season-mapping"
                : "manual-series-mapping";
        }
        else if (TryReadPositiveProviderId(identity.ProviderIds, MalKeys, out var providerMalId))
        {
            malId = providerMalId;
            resolutionReason = "mal-provider-id";
        }
        else
        {
            var hasAniListId = TryReadPositiveProviderId(identity.ProviderIds, ["AniList"], out _);
            if (string.Equals(config.AnimeFillerDetectionMode?.Trim(), "ProviderIdOnly", StringComparison.OrdinalIgnoreCase)
                && !hasAniListId)
            {
                return Unknown("series-match-unavailable");
            }

            var indirect = await ResolveIndirectAsync(identity, cancellationToken).ConfigureAwait(false);
            malId = indirect.MyAnimeListId;
            transientResolutionFailure = indirect.TransientFailure;
            resolutionReason = hasAniListId
                ? "anilist-provider-id"
                : "exact-title-match";
        }

        if (!malId.HasValue)
        {
            return Unknown(transientResolutionFailure ? "provider-unavailable" : "series-match-unavailable");
        }
        var episodes = await GetEpisodesAsync(malId.Value, config.AnimeFillerCacheHours, cancellationToken).ConfigureAwait(false);
        if (episodes is null) return Unknown("provider-unavailable");
        var resolvedEpisodeNumber = hasExplicitEpisodeNumber
            ? providerEpisodeNumber
            : episodes.EpisodeNumberByNormalizedTitle.TryGetValue(normalizedEpisodeTitle, out var titleMatchedEpisode)
                ? titleMatchedEpisode
                : (int?)null;
        if (!resolvedEpisodeNumber.HasValue) return Unknown("episode-number-unavailable");
        if (!episodes.FillerByEpisode.TryGetValue(resolvedEpisodeNumber.Value, out var filler)) return Unknown("episode-not-in-provider");
        return new AnimeFillerClassification(
            filler ? AnimeEpisodeClassification.Filler : AnimeEpisodeClassification.Canon,
            hasExplicitEpisodeNumber ? resolutionReason : resolutionReason + "+episode-title-match",
            malId,
            $"https://myanimelist.net/anime/{malId}/");
    }

    private async Task<SeriesResolution> ResolveIndirectAsync(AnimeSeriesIdentity identity, CancellationToken cancellationToken)
    {
        if (identity.Title.Length > 200) return new SeriesResolution(null, false);
        var key = BuildResolutionKey(identity);
        if (_resolutionCache.TryGet(key, out var cached)) return new SeriesResolution(cached.MyAnimeListId, false);
        if (_errorBackoff.TryGet("resolve:" + key, out _)) return new SeriesResolution(null, true);
        try
        {
            var flight = await _providerFlights.RunAsync("resolve:" + key, async sharedCancellationToken =>
            {
                using var operation = CancellationTokenSource.CreateLinkedTokenSource(sharedCancellationToken);
                operation.CancelAfter(TimeSpan.FromMinutes(2));
                int? resolved;
                if (TryReadPositiveProviderId(identity.ProviderIds, ["AniList"], out var aniListId))
                {
                    resolved = await _provider.ResolveAniListIdAsync(aniListId, operation.Token).ConfigureAwait(false);
                }
                else
                {
                    var candidates = await _provider.SearchAsync(identity.Title, operation.Token).ConfigureAwait(false);
                    resolved = AnimeFillerMappingParser.ChooseExactCandidate(identity.Title, identity.ProductionYear, candidates)?.MyAnimeListId;
                }

                _resolutionCache.Set(key, new CachedResolution(resolved), resolved.HasValue ? TimeSpan.FromHours(24) : TimeSpan.FromMinutes(30));
                return (object?)new SeriesResolution(resolved, false);
            }, cancellationToken).ConfigureAwait(false);
            if (!flight.Accepted)
            {
                _logger.LogWarning("Anime provider work capacity was exhausted; returning Unknown.");
                return new SeriesResolution(null, true);
            }

            return flight.Value as SeriesResolution ?? new SeriesResolution(null, true);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _errorBackoff.Set("resolve:" + key, true, TimeSpan.FromSeconds(30));
            _logger.LogWarning(ex, "Anime series resolution failed; returning Unknown.");
            return new SeriesResolution(null, true);
        }
    }

    private async Task<AnimeProviderEpisodes?> GetEpisodesAsync(int malId, int configuredHours, CancellationToken cancellationToken)
    {
        var now = _timeProvider.GetUtcNow();
        CachedEpisodes? lastGood = null;
        if (_episodeCache.TryGet(malId, out var cached))
        {
            if (cached.FreshUntil > now) return cached.Value;
            lastGood = cached;
        }

        if (_errorBackoff.TryGet("episodes:" + malId.ToString(CultureInfo.InvariantCulture), out _)) return lastGood?.Value;
        try
        {
            var flight = await _providerFlights.RunAsync(
                "episodes:" + malId.ToString(CultureInfo.InvariantCulture),
                async sharedCancellationToken =>
            {
                using var operation = CancellationTokenSource.CreateLinkedTokenSource(sharedCancellationToken);
                operation.CancelAfter(TimeSpan.FromMinutes(2));
                var fetched = await _provider.GetEpisodesAsync(malId, operation.Token).ConfigureAwait(false);
                if (fetched is null)
                {
                    _errorBackoff.Set("episodes:" + malId.ToString(CultureInfo.InvariantCulture), true, TimeSpan.FromSeconds(30));
                    return null;
                }
                var hours = Math.Clamp(configuredHours, 1, 168);
                _episodeCache.Set(malId, new CachedEpisodes(fetched, _timeProvider.GetUtcNow().AddHours(hours)), TimeSpan.FromDays(7));
                return (object?)fetched;
            }, cancellationToken).ConfigureAwait(false);
            if (!flight.Accepted)
            {
                _logger.LogWarning("Anime provider work capacity was exhausted for MAL {MalId}; returning last-good or Unknown.", malId);
                return lastGood?.Value;
            }

            return flight.Value as AnimeProviderEpisodes ?? lastGood?.Value;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _errorBackoff.Set("episodes:" + malId.ToString(CultureInfo.InvariantCulture), true, TimeSpan.FromSeconds(30));
            _logger.LogWarning(ex, "Anime episode classification fetch failed for MAL {MalId}; returning last-good or Unknown.", malId);
            return lastGood?.Value;
        }
    }

    private static bool TryReadPositiveProviderId(
        IReadOnlyDictionary<string, string> providerIds,
        IReadOnlyList<string> keys,
        out int id)
    {
        foreach (var key in keys)
        {
            var pair = providerIds.FirstOrDefault(candidate => string.Equals(candidate.Key, key, StringComparison.OrdinalIgnoreCase));
            if (pair.Key is not null && int.TryParse(pair.Value, NumberStyles.None, CultureInfo.InvariantCulture, out id) && id > 0) return true;
        }

        id = 0;
        return false;
    }

    private static string BuildResolutionKey(AnimeSeriesIdentity identity)
    {
        if (TryReadPositiveProviderId(identity.ProviderIds, ["AniList"], out var aniListId)) return "anilist:" + aniListId.ToString(CultureInfo.InvariantCulture);
        return "title:" + AnimeFillerMappingParser.NormalizeTitle(identity.Title) + ":" + (identity.ProductionYear?.ToString(CultureInfo.InvariantCulture) ?? "-");
    }

    private static AnimeFillerClassification Unknown(string reason) => new(AnimeEpisodeClassification.Unknown, reason);

    private sealed record CachedResolution(int? MyAnimeListId);

    private sealed record SeriesResolution(int? MyAnimeListId, bool TransientFailure);

    private sealed record CachedEpisodes(AnimeProviderEpisodes Value, DateTimeOffset FreshUntil);
}
