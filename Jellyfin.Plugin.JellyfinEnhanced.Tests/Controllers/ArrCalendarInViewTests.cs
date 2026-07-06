using System;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Xunit;

namespace Jellyfin.Plugin.JellyfinEnhanced.Tests.Controllers
{
    /// <summary>
    /// CRIT-1 (range filter): a date-only calendar release must be included when its LOCAL day
    /// intersects the requested view. Comparing its midnight-UTC instant against the view bounds
    /// drops it for any viewer off UTC (e.g. a UTC-7 day view whose UTC start is 07:00Z), which
    /// the prior fix never covered — the release was filtered out before the client's local-day
    /// bucketing could show it. Genuine instants must still filter by the exact UTC window.
    /// </summary>
    public class ArrCalendarInViewTests
    {
        // America/Los_Angeles day view of 2026-07-10 (PDT, UTC-7):
        //   local midnight  -> 2026-07-10T07:00:00Z (view UTC start)
        //   local end-of-day-> 2026-07-11T06:59:59Z (view UTC end)
        private static readonly DateTime ViewStartUtc = DateTime.Parse("2026-07-10T07:00:00Z").ToUniversalTime();
        private static readonly DateTime ViewEndUtc = DateTime.Parse("2026-07-11T06:59:59Z").ToUniversalTime();
        private const string StartDay = "2026-07-10";
        private const string EndDay = "2026-07-10";

        [Fact]
        public void DateOnlyRelease_MidnightUtc_SurvivesInUtcMinus7View()
        {
            // Radarr 2026-07-10 release -> midnight-UTC instant + "2026-07-10" local day.
            var releaseUtc = DateTime.Parse("2026-07-10T00:00:00Z").ToUniversalTime();

            // Its instant (00:00Z) is BEFORE the view's UTC start (07:00Z) — a UTC-instant
            // comparison would drop it. The local-day comparison must keep it.
            Assert.True(releaseUtc < ViewStartUtc, "guard: the release instant is outside the UTC window");
            Assert.True(ArrCalendarController.IsEventInView(
                dateOnly: true, releaseLocalDay: "2026-07-10", releaseUtc: releaseUtc,
                startUtc: ViewStartUtc, endUtc: ViewEndUtc, startDay: StartDay, endDay: EndDay));
        }

        [Fact]
        public void DateOnlyRelease_OutsideLocalDayWindow_IsExcluded()
        {
            var releaseUtc = DateTime.Parse("2026-07-11T00:00:00Z").ToUniversalTime();

            Assert.False(ArrCalendarController.IsEventInView(
                dateOnly: true, releaseLocalDay: "2026-07-11", releaseUtc: releaseUtc,
                startUtc: ViewStartUtc, endUtc: ViewEndUtc, startDay: StartDay, endDay: EndDay));
        }

        [Fact]
        public void GenuineInstant_KeepsExactUtcWindow()
        {
            // 02:00Z is 2026-07-09 19:00 PDT — a different local day, correctly outside the view.
            var beforeWindow = DateTime.Parse("2026-07-10T02:00:00Z").ToUniversalTime();
            Assert.False(ArrCalendarController.IsEventInView(
                dateOnly: false, releaseLocalDay: null, releaseUtc: beforeWindow,
                startUtc: ViewStartUtc, endUtc: ViewEndUtc, startDay: StartDay, endDay: EndDay));

            // 18:00Z is within [07:00Z, 06:59:59Z-next-day].
            var inWindow = DateTime.Parse("2026-07-10T18:00:00Z").ToUniversalTime();
            Assert.True(ArrCalendarController.IsEventInView(
                dateOnly: false, releaseLocalDay: null, releaseUtc: inWindow,
                startUtc: ViewStartUtc, endUtc: ViewEndUtc, startDay: StartDay, endDay: EndDay));
        }

        [Theory]
        [InlineData("2026-07-10", true)]
        [InlineData("2026-01-01", true)]
        [InlineData("2026-1-1", false)]
        [InlineData("not-a-date", false)]
        [InlineData("", false)]
        [InlineData(null, false)]
        public void IsDayKey_AcceptsOnlyWellFormedLocalDays(string? value, bool expected)
            => Assert.Equal(expected, ArrCalendarController.IsDayKey(value));
    }
}
