using System.Collections.Generic;
using System.Net.Http;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Jellyseerr;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Jellyseerr
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
    /// A watchlist/request entry reduced to the identity JE needs (moved from
    /// the former protected nested class on the controller base).
    /// </summary>
    public class WatchlistItem
    {
        public int TmdbId { get; set; }

        public string MediaType { get; set; } = "movie";
    }

    /// <summary>
    /// All Seerr (Jellyseerr) plumbing that used to live on
    /// <c>JellyfinEnhancedControllerBase</c>: configured-URL fan-out, user
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
