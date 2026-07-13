using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinCanopy.Helpers
{
    public static class ArrUrlGuard
    {
        private static readonly HashSet<string> _blockedHosts = new(StringComparer.OrdinalIgnoreCase)
        {
            "metadata.google.internal",
            "metadata.goog"
        };

        private static readonly HashSet<IPAddress> _blockedIPs = new()
        {
            IPAddress.Parse("169.254.169.254"),
            IPAddress.Parse("100.100.100.200"),
            IPAddress.Parse("169.254.170.2"),
            IPAddress.Parse("fd00:ec2::254"),
            IPAddress.Any,
            IPAddress.IPv6Any
        };

        private static bool? TrySyncChecks(string? url, out string host)
        {
            host = string.Empty;
            if (string.IsNullOrWhiteSpace(url)) return false;
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return false;
            if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) return false;

            host = uri.Host.TrimEnd('.').ToLowerInvariant();
            if (string.IsNullOrEmpty(host)) return false;
            if (_blockedHosts.Contains(host)) return false;

            if (IPAddress.TryParse(host, out var literalIp))
            {
                // normalize IPv6-mapped IPv4 so the block
                // list still catches `[::ffff:169.254.169.254]`.
                if (literalIp.IsIPv4MappedToIPv6)
                {
                    literalIp = literalIp.MapToIPv4();
                }
                return !IsBlockedIp(literalIp);
            }

            return null;  // need DNS
        }

        internal static bool IsBlockedIp(IPAddress addr)
        {
            if (_blockedIPs.Contains(addr)) return true;
            // 169.254.0.0/16 — AWS metadata + Windows APIPA + ECS metadata + custom probes
            var bytes = addr.GetAddressBytes();
            if (bytes.Length == 4 && bytes[0] == 169 && bytes[1] == 254) return true;
            return false;
        }

        public static bool IsAllowedUrl(string? url)
        {
            var sync = TrySyncChecks(url, out var host);
            if (sync.HasValue) return sync.Value;

            try
            {
                var addresses = Dns.GetHostAddresses(host);
                foreach (var addr in addresses)
                {
                    if (IsBlockedIp(addr))
                        return false;
                }
            }
            catch (SocketException)
            {
                // Fail CLOSED: if the host can't be resolved we can't prove it isn't a
                // blocked target (a short-TTL/rebinding name could resolve to metadata
                // later), so treat it as disallowed. Callers surface "instance unreachable".
                return false;
            }
            catch (ArgumentException)
            {
                return false;
            }

            return true;
        }

        public static async Task<bool> IsAllowedUrlAsync(string? url, CancellationToken ct = default)
        {
            ct.ThrowIfCancellationRequested();
            var sync = TrySyncChecks(url, out var host);
            if (sync.HasValue) return sync.Value;

            try
            {
                var addresses = await Dns.GetHostAddressesAsync(host, ct).ConfigureAwait(false);
                foreach (var addr in addresses)
                {
                    if (IsBlockedIp(addr))
                        return false;
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch (SocketException)
            {
                // See sync variant — fail CLOSED on resolver failure.
                return false;
            }
            catch (ArgumentException)
            {
                return false;
            }

            return true;
        }

        /// <summary>
        /// Builds a <see cref="SocketsHttpHandler"/> that re-validates the ACTUAL connected
        /// IP at socket-connect time, defeating DNS rebinding: the guard's pre-flight resolve
        /// (<see cref="IsAllowedUrl"/>) and the client's connect-time resolve can differ, so
        /// this callback is the authoritative, TOCTOU-proof block point. Every arr/Seerr
        /// HttpClient routes through here.
        /// </summary>
        public static SocketsHttpHandler CreateGuardedHandler(bool allowAutoRedirect)
        {
            var handler = new SocketsHttpHandler { AllowAutoRedirect = allowAutoRedirect };
            handler.ConnectCallback = async (ctx, ct) =>
            {
                var entries = await Dns.GetHostAddressesAsync(ctx.DnsEndPoint.Host, ct).ConfigureAwait(false);
                var target = entries.FirstOrDefault(a => !IsBlockedIp(a.IsIPv4MappedToIPv6 ? a.MapToIPv4() : a))
                             ?? throw new HttpRequestException("Blocked by ArrUrlGuard (connect-time IP check).");

                var socket = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
                try
                {
                    await socket.ConnectAsync(new IPEndPoint(target, ctx.DnsEndPoint.Port), ct).ConfigureAwait(false);
                    return new NetworkStream(socket, ownsSocket: true);
                }
                catch
                {
                    socket.Dispose();
                    throw;
                }
            };
            return handler;
        }
    }
}
