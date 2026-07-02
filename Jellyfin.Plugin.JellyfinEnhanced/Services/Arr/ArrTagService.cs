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

        /// <summary>Sonarr: tag labels keyed by series ImdbId.</summary>
        public Task<Dictionary<string, List<string>>> GetSeriesTagsByTvdbId(string sonarrUrl, string apiKey, CancellationToken ct = default)
        {
            return GetTagsAsync(
                ArrType.Sonarr,
                sonarrUrl,
                apiKey,
                hasKey: item => !string.IsNullOrEmpty(item.ImdbId),
                keySelector: item => item.ImdbId!,
                ct);
        }

        /// <summary>Radarr: tag labels keyed by movie TmdbId.</summary>
        public Task<Dictionary<int, List<string>>> GetMovieTagsByTmdbId(string radarrUrl, string apiKey, CancellationToken ct = default)
        {
            return GetTagsAsync(
                ArrType.Radarr,
                radarrUrl,
                apiKey,
                hasKey: item => item.TmdbId > 0,
                keySelector: item => item.TmdbId,
                ct);
        }

        /// <summary>
        /// Shared implementation. <paramref name="hasKey"/> decides whether an item has a usable
        /// provider-id key; <paramref name="keySelector"/> extracts it.
        /// </summary>
        private async Task<Dictionary<TKey, List<string>>> GetTagsAsync<TKey>(
            ArrType arrType,
            string baseUrl,
            string apiKey,
            Func<ArrMediaItem, bool> hasKey,
            Func<ArrMediaItem, TKey> keySelector,
            CancellationToken ct)
            where TKey : notnull
        {
            var serviceName = arrType.ToString(); // "Sonarr" / "Radarr"
            var itemNoun = arrType == ArrType.Sonarr ? "series" : "movies";
            var mediaEndpoint = arrType == ArrType.Sonarr ? "series" : "movie";

            var result = new Dictionary<TKey, List<string>>();

            // SSRF guard: reject before any outbound request so scheduled-task callers
            // cannot be pointed at metadata/loopback targets via instance URL.
            if (!Jellyfin.Plugin.JellyfinEnhanced.Helpers.ArrUrlGuard.IsAllowedUrl(baseUrl))
            {
                _logger.LogError($"Refusing to fetch {serviceName} tags — URL rejected by SSRF guard: {baseUrl}");
                return result;
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
                    return result;
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
                    return result;
                }

                var mediaContent = await mediaResponse.Content.ReadAsStringAsync(ct);
                var allItems = JsonSerializer.Deserialize<List<ArrMediaItem>>(mediaContent) ?? new List<ArrMediaItem>();

                _logger.LogInformation($"Found {allItems.Count} {itemNoun} in {serviceName}");

                // Map tags to items - keyed by the provider id Jellyfin uses
                foreach (var item in allItems)
                {
                    if (hasKey(item) && item.Tags.Count > 0)
                    {
                        var itemTags = new List<string>();
                        foreach (var tagId in item.Tags)
                        {
                            if (tagDictionary.TryGetValue(tagId, out var tagLabel))
                            {
                                itemTags.Add(tagLabel);
                            }
                        }

                        if (itemTags.Count > 0)
                        {
                            result[keySelector(item)] = itemTags;
                        }
                    }
                }

                _logger.LogInformation($"Mapped tags for {result.Count} {itemNoun}");
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

            return result;
        }
    }
}
