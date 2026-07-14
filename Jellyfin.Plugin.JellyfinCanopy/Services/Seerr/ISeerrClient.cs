using System.Collections.Generic;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Model.Seerr;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Seerr
{
    /// <summary>
    /// The acting caller for proxied Seerr operations. Resolved by the
    /// controller from the authenticated principal (never from caller-controlled
    /// headers) and passed down so the singleton client stays HttpContext-free.
    /// <see cref="IsAdmin"/> selects the admin error shape (upstream URL kept)
    /// vs the sanitised one, and bypasses Seerr permission pre-checks.
    /// </summary>
    /// <param name="JellyfinUserId">Dashed Jellyfin user id from the token, or null when unresolvable.</param>
    /// <param name="IsAdmin">Whether the caller is a Jellyfin administrator.</param>
    public sealed record SeerrCaller(string? JellyfinUserId, bool IsAdmin);

    /// <summary>
    /// A watchlist/request entry reduced to the identity JC needs (moved from
    /// the former protected nested class on the controller base).
    /// </summary>
    public class WatchlistItem
    {
        public int TmdbId { get; set; }

        public string MediaType { get; set; } = "movie";

        /// <summary>
        /// TVDB id when Seerr carries one (TV requests). Lets the download-queue filter match a
        /// Sonarr queue record via TVDB when Sonarr reports the series with tmdbId 0.
        /// </summary>
        public int? TvdbId { get; set; }
    }

    /// <summary>
    /// Whether the Seerr server has 4K enabled (a default 4K Radarr/Sonarr is
    /// configured) and whether the acting user may request it. The two
    /// <c>CanRequest4k*</c> flags already fold in the server-capability check, so a
    /// client can gate its 4K UI on the single relevant flag.
    /// </summary>
    /// <param name="Movie4kEnabled">Seerr's <c>movie4kEnabled</c> (a default 4K Radarr exists).</param>
    /// <param name="Series4kEnabled">Seerr's <c>series4kEnabled</c> (a default 4K Sonarr exists).</param>
    /// <param name="CanRequest4kMovie"><see cref="Movie4kEnabled"/> AND the user has the 4K movie permission.</param>
    /// <param name="CanRequest4kTv"><see cref="Series4kEnabled"/> AND the user has the 4K TV permission.</param>
    public sealed record Seerr4kCapability(
        bool Movie4kEnabled,
        bool Series4kEnabled,
        bool CanRequest4kMovie,
        bool CanRequest4kTv);

    /// <summary>
    /// Distinguishes an authoritative missing/blocked user from a lookup whose
    /// paginated source could not be read completely. Consumers must never turn
    /// <see cref="Incomplete"/> into a successful empty or "unlinked" response.
    /// </summary>
    public enum SeerrUserResolutionStatus
    {
        Found,
        NotFound,
        Blocked,
        Unavailable,
        Incomplete,
    }

    public sealed record SeerrUserResolution(
        SeerrUserResolutionStatus Status,
        SeerrUser? User = null,
        string? FailureReason = null)
    {
        public bool IsFound => Status == SeerrUserResolutionStatus.Found && User != null;

        public static SeerrUserResolution Found(SeerrUser user) => new(SeerrUserResolutionStatus.Found, user);

        public static SeerrUserResolution NotFound(string? reason = null) => new(SeerrUserResolutionStatus.NotFound, FailureReason: reason);

        public static SeerrUserResolution Incomplete(string? reason = null) => new(SeerrUserResolutionStatus.Incomplete, FailureReason: reason);
    }

    /// <summary>
    /// All Seerr (Seerr) plumbing that used to live on
    /// <c>JellyfinCanopyControllerBase</c>: configured-URL fan-out, user
    /// resolution with TTL cache + optional just-in-time import, the proxy core
    /// with its response cache and permission pre-checks, and the
    /// watchlist/request list helpers. One implementation, one cache
    /// (<see cref="ISeerrCache"/>) — the former <c>SeerrUserResolver</c>
    /// duplicate is folded in here.
    /// </summary>
    public interface ISeerrClient
    {
        /// <summary>
        /// Resolves the full Seerr user for a Jellyfin user id (any GUID format).
        /// Honours the user cache (unless disabled/bypassed), skips blocked users,
        /// and — when <paramref name="allowAutoImport"/> and the config allow it —
        /// attempts a just-in-time import of missing users.
        /// </summary>
        Task<SeerrUser?> GetSeerrUser(string jellyfinUserId, bool bypassCache = false, bool allowAutoImport = true);

        /// <summary>
        /// Resolves a Seerr user without collapsing incomplete collection reads
        /// into authoritative absence. The default keeps existing test doubles
        /// source-compatible; production overrides it with the typed paginator
        /// result.
        /// </summary>
        async Task<SeerrUserResolution> ResolveSeerrUser(
            string jellyfinUserId,
            bool bypassCache = false,
            bool allowAutoImport = true,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var user = await GetSeerrUser(jellyfinUserId, bypassCache, allowAutoImport).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            return user == null ? SeerrUserResolution.NotFound() : SeerrUserResolution.Found(user);
        }

        /// <summary>
        /// Resolves just the Seerr user id (cached separately with the same TTL).
        /// Pass <paramref name="allowAutoImport"/>=false for read-only callers
        /// (audits, background monitors) that must never create Seerr users.
        /// </summary>
        Task<string?> GetSeerrUserId(string jellyfinUserId, bool allowAutoImport = true);

        /// <summary>Whether the admin blocklist excludes this Jellyfin user from all Seerr integration.</summary>
        bool IsImportBlocked(string jellyfinUserId, PluginConfiguration config);

        /// <summary>Live /api/v1/status probe across the configured URLs (uncached).</summary>
        Task<bool> GetStatusActiveAsync();

        /// <summary>
        /// Resolves whether 4K requests are available for a Jellyfin user: reads
        /// Seerr's user-neutral <c>/api/v1/settings/public</c> (cached) for the
        /// server 4K capability and combines it with the user's Seerr 4K
        /// permissions. Degrades to all-false when Seerr is unconfigured/unreachable
        /// or the user is unlinked. When <paramref name="isAdmin"/> is true the
        /// caller is a Jellyfin admin who bypasses the Seerr per-user 4K permission
        /// gate in the proxy, so capability is projected as server-4K-enabled AND the
        /// JC admin master switch (not the linked Seerr user's own 4K bits).
        /// </summary>
        Task<Seerr4kCapability> GetSeerr4kCapabilityAsync(string jellyfinUserId, bool isAdmin = false);

        /// <summary>
        /// Evicts the shared response-cache entries for a movie/tv detail (and its
        /// sub-paths) so a mutation that changed <c>mediaInfo.requests</c> — e.g. an
        /// approve/decline — is reflected the next time the detail is read, instead
        /// of serving a stale request status until the cache TTL. Best-effort;
        /// <paramref name="mediaType"/> must be "movie" or "tv".
        /// </summary>
        void EvictMediaDetailCache(int tmdbId, string mediaType);

        /// <summary>
        /// Drops cached source-local identity data after a mandatory fresh
        /// lookup proves it stale. Test doubles may keep the default no-op.
        /// </summary>
        void InvalidateUserIdentityCache(string jellyfinUserId)
        {
        }

        /// <summary>
        /// The proxy core: authenticated fan-out of <paramref name="apiPath"/> to the
        /// configured Seerr URLs on behalf of <paramref name="caller"/>, with response
        /// caching, permission pre-checks and the typed error envelope contract.
        /// </summary>
        Task<IActionResult> ProxyRequestAsync(string apiPath, HttpMethod method, string? content, SeerrCaller caller);

        Task<IActionResult> ProxyRequestAsync(
            string apiPath,
            HttpMethod method,
            string? content,
            SeerrCaller caller,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return ProxyRequestAsync(apiPath, method, content, caller);
        }

        /// <summary>
        /// Reads one TV-detail document without consulting or publishing to the
        /// ordinary response cache. This deliberately narrow seam exists for an
        /// already-open season modal's state poll; callers cannot turn it into an
        /// arbitrary cache-bypass proxy. Implementations that do not provide a
        /// dedicated cache path retain source compatibility and fall back to the
        /// normal proxy behavior.
        /// </summary>
        Task<IActionResult> ProxyFreshTvDetailAsync(
            int tmdbId,
            SeerrCaller caller,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return ProxyRequestAsync(
                $"/api/v1/tv/{tmdbId}",
                HttpMethod.Get,
                null,
                caller,
                cancellationToken);
        }

        /// <summary>
        /// Proxies a user-scoped request using an already-resolved Seerr user.
        /// Production keeps the instance-local user id on
        /// <see cref="SeerrUser.SourceUrl"/> and must not resolve or fail over to
        /// another instance. Implementations that do not support this context
        /// fail closed by default instead of falling back to another resolution.
        /// </summary>
        Task<IActionResult> ProxyRequestAsync(
            string apiPath,
            HttpMethod method,
            string? content,
            SeerrCaller caller,
            SeerrUser resolvedUser)
            => Task.FromResult<IActionResult>(new ObjectResult(new
            {
                error = true,
                code = "source_affinity_unavailable",
                message = "The linked Seerr instance could not be verified. Please try again."
            })
            { StatusCode = 502 });

        Task<IActionResult> ProxyRequestAsync(
            string apiPath,
            HttpMethod method,
            string? content,
            SeerrCaller caller,
            SeerrUser resolvedUser,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return ProxyRequestAsync(apiPath, method, content, caller, resolvedUser);
        }

        /// <summary>Fetches a Seerr user's watchlist (by Seerr user id).</summary>
        Task<List<WatchlistItem>?> GetWatchlistForUser(string seerrUserId);

        /// <summary>
        /// Fetches a Seerr user's watchlist from the instance that resolved the
        /// instance-local user id. The default preserves compatibility for test
        /// doubles; the production client pins to <paramref name="sourceUrl"/>.
        /// </summary>
        Task<List<WatchlistItem>?> GetWatchlistForUser(
            string seerrUserId,
            string? sourceUrl,
            CancellationToken cancellationToken = default)
            => GetWatchlistForUser(seerrUserId);

        /// <summary>Fetches the requests a Seerr user made (by Seerr user id).</summary>
        Task<List<WatchlistItem>?> GetRequestsForUser(string seerrUserId);

        /// <summary>Fetches requests from the instance that resolved the Seerr user id.</summary>
        Task<List<WatchlistItem>?> GetRequestsForUser(
            string seerrUserId,
            string? sourceUrl,
            CancellationToken cancellationToken = default)
            => GetRequestsForUser(seerrUserId);

        /// <summary>
        /// Fetches requests with the source URL and API key taken from one
        /// captured configuration generation. The default keeps existing test
        /// doubles source-compatible; the production client fences dispatch and
        /// return against <paramref name="configurationRevision"/>.
        /// </summary>
        Task<List<WatchlistItem>?> GetRequestsForUser(
            string seerrUserId,
            string? sourceUrl,
            PluginConfiguration capturedConfiguration,
            long configurationRevision,
            string capturedApiKey,
            IReadOnlyList<string> capturedConfiguredUrls,
            CancellationToken cancellationToken = default)
            => GetRequestsForUser(seerrUserId, sourceUrl, cancellationToken);
    }
}
