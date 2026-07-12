using System.Collections.Generic;
using System.Net.Http;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Model.Jellyseerr;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Jellyseerr
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
    public sealed record JellyseerrCaller(string? JellyfinUserId, bool IsAdmin);

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
    /// All Seerr (Jellyseerr) plumbing that used to live on
    /// <c>JellyfinCanopyControllerBase</c>: configured-URL fan-out, user
    /// resolution with TTL cache + optional just-in-time import, the proxy core
    /// with its response cache and permission pre-checks, and the
    /// watchlist/request list helpers. One implementation, one cache
    /// (<see cref="ISeerrCache"/>) — the former <c>JellyseerrUserResolver</c>
    /// duplicate is folded in here.
    /// </summary>
    public interface IJellyseerrClient
    {
        /// <summary>
        /// Resolves the full Seerr user for a Jellyfin user id (any GUID format).
        /// Honours the user cache (unless disabled/bypassed), skips blocked users,
        /// and — when <paramref name="allowAutoImport"/> and the config allow it —
        /// attempts a just-in-time import of missing users.
        /// </summary>
        Task<JellyseerrUser?> GetJellyseerrUser(string jellyfinUserId, bool bypassCache = false, bool allowAutoImport = true);

        /// <summary>
        /// Resolves just the Seerr user id (cached separately with the same TTL).
        /// Pass <paramref name="allowAutoImport"/>=false for read-only callers
        /// (audits, background monitors) that must never create Seerr users.
        /// </summary>
        Task<string?> GetJellyseerrUserId(string jellyfinUserId, bool allowAutoImport = true);

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
        /// The proxy core: authenticated fan-out of <paramref name="apiPath"/> to the
        /// configured Seerr URLs on behalf of <paramref name="caller"/>, with response
        /// caching, permission pre-checks and the typed error envelope contract.
        /// </summary>
        Task<IActionResult> ProxyRequestAsync(string apiPath, HttpMethod method, string? content, JellyseerrCaller caller);

        /// <summary>Fetches a Seerr user's watchlist (by Seerr user id).</summary>
        Task<List<WatchlistItem>?> GetWatchlistForUser(string jellyseerrUserId);

        /// <summary>Fetches the requests a Seerr user made (by Seerr user id).</summary>
        Task<List<WatchlistItem>?> GetRequestsForUser(string jellyseerrUserId);
    }
}
