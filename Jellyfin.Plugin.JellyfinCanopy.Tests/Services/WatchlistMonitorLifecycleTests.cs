using System.Net;
using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Reflection;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class WatchlistMonitorLifecycleTests
{
    [Fact]
    public async Task DisposeDuringPreparedMutation_JoinsWorkerAndPreventsLateSave()
    {
        var library = new CountingLibraryManager();
        var user = new User("dispose-user", "provider", "password-provider");
        var readStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var allowRead = new ManualResetEventSlim(false);
        var saveCalls = 0;
        var userData = new UserItemData { Key = "dispose-watchlist-test" };
        var data = new StubUserDataManager
        {
            GetUserDataHook = (_, _) =>
            {
                readStarted.TrySetResult();
                allowRead.Wait();
                return userData;
            },
            SaveUserDataHook = (_, _, _, _, _) => Interlocked.Increment(ref saveCalls),
        };
        var handler = new AuthorizedResponsesHandler(user);
        var monitor = new WatchlistMonitor(
            library,
            new StubUserManager(user),
            data,
            new RecordingHttpClientFactory(handler),
            null!,
            NullLogger<WatchlistMonitor>.Instance,
            new FakePluginConfigProvider(EnabledConfiguration()));

        monitor.Initialize();
        library.RaiseItemAdded(Movie(123));
        await readStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        using var throwingRegistration = GetConfigurationCancellation(monitor).Token.Register(
            static () => throw new InvalidOperationException("synthetic disposal callback failure"));

        var disposeTask = Task.Run(monitor.Dispose);
        await WaitUntilAsync(() => library.ItemAddedCount == 0);
        await Task.Delay(20);
        Assert.False(disposeTask.IsCompleted);
        allowRead.Set();
        await disposeTask.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Equal(0, Volatile.Read(ref saveCalls));
        Assert.NotEqual(true, userData.Likes);
    }

    [Fact]
    public async Task TenThousandDuplicateLibraryEvents_CoalesceOnOneBoundedWorker()
    {
        var library = new CountingLibraryManager();
        var handler = new BlockingEmptyRequestsHandler();
        var monitor = CreateEventMonitor(library, handler, out _);
        var movie = Movie(123);

        monitor.Initialize();
        library.RaiseItemAdded(movie);
        await handler.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        for (var index = 0; index < 10_000; index++)
        {
            library.RaiseItemAdded(movie);
        }

        var busy = monitor.QueueMetrics;
        Assert.Equal(1, busy.WorkerTasks);
        Assert.Equal(1, busy.StateCount);
        Assert.Equal(10_000, busy.Coalesced);
        Assert.Equal(0, busy.Dropped);

        handler.Release.TrySetResult();
        await WaitUntilAsync(() => monitor.QueueMetrics.StateCount == 0);

        Assert.InRange(monitor.QueueMetrics.Processed, 1, 2);
        // The pagination helper deliberately reads each complete source twice for a stable
        // snapshot. The coalesced follow-up hits the populated 30-second cache, so it adds no call.
        Assert.Equal(2, handler.RequestCount);
        monitor.Dispose();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ConfigurationReplacement_CancelsActiveAndDrainsQueuedOldGeneration(
        bool notifyBeforeProviderObservation)
    {
        var library = new CountingLibraryManager();
        var handler = new BlockingEmptyRequestsHandler();
        var monitor = CreateEventMonitor(library, handler, out var provider);

        monitor.Initialize();
        library.RaiseItemAdded(Movie(123));
        await handler.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        library.RaiseItemAdded(Movie(456));
        Assert.Equal(2, monitor.QueueMetrics.StateCount);

        if (notifyBeforeProviderObservation)
        {
            // Model the provider revision being observed only after the event callback. The
            // monitor's explicit generation must invalidate old work independently of that timing.
            monitor.NotifyConfigurationChanged();
            provider.Current = EnabledConfiguration();
        }
        else
        {
            provider.Current = EnabledConfiguration();
            monitor.NotifyConfigurationChanged();
        }
        await handler.CancellationObserved.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await WaitUntilAsync(() => monitor.QueueMetrics.StateCount == 0);

        // The active request was cancelled on the save event. The queued item from the replaced
        // generation is drained before making any additional remote call.
        Assert.Equal(1, handler.RequestCount);
        monitor.Dispose();
    }

    [Fact]
    public async Task DisableNotification_AdvancesGenerationAndClearsOwnedRequestCache()
    {
        var library = new CountingLibraryManager();
        var handler = new BlockingEmptyRequestsHandler();
        var monitor = CreateEventMonitor(library, handler, out var provider);

        monitor.Initialize();
        library.RaiseItemAdded(Movie(123));
        await handler.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        handler.Release.TrySetResult();
        await WaitUntilAsync(() => monitor.QueueMetrics.StateCount == 0);
        Assert.Equal(1, monitor.RequestsCacheCount);
        var generation = monitor.ConfigurationGenerationNumber;

        provider.Current = new PluginConfiguration
        {
            AddRequestedMediaToWatchlist = true,
            SeerrEnabled = false,
            SeerrUrls = "http://seerr:5055",
            SeerrApiKey = "retained-key",
        };
        monitor.NotifyConfigurationChanged();

        Assert.Equal(generation + 1, monitor.ConfigurationGenerationNumber);
        Assert.Equal(0, monitor.RequestsCacheCount);
        var requestsBeforeDisabledEvent = handler.RequestCount;
        library.RaiseItemAdded(Movie(456));
        await Task.Delay(50);
        Assert.Equal(requestsBeforeDisabledEvent, handler.RequestCount);
        monitor.Dispose();
    }

    [Fact]
    public async Task ThrowingCancellationCallback_StillAdvancesGenerationAndClearsOwnedCache()
    {
        var library = new CountingLibraryManager();
        var handler = new BlockingEmptyRequestsHandler();
        var monitor = CreateEventMonitor(library, handler, out _);

        monitor.Initialize();
        library.RaiseItemAdded(Movie(123));
        await handler.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        handler.Release.TrySetResult();
        await WaitUntilAsync(() => monitor.QueueMetrics.StateCount == 0);
        Assert.Equal(1, monitor.RequestsCacheCount);
        var generation = monitor.ConfigurationGenerationNumber;

        var cancellation = GetConfigurationCancellation(monitor);
        using var registration = cancellation.Token.Register(
            static () => throw new InvalidOperationException("synthetic cancellation callback failure"));

        monitor.NotifyConfigurationChanged();
        Assert.Equal(generation + 1, monitor.ConfigurationGenerationNumber);
        Assert.Equal(0, monitor.RequestsCacheCount);
        monitor.Dispose();
    }

    private static CancellationTokenSource GetConfigurationCancellation(WatchlistMonitor monitor)
    {
        var generationField = typeof(WatchlistMonitor).GetField(
            "_configurationGeneration",
            BindingFlags.Instance | BindingFlags.NonPublic);
        var generation = generationField!.GetValue(monitor);
        Assert.NotNull(generation);
        var cancellationProperty = generation.GetType().GetProperty("Cancellation");
        return Assert.IsType<CancellationTokenSource>(cancellationProperty!.GetValue(generation));
    }

    [Fact]
    public async Task DisableNotification_BlockedOldFlightCannotRepopulateClearedCache()
    {
        var library = new CountingLibraryManager();
        var handler = new IgnoringCancellationBlockingEmptyRequestsHandler();
        var monitor = CreateEventMonitor(library, handler, out var provider);

        monitor.Initialize();
        library.RaiseItemAdded(Movie(789));
        await handler.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));

        provider.Current = new PluginConfiguration
        {
            AddRequestedMediaToWatchlist = true,
            SeerrEnabled = false,
            SeerrUrls = "http://seerr:5055",
            SeerrApiKey = "retained-key",
        };
        monitor.NotifyConfigurationChanged();
        Assert.Equal(0, monitor.RequestsCacheCount);

        handler.Release.TrySetResult();
        await WaitUntilAsync(() => monitor.QueueMetrics.StateCount == 0);

        Assert.Equal(0, monitor.RequestsCacheCount);
        Assert.Equal(1, handler.RequestCount);
        library.RaiseItemAdded(Movie(790));
        await Task.Delay(50);
        Assert.Equal(1, handler.RequestCount);
        monitor.Dispose();
    }

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

    private static WatchlistMonitor CreateEventMonitor(
        CountingLibraryManager library,
        HttpMessageHandler handler,
        out FakePluginConfigProvider provider)
    {
        provider = new FakePluginConfigProvider(EnabledConfiguration());
        return new WatchlistMonitor(
            library,
            null!,
            null!,
            new RecordingHttpClientFactory(handler),
            null!,
            NullLogger<WatchlistMonitor>.Instance,
            provider);
    }

    private static PluginConfiguration EnabledConfiguration()
        => new()
        {
            AddRequestedMediaToWatchlist = true,
            SeerrEnabled = true,
            SeerrUrls = "http://seerr:5055",
            SeerrApiKey = "key",
            PreventWatchlistReAddition = false,
        };

    private static Movie Movie(int tmdbId)
    {
        var movie = new Movie
        {
            Id = Guid.NewGuid(),
            Name = $"Movie {tmdbId}",
        };
        movie.ProviderIds["Tmdb"] = tmdbId.ToString(System.Globalization.CultureInfo.InvariantCulture);
        return movie;
    }

    private sealed class BlockingEmptyRequestsHandler : HttpMessageHandler
    {
        private int _requestCount;

        public TaskCompletionSource Started { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource Release { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource CancellationObserved { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public int RequestCount => Volatile.Read(ref _requestCount);

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            _ = request;
            Interlocked.Increment(ref _requestCount);
            Started.TrySetResult();
            try
            {
                await Release.Task.WaitAsync(cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                CancellationObserved.TrySetResult();
                throw;
            }
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    JsonSerializer.Serialize(new
                    {
                        page = 1,
                        totalPages = 1,
                        totalResults = 0,
                        pageInfo = new
                        {
                            page = 1,
                            pages = 1,
                            pageSize = 0,
                            results = 0,
                        },
                        results = Array.Empty<object>(),
                    }),
                    Encoding.UTF8,
                    "application/json"),
            };
        }
    }

    private sealed class IgnoringCancellationBlockingEmptyRequestsHandler : HttpMessageHandler
    {
        private int _requestCount;

        public TaskCompletionSource Started { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource Release { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public int RequestCount => Volatile.Read(ref _requestCount);

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            _ = request;
            _ = cancellationToken;
            Interlocked.Increment(ref _requestCount);
            Started.TrySetResult();
            await Release.Task;
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    JsonSerializer.Serialize(new
                    {
                        page = 1,
                        totalPages = 1,
                        totalResults = 0,
                        pageInfo = new
                        {
                            page = 1,
                            pages = 1,
                            pageSize = 0,
                            results = 0,
                        },
                        results = Array.Empty<object>(),
                    }),
                    Encoding.UTF8,
                    "application/json"),
            };
        }
    }

    private sealed class AuthorizedResponsesHandler : HttpMessageHandler
    {
        private readonly User _user;

        public AuthorizedResponsesHandler(User user)
        {
            _user = user;
        }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            object row = request.RequestUri!.AbsolutePath switch
            {
                "/api/v1/request" => new
                {
                    id = 1,
                    type = "movie",
                    requestedBy = new { id = 7, jellyfinUserId = _user.Id.ToString() },
                    media = new { tmdbId = 123, mediaType = "movie" },
                },
                "/api/v1/user" => new
                {
                    id = 7,
                    jellyfinUserId = _user.Id.ToString(),
                },
                var path => throw new Xunit.Sdk.XunitException($"Unexpected path {path}."),
            };

            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    JsonSerializer.Serialize(new
                    {
                        page = 1,
                        totalPages = 1,
                        totalResults = 1,
                        pageInfo = new
                        {
                            page = 1,
                            pages = 1,
                            pageSize = 1,
                            results = 1,
                        },
                        results = new[] { row },
                    }),
                    Encoding.UTF8,
                    "application/json"),
            });
        }
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
