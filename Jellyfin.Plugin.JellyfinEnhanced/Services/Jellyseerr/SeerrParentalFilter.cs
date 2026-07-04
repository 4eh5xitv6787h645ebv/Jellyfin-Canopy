using System;
using System.Collections.Concurrent;
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
    /// stays user-neutral) and before proxying request POSTs.
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
        private readonly ConcurrentDictionary<string, Task<CertScore?>> _inFlight = new();

        // Bound per-request fan-out and total time so a cold combined_credits view
        // (whole cast+crew, easily 100-300 items) can't stall the proxy response or
        // open hundreds of sockets. Unresolved items past the deadline fail closed.
        // Sized so a typical ~20-item discovery/search page resolves in one wave;
        // certifications are tiny and cached for 24h, so the burst is cheap.
        private const int MaxConcurrentFetches = 20;
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

        private enum Category
        {
            None,
            List,
            DetailMovieTv,
            Season,
        }

        private enum Container
        {
            Results,
            Parts,
            CombinedCredits,
        }

        private sealed record EndpointPlan
        {
            public Category Category { get; init; }

            public Container Container { get; init; }

            public string IdField { get; init; } = "id";

            public string? MediaTypeHint { get; init; }

            /// <summary>Request-list rows carry the tmdbId/mediaType under a nested <c>media</c> object.</summary>
            public bool NestedMedia { get; init; }

            /// <summary>For <see cref="Category.DetailMovieTv"/>: the title's media type.</summary>
            public string? DetailMediaType { get; init; }

            /// <summary>For <see cref="Category.Season"/>: the parent show's tmdbId (gated by the show's rating).</summary>
            public int ParentTvId { get; init; }
        }

        /// <summary>Snapshot of the caller's parental policy for one pass.</summary>
        private readonly record struct PolicySnapshot(int? MaxScore, int? MaxSubScore, IReadOnlyCollection<UnratedItem> BlockUnrated);

        /// <summary>Active gate for a restricted caller (feature on, non-admin, has a limit).</summary>
        private readonly record struct GateContext(PluginConfiguration Config, PolicySnapshot Policy, string Region);

        public async Task<SeerrParentalResult> ApplyAsync(string json, string apiPath, JellyseerrCaller caller)
        {
            try
            {
                var gate = await ResolveGateAsync(caller).ConfigureAwait(false);
                if (gate is null)
                {
                    return new SeerrParentalResult(false, json);
                }

                var g = gate.Value;
                var plan = ClassifyPath(apiPath);
                switch (plan.Category)
                {
                    case Category.DetailMovieTv:
                        return IsDetailBodyBlocked(json, plan.DetailMediaType!, g)
                            ? new SeerrParentalResult(true, string.Empty)
                            : new SeerrParentalResult(false, json);

                    case Category.Season:
                        return await IsTitleBlockedAsync("tv", plan.ParentTvId, g).ConfigureAwait(false)
                            ? new SeerrParentalResult(true, string.Empty)
                            : new SeerrParentalResult(false, json);

                    case Category.List:
                        return new SeerrParentalResult(false, await FilterListAsync(json, plan, g).ConfigureAwait(false));

                    default:
                        return new SeerrParentalResult(false, json);
                }
            }
            catch (Exception ex)
            {
                // A filter fault must not break Seerr. Log and pass through.
                _logger.LogWarning(ex, "Seerr parental filter failed for {ApiPath}; returning unfiltered results.", apiPath);
                return new SeerrParentalResult(false, json);
            }
        }

        public async Task<bool> IsBlockedAsync(string mediaType, int tmdbId, JellyseerrCaller caller)
        {
            try
            {
                var gate = await ResolveGateAsync(caller).ConfigureAwait(false);
                if (gate is null)
                {
                    return false;
                }

                var normalized = string.Equals(mediaType, "tv", StringComparison.OrdinalIgnoreCase) ? "tv" : "movie";
                return await IsTitleBlockedAsync(normalized, tmdbId, gate.Value).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Seerr parental request gate failed for {MediaType}/{TmdbId}; allowing.", mediaType, tmdbId);
                return false;
            }
        }

        // ── Gate resolution (shared fast paths) ───────────────────────────────
        private async Task<GateContext?> ResolveGateAsync(JellyseerrCaller caller)
        {
            var config = _configProvider.ConfigurationOrNull;
            if (config == null || !config.JellyseerrRespectParentalRatings)
            {
                return null;
            }

            // The gate resolves certifications through Seerr; if Seerr isn't
            // configured it cannot verify anything, so it stays inactive rather
            // than fail-closed-blocking every title (which would break the raw
            // TMDB passthrough for Elsewhere-only setups).
            if (string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.JellyseerrApiKey))
            {
                return null;
            }

            // Administrators bypass parental controls, matching Jellyfin core.
            if (caller.IsAdmin)
            {
                return null;
            }

            if (!TryGetPolicy(caller.JellyfinUserId, out var policy))
            {
                return null;
            }

            // Nothing to enforce: no rating limit and no blocked-unrated types.
            if (policy.MaxScore is null && policy.BlockUnrated.Count == 0)
            {
                return null;
            }

            // Kept async-shaped for a stable seam; nothing to await today.
            await Task.CompletedTask.ConfigureAwait(false);
            return new GateContext(config, policy, ResolveRegion(config));
        }

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

        // ── Detail / single-title decisions ───────────────────────────────────
        private bool IsDetailBodyBlocked(string json, string mediaType, GateContext gate)
        {
            JsonElement detail;
            try
            {
                using var doc = JsonDocument.Parse(json);
                detail = doc.RootElement.Clone();
            }
            catch (JsonException)
            {
                // Can't verify a restricted caller's detail body -> fail closed (block).
                return true;
            }

            var score = ScoreFromDetail(detail, mediaType, gate.Region);
            return !IsAllowed(score, mediaType, gate.Policy);
        }

        private async Task<bool> IsTitleBlockedAsync(string mediaType, int tmdbId, GateContext gate)
        {
            if (tmdbId <= 0)
            {
                return true; // cannot identify -> fail closed
            }

            using var cts = new CancellationTokenSource(PerFetchTimeout);
            var score = await GetScoreAsync(CacheKey(mediaType, tmdbId, gate.Region), mediaType, tmdbId, gate.Region, gate.Config, cts.Token).ConfigureAwait(false);
            if (score is null)
            {
                return true; // fetch failed / unverifiable -> fail closed
            }

            return !IsAllowed(score, mediaType, gate.Policy);
        }

        private static bool IsAllowed(CertScore? score, string mediaType, PolicySnapshot policy)
        {
            var unratedType = mediaType == "tv" ? UnratedItem.Series : UnratedItem.Movie;

            // score == null here means "resolved as unrated"; only IsTitleBlockedAsync
            // treats a *failed* resolution as blocked before calling this.
            return ParentalRatingDecision.IsAllowed(
                score?.Score,
                score?.SubScore,
                unratedType,
                policy.MaxScore,
                policy.MaxSubScore,
                policy.BlockUnrated);
        }

        // ── List filtering ────────────────────────────────────────────────────
        private async Task<string> FilterListAsync(string json, EndpointPlan plan, GateContext gate)
        {
            if (JsonNode.Parse(json) is not JsonObject root)
            {
                return json;
            }

            var arrays = CollectArrays(root, plan).ToList();
            if (arrays.Count == 0)
            {
                return json;
            }

            var scores = await ResolveScoresAsync(arrays, plan, gate).ConfigureAwait(false);
            foreach (var array in arrays)
            {
                RemoveDisallowed(array, plan, gate, scores);
            }

            return root.ToJsonString();
        }

        private async Task<Dictionary<string, CertScore?>> ResolveScoresAsync(
            IReadOnlyList<JsonArray> arrays,
            EndpointPlan plan,
            GateContext gate)
        {
            var keys = new Dictionary<string, (string MediaType, int TmdbId)>(StringComparer.Ordinal);
            foreach (var array in arrays)
            {
                foreach (var node in array)
                {
                    if (node is not JsonObject row)
                    {
                        continue;
                    }

                    // The row's own rating-gated title (nested under `media` for requests).
                    var item = ResolveItemObject(node, plan);
                    if (item is not null && !IsAdult(item))
                    {
                        var mediaType = ResolveMediaType(item, plan);
                        if (mediaType is not null && TryGetTmdbId(item, plan.IdField, out var tmdbId))
                        {
                            keys[CacheKey(mediaType, tmdbId, gate.Region)] = (mediaType, tmdbId);
                        }
                    }

                    // Person results embed a `knownFor` array of movie/tv titles that
                    // must be filtered too (else a restricted user recovers them from
                    // the response body).
                    CollectKnownForKeys(row, gate.Region, keys);
                }
            }

            var scores = new Dictionary<string, CertScore?>(StringComparer.Ordinal);
            if (keys.Count == 0)
            {
                return scores;
            }

            using var cts = new CancellationTokenSource(OverallBudget);
            using var throttle = new SemaphoreSlim(MaxConcurrentFetches);

            // The throttle bounds THIS request's fan-out; the budget token bounds THIS
            // request's total wait. Neither is passed into the shared fetch task, so one
            // request's budget can't cancel a fetch another request is awaiting.
            var tasks = keys.Select(async kvp =>
            {
                try
                {
                    await throttle.WaitAsync(cts.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    return (kvp.Key, (CertScore?)null); // over budget while queued -> fail closed
                }

                try
                {
                    var score = await GetScoreAsync(kvp.Key, kvp.Value.MediaType, kvp.Value.TmdbId, gate.Region, gate.Config, cts.Token).ConfigureAwait(false);
                    return (kvp.Key, score);
                }
                finally
                {
                    throttle.Release();
                }
            });

            foreach (var (key, score) in await Task.WhenAll(tasks).ConfigureAwait(false))
            {
                scores[key] = score;
            }

            return scores;
        }

        private void RemoveDisallowed(
            JsonArray array,
            EndpointPlan plan,
            GateContext gate,
            IReadOnlyDictionary<string, CertScore?> scores)
        {
            for (var i = array.Count - 1; i >= 0; i--)
            {
                if (array[i] is not JsonObject row)
                {
                    continue;
                }

                // The decision reads the identifying fields (nested under `media` for
                // request rows); removal always drops the whole row at index i.
                var item = ResolveItemObject(array[i], plan);

                // No usable object to evaluate (e.g. a request row with no media
                // record) is nothing to leak — keep the row.
                if (item is null)
                {
                    continue;
                }

                if (!ShouldKeep(item, plan, gate, scores))
                {
                    array.RemoveAt(i);
                    continue;
                }

                // Kept rows may still embed a `knownFor` array of titles to filter.
                FilterKnownFor(row, gate, scores);
            }
        }

        // Removes blocked movie/tv entries from a person result's `knownFor` array.
        private static void FilterKnownFor(
            JsonObject row,
            GateContext gate,
            IReadOnlyDictionary<string, CertScore?> scores)
        {
            if (row["knownFor"] is not JsonArray knownFor)
            {
                return;
            }

            for (var j = knownFor.Count - 1; j >= 0; j--)
            {
                if (knownFor[j] is not JsonObject entry)
                {
                    continue;
                }

                var mediaType = NormalizeMediaType(ReadString(entry, "mediaType"));
                if (mediaType is null)
                {
                    continue; // not a movie/tv known-for entry — nothing to rating-gate
                }

                if (IsAdult(entry)
                    || !TryGetTmdbId(entry, "id", out var tmdbId)
                    || !scores.TryGetValue(CacheKey(mediaType, tmdbId, gate.Region), out var score)
                    || score is null
                    || !IsAllowed(score, mediaType, gate.Policy))
                {
                    knownFor.RemoveAt(j);
                }
            }
        }

        private static void CollectKnownForKeys(
            JsonObject row,
            string region,
            IDictionary<string, (string MediaType, int TmdbId)> keys)
        {
            if (row["knownFor"] is not JsonArray knownFor)
            {
                return;
            }

            foreach (var node in knownFor)
            {
                if (node is not JsonObject entry || IsAdult(entry))
                {
                    continue;
                }

                var mediaType = NormalizeMediaType(ReadString(entry, "mediaType"));
                if (mediaType is not null && TryGetTmdbId(entry, "id", out var tmdbId))
                {
                    keys[CacheKey(mediaType, tmdbId, region)] = (mediaType, tmdbId);
                }
            }
        }

        private bool ShouldKeep(
            JsonObject item,
            EndpointPlan plan,
            GateContext gate,
            IReadOnlyDictionary<string, CertScore?> scores)
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
                return false; // a movie/tv item we cannot identify cannot be verified — fail closed
            }

            // Missing/failed resolution => could not verify => fail closed.
            if (!scores.TryGetValue(CacheKey(mediaType, tmdbId, gate.Region), out var score) || score is null)
            {
                return false;
            }

            return IsAllowed(score, mediaType, gate.Policy);
        }

        // ── Score resolution (cache -> in-flight -> fetch) ─────────────────────
        private CertScore? ScoreFromDetail(JsonElement detail, string mediaType, string region)
        {
            var cert = SeerrCertificationExtractor.Extract(detail, mediaType, region);
            if (string.IsNullOrWhiteSpace(cert.Certification))
            {
                return new CertScore(null, null); // known-unrated
            }

            var score = _localization.GetRatingScore(cert.Certification!, cert.Iso ?? region);
            return score is null ? new CertScore(null, null) : new CertScore(score.Score, score.SubScore);
        }

        private async Task<CertScore?> GetScoreAsync(
            string cacheKey,
            string mediaType,
            int tmdbId,
            string region,
            PluginConfiguration config,
            CancellationToken ct)
        {
            if (_seerrCache.CertScoreCache.TryGetValue(cacheKey, out var cached)
                && DateTime.UtcNow - cached.CachedAt < _seerrCache.GetParentalRatingCacheTtl())
            {
                return new CertScore(cached.Score, cached.SubScore);
            }

            // Coalesce concurrent fetches for the same title. The shared task carries
            // its OWN timeout (never the caller's budget); each caller bounds only its
            // own wait via WaitAsync(ct), so one request's budget can't cancel a fetch
            // another request depends on.
            var task = _inFlight.GetOrAdd(cacheKey, key =>
            {
                var fetch = FetchScoreAsync(key, mediaType, tmdbId, region, config);
                // Self-evict on completion so the map doesn't accumulate finished tasks.
                _ = fetch.ContinueWith(
                    completed => _inFlight.TryRemove(new KeyValuePair<string, Task<CertScore?>>(key, completed)),
                    CancellationToken.None,
                    TaskContinuationOptions.ExecuteSynchronously,
                    TaskScheduler.Default);
                return fetch;
            });

            try
            {
                return await task.WaitAsync(ct).ConfigureAwait(false);
            }
            catch (Exception)
            {
                // Our wait was cancelled (over budget) or the fetch faulted — cannot
                // verify -> fail closed. The shared task keeps running for others.
                return null;
            }
        }

        private async Task<CertScore?> FetchScoreAsync(
            string cacheKey,
            string mediaType,
            int tmdbId,
            string region,
            PluginConfiguration config)
        {
            using var cts = new CancellationTokenSource(PerFetchTimeout);
            var detail = await FetchDetailAsync(mediaType, tmdbId, config, cts.Token).ConfigureAwait(false);
            if (detail is null)
            {
                // Fetch failed — do NOT cache, so it retries next time. Restricted
                // callers fail closed on the missing verification.
                return null;
            }

            var resolved = ScoreFromDetail(detail.Value, mediaType, region) ?? new CertScore(null, null);
            _seerrCache.CertScoreCache[cacheKey] = (resolved.Score, resolved.SubScore, DateTime.UtcNow);
            return resolved;
        }

        // Resolves the certification source for a title. Prefers TMDB's dedicated
        // release_dates/content_ratings endpoints (tiny payload, one hop) and only
        // falls back to Seerr's heavy full-detail proxy when no TMDB key is set or
        // the direct call fails. Both feed the same extractor (which accepts the
        // wrapped and unwrapped shapes).
        private async Task<JsonElement?> FetchDetailAsync(string mediaType, int tmdbId, PluginConfiguration config, CancellationToken ct)
        {
            if (!string.IsNullOrEmpty(config.TMDB_API_KEY))
            {
                var fromTmdb = await FetchCertFromTmdbAsync(mediaType, tmdbId, config, ct).ConfigureAwait(false);
                if (fromTmdb is not null)
                {
                    return fromTmdb;
                }
            }

            return await FetchDetailFromSeerrAsync(mediaType, tmdbId, config, ct).ConfigureAwait(false);
        }

        private async Task<JsonElement?> FetchCertFromTmdbAsync(string mediaType, int tmdbId, PluginConfiguration config, CancellationToken ct)
        {
            var subResource = mediaType == "tv" ? "content_ratings" : "release_dates";
            var requestUri = $"https://api.themoviedb.org/3/{(mediaType == "tv" ? "tv" : "movie")}/{tmdbId.ToString(CultureInfo.InvariantCulture)}/{subResource}?api_key={config.TMDB_API_KEY}";
            try
            {
                var httpClient = Helpers.PluginHttpClients.CreateTmdbClient(_httpClientFactory);
                httpClient.Timeout = PerFetchTimeout;
                using var response = await httpClient.GetAsync(requestUri, ct).ConfigureAwait(false);
                if (!response.IsSuccessStatusCode)
                {
                    return null;
                }

                var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
                if (string.IsNullOrEmpty(body))
                {
                    return null;
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
                _logger.LogDebug(ex, "TMDB certification fetch failed for {MediaType}/{TmdbId}; falling back to Seerr.", mediaType, tmdbId);
                return null;
            }
        }

        private async Task<JsonElement?> FetchDetailFromSeerrAsync(string mediaType, int tmdbId, PluginConfiguration config, CancellationToken ct)
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

        // ── Endpoint classification ───────────────────────────────────────────
        private static EndpointPlan ClassifyPath(string apiPath)
        {
            if (string.IsNullOrEmpty(apiPath))
            {
                return new EndpointPlan { Category = Category.None };
            }

            // Requests list: results[] with tmdbId/mediaType nested under `media`.
            if (apiPath.StartsWith("/api/v1/request", StringComparison.OrdinalIgnoreCase))
            {
                return new EndpointPlan { Category = Category.List, Container = Container.Results, IdField = "tmdbId", MediaTypeHint = null, NestedMedia = true };
            }

            // Watchlist entries: results[] with a flat `tmdbId` field.
            if (apiPath.StartsWith("/api/v1/discover/watchlist", StringComparison.OrdinalIgnoreCase))
            {
                return new EndpointPlan { Category = Category.List, Container = Container.Results, IdField = "tmdbId" };
            }

            // Discover movies/tv (genre/keyword/network/studio variants share the prefix).
            if (apiPath.StartsWith("/api/v1/discover/movies", StringComparison.OrdinalIgnoreCase))
            {
                return new EndpointPlan { Category = Category.List, Container = Container.Results, MediaTypeHint = "movie" };
            }

            if (apiPath.StartsWith("/api/v1/discover/tv", StringComparison.OrdinalIgnoreCase))
            {
                return new EndpointPlan { Category = Category.List, Container = Container.Results, MediaTypeHint = "tv" };
            }

            bool related = apiPath.Contains("/similar", StringComparison.OrdinalIgnoreCase)
                || apiPath.Contains("/recommendations", StringComparison.OrdinalIgnoreCase);

            // Movie/TV detail, season, similar, recommendations — inspect the shape.
            if (apiPath.StartsWith("/api/v1/movie/", StringComparison.OrdinalIgnoreCase))
            {
                if (related)
                {
                    return new EndpointPlan { Category = Category.List, Container = Container.Results, MediaTypeHint = "movie" };
                }

                // Bare /api/v1/movie/{id} (no further path segment, ignoring query).
                if (IsBareDetail(apiPath, "/api/v1/movie/"))
                {
                    return new EndpointPlan { Category = Category.DetailMovieTv, DetailMediaType = "movie" };
                }

                return new EndpointPlan { Category = Category.None }; // ratingscombined etc.
            }

            if (apiPath.StartsWith("/api/v1/tv/", StringComparison.OrdinalIgnoreCase))
            {
                if (related)
                {
                    return new EndpointPlan { Category = Category.List, Container = Container.Results, MediaTypeHint = "tv" };
                }

                if (apiPath.Contains("/season/", StringComparison.OrdinalIgnoreCase))
                {
                    return TryParseId(apiPath, "/api/v1/tv/", out var parentTvId)
                        ? new EndpointPlan { Category = Category.Season, ParentTvId = parentTvId }
                        : new EndpointPlan { Category = Category.None };
                }

                if (IsBareDetail(apiPath, "/api/v1/tv/"))
                {
                    return new EndpointPlan { Category = Category.DetailMovieTv, DetailMediaType = "tv" };
                }

                return new EndpointPlan { Category = Category.None }; // ratings etc.
            }

            // Person filmography: cast[] + crew[], per-item mediaType.
            if (apiPath.StartsWith("/api/v1/person/", StringComparison.OrdinalIgnoreCase)
                && apiPath.Contains("/combined_credits", StringComparison.OrdinalIgnoreCase))
            {
                return new EndpointPlan { Category = Category.List, Container = Container.CombinedCredits };
            }

            // Collection parts: parts[] with no per-item mediaType (all movies).
            if (apiPath.StartsWith("/api/v1/collection/", StringComparison.OrdinalIgnoreCase))
            {
                return new EndpointPlan { Category = Category.List, Container = Container.Parts, MediaTypeHint = "movie" };
            }

            // Multi-search: results[] with a per-item mediaType. Exclude /search/keyword.
            if ((apiPath.StartsWith("/api/v1/search?", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(apiPath, "/api/v1/search", StringComparison.OrdinalIgnoreCase))
                && !apiPath.StartsWith("/api/v1/search/keyword", StringComparison.OrdinalIgnoreCase))
            {
                return new EndpointPlan { Category = Category.List, Container = Container.Results };
            }

            return new EndpointPlan { Category = Category.None };
        }

        // True for /api/v1/{type}/{id} with no further path segment (query allowed).
        private static bool IsBareDetail(string apiPath, string prefix)
        {
            var tail = apiPath.Substring(prefix.Length);
            var q = tail.IndexOf('?');
            if (q >= 0)
            {
                tail = tail.Substring(0, q);
            }

            return tail.Length > 0 && !tail.Contains('/');
        }

        private static bool TryParseId(string apiPath, string prefix, out int id)
        {
            id = 0;
            var tail = apiPath.Substring(prefix.Length);
            var slash = tail.IndexOf('/');
            var idPart = slash >= 0 ? tail.Substring(0, slash) : tail;
            return int.TryParse(idPart, NumberStyles.Integer, CultureInfo.InvariantCulture, out id);
        }

        private static IEnumerable<JsonArray> CollectArrays(JsonObject root, EndpointPlan plan)
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

        // ── Item readers ──────────────────────────────────────────────────────
        // For request rows, the identifying fields live under a nested `media` object.
        private static JsonObject? ResolveItemObject(JsonNode? node, EndpointPlan plan)
        {
            if (node is not JsonObject row)
            {
                return null;
            }

            if (!plan.NestedMedia)
            {
                return row;
            }

            return row["media"] as JsonObject;
        }

        // Read defensively: a non-string mediaType (a malformed or future upstream
        // shape) must never throw — that would fail the whole list OPEN.
        private static string? ResolveMediaType(JsonObject item, EndpointPlan plan)
            => NormalizeMediaType(ReadString(item, "mediaType") ?? plan.MediaTypeHint);

        private static string? NormalizeMediaType(string? raw)
        {
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

        private static string? ReadString(JsonObject item, string property)
        {
            var node = item[property];
            return node?.GetValueKind() == JsonValueKind.String ? node.GetValue<string>() : null;
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
