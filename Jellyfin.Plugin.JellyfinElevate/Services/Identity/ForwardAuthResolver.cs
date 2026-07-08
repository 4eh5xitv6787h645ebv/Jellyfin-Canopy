using System;
using System.Collections.Generic;

namespace Jellyfin.Plugin.JellyfinElevate.Services
{
    /// <summary>
    /// Maps a forward-auth / SSO principal header to a Jellyfin user (issue 16).
    /// A trusted proxy fronting Authelia / Authentik / Cloudflare Access /
    /// Tailscale Serve injects the authenticated username or email on every
    /// proxied request — including anonymous image GETs that carry no token —
    /// so this is the ONLY tier that can name a native client on a cold cache
    /// behind an IP-hiding proxy before it has fetched any stamped DTO.
    ///
    /// Pure/static so it unit-tests without a host: the caller supplies the
    /// header lookup and a username→userId resolver. Trust is the CALLER's
    /// responsibility — this must only be consulted after the transport peer is
    /// confirmed a trusted proxy (else the header is client-forgeable).
    /// </summary>
    public static class ForwardAuthResolver
    {
        /// <summary>
        /// Walks <paramref name="headerNames"/> in order; for the first header
        /// present with a non-empty value, resolves it to a user. A value with
        /// an '@' (email) is tried as: the whole string as a username, then its
        /// local-part — covering deployments where the Jellyfin username equals
        /// either the full email or just the name before the '@'. Returns the
        /// first match, or null.
        /// </summary>
        /// <param name="headerNames">Configured principal header names, priority order.</param>
        /// <param name="getHeader">Header value lookup (case-insensitive); returns null/empty when absent.</param>
        /// <param name="resolveUsername">Username → userId (Guid.Empty when no such user).</param>
        public static Guid Resolve(
            IReadOnlyList<string> headerNames,
            Func<string, string?> getHeader,
            Func<string, Guid> resolveUsername)
        {
            if (headerNames == null || headerNames.Count == 0) return Guid.Empty;

            foreach (var name in headerNames)
            {
                if (string.IsNullOrWhiteSpace(name)) continue;
                var raw = getHeader(name.Trim());
                if (string.IsNullOrWhiteSpace(raw)) continue;

                var value = raw.Trim();
                foreach (var candidate in UsernameCandidates(value))
                {
                    var userId = resolveUsername(candidate);
                    if (userId != Guid.Empty) return userId;
                }
            }

            return Guid.Empty;
        }

        /// <summary>Parses the configured header-name string into an ordered list.</summary>
        public static IReadOnlyList<string> ParseHeaderNames(string? config)
        {
            if (string.IsNullOrWhiteSpace(config)) return Array.Empty<string>();
            var names = new List<string>();
            foreach (var token in config.Split(new[] { ',', ';', '\n', '\r', '\t' }, StringSplitOptions.RemoveEmptyEntries))
            {
                var t = token.Trim();
                if (t.Length > 0) names.Add(t);
            }
            return names;
        }

        // Ordered username candidates for a header value: the verbatim value
        // first (covers username-headers and username==full-email), then the
        // email local-part (covers username==name-before-@). Deduped.
        private static IEnumerable<string> UsernameCandidates(string value)
        {
            yield return value;
            var at = value.IndexOf('@');
            if (at > 0)
            {
                var local = value.Substring(0, at);
                if (local.Length > 0 && !string.Equals(local, value, StringComparison.Ordinal))
                {
                    yield return local;
                }
            }
        }
    }
}
