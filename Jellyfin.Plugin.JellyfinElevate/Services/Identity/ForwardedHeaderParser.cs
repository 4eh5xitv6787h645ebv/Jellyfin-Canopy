using System;
using System.Net;
using System.Net.Sockets;

namespace Jellyfin.Plugin.JellyfinElevate.Services
{
    /// <summary>
    /// Extracts the real client IP from the SINGLE proxy forwarding header the
    /// admin declared (issue 7), used only after the transport peer is confirmed
    /// a trusted proxy. Reading exactly one named header — not several — closes a
    /// cross-header injection: a proxy that sets only <c>X-Forwarded-For</c> may
    /// not strip an inbound <c>Forwarded</c>/<c>X-Real-IP</c> the client forged,
    /// so trusting all of them would let a client behind the proxy spoof its own
    /// real IP. For the list-valued <c>X-Forwarded-For</c>/<c>Forwarded</c> the
    /// RIGHTMOST entry — the hop the trusted proxy itself appended — is used;
    /// never the leftmost, which is client-controlled.
    ///
    /// Pure/static; returns null when the header is absent or unparseable.
    /// </summary>
    public static class ForwardedHeaderParser
    {
        public static IPAddress? ExtractRealClientIp(
            Func<string, string?> getHeader,
            string headerName)
        {
            if (string.IsNullOrWhiteSpace(headerName)) headerName = "X-Forwarded-For";
            var value = getHeader(headerName.Trim());
            if (string.IsNullOrWhiteSpace(value)) return null;

            // RFC 7239 Forwarded uses "for=" element syntax; everything else is
            // a bare address or a comma list of addresses.
            if (string.Equals(headerName.Trim(), "Forwarded", StringComparison.OrdinalIgnoreCase))
            {
                return ParseForwarded(value);
            }
            return RightmostAddress(value);
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
