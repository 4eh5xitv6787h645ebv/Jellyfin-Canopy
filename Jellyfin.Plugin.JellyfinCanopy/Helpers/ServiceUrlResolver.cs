using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace Jellyfin.Plugin.JellyfinCanopy.Helpers
{
    /// <summary>
    /// The single server-side authority for the internal/external URL split used by the
    /// Seerr and *arr integrations (upstream "split URLs" requests 177/486/203/225).
    ///
    /// The plugin keeps two roles for every service URL:
    ///  - <b>Internal URL</b> — how the <i>Jellyfin server</i> reaches the service (LAN / docker
    ///    network). Every server-side fetch (<c>SeerrClient</c>, <c>ArrFetchService</c>, …)
    ///    uses this and this only. It may point at an address a browser can never reach.
    ///  - <b>External / public URL</b> — how a <i>user's browser</i> reaches the service, used only
    ///    for user-clickable "Open in Seerr / Sonarr / Radarr" deep links.
    ///
    /// When no external URL is configured the link falls back to the internal URL, so existing
    /// single-URL setups keep their exact prior behaviour (zero behaviour change).
    /// </summary>
    public static class ServiceUrlResolver
    {
        internal const int MaximumHttpUrlLength = 2048;
        internal const int MaximumUrlMappingsLength = 64 * 1024;

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
            if (string.IsNullOrWhiteSpace(url)
                || !Uri.TryCreate(url.Trim(), UriKind.Absolute, out var uri)
                || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
                || !string.IsNullOrEmpty(uri.UserInfo)
                || !string.IsNullOrEmpty(uri.Query)
                || !string.IsNullOrEmpty(uri.Fragment))
            {
                return false;
            }

            return true;
        }

        /// <summary>
        /// Validates and normalizes an HTTP(S) service base without discarding a
        /// configured application base path. In addition to the browser-link checks,
        /// this rejects control characters, backslashes, encoded separators and dot
        /// segments so appending an allowlisted API path cannot escape the configured
        /// base.
        /// </summary>
        public static bool TryNormalizeHttpBaseUrl(string? url, out string normalized)
        {
            normalized = string.Empty;
            if (string.IsNullOrWhiteSpace(url))
            {
                return false;
            }

            var trimmed = url.Trim();
            if (trimmed.Length > MaximumHttpUrlLength
                || trimmed.Any(char.IsControl)
                || trimmed.Contains('\\')
                || trimmed.StartsWith("//", StringComparison.Ordinal)
                || !Uri.TryCreate(trimmed, UriKind.Absolute, out var uri))
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

            if (string.IsNullOrWhiteSpace(uri.Host))
            {
                return false;
            }

            // Inspect the original escaped path because System.Uri canonicalizes
            // literal dot segments before exposing AbsolutePath.
            var schemeSeparator = trimmed.IndexOf("://", StringComparison.Ordinal);
            var authorityEnd = schemeSeparator < 0
                ? -1
                : trimmed.IndexOf('/', schemeSeparator + 3);
            var rawPath = authorityEnd < 0 ? string.Empty : trimmed[authorityEnd..];
            if (rawPath.Split('/', StringSplitOptions.None).Any(segment => !IsSafeEscapedPathSegment(segment)))
            {
                return false;
            }

            var authority = uri.GetComponents(
                UriComponents.SchemeAndServer,
                UriFormat.UriEscaped).TrimEnd('/');
            var path = uri.GetComponents(UriComponents.Path, UriFormat.UriEscaped).Trim('/');
            var candidate = path.Length == 0 ? authority : $"{authority}/{path}";
            if (candidate.Length > MaximumHttpUrlLength)
            {
                return false;
            }

            normalized = candidate;
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
        /// Sanitizes newline-delimited <c>Jellyfin URL|service URL</c> browser-link
        /// mappings. Invalid, duplicate and excessive rows are discarded. Neither
        /// side is ever used for server-to-server traffic.
        /// </summary>
        public static string SanitizeUrlMappings(string? mappings, int maximumMappings = 32)
        {
            if (string.IsNullOrWhiteSpace(mappings)
                || mappings.Length > MaximumUrlMappingsLength
                || maximumMappings <= 0)
            {
                return string.Empty;
            }

            var rows = new List<string>(Math.Min(maximumMappings, 8));
            var seenSources = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var normalizedLength = 0;
            foreach (var line in mappings.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
            {
                if (rows.Count >= maximumMappings)
                {
                    break;
                }

                var parts = line.Split('|');
                if (parts.Length != 2
                    || !TryNormalizeHttpBaseUrl(parts[0], out var source)
                    || !TryNormalizeHttpBaseUrl(parts[1], out var target)
                    || !seenSources.Add(source))
                {
                    continue;
                }

                var row = $"{source}|{target}";
                var proposedLength = normalizedLength
                    + (rows.Count == 0 ? 0 : 1)
                    + row.Length;
                if (proposedLength > MaximumUrlMappingsLength)
                {
                    return string.Empty;
                }

                rows.Add(row);
                normalizedLength = proposedLength;
            }

            var normalized = string.Join('\n', rows);
            return normalized.Length <= MaximumUrlMappingsLength
                ? normalized
                : string.Empty;
        }

        /// <summary>
        /// Resolves an administrator browser-link base. A mapping for the current
        /// Jellyfin access URL wins, followed by the external URL and finally the
        /// internal URL. Every candidate is revalidated at use time.
        /// </summary>
        public static string? ResolveMappedPublicUrl(
            string? internalUrl,
            string? externalUrl,
            string? mappings,
            string? currentJellyfinUrl)
        {
            if (TryNormalizeHttpBaseUrl(currentJellyfinUrl, out var current))
            {
                foreach (var line in SanitizeUrlMappings(mappings).Split(
                    '\n',
                    StringSplitOptions.RemoveEmptyEntries))
                {
                    var parts = line.Split('|');
                    if (parts.Length == 2
                        && string.Equals(parts[0], current, StringComparison.OrdinalIgnoreCase))
                    {
                        return parts[1];
                    }
                }
            }

            if (TryNormalizeHttpBaseUrl(externalUrl, out var external))
            {
                return external;
            }

            return TryNormalizeHttpBaseUrl(internalUrl, out var internalBase)
                ? internalBase
                : null;
        }

        /// <summary>
        /// Joins a validated root-relative browser route to a validated base while
        /// preserving a configured application BASE_PATH.
        /// </summary>
        public static string? JoinRelativePath(string? baseUrl, string? relativePath)
        {
            if (!TryNormalizeHttpBaseUrl(baseUrl, out var normalizedBase)
                || string.IsNullOrWhiteSpace(relativePath)
                || relativePath.Length > MaximumHttpUrlLength
                || !relativePath.StartsWith("/", StringComparison.Ordinal)
                || relativePath.StartsWith("//", StringComparison.Ordinal)
                || relativePath.Contains('\\')
                || relativePath.Contains('?')
                || relativePath.Contains('#')
                || relativePath.Any(char.IsControl))
            {
                return null;
            }

            if (relativePath.Split('/', StringSplitOptions.None)
                .Any(segment => !IsSafeEscapedPathSegment(segment)))
            {
                return null;
            }

            var joined = normalizedBase + relativePath;
            return joined.Length <= MaximumHttpUrlLength
                ? joined
                : null;
        }

        /// <summary>
        /// Validates one escaped path segment through every encoding layer. A single
        /// decode is insufficient because a proxy or browser can decode a second time
        /// (<c>%252e%252e</c> becomes <c>%2e%2e</c>, then <c>..</c>). Percent-bearing
        /// results are therefore decoded repeatedly and rejected if they do not
        /// converge quickly or if any layer exposes a separator, control character,
        /// or dot segment.
        /// </summary>
        private static bool IsSafeEscapedPathSegment(string segment)
        {
            var current = segment;
            for (var depth = 0; depth < 4; depth++)
            {
                string decoded;
                try
                {
                    decoded = Uri.UnescapeDataString(current);
                }
                catch (UriFormatException)
                {
                    return false;
                }

                if (decoded is "." or ".."
                    || decoded.Contains('/')
                    || decoded.Contains('\\')
                    || decoded.Any(char.IsControl))
                {
                    return false;
                }

                if (!decoded.Contains('%'))
                {
                    return true;
                }

                // Uri.UnescapeDataString leaves malformed percent escapes unchanged.
                // It also means another component could reinterpret the remaining
                // percent sequence, so fail closed when decoding cannot make progress.
                if (string.Equals(decoded, current, StringComparison.Ordinal))
                {
                    return false;
                }

                current = decoded;
            }

            return false;
        }

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
