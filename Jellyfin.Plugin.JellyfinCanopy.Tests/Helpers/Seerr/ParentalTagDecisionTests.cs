using System.Collections.Generic;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Helpers.Seerr
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
            Assert.True(ParentalTagDecision.IsAllowed(Clean("zombie"), Clean(), Clean(), Clean()));
            Assert.True(ParentalTagDecision.IsAllowed(Clean(), Clean(), Clean(), Clean()));
        }

        [Fact]
        public void BlockedOverlap_Blocks_OnKeywordsAndGenres()
        {
            // Keyword hit.
            Assert.False(ParentalTagDecision.IsAllowed(Clean("zombie"), Clean("comedy"), Clean("zombie"), Clean()));
            // Genre hit (the documented intent extension for BLOCKING).
            Assert.False(ParentalTagDecision.IsAllowed(Clean("friendship"), Clean("horror"), Clean("horror"), Clean()));
            // No hit on either surface.
            Assert.True(ParentalTagDecision.IsAllowed(Clean("friendship"), Clean("comedy"), Clean("zombie"), Clean()));
        }

        [Fact]
        public void BlockedWins_EvenWhenAllowedAlsoMatches()
        {
            // Core checks BlockedTags first and short-circuits.
            Assert.False(ParentalTagDecision.IsAllowed(Clean("zombie"), Clean(), Clean("zombie"), Clean("zombie")));
        }

        [Fact]
        public void AllowList_RequiresAtLeastOneKeywordMatch()
        {
            var allowed = Clean("friendship", "family");
            Assert.True(ParentalTagDecision.IsAllowed(Clean("friendship", "zombie-free"), Clean(), Clean(), allowed));
            Assert.False(ParentalTagDecision.IsAllowed(Clean("heist"), Clean(), Clean(), allowed));
            // Empty title keyword set under an active allow-list -> hidden.
            Assert.False(ParentalTagDecision.IsAllowed(Clean(), Clean(), Clean(), allowed));
        }

        [Fact]
        public void AllowList_IsNotSatisfiedByGenres_NativeParity()
        {
            // Native AllowedTags match item Tags (= imported keywords) only:
            // a "Family" GENRE must not satisfy allow-list "family", because
            // the library itself would hide that title (genres never become
            // Tags). Under-blocking is the unsafe direction for an allow-list.
            Assert.False(ParentalTagDecision.IsAllowed(
                Clean("friendship"), Clean("family", "animation"), Clean(), Clean("family")));
            // The same string as a KEYWORD does satisfy it.
            Assert.True(ParentalTagDecision.IsAllowed(
                Clean("family"), Clean(), Clean(), Clean("family")));
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
            Assert.False(ParentalTagDecision.IsAllowed(Clean("sci fi"), Clean(), Clean("Sci-Fi"), Clean()));
            Assert.False(ParentalTagDecision.IsAllowed(Clean("Sci-Fi"), Clean(), Clean("sci fi"), Clean()));
        }
    }
}
