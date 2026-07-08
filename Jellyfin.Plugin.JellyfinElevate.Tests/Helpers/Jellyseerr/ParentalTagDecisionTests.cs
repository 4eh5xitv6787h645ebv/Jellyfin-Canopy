using System.Collections.Generic;
using Jellyfin.Plugin.JellyfinElevate.Helpers.Jellyseerr;
using Xunit;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.Helpers.Jellyseerr
{
    /// <summary>
    /// Pins the pure tag branch (port of core's IsVisibleViaTags): blocked-wins
    /// precedence, strict allow-list, empty-list behavior, and the GetCleanValue
    /// normalization parity that keeps matching identical to native enforcement.
    /// </summary>
    public class ParentalTagDecisionTests
    {
        private static HashSet<string> Clean(params string[] raw) => ParentalTagDecision.CleanTags(raw);

        [Fact]
        public void BothListsEmpty_Allows()
        {
            Assert.True(ParentalTagDecision.IsAllowed(Clean("zombie"), Clean(), Clean()));
            Assert.True(ParentalTagDecision.IsAllowed(Clean(), Clean(), Clean()));
        }

        [Fact]
        public void BlockedOverlap_Blocks()
        {
            Assert.False(ParentalTagDecision.IsAllowed(Clean("zombie", "comedy"), Clean("zombie"), Clean()));
            Assert.True(ParentalTagDecision.IsAllowed(Clean("comedy"), Clean("zombie"), Clean()));
        }

        [Fact]
        public void BlockedWins_EvenWhenAllowedAlsoMatches()
        {
            // Core checks BlockedTags first and short-circuits.
            Assert.False(ParentalTagDecision.IsAllowed(Clean("zombie"), Clean("zombie"), Clean("zombie")));
        }

        [Fact]
        public void AllowList_RequiresAtLeastOneMatch()
        {
            var allowed = Clean("friendship", "family");
            Assert.True(ParentalTagDecision.IsAllowed(Clean("friendship", "zombie-free"), Clean(), allowed));
            Assert.False(ParentalTagDecision.IsAllowed(Clean("heist"), Clean(), allowed));
            // Empty title tag set under an active allow-list -> hidden.
            Assert.False(ParentalTagDecision.IsAllowed(Clean(), Clean(), allowed));
        }

        [Theory]
        [InlineData("Sci-Fi", "sci fi")]                  // punctuation -> space
        [InlineData("SCI FI", "sci fi")]                  // case fold
        [InlineData("Pokémon", "pokemon")]                // diacritics stripped
        [InlineData("  graphic   violence ", "graphic violence")] // whitespace collapse
        [InlineData("Sci-Fi & Fantasy", "sci fi fantasy")] // & -> space, collapsed
        public void CleanTags_MatchesCoreGetCleanValueSemantics(string raw, string expected)
        {
            Assert.Contains(expected, ParentalTagDecision.CleanTags(new[] { raw }));
        }

        [Fact]
        public void CleanTags_DropsNullEmptyAndWhitespace()
        {
            Assert.Empty(ParentalTagDecision.CleanTags(new string?[] { null, "", "   ", "!!!" }));
            Assert.Empty(ParentalTagDecision.CleanTags(null));
        }

        [Fact]
        public void NormalizedForms_MatchAcrossPunctuationVariants()
        {
            // A user blocking "Sci-Fi" must match a keyword "sci fi" (and vice
            // versa) exactly as native enforcement would.
            Assert.False(ParentalTagDecision.IsAllowed(Clean("sci fi"), Clean("Sci-Fi"), Clean()));
            Assert.False(ParentalTagDecision.IsAllowed(Clean("Sci-Fi"), Clean("sci fi"), Clean()));
        }
    }
}
