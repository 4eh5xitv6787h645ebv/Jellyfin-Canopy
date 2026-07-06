using System;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Arr;
using Xunit;

namespace Jellyfin.Plugin.JellyfinEnhanced.Tests.Helpers
{
    /// <summary>
    /// Pins the date-only contract emitted to the calendar client. A date-only release
    /// (Radarr cinema/digital/physical; Sonarr airDate fallback) must ship a stable
    /// "yyyy-MM-dd" bucket key so the client renders it on the correct local day with no
    /// spurious clock time; a genuine instant ships no local key so the client keeps
    /// timezone-converting it.
    /// </summary>
    public class ArrReleaseDateTests
    {
        [Fact]
        public void Build_DateOnly_EmitsLocalDate_MatchingUtcCalendarDay()
        {
            var (releaseDate, releaseDateLocal) = ArrReleaseDate.Build(
                new DateTime(2026, 7, 10, 0, 0, 0, DateTimeKind.Utc), dateOnly: true);

            Assert.Equal("2026-07-10", releaseDateLocal);
            Assert.StartsWith("2026-07-10T00:00:00", releaseDate, StringComparison.Ordinal);
        }

        [Fact]
        public void Build_Instant_LeavesLocalDateNull()
        {
            var (_, releaseDateLocal) = ArrReleaseDate.Build(
                new DateTime(2026, 7, 10, 18, 30, 0, DateTimeKind.Utc), dateOnly: false);

            Assert.Null(releaseDateLocal);
        }
    }
}
