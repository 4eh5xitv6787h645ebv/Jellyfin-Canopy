using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.JellyfinElevate.Model.Awards;
using Jellyfin.Plugin.JellyfinElevate.Services.Awards;
using Xunit;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.Services
{
    /// <summary>
    /// No-network coverage for the Wikidata provider's pure parts: the SPARQL the wins/noms
    /// templates emit, the parsing of a WDQS JSON result set, and the ceremony coverage (all
    /// requested ceremonies present; festivals correctly wins-only).
    /// </summary>
    public sealed class WikidataAwardsProviderTests
    {
        [Fact]
        public void BuildQuery_Wins_UsesAwardReceivedPredicate()
        {
            var q = WikidataAwardsProvider.BuildQuery("(wdt:P31 wd:Q19020)", "wd:Q11424 wd:Q5398426", won: true);
            Assert.Contains("p:P166 ?st", q);
            Assert.Contains("ps:P166 ?cat", q);
            Assert.DoesNotContain("P1411", q);
            Assert.Contains("(wdt:P31 wd:Q19020)", q);
            Assert.Contains("wd:Q11424 wd:Q5398426", q);
            // Must be matchable to a library item and take English labels.
            Assert.Contains("FILTER(BOUND(?imdb) || BOUND(?tmdb))", q);
            Assert.Contains("LANG(?category) = \"en\"", q);
        }

        [Fact]
        public void BuildQuery_Nominations_UsesNominatedForPredicate()
        {
            var q = WikidataAwardsProvider.BuildQuery("(wdt:P361 wd:Q1044427)", "wd:Q5398426", won: false);
            Assert.Contains("p:P1411 ?st", q);
            Assert.Contains("ps:P1411 ?cat", q);
            Assert.DoesNotContain("P166", q);
        }

        [Fact]
        public void ParseInto_ExtractsIdsYearAndMediaType_AndSetsWonFlag()
        {
            const string json = """
            {
              "results": {
                "bindings": [
                  {
                    "imdb": { "type": "literal", "value": "tt6710474" },
                    "tmdb": { "type": "literal", "value": "545611" },
                    "mediaType": { "type": "literal", "value": "movie" },
                    "category": { "type": "literal", "value": "Academy Award for Best Picture" },
                    "year": { "type": "literal", "value": "2023" }
                  }
                ]
              }
            }
            """;

            var sink = new List<AwardRow>();
            WikidataAwardsProvider.ParseInto(json, "Academy Awards", won: true, sink);

            var row = Assert.Single(sink);
            Assert.Equal("tt6710474", row.ImdbId);
            Assert.Equal("545611", row.TmdbId);
            Assert.Equal("movie", row.MediaType);
            Assert.Equal("Academy Awards", row.Ceremony);
            Assert.Equal("Academy Award for Best Picture", row.Category);
            Assert.Equal(2023, row.Year);
            Assert.True(row.Won);
        }

        [Fact]
        public void ParseInto_SkipsRowsWithNeitherId_AndToleratesMissingYear()
        {
            const string json = """
            {
              "results": {
                "bindings": [
                  { "category": { "type": "literal", "value": "Best Picture" } },
                  {
                    "tmdb": { "type": "literal", "value": "76331" },
                    "mediaType": { "type": "literal", "value": "tv" },
                    "category": { "type": "literal", "value": "Outstanding Drama Series" }
                  }
                ]
              }
            }
            """;

            var sink = new List<AwardRow>();
            WikidataAwardsProvider.ParseInto(json, "Primetime Emmy Awards", won: false, sink);

            var row = Assert.Single(sink); // the id-less row is dropped
            Assert.Null(row.ImdbId);
            Assert.Equal("76331", row.TmdbId);
            Assert.Equal("tv", row.MediaType);
            Assert.Null(row.Year); // missing year tolerated
            Assert.False(row.Won);
        }

        [Fact]
        public void ParseInto_MalformedSuccessResponse_Throws()
        {
            // A 200 with an error/proxy payload lacking results.bindings must be treated as a
            // FAILURE, not an empty success — otherwise it would falsely count as a successful
            // ceremony query and let a partial refresh publish as "complete".
            var sink = new List<AwardRow>();
            Assert.Throws<FormatException>(() =>
                WikidataAwardsProvider.ParseInto("{\"results\":{}}", "Academy Awards", won: true, sink));
            Assert.Throws<FormatException>(() =>
                WikidataAwardsProvider.ParseInto("{}", "Academy Awards", won: true, sink));
        }

        [Fact]
        public void ParseInto_EmptyBindings_IsValidZeroRows()
        {
            var sink = new List<AwardRow>();
            WikidataAwardsProvider.ParseInto("{\"results\":{\"bindings\":[]}}", "Academy Awards", won: true, sink);
            Assert.Empty(sink); // a legitimately empty result is success with zero rows, not a failure
        }

        [Fact]
        public void Ceremonies_CoverRequestedSet_AndFestivalsAreWinsOnly()
        {
            var meta = WikidataAwardsProvider.CeremonyMetaForTest;
            var names = meta.Select(m => m.Name).ToList();

            foreach (var expected in new[]
            {
                "Academy Awards", "Golden Globe Awards", "BAFTA Awards",
                "Cannes Film Festival", "Venice Film Festival", "Berlin International Film Festival",
                "Screen Actors Guild Awards", "Critics' Choice Awards", "Primetime Emmy Awards",
            })
            {
                Assert.Contains(expected, names);
            }

            // Film festivals don't record nominations in Wikidata → wins-only.
            foreach (var festival in new[] { "Cannes Film Festival", "Venice Film Festival", "Berlin International Film Festival" })
            {
                Assert.False(meta.Single(m => m.Name == festival).Nominations, $"{festival} should be wins-only");
            }

            // A ceremony that does record nominations still runs both.
            Assert.True(meta.Single(m => m.Name == "Academy Awards").Nominations);
        }
    }
}
