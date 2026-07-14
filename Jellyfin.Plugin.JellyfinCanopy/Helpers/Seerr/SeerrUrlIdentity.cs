using System;
using System.Linq;

namespace Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr
{
    /// <summary>
    /// Canonicalizes configured Seerr identity-domain URLs. URI scheme and host
    /// are case-insensitive and default ports are aliases; reverse-proxy paths
    /// remain case-sensitive and therefore preserve their original casing.
    /// </summary>
    internal static class SeerrUrlIdentity
    {
        public static string[] ParseConfigured(string? configuredUrls)
            => (configuredUrls ?? string.Empty)
                .Split(new[] { '\r', '\n', ',' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(Normalize)
                .Where(static url => url != null)
                .Select(static url => url!)
                .Distinct(StringComparer.Ordinal)
                .ToArray();

        public static string? Normalize(string? sourceUrl)
        {
            var trimmed = sourceUrl?.Trim().TrimEnd('/');
            if (string.IsNullOrWhiteSpace(trimmed)) return null;

            if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var uri)
                || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
                || string.IsNullOrEmpty(uri.Host)
                || !string.IsNullOrEmpty(uri.UserInfo)
                || !string.IsNullOrEmpty(uri.Query)
                || !string.IsNullOrEmpty(uri.Fragment))
            {
                // Validation is owned by the configuration boundary. Retaining
                // an invalid value here lets the normal request path report it,
                // while still deduplicating exact malformed entries safely.
                return trimmed;
            }

            // A trailing dot denotes the DNS root and does not select another
            // host (`seerr.example.` and `seerr.example` resolve identically).
            // Collapse it so aggregate jobs and mutations never visit the same
            // identity domain twice through absolute-name aliases.
            var idnHost = uri.IdnHost;
            var host = (idnHost.EndsWith(".", StringComparison.Ordinal)
                    && !idnHost.EndsWith("..", StringComparison.Ordinal))
                ? idnHost[..^1].ToLowerInvariant()
                : idnHost.ToLowerInvariant();
            if (host.Length == 0) return trimmed;
            if (host.Contains(':', StringComparison.Ordinal)
                && !host.StartsWith("[", StringComparison.Ordinal))
            {
                host = $"[{host}]";
            }

            var port = uri.IsDefaultPort ? string.Empty : $":{uri.Port}";
            var path = uri.AbsolutePath == "/"
                ? string.Empty
                : uri.AbsolutePath.TrimEnd('/');
            return $"{uri.Scheme.ToLowerInvariant()}://{host}{port}{path}";
        }
    }
}
