using System.Net;
using System.Collections.Concurrent;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Entities.Movies;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class WatchlistMonitorLifecycleTests
{
    [Fact]
    public async Task CompletedOlderFlight_DoesNotDeleteNewerReplacement()
    {
        var olderCompletion = new TaskCompletionSource<int>();
        var inFlight = new ConcurrentDictionary<string, Lazy<Task<int>>>();
        var olderTask = AsyncSingleFlight.GetOrAdd(
            inFlight,
            "source",
            () => olderCompletion.Task);
        var older = inFlight["source"];
        var newer = new Lazy<Task<int>>(() => Task.FromResult(2));
        Assert.True(inFlight.TryUpdate("source", newer, older));

        // ExecuteSynchronously makes the old flight's exact-value removal run
        // before SetResult returns. It must observe the replacement and leave it.
        olderCompletion.SetResult(1);
        Assert.Equal(1, await olderTask);
        Assert.Same(newer, inFlight["source"]);
        Assert.True(AsyncSingleFlight.TryRemoveExact(inFlight, "source", newer));
        Assert.Empty(inFlight);
    }

    [Fact]
    public async Task SingleFlight_ConcurrentCallersRunFactoryOnce()
    {
        var inFlight = new ConcurrentDictionary<string, Lazy<Task<int>>>();
        var start = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        var factoryCalls = 0;

        var callers = Enumerable.Range(0, 64)
            .Select(_ => Task.Run(async () =>
            {
                await start.Task;
                return await AsyncSingleFlight.GetOrAdd(
                    inFlight,
                    "source",
                    () =>
                    {
                        Interlocked.Increment(ref factoryCalls);
                        return release.Task;
                    });
            }))
            .ToArray();

        start.SetResult();
        await WaitUntilAsync(() => Volatile.Read(ref factoryCalls) == 1);
        await Task.Delay(50);
        Assert.Equal(1, Volatile.Read(ref factoryCalls));

        release.SetResult(42);
        Assert.All(await Task.WhenAll(callers), value => Assert.Equal(42, value));
        await WaitUntilAsync(() => inFlight.IsEmpty);
    }

    [Fact]
    public async Task Dispose_CancelsInFlightRequestAndIsThreadSafe()
    {
        var library = new CountingLibraryManager();
        var handler = new CancellationObservingHandler();
        var monitor = new WatchlistMonitor(
            library,
            null!,
            null!,
            new RecordingHttpClientFactory(handler),
            null!,
            NullLogger<WatchlistMonitor>.Instance,
            new FakePluginConfigProvider(new PluginConfiguration
            {
                AddRequestedMediaToWatchlist = true,
                SeerrEnabled = true,
                SeerrUrls = "http://seerr:5055",
                SeerrApiKey = "key",
            }));

        monitor.Initialize();
        var movie = new Movie { Name = "Cancellation sentinel" };
        movie.ProviderIds["Tmdb"] = "123";
        library.RaiseItemAdded(movie);

        await handler.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await Task.WhenAll(
            Task.Run(monitor.Dispose),
            Task.Run(monitor.Dispose));
        await handler.CancellationObserved.Task.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Equal(0, library.ItemAddedCount);
        Assert.Equal(0, library.ItemUpdatedCount);

        // A third call remains a no-op after the in-flight worker has unwound and disposed the CTS.
        monitor.Dispose();
    }

    private static async Task WaitUntilAsync(Func<bool> condition)
    {
        var timeoutAt = DateTime.UtcNow.AddSeconds(5);
        while (!condition() && DateTime.UtcNow < timeoutAt)
        {
            await Task.Delay(10);
        }

        Assert.True(condition(), "Timed out waiting for the expected single-flight state.");
    }

    private sealed class CancellationObservingHandler : HttpMessageHandler
    {
        public TaskCompletionSource Started { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource CancellationObserved { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Started.TrySetResult();
            try
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                return new HttpResponseMessage(HttpStatusCode.OK);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                CancellationObserved.TrySetResult();
                throw;
            }
        }
    }
}
