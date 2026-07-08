using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;

namespace Jellyfin.Plugin.JellyfinElevate.Services
{
    /// <summary>
    /// Parses an admin-configured trusted-proxy list (IPs or CIDR ranges) and
    /// answers "is this transport peer a trusted proxy?" — the gate every
    /// forwarded-header identity tier (forward-auth SSO, X-Forwarded-For learned
    /// map) checks before believing a proxy header. The check is always against
    /// <c>HttpContext.Connection.RemoteIpAddress</c> — the hop that ACTUALLY
    /// opened the TCP connection — never against a value the client can set, so
    /// a client connecting directly to Kestrel can never satisfy it.
    ///
    /// Immutable and pure; the caller rebuilds one when the config string
    /// changes (cheap — a handful of parsed ranges).
    /// </summary>
    public sealed class TrustedProxyEvaluator
    {
        private readonly IReadOnlyList<CidrRange> _ranges;

        /// <summary>The raw config string this evaluator was built from (so a caller can detect a change and rebuild).</summary>
        public string Source { get; }

        /// <summary>True when at least one valid proxy entry parsed — i.e. the proxy-header tiers are armed.</summary>
        public bool HasAny => _ranges.Count > 0;

        public TrustedProxyEvaluator(string? config)
        {
            Source = config ?? string.Empty;
            _ranges = Parse(Source);
        }

        /// <summary>
        /// True when <paramref name="transportPeer"/> — which MUST be
        /// <c>HttpContext.Connection.RemoteIpAddress</c> — falls inside a
        /// configured trusted-proxy range. IPv4-mapped-IPv6 peers are unwrapped
        /// so a mapped ::ffff:10.0.0.1 matches a 10.0.0.0/8 entry.
        /// </summary>
        public bool IsTrusted(IPAddress? transportPeer)
        {
            if (transportPeer == null || _ranges.Count == 0) return false;
            var ip = Normalize(transportPeer);
            foreach (var range in _ranges)
            {
                if (range.Contains(ip)) return true;
            }
            return false;
        }

        private static IReadOnlyList<CidrRange> Parse(string config)
        {
            if (string.IsNullOrWhiteSpace(config)) return Array.Empty<CidrRange>();

            var ranges = new List<CidrRange>();
            foreach (var tokenRaw in config.Split(new[] { ',', ';', '\n', '\r', '\t', ' ' }, StringSplitOptions.RemoveEmptyEntries))
            {
                var token = tokenRaw.Trim();
                if (token.Length == 0) continue;

                var slash = token.IndexOf('/');
                if (slash < 0)
                {
                    // Bare address ⇒ /32 (v4) or /128 (v6).
                    if (IPAddress.TryParse(token, out var single))
                    {
                        var norm = Normalize(single);
                        var fullBits = norm.AddressFamily == AddressFamily.InterNetworkV6 ? 128 : 32;
                        ranges.Add(new CidrRange(norm, fullBits));
                    }
                    continue;
                }

                var addrPart = token.Substring(0, slash);
                var prefixPart = token.Substring(slash + 1);
                if (!IPAddress.TryParse(addrPart, out var baseAddr)) continue;
                if (!int.TryParse(prefixPart, out var prefix)) continue;

                var normalized = Normalize(baseAddr);
                var maxBits = normalized.AddressFamily == AddressFamily.InterNetworkV6 ? 128 : 32;
                // Reject a non-positive prefix: a /0 ("0.0.0.0/0" or "::/0")
                // would match EVERY peer — including a client connecting directly
                // to Kestrel — arming the forwarded-header tiers for everyone.
                // That is never a valid trusted-proxy entry, so drop it (an admin
                // foot-gun, not a supported configuration).
                if (prefix <= 0 || prefix > maxBits) continue;
                ranges.Add(new CidrRange(normalized, prefix));
            }
            return ranges;
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

        private sealed class CidrRange
        {
            private readonly byte[] _network;
            private readonly int _prefixBits;
            private readonly AddressFamily _family;

            public CidrRange(IPAddress baseAddr, int prefixBits)
            {
                _family = baseAddr.AddressFamily;
                _prefixBits = prefixBits;
                _network = MaskBytes(baseAddr.GetAddressBytes(), prefixBits);
            }

            public bool Contains(IPAddress ip)
            {
                if (ip.AddressFamily != _family) return false;
                var candidate = MaskBytes(ip.GetAddressBytes(), _prefixBits);
                if (candidate.Length != _network.Length) return false;
                for (var i = 0; i < _network.Length; i++)
                {
                    if (candidate[i] != _network[i]) return false;
                }
                return true;
            }

            // Zeroes every bit below the prefix so two addresses in the same
            // range produce identical masked byte arrays.
            private static byte[] MaskBytes(byte[] bytes, int prefixBits)
            {
                var masked = (byte[])bytes.Clone();
                var fullBytes = prefixBits / 8;
                var remainderBits = prefixBits % 8;
                for (var i = 0; i < masked.Length; i++)
                {
                    if (i < fullBytes) continue;
                    if (i == fullBytes && remainderBits > 0)
                    {
                        var mask = (byte)(0xFF << (8 - remainderBits));
                        masked[i] &= mask;
                    }
                    else
                    {
                        masked[i] = 0;
                    }
                }
                return masked;
            }
        }
    }
}
