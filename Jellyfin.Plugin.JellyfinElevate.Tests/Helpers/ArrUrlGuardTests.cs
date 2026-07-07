using System.Linq;
using System.Net;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinElevate.Helpers;
using Xunit;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.Helpers
{
    /// <summary>
    /// CSCTRL-2 / ARR-8 (W2-TEST-8): pins the SSRF guard's three security-load-bearing
    /// decisions against the seam CS-H introduced (<c>internal IsBlockedIp</c> +
    /// <c>CreateGuardedHandler</c> + fail-closed DNS on both the sync and async paths):
    ///   1. FAIL-CLOSED on DNS failure — an unresolvable host is denied, not passed
    ///      through (was <c>return true</c> on <see cref="System.Net.Sockets.SocketException"/>).
    ///   2. CONNECT-TIME IP re-check (DNS rebinding / TOCTOU) — the guarded handler
    ///      selects only non-blocked, IPv6-mapping-normalized addresses; a rebound name
    ///      that resolves to a blocked IP at connect time yields no target.
    ///   3. Deliberate LOOPBACK / RFC-1918 pass-through — self-hosted arr/Seerr on
    ///      127.0.0.1, ::1, 10/8, 192.168/16, 172.16/12 stays ALLOWED. This class is the
    ///      single documented source of truth for that decision: a future "tighten" that
    ///      starts blocking LAN targets must consciously edit these expectations (they go
    ///      RED), so it can never silently break same-host installs.
    /// </summary>
    public class ArrUrlGuardTests
    {
        // ── Decision 3: internal-range pass-through (documented source of truth) ──────

        [Theory]
        [InlineData("127.0.0.1")]           // IPv4 loopback — deliberately allowed
        [InlineData("::1")]                 // IPv6 loopback — deliberately allowed
        [InlineData("10.0.0.5")]            // RFC-1918 10/8 — deliberately allowed
        [InlineData("192.168.1.10")]        // RFC-1918 192.168/16 — deliberately allowed
        [InlineData("172.16.4.4")]          // RFC-1918 172.16/12 (low) — deliberately allowed
        [InlineData("172.31.255.255")]      // RFC-1918 172.16/12 (high) — deliberately allowed
        [InlineData("fd00::1")]             // general IPv6 ULA — only the specific v6 metadata is blocked
        [InlineData("8.8.8.8")]             // public
        [InlineData("1.1.1.1")]             // public
        public void IsBlockedIp_LoopbackRfc1918AndPublic_Allowed(string ip)
        {
            // If any of these ever flips to blocked, a same-host / LAN arr install breaks.
            // That is a deliberate policy change — update this test on purpose, never to
            // silence it.
            Assert.False(ArrUrlGuard.IsBlockedIp(IPAddress.Parse(ip)));
        }

        [Theory]
        [InlineData("169.254.169.254")]     // AWS/GCP cloud metadata
        [InlineData("100.100.100.200")]     // Alibaba metadata
        [InlineData("169.254.170.2")]       // ECS task metadata
        [InlineData("169.254.1.1")]         // 169.254.0.0/16 link-local (whole range)
        [InlineData("169.254.0.0")]         // 169.254.0.0/16 lower bound
        [InlineData("169.254.255.255")]     // 169.254.0.0/16 upper bound
        [InlineData("fd00:ec2::254")]       // AWS IPv6 metadata
        [InlineData("0.0.0.0")]             // IPAddress.Any (unspecified)
        [InlineData("::")]                  // IPv6Any (unspecified)
        public void IsBlockedIp_MetadataLinkLocalAndUnspecified_Blocked(string ip)
        {
            Assert.True(ArrUrlGuard.IsBlockedIp(IPAddress.Parse(ip)));
        }

        // ── Decision 3 at the URL layer: literal targets resolve without DNS ─────────

        [Theory]
        [InlineData("http://127.0.0.1:8989")]
        [InlineData("http://10.0.0.5/api/v3/system/status")]
        [InlineData("http://192.168.1.10:7878")]
        [InlineData("https://[::1]:8096")]
        [InlineData("http://172.20.10.10")]
        public void IsAllowedUrl_LiteralLoopbackAndRfc1918_Allowed(string url)
        {
            Assert.True(ArrUrlGuard.IsAllowedUrl(url));
        }

        [Theory]
        [InlineData("http://169.254.169.254/latest/meta-data/")]  // metadata literal
        [InlineData("http://100.100.100.200")]                    // Alibaba metadata literal
        [InlineData("http://[fd00:ec2::254]/")]                   // IPv6 metadata literal
        [InlineData("http://[::ffff:169.254.169.254]/")]          // IPv6-MAPPED IPv4 metadata (normalized)
        [InlineData("http://0.0.0.0")]                            // unspecified
        [InlineData("http://metadata.google.internal")]          // blocked hostname
        [InlineData("http://metadata.goog/computeMetadata/")]    // blocked hostname
        public void IsAllowedUrl_LiteralBlockedTargets_Denied(string url)
        {
            Assert.False(ArrUrlGuard.IsAllowedUrl(url));
        }

        // ── Scheme / shape validation (first-class, not via ArrTagService) ───────────

        [Theory]
        [InlineData("ftp://8.8.8.8")]
        [InlineData("file:///etc/passwd")]
        [InlineData("gopher://169.254.169.254")]
        [InlineData("ws://127.0.0.1:8096")]
        public void IsAllowedUrl_NonHttpScheme_Denied(string url)
        {
            Assert.False(ArrUrlGuard.IsAllowedUrl(url));
        }

        [Theory]
        [InlineData(null)]
        [InlineData("")]
        [InlineData("   ")]
        [InlineData("not a url")]
        [InlineData("http://")]          // empty host
        [InlineData("://8.8.8.8")]       // no scheme
        public void IsAllowedUrl_MalformedOrEmpty_Denied(string? url)
        {
            Assert.False(ArrUrlGuard.IsAllowedUrl(url));
        }

        // ── Decision 1: fail-closed on DNS failure (sync AND async) ──────────────────

        [Fact]
        public void IsAllowedUrl_DnsFailure_FailsClosed()
        {
            // The reserved .invalid TLD never resolves (RFC 6761); an unresolvable host
            // must be DENIED (a short-TTL rebinding name could later resolve to metadata).
            Assert.False(ArrUrlGuard.IsAllowedUrl("http://nonexistent.invalid."));
        }

        [Fact]
        public async Task IsAllowedUrlAsync_DnsFailure_FailsClosed()
        {
            // The async resolver path must fail closed identically to the sync one.
            Assert.False(await ArrUrlGuard.IsAllowedUrlAsync("http://nonexistent.invalid."));
        }

        // ── Decision 1 (positive): the DNS branch is not fail-closed on everything ───

        [Fact]
        public void IsAllowedUrl_DnsResolvesToLoopback_Allowed()
        {
            // "localhost" resolves (offline) to 127.0.0.1 / ::1 — the DNS branch must
            // return the ALLOW, proving it is not blanket-denying resolvable names.
            Assert.True(ArrUrlGuard.IsAllowedUrl("http://localhost:8989"));
        }

        [Fact]
        public async Task IsAllowedUrlAsync_DnsResolvesToLoopback_Allowed()
        {
            Assert.True(await ArrUrlGuard.IsAllowedUrlAsync("http://localhost:7878"));
        }

        // ── Decision 2: connect-time IP re-check (DNS rebinding / TOCTOU) ─────────────

        [Fact]
        public void CreateGuardedHandler_ConfiguresRedirectAndConnectCallback()
        {
            using var noRedirect = ArrUrlGuard.CreateGuardedHandler(allowAutoRedirect: false);
            using var withRedirect = ArrUrlGuard.CreateGuardedHandler(allowAutoRedirect: true);

            Assert.False(noRedirect.AllowAutoRedirect);
            Assert.True(withRedirect.AllowAutoRedirect);
            // The connect-time re-check is the authoritative TOCTOU gate — it must be wired
            // on every guarded handler regardless of the redirect setting.
            Assert.NotNull(noRedirect.ConnectCallback);
            Assert.NotNull(withRedirect.ConnectCallback);
        }

        [Fact]
        public void GuardedSelection_RebindToMixed_PicksTheCleanIp()
        {
            // Mirrors the ConnectCallback's normalize-then-filter selection
            // (FirstOrDefault(a => !IsBlockedIp(mapped))): a rebound name that resolves to
            // [metadata, clean] at connect time must connect ONLY to the clean IP.
            var mixed = new[]
            {
                IPAddress.Parse("169.254.169.254"),
                IPAddress.Parse("8.8.8.8"),
            };

            var picked = mixed.FirstOrDefault(a => !ArrUrlGuard.IsBlockedIp(Normalize(a)));

            Assert.Equal(IPAddress.Parse("8.8.8.8"), picked);
        }

        [Fact]
        public void GuardedSelection_RebindToIpv6MappedMetadata_IsBlocked()
        {
            // A rebind that returns the metadata IP as an IPv6-mapped address must still be
            // rejected — the callback normalizes ::ffff:a.b.c.d to a.b.c.d before the check.
            var mapped = IPAddress.Parse("::ffff:169.254.169.254");

            Assert.True(ArrUrlGuard.IsBlockedIp(Normalize(mapped)));
        }

        [Fact]
        public void GuardedSelection_RebindToAllBlocked_YieldsNoTarget()
        {
            // A TTL-0 rebind that resolves ONLY to metadata IPs at connect time must leave
            // no allowed target — the ConnectCallback throws (HttpRequestException) in that
            // case rather than connecting.
            var allBlocked = new[]
            {
                IPAddress.Parse("169.254.169.254"),
                IPAddress.Parse("169.254.170.2"),
            };

            var picked = allBlocked.FirstOrDefault(a => !ArrUrlGuard.IsBlockedIp(Normalize(a)));

            Assert.Null(picked);
        }

        /// <summary>Mirror of the ConnectCallback's IPv6-mapped normalization.</summary>
        private static IPAddress Normalize(IPAddress a) => a.IsIPv4MappedToIPv6 ? a.MapToIPv4() : a;
    }
}
