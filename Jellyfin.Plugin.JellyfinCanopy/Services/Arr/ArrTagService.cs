using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Model.Arr;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Arr
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
        [JsonRequired]
        public List<int>? Tags { get; set; }
    }

    public class ArrTag
    {
        [JsonPropertyName("id")]
        [JsonRequired]
        public int Id { get; set; }

        [JsonPropertyName("label")]
        [JsonRequired]
        public string? Label { get; set; }
    }

    /// <summary>
    /// A snapshot whose completeness is explicit. A failed snapshot carries an empty value
    /// supplied by the caller so consumers cannot accidentally treat partial data as complete.
    /// </summary>
    /// <typeparam name="T">The snapshot value type.</typeparam>
    public sealed class ArrSnapshotResult<T>
    {
        private ArrSnapshotResult(bool isComplete, T value, string? failureReason)
        {
            IsComplete = isComplete;
            Value = value;
            FailureReason = failureReason;
        }

        public bool IsComplete { get; }

        public T Value { get; }

        public string? FailureReason { get; }

        public static ArrSnapshotResult<T> Complete(T value)
            => new ArrSnapshotResult<T>(true, value, null);

        public static ArrSnapshotResult<T> Failed(T empty, string failureReason)
        {
            if (string.IsNullOrWhiteSpace(failureReason))
            {
                throw new ArgumentException("A failure reason is required.", nameof(failureReason));
            }

            return new ArrSnapshotResult<T>(false, empty, failureReason);
        }
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
        public async Task<ArrSnapshotResult<SeriesTagMaps>> GetSeriesTagsAsync(
            string sonarrUrl,
            string apiKey,
            CancellationToken ct = default)
        {
            var byTvdbId = new Dictionary<int, List<string>>();
            var byImdbId = new Dictionary<string, List<string>>();
            var empty = new SeriesTagMaps(byTvdbId, byImdbId);

            var fetched = await FetchTagsAndItemsAsync(ArrType.Sonarr, sonarrUrl, apiKey, ct).ConfigureAwait(false);
            if (!fetched.IsComplete)
            {
                return ArrSnapshotResult<SeriesTagMaps>.Failed(
                    empty,
                    fetched.FailureReason ?? "Sonarr snapshot fetch failed.");
            }

            try
            {
                foreach (var item in fetched.Value.Items)
                {
                    ct.ThrowIfCancellationRequested();
                    if (item.Tags == null || item.Tags.Count == 0)
                    {
                        continue;
                    }

                    var itemTags = ResolveLabels(item, fetched.Value.TagLabels);
                    if (itemTags.Count == 0)
                    {
                        continue;
                    }

                    // Separate list copies per map so a later per-instance merge can't mutate
                    // the other map's value through a shared reference.
                    if (item.TvdbId > 0)
                    {
                        MergeTagLabels(byTvdbId, item.TvdbId, itemTags);
                    }

                    if (!string.IsNullOrWhiteSpace(item.ImdbId))
                    {
                        MergeTagLabels(byImdbId, item.ImdbId, itemTags);
                    }
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Unexpected error mapping Sonarr tag snapshot");
                return ArrSnapshotResult<SeriesTagMaps>.Failed(
                    new SeriesTagMaps(new Dictionary<int, List<string>>(), new Dictionary<string, List<string>>()),
                    "Unexpected error while mapping Sonarr tag snapshot.");
            }

            _logger.LogInformation($"Mapped Sonarr tags for {byTvdbId.Count} series by TVDB, {byImdbId.Count} by IMDb");
            return ArrSnapshotResult<SeriesTagMaps>.Complete(empty);
        }

        /// <summary>Radarr: tag labels keyed by movie TmdbId.</summary>
        public async Task<ArrSnapshotResult<Dictionary<int, List<string>>>> GetMovieTagsByTmdbId(
            string radarrUrl,
            string apiKey,
            CancellationToken ct = default)
        {
            var result = new Dictionary<int, List<string>>();

            var fetched = await FetchTagsAndItemsAsync(ArrType.Radarr, radarrUrl, apiKey, ct).ConfigureAwait(false);
            if (!fetched.IsComplete)
            {
                return ArrSnapshotResult<Dictionary<int, List<string>>>.Failed(
                    result,
                    fetched.FailureReason ?? "Radarr snapshot fetch failed.");
            }

            try
            {
                foreach (var item in fetched.Value.Items)
                {
                    ct.ThrowIfCancellationRequested();
                    if (item.TmdbId > 0 && item.Tags != null && item.Tags.Count > 0)
                    {
                        var itemTags = ResolveLabels(item, fetched.Value.TagLabels);
                        if (itemTags.Count > 0)
                        {
                            MergeTagLabels(result, item.TmdbId, itemTags);
                        }
                    }
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Unexpected error mapping Radarr tag snapshot");
                return ArrSnapshotResult<Dictionary<int, List<string>>>.Failed(
                    new Dictionary<int, List<string>>(),
                    "Unexpected error while mapping Radarr tag snapshot.");
            }

            _logger.LogInformation($"Mapped tags for {result.Count} movies");
            return ArrSnapshotResult<Dictionary<int, List<string>>>.Complete(result);
        }

        /// <summary>
        /// Fetches the tag label map and the full media list from one *arr instance in a
        /// single tag + media round-trip. Failures are returned explicitly so callers cannot
        /// confuse an unavailable or malformed upstream with a valid empty collection.
        /// </summary>
        private async Task<ArrSnapshotResult<FetchedArrSnapshot>> FetchTagsAndItemsAsync(
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
            if (!await Jellyfin.Plugin.JellyfinCanopy.Helpers.ArrUrlGuard
                .IsAllowedUrlAsync(baseUrl, ct)
                .ConfigureAwait(false))
            {
                _logger.LogError($"Refusing to fetch {serviceName} tags — URL rejected by SSRF guard: {baseUrl}");
                return FetchFailed($"{serviceName} URL was rejected by the SSRF guard.");
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
                using var tagsResponse = await httpClient.SendAsync(tagsRequest, ct).ConfigureAwait(false);

                // Only a complete 200 response can be deletion authority. In particular, a 206
                // array may be syntactically valid while omitting tags outside the returned range.
                if (tagsResponse.StatusCode != HttpStatusCode.OK)
                {
                    _logger.LogError($"Failed to fetch {serviceName} tags. Status: {tagsResponse.StatusCode}");
                    return FetchFailed($"{serviceName} tag request returned HTTP {(int)tagsResponse.StatusCode}.");
                }

                var tagsContent = await tagsResponse.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
                var tags = DeserializeCollection<ArrTag>(tagsContent);
                if (tags.Any(tag => tag.Id <= 0 || string.IsNullOrWhiteSpace(tag.Label))
                    || tags.Select(tag => tag.Id).Distinct().Count() != tags.Count)
                {
                    throw new ArrSnapshotValidationException(
                        "tag entries require unique positive ids and non-blank labels.");
                }

                var tagDictionary = tags.ToDictionary(t => t.Id, t => t.Label!);

                _logger.LogInformation($"Found {tags.Count} tags in {serviceName}");

                // Get all media items (series/movies)
                _logger.LogInformation($"Fetching {serviceName} {itemNoun} from {baseUrl}");
                var mediaUrl = $"{baseUrl.TrimEnd('/')}/api/v3/{mediaEndpoint}";
                using var mediaRequest = Helpers.PluginHttpClients.BuildArrRequest(HttpMethod.Get, mediaUrl, apiKey);
                using var mediaResponse = await httpClient.SendAsync(mediaRequest, ct).ConfigureAwait(false);

                if (mediaResponse.StatusCode != HttpStatusCode.OK)
                {
                    _logger.LogError($"Failed to fetch {serviceName} {itemNoun}. Status: {mediaResponse.StatusCode}");
                    return FetchFailed($"{serviceName} {itemNoun} request returned HTTP {(int)mediaResponse.StatusCode}.");
                }

                var mediaContent = await mediaResponse.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
                var allItems = DeserializeCollection<ArrMediaItem>(mediaContent);
                if (allItems.Any(item => item.Tags == null))
                {
                    throw new ArrSnapshotValidationException(
                        "media entries require a non-null tags collection.");
                }

                // A media response that references an id absent from the tag response is not
                // a coherent snapshot (for example, the two endpoint reads raced a deletion).
                // Treat it as incomplete instead of silently dropping the unresolved tag and
                // authorizing Jellyfin metadata deletion from a partial projection.
                if (allItems.Any(item => item.Tags!.Any(tagId => !tagDictionary.ContainsKey(tagId))))
                {
                    throw new ArrSnapshotValidationException(
                        "media entries referenced an unknown tag id.");
                }

                if (arrType == ArrType.Radarr
                    && allItems.Any(item => item.TmdbId <= 0))
                {
                    throw new ArrSnapshotValidationException(
                        "movie entries require a positive TMDB id.");
                }

                if (arrType == ArrType.Sonarr
                    && allItems.Any(item => item.TvdbId <= 0))
                {
                    throw new ArrSnapshotValidationException(
                        "series entries require a positive TVDB id.");
                }

                _logger.LogInformation($"Found {allItems.Count} {itemNoun} in {serviceName}");

                return ArrSnapshotResult<FetchedArrSnapshot>.Complete(
                    new FetchedArrSnapshot(allItems, tagDictionary));
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
                return FetchFailed($"{serviceName} request failed.");
            }
            catch (TaskCanceledException ex)
            {
                _logger.LogError($"Timeout fetching {serviceName} tags: {ex.Message}");
                return FetchFailed($"{serviceName} request timed out.");
            }
            catch (ArrSnapshotValidationException ex)
            {
                _logger.LogError($"Inconsistent {serviceName} tag snapshot: {ex.Message}");
                return FetchFailed($"{serviceName} snapshot was inconsistent: {ex.Message}");
            }
            catch (JsonException ex)
            {
                _logger.LogError($"Invalid JSON in {serviceName} tag snapshot response: {ex.Message}");
                return FetchFailed($"{serviceName} returned malformed JSON.");
            }
            catch (Exception ex)
            {
                _logger.LogError($"Unexpected error fetching {serviceName} tags: {ex.Message}");
                return FetchFailed($"Unexpected error while fetching {serviceName} tag snapshot.");
            }
        }

        private static List<T> DeserializeCollection<T>(string content)
            where T : class
        {
            var values = JsonSerializer.Deserialize<List<T>>(content);
            if (values == null || values.Any(value => value == null))
            {
                throw new JsonException("Expected a JSON array containing non-null objects.");
            }

            return values;
        }

        private static ArrSnapshotResult<FetchedArrSnapshot> FetchFailed(string failureReason)
            => ArrSnapshotResult<FetchedArrSnapshot>.Failed(
                new FetchedArrSnapshot(new List<ArrMediaItem>(), new Dictionary<int, string>()),
                failureReason);

        /// <summary>Resolves an item's tag ids to their labels via the fetched label map.</summary>
        private static List<string> ResolveLabels(ArrMediaItem item, Dictionary<int, string> tagLabels)
        {
            var itemTags = new List<string>();
            foreach (var tagId in item.Tags ?? throw new JsonException("Arr media tags were unavailable."))
            {
                if (tagLabels.TryGetValue(tagId, out var tagLabel))
                {
                    itemTags.Add(tagLabel);
                }
            }

            return itemTags;
        }

        /// <summary>
        /// Conservatively unions labels when one response repeats a provider identity. Arr should
        /// normally enforce uniqueness, but unioning keeps either entry from becoming accidental
        /// deletion authority while still yielding a usable snapshot.
        /// </summary>
        private static void MergeTagLabels<TKey>(
            Dictionary<TKey, List<string>> destination,
            TKey key,
            IReadOnlyList<string> labels)
            where TKey : notnull
        {
            if (!destination.TryGetValue(key, out var merged))
            {
                destination[key] = new List<string>(labels);
                return;
            }

            foreach (var label in labels)
            {
                if (!merged.Contains(label, StringComparer.OrdinalIgnoreCase))
                {
                    merged.Add(label);
                }
            }
        }

        private sealed record FetchedArrSnapshot(
            List<ArrMediaItem> Items,
            Dictionary<int, string> TagLabels);

        private sealed class ArrSnapshotValidationException : Exception
        {
            public ArrSnapshotValidationException(string message)
                : base(message)
            {
            }
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
