using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Security.Claims;
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
        public async Task IssueEndpoint_PinsReadAndAvatarTokenToResolvedSource()
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

            var result = Assert.IsType<ContentResult>(await controller.GetSeerrIssues(null));
            var body = JsonNode.Parse(result.Content!)!.AsObject();
            var createdBy = body["results"]!.AsArray()[0]!["createdBy"]!.AsObject();
            var token = (string)createdBy["avatarSourceToken"]!;

            Assert.Equal(Source, seerr.PinnedUser!.SourceUrl);
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

        private sealed class IssueSeerrClient : ISeerrClient
        {
            private readonly SeerrUser _user;

            public IssueSeerrClient(SeerrUser user) => _user = user;

            public SeerrUser? PinnedUser { get; private set; }

            public bool LastBypassCache { get; private set; }

            public bool LastAllowAutoImport { get; private set; } = true;

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
                return Task.FromResult<IActionResult>(new ContentResult
                {
                    ContentType = "application/json",
                    Content = @"{ ""results"": [{ ""createdBy"": { ""avatar"": ""/avatar/reporter.png"" } }] }",
                });
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
            public Task<SeerrParentalResult> ApplyAsync(string json, string apiPath, SeerrCaller caller)
                => Task.FromResult(new SeerrParentalResult(false, json));

            public Task<bool> IsBlockedAsync(string mediaType, int tmdbId, SeerrCaller caller)
                => Task.FromResult(false);

            public Task<bool> IsTmdbProxyPathBlockedAsync(string tmdbApiPath, SeerrCaller caller)
                => Task.FromResult(false);
        }
    }
}
