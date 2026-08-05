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
using MediaBrowser.Model.Entities;
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
            var userData = new StubUserDataManager();
            var nextUnwatched = new SpoilerNextUnwatchedService(
                lib, users, userData, NullLogger<SpoilerNextUnwatchedService>.Instance);
            return new SpoilerFieldStripFilter(
                resolver, lib, users, userData, new FakePluginConfigProvider(cfg), nextUnwatched);
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

        [Fact]
        public void GetTagData_RegularLiveProjection_PreservesVideoWidth()
        {
            var movie = new StreamMovie(width: 8192, height: 4096)
            {
                Id = Guid.NewGuid(),
                Name = "Resolution fixture",
            };

            var item = GetItemTagData(new PluginConfiguration(), new UserSpoilerBlur(), movie);

            Assert.Equal(8192, item.GetProperty("MediaStreams")[0].GetProperty("Width").GetInt32());
            Assert.Equal(4096, item.GetProperty("MediaStreams")[0].GetProperty("Height").GetInt32());
        }

        [Fact]
        public void GetTagData_GuardedMovieQualityProjection_PreservesVideoWidth()
        {
            var movie = new StreamMovie(width: 8192, height: 4096)
            {
                Id = Guid.NewGuid(),
                Name = "Guarded resolution fixture",
            };
            var state = new UserSpoilerBlur();
            var movieId = movie.Id.ToString("N");
            state.Movies[movieId] = new SpoilerBlurMovieEntry { MovieId = movieId };

            var item = GetItemTagData(QualityRetainingSpoilerConfig(), state, movie);

            Assert.Equal(8192, item.GetProperty("MediaStreams")[0].GetProperty("Width").GetInt32());
            Assert.Equal(4096, item.GetProperty("MediaStreams")[0].GetProperty("Height").GetInt32());
        }

        [Fact]
        public void GetTagData_GuardedEpisodeQualityProjection_PreservesVideoWidth()
        {
            var seriesId = Guid.NewGuid();
            var episode = new StreamEpisode(width: 7680, height: 4320)
            {
                Id = Guid.NewGuid(),
                SeriesId = seriesId,
                Name = "Guarded episode resolution fixture",
            };

            var item = GetItemTagData(
                QualityRetainingSpoilerConfig(),
                GuardedState(seriesId),
                episode);

            Assert.Equal(7680, item.GetProperty("MediaStreams")[0].GetProperty("Width").GetInt32());
            Assert.Equal(4320, item.GetProperty("MediaStreams")[0].GetProperty("Height").GetInt32());
        }

        private static PluginConfiguration QualityRetainingSpoilerConfig() => new()
        {
            SpoilerBlurEnabled = true,
            SpoilerStripRatings = true,
            SpoilerStripTags = false,
        };

        private static JsonElement GetSeasonTagData(
            PluginConfiguration cfg,
            bool? hideRatings,
            int seasonNumber,
            bool useEmptyRouteUserId = false)
        {
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

            return GetItemTagData(
                cfg,
                GuardedState(seriesId, hideRatings),
                season,
                useEmptyRouteUserId);
        }

        private static JsonElement GetItemTagData(
            PluginConfiguration cfg,
            UserSpoilerBlur state,
            BaseItem item,
            bool useEmptyRouteUserId = false)
        {
            var dir = Path.Combine(Path.GetTempPath(), "jc-tag-data-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            var user = new User("tag-data", "Prov", "PwProv");

            var userIdN = user.Id.ToString("N");
            try
            {
                var appPaths = new StubAppPaths(dir);
                var manager = new UserConfigurationManager(appPaths, NullLogger<UserConfigurationManager>.Instance);
                manager.SaveUserConfiguration(userIdN, SpoilerFile, state);
                SpoilerUserResolver.InvalidateUser(userIdN);

                var library = new CountingLibraryManager
                {
                    GetItemByIdUserHook = (id, _) => id == item.Id ? item : null,
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
                    projectionRevisionService: null!,
                    tagCacheLifecycle: new StubTagCacheLifecycle());
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
                        new[] { item.Id.ToString("N") }));
                using var json = JsonDocument.Parse(JsonSerializer.Serialize(ok.Value));
                return json.RootElement.GetProperty("Items")[0].Clone();
            }
            finally
            {
                SpoilerUserResolver.InvalidateUser(userIdN);
                try { Directory.Delete(dir, recursive: true); } catch { /* best effort */ }
            }
        }

        private sealed class StreamMovie : MediaBrowser.Controller.Entities.Movies.Movie
        {
            private readonly IReadOnlyList<MediaSourceInfo> _sources;

            public StreamMovie(int width, int height)
            {
                _sources = Sources(width, height);
            }

            public override string GetClientTypeName() => "Movie";

            public override IReadOnlyList<MediaSourceInfo> GetMediaSources(bool enablePathSubstitution)
                => _sources;
        }

        private sealed class StreamEpisode : MediaBrowser.Controller.Entities.TV.Episode
        {
            private readonly IReadOnlyList<MediaSourceInfo> _sources;

            public StreamEpisode(int width, int height)
            {
                _sources = Sources(width, height);
            }

            public override string GetClientTypeName() => "Episode";

            public override IReadOnlyList<MediaSourceInfo> GetMediaSources(bool enablePathSubstitution)
                => _sources;
        }

        private static IReadOnlyList<MediaSourceInfo> Sources(int width, int height)
            => new[]
            {
                new MediaSourceInfo
                {
                    MediaStreams = new[]
                    {
                        new MediaStream
                        {
                            Type = MediaStreamType.Video,
                            Codec = "hevc",
                            Width = width,
                            Height = height,
                        },
                    },
                },
            };
    }
}
