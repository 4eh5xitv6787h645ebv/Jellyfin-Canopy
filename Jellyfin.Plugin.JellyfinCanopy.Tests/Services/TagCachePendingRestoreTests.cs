using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
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
        var drainReached = new ManualResetEventSlim();
        var allowDrain = new ManualResetEventSlim();
        var restoreReached = new ManualResetEventSlim();
        var allowRestore = new ManualResetEventSlim();
        var library = new CountingLibraryManager
        {
            GetItemsResultHook = static _ => new QueryResult<BaseItem>(0, 0, Array.Empty<BaseItem>()),
            GetItemByIdHook = static _ => null,
        };
        var service = NewService(directory, library);
        var resources = new RaceResources(service, directory, drainReached, allowDrain, restoreReached, allowRestore);
        var workers = new List<DedicatedWorker>();
        Exception? failure = null;
        try
        {
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

            var published = true;
            var build = StartWorker(workers, resources, () =>
                published = service.BuildFullCache(null, default, canPublish: () => false));

            Assert.True(drainReached.Wait(TimeSpan.FromSeconds(10)));
            var duringDrain = StartWorker(workers, resources, () => service.EnqueueUpdate(duringDrainId));
            await AssertEnqueueCompletesAsync(duringDrain);
            allowDrain.Set();

            Assert.True(restoreReached.Wait(TimeSpan.FromSeconds(10)));
            var duringRestore = StartWorker(workers, resources, () => service.EnqueueRemoval(racedId));
            await AssertEnqueueCompletesAsync(duringRestore);
            allowRestore.Set();

            await build.Completion.WaitAsync(TimeSpan.FromSeconds(10));
            Assert.False(published);
            var restored = service.DrainPendingForTest().ToDictionary(change => change.Id);
            Assert.Equal(olderIds.Length + 2, restored.Count);
            Assert.All(olderIds, id => Assert.False(restored[id].Removed));
            Assert.False(restored[duringDrainId].Removed);
            Assert.True(restored[racedId].Removed);
        }
        catch (Exception ex)
        {
            failure = ex;
            throw;
        }
        finally
        {
            allowDrain.Set();
            allowRestore.Set();
            JoinWorkers(workers, resources, failure);
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
        var restoreReached = new ManualResetEventSlim();
        var allowRestore = new ManualResetEventSlim();
        var library = new CountingLibraryManager
        {
            GetItemsResultHook = static _ => new QueryResult<BaseItem>(0, 0, Array.Empty<BaseItem>()),
            GetItemByIdHook = id => id == movie.Id ? movie : null,
        };
        var owned = NewService(directory, library);
        var resources = new RaceResources(owned, directory, restoreReached, allowRestore);
        var workers = new List<DedicatedWorker>();
        Exception? failure = null;
        try
        {
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

            var published = true;
            var build = StartWorker(workers, resources, () =>
                published = owned.BuildFullCache(null, default, canPublish: () => false));
            Assert.True(restoreReached.Wait(TimeSpan.FromSeconds(10)));
            owned.Suspend();
            owned.Resume();
            allowRestore.Set();
            await build.Completion.WaitAsync(TimeSpan.FromSeconds(10));
            Assert.False(published);
            Assert.False(owned.IsSuspendedForTest);
            Assert.Equal(0, owned.PendingChangeCountForTest);
            Assert.Equal(0, owned.Count);

            owned.FlushPendingForTest();
            owned.BuildFullCache(null, default);
            Assert.Equal(0, owned.PendingChangeCountForTest);
            Assert.Equal(0, owned.Count);
        }
        catch (Exception ex)
        {
            failure = ex;
            throw;
        }
        finally
        {
            allowRestore.Set();
            JoinWorkers(workers, resources, failure);
        }
    }

    private static DedicatedWorker StartWorker(List<DedicatedWorker> workers, RaceResources resources, Action operation)
    {
        var worker = new DedicatedWorker(resources, operation);
        workers.Add(worker);
        worker.Start();
        return worker;
    }

    private static async Task AssertEnqueueCompletesAsync(DedicatedWorker worker)
    {
        // Worker startup is a handshake. Only the actual scan-thread operation owns
        // the one-second budget; a shared ThreadPool queue is not part of enqueue.
        try { await worker.Started.WaitAsync(TimeSpan.FromSeconds(10)); }
        catch (TimeoutException ex) { throw new TimeoutException("Enqueue worker did not start within ten seconds.", ex); }
        try { await worker.Completion.WaitAsync(TimeSpan.FromSeconds(1)); }
        catch (TimeoutException ex) { throw new TimeoutException("Enqueue did not complete within one second after worker startup.", ex); }
        Assert.True(worker.Elapsed <= TimeSpan.FromSeconds(1),
            $"Enqueue took {worker.Elapsed.TotalMilliseconds:F3} ms after its worker started.");
    }

    private static void JoinWorkers(List<DedicatedWorker> workers, RaceResources resources, Exception? failure)
    {
        var errors = new List<Exception>();
        foreach (var worker in workers)
        {
            try
            {
                Assert.True(worker.Join(), "Dedicated race worker did not exit within ten seconds.");
            }
            catch (Exception ex)
            {
                errors.Add(ex);
            }
        }

        // A timed-out/throwing join is not permission to dispose an actor's resources.
        // Controller release cleans synchronously only after every actor has released its lease.
        resources.Release();
        errors.AddRange(resources.Failures);
        if (errors.Count == 0) return;
        if (failure != null && !errors.Contains(failure)) errors.Insert(0, failure);
        var aggregate = new AggregateException("Race worker cleanup failed.", errors);
        // A failed test can return before a surviving actor. Retain its eventual cleanup
        // result (including late worker/disposal faults) with the original failure evidence.
        aggregate.Data["RaceCleanup"] = resources.Cleanup;
        throw aggregate;
    }

    /// <summary>Retains the fixture until both its controller and every actor relinquish ownership.</summary>
    private sealed class RaceResources
    {
        private readonly TagCacheService _service;
        private readonly string _directory;
        private readonly ManualResetEventSlim[] _gates;
        private readonly ConcurrentQueue<Exception> _failures = new();
        private readonly TaskCompletionSource _cleanup = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _owners = 1;

        public RaceResources(TagCacheService service, string directory, params ManualResetEventSlim[] gates)
        {
            _service = service;
            _directory = directory;
            _gates = gates;
        }

        public Task Cleanup => _cleanup.Task;
        public Exception[] Failures => _failures.ToArray();
        public void Retain() => Interlocked.Increment(ref _owners);
        public void RecordFailure(Exception failure) => _failures.Enqueue(failure);

        public void Release()
        {
            if (Interlocked.Decrement(ref _owners) != 0) return;
            // The last actor calls this only after its operation returns, so even deferred
            // cleanup cannot dispose a gate/service still in use by another race actor.
            try { _service.Dispose(); }
            catch (Exception ex) { RecordFailure(ex); }
            foreach (var gate in _gates)
            {
                try { gate.Dispose(); }
                catch (Exception ex) { RecordFailure(ex); }
            }
            TryDelete(_directory);
            if (_failures.IsEmpty) _cleanup.SetResult();
            else
            {
                _cleanup.SetException(_failures);
                _ = Cleanup.Exception; // Retain late errors without an unobserved-task exception.
            }
        }
    }

    /// <summary>Owns one synchronous race actor independently of the shared test ThreadPool.</summary>
    private sealed class DedicatedWorker
    {
        private readonly TaskCompletionSource _started = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly Thread _thread;
        private readonly RaceResources _resources;
        private bool _wasStarted;

        public DedicatedWorker(RaceResources resources, Action operation)
        {
            _resources = resources;
            _thread = new Thread(() =>
            {
                var startedAt = Stopwatch.GetTimestamp();
                _started.SetResult();
                try
                {
                    operation();
                    Elapsed = Stopwatch.GetElapsedTime(startedAt);
                    _completion.SetResult();
                }
                catch (Exception ex)
                {
                    resources.RecordFailure(ex);
                    _completion.SetException(ex);
                    _ = Completion.Exception;
                }
                finally
                {
                    resources.Release();
                }
            }) { IsBackground = true };
        }

        public Task Started => _started.Task;
        public Task Completion => _completion.Task;
        public TimeSpan Elapsed { get; private set; }

        public void Start()
        {
            _resources.Retain();
            try
            {
                _thread.Start();
                _wasStarted = true;
            }
            catch
            {
                _resources.Release();
                throw;
            }
        }

        public bool Join() => !_wasStarted || _thread.Join(TimeSpan.FromSeconds(10));
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
