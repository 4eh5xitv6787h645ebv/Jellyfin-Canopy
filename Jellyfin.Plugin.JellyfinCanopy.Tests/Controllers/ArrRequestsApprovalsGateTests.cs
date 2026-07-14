using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Security.Claims;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Model.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Arr;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers
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
            SeerrPermission callerPermissions,
            RecordingHttpMessageHandler handler,
            RecordingSeerrClient seerr,
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
                seerr,
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

        private static PluginConfiguration Config(
            bool approvalsEnabled,
            string urls = "http://seerr:5055") => new()
        {
            SeerrEnabled = true,
            SeerrUrls = urls,
            SeerrApiKey = "key",
            RequestApprovalsEnabled = approvalsEnabled,
        };

        private static string ActionToken(
            int requestId,
            string source = "http://seerr:5055",
            string caller = CallerGuid,
            DateTimeOffset? issuedAt = null,
            int seerrUserId = CallerSeerrId)
            => SeerrSourceToken.Create(
                "key",
                SeerrSourceToken.RequestActionPurpose,
                caller,
                source,
                requestId.ToString(System.Globalization.CultureInfo.InvariantCulture),
                issuedAt,
                binding: seerrUserId.ToString(System.Globalization.CultureInfo.InvariantCulture))!;

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
            var seerr = new RecordingSeerrClient(
                new SeerrUser
                {
                    Id = CallerSeerrId,
                    Permissions = SeerrPermission.ADMIN,
                    SourceUrl = "http://seerr:5055",
                });

            var controller = BuildController(
                Config(approvalsEnabled: false),
                SeerrPermission.ADMIN,
                handler,
                seerr,
                isAdmin: true,
                requestPath: "/JellyfinCanopy/arr/requests/123/approve");

            var result = await controller.ActOnRequest(123);

            Assert.Equal(403, StatusOf(result));
            Assert.Equal("In-app request approvals are disabled.", MessageOf(result));
            // The gate short-circuits before any upstream call or cache eviction.
            Assert.Empty(handler.Sent);
            Assert.Empty(seerr.Evictions);
        }

        // ── 2. Requests list advertises the capability off when toggled off ──

        [Fact]
        public async Task GetRequests_ApprovalsDisabled_CanApproveFalse_ForManageRequestsCaller()
        {
            var handler = new RecordingHttpMessageHandler();
            handler.AddResponse("/api/v1/request", @"{ ""results"": [], ""pageInfo"": { ""results"": 0 } }");
            var seerr = new RecordingSeerrClient(
                new SeerrUser
                {
                    Id = CallerSeerrId,
                    Permissions = SeerrPermission.MANAGE_REQUESTS,
                    SourceUrl = "http://seerr:5055",
                });

            var controller = BuildController(
                Config(approvalsEnabled: false),
                SeerrPermission.MANAGE_REQUESTS,
                handler,
                seerr,
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
            var seerr = new RecordingSeerrClient(
                new SeerrUser
                {
                    Id = CallerSeerrId,
                    Permissions = SeerrPermission.MANAGE_REQUESTS,
                    SourceUrl = "http://seerr:5055",
                });

            var controller = BuildController(
                Config(approvalsEnabled: true),
                SeerrPermission.MANAGE_REQUESTS,
                handler,
                seerr,
                isAdmin: false);

            Assert.True(CanApprove(await controller.GetRequests()));
        }

        [Fact]
        public async Task GetRequests_ActionAndAvatarTokensBindCallerResourceAndResolvedSource()
        {
            var handler = new RecordingHttpMessageHandler();
            handler.AddResponse("/api/v1/request", @"{
                ""results"": [{
                    ""id"": 9,
                    ""status"": 1,
                    ""type"": ""movie"",
                    ""is4k"": false,
                    ""createdAt"": ""2026-01-01T00:00:00Z"",
                    ""requestedBy"": { ""id"": 42, ""username"": ""requester"", ""avatar"": ""/avatar/requester.png?v=1"" },
                    ""media"": { ""tmdbId"": 550, ""status"": 2, ""downloadStatus"": [] }
                }],
                ""pageInfo"": { ""results"": 1, ""pages"": 1 }
            }");
            handler.AddResponse("/api/v1/movie/550", @"{ ""title"": ""Movie"" }");
            var seerr = new RecordingSeerrClient(new SeerrUser
            {
                Id = CallerSeerrId,
                Permissions = SeerrPermission.MANAGE_REQUESTS,
                SourceUrl = "http://source-b:5055/Tenant",
            });
            var controller = BuildController(
                Config(true, "http://source-a:5055,http://source-b:5055/Tenant/"),
                SeerrPermission.MANAGE_REQUESTS,
                handler,
                seerr,
                isAdmin: false);

            var ok = Assert.IsType<OkObjectResult>(await controller.GetRequests());
            var body = JsonNode.Parse(JsonSerializer.Serialize(ok.Value))!.AsObject();
            var row = body["requests"]!.AsArray().Single()!.AsObject();
            var actionToken = (string)row["sourceToken"]!;
            var avatarUrl = (string)row["requestedByAvatar"]!;
            var avatarToken = Uri.UnescapeDataString(avatarUrl.Split("sourceToken=", StringSplitOptions.None)[1]);

            Assert.True(SeerrSourceToken.TryValidate(
                actionToken,
                "key",
                SeerrSourceToken.RequestActionPurpose,
                CallerGuid,
                "9",
                out var actionClaims));
            Assert.True(SeerrSourceToken.MatchesSource(
                actionClaims!.SourceKey,
                "key",
                "http://source-b:5055/Tenant"));
            Assert.Equal(CallerSeerrId.ToString(), actionClaims.Binding);
            Assert.True(SeerrSourceToken.TryValidate(
                avatarToken,
                "key",
                SeerrSourceToken.AvatarPurpose,
                CallerGuid,
                "/avatar/requester.png",
                out var avatarClaims));
            Assert.Equal(actionClaims.SourceKey, avatarClaims!.SourceKey);
        }

        // ── 3. Approve/decline response drives detail-cache eviction ─────────

        [Fact]
        public async Task ActOnRequest_ValidApproveResponse_EvictsMatchingDetailCache()
        {
            var handler = new RecordingHttpMessageHandler();
            // Seerr's approve response is the MediaRequest: root `type` + `media.tmdbId`.
            handler.AddResponse("/approve", @"{ ""type"": ""movie"", ""media"": { ""tmdbId"": 550 } }");
            var seerr = new RecordingSeerrClient(
                new SeerrUser
                {
                    Id = CallerSeerrId,
                    Permissions = SeerrPermission.ADMIN,
                    SourceUrl = "http://seerr:5055",
                });

            var controller = BuildController(
                Config(approvalsEnabled: true),
                SeerrPermission.ADMIN,
                handler,
                seerr,
                isAdmin: true,
                requestPath: "/JellyfinCanopy/arr/requests/9/approve");

            var result = await controller.ActOnRequest(9, ActionToken(9));

            Assert.IsType<OkObjectResult>(result);
            var eviction = Assert.Single(seerr.Evictions);
            Assert.Equal((550, "movie"), eviction);
        }

        [Fact]
        public async Task ActOnRequest_MalformedApproveResponse_NoThrow_NoEviction()
        {
            var handler = new RecordingHttpMessageHandler();
            // Well-formed JSON but missing media.tmdbId → parser must not throw and must not evict.
            handler.AddResponse("/approve", @"{ ""type"": ""movie"", ""media"": {} }");
            var seerr = new RecordingSeerrClient(
                new SeerrUser
                {
                    Id = CallerSeerrId,
                    Permissions = SeerrPermission.ADMIN,
                    SourceUrl = "http://seerr:5055",
                });

            var controller = BuildController(
                Config(approvalsEnabled: true),
                SeerrPermission.ADMIN,
                handler,
                seerr,
                isAdmin: true,
                requestPath: "/JellyfinCanopy/arr/requests/9/approve");

            var result = await controller.ActOnRequest(9, ActionToken(9));

            Assert.IsType<OkObjectResult>(result);
            Assert.Empty(seerr.Evictions);
        }

        [Fact]
        public async Task ActOnRequest_MissingResolvedSourceFailsClosedWithoutHttp()
        {
            var handler = new RecordingHttpMessageHandler();
            var seerr = new RecordingSeerrClient(
                new SeerrUser { Id = CallerSeerrId, Permissions = SeerrPermission.ADMIN });
            var controller = BuildController(
                Config(approvalsEnabled: true),
                SeerrPermission.ADMIN,
                handler,
                seerr,
                isAdmin: true,
                requestPath: "/JellyfinCanopy/arr/requests/9/approve");

            var failure = Assert.IsType<ObjectResult>(await controller.ActOnRequest(9, ActionToken(9)));
            Assert.Equal(409, failure.StatusCode);
            var body = JsonNode.Parse(JsonSerializer.Serialize(failure.Value))!.AsObject();
            Assert.Equal("stale_source_token", (string?)body["code"]);
            Assert.Empty(handler.Sent);
            Assert.Empty(seerr.Evictions);
        }

        [Theory]
        [InlineData(null)]
        [InlineData("not-a-token")]
        public async Task ActOnRequest_MissingOrTamperedTokenFailsBeforeResolutionOrHttp(string? token)
        {
            var handler = new RecordingHttpMessageHandler();
            var seerr = new RecordingSeerrClient(new SeerrUser
            {
                Id = CallerSeerrId,
                Permissions = SeerrPermission.ADMIN,
                SourceUrl = "http://seerr:5055",
            });
            var controller = BuildController(
                Config(approvalsEnabled: true),
                SeerrPermission.ADMIN,
                handler,
                seerr,
                isAdmin: true,
                requestPath: "/JellyfinCanopy/arr/requests/9/approve");

            var failure = Assert.IsType<ObjectResult>(await controller.ActOnRequest(9, token));

            Assert.Equal(403, failure.StatusCode);
            Assert.Empty(seerr.Resolutions);
            Assert.Empty(handler.Sent);
        }

        [Fact]
        public async Task ActOnRequest_ExpiredTokenFailsBeforeResolutionOrHttp()
        {
            var handler = new RecordingHttpMessageHandler();
            var seerr = new RecordingSeerrClient(new SeerrUser
            {
                Id = CallerSeerrId,
                Permissions = SeerrPermission.ADMIN,
                SourceUrl = "http://seerr:5055",
            });
            var controller = BuildController(
                Config(approvalsEnabled: true),
                SeerrPermission.ADMIN,
                handler,
                seerr,
                isAdmin: true,
                requestPath: "/JellyfinCanopy/arr/requests/9/approve");

            var failure = Assert.IsType<ObjectResult>(await controller.ActOnRequest(
                9,
                ActionToken(9, issuedAt: DateTimeOffset.UtcNow.AddMinutes(-31))));

            Assert.Equal(403, failure.StatusCode);
            Assert.Empty(seerr.Resolutions);
            Assert.Empty(handler.Sent);
        }

        [Fact]
        public async Task ActOnRequest_UserRemappedToAnotherConfiguredSourceFailsWithoutMutation()
        {
            var handler = new RecordingHttpMessageHandler();
            var seerr = new RecordingSeerrClient(new SeerrUser
            {
                Id = CallerSeerrId,
                Permissions = SeerrPermission.ADMIN,
                SourceUrl = "http://source-b:5055",
            });
            var controller = BuildController(
                Config(true, "http://source-a:5055,http://source-b:5055"),
                SeerrPermission.ADMIN,
                handler,
                seerr,
                isAdmin: true,
                requestPath: "/JellyfinCanopy/arr/requests/9/approve");

            var failure = Assert.IsType<ObjectResult>(await controller.ActOnRequest(
                9,
                ActionToken(9, "http://source-a:5055")));

            Assert.Equal(409, failure.StatusCode);
            Assert.Single(seerr.Resolutions);
            Assert.True(seerr.Resolutions[0].BypassCache);
            Assert.False(seerr.Resolutions[0].AllowAutoImport);
            Assert.Empty(handler.Sent);
        }

        [Fact]
        public async Task ActOnRequest_UserReboundOnSameSourceFailsWithoutMutation()
        {
            var handler = new RecordingHttpMessageHandler();
            var seerr = new RecordingSeerrClient(new SeerrUser
            {
                Id = 99,
                Permissions = SeerrPermission.ADMIN,
                SourceUrl = "http://source-a:5055",
            });
            var controller = BuildController(
                Config(true, "http://source-a:5055"),
                SeerrPermission.ADMIN,
                handler,
                seerr,
                isAdmin: true,
                requestPath: "/JellyfinCanopy/arr/requests/9/approve");

            var failure = Assert.IsType<ObjectResult>(await controller.ActOnRequest(
                9,
                ActionToken(9, "http://source-a:5055", seerrUserId: CallerSeerrId)));

            Assert.Equal(409, failure.StatusCode);
            Assert.Single(seerr.Resolutions);
            Assert.True(seerr.Resolutions[0].BypassCache);
            Assert.False(seerr.Resolutions[0].AllowAutoImport);
            Assert.Empty(handler.Sent);
        }

        [Fact]
        public async Task ActOnRequest_ValidTokenMutatesOnlyTokenSource()
        {
            var handler = new RecordingHttpMessageHandler();
            handler.AddResponse("/approve", @"{ ""type"": ""movie"", ""media"": { ""tmdbId"": 550 } }");
            var seerr = new RecordingSeerrClient(new SeerrUser
            {
                Id = CallerSeerrId,
                Permissions = SeerrPermission.ADMIN,
                SourceUrl = "http://source-b:5055",
            });
            var controller = BuildController(
                Config(true, "http://source-a:5055,http://source-b:5055"),
                SeerrPermission.ADMIN,
                handler,
                seerr,
                isAdmin: true,
                requestPath: "/JellyfinCanopy/arr/requests/9/approve");

            var result = await controller.ActOnRequest(9, ActionToken(9, "http://source-b:5055"));

            Assert.IsType<OkObjectResult>(result);
            var request = Assert.Single(handler.Requests);
            Assert.Equal("source-b", request.RequestUri!.Host);
        }

        // ── Minimal fakes ────────────────────────────────────────────────────

        /// <summary>
        /// Resolves the caller to a fixed Seerr user and records every
        /// <see cref="EvictMediaDetailCache"/> call so the eviction path is assertable.
        /// Every other member is an unused NotImplemented stub (repo convention).
        /// </summary>
        private sealed class RecordingSeerrClient : ISeerrClient
        {
            private readonly SeerrUser _user;

            public RecordingSeerrClient(SeerrUser user) => _user = user;

            public List<(int TmdbId, string MediaType)> Evictions { get; } = new();

            public List<(bool BypassCache, bool AllowAutoImport)> Resolutions { get; } = new();

            public void EvictMediaDetailCache(int tmdbId, string mediaType) => Evictions.Add((tmdbId, mediaType));

            public Task<SeerrUser?> GetSeerrUser(string jellyfinUserId, bool bypassCache = false, bool allowAutoImport = true)
            {
                Resolutions.Add((bypassCache, allowAutoImport));
                return Task.FromResult<SeerrUser?>(_user);
            }

            public Task<string?> GetSeerrUserId(string jellyfinUserId, bool allowAutoImport = true)
                => throw new NotImplementedException();

            public bool IsImportBlocked(string jellyfinUserId, PluginConfiguration config)
                => throw new NotImplementedException();

            public Task<bool> GetStatusActiveAsync() => throw new NotImplementedException();

            public Task<Seerr4kCapability> GetSeerr4kCapabilityAsync(string jellyfinUserId, bool isAdmin = false)
                => throw new NotImplementedException();

            public Task<IActionResult> ProxyRequestAsync(string apiPath, HttpMethod method, string? content, SeerrCaller caller)
                => throw new NotImplementedException();

            public Task<List<WatchlistItem>?> GetWatchlistForUser(string seerrUserId)
                => throw new NotImplementedException();

            public Task<List<WatchlistItem>?> GetRequestsForUser(string seerrUserId)
                => throw new NotImplementedException();
        }

        private sealed class PassthroughParentalFilter : ISeerrParentalFilter
        {
            public Task<SeerrParentalResult> ApplyAsync(string json, string apiPath, SeerrCaller caller)
                => Task.FromResult(new SeerrParentalResult(false, json));

            public Task<bool> IsBlockedAsync(string mediaType, int tmdbId, SeerrCaller caller)
                => Task.FromResult(false);

            public Task<bool> IsTmdbProxyPathBlockedAsync(string tmdbApiPath, SeerrCaller caller)
                => Task.FromResult(false);
        }
    }
}
