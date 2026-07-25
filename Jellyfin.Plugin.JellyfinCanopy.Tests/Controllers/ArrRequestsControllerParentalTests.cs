using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Security.Claims;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Data.Events;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Data;
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
        private static readonly Guid AccessibleJellyfinId =
            Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
        private static readonly Guid RestrictedJellyfinId =
            Guid.Parse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
        private static readonly Guid AccessibleFourKJellyfinId =
            Guid.Parse("cccccccc-cccc-cccc-cccc-cccccccccccc");

        private static string MovieDetail(string cert) =>
            $@"{{ ""releases"": {{ ""results"": [ {{ ""iso_3166_1"": ""US"", ""release_dates"": [ {{ ""type"": 3, ""certification"": ""{cert}"" }} ] }} ] }} }}";

        // Builds the controller wired to a real SeerrParentalFilter over a
        // rating-limited (maxScore=13) non-admin user, a fake Seerr client that
        // resolves the caller to the given Seerr permissions, and a recording
        // handler that answers the request list plus the two cert fixtures.
        private static ArrRequestsController BuildController(
            string requestListJson,
            SeerrPermission callerPermissions,
            out RecordingHttpMessageHandler handler,
            SeerrUserResolution? userResolution = null,
            ISeerrParentalFilter? parentalFilterOverride = null,
            bool isAdmin = false,
            IItemLookupService? itemLookup = null,
            bool resolveJellyfinUser = true)
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
                DownloadsPageEnabled = true,
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
            var userManager = new StubUserManager(
                user,
                new UserPolicy { BlockUnratedItems = Array.Empty<UnratedItem>() },
                resolveJellyfinUser);
            var seerrCache = new SeerrCache(provider);

            var parentalFilter = new SeerrParentalFilter(
                factory,
                NullLogger<SeerrParentalFilter>.Instance,
                userManager,
                new FakeLocalization(),
                seerrCache,
                provider);

            var seerrClient = new FakeSeerrClient(userResolution ?? SeerrUserResolution.Found(new SeerrUser
            {
                Id = CallerSeerrId,
                Permissions = callerPermissions,
                SourceUrl = "http://seerr:5055",
            }));

            var controller = new ArrRequestsController(
                factory,
                NullLogger<ArrRequestsController>.Instance,
                userManager,
                seerrCache,
                provider,
                seerrClient,
                new ArrFetchService(factory, NullLogger<ArrFetchService>.Instance),
                itemLookup ?? new StubItemLookupService(),
                parentalFilterOverride ?? parentalFilter);

            var claims = new List<Claim> { new("Jellyfin-UserId", CallerGuid) };
            if (isAdmin)
            {
                claims.Add(new Claim(ClaimTypes.Role, "Administrator"));
            }

            var identity = new ClaimsIdentity(claims, "TestAuth");
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

        private static JsonObject ResponseBody(IActionResult result)
        {
            var value = Assert.IsAssignableFrom<ObjectResult>(result).Value;
            return JsonNode.Parse(JsonSerializer.Serialize(value))!.AsObject();
        }

        private static void AssertCalendarSnapshotEnvelope(JsonObject body, int keyCount)
        {
            Assert.Equal(
                new[] { "complete", "requestKeyCount", "requests" },
                body.Select(property => property.Key).OrderBy(key => key, StringComparer.Ordinal));
            Assert.True((bool?)body["complete"]);
            Assert.Equal(keyCount, (int?)body["requestKeyCount"]);
            Assert.Equal(keyCount, Assert.IsType<JsonArray>(body["requests"]).Count);
        }

        [Fact]
        public async Task GetRequests_RatingLimitedUser_DoesNotReceiveAboveLimitRequest()
        {
            // Caller can view all requests (REQUEST_VIEW) so the self-scope backstop
            // is inert — this isolates the parental filter. Row for R-rated tmdb 200
            // must be dropped; PG-13 tmdb 100 must survive.
            const string list = @"{ ""results"": [
                { ""id"": 1, ""type"": ""movie"", ""is4k"": false, ""requestedBy"": { ""id"": 7 }, ""media"": { ""tmdbId"": 100, ""mediaType"": ""movie"" } },
                { ""id"": 2, ""type"": ""movie"", ""is4k"": false, ""requestedBy"": { ""id"": 7 }, ""media"": { ""tmdbId"": 200, ""mediaType"": ""movie"" } } ],
                ""pageInfo"": { ""results"": 2 } }";

            var controller = BuildController(list, SeerrPermission.REQUEST_VIEW, out _);

            var tmdbIds = RequestTmdbIds(await controller.GetRequests());

            Assert.Contains(100, tmdbIds);
            Assert.DoesNotContain(200, tmdbIds);
        }

        [Fact]
        public async Task GetRequests_AppliesCallerLibraryScopeBeforeTotalsAndPaging()
        {
            var list = $$"""
                {
                  "results": [
                    {
                      "id": 1,
                      "type": "movie",
                      "is4k": false,
                      "requestedBy": { "id": 7 },
                      "media": {
                        "tmdbId": 100,
                        "mediaType": "movie",
                        "jellyfinMediaId": "{{AccessibleJellyfinId}}"
                      }
                    },
                    {
                      "id": 2,
                      "type": "movie",
                      "is4k": false,
                      "requestedBy": { "id": 7 },
                      "media": {
                        "tmdbId": 200,
                        "mediaType": "movie",
                        "jellyfinMediaId": "{{RestrictedJellyfinId}}"
                      }
                    },
                    {
                      "id": 3,
                      "type": "movie",
                      "is4k": false,
                      "requestedBy": { "id": 7 },
                      "media": {
                        "tmdbId": 100,
                        "mediaType": "movie"
                      }
                    }
                  ],
                  "pageInfo": { "results": 3 }
                }
                """;
            var lookup = new StubItemLookupService(
                (itemIds, _) => itemIds
                    .Where(id => id == AccessibleJellyfinId)
                    .ToHashSet());
            var controller = BuildController(
                list,
                SeerrPermission.REQUEST_VIEW,
                out _,
                parentalFilterOverride: new PassthroughParentalFilter(),
                itemLookup: lookup);

            var body = ResponseBody(await controller.GetRequests(take: 1));

            Assert.Equal(2, (int?)body["totalResults"]);
            Assert.Equal(2, (int?)body["totalPages"]);
            var firstPage = Assert.IsType<JsonArray>(body["requests"]);
            var firstItem = Assert.Single(firstPage);
            Assert.Equal(1, (int?)firstItem!["id"]);
            Assert.Equal(1, lookup.AccessQueryCount);

            body = ResponseBody(await controller.GetRequests(take: 20));
            Assert.Equal(
                new[] { 1, 3 },
                Assert.IsType<JsonArray>(body["requests"])
                    .Select(row => (int)row!["id"]!)
                    .ToArray());
        }

        [Fact]
        public async Task GetRequests_AppliesEditionSpecificLibraryScopeBeforePagingAndProjection()
        {
            var list = $$"""
                {
                  "results": [
                    {
                      "id": 1,
                      "type": "movie",
                      "is4k": true,
                      "requestedBy": { "id": 7 },
                      "media": {
                        "tmdbId": 100,
                        "mediaType": "movie",
                        "jellyfinMediaId4k": "{{AccessibleFourKJellyfinId}}"
                      }
                    },
                    {
                      "id": 2,
                      "type": "movie",
                      "is4k": true,
                      "requestedBy": { "id": 7 },
                      "media": {
                        "tmdbId": 100,
                        "mediaType": "movie",
                        "jellyfinMediaId4k": "{{RestrictedJellyfinId}}"
                      }
                    },
                    {
                      "id": 3,
                      "type": "movie",
                      "is4k": false,
                      "requestedBy": { "id": 7 },
                      "media": {
                        "tmdbId": 100,
                        "mediaType": "movie",
                        "jellyfinMediaId": "{{AccessibleJellyfinId}}",
                        "jellyfinMediaId4k": "{{RestrictedJellyfinId}}"
                      }
                    },
                    {
                      "id": 4,
                      "type": "movie",
                      "is4k": true,
                      "requestedBy": { "id": 7 },
                      "media": {
                        "tmdbId": 100,
                        "mediaType": "movie",
                        "jellyfinMediaId": "{{RestrictedJellyfinId}}",
                        "jellyfinMediaId4k": "{{AccessibleFourKJellyfinId}}"
                      }
                    },
                    {
                      "id": 5,
                      "type": "movie",
                      "is4k": false,
                      "requestedBy": { "id": 7 },
                      "media": {
                        "tmdbId": 100,
                        "mediaType": "movie",
                        "jellyfinMediaId": "{{RestrictedJellyfinId}}",
                        "jellyfinMediaId4k": "{{AccessibleFourKJellyfinId}}"
                      }
                    },
                    {
                      "id": 6,
                      "type": "movie",
                      "is4k": true,
                      "requestedBy": { "id": 7 },
                      "media": {
                        "tmdbId": 100,
                        "mediaType": "movie",
                        "jellyfinMediaId": "{{AccessibleJellyfinId}}",
                        "jellyfinMediaId4k": "{{RestrictedJellyfinId}}"
                      }
                    },
                    {
                      "id": 7,
                      "type": "movie",
                      "is4k": false,
                      "requestedBy": { "id": 7 },
                      "media": {
                        "tmdbId": 100,
                        "mediaType": "movie",
                        "jellyfinMediaId": null,
                        "jellyfinMediaId4k": "{{RestrictedJellyfinId}}"
                      }
                    },
                    {
                      "id": 8,
                      "type": "movie",
                      "is4k": true,
                      "requestedBy": { "id": 7 },
                      "media": {
                        "tmdbId": 100,
                        "mediaType": "movie",
                        "jellyfinMediaId": "{{AccessibleJellyfinId}}",
                        "jellyfinMediaId4k": "{{AccessibleJellyfinId}}"
                      }
                    }
                  ],
                  "pageInfo": { "results": 8 }
                }
                """;
            var queriedIds = new List<IReadOnlyCollection<Guid>>();
            var lookup = new StubItemLookupService((itemIds, _) =>
            {
                queriedIds.Add(itemIds.ToArray());
                return itemIds
                    .Where(id => id is var value
                        && (value == AccessibleJellyfinId
                            || value == AccessibleFourKJellyfinId))
                    .ToHashSet();
            });
            var controller = BuildController(
                list,
                SeerrPermission.REQUEST_VIEW,
                out _,
                parentalFilterOverride: new PassthroughParentalFilter(),
                itemLookup: lookup);

            var paged = ResponseBody(await controller.GetRequests(take: 2));
            Assert.Equal(5, (int?)paged["totalResults"]);
            Assert.Equal(3, (int?)paged["totalPages"]);
            Assert.Equal(
                new[] { 1, 3 },
                Assert.IsType<JsonArray>(paged["requests"])
                    .Select(row => (int)row!["id"]!)
                    .ToArray());

            var complete = ResponseBody(await controller.GetRequests(take: 20));
            var requests = Assert.IsType<JsonArray>(complete["requests"]);
            Assert.Equal(
                new[] { 1, 3, 4, 7, 8 },
                requests.Select(row => (int)row!["id"]!).ToArray());
            Assert.Equal(
                AccessibleFourKJellyfinId.ToString(),
                (string?)requests.Single(row => (int)row!["id"]! == 1)!["jellyfinMediaId"]);
            Assert.Equal(
                AccessibleJellyfinId.ToString(),
                (string?)requests.Single(row => (int)row!["id"]! == 3)!["jellyfinMediaId"]);
            Assert.Equal(
                AccessibleFourKJellyfinId.ToString(),
                (string?)requests.Single(row => (int)row!["id"]! == 4)!["jellyfinMediaId"]);
            Assert.Null(requests.Single(row => (int)row!["id"]! == 7)!["jellyfinMediaId"]);
            Assert.Equal(
                AccessibleJellyfinId.ToString(),
                (string?)requests.Single(row => (int)row!["id"]! == 8)!["jellyfinMediaId"]);
            Assert.Equal(2, lookup.AccessQueryCount);
            Assert.All(queriedIds, ids => Assert.Equal(
                new[]
                {
                    AccessibleJellyfinId,
                    RestrictedJellyfinId,
                    AccessibleFourKJellyfinId,
                }.OrderBy(id => id),
                ids.OrderBy(id => id)));
        }

        [Fact]
        public async Task GetRequests_AdminDoesNotBypassRestrictedFourKEdition()
        {
            var list = $$"""
                {
                  "results": [{
                    "id": 1,
                    "type": "movie",
                    "is4k": true,
                    "requestedBy": { "id": 7 },
                    "media": {
                      "tmdbId": 100,
                      "mediaType": "movie",
                      "jellyfinMediaId": "{{AccessibleJellyfinId}}",
                      "jellyfinMediaId4k": "{{RestrictedJellyfinId}}"
                    }
                  }],
                  "pageInfo": { "results": 1 }
                }
                """;
            var controller = BuildController(
                list,
                SeerrPermission.REQUEST_VIEW,
                out _,
                parentalFilterOverride: new PassthroughParentalFilter(),
                isAdmin: true,
                itemLookup: new StubItemLookupService(
                    (itemIds, _) => itemIds
                        .Where(id => id == AccessibleJellyfinId)
                        .ToHashSet()));

            var body = ResponseBody(await controller.GetRequests());

            Assert.Empty(Assert.IsType<JsonArray>(body["requests"]));
            Assert.Equal(0, (int?)body["totalResults"]);
        }

        [Fact]
        public async Task GetRequests_AllUnlinkedEditionsNeedNoLibraryQuery()
        {
            const string list = """
                {
                  "results": [{
                    "id": 1,
                    "type": "movie",
                    "is4k": true,
                    "requestedBy": { "id": 7 },
                    "media": {
                      "tmdbId": 100,
                      "mediaType": "movie",
                      "jellyfinMediaId": "",
                      "jellyfinMediaId4k": " "
                    }
                  }],
                  "pageInfo": { "results": 1 }
                }
                """;
            var lookup = new StubItemLookupService();
            var controller = BuildController(
                list,
                SeerrPermission.REQUEST_VIEW,
                out _,
                parentalFilterOverride: new PassthroughParentalFilter(),
                itemLookup: lookup);

            var body = ResponseBody(await controller.GetRequests());

            var request = Assert.Single(Assert.IsType<JsonArray>(body["requests"]));
            Assert.Null(request!["jellyfinMediaId"]);
            Assert.Equal(0, lookup.AccessQueryCount);
        }

        [Theory]
        [InlineData("\"true\"", "\"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\"", "\"cccccccc-cccc-cccc-cccc-cccccccccccc\"")]
        [InlineData("null", "\"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\"", "\"cccccccc-cccc-cccc-cccc-cccccccccccc\"")]
        [InlineData("true", "\"not-a-guid\"", "\"cccccccc-cccc-cccc-cccc-cccccccccccc\"")]
        [InlineData("false", "\"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\"", "{}")]
        [InlineData("true", "\"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\"", "\"00000000-0000-0000-0000-000000000000\"")]
        [InlineData("false", "42", "null")]
        public async Task GetRequests_MalformedEditionOrEitherKnownIdPublishesNoPrefix(
            string is4kJson,
            string standardIdJson,
            string fourKIdJson)
        {
            var list = $$"""
                {
                  "results": [
                    {
                      "id": 1,
                      "type": "movie",
                      "is4k": false,
                      "requestedBy": { "id": 7 },
                      "media": { "tmdbId": 100, "mediaType": "movie" }
                    },
                    {
                      "id": 2,
                      "type": "movie",
                      "is4k": {{is4kJson}},
                      "requestedBy": { "id": 7 },
                      "media": {
                        "tmdbId": 100,
                        "mediaType": "movie",
                        "jellyfinMediaId": {{standardIdJson}},
                        "jellyfinMediaId4k": {{fourKIdJson}}
                      }
                    }
                  ],
                  "pageInfo": { "results": 2 }
                }
                """;
            var lookup = new StubItemLookupService();
            var controller = BuildController(
                list,
                SeerrPermission.REQUEST_VIEW,
                out _,
                parentalFilterOverride: new PassthroughParentalFilter(),
                itemLookup: lookup);

            var result = Assert.IsAssignableFrom<ObjectResult>(
                await controller.GetRequests());
            var body = ResponseBody(result);

            Assert.Equal(502, result.StatusCode);
            Assert.Equal("library_scope_incomplete", (string?)body["code"]);
            Assert.Empty(Assert.IsType<JsonArray>(body["requests"]));
            Assert.Equal(0, (int?)body["totalResults"]);
            Assert.Equal(0, lookup.AccessQueryCount);
        }

        [Fact]
        public async Task GetRequests_MissingEditionFlagPublishesNoPrefix()
        {
            const string list = """
                {
                  "results": [{
                    "id": 1,
                    "type": "movie",
                    "requestedBy": { "id": 7 },
                    "media": {
                      "tmdbId": 100,
                      "mediaType": "movie",
                      "jellyfinMediaId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
                    }
                  }],
                  "pageInfo": { "results": 1 }
                }
                """;
            var lookup = new StubItemLookupService();
            var controller = BuildController(
                list,
                SeerrPermission.REQUEST_VIEW,
                out _,
                parentalFilterOverride: new PassthroughParentalFilter(),
                itemLookup: lookup);

            var result = Assert.IsAssignableFrom<ObjectResult>(
                await controller.GetRequests());
            var body = ResponseBody(result);

            Assert.Equal(502, result.StatusCode);
            Assert.Equal("library_scope_incomplete", (string?)body["code"]);
            Assert.Empty(Assert.IsType<JsonArray>(body["requests"]));
            Assert.Equal(0, lookup.AccessQueryCount);
        }

        [Theory]
        [InlineData(false)]
        [InlineData(true)]
        public async Task GetRequests_FourKLibraryLookupFailurePublishesNoPrefix(
            bool returnNull)
        {
            const string list = """
                {
                  "results": [{
                    "id": 1,
                    "type": "movie",
                    "is4k": true,
                    "requestedBy": { "id": 7 },
                    "media": {
                      "tmdbId": 100,
                      "mediaType": "movie",
                      "jellyfinMediaId4k": "cccccccc-cccc-cccc-cccc-cccccccccccc"
                    }
                  }],
                  "pageInfo": { "results": 1 }
                }
                """;
            var lookup = new StubItemLookupService((_, _) =>
                returnNull
                    ? null!
                    : throw new InvalidOperationException("library unavailable"));
            var controller = BuildController(
                list,
                SeerrPermission.REQUEST_VIEW,
                out _,
                parentalFilterOverride: new PassthroughParentalFilter(),
                itemLookup: lookup);

            var result = Assert.IsAssignableFrom<ObjectResult>(
                await controller.GetRequests());
            var body = ResponseBody(result);

            Assert.Equal(502, result.StatusCode);
            Assert.Equal("library_scope_incomplete", (string?)body["code"]);
            Assert.Empty(Assert.IsType<JsonArray>(body["requests"]));
            Assert.Equal(1, lookup.AccessQueryCount);
        }

        [Fact]
        public async Task GetRequests_AdminDoesNotBypassJellyfinLibraryScope()
        {
            var list = $$"""
                {
                  "results": [
                    {
                      "id": 1,
                      "type": "movie",
                      "is4k": false,
                      "requestedBy": { "id": 7 },
                      "media": {
                        "tmdbId": 200,
                        "mediaType": "movie",
                        "jellyfinMediaId": "{{RestrictedJellyfinId}}"
                      }
                    },
                    {
                      "id": 2,
                      "type": "movie",
                      "is4k": false,
                      "requestedBy": { "id": 99 },
                      "media": {
                        "tmdbId": 100,
                        "mediaType": "movie"
                      }
                    }
                  ],
                  "pageInfo": { "results": 2 }
                }
                """;
            var lookup = new StubItemLookupService((_, _) => new HashSet<Guid>());
            var controller = BuildController(
                list,
                SeerrPermission.NONE,
                out _,
                parentalFilterOverride: new PassthroughParentalFilter(),
                isAdmin: true,
                itemLookup: lookup);

            var body = ResponseBody(await controller.GetRequests());

            var item = Assert.Single(Assert.IsType<JsonArray>(body["requests"]));
            Assert.Equal(2, (int?)item!["id"]);
            Assert.Equal(1, (int?)body["totalResults"]);
        }

        [Theory]
        [InlineData("not-a-jellyfin-id", false)]
        [InlineData("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", true)]
        public async Task GetRequests_MalformedIdOrLibraryLookupFailurePublishesNoPrefix(
            string jellyfinId,
            bool throwDuringLookup)
        {
            var list = $$"""
                {
                  "results": [
                    {
                      "id": 1,
                      "type": "movie",
                      "is4k": false,
                      "requestedBy": { "id": 7 },
                      "media": {
                        "tmdbId": 100,
                        "mediaType": "movie",
                        "jellyfinMediaId": "{{jellyfinId}}"
                      }
                    },
                    {
                      "id": 2,
                      "type": "movie",
                      "is4k": false,
                      "requestedBy": { "id": 7 },
                      "media": {
                        "tmdbId": 100,
                        "mediaType": "movie"
                      }
                    }
                  ],
                  "pageInfo": { "results": 2 }
                }
                """;
            var lookup = new StubItemLookupService((itemIds, _) =>
                throwDuringLookup
                    ? throw new InvalidOperationException("library unavailable")
                    : itemIds.ToHashSet());
            var controller = BuildController(
                list,
                SeerrPermission.REQUEST_VIEW,
                out _,
                parentalFilterOverride: new PassthroughParentalFilter(),
                itemLookup: lookup);

            var result = Assert.IsAssignableFrom<ObjectResult>(
                await controller.GetRequests());
            Assert.Equal(502, result.StatusCode);
            var body = ResponseBody(result);
            Assert.Equal("library_scope_incomplete", (string?)body["code"]);
            Assert.Empty(Assert.IsType<JsonArray>(body["requests"]));
            Assert.Equal(0, (int?)body["totalResults"]);
        }

        [Fact]
        public async Task GetRequests_UnresolvableJellyfinCallerPublishesNoIdLessRows()
        {
            const string list = """
                {
                  "results": [
                    {
                      "id": 1,
                      "type": "movie",
                      "is4k": false,
                      "requestedBy": { "id": 7 },
                      "media": {
                        "tmdbId": 100,
                        "mediaType": "movie"
                      }
                    }
                  ],
                  "pageInfo": { "results": 1 }
                }
                """;
            var controller = BuildController(
                list,
                SeerrPermission.REQUEST_VIEW,
                out _,
                parentalFilterOverride: new PassthroughParentalFilter(),
                resolveJellyfinUser: false);

            var result = Assert.IsAssignableFrom<ObjectResult>(
                await controller.GetRequests());
            Assert.Equal(502, result.StatusCode);
            var body = ResponseBody(result);
            Assert.Equal("library_scope_incomplete", (string?)body["code"]);
            Assert.Empty(Assert.IsType<JsonArray>(body["requests"]));
        }

        [Fact]
        public async Task GetCompleteUserRequestSnapshot_FiltersOnlyAfterCompleteCollection()
        {
            const string list = @"{ ""results"": [
                { ""id"": 1, ""type"": ""movie"", ""is4k"": false, ""requestedBy"": { ""id"": 7 }, ""media"": { ""tmdbId"": 100, ""mediaType"": ""movie"" } },
                { ""id"": 2, ""type"": ""movie"", ""is4k"": false, ""requestedBy"": { ""id"": 7 }, ""media"": { ""tmdbId"": 200, ""mediaType"": ""movie"" } } ],
                ""pageInfo"": { ""page"": 1, ""pages"": 1, ""pageSize"": 2, ""results"": 2 } }";

            var controller = BuildController(list, SeerrPermission.NONE, out var handler);

            var ok = Assert.IsType<OkObjectResult>(await controller.GetCompleteUserRequestSnapshot());
            var body = JsonNode.Parse(JsonSerializer.Serialize(ok.Value))!.AsObject();

            AssertCalendarSnapshotEnvelope(body, 1);
            var keys = Assert.IsType<JsonArray>(body["requests"]);
            Assert.Equal(100, (int?)keys.Single()!["tmdbId"]);
            var upstream = handler.Requests
                .Where(request => request.RequestUri?.AbsolutePath == "/api/v1/request")
                .ToList();
            Assert.Equal(2, upstream.Count);
            Assert.All(upstream, request =>
            {
                Assert.Contains($"requestedBy={CallerSeerrId}", request.RequestUri!.Query);
                Assert.Equal(
                    CallerSeerrId.ToString(),
                    Assert.Single(request.Headers.GetValues("X-Api-User")));
            });
        }

        [Fact]
        public async Task GetCompleteUserRequestSnapshot_DropsForeignRowsFromCalendarProjection()
        {
            const string list = @"{ ""results"": [
                { ""id"": 1, ""type"": ""movie"", ""is4k"": false, ""requestedBy"": { ""id"": 7 }, ""media"": { ""tmdbId"": 100, ""mediaType"": ""movie"" } },
                { ""id"": 2, ""type"": ""movie"", ""is4k"": false, ""requestedBy"": { ""id"": 99 }, ""media"": { ""tmdbId"": 100, ""mediaType"": ""movie"" } } ],
                ""pageInfo"": { ""page"": 1, ""pages"": 1, ""pageSize"": 2, ""results"": 2 } }";
            var controller = BuildController(list, SeerrPermission.NONE, out _);

            var ok = Assert.IsType<OkObjectResult>(await controller.GetCompleteUserRequestSnapshot());
            var body = JsonNode.Parse(JsonSerializer.Serialize(ok.Value))!.AsObject();

            AssertCalendarSnapshotEnvelope(body, 1);
            Assert.Single(Assert.IsType<JsonArray>(body["requests"]));
        }

        [Fact]
        public async Task GetCompleteUserRequestSnapshot_RequestViewerRetainsAuthorizedForeignRows()
        {
            const string list = @"{ ""results"": [
                { ""id"": 1, ""type"": ""movie"", ""is4k"": false, ""requestedBy"": { ""id"": 7 }, ""media"": { ""tmdbId"": 100, ""mediaType"": ""movie"" } },
                { ""id"": 2, ""type"": ""movie"", ""is4k"": false, ""requestedBy"": { ""id"": 99 }, ""media"": { ""tmdbId"": 100, ""mediaType"": ""movie"" } } ],
                ""pageInfo"": { ""page"": 1, ""pages"": 1, ""pageSize"": 2, ""results"": 2 } }";
            var controller = BuildController(list, SeerrPermission.REQUEST_VIEW, out var handler);

            var ok = Assert.IsType<OkObjectResult>(await controller.GetCompleteUserRequestSnapshot());
            var body = JsonNode.Parse(JsonSerializer.Serialize(ok.Value))!.AsObject();

            AssertCalendarSnapshotEnvelope(body, 1);
            // Compact calendar keys remain deduplicated even when two users
            // requested the same title.
            Assert.Single(Assert.IsType<JsonArray>(body["requests"]));
            var upstream = handler.Requests
                .Where(request => request.RequestUri?.AbsolutePath == "/api/v1/request")
                .ToList();
            Assert.Equal(2, upstream.Count);
            Assert.All(upstream, request =>
            {
                Assert.DoesNotContain("requestedBy=", request.RequestUri!.Query);
                Assert.Equal(
                    CallerSeerrId.ToString(),
                    Assert.Single(request.Headers.GetValues("X-Api-User")));
            });
        }

        [Fact]
        public async Task GetCompleteUserRequestSnapshot_JellyfinAdminGlobalRead_OmitsApiUserAndOwnerScope()
        {
            const string list = @"{ ""results"": [
                { ""id"": 1, ""type"": ""movie"", ""is4k"": false, ""requestedBy"": { ""id"": 7 }, ""media"": { ""tmdbId"": 100, ""mediaType"": ""movie"" } },
                { ""id"": 2, ""type"": ""movie"", ""is4k"": false, ""requestedBy"": { ""id"": 99 }, ""media"": { ""tmdbId"": 200, ""mediaType"": ""movie"" } } ],
                ""pageInfo"": { ""page"": 1, ""pages"": 1, ""pageSize"": 2, ""results"": 2 } }";
            var controller = BuildController(
                list,
                SeerrPermission.NONE,
                out var handler,
                isAdmin: true);

            var ok = Assert.IsType<OkObjectResult>(await controller.GetCompleteUserRequestSnapshot());
            var body = JsonNode.Parse(JsonSerializer.Serialize(ok.Value))!.AsObject();

            AssertCalendarSnapshotEnvelope(body, 2);
            var upstream = handler.Requests
                .Where(request => request.RequestUri?.AbsolutePath == "/api/v1/request")
                .ToList();
            Assert.Equal(2, upstream.Count);
            Assert.All(upstream, request =>
            {
                Assert.DoesNotContain("requestedBy=", request.RequestUri!.Query);
                Assert.False(request.Headers.Contains("X-Api-User"));
            });
        }

        [Fact]
        public async Task GetCompleteUserRequestSnapshot_UserOnlyOverridesRequestViewPermission()
        {
            const string list = @"{ ""results"": [
                { ""id"": 1, ""type"": ""movie"", ""is4k"": false, ""requestedBy"": { ""id"": 7 }, ""media"": { ""tmdbId"": 100, ""mediaType"": ""movie"" } },
                { ""id"": 2, ""type"": ""movie"", ""is4k"": false, ""requestedBy"": { ""id"": 99 }, ""media"": { ""tmdbId"": 100, ""mediaType"": ""movie"" } } ],
                ""pageInfo"": { ""page"": 1, ""pages"": 1, ""pageSize"": 2, ""results"": 2 } }";
            var controller = BuildController(list, SeerrPermission.REQUEST_VIEW, out var handler);

            var ok = Assert.IsType<OkObjectResult>(
                await controller.GetCompleteUserRequestSnapshot(userOnly: true));
            var body = JsonNode.Parse(JsonSerializer.Serialize(ok.Value))!.AsObject();

            AssertCalendarSnapshotEnvelope(body, 1);
            var upstream = handler.Requests
                .Where(request => request.RequestUri?.AbsolutePath == "/api/v1/request")
                .ToList();
            Assert.Equal(2, upstream.Count);
            Assert.All(upstream, request =>
            {
                Assert.Contains($"requestedBy={CallerSeerrId}", request.RequestUri!.Query);
                Assert.Equal(
                    CallerSeerrId.ToString(),
                    Assert.Single(request.Headers.GetValues("X-Api-User")));
            });
        }

        [Fact]
        public async Task GetCompleteUserRequestSnapshot_ProjectsOnlyCalendarKeysFromSensitiveRawRows()
        {
            const string list = """
                {
                  "results": [
                    {
                      "id": 1,
                      "type": "movie",
                      "is4k": false,
                      "requestedBy": {
                        "id": 7,
                        "email": "requester-private@example.test",
                        "username": "private-requester"
                      },
                      "media": {
                        "tmdbId": 100,
                        "mediaType": "movie",
                        "downloadStatus": [
                          {
                            "downloadId": "private-download-id",
                            "releaseTitle": "Private.Release.Name",
                            "protocol": "usenet",
                            "outputPath": "/private/download/path",
                            "nested": {
                              "apiKey": "private-nested-api-key"
                            }
                          }
                        ],
                        "downloadStatus4k": [
                          {
                            "downloadId": "private-4k-download-id"
                          }
                        ],
                        "serviceUrl": "http://private-arr:8989"
                      }
                    }
                  ],
                  "pageInfo": {
                    "page": 1,
                    "pages": 1,
                    "pageSize": 1,
                    "results": 1
                  }
                }
                """;
            var controller = BuildController(
                list,
                SeerrPermission.NONE,
                out _,
                parentalFilterOverride: new PassthroughParentalFilter());

            var ok = Assert.IsType<OkObjectResult>(
                await controller.GetCompleteUserRequestSnapshot());
            var body = JsonNode.Parse(JsonSerializer.Serialize(ok.Value))!.AsObject();

            AssertCalendarSnapshotEnvelope(body, 1);
            var key = Assert.IsType<JsonObject>(
                Assert.Single(Assert.IsType<JsonArray>(body["requests"])));
            Assert.Equal(
                new[] { "tmdbId", "type" },
                key.Select(property => property.Key).OrderBy(name => name, StringComparer.Ordinal));
            Assert.Equal(100, (int?)key["tmdbId"]);
            Assert.Equal("movie", (string?)key["type"]);

            var serialized = body.ToJsonString();
            Assert.DoesNotContain("downloadStatus", serialized, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("private-", serialized, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("requester-private", serialized, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("serviceUrl", serialized, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public async Task GetCompleteUserRequestSnapshot_MalformedVisibleRowReturnsNoProjectedPrefix()
        {
            const string list = """
                {
                  "results": [
                    {
                      "id": 1,
                      "type": "movie",
                      "is4k": false,
                      "requestedBy": { "id": 7 },
                      "media": {
                        "tmdbId": 100,
                        "mediaType": "movie",
                        "downloadStatus": [
                          { "releaseTitle": "Sensitive.Prefix.Release" }
                        ]
                      }
                    },
                    {
                      "id": 2,
                      "type": "tv",
                      "is4k": false,
                      "requestedBy": { "id": 7 },
                      "media": {
                        "tmdbId": 200,
                        "mediaType": "movie"
                      }
                    }
                  ],
                  "pageInfo": {
                    "page": 1,
                    "pages": 1,
                    "pageSize": 2,
                    "results": 2
                  }
                }
                """;
            var controller = BuildController(
                list,
                SeerrPermission.NONE,
                out _,
                parentalFilterOverride: new PassthroughParentalFilter());

            var result = Assert.IsType<ObjectResult>(
                await controller.GetCompleteUserRequestSnapshot());
            var body = JsonNode.Parse(JsonSerializer.Serialize(result.Value))!.AsObject();

            Assert.Equal(502, result.StatusCode);
            Assert.Equal("upstream_collection_invalid", (string?)body["code"]);
            Assert.Empty(Assert.IsType<JsonArray>(body["requests"]));
            Assert.DoesNotContain(
                "Sensitive.Prefix.Release",
                body.ToJsonString(),
                StringComparison.Ordinal);
        }

        [Fact]
        public async Task GetCompleteUserRequestSnapshot_MalformedParentalOutputReturns502()
        {
            const string list = @"{ ""results"": [
                { ""id"": 1, ""type"": ""movie"", ""is4k"": false, ""requestedBy"": { ""id"": 7 }, ""media"": { ""tmdbId"": 100, ""mediaType"": ""movie"" } } ],
                ""pageInfo"": { ""page"": 1, ""pages"": 1, ""pageSize"": 1, ""results"": 1 } }";
            var controller = BuildController(
                list,
                SeerrPermission.NONE,
                out _,
                parentalFilterOverride: new MalformedParentalFilter());

            var result = Assert.IsType<ObjectResult>(
                await controller.GetCompleteUserRequestSnapshot());
            var body = JsonNode.Parse(JsonSerializer.Serialize(result.Value))!.AsObject();

            Assert.Equal(502, result.StatusCode);
            Assert.Equal("upstream_collection_invalid", (string?)body["code"]);
            Assert.Empty(Assert.IsType<JsonArray>(body["requests"]));
        }

        [Fact]
        public async Task GetCompleteUserRequestSnapshot_IncompleteUserLookup_Returns502WithoutUpstreamRequest()
        {
            var controller = BuildController(
                "{}",
                SeerrPermission.NONE,
                out var handler,
                SeerrUserResolution.Incomplete("page two failed"));

            var result = Assert.IsType<ObjectResult>(await controller.GetCompleteUserRequestSnapshot());
            var body = JsonNode.Parse(JsonSerializer.Serialize(result.Value))!.AsObject();

            Assert.Equal(502, result.StatusCode);
            Assert.Equal("user_lookup_incomplete", (string?)body["code"]);
            Assert.Empty(handler.Requests);
        }

        [Theory]
        [InlineData(null)]
        [InlineData("http://retired-seerr:5055")]
        public async Task GetCompleteUserRequestSnapshot_MissingOrStaleSource_Returns502WithoutUpstreamRequest(
            string? sourceUrl)
        {
            var controller = BuildController(
                "{}",
                SeerrPermission.NONE,
                out var handler,
                SeerrUserResolution.Found(new SeerrUser
                {
                    Id = CallerSeerrId,
                    Permissions = SeerrPermission.NONE,
                    SourceUrl = sourceUrl,
                }));

            var result = Assert.IsType<ObjectResult>(
                await controller.GetCompleteUserRequestSnapshot());
            var body = JsonNode.Parse(JsonSerializer.Serialize(result.Value))!.AsObject();

            Assert.Equal(502, result.StatusCode);
            Assert.Equal("source_affinity_unavailable", (string?)body["code"]);
            Assert.Empty(handler.Requests);
        }

        [Fact]
        public async Task GetCompleteUserRequestSnapshot_InvalidOwnedRow_Returns502WithoutPrefix()
        {
            const string list = @"{ ""results"": [
                { ""id"": 1, ""type"": ""movie"", ""is4k"": false, ""media"": { ""tmdbId"": 100, ""mediaType"": ""movie"" } } ],
                ""pageInfo"": { ""page"": 1, ""pages"": 1, ""pageSize"": 1, ""results"": 1 } }";
            var controller = BuildController(list, SeerrPermission.NONE, out _);

            var result = Assert.IsType<ObjectResult>(await controller.GetCompleteUserRequestSnapshot());
            var body = JsonNode.Parse(JsonSerializer.Serialize(result.Value))!.AsObject();

            Assert.Equal(502, result.StatusCode);
            Assert.Equal("upstream_collection_invalid", (string?)body["code"]);
            Assert.Empty(Assert.IsType<JsonArray>(body["requests"]));
        }

        [Fact]
        public async Task GetCompleteUserRequestSnapshot_MissingRequestId_ReturnsIncompleteWithoutPrefix()
        {
            const string list = @"{ ""results"": [
                { ""type"": ""movie"", ""is4k"": false, ""requestedBy"": { ""id"": 7 }, ""media"": { ""tmdbId"": 100, ""mediaType"": ""movie"" } } ],
                ""pageInfo"": { ""page"": 1, ""pages"": 1, ""pageSize"": 1, ""results"": 1 } }";
            var controller = BuildController(list, SeerrPermission.NONE, out _);

            var result = Assert.IsType<ObjectResult>(await controller.GetCompleteUserRequestSnapshot());
            var body = JsonNode.Parse(JsonSerializer.Serialize(result.Value))!.AsObject();

            Assert.Equal(502, result.StatusCode);
            Assert.Equal("upstream_collection_incomplete", (string?)body["code"]);
            Assert.Empty(Assert.IsType<JsonArray>(body["requests"]));
        }

        [Fact]
        public async Task GetCompleteUserRequestSnapshot_ParentalFilterThrows_Returns502WithoutRows()
        {
            const string list = @"{ ""results"": [
                { ""id"": 1, ""type"": ""movie"", ""is4k"": false, ""requestedBy"": { ""id"": 7 }, ""media"": { ""tmdbId"": 100, ""mediaType"": ""movie"" } } ],
                ""pageInfo"": { ""page"": 1, ""pages"": 1, ""pageSize"": 1, ""results"": 1 } }";
            var controller = BuildController(
                list,
                SeerrPermission.NONE,
                out _,
                parentalFilterOverride: new ThrowingParentalFilter());

            var result = Assert.IsType<ObjectResult>(await controller.GetCompleteUserRequestSnapshot());
            var body = JsonNode.Parse(JsonSerializer.Serialize(result.Value))!.AsObject();

            Assert.Equal(502, result.StatusCode);
            Assert.Equal("parental_filter_incomplete", (string?)body["code"]);
            Assert.Empty(Assert.IsType<JsonArray>(body["requests"]));
        }

        [Fact]
        public async Task GetRequests_SelfScopedUser_DropsRowOwnedByAnotherUser()
        {
            // No request-view permission => self-scoped. The row is at an ALLOWED
            // rating (PG-13) but is owned by a different Seerr user (99), simulating a
            // dropped/ignored requestedBy scoping. The backstop must drop it.
            const string list = @"{ ""results"": [
                { ""id"": 1, ""type"": ""movie"", ""is4k"": false, ""requestedBy"": { ""id"": 99 }, ""media"": { ""tmdbId"": 100, ""mediaType"": ""movie"" } } ],
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
                { ""id"": 1, ""type"": ""movie"", ""is4k"": false, ""requestedBy"": { ""id"": 7 }, ""media"": { ""tmdbId"": 100, ""mediaType"": ""movie"" } },
                { ""id"": 2, ""type"": ""movie"", ""is4k"": false, ""requestedBy"": { ""id"": 7 }, ""media"": { ""tmdbId"": 200, ""mediaType"": ""movie"" } } ],
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
                DownloadsPageEnabled = true,
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
            var seerrClient = new FakeSeerrClient(new SeerrUser
            {
                Id = CallerSeerrId,
                Permissions = SeerrPermission.REQUEST_VIEW,
                SourceUrl = "http://seerr:5055",
            });

            var controller = new ArrRequestsController(
                factory, NullLogger<ArrRequestsController>.Instance, userManager, seerrCache, provider,
                seerrClient, new ArrFetchService(factory, NullLogger<ArrFetchService>.Instance),
                new StubItemLookupService(), parentalFilter);
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
            private readonly SeerrUserResolution _resolution;

            public FakeSeerrClient(SeerrUser user) : this(SeerrUserResolution.Found(user)) { }

            public FakeSeerrClient(SeerrUserResolution resolution) => _resolution = resolution;

            public Task<SeerrUser?> GetSeerrUser(string jellyfinUserId, bool bypassCache = false, bool allowAutoImport = true)
                => Task.FromResult(_resolution.User);

            public Task<SeerrUserResolution> ResolveSeerrUser(
                string jellyfinUserId,
                bool bypassCache = false,
                bool allowAutoImport = true,
                CancellationToken cancellationToken = default)
                => Task.FromResult(_resolution);

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

        private sealed class ThrowingParentalFilter : ISeerrParentalFilter
        {
            public Task<SeerrParentalResult> ApplyAsync(string json, string apiPath, SeerrCaller caller)
                => throw new InvalidOperationException("simulated filter failure");

            public Task<bool> IsBlockedAsync(string mediaType, int tmdbId, SeerrCaller caller)
                => Task.FromResult(false);

            public Task<bool> IsTmdbProxyPathBlockedAsync(string tmdbApiPath, SeerrCaller caller)
                => Task.FromResult(false);
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

        private sealed class MalformedParentalFilter : ISeerrParentalFilter
        {
            public Task<SeerrParentalResult> ApplyAsync(string json, string apiPath, SeerrCaller caller)
                => Task.FromResult(new SeerrParentalResult(false, """{"results":["""));

            public Task<bool> IsBlockedAsync(string mediaType, int tmdbId, SeerrCaller caller)
                => Task.FromResult(false);

            public Task<bool> IsTmdbProxyPathBlockedAsync(string tmdbApiPath, SeerrCaller caller)
                => Task.FromResult(false);
        }

        private sealed class StubUserManager : IUserManager
        {
            private readonly User _user;
            private readonly UserPolicy _policy;
            private readonly bool _resolveUser;

            public StubUserManager(
                User user,
                UserPolicy policy,
                bool resolveUser = true)
            {
                _user = user;
                _policy = policy;
                _resolveUser = resolveUser;
            }

            public event EventHandler<GenericEventArgs<User>> OnUserUpdated { add { } remove { } }

            public User? GetUserById(Guid id) => _resolveUser ? _user : null;

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
