using System.Collections;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Data;
using Jellyfin.Plugin.JellyfinCanopy.ScheduledTasks;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Model.Entities;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class WatchlistLibraryResolverTests
{
    [Fact]
    public void Resolve_InaccessibleLowestId_SelectsAccessibleAlternate()
    {
        var user = User("alternate-user");
        var inaccessible = Movie(
            "00000000-0000-0000-0000-000000000001",
            101,
            "Restricted cut");
        var accessible = Movie(
            "00000000-0000-0000-0000-000000000002",
            101,
            "Accessible cut");
        var lookup = StubItemLookupService.FromItems(
            new BaseItem[] { inaccessible, accessible },
            (ids, _) => ids.Where(id => id == accessible.Id).ToHashSet());
        var resolver = new WatchlistLibraryResolver(
            new CountingLibraryManager
            {
                GetItemListHook = _ => new BaseItem[] { inaccessible, accessible },
            },
            lookup);

        var batch = resolver.Resolve(
            new[] { new WatchlistMediaKey("movie", 101) },
            new[] { user });

        Assert.True(batch.IsComplete);
        Assert.Same(
            accessible,
            batch.Get(user, new WatchlistMediaKey("movie", 101)).SelectedItem);
        Assert.Equal(1, lookup.ProviderQueryCount);
        Assert.Equal(1, lookup.AccessQueryCount);
    }

    [Fact]
    public void Resolve_NoAccessibleEdition_FailsClosed()
    {
        var user = User("no-access-user");
        var movie = Movie(
            "00000000-0000-0000-0000-000000000003",
            102,
            "Restricted movie");
        var lookup = StubItemLookupService.FromItems(
            new BaseItem[] { movie },
            (_, _) => new HashSet<Guid>());
        var resolver = new WatchlistLibraryResolver(new CountingLibraryManager(), lookup);

        var match = resolver.Resolve(
                new[] { new WatchlistMediaKey("movie", 102) },
                new[] { user },
                new BaseItem[] { movie })
            .Get(user, new WatchlistMediaKey("movie", 102));

        Assert.Equal(WatchlistLibraryMatchState.Inaccessible, match.State);
        Assert.Null(match.SelectedItem);
    }

    [Fact]
    public void Resolve_MovieAndTvNamespacesRemainTypeCorrect()
    {
        var user = User("namespace-user");
        var movie = Movie(
            "00000000-0000-0000-0000-000000000004",
            103,
            "Movie namespace");
        var series = new Series
        {
            Id = Guid.Parse("00000000-0000-0000-0000-000000000005"),
            Name = "TV namespace",
        };
        series.ProviderIds["Tmdb"] = "103";
        var items = new BaseItem[] { movie, series };
        var lookup = StubItemLookupService.FromItems(items);
        var resolver = new WatchlistLibraryResolver(new CountingLibraryManager(), lookup);

        var batch = resolver.Resolve(
            new[]
            {
                new WatchlistMediaKey("movie", 103),
                new WatchlistMediaKey("tv", 103),
            },
            new[] { user },
            items);

        Assert.Same(movie, batch.Get(user, new WatchlistMediaKey("movie", 103)).SelectedItem);
        Assert.Same(series, batch.Get(user, new WatchlistMediaKey("tv", 103)).SelectedItem);
    }

    [Fact]
    public void Resolve_ProviderPairLimitFailsClosedBeforeAccessProjection()
    {
        var user = User("bounded-user");
        var lookup = new StubItemLookupService();
        var resolver = new WatchlistLibraryResolver(new CountingLibraryManager(), lookup);
        var keys = Enumerable.Range(
                1,
                WatchlistLibraryResolver.MaximumProviderPairs + 1)
            .Select(static tmdbId => new WatchlistMediaKey("movie", tmdbId))
            .ToList();

        var batch = resolver.Resolve(keys, new[] { user });

        Assert.False(batch.IsComplete);
        Assert.Equal(1, lookup.ProviderQueryCount);
        Assert.Equal(0, lookup.AccessQueryCount);
    }

    [Fact]
    public void Resolve_UserKeyCrossProductLimitFailsBeforeConstructingOrQuerying()
    {
        var users = Enumerable.Range(1, 501)
            .Select(index => User($"bounded-user-{index}"))
            .ToList();
        var keys = Enumerable.Range(1, 200)
            .Select(static tmdbId => new WatchlistMediaKey("movie", tmdbId))
            .ToList();
        var lookup = new StubItemLookupService();
        var resolver = new WatchlistLibraryResolver(new CountingLibraryManager(), lookup);

        var batch = resolver.Resolve(keys, users);

        Assert.False(batch.IsComplete);
        Assert.Equal(0, lookup.ProviderQueryCount);
        Assert.Equal(0, lookup.AccessQueryCount);
    }

    [Fact]
    public void Resolve_AggregateCandidateProjectionLimitFailsBeforeAccessQueries()
    {
        var users = new[] { User("first"), User("second"), User("third") };
        var candidates = Enumerable.Range(1, 83_334)
            .Select(_ => new ItemLookupCandidate(
                Guid.NewGuid(),
                ItemLookupKind.Movie,
                null,
                false))
            .ToList();
        var lookup = new StubItemLookupService(
            candidateProjection: providers => providers.ToDictionary(
                static pair => pair,
                _ => (IReadOnlyList<ItemLookupCandidate>)candidates));
        var resolver = new WatchlistLibraryResolver(new CountingLibraryManager(), lookup);

        var batch = resolver.Resolve(
            new[] { new WatchlistMediaKey("movie", 301) },
            users);

        Assert.False(batch.IsComplete);
        Assert.Equal(1, lookup.ProviderQueryCount);
        Assert.Equal(0, lookup.AccessQueryCount);
    }

    [Fact]
    public void Resolve_RepeatedRequestsEnumerateKnownEditionsOncePerDistinctMediaKey()
    {
        var user = User("repeated-binding-user");
        var key = new WatchlistMediaKey("movie", 302);
        var movie = Movie(
            "00000000-0000-0000-0000-000000000008",
            302,
            "Repeated binding movie");
        var knownEditions = new CountingReadOnlyCollection(new BaseItem[] { movie });
        var lookup = StubItemLookupService.FromItems(new BaseItem[] { movie });
        var resolver = new WatchlistLibraryResolver(new CountingLibraryManager(), lookup);
        var requests = Enumerable.Repeat(
                new WatchlistLibraryRequest(user, key),
                20)
            .ToList();

        var batch = resolver.Resolve(
            requests,
            new Dictionary<WatchlistMediaKey, CountingReadOnlyCollection>
            {
                [key] = knownEditions,
            });

        Assert.True(batch.IsComplete);
        Assert.Same(movie, batch.Get(user, key).SelectedItem);
        Assert.Equal(1, knownEditions.EnumerationCount);
        Assert.Equal(1, lookup.ProviderQueryCount);
        Assert.Equal(1, lookup.AccessQueryCount);
    }

    [Fact]
    public void Resolve_OversizedKnownEditionProjectionFailsBeforeEnumerationOrProviderQuery()
    {
        var user = User("oversized-known-user");
        var key = new WatchlistMediaKey("movie", 303);
        var knownEditions = new CountingReadOnlyCollection(
            Array.Empty<BaseItem>(),
            WatchlistLibraryResolver.MaximumCandidates + 1,
            throwOnEnumeration: true);
        var lookup = new StubItemLookupService();
        var resolver = new WatchlistLibraryResolver(new CountingLibraryManager(), lookup);

        var batch = resolver.Resolve(
            new[] { new WatchlistLibraryRequest(user, key) },
            new Dictionary<WatchlistMediaKey, CountingReadOnlyCollection>
            {
                [key] = knownEditions,
            });

        Assert.False(batch.IsComplete);
        Assert.Equal(0, knownEditions.EnumerationCount);
        Assert.Equal(0, lookup.ProviderQueryCount);
        Assert.Equal(0, lookup.AccessQueryCount);
    }

    [Fact]
    public void PrepareDispatchSelections_RepeatedBindingsEnumerateDistinctEditionSetLinearly()
    {
        var user = User("linear-selection-user");
        var key = new WatchlistMediaKey("movie", 304);
        var movie = Movie(
            "00000000-0000-0000-0000-000000000009",
            304,
            "Linear selection movie");
        var editions = new CountingReadOnlyList(new BaseItem[] { movie });
        var library = new WatchlistLibraryBatch(
            new Dictionary<Guid, IReadOnlyDictionary<WatchlistMediaKey, WatchlistLibraryMatch>>
            {
                [user.Id] = new Dictionary<WatchlistMediaKey, WatchlistLibraryMatch>
                {
                    [key] = new WatchlistLibraryMatch(
                        WatchlistLibraryMatchState.Accessible,
                        editions),
                },
            },
            true);
        var userData = new StubUserDataManager
        {
            GetUserDataBatchHook = (items, _) => items.ToDictionary(
                static item => item.Id,
                item => new UserItemData
                {
                    Key = item.Id.ToString("N"),
                    Likes = true,
                }),
        };
        var repeatedBindings = Enumerable.Repeat(
                new WatchlistLibraryRequest(user, key),
                20_000)
            .ToList();

        var selections = JellyfinToSeerrWatchlistSyncTask.PrepareDispatchSelections(
            repeatedBindings,
            library,
            userData,
            CancellationToken.None);

        Assert.Same(movie, Assert.Single(selections).Value);
        Assert.Equal(2, editions.EnumerationCount);
        Assert.Equal(1, userData.GetUserDataBatchCallCount);
        Assert.Equal(1, userData.GetUserDataBatchItemCount);
    }

    [Fact]
    public void Resolve_MaterializesCandidateItemsInOneThousandItemBatches()
    {
        var user = User("materialization-user");
        var key = new WatchlistMediaKey("movie", 305);
        var items = Enumerable.Range(1, WatchlistLibraryResolver.MaterializationBatchSize + 1)
            .Select(index => Movie(
                $"00000000-0000-0000-0001-{index.ToString("D12", System.Globalization.CultureInfo.InvariantCulture)}",
                305,
                $"Materialized {index}"))
            .Cast<BaseItem>()
            .ToList();
        var byId = items.ToDictionary(static item => item.Id);
        var lookup = StubItemLookupService.FromItems(items);
        var library = new CountingLibraryManager
        {
            GetItemListHook = query =>
            {
                Assert.InRange(
                    query.ItemIds.Length,
                    1,
                    WatchlistLibraryResolver.MaterializationBatchSize);
                Assert.Equal(query.ItemIds.Length + 1, query.Limit);
                return query.ItemIds.Select(id => byId[id]).ToList();
            },
        };
        var resolver = new WatchlistLibraryResolver(library, lookup);

        var batch = resolver.Resolve(new[] { key }, new[] { user });

        Assert.True(batch.IsComplete);
        Assert.Equal(items.Count, batch.Get(user, key).AccessibleItems.Count);
        Assert.Equal(2, library.GetItemListCallCount);
    }

    [Fact]
    public void Resolve_CancellationAfterAccessQueryStopsBeforeNextUser()
    {
        using var cancellation = new CancellationTokenSource();
        var first = User("cancel-first");
        var second = User("cancel-second");
        var movie = Movie(
            "00000000-0000-0000-0000-000000000010",
            306,
            "Cancellation movie");
        var lookup = StubItemLookupService.FromItems(new BaseItem[] { movie });
        lookup.BeforeAccessQuery = count =>
        {
            if (count == 1)
            {
                cancellation.Cancel();
            }
        };
        var resolver = new WatchlistLibraryResolver(new CountingLibraryManager(), lookup);

        Assert.Throws<OperationCanceledException>(() => resolver.Resolve(
            new[] { new WatchlistMediaKey("movie", 306) },
            new[] { first, second },
            new BaseItem[] { movie },
            cancellation.Token));
        Assert.Equal(1, lookup.AccessQueryCount);
    }

    [Theory]
    [InlineData(WatchlistLibraryResolver.AccessProjectionBatchSize, 1)]
    [InlineData(WatchlistLibraryResolver.AccessProjectionBatchSize + 1, 2)]
    public void GetAccessibleItemIdsBounded_ExactAndMaxPlusOneStayWithinBatchSize(
        int itemCount,
        int expectedQueries)
    {
        var user = User("bounded-access-user");
        var itemIds = Enumerable.Range(1, itemCount)
            .Select(DeterministicGuid)
            .Reverse()
            .ToList();
        var lookup = new StubItemLookupService();
        var resolver = new WatchlistLibraryResolver(new CountingLibraryManager(), lookup);

        var accessibleIds = resolver.GetAccessibleItemIdsBounded(
            itemIds,
            user,
            CancellationToken.None);

        Assert.Equal(expectedQueries, lookup.AccessQueryCount);
        Assert.All(
            lookup.AccessQueryItemIds,
            query => Assert.InRange(
                query.Count,
                1,
                WatchlistLibraryResolver.AccessProjectionBatchSize));
        Assert.Equal(
            itemIds.OrderBy(static id => id),
            lookup.AccessQueryItemIds.SelectMany(static query => query));
        Assert.True(accessibleIds.SetEquals(itemIds));
    }

    [Fact]
    public void Resolve_MaxPlusOneAccessProjectionUsesTwoBoundedQueries()
    {
        var user = User("resolve-bounded-access-user");
        var key = new WatchlistMediaKey("movie", 307);
        var items = Enumerable.Range(
                1,
                WatchlistLibraryResolver.AccessProjectionBatchSize + 1)
            .Select(index => Movie(
                DeterministicGuid(index).ToString(),
                key.TmdbId,
                $"Bounded resolve {index}"))
            .Cast<BaseItem>()
            .ToList();
        var lookup = StubItemLookupService.FromItems(items);
        var resolver = new WatchlistLibraryResolver(new CountingLibraryManager(), lookup);

        var batch = resolver.Resolve(new[] { key }, new[] { user }, items);

        Assert.True(batch.IsComplete);
        Assert.Equal(items.Count, batch.Get(user, key).AccessibleItems.Count);
        Assert.Equal(2, lookup.AccessQueryCount);
        Assert.All(
            lookup.AccessQueryItemIds,
            query => Assert.InRange(
                query.Count,
                1,
                WatchlistLibraryResolver.AccessProjectionBatchSize));
    }

    [Fact]
    public void RevalidateAccessibleItems_MaxPlusOneUsesTwoBoundedQueries()
    {
        var user = User("revalidate-bounded-access-user");
        var key = new WatchlistMediaKey("movie", 308);
        var items = Enumerable.Range(
                1,
                WatchlistLibraryResolver.AccessProjectionBatchSize + 1)
            .Select(index => Movie(
                DeterministicGuid(index).ToString(),
                key.TmdbId,
                $"Bounded revalidation {index}"))
            .Cast<BaseItem>()
            .ToList();
        var lookup = new StubItemLookupService();
        var resolver = new WatchlistLibraryResolver(new CountingLibraryManager(), lookup);

        var accessibleItems = resolver.RevalidateAccessibleItems(
            user,
            key,
            items,
            CancellationToken.None);

        Assert.Equal(items.Count, accessibleItems.Count);
        Assert.Equal(2, lookup.AccessQueryCount);
        Assert.All(
            lookup.AccessQueryItemIds,
            query => Assert.InRange(
                query.Count,
                1,
                WatchlistLibraryResolver.AccessProjectionBatchSize));
    }

    [Fact]
    public void GetAccessibleItemIdsBounded_CancellationStopsSingleUserBetweenBatches()
    {
        using var cancellation = new CancellationTokenSource();
        var user = User("cancel-bounded-access-user");
        var itemIds = Enumerable.Range(
                1,
                WatchlistLibraryResolver.AccessProjectionBatchSize + 1)
            .Select(DeterministicGuid)
            .ToList();
        var lookup = new StubItemLookupService();
        lookup.BeforeAccessQuery = count =>
        {
            if (count == 1)
            {
                cancellation.Cancel();
            }
        };
        var resolver = new WatchlistLibraryResolver(new CountingLibraryManager(), lookup);

        Assert.Throws<OperationCanceledException>(() => resolver.GetAccessibleItemIdsBounded(
            itemIds,
            user,
            cancellation.Token));
        Assert.Equal(1, lookup.AccessQueryCount);
        Assert.Equal(
            WatchlistLibraryResolver.AccessProjectionBatchSize,
            Assert.Single(lookup.AccessQueryItemIds).Count);
    }

    [Fact]
    public void SelectPreferred_ChoosesAlreadyLikedAccessibleEdition()
    {
        var lowerId = Movie(
            "00000000-0000-0000-0000-000000000006",
            104,
            "Unliked cut");
        var higherId = Movie(
            "00000000-0000-0000-0000-000000000007",
            104,
            "Liked cut");
        var match = new WatchlistLibraryMatch(
            WatchlistLibraryMatchState.Accessible,
            new BaseItem[] { lowerId, higherId });
        var lowerData = new UserItemData { Key = lowerId.Id.ToString("N"), Likes = false };
        var higherData = new UserItemData { Key = higherId.Id.ToString("N"), Likes = true };

        var selection = match.SelectPreferred(new Dictionary<Guid, UserItemData>
        {
            [lowerId.Id] = lowerData,
            [higherId.Id] = higherData,
        });

        Assert.NotNull(selection);
        Assert.Same(higherId, selection.Item);
        Assert.Same(higherData, selection.UserData);
    }

    private static User User(string name)
        => new(name, "provider", "password-provider");

    private static Guid DeterministicGuid(int index)
        => Guid.Parse($"00000000-0000-0000-0002-{index.ToString("D12", System.Globalization.CultureInfo.InvariantCulture)}");

    private static Movie Movie(string id, int tmdbId, string name)
    {
        var movie = new Movie
        {
            Id = Guid.Parse(id),
            Name = name,
        };
        movie.ProviderIds["Tmdb"] = tmdbId.ToString(
            System.Globalization.CultureInfo.InvariantCulture);
        return movie;
    }

    private sealed class CountingReadOnlyCollection : IReadOnlyCollection<BaseItem>
    {
        private readonly IReadOnlyList<BaseItem> _items;
        private readonly bool _throwOnEnumeration;

        public CountingReadOnlyCollection(
            IReadOnlyList<BaseItem> items,
            int? reportedCount = null,
            bool throwOnEnumeration = false)
        {
            _items = items;
            Count = reportedCount ?? items.Count;
            _throwOnEnumeration = throwOnEnumeration;
        }

        public int Count { get; }

        public int EnumerationCount { get; private set; }

        public IEnumerator<BaseItem> GetEnumerator()
        {
            EnumerationCount++;
            if (_throwOnEnumeration)
            {
                throw new Xunit.Sdk.XunitException("The oversized collection must not be enumerated.");
            }

            return _items.GetEnumerator();
        }

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    private sealed class CountingReadOnlyList : IReadOnlyList<BaseItem>
    {
        private readonly IReadOnlyList<BaseItem> _items;

        public CountingReadOnlyList(IReadOnlyList<BaseItem> items)
        {
            _items = items;
        }

        public int Count => _items.Count;

        public BaseItem this[int index] => _items[index];

        public int EnumerationCount { get; private set; }

        public IEnumerator<BaseItem> GetEnumerator()
        {
            EnumerationCount++;
            return _items.GetEnumerator();
        }

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }
}
