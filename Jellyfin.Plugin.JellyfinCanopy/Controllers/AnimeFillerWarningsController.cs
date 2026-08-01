using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinCanopy.Data;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.AnimeFiller;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using MediaBrowser.Common.Api;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Controllers;

[Route("JellyfinCanopy/anime-filler")]
[ApiController]
public sealed class AnimeFillerWarningsController : JellyfinCanopyControllerBase
{
    // PERF(S2): recursive per-series enumeration is page-bounded. Only one page is
    // resident while the compact season-maximum numbering index is constructed.
    private const int SeriesEpisodePageSize = 256;

    private readonly ILibraryManager _libraryManager;
    private readonly AnimeFillerService _animeFillerService;
    private readonly IAnimeFillerProvider _provider;

    public AnimeFillerWarningsController(
        IHttpClientFactory httpClientFactory,
        ILogger<AnimeFillerWarningsController> logger,
        IUserManager userManager,
        ISeerrCache seerrCache,
        IPluginConfigProvider configProvider,
        ILibraryManager libraryManager,
        AnimeFillerService animeFillerService,
        IAnimeFillerProvider provider)
        : base(httpClientFactory, logger, userManager, seerrCache, configProvider)
    {
        _libraryManager = libraryManager;
        _animeFillerService = animeFillerService;
        _provider = provider;
    }

    /// <summary>Classifies up to 100 unique caller-visible Jellyfin episode IDs.</summary>
    [HttpPost("classifications")]
    [Authorize]
    [RequestSizeLimit(64 * 1024)]
    [Produces("application/json")]
    public async Task<IActionResult> Classify([FromBody] AnimeFillerBatchRequest? request)
    {
        var requestedIds = request?.ItemIds?.Where(value => !string.IsNullOrWhiteSpace(value)).ToArray() ?? [];
        var uniqueIds = requestedIds.Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        if (requestedIds.Length == 0) return BadRequest(new { message = "itemIds must contain at least one ID." });
        if (requestedIds.Length > 100 || uniqueIds.Length > 100) return BadRequest(new { message = "itemIds may contain at most 100 IDs." });

        var userId = UserHelper.GetCurrentUserId(User);
        var user = userId.HasValue ? _userManager.GetUserById(userId.Value) : null;
        if (user is null) return Forbid();

        var cancellationToken = HttpContext.RequestAborted;
        cancellationToken.ThrowIfCancellationRequested();
        var validItemIds = uniqueIds
            .Select(value => Guid.TryParse(value, out var itemId) ? itemId : Guid.Empty)
            .Where(itemId => itemId != Guid.Empty)
            .Distinct()
            .ToArray();
        var episodesById = GetCallerVisibleItems<Episode>(
            validItemIds,
            user,
            BaseItemKind.Episode,
            "episode",
            cancellationToken);
        var numberedEpisodes = episodesById.Values
            .Where(IsNumberedEpisode)
            .ToDictionary(episode => episode.Id);
        var seriesIds = numberedEpisodes.Values
            .Select(episode => episode.SeriesId)
            .Where(seriesId => seriesId != Guid.Empty)
            .Distinct()
            .ToArray();
        var seriesById = GetCallerVisibleItems<Series>(
            seriesIds,
            user,
            BaseItemKind.Series,
            "series",
            cancellationToken);

        var byId = new Dictionary<Guid, AnimeFillerItemResponse>();
        var mappings = _animeFillerService.GetMappings();
        var numberingBySeries = new Dictionary<Guid, AnimeFillerEpisodeNumbering?>();
        foreach (var itemId in validItemIds)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!numberedEpisodes.TryGetValue(itemId, out var episode))
            {
                byId[itemId] = Unknown(itemId.ToString(), "unavailable");
                continue;
            }

            // Do not trust the relationship object cached on the episode: it can be
            // incomplete, and it is not itself evidence that the caller can access the
            // parent. The distinct parent batch above resolves it through the same
            // caller-scoped library seam.
            if (!seriesById.TryGetValue(episode.SeriesId, out var series) || !IsAnime(series))
            {
                byId[itemId] = Unknown(itemId.ToString(), "not-recognized-as-anime");
                continue;
            }

            var seasonNumber = episode.ParentIndexNumber.GetValueOrDefault();
            var usesSeasonMapping = mappings.Seasons.ContainsKey((series.Id, seasonNumber));
            int? providerEpisode;
            if (usesSeasonMapping)
            {
                providerEpisode = episode.IndexNumber.GetValueOrDefault();
            }
            else
            {
                if (!numberingBySeries.TryGetValue(series.Id, out var numbering))
                {
                    numbering = LoadEpisodeNumbering(series, user, cancellationToken);
                    numberingBySeries[series.Id] = numbering;
                }

                providerEpisode = numbering?.Calculate(seasonNumber, episode.IndexNumber.GetValueOrDefault());
            }

            var identity = new AnimeSeriesIdentity(
                series.Id,
                seasonNumber,
                series.Name ?? string.Empty,
                series.ProductionYear,
                new Dictionary<string, string>(series.ProviderIds, StringComparer.OrdinalIgnoreCase));
            var classification = await _animeFillerService.ClassifyAsync(
                identity,
                providerEpisode,
                episode.Name,
                cancellationToken).ConfigureAwait(false);
            byId[itemId] = new AnimeFillerItemResponse(
                itemId.ToString(),
                classification.Classification.ToString(),
                classification.Reason,
                classification.MyAnimeListId,
                classification.SourceUrl);
        }

        return Ok(new AnimeFillerBatchResponse(requestedIds.Select(requestedId =>
        {
            if (!Guid.TryParse(requestedId, out var itemId)
                || !byId.TryGetValue(itemId, out var response))
            {
                return Unknown(requestedId, "unavailable");
            }

            return response with { ItemId = requestedId };
        }).ToArray()));
    }

    /// <summary>Returns non-secret configuration and mapping validation for administrators.</summary>
    [HttpGet("diagnostics")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [Produces("application/json")]
    public IActionResult Diagnostics()
    {
        var config = _configProvider.ConfigurationOrNull;
        if (config is null) return StatusCode(StatusCodes.Status503ServiceUnavailable);
        var mappings = _animeFillerService.GetMappings();
        return Ok(new
        {
            enabled = config.AnimeFillerWarningsEnabled,
            detectionMode = config.AnimeFillerDetectionMode,
            cacheHours = Math.Clamp(config.AnimeFillerCacheHours, 1, 168),
            seriesMappings = mappings.Series.Count,
            seasonMappings = mappings.Seasons.Count,
            mappingErrors = mappings.Errors,
            provider = "Jikan v4",
        });
    }

    /// <summary>Previews strict title candidates for an administrator configuring a manual mapping.</summary>
    [HttpGet("search")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [Produces("application/json")]
    public async Task<IActionResult> Search([FromQuery] string? title)
    {
        if (string.IsNullOrWhiteSpace(title) || title.Length > 200) return BadRequest(new { message = "title must be 1–200 characters." });
        try
        {
            var candidates = await _provider.SearchAsync(title, HttpContext.RequestAborted).ConfigureAwait(false);
            return Ok(new { candidates = candidates.Take(10) });
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !HttpContext.RequestAborted.IsCancellationRequested)
        {
            _logger.LogWarning(ex, "Anime provider diagnostic search failed.");
            return StatusCode(StatusCodes.Status503ServiceUnavailable, new { message = "Anime provider unavailable." });
        }
    }

    private bool IsAnime(Series series)
    {
        var config = _configProvider.ConfigurationOrNull;
        if (config?.AnimeFillerWarningsEnabled != true) return false;
        var hasProviderId = series.ProviderIds.Any(pair => IsSupportedPositiveProviderId(pair.Key, pair.Value));
        var hasLabel = (!string.IsNullOrWhiteSpace(config.AnimeFillerGenre)
                && series.Genres.Any(value => string.Equals(value, config.AnimeFillerGenre, StringComparison.OrdinalIgnoreCase)))
            || (!string.IsNullOrWhiteSpace(config.AnimeFillerTag)
                && series.Tags.Any(value => string.Equals(value, config.AnimeFillerTag, StringComparison.OrdinalIgnoreCase)));
        return config.AnimeFillerDetectionMode?.Trim().ToLowerInvariant() switch
        {
            "genreonly" => hasLabel,
            "provideridonly" => hasProviderId,
            _ => hasProviderId || hasLabel,
        };
    }

    private static bool IsSupportedPositiveProviderId(string key, string value)
        => (string.Equals(key, "AniList", StringComparison.OrdinalIgnoreCase)
                || string.Equals(key, "MyAnimeList", StringComparison.OrdinalIgnoreCase)
                || string.Equals(key, "MyAnimeListId", StringComparison.OrdinalIgnoreCase)
                || string.Equals(key, "MAL", StringComparison.OrdinalIgnoreCase))
            && int.TryParse(value, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var id)
            && id > 0;

    private IReadOnlyDictionary<Guid, T> GetCallerVisibleItems<T>(
        IReadOnlyCollection<Guid> itemIds,
        Jellyfin.Database.Implementations.Entities.User user,
        BaseItemKind itemKind,
        string itemDescription,
        CancellationToken cancellationToken)
        where T : BaseItem
    {
        if (itemIds.Count == 0) return new Dictionary<Guid, T>();
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            var query = UserAccessQuery.BuildItemIds(_libraryManager, user, itemIds);
            query.IncludeItemTypes = [itemKind];
            query.Limit = itemIds.Count;
            var requested = itemIds.ToHashSet();
            var items = _libraryManager.GetItemList(query)
                .OfType<T>()
                .Where(item => requested.Contains(item.Id))
                .GroupBy(item => item.Id)
                .ToDictionary(group => group.Key, group => group.First());
            cancellationToken.ThrowIfCancellationRequested();
            return items;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Caller-scoped anime {ItemDescription} batch lookup failed.", itemDescription);
            return new Dictionary<Guid, T>();
        }
    }

    private AnimeFillerEpisodeNumbering? LoadEpisodeNumbering(
        Series series,
        Jellyfin.Database.Implementations.Entities.User user,
        CancellationToken cancellationToken)
    {
        try
        {
            return AnimeFillerMappingParser.IndexAbsoluteEpisodeNumbers(
                EnumerateSeriesEpisodeNumbers(series.Id, user, cancellationToken));
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not prove absolute anime episode numbering for series {SeriesId}.", series.Id);
            return null;
        }
    }

    private IEnumerable<(int? Season, int? Episode)> EnumerateSeriesEpisodeNumbers(
        Guid seriesId,
        Jellyfin.Database.Implementations.Entities.User user,
        CancellationToken cancellationToken)
    {
        var startIndex = 0;
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var query = new InternalItemsQuery(user)
            {
                ParentId = seriesId,
                IncludeItemTypes = [BaseItemKind.Episode],
                Recursive = true,
                StartIndex = startIndex,
                Limit = SeriesEpisodePageSize,
                OrderBy =
                [
                    (ItemSortBy.ParentIndexNumber, JSortOrder.Ascending),
                    (ItemSortBy.IndexNumber, JSortOrder.Ascending),
                ],
            };
            var page = _libraryManager.GetItemList(query);
            cancellationToken.ThrowIfCancellationRequested();
            foreach (var episode in page.OfType<Episode>())
            {
                yield return (episode.ParentIndexNumber, episode.IndexNumber);
            }

            if (page.Count < SeriesEpisodePageSize) yield break;
            startIndex = checked(startIndex + page.Count);
        }
    }

    private static bool IsNumberedEpisode(Episode episode)
        => episode.ParentIndexNumber is > 0 && episode.IndexNumber is > 0;

    private static AnimeFillerItemResponse Unknown(string itemId, string reason) => new(itemId, nameof(AnimeEpisodeClassification.Unknown), reason, null, null);
}

public sealed record AnimeFillerBatchRequest(IReadOnlyList<string>? ItemIds);

public sealed record AnimeFillerBatchResponse(IReadOnlyList<AnimeFillerItemResponse> Items);

public sealed record AnimeFillerItemResponse(string ItemId, string Classification, string Reason, int? MyAnimeListId, string? SourceUrl);
