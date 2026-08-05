using System;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Model.Dto;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services
{
    /// <summary>
    /// Advanced per-category Spoiler Guard reveals through the field-strip
    /// filter: the next unwatched episode / current season get their admin
    /// category masks, everything else (later seasons, specials, unknown
    /// categories, advanced mode off, user opt-out, fail-closed) keeps the
    /// uniform full strip. A reveal must never relax a strip beyond what the
    /// category mask authorizes, and never strip anything itself.
    /// </summary>
    public sealed class SpoilerAdvancedCategoryStripTests
    {
        private static readonly Guid SeriesId = Guid.NewGuid();
        private static readonly Guid BoundaryEpisodeId = Guid.NewGuid();
        private static readonly Guid TestUserId = Guid.NewGuid();

        private static PluginConfiguration AdvancedCfg() => new()
        {
            SpoilerBlurEnabled = true,
            SpoilerAdvancedMode = true,
            SpoilerStripOverview = true,
            SpoilerReplaceTitle = true,
            SpoilerStripRatings = true,
            // Category defaults from the ctor: next-episode title revealed,
            // everything else stripped. Restated explicitly so the tests
            // don't silently drift with the defaults.
            SpoilerNextEpisodeStripTitle = false,
            SpoilerNextEpisodeStripOverview = true,
            SpoilerNextEpisodeStripRatings = true,
            SpoilerCurrentSeasonStripTitle = true,
            SpoilerCurrentSeasonStripOverview = true,
            SpoilerCurrentSeasonStripRatings = true,
        };

        private static UserSpoilerBlur GuardedState(bool? useAdvancedCategories = null)
        {
            var state = new UserSpoilerBlur
            {
                Prefs = new SpoilerBlurUserPrefs { UseAdvancedCategories = useAdvancedCategories },
            };
            var seriesIdN = SeriesId.ToString("N");
            state.Series[seriesIdN] = new SpoilerBlurSeriesEntry { SeriesId = seriesIdN };
            return state;
        }

        private static SpoilerFieldStripFilter NewFilter(
            PluginConfiguration cfg,
            SpoilerNextUnwatchedService.NextUnwatchedBoundary? boundary)
        {
            var lib = new CountingLibraryManager();
            var users = new StubUserManager();
            var userData = new StubUserDataManager();
            var markers = new SpoilerIdentityService(users, NullLogger<SpoilerIdentityService>.Instance);
            var identity = new RequestIdentityService(
                new CountingSessionManager(), users, markers, NullLogger<RequestIdentityService>.Instance);
            var resolver = new SpoilerUserResolver(
                userConfigManager: null!, lib, NullLogger<SpoilerUserResolver>.Instance, identity);
            var nextUnwatched = new SpoilerNextUnwatchedService(
                lib, users, userData, NullLogger<SpoilerNextUnwatchedService>.Instance)
            {
                BoundaryComputerForTest = (_, _) => boundary,
            };
            return new SpoilerFieldStripFilter(
                resolver, lib, users, userData, new FakePluginConfigProvider(cfg), nextUnwatched);
        }

        private static BaseItemDto EpisodeDto(int season, int episode, Guid? id = null) => new()
        {
            Id = id ?? Guid.NewGuid(),
            Type = BaseItemKind.Episode,
            SeriesId = SeriesId,
            ParentIndexNumber = season,
            IndexNumber = episode,
            Name = "The Big Reveal",
            Overview = "Someone dies.",
            CommunityRating = 9.8f,
            CriticRating = 97f,
            UserData = new UserItemDataDto { Key = "k", Played = false },
        };

        private static SpoilerNextUnwatchedService.NextUnwatchedBoundary DefaultBoundary()
            => new(BoundaryEpisodeId, SeasonNumber: 2, EpisodeNumber: 5);

        [Fact]
        public void NextEpisode_DefaultMask_RevealsTitleOnly()
        {
            var filter = NewFilter(AdvancedCfg(), DefaultBoundary());
            var dto = EpisodeDto(2, 5, BoundaryEpisodeId);

            filter.StripItemForTest(dto, GuardedState(), AdvancedCfg(), TestUserId);

            Assert.Equal("The Big Reveal", dto.Name);
            Assert.Equal("Spoiler Guard activated", dto.Overview);
            Assert.Null(dto.CommunityRating);
            Assert.Null(dto.CriticRating);
        }

        [Fact]
        public void NextEpisode_AdminCanRevealOverviewAndRatings()
        {
            var cfg = AdvancedCfg();
            cfg.SpoilerNextEpisodeStripOverview = false;
            cfg.SpoilerNextEpisodeStripRatings = false;
            var filter = NewFilter(cfg, DefaultBoundary());
            var dto = EpisodeDto(2, 5, BoundaryEpisodeId);

            filter.StripItemForTest(dto, GuardedState(), cfg, TestUserId);

            Assert.Equal("The Big Reveal", dto.Name);
            Assert.Equal("Someone dies.", dto.Overview);
            Assert.Equal(9.8f, dto.CommunityRating);
            Assert.Equal(97f, dto.CriticRating);
        }

        [Fact]
        public void CurrentSeason_DefaultMask_IsFullStrip()
        {
            var filter = NewFilter(AdvancedCfg(), DefaultBoundary());
            var dto = EpisodeDto(2, 6);

            filter.StripItemForTest(dto, GuardedState(), AdvancedCfg(), TestUserId);

            Assert.Equal("Season 2, Episode 6", dto.Name);
            Assert.Equal("Spoiler Guard activated", dto.Overview);
            Assert.Null(dto.CommunityRating);
        }

        [Fact]
        public void CurrentSeason_AdminCanRevealRatings_TitleStaysStripped()
        {
            var cfg = AdvancedCfg();
            cfg.SpoilerCurrentSeasonStripRatings = false;
            var filter = NewFilter(cfg, DefaultBoundary());
            var dto = EpisodeDto(2, 6);

            filter.StripItemForTest(dto, GuardedState(), cfg, TestUserId);

            Assert.Equal("Season 2, Episode 6", dto.Name);
            Assert.Equal(9.8f, dto.CommunityRating);
            Assert.Equal(97f, dto.CriticRating);
            Assert.Equal("Spoiler Guard activated", dto.Overview);
        }

        [Theory]
        [InlineData(3, 1)] // future season
        [InlineData(1, 9)] // skipped earlier season
        [InlineData(0, 2)] // special
        public void OtherCategories_KeepFullStrip(int season, int episode)
        {
            var filter = NewFilter(AdvancedCfg(), DefaultBoundary());
            var dto = EpisodeDto(season, episode);

            filter.StripItemForTest(dto, GuardedState(), AdvancedCfg(), TestUserId);

            Assert.Equal($"Season {season}, Episode {episode}", dto.Name);
            Assert.Equal("Spoiler Guard activated", dto.Overview);
            Assert.Null(dto.CommunityRating);
        }

        [Fact]
        public void AdvancedModeOff_BoundaryEpisodeKeepsFullStrip()
        {
            var cfg = AdvancedCfg();
            cfg.SpoilerAdvancedMode = false;
            var filter = NewFilter(cfg, DefaultBoundary());
            var dto = EpisodeDto(2, 5, BoundaryEpisodeId);

            filter.StripItemForTest(dto, GuardedState(), cfg, TestUserId);

            Assert.Equal("Season 2, Episode 5", dto.Name);
        }

        [Fact]
        public void UserOptOut_RestoresFullStrip()
        {
            var filter = NewFilter(AdvancedCfg(), DefaultBoundary());
            var dto = EpisodeDto(2, 5, BoundaryEpisodeId);

            filter.StripItemForTest(dto, GuardedState(useAdvancedCategories: false), AdvancedCfg(), TestUserId);

            Assert.Equal("Season 2, Episode 5", dto.Name);
        }

        [Fact]
        public void UserPrefTrue_NeverEnablesModeTheAdminDisabled()
        {
            var cfg = AdvancedCfg();
            cfg.SpoilerAdvancedMode = false;
            var filter = NewFilter(cfg, DefaultBoundary());
            var dto = EpisodeDto(2, 5, BoundaryEpisodeId);

            filter.StripItemForTest(dto, GuardedState(useAdvancedCategories: true), cfg, TestUserId);

            Assert.Equal("Season 2, Episode 5", dto.Name);
        }

        [Fact]
        public void NullBoundary_FailsClosedToFullStrip()
        {
            var filter = NewFilter(AdvancedCfg(), boundary: null);
            var dto = EpisodeDto(2, 5, BoundaryEpisodeId);

            filter.StripItemForTest(dto, GuardedState(), AdvancedCfg(), TestUserId);

            Assert.Equal("Season 2, Episode 5", dto.Name);
        }

        [Fact]
        public void FailClosedPolicy_IgnoresAdvancedMode()
        {
            var filter = NewFilter(AdvancedCfg(), DefaultBoundary());
            var dto = EpisodeDto(2, 5, BoundaryEpisodeId);

            filter.StripItemForTest(dto, new UserSpoilerBlur { FailClosed = true }, AdvancedCfg(), TestUserId);

            Assert.NotEqual("The Big Reveal", dto.Name);
        }

        [Fact]
        public void RevealNeverStrips_WhenBaseToggleIsOff()
        {
            // Category says "strip title" but the base toggle is off — the
            // category mask can only relax an active strip, never add one.
            var cfg = AdvancedCfg();
            cfg.SpoilerReplaceTitle = false;
            cfg.SpoilerCurrentSeasonStripTitle = true;
            var filter = NewFilter(cfg, DefaultBoundary());
            var dto = EpisodeDto(2, 6);

            filter.StripItemForTest(dto, GuardedState(), cfg, TestUserId);

            Assert.Equal("The Big Reveal", dto.Name);
        }

        [Fact]
        public void RevealedTitle_StillSanitizesNestedTitleSurfaces_WhileOverviewStripOn()
        {
            // Title revealed but overview stripped: the deny-by-default
            // title-bearing sanitize block still runs off the overview strip,
            // so nested surfaces (Path etc.) stay protected while Name shows.
            var filter = NewFilter(AdvancedCfg(), DefaultBoundary());
            var dto = EpisodeDto(2, 5, BoundaryEpisodeId);
            dto.Path = "/media/Show/S02E05 The Big Reveal.mkv";

            filter.StripItemForTest(dto, GuardedState(), AdvancedCfg(), TestUserId);

            Assert.Equal("The Big Reveal", dto.Name);
            Assert.Null(dto.Path);
        }

        [Theory]
        [InlineData(true, false)]  // season present, episode index missing
        [InlineData(false, true)]  // episode present, season index missing
        [InlineData(false, false)] // both missing
        public void BoundaryIdMatch_WithMissingIndexes_KeepsFullStrip_EvenWithAllRevealsOn(
            bool hasSeason, bool hasEpisode)
        {
            var cfg = AdvancedCfg();
            cfg.SpoilerNextEpisodeStripTitle = false;
            cfg.SpoilerNextEpisodeStripOverview = false;
            cfg.SpoilerNextEpisodeStripRatings = false;
            var filter = NewFilter(cfg, DefaultBoundary());
            var dto = EpisodeDto(2, 5, BoundaryEpisodeId);
            dto.ParentIndexNumber = hasSeason ? 2 : null;
            dto.IndexNumber = hasEpisode ? 5 : null;

            filter.StripItemForTest(dto, GuardedState(), cfg, TestUserId);

            Assert.NotEqual("Someone dies.", dto.Overview);
            Assert.Null(dto.CommunityRating);
            Assert.Null(dto.CriticRating);
        }

        [Fact]
        public void BoundaryIdMatch_InSeasonZero_KeepsFullStrip()
        {
            var filter = NewFilter(AdvancedCfg(), DefaultBoundary());
            var dto = EpisodeDto(0, 5, BoundaryEpisodeId);

            filter.StripItemForTest(dto, GuardedState(), AdvancedCfg(), TestUserId);

            Assert.Equal("Season 0, Episode 5", dto.Name);
            Assert.Equal("Spoiler Guard activated", dto.Overview);
            Assert.Null(dto.CommunityRating);
        }

        [Fact]
        public void DifferentEpisodeWithBoundaryCoordinates_GetsSeasonMaskNotNextMask()
        {
            var cfg = AdvancedCfg();
            cfg.SpoilerCurrentSeasonStripRatings = false;
            var filter = NewFilter(cfg, DefaultBoundary());
            var dto = EpisodeDto(2, 5); // boundary coordinates, different id

            filter.StripItemForTest(dto, GuardedState(), cfg, TestUserId);

            // CurrentSeason mask: ratings revealed by the relaxed toggle, but
            // the title stays stripped — never the NextEpisode title reveal.
            Assert.Equal("Season 2, Episode 5", dto.Name);
            Assert.Equal(9.8f, dto.CommunityRating);
        }

        [Fact]
        public void WatchedEpisode_StaysUntouched_RegardlessOfCategory()
        {
            var filter = NewFilter(AdvancedCfg(), DefaultBoundary());
            var dto = EpisodeDto(2, 6);
            dto.UserData = new UserItemDataDto { Key = "k", Played = true };

            filter.StripItemForTest(dto, GuardedState(), AdvancedCfg(), TestUserId);

            Assert.Equal("The Big Reveal", dto.Name);
            Assert.Equal("Someone dies.", dto.Overview);
            Assert.Equal(9.8f, dto.CommunityRating);
        }
    }
}
