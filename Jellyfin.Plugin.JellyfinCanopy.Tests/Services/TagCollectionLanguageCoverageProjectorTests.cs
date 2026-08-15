using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinCanopy.Model;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Model.Querying;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class TagCollectionLanguageCoverageProjectorTests
{
    [Fact]
    public void SpoilerOmission_PreservesOrdinaryCoverage_ButRemovesAllMemberFactsWhenEffective()
    {
        var coverage = new Dictionary<string, TagCollectionLanguageCoverage>
        {
            [Guid.NewGuid().ToString("N")] = new()
            {
                EligibleMemberCount = 2,
                ObservedMemberCount = 2,
                Complete = true,
                FullLanguages = new[] { "en" },
            },
        };

        TagCacheController.ApplyCollectionCoverageSpoilerOmission(coverage, effectiveGenreStrip: false);
        Assert.Single(coverage);

        TagCacheController.ApplyCollectionCoverageSpoilerOmission(coverage, effectiveGenreStrip: true);
        Assert.Empty(coverage);
    }

    [Fact]
    public void ProjectContainers_UsesCallerFolderScopeBeforeItemIds_AndNeverLeaksAcrossUsers()
    {
        var collectionId = Guid.NewGuid();
        var firstId = Guid.NewGuid();
        var secondId = Guid.NewGuid();
        var firstTop = Guid.NewGuid();
        var secondTop = Guid.NewGuid();
        var saved = DateTime.UtcNow;
        var movies = new Dictionary<Guid, BaseItem>
        {
            [firstId] = new StubMovie { Id = firstId, DateLastSaved = saved },
            [secondId] = new StubMovie { Id = secondId, DateLastSaved = saved },
        };
        var linked = new StubLinkedChildrenService
        {
            GetChildrenHook = (_, _) => new[] { firstId, secondId },
        };
        var library = new CountingLibraryManager();
        using var fixture = Fixture.Create(library, linked);
        library.ConfigureUserAccessHook = (query, user) =>
        {
            Assert.Empty(query.ItemIds);
            query.TopParentIds = new[] { user.Id == fixture.FirstUser.Id ? firstTop : secondTop };
        };
        library.GetItemsResultHook = query =>
        {
            var allowed = query.TopParentIds.Single() == firstTop ? firstId : secondId;
            var rows = query.ItemIds.Where(id => id == allowed).Select(id => movies[id]).ToArray();
            return new QueryResult<BaseItem>(0, rows.Length, rows);
        };
        fixture.SeedMovie(firstId, saved.Ticks, "eng");
        fixture.SeedMovie(secondId, saved.Ticks, "jpn");
        var projector = new TagCollectionLanguageCoverageProjector(library, fixture.Cache, NullLogger.Instance);

        var first = projector.ProjectContainers(fixture.FirstUser, new[] { new BoxSet { Id = collectionId } }, default)[Key(collectionId)];
        var second = projector.ProjectContainers(fixture.SecondUser, new[] { new BoxSet { Id = collectionId } }, default)[Key(collectionId)];

        Assert.Equal(1, first.EligibleMemberCount);
        Assert.Equal(new[] { "en" }, first.FullLanguages);
        Assert.DoesNotContain("ja", first.FullLanguages.Concat(first.PartialLanguages).Concat(first.UnknownLanguages));
        Assert.Equal(1, second.EligibleMemberCount);
        Assert.Equal(new[] { "ja" }, second.FullLanguages);
        Assert.DoesNotContain("en", second.FullLanguages.Concat(second.PartialLanguages).Concat(second.UnknownLanguages));
    }

    [Fact]
    public void ProjectContainers_PropagatesAccessibleMemberOriginalLanguageOnly()
    {
        var collectionId = Guid.NewGuid();
        var movieId = Guid.NewGuid();
        var saved = DateTime.UtcNow;
        var movie = new StubMovie { Id = movieId, DateLastSaved = saved };
        var linked = new StubLinkedChildrenService { GetChildrenHook = (_, _) => new[] { movieId } };
        var library = new CountingLibraryManager();
        using var fixture = Fixture.Create(library, linked);
        library.ConfigureUserAccessHook = static (_, _) => { };
        library.GetItemsResultHook = _ => new QueryResult<BaseItem>(0, 1, new BaseItem[] { movie });
        fixture.SeedMovieWithOriginal(movieId, saved.Ticks, "pt-BR", "pt-br", "eng");

        var result = new TagCollectionLanguageCoverageProjector(
            library, fixture.Cache, NullLogger.Instance)
            .ProjectContainers(fixture.FirstUser, new[] { new BoxSet { Id = collectionId } }, default)[Key(collectionId)];

        Assert.Equal(new[] { "pt-BR" }, result.OriginalLanguages);
    }

    [Fact]
    public void ProjectContainers_PagesFiveHundredIds_AndClassifiesStaleEvidenceUnknown()
    {
        var collectionId = Guid.NewGuid();
        var saved = DateTime.UtcNow;
        var movies = Enumerable.Range(0, 501).Select(_ => new StubMovie
        {
            Id = Guid.NewGuid(),
            DateLastSaved = saved,
        }).ToArray();
        var linked = new StubLinkedChildrenService { GetChildrenHook = (_, _) => movies.Select(static item => item.Id).ToArray() };
        var library = new CountingLibraryManager
        {
            ConfigureUserAccessHook = static (_, _) => { },
            GetItemsResultHook = query => new QueryResult<BaseItem>(0, query.ItemIds.Length, query.ItemIds.Select(id => movies.Single(movie => movie.Id == id)).ToArray()),
        };
        using var fixture = Fixture.Create(library, linked);
        foreach (var movie in movies) fixture.SeedMovie(movie.Id, saved.Ticks, "eng");
        fixture.SeedMovie(movies[^1].Id, saved.Ticks - 1, "jpn");

        var result = new TagCollectionLanguageCoverageProjector(library, fixture.Cache, NullLogger.Instance)
            .ProjectContainers(fixture.FirstUser, new[] { new BoxSet { Id = collectionId } }, default)[Key(collectionId)];

        Assert.Equal(2, library.GetItemsResultCallCount);
        Assert.Equal(501, result.EligibleMemberCount);
        Assert.Equal(500, result.ObservedMemberCount);
        Assert.False(result.Complete);
        Assert.Equal(new[] { "en", "ja" }, result.UnknownLanguages);
    }

    [Fact]
    public void ProjectContainers_EdgeCapStopsBeforeLaterCollectionOrMovieQueries()
    {
        var firstCollection = Guid.NewGuid();
        var secondCollection = Guid.NewGuid();
        var linked = new StubLinkedChildrenService
        {
            GetChildrenHook = (_, _) => Enumerable.Range(0, TagCollectionLanguageCoverageProjector.MaximumMembershipEdgesPerRequest + 1)
                .Select(_ => Guid.NewGuid()).ToArray(),
        };
        var library = new CountingLibraryManager();
        using var fixture = Fixture.Create(library, linked);

        var result = new TagCollectionLanguageCoverageProjector(library, fixture.Cache, NullLogger.Instance)
            .ProjectContainers(fixture.FirstUser, new BaseItem[] { new BoxSet { Id = firstCollection }, new BoxSet { Id = secondCollection } }, default);

        Assert.Equal(1, linked.GetChildrenCallCount);
        Assert.Equal(0, library.GetItemsResultCallCount);
        Assert.All(result.Values, coverage =>
        {
            Assert.False(coverage.Complete);
            Assert.True(coverage.Truncated);
            Assert.Null(coverage.EligibleMemberCount);
            Assert.Null(coverage.OmittedLanguageCount);
        });
    }

    [Fact]
    public void ProjectContainers_ExactlyEdgeCapIsProcessed()
    {
        var collectionId = Guid.NewGuid();
        var linked = new StubLinkedChildrenService
        {
            GetChildrenHook = (_, _) => Enumerable.Range(0, TagCollectionLanguageCoverageProjector.MaximumMembershipEdgesPerRequest)
                .Select(_ => Guid.NewGuid()).ToArray(),
        };
        var library = new CountingLibraryManager
        {
            ConfigureUserAccessHook = static (_, _) => { },
            GetItemsResultHook = static _ => new QueryResult<BaseItem>(0, 0, Array.Empty<BaseItem>()),
        };
        using var fixture = Fixture.Create(library, linked);

        var result = new TagCollectionLanguageCoverageProjector(library, fixture.Cache, NullLogger.Instance)
            .ProjectContainers(fixture.FirstUser, new[] { new BoxSet { Id = collectionId } }, default)[Key(collectionId)];

        Assert.True(result.Complete);
        Assert.False(result.Truncated);
        Assert.Equal(0, result.EligibleMemberCount);
        Assert.Equal(TagCollectionLanguageCoverageProjector.MaximumMembershipEdgesPerRequest / TagCollectionLanguageCoverageProjector.PageSize, library.GetItemsResultCallCount);
    }

    [Fact]
    public void ProjectContainers_WrongCacheTypeIsUnknown_AndLanguageEnvelopeIsBounded()
    {
        var collectionId = Guid.NewGuid();
        var movieId = Guid.NewGuid();
        var saved = DateTime.UtcNow;
        var movie = new StubMovie { Id = movieId, DateLastSaved = saved };
        var linked = new StubLinkedChildrenService { GetChildrenHook = (_, _) => new[] { movieId } };
        var library = new CountingLibraryManager
        {
            ConfigureUserAccessHook = static (_, _) => { },
            GetItemsResultHook = _ => new QueryResult<BaseItem>(0, 1, new BaseItem[] { movie }),
        };
        using var fixture = Fixture.Create(library, linked);
        fixture.Cache.SeedEntryForTest(Key(movieId), new TagCacheEntry
        {
            Type = "Episode",
            SourceRevision = saved.Ticks,
            AudioLanguages = Enumerable.Range(0, 33).Select(index => $"q{(char)('a' + index / 26)}{(char)('a' + index % 26)}").ToArray(),
        });

        var unknown = new TagCollectionLanguageCoverageProjector(library, fixture.Cache, NullLogger.Instance)
            .ProjectContainers(fixture.FirstUser, new[] { new BoxSet { Id = collectionId } }, default)[Key(collectionId)];
        Assert.False(unknown.Complete);
        Assert.Equal(1, unknown.EligibleMemberCount);
        Assert.Equal(0, unknown.ObservedMemberCount);

        fixture.SeedMovie(movieId, saved.Ticks,
            Enumerable.Range(0, 33).Select(index => $"q{(char)('a' + index / 26)}{(char)('a' + index % 26)}").ToArray());
        var bounded = new TagCollectionLanguageCoverageProjector(library, fixture.Cache, NullLogger.Instance)
            .ProjectContainers(fixture.FirstUser, new[] { new BoxSet { Id = collectionId } }, default)[Key(collectionId)];
        Assert.True(bounded.Truncated);
        Assert.Equal(1, bounded.OmittedLanguageCount);
        Assert.Equal(32, bounded.FullLanguages.Length);
        Assert.Equal(bounded.FullLanguages.OrderBy(static value => value, StringComparer.Ordinal), bounded.FullLanguages);
    }

    [Fact]
    public void ProjectContainers_CancellationBetweenBatchesNeverPublishesPartialCoverage()
    {
        var collectionId = Guid.NewGuid();
        var movies = Enumerable.Range(0, 501).Select(_ => new StubMovie { Id = Guid.NewGuid() }).ToArray();
        var linked = new StubLinkedChildrenService { GetChildrenHook = (_, _) => movies.Select(static movie => movie.Id).ToArray() };
        using var cancellation = new System.Threading.CancellationTokenSource();
        var library = new CountingLibraryManager
        {
            ConfigureUserAccessHook = static (_, _) => { },
            GetItemsResultHook = query =>
            {
                cancellation.Cancel();
                return new QueryResult<BaseItem>(0, query.ItemIds.Length, query.ItemIds.Select(id => movies.Single(movie => movie.Id == id)).ToArray());
            },
        };
        using var fixture = Fixture.Create(library, linked);

        Assert.Throws<OperationCanceledException>(() => new TagCollectionLanguageCoverageProjector(library, fixture.Cache, NullLogger.Instance)
            .ProjectContainers(fixture.FirstUser, new[] { new BoxSet { Id = collectionId } }, cancellation.Token));
        Assert.Equal(1, library.GetItemsResultCallCount);
    }

    [Theory]
    [InlineData("nonmovie")]
    [InlineData("virtual")]
    [InlineData("foreign")]
    [InlineData("duplicate")]
    public void ProjectContainers_MalformedRowsFailClosed(string mode)
    {
        var collectionId = Guid.NewGuid();
        var memberId = Guid.NewGuid();
        var linked = new StubLinkedChildrenService { GetChildrenHook = (_, _) => new[] { memberId } };
        var requestedMovie = new StubMovie { Id = memberId };
        BaseItem[] malformed = mode switch
        {
            "virtual" => new BaseItem[] { new StubMovie { Id = memberId, IsVirtualItem = true } },
            "foreign" => new BaseItem[] { new StubMovie { Id = Guid.NewGuid() } },
            "duplicate" => new BaseItem[] { requestedMovie, requestedMovie },
            _ => new BaseItem[] { new BoxSet { Id = memberId } },
        };
        var library = new CountingLibraryManager
        {
            ConfigureUserAccessHook = static (_, _) => { },
            GetItemsResultHook = _ => new QueryResult<BaseItem>(0, malformed.Length, malformed),
        };
        using var fixture = Fixture.Create(library, linked);

        var result = new TagCollectionLanguageCoverageProjector(library, fixture.Cache, NullLogger.Instance)
            .ProjectContainers(fixture.FirstUser, new[] { new BoxSet { Id = collectionId } }, default)[Key(collectionId)];

        Assert.False(result.Complete);
        Assert.False(result.Truncated);
        Assert.Null(result.EligibleMemberCount);
        Assert.Null(result.ObservedMemberCount);
    }

    [Fact]
    public void ProjectAccessibleSnapshot_DeduplicatesMembershipAndReturnsCompleteEmptyForNoAccessibleMovies()
    {
        var collectionId = Guid.NewGuid();
        var inaccessibleMovieId = Guid.NewGuid();
        var linked = new StubLinkedChildrenService { GetChildrenHook = (_, _) => new[] { inaccessibleMovieId, inaccessibleMovieId } };
        var library = new CountingLibraryManager();
        using var fixture = Fixture.Create(library, linked);
        var entries = new Dictionary<string, TagCacheEntry>
        {
            [Key(collectionId)] = new() { Type = "BoxSet", SourceRevision = 1 },
        };

        var result = new TagCollectionLanguageCoverageProjector(library, fixture.Cache, NullLogger.Instance)
            .ProjectAccessibleSnapshot(fixture.FirstUser, entries, default)[Key(collectionId)];

        Assert.True(result.Complete);
        Assert.Equal(0, result.EligibleMemberCount);
        Assert.Equal(0, result.ObservedMemberCount);
    }

    [Fact]
    public void RemovedMovie_UsesDurableOldMembershipToInvalidateFormerCollection()
    {
        var collectionId = Guid.NewGuid();
        var movieId = Guid.NewGuid();
        var collection = new BoxSet { Id = collectionId, DateLastSaved = DateTime.UtcNow };
        var linked = new StubLinkedChildrenService
        {
            // The live reverse edge is already gone when Jellyfin emits deletion.
            GetParentsHook = (_, _) => Array.Empty<Guid>(),
            GetChildrenHook = (_, _) => Array.Empty<Guid>(),
        };
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => id == collectionId ? collection : null,
            GetItemByIdUserHook = (id, _) => id == collectionId ? collection : null,
            GetItemIdsHook = _ => new[] { collectionId, movieId },
        };
        using var fixture = Fixture.Create(library, linked);
        fixture.Cache.SeedEntryForTest(Key(collectionId), new TagCacheEntry { Type = "BoxSet", SourceRevision = 1 });
        fixture.Cache.SeedEntryForTest(Key(movieId), new TagCacheEntry { Type = "Movie", SourceRevision = 1 });
        fixture.Cache.SeedCollectionMembershipForTest(collectionId, movieId);
        var initial = fixture.Cache.GetFullContentForUser(fixture.FirstUser);
        var beforeRevision = initial.Revision;

        fixture.Cache.EnqueueItemChange(new StubMovie { Id = movieId }, removed: true);
        fixture.Cache.FlushPendingForTest();

        Assert.False(fixture.Cache.ContainsKeyForTest(Key(movieId)));
        Assert.True(fixture.Cache.ContainsKeyForTest(Key(collectionId)));
        Assert.True(fixture.Cache.ContentRevision >= beforeRevision + 2);
        Assert.Equal(1, linked.GetParentsCallCount); // empty live result did not erase the durable old edge
        var delta = fixture.Cache.GetContentDeltaForUser(fixture.FirstUser, initial.Epoch, beforeRevision);
        Assert.False(delta.ResetRequired);
        Assert.Contains(Key(collectionId), delta.Items.Keys);
    }

    [Fact]
    public void MovieScanCallback_PerformsNoLinkedRelationshipQuery()
    {
        var linked = new StubLinkedChildrenService();
        var library = new CountingLibraryManager();
        using var fixture = Fixture.Create(library, linked);
        using var monitor = new TagCacheMonitor(library, fixture.Cache, NullLogger<TagCacheMonitor>.Instance);
        monitor.Initialize();

        library.RaiseItemUpdated(new StubMovie { Id = Guid.NewGuid() });

        Assert.Equal(0, linked.GetChildrenCallCount);
        Assert.Equal(0, linked.GetParentsCallCount);
        Assert.Equal(1, fixture.Cache.PendingChangeCountForTest);
    }

    [Fact]
    public void MovieDeletion_RechecksUnindexedCollectionAndDetectsReturnBelowCapOnWorker()
    {
        var collectionId = Guid.NewGuid();
        var removedMovieId = Guid.NewGuid();
        var remaining = Enumerable.Range(0, TagCollectionLanguageCoverageProjector.MaximumMembershipEdgesPerRequest)
            .Select(_ => Guid.NewGuid()).ToArray();
        var collection = new BoxSet { Id = collectionId, DateLastSaved = DateTime.UtcNow };
        var linked = new StubLinkedChildrenService
        {
            GetParentsHook = (_, _) => Array.Empty<Guid>(),
            GetChildrenHook = (_, _) => remaining,
        };
        var library = new CountingLibraryManager { GetItemByIdHook = id => id == collectionId ? collection : null };
        using var fixture = Fixture.Create(library, linked);
        fixture.Cache.SeedEntryForTest(Key(collectionId), new TagCacheEntry { Type = "BoxSet", SourceRevision = 1 });
        fixture.Cache.SeedEntryForTest(Key(removedMovieId), new TagCacheEntry { Type = "Movie", SourceRevision = 1 });
        fixture.Cache.SeedUnindexedCollectionForTest(collectionId);

        fixture.Cache.EnqueueItemChange(new StubMovie { Id = removedMovieId }, removed: true);
        Assert.Equal(0, linked.GetChildrenCallCount);
        fixture.Cache.FlushPendingForTest();

        Assert.Equal(1, linked.GetChildrenCallCount);
        Assert.False(fixture.Cache.IsCollectionUnindexedForTest(collectionId));
    }

    [Fact]
    public void MovieMove_InvalidatesBothDurableOldAndLiveNewCollections()
    {
        var movie = new StubMovie { Id = Guid.NewGuid(), DateLastSaved = DateTime.UtcNow };
        var oldCollection = new BoxSet { Id = Guid.NewGuid(), DateLastSaved = DateTime.UtcNow };
        var newCollection = new BoxSet { Id = Guid.NewGuid(), DateLastSaved = DateTime.UtcNow };
        var linked = new StubLinkedChildrenService
        {
            GetParentsHook = (_, _) => new[] { newCollection.Id },
            GetChildrenHook = (id, _) => id == newCollection.Id ? new[] { movie.Id } : Array.Empty<Guid>(),
        };
        var items = new BaseItem[] { movie, oldCollection, newCollection };
        var library = new CountingLibraryManager { GetItemByIdHook = id => items.SingleOrDefault(item => item.Id == id) };
        using var fixture = Fixture.Create(library, linked);
        fixture.Cache.SeedEntryForTest(Key(movie.Id), new TagCacheEntry { Type = "Movie", SourceRevision = 1 });
        fixture.Cache.SeedEntryForTest(Key(oldCollection.Id), new TagCacheEntry { Type = "BoxSet", SourceRevision = 1 });
        fixture.Cache.SeedEntryForTest(Key(newCollection.Id), new TagCacheEntry { Type = "BoxSet", SourceRevision = 1 });
        fixture.Cache.SeedCollectionMembershipForTest(oldCollection.Id, movie.Id);
        var before = fixture.Cache.ContentRevision;

        fixture.Cache.EnqueueItemChange(movie, removed: false);
        fixture.Cache.FlushPendingForTest();

        Assert.True(fixture.Cache.ContentRevision >= before + 3);
        Assert.Equal(1, linked.GetParentsCallCount);
        Assert.Equal(2, linked.GetChildrenCallCount);
    }

    [Fact]
    public void BoxSetEvents_AtomicallyTrackMembershipAddAndRemove()
    {
        var movie = new StubMovie { Id = Guid.NewGuid(), DateLastSaved = DateTime.UtcNow };
        var collection = new BoxSet { Id = Guid.NewGuid(), DateLastSaved = DateTime.UtcNow };
        Guid[] members = Array.Empty<Guid>();
        var linked = new StubLinkedChildrenService { GetChildrenHook = (_, _) => members };
        var library = new CountingLibraryManager { GetItemByIdHook = id => id == collection.Id ? collection : movie };
        using var fixture = Fixture.Create(library, linked);
        fixture.Cache.SeedEntryForTest(Key(collection.Id), new TagCacheEntry { Type = "BoxSet", SourceRevision = 1 });
        fixture.Cache.SeedEntryForTest(Key(movie.Id), new TagCacheEntry { Type = "Movie", SourceRevision = 1 });
        fixture.Cache.SeedCollectionMembershipForTest(collection.Id);

        members = new[] { movie.Id };
        fixture.Cache.EnqueueItemChange(collection, removed: false);
        fixture.Cache.FlushPendingForTest();
        Assert.Equal(new[] { movie.Id }, fixture.Cache.GetIndexedCollectionMembersForTest(collection.Id));

        members = Array.Empty<Guid>();
        fixture.Cache.EnqueueItemChange(collection, removed: false);
        fixture.Cache.FlushPendingForTest();
        Assert.Empty(fixture.Cache.GetIndexedCollectionMembersForTest(collection.Id));
    }

    [Fact]
    public void QueuedMovieStreamRevision_BecomesVisibleAfterFlushAndJournalsCollection()
    {
        var movieId = Guid.NewGuid();
        var collectionId = Guid.NewGuid();
        var movie = new StubMovie { Id = movieId, DateLastSaved = DateTime.UtcNow };
        var collection = new BoxSet { Id = collectionId, DateLastSaved = DateTime.UtcNow };
        var linked = new StubLinkedChildrenService
        {
            GetParentsHook = (_, _) => new[] { collectionId },
            GetChildrenHook = (_, _) => new[] { movieId },
        };
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => id == movieId ? movie : collection,
        };
        using var fixture = Fixture.Create(library, linked);
        fixture.Cache.SeedEntryForTest(Key(collectionId), new TagCacheEntry { Type = "BoxSet", SourceRevision = 1 });
        fixture.Cache.SeedEntryForTest(Key(movieId), new TagCacheEntry
        {
            Type = "Movie",
            SourceRevision = 1,
            AudioLanguages = new[] { "eng" },
        });
        fixture.Cache.SeedCollectionMembershipForTest(collectionId, movieId);
        var before = new Dictionary<string, TagCacheEntry>
        {
            [Key(collectionId)] = fixture.Cache.GetEntryForTest(Key(collectionId))!,
            [Key(movieId)] = fixture.Cache.GetEntryForTest(Key(movieId))!,
        };
        var beforeCoverage = new TagCollectionLanguageCoverageProjector(library, fixture.Cache, NullLogger.Instance)
            .ProjectAccessibleSnapshot(fixture.FirstUser, before, default)[Key(collectionId)];
        Assert.Equal(new[] { "en" }, beforeCoverage.FullLanguages);
        var beforeRevision = fixture.Cache.ContentRevision;

        fixture.Cache.EnqueueItemChange(movie, removed: false);
        fixture.Cache.FlushPendingForTest();

        var after = new Dictionary<string, TagCacheEntry>
        {
            [Key(collectionId)] = fixture.Cache.GetEntryForTest(Key(collectionId))!,
            [Key(movieId)] = fixture.Cache.GetEntryForTest(Key(movieId))!,
        };
        var afterCoverage = new TagCollectionLanguageCoverageProjector(library, fixture.Cache, NullLogger.Instance)
            .ProjectAccessibleSnapshot(fixture.FirstUser, after, default)[Key(collectionId)];
        Assert.True(afterCoverage.Complete);
        Assert.Empty(afterCoverage.FullLanguages);
        Assert.Empty(afterCoverage.PartialLanguages);
        Assert.True(fixture.Cache.ContentRevision >= beforeRevision + 2);
    }

    [Fact]
    public void DurableMembership_RestartStillInvalidatesFormerCollectionAfterMovieDeletion()
    {
        var directory = Path.Combine(Path.GetTempPath(), "canopy-collection-restart-" + Guid.NewGuid().ToString("N"));
        var collectionId = Guid.NewGuid();
        var movieId = Guid.NewGuid();
        var collection = new BoxSet { Id = collectionId, DateLastSaved = DateTime.UtcNow };
        var paths = new StubAppPaths(directory);
        try
        {
            using (var writer = new TagCacheService(
                new CountingLibraryManager(), paths, NullLogger<TagCacheService>.Instance, new StubLinkedChildrenService()))
            {
                writer.SeedEntryForTest(Key(collectionId), new TagCacheEntry { Type = "BoxSet", SourceRevision = 1 });
                writer.SeedEntryForTest(Key(movieId), new TagCacheEntry { Type = "Movie", SourceRevision = 1 });
                writer.SeedCollectionMembershipForTest(collectionId, movieId);
                Assert.True(writer.SaveToDisk());
            }

            var liveLinks = new StubLinkedChildrenService
            {
                GetParentsHook = (_, _) => Array.Empty<Guid>(),
                GetChildrenHook = (_, _) => Array.Empty<Guid>(),
            };
            var library = new CountingLibraryManager { GetItemByIdHook = id => id == collectionId ? collection : null };
            using var reader = new TagCacheService(library, paths, NullLogger<TagCacheService>.Instance, liveLinks);
            Assert.True(reader.LoadFromDisk(canPublish: null));
            reader.EnqueueItemChange(new StubMovie { Id = movieId }, removed: true);
            reader.FlushPendingForTest();

            Assert.False(reader.ContainsKeyForTest(Key(movieId)));
            Assert.True(reader.ContainsKeyForTest(Key(collectionId)));
            Assert.True(reader.ContentRevision >= 2);
        }
        finally
        {
            try { Directory.Delete(directory, recursive: true); } catch { }
        }
    }

    [Theory]
    [InlineData("null")]
    [InlineData("empty-id")]
    [InlineData("oversize")]
    [InlineData("non-boxset")]
    public void LoadFromDisk_MalformedMembershipSnapshotIsRejectedForRebuild(string mode)
    {
        var directory = Path.Combine(Path.GetTempPath(), "canopy-collection-malformed-" + Guid.NewGuid().ToString("N"));
        var collectionId = Guid.NewGuid();
        var paths = new StubAppPaths(directory);
        try
        {
            using (var writer = new TagCacheService(
                new CountingLibraryManager(), paths, NullLogger<TagCacheService>.Instance, new StubLinkedChildrenService()))
            {
                writer.SeedEntryForTest(Key(collectionId), new TagCacheEntry { Type = "BoxSet", SourceRevision = 1 });
                writer.SeedCollectionMembershipForTest(collectionId);
                Assert.True(writer.SaveToDisk());
            }

            var path = Path.Combine(directory, "configurations", "Jellyfin.Plugin.JellyfinCanopy", "tag-cache.json");
            var root = JsonNode.Parse(File.ReadAllText(path))!.AsObject();
            if (mode == "null")
            {
                root["CollectionMembers"] = null;
            }
            else
            {
                var members = root["CollectionMembers"]!.AsObject();
                members.Clear();
                var key = mode == "non-boxset" ? Guid.NewGuid() : collectionId;
                var values = mode switch
                {
                    "empty-id" => new[] { Guid.Empty },
                    "oversize" => Enumerable.Range(0, TagCollectionLanguageCoverageProjector.MaximumMembershipEdgesPerRequest + 1)
                        .Select(_ => Guid.NewGuid()).ToArray(),
                    _ => Array.Empty<Guid>(),
                };
                members[key.ToString()] = new JsonArray(values.Select(static value => JsonValue.Create(value)).ToArray());
            }
            File.WriteAllText(path, root.ToJsonString());

            using var reader = new TagCacheService(
                new CountingLibraryManager(), paths, NullLogger<TagCacheService>.Instance, new StubLinkedChildrenService());
            Assert.False(reader.LoadFromDisk(canPublish: null));
            Assert.Equal(0, reader.Count);
        }
        finally
        {
            try { Directory.Delete(directory, recursive: true); } catch { }
        }
    }

    [Fact]
    public void RejectedFullReconcile_DoesNotSwapAwayOldMembershipSnapshot()
    {
        var collectionId = Guid.NewGuid();
        var movie = new StubMovie { Id = Guid.NewGuid(), DateLastSaved = DateTime.UtcNow };
        var collection = new BoxSet { Id = collectionId, DateLastSaved = DateTime.UtcNow };
        var all = new BaseItem[] { movie, collection };
        var linked = new StubLinkedChildrenService
        {
            GetParentsHook = (_, _) => Array.Empty<Guid>(),
            GetChildrenHook = (_, _) => Array.Empty<Guid>(),
        };
        var library = new CountingLibraryManager
        {
            GetItemsResultHook = query =>
            {
                var included = query.IncludeItemTypes.ToHashSet();
                var rows = all.Where(item => included.Contains(item.GetBaseItemKind())).ToArray();
                return new QueryResult<BaseItem>(0, rows.Length, rows);
            },
            GetItemByIdHook = id => id == collectionId ? collection : null,
        };
        using var fixture = Fixture.Create(library, linked);
        fixture.Cache.SeedEntryForTest(Key(collectionId), new TagCacheEntry { Type = "BoxSet", SourceRevision = 1 });
        fixture.Cache.SeedEntryForTest(Key(movie.Id), new TagCacheEntry { Type = "Movie", SourceRevision = 1 });
        fixture.Cache.SeedCollectionMembershipForTest(collectionId, movie.Id);

        Assert.False(fixture.Cache.BuildFullCache(null, default, canPublish: () => false));
        var before = fixture.Cache.ContentRevision;
        fixture.Cache.EnqueueItemChange(movie, removed: true);
        fixture.Cache.FlushPendingForTest();

        Assert.True(fixture.Cache.ContentRevision >= before + 2);
        Assert.True(fixture.Cache.ContainsKeyForTest(Key(collectionId)));
    }

    [Fact]
    public void FullReconcile_MembershipOnlyChangeJournalsCollectionUpsert()
    {
        var collectionId = Guid.NewGuid();
        var firstMovie = new StubMovie { Id = Guid.NewGuid(), DateLastSaved = DateTime.UtcNow };
        var secondMovie = new StubMovie { Id = Guid.NewGuid(), DateLastSaved = DateTime.UtcNow };
        var collection = new BoxSet { Id = collectionId, DateLastSaved = DateTime.UtcNow };
        var members = new[] { firstMovie.Id };
        var linked = new StubLinkedChildrenService { GetChildrenHook = (_, _) => members };
        var all = new BaseItem[] { firstMovie, secondMovie, collection };
        var library = new CountingLibraryManager
        {
            GetItemsResultHook = query =>
            {
                var included = query.IncludeItemTypes.ToHashSet();
                var rows = all.Where(item => included.Contains(item.GetBaseItemKind())).ToArray();
                return new QueryResult<BaseItem>(0, rows.Length, rows);
            },
            GetItemIdsHook = _ => all.Select(static item => item.Id).ToArray(),
            GetItemByIdUserHook = (id, _) => all.SingleOrDefault(item => item.Id == id),
        };
        using var fixture = Fixture.Create(library, linked);
        fixture.Cache.BuildFullCache(null, default);
        var initial = fixture.Cache.GetFullContentForUser(fixture.FirstUser);

        members = new[] { secondMovie.Id };
        fixture.Cache.BuildFullCache(null, default);
        var delta = fixture.Cache.GetContentDeltaForUser(fixture.FirstUser, initial.Epoch, initial.Revision);

        Assert.False(delta.ResetRequired);
        Assert.Contains(Key(collectionId), delta.Items.Keys);
    }

    [Fact]
    public void IncrementalBatch_MultipleBoxSetsRebuildReverseGraphOnce()
    {
        var first = new BoxSet { Id = Guid.NewGuid(), DateLastSaved = DateTime.UtcNow };
        var second = new BoxSet { Id = Guid.NewGuid(), DateLastSaved = DateTime.UtcNow };
        var boxes = new BaseItem[] { first, second };
        var linked = new StubLinkedChildrenService { GetChildrenHook = (_, _) => Array.Empty<Guid>() };
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => boxes.Single(item => item.Id == id),
        };
        using var fixture = Fixture.Create(library, linked);
        foreach (var box in boxes)
        {
            fixture.Cache.SeedEntryForTest(Key(box.Id), new TagCacheEntry { Type = "BoxSet", SourceRevision = 1 });
            fixture.Cache.SeedCollectionMembershipForTest(box.Id);
        }
        var before = fixture.Cache.CollectionReverseRebuildsForTest;

        fixture.Cache.EnqueueItemChange(first, removed: false);
        fixture.Cache.EnqueueItemChange(second, removed: false);
        fixture.Cache.FlushPendingForTest();

        Assert.Equal(2, linked.GetChildrenCallCount);
        Assert.Equal(before + 1, fixture.Cache.CollectionReverseRebuildsForTest);
    }

    [Fact]
    public void FullReconcile_HandoffBoxSetReadsLinksOutsideContentGate()
    {
        var box = new BoxSet { Id = Guid.NewGuid(), DateLastSaved = DateTime.UtcNow };
        var library = new CountingLibraryManager
        {
            GetItemsResultHook = static _ => new QueryResult<BaseItem>(0, 0, Array.Empty<BaseItem>()),
            GetItemByIdHook = id => id == box.Id ? box : null,
        };
        TagCacheService? service = null;
        var linked = new StubLinkedChildrenService
        {
            GetChildrenHook = (_, _) =>
            {
                Assert.NotNull(service);
                Assert.False(service!.IsContentGateHeldByCurrentThreadForTest);
                return Array.Empty<Guid>();
            },
        };
        using var fixture = Fixture.Create(library, linked);
        service = fixture.Cache;
        service.OnBeforeSwapForTest = () => service.EnqueueItemChange(box, removed: false);

        service.BuildFullCache(null, default);

        Assert.Equal(1, linked.GetChildrenCallCount);
        Assert.True(service.ContainsKeyForTest(Key(box.Id)));
        Assert.Equal(0, service.PendingChangeCountForTest);
    }

    private static string Key(Guid id) => id.ToString("N");

    private sealed class Fixture : IDisposable
    {
        private readonly string _directory;

        private Fixture(string directory, CountingLibraryManager library, StubLinkedChildrenService linked)
        {
            _directory = directory;
            FirstUser = NewUser("first");
            SecondUser = NewUser("second");
            Cache = new TagCacheService(library, new StubAppPaths(directory), NullLogger<TagCacheService>.Instance, linked);
        }

        internal Jellyfin.Database.Implementations.Entities.User FirstUser { get; }

        internal Jellyfin.Database.Implementations.Entities.User SecondUser { get; }

        internal TagCacheService Cache { get; }

        internal static Fixture Create(CountingLibraryManager library, StubLinkedChildrenService linked)
            => new(Path.Combine(Path.GetTempPath(), "canopy-collection-coverage-" + Guid.NewGuid().ToString("N")), library, linked);

        internal void SeedMovie(Guid id, long revision, params string[] languages)
            => Cache.SeedEntryForTest(Key(id), new TagCacheEntry
            {
                Type = "Movie",
                SourceRevision = revision,
                AudioLanguages = languages,
            });

        internal void SeedMovieWithOriginal(Guid id, long revision, string originalLanguage, params string[] languages)
            => Cache.SeedEntryForTest(Key(id), new TagCacheEntry
            {
                Type = "Movie",
                SourceRevision = revision,
                AudioLanguages = languages,
                OriginalLanguage = originalLanguage,
            });

        public void Dispose()
        {
            Cache.Dispose();
            try { Directory.Delete(_directory, recursive: true); } catch { }
        }

        private static Jellyfin.Database.Implementations.Entities.User NewUser(string name)
            => new(name, "provider", "password-provider") { Id = Guid.NewGuid() };
    }
}
