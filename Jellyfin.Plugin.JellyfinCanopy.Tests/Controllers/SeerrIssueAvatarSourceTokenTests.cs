using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Security.Claims;
using System.Text.Json;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Model.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers
{
    public class SeerrIssueAvatarSourceTokenTests
    {
        private const string Caller = "22222222-2222-2222-2222-222222222222";
        private const string Source = "http://source-b:5055/Tenant";

        [Fact]
        public void Decorator_BindsRelativeIssueAvatarToCallerPathAndPinnedSource()
        {
            var body = JsonNode.Parse(@"{
                ""results"": [{
                    ""id"": 7,
                    ""createdBy"": {
                        ""username"": ""reporter"",
                        ""avatar"": ""/avatar/reporter.png?v=1""
                    }
                }]
            }")!.AsObject();

            Assert.True(SeerrProxyController.TryDecorateIssueAvatarTokens(
                body,
                "key",
                Caller,
                Source));

            var createdBy = body["results"]!.AsArray()[0]!["createdBy"]!.AsObject();
            Assert.Equal("/avatar/reporter.png", (string?)createdBy["avatar"]);
            var token = (string)createdBy["avatarSourceToken"]!;
            Assert.True(SeerrSourceToken.TryValidate(
                token,
                "key",
                SeerrSourceToken.AvatarPurpose,
                Caller,
                "/avatar/reporter.png",
                out var claims));
            Assert.True(SeerrSourceToken.MatchesSource(claims!.SourceKey, "key", Source));
        }

        [Fact]
        public void Decorator_RemovesUnsafeRelativeAvatarInsteadOfPublishingUnboundProxyInput()
        {
            var body = JsonNode.Parse(@"{
                ""results"": [{ ""createdBy"": { ""avatar"": ""/avatar/%2e%2e/settings"" } }]
            }")!.AsObject();

            Assert.True(SeerrProxyController.TryDecorateIssueAvatarTokens(
                body,
                "key",
                Caller,
                Source));

            var createdBy = body["results"]!.AsArray()[0]!["createdBy"]!.AsObject();
            Assert.Null(createdBy["avatar"]);
            Assert.Null(createdBy["avatarSourceToken"]);
        }

        [Fact]
        public async Task IssueEndpoint_PinsMediaFilterReadAndAvatarTokenToResolvedSource()
        {
            var config = new PluginConfiguration
            {
                SeerrEnabled = true,
                SeerrUrls = "http://source-a:5055,http://source-b:5055/Tenant/",
                SeerrApiKey = "key",
            };
            var provider = new FakePluginConfigProvider(config);
            var seerr = new IssueSeerrClient(new SeerrUser
            {
                Id = 42,
                Permissions = SeerrPermission.VIEW_ISSUES,
                SourceUrl = Source,
            });
            var handler = new RecordingHttpMessageHandler();
            var factory = new RecordingHttpClientFactory(handler);
            var userManager = new StubUserManager();
            var cache = new SeerrCache(provider);
            var pending = new SpoilerPendingService(
                new UserConfigurationManager(
                    new StubAppPaths(Path.Combine(Path.GetTempPath(), "jc-issue-token-" + Guid.NewGuid().ToString("N"))),
                    NullLogger<UserConfigurationManager>.Instance),
                new CountingLibraryManager(),
                userManager,
                NullLogger<SpoilerPendingService>.Instance);
            var controller = new SeerrProxyController(
                factory,
                NullLogger<SeerrProxyController>.Instance,
                userManager,
                cache,
                provider,
                seerr,
                new PassthroughParentalFilter(),
                pending)
            {
                ControllerContext = new ControllerContext
                {
                    HttpContext = new DefaultHttpContext
                    {
                        User = new ClaimsPrincipal(new ClaimsIdentity(
                            new[] { new Claim("Jellyfin-UserId", Caller) },
                            "TestAuth")),
                    },
                },
            };

            var result = Assert.IsType<ContentResult>(await controller.GetSeerrIssues(
                tmdbId: 123,
                mediaType: "movie"));
            var body = JsonNode.Parse(result.Content!)!.AsObject();
            var createdBy = body["results"]!.AsArray()[0]!["createdBy"]!.AsObject();
            var token = (string)createdBy["avatarSourceToken"]!;

            Assert.Equal(Source, seerr.PinnedUser!.SourceUrl);
            Assert.Equal("/api/v1/movie/123", seerr.LastApiPath);
            Assert.Equal(1, seerr.FreshDetailReads);
            Assert.True(seerr.LastBypassCache);
            Assert.False(seerr.LastAllowAutoImport);
            Assert.True(SeerrSourceToken.TryValidate(
                token,
                "key",
                SeerrSourceToken.AvatarPurpose,
                Caller,
                "/avatar/reporter.png",
                out var claims));
            Assert.True(SeerrSourceToken.MatchesSource(claims!.SourceKey, "key", Source));
            Assert.Empty(handler.Sent);
        }

        [Fact]
        public async Task TargetedIssueEndpoint_PagesAndCountsTheCompleteTitleRelation()
        {
            var relation = new JsonArray();
            var start = new DateTimeOffset(2026, 7, 16, 0, 0, 0, TimeSpan.Zero);
            for (var id = 1; id <= 65; id++)
            {
                relation.Add(new JsonObject
                {
                    ["id"] = id,
                    ["status"] = id <= 55 ? 1 : 2,
                    ["createdAt"] = start.AddMinutes(id).ToString("O"),
                    ["updatedAt"] = start.AddMinutes(100 - id).ToString("O"),
                });
            }

            var seerr = new IssueSeerrClient(
                UserWithPermission(),
                DetailBody(9001, 42, "movie", relation));
            var parental = new PassthroughParentalFilter();
            var controller = CreateController(seerr, parental);

            var result = Assert.IsType<ContentResult>(await controller.GetSeerrIssues(
                tmdbId: 42,
                mediaType: "movie",
                take: 20,
                skip: 40,
                filter: "open",
                sort: "added"));
            var body = JsonNode.Parse(result.Content!)!.AsObject();
            var pageInfo = body["pageInfo"]!.AsObject();
            var rows = body["results"]!.AsArray();

            Assert.Equal(55, (int)pageInfo["results"]!);
            Assert.Equal(3, (int)pageInfo["pages"]!);
            Assert.Equal(3, (int)pageInfo["page"]!);
            Assert.Equal(15, rows.Count);
            Assert.Equal(15, (int)rows[0]!["id"]!);
            Assert.Equal(1, (int)rows[^1]!["id"]!);
            Assert.Equal("media-relation-owner", (string)body["jellyfinCanopyPagination"]!["contract"]!);
            Assert.True((bool)body["jellyfinCanopyPagination"]!["totalExact"]!);
            Assert.Equal("/api/v1/movie/42", seerr.LastApiPath);
            Assert.Equal(("movie", 42), parental.LastTarget);
        }

        [Fact]
        public async Task TargetedIssueEndpoint_MaximumSkipPublishesANonOverflowingExactPage()
        {
            var seerr = new IssueSeerrClient(
                UserWithPermission(),
                DetailBody(9001, 42, "movie", new JsonArray()));
            var controller = CreateController(seerr, new PassthroughParentalFilter());

            var result = Assert.IsType<ContentResult>(await controller.GetSeerrIssues(
                tmdbId: 42,
                mediaType: "movie",
                take: 1,
                skip: int.MaxValue));
            var body = JsonNode.Parse(result.Content!)!.AsObject();
            var pageInfo = body["pageInfo"]!.AsObject();

            Assert.Equal(2_147_483_648L, (long)pageInfo["page"]!);
            Assert.Equal(0, (int)pageInfo["results"]!);
            Assert.Empty(body["results"]!.AsArray());
        }

        [Fact]
        public async Task TargetedIssueEndpoint_BlockedTitleNeverDispatchesOrPublishesRows()
        {
            var seerr = new IssueSeerrClient(UserWithPermission(), DetailBody(1, 42, "movie", new JsonArray()));
            var parental = new PassthroughParentalFilter { BlockTarget = true };
            var controller = CreateController(seerr, parental);

            var result = Assert.IsType<ObjectResult>(await controller.GetSeerrIssues(
                tmdbId: 42,
                mediaType: "movie"));

            Assert.Equal(403, result.StatusCode);
            Assert.Equal(string.Empty, seerr.LastApiPath);
        }

        [Fact]
        public async Task TargetedIssueEndpoint_MalformedOrDuplicateRelationFailsWithoutPartialRows()
        {
            var relation = JsonNode.Parse(@"[
                { ""id"": 7, ""status"": 1, ""createdAt"": ""2026-01-01T00:00:00Z"", ""updatedAt"": ""2026-01-01T00:00:00Z"" },
                { ""id"": 7, ""status"": 1, ""createdAt"": ""2026-01-02T00:00:00Z"", ""updatedAt"": ""2026-01-02T00:00:00Z"" }
            ]")!.AsArray();
            var seerr = new IssueSeerrClient(UserWithPermission(), DetailBody(1, 42, "movie", relation));
            var controller = CreateController(seerr, new PassthroughParentalFilter());

            var result = Assert.IsType<ObjectResult>(await controller.GetSeerrIssues(
                tmdbId: 42,
                mediaType: "movie"));

            Assert.Equal(502, result.StatusCode);
            Assert.Contains("issue_relation_incomplete", JsonSerializer.Serialize(result.Value), StringComparison.Ordinal);
        }

        [Fact]
        public async Task TargetedIssueEndpoint_MissingMediaOwnerIsIncompleteNotFalseEmpty()
        {
            var seerr = new IssueSeerrClient(UserWithPermission(), @"{ ""mediaInfo"": null }");
            var controller = CreateController(seerr, new PassthroughParentalFilter());

            var result = Assert.IsType<ObjectResult>(await controller.GetSeerrIssues(
                tmdbId: 42,
                mediaType: "movie"));

            Assert.Equal(502, result.StatusCode);
            Assert.Contains("issue_relation_incomplete", JsonSerializer.Serialize(result.Value), StringComparison.Ordinal);
        }

        [Fact]
        public async Task TargetedIssueEndpoint_RejectsAnOwnerRelationBeyondTheHardBound()
        {
            var relation = new JsonArray();
            for (var id = 1; id <= 1001; id++) relation.Add(new JsonObject { ["id"] = id });
            var seerr = new IssueSeerrClient(UserWithPermission(), DetailBody(1, 42, "movie", relation));
            var controller = CreateController(seerr, new PassthroughParentalFilter());

            var result = Assert.IsType<ObjectResult>(await controller.GetSeerrIssues(
                tmdbId: 42,
                mediaType: "movie",
                take: 1000));

            Assert.Equal(502, result.StatusCode);
            Assert.Contains("issue_relation_incomplete", JsonSerializer.Serialize(result.Value), StringComparison.Ordinal);
        }

        [Fact]
        public async Task TargetedIssueEndpoint_PreservesUpstreamFailureWithoutPublishingAnEmptyTitle()
        {
            var upstream = new ObjectResult(new { error = true, code = "seerr_unavailable" }) { StatusCode = 503 };
            var seerr = new IssueSeerrClient(UserWithPermission(), resultOverride: upstream);
            var controller = CreateController(seerr, new PassthroughParentalFilter());

            var result = await controller.GetSeerrIssues(tmdbId: 42, mediaType: "movie");

            Assert.Same(upstream, result);
            Assert.Equal("/api/v1/movie/42", seerr.LastApiPath);
        }

        [Fact]
        public async Task GenericIssueEndpoint_RetainsOnePinnedSeerrOwnedPageForDownloads()
        {
            var seerr = new IssueSeerrClient(
                UserWithPermission(),
                @"{ ""pageInfo"": { ""pages"": 1, ""pageSize"": 20, ""results"": 1, ""page"": 1 }, ""results"": [{ ""id"": 9 }] }");
            var controller = CreateController(seerr, new PassthroughParentalFilter());

            var result = Assert.IsType<ContentResult>(await controller.GetSeerrIssues(
                take: 20,
                skip: 0,
                filter: "open"));

            Assert.Contains("/api/v1/issue?", seerr.LastApiPath, StringComparison.Ordinal);
            Assert.Contains("take=20", seerr.LastApiPath, StringComparison.Ordinal);
            Assert.DoesNotContain("mediaId", seerr.LastApiPath, StringComparison.Ordinal);
            Assert.Single(JsonNode.Parse(result.Content!)!["results"]!.AsArray());
        }

        [Theory]
        [InlineData(true)]
        [InlineData(false)]
        public async Task IssueEndpoint_FinalConfigurationFencePublishesNoOldSourceProjection(bool targeted)
        {
            var provider = new FakePluginConfigProvider(TestConfiguration());
            var body = targeted
                ? DetailBody(1, 42, "movie", JsonNode.Parse(@"[{
                    ""id"": 7, ""status"": 1,
                    ""createdAt"": ""2026-01-01T00:00:00Z"",
                    ""updatedAt"": ""2026-01-01T00:00:00Z""
                }]")!.AsArray())
                : @"{ ""pageInfo"": { ""pages"": 1, ""pageSize"": 20, ""results"": 1, ""page"": 1 }, ""results"": [{ ""id"": 7 }] }";
            var seerr = new IssueSeerrClient(UserWithPermission(), body);
            var controller = CreateController(seerr, new PassthroughParentalFilter(), provider);
            controller.BeforeIssueProjectionPublishForTest = () => provider.Current = TestConfiguration();

            var result = targeted
                ? await controller.GetSeerrIssues(tmdbId: 42, mediaType: "movie")
                : await controller.GetSeerrIssues();

            var changed = Assert.IsType<ObjectResult>(result);
            Assert.Equal(409, changed.StatusCode);
            Assert.Contains("read_configuration_changed", JsonSerializer.Serialize(changed.Value), StringComparison.Ordinal);
        }

        [Fact]
        public async Task TargetedIssueEndpoint_RequiresIssueViewPermissionBeforeDetailDispatch()
        {
            var seerr = new IssueSeerrClient(new SeerrUser
            {
                Id = 42,
                Permissions = SeerrPermission.CREATE_ISSUES,
                SourceUrl = Source,
            });
            var controller = CreateController(seerr, new PassthroughParentalFilter());

            var result = Assert.IsType<ObjectResult>(await controller.GetSeerrIssues(
                tmdbId: 42,
                mediaType: "movie"));

            Assert.Equal(403, result.StatusCode);
            Assert.Equal(string.Empty, seerr.LastApiPath);
        }

        private static SeerrUser UserWithPermission() => new()
        {
            Id = 42,
            Permissions = SeerrPermission.VIEW_ISSUES,
            SourceUrl = Source,
        };

        private static string DetailBody(int ownerId, int tmdbId, string mediaType, JsonArray issues)
            => new JsonObject
            {
                ["mediaInfo"] = new JsonObject
                {
                    ["id"] = ownerId,
                    ["tmdbId"] = tmdbId,
                    ["mediaType"] = mediaType,
                    ["issues"] = issues,
                },
            }.ToJsonString();

        private static SeerrProxyController CreateController(
            IssueSeerrClient seerr,
            PassthroughParentalFilter parental,
            FakePluginConfigProvider? provider = null)
        {
            provider ??= new FakePluginConfigProvider(TestConfiguration());
            var userManager = new StubUserManager();
            var pending = new SpoilerPendingService(
                new UserConfigurationManager(
                    new StubAppPaths(Path.Combine(Path.GetTempPath(), "jc-issue-owner-" + Guid.NewGuid().ToString("N"))),
                    NullLogger<UserConfigurationManager>.Instance),
                new CountingLibraryManager(),
                userManager,
                NullLogger<SpoilerPendingService>.Instance);
            var controller = new SeerrProxyController(
                new RecordingHttpClientFactory(new RecordingHttpMessageHandler()),
                NullLogger<SeerrProxyController>.Instance,
                userManager,
                new SeerrCache(provider),
                provider,
                seerr,
                parental,
                pending);
            controller.ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext
                {
                    User = new ClaimsPrincipal(new ClaimsIdentity(
                        new[] { new Claim("Jellyfin-UserId", Caller) },
                        "TestAuth")),
                },
            };
            return controller;
        }

        private static PluginConfiguration TestConfiguration()
            => new()
            {
                SeerrEnabled = true,
                SeerrUrls = "http://source-a:5055,http://source-b:5055/Tenant/",
                SeerrApiKey = "key",
            };

        private sealed class IssueSeerrClient : ISeerrClient
        {
            private readonly SeerrUser _user;

            private readonly string _detailBody;
            private readonly IActionResult? _resultOverride;

            public IssueSeerrClient(
                SeerrUser user,
                string? detailBody = null,
                IActionResult? resultOverride = null)
            {
                _user = user;
                _resultOverride = resultOverride;
                _detailBody = detailBody ?? DetailBody(
                    9001,
                    123,
                    "movie",
                    JsonNode.Parse(@"[{
                        ""id"": 7,
                        ""status"": 1,
                        ""createdAt"": ""2026-01-01T00:00:00Z"",
                        ""updatedAt"": ""2026-01-01T00:00:00Z"",
                        ""createdBy"": {
                            ""username"": ""reporter"",
                            ""avatar"": ""/avatar/reporter.png""
                        }
                    }]")!.AsArray());
            }

            public SeerrUser? PinnedUser { get; private set; }

            public bool LastBypassCache { get; private set; }

            public bool LastAllowAutoImport { get; private set; } = true;

            public string LastApiPath { get; private set; } = string.Empty;

            public int FreshDetailReads { get; private set; }

            public Task<SeerrUser?> GetSeerrUser(
                string jellyfinUserId,
                bool bypassCache = false,
                bool allowAutoImport = true)
            {
                LastBypassCache = bypassCache;
                LastAllowAutoImport = allowAutoImport;
                return Task.FromResult<SeerrUser?>(_user);
            }

            public Task<IActionResult> ProxyRequestAsync(
                string apiPath,
                HttpMethod method,
                string? content,
                SeerrCaller caller,
                SeerrUser resolvedUser)
            {
                PinnedUser = resolvedUser;
                LastApiPath = apiPath;
                if (_resultOverride != null)
                {
                    return Task.FromResult(_resultOverride);
                }
                return Task.FromResult<IActionResult>(new ContentResult
                {
                    ContentType = "application/json",
                    Content = _detailBody,
                });
            }

            public Task<IActionResult> ProxyFreshMediaDetailAsync(
                int tmdbId,
                string mediaType,
                SeerrCaller caller,
                SeerrUser resolvedUser,
                System.Threading.CancellationToken cancellationToken = default)
            {
                FreshDetailReads++;
                return ProxyRequestAsync(
                    $"/api/v1/{mediaType}/{tmdbId}",
                    HttpMethod.Get,
                    null,
                    caller,
                    resolvedUser);
            }

            public Task<string?> GetSeerrUserId(string jellyfinUserId, bool allowAutoImport = true)
                => throw new NotImplementedException();

            public bool IsImportBlocked(string jellyfinUserId, PluginConfiguration config)
                => throw new NotImplementedException();

            public Task<bool> GetStatusActiveAsync() => throw new NotImplementedException();

            public Task<Seerr4kCapability> GetSeerr4kCapabilityAsync(string jellyfinUserId, bool isAdmin = false)
                => throw new NotImplementedException();

            public void EvictMediaDetailCache(int tmdbId, string mediaType) { }

            public Task<IActionResult> ProxyRequestAsync(
                string apiPath,
                HttpMethod method,
                string? content,
                SeerrCaller caller)
                => throw new NotImplementedException();

            public Task<List<WatchlistItem>?> GetWatchlistForUser(string seerrUserId)
                => throw new NotImplementedException();

            public Task<List<WatchlistItem>?> GetRequestsForUser(string seerrUserId)
                => throw new NotImplementedException();
        }

        private sealed class PassthroughParentalFilter : ISeerrParentalFilter
        {
            public bool BlockTarget { get; init; }

            public (string MediaType, int TmdbId)? LastTarget { get; private set; }

            public Task<SeerrParentalResult> ApplyAsync(string json, string apiPath, SeerrCaller caller)
                => Task.FromResult(new SeerrParentalResult(false, json));

            public Task<bool> IsBlockedAsync(string mediaType, int tmdbId, SeerrCaller caller)
            {
                LastTarget = (mediaType, tmdbId);
                return Task.FromResult(BlockTarget);
            }

            public Task<bool> IsTmdbProxyPathBlockedAsync(string tmdbApiPath, SeerrCaller caller)
                => Task.FromResult(false);
        }
    }
}
