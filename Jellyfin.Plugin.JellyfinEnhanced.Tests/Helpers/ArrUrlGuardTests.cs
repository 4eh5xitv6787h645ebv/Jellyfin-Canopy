using System.Linq;
using System.Net;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Xunit;

namespace Jellyfin.Plugin.JellyfinEnhanced.Tests.Helpers
{
    /// <summary>
    /// CSCTRL-2 / ARR-8: the SSRF guard must (a) fail CLOSED when a host can't be
    /// resolved (was pass-through), and (b) expose the block-list decision so the
    /// connect-time handler can re-check the actually-resolved IP (DNS-rebind/TOCTOU).
    /// Loopback and RFC-1918 stay deliberately ALLOWED (common same-host arr/Seerr).
    /// </summary>
    public class ArrUrlGuardTests
    {
        [Fact]
        public void DnsFailure_IsBlocked()
        {
            // The reserved .invalid TLD never resolves (RFC 6761); the guard must now
            // treat an unresolvable host as disallowed instead of letting it through.
            Assert.False(ArrUrlGuard.IsAllowedUrl("http://nonexistent.invalid."));
        }

        [Theory]
        [InlineData("169.254.169.254")] // cloud metadata
        [InlineData("100.100.100.200")] // Alibaba metadata
        [InlineData("169.254.170.2")]   // ECS task metadata
        [InlineData("169.254.1.1")]     // 169.254.0.0/16 link-local range
        public void IsBlockedIp_MetadataAndLinkLocal_True(string ip)
        {
            Assert.True(ArrUrlGuard.IsBlockedIp(IPAddress.Parse(ip)));
        }

        [Theory]
        [InlineData("127.0.0.1")]     // loopback — deliberately allowed
        [InlineData("10.0.0.5")]      // RFC-1918 — deliberately allowed
        [InlineData("192.168.1.10")]  // RFC-1918 — deliberately allowed
        [InlineData("172.16.4.4")]    // RFC-1918 — deliberately allowed
        [InlineData("8.8.8.8")]       // public
        public void LoopbackAndRfc1918AndPublic_Allowed(string ip)
        {
            Assert.False(ArrUrlGuard.IsBlockedIp(IPAddress.Parse(ip)));
        }

        [Fact]
        public void CreateGuardedHandler_ConfiguresRedirectAndConnectCallback()
        {
            using var noRedirect = ArrUrlGuard.CreateGuardedHandler(allowAutoRedirect: false);
            using var withRedirect = ArrUrlGuard.CreateGuardedHandler(allowAutoRedirect: true);

            Assert.False(noRedirect.AllowAutoRedirect);
            Assert.True(withRedirect.AllowAutoRedirect);
            // The connect-time re-check is the authoritative TOCTOU gate — it must be wired.
            Assert.NotNull(noRedirect.ConnectCallback);
            Assert.NotNull(withRedirect.ConnectCallback);
        }

        [Fact]
        public void GuardedSelection_FiltersBlockedIp_AndPicksCleanOne()
        {
            // Mirrors the ConnectCallback's FirstOrDefault(a => !IsBlockedIp(a)) selection:
            // a rebound name that resolves to [metadata, clean] must connect to the clean IP.
            var mixed = new[]
            {
                IPAddress.Parse("169.254.169.254"),
                IPAddress.Parse("8.8.8.8"),
            };

            var picked = mixed.FirstOrDefault(a => !ArrUrlGuard.IsBlockedIp(a));

            Assert.Equal(IPAddress.Parse("8.8.8.8"), picked);
        }

        [Fact]
        public void GuardedSelection_AllBlocked_YieldsNoTarget()
        {
            // A TTL-0 rebind that resolves ONLY to the metadata IP at connect time must
            // leave no allowed target — the ConnectCallback throws in that case.
            var allBlocked = new[]
            {
                IPAddress.Parse("169.254.169.254"),
                IPAddress.Parse("169.254.170.2"),
            };

            var picked = allBlocked.FirstOrDefault(a => !ArrUrlGuard.IsBlockedIp(a));

            Assert.Null(picked);
        }
    }
}
