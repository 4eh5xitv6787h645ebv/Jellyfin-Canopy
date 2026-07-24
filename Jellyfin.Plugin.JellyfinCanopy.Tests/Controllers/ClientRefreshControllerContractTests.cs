using System.Security.Claims;
using System.Reflection;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Common.Api;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers
{
    public sealed class ClientRefreshControllerContractTests
    {
        [Fact]
        public void StateEndpoint_RequiresAuthentication()
        {
            var method = typeof(ClientRefreshController).GetMethod(
                nameof(ClientRefreshController.GetState));

            Assert.NotNull(method);
            Assert.Equal(
                "client-refresh-state",
                method!.GetCustomAttribute<HttpGetAttribute>()?.Template);
            var authorize = method.GetCustomAttribute<AuthorizeAttribute>();
            Assert.NotNull(authorize);
            Assert.Null(authorize!.Policy);
        }

        [Fact]
        public void ForceEndpoint_RequiresElevation()
        {
            var method = typeof(ClientRefreshController).GetMethod(
                nameof(ClientRefreshController.RequestRefresh));

            Assert.NotNull(method);
            Assert.Equal(
                "client-refresh",
                method!.GetCustomAttribute<HttpPostAttribute>()?.Template);
            Assert.Equal(
                Policies.RequiresElevation,
                method.GetCustomAttribute<AuthorizeAttribute>()?.Policy);
        }

        [Fact]
        public void StateEndpoint_ReturnsNoStoreSnapshotAndRegistersCanopyDevice()
        {
            var userId = Guid.Parse("11111111-1111-1111-1111-111111111111");
            var registry = new RecordingLiveSessionRegistry();
            var controller = CreateController(registry, userId, "canopy-phone");

            var result = Assert.IsType<OkObjectResult>(controller.GetState().Result);
            var state = Assert.IsType<ClientRefreshState>(result.Value);

            Assert.Equal("no-store", controller.Response.Headers.CacheControl);
            Assert.Equal("Smart", state.Policy.Mode);
            Assert.Equal("canopy-phone", registry.DeviceId);
            Assert.Equal(userId, registry.UserId);
        }

        [Fact]
        public void ForceEndpoint_IncrementsRevisionAndReturnsNoStore()
        {
            var controller = CreateController(new RecordingLiveSessionRegistry());

            var first = Assert.IsType<OkObjectResult>(controller.RequestRefresh().Result);
            var second = Assert.IsType<OkObjectResult>(controller.RequestRefresh().Result);

            Assert.Equal("no-store", controller.Response.Headers.CacheControl);
            Assert.Contains("ForceRevision = 1", first.Value?.ToString(), StringComparison.Ordinal);
            Assert.Contains("ForceRevision = 2", second.Value?.ToString(), StringComparison.Ordinal);
        }

        private static ClientRefreshController CreateController(
            ILiveSessionRegistry registry,
            Guid? userId = null,
            string? deviceId = null)
        {
            var state = new ClientRefreshStateService(
                new FakePluginConfigProvider(new PluginConfiguration()),
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
            var claims = new List<Claim>();
            if (userId.HasValue)
            {
                claims.Add(new Claim("Jellyfin-UserId", userId.Value.ToString()));
            }

            if (deviceId != null)
            {
                claims.Add(new Claim("Jellyfin-DeviceId", deviceId));
            }

            var controller = new ClientRefreshController(state, registry)
            {
                ControllerContext = new ControllerContext
                {
                    HttpContext = new DefaultHttpContext
                    {
                        User = new ClaimsPrincipal(new ClaimsIdentity(claims, "TestAuth")),
                    },
                },
            };
            return controller;
        }

        private sealed class RecordingLiveSessionRegistry : ILiveSessionRegistry
        {
            public string? DeviceId { get; private set; }

            public Guid UserId { get; private set; }

            public void Touch(string deviceId, Guid userId)
            {
                DeviceId = deviceId;
                UserId = userId;
            }

            public IReadOnlyList<LiveSessionEntry> GetActiveEntries()
                => Array.Empty<LiveSessionEntry>();
        }
    }
}
