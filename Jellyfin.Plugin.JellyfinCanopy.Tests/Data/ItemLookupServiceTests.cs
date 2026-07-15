using Jellyfin.Plugin.JellyfinCanopy.Data;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Model.Querying;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Data
{
    /// <summary>
    /// Tests for the pure query-building / mapping core of <see cref="ItemLookupService"/>.
    /// They pin down the exact InternalItemsQuery contents produced for given inputs
    /// and the exact case-sensitive, all-editions pair→item mapping semantics.
    /// </summary>
    public class ItemLookupServiceTests
    {
        // ---------------------------------------------------------------------
        // BuildProviderQuery (items/by-providers endpoint, both targets)
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
        // NormalizePairs (guards the batch query against blank existence-matches)
        // ---------------------------------------------------------------------

        [Fact]
        public void NormalizePairs_DropsBlankPairsAndDuplicates()
        {
            var pairs = new List<(string Provider, string Value)>
            {
                ("Tvdb", "123"),
                ("Tvdb", "123"),      // duplicate
                ("Tvdb", ""),         // blank value: must never reach HasAnyProviderIds
                ("Tvdb", "   "),      // whitespace value
                ("", "999"),          // blank provider
                ("Imdb", "tt1"),
            };

            var normalized = ItemLookupService.NormalizePairs(pairs);

            Assert.Equal(new[] { ("Tvdb", "123"), ("Imdb", "tt1") }, normalized);
        }

        // ---------------------------------------------------------------------
        // BuildBatchQuery (batch shape: one HasAnyProviderIds query)
        // ---------------------------------------------------------------------

        [Fact]
        public void BuildBatchQuery_GroupsValuesPerProvider()
        {
            var pairs = new List<(string Provider, string Value)>
            {
                ("Tvdb", "123"),
                ("Tvdb", "456"),
                ("Tvdb", "456"), // duplicate value collapses
                ("Tmdb", "999"),
                ("Imdb", "tt1"),
            };

            var query = ItemLookupService.BuildBatchQuery(pairs);

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
        public void BuildBatchQuery_ProviderKeysAreCaseSensitive()
        {
            var pairs = new List<(string Provider, string Value)>
            {
                ("Tvdb", "123"),
                ("tvdb", "123"), // different casing = different provider key (BINARY collation parity)
            };

            var query = ItemLookupService.BuildBatchQuery(pairs);

            Assert.Equal(2, query.HasAnyProviderIds!.Count);
            Assert.True(query.HasAnyProviderIds.ContainsKey("Tvdb"));
            Assert.True(query.HasAnyProviderIds.ContainsKey("tvdb"));
        }

        // ---------------------------------------------------------------------
        // MapProviderPairs (in-memory pair→item mapping)
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
            Assert.Equal(new[] { new ItemLookupCandidate(movieId, ItemLookupKind.Movie) }, map[("Tmdb", "603")]);
            Assert.Equal(new[] { new ItemLookupCandidate(movieId, ItemLookupKind.Movie) }, map[("Imdb", "tt0133093")]);
            Assert.Equal(new[] { new ItemLookupCandidate(otherId, ItemLookupKind.Movie) }, map[("Tmdb", "604")]);
            Assert.False(map.ContainsKey(("Tvdb", "1"))); // unmatched pair absent, like the raw SQL result
        }

        [Fact]
        public void MapProviderPairs_PreservesEveryEditionForSharedProviderId()
        {
            var firstId = Guid.NewGuid();
            var secondId = Guid.NewGuid();
            var items = new[]
            {
                MovieWith(firstId, ("Tmdb", "603")),
                MovieWith(secondId, ("Tmdb", "603")), // duplicate edition in another library
            };

            var map = ItemLookupService.MapProviderPairs(items, new List<(string, string)> { ("Tmdb", "603") });

            Assert.Equal(
                new[] { firstId, secondId }.OrderBy(id => id),
                map[("Tmdb", "603")].Select(candidate => candidate.ItemId));
        }

        [Fact]
        public void MapProviderPairs_PreservesCandidateMediaType()
        {
            var movie = MovieWith(Guid.NewGuid(), ("Tmdb", "42"));
            var series = new Series { Id = Guid.NewGuid() };
            series.ProviderIds["Tmdb"] = "42";
            var episode = new Episode { Id = Guid.NewGuid() };
            episode.ProviderIds["Tvdb"] = "99";

            var map = ItemLookupService.MapProviderPairs(
                new BaseItem[] { series, movie, episode },
                new List<(string, string)> { ("Tmdb", "42"), ("Tvdb", "99") });

            Assert.Contains(map[("Tmdb", "42")], candidate => candidate.Kind == ItemLookupKind.Movie);
            Assert.Contains(map[("Tmdb", "42")], candidate => candidate.Kind == ItemLookupKind.Series);
            Assert.Equal(ItemLookupKind.Episode, Assert.Single(map[("Tvdb", "99")]).Kind);
        }

        [Fact]
        public void MapProviderPairs_IsCaseSensitiveOnKeyAndValue()
        {
            var items = new[] { MovieWith(Guid.NewGuid(), ("Imdb", "tt0133093")) };

            var map = ItemLookupService.MapProviderPairs(
                items,
                new List<(string, string)> { ("imdb", "tt0133093"), ("Imdb", "TT0133093") });

            // The lookup is case-sensitive end-to-end (BINARY-collation storage +
            // ordinal tuple-key dictionary); the mapping must not loosen that.
            Assert.Empty(map);
        }

        [Fact]
        public void MapProviderPairs_IgnoresItemsWithoutRequestedProviders()
        {
            var items = new[] { MovieWith(Guid.NewGuid(), ("Tvdb", "42")) };

            var map = ItemLookupService.MapProviderPairs(items, new List<(string, string)> { ("Tmdb", "42") });

            Assert.Empty(map);
        }

        [Fact]
        public void GetAccessibleItemIdsBatch_ConfiguresUserAccessBeforeSettingItemIds()
        {
            var requested = Guid.NewGuid();
            var accessible = Guid.NewGuid();
            var user = new User("calendar-user", "provider", "password-provider");
            var configuredBeforeIds = false;
            var library = new CountingLibraryManager
            {
                ConfigureUserAccessHook = (query, configuredUser) =>
                {
                    configuredBeforeIds = query.ItemIds.Length == 0 && ReferenceEquals(user, configuredUser);
                    query.TopParentIds = new[] { Guid.NewGuid() };
                },
                GetItemIdsHook = query =>
                {
                    Assert.True(configuredBeforeIds);
                    Assert.Equal(new[] { requested }, query.ItemIds);
                    Assert.NotEmpty(query.TopParentIds);
                    return new[] { accessible };
                }
            };

            var result = new ItemLookupService(library)
                .GetAccessibleItemIdsBatch(new[] { requested }, user);

            Assert.Equal(new HashSet<Guid> { accessible }, result);
        }
    }
}
