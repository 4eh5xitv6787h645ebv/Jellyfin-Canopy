using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Querying;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Model.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Services.AutoRequest;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Microsoft.Extensions.Logging;
namespace Jellyfin.Plugin.JellyfinCanopy.Services
{
    public class AutoSeasonRequestService
    {
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly ILogger<AutoSeasonRequestService> _logger;
        private readonly IPluginConfigProvider _configProvider;
        private readonly IUserManager _userManager;
        private readonly IUserDataManager _userDataManager;
        private readonly ILibraryManager _libraryManager;

        // In-memory cache of recently requested seasons to avoid duplicates (keyed by tmdbId_seasonNumber, global across all users)
        private static readonly TimeSpan RequestReservationTtl = TimeSpan.FromHours(1);
        private readonly BoundedTtlCache<string, byte> _requestedSeasons = new(
            maximumEntries: 16_384,
            maximumWeight: 16_384,
            comparer: StringComparer.Ordinal,
            defaultTtl: () => RequestReservationTtl);
        private readonly object _requestCacheLock = new();
        private readonly Seerr.ISeerrClient _seerrClient;
        private readonly ISeerrParentalFilter _parentalFilter;
        private readonly BoundedTtlCache<string, string> _seriesDetailsCache = new(
            maximumEntries: 256,
            maximumWeight: 16L * 1024 * 1024,
            weight: static (key, content) => Encoding.UTF8.GetByteCount(key) + Encoding.UTF8.GetByteCount(content),
            comparer: StringComparer.Ordinal);
        private readonly object _seriesDetailsCacheLock = new();
        private readonly ConcurrentDictionary<string, Lazy<Task<string?>>> _seriesDetailsInFlight = new();

        public AutoSeasonRequestService(
            IHttpClientFactory httpClientFactory,
            ILogger<AutoSeasonRequestService> logger,
            IUserManager userManager,
            IUserDataManager userDataManager,
            ILibraryManager libraryManager,
            IPluginConfigProvider configProvider,
            Seerr.ISeerrClient seerrClient,
            ISeerrParentalFilter parentalFilter)
        {
            _httpClientFactory = httpClientFactory;
            _logger = logger;
            _userManager = userManager;
            _userDataManager = userDataManager;
            _libraryManager = libraryManager;
            _configProvider = configProvider;
            _seerrClient = seerrClient;
            _parentalFilter = parentalFilter;
        }

        private static string[] GetConfiguredUrls(string? urls)
        {
            return Seerr.SeerrClient.GetConfiguredUrls(urls);
        }

        internal Task<string?> GetSeriesDetailsJsonAsync(string tmdbId, string seerrSourceUrl)
        {
            var integration = SeerrIntegrationPolicy.Capture(_configProvider);
            return !integration.IsActive
                ? Task.FromResult<string?>(null)
                : GetSeriesDetailsJsonAsync(
                    tmdbId,
                    seerrSourceUrl,
                    integration.Configuration!,
                    integration.ConfigurationStamp);
        }

        private async Task<string?> GetSeriesDetailsJsonAsync(
            string tmdbId,
            string seerrSourceUrl,
            PluginConfiguration config,
            SeerrMutationConfigStamp operationConfigStamp)
        {
            if (!operationConfigStamp.Matches(
                    _configProvider.ConfigurationOrNull,
                    _configProvider.ConfigurationRevision))
            {
                return null;
            }

            // Snapshot every input used by the request. PluginConfiguration is
            // mutable, so retaining the object itself would allow an in-place
            // admin edit to change the credential underneath an existing flight.
            var configRevision = _configProvider.ConfigurationRevision;
            var configStamp = SeerrMutationConfigStamp.Capture(config, configRevision);
            var configuredUrls = config.SeerrUrls;
            var apiKey = config.SeerrApiKey;
            var cacheEnabled = !config.SeerrDisableCache;
            var cacheTtl = TimeSpan.FromMinutes(Math.Max(1, config.SeerrResponseCacheTtlMinutes));
            var configFingerprint = ComputeConfigurationFingerprint(config);

            bool IsCapturedConfigurationCurrent()
            {
                var current = _configProvider.ConfigurationOrNull;
                var revision = _configProvider.ConfigurationRevision;
                return operationConfigStamp.Matches(current, revision)
                    && configStamp.Matches(current, revision)
                    && SeerrIntegrationPolicy.HasUsableSavedConfiguration(current);
            }

            if (!IsCapturedConfigurationCurrent())
            {
                return null;
            }

            var pinnedSource = FindConfiguredSource(configuredUrls, seerrSourceUrl);
            if (pinnedSource == null)
            {
                _logger.LogWarning("[Auto-Season-Request] The linked Seerr instance is no longer configured; no series-details lookup was attempted");
                return null;
            }

            // The TV detail contains instance-local media/request state. Neither
            // the cached response nor a shared in-flight task may cross sources
            // or configuration generations. The opaque full-config digest also
            // partitions in-place edits for which the object revision is stable.
            var cacheKey = BuildSourceScopedKey(
                pinnedSource,
                $"{configRevision}:{configFingerprint}:{tmdbId}");

            if (cacheEnabled)
            {
                lock (_seriesDetailsCacheLock)
                {
                    if (_seriesDetailsCache.TryGetValue(cacheKey, out var cached) &&
                        IsCapturedConfigurationCurrent())
                    {
                        return cached;
                    }
                }
            }

            BoundedTtlCache<string, string>.CacheToken publication = default;

            async Task<string?> FetchAsync()
            {
                // A queued single-flight delegate may start after the operation
                // that created it has been disabled. Recheck at the transport
                // edge instead of trusting retained credentials in the closure.
                if (!IsCapturedConfigurationCurrent())
                {
                    return null;
                }

                var httpClient = Helpers.Seerr.SeerrHttpHelper.CreateClient(_httpClientFactory);

                try
                {
                    var requestUrl = $"{pinnedSource}/api/v1/tv/{tmdbId}";
                    using var request = Helpers.Seerr.SeerrHttpHelper.BuildRequest(
                        HttpMethod.Get, requestUrl, apiKey);
                    var (content, error, _) = await Helpers.Seerr.SeerrHttpHelper.SendAndReadJsonAsync(
                        httpClient,
                        request,
                        requestUrl);
                    if (error != null)
                    {
                        _logger.LogDebug($"[Auto-Season-Request] Series details fetch for TMDB {tmdbId} failed: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay}");
                        return null;
                    }

                    return IsCapturedConfigurationCurrent() ? content : null;
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    _logger.LogDebug($"[Auto-Season-Request] Error checking Seerr at {pinnedSource}: {ex.Message}");
                }

                return null;
            }

            string? content;
            if (cacheEnabled)
            {
                async Task<string?> FetchAndCacheAsync()
                {
                    var fetchedContent = await FetchAsync().ConfigureAwait(false);
                    if (!string.IsNullOrEmpty(fetchedContent) &&
                        IsCapturedConfigurationCurrent())
                    {
                        // Cache publication is part of the shared flight, so
                        // removal cannot expose a miss before the result lands.
                        lock (_seriesDetailsCacheLock)
                        {
                            _seriesDetailsCache.TrySet(cacheKey, fetchedContent, cacheTtl, out publication);
                        }
                    }

                    return fetchedContent;
                }

                var task = Helpers.AsyncSingleFlight.GetOrAdd(
                    _seriesDetailsInFlight,
                    cacheKey,
                    FetchAndCacheAsync);
                content = await task.ConfigureAwait(false);
            }
            else
            {
                content = await FetchAsync();
            }

            if (!IsCapturedConfigurationCurrent())
            {
                // A generation change can occur after the flight's publication
                // check but before this waiter resumes. Its generation-specific
                // entry is no longer usable and must not survive for an A→B→A
                // transition within this service instance.
                lock (_seriesDetailsCacheLock)
                {
                    _seriesDetailsCache.Remove(publication);
                }

                return null;
            }

            return content;
        }

        private static string ComputeConfigurationFingerprint(PluginConfiguration configuration)
            => Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(configuration)));

        // Checks a completed episode to determine if next season should be requested.
        // Event-driven entry point called when a user finishes or starts watching an episode.
        public async Task<AutoRequestPlaybackOutcome> CheckEpisodeCompletionAsync(
            BaseItem episodeItem,
            Guid userId)
        {
            var config = _configProvider.ConfigurationOrNull;
            if (config == null
                || !config.AutoSeasonRequestEnabled
                || !SeerrIntegrationPolicy.HasUsableSavedConfiguration(config))
            {
                return AutoRequestPlaybackOutcome.DefinitiveNoop;
            }

            var user = _userManager.GetUserById(userId);
            if (user == null)
            {
                return AutoRequestPlaybackOutcome.DefinitiveNoop;
            }

            // Get the series this episode belongs to
            var episode = episodeItem as Episode;
            if (episode == null || episode.Series == null || !episode.ParentIndexNumber.HasValue || !episode.IndexNumber.HasValue)
            {
                return AutoRequestPlaybackOutcome.DefinitiveNoop;
            }

            var series = episode.Series;
            var seasonNumber = episode.ParentIndexNumber.Value;
            var episodeNumber = episode.IndexNumber.Value;

            _logger.LogInformation($"[Auto-Season-Request] Checking '{series.Name}' S{seasonNumber}E{episodeNumber}");

            // Check this specific season for auto-season-request, passing the current episode number
            return await CheckSeasonForAutoRequest(
                series,
                seasonNumber,
                episodeNumber,
                user).ConfigureAwait(false);
        }

        // Checks if a specific season needs its next season requested
        internal async Task<AutoRequestPlaybackOutcome> CheckSeasonForAutoRequest(
            Series series,
            int currentSeasonNumber,
            int currentEpisodeNumber,
            JUser user)
        {
            var config = _configProvider.ConfigurationOrNull;
            if (config == null
                || !config.AutoSeasonRequestEnabled
                || !SeerrIntegrationPolicy.HasUsableSavedConfiguration(config))
            {
                return AutoRequestPlaybackOutcome.DefinitiveNoop;
            }

            var mutationConfigStamp = SeerrMutationConfigStamp.Capture(
                config,
                _configProvider.ConfigurationRevision);

            // Get TMDB ID first - we'll need it for Seerr checks
            var tmdbId = GetTmdbId(series);
            if (string.IsNullOrEmpty(tmdbId))
            {
                _logger.LogWarning($"[Auto-Season-Request] Could not find TMDB ID for series '{series.Name}'");
                return AutoRequestPlaybackOutcome.DefinitiveNoop;
            }

            // Resolve once before the first Seerr read. Seerr user ids, media
            // state and request ids belong to one source and cannot be replayed
            // against whichever configured instance happens to answer first.
            var seerrBinding = await ResolvePinnedSeerrUserAsync(user.Id.ToString(), config).ConfigureAwait(false);
            if (!seerrBinding.HasValue)
            {
                return AutoRequestPlaybackOutcome.RetryableFailure;
            }

            var (seerrUser, seerrSourceUrl) = seerrBinding.Value;

            // Get the total episode count for this season from TMDB/Seerr
            var totalEpisodesInSeason = await GetTotalEpisodesInSeasonFromTmdb(
                tmdbId,
                currentSeasonNumber,
                seerrSourceUrl,
                config,
                mutationConfigStamp);
            if (totalEpisodesInSeason == null || totalEpisodesInSeason <= 0)
            {
                _logger.LogWarning($"[Auto-Season-Request] Could not determine total episodes for '{series.Name}' S{currentSeasonNumber} from TMDB");
                return AutoRequestPlaybackOutcome.RetryableFailure;
            }

            // Calculate remaining episodes based on current episode position and TMDB total
            // If watching E8 out of 15 total episodes, remaining = 15 - 8 = 7 episodes left
            var remainingAfterCurrent = totalEpisodesInSeason.Value - currentEpisodeNumber;
            if (remainingAfterCurrent < 0) remainingAfterCurrent = 0;

            // Query episodes in Jellyfin for "require all watched" check if needed
            var availableEpisodesInJellyfin = 0;
            List<Episode> allEpisodes = new List<Episode>();

            if (config.AutoSeasonRequestRequireAllWatched)
            {
                var episodesQuery = new InternalItemsQuery(user)
                {
                    AncestorIds = new[] { series.Id },
                    IncludeItemTypes = new[] { BaseItemKind.Episode },
                    Recursive = true,
                    OrderBy = new[] { (ItemSortBy.ParentIndexNumber, JSortOrder.Ascending), (ItemSortBy.IndexNumber, JSortOrder.Ascending) }
                };

                allEpisodes = _libraryManager.GetItemsResult(episodesQuery).Items
                    .OfType<Episode>()
                    .Where(e => e.ParentIndexNumber == currentSeasonNumber)
                    .OrderBy(e => e.IndexNumber)
                    .ToList();

                availableEpisodesInJellyfin = allEpisodes.Count;
            }

            _logger.LogInformation($"[Auto-Season-Request] Season {currentSeasonNumber}: E{currentEpisodeNumber}/{totalEpisodesInSeason} (TMDB total), {availableEpisodesInJellyfin} available in Jellyfin, {remainingAfterCurrent} episodes remaining after current (threshold: {config.AutoSeasonRequestThresholdValue})");

            // Check if threshold is met
            bool thresholdMet = remainingAfterCurrent <= config.AutoSeasonRequestThresholdValue;

            if (!thresholdMet)
            {
                _logger.LogDebug($"[Auto-Season-Request] Threshold not met for '{series.Name}' S{currentSeasonNumber}");
                return AutoRequestPlaybackOutcome.DefinitiveNoop;
            }

            // If "Require All Episodes Watched" is enabled, verify all episodes before the threshold are watched
            bool shouldRequest = true;
            if (config.AutoSeasonRequestRequireAllWatched)
            {
                // Check that all episodes before the current one are marked as watched
                var episodesBeforeCurrent = allEpisodes.Where(e => e.IndexNumber.HasValue && e.IndexNumber.Value < currentEpisodeNumber).ToList();
                var unwatchedBeforeCurrent = episodesBeforeCurrent.Where(e =>
                {
                    var userData = _userDataManager.GetUserData(user, e);
                    return userData == null || !userData.Played;
                }).ToList();

                if (unwatchedBeforeCurrent.Any())
                {
                    shouldRequest = false;
                    var unwatchedEpisodeNumbers = string.Join(", ", unwatchedBeforeCurrent.Select(e => $"E{e.IndexNumber}"));
                    _logger.LogDebug($"[Auto-Season-Request] Threshold met but not all prior episodes watched for '{series.Name}' S{currentSeasonNumber}. Unwatched: {unwatchedEpisodeNumbers}");
                }
                else
                {
                    _logger.LogInformation($"[Auto-Season-Request] Threshold met and all prior episodes watched for '{series.Name}' S{currentSeasonNumber} - requesting next season");
                }
            }

            if (!shouldRequest)
            {
                return AutoRequestPlaybackOutcome.DefinitiveNoop;
            }

            // Threshold met - prepare to request next season
            var nextSeasonNumber = currentSeasonNumber + 1;

            // Check in-memory cache first (fast path to avoid redundant API calls)
            // Uses a sentinel pattern: write the entry before async work so concurrent
            // callers see it immediately, then remove on failure to allow retries.
            var cacheKey = BuildSourceScopedKey(
                seerrSourceUrl,
                $"{tmdbId}:S{nextSeasonNumber}");
            BoundedTtlCache<string, byte>.CacheToken reservation;
            lock (_requestCacheLock)
            {
                if (_requestedSeasons.ContainsKey(cacheKey))
                {
                    _logger.LogDebug($"[Auto-Season-Request] Already requested S{nextSeasonNumber} for TMDB {tmdbId} (cached)");
                    return AutoRequestPlaybackOutcome.DefinitiveNoop;
                }

                // Reserve the slot so concurrent callers see it immediately
                _requestedSeasons.TrySet(cacheKey, 0, out reservation);
            }

            void ReleaseReservation()
            {
                lock (_requestCacheLock)
                {
                    _requestedSeasons.Remove(reservation);
                }
            }

            try
            {
                // Get episode count for next season to verify it has started.
                var nextSeasonEpisodeCount = await GetTotalEpisodesInSeasonFromTmdb(
                    tmdbId,
                    nextSeasonNumber,
                    seerrSourceUrl,
                    config,
                    mutationConfigStamp).ConfigureAwait(false);

                if (nextSeasonEpisodeCount == null || nextSeasonEpisodeCount <= 0)
                {
                    _logger.LogInformation($"[Auto-Season-Request] Season {nextSeasonNumber} has not started yet (0 episodes) - not requesting");
                    // Drop the sentinel so the next check re-evaluates instead
                    // of being stuck for an hour after TMDB adds season data.
                    ReleaseReservation();
                    return AutoRequestPlaybackOutcome.RetryableFailure;
                }

                // Always query Seerr to get the latest season state.
                var seerrStatus = await GetSeasonStatusFromSeerr(
                    tmdbId,
                    nextSeasonNumber,
                    seerrSourceUrl,
                    config,
                    mutationConfigStamp).ConfigureAwait(false);

                if (seerrStatus == null)
                {
                    _logger.LogDebug($"[Auto-Season-Request] Season {nextSeasonNumber} does not exist for '{series.Name}' (not available on TMDB)");
                    ReleaseReservation();
                    return AutoRequestPlaybackOutcome.RetryableFailure;
                }

                if (seerrStatus.IsAvailable)
                {
                    _logger.LogDebug($"[Auto-Season-Request] Season {nextSeasonNumber} already available on Jellyfin for '{series.Name}'");
                    return AutoRequestPlaybackOutcome.DefinitiveNoop;
                }

                if (seerrStatus.IsRequested)
                {
                    _logger.LogDebug($"[Auto-Season-Request] Season {nextSeasonNumber} already requested in Seerr for '{series.Name}'");
                    return AutoRequestPlaybackOutcome.DefinitiveNoop;
                }

                // Season exists, is unavailable, and has not been requested.
                var outcome = await RequestNextSeason(
                    tmdbId,
                    nextSeasonNumber,
                    user.Id.ToString(),
                    user.HasPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.IsAdministrator),
                    seerrUser,
                    seerrSourceUrl,
                    mutationConfigStamp).ConfigureAwait(false);

                if (outcome == AutoRequestDispatchOutcome.Succeeded)
                {
                    _logger.LogInformation($"[Auto-Season-Request] ✓ Requested '{series.Name}' S{nextSeasonNumber} (TMDB: {tmdbId}) for {user.Username}");
                    return AutoRequestPlaybackOutcome.Committed;
                }

                if (outcome == AutoRequestDispatchOutcome.NotAttempted)
                {
                    // Preparation failed before dispatch, so retrying cannot
                    // replay a possibly committed non-idempotent request.
                    ReleaseReservation();
                    _logger.LogWarning($"[Auto-Season-Request] ✗ Failed to request '{series.Name}' S{nextSeasonNumber} for {user.Username}");
                    return AutoRequestPlaybackOutcome.RetryableFailure;
                }

                _logger.LogWarning($"[Auto-Season-Request] Request outcome for '{series.Name}' S{nextSeasonNumber} is ambiguous; retaining the cooldown reservation to prevent replay");
                return AutoRequestPlaybackOutcome.Committed;
            }
            catch (OperationCanceledException)
            {
                ReleaseReservation();
                return AutoRequestPlaybackOutcome.Cancelled;
            }
            catch
            {
                ReleaseReservation();
                throw;
            }
        }

        // Gets the total number of episodes in a season from TMDB
        private async Task<int?> GetTotalEpisodesInSeasonFromTmdb(
            string tmdbId,
            int seasonNumber,
            string seerrSourceUrl,
            PluginConfiguration config,
            SeerrMutationConfigStamp mutationConfigStamp)
        {
            if (!mutationConfigStamp.Matches(
                    _configProvider.ConfigurationOrNull,
                    _configProvider.ConfigurationRevision))
            {
                return null;
            }

            try
            {
                var content = await GetSeriesDetailsJsonAsync(
                    tmdbId,
                    seerrSourceUrl,
                    config,
                    mutationConfigStamp);
                if (string.IsNullOrEmpty(content))
                {
                    return null;
                }

                using (JsonDocument doc = JsonDocument.Parse(content))
                {
                    var root = doc.RootElement;

                    if (TryReadTmdbSeasonEpisodeCount(root, seasonNumber, out var episodeCount))
                    {
                        _logger.LogInformation($"[Auto-Season-Request] TMDB reports {episodeCount} episodes in season {seasonNumber}");
                        return episodeCount;
                    }
                }

                _logger.LogWarning($"[Auto-Season-Request] Season {seasonNumber} was absent, duplicated, or malformed in TMDB season metadata; refusing to infer that it is requestable");
                return null;
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"[Auto-Season-Request] Error querying TMDB episode count: {ex.Message}");
            }

            return null;
        }

        // Seerr season status
        private class SeasonStatus
        {
            public bool IsAvailable { get; set; }
            public bool IsRequested { get; set; }
        }

        // These are MediaStatus values from Seerr's persisted media/season
        // model. They are deliberately separate from MediaRequestStatus (whose
        // value 5 means COMPLETED rather than AVAILABLE).
        private enum SeerrMediaAvailabilityStatus
        {
            Unknown = 1,
            Pending = 2,
            Processing = 3,
            PartiallyAvailable = 4,
            Available = 5,
            Blocklisted = 6,
            Deleted = 7,
        }

        // Seerr's MediaRequestStatus is a different persistence enum from
        // MediaStatus. Declined/completed historical requests do not block a
        // new request; pending/approved/failed requests still do.
        private enum SeerrMediaRequestStatus
        {
            Pending = 1,
            Approved = 2,
            Declined = 3,
            Failed = 4,
            Completed = 5,
        }

        // Gets season status from Seerr - always fetches fresh to ensure accurate request/availability state
        private async Task<SeasonStatus?> GetSeasonStatusFromSeerr(
            string tmdbId,
            int seasonNumber,
            string seerrSourceUrl,
            PluginConfiguration config,
            SeerrMutationConfigStamp mutationConfigStamp)
        {
            try
            {
                var pinnedSource = FindConfiguredSource(config.SeerrUrls, seerrSourceUrl);
                if (pinnedSource == null)
                {
                    _logger.LogWarning("[Auto-Season-Request] The linked Seerr instance is no longer configured; no season-status lookup was attempted");
                    return null;
                }

                // The preceding series-details read can be in flight while the
                // integration is disabled. Fence this distinct status request
                // with the original generation immediately before transport.
                if (!mutationConfigStamp.Matches(
                        _configProvider.ConfigurationOrNull,
                        _configProvider.ConfigurationRevision))
                {
                    return null;
                }

                var httpClient = Helpers.Seerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
                var requestUrl = $"{pinnedSource}/api/v1/tv/{tmdbId}";
                using var statusRequest = Helpers.Seerr.SeerrHttpHelper.BuildRequest(
                    HttpMethod.Get, requestUrl, config.SeerrApiKey);
                var (content, error, _) = await Helpers.Seerr.SeerrHttpHelper.SendAndReadJsonAsync(
                    httpClient,
                    statusRequest,
                    requestUrl);
                if (error != null)
                {
                    _logger.LogDebug($"[Auto-Season-Request] Status check for TMDB {tmdbId} failed: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay}");
                    return null;
                }

                if (string.IsNullOrEmpty(content))
                {
                    return null;
                }

                using (JsonDocument doc = JsonDocument.Parse(content))
                {
                    var root = doc.RootElement;

                    if (TryReadSeerrSeasonState(root, seasonNumber, out var status))
                    {
                        _logger.LogInformation($"[Auto-Season-Request] Season {seasonNumber} final status from Seerr: Available={status.IsAvailable}, RequestedOrBlocked={status.IsRequested}");
                        return status;
                    }
                }

                _logger.LogWarning($"[Auto-Season-Request] Season {seasonNumber} had absent, malformed, or conflicting TMDB/media state in the Seerr response; no request was attempted");
                return null;
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"[Auto-Season-Request] Error querying Seerr: {ex.Message}");
            }

            return null;
        }

        private static bool TryReadTmdbSeasonEpisodeCount(
            JsonElement root,
            int seasonNumber,
            out int episodeCount)
        {
            episodeCount = 0;
            if (root.ValueKind != JsonValueKind.Object || seasonNumber <= 0 ||
                !root.TryGetProperty("numberOfSeasons", out var totalSeasonsElement) ||
                totalSeasonsElement.ValueKind != JsonValueKind.Number ||
                !totalSeasonsElement.TryGetInt32(out var totalSeasons) ||
                totalSeasons < 0 ||
                seasonNumber > totalSeasons ||
                !root.TryGetProperty("seasons", out var seasonsElement) ||
                seasonsElement.ValueKind != JsonValueKind.Array)
            {
                return false;
            }

            var seenSeasonNumbers = new HashSet<int>();
            var found = false;
            foreach (var season in seasonsElement.EnumerateArray())
            {
                if (season.ValueKind != JsonValueKind.Object ||
                    !season.TryGetProperty("seasonNumber", out var seasonNumberElement) ||
                    seasonNumberElement.ValueKind != JsonValueKind.Number ||
                    !seasonNumberElement.TryGetInt32(out var candidateSeasonNumber) ||
                    candidateSeasonNumber < 0 ||
                    !seenSeasonNumbers.Add(candidateSeasonNumber) ||
                    !season.TryGetProperty("episodeCount", out var episodeCountElement) ||
                    episodeCountElement.ValueKind != JsonValueKind.Number ||
                    !episodeCountElement.TryGetInt32(out var candidateEpisodeCount) ||
                    candidateEpisodeCount < 0)
                {
                    return false;
                }

                if (candidateSeasonNumber == seasonNumber)
                {
                    found = true;
                    episodeCount = candidateEpisodeCount;
                }
            }

            return found;
        }

        private static bool TryReadSeerrSeasonState(
            JsonElement root,
            int seasonNumber,
            out SeasonStatus status)
        {
            status = new SeasonStatus();

            // Root seasons are mapped directly from TMDB and establish only
            // existence/episode metadata. Never interpret a root `status`
            // property as Seerr availability state.
            if (!TryReadTmdbSeasonEpisodeCount(root, seasonNumber, out _))
            {
                return false;
            }

            if (!root.TryGetProperty("mediaInfo", out var mediaInfo) ||
                mediaInfo.ValueKind == JsonValueKind.Null)
            {
                // No persisted Seerr media record yet: TMDB existence is still
                // authoritative and there is no local state to conflict with.
                return true;
            }

            if (mediaInfo.ValueKind != JsonValueKind.Object ||
                !TryReadMediaAvailabilityStatus(mediaInfo, "status", out var mediaStatus) ||
                !TryReadMediaAvailabilityStatus(mediaInfo, "status4k", out _) ||
                !mediaInfo.TryGetProperty("requests", out var requests) ||
                requests.ValueKind != JsonValueKind.Array ||
                !mediaInfo.TryGetProperty("seasons", out var mediaSeasons) ||
                mediaSeasons.ValueKind != JsonValueKind.Array)
            {
                return false;
            }

            var hasActiveNormalRequest = false;
            var seenRequestIds = new HashSet<int>();
            foreach (var request in requests.EnumerateArray())
            {
                if (request.ValueKind != JsonValueKind.Object ||
                    !request.TryGetProperty("id", out var requestIdElement) ||
                    requestIdElement.ValueKind != JsonValueKind.Number ||
                    !requestIdElement.TryGetInt32(out var requestId) ||
                    requestId <= 0 ||
                    !seenRequestIds.Add(requestId) ||
                    !TryReadMediaRequestStatus(request, "status", out var requestStatus) ||
                    !request.TryGetProperty("is4k", out var is4kElement) ||
                    (is4kElement.ValueKind != JsonValueKind.True &&
                        is4kElement.ValueKind != JsonValueKind.False) ||
                    !request.TryGetProperty("seasons", out var requestSeasons) ||
                    requestSeasons.ValueKind != JsonValueKind.Array)
                {
                    return false;
                }

                var is4k = is4kElement.GetBoolean();
                var seenRequestSeasonNumbers = new HashSet<int>();
                foreach (var requestSeason in requestSeasons.EnumerateArray())
                {
                    if (requestSeason.ValueKind != JsonValueKind.Object ||
                        !requestSeason.TryGetProperty("seasonNumber", out var requestSeasonNumber) ||
                        requestSeasonNumber.ValueKind != JsonValueKind.Number ||
                        !requestSeasonNumber.TryGetInt32(out var parsedRequestSeasonNumber) ||
                        parsedRequestSeasonNumber < 0 ||
                        !seenRequestSeasonNumbers.Add(parsedRequestSeasonNumber) ||
                        !TryReadMediaRequestStatus(requestSeason, "status", out _))
                    {
                        return false;
                    }

                    if (!is4k &&
                        requestStatus is not SeerrMediaRequestStatus.Declined and
                            not SeerrMediaRequestStatus.Completed &&
                        parsedRequestSeasonNumber == seasonNumber)
                    {
                        hasActiveNormalRequest = true;
                    }
                }
            }

            var seenMediaSeasonNumbers = new HashSet<int>();
            var targetMediaSeasonFound = false;
            var targetStatus = SeerrMediaAvailabilityStatus.Unknown;
            foreach (var mediaSeason in mediaSeasons.EnumerateArray())
            {
                if (mediaSeason.ValueKind != JsonValueKind.Object ||
                    !mediaSeason.TryGetProperty("seasonNumber", out var mediaSeasonNumber) ||
                    mediaSeasonNumber.ValueKind != JsonValueKind.Number ||
                    !mediaSeasonNumber.TryGetInt32(out var parsedMediaSeasonNumber) ||
                    parsedMediaSeasonNumber < 0 ||
                    !seenMediaSeasonNumbers.Add(parsedMediaSeasonNumber) ||
                    !TryReadMediaAvailabilityStatus(mediaSeason, "status", out var parsedStatus) ||
                    !TryReadMediaAvailabilityStatus(mediaSeason, "status4k", out _))
                {
                    return false;
                }

                if (parsedMediaSeasonNumber == seasonNumber)
                {
                    targetMediaSeasonFound = true;
                    targetStatus = parsedStatus;
                }
            }

            if (targetMediaSeasonFound)
            {
                // The emitted request is non-4K (no `is4k` field), so only the
                // normal status is its availability/idempotency domain.
                // status4k is still required and validated above, but a 4K-only
                // copy/request must not suppress the missing normal season.
                status.IsAvailable =
                    targetStatus == SeerrMediaAvailabilityStatus.Available;
                status.IsRequested =
                    mediaStatus == SeerrMediaAvailabilityStatus.Blocklisted ||
                    hasActiveNormalRequest ||
                    IsNonRequestableMediaState(targetStatus);
            }
            else
            {
                // Seerr's top TV status is an aggregate of persisted season
                // rows. A newly announced TMDB season may not be represented
                // there yet even while that stale aggregate is AVAILABLE.
                // Seerr's request path prunes duplicates per season and only
                // treats the normal top-level BLOCKLISTED state as global.
                status.IsAvailable = false;
                status.IsRequested =
                    mediaStatus == SeerrMediaAvailabilityStatus.Blocklisted ||
                    hasActiveNormalRequest;
            }

            return true;
        }

        private static bool TryReadMediaAvailabilityStatus(
            JsonElement mediaSeason,
            string propertyName,
            out SeerrMediaAvailabilityStatus status)
        {
            status = SeerrMediaAvailabilityStatus.Unknown;
            if (!mediaSeason.TryGetProperty(propertyName, out var statusElement) ||
                statusElement.ValueKind != JsonValueKind.Number ||
                !statusElement.TryGetInt32(out var statusValue) ||
                !Enum.IsDefined(typeof(SeerrMediaAvailabilityStatus), statusValue))
            {
                return false;
            }

            status = (SeerrMediaAvailabilityStatus)statusValue;
            return true;
        }

        private static bool TryReadMediaRequestStatus(
            JsonElement owner,
            string propertyName,
            out SeerrMediaRequestStatus status)
        {
            status = SeerrMediaRequestStatus.Pending;
            if (!owner.TryGetProperty(propertyName, out var statusElement) ||
                statusElement.ValueKind != JsonValueKind.Number ||
                !statusElement.TryGetInt32(out var statusValue) ||
                !Enum.IsDefined(typeof(SeerrMediaRequestStatus), statusValue))
            {
                return false;
            }

            status = (SeerrMediaRequestStatus)statusValue;
            return true;
        }

        private static bool IsNonRequestableMediaState(SeerrMediaAvailabilityStatus status)
            => status is SeerrMediaAvailabilityStatus.Pending
                or SeerrMediaAvailabilityStatus.Processing
                or SeerrMediaAvailabilityStatus.PartiallyAvailable
                or SeerrMediaAvailabilityStatus.Blocklisted;

        // Calculates remaining unwatched episodes
        private int CalculateRemainingEpisodes(
            List<BaseItem> episodes,
            JUser user)
        {
            int remainingEpisodes = 0;

            foreach (var episode in episodes)
            {
                var userData = _userDataManager.GetUserData(user, episode);

                // If episode hasn't been watched (completed)
                if (userData == null || !userData.Played)
                {
                    remainingEpisodes++;
                }
            }

            return remainingEpisodes;
        }

        // Gets TMDB ID from series metadata
        private string? GetTmdbId(Series series)
        {
            if (series.ProviderIds.TryGetValue("Tmdb", out var tmdbId))
            {
                return tmdbId;
            }
            return null;
        }

        // Requests the next season from Seerr
        private enum AutoRequestDispatchOutcome
        {
            NotAttempted,
            Attempted,
            Succeeded,
        }

        private async Task<AutoRequestDispatchOutcome> RequestNextSeason(
            string tmdbId,
            int seasonNumber,
            string jellyfinUserId,
            bool callerIsAdmin,
            SeerrUser seerrUser,
            string seerrSourceUrl,
            SeerrMutationConfigStamp mutationConfigStamp)
        {
            var config = _configProvider.ConfigurationOrNull;
            if (!mutationConfigStamp.Matches(
                    config,
                    _configProvider.ConfigurationRevision)
                || !SeerrIntegrationPolicy.HasUsableSavedConfiguration(config))
            {
                _logger.LogWarning("[Auto-Season-Request] Seerr configuration is missing");
                return AutoRequestDispatchOutcome.NotAttempted;
            }

            var pinnedSource = FindConfiguredSource(config!.SeerrUrls, seerrSourceUrl);
            if (seerrUser.Id <= 0 || pinnedSource == null)
            {
                _logger.LogWarning(
                    "[Auto-Season-Request] The linked Seerr user or instance is no longer valid; no request was attempted");
                return AutoRequestDispatchOutcome.NotAttempted;
            }

            var seerrUserId = seerrUser.Id.ToString();
            var httpClient = Helpers.Seerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
            var dispatched = false;

            try
            {
                var requestUri = $"{pinnedSource}/api/v1/request";

                var requestBody = new
                {
                    mediaType = "tv",
                    mediaId = int.Parse(tmdbId),
                    seasons = new[] { seasonNumber },
                    // Keep Seerr's strict request-quality duplicate checks in
                    // the normal (non-4K) domain.
                    is4k = false,
                };

                var jsonContent = JsonSerializer.Serialize(requestBody);

                // This service posts directly rather than through
                // SeerrClient.ProxyRequestAsync. Apply the same server-side
                // Jellyfin parental gate to the parent series before a
                // playback-triggered request can be emitted.
                if (await _parentalFilter.IsBlockedAsync(
                        "tv",
                        int.Parse(tmdbId, System.Globalization.CultureInfo.InvariantCulture),
                        new SeerrCaller(jellyfinUserId, callerIsAdmin)).ConfigureAwait(false))
                {
                    _logger.LogInformation(
                        "[Auto-Season-Request] Series TMDB {TmdbId} is blocked by the acting Jellyfin user's parental policy; no request was attempted",
                        tmdbId);
                    return AutoRequestDispatchOutcome.NotAttempted;
                }

                // This is the final awaited operation before dispatch. A
                // playback-triggered check can take long enough for a Seerr
                // account to be remapped or lose permissions, so bypass the
                // user cache and require the complete original binding again.
                if (!await HasUnchangedFreshBindingAsync(
                        jellyfinUserId,
                        seerrUser,
                        pinnedSource,
                        config).ConfigureAwait(false))
                {
                    return AutoRequestDispatchOutcome.NotAttempted;
                }

                var currentConfig = _configProvider.ConfigurationOrNull;
                var currentPinnedSource = FindConfiguredSource(
                    currentConfig?.SeerrUrls,
                    seerrSourceUrl);
                if (!mutationConfigStamp.Matches(
                        currentConfig,
                        _configProvider.ConfigurationRevision)
                    || currentConfig == null
                    || !SeerrIntegrationPolicy.HasUsableSavedConfiguration(currentConfig)
                    || !currentConfig.AutoSeasonRequestEnabled
                    || string.IsNullOrEmpty(currentConfig.SeerrApiKey)
                    || !string.Equals(currentPinnedSource, pinnedSource, StringComparison.Ordinal))
                {
                    _logger.LogWarning(
                        "[Auto-Season-Request] Plugin configuration changed while preparing the request; no mutation was attempted");
                    return AutoRequestDispatchOutcome.NotAttempted;
                }

                config = currentConfig;
                requestUri = $"{currentPinnedSource}/api/v1/request";

                using var request = Helpers.Seerr.SeerrHttpHelper.BuildRequest(
                    HttpMethod.Post, requestUri, config.SeerrApiKey, seerrUserId, jsonContent);
                dispatched = true;
                var (_, error, _) = await Helpers.Seerr.SeerrHttpHelper.SendAndReadJsonAsync(
                    httpClient,
                    request,
                    requestUri);

                if (error == null)
                {
                    return AutoRequestDispatchOutcome.Succeeded;
                }
                // Seerr already has this request (409) — idempotent success.
                if (AutoRequest.AutoRequestRetryPolicy.IsAlreadyRequested(error))
                {
                    _logger.LogInformation($"[Auto-Season-Request] Season already requested on Seerr (409) at {pinnedSource} — treating as success.");
                    return AutoRequestDispatchOutcome.Succeeded;
                }

                _logger.LogWarning($"[Auto-Season-Request] Seerr request failed: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay} — {error.Message}");
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogError($"[Auto-Season-Request] Exception requesting season from Seerr at {pinnedSource}: {ex.Message}");
            }

            return dispatched
                ? AutoRequestDispatchOutcome.Attempted
                : AutoRequestDispatchOutcome.NotAttempted;
        }

        private async Task<bool> HasUnchangedFreshBindingAsync(
            string jellyfinUserId,
            SeerrUser initialUser,
            string initialSourceUrl,
            PluginConfiguration config)
        {
            var freshResolution = await _seerrClient.ResolveSeerrUser(
                jellyfinUserId,
                bypassCache: true,
                allowAutoImport: false).ConfigureAwait(false);
            var freshUser = freshResolution.User;
            var freshSourceUrl = FindConfiguredSource(config.SeerrUrls, freshUser?.SourceUrl);
            var expectedBinding = NormalizeJellyfinUserId(jellyfinUserId);
            var unchanged = freshResolution.IsFound &&
                freshUser != null &&
                freshUser.Id > 0 &&
                string.Equals(freshSourceUrl, initialSourceUrl, StringComparison.Ordinal) &&
                freshUser.Id == initialUser.Id &&
                freshUser.Permissions == initialUser.Permissions &&
                string.Equals(
                    NormalizeJellyfinUserId(initialUser.JellyfinUserId),
                    expectedBinding,
                    StringComparison.OrdinalIgnoreCase) &&
                string.Equals(
                    NormalizeJellyfinUserId(freshUser.JellyfinUserId),
                    expectedBinding,
                    StringComparison.OrdinalIgnoreCase);

            if (!unchanged)
            {
                _seerrClient.InvalidateUserIdentityCache(jellyfinUserId);
                _logger.LogWarning(
                    "[Auto-Season-Request] Fresh Seerr user resolution changed or invalidated the initial account/source/permission binding for Jellyfin user {UserId}; no request was attempted",
                    jellyfinUserId);
            }

            return unchanged;
        }

        private async Task<(SeerrUser User, string SourceUrl)?> ResolvePinnedSeerrUserAsync(
            string jellyfinUserId,
            PluginConfiguration config)
        {
            var userResolution = await ResolveSeerrUser(jellyfinUserId).ConfigureAwait(false);
            var seerrUser = userResolution.User;
            var sourceUrl = FindConfiguredSource(config.SeerrUrls, seerrUser?.SourceUrl);
            var expectedBinding = NormalizeJellyfinUserId(jellyfinUserId);
            if (!userResolution.IsFound ||
                seerrUser == null ||
                seerrUser.Id <= 0 ||
                sourceUrl == null ||
                !string.Equals(
                    NormalizeJellyfinUserId(seerrUser.JellyfinUserId),
                    expectedBinding,
                    StringComparison.OrdinalIgnoreCase))
            {
                _logger.LogWarning(
                    "[Auto-Season-Request] Seerr user resolution for Jellyfin user {UserId} returned {Status} without a current source binding; no Seerr request was attempted. {Reason}",
                    jellyfinUserId,
                    userResolution.Status,
                    userResolution.FailureReason);
                return null;
            }

            return (seerrUser, sourceUrl);
        }

        private static string? FindConfiguredSource(string? configuredUrls, string? candidateSourceUrl)
        {
            var normalizedCandidate = Helpers.Seerr.SeerrUrlIdentity.Normalize(candidateSourceUrl);
            if (string.IsNullOrWhiteSpace(normalizedCandidate))
            {
                return null;
            }

            return GetConfiguredUrls(configuredUrls).FirstOrDefault(url => string.Equals(
                url,
                normalizedCandidate,
                StringComparison.Ordinal));
        }

        private static string BuildSourceScopedKey(string sourceUrl, string resourceKey)
            => $"{sourceUrl.Length}:{sourceUrl}{resourceKey}";

        private static string? NormalizeJellyfinUserId(string? jellyfinUserId)
            => string.IsNullOrWhiteSpace(jellyfinUserId)
                ? null
                : jellyfinUserId.Replace("-", string.Empty, StringComparison.Ordinal);

        // Resolves the Seerr user and the instance that owns its id.
        private Task<SeerrUserResolution> ResolveSeerrUser(string jellyfinUserId)
        {
            // allowAutoImport: false — background monitors must never create
            // Seerr users as a side effect of playback (matches the former
            // SeerrUserResolver semantics: lookup only, no import).
            return _seerrClient.ResolveSeerrUser(
                jellyfinUserId,
                // The initial lookup may use the healthy positive cache; the
                // mandatory final pre-dispatch lookup bypasses it and requires
                // the exact same source-local binding.
                bypassCache: false,
                allowAutoImport: false);
        }
    }
}
