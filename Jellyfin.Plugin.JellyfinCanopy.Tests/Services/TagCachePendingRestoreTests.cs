using System;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinCanopy.Model;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Querying;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class TagCachePendingRestoreTests
{
    [Fact]
    public async Task PausedHandoffDrainAndRestore_DoNotBlockEnqueue_AndLoseNoEvents()
    {
        var directory = TempDirectory();
        var olderIds = Enumerable.Range(0, 2_048).Select(_ => Guid.NewGuid()).ToArray();
        var racedId = Guid.NewGuid();
        var duringDrainId = Guid.NewGuid();
        using var drainReached = new ManualResetEventSlim();
        using var allowDrain = new ManualResetEventSlim();
        using var restoreReached = new ManualResetEventSlim();
        using var allowRestore = new ManualResetEventSlim();
        var library = new CountingLibraryManager
        {
            GetItemsResultHook = static _ => new QueryResult<BaseItem>(0, 0, Array.Empty<BaseItem>()),
            GetItemByIdHook = static _ => null,
        };
        Task<bool>? build = null;
        try
        {
            using var service = NewService(directory, library);
            service.OnBeforeSwapForTest = () =>
            {
                service.OnBeforeSwapForTest = null;
                foreach (var id in olderIds) service.EnqueueUpdate(id);
                service.EnqueueUpdate(racedId);
            };
            service.OnBeforePendingHandoffDrainForTest = () =>
            {
                service.OnBeforePendingHandoffDrainForTest = null;
                drainReached.Set();
                Assert.True(allowDrain.Wait(TimeSpan.FromSeconds(10)));
            };
            service.OnBeforePendingRestoreReplayForTest = () =>
            {
                service.OnBeforePendingRestoreReplayForTest = null;
                restoreReached.Set();
                Assert.True(allowRestore.Wait(TimeSpan.FromSeconds(10)));
            };

            build = Task.Run(() => service.BuildFullCache(null, default, canPublish: () => false));

            Assert.True(drainReached.Wait(TimeSpan.FromSeconds(10)));
            var duringDrain = Task.Run(() => service.EnqueueUpdate(duringDrainId));
            await duringDrain.WaitAsync(TimeSpan.FromSeconds(1));
            allowDrain.Set();

            Assert.True(restoreReached.Wait(TimeSpan.FromSeconds(10)));
            var duringRestore = Task.Run(() => service.EnqueueRemoval(racedId));
            await duringRestore.WaitAsync(TimeSpan.FromSeconds(1));
            allowRestore.Set();

            Assert.False(await build.WaitAsync(TimeSpan.FromSeconds(10)));
            var restored = service.DrainPendingForTest().ToDictionary(change => change.Id);
            Assert.Equal(olderIds.Length + 2, restored.Count);
            Assert.All(olderIds, id => Assert.False(restored[id].Removed));
            Assert.False(restored[duringDrainId].Removed);
            Assert.True(restored[racedId].Removed);
        }
        finally
        {
            allowDrain.Set();
            allowRestore.Set();
            if (build != null) await build.WaitAsync(TimeSpan.FromSeconds(10));
            TryDelete(directory);
        }
    }

    [Fact]
    public void SaveRollback_RestoresOlderUpdateWithoutOverwritingNewerSameIdRemoval()
    {
        var directory = TempDirectory();
        var movie = new StubMovie { Id = Guid.NewGuid(), DateLastSaved = DateTime.UtcNow };
        var library = new CountingLibraryManager
        {
            GetItemsResultHook = query =>
            {
                var rows = query.IncludeItemTypes.Contains(BaseItemKind.Movie)
                    ? new BaseItem[] { movie }
                    : Array.Empty<BaseItem>();
                return new QueryResult<BaseItem>(0, rows.Length, rows);
            },
            GetItemByIdHook = id => id == movie.Id ? movie : null,
        };
        try
        {
            using var service = NewService(directory, library);
            service.SeedEntryForTest(Key(movie.Id), new TagCacheEntry { Type = "Movie", SourceRevision = 1 });
            service.OnBeforeSwapForTest = () =>
            {
                service.OnBeforeSwapForTest = null;
                service.EnqueueItemChange(movie, removed: false); // older drained token
            };
            var canPublish = true;
            service.OnBeforeCachePersistForTest = () =>
            {
                service.OnBeforeCachePersistForTest = null;
                service.EnqueueRemoval(movie.Id); // genuinely newer intent after drain
                canPublish = false; // reject the disk commit and roll memory back
            };

            Assert.Throws<OperationCanceledException>(() =>
                service.BuildFullCache(null, default, canPublish: () => canPublish));

            var restored = Assert.Single(service.DrainPendingForTest());
            Assert.Equal(movie.Id, restored.Id);
            Assert.True(restored.Removed);
            Assert.Equal(0, restored.RetryAttempts);
        }
        finally
        {
            TryDelete(directory);
        }
    }

    [Fact]
    public void RejectedPublish_RestoresOlderRelationshipTokenBeforeNewerSameIdUpdate()
    {
        var directory = TempDirectory();
        var episodeId = Guid.NewGuid();
        var priorSeriesId = Guid.NewGuid();
        var priorSeasonId = Guid.NewGuid();
        var intermediateSeriesId = Guid.NewGuid();
        var intermediateSeasonId = Guid.NewGuid();
        var latestSeriesId = Guid.NewGuid();
        var latestSeasonId = Guid.NewGuid();
        var older = new StubEpisode
        {
            Id = episodeId,
            SeriesId = intermediateSeriesId,
            SeasonId = intermediateSeasonId,
            DateLastSaved = DateTime.UtcNow,
        };
        var newer = new StubEpisode
        {
            Id = episodeId,
            SeriesId = latestSeriesId,
            SeasonId = latestSeasonId,
            DateLastSaved = older.DateLastSaved.AddTicks(1),
        };
        TagCacheService? service = null;
        var newerQueued = false;
        var library = new CountingLibraryManager
        {
            GetItemsResultHook = static _ => new QueryResult<BaseItem>(0, 0, Array.Empty<BaseItem>()),
            GetItemListHook = static _ => Array.Empty<BaseItem>(),
            GetItemByIdHook = id =>
            {
                if (id == episodeId)
                {
                    if (!newerQueued)
                    {
                        newerQueued = true;
                        service!.EnqueueItemChange(newer, removed: false);
                    }

                    return newer;
                }

                if (id == priorSeasonId || id == intermediateSeasonId || id == latestSeasonId)
                {
                    return new StubSeason { Id = id, SeriesId = latestSeriesId };
                }

                return new StubSeries { Id = id };
            },
        };
        try
        {
            using var owned = NewService(directory, library);
            service = owned;
            owned.SeedEntryForTest(Key(episodeId), new TagCacheEntry
            {
                Type = "Episode",
                SeriesId = Key(priorSeriesId),
                SeasonId = Key(priorSeasonId),
                SourceRevision = 1,
            });
            owned.OnBeforeSwapForTest = () =>
            {
                owned.OnBeforeSwapForTest = null;
                owned.EnqueueItemChange(older, removed: false);
            };

            Assert.False(owned.BuildFullCache(null, default, canPublish: () => false));

            var restored = owned.DrainPendingForTest().Single(change => change.Id == episodeId);
            Assert.False(restored.Removed);
            Assert.Equal(latestSeriesId, restored.SeriesId);
            Assert.Equal(latestSeasonId, restored.SeasonId);
            Assert.Equal(priorSeriesId, restored.PreviousSeriesId);
            Assert.Equal(priorSeasonId, restored.PreviousSeasonId);
            Assert.Equal(0, restored.RetryAttempts);
        }
        finally
        {
            TryDelete(directory);
        }
    }

    [Fact]
    public async Task SuspendResumeDuringRestoreReplay_DropsTheCapturedRetiredContainer()
    {
        var directory = TempDirectory();
        var movie = new StubMovie { Id = Guid.NewGuid(), DateLastSaved = DateTime.UtcNow };
        using var restoreReached = new ManualResetEventSlim();
        using var allowRestore = new ManualResetEventSlim();
        var library = new CountingLibraryManager
        {
            GetItemsResultHook = static _ => new QueryResult<BaseItem>(0, 0, Array.Empty<BaseItem>()),
            GetItemByIdHook = id => id == movie.Id ? movie : null,
        };
        Task<bool>? build = null;
        try
        {
            using var owned = NewService(directory, library);
            owned.SeedEntryForTest(Key(movie.Id), new TagCacheEntry { Type = "Movie", SourceRevision = 1 });
            owned.OnBeforeSwapForTest = () =>
            {
                owned.OnBeforeSwapForTest = null;
                owned.EnqueueItemChange(movie, removed: false);
            };
            owned.OnBeforePendingRestoreReplayForTest = () =>
            {
                owned.OnBeforePendingRestoreReplayForTest = null;
                restoreReached.Set();
                Assert.True(allowRestore.Wait(TimeSpan.FromSeconds(10)));
            };

            build = Task.Run(() => owned.BuildFullCache(null, default, canPublish: () => false));
            Assert.True(restoreReached.Wait(TimeSpan.FromSeconds(10)));
            owned.Suspend();
            owned.Resume();
            allowRestore.Set();
            Assert.False(await build.WaitAsync(TimeSpan.FromSeconds(10)));
            Assert.False(owned.IsSuspendedForTest);
            Assert.Equal(0, owned.PendingChangeCountForTest);
            Assert.Equal(0, owned.Count);

            owned.FlushPendingForTest();
            owned.BuildFullCache(null, default);
            Assert.Equal(0, owned.PendingChangeCountForTest);
            Assert.Equal(0, owned.Count);
        }
        finally
        {
            allowRestore.Set();
            if (build != null) await build.WaitAsync(TimeSpan.FromSeconds(10));
            TryDelete(directory);
        }
    }

    private static TagCacheService NewService(string directory, CountingLibraryManager library)
        => new(library, new StubAppPaths(directory), NullLogger<TagCacheService>.Instance);

    private static string TempDirectory()
        => Path.Combine(Path.GetTempPath(), "canopy-pending-restore-" + Guid.NewGuid().ToString("N"));

    private static string Key(Guid id) => id.ToString("N");

    private static void TryDelete(string directory)
    {
        try { Directory.Delete(directory, recursive: true); } catch { }
    }
}
