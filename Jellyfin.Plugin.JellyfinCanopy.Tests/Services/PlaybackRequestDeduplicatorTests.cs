using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.AutoRequest;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class PlaybackRequestDeduplicatorTests
{
    [Fact]
    public async Task RetryableFirstCall_AllowsImmediatePlaybackRetry()
    {
        var deduplicator = new PlaybackRequestDeduplicator();
        var calls = 0;

        Assert.True(await deduplicator.ExecuteAsync(
            "generation-a",
            "movie:user:item",
            () =>
            {
                calls++;
                return Task.FromResult(AutoRequestPlaybackOutcome.RetryableFailure);
            }));

        Assert.True(await deduplicator.ExecuteAsync(
            "generation-a",
            "movie:user:item",
            () =>
            {
                calls++;
                return Task.FromResult(AutoRequestPlaybackOutcome.Committed);
            }));

        Assert.False(await deduplicator.ExecuteAsync(
            "generation-a",
            "movie:user:item",
            () =>
            {
                calls++;
                return Task.FromResult(AutoRequestPlaybackOutcome.Committed);
            }));
        Assert.Equal(2, calls);
    }

    [Fact]
    public async Task CancelledOutcome_ReleasesReservation()
    {
        var deduplicator = new PlaybackRequestDeduplicator();
        var calls = 0;

        Assert.True(await deduplicator.ExecuteAsync(
            "generation-a",
            "season:user:item",
            () =>
            {
                calls++;
                return Task.FromResult(AutoRequestPlaybackOutcome.Cancelled);
            }));
        Assert.True(await deduplicator.ExecuteAsync(
            "generation-a",
            "season:user:item",
            () =>
            {
                calls++;
                return Task.FromResult(AutoRequestPlaybackOutcome.Committed);
            }));

        Assert.Equal(2, calls);
    }

    [Fact]
    public async Task ThrownCancellation_ReleasesReservation()
    {
        var deduplicator = new PlaybackRequestDeduplicator();
        var calls = 0;

        Assert.True(await deduplicator.ExecuteAsync(
            "generation-a",
            "movie:user:cancelled",
            () =>
            {
                calls++;
                return Task.FromException<AutoRequestPlaybackOutcome>(
                    new OperationCanceledException());
            }));
        Assert.True(await deduplicator.ExecuteAsync(
            "generation-a",
            "movie:user:cancelled",
            () =>
            {
                calls++;
                return Task.FromResult(AutoRequestPlaybackOutcome.Committed);
            }));

        Assert.Equal(2, calls);
    }

    [Fact]
    public async Task ConcurrentIdenticalEvents_InvokeServiceOnce()
    {
        var deduplicator = new PlaybackRequestDeduplicator();
        var operationStarted = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseOperation = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = 0;

        async Task<AutoRequestPlaybackOutcome> BlockingOperation()
        {
            Interlocked.Increment(ref calls);
            operationStarted.TrySetResult();
            await releaseOperation.Task;
            return AutoRequestPlaybackOutcome.Committed;
        }

        var first = deduplicator.ExecuteAsync(
            "generation-a",
            "season:user:concurrent",
            BlockingOperation);
        await operationStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));

        var duplicates = Enumerable.Range(0, 32)
            .Select(_ => deduplicator.ExecuteAsync(
                "generation-a",
                "season:user:concurrent",
                BlockingOperation))
            .ToArray();
        var duplicateResults = await Task.WhenAll(duplicates);

        Assert.All(duplicateResults, Assert.False);
        Assert.Equal(1, Volatile.Read(ref calls));

        releaseOperation.TrySetResult();
        Assert.True(await first);
        Assert.Equal(1, Volatile.Read(ref calls));
    }

    [Theory]
    [InlineData(AutoRequestPlaybackOutcome.Committed)]
    [InlineData(AutoRequestPlaybackOutcome.DefinitiveNoop)]
    public async Task DefinitiveOutcomes_CommitLongDedup(
        AutoRequestPlaybackOutcome outcome)
    {
        var clock = new ManualTimeProvider();
        var deduplicator = new PlaybackRequestDeduplicator(clock);
        var calls = 0;

        Task<AutoRequestPlaybackOutcome> Operation()
        {
            calls++;
            return Task.FromResult(outcome);
        }

        Assert.True(await deduplicator.ExecuteAsync("generation-a", "movie:user:definitive", Operation));
        Assert.False(await deduplicator.ExecuteAsync("generation-a", "movie:user:definitive", Operation));

        clock.Advance(PlaybackRequestDeduplicator.CommittedTtl - TimeSpan.FromTicks(1));
        Assert.False(await deduplicator.ExecuteAsync("generation-a", "movie:user:definitive", Operation));

        clock.Advance(TimeSpan.FromTicks(1));
        Assert.True(await deduplicator.ExecuteAsync("generation-a", "movie:user:definitive", Operation));
        Assert.Equal(2, calls);
    }

    [Fact]
    public async Task RepeatedRetryableFailures_UseBoundedBackoff()
    {
        var clock = new ManualTimeProvider();
        var deduplicator = new PlaybackRequestDeduplicator(clock);
        var calls = 0;

        Task<AutoRequestPlaybackOutcome> Fail()
        {
            calls++;
            return Task.FromResult(AutoRequestPlaybackOutcome.RetryableFailure);
        }

        Assert.True(await deduplicator.ExecuteAsync("generation-a", "season:user:retry", Fail));
        Assert.True(await deduplicator.ExecuteAsync("generation-a", "season:user:retry", Fail));
        Assert.False(await deduplicator.ExecuteAsync("generation-a", "season:user:retry", Fail));

        clock.Advance(PlaybackRequestDeduplicator.InitialBackoff - TimeSpan.FromTicks(1));
        Assert.False(await deduplicator.ExecuteAsync("generation-a", "season:user:retry", Fail));

        clock.Advance(TimeSpan.FromTicks(1));
        Assert.True(await deduplicator.ExecuteAsync("generation-a", "season:user:retry", Fail));
        Assert.Equal(3, calls);

        Assert.Equal(
            PlaybackRequestDeduplicator.MaximumBackoff,
            PlaybackRequestDeduplicator.ComputeBackoff(int.MaxValue));
    }

    [Fact]
    public async Task UnexpectedException_ReleasesReservationAndPropagates()
    {
        var deduplicator = new PlaybackRequestDeduplicator();

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            deduplicator.ExecuteAsync(
                "generation-a",
                "movie:user:exception",
                () => Task.FromException<AutoRequestPlaybackOutcome>(
                    new InvalidOperationException("transient"))));

        Assert.True(await deduplicator.ExecuteAsync(
            "generation-a",
            "movie:user:exception",
            () => Task.FromResult(AutoRequestPlaybackOutcome.Committed)));
    }

    [Fact]
    public async Task CommittedAndRetryState_DoNotSuppressReplacementGeneration()
    {
        var deduplicator = new PlaybackRequestDeduplicator();
        var calls = 0;

        Assert.True(await deduplicator.ExecuteAsync(
            "generation-a",
            "movie:user:same-item",
            () => Task.FromResult(AutoRequestPlaybackOutcome.Committed)));
        Assert.True(await deduplicator.ExecuteAsync(
            "generation-b",
            "movie:user:same-item",
            () =>
            {
                calls++;
                return Task.FromResult(AutoRequestPlaybackOutcome.RetryableFailure);
            }));
        Assert.True(await deduplicator.ExecuteAsync(
            "generation-b",
            "movie:user:same-item",
            () =>
            {
                calls++;
                return Task.FromResult(AutoRequestPlaybackOutcome.RetryableFailure);
            }));
        Assert.False(await deduplicator.ExecuteAsync(
            "generation-b",
            "movie:user:same-item",
            () => Task.FromResult(AutoRequestPlaybackOutcome.Committed)));
        Assert.True(await deduplicator.ExecuteAsync(
            "generation-c",
            "movie:user:same-item",
            () => Task.FromResult(AutoRequestPlaybackOutcome.Committed)));
        Assert.Equal(2, calls);
    }

    [Fact]
    public async Task Watcher_OldInFlightCompletionCannotReserveOrCommitReplacementGeneration()
    {
        var provider = new FakePluginConfigProvider(Configuration());
        var watcher = new TestWatcher(provider);
        var oldIntegration = Assert.IsType<SeerrIntegrationPolicy.SeerrIntegrationSnapshot>(
            watcher.CaptureEnabled());
        var oldStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseOld = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        var oldOperation = watcher.Execute(
            oldIntegration,
            "season:user:same-item",
            async () =>
            {
                oldStarted.TrySetResult();
                await releaseOld.Task;
                return AutoRequestPlaybackOutcome.Committed;
            });
        await oldStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));

        provider.Current = Configuration();
        var replacementIntegration = Assert.IsType<SeerrIntegrationPolicy.SeerrIntegrationSnapshot>(
            watcher.CaptureEnabled());
        Assert.NotEqual(
            oldIntegration.GenerationIdentity,
            replacementIntegration.GenerationIdentity);
        Assert.True(await watcher.Execute(
            replacementIntegration,
            "season:user:same-item",
            () => Task.FromResult(AutoRequestPlaybackOutcome.Committed)));

        releaseOld.TrySetResult();
        Assert.True(await oldOperation.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.False(await watcher.Execute(
            replacementIntegration,
            "season:user:same-item",
            () => Task.FromResult(AutoRequestPlaybackOutcome.Committed)));
    }

    private static PluginConfiguration Configuration()
        => new()
        {
            SeerrEnabled = true,
            SeerrUrls = "http://seerr",
            SeerrApiKey = "key",
            AutoMovieRequestEnabled = true,
        };

    private sealed class TestWatcher(IPluginConfigProvider provider) : PlaybackWatcherBase(
        null!,
        null!,
        null!,
        NullLogger.Instance,
        provider)
    {
        protected override string LogPrefix => "[Test]";

        protected override string FeatureNoun => "test";

        protected override string DisabledMonitoringName => "Test";

        protected override bool IsFeatureEnabled(PluginConfiguration config)
            => config.AutoMovieRequestEnabled;

        public SeerrIntegrationPolicy.SeerrIntegrationSnapshot? CaptureEnabled()
            => GetEnabledIntegration();

        public Task<bool> Execute(
            SeerrIntegrationPolicy.SeerrIntegrationSnapshot integration,
            string key,
            Func<Task<AutoRequestPlaybackOutcome>> operation)
            => ExecuteDeduplicatedAsync(integration, key, operation);

        protected override void SubscribeEvents()
        {
        }

        protected override void UnsubscribeEvents()
        {
        }
    }

    private sealed class ManualTimeProvider : TimeProvider
    {
        private DateTimeOffset _utcNow =
            new(2026, 7, 15, 0, 0, 0, TimeSpan.Zero);

        public override DateTimeOffset GetUtcNow() => _utcNow;

        public void Advance(TimeSpan elapsed) => _utcNow += elapsed;
    }
}
