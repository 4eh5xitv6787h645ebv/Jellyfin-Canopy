using System;
using System.Collections.Generic;
using System.Text.Json;

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
        /// True when <paramref name="url"/> is a well-formed absolute http(s) BASE URL suitable to
        /// hand to a browser as a link target. Rejects: empty/whitespace, scheme-less "host:port",
        /// non-http(s) schemes (<c>file:</c>/<c>javascript:</c>), embedded credentials
        /// (user:pass@ — a stored external URL is projected to every authenticated client, so
        /// credentials would leak), and query strings / fragments (item paths are string-appended
        /// to the base, so <c>?x=1</c> would produce <c>…?x=1/series/…</c>).
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

            if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
            {
                return false;
            }

            // No credentials: the value is served to every authenticated client.
            if (!string.IsNullOrEmpty(uri.UserInfo))
            {
                return false;
            }

            // No query/fragment: callers append "/movie/{id}"-style paths by concatenation.
            if (!string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment))
            {
                return false;
            }

            return true;
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

        /// <summary>
        /// Sanitises the per-instance <c>ExternalUrl</c> fields inside a stored
        /// SonarrInstances/RadarrInstances JSON array (the config-page validator can be bypassed
        /// by a direct config POST or hand edit, so the save hook is the authoritative gate).
        /// Only rewrites when the JSON parses cleanly — corrupt JSON is returned untouched, since
        /// the corruption-recovery flow (<c>IsSonarrInstancesCorrupt</c> etc.) owns that case.
        /// </summary>
        /// <param name="json">The stored instance-array JSON.</param>
        /// <param name="onDropped">Invoked with (instanceName, droppedValue) for each malformed external URL.</param>
        /// <returns>The (possibly rewritten) JSON.</returns>
        public static string SanitizeInstanceExternalUrlsJson(string json, Action<string, string>? onDropped = null)
        {
            if (string.IsNullOrWhiteSpace(json))
            {
                return json;
            }

            try
            {
                var instances = JsonSerializer.Deserialize<List<Model.Arr.ArrInstance>>(json);
                if (instances == null)
                {
                    return json;
                }

                bool changed = false;
                foreach (var instance in instances)
                {
                    if (instance == null)
                    {
                        continue;
                    }

                    var cleaned = SanitizeExternalUrl(instance.ExternalUrl);
                    if (!string.Equals(cleaned, instance.ExternalUrl ?? string.Empty, StringComparison.Ordinal))
                    {
                        if (!string.IsNullOrWhiteSpace(instance.ExternalUrl))
                        {
                            onDropped?.Invoke(instance.Name, instance.ExternalUrl);
                        }

                        instance.ExternalUrl = cleaned;
                        changed = true;
                    }
                }

                return changed ? JsonSerializer.Serialize(instances) : json;
            }
            catch (JsonException)
            {
                return json;
            }
        }
    }
}
