using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services
{
    // Shared spoiler-state-load helper used by both SpoilerBlurImageFilter
    // and SpoilerFieldStripFilter, plus thin delegation into the plugin-wide
    // RequestIdentityService (Services/Identity) — the "who is making this
    // request?" ladder (ClaimsPrincipal → tag marker → cookie → session-by-IP)
    // lives THERE so every feature resolves identity through one documented,
    // unit-tested choke point; this class owns only what is spoiler-specific
    // (per-user spoilerblur.json state, collection scope, corruption log).
    //
    // Shares a single HttpContext.Items cache key so a request that triggers
    // BOTH filters (e.g. an /Items batch that ALSO loads images) performs ONE
    // file-read for the per-user spoiler state, not two.
    public sealed class SpoilerUserResolver
    {
        public const string ContextKeyUserState = "__JE_SpoilerBlur_UserState_Shared";

        private static readonly TimeSpan PerKeyWarnInterval = TimeSpan.FromHours(1);
        private static readonly BoundedTtlCache<string, DateTime> _warnedAt = new(
            maximumEntries: 4_096,
            maximumWeight: 1024 * 1024,
            weight: static (key, _) => key.Length + sizeof(long),
            comparer: StringComparer.Ordinal,
            defaultTtl: () => PerKeyWarnInterval);

        // F7: cross-request in-memory cache of each user's spoiler state, keyed
        // by userId (N-format). An anonymous image burst on a shared IP probes
        // every candidate's state on every image request; without this each
        // probe re-reads + re-parses spoilerblur.json from disk. Invalidated by
        // every controller/pending/promoter write path via InvalidateUser, and
        // per-request the HttpContext.Items layer still short-circuits repeats.
        private static readonly TimeSpan UserStateCacheTtl = TimeSpan.FromSeconds(30);
        private static readonly BoundedTtlCache<string, (UserSpoilerBlur State, DateTime CachedAt)> _userStateCache
            = new(
                maximumEntries: 2_048,
                maximumWeight: 100_000,
                weight: static (_, entry) => 1L
                    + entry.State.Series.Count
                    + entry.State.Movies.Count
                    + entry.State.Collections.Count
                    + entry.State.PendingTmdb.Count,
                comparer: StringComparer.OrdinalIgnoreCase,
                defaultTtl: () => UserStateCacheTtl);

        // F6: memoized result of the O(opted-collections × members) collection
        // walk in FindOptedInCollectionForMovie (runs 2-3× per movie image/DTO).
        // Keyed by (movieId + the SORTED set of opted collection GUIDs), because
        // the result is a pure function of those two inputs plus user-independent
        // library structure — so a collection opt-in/out changes the key set
        // automatically (self-invalidating) and two users with the same set share
        // safely. Short TTL bounds staleness from library edits.
        private static readonly TimeSpan CollectionScopeCacheTtl = TimeSpan.FromSeconds(30);
        private static readonly BoundedTtlCache<string, (Guid? CollectionId, DateTime CachedAt)> _collectionScopeCache
            = new(
                maximumEntries: 1_024,
                maximumWeight: 8L * 1024 * 1024,
                weight: static (key, _) => key.Length + 16,
                comparer: StringComparer.Ordinal,
                defaultTtl: () => CollectionScopeCacheTtl);

        /// <summary>
        /// Drops the cross-request caches for a user so the next request re-reads
        /// spoilerblur.json from disk. MUST be called immediately after any write
        /// to that user's spoiler state (add/remove/promote), or the image filter
        /// would serve stale (possibly UN-blurred) bytes for up to the cache TTL.
        /// </summary>
        public static void InvalidateUser(string userIdN)
        {
            if (string.IsNullOrEmpty(userIdN)) return;
            _userStateCache.TryRemove(userIdN, out _);
            // The collection-scope memo is self-invalidating (its key includes
            // the collection set), so no per-user sweep is required there.
        }

        // Test seams (Tests has InternalsVisibleTo) over the F7 cross-request
        // state cache, mirroring HiddenContentResponseFilter's.
        internal static void SeedUserStateCacheForTest(string userIdN)
        {
            if (!string.IsNullOrEmpty(userIdN))
                _userStateCache[userIdN] = (new UserSpoilerBlur(), DateTime.UtcNow);
        }

        internal static bool IsUserStateCachedForTest(string userIdN)
            => !string.IsNullOrEmpty(userIdN) && _userStateCache.ContainsKey(userIdN);

        // Test seam: force a user's cross-request entry to appear stale (TTL elapsed)
        // WITHOUT removing it, so the next LoadUserState re-reads disk while the entry
        // is still present as last-known-good. Distinct from InvalidateUser (which
        // drops the entry — the repair path). Lets a test prove LKG retention across a
        // genuine TTL expiry deterministically without a wall-clock wait.
        internal static void ExpireUserStateCacheForTest(string userIdN)
        {
            if (!string.IsNullOrEmpty(userIdN) && _userStateCache.TryGetValue(userIdN, out var e))
                _userStateCache[userIdN] = (e.State, DateTime.MinValue);
        }

        private readonly UserConfigurationManager _userConfigManager;
        private readonly ILibraryManager _libraryManager;
        private readonly RequestIdentityService _identity;
        private readonly ILogger<SpoilerUserResolver> _logger;

        public SpoilerUserResolver(
            UserConfigurationManager userConfigManager,
            ILibraryManager libraryManager,
            ILogger<SpoilerUserResolver> logger,
            RequestIdentityService identity)
        {
            _userConfigManager = userConfigManager;
            _libraryManager = libraryManager;
            _identity = identity;
            _logger = logger;
        }

        // Returns the id of an opted-in collection (BoxSet) that contains the
        // given movie, or null. Shared by the image filter, field-strip filter
        // and controller so the "is this movie in spoiler scope via a collection"
        // rule (and the collection-art lookup) can't drift between them.
        public Guid? FindOptedInCollectionForMovie(UserSpoilerBlur userState, Guid movieId)
        {
            if (movieId == Guid.Empty || userState.Collections.Count == 0) return null;

            // F6 memo. The static cache serves BOTH within-request repeats (the
            // 2-3 calls per movie hit the same entry) AND repeats across the
            // page/session, so a separate HttpContext.Items layer would be
            // redundant.
            var cacheKey = BuildCollectionScopeKey(userState, movieId);
            var now = DateTime.UtcNow;
            if (cacheKey != null
                && _collectionScopeCache.TryGetValue(cacheKey, out var hit)
                && (now - hit.CachedAt) < CollectionScopeCacheTtl)
            {
                return hit.CollectionId;
            }

            Guid? result = null;
            try
            {
                foreach (var collKeyN in userState.Collections.Keys)
                {
                    if (!Guid.TryParse(collKeyN, out var collGuid)) continue;
                    if (_libraryManager.GetItemById(collGuid) is not MediaBrowser.Controller.Entities.Movies.BoxSet bs) continue;
                    foreach (var child in bs.GetLinkedChildren())
                    {
                        if (child != null && child.Id == movieId) { result = collGuid; break; }
                    }
                    if (result.HasValue) break;
                }
            }
            catch (Exception ex)
            {
                WarnRateLimited(
                    "movie-in-collection:" + ex.GetType().FullName,
                    $"Spoiler Guard: movie-in-collection linked-children walk failed for {movieId}: {ex.Message}");
                return null; // don't cache a transient failure
            }

            if (cacheKey != null)
            {
                _collectionScopeCache.Set(
                    cacheKey,
                    (result, now),
                    CollectionScopeCacheTtl);
            }
            return result;
        }

        // Stable memo key for FindOptedInCollectionForMovie: movieId + the
        // SORTED opted-collection GUID set. Returns null (skip caching) when the
        // set is large enough that the key string would be unwieldy — such users
        // are vanishingly rare and simply pay the uncached walk.
        private static string? BuildCollectionScopeKey(UserSpoilerBlur userState, Guid movieId)
        {
            var count = userState.Collections.Count;
            if (count == 0 || count > 64) return null;
            var keys = new string[count];
            userState.Collections.Keys.CopyTo(keys, 0);
            Array.Sort(keys, StringComparer.OrdinalIgnoreCase);
            return movieId.ToString("N") + "|" + string.Join(",", keys);
        }

        // Materialize the union of every opted-in collection's member movie ids,
        // walking each collection EXACTLY ONCE (BI-PERF-037 / #98). Callers that
        // must classify a large returned movie set — the tag-cache projection —
        // use this instead of FindOptedInCollectionForMovie per movie, turning an
        // O(movies × collections × collection-size) walk into O(collections ×
        // collection-size). A per-collection resolution/walk failure is skipped
        // (matching FindOptedInCollectionForMovie's catch → not-in-scope), so the
        // returned set is byte-identical to the per-movie predicate's membership.
        public HashSet<Guid> BuildOptedInCollectionMembers(UserSpoilerBlur userState)
        {
            var members = new HashSet<Guid>();
            if (userState.Collections.Count == 0)
            {
                return members;
            }

            foreach (var collKeyN in userState.Collections.Keys)
            {
                if (!Guid.TryParse(collKeyN, out var collGuid)) continue;
                try
                {
                    if (_libraryManager.GetItemById(collGuid) is not MediaBrowser.Controller.Entities.Movies.BoxSet bs) continue;
                    foreach (var child in bs.GetLinkedChildren())
                    {
                        if (child != null && child.Id != Guid.Empty)
                        {
                            members.Add(child.Id);
                        }
                    }
                }
                catch (Exception ex)
                {
                    WarnRateLimited(
                        "collection-members:" + ex.GetType().FullName,
                        $"Spoiler Guard: opted-in collection member walk failed for {collGuid}: {ex.Message}");
                    // Skip this collection: movies known only through it fall out of
                    // scope, exactly as the per-movie walk's catch would return null.
                }
            }

            return members;
        }

        // True when the movie is opted in directly OR is a member of an opted-in
        // collection. The single source of truth for movie spoiler scope.
        public bool IsMovieInSpoilerScope(UserSpoilerBlur userState, Guid movieId)
        {
            if (movieId == Guid.Empty) return false;
            return userState.Movies.ContainsKey(movieId.ToString("N"))
                || FindOptedInCollectionForMovie(userState, movieId).HasValue;
        }

        // Resolves the requesting user's GUID via the plugin-wide identity
        // ladder (RequestIdentityService). Returns null when identity is
        // ambiguous (multiple shared-IP candidates) or absent — callers that
        // need a single identity (the field-strip filter) then pass through.
        // The image filter instead uses ResolveCandidateUserIds so it can
        // disambiguate by spoiler scope and fail CLOSED (protect) rather than
        // leak the original bytes.
        public Guid? ResolveUserId(Microsoft.AspNetCore.Http.HttpContext httpContext)
        {
            var candidates = ResolveCandidateUserIds(httpContext);
            // Exactly one candidate = unambiguous (authenticated, marker,
            // cookie, or a single session on the IP). Zero or many = no
            // single safe identity.
            return candidates.Count == 1 ? candidates[0] : (Guid?)null;
        }

        // Resolves the FULL set of plausible requesting users via the
        // identity ladder in RequestIdentityService (ClaimsPrincipal → ?tag=
        // identity marker → jc-spoiler-uid cookie → session-by-IP). The image
        // filter walks these and protects the item if ANY candidate opted
        // into it — fail-closed, so an anonymous image request on a shared IP
        // can never leak an opted-in user's unwatched artwork.
        public IReadOnlyList<Guid> ResolveCandidateUserIds(Microsoft.AspNetCore.Http.HttpContext httpContext)
        {
            return _identity.Resolve(httpContext).Candidates;
        }


        // Loads (and caches per-request, keyed by userId) the user's
        // UserSpoilerBlur state. Keying by userId lets the image filter probe
        // several shared-IP candidates in one request without the first one's
        // state masking the others; a request that triggers BOTH filters for
        // the SAME user still reads the file once (shared key).
        public UserSpoilerBlur LoadUserState(Microsoft.AspNetCore.Http.HttpContext httpContext, Guid userId)
        {
            var userIdN = userId.ToString("N");
            var cacheKey = ContextKeyUserState + ":" + userIdN;

            // 1. Per-request cache — also lets several shared-IP candidates in one
            //    request each read once without the first masking the others.
            if (httpContext.Items.TryGetValue(cacheKey, out var cached)
                && cached is UserSpoilerBlur hit)
            {
                return hit;
            }

            // 2. F7 cross-request cache — skips the disk read + parse when a
            //    recent copy exists. Invalidated by every write path. A stale
            //    entry is retained (not dropped) so a policy fault can fall back
            //    to it as last-known-good instead of failing open.
            var now = DateTime.UtcNow;
            var hasEntry = _userStateCache.TryGetValue(userIdN, out var entry);
            if (hasEntry && (now - entry.CachedAt) < UserStateCacheTtl)
            {
                httpContext.Items[cacheKey] = entry.State;
                return entry.State;
            }

            // 3. Miss or stale — typed, side-effect-free read from disk. Unlike the
            //    old lenient GetUserConfiguration path (which collapsed every fault
            //    into an empty new T() and silently disabled protection), this
            //    classifies Missing/Valid/Corrupt/Unavailable so a fault retains
            //    last-known-good or fails CLOSED instead of leaking artwork/fields.
            var read = _userConfigManager.ReadUserConfiguration<UserSpoilerBlur>(
                userIdN,
                SpoilerBlurImageFilter.SpoilerBlurFileName);
            var lastKnownGood = hasEntry ? entry.State : null;
            var state = ResolvePolicyState(read, lastKnownGood);

            if (read.IsFault)
            {
                var posture = lastKnownGood != null
                    ? "retaining last-known-good spoiler protection"
                    : "no last-known-good — failing CLOSED (protecting all items)";
                WarnRateLimited(
                    "userstate-" + read.Status + ":" + (read.FaultDetail ?? "?"),
                    $"Spoiler Guard resolver: {read.Status} spoilerblur.json for {userId} ({read.FaultDetail}) — {posture} until repaired.");
            }

            _userStateCache.Set(userIdN, (state, now), UserStateCacheTtl);
            httpContext.Items[cacheKey] = state;
            return state;
        }

        // Pure policy decision: how a typed read maps to the enforced spoiler state.
        //   Missing/Valid → use the (possibly empty) value — an intentional policy.
        //     A missing file is the common "user never opted anything in" case and
        //     MUST pass through, so only genuine faults trigger protection.
        //   Corrupt/Unavailable → retain last-known-good if present, else a
        //     FailClosed sentinel so the image/field filters over-protect.
        internal static UserSpoilerBlur ResolvePolicyState(
            UserConfigReadResult<UserSpoilerBlur> read,
            UserSpoilerBlur? lastKnownGood)
        {
            if (read.HasUsableValue)
            {
                return read.Value ?? new UserSpoilerBlur();
            }

            return lastKnownGood ?? new UserSpoilerBlur { FailClosed = true };
        }

        public void WarnRateLimited(string key, string message)
        {
            var now = DateTime.UtcNow;
            var stored = _warnedAt.AddOrUpdate(key, _ => now,
                (_, last) => (now - last) >= PerKeyWarnInterval ? now : last);
            if (stored != now) return;
            _logger.LogWarning(message);
        }

        // Track per-user corruption events so the admin can surface a banner in the
        // JC management UI. Populated by the controller/tag-cache STRICT read+write
        // path when a mutation hits a corrupt spoilerblur.json (it quarantines the
        // bytes to .corrupt-* and refuses to overwrite). Note the runtime ENFORCEMENT read
        // (LoadUserState) no longer fails open on corruption: it retains
        // last-known-good or fails CLOSED, so protection is preserved rather than
        // silently no-op'd. The banner still lets the user know a repair is needed.
        private static readonly ConcurrentDictionary<string, CorruptionEvent> _corruptionLog = new();

        public class CorruptionEvent
        {
            public string UserDisplay { get; set; } = string.Empty;
            public DateTime At { get; set; }
            public string Reason { get; set; } = string.Empty;
        }

        public static void RecordCorruption(string userKey, string userDisplay, string reason)
        {
            // TryAdd makes marker hits idempotent: retries do not refresh the event
            // timestamp, while the first hit after a process restart reconstructs
            // the in-memory banner from the still-durable marker.
            _corruptionLog.TryAdd(userKey, new CorruptionEvent
            {
                UserDisplay = userDisplay,
                At = DateTime.UtcNow,
                Reason = reason,
            });
        }

        public static IReadOnlyDictionary<string, CorruptionEvent> GetCorruptionLog()
        {
            return _corruptionLog;
        }

        public static void ClearCorruption(string userKey)
        {
            _corruptionLog.TryRemove(userKey, out _);
        }
    }
}
