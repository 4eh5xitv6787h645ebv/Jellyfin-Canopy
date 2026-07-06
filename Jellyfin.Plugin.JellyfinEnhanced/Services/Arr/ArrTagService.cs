using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr
{
    /// <summary>
    /// Media item as returned by the Sonarr (/api/v3/series) and Radarr (/api/v3/movie)
    /// endpoints. Fields not present in a given payload deserialize to their defaults.
    /// </summary>
    public class ArrMediaItem
    {
        [JsonPropertyName("id")]
        public int Id { get; set; }

        [JsonPropertyName("title")]
        public string Title { get; set; } = string.Empty;

        [JsonPropertyName("tvdbId")]
        public int TvdbId { get; set; }

        [JsonPropertyName("tmdbId")]
        public int TmdbId { get; set; }

        [JsonPropertyName("imdbId")]
        public string? ImdbId { get; set; }

        [JsonPropertyName("tags")]
        public List<int> Tags { get; set; } = new List<int>();
    }

    public class ArrTag
    {
        [JsonPropertyName("id")]
        public int Id { get; set; }

        [JsonPropertyName("label")]
        public string Label { get; set; } = string.Empty;
    }

    /// <summary>
    /// Fetches tag mappings from Sonarr/Radarr. Merged from the former SonarrService and
    /// RadarrService, which were identical except for the media endpoint (/series vs /movie)
    /// and the provider-id key (ImdbId string vs TmdbId int).
    /// </summary>
    public class ArrTagService
    {
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly ILogger _logger;

        public ArrTagService(IHttpClientFactory httpClientFactory, ILogger logger)
        {
            _httpClientFactory = httpClientFactory;
            _logger = logger;
        }

        /// <summary>
        /// Sonarr series tag labels keyed BOTH by TVDB id (Sonarr's canonical, always-present
        /// id) and by IMDb id (fallback). Keying by IMDb alone silently synced nothing for
        /// TVDB-scraped libraries (series without an IMDb id); TVDB is the reliable key.
        /// </summary>
        public async Task<SeriesTagMaps> GetSeriesTagsAsync(string sonarrUrl, string apiKey, CancellationToken ct = default)
        {
            var byTvdbId = new Dictionary<int, List<string>>();
            var byImdbId = new Dictionary<string, List<string>>();

            var fetched = await FetchTagsAndItemsAsync(ArrType.Sonarr, sonarrUrl, apiKey, ct).ConfigureAwait(false);
            if (fetched == null)
            {
                return new SeriesTagMaps(byTvdbId, byImdbId);
            }

            var (items, tagLabels) = fetched.Value;
            foreach (var item in items)
            {
                if (item.Tags.Count == 0)
                {
                    continue;
                }

                var itemTags = ResolveLabels(item, tagLabels);
                if (itemTags.Count == 0)
                {
                    continue;
                }

                // Separate list copies per map so a later per-instance merge can't mutate
                // the other map's value through a shared reference.
                if (item.TvdbId > 0)
                {
                    byTvdbId[item.TvdbId] = new List<string>(itemTags);
                }

                if (!string.IsNullOrEmpty(item.ImdbId))
                {
                    byImdbId[item.ImdbId] = new List<string>(itemTags);
                }
            }

            _logger.LogInformation($"Mapped Sonarr tags for {byTvdbId.Count} series by TVDB, {byImdbId.Count} by IMDb");
            return new SeriesTagMaps(byTvdbId, byImdbId);
        }

        /// <summary>Radarr: tag labels keyed by movie TmdbId.</summary>
        public async Task<Dictionary<int, List<string>>> GetMovieTagsByTmdbId(string radarrUrl, string apiKey, CancellationToken ct = default)
        {
            var result = new Dictionary<int, List<string>>();

            var fetched = await FetchTagsAndItemsAsync(ArrType.Radarr, radarrUrl, apiKey, ct).ConfigureAwait(false);
            if (fetched == null)
            {
                return result;
            }

            var (items, tagLabels) = fetched.Value;
            foreach (var item in items)
            {
                if (item.TmdbId > 0 && item.Tags.Count > 0)
                {
                    var itemTags = ResolveLabels(item, tagLabels);
                    if (itemTags.Count > 0)
                    {
                        result[item.TmdbId] = itemTags;
                    }
                }
            }

            _logger.LogInformation($"Mapped tags for {result.Count} movies");
            return result;
        }

        /// <summary>
        /// Fetches the tag label map and the full media list from one *arr instance in a
        /// single tag + media round-trip. Returns null when the SSRF guard blocks the URL
        /// or any fetch/parse step fails (all logged); callers degrade to empty maps.
        /// </summary>
        private async Task<(List<ArrMediaItem> Items, Dictionary<int, string> TagLabels)?> FetchTagsAndItemsAsync(
            ArrType arrType,
            string baseUrl,
            string apiKey,
            CancellationToken ct)
        {
            var serviceName = arrType.ToString(); // "Sonarr" / "Radarr"
            var itemNoun = arrType == ArrType.Sonarr ? "series" : "movies";
            var mediaEndpoint = arrType == ArrType.Sonarr ? "series" : "movie";

            // SSRF guard: reject before any outbound request so scheduled-task callers
            // cannot be pointed at metadata/loopback targets via instance URL.
            if (!Jellyfin.Plugin.JellyfinEnhanced.Helpers.ArrUrlGuard.IsAllowedUrl(baseUrl))
            {
                _logger.LogError($"Refusing to fetch {serviceName} tags — URL rejected by SSRF guard: {baseUrl}");
                return null;
            }

            try
            {
                // Named arr client; the API key rides on each request instead of on
                // the DefaultRequestHeaders of a factory client. Timeout stays at the
                // client default (100s) — full-library fetches can be large.
                var httpClient = Helpers.PluginHttpClients.CreateArrClient(_httpClientFactory);

                // Get all tags first
                _logger.LogInformation($"Fetching {serviceName} tags from {baseUrl}");
                var tagsUrl = $"{baseUrl.TrimEnd('/')}/api/v3/tag";
                using var tagsRequest = Helpers.PluginHttpClients.BuildArrRequest(HttpMethod.Get, tagsUrl, apiKey);
                var tagsResponse = await httpClient.SendAsync(tagsRequest, ct);

                if (!tagsResponse.IsSuccessStatusCode)
                {
                    _logger.LogError($"Failed to fetch {serviceName} tags. Status: {tagsResponse.StatusCode}");
                    return null;
                }

                var tagsContent = await tagsResponse.Content.ReadAsStringAsync(ct);
                var tags = JsonSerializer.Deserialize<List<ArrTag>>(tagsContent) ?? new List<ArrTag>();
                var tagDictionary = tags.ToDictionary(t => t.Id, t => t.Label);

                _logger.LogInformation($"Found {tags.Count} tags in {serviceName}");

                // Get all media items (series/movies)
                _logger.LogInformation($"Fetching {serviceName} {itemNoun} from {baseUrl}");
                var mediaUrl = $"{baseUrl.TrimEnd('/')}/api/v3/{mediaEndpoint}";
                using var mediaRequest = Helpers.PluginHttpClients.BuildArrRequest(HttpMethod.Get, mediaUrl, apiKey);
                var mediaResponse = await httpClient.SendAsync(mediaRequest, ct);

                if (!mediaResponse.IsSuccessStatusCode)
                {
                    _logger.LogError($"Failed to fetch {serviceName} {itemNoun}. Status: {mediaResponse.StatusCode}");
                    return null;
                }

                var mediaContent = await mediaResponse.Content.ReadAsStringAsync(ct);
                var allItems = JsonSerializer.Deserialize<List<ArrMediaItem>>(mediaContent) ?? new List<ArrMediaItem>();

                _logger.LogInformation($"Found {allItems.Count} {itemNoun} in {serviceName}");

                return (allItems, tagDictionary);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                // Let the scheduled task's cancellation path observe the cancel instead of
                // flattening it into an empty "success" result.
                throw;
            }
            catch (HttpRequestException ex)
            {
                _logger.LogError($"Network error fetching {serviceName} tags: {ex.Message}");
            }
            catch (TaskCanceledException ex)
            {
                _logger.LogError($"Timeout fetching {serviceName} tags: {ex.Message}");
            }
            catch (JsonException ex)
            {
                _logger.LogError($"Invalid JSON from {serviceName} tags endpoint: {ex.Message}");
            }
            catch (Exception ex)
            {
                _logger.LogError($"Unexpected error fetching {serviceName} tags: {ex.Message}");
            }

            return null;
        }

        /// <summary>Resolves an item's tag ids to their labels via the fetched label map.</summary>
        private static List<string> ResolveLabels(ArrMediaItem item, Dictionary<int, string> tagLabels)
        {
            var itemTags = new List<string>();
            foreach (var tagId in item.Tags)
            {
                if (tagLabels.TryGetValue(tagId, out var tagLabel))
                {
                    itemTags.Add(tagLabel);
                }
            }

            return itemTags;
        }
    }

    /// <summary>
    /// Sonarr series tag labels projected by both keying strategies: TVDB id (canonical,
    /// preferred) and IMDb id (fallback). Built in a single fetch so a TVDB-scraped library
    /// (series with no IMDb id) still syncs.
    /// </summary>
    public sealed record SeriesTagMaps(
        Dictionary<int, List<string>> ByTvdbId,
        Dictionary<string, List<string>> ByImdbId);
}
