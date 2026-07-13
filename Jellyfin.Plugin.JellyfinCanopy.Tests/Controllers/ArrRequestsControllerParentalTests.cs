using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Security.Claims;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Data.Events;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Model.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Services.Arr;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using MediaBrowser.Model.Users;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers
{
    /// <summary>
    /// Pins SEERR-1: the Requests page (and the Calendar rows served from the same
    /// <c>/arr/requests</c> data) must run through the parental filter, using the
    /// auth-claim user. A rating-limited caller must not receive an above-limit
    /// request (title/poster/requester); an admin/unlimited caller sees everything.
    /// Also pins the defense-in-depth backstop: a self-scoped caller never receives
    /// a row owned by another user even if the upstream <c>requestedBy</c> scoping
    /// were dropped.
    /// </summary>
    public class ArrRequestsControllerParentalTests
    {
        private const string CallerGuid = "11111111-1111-1111-1111-111111111111";
        private const int CallerSeerrId = 7;

        private static string MovieDetail(string cert) =>
            $@"{{ ""releases"": {{ ""results"": [ {{ ""iso_3166_1"": ""US"", ""release_dates"": [ {{ ""type"": 3, ""certification"": ""{cert}"" }} ] }} ] }} }}";

        // Builds the controller wired to a real SeerrParentalFilter over a
        // rating-limited (maxScore=13) non-admin user, a fake Seerr client that
        // resolves the caller to the given Seerr permissions, and a recording
        // handler that answers the request list plus the two cert fixtures.
        private static ArrRequestsController BuildController(
            string requestListJson,
            SeerrPermission callerPermissions,
            out RecordingHttpMessageHandler handler)
        {
            handler = new RecordingHttpMessageHandler();
            handler.AddResponse("/api/v1/request", requestListJson);
            handler.AddResponse("/movie/100", MovieDetail("PG-13"));
            handler.AddResponse("/movie/200", MovieDetail("R"));

            var factory = new RecordingHttpClientFactory(handler);

            var provider = new FakePluginConfigProvider(new PluginConfiguration
            {
                SeerrEnabled = true,
                SeerrRespectParentalRatings = true,
                SeerrUrls = "http://seerr:5055",
                SeerrApiKey = "key",
                DEFAULT_REGION = "US",
                TMDB_API_KEY = string.Empty, // force the filter's cert lookup through Seerr (same handler)
            });

            var user = new User("kid", "Prov", "PwProv")
            {
                MaxParentalRatingScore = 13,
                MaxParentalRatingSubScore = 0,
            };
            var userManager = new StubUserManager(user, new UserPolicy { BlockUnratedItems = Array.Empty<UnratedItem>() });
            var seerrCache = new SeerrCache(provider);

            var parentalFilter = new SeerrParentalFilter(
                factory,
                NullLogger<SeerrParentalFilter>.Instance,
                userManager,
                new FakeLocalization(),
                seerrCache,
                provider);

            var seerrClient = new FakeSeerrClient(new SeerrUser
            {
                Id = CallerSeerrId,
                Permissions = callerPermissions,
            });

            var controller = new ArrRequestsController(
                factory,
                NullLogger<ArrRequestsController>.Instance,
                userManager,
                seerrCache,
                provider,
                seerrClient,
                new ArrFetchService(factory, NullLogger<ArrFetchService>.Instance),
                parentalFilter);

            var identity = new ClaimsIdentity(new[] { new Claim("Jellyfin-UserId", CallerGuid) }, "TestAuth");
            controller.ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(identity) },
            };

            return controller;
        }

        private static List<int?> RequestTmdbIds(IActionResult result)
        {
            var ok = Assert.IsType<OkObjectResult>(result);
            var json = JsonNode.Parse(JsonSerializer.Serialize(ok.Value))!.AsObject();
            return ((JsonArray)json["requests"]!)
                .Select(n => (int?)n!["tmdbId"])
                .ToList();
        }

        [Fact]
        public async Task GetRequests_RatingLimitedUser_DoesNotReceiveAboveLimitRequest()
        {
            // Caller can view all requests (REQUEST_VIEW) so the self-scope backstop
            // is inert — this isolates the parental filter. Row for R-rated tmdb 200
            // must be dropped; PG-13 tmdb 100 must survive.
            const string list = @"{ ""results"": [
                { ""id"": 1, ""type"": ""movie"", ""requestedBy"": { ""id"": 7 }, ""media"": { ""tmdbId"": 100, ""mediaType"": ""movie"" } },
                { ""id"": 2, ""type"": ""movie"", ""requestedBy"": { ""id"": 7 }, ""media"": { ""tmdbId"": 200, ""mediaType"": ""movie"" } } ],
                ""pageInfo"": { ""results"": 2 } }";

            var controller = BuildController(list, SeerrPermission.REQUEST_VIEW, out _);

            var tmdbIds = RequestTmdbIds(await controller.GetRequests());

            Assert.Contains(100, tmdbIds);
            Assert.DoesNotContain(200, tmdbIds);
        }

        [Fact]
        public async Task GetRequests_SelfScopedUser_DropsRowOwnedByAnotherUser()
        {
            // No request-view permission => self-scoped. The row is at an ALLOWED
            // rating (PG-13) but is owned by a different Seerr user (99), simulating a
            // dropped/ignored requestedBy scoping. The backstop must drop it.
            const string list = @"{ ""results"": [
                { ""id"": 1, ""type"": ""movie"", ""requestedBy"": { ""id"": 99 }, ""media"": { ""tmdbId"": 100, ""mediaType"": ""movie"" } } ],
                ""pageInfo"": { ""results"": 1 } }";

            var controller = BuildController(list, SeerrPermission.NONE, out _);

            var tmdbIds = RequestTmdbIds(await controller.GetRequests());

            Assert.Empty(tmdbIds);
        }

        [Fact]
        public async Task GetRequests_UnlimitedUser_ReceivesAboveLimitRequest()
        {
            // A user with no parental limit (and view permission) sees every row,
            // proving the gate is per-caller and not a blanket filter.
            const string list = @"{ ""results"": [
                { ""id"": 1, ""type"": ""movie"", ""requestedBy"": { ""id"": 7 }, ""media"": { ""tmdbId"": 100, ""mediaType"": ""movie"" } },
                { ""id"": 2, ""type"": ""movie"", ""requestedBy"": { ""id"": 7 }, ""media"": { ""tmdbId"": 200, ""mediaType"": ""movie"" } } ],
                ""pageInfo"": { ""results"": 2 } }";

            var handler = new RecordingHttpMessageHandler();
            handler.AddResponse("/api/v1/request", list);
            handler.AddResponse("/movie/100", MovieDetail("PG-13"));
            handler.AddResponse("/movie/200", MovieDetail("R"));
            var factory = new RecordingHttpClientFactory(handler);

            var provider = new FakePluginConfigProvider(new PluginConfiguration
            {
                SeerrEnabled = true,
                SeerrRespectParentalRatings = true,
                SeerrUrls = "http://seerr:5055",
                SeerrApiKey = "key",
                DEFAULT_REGION = "US",
                TMDB_API_KEY = string.Empty,
            });

            // No rating limit set on the user => the gate resolves inactive.
            var user = new User("grownup", "Prov", "PwProv");
            var userManager = new StubUserManager(user, new UserPolicy { BlockUnratedItems = Array.Empty<UnratedItem>() });
            var seerrCache = new SeerrCache(provider);
            var parentalFilter = new SeerrParentalFilter(
                factory, NullLogger<SeerrParentalFilter>.Instance, userManager, new FakeLocalization(), seerrCache, provider);
            var seerrClient = new FakeSeerrClient(new SeerrUser { Id = CallerSeerrId, Permissions = SeerrPermission.REQUEST_VIEW });

            var controller = new ArrRequestsController(
                factory, NullLogger<ArrRequestsController>.Instance, userManager, seerrCache, provider,
                seerrClient, new ArrFetchService(factory, NullLogger<ArrFetchService>.Instance), parentalFilter);
            var identity = new ClaimsIdentity(new[] { new Claim("Jellyfin-UserId", CallerGuid) }, "TestAuth");
            controller.ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(identity) },
            };

            var tmdbIds = RequestTmdbIds(await controller.GetRequests());

            Assert.Contains(100, tmdbIds);
            Assert.Contains(200, tmdbIds);
        }

        // ── Minimal fakes ────────────────────────────────────────────────────

        private sealed class FakeSeerrClient : ISeerrClient
        {
            private readonly SeerrUser _user;

            public FakeSeerrClient(SeerrUser user) => _user = user;

            public Task<SeerrUser?> GetSeerrUser(string jellyfinUserId, bool bypassCache = false, bool allowAutoImport = true)
                => Task.FromResult<SeerrUser?>(_user);

            public Task<string?> GetSeerrUserId(string jellyfinUserId, bool allowAutoImport = true)
                => throw new NotImplementedException();

            public bool IsImportBlocked(string jellyfinUserId, PluginConfiguration config)
                => throw new NotImplementedException();

            public Task<bool> GetStatusActiveAsync() => throw new NotImplementedException();

            public Task<Seerr4kCapability> GetSeerr4kCapabilityAsync(string jellyfinUserId, bool isAdmin = false)
                => throw new NotImplementedException();

            public void EvictMediaDetailCache(int tmdbId, string mediaType) { }

            public Task<IActionResult> ProxyRequestAsync(string apiPath, HttpMethod method, string? content, SeerrCaller caller)
                => throw new NotImplementedException();

            public Task<List<WatchlistItem>?> GetWatchlistForUser(string seerrUserId)
                => throw new NotImplementedException();

            public Task<List<WatchlistItem>?> GetRequestsForUser(string seerrUserId)
                => throw new NotImplementedException();
        }

        private sealed class StubUserManager : IUserManager
        {
            private readonly User _user;
            private readonly UserPolicy _policy;

            public StubUserManager(User user, UserPolicy policy)
            {
                _user = user;
                _policy = policy;
            }

            public event EventHandler<GenericEventArgs<User>> OnUserUpdated { add { } remove { } }

            public User? GetUserById(Guid id) => _user;

            public UserDto GetUserDto(User user, string? remoteEndPoint = null) => new() { Policy = _policy };

            public IEnumerable<User> GetUsers() => throw new NotImplementedException();

            public IEnumerable<Guid> GetUsersIds() => throw new NotImplementedException();

            public Task InitializeAsync() => throw new NotImplementedException();

            public User? GetFirstUser() => throw new NotImplementedException();

            public User? GetUserByName(string name) => throw new NotImplementedException();

            public Task RenameUser(Guid userId, string oldName, string newName) => throw new NotImplementedException();

            public Task UpdateUserAsync(User user) => throw new NotImplementedException();

            public Task<User> CreateUserAsync(string name) => throw new NotImplementedException();

            public Task DeleteUserAsync(Guid userId) => throw new NotImplementedException();

            public Task ResetPassword(Guid userId) => throw new NotImplementedException();

            public Task ChangePassword(Guid userId, string newPassword) => throw new NotImplementedException();

            public Task<User?> AuthenticateUser(string username, string password, string remoteEndPoint, bool isUserSession) => throw new NotImplementedException();

            public Task<ForgotPasswordResult> StartForgotPasswordProcess(string enteredUsername, bool isInNetwork) => throw new NotImplementedException();

            public Task<PinRedeemResult> RedeemPasswordResetPin(string pin) => throw new NotImplementedException();

            public NameIdPair[] GetAuthenticationProviders() => throw new NotImplementedException();

            public NameIdPair[] GetPasswordResetProviders() => throw new NotImplementedException();

            public Task UpdateConfigurationAsync(Guid userId, UserConfiguration config) => throw new NotImplementedException();

            public Task UpdatePolicyAsync(Guid userId, UserPolicy policy) => throw new NotImplementedException();

            public Task ClearProfileImageAsync(User user) => throw new NotImplementedException();
        }
    }
}
