using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Querying;
using MediaBrowser.Model.Search;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services
{
    public sealed class HiddenContentResponseFilter : IAsyncActionFilter
    {
        private const string FileName = "hidden-content.json";
        private const string CacheKey = "__JE_HC_FILTER_CACHE";

        // Cross-request in-memory cache keyed by userId (N-format string).
        // Eliminates per-request disk reads for hidden-content.json.
        private static readonly TimeSpan _hcCacheTtl = TimeSpan.FromSeconds(30);
        private static readonly BoundedTtlCache<string, (HideContext Ctx, DateTime CachedAt)> _hcCache = new(
            maximumEntries: 2_048,
            maximumWeight: 100_000,
            weight: static (_, entry) => 1L
                + entry.Ctx.ItemIdScopes.Count
                + entry.Ctx.SeriesIdScopes.Count,
            comparer: StringComparer.OrdinalIgnoreCase,
            defaultTtl: () => _hcCacheTtl);

        /// <summary>
        /// Removes the cached hidden-content context for the given user so the next
        /// request re-reads from disk. Call this immediately after any write to
        /// hidden-content.json for that user.
        /// </summary>
        public static void InvalidateUser(string userId)
        {
            if (!string.IsNullOrEmpty(userId))
                _hcCache.TryRemove(userId, out _);
        }

        // Test seam: seed an (empty) cache entry for a user so a test can prove a writer invalidated
        // it. Kept internal (Tests has InternalsVisibleTo) so no public surface leaks.
        internal static void SeedCacheForTest(string userIdN)
        {
            if (!string.IsNullOrEmpty(userIdN))
                _hcCache[userIdN] = (HideContext.Empty, DateTime.UtcNow);
        }

        // Test seam for exercising the real MVC action-filter route without
        // coupling a response-contract regression to filesystem persistence.
        internal static void SeedRequestPolicyForTest(HttpContext httpContext, UserHiddenContent policy)
        {
            ArgumentNullException.ThrowIfNull(httpContext);
            ArgumentNullException.ThrowIfNull(policy);
            httpContext.Items[CacheKey] = HideContext.Build(policy);
        }

        // Test seam: whether a cache entry currently exists for a user.
        internal static bool IsCachedForTest(string userIdN)
            => !string.IsNullOrEmpty(userIdN) && _hcCache.ContainsKey(userIdN);

        // Test seam: force a user's cache entry to appear stale (TTL elapsed) WITHOUT
        // removing it, so the next read re-reads disk while the entry is still present
        // as last-known-good. Distinct from InvalidateUser, which drops the entry (the
        // repair path). Lets a test prove LKG retention across a genuine TTL expiry
        // deterministically without a wall-clock wait.
        internal static void ExpireCacheForTest(string userIdN)
        {
            if (!string.IsNullOrEmpty(userIdN) && _hcCache.TryGetValue(userIdN, out var e))
                _hcCache[userIdN] = (e.Ctx, DateTime.MinValue);
        }

        // Test seam: run the real disk+cache load path for a user on a fresh request
        // and report whether the given item would be hidden on the given surface.
        // Returns primitives only so the private HideContext never leaks.
        internal bool WouldHideForTest(Guid userId, string itemIdN, string surface)
        {
            var hide = LoadHideContext(new DefaultHttpContext(), userId);
            return IsHiddenById(itemIdN, null, hide, surface);
        }

        private static readonly Dictionary<(string, string), (string Surface, ResponseHandler Handler)> _routes
            = new(KeyComparer.Instance)
        {
            { ("Items", "GetResumeItems"),         ("continuewatching", FilterQueryResult) },
            { ("Items", "GetResumeItemsLegacy"),   ("continuewatching", FilterQueryResult) },
            { ("Items", "GetItems"),               ("library",          FilterQueryResult) },
            { ("Items", "GetItemsByUserIdLegacy"), ("library",          FilterQueryResult) },
            { ("UserLibrary", "GetLatestMedia"),       ("library", FilterEnumerable) },
            { ("UserLibrary", "GetLatestMediaLegacy"), ("library", FilterEnumerable) },
            { ("TvShows", "GetNextUp"),                ("nextup",          FilterQueryResult) },
            { ("TvShows", "GetUpcomingEpisodes"),      ("upcoming",        FilterQueryResult) },
            { ("Suggestions", "GetSuggestions"),       ("recommendations", FilterQueryResult) },
            { ("Suggestions", "GetSuggestionsLegacy"), ("recommendations", FilterQueryResult) },
            { ("Search", "GetSearchHints"),            ("search",          FilterSearchHints) },
        };

        private delegate void ResponseHandler(
            ActionExecutedContext executed,
            HideContext hide,
            string surface,
            ILogger<HiddenContentResponseFilter> logger,
            HiddenContentHierarchyResolver hierarchyResolver,
            Guid userId,
            CancellationToken cancellationToken);

        // Re-warn at most once per hour so a real Jellyfin upgrade isn't permanently invisible after the first warn.
        private static readonly TimeSpan ShapeMismatchReWarnInterval = TimeSpan.FromHours(1);
        private static readonly BoundedTtlCache<string, DateTime> _warnedShapeMismatchAt = new(
            maximumEntries: 256,
            maximumWeight: 256 * 1024,
            weight: static (key, _) => key.Length + sizeof(long),
            comparer: StringComparer.Ordinal,
            defaultTtl: () => ShapeMismatchReWarnInterval);
        private static readonly BoundedTtlCache<Guid, byte> _warnedReadFailure = new(
            maximumEntries: 2_048,
            maximumWeight: 2_048,
            defaultTtl: static () => TimeSpan.FromDays(7));
        private static readonly BoundedTtlCache<string, byte> _warnedHierarchyFailure = new(
            maximumEntries: 16,
            maximumWeight: 512,
            weight: static (key, _) => key.Length + 1L,
            comparer: StringComparer.Ordinal,
            defaultTtl: static () => TimeSpan.FromHours(1));

        private static void WarnShapeMismatchOnce(ILogger<HiddenContentResponseFilter> logger, string surface, string handlerName, IActionResult? result)
        {
            var now = DateTime.UtcNow;
            // AddOrUpdate returns the stored value. Equality with `now` means our new timestamp won the slot — log.
            var stored = _warnedShapeMismatchAt.AddOrUpdate(
                surface,
                _ => now,
                (_, last) => (now - last) >= ShapeMismatchReWarnInterval ? now : last);
            if (stored != now) return;
            var actualType = result?.GetType().FullName ?? "(null)";
            logger.LogWarning($"HC filter: {handlerName} for surface '{surface}' got an unexpected response shape ({actualType}); filter is no-op for this endpoint. Likely a Jellyfin upgrade changed the response type. Re-warns hourly.");
        }

        private readonly UserConfigurationManager _configManager;
        private readonly ILogger<HiddenContentResponseFilter> _logger;
        private readonly IPluginConfigProvider _configProvider;
        private readonly HiddenContentHierarchyResolver _hierarchyResolver;

        public HiddenContentResponseFilter(
            UserConfigurationManager configManager,
            ILogger<HiddenContentResponseFilter> logger,
            IPluginConfigProvider configProvider,
            HiddenContentHierarchyResolver hierarchyResolver)
        {
            _configManager = configManager;
            _logger = logger;
            _configProvider = configProvider;
            _hierarchyResolver = hierarchyResolver;
        }

        public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
        {
            if (!TryGetRoute(context, out var route))
            {
                await next().ConfigureAwait(false);
                return;
            }

            var hcEnabled = _configProvider.ConfigurationOrNull?.HiddenContentEnabled == true;
            var rcwEnabled = _configProvider.ConfigurationOrNull?.RemoveContinueWatchingEnabled == true;

            // /Items doubles as library list + search results — searchTerm wins, then fall back to library.
            var surface = (route.Surface == "library" && HasSearchTerm(context))
                ? "search"
                : route.Surface;

            // RemoveContinueWatchingEnabled keeps the home-section Remove surfaces (Continue
            // Watching + Next Up) filtering on even when HC's master switch is off.
            var isRemoveSurface = string.Equals(surface, "continuewatching", StringComparison.OrdinalIgnoreCase)
                || string.Equals(surface, "nextup", StringComparison.OrdinalIgnoreCase);
            if (!hcEnabled && !(rcwEnabled && isRemoveSurface))
            {
                await next().ConfigureAwait(false);
                return;
            }

            var userId = UserHelper.GetCurrentUserId(context.HttpContext.User) ?? Guid.Empty;
            if (userId == Guid.Empty)
            {
                await next().ConfigureAwait(false);
                return;
            }

            var hide = LoadHideContext(context.HttpContext, userId);
            if (hide.IsEmpty)
            {
                await next().ConfigureAwait(false);
                return;
            }

            // Pure metadata-resolver Ids calls bypass — JC's batchCheckParentSeries cascade caches missing IDs as deleted forever.
            if (surface == "library" && IsMetadataResolverIdsCall(context))
            {
                await next().ConfigureAwait(false);
                return;
            }

            var executed = await next().ConfigureAwait(false);
            try
            {
                route.Handler(
                    executed,
                    hide,
                    surface,
                    _logger,
                    _hierarchyResolver,
                    userId,
                    context.HttpContext.RequestAborted);
            }
            catch (Exception ex)
            {
                _logger.LogError($"HC response filter handler failed for surface '{route.Surface}' — entries will pass through unfiltered for this request: {ex.Message}");
            }
        }

        private static bool HasSearchTerm(ActionExecutingContext context)
        {
            var q = context.HttpContext?.Request?.Query;
            if (q == null) return false;
            return HasNonEmpty(q, "searchTerm") || HasNonEmpty(q, "SearchTerm");
        }

        private static bool HasNonEmpty(IQueryCollection q, string key)
            => q.TryGetValue(key, out var v) && !string.IsNullOrWhiteSpace(v.ToString());

        private static bool IsMetadataResolverIdsCall(ActionExecutingContext context)
        {
            var q = context.HttpContext?.Request?.Query;
            if (q == null) return false;
            if (!HasNonEmpty(q, "Ids") && !HasNonEmpty(q, "ids")) return false;
            if (IsRecursiveTrue(q, "Recursive") || IsRecursiveTrue(q, "recursive")) return false;
            if (HasNonEmpty(q, "ParentId") || HasNonEmpty(q, "parentId")) return false;
            return true;
        }

        private static bool IsRecursiveTrue(IQueryCollection q, string key)
            => q.TryGetValue(key, out var v) && string.Equals(v.ToString().Trim(), "true", StringComparison.OrdinalIgnoreCase);

        private static bool TryGetRoute(ActionExecutingContext context, out (string Surface, ResponseHandler Handler) route)
        {
            route = default;
            var rv = context.RouteData?.Values;
            if (rv is null) return false;
            if (!rv.TryGetValue("controller", out var rawC) || rawC is not string controller) return false;
            if (!rv.TryGetValue("action", out var rawA) || rawA is not string action) return false;
            return _routes.TryGetValue((controller, action), out route);
        }

        private HideContext LoadHideContext(HttpContext httpContext, Guid userId)
        {
            // 1. Per-request cache, avoids repeated work within a single request (e.g. nested filter calls).
            if (httpContext.Items.TryGetValue(CacheKey, out var cached) && cached is HideContext hit)
            {
                return hit;
            }

            // 2. Cross-request in-memory cache, avoids disk reads on every Jellyfin API call.
            //    The entry doubles as last-known-good: a stale entry is retained (not
            //    dropped) so a policy fault can fall back to it instead of failing open.
            var userIdN = userId.ToString("N");
            var now = DateTime.UtcNow;
            var hasEntry = _hcCache.TryGetValue(userIdN, out var entry);
            if (hasEntry && (now - entry.CachedAt) < _hcCacheTtl)
            {
                httpContext.Items[CacheKey] = entry.Ctx;
                return entry.Ctx;
            }

            // 3. Cache miss or stale — typed, side-effect-free read from disk.
            var read = _configManager.ReadUserConfiguration<UserHiddenContent>(userIdN, FileName);
            var lastKnownGood = hasEntry ? entry.Ctx : null;
            var ctx = ResolvePolicyContext(read, lastKnownGood);

            if (read.IsFault)
            {
                // Dedup once per user per process so a persistent fault doesn't spam Error on every matched request.
                if (_warnedReadFailure.TryAdd(userId, 0))
                {
                    var posture = lastKnownGood != null
                        ? "retaining last-known-good hidden-content protection"
                        : "no last-known-good — failing CLOSED (hiding all matched surfaces)";
                    _logger.LogError($"HC response filter: {read.Status} hidden-content.json for user {userId} ({read.FaultDetail}) — {posture} until repaired.");
                }
            }
            else
            {
                _warnedReadFailure.TryRemove(userId, out _);
            }

            // Cache the resolved context (an intentional policy, retained LKG, or the
            // fail-closed sentinel) with a fresh timestamp — never an empty fail-open
            // entry after a fault. A repair invalidates this via InvalidateUser.
            _hcCache.Set(userIdN, (ctx, now), _hcCacheTtl);
            httpContext.Items[CacheKey] = ctx;
            return ctx;
        }

        // Pure policy decision: how a typed read maps to the enforced context.
        //   Missing/Valid → build from the (possibly empty) value — an intentional policy.
        //   Corrupt/Unavailable → retain last-known-good if present, else fail closed.
        // A missing file is the common "feature enabled globally, user never configured
        // it" case and MUST pass through, so only genuine faults trigger protection.
        private static HideContext ResolvePolicyContext(UserConfigReadResult<UserHiddenContent> read, HideContext? lastKnownGood)
            => read.HasUsableValue
                ? HideContext.Build(read.Value)
                : (lastKnownGood ?? HideContext.FailClosed);

        private static void FilterQueryResult(
            ActionExecutedContext executed,
            HideContext hide,
            string surface,
            ILogger<HiddenContentResponseFilter> logger,
            HiddenContentHierarchyResolver hierarchyResolver,
            Guid userId,
            CancellationToken cancellationToken)
        {
            if (executed.Result is not ObjectResult or || or.Value is not QueryResult<BaseItemDto> qr)
            {
                WarnShapeMismatchOnce(logger, surface, nameof(FilterQueryResult), executed.Result);
                return;
            }
            var filtered = FilterQueryResultCore(qr, hide, surface, out var dropped);
            if (dropped > 0) or.Value = filtered;
            PostPaginationFilterContract.MarkResponse(executed.HttpContext.Response, dropped);
        }

        private static QueryResult<BaseItemDto> FilterQueryResultCore(
            QueryResult<BaseItemDto> result,
            HideContext hide,
            string surface,
            out int dropped)
        {
            var items = result.Items;
            if (items is null || items.Count == 0)
            {
                dropped = 0;
                return result;
            }

            var kept = new List<BaseItemDto>(items.Count);
            dropped = 0;
            foreach (var item in items)
            {
                if (IsHidden(item, hide, surface)) { dropped++; continue; }
                kept.Add(item);
            }
            if (dropped == 0) return result;

            return new QueryResult<BaseItemDto>(
                result.StartIndex,
                PostPaginationFilterContract.NavigationTotal(result.TotalRecordCount, dropped),
                kept);
        }

        private static void FilterEnumerable(
            ActionExecutedContext executed,
            HideContext hide,
            string surface,
            ILogger<HiddenContentResponseFilter> logger,
            HiddenContentHierarchyResolver hierarchyResolver,
            Guid userId,
            CancellationToken cancellationToken)
        {
            if (executed.Result is not ObjectResult or || or.Value is not IEnumerable<BaseItemDto> raw)
            {
                WarnShapeMismatchOnce(logger, surface, nameof(FilterEnumerable), executed.Result);
                return;
            }

            var kept = new List<BaseItemDto>();
            var dropped = 0;
            foreach (var item in raw)
            {
                if (IsHidden(item, hide, surface)) { dropped++; continue; }
                kept.Add(item);
            }
            if (dropped == 0) return;
            or.Value = kept;
        }

        // SearchHint has no SeriesId. Resolve every Episode/Season candidate at
        // the shared hierarchy owner before publishing one final policy result.
        private static void FilterSearchHints(
            ActionExecutedContext executed,
            HideContext hide,
            string surface,
            ILogger<HiddenContentResponseFilter> logger,
            HiddenContentHierarchyResolver hierarchyResolver,
            Guid userId,
            CancellationToken cancellationToken)
        {
            if (executed.Result is not ObjectResult or || or.Value is not SearchHintResult sh)
            {
                WarnShapeMismatchOnce(logger, surface, nameof(FilterSearchHints), executed.Result);
                return;
            }
            or.Value = FilterSearchHintsCore(
                sh,
                hide,
                surface,
                logger,
                hierarchyResolver,
                userId,
                cancellationToken,
                out var removedFromPage);
            PostPaginationFilterContract.MarkResponse(executed.HttpContext.Response, removedFromPage);
        }

        private static SearchHintResult FilterSearchHintsCore(
            SearchHintResult result,
            HideContext hide,
            string surface,
            ILogger<HiddenContentResponseFilter> logger,
            HiddenContentHierarchyResolver hierarchyResolver,
            Guid userId,
            CancellationToken cancellationToken,
            out int removedFromPage)
        {
            removedFromPage = 0;
            var hints = result.SearchHints;
            if (hints is null || hints.Count == 0) return result;

            // Explicit item entries and Series rows are decidable from the hint
            // itself. Parent resolution is needed only while an applicable
            // series-cascade policy exists; this keeps item-only hiding distinct.
            var needsSeriesResolution = hide.HasApplicableSeriesScope(surface);
            var descendantIds = new List<Guid>();
            if (needsSeriesResolution)
            {
                foreach (var hint in hints)
                {
                    if (IsDescendantHint(hint) && hint.Id != Guid.Empty)
                    {
                        descendantIds.Add(hint.Id);
                    }
                }
            }

            IReadOnlyDictionary<Guid, Guid> seriesByItemId = new Dictionary<Guid, Guid>();
            if (descendantIds.Count > 0)
            {
                var resolution = hierarchyResolver.ResolveSeriesIds(userId, descendantIds, cancellationToken);
                if (!resolution.IsSuccess)
                {
                    var warningKey = resolution.Status.ToString();
                    if (_warnedHierarchyFailure.TryAdd(warningKey, 0))
                    {
                        logger.LogWarning(
                            $"HC SearchHint hierarchy resolution failed ({warningKey}); dropping the complete hint payload for this request so no partial policy result is published.");
                    }

                    removedFromPage = hints.Count;
                    return new SearchHintResult(
                        new List<SearchHint>(),
                        PostPaginationFilterContract.NavigationTotal(result.TotalRecordCount, removedFromPage));
                }

                seriesByItemId = resolution.SeriesByItemId;
            }

            var kept = new List<SearchHint>(hints.Count);
            var dropped = 0;
            foreach (var hint in hints)
            {
                if (IsHiddenById(hint.Id.ToString(), null, hide, surface))
                {
                    dropped++;
                    continue;
                }

                if (needsSeriesResolution && IsDescendantHint(hint))
                {
                    // A successful user-scoped query that omits the item means it
                    // is deleted, malformed, or inaccessible to this user. Any of
                    // those shapes is dropped while a series cascade is active:
                    // without a trusted parent identity it cannot be proven safe.
                    if (!seriesByItemId.TryGetValue(hint.Id, out var seriesId)
                        || IsHiddenById(hint.Id.ToString(), seriesId.ToString(), hide, surface))
                    {
                        dropped++;
                        continue;
                    }
                }

                kept.Add(hint);
            }
            if (dropped == 0) return result;

            removedFromPage = dropped;
            return new SearchHintResult(
                kept,
                PostPaginationFilterContract.NavigationTotal(result.TotalRecordCount, dropped));
        }

        private static bool IsDescendantHint(SearchHint hint)
            => hint.Type is BaseItemKind.Episode or BaseItemKind.Season;

        // Focused server-policy seam: exercises the real SearchHint decision and
        // hierarchy owner without depending on MVC response-shape construction.
        internal SearchHintResult FilterSearchHintsForTest(
            SearchHintResult result,
            UserHiddenContent policy,
            Guid userId,
            CancellationToken cancellationToken = default)
            => FilterSearchHintsCore(
                result,
                HideContext.Build(policy),
                "search",
                _logger,
                _hierarchyResolver,
                userId,
                cancellationToken,
                out _);

        internal QueryResult<BaseItemDto> FilterQueryResultForTest(
            QueryResult<BaseItemDto> result,
            UserHiddenContent policy,
            string surface = "library")
            => FilterQueryResultCore(
                result,
                HideContext.Build(policy),
                surface,
                out _);

        private static bool IsHidden(BaseItemDto item, HideContext hide, string surface)
        {
            return IsHiddenById(item.Id.ToString(),
                                item.SeriesId.HasValue ? item.SeriesId.Value.ToString() : null,
                                hide, surface);
        }

        private static bool IsHiddenById(string itemIdStr, string? seriesIdStr, HideContext hide, string surface)
        {
            // Fail-closed: a policy fault with no last-known-good over-hides every
            // item on every matched surface rather than disclosing content the user
            // had hidden. The per-surface Settings gate is deliberately bypassed —
            // we have no readable Settings, so we protect all routed surfaces.
            if (hide.IsFailClosed) return true;

            var itemId = NormalizeId(itemIdStr);
            var seriesId = seriesIdStr is null ? null : NormalizeId(seriesIdStr);

            if (hide.ItemIdScopes.TryGetValue(itemId, out var scopes))
            {
                foreach (var s in scopes)
                {
                    if (ScopeAppliesToSurface(s, surface, hide.Settings)) return true;
                }
            }

            if (seriesId is not null && hide.SeriesIdScopes.TryGetValue(seriesId, out var sScopes))
            {
                foreach (var s in sScopes)
                {
                    if (ScopeAppliesToSurface(s, surface, hide.Settings)) return true;
                }
            }

            // Item is itself a Series row whose entry was keyed series-scope.
            if (hide.SeriesIdScopes.TryGetValue(itemId, out var selfSeriesScopes))
            {
                foreach (var s in selfSeriesScopes)
                {
                    if (ScopeAppliesToSurface(s, surface, hide.Settings)) return true;
                }
            }

            return false;
        }

        private static bool ScopeAppliesToSurface(string scope, string surface, HiddenContentSettings settings)
        {
            // Per-surface gate — toggling "Filter Continue Watching" off suppresses ALL CW filtering, including explicit-scope hides.
            if (!ShouldFilterSurface(settings, surface)) return false;

            if (string.Equals(scope, surface, StringComparison.OrdinalIgnoreCase)) return true;
            if (string.Equals(scope, "homesections", StringComparison.OrdinalIgnoreCase)
                && (string.Equals(surface, "nextup", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(surface, "continuewatching", StringComparison.OrdinalIgnoreCase)))
            {
                return true;
            }
            return string.Equals(scope, "global", StringComparison.OrdinalIgnoreCase);
        }

        private static bool ShouldFilterSurface(HiddenContentSettings s, string surface)
        {
            if (s == null || !s.Enabled) return false;
            return surface switch
            {
                "library" or "details" => s.FilterLibrary,
                "discovery" => s.FilterDiscovery,
                "search" => s.FilterSearch,
                "upcoming" => s.FilterUpcoming,
                "calendar" => s.FilterCalendar,
                "recommendations" => s.FilterRecommendations,
                "requests" => s.FilterRequests,
                "nextup" => s.FilterNextUp,
                "continuewatching" => s.FilterContinueWatching,
                _ => true,
            };
        }

        private static string NormalizeId(string id)
        {
            if (string.IsNullOrEmpty(id)) return string.Empty;
            if (Guid.TryParse(id, out var g) || Guid.TryParseExact(id, "N", out g))
            {
                return g.ToString();
            }
            return id.ToLowerInvariant();
        }

        private sealed class HideContext
        {
            public static readonly HideContext Empty = new HideContext();

            // Fail-closed sentinel: served only when the user's policy read faulted
            // (corrupt/unavailable) with no last-known-good to retain. It over-hides
            // every item on every matched surface so a persistence fault can never
            // silently disclose content the user had chosen to hide. Bounded and
            // self-healing — a repair (via any write path → InvalidateUser) or the
            // next Valid read replaces it.
            public static readonly HideContext FailClosed = new HideContext { IsFailClosed = true };

            public Dictionary<string, HashSet<string>> ItemIdScopes { get; } = new(StringComparer.OrdinalIgnoreCase);
            public Dictionary<string, HashSet<string>> SeriesIdScopes { get; } = new(StringComparer.OrdinalIgnoreCase);
            public HiddenContentSettings Settings { get; private set; } = new HiddenContentSettings();

            public bool IsFailClosed { get; private init; }

            // Fail-closed is never "empty": the filter must engage so its handlers
            // over-hide. Otherwise emptiness is the absence of any hide scope.
            public bool IsEmpty => !IsFailClosed && ItemIdScopes.Count == 0 && SeriesIdScopes.Count == 0;

            public bool HasApplicableSeriesScope(string surface)
            {
                if (IsFailClosed) return false;
                foreach (var scopes in SeriesIdScopes.Values)
                {
                    foreach (var scope in scopes)
                    {
                        if (ScopeAppliesToSurface(scope, surface, Settings)) return true;
                    }
                }

                return false;
            }

            public static HideContext Build(UserHiddenContent? data)
            {
                if (data?.Items == null || data.Items.Count == 0)
                {
                    return new HideContext { Settings = data?.Settings ?? new HiddenContentSettings() };
                }

                var ctx = new HideContext { Settings = data.Settings ?? new HiddenContentSettings() };
                if (!ctx.Settings.Enabled) return ctx;

                foreach (var entry in data.Items.Values)
                {
                    if (entry == null || string.IsNullOrWhiteSpace(entry.ItemId)) continue;
                    var id = NormalizeId(entry.ItemId);
                    var scope = string.IsNullOrEmpty(entry.HideScope) ? "global" : entry.HideScope.ToLowerInvariant();

                    AddScope(ctx.ItemIdScopes, id, scope);
                    if (string.Equals(entry.Type, "Series", StringComparison.OrdinalIgnoreCase))
                    {
                        AddScope(ctx.SeriesIdScopes, id, scope);
                    }
                }
                return ctx;
            }

            private static void AddScope(Dictionary<string, HashSet<string>> dict, string key, string scope)
            {
                if (!dict.TryGetValue(key, out var set))
                {
                    set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    dict[key] = set;
                }
                set.Add(scope);
            }
        }

        private sealed class KeyComparer : IEqualityComparer<(string, string)>
        {
            public static readonly KeyComparer Instance = new();
            public bool Equals((string, string) x, (string, string) y)
                => string.Equals(x.Item1, y.Item1, StringComparison.OrdinalIgnoreCase)
                && string.Equals(x.Item2, y.Item2, StringComparison.OrdinalIgnoreCase);
            public int GetHashCode((string, string) obj)
                => HashCode.Combine(
                    StringComparer.OrdinalIgnoreCase.GetHashCode(obj.Item1 ?? string.Empty),
                    StringComparer.OrdinalIgnoreCase.GetHashCode(obj.Item2 ?? string.Empty));
        }
    }
}
