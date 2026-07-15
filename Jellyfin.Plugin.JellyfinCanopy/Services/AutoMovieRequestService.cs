using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
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
    public class AutoMovieRequestService
    {
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly ILogger<AutoMovieRequestService> _logger;
        private readonly IPluginConfigProvider _configProvider;
        private readonly IUserManager _userManager;
        private readonly ILibraryManager _libraryManager;

        // Track which movies have already been requested to avoid duplicates (with timestamps for expiry)
        private static readonly TimeSpan RequestReservationTtl = TimeSpan.FromHours(1);
        private readonly BoundedTtlCache<string, byte> _requestedMovies = new(
            maximumEntries: 16_384,
            maximumWeight: 16_384,
            comparer: StringComparer.Ordinal,
            defaultTtl: () => RequestReservationTtl);
        private readonly object _movieCacheLock = new();
        private readonly Seerr.ISeerrClient _seerrClient;
        private readonly ISeerrParentalFilter _parentalFilter;

        public AutoMovieRequestService(
            IHttpClientFactory httpClientFactory,
            ILogger<AutoMovieRequestService> logger,
            IUserManager userManager,
            ILibraryManager libraryManager,
            IPluginConfigProvider configProvider,
            Seerr.ISeerrClient seerrClient,
            ISeerrParentalFilter parentalFilter)
        {
            _httpClientFactory = httpClientFactory;
            _logger = logger;
            _userManager = userManager;
            _libraryManager = libraryManager;
            _configProvider = configProvider;
            _seerrClient = seerrClient;
            _parentalFilter = parentalFilter;
        }

        private static string[] GetConfiguredUrls(string? urls)
        {
            return Seerr.SeerrClient.GetConfiguredUrls(urls);
        }

        // Checks a movie to determine if the next movie in collection should be requested.
        // Event-driven entry point called when a user starts watching a movie.
        public async Task<AutoRequestPlaybackOutcome> CheckMovieForCollectionRequestAsync(
            BaseItem movieItem,
            Guid userId)
        {
            var config = _configProvider.ConfigurationOrNull;
            if (config == null || !config.AutoMovieRequestEnabled || !config.SeerrEnabled)
            {
                return AutoRequestPlaybackOutcome.DefinitiveNoop;
            }

            if (string.IsNullOrEmpty(config.TMDB_API_KEY))
            {
                _logger.LogWarning("[Auto-Movie-Request] TMDB API key is not configured. Auto movie requests require TMDB API access.");
                return AutoRequestPlaybackOutcome.RetryableFailure;
            }

            var mutationConfigStamp = SeerrMutationConfigStamp.Capture(
                config,
                _configProvider.ConfigurationRevision);

            // Custom Radarr ids and root folders are instance-local, but the
            // persisted settings do not carry a Seerr source identity. They are
            // therefore safe only when configuration has one identity domain.
            // (Syntactic aliases collapse in GetConfiguredUrls.)
            if (string.Equals(config.AutoMovieRequestQualityMode, "custom", StringComparison.Ordinal) &&
                GetConfiguredUrls(config.SeerrUrls).Length != 1)
            {
                _logger.LogWarning(
                    "[Auto-Movie-Request] Custom quality mode requires exactly one configured Seerr identity domain because its Radarr server/profile/root ids are not source-bound; no request was attempted");
                return AutoRequestPlaybackOutcome.RetryableFailure;
            }

            var user = _userManager.GetUserById(userId);
            if (user == null)
            {
                return AutoRequestPlaybackOutcome.DefinitiveNoop;
            }

            // Ensure this is a movie
            var movie = movieItem as Movie;
            if (movie == null)
            {
                return AutoRequestPlaybackOutcome.DefinitiveNoop;
            }

            // Get TMDB ID
            var tmdbId = GetTmdbId(movie);
            if (string.IsNullOrEmpty(tmdbId))
            {
                _logger.LogDebug($"[Auto-Movie-Request] '{movie.Name}' has no TMDB ID");
                return AutoRequestPlaybackOutcome.DefinitiveNoop;
            }

            // Resolve the instance-local user id and its owning Seerr instance once,
            // before any Seerr read. Collection/profile ids are local to an instance,
            // so every later read and the final POST must use this exact binding.
            var seerrBinding = await ResolvePinnedSeerrUserAsync(user.Id.ToString(), config).ConfigureAwait(false);
            if (!seerrBinding.HasValue)
            {
                return AutoRequestPlaybackOutcome.RetryableFailure;
            }

            var (seerrUser, seerrSourceUrl) = seerrBinding.Value;

            // Get collection info from TMDB
            var collectionLookup = await GetTmdbCollectionIdAsync(tmdbId, config);
            if (collectionLookup.Value == null)
            {
                return collectionLookup.Outcome;
            }

            var collectionInfo = collectionLookup.Value!;

            _logger.LogInformation($"[Auto-Movie-Request] '{movie.Name}' is part of {collectionInfo.Name} (TMDB collection {collectionInfo.Id})");

            // Resolve the exact quality domain before checking successor state:
            // normal and 4K availability/request ids are independent in Seerr.
            var qualityResolution = await ResolveQualityProfileAsync(
                tmdbId,
                seerrSourceUrl,
                config);
            if (!qualityResolution.IsComplete)
            {
                _logger.LogWarning(
                    "[Auto-Movie-Request] Original quality state could not be read authoritatively; no request was attempted");
                return AutoRequestPlaybackOutcome.RetryableFailure;
            }

            var qualitySettings = qualityResolution.Settings;
            var requestIs4k = qualitySettings?.Is4k == true;
            if (requestIs4k && !config.SeerrEnable4KRequests)
            {
                _logger.LogInformation(
                    "[Auto-Movie-Request] Original quality resolved to 4K, but Jellyfin Canopy's 4K movie master switch is disabled; no request was attempted");
                return AutoRequestPlaybackOutcome.DefinitiveNoop;
            }

            // Get collection details from Seerr and inspect status/status4k for
            // the same quality domain the final POST will target.
            var nextMovieLookup = await GetNextMovieInCollectionAsync(
                collectionInfo.Id,
                tmdbId,
                seerrSourceUrl,
                requestIs4k,
                config);
            if (nextMovieLookup.Value == null)
            {
                return nextMovieLookup.Outcome;
            }

            var nextMovieInfo = nextMovieLookup.Value!;

            // Check if we've already requested this movie (in-memory cache with 1-hour expiry)
            // Uses a sentinel pattern: write the entry before async work so concurrent
            // callers see it immediately, then remove on failure to allow retries.
            var requestKey = BuildSourceScopedKey(
                seerrSourceUrl,
                $"{nextMovieInfo.TmdbId}:{(requestIs4k ? "4k" : "normal")}");
            BoundedTtlCache<string, byte>.CacheToken reservation;
            lock (_movieCacheLock)
            {
                // The target reservation is global to this service instance,
                // not per Jellyfin caller. Seerr's duplicate check is a
                // non-atomic read/write, so two users racing the same source,
                // successor, and quality domain must share one lease.
                if (_requestedMovies.ContainsKey(requestKey))
                {
                    _logger.LogDebug($"[Auto-Movie-Request] Already requested '{nextMovieInfo.Title}' (cached)");
                    return AutoRequestPlaybackOutcome.DefinitiveNoop;
                }

                // Reserve the slot so concurrent callers see it immediately
                _requestedMovies.TrySet(requestKey, 0, out reservation);
            }

            // Request the movie
            AutoRequestDispatchOutcome outcome;
            try
            {
                outcome = await RequestMovie(
                    nextMovieInfo.TmdbId.ToString(),
                    user.Id.ToString(),
                    user.HasPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.IsAdministrator),
                    seerrUser,
                    seerrSourceUrl,
                    qualitySettings,
                    config,
                    mutationConfigStamp);
            }
            catch (OperationCanceledException)
            {
                lock (_movieCacheLock)
                {
                    _requestedMovies.Remove(reservation);
                }

                return AutoRequestPlaybackOutcome.Cancelled;
            }

            if (outcome == AutoRequestDispatchOutcome.Succeeded)
            {
                _logger.LogInformation($"[Auto-Movie-Request] ✓ Requested '{nextMovieInfo.Title}' (TMDB {nextMovieInfo.TmdbId}) for {user.Username}");
                return AutoRequestPlaybackOutcome.Committed;
            }
            else if (outcome == AutoRequestDispatchOutcome.NotAttempted)
            {
                // Preparation failed before dispatch, so retrying cannot replay
                // a possibly committed non-idempotent request.
                lock (_movieCacheLock)
                {
                    _requestedMovies.Remove(reservation);
                }
                _logger.LogWarning($"[Auto-Movie-Request] ✗ Failed to request '{nextMovieInfo.Title}' (TMDB {nextMovieInfo.TmdbId}) for {user.Username}");
                return AutoRequestPlaybackOutcome.RetryableFailure;
            }
            else
            {
                _logger.LogWarning($"[Auto-Movie-Request] Request outcome for '{nextMovieInfo.Title}' (TMDB {nextMovieInfo.TmdbId}) is ambiguous; retaining the cooldown reservation to prevent replay");
                return AutoRequestPlaybackOutcome.Committed;
            }
        }

        // Seerr movie status
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

        private enum AutoRequestDispatchOutcome
        {
            NotAttempted,
            Attempted,
            Succeeded,
        }

        // Collection info from TMDB
        private class CollectionInfo
        {
            public int Id { get; set; }
            public string Name { get; set; } = string.Empty;
        }

        // Movie info with title
        private class MovieInfo
        {
            public int TmdbId { get; set; }
            public string Title { get; set; } = string.Empty;
        }

        private sealed class LookupResult<T>
            where T : class
        {
            private LookupResult(T? value, AutoRequestPlaybackOutcome outcome)
            {
                Value = value;
                Outcome = outcome;
            }

            public T? Value { get; }

            public AutoRequestPlaybackOutcome Outcome { get; }

            public static LookupResult<T> Found(T value) =>
                new(value, AutoRequestPlaybackOutcome.Committed);

            public static LookupResult<T> DefinitiveNoop() =>
                new(null, AutoRequestPlaybackOutcome.DefinitiveNoop);

            public static LookupResult<T> RetryableFailure() =>
                new(null, AutoRequestPlaybackOutcome.RetryableFailure);
        }

        // Quality profile settings for Seerr requests
        private class QualityProfileSettings
        {
            public int? ServerId { get; set; }
            public int? ProfileId { get; set; }
            public string? RootFolder { get; set; }
            public bool Is4k { get; set; }
        }

        private sealed class QualityProfileResolution
        {
            private QualityProfileResolution(bool isComplete, QualityProfileSettings? settings)
            {
                IsComplete = isComplete;
                Settings = settings;
            }

            public bool IsComplete { get; }

            public QualityProfileSettings? Settings { get; }

            public static QualityProfileResolution Ready(QualityProfileSettings? settings)
                => new(true, settings);

            public static QualityProfileResolution Incomplete()
                => new(false, null);
        }

        private enum OriginalProfileReadStatus
        {
            Found,
            Absent,
            Incomplete,
        }

        private sealed class OriginalProfileReadResult
        {
            public OriginalProfileReadStatus Status { get; init; }

            public QualityProfileSettings? Settings { get; init; }
        }

        private enum SeerrMediaRequestStatus
        {
            Pending = 1,
            Approved = 2,
            Declined = 3,
            Failed = 4,
            Completed = 5,
        }

        // Gets TMDB collection ID and name for a movie
        private async Task<LookupResult<CollectionInfo>> GetTmdbCollectionIdAsync(
            string tmdbId,
            PluginConfiguration config)
        {
            if (string.IsNullOrEmpty(config.TMDB_API_KEY))
            {
                return LookupResult<CollectionInfo>.RetryableFailure();
            }

            try
            {
                var httpClient = Helpers.PluginHttpClients.CreateTmdbClient(_httpClientFactory);
                var requestUrl = $"https://api.themoviedb.org/3/movie/{tmdbId}?api_key={config.TMDB_API_KEY}";

                var response = await httpClient.GetAsync(requestUrl);
                if (!response.IsSuccessStatusCode)
                {
                    _logger.LogDebug($"[Auto-Movie-Request] TMDB returned {response.StatusCode} for movie {tmdbId}");
                    return LookupResult<CollectionInfo>.RetryableFailure();
                }

                var content = await response.Content.ReadAsStringAsync();
                using (JsonDocument doc = JsonDocument.Parse(content))
                {
                    var root = doc.RootElement;
                    if (root.TryGetProperty("belongs_to_collection", out var collectionProp))
                    {
                        if (collectionProp.ValueKind != JsonValueKind.Null &&
                            collectionProp.TryGetProperty("id", out var idProp) &&
                            collectionProp.TryGetProperty("name", out var nameProp))
                        {
                            return LookupResult<CollectionInfo>.Found(
                                new CollectionInfo
                                {
                                    Id = idProp.GetInt32(),
                                    Name = nameProp.GetString() ?? "Unknown Collection"
                                });
                        }

                        if (collectionProp.ValueKind != JsonValueKind.Null)
                        {
                            return LookupResult<CollectionInfo>.RetryableFailure();
                        }
                    }
                }
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"[Auto-Movie-Request] Error querying TMDB: {ex.Message}");
                return LookupResult<CollectionInfo>.RetryableFailure();
            }

            return LookupResult<CollectionInfo>.DefinitiveNoop();
        }

        /// <summary>
        /// Orders a TMDB collection "parts" array by parsed release date (stable by original
        /// index), so the "next in collection" walk follows chronological order. Parts with a
        /// missing/unparseable release date sort last. Non-array input yields an empty list.
        /// </summary>
        internal static List<JsonElement> OrderPartsByReleaseDate(JsonElement partsArray)
        {
            if (partsArray.ValueKind != JsonValueKind.Array)
            {
                return new List<JsonElement>();
            }

            return partsArray.EnumerateArray()
                .Select((p, idx) => (p, idx,
                    date: p.TryGetProperty("releaseDate", out var d)
                          && DateTime.TryParse(d.GetString(), out var dt)
                        ? dt : DateTime.MaxValue))
                .OrderBy(t => t.date)
                .ThenBy(t => t.idx)
                .Select(t => t.p)
                .ToList();
        }

        // Gets next movie in collection from Seerr collection endpoint
        private async Task<LookupResult<MovieInfo>> GetNextMovieInCollectionAsync(
            int collectionId,
            string currentTmdbId,
            string seerrSourceUrl,
            bool requestIs4k,
            PluginConfiguration config)
        {
            if (string.IsNullOrEmpty(config.SeerrUrls) || string.IsNullOrEmpty(config.SeerrApiKey))
            {
                return LookupResult<MovieInfo>.RetryableFailure();
            }

            try
            {
                var pinnedSource = FindConfiguredSource(config.SeerrUrls, seerrSourceUrl);
                if (pinnedSource == null)
                {
                    _logger.LogWarning("[Auto-Movie-Request] The linked Seerr instance is no longer configured; no collection lookup was attempted");
                    return LookupResult<MovieInfo>.RetryableFailure();
                }

                var httpClient = Helpers.Seerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
                var requestUrl = $"{pinnedSource}/api/v1/collection/{collectionId}";

                try
                {
                    using var request = Helpers.Seerr.SeerrHttpHelper.BuildRequest(
                        HttpMethod.Get, requestUrl, config.SeerrApiKey);
                    var (content, error, _) = await Helpers.Seerr.SeerrHttpHelper.SendAndReadJsonAsync(
                        httpClient,
                        request,
                        requestUrl);
                    if (error != null)
                    {
                        _logger.LogDebug($"[Auto-Movie-Request] Seerr collection fetch failed: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay}");
                        return LookupResult<MovieInfo>.RetryableFailure();
                    }

                    using (JsonDocument doc = JsonDocument.Parse(content!))
                    {
                        var root = doc.RootElement;

                        if (root.TryGetProperty("parts", out var partsArray))
                        {
                            int? currentIndex = null;
                            int? nextIndex = null;

                            // Find current movie and next movie. The TMDB "parts" array is
                            // NOT guaranteed to be in release order, so order it by release
                            // date first — otherwise "next in collection" could request a
                            // prequel/spin-off listed after the film just watched (ARR-7).
                            var parts = OrderPartsByReleaseDate(partsArray);
                            for (int i = 0; i < parts.Count; i++)
                            {
                                var part = parts[i];
                                if (part.TryGetProperty("id", out var idProp) && idProp.GetInt32().ToString() == currentTmdbId)
                                {
                                    currentIndex = i;
                                    break;
                                }
                            }

                            if (currentIndex.HasValue && currentIndex.Value < parts.Count - 1)
                            {
                                nextIndex = currentIndex.Value + 1;
                                var nextPart = parts[nextIndex.Value];

                                // Check if next movie is available or already requested
                                if (nextPart.TryGetProperty("mediaInfo", out var mediaInfo) &&
                                    mediaInfo.ValueKind != JsonValueKind.Null)
                                {
                                    if (!TryReadMovieMediaState(
                                            mediaInfo,
                                            requestIs4k,
                                            out var matchingStatus,
                                            out var globallyBlocklisted))
                                    {
                                        _logger.LogWarning(
                                            "[Auto-Movie-Request] Next movie carried malformed or incomplete normal/4K media state; no request was attempted");
                                        return LookupResult<MovieInfo>.RetryableFailure();
                                    }

                                    if (globallyBlocklisted ||
                                        matchingStatus is not SeerrMediaAvailabilityStatus.Unknown and
                                            not SeerrMediaAvailabilityStatus.Deleted)
                                    {
                                        _logger.LogDebug($"[Auto-Movie-Request] Next movie already unavailable for a new {(requestIs4k ? "4K" : "normal")} request (status: {matchingStatus})");
                                        return LookupResult<MovieInfo>.DefinitiveNoop();
                                    }
                                }

                                // Check release date if configured
                                if (config.AutoMovieRequestCheckReleaseDate)
                                {
                                    if (!nextPart.TryGetProperty("releaseDate", out var releaseDateProp) ||
                                        releaseDateProp.ValueKind != JsonValueKind.String ||
                                        string.IsNullOrWhiteSpace(releaseDateProp.GetString()) ||
                                        !DateTime.TryParse(releaseDateProp.GetString(), out var releaseDate))
                                    {
                                        _logger.LogDebug("[Auto-Movie-Request] Next movie has no authoritative release date; release-date gating fails closed");
                                        return LookupResult<MovieInfo>.DefinitiveNoop();
                                    }

                                    if (releaseDate.Date > DateTime.UtcNow.Date)
                                    {
                                        _logger.LogDebug($"[Auto-Movie-Request] Next movie is not yet released (release date: {releaseDate:yyyy-MM-dd}), skipping");
                                        return LookupResult<MovieInfo>.DefinitiveNoop();
                                    }
                                }

                                // Return next movie's TMDB ID and title
                                if (nextPart.TryGetProperty("id", out var nextIdProp) &&
                                    nextPart.TryGetProperty("title", out var titleProp))
                                {
                                    return LookupResult<MovieInfo>.Found(
                                        new MovieInfo
                                        {
                                            TmdbId = nextIdProp.GetInt32(),
                                            Title = titleProp.GetString() ?? "Unknown Title"
                                        });
                                }

                                return LookupResult<MovieInfo>.RetryableFailure();
                            }
                            else
                            {
                                // _logger.LogDebug($"[Auto-Movie-Request] Current movie is the last in collection or not found");
                                return LookupResult<MovieInfo>.DefinitiveNoop();
                            }
                        }

                        return LookupResult<MovieInfo>.RetryableFailure();
                    }
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    _logger.LogDebug($"[Auto-Movie-Request] Error checking Seerr at {pinnedSource}: {ex.Message}");
                }
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"[Auto-Movie-Request] Error querying Seerr collection: {ex.Message}");
            }

            return LookupResult<MovieInfo>.RetryableFailure();
        }

        private static bool TryReadMovieMediaState(
            JsonElement mediaInfo,
            bool requestIs4k,
            out SeerrMediaAvailabilityStatus matchingStatus,
            out bool globallyBlocklisted)
        {
            matchingStatus = SeerrMediaAvailabilityStatus.Unknown;
            globallyBlocklisted = false;
            if (mediaInfo.ValueKind != JsonValueKind.Object ||
                !TryReadMovieMediaStatus(mediaInfo, "status", out var normalStatus) ||
                !TryReadMovieMediaStatus(mediaInfo, "status4k", out var status4k))
            {
                return false;
            }

            // Seerr checks the normal media blocklist before handling either
            // request quality. Otherwise normal and 4K status domains are
            // independent.
            globallyBlocklisted = normalStatus == SeerrMediaAvailabilityStatus.Blocklisted;
            matchingStatus = requestIs4k ? status4k : normalStatus;
            return true;
        }

        private static bool TryReadMovieMediaStatus(
            JsonElement mediaInfo,
            string propertyName,
            out SeerrMediaAvailabilityStatus status)
        {
            status = SeerrMediaAvailabilityStatus.Unknown;
            if (!mediaInfo.TryGetProperty(propertyName, out var statusElement) ||
                statusElement.ValueKind != JsonValueKind.Number ||
                !statusElement.TryGetInt32(out var statusValue) ||
                !Enum.IsDefined(typeof(SeerrMediaAvailabilityStatus), statusValue))
            {
                return false;
            }

            status = (SeerrMediaAvailabilityStatus)statusValue;
            return true;
        }

        // Gets the quality profile of a movie from its existing Seerr request
        private async Task<OriginalProfileReadResult> GetOriginalMovieQualityProfileAsync(
            string tmdbId,
            string seerrSourceUrl,
            PluginConfiguration config)
        {
            if (string.IsNullOrEmpty(config.SeerrUrls) || string.IsNullOrEmpty(config.SeerrApiKey))
            {
                return new OriginalProfileReadResult { Status = OriginalProfileReadStatus.Incomplete };
            }

            var pinnedSource = FindConfiguredSource(config.SeerrUrls, seerrSourceUrl);
            if (pinnedSource == null)
            {
                _logger.LogWarning("[Auto-Movie-Request] The linked Seerr instance is no longer configured; no quality-profile lookup was attempted");
                return new OriginalProfileReadResult { Status = OriginalProfileReadStatus.Incomplete };
            }

            var httpClient = Helpers.Seerr.SeerrHttpHelper.CreateClient(_httpClientFactory);

            try
            {
                var requestUrl = $"{pinnedSource}/api/v1/movie/{tmdbId}";
                using var request = Helpers.Seerr.SeerrHttpHelper.BuildRequest(
                    HttpMethod.Get, requestUrl, config.SeerrApiKey);
                var (content, error, _) = await Helpers.Seerr.SeerrHttpHelper.SendAndReadJsonAsync(
                    httpClient,
                    request,
                    requestUrl);
                if (error != null)
                {
                    _logger.LogDebug($"[Auto-Movie-Request] Quality profile lookup for movie {tmdbId} failed: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay}");
                    return new OriginalProfileReadResult { Status = OriginalProfileReadStatus.Incomplete };
                }

                using (JsonDocument doc = JsonDocument.Parse(content!))
                {
                    var root = doc.RootElement;
                    if (root.ValueKind != JsonValueKind.Object)
                    {
                        return new OriginalProfileReadResult { Status = OriginalProfileReadStatus.Incomplete };
                    }

                    if (!root.TryGetProperty("mediaInfo", out var mediaInfo))
                    {
                        // Seerr's movie mapper assigns `mediaInfo` from
                        // Media.getMedia(). When no persisted Media row exists,
                        // that value is undefined and Express omits the JSON
                        // property entirely. Omission is therefore the normal,
                        // authoritative no-original-request shape.
                        return new OriginalProfileReadResult { Status = OriginalProfileReadStatus.Absent };
                    }

                    if (mediaInfo.ValueKind == JsonValueKind.Null)
                    {
                        return new OriginalProfileReadResult { Status = OriginalProfileReadStatus.Absent };
                    }

                    if (mediaInfo.ValueKind != JsonValueKind.Object ||
                        !mediaInfo.TryGetProperty("requests", out var requests) ||
                        requests.ValueKind != JsonValueKind.Array)
                    {
                        return new OriginalProfileReadResult { Status = OriginalProfileReadStatus.Incomplete };
                    }

                    var candidates = new List<(
                        DateTimeOffset UpdatedAt,
                        int Id,
                        QualityProfileSettings Settings)>();
                    var seenRequestIds = new HashSet<int>();
                    foreach (var requestRow in requests.EnumerateArray())
                    {
                        if (requestRow.ValueKind != JsonValueKind.Object ||
                            !requestRow.TryGetProperty("id", out var idElement) ||
                            idElement.ValueKind != JsonValueKind.Number ||
                            !idElement.TryGetInt32(out var requestId) ||
                            requestId <= 0 ||
                            !seenRequestIds.Add(requestId) ||
                            !TryReadMovieRequestStatus(requestRow, out var requestStatus) ||
                            !requestRow.TryGetProperty("is4k", out var is4kElement) ||
                            (is4kElement.ValueKind != JsonValueKind.True &&
                                is4kElement.ValueKind != JsonValueKind.False) ||
                            !requestRow.TryGetProperty("updatedAt", out var updatedAtElement) ||
                            updatedAtElement.ValueKind != JsonValueKind.String ||
                            !DateTimeOffset.TryParse(updatedAtElement.GetString(), out var updatedAt) ||
                            !TryReadOptionalProfileInteger(requestRow, "serverId", allowZero: true, out var serverId) ||
                            !TryReadOptionalProfileInteger(requestRow, "profileId", allowZero: false, out var profileId) ||
                            !TryReadOptionalRootFolder(requestRow, out var rootFolder))
                        {
                            return new OriginalProfileReadResult { Status = OriginalProfileReadStatus.Incomplete };
                        }

                        // Declined and failed rows are obsolete quality choices.
                        // Among the remaining real requests, the most recently
                        // updated row (then highest id) is deterministic despite
                        // TypeORM returning the relation in no defined order.
                        if (requestStatus is SeerrMediaRequestStatus.Declined or
                            SeerrMediaRequestStatus.Failed)
                        {
                            continue;
                        }

                        candidates.Add((
                            updatedAt,
                            requestId,
                            new QualityProfileSettings
                            {
                                ProfileId = profileId,
                                ServerId = serverId,
                                RootFolder = rootFolder,
                                Is4k = is4kElement.GetBoolean(),
                            }));
                    }

                    if (candidates.Count == 0)
                    {
                        return new OriginalProfileReadResult { Status = OriginalProfileReadStatus.Absent };
                    }

                    var selected = candidates
                        .OrderByDescending(static candidate => candidate.UpdatedAt)
                        .ThenByDescending(static candidate => candidate.Id)
                        .First()
                        .Settings;
                    _logger.LogDebug($"[Auto-Movie-Request] Found deterministic latest quality profile for TMDB {tmdbId}: profileId={selected.ProfileId}, serverId={selected.ServerId}, rootFolder={selected.RootFolder}, is4k={selected.Is4k}");
                    return new OriginalProfileReadResult
                    {
                        Status = OriginalProfileReadStatus.Found,
                        Settings = selected,
                    };
                }
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (HttpRequestException ex)
            {
                _logger.LogDebug($"[Auto-Movie-Request] Failed to connect to {pinnedSource}: {ex.Message}");
            }
            catch (JsonException ex)
            {
                _logger.LogWarning($"[Auto-Movie-Request] Invalid response from {pinnedSource}: {ex.Message}");
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"[Auto-Movie-Request] Unexpected error fetching quality profile from {pinnedSource}: {ex.Message}");
            }

            return new OriginalProfileReadResult { Status = OriginalProfileReadStatus.Incomplete };
        }

        private static bool TryReadMovieRequestStatus(
            JsonElement requestRow,
            out SeerrMediaRequestStatus status)
        {
            status = SeerrMediaRequestStatus.Pending;
            if (!requestRow.TryGetProperty("status", out var statusElement) ||
                statusElement.ValueKind != JsonValueKind.Number ||
                !statusElement.TryGetInt32(out var statusValue) ||
                !Enum.IsDefined(typeof(SeerrMediaRequestStatus), statusValue))
            {
                return false;
            }

            status = (SeerrMediaRequestStatus)statusValue;
            return true;
        }

        private static bool TryReadOptionalProfileInteger(
            JsonElement requestRow,
            string propertyName,
            bool allowZero,
            out int? value)
        {
            value = null;
            if (!requestRow.TryGetProperty(propertyName, out var element) ||
                element.ValueKind == JsonValueKind.Null)
            {
                return true;
            }

            if (element.ValueKind != JsonValueKind.Number ||
                !element.TryGetInt32(out var parsed) ||
                parsed < (allowZero ? 0 : 1))
            {
                return false;
            }

            value = parsed;
            return true;
        }

        private static bool TryReadOptionalRootFolder(
            JsonElement requestRow,
            out string? rootFolder)
        {
            rootFolder = null;
            if (!requestRow.TryGetProperty("rootFolder", out var element) ||
                element.ValueKind == JsonValueKind.Null)
            {
                return true;
            }

            if (element.ValueKind != JsonValueKind.String)
            {
                return false;
            }

            rootFolder = element.GetString();
            return true;
        }

        // Resolves quality profile settings based on configuration mode
        private async Task<QualityProfileResolution> ResolveQualityProfileAsync(
            string watchedTmdbId,
            string seerrSourceUrl,
            PluginConfiguration config)
        {
            var mode = config.AutoMovieRequestQualityMode ?? "default";

            if (mode == "original")
            {
                var original = await GetOriginalMovieQualityProfileAsync(
                    watchedTmdbId,
                    seerrSourceUrl,
                    config);
                if (original.Status == OriginalProfileReadStatus.Incomplete)
                {
                    return QualityProfileResolution.Incomplete();
                }

                if (original.Status == OriginalProfileReadStatus.Absent)
                {
                    _logger.LogInformation($"[Auto-Movie-Request] No usable request profile exists for watched movie TMDB {watchedTmdbId}; using Seerr's default profile");
                    return QualityProfileResolution.Ready(null);
                }

                var settings = original.Settings!;
                if (settings.Is4k && config.AutoMovieRequestFallbackOn4k)
                {
                    _logger.LogInformation($"[Auto-Movie-Request] Original movie used a 4K quality profile, falling back to default (AutoMovieRequestFallbackOn4k is enabled)");
                    return QualityProfileResolution.Ready(null);
                }

                return QualityProfileResolution.Ready(settings);
            }

            if (mode == "custom")
            {
                var settings = new QualityProfileSettings();
                if (config.AutoMovieRequestCustomServerId >= 0)
                {
                    settings.ServerId = config.AutoMovieRequestCustomServerId;
                }
                if (config.AutoMovieRequestCustomProfileId > 0)
                {
                    settings.ProfileId = config.AutoMovieRequestCustomProfileId;
                }
                if (!string.IsNullOrEmpty(config.AutoMovieRequestCustomRootFolder))
                {
                    settings.RootFolder = config.AutoMovieRequestCustomRootFolder;
                }

                // Only return if at least one value is set
                if (settings.ServerId.HasValue || settings.ProfileId.HasValue || !string.IsNullOrEmpty(settings.RootFolder))
                {
                    return QualityProfileResolution.Ready(settings);
                }

                _logger.LogWarning("[Auto-Movie-Request] Custom quality profile mode selected but no values configured, falling back to default");
                return QualityProfileResolution.Ready(null);
            }

            // "default" mode or unrecognized - no quality profile settings
            if (mode != "default")
            {
                _logger.LogWarning($"[Auto-Movie-Request] Unrecognized quality mode '{mode}', treating as default");
            }
            return QualityProfileResolution.Ready(null);
        }

        // Gets TMDB ID from movie metadata
        private string? GetTmdbId(Movie movie)
        {
            if (movie.ProviderIds.TryGetValue("Tmdb", out var tmdbId))
            {
                return tmdbId;
            }
            return null;
        }

        // Requests a movie from Seerr
        private async Task<AutoRequestDispatchOutcome> RequestMovie(
            string tmdbId,
            string jellyfinUserId,
            bool callerIsAdmin,
            SeerrUser seerrUser,
            string seerrSourceUrl,
            QualityProfileSettings? qualitySettings,
            PluginConfiguration config,
            SeerrMutationConfigStamp mutationConfigStamp)
        {
            if (string.IsNullOrEmpty(config.SeerrUrls) || string.IsNullOrEmpty(config.SeerrApiKey))
            {
                _logger.LogWarning("[Auto-Movie-Request] Seerr configuration is missing");
                return AutoRequestDispatchOutcome.NotAttempted;
            }

            var pinnedSource = FindConfiguredSource(config.SeerrUrls, seerrSourceUrl);
            if (seerrUser.Id <= 0 || pinnedSource == null)
            {
                _logger.LogWarning(
                    "[Auto-Movie-Request] The linked Seerr user or instance is no longer valid; no request was attempted");
                return AutoRequestDispatchOutcome.NotAttempted;
            }

            var seerrUserId = seerrUser.Id.ToString();
            var httpClient = Helpers.Seerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
            var dispatched = false;

            try
            {
                var requestUri = $"{pinnedSource}/api/v1/request";

                var requestBody = new Dictionary<string, object>
                {
                    { "mediaType", "movie" },
                    { "mediaId", int.Parse(tmdbId) },
                    // Seerr quality-scopes duplicate detection using strict
                    // boolean equality; undefined is not the normal domain.
                    { "is4k", qualitySettings?.Is4k == true }
                };

                if (qualitySettings != null)
                {
                    if (qualitySettings.ServerId.HasValue && qualitySettings.ServerId.Value >= 0)
                        requestBody["serverId"] = qualitySettings.ServerId.Value;
                    if (qualitySettings.ProfileId.HasValue && qualitySettings.ProfileId.Value > 0)
                        requestBody["profileId"] = qualitySettings.ProfileId.Value;
                    if (!string.IsNullOrEmpty(qualitySettings.RootFolder))
                        requestBody["rootFolder"] = qualitySettings.RootFolder;
                }

                var jsonContent = JsonSerializer.Serialize(requestBody);

                // Auto requests bypass SeerrClient.ProxyRequestAsync, so they
                // must apply the same Jellyfin parental policy explicitly. A
                // successor that the acting user cannot see/request manually
                // must never be created by the playback-triggered background
                // path. Keep the fresh identity lookup below as the final
                // awaited authorization step before dispatch.
                if (await _parentalFilter.IsBlockedAsync(
                        "movie",
                        int.Parse(tmdbId, System.Globalization.CultureInfo.InvariantCulture),
                        new SeerrCaller(jellyfinUserId, callerIsAdmin)).ConfigureAwait(false))
                {
                    _logger.LogInformation(
                        "[Auto-Movie-Request] Successor movie TMDB {TmdbId} is blocked by the acting Jellyfin user's parental policy; no request was attempted",
                        tmdbId);
                    return AutoRequestDispatchOutcome.NotAttempted;
                }

                // This is the final awaited operation before dispatch. Re-read
                // the binding without the user cache and refuse the POST if the
                // account, source, Jellyfin mapping, or permissions changed
                // while the collection/profile checks were in flight.
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
                    || !currentConfig.SeerrEnabled
                    || !currentConfig.AutoMovieRequestEnabled
                    || (qualitySettings?.Is4k == true && !currentConfig.SeerrEnable4KRequests)
                    || string.IsNullOrEmpty(currentConfig.SeerrApiKey)
                    || !string.Equals(currentPinnedSource, pinnedSource, StringComparison.Ordinal))
                {
                    _logger.LogWarning(
                        "[Auto-Movie-Request] Plugin configuration changed while preparing the request; no mutation was attempted");
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
                    _logger.LogInformation($"[Auto-Movie-Request] Movie already requested on Seerr (409) at {pinnedSource} — treating as success.");
                    return AutoRequestDispatchOutcome.Succeeded;
                }

                _logger.LogWarning($"[Auto-Movie-Request] Seerr request failed: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay} — {error.Message}");
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogError($"[Auto-Movie-Request] Exception requesting movie from Seerr at {pinnedSource}: {ex.Message}");
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
                    "[Auto-Movie-Request] Fresh Seerr user resolution changed or invalidated the initial account/source/permission binding for Jellyfin user {UserId}; no request was attempted",
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
                    "[Auto-Movie-Request] Seerr user resolution for Jellyfin user {UserId} returned {Status} without a current source binding; no Seerr request was attempted. {Reason}",
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

        // Clears the request cache (useful for testing or resetting)
        public void ClearRequestCache()
        {
            lock (_movieCacheLock)
            {
                _requestedMovies.Clear();
            }
            _logger.LogInformation("[Auto-Movie-Request] Cleared auto movie request cache");
        }
    }
}
