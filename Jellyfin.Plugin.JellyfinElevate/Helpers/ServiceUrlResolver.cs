using System;

namespace Jellyfin.Plugin.JellyfinElevate.Helpers
{
    /// <summary>
    /// The single server-side authority for the internal/external URL split used by the
    /// Seerr and *arr integrations (upstream "split URLs" requests 177/486/203/225).
    ///
    /// The plugin keeps two roles for every service URL:
    ///  - <b>Internal URL</b> — how the <i>Jellyfin server</i> reaches the service (LAN / docker
    ///    network). Every server-side fetch (<c>JellyseerrClient</c>, <c>ArrFetchService</c>, …)
    ///    uses this and this only. It may point at an address a browser can never reach.
    ///  - <b>External / public URL</b> — how a <i>user's browser</i> reaches the service, used only
    ///    for user-clickable "Open in Seerr / Sonarr / Radarr" deep links.
    ///
    /// When no external URL is configured the link falls back to the internal URL, so existing
    /// single-URL setups keep their exact prior behaviour (zero behaviour change).
    /// </summary>
    public static class ServiceUrlResolver
    {
        /// <summary>
        /// True when <paramref name="url"/> is a well-formed absolute http(s) URL. Anything else
        /// (empty, whitespace, a scheme-less "host:port", a <c>file:</c>/<c>javascript:</c> scheme)
        /// is rejected so a malformed value can never be handed to a browser as a link target.
        /// </summary>
        public static bool IsWellFormedHttpUrl(string? url)
        {
            if (string.IsNullOrWhiteSpace(url))
            {
                return false;
            }

            if (!Uri.TryCreate(url.Trim(), UriKind.Absolute, out var uri))
            {
                return false;
            }

            return uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps;
        }

        /// <summary>
        /// Resolves the URL a browser should link to for a service: the trimmed external URL when
        /// it is a well-formed http(s) URL, otherwise the internal URL unchanged. A malformed or
        /// blank external URL therefore transparently degrades to the internal URL rather than
        /// producing a broken link — defence-in-depth on top of the config-page save validation.
        /// </summary>
        /// <param name="internalUrl">The internal (server-reachable) URL — the existing field.</param>
        /// <param name="externalUrl">The optional external (browser-reachable) URL.</param>
        /// <returns>The URL to use for browser-facing links.</returns>
        public static string? ResolvePublicUrl(string? internalUrl, string? externalUrl)
            => IsWellFormedHttpUrl(externalUrl) ? externalUrl!.Trim() : internalUrl;

        /// <summary>
        /// Sanitises an admin-entered external URL for persistence: trims it, keeps it only if it
        /// is a well-formed http(s) URL, and blanks it otherwise. Used by the config-save hook so
        /// an obviously-malformed external URL is never stored (and never reaches link building).
        /// </summary>
        public static string SanitizeExternalUrl(string? url)
            => IsWellFormedHttpUrl(url) ? url!.Trim() : string.Empty;
    }
}
