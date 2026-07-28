using System.Linq;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Microsoft.AspNetCore.Mvc;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    public class PlatformDiscoveryControllerTests
    {
        private static PlatformDiscoveryController Controller() => new();

        [Fact]
        public void Discovery_ExposesAvailabilityAndProtocolRangeAndNothingElse()
        {
            var response = Assert.IsType<OkObjectResult>(Controller().GetDiscovery().Result);
            var payload = Assert.IsType<PlatformDiscoveryResponse>(response.Value);

            Assert.True(payload.Available);
            Assert.Equal(PlatformConstants.ProtocolMinimum, payload.ProtocolMinimum);
            Assert.Equal(PlatformConstants.ProtocolMaximum, payload.ProtocolMaximum);

            // The shape is the contract. This is an ANONYMOUS payload, so a new property
            // is a new thing an unauthenticated caller learns about this server - it
            // should have to be added here deliberately, not arrive by accident.
            var properties = typeof(PlatformDiscoveryResponse).GetProperties().Select(p => p.Name).OrderBy(n => n);
            Assert.Equal(
                new[] { nameof(PlatformDiscoveryResponse.Available), nameof(PlatformDiscoveryResponse.ProtocolMaximum), nameof(PlatformDiscoveryResponse.ProtocolMinimum) },
                properties);
        }

        [Theory]
        // A client offering exactly what the host speaks.
        [InlineData(1, 1, true, 1)]
        // A forward-looking client: negotiate down to what the host actually has,
        // rather than refusing a client that is willing to speak our version.
        [InlineData(1, 5, true, 1)]
        // A client that has dropped support for everything this host speaks. Its own
        // outcome, distinct from "unavailable" and from "denied".
        [InlineData(4, 9, false, null)]
        public void Negotiate_PicksTheHighestCommonVersion(int clientMin, int clientMax, bool compatible, int? expected)
        {
            var response = Assert.IsType<OkObjectResult>(Controller().Negotiate(clientMin, clientMax).Result);
            var payload = Assert.IsType<PlatformNegotiationResponse>(response.Value);

            Assert.Equal(compatible, payload.Compatible);
            Assert.Equal(expected, payload.Protocol);
        }

        [Fact]
        public void Negotiate_AlwaysEchoesTheHostRange()
        {
            // Including on the incompatible path: a client that cannot talk to us should
            // be able to say WHY in its logs rather than just failing.
            var response = Assert.IsType<OkObjectResult>(Controller().Negotiate(9, 9).Result);
            var payload = Assert.IsType<PlatformNegotiationResponse>(response.Value);

            Assert.False(payload.Compatible);
            Assert.Equal(PlatformConstants.ProtocolMinimum, payload.HostProtocolMinimum);
            Assert.Equal(PlatformConstants.ProtocolMaximum, payload.HostProtocolMaximum);
        }

        [Fact]
        public void Negotiate_WithNoRangeSuppliedAssumesTheOldestProtocol()
        {
            // A client that says nothing is treated as speaking v1 only. Assuming it
            // supports our newest would be optimistic about software we know nothing about.
            var response = Assert.IsType<OkObjectResult>(Controller().Negotiate(null, null).Result);
            var payload = Assert.IsType<PlatformNegotiationResponse>(response.Value);

            Assert.True(payload.Compatible);
            Assert.Equal(PlatformConstants.ProtocolMinimum, payload.Protocol);
        }

        [Fact]
        public void RoutePrefixIsVersionedAndNamespacedUnderTheExistingPluginPath()
        {
            // Two properties matter here. It carries a MAJOR version, so an incompatible
            // v2 can coexist rather than mutating v1 under consumers. And it sits under
            // the plugin's own path, so it cannot collide with another plugin's routes -
            // Jellyfin applies no prefix convention of its own.
            Assert.Equal("JellyfinCanopy/Platform/v1", PlatformConstants.RoutePrefix);
        }
    }
}
