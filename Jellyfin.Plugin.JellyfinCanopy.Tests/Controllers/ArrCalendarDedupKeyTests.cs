using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Model.Arr;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers
{
    /// <summary>
    /// ARR-3: the cross-instance dedup key must not depend on the release date. A series
    /// tvdbId + S/E (or a movie tmdbId + release-type) already identifies the item, so a
    /// UTC-midnight boundary must not false-split the same item into two calendar rows.
    /// </summary>
    public class ArrCalendarDedupKeyTests
    {
        [Fact]
        public void SonarrEpisode_DifferentReleaseDate_SameKey()
        {
            var late = new ArrItem
            {
                Source = nameof(ArrType.Sonarr),
                TvdbId = 1234,
                SeasonNumber = 1,
                EpisodeNumber = 2,
                ReleaseDate = "2026-01-01T23:30:00.0000000Z",
            };
            var nextUtcDay = new ArrItem
            {
                Source = nameof(ArrType.Sonarr),
                TvdbId = 1234,
                SeasonNumber = 1,
                EpisodeNumber = 2,
                ReleaseDate = "2026-01-02T00:30:00.0000000Z",
            };

            Assert.Equal(
                ArrCalendarController.BuildDedupKey(late),
                ArrCalendarController.BuildDedupKey(nextUtcDay));
        }

        [Fact]
        public void RadarrRelease_DifferentReleaseDate_SameKey()
        {
            var a = new ArrItem
            {
                Source = nameof(ArrType.Radarr),
                TmdbId = 555,
                ReleaseType = "DigitalRelease",
                ReleaseDate = "2026-03-10T23:00:00Z",
            };
            var b = new ArrItem
            {
                Source = nameof(ArrType.Radarr),
                TmdbId = 555,
                ReleaseType = "DigitalRelease",
                ReleaseDate = "2026-03-11T01:00:00Z",
            };

            Assert.Equal(ArrCalendarController.BuildDedupKey(a), ArrCalendarController.BuildDedupKey(b));
        }

        [Fact]
        public void DistinctEpisodes_StillGetDistinctKeys()
        {
            var e2 = new ArrItem { Source = nameof(ArrType.Sonarr), TvdbId = 1234, SeasonNumber = 1, EpisodeNumber = 2 };
            var e3 = new ArrItem { Source = nameof(ArrType.Sonarr), TvdbId = 1234, SeasonNumber = 1, EpisodeNumber = 3 };

            Assert.NotEqual(ArrCalendarController.BuildDedupKey(e2), ArrCalendarController.BuildDedupKey(e3));
        }

        // ARR-CS-2: a 0/absent tvdbId/tmdbId takes the TITLE fallback. Without a provider id we cannot
        // prove two same-title rows are the same item, so the fallback must carry discriminators or it
        // merges genuinely-distinct items and hides content.

        [Fact]
        public void UnmappedSonarr_SameTitleAndEpisode_DifferentInstance_GetDistinctKeys()
        {
            var a = new ArrItem
            {
                Source = nameof(ArrType.Sonarr), TvdbId = null, Title = "The News",
                InstanceName = "Anime", SeasonNumber = 1, EpisodeNumber = 1, ReleaseDateLocal = "2026-07-10",
            };
            var b = new ArrItem
            {
                Source = nameof(ArrType.Sonarr), TvdbId = null, Title = "The News",
                InstanceName = "Docs", SeasonNumber = 1, EpisodeNumber = 1, ReleaseDateLocal = "2026-07-10",
            };

            Assert.NotEqual(ArrCalendarController.BuildDedupKey(a), ArrCalendarController.BuildDedupKey(b));
        }

        [Fact]
        public void UnmappedSonarr_SameTitleAndEpisode_DifferentAirDate_GetDistinctKeys()
        {
            var a = new ArrItem
            {
                Source = nameof(ArrType.Sonarr), TvdbId = null, Title = "The News",
                InstanceName = "Main", SeasonNumber = 1, EpisodeNumber = 1, ReleaseDateLocal = "2026-07-10",
            };
            var b = new ArrItem
            {
                Source = nameof(ArrType.Sonarr), TvdbId = null, Title = "The News",
                InstanceName = "Main", SeasonNumber = 1, EpisodeNumber = 1, ReleaseDateLocal = "2026-07-11",
            };

            Assert.NotEqual(ArrCalendarController.BuildDedupKey(a), ArrCalendarController.BuildDedupKey(b));
        }

        [Fact]
        public void UnmappedRadarr_SameTitleRemake_DifferentYear_SameReleaseType_GetDistinctKeys()
        {
            var original = new ArrItem
            {
                Source = nameof(ArrType.Radarr), TmdbId = null, Title = "The Batman",
                Subtitle = "2004", InstanceName = "Movies", ReleaseType = "CinemaRelease",
            };
            var remake = new ArrItem
            {
                Source = nameof(ArrType.Radarr), TmdbId = null, Title = "The Batman",
                Subtitle = "2022", InstanceName = "Movies", ReleaseType = "CinemaRelease",
            };

            Assert.NotEqual(ArrCalendarController.BuildDedupKey(original), ArrCalendarController.BuildDedupKey(remake));
        }

        [Fact]
        public void UnmappedItems_TrulyIdentical_StillMerge()
        {
            // Same title, instance, year and release type with no provider id — as close to
            // "identical" as the fallback can prove. These should still collapse to one row.
            var a = new ArrItem
            {
                Source = nameof(ArrType.Radarr), TmdbId = null, Title = "Foo",
                Subtitle = "2020", InstanceName = "Movies", ReleaseType = "CinemaRelease",
            };
            var b = new ArrItem
            {
                Source = nameof(ArrType.Radarr), TmdbId = null, Title = "Foo",
                Subtitle = "2020", InstanceName = "Movies", ReleaseType = "CinemaRelease",
            };

            Assert.Equal(ArrCalendarController.BuildDedupKey(a), ArrCalendarController.BuildDedupKey(b));
        }
    }
}
