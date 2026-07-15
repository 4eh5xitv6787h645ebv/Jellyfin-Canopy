using Jellyfin.Plugin.JellyfinCanopy.Services.AutoRequest;
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
            "movie:user:item",
            () =>
            {
                calls++;
                return Task.FromResult(AutoRequestPlaybackOutcome.RetryableFailure);
            }));

        Assert.True(await deduplicator.ExecuteAsync(
            "movie:user:item",
            () =>
            {
                calls++;
                return Task.FromResult(AutoRequestPlaybackOutcome.Committed);
            }));

        Assert.False(await deduplicator.ExecuteAsync(
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
            "season:user:item",
            () =>
            {
                calls++;
                return Task.FromResult(AutoRequestPlaybackOutcome.Cancelled);
            }));
        Assert.True(await deduplicator.ExecuteAsync(
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
            "movie:user:cancelled",
            () =>
            {
                calls++;
                return Task.FromException<AutoRequestPlaybackOutcome>(
                    new OperationCanceledException());
            }));
        Assert.True(await deduplicator.ExecuteAsync(
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
            "season:user:concurrent",
            BlockingOperation);
        await operationStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));

        var duplicates = Enumerable.Range(0, 32)
            .Select(_ => deduplicator.ExecuteAsync(
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

        Assert.True(await deduplicator.ExecuteAsync("movie:user:definitive", Operation));
        Assert.False(await deduplicator.ExecuteAsync("movie:user:definitive", Operation));

        clock.Advance(PlaybackRequestDeduplicator.CommittedTtl - TimeSpan.FromTicks(1));
        Assert.False(await deduplicator.ExecuteAsync("movie:user:definitive", Operation));

        clock.Advance(TimeSpan.FromTicks(1));
        Assert.True(await deduplicator.ExecuteAsync("movie:user:definitive", Operation));
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

        Assert.True(await deduplicator.ExecuteAsync("season:user:retry", Fail));
        Assert.True(await deduplicator.ExecuteAsync("season:user:retry", Fail));
        Assert.False(await deduplicator.ExecuteAsync("season:user:retry", Fail));

        clock.Advance(PlaybackRequestDeduplicator.InitialBackoff - TimeSpan.FromTicks(1));
        Assert.False(await deduplicator.ExecuteAsync("season:user:retry", Fail));

        clock.Advance(TimeSpan.FromTicks(1));
        Assert.True(await deduplicator.ExecuteAsync("season:user:retry", Fail));
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
                "movie:user:exception",
                () => Task.FromException<AutoRequestPlaybackOutcome>(
                    new InvalidOperationException("transient"))));

        Assert.True(await deduplicator.ExecuteAsync(
            "movie:user:exception",
            () => Task.FromResult(AutoRequestPlaybackOutcome.Committed)));
    }

    private sealed class ManualTimeProvider : TimeProvider
    {
        private DateTimeOffset _utcNow =
            new(2026, 7, 15, 0, 0, 0, TimeSpan.Zero);

        public override DateTimeOffset GetUtcNow() => _utcNow;

        public void Advance(TimeSpan elapsed) => _utcNow += elapsed;
    }
}
