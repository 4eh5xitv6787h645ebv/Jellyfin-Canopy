using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class SpoilerPendingPromoterLifecycleTests : IDisposable
{
    private const string SpoilerFile = "spoilerblur.json";
    private readonly string _directory = Path.Combine(
        Path.GetTempPath(),
        "jc-promoter-lifecycle-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        try
        {
            Directory.Delete(_directory, recursive: true);
        }
        catch
        {
            // Best-effort test cleanup.
        }
    }

    [Fact]
    public async Task StopAsync_DrainsAcceptedPromotion_AndNoWorkerWriteSurvivesStop()
    {
        var harness = CreateHarness();
        const string pendingKey = "tv:123";
        var series = VisibleSeries("123");
        SavePending(harness.Manager, harness.User.Id, pendingKey);
        harness.Library.GetItemListHook = _ => new BaseItem[] { series };
        harness.Library.GetItemByIdUserHook = (_, _) => series;

        var entered = NewSignal();
        var release = NewSignal();
        harness.Promoter.BeforePromotionForTest = _ =>
        {
            entered.TrySetResult();
            return release.Task;
        };

        await harness.Promoter.StartAsync(CancellationToken.None);
        await entered.Task;

        var stop = harness.Promoter.StopAsync(CancellationToken.None);
        Assert.False(stop.IsCompleted);

        release.TrySetResult();
        await stop;

        var state = ReadState(harness.Manager, harness.User.Id);
        Assert.Empty(state.PendingTmdb);
        Assert.True(state.Series.ContainsKey(series.Id.ToString("N")));

        // The completed owner has unsubscribed. A later matching event cannot
        // launch detached work or mutate the already-drained generation.
        harness.Library.RaiseItemAdded(series);
        Assert.Empty(ReadState(harness.Manager, harness.User.Id).PendingTmdb);
    }

    [Fact]
    public async Task StartupReplayBeyondQueueCapacity_ReturnsBeforeAdmissionBlocks_AndCanceledStopAbortsOwnership()
    {
        var harness = CreateHarness(queueCapacity: SpoilerSeerrPendingPromoter.DefaultQueueCapacity);
        var pendingKeys = Enumerable.Range(600, SpoilerSeerrPendingPromoter.DefaultQueueCapacity + 2)
            .Select(value => $"tv:{value}")
            .ToArray();
        SavePending(harness.Manager, harness.User.Id, pendingKeys);

        var firstEntered = NewSignal();
        var releaseFirst = NewSignal();
        var replayReachedBlockedAdmission = NewSignal();
        var firstSweep = 0;
        string? blockedKey = null;
        Series? blockedSeries = null;
        harness.Promoter.BeforePromotionForTest = key =>
        {
            if (Interlocked.Exchange(ref firstSweep, 1) != 0)
            {
                return Task.CompletedTask;
            }

            blockedKey = key;
            blockedSeries = VisibleSeries(key.Substring(key.IndexOf(':') + 1));
            firstEntered.TrySetResult();
            return releaseFirst.Task;
        };
        harness.Promoter.BeforeReplayWriteForTest = (_, scheduledCount) =>
        {
            if (scheduledCount >= SpoilerSeerrPendingPromoter.DefaultQueueCapacity + 2)
            {
                replayReachedBlockedAdmission.TrySetResult();
            }
        };
        harness.Library.GetItemListHook = query =>
        {
            if (blockedSeries != null
                && query.HasAnyProviderId != null
                && query.HasAnyProviderId.TryGetValue("Tmdb", out var requestedTmdb)
                && blockedSeries.ProviderIds.TryGetValue("Tmdb", out var blockedTmdb)
                && string.Equals(requestedTmdb, blockedTmdb, StringComparison.Ordinal))
            {
                return new BaseItem[] { blockedSeries };
            }

            return Array.Empty<BaseItem>();
        };
        harness.Library.GetItemByIdUserHook = (itemId, user) =>
            blockedSeries != null
            && itemId == blockedSeries.Id
            && user?.Id == harness.User.Id
                ? blockedSeries
                : null;

        var start = harness.Promoter.StartAsync(CancellationToken.None);
        await firstEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await replayReachedBlockedAdmission.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var startReturnedBeforeReplayFilledTheBoundedQueue = start.IsCompletedSuccessfully;

        using var hostDeadline = new CancellationTokenSource();
        var stop = harness.Promoter.StopAsync(hostDeadline.Token);
        hostDeadline.Cancel();
        var stopCompletedBeforeBlockedPromotionWasReleased = false;
        try
        {
            await stop.WaitAsync(TimeSpan.FromSeconds(5));
            stopCompletedBeforeBlockedPromotionWasReleased = true;
        }
        catch (TimeoutException)
        {
            // Bound cleanup of the pre-fix lifecycle deadlock so the regression
            // can report both violated contracts without stranding the test host.
        }
        finally
        {
            releaseFirst.TrySetResult();
            await start.WaitAsync(TimeSpan.FromSeconds(5));
            await stop.WaitAsync(TimeSpan.FromSeconds(5));
        }

        Assert.True(
            startReturnedBeforeReplayFilledTheBoundedQueue
            && stopCompletedBeforeBlockedPromotionWasReleased,
            "Durable replay must leave the startup path and a canceled host deadline "
            + "must abort queued/in-flight ownership. "
            + $"Startup returned: {startReturnedBeforeReplayFilledTheBoundedQueue}; "
            + $"stop completed before release: {stopCompletedBeforeBlockedPromotionWasReleased}.");

        Assert.NotNull(blockedKey);
        Assert.NotNull(blockedSeries);
        harness.Library.RaiseItemAdded(blockedSeries);
        var stoppedState = ReadState(harness.Manager, harness.User.Id);
        Assert.Equal(pendingKeys.Length, stoppedState.PendingTmdb.Count);
        Assert.Empty(stoppedState.Series);

        // Cancellation abandons only ephemeral ownership. The durable row is
        // replayed and promoted by a fresh generation without another event.
        var restarted = NewPromoter(
            harness,
            SpoilerSeerrPendingPromoter.DefaultQueueCapacity);
        var replayed = NewSignal();
        restarted.AfterPromotionForTest = key =>
        {
            if (string.Equals(key, blockedKey, StringComparison.OrdinalIgnoreCase))
            {
                replayed.TrySetResult();
            }
        };
        await restarted.StartAsync(CancellationToken.None);
        await replayed.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await restarted.StopAsync(CancellationToken.None);

        var replayedState = ReadState(harness.Manager, harness.User.Id);
        Assert.False(replayedState.PendingTmdb.ContainsKey(blockedKey));
        Assert.True(replayedState.Series.ContainsKey(blockedSeries.Id.ToString("N")));
    }

    [Fact]
    public async Task ConcurrentStart_WaitsForBlockedStopBeforeCreatingNextGeneration()
    {
        var harness = CreateHarness();
        const string pendingKey = "tv:234";
        SavePending(harness.Manager, harness.User.Id, pendingKey);
        harness.Library.GetItemListHook = _ => Array.Empty<BaseItem>();
        var firstEntered = NewSignal();
        var releaseFirst = NewSignal();
        var secondEntered = NewSignal();
        var sweepCount = 0;
        harness.Promoter.BeforePromotionForTest = _ =>
        {
            if (Interlocked.Increment(ref sweepCount) == 1)
            {
                firstEntered.TrySetResult();
                return releaseFirst.Task;
            }

            secondEntered.TrySetResult();
            return Task.CompletedTask;
        };

        await harness.Promoter.StartAsync(CancellationToken.None);
        await firstEntered.Task;
        var stop = harness.Promoter.StopAsync(CancellationToken.None);
        var restart = harness.Promoter.StartAsync(CancellationToken.None);

        Assert.False(stop.IsCompleted);
        Assert.False(restart.IsCompleted);
        Assert.True(harness.Promoter.IsUserRegisteredForTest(pendingKey, harness.User.Id));

        releaseFirst.TrySetResult();
        await stop;
        await restart;
        await secondEntered.Task;

        Assert.True(harness.Promoter.IsUserRegisteredForTest(pendingKey, harness.User.Id));
        Assert.Equal(2, Volatile.Read(ref sweepCount));
        await harness.Promoter.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task Startup_DeletedUserRowsCannotFillQueueOrHoldLifecycleGate()
    {
        var harness = CreateHarness(queueCapacity: 1);
        var deletedUserId = Guid.NewGuid();
        var orphanKeys = new[] { "tv:301", "tv:302", "tv:303" };
        SavePending(harness.Manager, deletedUserId, orphanKeys);
        var orphanSweepEntered = NewSignal();
        var releaseOrphanSweep = NewSignal();
        harness.Promoter.BeforePromotionForTest = _ =>
        {
            orphanSweepEntered.TrySetResult();
            return releaseOrphanSweep.Task;
        };

        await harness.Promoter.StartAsync(CancellationToken.None);
        var replay = harness.Promoter.ReplayCompletionForTest;
        var winner = await Task.WhenAny(replay, orphanSweepEntered.Task)
            .WaitAsync(TimeSpan.FromSeconds(5));
        var replayCompletedWithoutOrphanSweep = ReferenceEquals(winner, replay);

        // Keep the old failure mode bounded: if startup admitted the three
        // orphan keys, one is running, one fills the channel, and the third
        // holds StartAsync inside the lifecycle gate. Removing the in-memory
        // registrations lets that broken generation drain before assertion.
        foreach (var key in orphanKeys)
        {
            harness.Promoter.UnregisterPending(key, deletedUserId);
        }

        releaseOrphanSweep.TrySetResult();
        await replay.WaitAsync(TimeSpan.FromSeconds(5));
        await harness.Promoter.StopAsync(CancellationToken.None);

        Assert.True(
            replayCompletedWithoutOrphanSweep,
            "Background replay must skip durable directories whose Jellyfin user no longer exists.");
        Assert.All(
            orphanKeys,
            key => Assert.False(harness.Promoter.IsKeyRegisteredForTest(key)));
        var orphanState = ReadState(harness.Manager, deletedUserId);
        Assert.Equal(3, orphanState.PendingTmdb.Count);
        Assert.All(orphanKeys, key => Assert.True(orphanState.PendingTmdb.ContainsKey(key)));
    }

    [Fact]
    public async Task DeletedUserDuringSweep_DoesNotStarveLiveKey_AndGracefulStopDrainsIt()
    {
        var deletedUser = new User("deleted-during-sweep", "provider", "password-provider");
        var liveUser = new User("live-behind-orphan", "provider", "password-provider");
        var harness = CreateHarness(new[] { deletedUser, liveUser }, queueCapacity: 1);
        const string orphanKey = "tv:401";
        const string liveKey = "tv:402";
        var liveSeries = VisibleSeries("402");
        harness.Library.GetItemListHook = query =>
        {
            if (query.HasAnyProviderId != null
                && query.HasAnyProviderId.TryGetValue("Tmdb", out var requestedTmdb)
                && string.Equals(requestedTmdb, "402", StringComparison.Ordinal))
            {
                return new BaseItem[] { liveSeries };
            }

            return Array.Empty<BaseItem>();
        };
        harness.Library.GetItemByIdUserHook = (itemId, user) =>
            itemId == liveSeries.Id && user?.Id == liveUser.Id ? liveSeries : null;

        var firstOrphanSweepEntered = NewSignal();
        var releaseFirstOrphanSweep = NewSignal();
        var repeatedOrphanSweepEntered = NewSignal();
        var releaseRepeatedOrphanSweep = NewSignal();
        var liveSweepEntered = NewSignal();
        var releaseLiveSweep = NewSignal();
        var orphanSweepCount = 0;
        harness.Promoter.BeforePromotionForTest = key =>
        {
            if (string.Equals(key, orphanKey, StringComparison.OrdinalIgnoreCase))
            {
                if (Interlocked.Increment(ref orphanSweepCount) == 1)
                {
                    firstOrphanSweepEntered.TrySetResult();
                    return releaseFirstOrphanSweep.Task;
                }

                repeatedOrphanSweepEntered.TrySetResult();
                return releaseRepeatedOrphanSweep.Task;
            }

            if (string.Equals(key, liveKey, StringComparison.OrdinalIgnoreCase))
            {
                liveSweepEntered.TrySetResult();
                return releaseLiveSweep.Task;
            }

            return Task.CompletedTask;
        };

        await harness.Promoter.StartAsync(CancellationToken.None);
        await harness.Promoter.ReplayCompletionForTest;
        SavePending(harness.Manager, deletedUser.Id, orphanKey);
        SavePending(harness.Manager, liveUser.Id, liveKey);
        harness.Pending.NotifyPendingRegistered(orphanKey, deletedUser.Id);
        await firstOrphanSweepEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));

        // The durable directory remains, but Jellyfin deletes the user while
        // the already-accepted sweep is paused. Queue the live key behind it.
        harness.Users.GetUserByIdHook = userId =>
            userId == deletedUser.Id
                ? null
                : userId == liveUser.Id
                    ? liveUser
                    : null;
        harness.Pending.NotifyPendingRegistered(liveKey, liveUser.Id);
        releaseFirstOrphanSweep.TrySetResult();

        var winner = await Task.WhenAny(liveSweepEntered.Task, repeatedOrphanSweepEntered.Task)
            .WaitAsync(TimeSpan.FromSeconds(5));
        var liveKeyWasNotStarved = ReferenceEquals(winner, liveSweepEntered.Task);

        var stop = harness.Promoter.StopAsync(CancellationToken.None);
        Assert.False(stop.IsCompleted);

        // Whichever old/new path won is deliberately blocked above. Release
        // both barriers so the stop can prove that all accepted work drains.
        releaseRepeatedOrphanSweep.TrySetResult();
        releaseLiveSweep.TrySetResult();
        await stop.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.True(
            liveKeyWasNotStarved,
            "A deleted user's durable row must not self-rerun ahead of a later accepted key.");
        Assert.Equal(1, Volatile.Read(ref orphanSweepCount));
        Assert.True(ReadState(harness.Manager, deletedUser.Id).PendingTmdb.ContainsKey(orphanKey));
        var liveState = ReadState(harness.Manager, liveUser.Id);
        Assert.Empty(liveState.PendingTmdb);
        Assert.True(liveState.Series.ContainsKey(liveSeries.Id.ToString("N")));
    }

    [Fact]
    public async Task AbsentPendingRow_StillReconcilesAndUnregistersEphemeralGate()
    {
        var harness = CreateHarness();
        const string pendingKey = "tv:501";
        var series = VisibleSeries("501");
        harness.Library.GetItemListHook = _ => new BaseItem[] { series };
        harness.Library.GetItemByIdUserHook = (_, _) => series;
        var swept = NewSignal();
        harness.Promoter.AfterPromotionForTest = key =>
        {
            if (string.Equals(key, pendingKey, StringComparison.OrdinalIgnoreCase))
            {
                swept.TrySetResult();
            }
        };

        await harness.Promoter.StartAsync(CancellationToken.None);
        await harness.Promoter.ReplayCompletionForTest;
        harness.Pending.NotifyPendingRegistered(pendingKey, harness.User.Id);
        await swept.Task.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.False(harness.Promoter.IsKeyRegisteredForTest(pendingKey));
        Assert.Empty(ReadState(harness.Manager, harness.User.Id).PendingTmdb);
        await harness.Promoter.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task UnregisteredQueuedKey_IsSkippedWithoutRecreatingEphemeralOwnership()
    {
        var harness = CreateHarness();
        const string pendingKey = "tv:502";
        SavePending(harness.Manager, harness.User.Id, pendingKey);
        harness.Library.GetItemListHook = _ => Array.Empty<BaseItem>();
        var entered = NewSignal();
        var release = NewSignal();
        var swept = NewSignal();
        harness.Promoter.BeforePromotionForTest = key =>
        {
            if (string.Equals(key, pendingKey, StringComparison.OrdinalIgnoreCase))
            {
                entered.TrySetResult();
                return release.Task;
            }

            return Task.CompletedTask;
        };
        harness.Promoter.AfterPromotionForTest = key =>
        {
            if (string.Equals(key, pendingKey, StringComparison.OrdinalIgnoreCase))
            {
                swept.TrySetResult();
            }
        };

        await harness.Promoter.StartAsync(CancellationToken.None);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        harness.Promoter.UnregisterPending(pendingKey, harness.User.Id);
        release.TrySetResult();
        await swept.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await harness.Promoter.StopAsync(CancellationToken.None);

        Assert.False(harness.Promoter.IsKeyRegisteredForTest(pendingKey));
        Assert.True(ReadState(harness.Manager, harness.User.Id).PendingTmdb.ContainsKey(pendingKey));
    }

    [Fact]
    public async Task RegisterPending_RetriesWhenLastUserRemovalDetachesObtainedDictionary()
    {
        var harness = CreateHarness();
        await harness.Promoter.StartAsync(CancellationToken.None);
        await harness.Promoter.ReplayCompletionForTest;
        const string pendingKey = "tv:345";
        var existingUser = harness.User.Id;
        var registeringUser = Guid.NewGuid();
        harness.Promoter.RegisterPending(pendingKey, existingUser);
        var dictionaryObtained = NewSignal();
        var allowAdd = NewSignal();
        harness.Promoter.PendingDictionaryAcquiredForTest = (key, userId) =>
        {
            if (key == pendingKey && userId == registeringUser)
            {
                dictionaryObtained.TrySetResult();
                allowAdd.Task.GetAwaiter().GetResult();
            }
        };

        var register = Task.Run(() => harness.Promoter.RegisterPending(pendingKey, registeringUser));
        await dictionaryObtained.Task;
        harness.Promoter.UnregisterPending(pendingKey, existingUser);
        Assert.False(harness.Promoter.IsKeyRegisteredForTest(pendingKey));

        allowAdd.TrySetResult();
        await register;

        Assert.True(harness.Promoter.IsUserRegisteredForTest(pendingKey, registeringUser));
        Assert.Equal(1, harness.Promoter.RegisteredUserCountForTest(pendingKey));
        await harness.Promoter.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task FreshInstance_ReplaysDurableRowWithoutAnotherLibraryEvent()
    {
        var harness = CreateHarness();
        const string pendingKey = "tv:456";
        SavePending(harness.Manager, harness.User.Id, pendingKey);
        harness.Library.GetItemListHook = _ => Array.Empty<BaseItem>();

        var firstSweep = NewSignal();
        harness.Promoter.AfterPromotionForTest = _ => firstSweep.TrySetResult();
        await harness.Promoter.StartAsync(CancellationToken.None);
        await firstSweep.Task;
        await harness.Promoter.StopAsync(CancellationToken.None);
        Assert.True(ReadState(harness.Manager, harness.User.Id).PendingTmdb.ContainsKey(pendingKey));

        var series = VisibleSeries("456");
        harness.Library.GetItemListHook = _ => new BaseItem[] { series };
        harness.Library.GetItemByIdUserHook = (_, _) => series;
        var restarted = NewPromoter(harness, queueCapacity: 2);
        var replayed = NewSignal();
        restarted.AfterPromotionForTest = _ => replayed.TrySetResult();

        await restarted.StartAsync(CancellationToken.None);
        await replayed.Task;
        await restarted.StopAsync(CancellationToken.None);

        var state = ReadState(harness.Manager, harness.User.Id);
        Assert.Empty(state.PendingTmdb);
        Assert.True(state.Series.ContainsKey(series.Id.ToString("N")));
    }

    [Fact]
    public async Task DuplicateBurst_Coalesces_AndSaturationLeavesEveryIntentDurable()
    {
        var harness = CreateHarness(queueCapacity: 1);
        harness.Library.GetItemListHook = _ => Array.Empty<BaseItem>();
        var entered = NewSignal();
        var release = NewSignal();
        harness.Promoter.BeforePromotionForTest = key =>
        {
            if (string.Equals(key, "tv:100", StringComparison.OrdinalIgnoreCase))
            {
                entered.TrySetResult();
            }

            return release.Task;
        };
        await harness.Promoter.StartAsync(CancellationToken.None);
        await harness.Promoter.ReplayCompletionForTest;

        Assert.True(harness.Pending.RegisterSeerrIntent(
            harness.User.Id,
            "{\"mediaType\":\"tv\",\"mediaId\":100}").IsDurable);
        await entered.Task;
        for (var i = 0; i < 64; i++)
        {
            Assert.True(harness.Pending.RegisterSeerrIntent(
                harness.User.Id,
                "{\"mediaType\":\"tv\",\"mediaId\":100}").IsDurable);
        }

        Assert.True(harness.Pending.RegisterSeerrIntent(
            harness.User.Id,
            "{\"mediaType\":\"tv\",\"mediaId\":101}").IsDurable);
        Assert.True(harness.Pending.RegisterSeerrIntent(
            harness.User.Id,
            "{\"mediaType\":\"tv\",\"mediaId\":102}").IsDurable);

        var durable = ReadState(harness.Manager, harness.User.Id);
        Assert.Equal(3, durable.PendingTmdb.Count);
        Assert.Equal(1, harness.Promoter.RegisteredUserCountForTest("tv:100"));
        Assert.InRange(harness.Promoter.ScheduledKeyCountForTest, 1, 2);

        release.TrySetResult();
        await harness.Promoter.StopAsync(CancellationToken.None);
        Assert.Equal(3, ReadState(harness.Manager, harness.User.Id).PendingTmdb.Count);
    }

    [Fact]
    public async Task HotKeyRerun_RequeuesAtTailSoInterleavedColdKeyRunsNext()
    {
        var harness = CreateHarness(queueCapacity: 2);
        const string hotKey = "tv:700";
        const string coldKey = "tv:701";
        harness.Library.GetItemListHook = _ => Array.Empty<BaseItem>();
        var firstHotEntered = NewSignal();
        var releaseFirstHot = NewSignal();
        var secondHotEntered = NewSignal();
        var coldEntered = NewSignal();
        var hotSweepCount = 0;
        var sweepOrdinal = 0;
        var secondHotOrdinal = 0;
        var coldOrdinal = 0;
        harness.Promoter.BeforePromotionForTest = key =>
        {
            var ordinal = Interlocked.Increment(ref sweepOrdinal);
            if (string.Equals(key, hotKey, StringComparison.OrdinalIgnoreCase))
            {
                if (Interlocked.Increment(ref hotSweepCount) == 1)
                {
                    firstHotEntered.TrySetResult();
                    return releaseFirstHot.Task;
                }

                Volatile.Write(ref secondHotOrdinal, ordinal);
                secondHotEntered.TrySetResult();
            }
            else if (string.Equals(key, coldKey, StringComparison.OrdinalIgnoreCase))
            {
                Volatile.Write(ref coldOrdinal, ordinal);
                coldEntered.TrySetResult();
            }

            return Task.CompletedTask;
        };

        await harness.Promoter.StartAsync(CancellationToken.None);
        await harness.Promoter.ReplayCompletionForTest;
        SavePending(harness.Manager, harness.User.Id, hotKey, coldKey);
        harness.Pending.NotifyPendingRegistered(hotKey, harness.User.Id);
        await firstHotEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));

        harness.Pending.NotifyPendingRegistered(coldKey, harness.User.Id);
        harness.Pending.NotifyPendingRegistered(hotKey, harness.User.Id);
        releaseFirstHot.TrySetResult();

        await coldEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await secondHotEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await harness.Promoter.StopAsync(CancellationToken.None);

        Assert.True(
            Volatile.Read(ref coldOrdinal) < Volatile.Read(ref secondHotOrdinal),
            "An active key's rerun must requeue at the tail instead of monopolizing the worker. "
            + $"Cold ordinal: {Volatile.Read(ref coldOrdinal)}; "
            + $"second hot ordinal: {Volatile.Read(ref secondHotOrdinal)}.");
        Assert.True(ReadState(harness.Manager, harness.User.Id).PendingTmdb.ContainsKey(hotKey));
        Assert.True(ReadState(harness.Manager, harness.User.Id).PendingTmdb.ContainsKey(coldKey));
    }

    [Fact]
    public async Task SharedTmdbKey_PromotesEveryUserInOneCoalescedSweep()
    {
        var userA = new User("shared-a", "provider", "password-provider");
        var userB = new User("shared-b", "provider", "password-provider");
        var harness = CreateHarness(new[] { userA, userB });
        const string pendingKey = "tv:789";
        SavePending(harness.Manager, userA.Id, pendingKey);
        SavePending(harness.Manager, userB.Id, pendingKey);
        var series = VisibleSeries("789");
        harness.Library.GetItemListHook = _ => new BaseItem[] { series };
        harness.Library.GetItemByIdUserHook = (_, _) => series;
        var swept = NewSignal();
        var releaseSweep = NewSignal();
        harness.Promoter.BeforePromotionForTest = _ => releaseSweep.Task;
        harness.Promoter.AfterPromotionForTest = _ => swept.TrySetResult();

        await harness.Promoter.StartAsync(CancellationToken.None);
        await harness.Promoter.ReplayCompletionForTest;
        releaseSweep.TrySetResult();
        await swept.Task;
        await harness.Promoter.StopAsync(CancellationToken.None);

        Assert.True(ReadState(harness.Manager, userA.Id).Series.ContainsKey(series.Id.ToString("N")));
        Assert.True(ReadState(harness.Manager, userB.Id).Series.ContainsKey(series.Id.ToString("N")));
    }

    private Harness CreateHarness(int queueCapacity = 4)
        => CreateHarness(new[] { new User("lifecycle-user", "provider", "password-provider") }, queueCapacity);

    private Harness CreateHarness(IReadOnlyList<User> users, int queueCapacity = 4)
    {
        var manager = new UserConfigurationManager(
            new StubAppPaths(_directory),
            NullLogger<UserConfigurationManager>.Instance);
        var library = new CountingLibraryManager();
        var userManager = new StubUserManager(users.ToArray());
        var provider = new FakePluginConfigProvider(new PluginConfiguration
        {
            SpoilerBlurEnabled = true,
        });
        var pending = new SpoilerPendingService(
            manager,
            library,
            userManager,
            NullLogger<SpoilerPendingService>.Instance);
        var harness = new Harness(
            manager,
            library,
            userManager,
            provider,
            pending,
            null!,
            users[0]);
        return harness with { Promoter = NewPromoter(harness, queueCapacity) };
    }

    private static SpoilerSeerrPendingPromoter NewPromoter(Harness harness, int queueCapacity)
        => new(
            harness.Library,
            harness.Users,
            harness.Manager,
            harness.Provider,
            harness.Pending,
            NullLogger<SpoilerSeerrPendingPromoter>.Instance,
            queueCapacity);

    private static void SavePending(
        UserConfigurationManager manager,
        Guid userId,
        params string[] pendingKeys)
    {
        var state = new UserSpoilerBlur();
        foreach (var pendingKey in pendingKeys)
        {
            var separator = pendingKey.IndexOf(':');
            state.PendingTmdb[pendingKey] = new SpoilerBlurPendingEntry
            {
                MediaType = pendingKey.Substring(0, separator),
                TmdbId = pendingKey.Substring(separator + 1),
            };
        }

        manager.SaveUserConfiguration(userId.ToString("N"), SpoilerFile, state);
    }

    private static UserSpoilerBlur ReadState(UserConfigurationManager manager, Guid userId)
        => manager.GetUserConfiguration<UserSpoilerBlur>(userId.ToString("N"), SpoilerFile);

    private static Series VisibleSeries(string tmdbId)
    {
        var series = new Series { Id = Guid.NewGuid(), Name = "Series " + tmdbId };
        series.ProviderIds["Tmdb"] = tmdbId;
        return series;
    }

    private static TaskCompletionSource NewSignal()
        => new(TaskCreationOptions.RunContinuationsAsynchronously);

    private sealed record Harness(
        UserConfigurationManager Manager,
        CountingLibraryManager Library,
        StubUserManager Users,
        FakePluginConfigProvider Provider,
        SpoilerPendingService Pending,
        SpoilerSeerrPendingPromoter Promoter,
        User User);
}
