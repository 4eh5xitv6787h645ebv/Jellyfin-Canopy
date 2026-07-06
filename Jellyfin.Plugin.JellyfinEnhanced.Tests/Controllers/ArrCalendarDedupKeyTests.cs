using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Xunit;

namespace Jellyfin.Plugin.JellyfinEnhanced.Tests.Controllers
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
    }
}
