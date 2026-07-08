using System;
using System.Net;
using System.Net.Sockets;

namespace Jellyfin.Plugin.JellyfinElevate.Services
{
    /// <summary>
    /// Extracts the real client IP from proxy forwarding headers (issue 7),
    /// used only after the transport peer is confirmed a trusted proxy. Reads,
    /// in order: RFC 7239 <c>Forwarded: for=</c>, <c>X-Forwarded-For</c>,
    /// <c>X-Real-IP</c>. For the list-valued headers the RIGHTMOST entry is the
    /// hop the trusted proxy itself appended (the real client as that proxy saw
    /// it); taking the rightmost — not the leftmost, which is client-controlled
    /// and forgeable — is what makes this safe.
    ///
    /// Pure/static; returns null when no header yields a parseable address.
    /// </summary>
    public static class ForwardedHeaderParser
    {
        public static IPAddress? ExtractRealClientIp(
            Func<string, string?> getHeader)
        {
            // RFC 7239 Forwarded: for=1.2.3.4; may be a comma list of hops.
            var forwarded = getHeader("Forwarded");
            if (!string.IsNullOrWhiteSpace(forwarded))
            {
                var ip = ParseForwarded(forwarded);
                if (ip != null) return ip;
            }

            var xff = getHeader("X-Forwarded-For");
            if (!string.IsNullOrWhiteSpace(xff))
            {
                var ip = RightmostAddress(xff);
                if (ip != null) return ip;
            }

            var realIp = getHeader("X-Real-IP");
            if (!string.IsNullOrWhiteSpace(realIp))
            {
                if (TryParseHostMaybePort(realIp.Trim(), out var ip)) return ip;
            }

            return null;
        }

        // Rightmost comma-separated entry (the hop appended by the trusted
        // proxy nearest us). Walk from the right so a client-injected left
        // portion is ignored.
        private static IPAddress? RightmostAddress(string headerValue)
        {
            var parts = headerValue.Split(',');
            for (var i = parts.Length - 1; i >= 0; i--)
            {
                var token = parts[i].Trim();
                if (token.Length == 0) continue;
                if (TryParseHostMaybePort(token, out var ip)) return ip;
                // A malformed rightmost token is suspicious; stop rather than
                // walking left into client-controlled entries.
                return null;
            }
            return null;
        }

        // Forwarded: for="[2001:db8::1]:4711", for=192.0.2.60; take the
        // rightmost for= element.
        private static IPAddress? ParseForwarded(string headerValue)
        {
            var elements = headerValue.Split(',');
            for (var i = elements.Length - 1; i >= 0; i--)
            {
                var element = elements[i];
                foreach (var param in element.Split(';'))
                {
                    var kv = param.Trim();
                    if (!kv.StartsWith("for=", StringComparison.OrdinalIgnoreCase)) continue;
                    var val = kv.Substring(4).Trim().Trim('"');
                    if (val.Length == 0) continue;
                    if (TryParseHostMaybePort(val, out var ip)) return ip;
                    return null;
                }
            }
            return null;
        }

        // Parses "1.2.3.4", "1.2.3.4:5678", "[::1]", "[::1]:5678", "::1".
        private static bool TryParseHostMaybePort(string token, out IPAddress ip)
        {
            ip = IPAddress.None;

            // Bracketed IPv6, optional :port.
            if (token.StartsWith("[", StringComparison.Ordinal))
            {
                var close = token.IndexOf(']');
                if (close > 1)
                {
                    var inner = token.Substring(1, close - 1);
                    if (IPAddress.TryParse(inner, out var v6)) { ip = Normalize(v6); return true; }
                }
                return false;
            }

            if (IPAddress.TryParse(token, out var bare)) { ip = Normalize(bare); return true; }

            // host:port (IPv4 or a bare IPv6-with-port that TryParse rejected).
            var lastColon = token.LastIndexOf(':');
            if (lastColon > 0 && lastColon < token.Length - 1)
            {
                var portPart = token.Substring(lastColon + 1);
                if (int.TryParse(portPart, out _))
                {
                    var host = token.Substring(0, lastColon);
                    if (IPAddress.TryParse(host, out var withPort)) { ip = Normalize(withPort); return true; }
                }
            }

            return false;
        }

        private static IPAddress Normalize(IPAddress addr)
        {
            if (addr.IsIPv4MappedToIPv6) return addr.MapToIPv4();
            if (addr.AddressFamily == AddressFamily.InterNetworkV6 && addr.ScopeId != 0)
            {
                return new IPAddress(addr.GetAddressBytes());
            }
            return addr;
        }
    }
}
