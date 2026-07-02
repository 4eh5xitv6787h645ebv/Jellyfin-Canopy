using Jellyfin.Plugin.JellyfinEnhanced.Data;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Model.Querying;
using Xunit;

namespace Jellyfin.Plugin.JellyfinEnhanced.Tests.Data
{
    /// <summary>
    /// Tests for the pure query-building / mapping core of <see cref="ItemLookupService"/>.
    /// The service itself is a thin glue over ILibraryManager; these tests pin down the
    /// exact InternalItemsQuery contents produced for given inputs and the exact
    /// (case-sensitive, first-wins) pair→item mapping semantics that replaced the old
    /// raw BaseItemProviders SQL.
    /// </summary>
    public class ItemLookupServiceTests
    {
        // ---------------------------------------------------------------------
        // BuildProviderQuery (items/by-providers endpoint)
        // ---------------------------------------------------------------------

        [Fact]
        public void BuildProviderQuery_CopiesProvidersAndSetsRecursive()
        {
            var input = new Dictionary<string, string> { ["Tvdb"] = "121361", ["Imdb"] = "tt0944947" };

            var query = ItemLookupService.BuildProviderQuery(input);

            Assert.True(query.Recursive);
            Assert.NotNull(query.HasAnyProviderId);
            Assert.Equal(2, query.HasAnyProviderId!.Count);
            Assert.Equal("121361", query.HasAnyProviderId["Tvdb"]);
            Assert.Equal("tt0944947", query.HasAnyProviderId["Imdb"]);

            // Defensive copy — mutating the caller's dictionary must not leak into the query.
            input["Tvdb"] = "mutated";
            Assert.Equal("121361", query.HasAnyProviderId["Tvdb"]);
        }

        // ---------------------------------------------------------------------
        // NormalizePairs
        // ---------------------------------------------------------------------

        [Fact]
        public void NormalizePairs_DropsBlankPairsAndDuplicates()
        {
            var pairs = new List<(string Provider, string Value)>
            {
                ("Tvdb", "123"),
                ("Tvdb", "123"),      // duplicate
                ("Tvdb", ""),         // blank value: must never reach HasAnyProviderId
                ("Tvdb", "   "),      // whitespace value
                ("", "999"),          // blank provider
                ("Imdb", "tt1"),
            };

            var normalized = ItemLookupService.NormalizePairs(pairs);

            Assert.Equal(new[] { ("Tvdb", "123"), ("Imdb", "tt1") }, normalized);
        }

        // ---------------------------------------------------------------------
        // BuildBatchQueries — tests compile/run against the jf12 (net10.0) build,
        // which uses the single-query HasAnyProviderIds shape.
        // ---------------------------------------------------------------------

        [Fact]
        public void BuildBatchQueries_GroupsValuesPerProvider_SingleQuery()
        {
            var pairs = new List<(string Provider, string Value)>
            {
                ("Tvdb", "123"),
                ("Tvdb", "456"),
                ("Tvdb", "456"), // duplicate value collapses
                ("Tmdb", "999"),
                ("Imdb", "tt1"),
            };

            var queries = ItemLookupService.BuildBatchQueries(pairs);

            var query = Assert.Single(queries);
            Assert.True(query.Recursive);
            Assert.NotNull(query.HasAnyProviderIds);
            Assert.Equal(3, query.HasAnyProviderIds!.Count);
            Assert.Equal(new[] { "123", "456" }, query.HasAnyProviderIds["Tvdb"]);
            Assert.Equal(new[] { "999" }, query.HasAnyProviderIds["Tmdb"]);
            Assert.Equal(new[] { "tt1" }, query.HasAnyProviderIds["Imdb"]);

            // ProviderIds must be hydrated on the returned items or the mapping
            // step cannot work — the field drives the Provider navigation include.
            Assert.Contains(ItemFields.ProviderIds, query.DtoOptions.Fields);
        }

        [Fact]
        public void BuildBatchQueries_ProviderKeysAreCaseSensitive()
        {
            var pairs = new List<(string Provider, string Value)>
            {
                ("Tvdb", "123"),
                ("tvdb", "123"), // different casing = different provider key (BINARY collation parity)
            };

            var queries = ItemLookupService.BuildBatchQueries(pairs);

            var query = Assert.Single(queries);
            Assert.Equal(2, query.HasAnyProviderIds!.Count);
            Assert.True(query.HasAnyProviderIds.ContainsKey("Tvdb"));
            Assert.True(query.HasAnyProviderIds.ContainsKey("tvdb"));
        }

        // ---------------------------------------------------------------------
        // BuildSingleValueChunks (the jf10 / Jellyfin 10.11 query shape;
        // compiled on both targets so it stays testable here)
        // ---------------------------------------------------------------------

        [Fact]
        public void BuildSingleValueChunks_RoundRobinsOneValuePerProviderPerChunk()
        {
            var pairs = new List<(string Provider, string Value)>
            {
                ("Tvdb", "123"),
                ("Tvdb", "456"),
                ("Tvdb", "789"),
                ("Tmdb", "999"),
                ("Imdb", "tt1"),
                ("Imdb", "tt2"),
            };

            var chunks = ItemLookupService.BuildSingleValueChunks(pairs);

            // Chunk count = max distinct values of any provider (Tvdb: 3).
            Assert.Equal(3, chunks.Count);
            Assert.Equal(
                new Dictionary<string, string> { ["Tvdb"] = "123", ["Tmdb"] = "999", ["Imdb"] = "tt1" },
                chunks[0]);
            Assert.Equal(
                new Dictionary<string, string> { ["Tvdb"] = "456", ["Imdb"] = "tt2" },
                chunks[1]);
            Assert.Equal(
                new Dictionary<string, string> { ["Tvdb"] = "789" },
                chunks[2]);
        }

        [Fact]
        public void BuildSingleValueChunks_EmptyInput_NoChunks()
        {
            var chunks = ItemLookupService.BuildSingleValueChunks(new List<(string, string)>());
            Assert.Empty(chunks);
        }

        [Fact]
        public void BuildSingleValueChunks_DuplicateValuesCollapse()
        {
            var pairs = new List<(string Provider, string Value)>
            {
                ("Tvdb", "123"),
                ("Tvdb", "123"),
            };

            var chunks = ItemLookupService.BuildSingleValueChunks(pairs);

            var chunk = Assert.Single(chunks);
            Assert.Equal("123", chunk["Tvdb"]);
        }

        // ---------------------------------------------------------------------
        // MapProviderPairs
        // ---------------------------------------------------------------------

        private static Movie MovieWith(Guid id, params (string Key, string Value)[] providerIds)
        {
            var movie = new Movie { Id = id };
            foreach (var (key, value) in providerIds)
                movie.ProviderIds[key] = value;
            return movie;
        }

        [Fact]
        public void MapProviderPairs_MapsEachRequestedPairToItsItem()
        {
            var movieId = Guid.NewGuid();
            var otherId = Guid.NewGuid();
            var items = new[]
            {
                MovieWith(movieId, ("Tmdb", "603"), ("Imdb", "tt0133093")),
                MovieWith(otherId, ("Tmdb", "604")),
            };
            var pairs = new List<(string, string)> { ("Tmdb", "603"), ("Imdb", "tt0133093"), ("Tmdb", "604"), ("Tvdb", "1") };

            var map = ItemLookupService.MapProviderPairs(items, pairs);

            Assert.Equal(3, map.Count);
            Assert.Equal(movieId, map[("Tmdb", "603")]);
            Assert.Equal(movieId, map[("Imdb", "tt0133093")]);
            Assert.Equal(otherId, map[("Tmdb", "604")]);
            Assert.False(map.ContainsKey(("Tvdb", "1"))); // unmatched pair absent, like the old SQL result
        }

        [Fact]
        public void MapProviderPairs_FirstItemWinsForSharedProviderId()
        {
            var firstId = Guid.NewGuid();
            var secondId = Guid.NewGuid();
            var items = new[]
            {
                MovieWith(firstId, ("Tmdb", "603")),
                MovieWith(secondId, ("Tmdb", "603")), // duplicate edition in another library
            };

            var map = ItemLookupService.MapProviderPairs(items, new List<(string, string)> { ("Tmdb", "603") });

            Assert.Equal(firstId, map[("Tmdb", "603")]); // DistinctBy-equivalent: first wins
        }

        [Fact]
        public void MapProviderPairs_IsCaseSensitiveOnKeyAndValue()
        {
            var items = new[] { MovieWith(Guid.NewGuid(), ("Imdb", "tt0133093")) };

            var map = ItemLookupService.MapProviderPairs(
                items,
                new List<(string, string)> { ("imdb", "tt0133093"), ("Imdb", "TT0133093") });

            // Old pipeline was case-sensitive end-to-end (BINARY collation match +
            // ordinal tuple-key dictionary); the replacement must not loosen that.
            Assert.Empty(map);
        }

        [Fact]
        public void MapProviderPairs_IgnoresItemsWithoutRequestedProviders()
        {
            var items = new[] { MovieWith(Guid.NewGuid(), ("Tvdb", "42")) };

            var map = ItemLookupService.MapProviderPairs(items, new List<(string, string)> { ("Tmdb", "42") });

            Assert.Empty(map);
        }
    }
}
