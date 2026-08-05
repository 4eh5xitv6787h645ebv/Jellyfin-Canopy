using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Services.Arr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Model.Querying;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class CalendarRequesterTagResolverTests
{
    [Fact]
    public void Resolve_ExactCallerTags_ProjectMovieAndTvThroughUserScopedDoubleScan()
    {
        var caller = User("caller");
        var other = User("other");
        var movie = Movie(101, $"canopy-requester:alice");
        var series = Series(101, $"canopy-requester:alice");
        var foreign = Movie(202, $"canopy-requester:bob");
        var items = new BaseItem[] { movie, series, foreign };
        var configuredBeforeTags = 0;
        var library = Library(items, (query, user) =>
        {
            Assert.Same(caller, user);
            Assert.Empty(query.Tags);
            Assert.Null(query.HasAnyProviderIds);
            Assert.False(query.GroupByPresentationUniqueKey);
            Assert.True(query.IncludeOwnedItems);
            Assert.False(query.DtoOptions.EnableImages);
            Assert.False(query.DtoOptions.EnableUserData);
            Assert.False(query.DtoOptions.AddCurrentProgram);
            Assert.Equal(
                new[] { ItemFields.ProviderIds, ItemFields.Tags },
                query.DtoOptions.Fields);
            configuredBeforeTags++;
        });
        var resolver = new CalendarRequesterTagResolver(
            library,
            new StubUserManager(caller, other));

        var result = resolver.Resolve(Config(
            $"{caller.Id:D}=alice\n{other.Id:D}=bob"), caller, CancellationToken.None);

        Assert.True(result.IsComplete);
        Assert.Equal(
            new[]
            {
                new CalendarRequesterMediaKey(101, "movie"),
                new CalendarRequesterMediaKey(101, "tv"),
            },
            result.Keys);
        Assert.Equal(4, library.GetItemsResultCallCount);
        Assert.Equal(4, configuredBeforeTags);
    }

    [Fact]
    public void Resolve_MultipleOwnersOrMalformedReservedTag_SuppressesMediaKey()
    {
        var caller = User("caller");
        var other = User("other");
        var conflictingFirst = Movie(301, "canopy-requester:alice");
        var conflictingSecond = Movie(301, "canopy-requester:bob");
        var malformed = Movie(
            302,
            "canopy-requester:alice",
            "Canopy-requester:unknown");
        var resolver = Resolver(
            new BaseItem[] { conflictingFirst, conflictingSecond, malformed },
            caller,
            other);

        var result = resolver.Resolve(Config(
            $"{caller.Id:D}=alice\n{other.Id:D}=bob"), caller, CancellationToken.None);

        Assert.True(result.IsComplete);
        Assert.Empty(result.Keys);
    }

    [Fact]
    public void Resolve_DuplicateSameRequesterTagOnItem_FailsClosedForKey()
    {
        var caller = User("caller");
        var item = Movie(
            401,
            "canopy-requester:alice",
            "canopy-requester:alice");
        var resolver = Resolver(new BaseItem[] { item }, caller);

        var result = resolver.Resolve(
            Config($"{caller.Id:D}=alice"),
            caller,
            CancellationToken.None);

        Assert.True(result.IsComplete);
        Assert.Empty(result.Keys);
    }

    [Fact]
    public void Resolve_UnmappedReservedTagOnAlternateEdition_SuppressesCandidateKey()
    {
        var caller = User("caller");
        var primary = Movie(402, "canopy-requester:alice");
        var alternate = Movie(402, "canopy-requester:unknown");
        alternate.PrimaryVersionId = primary.Id;
        var resolver = Resolver(new BaseItem[] { primary, alternate }, caller);

        var result = resolver.Resolve(
            Config($"{caller.Id:D}=alice"),
            caller,
            CancellationToken.None);

        Assert.True(result.IsComplete);
        Assert.Empty(result.Keys);
    }

    [Fact]
    public void Resolve_UserAccessProjectionExcludesInaccessibleTaggedItem()
    {
        var caller = User("caller");
        var accessible = Movie(403, "canopy-requester:alice");
        var inaccessible = Movie(404, "canopy-requester:alice");
        var library = Library(
            new BaseItem[] { accessible, inaccessible },
            (query, _) => query.ItemIds = new[] { accessible.Id });
        var resolver = new CalendarRequesterTagResolver(
            library,
            new StubUserManager(caller));

        var result = resolver.Resolve(
            Config($"{caller.Id:D}=alice"),
            caller,
            CancellationToken.None);

        Assert.True(result.IsComplete);
        Assert.Equal(
            new[] { new CalendarRequesterMediaKey(403, "movie") },
            result.Keys);
    }

    [Fact]
    public void Resolve_MissingTmdbAndUnsupportedType_PublishNothing()
    {
        var caller = User("caller");
        var missingTmdb = new Movie
        {
            Id = Guid.NewGuid(),
            Tags = new[] { "canopy-requester:alice" },
        };
        var episode = new MediaBrowser.Controller.Entities.TV.Episode
        {
            Id = Guid.NewGuid(),
            Tags = new[] { "canopy-requester:alice" },
        };
        episode.ProviderIds["Tmdb"] = "99";
        var resolver = Resolver(new BaseItem[] { missingTmdb, episode }, caller);

        var result = resolver.Resolve(
            Config($"{caller.Id:D}=alice"),
            caller,
            CancellationToken.None);

        Assert.True(result.IsComplete);
        Assert.Empty(result.Keys);
    }

    [Fact]
    public void Resolve_UnmappedCaller_ValidatesMappingsButSkipsLibraryQuery()
    {
        var caller = User("caller");
        var mapped = User("mapped");
        var library = new CountingLibraryManager
        {
            ConfigureUserAccessHook = (_, _) => throw new Xunit.Sdk.XunitException(
                "unmapped caller must not scan the library"),
        };
        var resolver = new CalendarRequesterTagResolver(
            library,
            new StubUserManager(caller, mapped));

        var result = resolver.Resolve(
            Config($"{mapped.Id:D}=mapped"),
            caller,
            CancellationToken.None);

        Assert.True(result.IsComplete);
        Assert.Empty(result.Keys);
        Assert.Equal(0, library.GetItemsResultCallCount);
    }

    [Fact]
    public void Resolve_DeletedMappedUser_InvalidatesWholeFallbackConfiguration()
    {
        var caller = User("caller");
        var deleted = User("deleted");
        var resolver = new CalendarRequesterTagResolver(
            new CountingLibraryManager(),
            new StubUserManager(caller));

        var result = resolver.Resolve(Config(
            $"{caller.Id:D}=alice\n{deleted.Id:D}=deleted"), caller, CancellationToken.None);

        Assert.False(result.IsComplete);
        Assert.Equal("mapped_user_missing", result.FailureReason);
        Assert.Empty(result.Keys);
    }

    [Fact]
    public void Resolve_MappedUserDeletedDuringScan_RejectsCompletedProjection()
    {
        var caller = User("caller");
        var library = Library(
            new BaseItem[] { Movie(405, "canopy-requester:alice") });
        var users = new StubUserManager(caller)
        {
            GetUserByIdHook = id => library.GetItemsResultCallCount < 4 && id == caller.Id
                ? caller
                : null,
        };
        var resolver = new CalendarRequesterTagResolver(library, users);

        var result = resolver.Resolve(
            Config($"{caller.Id:D}=alice"),
            caller,
            CancellationToken.None);

        Assert.False(result.IsComplete);
        Assert.Equal("mapped_user_missing", result.FailureReason);
        Assert.Empty(result.Keys);
    }

    [Fact]
    public void Resolve_OverItemBound_RejectsWithoutPublishingPrefix()
    {
        var caller = User("caller");
        var library = new CountingLibraryManager
        {
            ConfigureUserAccessHook = (_, _) => { },
            GetItemsResultHook = query => new QueryResult<BaseItem>(
                query.StartIndex,
                CalendarRequesterTagResolver.MaxTaggedItems + 1,
                Array.Empty<BaseItem>()),
        };
        var resolver = new CalendarRequesterTagResolver(
            library,
            new StubUserManager(caller));

        var result = resolver.Resolve(
            Config($"{caller.Id:D}=alice"),
            caller,
            CancellationToken.None);

        Assert.False(result.IsComplete);
        Assert.Equal("library_item_bound_exceeded", result.FailureReason);
        Assert.Empty(result.Keys);
    }

    [Fact]
    public void Resolve_ChangedSecondScan_RejectsStaleProjection()
    {
        var caller = User("caller");
        var first = Movie(501, "canopy-requester:alice");
        var second = Movie(502, "canopy-requester:alice");
        var call = 0;
        var library = new CountingLibraryManager
        {
            ConfigureUserAccessHook = (_, _) => { },
            GetItemsResultHook = query =>
            {
                call++;
                var item = call <= 2 ? first : second;
                return new QueryResult<BaseItem>(query.StartIndex, 1, new BaseItem[] { item });
            },
        };
        var resolver = new CalendarRequesterTagResolver(
            library,
            new StubUserManager(caller));

        var result = resolver.Resolve(
            Config($"{caller.Id:D}=alice"),
            caller,
            CancellationToken.None);

        Assert.False(result.IsComplete);
        Assert.Equal("library_projection_changed", result.FailureReason);
        Assert.Empty(result.Keys);
    }

    [Fact]
    public void Resolve_CancelledBeforeScan_PropagatesCancellation()
    {
        var caller = User("caller");
        var resolver = Resolver(Array.Empty<BaseItem>(), caller);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        Assert.Throws<OperationCanceledException>(() => resolver.Resolve(
            Config($"{caller.Id:D}=alice"),
            caller,
            cancellation.Token));
    }

    [Theory]
    [InlineData("", "mapping_empty")]
    [InlineData("not-a-guid=alice", "mapping_row_invalid")]
    [InlineData("00000000-0000-0000-0000-000000000001=Alice", "mapping_row_invalid")]
    [InlineData("00000000-0000-0000-0000-000000000001=ali ce", "mapping_row_invalid")]
    [InlineData("00000000-0000-0000-0000-000000000001=alice=extra", "mapping_row_malformed")]
    [InlineData("00000000-0000-0000-0000-000000000001=alice\n00000000-0000-0000-0000-000000000001=bob", "mapping_collision")]
    [InlineData("00000000-0000-0000-0000-000000000001=alice\n00000000-0000-0000-0000-000000000002=alice", "mapping_collision")]
    public void TryParseConfiguration_InvalidRowsFailClosed(string mappings, string expectedReason)
    {
        var config = Config(mappings);

        var valid = CalendarRequesterTagResolver.TryParseConfiguration(
            config,
            out var parsed,
            out var failureReason);

        Assert.False(valid);
        Assert.Null(parsed);
        Assert.Equal(expectedReason, failureReason);
    }

    [Fact]
    public void TryParseConfiguration_OverByteAndRowBoundsFailClosed()
    {
        var overBytes = Config($"00000000-0000-0000-0000-000000000001={new string('a', CalendarRequesterTagResolver.MaxMappingBytes)}");
        Assert.False(CalendarRequesterTagResolver.TryParseConfiguration(
            overBytes,
            out _,
            out var byteReason));
        Assert.Equal("mapping_bytes_exceeded", byteReason);

        var rows = Enumerable.Range(1, CalendarRequesterTagResolver.MaxMappingRows + 1)
            .Select(index => $"{new Guid(index, 0, 0, new byte[8]):D}=u{index}");
        var overRows = Config(string.Join('\n', rows));
        Assert.False(CalendarRequesterTagResolver.TryParseConfiguration(
            overRows,
            out _,
            out var rowReason));
        Assert.Equal("mapping_rows_exceeded", rowReason);
    }

    [Fact]
    public void TryParseConfiguration_PrefixAndTokenBoundsAreExact()
    {
        const string userId = "00000000-0000-0000-0000-000000000001";
        var valid = Config($"{userId}={new string('a', CalendarRequesterTagResolver.MaxTokenLength)}");
        valid.CalendarRequesterTagPrefix = $"a{new string('b', CalendarRequesterTagResolver.MaxPrefixLength - 2)}:";
        Assert.True(CalendarRequesterTagResolver.TryParseConfiguration(
            valid,
            out var parsed,
            out var validReason));
        Assert.NotNull(parsed);
        Assert.Empty(validReason);

        var overPrefix = Config($"{userId}=alice");
        overPrefix.CalendarRequesterTagPrefix = $"a{new string('b', CalendarRequesterTagResolver.MaxPrefixLength - 1)}:";
        Assert.False(CalendarRequesterTagResolver.TryParseConfiguration(
            overPrefix,
            out _,
            out var prefixReason));
        Assert.Equal("invalid_prefix", prefixReason);

        var overToken = Config($"{userId}={new string('a', CalendarRequesterTagResolver.MaxTokenLength + 1)}");
        Assert.False(CalendarRequesterTagResolver.TryParseConfiguration(
            overToken,
            out _,
            out var tokenReason));
        Assert.Equal("mapping_row_invalid", tokenReason);
    }

    private static CalendarRequesterTagResolver Resolver(
        IReadOnlyList<BaseItem> items,
        params User[] users)
        => new(Library(items), new StubUserManager(users));

    private static CountingLibraryManager Library(
        IReadOnlyList<BaseItem> items,
        Action<InternalItemsQuery, User>? configure = null)
        => new()
        {
            ConfigureUserAccessHook = configure ?? ((_, _) => { }),
            GetItemsResultHook = query =>
            {
                IEnumerable<BaseItem> filtered = items;
                if (query.ItemIds.Length > 0)
                {
                    var itemIds = query.ItemIds.ToHashSet();
                    filtered = filtered.Where(item => itemIds.Contains(item.Id));
                }

                if (query.Tags.Length > 0)
                {
                    filtered = filtered.Where(item => (item.Tags ?? Array.Empty<string>())
                        .Any(tag => query.Tags.Contains(tag, StringComparer.OrdinalIgnoreCase)));
                }

                if (query.HasAnyProviderIds is { Count: > 0 } providerFilters)
                {
                    filtered = filtered.Where(item => providerFilters.Any(filter =>
                        item.ProviderIds.TryGetValue(filter.Key, out var value)
                        && filter.Value.Contains(value, StringComparer.Ordinal)));
                }

                var filteredItems = filtered.ToArray();
                var start = query.StartIndex ?? 0;
                var limit = query.Limit ?? CalendarRequesterTagResolver.LibraryPageSize;
                var page = filteredItems.Skip(start).Take(limit).ToArray();
                return new QueryResult<BaseItem>(query.StartIndex, filteredItems.Length, page);
            },
        };

    private static PluginConfiguration Config(string mappings)
        => new()
        {
            CalendarRequesterTagFallbackEnabled = true,
            CalendarRequesterTagPrefix = "canopy-requester:",
            CalendarRequesterTagMappings = mappings,
        };

    private static User User(string name)
        => new(name, "provider", "password-provider");

    private static Movie Movie(int tmdbId, params string[] tags)
    {
        var movie = new Movie
        {
            Id = Guid.NewGuid(),
            Tags = tags,
        };
        movie.ProviderIds["Tmdb"] = tmdbId.ToString(System.Globalization.CultureInfo.InvariantCulture);
        return movie;
    }

    private static Series Series(int tmdbId, params string[] tags)
    {
        var series = new Series
        {
            Id = Guid.NewGuid(),
            Tags = tags,
        };
        series.ProviderIds["Tmdb"] = tmdbId.ToString(System.Globalization.CultureInfo.InvariantCulture);
        return series;
    }
}
