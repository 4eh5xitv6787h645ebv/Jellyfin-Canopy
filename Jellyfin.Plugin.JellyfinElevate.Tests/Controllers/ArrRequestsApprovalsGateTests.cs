using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Security.Claims;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinElevate.Configuration;
using Jellyfin.Plugin.JellyfinElevate.Controllers;
using Jellyfin.Plugin.JellyfinElevate.Model.Jellyseerr;
using Jellyfin.Plugin.JellyfinElevate.Services;
using Jellyfin.Plugin.JellyfinElevate.Services.Arr;
using Jellyfin.Plugin.JellyfinElevate.Services.Jellyseerr;
using Jellyfin.Plugin.JellyfinElevate.Tests.TestDoubles;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.Controllers
{
    /// <summary>
    /// Pins the server-side In-App Request Approvals feature gate on
    /// <see cref="ArrRequestsController"/>:
    /// <list type="bullet">
    /// <item><description><see cref="ArrRequestsController.ActOnRequest"/> returns 403 when
    /// <c>RequestApprovalsEnabled == false</c>, even for a Jellyfin admin — the client hides the
    /// buttons but the server must still enforce so a crafted request can't bypass the toggle.</description></item>
    /// <item><description>The requests-list endpoint advertises <c>canApproveRequests == false</c>
    /// when the toggle is off (so the client never renders the buttons), even for a caller who
    /// otherwise holds MANAGE_REQUESTS.</description></item>
    /// <item><description>The approve/decline response is parsed to evict the shared detail cache:
    /// a valid <c>{type, media.tmdbId}</c> body evicts the exact entry; a malformed body neither
    /// throws nor evicts.</description></item>
    /// </list>
    /// </summary>
    public class ArrRequestsApprovalsGateTests
    {
        private const string CallerGuid = "22222222-2222-2222-2222-222222222222";
        private const int CallerSeerrId = 42;

        // ── Controller wiring ────────────────────────────────────────────────

        private static ArrRequestsController BuildController(
            PluginConfiguration config,
            JellyseerrPermission callerPermissions,
            RecordingHttpMessageHandler handler,
            RecordingJellyseerrClient jellyseerr,
            bool isAdmin,
            string? requestPath = null)
        {
            var factory = new RecordingHttpClientFactory(handler);
            var provider = new FakePluginConfigProvider(config);
            var seerrCache = new SeerrCache(provider);

            var controller = new ArrRequestsController(
                factory,
                NullLogger<ArrRequestsController>.Instance,
                new StubUserManager(), // empty: IsAdminUser() falls through to the role claim below
                seerrCache,
                provider,
                jellyseerr,
                new ArrFetchService(factory, NullLogger<ArrFetchService>.Instance),
                new PassthroughParentalFilter());

            var claims = new List<Claim> { new("Jellyfin-UserId", CallerGuid) };
            if (isAdmin)
            {
                claims.Add(new Claim(ClaimTypes.Role, "Administrator"));
            }

            var httpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity(claims, "TestAuth")),
            };
            if (requestPath != null)
            {
                httpContext.Request.Path = requestPath;
            }

            controller.ControllerContext = new ControllerContext { HttpContext = httpContext };
            return controller;
        }

        private static PluginConfiguration Config(bool approvalsEnabled) => new()
        {
            JellyseerrEnabled = true,
            JellyseerrUrls = "http://seerr:5055",
            JellyseerrApiKey = "key",
            RequestApprovalsEnabled = approvalsEnabled,
        };

        private static int? StatusOf(IActionResult result) => (result as ObjectResult)?.StatusCode;

        private static string? MessageOf(IActionResult result)
            => (result as ObjectResult)?.Value?.GetType().GetProperty("message")?.GetValue((result as ObjectResult)!.Value) as string;

        private static bool CanApprove(IActionResult result)
        {
            var ok = Assert.IsType<OkObjectResult>(result);
            var json = JsonNode.Parse(JsonSerializer.Serialize(ok.Value))!.AsObject();
            return (bool)json["canApproveRequests"]!;
        }

        // ── 1. ActOnRequest is gated server-side, even for an admin ───────────

        [Fact]
        public async Task ActOnRequest_ApprovalsDisabled_Returns403_EvenForAdmin()
        {
            var handler = new RecordingHttpMessageHandler();
            var jellyseerr = new RecordingJellyseerrClient(
                new JellyseerrUser { Id = CallerSeerrId, Permissions = JellyseerrPermission.ADMIN });

            var controller = BuildController(
                Config(approvalsEnabled: false),
                JellyseerrPermission.ADMIN,
                handler,
                jellyseerr,
                isAdmin: true,
                requestPath: "/JellyfinElevate/arr/requests/123/approve");

            var result = await controller.ActOnRequest(123);

            Assert.Equal(403, StatusOf(result));
            Assert.Equal("In-app request approvals are disabled.", MessageOf(result));
            // The gate short-circuits before any upstream call or cache eviction.
            Assert.Empty(handler.Sent);
            Assert.Empty(jellyseerr.Evictions);
        }

        // ── 2. Requests list advertises the capability off when toggled off ──

        [Fact]
        public async Task GetRequests_ApprovalsDisabled_CanApproveFalse_ForManageRequestsCaller()
        {
            var handler = new RecordingHttpMessageHandler();
            handler.AddResponse("/api/v1/request", @"{ ""results"": [], ""pageInfo"": { ""results"": 0 } }");
            var jellyseerr = new RecordingJellyseerrClient(
                new JellyseerrUser { Id = CallerSeerrId, Permissions = JellyseerrPermission.MANAGE_REQUESTS });

            var controller = BuildController(
                Config(approvalsEnabled: false),
                JellyseerrPermission.MANAGE_REQUESTS,
                handler,
                jellyseerr,
                isAdmin: false);

            Assert.False(CanApprove(await controller.GetRequests()));
        }

        [Fact]
        public async Task GetRequests_ApprovalsEnabled_CanApproveTrue_ForManageRequestsCaller()
        {
            // Companion to the disabled case: with the same authorized (MANAGE_REQUESTS) caller,
            // flipping the toggle on is the only thing that turns the capability on — proving the
            // toggle, not the permission, is the deciding factor.
            var handler = new RecordingHttpMessageHandler();
            handler.AddResponse("/api/v1/request", @"{ ""results"": [], ""pageInfo"": { ""results"": 0 } }");
            var jellyseerr = new RecordingJellyseerrClient(
                new JellyseerrUser { Id = CallerSeerrId, Permissions = JellyseerrPermission.MANAGE_REQUESTS });

            var controller = BuildController(
                Config(approvalsEnabled: true),
                JellyseerrPermission.MANAGE_REQUESTS,
                handler,
                jellyseerr,
                isAdmin: false);

            Assert.True(CanApprove(await controller.GetRequests()));
        }

        // ── 3. Approve/decline response drives detail-cache eviction ─────────

        [Fact]
        public async Task ActOnRequest_ValidApproveResponse_EvictsMatchingDetailCache()
        {
            var handler = new RecordingHttpMessageHandler();
            // Seerr's approve response is the MediaRequest: root `type` + `media.tmdbId`.
            handler.AddResponse("/approve", @"{ ""type"": ""movie"", ""media"": { ""tmdbId"": 550 } }");
            var jellyseerr = new RecordingJellyseerrClient(
                new JellyseerrUser { Id = CallerSeerrId, Permissions = JellyseerrPermission.ADMIN });

            var controller = BuildController(
                Config(approvalsEnabled: true),
                JellyseerrPermission.ADMIN,
                handler,
                jellyseerr,
                isAdmin: true,
                requestPath: "/JellyfinElevate/arr/requests/9/approve");

            var result = await controller.ActOnRequest(9);

            Assert.IsType<OkObjectResult>(result);
            var eviction = Assert.Single(jellyseerr.Evictions);
            Assert.Equal((550, "movie"), eviction);
        }

        [Fact]
        public async Task ActOnRequest_MalformedApproveResponse_NoThrow_NoEviction()
        {
            var handler = new RecordingHttpMessageHandler();
            // Well-formed JSON but missing media.tmdbId → parser must not throw and must not evict.
            handler.AddResponse("/approve", @"{ ""type"": ""movie"", ""media"": {} }");
            var jellyseerr = new RecordingJellyseerrClient(
                new JellyseerrUser { Id = CallerSeerrId, Permissions = JellyseerrPermission.ADMIN });

            var controller = BuildController(
                Config(approvalsEnabled: true),
                JellyseerrPermission.ADMIN,
                handler,
                jellyseerr,
                isAdmin: true,
                requestPath: "/JellyfinElevate/arr/requests/9/approve");

            var result = await controller.ActOnRequest(9);

            Assert.IsType<OkObjectResult>(result);
            Assert.Empty(jellyseerr.Evictions);
        }

        // ── Minimal fakes ────────────────────────────────────────────────────

        /// <summary>
        /// Resolves the caller to a fixed Seerr user and records every
        /// <see cref="EvictMediaDetailCache"/> call so the eviction path is assertable.
        /// Every other member is an unused NotImplemented stub (repo convention).
        /// </summary>
        private sealed class RecordingJellyseerrClient : IJellyseerrClient
        {
            private readonly JellyseerrUser _user;

            public RecordingJellyseerrClient(JellyseerrUser user) => _user = user;

            public List<(int TmdbId, string MediaType)> Evictions { get; } = new();

            public void EvictMediaDetailCache(int tmdbId, string mediaType) => Evictions.Add((tmdbId, mediaType));

            public Task<JellyseerrUser?> GetJellyseerrUser(string jellyfinUserId, bool bypassCache = false, bool allowAutoImport = true)
                => Task.FromResult<JellyseerrUser?>(_user);

            public Task<string?> GetJellyseerrUserId(string jellyfinUserId, bool allowAutoImport = true)
                => throw new NotImplementedException();

            public bool IsImportBlocked(string jellyfinUserId, PluginConfiguration config)
                => throw new NotImplementedException();

            public Task<bool> GetStatusActiveAsync() => throw new NotImplementedException();

            public Task<Seerr4kCapability> GetSeerr4kCapabilityAsync(string jellyfinUserId, bool isAdmin = false)
                => throw new NotImplementedException();

            public Task<IActionResult> ProxyRequestAsync(string apiPath, HttpMethod method, string? content, JellyseerrCaller caller)
                => throw new NotImplementedException();

            public Task<List<WatchlistItem>?> GetWatchlistForUser(string jellyseerrUserId)
                => throw new NotImplementedException();

            public Task<List<WatchlistItem>?> GetRequestsForUser(string jellyseerrUserId)
                => throw new NotImplementedException();
        }

        private sealed class PassthroughParentalFilter : ISeerrParentalFilter
        {
            public Task<SeerrParentalResult> ApplyAsync(string json, string apiPath, JellyseerrCaller caller)
                => Task.FromResult(new SeerrParentalResult(false, json));

            public Task<bool> IsBlockedAsync(string mediaType, int tmdbId, JellyseerrCaller caller)
                => Task.FromResult(false);

            public Task<bool> IsTmdbProxyPathBlockedAsync(string tmdbApiPath, JellyseerrCaller caller)
                => Task.FromResult(false);
        }
    }
}
