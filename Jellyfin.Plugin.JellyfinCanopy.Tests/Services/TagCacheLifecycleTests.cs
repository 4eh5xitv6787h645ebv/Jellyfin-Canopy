using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Model;
using Jellyfin.Plugin.JellyfinCanopy.ScheduledTasks;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Entities;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using JSortOrder = Jellyfin.Database.Implementations.Enums.SortOrder;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services
{
    public sealed class TagCacheLifecycleTests
    {
        [Fact]
        public async Task DisabledStartupAndScheduledTask_PerformNoCacheWork()
        {
            using var fixture = new Fixture(enabled: false);
            fixture.Library.GetItemListHook = _ => throw new Xunit.Sdk.XunitException("disabled mode must not query the library");

            await fixture.Lifecycle.InitializeAsync(null, CancellationToken.None);
            await new BuildTagCacheTask(fixture.Lifecycle)
                .ExecuteAsync(new Progress<double>(), CancellationToken.None);

            Assert.False(fixture.Lifecycle.IsReady);
            Assert.False(fixture.Lifecycle.IsEnabledForTest);
            Assert.True(fixture.Cache.IsSuspendedForTest);
            Assert.Equal(0, fixture.Cache.LoadFromDiskCallsForTest);
            Assert.Equal(0, fixture.Cache.SaveToDiskCallsForTest);
            Assert.Equal(0, fixture.Library.GetItemListCallCount);
            Assert.Equal(0, fixture.Library.ItemAddedCount);
            Assert.Equal(0, fixture.Library.ItemUpdatedCount);
            Assert.Equal(0, fixture.Library.ItemRemovedCount);
            Assert.Equal(0, fixture.UserData.UserDataSavedSubscriberCount);
            Assert.False(fixture.Cache.HasFlushTimerForTest);
        }

        [Fact]
        public async Task EnableBuildsOnce_ThenDisableRevokesReadinessSubscriptionsAndMemory()
        {
            using var fixture = new Fixture(enabled: true);
            var movie = new StubMovie { Id = Guid.NewGuid(), DateLastSaved = DateTime.UtcNow };
            fixture.Library.GetItemListHook = query => Page(query, new BaseItem[] { movie });

            await fixture.Lifecycle.ReconcileAsync(null, CancellationToken.None);

            Assert.True(fixture.Lifecycle.IsReady);
            Assert.Equal(1, fixture.Cache.Count);
            Assert.Equal(1, fixture.Library.ItemAddedCount);
            Assert.Equal(1, fixture.Library.ItemUpdatedCount);
            Assert.Equal(1, fixture.Library.ItemRemovedCount);
            Assert.Equal(1, fixture.UserData.UserDataSavedSubscriberCount);

            fixture.Provider.Current = new PluginConfiguration { TagCacheServerMode = false };
            fixture.Lifecycle.NotifyConfigurationChanged();

            Assert.False(fixture.Lifecycle.IsReady);
            Assert.False(fixture.Lifecycle.IsEnabledForTest);
            Assert.True(fixture.Cache.IsSuspendedForTest);
            Assert.Equal(0, fixture.Cache.Count);
            Assert.Equal(0, fixture.Library.ItemAddedCount);
            Assert.Equal(0, fixture.Library.ItemUpdatedCount);
            Assert.Equal(0, fixture.Library.ItemRemovedCount);
            Assert.Equal(0, fixture.UserData.UserDataSavedSubscriberCount);
            Assert.False(fixture.Cache.HasFlushTimerForTest);
        }

        [Fact]
        public async Task UnrelatedEnabledConfigurationSave_DoesNotStartAnotherBuild()
        {
            using var fixture = new Fixture(enabled: true);
            fixture.Library.GetItemListHook = _ => Array.Empty<BaseItem>();
            await fixture.Lifecycle.ReconcileAsync(null, CancellationToken.None);
            var queries = fixture.Library.GetItemListCallCount;
            var saves = fixture.Cache.SaveToDiskCallsForTest;

            fixture.Provider.Current = new PluginConfiguration
            {
                TagCacheServerMode = true,
                TagsCacheTtlDays = 12
            };
            fixture.Lifecycle.NotifyConfigurationChanged();

            Assert.Equal(queries, fixture.Library.GetItemListCallCount);
            Assert.Equal(saves, fixture.Cache.SaveToDiskCallsForTest);
            Assert.True(fixture.Lifecycle.IsReady);
        }

        [Fact]
        public async Task PreCancelledReconcile_PerformsNoLifecycleOrCacheWork()
        {
            using var fixture = new Fixture(enabled: true);
            fixture.Library.GetItemsResultHook = _ =>
                throw new Xunit.Sdk.XunitException("pre-cancelled reconcile must not query the library");
            using var cancellation = new CancellationTokenSource();
            cancellation.Cancel();

            await Assert.ThrowsAnyAsync<OperationCanceledException>(
                () => fixture.Lifecycle.ReconcileAsync(null, cancellation.Token));

            Assert.False(fixture.Lifecycle.IsReady);
            Assert.False(fixture.Lifecycle.IsEnabledForTest);
            Assert.Equal(0, fixture.Cache.LoadFromDiskCallsForTest);
            Assert.Equal(0, fixture.Cache.SaveToDiskCallsForTest);
            Assert.Equal(0, fixture.Library.GetItemsResultCallCount);
            Assert.Equal(0, fixture.Library.ItemAddedCount);
            Assert.Equal(0, fixture.UserData.UserDataSavedSubscriberCount);
        }

        [Fact]
        public async Task DisableDuringBlockedPage_CancelsGenerationWithoutLateSwapOrSave()
        {
            using var fixture = new Fixture(enabled: true);
            var entered = new ManualResetEventSlim();
            var release = new ManualResetEventSlim();
            var movie = new StubMovie { Id = Guid.NewGuid(), DateLastSaved = DateTime.UtcNow };
            fixture.Library.GetItemListHook = query =>
            {
                if (query.IncludeItemTypes.Contains(BaseItemKind.Series))
                {
                    return Array.Empty<BaseItem>();
                }

                entered.Set();
                release.Wait(TimeSpan.FromSeconds(10));
                return new BaseItem[] { movie };
            };

            var build = fixture.Lifecycle.ReconcileAsync(null, CancellationToken.None);
            Assert.True(entered.Wait(TimeSpan.FromSeconds(10)));

            fixture.Provider.Current = new PluginConfiguration { TagCacheServerMode = false };
            fixture.Lifecycle.NotifyConfigurationChanged();
            Assert.False(fixture.Lifecycle.IsReady);
            release.Set();
            await build;

            Assert.Equal(0, fixture.Cache.Count);
            Assert.Equal(0, fixture.Cache.SaveToDiskCallsForTest);
            Assert.Equal(0, fixture.Library.ItemAddedCount);
            Assert.Equal(0, fixture.UserData.UserDataSavedSubscriberCount);
        }

        [Fact]
        public async Task OverlappingReconcileTriggers_JoinOneInFlightGeneration()
        {
            using var fixture = new Fixture(enabled: true);
            var entered = new ManualResetEventSlim();
            var release = new ManualResetEventSlim();
            var movie = new StubMovie { Id = Guid.NewGuid(), DateLastSaved = DateTime.UtcNow };
            fixture.Library.GetItemListHook = query =>
            {
                if (query.IncludeItemTypes.Contains(BaseItemKind.Series))
                {
                    entered.Set();
                    release.Wait(TimeSpan.FromSeconds(10));
                    return Array.Empty<BaseItem>();
                }

                return Page(query, new BaseItem[] { movie });
            };

            var first = fixture.Lifecycle.ReconcileAsync(null, CancellationToken.None);
            Assert.True(entered.Wait(TimeSpan.FromSeconds(10)));
            var second = fixture.Lifecycle.ReconcileAsync(null, CancellationToken.None);
            release.Set();
            await Task.WhenAll(first, second);

            Assert.True(fixture.Lifecycle.IsReady);
            Assert.Equal(2, fixture.Library.GetItemListCallCount);
            Assert.Equal(1, fixture.Cache.SaveToDiskCallsForTest);
        }

        [Fact]
        public async Task RapidDisableReenable_DoesNotJoinObsoleteBuildGeneration()
        {
            using var fixture = new Fixture(enabled: true);
            var firstEntered = new ManualResetEventSlim();
            var releaseFirst = new ManualResetEventSlim();
            var obsolete = new StubMovie { Id = Guid.NewGuid(), DateLastSaved = DateTime.UtcNow };
            var current = new StubMovie { Id = Guid.NewGuid(), DateLastSaved = DateTime.UtcNow };
            var nonSeriesQueries = 0;
            fixture.Library.GetItemListHook = query =>
            {
                if (query.IncludeItemTypes.Contains(BaseItemKind.Series))
                {
                    return Array.Empty<BaseItem>();
                }

                if (Interlocked.Increment(ref nonSeriesQueries) == 1)
                {
                    firstEntered.Set();
                    releaseFirst.Wait(TimeSpan.FromSeconds(10));
                    return new BaseItem[] { obsolete };
                }

                return new BaseItem[] { current };
            };

            var obsoleteBuild = fixture.Lifecycle.ReconcileAsync(null, CancellationToken.None);
            Assert.True(firstEntered.Wait(TimeSpan.FromSeconds(10)));
            fixture.Provider.Current = new PluginConfiguration { TagCacheServerMode = false };
            fixture.Lifecycle.NotifyConfigurationChanged();
            fixture.Provider.Current = new PluginConfiguration { TagCacheServerMode = true };
            fixture.Lifecycle.NotifyConfigurationChanged();
            var currentBuild = fixture.Lifecycle.ReconcileAsync(null, CancellationToken.None);

            releaseFirst.Set();
            await Task.WhenAll(obsoleteBuild, currentBuild);

            Assert.True(fixture.Lifecycle.IsReady);
            Assert.False(fixture.Cache.ContainsKeyForTest(Key(obsolete.Id)));
            Assert.True(fixture.Cache.ContainsKeyForTest(Key(current.Id)));
            Assert.Equal(1, fixture.Cache.SaveToDiskCallsForTest);
        }

        [Fact]
        public async Task CancellingJoinedWaiter_DoesNotCancelSharedGeneration()
        {
            using var fixture = new Fixture(enabled: true);
            var entered = new ManualResetEventSlim();
            var release = new ManualResetEventSlim();
            fixture.Library.GetItemListHook = query =>
            {
                if (query.IncludeItemTypes.Contains(BaseItemKind.Series))
                {
                    entered.Set();
                    release.Wait(TimeSpan.FromSeconds(10));
                }

                return Array.Empty<BaseItem>();
            };

            var owner = fixture.Lifecycle.ReconcileAsync(null, CancellationToken.None);
            Assert.True(entered.Wait(TimeSpan.FromSeconds(10)));
            using var waiterCancellation = new CancellationTokenSource();
            var waiter = fixture.Lifecycle.ReconcileAsync(null, waiterCancellation.Token);
            waiterCancellation.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => waiter);

            release.Set();
            await owner;
            Assert.True(fixture.Lifecycle.IsReady);
            Assert.Equal(1, fixture.Cache.SaveToDiskCallsForTest);
        }

        [Fact]
        public async Task CancellingOnlyReconcileOwner_CancelsUnobservedGenerationBeforePublication()
        {
            using var fixture = new Fixture(enabled: true);
            var entered = new ManualResetEventSlim();
            var release = new ManualResetEventSlim();
            var movie = new StubMovie { Id = Guid.NewGuid(), DateLastSaved = DateTime.UtcNow };
            fixture.Library.GetItemListHook = query =>
            {
                if (query.IncludeItemTypes.Contains(BaseItemKind.Series))
                {
                    entered.Set();
                    release.Wait(TimeSpan.FromSeconds(10));
                    return Array.Empty<BaseItem>();
                }

                return new BaseItem[] { movie };
            };

            using var cancellation = new CancellationTokenSource();
            var reconcile = fixture.Lifecycle.ReconcileAsync(null, cancellation.Token);
            Assert.True(entered.Wait(TimeSpan.FromSeconds(10)));
            cancellation.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => reconcile);
            release.Set();

            Assert.True(SpinWait.SpinUntil(
                () => !fixture.Lifecycle.HasBuildInFlightForTest,
                TimeSpan.FromSeconds(10)));
            Assert.False(fixture.Lifecycle.IsReady);
            Assert.Equal(0, fixture.Cache.Count);
            Assert.Equal(0, fixture.Cache.SaveToDiskCallsForTest);
        }

        [Fact]
        public async Task NewDemandDuringSoleOwnerCancellation_StartsFreshJoinableAttempt()
        {
            using var fixture = new Fixture(enabled: true);
            var firstPageEntered = new ManualResetEventSlim();
            var releaseFirstPage = new ManualResetEventSlim();
            var retired = new ManualResetEventSlim();
            var releaseCancellation = new ManualResetEventSlim();
            var current = new StubMovie { Id = Guid.NewGuid(), DateLastSaved = DateTime.UtcNow };
            var seriesCalls = 0;
            fixture.Library.GetItemListHook = query =>
            {
                if (query.IncludeItemTypes.Contains(BaseItemKind.Series)
                    && Interlocked.Increment(ref seriesCalls) == 1)
                {
                    firstPageEntered.Set();
                    releaseFirstPage.Wait(TimeSpan.FromSeconds(10));
                    return Array.Empty<BaseItem>();
                }

                return query.IncludeItemTypes.Contains(BaseItemKind.Series)
                    ? Array.Empty<BaseItem>()
                    : new BaseItem[] { current };
            };
            fixture.Lifecycle.OnBeforeBuildDemandCancelForTest = () =>
            {
                retired.Set();
                releaseCancellation.Wait(TimeSpan.FromSeconds(10));
            };

            using var cancellation = new CancellationTokenSource();
            var abandoned = fixture.Lifecycle.ReconcileAsync(null, cancellation.Token);
            Assert.True(firstPageEntered.Wait(TimeSpan.FromSeconds(10)));
            cancellation.Cancel();
            Assert.True(retired.Wait(TimeSpan.FromSeconds(10)));

            var replacement = fixture.Lifecycle.ReconcileAsync(null, CancellationToken.None);
            await replacement;
            releaseCancellation.Set();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => abandoned);
            releaseFirstPage.Set();

            Assert.True(SpinWait.SpinUntil(
                () => !fixture.Lifecycle.HasBuildInFlightForTest,
                TimeSpan.FromSeconds(10)));
            Assert.True(fixture.Lifecycle.IsReady);
            Assert.True(fixture.Cache.ContainsKeyForTest(Key(current.Id)));
            Assert.Equal(1, fixture.Cache.SaveToDiskCallsForTest);
        }

        [Fact]
        public async Task DisableDuringDiskRead_CannotRepopulateDisabledMemory()
        {
            using var fixture = new Fixture(enabled: true);
            fixture.Cache.SeedEntryForTest(Key(Guid.NewGuid()), new TagCacheEntry { Type = "Movie" });
            fixture.Cache.SaveToDisk();
            fixture.Cache.SwapCacheAndCursorForTest(
                new Dictionary<string, TagCacheEntry>(),
                version: 0,
                lastModified: 0);
            var read = new ManualResetEventSlim();
            var release = new ManualResetEventSlim();
            fixture.Cache.OnAfterDiskReadForTest = () =>
            {
                read.Set();
                release.Wait(TimeSpan.FromSeconds(10));
            };

            var initialize = Task.Run(
                () => fixture.Lifecycle.InitializeAsync(null, CancellationToken.None));
            Assert.True(read.Wait(TimeSpan.FromSeconds(10)));
            fixture.Provider.Current = new PluginConfiguration { TagCacheServerMode = false };
            fixture.Lifecycle.NotifyConfigurationChanged();
            release.Set();
            await initialize;

            Assert.False(fixture.Lifecycle.IsReady);
            Assert.True(fixture.Cache.IsSuspendedForTest);
            Assert.Equal(0, fixture.Cache.Count);
        }

        [Fact]
        public async Task IncrementalEventDuringDiskLoad_RemainsPendingAndAppliesAfterLoadedSnapshot()
        {
            using var fixture = new Fixture(enabled: true);
            var oldId = Guid.NewGuid();
            fixture.Cache.SeedEntryForTest(Key(oldId), new TagCacheEntry { Type = "Movie" });
            fixture.Cache.SaveToDisk();
            fixture.Cache.SwapCacheAndCursorForTest(
                new Dictionary<string, TagCacheEntry>(),
                version: 0,
                lastModified: 0);

            var added = new StubMovie { Id = Guid.NewGuid(), DateLastSaved = DateTime.UtcNow };
            fixture.Library.GetItemByIdHook = id => id == added.Id ? added : null;
            fixture.Cache.OnAfterDiskReadForTest = () => fixture.Library.RaiseItemAdded(added);

            await fixture.Lifecycle.InitializeAsync(null, CancellationToken.None);

            Assert.True(fixture.Cache.ContainsKeyForTest(Key(oldId)));
            Assert.Equal(1, fixture.Cache.PendingChangeCountForTest);
            fixture.Cache.FlushPendingForTest();
            Assert.True(fixture.Cache.ContainsKeyForTest(Key(oldId)));
            Assert.True(fixture.Cache.ContainsKeyForTest(Key(added.Id)));
        }

        [Fact]
        public async Task DisableAfterIncrementalApply_CannotResurrectSaveTimerOrOverwriteDisk()
        {
            using var fixture = new Fixture(enabled: true);
            fixture.Library.GetItemListHook = _ => Array.Empty<BaseItem>();
            await fixture.Lifecycle.ReconcileAsync(null, CancellationToken.None);
            var diskBefore = File.ReadAllBytes(fixture.CacheFilePath);
            var saveCallsBefore = fixture.Cache.SaveToDiskCallsForTest;
            var movie = new StubMovie { Id = Guid.NewGuid(), DateLastSaved = DateTime.UtcNow };
            fixture.Library.GetItemByIdHook = id => id == movie.Id ? movie : null;
            var applied = new ManualResetEventSlim();
            var release = new ManualResetEventSlim();
            fixture.Cache.OnAfterFlushApplyForTest = () =>
            {
                applied.Set();
                release.Wait(TimeSpan.FromSeconds(10));
            };
            fixture.Cache.EnqueueUpdate(movie.Id);

            var flush = Task.Run(fixture.Cache.FlushPendingForTest);
            Assert.True(applied.Wait(TimeSpan.FromSeconds(10)));
            fixture.Provider.Current = new PluginConfiguration { TagCacheServerMode = false };
            fixture.Lifecycle.NotifyConfigurationChanged();
            release.Set();
            await flush;

            Assert.Equal(0, fixture.Cache.Count);
            Assert.False(fixture.Cache.HasFlushTimerForTest);
            Assert.Equal(saveCallsBefore, fixture.Cache.SaveToDiskCallsForTest);
            Assert.Equal(diskBefore, File.ReadAllBytes(fixture.CacheFilePath));
        }

        [Fact]
        public async Task NormalShutdown_DrainsPendingIncrementalChangeBeforeCacheDisposal()
        {
            using var fixture = new Fixture(enabled: true);
            fixture.Library.GetItemListHook = _ => Array.Empty<BaseItem>();
            await fixture.Lifecycle.ReconcileAsync(null, CancellationToken.None);

            var movie = new StubMovie { Id = Guid.NewGuid(), DateLastSaved = DateTime.UtcNow };
            fixture.Library.GetItemByIdHook = id => id == movie.Id ? movie : null;
            fixture.Cache.EnqueueUpdate(movie.Id);

            // The host disposes the lifecycle owner before the cache singleton. The
            // lifecycle must leave pending cache work intact so the cache can drain
            // and persist it during its own shutdown.
            fixture.Lifecycle.Dispose();
            fixture.Cache.Dispose();

            using var restored = new TagCacheService(
                fixture.Library,
                new StubAppPaths(fixture.RootDirectory),
                NullLogger<TagCacheService>.Instance);
            restored.LoadFromDisk();

            Assert.True(restored.ContainsKeyForTest(Key(movie.Id)));
        }

        [Fact]
        public async Task LargeLibrary_GeneratesOnlyFixedPagesWithMonotonicOffsets()
        {
            using var fixture = new Fixture(enabled: true);
            const int MovieCount = 10_001;
            var maxMaterializedRows = 0;
            var observed = new List<(
                BaseItemKind[] Types,
                int Start,
                int Limit,
                int Returned,
                bool EnableTotalRecordCount,
                IReadOnlyList<(ItemSortBy OrderBy, JSortOrder SortOrder)> OrderBy)>();
            fixture.Library.GetItemsResultHook = query =>
            {
                var isSeries = query.IncludeItemTypes.Contains(BaseItemKind.Series);
                var start = query.StartIndex ?? 0;
                var limit = query.Limit ?? int.MaxValue;
                var returned = isSeries ? 0 : Math.Min(limit, Math.Max(0, MovieCount - start));
                var result = Enumerable.Range(start, returned)
                    .Select(index => (BaseItem)new StubMovie
                    {
                        Id = new Guid(index + 1, 0, 0, new byte[8]),
                        DateLastSaved = DateTime.UnixEpoch.AddTicks(index + 1)
                    })
                    .ToArray();
                maxMaterializedRows = Math.Max(maxMaterializedRows, result.Length);
                observed.Add((
                    query.IncludeItemTypes,
                    start,
                    limit,
                    result.Length,
                    query.EnableTotalRecordCount,
                    query.OrderBy));
                return new MediaBrowser.Model.Querying.QueryResult<BaseItem>(
                    query.StartIndex,
                    isSeries ? 0 : MovieCount,
                    result);
            };

            await fixture.Lifecycle.ReconcileAsync(null, CancellationToken.None);

            Assert.True(fixture.Lifecycle.IsReady);
            Assert.Equal(MovieCount, fixture.Cache.Count);
            Assert.InRange(maxMaterializedRows, 1, TagCacheService.FullCachePageSize);
            Assert.All(observed, call => Assert.InRange(call.Limit, 1, TagCacheService.FullCachePageSize));
            var series = Assert.Single(observed, call => call.Types.Contains(BaseItemKind.Series));
            Assert.Equal(0, series.Start);
            Assert.Equal(0, series.Returned);
            Assert.True(series.EnableTotalRecordCount);
            var nonSeries = observed
                .Where(call => !call.Types.Contains(BaseItemKind.Series))
                .ToArray();
            Assert.Equal(21, nonSeries.Length);
            Assert.Equal(
                Enumerable.Range(0, 21).Select(page => page * TagCacheService.FullCachePageSize),
                nonSeries.Select(call => call.Start));
            Assert.Equal(1, nonSeries[^1].Returned);
            Assert.True(nonSeries[0].EnableTotalRecordCount);
            Assert.All(nonSeries.Skip(1), call => Assert.False(call.EnableTotalRecordCount));
            Assert.All(
                observed,
                call => Assert.Contains(
                    call.OrderBy,
                    order => order.OrderBy == ItemSortBy.SortName && order.SortOrder == JSortOrder.Ascending));
        }

        [Fact]
        public void LibraryEventDuringOffsetPaging_DiscardsReplacementAndRetainsLastGood()
        {
            using var fixture = new Fixture(enabled: true);
            var oldId = Guid.NewGuid();
            var oldEntry = new TagCacheEntry { Type = "Movie", Genres = new[] { "Last good" } };
            fixture.Cache.SeedEntryForTest(Key(oldId), oldEntry);
            var movies = Enumerable.Range(0, 600)
                .Select(_ => (BaseItem)new StubMovie { Id = Guid.NewGuid(), DateLastSaved = DateTime.UtcNow })
                .ToArray();
            fixture.Library.GetItemListHook = query =>
            {
                var page = Page(query, movies);
                if (!query.IncludeItemTypes.Contains(BaseItemKind.Series)
                    && query.StartIndex == 0)
                {
                    fixture.Cache.EnqueueRemoval(Guid.NewGuid());
                }

                return page;
            };

            var error = Assert.Throws<InvalidOperationException>(
                () => fixture.Cache.BuildFullCache(null, CancellationToken.None));

            Assert.Contains("library changed", error.Message, StringComparison.OrdinalIgnoreCase);
            Assert.Same(oldEntry, fixture.Cache.GetEntryForTest(Key(oldId)));
        }

        [Fact]
        public void EqualSortBoundaryOverlap_CannotPublishAnOmittedRow()
        {
            using var fixture = new Fixture(enabled: true);
            var oldId = Guid.NewGuid();
            var oldEntry = new TagCacheEntry { Type = "Movie", Genres = new[] { "Last good" } };
            fixture.Cache.SeedEntryForTest(Key(oldId), oldEntry);
            fixture.Cache.SaveToDisk();
            var diskBefore = File.ReadAllBytes(fixture.CacheFilePath);
            var movies = Enumerable.Range(0, 600)
                .Select(_ => (BaseItem)new StubMovie
                {
                    Id = Guid.NewGuid(),
                    Name = "Same title",
                    SortName = "Same title",
                    DateLastSaved = DateTime.UtcNow
                })
                .ToArray();
            fixture.Library.GetItemsResultHook = query =>
            {
                if (query.IncludeItemTypes.Contains(BaseItemKind.Series))
                {
                    return new MediaBrowser.Model.Querying.QueryResult<BaseItem>(
                        query.StartIndex,
                        0,
                        Array.Empty<BaseItem>());
                }

                var items = (query.StartIndex ?? 0) == 0
                    ? movies.Take(TagCacheService.FullCachePageSize).ToArray()
                    : movies.Skip(TagCacheService.FullCachePageSize - 1).Take(100).ToArray();
                return new MediaBrowser.Model.Querying.QueryResult<BaseItem>(
                    query.StartIndex,
                    movies.Length,
                    items);
            };

            var error = Assert.Throws<InvalidOperationException>(
                () => fixture.Cache.BuildFullCache(null, CancellationToken.None));

            Assert.Contains("distinct rows", error.Message, StringComparison.OrdinalIgnoreCase);
            Assert.Same(oldEntry, fixture.Cache.GetEntryForTest(Key(oldId)));
            Assert.Equal(diskBefore, File.ReadAllBytes(fixture.CacheFilePath));
        }

        [Fact]
        public void MalformedLibraryRow_AbortsWithoutPublishingPartialReplacement()
        {
            using var fixture = new Fixture(enabled: true);
            var oldId = Guid.NewGuid();
            var oldEntry = new TagCacheEntry { Type = "Movie", Genres = new[] { "Last good" } };
            fixture.Cache.SeedEntryForTest(Key(oldId), oldEntry);
            fixture.Cache.SaveToDisk();
            var diskBefore = File.ReadAllBytes(fixture.CacheFilePath);
            fixture.Library.GetItemsResultHook = query =>
            {
                var rows = query.IncludeItemTypes.Contains(BaseItemKind.Series)
                    ? Array.Empty<BaseItem>()
                    : new BaseItem[] { null! };
                return new MediaBrowser.Model.Querying.QueryResult<BaseItem>(
                    query.StartIndex,
                    rows.Length,
                    rows);
            };

            Assert.ThrowsAny<Exception>(
                () => fixture.Cache.BuildFullCache(null, CancellationToken.None));

            Assert.Same(oldEntry, fixture.Cache.GetEntryForTest(Key(oldId)));
            Assert.Equal(diskBefore, File.ReadAllBytes(fixture.CacheFilePath));
        }

        [Fact]
        public async Task LaterPageFailure_RetainsExactLastGoodMemoryAndDisk()
        {
            using var fixture = new Fixture(enabled: true);
            var oldId = Guid.NewGuid();
            var oldEntry = new TagCacheEntry { Type = "Movie", Genres = new[] { "Last good" } };
            fixture.Cache.SeedEntryForTest(Key(oldId), oldEntry);
            fixture.Cache.SaveToDisk();
            var path = fixture.CacheFilePath;
            var diskBefore = File.ReadAllBytes(path);
            var movies = Enumerable.Range(0, 600)
                .Select(_ => (BaseItem)new StubMovie
                {
                    Id = Guid.NewGuid(),
                    DateLastSaved = DateTime.UtcNow
                })
                .ToArray();
            fixture.Library.GetItemsResultHook = query =>
            {
                if (query.IncludeItemTypes.Contains(BaseItemKind.Series))
                {
                    return new MediaBrowser.Model.Querying.QueryResult<BaseItem>(
                        query.StartIndex,
                        0,
                        Array.Empty<BaseItem>());
                }

                if (query.StartIndex >= TagCacheService.FullCachePageSize)
                {
                    throw new IOException("page fault");
                }

                return new MediaBrowser.Model.Querying.QueryResult<BaseItem>(
                    query.StartIndex,
                    movies.Length,
                    Page(query, movies));
            };

            await Assert.ThrowsAsync<IOException>(
                () => fixture.Lifecycle.ReconcileAsync(null, CancellationToken.None));

            Assert.Same(oldEntry, fixture.Cache.GetEntryForTest(Key(oldId)));
            Assert.Equal(1, fixture.Cache.Count);
            Assert.Equal(diskBefore, File.ReadAllBytes(path));
            Assert.Equal(1, fixture.Cache.SaveToDiskCallsForTest);
            Assert.False(fixture.Lifecycle.IsReady);
        }

        [Fact]
        public async Task PersistenceFailure_RollsBackMemoryJournalAndDiskBeforeReadiness()
        {
            using var fixture = new Fixture(enabled: true);
            var oldId = Guid.NewGuid();
            var oldEntry = new TagCacheEntry { Type = "Movie", Genres = new[] { "Durable" } };
            fixture.Cache.SeedEntryForTest(Key(oldId), oldEntry);
            fixture.Cache.SaveToDisk();
            var diskBefore = File.ReadAllBytes(fixture.CacheFilePath);
            var revisionBefore = fixture.Cache.ContentRevision;
            var replacement = new StubMovie { Id = Guid.NewGuid(), DateLastSaved = DateTime.UtcNow };
            fixture.Library.GetItemListHook = query => Page(query, new BaseItem[] { replacement });
            fixture.Cache.OnBeforeCachePersistForTest = () => throw new IOException("disk fault");

            var error = await Assert.ThrowsAsync<IOException>(
                () => fixture.Lifecycle.ReconcileAsync(null, CancellationToken.None));

            Assert.Contains("could not be persisted", error.Message, StringComparison.OrdinalIgnoreCase);
            Assert.Same(oldEntry, fixture.Cache.GetEntryForTest(Key(oldId)));
            Assert.False(fixture.Cache.ContainsKeyForTest(Key(replacement.Id)));
            Assert.Equal(revisionBefore, fixture.Cache.ContentRevision);
            Assert.Equal(diskBefore, File.ReadAllBytes(fixture.CacheFilePath));
            Assert.False(fixture.Lifecycle.IsReady);
        }

        [Fact]
        public async Task ReaderWaitsForPersistenceFailureRollbackAndNeverSeesProvisionalReplacement()
        {
            using var fixture = new Fixture(enabled: true);
            var oldId = Guid.NewGuid();
            fixture.Cache.SeedEntryForTest(Key(oldId), new TagCacheEntry { Type = "Movie" });
            fixture.Cache.SaveToDisk();
            var replacement = new StubMovie { Id = Guid.NewGuid(), DateLastSaved = DateTime.UtcNow };
            fixture.Library.GetItemListHook = query => Page(query, new BaseItem[] { replacement });
            var persistEntered = new ManualResetEventSlim();
            var releasePersist = new ManualResetEventSlim();
            fixture.Cache.OnBeforeCachePersistForTest = () =>
            {
                persistEntered.Set();
                releasePersist.Wait(TimeSpan.FromSeconds(10));
                throw new IOException("disk fault");
            };

            var reconcile = fixture.Lifecycle.ReconcileAsync(null, CancellationToken.None);
            Assert.True(persistEntered.Wait(TimeSpan.FromSeconds(10)));
            var reader = Task.Run(() => fixture.Cache.Count);
            Assert.NotSame(reader, await Task.WhenAny(reader, Task.Delay(100)));

            releasePersist.Set();
            await Assert.ThrowsAsync<IOException>(() => reconcile);
            Assert.Equal(1, await reader.WaitAsync(TimeSpan.FromSeconds(10)));
            Assert.True(fixture.Cache.ContainsKeyForTest(Key(oldId)));
            Assert.False(fixture.Cache.ContainsKeyForTest(Key(replacement.Id)));
        }

        [Fact]
        public async Task DisableDuringPersistence_RejectsTempCommitAndPreservesLastCompleteDisk()
        {
            using var fixture = new Fixture(enabled: true);
            var oldId = Guid.NewGuid();
            fixture.Cache.SeedEntryForTest(Key(oldId), new TagCacheEntry { Type = "Movie" });
            fixture.Cache.SaveToDisk();
            var diskBefore = File.ReadAllBytes(fixture.CacheFilePath);
            var replacement = new StubMovie { Id = Guid.NewGuid(), DateLastSaved = DateTime.UtcNow };
            fixture.Library.GetItemListHook = query => Page(query, new BaseItem[] { replacement });
            var persistEntered = new ManualResetEventSlim();
            var releasePersist = new ManualResetEventSlim();
            fixture.Cache.OnBeforeCachePersistForTest = () =>
            {
                persistEntered.Set();
                releasePersist.Wait(TimeSpan.FromSeconds(10));
            };

            var reconcile = fixture.Lifecycle.ReconcileAsync(null, CancellationToken.None);
            Assert.True(persistEntered.Wait(TimeSpan.FromSeconds(10)));
            fixture.Provider.Current = new PluginConfiguration { TagCacheServerMode = false };
            fixture.Lifecycle.NotifyConfigurationChanged();
            releasePersist.Set();
            await reconcile;

            Assert.True(SpinWait.SpinUntil(
                () => fixture.Cache.Count == 0,
                TimeSpan.FromSeconds(10)));
            Assert.Equal(diskBefore, File.ReadAllBytes(fixture.CacheFilePath));
            Assert.False(fixture.Lifecycle.IsReady);
        }

        private static IReadOnlyList<BaseItem> Page(InternalItemsQuery query, IReadOnlyList<BaseItem> source)
        {
            var included = query.IncludeItemTypes.ToHashSet();
            return source
                .Where(item => included.Contains(item.GetBaseItemKind()))
                .Skip(query.StartIndex ?? 0)
                .Take(query.Limit ?? source.Count)
                .ToArray();
        }

        private static string Key(Guid id) => id.ToString("N").ToLowerInvariant();

        private sealed class Fixture : IDisposable
        {
            private readonly string _dir;

            public Fixture(bool enabled)
            {
                _dir = Path.Combine(Path.GetTempPath(), "jc-tagcache-lifecycle-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(_dir);
                Provider = new FakePluginConfigProvider(
                    new PluginConfiguration { TagCacheServerMode = enabled });
                Library = new CountingLibraryManager();
                UserData = new StubUserDataManager();
                Cache = new TagCacheService(
                    Library,
                    new StubAppPaths(_dir),
                    NullLogger<TagCacheService>.Instance);
                Monitor = new TagCacheMonitor(Library, Cache, NullLogger<TagCacheMonitor>.Instance);
                Projection = new TagCacheProjectionRevisionService(
                    UserData,
                    NullLogger<TagCacheProjectionRevisionService>.Instance);
                Lifecycle = new TagCacheLifecycleService(
                    Provider,
                    Cache,
                    Monitor,
                    Projection,
                    NullLogger<TagCacheLifecycleService>.Instance);
            }

            public FakePluginConfigProvider Provider { get; }

            public CountingLibraryManager Library { get; }

            public StubUserDataManager UserData { get; }

            public TagCacheService Cache { get; }

            public TagCacheMonitor Monitor { get; }

            public TagCacheProjectionRevisionService Projection { get; }

            public TagCacheLifecycleService Lifecycle { get; }

            public string CacheFilePath => Path.Combine(
                _dir,
                "configurations",
                "Jellyfin.Plugin.JellyfinCanopy",
                "tag-cache.json");

            public string RootDirectory => _dir;

            public void Dispose()
            {
                Lifecycle.Dispose();
                Projection.Dispose();
                Monitor.Dispose();
                Cache.Dispose();
                try
                {
                    Directory.Delete(_dir, recursive: true);
                }
                catch
                {
                    // Best-effort test cleanup.
                }
            }
        }
    }
}
