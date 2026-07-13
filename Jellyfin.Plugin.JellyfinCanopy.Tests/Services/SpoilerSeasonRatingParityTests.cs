using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Dto;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services
{
    /// <summary>
    /// BI-SEC-036: guarded Season rating policy must be identical across the
    /// pre-computed tag cache, the tag-data fallback and native BaseItemDto
    /// filtering. S0/S1 and later Seasons with any watched episode exempt only
    /// their non-rating metadata; the guarded Series rating must never reappear.
    /// </summary>
    public sealed class SpoilerSeasonRatingParityTests
    {
        private const string SpoilerFile = "spoilerblur.json";

        private static PluginConfiguration StrictConfig(bool stripRatings = true) => new()
        {
            SpoilerBlurEnabled = true,
            SpoilerStripRatings = stripRatings,
            SpoilerStripOverview = true,
            SpoilerStripTags = true,
            SpoilerReplaceTitle = false,
            SpoilerOverviewPlaceholder = "Protected",
        };

        private static UserSpoilerBlur GuardedState(Guid seriesId, bool? hideRatings = null)
        {
            var state = new UserSpoilerBlur
            {
                Prefs = new SpoilerBlurUserPrefs { HideRatings = hideRatings },
            };
            var seriesIdN = seriesId.ToString("N");
            state.Series[seriesIdN] = new SpoilerBlurSeriesEntry { SeriesId = seriesIdN };
            return state;
        }

        private static SpoilerFieldStripFilter NewFilter(PluginConfiguration cfg)
        {
            var lib = new CountingLibraryManager();
            var users = new StubUserManager();
            var markers = new SpoilerIdentityService(users, NullLogger<SpoilerIdentityService>.Instance);
            var identity = new RequestIdentityService(
                new CountingSessionManager(), users, markers, NullLogger<RequestIdentityService>.Instance);
            // DTO item-counts make these tests independent of live library queries.
            var resolver = new SpoilerUserResolver(
                userConfigManager: null!, lib, NullLogger<SpoilerUserResolver>.Instance, identity);
            return new SpoilerFieldStripFilter(
                resolver, lib, users, new StubUserDataManager(), new FakePluginConfigProvider(cfg));
        }

        private static BaseItemDto SeasonDto(Guid seriesId, int seasonNumber, bool anyWatched)
            => new()
            {
                Id = Guid.NewGuid(),
                Type = BaseItemKind.Season,
                SeriesId = seriesId,
                IndexNumber = seasonNumber,
                Name = $"Season {seasonNumber} original",
                Overview = "Non-rating overview remains visible for an exempt Season.",
                Genres = new[] { "Drama" },
                Tags = new[] { "Non-rating tag" },
                CommunityRating = 9.8f,
                CriticRating = 97f,
                RecursiveItemCount = 10,
                UserData = new UserItemDataDto
                {
                    Key = "season",
                    UnplayedItemCount = anyWatched ? 9 : 10,
                },
            };

        [Theory]
        [InlineData(1, false, true)]
        [InlineData(2, true, true)]
        [InlineData(2, false, false)]
        public void SharedDecision_PinsSeasonExemptionBoundary(
            int seasonNumber,
            bool anyWatched,
            bool expectRatingOnly)
        {
            var decision = TagCacheService.ResolveGuardedSeasonStripDecision(seasonNumber, anyWatched);

            Assert.Equal(
                expectRatingOnly
                    ? TagCacheService.TagStripDecision.SeasonRatingOnly
                    : TagCacheService.TagStripDecision.Strip,
                decision);
        }

        [Fact]
        public void SharedDecision_MissingSeasonNumberFailsClosedEvenWhenAnyEpisodeIsWatched()
        {
            var decision = TagCacheService.ResolveGuardedSeasonStripDecision(
                seasonIndexNumber: null,
                seasonAnyWatched: true);

            Assert.Equal(TagCacheService.TagStripDecision.Strip, decision);
        }

        [Fact]
        public void SharedProjection_MarksSuppressionEvenWhenSourceRatingsAreNull()
        {
            var projected = TagCacheService.ProjectGuardedSeasonRatings(
                communityRating: null,
                criticRating: null,
                decision: TagCacheService.TagStripDecision.SeasonRatingOnly,
                stripRatings: true);

            Assert.True(projected.Suppressed);
            Assert.Null(projected.CommunityRating);
            Assert.Null(projected.CriticRating);
        }

        [Fact]
        public void FieldFilter_GuardedSeasonOne_StripsOnlyRatings()
        {
            var seriesId = Guid.NewGuid();
            var cfg = StrictConfig();
            var dto = SeasonDto(seriesId, seasonNumber: 1, anyWatched: false);

            NewFilter(cfg).StripItemForTest(dto, GuardedState(seriesId), cfg);

            Assert.Null(dto.CommunityRating);
            Assert.Null(dto.CriticRating);
            Assert.Equal("Non-rating overview remains visible for an exempt Season.", dto.Overview);
            Assert.Equal(new[] { "Non-rating tag" }, dto.Tags);
            Assert.Equal(new[] { "Drama" }, dto.Genres);
            Assert.Equal("Season 1 original", dto.Name);
        }

        [Fact]
        public void FieldFilter_GuardedSeasonTwoAnyWatched_StripsOnlyRatings()
        {
            var seriesId = Guid.NewGuid();
            var cfg = StrictConfig();
            var dto = SeasonDto(seriesId, seasonNumber: 2, anyWatched: true);

            NewFilter(cfg).StripItemForTest(dto, GuardedState(seriesId), cfg);

            Assert.Null(dto.CommunityRating);
            Assert.Null(dto.CriticRating);
            Assert.Equal("Non-rating overview remains visible for an exempt Season.", dto.Overview);
            Assert.Equal(new[] { "Non-rating tag" }, dto.Tags);
            Assert.Equal(new[] { "Drama" }, dto.Genres);
        }

        [Fact]
        public void FieldFilter_GuardedSeasonTwoNoneWatched_AppliesFullConfiguredStrip()
        {
            var seriesId = Guid.NewGuid();
            var cfg = StrictConfig();
            var dto = SeasonDto(seriesId, seasonNumber: 2, anyWatched: false);

            NewFilter(cfg).StripItemForTest(dto, GuardedState(seriesId), cfg);

            Assert.Null(dto.CommunityRating);
            Assert.Null(dto.CriticRating);
            Assert.Equal("Protected", dto.Overview);
            Assert.Empty(dto.Tags);
        }

        [Fact]
        public void FieldFilter_AdminRatingToggleOff_PreservesExemptSeasonRatings()
        {
            var seriesId = Guid.NewGuid();
            var cfg = StrictConfig(stripRatings: false);
            var dto = SeasonDto(seriesId, seasonNumber: 1, anyWatched: false);

            NewFilter(cfg).StripItemForTest(dto, GuardedState(seriesId), cfg);

            Assert.Equal(9.8f, dto.CommunityRating);
            Assert.Equal(97f, dto.CriticRating);
        }

        [Fact]
        public void FieldFilter_HideRatingsOptOut_PreservesExemptSeasonRatings()
        {
            var seriesId = Guid.NewGuid();
            var cfg = StrictConfig();
            var dto = SeasonDto(seriesId, seasonNumber: 1, anyWatched: false);

            NewFilter(cfg).StripItemForTest(dto, GuardedState(seriesId, hideRatings: false), cfg);

            Assert.Equal(9.8f, dto.CommunityRating);
            Assert.Equal(97f, dto.CriticRating);
        }

        [Fact]
        public void GetTagData_GuardedSeasonOne_StripsRatingsAndBlocksFallbackWithoutDroppingIdentity()
        {
            var item = GetSeasonTagData(StrictConfig(), hideRatings: null, seasonNumber: 1);

            Assert.Equal(JsonValueKind.Null, item.GetProperty("CommunityRating").ValueKind);
            Assert.Equal(JsonValueKind.Null, item.GetProperty("CriticRating").ValueKind);
            Assert.True(item.GetProperty("RatingSuppressed").GetBoolean());
            Assert.NotEqual(JsonValueKind.Null, item.GetProperty("SeriesId").ValueKind);
            Assert.Equal("Season 1 original", item.GetProperty("Name").GetString());
            Assert.Equal("Drama", item.GetProperty("Genres")[0].GetString());
        }

        [Fact]
        public void GetTagData_EmptyRouteUserId_UsesAuthorizedEffectiveUserPolicy()
        {
            var item = GetSeasonTagData(
                StrictConfig(),
                hideRatings: null,
                seasonNumber: 1,
                useEmptyRouteUserId: true);

            Assert.Equal(JsonValueKind.Null, item.GetProperty("CommunityRating").ValueKind);
            Assert.True(item.GetProperty("RatingSuppressed").GetBoolean());
        }

        [Fact]
        public void GetTagData_GuardedSeasonTwoNoneWatched_UsesFullStub()
        {
            var item = GetSeasonTagData(StrictConfig(), hideRatings: null, seasonNumber: 2);

            Assert.Equal(JsonValueKind.Null, item.GetProperty("CommunityRating").ValueKind);
            Assert.Equal(JsonValueKind.Null, item.GetProperty("CriticRating").ValueKind);
            Assert.True(item.GetProperty("RatingSuppressed").GetBoolean());
            Assert.Equal(JsonValueKind.Null, item.GetProperty("SeriesId").ValueKind);
            Assert.Empty(item.GetProperty("Genres").EnumerateArray());
        }

        [Theory]
        [InlineData(false, null)]
        [InlineData(true, false)]
        public void GetTagData_RatingToggleOrUserOptOut_PreservesExemptSeasonRatings(
            bool adminStripRatings,
            bool? hideRatings)
        {
            var item = GetSeasonTagData(
                StrictConfig(stripRatings: adminStripRatings),
                hideRatings,
                seasonNumber: 1);

            Assert.Equal(9.8, item.GetProperty("CommunityRating").GetDouble(), precision: 3);
            Assert.Equal(97, item.GetProperty("CriticRating").GetDouble(), precision: 3);
            Assert.False(item.GetProperty("RatingSuppressed").GetBoolean());
        }

        private static JsonElement GetSeasonTagData(
            PluginConfiguration cfg,
            bool? hideRatings,
            int seasonNumber,
            bool useEmptyRouteUserId = false)
        {
            var dir = Path.Combine(Path.GetTempPath(), "jc-season-rating-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);

            var user = new User("season-rating", "Prov", "PwProv");
            var seriesId = Guid.NewGuid();
            var season = new StubSeason
            {
                Id = Guid.NewGuid(),
                SeriesId = seriesId,
                IndexNumber = seasonNumber,
                Name = $"Season {seasonNumber} original",
                Genres = new[] { "Drama" },
                Tags = new[] { "Non-rating tag" },
                CommunityRating = 9.8f,
                CriticRating = 97f,
            };

            var userIdN = user.Id.ToString("N");
            try
            {
                var appPaths = new StubAppPaths(dir);
                var manager = new UserConfigurationManager(appPaths, NullLogger<UserConfigurationManager>.Instance);
                manager.SaveUserConfiguration(userIdN, SpoilerFile, GuardedState(seriesId, hideRatings));
                SpoilerUserResolver.InvalidateUser(userIdN);

                var library = new CountingLibraryManager
                {
                    GetItemByIdUserHook = (id, _) => id == season.Id ? season : null,
                    GetItemListHook = _ => Array.Empty<BaseItem>(),
                };
                var users = new StubUserManager(user);
                var identity = new RequestIdentityService(
                    new CountingSessionManager(),
                    users,
                    new SpoilerIdentityService(users, NullLogger<SpoilerIdentityService>.Instance),
                    NullLogger<RequestIdentityService>.Instance);
                var resolver = new SpoilerUserResolver(
                    manager, library, NullLogger<SpoilerUserResolver>.Instance, identity);
                var configProvider = new FakePluginConfigProvider(cfg);

                // GetTagData does not touch the cache/revision services; null test
                // placeholders keep this harness focused on its live fallback path.
                var controller = new TagCacheController(
                    new RecordingHttpClientFactory(new HttpClientHandler()),
                    NullLogger<TagCacheController>.Instance,
                    users,
                    new SeerrCache(configProvider),
                    configProvider,
                    tagCacheService: null!,
                    library,
                    new StubUserDataManager(),
                    resolver,
                    manager,
                    projectionRevisionService: null!);
                var principal = new ClaimsPrincipal(new ClaimsIdentity(
                    new[] { new Claim("Jellyfin-UserId", user.Id.ToString()) },
                    "TestAuth"));
                controller.ControllerContext = new ControllerContext
                {
                    HttpContext = new DefaultHttpContext { User = principal },
                };

                var ok = Assert.IsType<OkObjectResult>(
                    controller.GetTagData(
                        useEmptyRouteUserId ? Guid.Empty : user.Id,
                        new[] { season.Id.ToString("N") }));
                using var json = JsonDocument.Parse(JsonSerializer.Serialize(ok.Value));
                return json.RootElement.GetProperty("Items")[0].Clone();
            }
            finally
            {
                SpoilerUserResolver.InvalidateUser(userIdN);
                try { Directory.Delete(dir, recursive: true); } catch { /* best effort */ }
            }
        }
    }
}
