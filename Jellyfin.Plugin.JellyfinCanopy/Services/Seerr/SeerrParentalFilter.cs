using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Globalization;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Seerr
{
    /// <summary>
    /// Server-side implementation of <see cref="ISeerrParentalFilter"/>. Registered
    /// as a singleton and injected into <see cref="SeerrClient"/>, which calls
    /// it on the way out of the proxy (post-cache, so the shared response cache
    /// stays user-neutral) and before proxying request POSTs.
    ///
    /// It deliberately does NOT depend on <see cref="ISeerrClient"/> (which
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
        private readonly ConcurrentDictionary<string, Lazy<Task<TitleSignature?>>> _inFlight = new();

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

        // A title's resolved parental signals: certification score (null =
        // unrated/unknown) plus the cleaned keyword and genre name sets for
        // the tag branch, kept separate because blocked tags match keywords ∪
        // genres while allowed tags match keywords only (native parity — see
        // ParentalTagDecision). Null sets = tag data not fetched (only
        // possible on entries resolved through the light cert-only TMDB
        // endpoints; tag-rule passes always resolve the tag-bearing Seerr
        // detail).
        private readonly record struct TitleSignature(int? Score, int? SubScore, string[]? Keywords, string[]? Genres);

        private enum Category
        {
            None,
            List,
            DetailMovieTv,
            Season,
            SubDetail,
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

            /// <summary>
            /// For <see cref="Category.Season"/> and <see cref="Category.SubDetail"/>:
            /// the parent title's tmdbId (the movie/tv the sub-resource belongs to), gated
            /// on that title's rating. Its media type is carried by <see cref="DetailMediaType"/>.
            /// </summary>
            public int ParentTvId { get; init; }
        }

        /// <summary>Snapshot of the caller's parental policy for one pass.</summary>
        private readonly record struct PolicySnapshot(
            int? MaxScore,
            int? MaxSubScore,
            IReadOnlyCollection<UnratedItem> BlockUnrated,
            IReadOnlyCollection<string> BlockedTags,
            IReadOnlyCollection<string> AllowedTags)
        {
            /// <summary>True when the tag branch has anything to enforce.</summary>
            public bool HasTagRules => BlockedTags.Count > 0 || AllowedTags.Count > 0;
        }

        /// <summary>
        /// Immutable subset of configuration used by an upstream parental lookup.
        /// Admin saves normally replace the configuration object, but retaining a
        /// value snapshot also prevents an in-place edit from changing a flight's
        /// source or credential halfway through its fallback sequence.
        /// </summary>
        private readonly record struct FetchConfiguration(
            string SeerrUrls,
            string SeerrApiKey,
            string TmdbApiKey,
            TimeSpan CacheTtl);

        /// <summary>Active gate for a restricted caller (feature on, non-admin, has a limit).</summary>
        private readonly record struct GateContext(
            PolicySnapshot Policy,
            string Region,
            FetchConfiguration FetchConfig,
            long ConfigurationRevision,
            string ConfigurationIdentity,
            SeerrMutationConfigStamp ConfigurationStamp);

        public async Task<SeerrParentalResult> ApplyAsync(string json, string apiPath, SeerrCaller caller)
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

                    case Category.SubDetail:
                        // A movie/tv sub-resource (ratingscombined, ratings, watch/providers,
                        // …) carries no rating of its own; gate it on the parent title so a
                        // blocked title exposes none of its sub-resources while the bare
                        // detail already 403s.
                        return await IsTitleBlockedAsync(plan.DetailMediaType!, plan.ParentTvId, g).ConfigureAwait(false)
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
                return new SeerrParentalResult(false, json, Succeeded: false);
            }
        }

        public async Task<bool> IsBlockedAsync(string mediaType, int tmdbId, SeerrCaller caller)
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
                // This method protects non-idempotent request mutations. If the
                // caller's policy cannot be resolved authoritatively, allowing the
                // POST would bypass the parental control with no safe way to undo it.
                _logger.LogWarning(ex, "Seerr parental request gate failed for {MediaType}/{TmdbId}; blocking.", mediaType, tmdbId);
                return true;
            }
        }

        public async Task<bool> IsTmdbProxyPathBlockedAsync(string tmdbApiPath, SeerrCaller caller)
        {
            try
            {
                var gate = await ResolveGateAsync(caller).ConfigureAwait(false);
                if (gate is null)
                {
                    return false; // admin / no-limit / feature or Seerr off
                }

                var decision = TmdbProxyPathClassifier.Classify(tmdbApiPath);
                return decision.Gate switch
                {
                    TmdbProxyGate.Neutral => false,
                    TmdbProxyGate.Restricted => true,
                    TmdbProxyGate.DetailGate => await IsTitleBlockedAsync(decision.MediaType, decision.TmdbId, gate.Value).ConfigureAwait(false),
                    _ => true,
                };
            }
            catch (Exception ex)
            {
                // The classifier is pure/exception-free, so this only trips on a genuine
                // gate-resolution fault. The raw passthrough cannot filter its response
                // body after the fact, so an indeterminate gate must fail closed.
                _logger.LogWarning(ex, "TMDB proxy gate failed for {ApiPath}; blocking.", tmdbApiPath);
                return true;
            }
        }

        // ── Gate resolution (shared fast paths) ───────────────────────────────
        private async Task<GateContext?> ResolveGateAsync(SeerrCaller caller)
        {
            var config = _configProvider.ConfigurationOrNull;
            if (config == null || !config.SeerrRespectParentalRatings)
            {
                return null;
            }

            // The gate resolves certifications through Seerr; if Seerr isn't
            // configured it cannot verify anything, so it stays inactive rather
            // than fail-closed-blocking every title (which would break the raw
            // TMDB passthrough for Elsewhere-only setups).
            if (string.IsNullOrEmpty(config.SeerrUrls) || string.IsNullOrEmpty(config.SeerrApiKey))
            {
                return null;
            }

            // Administrators bypass parental controls, matching Jellyfin core.
            if (caller.IsAdmin)
            {
                return null;
            }

            if (!TryGetPolicy(caller.JellyfinUserId, config, out var policy))
            {
                return null;
            }

            // Nothing to enforce: no rating limit, no blocked-unrated types,
            // and no blocked/allowed tags.
            if (policy.MaxScore is null && policy.BlockUnrated.Count == 0 && !policy.HasTagRules)
            {
                return null;
            }

            var revision = _configProvider.ConfigurationRevision;
            var configurationStamp = SeerrMutationConfigStamp.Capture(config, revision);
            var fetchConfig = new FetchConfiguration(
                config.SeerrUrls ?? string.Empty,
                config.SeerrApiKey ?? string.Empty,
                config.TMDB_API_KEY ?? string.Empty,
                TimeSpan.FromMinutes(Math.Max(1, config.SeerrParentalRatingCacheTtlMinutes)));
            var configurationIdentity = BuildConfigurationIdentity(config);

            // Kept async-shaped for a stable seam; nothing to await today.
            await Task.CompletedTask.ConfigureAwait(false);
            return new GateContext(
                policy,
                ResolveRegion(config),
                fetchConfig,
                revision,
                configurationIdentity,
                configurationStamp);
        }

        private bool IsCurrentConfiguration(GateContext gate)
            => gate.ConfigurationStamp.Matches(
                _configProvider.ConfigurationOrNull,
                _configProvider.ConfigurationRevision);

        private static string BuildConfigurationIdentity(PluginConfiguration config)
        {
            // The digest deliberately binds the normalized source set, both
            // upstream credentials, and the complete configuration. No source
            // credential is exposed in the process-wide cache key.
            var fullConfigDigest = Convert.ToHexString(
                SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(config)));
            var identityMaterial = JsonSerializer.SerializeToUtf8Bytes(new
            {
                Sources = SeerrClient.GetConfiguredUrls(config.SeerrUrls),
                SeerrApiKey = config.SeerrApiKey ?? string.Empty,
                TmdbApiKey = config.TMDB_API_KEY ?? string.Empty,
                FullConfigDigest = fullConfigDigest,
            });
            return Convert.ToHexString(SHA256.HashData(identityMaterial));
        }

        private bool TryGetPolicy(string? jellyfinUserId, PluginConfiguration config, out PolicySnapshot policy)
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
            IReadOnlyCollection<string> blockedTags = Array.Empty<string>();
            IReadOnlyCollection<string> allowedTags = Array.Empty<string>();
            try
            {
                var dtoPolicy = _userManager.GetUserDto(user, string.Empty)?.Policy;
                if (dtoPolicy?.BlockUnratedItems is { Length: > 0 } blocked)
                {
                    blockUnrated = blocked;
                }

                // Tag branch of the native parental controls. Both lists are
                // normalized with core's own GetCleanValue (inside CleanTags)
                // so matching cannot drift from BaseItem.IsVisibleViaTags.
                // The kill-switch drops them wholesale, reverting to
                // rating-only behavior.
                if (config.SeerrRespectBlockedTags)
                {
                    if (dtoPolicy?.BlockedTags is { Length: > 0 } rawBlocked)
                    {
                        blockedTags = ParentalTagDecision.CleanTags(rawBlocked);
                    }

                    if (dtoPolicy?.AllowedTags is { Length: > 0 } rawAllowed)
                    {
                        allowedTags = ParentalTagDecision.CleanTags(rawAllowed);
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "Could not read parental policy lists for user {UserId}; treating as none.", jellyfinUserId);
            }

            policy = new PolicySnapshot(user.MaxParentalRatingScore, user.MaxParentalRatingSubScore, blockUnrated, blockedTags, allowedTags);
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

            // The detail body in hand is the Seerr full detail — it carries the
            // keyword/genre containers, so the tag signature extracts directly.
            var signature = SignatureFromDetail(detail, mediaType, gate.Region, includeTags: gate.Policy.HasTagRules);
            return !IsAllowed(signature, mediaType, gate.Policy);
        }

        private async Task<bool> IsTitleBlockedAsync(string mediaType, int tmdbId, GateContext gate)
        {
            if (tmdbId <= 0)
            {
                return true; // cannot identify -> fail closed
            }

            if (!IsCurrentConfiguration(gate))
            {
                return true;
            }

            using var cts = new CancellationTokenSource(PerFetchTimeout);
            var signature = await GetSignatureAsync(
                CacheKey(mediaType, tmdbId, gate.Region), mediaType, tmdbId, gate,
                needTags: gate.Policy.HasTagRules, cts.Token).ConfigureAwait(false);
            if (signature is null || !IsCurrentConfiguration(gate))
            {
                return true; // fetch failed, stale generation, or unverifiable -> fail closed
            }

            return !IsAllowed(signature, mediaType, gate.Policy);
        }

        private static bool IsAllowed(TitleSignature? signature, string mediaType, PolicySnapshot policy)
        {
            var unratedType = mediaType == "tv" ? UnratedItem.Series : UnratedItem.Movie;

            // signature == null here means "resolved as unrated"; only
            // IsTitleBlockedAsync treats a *failed* resolution as blocked
            // before calling this.
            var ratingAllowed = ParentalRatingDecision.IsAllowed(
                signature?.Score,
                signature?.SubScore,
                unratedType,
                policy.MaxScore,
                policy.MaxSubScore,
                policy.BlockUnrated);
            if (!ratingAllowed)
            {
                return false;
            }

            if (!policy.HasTagRules)
            {
                return true;
            }

            // Tag branch. A missing tag set under active tag rules means the
            // title could not be verified -> fail closed, mirroring the
            // cert path's posture.
            if (signature?.Keywords is not { } keywords || signature?.Genres is not { } genres)
            {
                return false;
            }

            return ParentalTagDecision.IsAllowed(keywords, genres, policy.BlockedTags, policy.AllowedTags);
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
            var removed = 0;
            foreach (var array in arrays)
            {
                var before = array.Count;
                RemoveDisallowed(array, plan, gate, scores);
                removed += before - array.Count;
            }

            if (!IsCurrentConfiguration(gate))
            {
                // A save can land after ResolveScoresAsync's final generation
                // check. Re-run the removal with no trusted signatures so no
                // title authorized by the stale generation is returned.
                var noTrustedScores = new Dictionary<string, TitleSignature?>(StringComparer.Ordinal);
                foreach (var array in arrays)
                {
                    var before = array.Count;
                    RemoveDisallowed(array, plan, gate, noTrustedScores);
                    removed += before - array.Count;
                }
            }

            // Keep paginators honest: when rows are dropped, decrement the count fields
            // so the client's totals/page math reflect what it actually received. Only
            // top-level result-count containers carry these; parts/credits lists have
            // none, so this is a no-op there.
            if (removed > 0)
            {
                DecrementListCounts(root, removed);
            }

            return root.ToJsonString();
        }

        // Decrements the result/page counters (both the Seerr `pageInfo` shape and the
        // TMDB-style top-level `totalResults`/`totalPages`) by the number of rows the
        // filter removed, recomputing page counts from the surviving results.
        private static void DecrementListCounts(JsonObject root, int removed)
        {
            if (root["pageInfo"] is JsonObject pageInfo)
            {
                AdjustCounts(pageInfo, "results", "pages", ReadIntOrNull(pageInfo, "pageSize"), removed);
            }

            AdjustCounts(root, "totalResults", "totalPages", null, removed);
        }

        private static void AdjustCounts(JsonObject obj, string resultsField, string pagesField, int? pageSize, int removed)
        {
            if (!TryReadInt(obj, resultsField, out var oldResults))
            {
                return;
            }

            var newResults = Math.Max(0, oldResults - removed);
            obj[resultsField] = newResults;

            if (!TryReadInt(obj, pagesField, out var oldPages) || oldPages <= 0)
            {
                return;
            }

            // Prefer an explicit page size; otherwise infer it from the pre-adjustment
            // results/pages so the recomputed page count stays internally consistent.
            var effectivePageSize = pageSize is > 0
                ? pageSize.Value
                : (int)Math.Ceiling(oldResults / (double)oldPages);
            if (effectivePageSize <= 0)
            {
                return;
            }

            obj[pagesField] = (int)Math.Ceiling(newResults / (double)effectivePageSize);
        }

        private static int? ReadIntOrNull(JsonObject obj, string field)
            => TryReadInt(obj, field, out var value) ? value : null;

        private static bool TryReadInt(JsonObject obj, string field, out int value)
        {
            value = 0;
            var node = obj[field];
            if (node is null || node.GetValueKind() != JsonValueKind.Number)
            {
                return false;
            }

            try
            {
                value = node.GetValue<int>();
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }

        private async Task<Dictionary<string, TitleSignature?>> ResolveScoresAsync(
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

            var scores = new Dictionary<string, TitleSignature?>(StringComparer.Ordinal);
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
                    return (kvp.Key, (TitleSignature?)null); // over budget while queued -> fail closed
                }

                try
                {
                    var score = await GetSignatureAsync(
                        kvp.Key,
                        kvp.Value.MediaType,
                        kvp.Value.TmdbId,
                        gate,
                        needTags: gate.Policy.HasTagRules,
                        cts.Token).ConfigureAwait(false);
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

            // A generation change after the last individual lookup invalidates
            // the whole snapshot. An empty score map makes every identifiable
            // movie/series row fail closed in the existing removal pass.
            if (!IsCurrentConfiguration(gate))
            {
                scores.Clear();
            }

            return scores;
        }

        private void RemoveDisallowed(
            JsonArray array,
            EndpointPlan plan,
            GateContext gate,
            IReadOnlyDictionary<string, TitleSignature?> scores)
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
            IReadOnlyDictionary<string, TitleSignature?> scores)
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
            IReadOnlyDictionary<string, TitleSignature?> scores)
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

        // ── Signature resolution (cache -> in-flight -> fetch) ─────────────────
        private TitleSignature? SignatureFromDetail(JsonElement detail, string mediaType, string region, bool includeTags)
        {
            string[]? keywords = null;
            string[]? genres = null;
            if (includeTags)
            {
                var extracted = SeerrTagSignatureExtractor.Extract(detail);
                keywords = extracted.Keywords.Count == 0 ? Array.Empty<string>() : extracted.Keywords.ToArray();
                genres = extracted.Genres.Count == 0 ? Array.Empty<string>() : extracted.Genres.ToArray();
            }

            var cert = SeerrCertificationExtractor.Extract(detail, mediaType, region);
            if (string.IsNullOrWhiteSpace(cert.Certification))
            {
                return new TitleSignature(null, null, keywords, genres); // known-unrated
            }

            var score = _localization.GetRatingScore(cert.Certification!, cert.Iso ?? region);
            return score is null ? new TitleSignature(null, null, keywords, genres) : new TitleSignature(score.Score, score.SubScore, keywords, genres);
        }

        private async Task<TitleSignature?> GetSignatureAsync(
            string cacheKey,
            string mediaType,
            int tmdbId,
            GateContext gate,
            bool needTags,
            CancellationToken ct)
        {
            var generationCacheKey = GenerationCacheKey(cacheKey, gate);

            // A cached entry satisfies a tag-rule pass only if its tag set was
            // actually resolved (entries written by rating-only passes through
            // the light cert endpoints carry Tags == null).
            if (_seerrCache.CertScoreCache.TryGetValue(generationCacheKey, out var cached)
                && DateTime.UtcNow - cached.CachedAt < gate.FetchConfig.CacheTtl
                && (!needTags || cached.Keywords != null)
                && IsCurrentConfiguration(gate))
            {
                return new TitleSignature(cached.Score, cached.SubScore, cached.Keywords, cached.Genres);
            }

            if (!IsCurrentConfiguration(gate))
            {
                return null;
            }

            // Coalesce concurrent fetches for the same title. The shared task carries
            // its OWN timeout (never the caller's budget); each caller bounds only its
            // own wait via WaitAsync(ct), so one request's budget can't cancel a fetch
            // another request depends on.
            // Tag-bearing and cert-only fetches coalesce separately: a
            // rating-only fetch in flight cannot satisfy a tag-rule caller.
            var inFlightKey = needTags ? generationCacheKey + "|tags" : generationCacheKey;
            var task = Helpers.AsyncSingleFlight.GetOrAdd(
                _inFlight,
                inFlightKey,
                () => FetchSignatureAsync(
                    generationCacheKey,
                    mediaType,
                    tmdbId,
                    gate,
                    needTags));

            try
            {
                var resolved = await task.WaitAsync(ct).ConfigureAwait(false);
                return IsCurrentConfiguration(gate) ? resolved : null;
            }
            catch (Exception)
            {
                // Our wait was cancelled (over budget) or the fetch faulted — cannot
                // verify -> fail closed. The shared task keeps running for others.
                return null;
            }
        }

        private async Task<TitleSignature?> FetchSignatureAsync(
            string generationCacheKey,
            string mediaType,
            int tmdbId,
            GateContext gate,
            bool needTags)
        {
            using var cts = new CancellationTokenSource(PerFetchTimeout);
            var (detail, hasTagData) = await FetchDetailAsync(
                mediaType,
                tmdbId,
                gate.FetchConfig,
                needTags,
                cts.Token).ConfigureAwait(false);
            if (detail is null || !IsCurrentConfiguration(gate))
            {
                // Fetch failed — do NOT cache, so it retries next time. Restricted
                // callers fail closed on missing or stale-generation verification.
                return null;
            }

            // Extract tags whenever the body carries them (opportunistically on
            // Seerr-detail cert fetches too), so later tag-rule passes hit the
            // cache instead of re-fetching.
            var resolved = SignatureFromDetail(detail.Value, mediaType, gate.Region, includeTags: hasTagData)
                ?? new TitleSignature(null, null, hasTagData ? Array.Empty<string>() : null, hasTagData ? Array.Empty<string>() : null);

            if (!IsCurrentConfiguration(gate))
            {
                return null;
            }

            // Atomic write with a narrow tag-preservation rule. A light
            // cert-only result must not erase tags a CONCURRENT full fetch
            // just cached (the split in-flight keys allow both to run at
            // once) — but it must equally not resurrect EXPIRED tags: light
            // fetches only run when the entry is stale/missing, and stamping
            // old tags with a fresh timestamp would extend them another TTL,
            // letting upstream keyword changes (e.g. a title gaining
            // "horror") bypass a tag-restricted user until the next expiry.
            // So tags are preserved only while the existing entry is itself
            // still within TTL — in practice, the seconds-wide race window.
            var now = DateTime.UtcNow;
            var ttl = gate.FetchConfig.CacheTtl;
            var published = _seerrCache.CertScoreCache.AddOrUpdate(
                generationCacheKey,
                _ => (resolved.Score, resolved.SubScore, resolved.Keywords, resolved.Genres, now),
                (_, current) =>
                {
                    var keywords = resolved.Keywords;
                    var genres = resolved.Genres;
                    if (keywords is null && current.Keywords != null && (now - current.CachedAt) < ttl)
                    {
                        keywords = current.Keywords;
                        genres = current.Genres;
                    }
                    return (resolved.Score, resolved.SubScore, keywords, genres, now);
                });

            // The generation may have changed in the narrow interval between
            // the pre-publication check and AddOrUpdate. Remove only this exact
            // value and never return it to a waiter from a newer generation.
            if (!IsCurrentConfiguration(gate))
            {
                Helpers.AsyncSingleFlight.TryRemoveExact(
                    _seerrCache.CertScoreCache,
                    generationCacheKey,
                    published);
                return null;
            }

            return resolved;
        }

        // Resolves the signal source for a title. For rating-only passes it
        // prefers TMDB's dedicated release_dates/content_ratings endpoints
        // (tiny payload, one hop; carries NO tag data) and falls back to
        // Seerr's full-detail proxy. When tag rules are active the Seerr full
        // detail is REQUIRED — it is the one body carrying certifications AND
        // keywords/genres, and the gate only activates when Seerr is
        // configured, so it is always reachable. Returns whether the body is
        // tag-bearing so the caller caches Tags correctly.
        private async Task<(JsonElement? Detail, bool HasTagData)> FetchDetailAsync(
            string mediaType,
            int tmdbId,
            FetchConfiguration config,
            bool needTags,
            CancellationToken ct)
        {
            if (!needTags && !string.IsNullOrEmpty(config.TmdbApiKey))
            {
                var fromTmdb = await FetchCertFromTmdbAsync(mediaType, tmdbId, config, ct).ConfigureAwait(false);
                if (fromTmdb is not null)
                {
                    return (fromTmdb, false);
                }
            }

            var fromSeerr = await FetchDetailFromSeerrAsync(mediaType, tmdbId, config, ct).ConfigureAwait(false);
            return (fromSeerr, fromSeerr is not null);
        }

        private async Task<JsonElement?> FetchCertFromTmdbAsync(
            string mediaType,
            int tmdbId,
            FetchConfiguration config,
            CancellationToken ct)
        {
            var subResource = mediaType == "tv" ? "content_ratings" : "release_dates";
            var requestUri = $"https://api.themoviedb.org/3/{(mediaType == "tv" ? "tv" : "movie")}/{tmdbId.ToString(CultureInfo.InvariantCulture)}/{subResource}?api_key={config.TmdbApiKey}";
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

        private async Task<JsonElement?> FetchDetailFromSeerrAsync(
            string mediaType,
            int tmdbId,
            FetchConfiguration config,
            CancellationToken ct)
        {
            var urls = SeerrClient.GetConfiguredUrls(config.SeerrUrls);
            if (urls.Length == 0 || string.IsNullOrEmpty(config.SeerrApiKey))
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
                    using var request = SeerrHttpHelper.BuildRequest(HttpMethod.Get, requestUri, config.SeerrApiKey);
                    var (body, error, _) = await SeerrHttpHelper.SendAndReadJsonAsync(
                        httpClient,
                        request,
                        requestUri,
                        ct).ConfigureAwait(false);
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

            // Trending: results[] mixing movie/tv (and, for mediaType=all, person/collection).
            // No MediaTypeHint — ResolveMediaType reads each row's own `mediaType`, so movie/tv
            // rows are rating-gated and person/collection rows are kept (never ratable). `id` is
            // the tmdbId (default IdField). Must precede /discover/movies|tv (distinct prefix).
            if (apiPath.StartsWith("/api/v1/discover/trending", StringComparison.OrdinalIgnoreCase))
            {
                return new EndpointPlan { Category = Category.List, Container = Container.Results };
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

                // Any other sub-resource (ratingscombined, watch/providers, …): gate on the
                // parent movie so a blocked title exposes none of its sub-resources.
                return TryParseId(apiPath, "/api/v1/movie/", out var movieSubId)
                    ? new EndpointPlan { Category = Category.SubDetail, DetailMediaType = "movie", ParentTvId = movieSubId }
                    : new EndpointPlan { Category = Category.None };
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

                // Any other sub-resource (ratings, watch/providers, …): gate on the parent
                // show so a blocked title exposes none of its sub-resources.
                return TryParseId(apiPath, "/api/v1/tv/", out var tvSubId)
                    ? new EndpointPlan { Category = Category.SubDetail, DetailMediaType = "tv", ParentTvId = tvSubId }
                    : new EndpointPlan { Category = Category.None };
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

        private static string GenerationCacheKey(string titleKey, GateContext gate)
            => $"{titleKey}|cfg:{gate.ConfigurationRevision.ToString(CultureInfo.InvariantCulture)}:{gate.ConfigurationIdentity}";
    }
}
