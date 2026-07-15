using System.Diagnostics;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Xunit;
using Xunit.Abstractions;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Helpers;

public sealed class BoundedCoalescingWorkerTests
{
    private readonly ITestOutputHelper _output;

    public BoundedCoalescingWorkerTests(ITestOutputHelper output)
    {
        _output = output;
    }

    [Fact]
    public async Task TenThousandDuplicateEvents_UseOneWorkerAndOneCurrentKey()
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = 0;
        var concurrent = 0;
        var maximumConcurrent = 0;
        var observedValues = new System.Collections.Concurrent.ConcurrentQueue<int>();
        await using var worker = new BoundedCoalescingWorker<int, int>(
            capacity: 16,
            maximumAttempts: 2,
            async (value, cancellationToken) =>
            {
                Interlocked.Increment(ref calls);
                observedValues.Enqueue(value);
                var current = Interlocked.Increment(ref concurrent);
                SetMaximum(ref maximumConcurrent, current);
                started.TrySetResult();
                await release.Task.WaitAsync(cancellationToken);
                Interlocked.Decrement(ref concurrent);
            });

        Assert.True(worker.TryEnqueue(7, 0));
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        for (var index = 1; index <= 10_000; index++)
        {
            Assert.True(worker.TryEnqueue(7, index));
        }

        var busy = worker.Metrics;
        Assert.Equal(1, busy.WorkerTasks);
        Assert.Equal(1, busy.StateCount);
        Assert.InRange(busy.QueueDepth, 0, 1);
        Assert.Equal(10_000, busy.Coalesced);
        Assert.Equal(0, busy.Dropped);

        release.TrySetResult();
        await WaitUntilAsync(() => worker.Metrics.StateCount == 0);

        Assert.Equal(2, Volatile.Read(ref calls));
        Assert.Equal(new[] { 0, 10_000 }, observedValues.ToArray());
        Assert.Equal(1, Volatile.Read(ref maximumConcurrent));
        Assert.InRange(worker.Metrics.PeakQueueDepth, 1, worker.Metrics.Capacity);
    }

    [Fact]
    public async Task DistinctEventStorm_RejectsBeyondFixedCapacityWithoutCreatingTasks()
    {
        const int capacity = 64;
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = 0;
        await using var worker = new BoundedCoalescingWorker<int, int>(
            capacity,
            maximumAttempts: 1,
            async (_, cancellationToken) =>
            {
                Interlocked.Increment(ref calls);
                started.TrySetResult();
                await release.Task.WaitAsync(cancellationToken);
            });

        var allocatedBefore = GC.GetTotalAllocatedBytes(precise: true);
        var stopwatch = Stopwatch.StartNew();
        Assert.True(worker.TryEnqueue(0, 0));
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var accepted = 1;
        for (var index = 1; index < 15_000; index++)
        {
            if (worker.TryEnqueue(index, index)) accepted++;
        }

        stopwatch.Stop();
        var allocated = GC.GetTotalAllocatedBytes(precise: true) - allocatedBefore;
        var metrics = worker.Metrics;
        _output.WriteLine(
            "events=15000 workerTasks={0} capacity={1} accepted={2} dropped={3} peakDepth={4} callsWhileBlocked={5} elapsedMs={6:F3} allocatedBytes={7}",
            metrics.WorkerTasks,
            metrics.Capacity,
            accepted,
            metrics.Dropped,
            metrics.PeakQueueDepth,
            Volatile.Read(ref calls),
            stopwatch.Elapsed.TotalMilliseconds,
            allocated);

        Assert.Equal(capacity, accepted);
        Assert.Equal(15_000 - capacity, metrics.Dropped);
        Assert.Equal(capacity, metrics.StateCount);
        Assert.Equal(capacity - 1, metrics.QueueDepth);
        Assert.Equal(capacity - 1, metrics.PeakQueueDepth);
        Assert.Equal(1, metrics.WorkerTasks);
        Assert.Equal(1, Volatile.Read(ref calls));

        release.TrySetResult();
        await WaitUntilAsync(() => worker.Metrics.StateCount == 0);
        Assert.Equal(capacity, Volatile.Read(ref calls));
    }

    [Fact]
    public async Task FailureRetryBudget_IsExactAndBounded()
    {
        var calls = 0;
        var observedFailures = 0;
        await using var worker = new BoundedCoalescingWorker<int, int>(
            capacity: 4,
            maximumAttempts: 2,
            (_, _) =>
            {
                Interlocked.Increment(ref calls);
                throw new InvalidOperationException("sentinel");
            },
            failureObserver: _ => Interlocked.Increment(ref observedFailures));

        Assert.True(worker.TryEnqueue(1, 1));
        await WaitUntilAsync(() =>
            worker.Metrics.StateCount == 0 && Volatile.Read(ref observedFailures) == 2);

        var metrics = worker.Metrics;
        Assert.Equal(2, Volatile.Read(ref calls));
        Assert.Equal(2, Volatile.Read(ref observedFailures));
        Assert.Equal(2, metrics.Failures);
        Assert.Equal(1, metrics.Retried);
        Assert.Equal(0, metrics.Processed);
    }

    [Fact]
    public async Task Dispose_CancelsAndJoinsTheOwnedWorker()
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cancellationObserved = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var worker = new BoundedCoalescingWorker<int, int>(
            capacity: 4,
            maximumAttempts: 2,
            async (_, cancellationToken) =>
            {
                started.TrySetResult();
                try
                {
                    await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    cancellationObserved.TrySetResult();
                    throw;
                }
            });

        Assert.True(worker.TryEnqueue(1, 1));
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await worker.DisposeAsync();

        Assert.True(cancellationObserved.Task.IsCompletedSuccessfully);
        Assert.False(worker.TryEnqueue(2, 2));
        Assert.True(worker.Metrics.Cancelled >= 1);
    }

    [Fact]
    public async Task ConcurrentDisposeAsyncCallers_AwaitTheSameShutdownJoin()
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cancellationObserved = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var allowExit = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var worker = new BoundedCoalescingWorker<int, int>(
            capacity: 4,
            maximumAttempts: 1,
            async (_, cancellationToken) =>
            {
                started.TrySetResult();
                try
                {
                    await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    cancellationObserved.TrySetResult();
                    await allowExit.Task;
                    throw;
                }
            });

        Assert.True(worker.TryEnqueue(1, 1));
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var first = worker.DisposeAsync().AsTask();
        await cancellationObserved.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var second = worker.DisposeAsync().AsTask();

        Assert.False(first.IsCompleted);
        Assert.False(second.IsCompleted);
        allowExit.TrySetResult();
        await Task.WhenAll(first, second).WaitAsync(TimeSpan.FromSeconds(5));
    }

    [Fact]
    public async Task CapacityDrop_RecoversAfterAnEntryCompletes()
    {
        var releases = new System.Collections.Concurrent.ConcurrentQueue<TaskCompletionSource>();
        await using var worker = new BoundedCoalescingWorker<int, int>(
            capacity: 2,
            maximumAttempts: 1,
            async (_, cancellationToken) =>
            {
                var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                releases.Enqueue(release);
                await release.Task.WaitAsync(cancellationToken);
            });

        Assert.True(worker.TryEnqueue(1, 1));
        await WaitUntilAsync(() => !releases.IsEmpty);
        Assert.True(worker.TryEnqueue(2, 2));
        Assert.False(worker.TryEnqueue(3, 3));

        Assert.True(releases.TryDequeue(out var firstRelease));
        firstRelease.TrySetResult();
        await WaitUntilAsync(() => worker.Metrics.StateCount == 1);
        Assert.True(worker.TryEnqueue(3, 3));

        while (worker.Metrics.StateCount > 0)
        {
            if (releases.TryDequeue(out var release)) release.TrySetResult();
            await Task.Delay(1);
        }

        Assert.Equal(1, worker.Metrics.Dropped);
        Assert.Equal(3, worker.Metrics.Processed);
    }

    private static void SetMaximum(ref int target, int value)
    {
        var current = Volatile.Read(ref target);
        while (value > current)
        {
            var observed = Interlocked.CompareExchange(ref target, value, current);
            if (observed == current) return;
            current = observed;
        }
    }

    private static async Task WaitUntilAsync(Func<bool> condition)
    {
        var timeoutAt = DateTime.UtcNow.AddSeconds(5);
        while (!condition() && DateTime.UtcNow < timeoutAt)
        {
            await Task.Delay(10);
        }

        Assert.True(condition(), "Timed out waiting for the bounded worker to become idle.");
    }
}
