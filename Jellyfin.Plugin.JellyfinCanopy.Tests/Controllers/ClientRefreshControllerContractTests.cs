using System.Security.Claims;
using System.Reflection;
using System.Text.Json;
using System.Linq;
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
        public void BootstrapEndpoint_IsAnonymousNoStoreJavascriptWithOnlyTheRefreshContract()
        {
            var method = typeof(ClientRefreshController).GetMethod(
                nameof(ClientRefreshController.GetBootstrap));
            Assert.NotNull(method);
            Assert.Equal(
                "client-refresh-bootstrap.js",
                method!.GetCustomAttribute<HttpGetAttribute>()?.Template);
            Assert.NotNull(method.GetCustomAttribute<AllowAnonymousAttribute>());

            var controller = CreateController(new RecordingLiveSessionRegistry());
            var result = Assert.IsType<ContentResult>(controller.GetBootstrap());
            Assert.Equal("no-store", controller.Response.Headers.CacheControl);
            Assert.Equal("nosniff", controller.Response.Headers["X-Content-Type-Options"]);
            Assert.Equal("text/javascript; charset=utf-8", result.ContentType);
            Assert.StartsWith(
                "window.__JellyfinCanopyRefreshBootstrap=",
                result.Content,
                StringComparison.Ordinal);

            const string prefix = "window.__JellyfinCanopyRefreshBootstrap=";
            var json = result.Content![prefix.Length..^1];
            using var document = JsonDocument.Parse(json);
            var rootKeys = document.RootElement.EnumerateObject()
                .Select(property => property.Name)
                .OrderBy(name => name)
                .ToArray();
            Assert.Equal(
                new[]
                {
                    "CanopyBuildId",
                    "ConfigurationRevision",
                    "ForceRevision",
                    "JellyfinGeneration",
                    "Policy",
                    "SchemaVersion",
                    "ServerId",
                },
                rootKeys);
            var policyKeys = document.RootElement.GetProperty("Policy")
                .EnumerateObject()
                .Select(property => property.Name)
                .OrderBy(name => name)
                .ToArray();
            Assert.Equal(
                new[]
                {
                    "IdleSeconds",
                    "Mode",
                    "OnCanopyUpdate",
                    "OnConfigChange",
                    "OnJellyfinUpdate",
                    "PollSeconds",
                },
                policyKeys);
            var state = JsonSerializer.Deserialize<ClientRefreshState>(json);
            Assert.NotNull(state);
            Assert.Equal(1, state!.SchemaVersion);
            Assert.Equal("cccccccccccccccccccccccccccccccc", state.ServerId);
            Assert.Matches("^[a-f0-9]{64}$", state.CanopyBuildId);
            Assert.Matches("^[a-f0-9]{64}$", state.JellyfinGeneration);
        }

        [Theory]
        [InlineData("1", true)]
        [InlineData("1720000000000", true)]
        [InlineData("", false)]
        [InlineData("-1", false)]
        [InlineData("1.0", false)]
        [InlineData("not-a-heartbeat", false)]
        public void LegacyHeartbeatQuery_IsAcceptedOnlyForTheOldNumericProbe(
            string value,
            bool expected)
        {
            Assert.Equal(
                expected,
                ConfigController.IsLegacyRefreshHeartbeat(
                    new Microsoft.Extensions.Primitives.StringValues(value)));
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
                "cccccccccccccccccccccccccccccccc",
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
