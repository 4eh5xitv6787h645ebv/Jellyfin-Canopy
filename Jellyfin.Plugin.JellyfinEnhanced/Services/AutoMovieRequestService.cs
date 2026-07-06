using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Querying;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    public class AutoMovieRequestService
    {
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly ILogger<AutoMovieRequestService> _logger;
        private readonly IPluginConfigProvider _configProvider;
        private readonly IUserManager _userManager;
        private readonly ILibraryManager _libraryManager;

        // Track which movies have already been requested to avoid duplicates (with timestamps for expiry)
        private readonly Dictionary<string, Dictionary<string, DateTime>> _requestedMovies = new();
        private readonly object _movieCacheLock = new();
        private readonly Jellyseerr.IJellyseerrClient _jellyseerrClient;

        public AutoMovieRequestService(
            IHttpClientFactory httpClientFactory,
            ILogger<AutoMovieRequestService> logger,
            IUserManager userManager,
            ILibraryManager libraryManager,
            IPluginConfigProvider configProvider,
            Jellyseerr.IJellyseerrClient jellyseerrClient)
        {
            _httpClientFactory = httpClientFactory;
            _logger = logger;
            _userManager = userManager;
            _libraryManager = libraryManager;
            _configProvider = configProvider;
            _jellyseerrClient = jellyseerrClient;
        }

        private static string[] GetConfiguredUrls(string? urls)
        {
            return Jellyseerr.JellyseerrClient.GetConfiguredUrls(urls);
        }

        // Checks a movie to determine if the next movie in collection should be requested.
        // Event-driven entry point called when a user starts watching a movie.
        public async Task CheckMovieForCollectionRequestAsync(BaseItem movieItem, Guid userId)
        {
            var config = _configProvider.ConfigurationOrNull;
            if (config == null || !config.AutoMovieRequestEnabled || !config.JellyseerrEnabled)
            {
                return;
            }

            if (string.IsNullOrEmpty(config.TMDB_API_KEY))
            {
                _logger.LogWarning("[Auto-Movie-Request] TMDB API key is not configured. Auto movie requests require TMDB API access.");
                return;
            }

            var user = _userManager.GetUserById(userId);
            if (user == null)
            {
                return;
            }

            // Ensure this is a movie
            var movie = movieItem as Movie;
            if (movie == null)
            {
                return;
            }

            // Get TMDB ID
            var tmdbId = GetTmdbId(movie);
            if (string.IsNullOrEmpty(tmdbId))
            {
                _logger.LogDebug($"[Auto-Movie-Request] '{movie.Name}' has no TMDB ID");
                return;
            }

            // Get collection info from TMDB
            var collectionInfo = await GetTmdbCollectionIdAsync(tmdbId);
            if (collectionInfo == null)
            {
                // _logger.LogDebug($"[Auto-Movie-Request] '{movie.Name}' is not part of a TMDB collection");
                return;
            }

            _logger.LogInformation($"[Auto-Movie-Request] '{movie.Name}' is part of {collectionInfo.Name} (TMDB collection {collectionInfo.Id})");

            // Get collection details from Jellyseerr
            var nextMovieInfo = await GetNextMovieInCollectionAsync(collectionInfo.Id, tmdbId);
            if (nextMovieInfo == null)
            {
                // _logger.LogDebug($"[Auto-Movie-Request] No next movie found or next movie is already available/requested");
                return;
            }

            // Check if we've already requested this movie (in-memory cache with 1-hour expiry)
            // Uses a sentinel pattern: write the entry before async work so concurrent
            // callers see it immediately, then remove on failure to allow retries.
            var requestKey = $"{user.Id}_{nextMovieInfo.TmdbId}";
            lock (_movieCacheLock)
            {
                // Clean up expired entries across all users
                foreach (var cachedUserId in _requestedMovies.Keys.ToList())
                {
                    var expired = _requestedMovies[cachedUserId]
                        .Where(kvp => (DateTime.Now - kvp.Value).TotalHours >= 1)
                        .Select(kvp => kvp.Key).ToList();
                    foreach (var key in expired) _requestedMovies[cachedUserId].Remove(key);
                    if (_requestedMovies[cachedUserId].Count == 0) _requestedMovies.Remove(cachedUserId);
                }

                if (!_requestedMovies.ContainsKey(user.Id.ToString()))
                {
                    _requestedMovies[user.Id.ToString()] = new Dictionary<string, DateTime>();
                }

                if (_requestedMovies[user.Id.ToString()].ContainsKey(requestKey))
                {
                    _logger.LogDebug($"[Auto-Movie-Request] Already requested '{nextMovieInfo.Title}' (cached)");
                    return;
                }

                // Reserve the slot so concurrent callers see it immediately
                _requestedMovies[user.Id.ToString()][requestKey] = DateTime.Now;
            }

            // Resolve quality profile settings based on configuration mode
            var qualitySettings = await ResolveQualityProfileAsync(tmdbId);

            // Request the movie
            var success = await RequestMovie(nextMovieInfo.TmdbId.ToString(), user.Id.ToString(), qualitySettings);

            if (success)
            {
                _logger.LogInformation($"[Auto-Movie-Request] ✓ Requested '{nextMovieInfo.Title}' (TMDB {nextMovieInfo.TmdbId}) for {user.Username}");
            }
            else
            {
                // Remove sentinel so a future attempt can retry
                lock (_movieCacheLock)
                {
                    if (_requestedMovies.ContainsKey(user.Id.ToString()))
                    {
                        _requestedMovies[user.Id.ToString()].Remove(requestKey);
                    }
                }
                _logger.LogWarning($"[Auto-Movie-Request] ✗ Failed to request '{nextMovieInfo.Title}' (TMDB {nextMovieInfo.TmdbId}) for {user.Username}");
            }
        }

        // Jellyseerr movie status
        private class MovieStatus
        {
            public bool IsAvailable { get; set; }
            public bool IsRequested { get; set; }
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

        // Quality profile settings for Jellyseerr requests
        private class QualityProfileSettings
        {
            public int? ServerId { get; set; }
            public int? ProfileId { get; set; }
            public string? RootFolder { get; set; }
            public bool Is4k { get; set; }
        }

        // Gets TMDB collection ID and name for a movie
        private async Task<CollectionInfo?> GetTmdbCollectionIdAsync(string tmdbId)
        {
            var config = _configProvider.ConfigurationOrNull;
            if (config == null || string.IsNullOrEmpty(config.TMDB_API_KEY))
            {
                return null;
            }

            try
            {
                var httpClient = Helpers.PluginHttpClients.CreateTmdbClient(_httpClientFactory);
                var requestUrl = $"https://api.themoviedb.org/3/movie/{tmdbId}?api_key={config.TMDB_API_KEY}";

                var response = await httpClient.GetAsync(requestUrl);
                if (!response.IsSuccessStatusCode)
                {
                    _logger.LogDebug($"[Auto-Movie-Request] TMDB returned {response.StatusCode} for movie {tmdbId}");
                    return null;
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
                            return new CollectionInfo
                            {
                                Id = idProp.GetInt32(),
                                Name = nameProp.GetString() ?? "Unknown Collection"
                            };
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"[Auto-Movie-Request] Error querying TMDB: {ex.Message}");
            }

            return null;
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

        // Gets next movie in collection from Jellyseerr collection endpoint
        private async Task<MovieInfo?> GetNextMovieInCollectionAsync(int collectionId, string currentTmdbId)
        {
            var config = _configProvider.ConfigurationOrNull;
            if (config == null || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.JellyseerrApiKey))
            {
                return null;
            }

            try
            {
                var urls = GetConfiguredUrls(config.JellyseerrUrls);
                var httpClient = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);

                foreach (var url in urls)
                {
                    var trimmedUrl = url.Trim().TrimEnd('/');
                    var requestUrl = $"{trimmedUrl}/api/v1/collection/{collectionId}";

                    try
                    {
                        using var request = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(
                            HttpMethod.Get, requestUrl, config.JellyseerrApiKey);
                        using var response = await httpClient.SendAsync(request);
                        var (content, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, requestUrl);
                        if (error != null)
                        {
                            _logger.LogDebug($"[Auto-Movie-Request] Jellyseerr collection fetch failed: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay}");
                            continue;
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
                                    if (nextPart.TryGetProperty("mediaInfo", out var mediaInfo))
                                    {
                                        if (mediaInfo.TryGetProperty("status", out var statusProp))
                                        {
                                            var statusValue = statusProp.GetInt32();
                                            // 5 = available, 2 = pending, 3 = processing
                                            if (statusValue == 5 || statusValue == 2 || statusValue == 3)
                                            {
                                                _logger.LogDebug($"[Auto-Movie-Request] Next movie already available or requested (status: {statusValue})");
                                                return null;
                                            }
                                        }
                                    }

                                    // Check release date if configured
                                    if (config.AutoMovieRequestCheckReleaseDate && nextPart.TryGetProperty("releaseDate", out var releaseDateProp))
                                    {
                                        var releaseDateStr = releaseDateProp.GetString();
                                        if (!string.IsNullOrEmpty(releaseDateStr) && DateTime.TryParse(releaseDateStr, out var releaseDate))
                                        {
                                            if (releaseDate > DateTime.Now)
                                            {
                                                _logger.LogDebug($"[Auto-Movie-Request] Next movie is not yet released (release date: {releaseDate:yyyy-MM-dd}), skipping");
                                                return null;
                                            }
                                        }
                                    }

                                    // Return next movie's TMDB ID and title
                                    if (nextPart.TryGetProperty("id", out var nextIdProp) &&
                                        nextPart.TryGetProperty("title", out var titleProp))
                                    {
                                        return new MovieInfo
                                        {
                                            TmdbId = nextIdProp.GetInt32(),
                                            Title = titleProp.GetString() ?? "Unknown Title"
                                        };
                                    }
                                }
                                else
                                {
                                    // _logger.LogDebug($"[Auto-Movie-Request] Current movie is the last in collection or not found");
                                    return null;
                                }
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        _logger.LogDebug($"[Auto-Movie-Request] Error checking Jellyseerr at {trimmedUrl}: {ex.Message}");
                        continue;
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"[Auto-Movie-Request] Error querying Jellyseerr collection: {ex.Message}");
            }

            return null;
        }

        // Gets the quality profile of a movie from its existing Jellyseerr request
        private async Task<QualityProfileSettings?> GetOriginalMovieQualityProfileAsync(string tmdbId)
        {
            var config = _configProvider.ConfigurationOrNull;
            if (config == null || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.JellyseerrApiKey))
            {
                return null;
            }

            var urls = GetConfiguredUrls(config.JellyseerrUrls);
            var httpClient = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);

            foreach (var url in urls)
            {
                try
                {
                    var requestUrl = $"{url}/api/v1/movie/{tmdbId}";
                    using var request = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(
                        HttpMethod.Get, requestUrl, config.JellyseerrApiKey);
                    using var response = await httpClient.SendAsync(request);
                    var (content, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, requestUrl);
                    if (error != null)
                    {
                        _logger.LogDebug($"[Auto-Movie-Request] Quality profile lookup for movie {tmdbId} failed: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay}");
                        continue;
                    }

                    using (JsonDocument doc = JsonDocument.Parse(content!))
                    {
                        var root = doc.RootElement;
                        if (root.TryGetProperty("mediaInfo", out var mediaInfo) &&
                            mediaInfo.TryGetProperty("requests", out var requests) &&
                            requests.GetArrayLength() > 0)
                        {
                            var firstRequest = requests[0];
                            var settings = new QualityProfileSettings();

                            if (firstRequest.TryGetProperty("profileId", out var profileId) &&
                                profileId.ValueKind == JsonValueKind.Number)
                            {
                                settings.ProfileId = profileId.GetInt32();
                            }
                            if (firstRequest.TryGetProperty("serverId", out var serverId) &&
                                serverId.ValueKind == JsonValueKind.Number)
                            {
                                settings.ServerId = serverId.GetInt32();
                            }
                            if (firstRequest.TryGetProperty("rootFolder", out var rootFolder) &&
                                rootFolder.ValueKind == JsonValueKind.String)
                            {
                                settings.RootFolder = rootFolder.GetString();
                            }
                            if (firstRequest.TryGetProperty("is4k", out var is4k) &&
                                is4k.ValueKind == JsonValueKind.True)
                            {
                                settings.Is4k = true;
                            }

                            if (settings.ProfileId.HasValue || settings.ServerId.HasValue)
                            {
                                _logger.LogDebug($"[Auto-Movie-Request] Found quality profile for TMDB {tmdbId}: profileId={settings.ProfileId}, serverId={settings.ServerId}, rootFolder={settings.RootFolder}, is4k={settings.Is4k}");
                                return settings;
                            }
                        }
                    }

                    _logger.LogDebug($"[Auto-Movie-Request] No request records found for TMDB {tmdbId} in Jellyseerr");
                    return null;
                }
                catch (HttpRequestException ex)
                {
                    _logger.LogDebug($"[Auto-Movie-Request] Failed to connect to {url}: {ex.Message}");
                    continue;
                }
                catch (JsonException ex)
                {
                    _logger.LogWarning($"[Auto-Movie-Request] Invalid response from {url}: {ex.Message}");
                    continue;
                }
                catch (Exception ex)
                {
                    _logger.LogWarning($"[Auto-Movie-Request] Unexpected error fetching quality profile from {url}: {ex.Message}");
                    continue;
                }
            }

            return null;
        }

        // Resolves quality profile settings based on configuration mode
        private async Task<QualityProfileSettings?> ResolveQualityProfileAsync(string watchedTmdbId)
        {
            var config = _configProvider.ConfigurationOrNull;
            if (config == null)
            {
                return null;
            }

            var mode = config.AutoMovieRequestQualityMode ?? "default";

            if (mode == "original")
            {
                var settings = await GetOriginalMovieQualityProfileAsync(watchedTmdbId);
                if (settings == null)
                {
                    _logger.LogWarning($"[Auto-Movie-Request] Could not determine quality profile for watched movie TMDB {watchedTmdbId}, falling back to default");
                    return null;
                }

                if (settings.Is4k && config.AutoMovieRequestFallbackOn4k)
                {
                    _logger.LogInformation($"[Auto-Movie-Request] Original movie used a 4K quality profile, falling back to default (AutoMovieRequestFallbackOn4k is enabled)");
                    return null;
                }

                return settings;
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
                    return settings;
                }

                _logger.LogWarning("[Auto-Movie-Request] Custom quality profile mode selected but no values configured, falling back to default");
                return null;
            }

            // "default" mode or unrecognized - no quality profile settings
            if (mode != "default")
            {
                _logger.LogWarning($"[Auto-Movie-Request] Unrecognized quality mode '{mode}', treating as default");
            }
            return null;
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

        // Requests a movie from Jellyseerr
        private async Task<bool> RequestMovie(string tmdbId, string jellyfinUserId, QualityProfileSettings? qualitySettings = null)
        {
            var config = _configProvider.ConfigurationOrNull;
            if (config == null || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.JellyseerrApiKey))
            {
                _logger.LogWarning("[Auto-Movie-Request] Jellyseerr configuration is missing");
                return false;
            }

            // Get Jellyseerr user ID
            var jellyseerrUserId = await GetJellyseerrUserId(jellyfinUserId);
            if (string.IsNullOrEmpty(jellyseerrUserId))
            {
                _logger.LogWarning($"[Auto-Movie-Request] Could not find Jellyseerr user for Jellyfin user {jellyfinUserId}");
                return false;
            }

            var urls = GetConfiguredUrls(config.JellyseerrUrls);
            var httpClient = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);

            foreach (var url in urls)
            {
                try
                {
                    var requestUri = $"{url.Trim().TrimEnd('/')}/api/v1/request";

                    var requestBody = new Dictionary<string, object>
                    {
                        { "mediaType", "movie" },
                        { "mediaId", int.Parse(tmdbId) }
                    };

                    if (qualitySettings != null)
                    {
                        if (qualitySettings.ServerId.HasValue && qualitySettings.ServerId.Value >= 0)
                            requestBody["serverId"] = qualitySettings.ServerId.Value;
                        if (qualitySettings.ProfileId.HasValue && qualitySettings.ProfileId.Value > 0)
                            requestBody["profileId"] = qualitySettings.ProfileId.Value;
                        if (!string.IsNullOrEmpty(qualitySettings.RootFolder))
                            requestBody["rootFolder"] = qualitySettings.RootFolder;
                        if (qualitySettings.Is4k)
                            requestBody["is4k"] = true;
                    }

                    var jsonContent = JsonSerializer.Serialize(requestBody);

                    using var request = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(
                        HttpMethod.Post, requestUri, config.JellyseerrApiKey, jellyseerrUserId, jsonContent);
                    using var response = await httpClient.SendAsync(request);
                    var (responseContent, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, requestUri);

                    if (error == null)
                    {
                        return true;
                    }
                    // Seerr already has this request (409) — idempotent success, stop here.
                    if (AutoRequest.AutoRequestRetryPolicy.IsAlreadyRequested(error))
                    {
                        _logger.LogInformation($"[Auto-Movie-Request] Movie already requested on Jellyseerr (409) at {url} — treating as success.");
                        return true;
                    }
                    _logger.LogWarning($"[Auto-Movie-Request] Jellyseerr request failed: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay} — {error.Message}");
                    // A server that RESPONDED (any real status) may already have committed the
                    // request; do not re-POST it to another backend. Only fail over on a pure
                    // transport failure (no commit possible).
                    if (!AutoRequest.AutoRequestRetryPolicy.ShouldTryNextUrl(error))
                    {
                        return false;
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogError($"[Auto-Movie-Request] Exception requesting movie from Jellyseerr at {url}: {ex.Message}");
                }
            }

            return false;
        }

        // Gets the Jellyseerr user ID for a Jellyfin user
        private Task<string?> GetJellyseerrUserId(string jellyfinUserId)
        {
            // allowAutoImport: false — background monitors must never create
            // Seerr users as a side effect of playback (matches the former
            // JellyseerrUserResolver semantics: lookup only, no import).
            return _jellyseerrClient.GetJellyseerrUserId(jellyfinUserId, allowAutoImport: false);
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
