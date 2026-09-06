using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Model;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Model.Dto;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

/// <summary>
/// Drive real pending publication and atomic disk writes through a monotonic manual save clock.
/// Timer callbacks can deliberately survive Change/Dispose, as callbacks already queued by the
/// runtime do. No test waits out a multi-minute debounce or alters a public production contract.
/// </summary>
public sealed class TagCacheSaveDeadlineTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Reconcile_PostCommitLoggerFailure_PublishesDurableReplacementAndPreservesNextWindow(bool throwOnError)
    {
        var logger = new ThrowingSaveLogger();
        using var fixture = new Fixture(logger);
        fixture.Change("durable");
        Assert.True(fixture.Cache.SaveToDisk());
        fixture.Change("unsaved original");
        var revision = fixture.Cache.ContentRevision;
        fixture.Clock.Advance(20);
        // The library can change independently of an incremental event: rollback must not rely
        // on a later pending-event replay to repair a post-commit memory/disk disagreement.
        fixture.UpdateLibrary("replacement");
        logger.ThrowOnSaved = true;
        logger.ThrowOnError = throwOnError;

        fixture.Cache.BuildFullCache(null, default);

        Assert.Equal(1, logger.SavedFailures);
        Assert.Equal("replacement", fixture.Cache.GetEntryForTest(fixture.Key)!.Genres![0]);
        Assert.Equal("replacement", fixture.DiskGenre());
        Assert.True(fixture.Cache.ContentRevision > revision);
        Assert.False(fixture.Cache.IsDirtyForTest);
        fixture.Clock.Advance(600);
        Assert.Equal(0, fixture.Cache.DebouncedSaveAttemptsForTest);
        Assert.Equal("replacement", fixture.DiskGenre());

        fixture.Change("next window");
        fixture.Clock.Advance(29);
        Assert.Equal("replacement", fixture.DiskGenre());
        fixture.Clock.Advance(1);
        Assert.Equal("next window", fixture.DiskGenre());
        Assert.Equal("next window", fixture.Cache.GetEntryForTest(fixture.Key)!.Genres![0]);
        Assert.False(fixture.Cache.IsDirtyForTest);
        Assert.Equal(1, fixture.Cache.DebouncedSaveAttemptsForTest);
    }

    [Fact]
    public void ExplicitSave_PostCommitLoggerFailure_ReportsCommittedSuccessAndRetiresWindow()
    {
        var logger = new ThrowingSaveLogger { ThrowOnSaved = true, ThrowOnError = true };
        using var fixture = new Fixture(logger);
        fixture.Change("committed");

        Assert.True(fixture.Cache.SaveToDisk());

        Assert.Equal(1, logger.SavedFailures);
        Assert.Equal("committed", fixture.DiskGenre());
        Assert.Equal("committed", fixture.Cache.GetEntryForTest(fixture.Key)!.Genres![0]);
        Assert.False(fixture.Cache.IsDirtyForTest);
        fixture.Clock.Advance(600);
        Assert.Equal(0, fixture.Cache.DebouncedSaveAttemptsForTest);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void PreCommitFailure_WithThrowingErrorLogger_PreservesFailureAndAutomaticRecovery(bool reconcile)
    {
        var logger = new ThrowingSaveLogger();
        using var fixture = new Fixture(logger);
        fixture.Change("durable");
        Assert.True(fixture.Cache.SaveToDisk());
        var durable = File.ReadAllBytes(fixture.Path);
        fixture.Change("unsaved original");
        var original = fixture.Cache.GetEntryForTest(fixture.Key);
        var revision = fixture.Cache.ContentRevision;
        fixture.Clock.Advance(20);
        logger.ThrowOnError = true;
        fixture.Cache.OnBeforeCachePersistForTest = () => throw new IOException("write failed before commit");
        if (reconcile)
        {
            fixture.UpdateLibrary("uncommitted replacement");
            Assert.Throws<IOException>(() => fixture.Cache.BuildFullCache(null, default));
        }
        else
        {
            Assert.False(fixture.Cache.SaveToDisk());
        }

        Assert.Equal(1, logger.ErrorFailures);
        Assert.Equal(durable, File.ReadAllBytes(fixture.Path));
        Assert.Same(original, fixture.Cache.GetEntryForTest(fixture.Key));
        Assert.Equal(revision, fixture.Cache.ContentRevision);
        Assert.True(fixture.Cache.IsDirtyForTest);
        fixture.Cache.OnBeforeCachePersistForTest = null;
        // Failed reconcile retains the old window; a failed ordinary save has a +30s retry floor.
        fixture.Clock.Advance(reconcile ? 9 : 29);
        Assert.Equal(durable, File.ReadAllBytes(fixture.Path));
        fixture.Clock.Advance(1);
        Assert.Equal("unsaved original", fixture.DiskGenre());
        Assert.False(fixture.Cache.IsDirtyForTest);
        Assert.Equal(1, fixture.Cache.DebouncedSaveAttemptsForTest);
    }

    [Fact]
    public void ContinuousRealChanges_AttemptAndCommitByFiveMinutes_ThenStartAFreshWindow()
    {
        using var fixture = new Fixture();
        fixture.Change("0");
        for (var seconds = 20; seconds < 300; seconds += 20)
        {
            fixture.Clock.Advance(20);
            fixture.Change(seconds.ToString(System.Globalization.CultureInfo.InvariantCulture));
        }

        fixture.Clock.Advance(19);
        Assert.Equal(0, fixture.Cache.DebouncedSaveAttemptsForTest);
        Assert.False(File.Exists(fixture.Path));
        fixture.Clock.Advance(1);
        Assert.Equal(1, fixture.Cache.DebouncedSaveAttemptsForTest);
        Assert.Equal(1, fixture.Cache.SaveToDiskCallsForTest);
        Assert.Equal("280", fixture.DiskGenre());
        Assert.False(fixture.Cache.IsDirtyForTest);

        fixture.Change("next window");
        fixture.Clock.Advance(29);
        Assert.Equal(1, fixture.Cache.SaveToDiskCallsForTest);
        fixture.Clock.Advance(1);
        Assert.Equal("next window", fixture.DiskGenre());
        Assert.Equal(2, fixture.Cache.SaveToDiskCallsForTest);
    }

    [Fact]
    public void OrdinaryBurst_PreservesThirtySecondTrailingDebounce()
    {
        using var fixture = new Fixture();
        fixture.Change("first");
        fixture.Clock.Advance(10);
        fixture.Change("second");
        fixture.Clock.Advance(20);
        Assert.Equal(0, fixture.Cache.SaveToDiskCallsForTest);
        fixture.Clock.Advance(9);
        Assert.False(File.Exists(fixture.Path));
        fixture.Clock.Advance(1);
        Assert.Equal("second", fixture.DiskGenre());
        Assert.Equal(1, fixture.Cache.SaveToDiskCallsForTest);
    }

    [Fact]
    public void EmptyFlushAndAbsentRemoval_DoNotCreateOrExtendSaveWindow()
    {
        using var fixture = new Fixture();
        fixture.Cache.FlushPendingForTest();
        fixture.Cache.EnqueueRemoval(Guid.NewGuid());
        fixture.Cache.FlushPendingForTest();
        fixture.Clock.Advance(300);
        Assert.Equal(0, fixture.Cache.DebouncedSaveAttemptsForTest);

        fixture.Change("pending");
        fixture.Clock.Advance(20);
        fixture.Cache.EnqueueRemoval(Guid.NewGuid());
        fixture.Cache.FlushPendingForTest();
        fixture.Clock.Advance(10);
        Assert.Equal("pending", fixture.DiskGenre());
        fixture.Cache.FlushPendingForTest();
        fixture.Clock.Advance(300);
        Assert.Equal(1, fixture.Cache.SaveToDiskCallsForTest);
    }

    [Fact]
    public void ExplicitSave_SatisfiesPendingWindowAndStillWorksWhenClean()
    {
        using var fixture = new Fixture();
        fixture.Change("explicit");
        Assert.True(fixture.Cache.SaveToDisk());
        fixture.Clock.Advance(300);
        Assert.Equal(0, fixture.Cache.DebouncedSaveAttemptsForTest);
        Assert.Equal("explicit", fixture.DiskGenre());
        Assert.True(fixture.Cache.SaveToDisk());
        Assert.Equal(2, fixture.Cache.SaveToDiskCallsForTest);
    }

    [Fact]
    public void DirtyVersionAfterSnapshot_RemainsScheduledWithoutAnotherEvent()
    {
        using var fixture = new Fixture();
        fixture.Change("snapshot");
        fixture.Cache.OnAfterSnapshotForTest = () =>
        {
            fixture.Cache.OnAfterSnapshotForTest = null;
            fixture.Cache.MarkDirtyForTest();
        };
        fixture.Clock.Advance(30);
        Assert.True(fixture.Cache.IsDirtyForTest);
        Assert.Equal(1, fixture.Cache.SaveToDiskCallsForTest);
        fixture.Clock.Advance(29);
        Assert.Equal(1, fixture.Cache.SaveToDiskCallsForTest);
        fixture.Clock.Advance(1);
        Assert.Equal(2, fixture.Cache.SaveToDiskCallsForTest);
        Assert.False(fixture.Cache.IsDirtyForTest);
    }

    [Fact]
    public void RealEventDuringSnapshot_StaysPendingAndPersistsAfterStableSnapshot()
    {
        using var fixture = new Fixture();
        fixture.Change("before snapshot");
        fixture.Cache.OnAfterSnapshotForTest = () =>
        {
            fixture.Cache.OnAfterSnapshotForTest = null;
            fixture.Queue("after snapshot");
            fixture.Cache.FlushPendingForTest(); // the stable writer owns the guard
            Assert.Equal(1, fixture.Cache.PendingChangeCountForTest);
        };
        fixture.Clock.Advance(30);
        Assert.Equal("before snapshot", fixture.DiskGenre());
        fixture.Cache.FlushPendingForTest();
        Assert.True(fixture.Cache.IsDirtyForTest);
        fixture.Clock.Advance(30);
        Assert.Equal("after snapshot", fixture.DiskGenre());
    }

    [Fact]
    public void FailedWrite_RetainsLastGoodBytesAndRetriesWithoutANewEvent()
    {
        using var fixture = new Fixture();
        fixture.Change("durable");
        Assert.True(fixture.Cache.SaveToDisk());
        var durable = File.ReadAllBytes(fixture.Path);
        fixture.Change("retry");
        fixture.Cache.OnBeforeCachePersistForTest = () => throw new IOException("one disk fault");
        fixture.Clock.Advance(30);
        Assert.Equal(durable, File.ReadAllBytes(fixture.Path));
        Assert.True(fixture.Cache.IsDirtyForTest);
        Assert.Equal(1, fixture.Cache.DebouncedSaveAttemptsForTest);
        fixture.Cache.OnBeforeCachePersistForTest = null;
        fixture.Clock.Advance(29);
        Assert.Equal(1, fixture.Cache.DebouncedSaveAttemptsForTest);
        fixture.Clock.Advance(1);
        Assert.Equal("retry", fixture.DiskGenre());
        Assert.False(fixture.Cache.IsDirtyForTest);
    }

    [Fact]
    public void PersistentFailureAfterCap_HasPositiveRetryDespiteContinuousChanges()
    {
        using var fixture = new Fixture();
        fixture.Cache.OnBeforeCachePersistForTest = () => throw new IOException("disk remains unavailable");
        fixture.Change("0");
        for (var seconds = 1; seconds <= 390; seconds++)
        {
            fixture.Clock.Advance(1);
            if (seconds % 10 == 0) fixture.Change(seconds.ToString(System.Globalization.CultureInfo.InvariantCulture));
        }

        Assert.Equal(4, fixture.Cache.DebouncedSaveAttemptsForTest); // 300, 330, 360, 390
        Assert.Equal(4, fixture.Cache.SaveToDiskCallsForTest);
        Assert.True(fixture.Cache.IsDirtyForTest);
        Assert.False(File.Exists(fixture.Path));
        fixture.Cache.OnBeforeCachePersistForTest = null;
        fixture.Clock.Advance(30);
        Assert.Equal("390", fixture.DiskGenre());
    }

    [Fact]
    public void GuardContentionAtExpiredCap_AttemptsOnceThenRetriesWithoutBlockingOrLosingDirtyState()
    {
        using var fixture = new Fixture();
        fixture.Change("first");
        for (var seconds = 20; seconds < 300; seconds += 20)
        {
            fixture.Clock.Advance(20);
            fixture.Change(seconds.ToString(System.Globalization.CultureInfo.InvariantCulture));
        }

        fixture.Cache.OnAfterFlushApplyForTest = () =>
        {
            fixture.Cache.OnAfterFlushApplyForTest = null;
            fixture.Clock.Advance(20); // five-minute deadline, while this real flush holds the guard
            Assert.Equal(1, fixture.Cache.DebouncedSaveAttemptsForTest);
            Assert.Equal(0, fixture.Cache.SaveToDiskCallsForTest);
            Assert.True(fixture.Cache.IsDirtyForTest);
        };
        fixture.Change("guard owner");
        fixture.Clock.Advance(29);
        Assert.Equal(1, fixture.Cache.DebouncedSaveAttemptsForTest);
        fixture.Clock.Advance(1);
        Assert.Equal(2, fixture.Cache.DebouncedSaveAttemptsForTest);
        Assert.Equal(1, fixture.Cache.SaveToDiskCallsForTest);
        Assert.Equal("guard owner", fixture.DiskGenre());
    }

    [Fact]
    public void QueuedCallbackBeforeChange_CannotShortenNewTrailingDeadline()
    {
        using var fixture = new Fixture();
        fixture.Change("first");
        fixture.Clock.Elapse(30);
        var queued = fixture.Clock.TakeDueCallback();
        fixture.Change("new burst");
        queued();
        Assert.Equal(0, fixture.Cache.DebouncedSaveAttemptsForTest);
        fixture.Clock.Advance(29);
        Assert.False(File.Exists(fixture.Path));
        fixture.Clock.Advance(1);
        Assert.Equal("new burst", fixture.DiskGenre());
    }

    [Fact]
    public void DuplicateQueuedCallbackDuringSave_CannotStartAnotherAttempt()
    {
        using var fixture = new Fixture();
        fixture.Change("one owner");
        fixture.Clock.Elapse(30);
        var queued = fixture.Clock.TakeDueCallback();
        fixture.Cache.OnBeforeCachePersistForTest = () =>
        {
            queued();
            Assert.Equal(1, fixture.Cache.DebouncedSaveAttemptsForTest);
        };
        queued();
        fixture.Cache.OnBeforeCachePersistForTest = null;
        queued(); // fully saved work also rejects a callback already queued before disarming
        fixture.Clock.Advance(300);
        Assert.Equal(1, fixture.Cache.SaveToDiskCallsForTest);
        Assert.Equal("one owner", fixture.DiskGenre());
    }

    [Fact]
    public void SuspendResume_RejectsQueuedOldCallbackAndStartsFreshWindow()
    {
        using var fixture = new Fixture();
        fixture.Change("old generation");
        fixture.Clock.Elapse(300);
        var queued = fixture.Clock.TakeDueCallback();
        fixture.Cache.Suspend();
        fixture.Cache.Resume();
        fixture.Change("new generation");
        queued();
        Assert.Equal(0, fixture.Cache.DebouncedSaveAttemptsForTest);
        fixture.Clock.Advance(29);
        Assert.False(File.Exists(fixture.Path));
        fixture.Clock.Advance(1);
        Assert.Equal("new generation", fixture.DiskGenre());
    }

    [Fact]
    public async Task SuspendResumeDuringActiveSave_RejectsOldCommitAndCompletion()
    {
        using var fixture = new Fixture();
        fixture.Change("durable");
        Assert.True(fixture.Cache.SaveToDisk());
        var durable = File.ReadAllBytes(fixture.Path);
        fixture.Change("obsolete");
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        fixture.Cache.OnBeforeCachePersistForTest = () =>
        {
            entered.Set();
            Assert.True(release.Wait(TimeSpan.FromSeconds(10)));
        };
        var save = Task.Run(() => fixture.Clock.Advance(30));
        try
        {
            Assert.True(entered.Wait(TimeSpan.FromSeconds(10)));
            fixture.Cache.Suspend();
            fixture.Cache.Resume();
            fixture.Queue("new generation");
        }
        finally
        {
            release.Set();
        }

        await save.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(durable, File.ReadAllBytes(fixture.Path));
        fixture.Cache.OnBeforeCachePersistForTest = null;
        fixture.Cache.FlushPendingForTest();
        fixture.Clock.Advance(30);
        Assert.Equal("new generation", fixture.DiskGenre());
        Assert.False(fixture.Cache.IsDirtyForTest);
    }

    [Fact]
    public void ReconcileFailure_PreservesOriginalDirtyWindowAfterRollback()
    {
        using var fixture = new Fixture();
        fixture.Change("durable");
        Assert.True(fixture.Cache.SaveToDisk());
        fixture.Change("unsaved original");
        var original = fixture.Cache.GetEntryForTest(fixture.Key);
        var revision = fixture.Cache.ContentRevision;
        var durable = File.ReadAllBytes(fixture.Path);
        fixture.Clock.Advance(20);
        fixture.Queue("replacement");
        fixture.Cache.OnBeforeCachePersistForTest = () => throw new IOException("replacement fault");
        Assert.Throws<IOException>(() => fixture.Cache.BuildFullCache(null, default));
        Assert.Same(original, fixture.Cache.GetEntryForTest(fixture.Key));
        Assert.Equal(revision, fixture.Cache.ContentRevision);
        Assert.Equal(durable, File.ReadAllBytes(fixture.Path));
        Assert.True(fixture.Cache.IsDirtyForTest);
        // Inspect the prior restored snapshot before separately replaying the restored event.
        fixture.Cache.DrainPendingForTest();
        fixture.Cache.OnBeforeCachePersistForTest = null;
        fixture.Clock.Advance(9);
        Assert.Equal(durable, File.ReadAllBytes(fixture.Path));
        fixture.Clock.Advance(1);
        Assert.Equal("unsaved original", fixture.DiskGenre());
    }

    [Fact]
    public void ReconcileFailure_PreservesContentionRetry()
    {
        using var fixture = new Fixture();
        fixture.Change("original");
        fixture.Cache.OnBeforeCachePersistForTest = () =>
        {
            fixture.Clock.Advance(30); // timer collides with the provisional replacement's guard
            Assert.Equal(1, fixture.Cache.DebouncedSaveAttemptsForTest);
            throw new IOException("replacement fault");
        };
        Assert.Throws<IOException>(() => fixture.Cache.BuildFullCache(null, default));
        Assert.True(fixture.Cache.IsDirtyForTest);
        fixture.Cache.OnBeforeCachePersistForTest = null;
        fixture.Clock.Advance(29);
        Assert.Equal(1, fixture.Cache.DebouncedSaveAttemptsForTest);
        fixture.Clock.Advance(1);
        Assert.Equal("original", fixture.DiskGenre());
    }

    [Fact]
    public void ReconcileRollbackAfterSuspendResume_CannotRestoreOldDirtyWindow()
    {
        using var fixture = new Fixture();
        fixture.Change("obsolete");
        fixture.Cache.OnBeforeCachePersistForTest = () =>
        {
            fixture.Cache.Suspend();
            fixture.Cache.Resume();
            throw new IOException("revoked replacement");
        };
        Assert.Throws<IOException>(() => fixture.Cache.BuildFullCache(null, default));
        Assert.False(fixture.Cache.IsDirtyForTest);
        fixture.Cache.OnBeforeCachePersistForTest = null;
        fixture.Clock.Advance(300);
        Assert.Equal(0, fixture.Cache.DebouncedSaveAttemptsForTest);
        fixture.Change("current");
        fixture.Clock.Advance(30);
        Assert.Equal("current", fixture.DiskGenre());
    }

    [Fact]
    public void SuccessfulReconcile_SatisfiesPendingSaveWindow()
    {
        using var fixture = new Fixture();
        fixture.Change("reconciled");
        fixture.Cache.BuildFullCache(null, default);
        fixture.Clock.Advance(300);
        Assert.Equal(1, fixture.Cache.SaveToDiskCallsForTest);
        Assert.Equal(0, fixture.Cache.DebouncedSaveAttemptsForTest);
        Assert.Equal("reconciled", fixture.DiskGenre());
    }

    [Fact]
    public void Dispose_DrainsPendingAndRejectsQueuedAutomaticCallback()
    {
        using var fixture = new Fixture();
        fixture.Change("first");
        fixture.Clock.Elapse(30);
        var queued = fixture.Clock.TakeDueCallback();
        fixture.Queue("shutdown drain");
        fixture.Cache.Dispose();
        Assert.Equal("shutdown drain", fixture.DiskGenre());
        var saves = fixture.Cache.SaveToDiskCallsForTest;
        queued();
        fixture.Clock.Advance(300);
        Assert.Equal(saves, fixture.Cache.SaveToDiskCallsForTest);
        Assert.Equal(0, fixture.Cache.DebouncedSaveAttemptsForTest);
        Assert.False(fixture.Cache.HasFlushTimerForTest);
    }

    [Fact]
    public void WallClockJumps_DoNotMoveMonotonicSaveDeadline()
    {
        using var fixture = new Fixture();
        fixture.Change("monotonic");
        fixture.Clock.WallClockOffset = TimeSpan.FromDays(-30);
        fixture.Clock.Advance(29);
        Assert.False(File.Exists(fixture.Path));
        fixture.Clock.WallClockOffset = TimeSpan.FromDays(30);
        fixture.Clock.Advance(1);
        Assert.Equal("monotonic", fixture.DiskGenre());
    }

    [Fact]
    public void ExplicitFailureWithoutWindow_CreatesAutomaticRetry()
    {
        using var fixture = new Fixture();
        fixture.Cache.SeedEntryForTest(fixture.Key, new TagCacheEntry { Type = "Movie", Genres = new[] { "seed" } });
        fixture.Cache.OnBeforeCachePersistForTest = () => throw new IOException("explicit write fault");
        Assert.False(fixture.Cache.SaveToDisk());
        Assert.True(fixture.Cache.IsDirtyForTest);
        fixture.Cache.OnBeforeCachePersistForTest = null;
        fixture.Clock.Advance(29);
        Assert.Equal(0, fixture.Cache.DebouncedSaveAttemptsForTest);
        fixture.Clock.Advance(1);
        Assert.Equal("seed", fixture.DiskGenre());
    }

    [Fact]
    public void ExplicitGuardFailure_CreatesRetryWithoutClearingEarlierDirtyWork()
    {
        using var fixture = new Fixture();
        fixture.Change("before");
        fixture.Cache.SetRebuildFlushGuardSpinsForTest(0);
        fixture.Cache.OnAfterFlushApplyForTest = () =>
        {
            fixture.Cache.OnAfterFlushApplyForTest = null;
            Assert.False(fixture.Cache.SaveToDisk());
        };
        fixture.Change("after");
        fixture.Clock.Advance(30);
        Assert.Equal("after", fixture.DiskGenre());
    }

    [Fact]
    public async Task DisableDuringActiveSave_RetainsLastGoodBytesAndQuiescesRetries()
    {
        using var fixture = new Fixture();
        fixture.Change("durable");
        Assert.True(fixture.Cache.SaveToDisk());
        var durable = File.ReadAllBytes(fixture.Path);
        fixture.Change("disabled");
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        fixture.Cache.OnBeforeCachePersistForTest = () =>
        {
            entered.Set();
            Assert.True(release.Wait(TimeSpan.FromSeconds(10)));
        };
        var save = Task.Run(() => fixture.Clock.Advance(30));
        try
        {
            Assert.True(entered.Wait(TimeSpan.FromSeconds(10)));
            fixture.Cache.Suspend();
        }
        finally
        {
            release.Set();
        }

        await save.WaitAsync(TimeSpan.FromSeconds(10));
        fixture.Clock.Advance(300);
        Assert.Equal(durable, File.ReadAllBytes(fixture.Path));
        Assert.False(fixture.Cache.IsDirtyForTest);
        Assert.Equal(1, fixture.Cache.DebouncedSaveAttemptsForTest);
    }

    [Fact]
    public async Task DisposeDuringActiveAutomaticSave_RejectsLateCommitAndRetainsRepairMarker()
    {
        using var fixture = new Fixture();
        fixture.Change("durable");
        Assert.True(fixture.Cache.SaveToDisk());
        var durable = File.ReadAllBytes(fixture.Path);
        fixture.Change("in flight");
        fixture.Cache.SetDisposeFlushGuardSpinsForTest(0);
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        fixture.Cache.OnBeforeCachePersistForTest = () =>
        {
            entered.Set();
            Assert.True(release.Wait(TimeSpan.FromSeconds(10)));
        };
        var save = Task.Run(() => fixture.Clock.Advance(30));
        try
        {
            Assert.True(entered.Wait(TimeSpan.FromSeconds(10)));
            fixture.Cache.Dispose();
            Assert.True(File.Exists(fixture.Path + ".incomplete"));
        }
        finally
        {
            release.Set();
        }

        await save.WaitAsync(TimeSpan.FromSeconds(10));
        fixture.Clock.Advance(300);
        Assert.Equal(durable, File.ReadAllBytes(fixture.Path));
        Assert.True(File.Exists(fixture.Path + ".incomplete"));
        Assert.True(fixture.Cache.IsDirtyForTest);
        Assert.Equal(1, fixture.Cache.DebouncedSaveAttemptsForTest);
    }

    private sealed class Fixture : IDisposable
    {
        private readonly string _directory = System.IO.Path.Combine(
            System.IO.Path.GetTempPath(), "canopy-save-deadline-" + Guid.NewGuid().ToString("N"));
        private TestMovie _movie = new() { Id = Guid.NewGuid() };
        private readonly ILogger<TagCacheService>? _logger;

        public Fixture() : this(null)
        {
        }

        public Fixture(ILogger<TagCacheService>? logger)
        {
            _logger = logger;
            var library = new CountingLibraryManager
            {
                GetItemByIdHook = id => id == _movie.Id ? _movie : null,
                GetItemListHook = query => query.IncludeItemTypes.Contains(_movie.GetBaseItemKind())
                    ? new BaseItem[] { _movie }
                    : Array.Empty<BaseItem>(),
            };
            Cache = new TagCacheService(library, new StubAppPaths(_directory),
                logger ?? NullLogger<TagCacheService>.Instance, new StubLinkedChildrenService(),
                TagCacheService.DefaultContentJournalCapacity, Clock);
        }

        public ManualSaveClock Clock { get; } = new();
        public TagCacheService Cache { get; }
        public string Key => _movie.Id.ToString("N");
        public string Path => System.IO.Path.Combine(_directory, "configurations", "Jellyfin.Plugin.JellyfinCanopy", "tag-cache.json");

        public void Queue(string genre)
        {
            UpdateLibrary(genre);
            Cache.EnqueueItemChange(_movie, removed: false);
        }

        public void UpdateLibrary(string genre)
        {
            _movie = new TestMovie
            {
                Id = _movie.Id,
                Genres = new[] { genre },
                DateLastSaved = _movie.DateLastSaved.AddTicks(1),
            };
        }

        public void Change(string genre)
        {
            Queue(genre);
            Cache.FlushPendingForTest();
        }

        public string DiskGenre()
        {
            using var json = JsonDocument.Parse(File.ReadAllBytes(Path));
            return json.RootElement.GetProperty("Items").GetProperty(Key).GetProperty("Genres")[0].GetString()!;
        }

        public void Dispose()
        {
            if (_logger is ThrowingSaveLogger logger)
            {
                logger.ThrowOnSaved = false;
                logger.ThrowOnError = false;
            }

            Cache.OnAfterSnapshotForTest = null;
            Cache.OnBeforeCachePersistForTest = null;
            Cache.OnAfterFlushApplyForTest = null;
            Cache.Dispose();
            if (Directory.Exists(_directory)) Directory.Delete(_directory, recursive: true);
        }
    }

    private sealed class TestMovie : Movie
    {
        public override string GetClientTypeName() => "Movie";
        public override IReadOnlyList<MediaSourceInfo> GetMediaSources(bool enablePathSubstitution)
            => Array.Empty<MediaSourceInfo>();
    }

    private sealed class ThrowingSaveLogger : ILogger<TagCacheService>
    {
        public bool ThrowOnSaved { get; set; }
        public bool ThrowOnError { get; set; }
        public int SavedFailures { get; private set; }
        public int ErrorFailures { get; private set; }
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            if (ThrowOnSaved && formatter(state, exception).StartsWith("[TagCache] Saved ", StringComparison.Ordinal))
            {
                SavedFailures++;
                throw new InvalidOperationException("success logger failed after commit");
            }

            if (ThrowOnError && logLevel == LogLevel.Error)
            {
                ErrorFailures++;
                throw new InvalidOperationException("error logger failed");
            }
        }
    }

    private sealed class ManualSaveClock : TimeProvider
    {
        private readonly object _gate = new();
        private readonly List<ManualTimer> _timers = new();
        private long _ticks;
        public TimeSpan WallClockOffset { get; set; }
        public override long TimestampFrequency => TimeSpan.TicksPerSecond;
        public override long GetTimestamp() { lock (_gate) return _ticks; }
        public override DateTimeOffset GetUtcNow()
            => new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero).AddTicks(GetTimestamp()).Add(WallClockOffset);

        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        {
            lock (_gate)
            {
                var timer = new ManualTimer(this, callback, state);
                _timers.Add(timer);
                timer.Change(dueTime, period);
                return timer;
            }
        }

        public void Elapse(int seconds) { lock (_gate) _ticks += TimeSpan.FromSeconds(seconds).Ticks; }

        public Action TakeDueCallback()
        {
            lock (_gate)
            {
                var timer = _timers.First(timer => timer.Due is { } due && due <= _ticks);
                timer.Due = null;
                return timer.Invoke; // already queued: deliberately survives Change and Dispose
            }
        }

        public void Advance(int seconds)
        {
            var target = GetTimestamp() + TimeSpan.FromSeconds(seconds).Ticks;
            for (var callbacks = 0; ; callbacks++)
            {
                Action callback;
                lock (_gate)
                {
                    var timer = _timers.Where(timer => timer.Due is { } due && due <= target)
                        .OrderBy(timer => timer.Due).FirstOrDefault();
                    if (timer == null)
                    {
                        _ticks = Math.Max(_ticks, target);
                        return;
                    }

                    Assert.True(callbacks < 1000, "save scheduler entered a zero-delay retry loop");
                    _ticks = Math.Max(_ticks, timer.Due!.Value);
                    timer.Due = null;
                    callback = timer.Invoke;
                }

                callback();
            }
        }

        private sealed class ManualTimer(ManualSaveClock owner, TimerCallback callback, object? state) : ITimer
        {
            private bool _disposed;
            public long? Due { get; set; }
            public void Invoke() => callback(state);
            public bool Change(TimeSpan dueTime, TimeSpan period)
            {
                lock (owner._gate)
                {
                    if (_disposed) return false;
                    Assert.Equal(Timeout.InfiniteTimeSpan, period);
                    Due = dueTime == Timeout.InfiniteTimeSpan ? null : owner._ticks + dueTime.Ticks;
                    return true;
                }
            }

            public void Dispose() { lock (owner._gate) { _disposed = true; Due = null; } }
            public ValueTask DisposeAsync() { Dispose(); return ValueTask.CompletedTask; }
        }
    }
}
