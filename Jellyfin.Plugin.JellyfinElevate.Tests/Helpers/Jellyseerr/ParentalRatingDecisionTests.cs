using System;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinElevate.Helpers.Jellyseerr;
using Xunit;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.Helpers.Jellyseerr
{
    /// <summary>
    /// Pins the parental-control decision to Jellyfin core's
    /// <c>BaseItem.IsParentalAllowed</c> rating branches (B/C/D/E). This is the
    /// correctness core of the Seerr parental filter, so every branch and the
    /// score/sub-score lexicographic edge cases are covered.
    /// </summary>
    public class ParentalRatingDecisionTests
    {
        private static readonly UnratedItem[] None = Array.Empty<UnratedItem>();

        // (D) No user limit -> always allowed, regardless of the item's rating.
        [Theory]
        [InlineData(0)]
        [InlineData(13)]
        [InlineData(17)]
        [InlineData(1000)]
        public void NoLimit_AllowsAnyRatedItem(int itemScore)
        {
            Assert.True(ParentalRatingDecision.IsAllowed(itemScore, 0, UnratedItem.Movie, maxScore: null, maxSubScore: null, None));
        }

        // (E) Score comparison: below/at/above the limit.
        [Theory]
        [InlineData(10, 13, true)]   // PG under PG-13 limit
        [InlineData(13, 13, true)]   // equal (sub 0 <= 0)
        [InlineData(17, 13, false)]  // R over PG-13 limit
        [InlineData(0, 0, true)]     // G at G limit
        [InlineData(13, 10, false)]  // PG-13 over PG limit
        public void ScoreComparison(int itemScore, int maxScore, bool expected)
        {
            Assert.Equal(expected, ParentalRatingDecision.IsAllowed(itemScore, 0, UnratedItem.Movie, maxScore, maxSubScore: 0, None));
        }

        // (E) Sub-score only matters when the scores are equal.
        [Theory]
        [InlineData(17, 0, 17, 0, true)]    // R (17,0) at max (17,0)
        [InlineData(17, 1, 17, 0, false)]   // NC-17/TV-MA (17,1) over max (17,0)
        [InlineData(17, 0, 17, 1, true)]    // R (17,0) under max (17,1)
        [InlineData(14, 1, 13, 0, false)]   // higher score wins before sub-score is consulted
        public void SubScoreComparison(int itemScore, int itemSub, int maxScore, int maxSub, bool expected)
        {
            Assert.Equal(expected, ParentalRatingDecision.IsAllowed(itemScore, itemSub, UnratedItem.Movie, maxScore, maxSub, None));
        }

        [Fact]
        public void EqualScore_NullMaxSubScore_IsUnboundedAtThatLevel()
        {
            // maxSubScore null => any sub-score at the matching score is allowed.
            Assert.True(ParentalRatingDecision.IsAllowed(17, 1, UnratedItem.Movie, maxScore: 17, maxSubScore: null, None));
        }

        [Fact]
        public void EqualScore_ItemSubScoreNull_TreatedAsZero()
        {
            Assert.True(ParentalRatingDecision.IsAllowed(13, null, UnratedItem.Movie, maxScore: 13, maxSubScore: 0, None));
        }

        // (B/C) Unrated items: allowed unless the user blocks unrated items of that type.
        [Fact]
        public void Unrated_NoBlock_IsAllowed()
        {
            Assert.True(ParentalRatingDecision.IsAllowed(null, null, UnratedItem.Movie, maxScore: 10, maxSubScore: 0, None));
        }

        [Fact]
        public void Unrated_BlockMatchesType_IsDenied()
        {
            Assert.False(ParentalRatingDecision.IsAllowed(null, null, UnratedItem.Movie, maxScore: null, maxSubScore: null, new[] { UnratedItem.Movie }));
        }

        [Fact]
        public void Unrated_BlockDifferentType_IsAllowed()
        {
            // User blocks unrated movies; an unrated series is unaffected.
            Assert.True(ParentalRatingDecision.IsAllowed(null, null, UnratedItem.Series, maxScore: null, maxSubScore: null, new[] { UnratedItem.Movie }));
        }

        [Fact]
        public void Unrated_BlockSeries_DeniesUnratedSeries()
        {
            Assert.False(ParentalRatingDecision.IsAllowed(null, null, UnratedItem.Series, maxScore: null, maxSubScore: null, new[] { UnratedItem.Series }));
        }

        [Fact]
        public void Unrated_NullBlockList_IsAllowed()
        {
            Assert.True(ParentalRatingDecision.IsAllowed(null, null, UnratedItem.Movie, maxScore: 10, maxSubScore: 0, blockUnrated: null));
        }

        [Fact]
        public void RatedItem_IgnoresBlockUnrated()
        {
            // A rated item under the limit is allowed even if the user blocks unrated items.
            Assert.True(ParentalRatingDecision.IsAllowed(10, 0, UnratedItem.Movie, maxScore: 13, maxSubScore: 0, new[] { UnratedItem.Movie }));
        }
    }
}
