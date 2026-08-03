using System;
using System.Linq;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Http;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    public class PlatformDiscoveryControllerTests
    {
        private static PlatformDiscoveryController Controller(bool enabled = true)
        {
            var controller = new PlatformDiscoveryController
            {
                ControllerContext = new ControllerContext
                {
                    HttpContext = new DefaultHttpContext(),
                },
            };
            PlatformAvailabilityFilter.Record(controller.HttpContext, enabled);
            return controller;
        }

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

        [Fact]
        public void Discovery_UsesOnlyTheRequestScopedAvailabilitySnapshot()
        {
            var disabled = Assert.IsType<PlatformDiscoveryResponse>(
                Assert.IsType<OkObjectResult>(Controller(enabled: false).GetDiscovery().Result).Value);

            Assert.False(disabled.Available);
            Assert.Equal(PlatformConstants.ProtocolMinimum, disabled.ProtocolMinimum);
            Assert.Equal(PlatformConstants.ProtocolMaximum, disabled.ProtocolMaximum);

            var missingState = new PlatformDiscoveryController
            {
                ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() },
            };
            var missing = Assert.IsType<PlatformDiscoveryResponse>(
                Assert.IsType<OkObjectResult>(missingState.GetDiscovery().Result).Value);
            Assert.False(missing.Available);
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
        public async Task Negotiate_PicksTheHighestCommonVersion(int clientMin, int clientMax, bool compatible, int? expected)
        {
            var response = Assert.IsType<OkObjectResult>((await Controller().Negotiate(clientMin, clientMax)).Result);
            var payload = Assert.IsType<PlatformNegotiationResponse>(response.Value);

            Assert.Equal(compatible, payload.Compatible);
            Assert.Equal(expected, payload.Protocol);
        }

        [Fact]
        public async Task Negotiate_AlwaysEchoesTheHostRange()
        {
            // Including on the incompatible path: a client that cannot talk to us should
            // be able to say WHY in its logs rather than just failing.
            var response = Assert.IsType<OkObjectResult>((await Controller().Negotiate(9, 9)).Result);
            var payload = Assert.IsType<PlatformNegotiationResponse>(response.Value);

            Assert.False(payload.Compatible);
            Assert.Equal(PlatformConstants.ProtocolMinimum, payload.HostProtocolMinimum);
            Assert.Equal(PlatformConstants.ProtocolMaximum, payload.HostProtocolMaximum);
        }

        [Fact]
        public async Task Negotiate_WithNoRangeSuppliedAssumesTheOldestProtocol()
        {
            // A client that says nothing is treated as speaking v1 only. Assuming it
            // supports our newest would be optimistic about software we know nothing about.
            var response = Assert.IsType<OkObjectResult>((await Controller().Negotiate(null, null)).Result);
            var payload = Assert.IsType<PlatformNegotiationResponse>(response.Value);

            Assert.True(payload.Compatible);
            Assert.Equal(PlatformConstants.ProtocolMinimum, payload.Protocol);
        }

        [Fact]
        public async Task Negotiate_AdvertisesAvailabilityForTheAuthenticatedUser()
        {
            var userId = Guid.Parse("3f2504e0-4f89-41d3-9a0c-0305e82c3301");
            var available = new RecordingAvailability(available: true);
            var active = AuthenticatedController(available, userId);
            var activePayload = Assert.IsType<PlatformNegotiationResponse>(
                Assert.IsType<OkObjectResult>((await active.Negotiate(1, 1)).Result).Value);

            var unlinked = AuthenticatedController(new RecordingAvailability(available: false), userId);
            var unlinkedPayload = Assert.IsType<PlatformNegotiationResponse>(
                Assert.IsType<OkObjectResult>((await unlinked.Negotiate(1, 1)).Result).Value);
            var unavailablePayload = Assert.IsType<PlatformNegotiationResponse>(
                Assert.IsType<OkObjectResult>((await Controller().Negotiate(1, 1)).Result).Value);

            Assert.True(activePayload.SeerrAvailable);
            Assert.Equal(userId, available.UserId);
            Assert.False(unlinkedPayload.SeerrAvailable);
            Assert.False(unavailablePayload.SeerrAvailable);
        }

        [Fact]
        public async Task Negotiate_FailsClosedWhenAvailabilityLookupFails()
        {
            var controller = AuthenticatedController(
                new RecordingAvailability(available: false, failure: new InvalidOperationException("provider unavailable")),
                Guid.NewGuid());

            var payload = Assert.IsType<PlatformNegotiationResponse>(
                Assert.IsType<OkObjectResult>((await controller.Negotiate(1, 1)).Result).Value);

            Assert.False(payload.SeerrAvailable);
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

        private static PlatformDiscoveryController AuthenticatedController(
            ISeerrUserAvailability availability,
            Guid userId)
        {
            var controller = new PlatformDiscoveryController(availability)
            {
                ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() },
            };
            controller.HttpContext.Items["JellyfinCanopy.Platform.Actor"] = PlatformActorTestFactory.Create(
                userId,
                false,
                "correlation",
                null,
                null);
            return controller;
        }

        private sealed class RecordingAvailability : ISeerrUserAvailability
        {
            private readonly bool _available;
            private readonly Exception? _failure;

            internal RecordingAvailability(bool available, Exception? failure = null)
            {
                _available = available;
                _failure = failure;
            }

            internal Guid? UserId { get; private set; }

            public Task<bool> IsAvailableAsync(Guid jellyfinUserId, CancellationToken cancellationToken)
            {
                cancellationToken.ThrowIfCancellationRequested();
                UserId = jellyfinUserId;
                return _failure == null
                    ? Task.FromResult(_available)
                    : Task.FromException<bool>(_failure);
            }
        }
    }
}
