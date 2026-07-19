using Jellyfin.Data.Enums;
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

        var byId = new Dictionary<string, AnimeFillerItemResponse>(StringComparer.OrdinalIgnoreCase);
        var mappings = _animeFillerService.GetMappings();
        foreach (var requestedId in uniqueIds)
        {
            if (!Guid.TryParse(requestedId, out var itemId))
            {
                byId[requestedId] = Unknown(requestedId, "unavailable");
                continue;
            }

            Episode? episode = null;
            try
            {
                episode = _libraryManager.GetItemById<BaseItem>(itemId, user) as Episode;
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "Caller-scoped anime episode lookup failed.");
            }

            if (episode is null || episode.ParentIndexNumber is null || episode.ParentIndexNumber <= 0 || episode.IndexNumber is null || episode.IndexNumber <= 0)
            {
                byId[requestedId] = Unknown(requestedId, "unavailable");
                continue;
            }

            Series? series = null;
            try
            {
                // Do not trust the relationship object cached on the episode: it can be
                // incomplete, and it is not itself evidence that the caller can access the
                // parent. Resolve the series through the same caller-scoped library seam.
                series = _libraryManager.GetItemById<BaseItem>(episode.SeriesId, user) as Series;
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "Caller-scoped anime series lookup failed.");
            }

            if (series is null || !IsAnime(series))
            {
                byId[requestedId] = Unknown(requestedId, "not-recognized-as-anime");
                continue;
            }

            var seasonNumber = episode.ParentIndexNumber.Value;
            var usesSeasonMapping = mappings.Seasons.ContainsKey((series.Id, seasonNumber));
            var providerEpisode = usesSeasonMapping
                ? episode.IndexNumber.Value
                : CalculateAbsoluteEpisodeNumber(series, episode, user);
            if (providerEpisode is null)
            {
                byId[requestedId] = Unknown(requestedId, "episode-number-unavailable");
                continue;
            }

            var identity = new AnimeSeriesIdentity(
                series.Id,
                seasonNumber,
                series.Name ?? string.Empty,
                series.ProductionYear,
                new Dictionary<string, string>(series.ProviderIds, StringComparer.OrdinalIgnoreCase));
            var classification = await _animeFillerService.ClassifyAsync(identity, providerEpisode.Value, HttpContext.RequestAborted).ConfigureAwait(false);
            byId[requestedId] = new AnimeFillerItemResponse(
                requestedId,
                classification.Classification.ToString(),
                classification.Reason,
                classification.MyAnimeListId,
                classification.SourceUrl);
        }

        return Ok(new AnimeFillerBatchResponse(requestedIds.Select(id => byId[id]).ToArray()));
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

    private int? CalculateAbsoluteEpisodeNumber(Series series, Episode current, Jellyfin.Database.Implementations.Entities.User user)
    {
        try
        {
            var query = new InternalItemsQuery(user)
            {
                ParentId = series.Id,
                IncludeItemTypes = [BaseItemKind.Episode],
                Recursive = true,
            };
            var libraryEpisodes = _libraryManager.GetItemList(query)
                .OfType<Episode>()
                .Select(episode => (episode.ParentIndexNumber, episode.IndexNumber));
            // A completely absent prior season makes absolute numbering unprovable.
            // Virtual episodes are included by the recursive query and close normal file gaps.
            return AnimeFillerMappingParser.CalculateAbsoluteEpisodeNumber(
                current.ParentIndexNumber!.Value,
                current.IndexNumber!.Value,
                libraryEpisodes);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not prove absolute anime episode numbering for series {SeriesId}.", series.Id);
            return null;
        }
    }

    private static AnimeFillerItemResponse Unknown(string itemId, string reason) => new(itemId, nameof(AnimeEpisodeClassification.Unknown), reason, null, null);
}

public sealed record AnimeFillerBatchRequest(IReadOnlyList<string>? ItemIds);

public sealed record AnimeFillerBatchResponse(IReadOnlyList<AnimeFillerItemResponse> Items);

public sealed record AnimeFillerItemResponse(string ItemId, string Classification, string Reason, int? MyAnimeListId, string? SourceUrl);
