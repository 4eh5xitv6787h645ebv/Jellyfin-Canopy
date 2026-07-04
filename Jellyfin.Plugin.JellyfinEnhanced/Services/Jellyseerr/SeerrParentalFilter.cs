using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Globalization;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Jellyseerr
{
    /// <summary>
    /// Server-side implementation of <see cref="ISeerrParentalFilter"/>. Registered
    /// as a singleton and injected into <see cref="JellyseerrClient"/>, which calls
    /// it on the way out of the proxy (post-cache, so the shared response cache
    /// stays user-neutral).
    ///
    /// It deliberately does NOT depend on <see cref="IJellyseerrClient"/> (which
    /// depends on it) — that would form a DI cycle. Per-item certification lookups
    /// use the low-level <see cref="SeerrHttpHelper"/> directly, with the
    /// <c>X-Api-User</c> header omitted so the certification data is genuinely
    /// user-independent and safe to share via <see cref="ISeerrCache.CertScoreCache"/>.
    /// </summary>
    public sealed class SeerrParentalFilter : ISeerrParentalFilter
    {
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly ILogger<SeerrParentalFilter> _logger;
        private readonly IUserManager _userManager;
        private readonly ILocalizationManager _localization;
        private readonly ISeerrCache _seerrCache;
        private readonly IPluginConfigProvider _configProvider;

        // Process-wide coalescing of concurrent certification fetches for the same
        // title, mirroring ISeerrCache.TmdbEnrichmentInFlight. A null Task result
        // means the fetch could not be resolved (fail-closed for restricted callers).
        private readonly System.Collections.Concurrent.ConcurrentDictionary<string, Task<CertScore?>> _inFlight = new();

        // Bound per-request fan-out and total time so a cold combined_credits view
        // (whole cast+crew, easily 100-300 items) can't stall the proxy response or
        // open hundreds of sockets. Unresolved items past the deadline fail closed.
        private const int MaxConcurrentFetches = 8;
        private static readonly TimeSpan OverallBudget = TimeSpan.FromSeconds(12);
        private static readonly TimeSpan PerFetchTimeout = TimeSpan.FromSeconds(8);

        public SeerrParentalFilter(
            IHttpClientFactory httpClientFactory,
            ILogger<SeerrParentalFilter> logger,
            IUserManager userManager,
            ILocalizationManager localization,
            ISeerrCache seerrCache,
            IPluginConfigProvider configProvider)
        {
            _httpClientFactory = httpClientFactory;
            _logger = logger;
            _userManager = userManager;
            _localization = localization;
            _seerrCache = seerrCache;
            _configProvider = configProvider;
        }

        private readonly record struct CertScore(int? Score, int? SubScore);

        private enum Container
        {
            None,
            Results,
            Parts,
            CombinedCredits,
        }

        private readonly record struct FilterPlan(Container Container, string IdField, string? MediaTypeHint);

        /// <summary>Snapshot of the caller's parental policy for one filter pass.</summary>
        private readonly record struct PolicySnapshot(int? MaxScore, int? MaxSubScore, IReadOnlyCollection<UnratedItem> BlockUnrated);

        public async Task<string> FilterListBodyAsync(string json, string apiPath, JellyseerrCaller caller)
        {
            try
            {
                var config = _configProvider.ConfigurationOrNull;
                if (config == null || !config.JellyseerrRespectParentalRatings)
                {
                    return json;
                }

                // Administrators bypass parental controls, matching Jellyfin core.
                if (caller.IsAdmin)
                {
                    return json;
                }

                var plan = ClassifyPath(apiPath);
                if (plan.Container == Container.None)
                {
                    return json;
                }

                if (!TryGetPolicy(caller.JellyfinUserId, out var policy))
                {
                    return json;
                }

                // Nothing to enforce: no rating limit and no blocked-unrated types.
                if (policy.MaxScore is null && policy.BlockUnrated.Count == 0)
                {
                    return json;
                }

                if (JsonNode.Parse(json) is not JsonObject root)
                {
                    return json;
                }

                var arrays = CollectArrays(root, plan).ToList();
                if (arrays.Count == 0)
                {
                    return json;
                }

                var region = ResolveRegion(config);

                // Pass 1: resolve every movie/tv item's certification score concurrently.
                var scores = await ResolveScoresAsync(arrays, plan, region, config).ConfigureAwait(false);

                // Pass 2: drop disallowed items in place.
                foreach (var array in arrays)
                {
                    RemoveDisallowed(array, plan, region, scores, policy);
                }

                return root.ToJsonString();
            }
            catch (Exception ex)
            {
                // A filter fault must not break Seerr search. Log and pass through.
                _logger.LogWarning(ex, "Seerr parental filter failed for {ApiPath}; returning unfiltered results.", apiPath);
                return json;
            }
        }

        // ── Endpoint classification ──────────────────────────────────────────
        // Keyed on the upstream Seerr apiPath. Only genuine media result lists are
        // filtered; detail bodies, ratings, genre/keyword metadata, etc. pass through.
        private static FilterPlan ClassifyPath(string apiPath)
        {
            if (string.IsNullOrEmpty(apiPath))
            {
                return new FilterPlan(Container.None, "id", null);
            }

            // Watchlist entries: results[] with a `tmdbId` field (not `id`).
            if (apiPath.StartsWith("/api/v1/discover/watchlist", StringComparison.OrdinalIgnoreCase))
            {
                return new FilterPlan(Container.Results, "tmdbId", null);
            }

            // Discover movies/tv (genre/keyword/network/studio variants all share the prefix).
            if (apiPath.StartsWith("/api/v1/discover/movies", StringComparison.OrdinalIgnoreCase))
            {
                return new FilterPlan(Container.Results, "id", "movie");
            }

            if (apiPath.StartsWith("/api/v1/discover/tv", StringComparison.OrdinalIgnoreCase))
            {
                return new FilterPlan(Container.Results, "id", "tv");
            }

            // Similar / recommendations hang off a movie or tv id.
            bool related = apiPath.Contains("/similar", StringComparison.OrdinalIgnoreCase)
                || apiPath.Contains("/recommendations", StringComparison.OrdinalIgnoreCase);
            if (related && apiPath.StartsWith("/api/v1/movie/", StringComparison.OrdinalIgnoreCase))
            {
                return new FilterPlan(Container.Results, "id", "movie");
            }

            if (related && apiPath.StartsWith("/api/v1/tv/", StringComparison.OrdinalIgnoreCase))
            {
                return new FilterPlan(Container.Results, "id", "tv");
            }

            // Person filmography: cast[] + crew[], per-item mediaType.
            if (apiPath.StartsWith("/api/v1/person/", StringComparison.OrdinalIgnoreCase)
                && apiPath.Contains("/combined_credits", StringComparison.OrdinalIgnoreCase))
            {
                return new FilterPlan(Container.CombinedCredits, "id", null);
            }

            // Collection parts: parts[] with no per-item mediaType (all movies).
            if (apiPath.StartsWith("/api/v1/collection/", StringComparison.OrdinalIgnoreCase))
            {
                return new FilterPlan(Container.Parts, "id", "movie");
            }

            // Multi-search: results[] with a per-item mediaType. Guard against the
            // /search/keyword typeahead which is not a media list.
            if ((apiPath.StartsWith("/api/v1/search?", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(apiPath, "/api/v1/search", StringComparison.OrdinalIgnoreCase))
                && !apiPath.StartsWith("/api/v1/search/keyword", StringComparison.OrdinalIgnoreCase))
            {
                return new FilterPlan(Container.Results, "id", null);
            }

            return new FilterPlan(Container.None, "id", null);
        }

        private static IEnumerable<JsonArray> CollectArrays(JsonObject root, FilterPlan plan)
        {
            switch (plan.Container)
            {
                case Container.Results:
                    if (root["results"] is JsonArray results)
                    {
                        yield return results;
                    }

                    break;
                case Container.Parts:
                    if (root["parts"] is JsonArray parts)
                    {
                        yield return parts;
                    }

                    break;
                case Container.CombinedCredits:
                    if (root["cast"] is JsonArray cast)
                    {
                        yield return cast;
                    }

                    if (root["crew"] is JsonArray crew)
                    {
                        yield return crew;
                    }

                    break;
            }
        }

        // ── Policy resolution ────────────────────────────────────────────────
        private bool TryGetPolicy(string? jellyfinUserId, out PolicySnapshot policy)
        {
            policy = default;
            if (string.IsNullOrEmpty(jellyfinUserId) || !Guid.TryParse(jellyfinUserId, out var userGuid))
            {
                return false;
            }

            var user = _userManager.GetUserById(userGuid);
            if (user == null)
            {
                return false;
            }

            IReadOnlyCollection<UnratedItem> blockUnrated = Array.Empty<UnratedItem>();
            try
            {
                var dtoPolicy = _userManager.GetUserDto(user, string.Empty)?.Policy;
                if (dtoPolicy?.BlockUnratedItems is { Length: > 0 } blocked)
                {
                    blockUnrated = blocked;
                }
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "Could not read BlockUnratedItems for user {UserId}; treating as none.", jellyfinUserId);
            }

            policy = new PolicySnapshot(user.MaxParentalRatingScore, user.MaxParentalRatingSubScore, blockUnrated);
            return true;
        }

        private static string ResolveRegion(PluginConfiguration config)
        {
            var region = config.DEFAULT_REGION;
            return string.IsNullOrWhiteSpace(region) ? "US" : region.Trim().ToUpperInvariant();
        }

        // ── Per-item score resolution (cache -> in-flight -> fetch) ────────────
        private async Task<Dictionary<string, CertScore?>> ResolveScoresAsync(
            IReadOnlyList<JsonArray> arrays,
            FilterPlan plan,
            string region,
            PluginConfiguration config)
        {
            // Unique (mediaType, tmdbId) for movie/tv items worth resolving.
            var keys = new Dictionary<string, (string MediaType, int TmdbId)>(StringComparer.Ordinal);
            foreach (var array in arrays)
            {
                foreach (var node in array)
                {
                    if (node is not JsonObject item || IsAdult(item))
                    {
                        continue;
                    }

                    var mediaType = ResolveMediaType(item, plan);
                    if (mediaType is null)
                    {
                        continue;
                    }

                    if (!TryGetTmdbId(item, plan.IdField, out var tmdbId))
                    {
                        continue;
                    }

                    keys[CacheKey(mediaType, tmdbId, region)] = (mediaType, tmdbId);
                }
            }

            var scores = new Dictionary<string, CertScore?>(StringComparer.Ordinal);
            if (keys.Count == 0)
            {
                return scores;
            }

            using var cts = new CancellationTokenSource(OverallBudget);
            using var gate = new SemaphoreSlim(MaxConcurrentFetches);

            var tasks = keys.Select(async kvp =>
            {
                var score = await GetScoreAsync(kvp.Key, kvp.Value.MediaType, kvp.Value.TmdbId, region, config, gate, cts.Token).ConfigureAwait(false);
                return (kvp.Key, score);
            });

            foreach (var (key, score) in await Task.WhenAll(tasks).ConfigureAwait(false))
            {
                scores[key] = score;
            }

            return scores;
        }

        private async Task<CertScore?> GetScoreAsync(
            string cacheKey,
            string mediaType,
            int tmdbId,
            string region,
            PluginConfiguration config,
            SemaphoreSlim gate,
            CancellationToken ct)
        {
            if (_seerrCache.CertScoreCache.TryGetValue(cacheKey, out var cached)
                && DateTime.UtcNow - cached.CachedAt < _seerrCache.GetParentalRatingCacheTtl())
            {
                return new CertScore(cached.Score, cached.SubScore);
            }

            var task = _inFlight.GetOrAdd(cacheKey, _ => ResolveAndCacheAsync(cacheKey, mediaType, tmdbId, region, config, gate, ct));
            try
            {
                return await task.ConfigureAwait(false);
            }
            catch (Exception)
            {
                // Cancelled (over budget) or unexpected — cannot verify, fail closed.
                return null;
            }
            finally
            {
                _inFlight.TryRemove(cacheKey, out _);
            }
        }

        private async Task<CertScore?> ResolveAndCacheAsync(
            string cacheKey,
            string mediaType,
            int tmdbId,
            string region,
            PluginConfiguration config,
            SemaphoreSlim gate,
            CancellationToken ct)
        {
            await gate.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                var detail = await FetchDetailAsync(mediaType, tmdbId, config, ct).ConfigureAwait(false);
                if (detail is null)
                {
                    // Fetch failed — do NOT cache, so it retries next time. Restricted
                    // callers fail closed on the missing verification.
                    return null;
                }

                var cert = SeerrCertificationExtractor.Extract(detail.Value, mediaType, region);
                CertScore resolved;
                if (string.IsNullOrWhiteSpace(cert.Certification))
                {
                    // Genuinely unrated (known): null score routes through block-unrated.
                    resolved = new CertScore(null, null);
                }
                else
                {
                    var score = _localization.GetRatingScore(cert.Certification!, cert.Iso ?? region);
                    resolved = score is null
                        ? new CertScore(null, null)
                        : new CertScore(score.Score, score.SubScore);
                }

                _seerrCache.CertScoreCache[cacheKey] = (resolved.Score, resolved.SubScore, DateTime.UtcNow);
                return resolved;
            }
            finally
            {
                gate.Release();
            }
        }

        private async Task<JsonElement?> FetchDetailAsync(string mediaType, int tmdbId, PluginConfiguration config, CancellationToken ct)
        {
            var urls = JellyseerrClient.GetConfiguredUrls(config.JellyseerrUrls);
            if (urls.Length == 0 || string.IsNullOrEmpty(config.JellyseerrApiKey))
            {
                return null;
            }

            var relative = $"/api/v1/{(mediaType == "tv" ? "tv" : "movie")}/{tmdbId.ToString(CultureInfo.InvariantCulture)}";
            var httpClient = SeerrHttpHelper.CreateClient(_httpClientFactory);
            httpClient.Timeout = PerFetchTimeout;

            foreach (var url in urls)
            {
                var requestUri = $"{url}{relative}";
                try
                {
                    // X-Api-User is intentionally omitted: certification data does not
                    // vary per user, which is what makes the shared cert cache correct.
                    using var request = SeerrHttpHelper.BuildRequest(HttpMethod.Get, requestUri, config.JellyseerrApiKey);
                    using var response = await httpClient.SendAsync(request, ct).ConfigureAwait(false);
                    var (body, error) = await SeerrHttpHelper.ReadResponseAsync(response, requestUri, ct).ConfigureAwait(false);
                    if (error != null || string.IsNullOrEmpty(body))
                    {
                        continue;
                    }

                    using var parsed = JsonDocument.Parse(body);
                    return parsed.RootElement.Clone();
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    _logger.LogDebug(ex, "Parental filter detail fetch failed for {MediaType}/{TmdbId} at {Url}.", mediaType, tmdbId, url);
                }
            }

            return null;
        }

        // ── Pass 2: remove disallowed items in place ──────────────────────────
        private static void RemoveDisallowed(
            JsonArray array,
            FilterPlan plan,
            string region,
            IReadOnlyDictionary<string, CertScore?> scores,
            PolicySnapshot policy)
        {
            for (var i = array.Count - 1; i >= 0; i--)
            {
                if (array[i] is not JsonObject item)
                {
                    continue;
                }

                if (!ShouldKeep(item, plan, region, scores, policy))
                {
                    array.RemoveAt(i);
                }
            }
        }

        private static bool ShouldKeep(
            JsonObject item,
            FilterPlan plan,
            string region,
            IReadOnlyDictionary<string, CertScore?> scores,
            PolicySnapshot policy)
        {
            var mediaType = ResolveMediaType(item, plan);
            if (mediaType is null)
            {
                // Persons, collections, or anything not movie/tv — never rating-gated.
                return true;
            }

            if (IsAdult(item))
            {
                return false;
            }

            if (!TryGetTmdbId(item, plan.IdField, out var tmdbId))
            {
                // A movie/tv item we cannot identify cannot be verified — fail closed.
                return false;
            }

            var unratedType = mediaType == "tv" ? UnratedItem.Series : UnratedItem.Movie;

            // Missing/failed resolution => could not verify => fail closed.
            if (!scores.TryGetValue(CacheKey(mediaType, tmdbId, region), out var score) || score is null)
            {
                return false;
            }

            return ParentalRatingDecision.IsAllowed(
                score.Value.Score,
                score.Value.SubScore,
                unratedType,
                policy.MaxScore,
                policy.MaxSubScore,
                policy.BlockUnrated);
        }

        // ── Small item readers ────────────────────────────────────────────────
        private static string? ResolveMediaType(JsonObject item, FilterPlan plan)
        {
            var raw = item["mediaType"]?.GetValue<string>() ?? plan.MediaTypeHint;
            if (string.Equals(raw, "movie", StringComparison.OrdinalIgnoreCase))
            {
                return "movie";
            }

            if (string.Equals(raw, "tv", StringComparison.OrdinalIgnoreCase))
            {
                return "tv";
            }

            return null;
        }

        private static bool IsAdult(JsonObject item)
        {
            var adult = item["adult"];
            if (adult is null)
            {
                return false;
            }

            try
            {
                return adult.GetValueKind() == JsonValueKind.True;
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static bool TryGetTmdbId(JsonObject item, string idField, out int tmdbId)
        {
            tmdbId = 0;
            var node = item[idField];
            if (node is null)
            {
                return false;
            }

            try
            {
                switch (node.GetValueKind())
                {
                    case JsonValueKind.Number:
                        tmdbId = node.GetValue<int>();
                        return true;
                    case JsonValueKind.String:
                        return int.TryParse(node.GetValue<string>(), NumberStyles.Integer, CultureInfo.InvariantCulture, out tmdbId);
                    default:
                        return false;
                }
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static string CacheKey(string mediaType, int tmdbId, string region)
            => $"{mediaType}:{tmdbId.ToString(CultureInfo.InvariantCulture)}:{region}";
    }
}
