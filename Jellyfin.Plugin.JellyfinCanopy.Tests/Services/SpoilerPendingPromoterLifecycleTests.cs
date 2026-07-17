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
    public async Task RegisterPending_RetriesWhenLastUserRemovalDetachesObtainedDictionary()
    {
        var harness = CreateHarness();
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
        harness.Promoter.AfterPromotionForTest = _ => swept.TrySetResult();

        await harness.Promoter.StartAsync(CancellationToken.None);
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

    private static void SavePending(UserConfigurationManager manager, Guid userId, string pendingKey)
    {
        var separator = pendingKey.IndexOf(':');
        var state = new UserSpoilerBlur();
        state.PendingTmdb[pendingKey] = new SpoilerBlurPendingEntry
        {
            MediaType = pendingKey.Substring(0, separator),
            TmdbId = pendingKey.Substring(separator + 1),
        };
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
