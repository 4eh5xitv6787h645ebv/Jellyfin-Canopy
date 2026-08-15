using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.ScheduledTasks;
using Jellyfin.Plugin.JellyfinCanopy.Services.Awards;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.ScheduledTasks;

public sealed class RefreshAwardsIndexTaskTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "jc-awards-task-tests-" + Guid.NewGuid().ToString("N"));

    [Fact]
    public void StableSchedule_IsDeterministicAndDistributedWithinWeek()
    {
        var first = RefreshAwardsIndexTask.StableSchedule("server-a");
        var repeated = RefreshAwardsIndexTask.StableSchedule("server-a");
        var second = RefreshAwardsIndexTask.StableSchedule("server-b");

        Assert.Equal(first, repeated);
        Assert.NotEqual(first, second);
        Assert.InRange((int)first.Day, 0, 6);
        Assert.InRange(first.Time, TimeSpan.Zero, TimeSpan.FromDays(1) - TimeSpan.FromTicks(1));
    }

    [Fact]
    public void StableSchedule_DistributesHundredThousandInstallFleetAcrossWeekSeconds()
    {
        const int secondsPerWeek = 7 * 24 * 60 * 60;
        var secondCounts = new int[secondsPerWeek];
        for (var index = 0; index < 100_000; index++)
        {
            var (day, time) = RefreshAwardsIndexTask.StableSchedule($"simulated-install-{index}");
            var second = ((int)day * 24 * 60 * 60) + (int)time.TotalSeconds;
            secondCounts[second]++;
        }

        Assert.Equal(100_000, secondCounts.Sum());
        Assert.InRange(secondCounts.Count(count => count > 0), 90_000, 100_000);
        Assert.InRange(secondCounts.Max(), 1, 6);
        var hourCounts = secondCounts.Chunk(60 * 60).Select(hour => hour.Sum()).ToArray();
        Assert.Equal(168, hourCounts.Length);
        Assert.All(hourCounts, count => Assert.InRange(count, 500, 700));
    }

    [Fact]
    public async Task ExecuteAsync_ReReadsLiveConfigurationAfterDisabledNetworkFreeNoOp()
    {
        var source = new ControlledSource();
        var config = new FakePluginConfigProvider(new PluginConfiguration { AwardsEnabled = false });
        var progress = new SynchronousProgress();
        var task = CreateTask(source, config);

        await task.ExecuteAsync(progress, CancellationToken.None);

        Assert.Equal([0, 100], progress.Values);
        Assert.Equal(0, source.Calls);

        config.Current = new PluginConfiguration { AwardsEnabled = true };
        var enabledExecution = task.ExecuteAsync(progress, CancellationToken.None);
        Assert.Equal(1, source.Calls);
        source.Release(Array.Empty<AwardsSourceRecord>());
        await enabledExecution;

        Assert.Equal([0, 100, 0, 100], progress.Values);
        Assert.Equal(1, source.Calls);
    }

    [Fact]
    public async Task ConcurrentManualAndScheduledExecutionsShareOneRefreshOwner()
    {
        var source = new ControlledSource();
        var config = new FakePluginConfigProvider(new PluginConfiguration { AwardsEnabled = true });
        var service = CreateService(source);
        var manualProgress = new SynchronousProgress();
        var scheduledProgress = new SynchronousProgress();
        var manual = CreateTask(service, config);
        var scheduled = CreateTask(service, config);

        var manualExecution = manual.ExecuteAsync(manualProgress, CancellationToken.None);
        var scheduledExecution = scheduled.ExecuteAsync(scheduledProgress, CancellationToken.None);
        Assert.Equal(1, source.Calls);
        source.Release(Array.Empty<AwardsSourceRecord>());

        await Task.WhenAll(manualExecution, scheduledExecution);
        Assert.Equal(1, source.Calls);
        Assert.Equal([0, 100], manualProgress.Values);
        Assert.Equal([0, 100], scheduledProgress.Values);
    }

    [Fact]
    public async Task CancellingOneExecutionDoesNotCancelSharedRefreshOwnership()
    {
        var source = new ControlledSource();
        var config = new FakePluginConfigProvider(new PluginConfiguration { AwardsEnabled = true });
        var service = CreateService(source);
        using var cancellation = new CancellationTokenSource();
        var cancelled = CreateTask(service, config).ExecuteAsync(new SynchronousProgress(), cancellation.Token);
        var surviving = CreateTask(service, config).ExecuteAsync(new SynchronousProgress(), CancellationToken.None);

        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => cancelled);
        Assert.Equal(1, source.Calls);
        source.Release(Array.Empty<AwardsSourceRecord>());

        await surviving;
        Assert.Equal(1, source.Calls);
    }

    [Fact]
    public async Task FailedExecutionSignalsFailureAndRetainsLastGoodIndex()
    {
        var old = new AwardsSourceRecord(
            "Q42", AwardsMediaKind.Movie, "tmdb", "123", "Last Good", 2024, AwardOutcome.Win);
        var source = new SequenceSource(
            new AwardsSourceSnapshot([old]),
            new IOException("partial provider response"));
        var config = new FakePluginConfigProvider(new PluginConfiguration { AwardsEnabled = true });
        var service = CreateService(source);
        Assert.True(await service.RefreshAsync(CancellationToken.None));
        var progress = new SynchronousProgress();

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            CreateTask(service, config).ExecuteAsync(progress, CancellationToken.None));

        Assert.Equal([0], progress.Values);
        Assert.Equal(
            "Last Good",
            Assert.Single(service.Lookup(
                AwardsMediaKind.Movie,
                new Dictionary<string, string> { ["Tmdb"] = "123" }).Wins).Name);
    }

    public void Dispose()
    {
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, recursive: true);
        }
    }

    private AwardsIndexService CreateService(IAwardsSourceClient source)
        => new(
            source,
            NullLogger<AwardsIndexService>.Instance,
            Path.Combine(_root, Guid.NewGuid().ToString("N"), "index.json"));

    private RefreshAwardsIndexTask CreateTask(
        IAwardsSourceClient source,
        FakePluginConfigProvider config)
        => CreateTask(CreateService(source), config);

    private static RefreshAwardsIndexTask CreateTask(
        AwardsIndexService service,
        FakePluginConfigProvider config)
        => new(service, config, new AwardsHostIdentity("task-test-host"));

    private sealed class SynchronousProgress : IProgress<double>
    {
        public List<double> Values { get; } = new();

        public void Report(double value) => Values.Add(value);
    }

    private sealed class ControlledSource : IAwardsSourceClient
    {
        private readonly TaskCompletionSource<AwardsSourceSnapshot> _completion =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public int Calls { get; private set; }

        public Task<AwardsSourceSnapshot> FetchCompleteAsync(CancellationToken cancellationToken)
        {
            Calls++;
            return _completion.Task;
        }

        public void Release(IReadOnlyList<AwardsSourceRecord> records)
            => _completion.SetResult(new AwardsSourceSnapshot(records));
    }

    private sealed class SequenceSource(params object[] results) : IAwardsSourceClient
    {
        private readonly Queue<object> _results = new(results);

        public Task<AwardsSourceSnapshot> FetchCompleteAsync(CancellationToken cancellationToken)
        {
            var result = _results.Dequeue();
            return result is Exception exception
                ? Task.FromException<AwardsSourceSnapshot>(exception)
                : Task.FromResult((AwardsSourceSnapshot)result);
        }
    }
}
