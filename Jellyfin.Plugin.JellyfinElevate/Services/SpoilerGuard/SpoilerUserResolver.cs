using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.JellyfinElevate.Configuration;
using Jellyfin.Plugin.JellyfinElevate.Helpers;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinElevate.Services
{
    // Shared user-resolution + spoiler-state-load helper used by both
    // SpoilerBlurImageFilter and SpoilerFieldStripFilter. Extracted so the
    // IPv6/IPv4-mapped-IPv6/raw-IPv6-with-port handling and the shared-IP
    // ambiguity-window fail-closed logic stays in ONE place — preventing
    // future regressions like the field-strip filter inheriting an old
    // string-compare implementation.
    //
    // Also shares a single HttpContext.Items cache key so a request that
    // triggers BOTH filters (e.g. an /Items batch that ALSO loads images)
    // performs ONE file-read for the per-user spoiler state, not two.
    public sealed class SpoilerUserResolver
    {
        public const string ContextKeyUserState = "__JE_SpoilerBlur_UserState_Shared";

        private static readonly TimeSpan PerKeyWarnInterval = TimeSpan.FromHours(1);
        private static readonly ConcurrentDictionary<string, DateTime> _warnedAt = new();

        // Per-browser identity cookie the web client sets on load (see
        // src/enhanced/spoiler-blur). Browsers attach it to every same-origin
        // request INCLUDING anonymous <img>/CSS-background image fetches, which
        // on Jellyfin 12 carry no other user identity (the image endpoint ignores
        // the api_key query param for identity, and <img> tags can't send an
        // Authorization header). We trust it ONLY to disambiguate among users
        // that actually have an active session from the request IP, so a forged
        // value can't impersonate a user who isn't even present.
        public const string SpoilerUidCookie = "je-spoiler-uid";

        // Short-TTL cache of the per-IP session scan. A single page load fires a
        // burst of image requests from one IP; without this each one would
        // re-enumerate ISessionManager.Sessions (O(sessions) + an allocation),
        // which is exactly the per-image latency that shows up as the BlurHash
        // placeholder lingering — and it gets worse the more sessions exist
        // (e.g. a Seerr instance polling the server). Cache the scan result for a
        // couple of seconds so the burst pays for one scan, not dozens.
        private static readonly TimeSpan IpScanCacheTtl = TimeSpan.FromSeconds(2);
        private static readonly ConcurrentDictionary<string, IpScanCacheEntry> _ipScanCache = new();

        private sealed class IpScanCacheEntry
        {
            public required DateTime CachedAt { get; init; }
            public required IReadOnlyCollection<Guid> IpUsers { get; init; }
        }

        // F7: cross-request in-memory cache of each user's spoiler state, keyed
        // by userId (N-format). An anonymous image burst on a shared IP probes
        // every candidate's state on every image request; without this each
        // probe re-reads + re-parses spoilerblur.json from disk. Invalidated by
        // every controller/pending/promoter write path via InvalidateUser, and
        // per-request the HttpContext.Items layer still short-circuits repeats.
        private static readonly TimeSpan UserStateCacheTtl = TimeSpan.FromSeconds(30);
        private static readonly ConcurrentDictionary<string, (UserSpoilerBlur State, DateTime CachedAt)> _userStateCache
            = new(StringComparer.OrdinalIgnoreCase);

        // F6: memoized result of the O(opted-collections × members) collection
        // walk in FindOptedInCollectionForMovie (runs 2-3× per movie image/DTO).
        // Keyed by (movieId + the SORTED set of opted collection GUIDs), because
        // the result is a pure function of those two inputs plus user-independent
        // library structure — so a collection opt-in/out changes the key set
        // automatically (self-invalidating) and two users with the same set share
        // safely. Short TTL bounds staleness from library edits.
        private static readonly TimeSpan CollectionScopeCacheTtl = TimeSpan.FromSeconds(30);
        private static readonly ConcurrentDictionary<string, (Guid? CollectionId, DateTime CachedAt)> _collectionScopeCache
            = new(StringComparer.Ordinal);

        // F8: negative-cache for a je-spoiler-uid cookie that names a user with
        // NO session on the request IP. Without it, a stale/forged cookie forces
        // an uncached full session rescan on EVERY request (scan storm). Keyed by
        // "{ipKey}|{cookieUidN}" with a short TTL.
        private static readonly TimeSpan CookieMissNegativeCacheTtl = TimeSpan.FromSeconds(5);
        private static readonly ConcurrentDictionary<string, DateTime> _cookieMissCache = new(StringComparer.Ordinal);

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

        private readonly UserConfigurationManager _userConfigManager;
        private readonly ISessionManager _sessionManager;
        private readonly ILibraryManager _libraryManager;
        private readonly ILogger<SpoilerUserResolver> _logger;

        public SpoilerUserResolver(
            UserConfigurationManager userConfigManager,
            ISessionManager sessionManager,
            ILibraryManager libraryManager,
            ILogger<SpoilerUserResolver> logger)
        {
            _userConfigManager = userConfigManager;
            _sessionManager = sessionManager;
            _libraryManager = libraryManager;
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
                _collectionScopeCache[cacheKey] = (result, now);
                // Opportunistic eviction, mirroring the season-watched cache in
                // SpoilerBlurImageFilter: snapshot-free, only removes expired.
                if (_collectionScopeCache.Count > 1024)
                {
                    foreach (var kvp in _collectionScopeCache)
                    {
                        if ((now - kvp.Value.CachedAt) >= CollectionScopeCacheTtl)
                            _collectionScopeCache.TryRemove(kvp.Key, out _);
                    }
                }
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

        // True when the movie is opted in directly OR is a member of an opted-in
        // collection. The single source of truth for movie spoiler scope.
        public bool IsMovieInSpoilerScope(UserSpoilerBlur userState, Guid movieId)
        {
            if (movieId == Guid.Empty) return false;
            return userState.Movies.ContainsKey(movieId.ToString("N"))
                || FindOptedInCollectionForMovie(userState, movieId).HasValue;
        }

        // Resolves the requesting user's GUID, falling back to a session-by-IP
        // lookup when ClaimsPrincipal yields no user (anonymous browser image
        // requests, native clients that don't authenticate image fetches).
        // Returns null when session-by-IP is ambiguous (multiple distinct users
        // have a session on the request IP) — callers that need a single
        // identity (the field-strip filter) then pass through.
        // The image filter instead uses ResolveCandidateUserIds so it can
        // disambiguate by spoiler scope and fail CLOSED (protect) rather than
        // leak the original bytes. See that method.
        public Guid? ResolveUserId(Microsoft.AspNetCore.Http.HttpContext httpContext)
        {
            var candidates = ResolveCandidateUserIds(httpContext);
            // Exactly one candidate = unambiguous (ClaimsPrincipal, or a single
            // session on the IP). Zero or many = no single safe identity.
            return candidates.Count == 1 ? candidates[0] : (Guid?)null;
        }

        // Resolves the FULL set of plausible requesting users:
        //   • ClaimsPrincipal present  → exactly that user (authoritative).
        //   • je-spoiler-uid cookie    → that user, when it has a session on the IP.
        //   • else session-by-IP       → every distinct user with a session from
        //     the request IP. One entry when unambiguous; several when a shared
        //     IP (reverse proxy without KnownProxies, NAT) can't pin the request.
        // The image filter walks these and protects the item if ANY candidate
        // opted into it — fail-closed, so an anonymous image request on a
        // shared IP can no longer leak an opted-in user's unwatched artwork.
        public IReadOnlyList<Guid> ResolveCandidateUserIds(Microsoft.AspNetCore.Http.HttpContext httpContext)
        {
            var primary = UserHelper.GetCurrentUserId(httpContext.User);
            if (primary != null && primary.Value != Guid.Empty)
            {
                return new[] { primary.Value };
            }

            // Anonymous request (browser <img>/CSS-background, or a native
            // TV/mobile image fetch) — resolve by session-on-IP (cached briefly).
            var ipUsers = ScanActiveSessionUsersCached(httpContext);

            // Per-browser cookie disambiguation. The je-spoiler-uid cookie pins
            // THIS request to its browser's user — trusted ONLY when that user
            // genuinely has a session from this IP, so a stale/forged value can't
            // impersonate a user who isn't present.
            if (httpContext.Request.Cookies.TryGetValue(SpoilerUidCookie, out var raw)
                && Guid.TryParse(raw, out var cookieUid)
                && cookieUid != Guid.Empty)
            {
                // A cookie naming a user absent from the (up-to-TTL-stale) cached
                // set may be a JUST-logged-in user the cache hasn't seen yet —
                // re-scan uncached once before rejecting, else a fresh login
                // leaks its own guarded images for up to the cache TTL.
                //
                // F8: but a STALE/forged cookie naming an absent user would
                // trigger that uncached full session rescan on EVERY request (a
                // scan storm). Negative-cache the (ip, cookieUid) miss for a
                // short window so repeated requests with the same stale cookie
                // reuse the last scan instead of re-scanning.
                if (!ipUsers.Contains(cookieUid))
                {
                    var ipKey = TryGetNormalizedIpKey(httpContext);
                    var missKey = ipKey != null ? ipKey + "|" + cookieUid.ToString("N") : null;
                    var now = DateTime.UtcNow;
                    var recentMiss = missKey != null
                        && _cookieMissCache.TryGetValue(missKey, out var missAt)
                        && (now - missAt) < CookieMissNegativeCacheTtl;
                    if (!recentMiss)
                    {
                        ipUsers = ScanActiveSessionUsersFresh(httpContext);
                        if (missKey != null && !ipUsers.Contains(cookieUid))
                        {
                            _cookieMissCache[missKey] = now;
                            if (_cookieMissCache.Count > 512)
                            {
                                foreach (var kvp in _cookieMissCache)
                                {
                                    if ((now - kvp.Value) >= CookieMissNegativeCacheTtl)
                                        _cookieMissCache.TryRemove(kvp.Key, out _);
                                }
                            }
                        }
                    }
                }
                if (ipUsers.Contains(cookieUid))
                {
                    return new[] { cookieUid };
                }
            }

            // No usable cookie (native TV/mobile client, or a forged/stale value
            // naming an absent user). Fail CLOSED by scope over ALL users with a
            // session on this IP: return the full set so the image filter blurs
            // the item if ANY of them opted in, rather than leaking the original
            // bytes. (Using the full IP-session set — not a recent-activity
            // window — is deliberate; passive image viewing doesn't refresh a
            // session, so an opted-in user must not age out of protection.)
            if (ipUsers.Count > 1)
            {
                WarnRateLimited(
                    "shared-ip-nocookie",
                    $"Spoiler Guard resolver: {ipUsers.Count} users have a session on one IP with no matching {SpoilerUidCookie} cookie (native client, or cookie names an absent user). Disambiguating by spoiler scope. Configure Jellyfin KnownProxies so proxied requests carry the real client IP to restore per-user precision.");
                return ipUsers.ToArray();
            }
            return ipUsers.Count == 1 ? ipUsers.ToArray() : Array.Empty<Guid>();
        }

        // Cached wrapper over the session scan. Keyed by normalized request IP;
        // entries live for IpScanCacheTtl so a page-load burst of image requests
        // scans ISessionManager.Sessions once instead of once per image.
        private IReadOnlyCollection<Guid> ScanActiveSessionUsersCached(Microsoft.AspNetCore.Http.HttpContext httpContext)
        {
            var remoteIpRaw = httpContext.Connection.RemoteIpAddress;
            if (remoteIpRaw == null) return Array.Empty<Guid>();
            var ipKey = NormalizeIp(remoteIpRaw).ToString();

            if (_ipScanCache.TryGetValue(ipKey, out var hit) && (DateTime.UtcNow - hit.CachedAt) < IpScanCacheTtl)
            {
                return hit.IpUsers;
            }
            return ScanAndCache(ipKey, httpContext);
        }

        // Forces a fresh (uncached) scan and refreshes the cache. Used when a
        // je-spoiler-uid cookie names a user absent from the cached set: the
        // cache can be up to IpScanCacheTtl stale, so a just-logged-in user's
        // brand-new session may not be in it yet. Re-scanning before rejecting
        // the cookie closes the window where a fresh login would otherwise leak
        // its guarded images for up to the TTL.
        private IReadOnlyCollection<Guid> ScanActiveSessionUsersFresh(Microsoft.AspNetCore.Http.HttpContext httpContext)
        {
            var remoteIpRaw = httpContext.Connection.RemoteIpAddress;
            if (remoteIpRaw == null) return Array.Empty<Guid>();
            return ScanAndCache(NormalizeIp(remoteIpRaw).ToString(), httpContext);
        }

        private IReadOnlyCollection<Guid> ScanAndCache(string ipKey, Microsoft.AspNetCore.Http.HttpContext httpContext)
        {
            var now = DateTime.UtcNow;
            var ipUsers = ScanActiveSessionUsers(httpContext);
            _ipScanCache[ipKey] = new IpScanCacheEntry { CachedAt = now, IpUsers = ipUsers };

            // Opportunistic prune so the cache can't grow unbounded across many
            // distinct client IPs over a long uptime.
            if (_ipScanCache.Count > 512)
            {
                foreach (var kvp in _ipScanCache)
                {
                    if ((now - kvp.Value.CachedAt) >= IpScanCacheTtl) _ipScanCache.TryRemove(kvp.Key, out _);
                }
            }
            return ipUsers;
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
            //    recent copy exists. Invalidated by every write path.
            var now = DateTime.UtcNow;
            if (_userStateCache.TryGetValue(userIdN, out var entry)
                && (now - entry.CachedAt) < UserStateCacheTtl)
            {
                httpContext.Items[cacheKey] = entry.State;
                return entry.State;
            }

            // 3. Miss — read from disk.
            UserSpoilerBlur state;
            try
            {
                state = _userConfigManager.GetUserConfiguration<UserSpoilerBlur>(
                    userIdN,
                    SpoilerBlurImageFilter.SpoilerBlurFileName);
            }
            catch (Exception ex)
            {
                // GetUserConfiguration is the LENIENT path — it already
                // swallows IOException + JsonException + parse failures
                // internally and returns `new T()` (it logs at Error level
                // via the config manager's own _logger, so the corruption
                // fact is observable, just not under our namespace). This
                // outer catch-all only fires for exceptions that escape the
                // lenient path (e.g. ResolveUserFile throwing on a bad
                // userId). Rate-limited so a flood of bad requests doesn't
                // spam logs. Do NOT populate the cross-request cache with a
                // spurious empty on this rare escape — only the per-request
                // layer, so a retry re-reads.
                WarnRateLimited(
                    "userstate-load:" + ex.GetType().FullName,
                    $"Spoiler Guard resolver: failed to read user state for {userId} — passing through unblurred. {ex.Message}");
                state = new UserSpoilerBlur();
                httpContext.Items[cacheKey] = state;
                return state;
            }

            _userStateCache[userIdN] = (state, now);
            // Opportunistic prune so the cache can't grow unbounded across many
            // users over a long uptime (mirrors the IP-scan cache prune).
            if (_userStateCache.Count > 512)
            {
                foreach (var kvp in _userStateCache)
                {
                    if ((now - kvp.Value.CachedAt) >= UserStateCacheTtl)
                        _userStateCache.TryRemove(kvp.Key, out _);
                }
            }
            httpContext.Items[cacheKey] = state;
            return state;
        }

        // Session-by-IP scan. Returns the set of DISTINCT users that have a
        // session from the request IP, regardless of how recently active. We
        // deliberately do NOT filter by a recent-activity window: passively
        // viewing images (lazy-loaded <img>/CSS-background posters) does not
        // refresh a session's LastActivityDate, so a quietly-scrolling opted-in
        // user would age out of any activity window while still firing anonymous
        // image requests — and drop out of the fail-closed-by-scope set, leaking
        // their own guarded artwork. Empty ⇒ no matching session (nothing to
        // protect). The caller applies the je-spoiler-uid cookie first, then
        // falls back to protecting the item if ANY user in this set opted in.
        private IReadOnlyCollection<Guid> ScanActiveSessionUsers(Microsoft.AspNetCore.Http.HttpContext httpContext)
        {
            var remoteIpRaw = httpContext.Connection.RemoteIpAddress;
            if (remoteIpRaw == null) return Array.Empty<Guid>();
            var remoteIp = NormalizeIp(remoteIpRaw);

            var ipUsers = new HashSet<Guid>();

            // Snapshot the live IEnumerable. ISessionManager.Sessions can return
            // a live view; foreach's MoveNext can throw InvalidOperationException
            // ("Collection was modified"). ToArray() forces materialization here
            // so the enumerator hazard is contained.
            SessionInfo[] sessions;
            try
            {
                sessions = _sessionManager.Sessions.ToArray();
            }
            catch (Exception ex)
            {
                WarnRateLimited(
                    "session-list:" + ex.GetType().FullName,
                    $"Spoiler Guard resolver: ISessionManager.Sessions enumeration threw: {ex.Message}");
                return Array.Empty<Guid>();
            }

            // Per-session try/catch (not one outer try) so a single misbehaving
            // SessionInfo (e.g. a corrupt RemoteEndPoint) can't abort iteration
            // of ALL sessions — one bad row must not hide every healthy match.
            foreach (var s in sessions)
            {
                try
                {
                    if (s.UserId == Guid.Empty) continue;
                    if (!RemoteEndpointIpEquals(s.RemoteEndPoint, remoteIp)) continue;
                    ipUsers.Add(s.UserId);
                }
                catch (Exception ex)
                {
                    WarnRateLimited(
                        "session-iter:" + ex.GetType().FullName,
                        $"Spoiler Guard resolver: skipped a session row during IP match: {ex.Message}");
                    continue;
                }
            }

            return ipUsers;
        }

        // Normalized request-IP key (or null when the remote IP is unavailable),
        // used for the F8 cookie-miss negative cache. Same normalization the
        // per-IP session-scan cache uses so keys line up.
        private static string? TryGetNormalizedIpKey(Microsoft.AspNetCore.Http.HttpContext httpContext)
        {
            var raw = httpContext.Connection.RemoteIpAddress;
            return raw == null ? null : NormalizeIp(raw).ToString();
        }

        // Returns the canonical IPAddress for comparison: IPv4-mapped-IPv6
        // unwrapped to IPv4, scope IDs cleared.
        private static System.Net.IPAddress NormalizeIp(System.Net.IPAddress addr)
        {
            if (addr.IsIPv4MappedToIPv6) return addr.MapToIPv4();
            if (addr.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6 && addr.ScopeId != 0)
            {
                return new System.Net.IPAddress(addr.GetAddressBytes());
            }
            return addr;
        }

        private void RemoteEndpointParseFailedWarn(string endpoint)
        {
            var safe = endpoint.Length > 80 ? endpoint.Substring(0, 80) + "…" : endpoint;
            WarnRateLimited(
                "endpoint-parse",
                $"Spoiler Guard resolver: unrecognized SessionInfo.RemoteEndPoint format '{safe}' — session-by-IP fallback offline. Likely a Jellyfin format change.");
        }

        private bool RemoteEndpointIpEquals(string? endpoint, System.Net.IPAddress remoteIp)
        {
            if (string.IsNullOrEmpty(endpoint)) return false;

            if (System.Net.IPEndPoint.TryParse(endpoint, out var parsed))
            {
                return NormalizeIp(parsed.Address).Equals(remoteIp);
            }
            if (System.Net.IPAddress.TryParse(endpoint, out var bare))
            {
                return NormalizeIp(bare).Equals(remoteIp);
            }

            // Raw IPv6-with-port without brackets (e.g. "::1:1234") parses as
            // a single IPv6 address by both parsers — strip the trailing
            // ":port" and try again.
            var lastColon = endpoint.LastIndexOf(':');
            if (lastColon > 0 && lastColon < endpoint.Length - 1)
            {
                var portCandidate = endpoint.Substring(lastColon + 1);
                if (int.TryParse(portCandidate, out _))
                {
                    var addressOnly = endpoint.Substring(0, lastColon);
                    if (System.Net.IPAddress.TryParse(addressOnly, out var stripped))
                    {
                        return NormalizeIp(stripped).Equals(remoteIp);
                    }
                }
            }

            RemoteEndpointParseFailedWarn(endpoint);
            return false;
        }

        public void WarnRateLimited(string key, string message)
        {
            var now = DateTime.UtcNow;
            var stored = _warnedAt.AddOrUpdate(key, now,
                (_, last) => (now - last) >= PerKeyWarnInterval ? now : last);
            if (stored != now) return;
            _logger.LogWarning(message);
        }

        // Track per-user corruption events so the admin can surface a
        // banner in the JE management UI when any user's spoilerblur.json
        // was rolled into the .corrupt-backup file. The file-on-disk has
        // been rewritten with an empty state by UserConfigurationManager
        // (fail-open per SECURITY.md) so the user's image/strip pipeline
        // silently no-ops until they re-enable items. Surfacing this lets
        // the user know to retry.
        private static readonly ConcurrentDictionary<string, CorruptionEvent> _corruptionLog = new();

        public class CorruptionEvent
        {
            public string UserDisplay { get; set; } = string.Empty;
            public DateTime At { get; set; }
            public string Reason { get; set; } = string.Empty;
        }

        public static void RecordCorruption(string userKey, string userDisplay, string reason)
        {
            _corruptionLog[userKey] = new CorruptionEvent
            {
                UserDisplay = userDisplay,
                At = DateTime.UtcNow,
                Reason = reason,
            };
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
