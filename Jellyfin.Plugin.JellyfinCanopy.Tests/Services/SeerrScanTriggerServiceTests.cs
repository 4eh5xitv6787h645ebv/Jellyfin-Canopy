using System.Collections.Concurrent;
using System.Net;
using System.Text;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Entities.Movies;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class SeerrScanTriggerServiceTests
{
    private static readonly DateTimeOffset Epoch =
        new(2026, 7, 15, 0, 0, 0, TimeSpan.Zero);

    [Fact]
    public void ParseUrls_NormalizesDocumentedSeparatorsAndDeduplicatesAliases()
    {
        var urls = SeerrScanTriggerService.ParseUrls(
            " http://first:5055/\r\nhttp://second:5055, http://first:5055\nhttp://second:5055/ ");

        Assert.Equal(new[] { "http://first:5055", "http://second:5055" }, urls);
    }

    [Fact]
    public void ParseUrls_PreservesPathCaseAsDistinctIdentityDomains()
    {
        var urls = SeerrScanTriggerService.ParseUrls(
            "http://seerr:5055/Tenant,http://seerr:5055/tenant");

        Assert.Equal(
            new[] { "http://seerr:5055/Tenant", "http://seerr:5055/tenant" },
            urls);
    }

    [Fact]
    public void DispatchDelay_UsesTrailingDebounceUntilFourWindowHardCap()
    {
        var debounce = TimeSpan.FromSeconds(5);

        Assert.Equal(
            debounce,
            SeerrScanTriggerService.ComputeDispatchDelay(Epoch, Epoch.AddSeconds(12), debounce));
        Assert.Equal(
            TimeSpan.FromSeconds(2),
            SeerrScanTriggerService.ComputeDispatchDelay(Epoch, Epoch.AddSeconds(18), debounce));
        Assert.Equal(
            TimeSpan.Zero,
            SeerrScanTriggerService.ComputeDispatchDelay(Epoch, Epoch.AddSeconds(20), debounce));
    }

    [Fact]
    public async Task Burst_DispatchesOnceAfterTrailingDebounce()
    {
        var clock = new ManualTimeProvider(Epoch);
        var library = new CountingLibraryManager();
        var handler = LifecycleHandler.Immediate();
        using var service = CreateService(EnabledProvider(), handler, library, clock);
        service.Initialize();

        for (var index = 0; index < 100; index++)
        {
            library.RaiseItemAdded(Movie());
        }

        clock.Advance(TimeSpan.FromSeconds(4));
        Assert.Equal(0, handler.RequestCount);
        clock.Advance(TimeSpan.FromSeconds(1));
        await WaitUntilAsync(() => handler.RequestCount == 1);

        Assert.Equal(1, handler.RequestCount);
        Assert.Equal(1, handler.MaximumConcurrency);
    }

    [Fact]
    public async Task ContinuousEvents_DispatchByFourWindowMaximumLatency()
    {
        var clock = new ManualTimeProvider(Epoch);
        var library = new CountingLibraryManager();
        var handler = LifecycleHandler.Immediate();
        using var service = CreateService(EnabledProvider(), handler, library, clock);
        service.Initialize();

        library.RaiseItemAdded(Movie());
        for (var elapsed = 4; elapsed <= 16; elapsed += 4)
        {
            clock.Advance(TimeSpan.FromSeconds(4));
            library.RaiseItemAdded(Movie());
            Assert.Equal(0, handler.RequestCount);
        }

        clock.Advance(TimeSpan.FromSeconds(3));
        Assert.Equal(0, handler.RequestCount);
        clock.Advance(TimeSpan.FromSeconds(1));
        await WaitUntilAsync(() => handler.RequestCount == 1);

        Assert.Equal(1, handler.RequestCount);
    }

    [Fact]
    public async Task ManualTrigger_WithPendingTimer_DrainsToExactlyOneScan()
    {
        var clock = new ManualTimeProvider(Epoch);
        var library = new CountingLibraryManager();
        var handler = LifecycleHandler.Immediate();
        using var service = CreateService(EnabledProvider(), handler, library, clock);
        service.Initialize();
        library.RaiseItemAdded(Movie());

        var result = await service.TriggerNowAsync("http://first:5055", "key");
        clock.Advance(TimeSpan.FromMinutes(1));
        await Task.Yield();

        Assert.True(result.Success);
        Assert.Equal(1, handler.RequestCount);
    }

    [Fact]
    public async Task ManualTrigger_JoinsEquivalentAutomaticScanAlreadyInFlight()
    {
        var clock = new ManualTimeProvider(Epoch);
        var library = new CountingLibraryManager();
        var handler = LifecycleHandler.BlockingFirst();
        using var service = CreateService(EnabledProvider(), handler, library, clock);
        service.Initialize();
        library.RaiseItemAdded(Movie());
        clock.Advance(TimeSpan.FromSeconds(5));
        await handler.FirstStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));

        var manual = service.TriggerNowAsync("http://first:5055", "key");
        await Task.Delay(20);
        Assert.Equal(1, handler.RequestCount);
        handler.ReleaseFirst.TrySetResult();

        Assert.True((await manual.WaitAsync(TimeSpan.FromSeconds(5))).Success);
        Assert.Equal(1, handler.RequestCount);
    }

    [Fact]
    public async Task ManualTrigger_WithNewEventsDuringActiveScan_UsesOneFollowUp()
    {
        var clock = new ManualTimeProvider(Epoch);
        var library = new CountingLibraryManager();
        var handler = LifecycleHandler.BlockingFirst();
        using var service = CreateService(EnabledProvider(), handler, library, clock);
        service.Initialize();
        library.RaiseItemAdded(Movie());
        clock.Advance(TimeSpan.FromSeconds(5));
        await handler.FirstStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));

        library.RaiseItemAdded(Movie());
        var manual = service.TriggerNowAsync("http://first:5055", "key");
        await Task.Delay(20);
        Assert.Equal(1, handler.RequestCount);
        handler.ReleaseFirst.TrySetResult();

        Assert.True((await manual.WaitAsync(TimeSpan.FromSeconds(5))).Success);
        clock.Advance(TimeSpan.FromMinutes(1));
        await Task.Yield();
        Assert.Equal(2, handler.RequestCount);
        Assert.Equal(1, handler.MaximumConcurrency);
    }

    [Fact]
    public async Task ManualTrigger_AfterResultsPublishButBeforeWorkerClears_StartsNewScan()
    {
        var handler = LifecycleHandler.Immediate();
        using var service = CreateService(EnabledProvider(), handler);
        var completionPublished = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        using var allowStateTransition = new ManualResetEventSlim(false);
        service.OnAfterPlanCompletedForTest = () =>
        {
            completionPublished.TrySetResult();
            allowStateTransition.Wait();
        };

        Assert.True((await service.TriggerNowAsync("http://first:5055", "key")).Success);
        await completionPublished.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var second = service.TriggerNowAsync("http://first:5055", "key");
        Assert.Equal(1, handler.RequestCount);

        service.OnAfterPlanCompletedForTest = null;
        allowStateTransition.Set();
        Assert.True((await second.WaitAsync(TimeSpan.FromSeconds(5))).Success);
        Assert.Equal(2, handler.RequestCount);
    }

    [Fact]
    public async Task EventsDuringInFlightDispatch_CreateOneNonOverlappingFollowUp()
    {
        var clock = new ManualTimeProvider(Epoch);
        var library = new CountingLibraryManager();
        var handler = LifecycleHandler.BlockingFirst();
        using var service = CreateService(EnabledProvider(), handler, library, clock);
        service.Initialize();
        library.RaiseItemAdded(Movie());
        clock.Advance(TimeSpan.FromSeconds(5));
        await handler.FirstStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));

        for (var index = 0; index < 1_000; index++)
        {
            library.RaiseItemAdded(Movie());
        }

        clock.Advance(TimeSpan.FromSeconds(5));
        Assert.Equal(1, handler.RequestCount);
        handler.ReleaseFirst.TrySetResult();
        await WaitUntilAsync(() => handler.RequestCount == 2);

        Assert.Equal(2, handler.RequestCount);
        Assert.Equal(1, handler.MaximumConcurrency);
    }

    [Fact]
    public async Task FailedDispatch_ReleasesSingleFlightForOneQueuedFollowUp()
    {
        var clock = new ManualTimeProvider(Epoch);
        var library = new CountingLibraryManager();
        var handler = LifecycleHandler.BlockingFirst(HttpStatusCode.InternalServerError);
        using var service = CreateService(EnabledProvider(), handler, library, clock);
        service.Initialize();
        library.RaiseItemAdded(Movie());
        clock.Advance(TimeSpan.FromSeconds(5));
        await handler.FirstStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));

        library.RaiseItemAdded(Movie());
        clock.Advance(TimeSpan.FromSeconds(5));
        handler.ReleaseFirst.TrySetResult();
        await WaitUntilAsync(() => handler.RequestCount == 2);

        Assert.Equal(2, handler.RequestCount);
        Assert.Equal(1, handler.MaximumConcurrency);
    }

    [Fact]
    public async Task Dispose_CancelsAndJoinsActiveRequestAndPreventsLateCalls()
    {
        var clock = new ManualTimeProvider(Epoch);
        var library = new CountingLibraryManager();
        var handler = LifecycleHandler.CancellationBlocking();
        var service = CreateService(EnabledProvider(), handler, library, clock);
        service.Initialize();
        library.RaiseItemAdded(Movie());
        clock.Advance(TimeSpan.FromSeconds(5));
        await handler.FirstStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));

        await Task.WhenAll(Task.Run(service.Dispose), Task.Run(service.Dispose));
        await handler.CancellationObserved.Task.WaitAsync(TimeSpan.FromSeconds(5));

        library.RaiseItemAdded(Movie());
        clock.Advance(TimeSpan.FromHours(1));
        await Task.Yield();
        Assert.Equal(1, handler.RequestCount);
        Assert.Equal(0, library.ItemAddedCount);
        await Assert.ThrowsAsync<ObjectDisposedException>(
            () => service.TriggerNowAsync("http://first:5055", "key"));
    }

    [Fact]
    public async Task ScheduledDispatch_FeatureDisabledBeforeTimerFires_DoesNotPost()
    {
        var provider = new FakePluginConfigProvider(new PluginConfiguration
        {
            SeerrEnabled = false,
            TriggerSeerrScanOnItemAdded = false,
            SeerrUrls = "http://first:5055",
            SeerrApiKey = "key",
        });
        var handler = LifecycleHandler.Immediate();
        using var service = CreateService(provider, handler);

        var results = await service.DispatchAsync(batchSize: 1);

        Assert.Empty(results);
        Assert.Equal(0, handler.RequestCount);
    }

    [Fact]
    public async Task MultiDomainDispatch_ConfigChangesDuringFirstPost_StopsRemainingDomains()
    {
        var provider = new FakePluginConfigProvider(new PluginConfiguration
        {
            SeerrEnabled = true,
            TriggerSeerrScanOnItemAdded = true,
            SeerrUrls = "http://first:5055,http://second:5055",
            SeerrApiKey = "key-a",
        });
        var handler = LifecycleHandler.Immediate(() => provider.Current = new PluginConfiguration
        {
            SeerrEnabled = true,
            TriggerSeerrScanOnItemAdded = true,
            SeerrUrls = "http://replacement:5055",
            SeerrApiKey = "key-b",
        });
        using var service = CreateService(provider, handler);

        var results = await service.DispatchAsync(batchSize: 1);

        Assert.Equal(2, results.Count);
        Assert.True(results[0].Success);
        Assert.Equal("ConfigurationChanged", results[1].ErrorCode);
        Assert.Equal(409, results[1].StatusCode);
        var request = Assert.Single(handler.Requests);
        Assert.Equal("first", request.Host);
        Assert.Equal("key-a", request.ApiKey);
    }

    [Fact]
    public async Task MultiDomainManualBatch_WithPendingTimer_DispatchesEveryDomainOnce()
    {
        var provider = EnabledProvider();
        provider.Current!.SeerrUrls = "http://first:5055,http://second:5055";
        var clock = new ManualTimeProvider(Epoch);
        var library = new CountingLibraryManager();
        var handler = LifecycleHandler.Immediate();
        using var service = CreateService(provider, handler, library, clock);
        service.Initialize();
        library.RaiseItemAdded(Movie());

        var results = await service.TriggerNowAsync(
            new[] { "http://first:5055", "http://second:5055" },
            "key");
        clock.Advance(TimeSpan.FromMinutes(1));
        await Task.Yield();

        Assert.Equal(new[] { "first", "second" }, handler.Requests.Select(request => request.Host));
        Assert.All(results, result => Assert.True(result.Success));
        Assert.Equal(2, handler.RequestCount);
    }

    [Fact]
    public async Task ManualSubset_PreservesPendingAutomaticOnlyDomainsInFollowUp()
    {
        var provider = EnabledProvider();
        provider.Current!.SeerrUrls = "http://first:5055,http://second:5055";
        var clock = new ManualTimeProvider(Epoch);
        var library = new CountingLibraryManager();
        var handler = LifecycleHandler.BlockingFirst();
        using var service = CreateService(provider, handler, library, clock);
        service.Initialize();
        library.RaiseItemAdded(Movie());
        clock.Advance(TimeSpan.FromSeconds(5));
        await handler.FirstStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));

        library.RaiseItemAdded(Movie());
        var manual = service.TriggerNowAsync(new[] { "http://first:5055" }, "key");
        handler.ReleaseFirst.TrySetResult();
        var results = await manual.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Equal(new[] { "first", "second", "first", "second" },
            handler.Requests.Select(request => request.Host));
        Assert.Equal(new[] { "http://first:5055", "http://second:5055" },
            results.Select(result => result.Url));
        Assert.Equal(1, handler.MaximumConcurrency);
    }

    [Fact]
    public async Task ManualAwaiterCancellation_DoesNotCancelSharedWorker()
    {
        var handler = LifecycleHandler.BlockingFirst();
        using var service = CreateService(EnabledProvider(), handler);
        using var callerCancellation = new CancellationTokenSource();
        var manual = service.TriggerNowAsync(
            "http://first:5055",
            "key",
            callerCancellation.Token);
        await handler.FirstStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));

        callerCancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => manual);
        Assert.Equal(1, handler.ActiveCount);
        await Task.Delay(20);
        Assert.Equal(1, handler.ActiveCount);
        Assert.Equal(1, handler.RequestCount);
        handler.ReleaseFirst.TrySetResult();
        await WaitUntilAsync(() => handler.ActiveCount == 0);
        Assert.Equal(1, handler.RequestCount);
    }

    [Fact]
    public async Task ManualTrigger_MasterDisabledWithRetainedCredentials_DoesNotPost()
    {
        var provider = new FakePluginConfigProvider(new PluginConfiguration
        {
            SeerrEnabled = false,
            TriggerSeerrScanOnItemAdded = true,
            SeerrUrls = "http://retained:5055",
            SeerrApiKey = "retained-key",
        });
        var handler = LifecycleHandler.Immediate();
        using var service = CreateService(provider, handler);

        var result = await service.TriggerNowAsync(
            "http://retained:5055",
            "retained-key");

        Assert.False(result.Success);
        Assert.Equal("SeerrDisabled", result.ErrorCode);
        Assert.Equal(503, result.StatusCode);
        Assert.Equal(0, handler.RequestCount);
    }

    private static FakePluginConfigProvider EnabledProvider()
        => new(new PluginConfiguration
        {
            SeerrEnabled = true,
            TriggerSeerrScanOnItemAdded = true,
            SeerrScanDebounceSeconds = 5,
            SeerrUrls = "http://first:5055",
            SeerrApiKey = "key",
        });

    private static Movie Movie() => new() { Name = "Seerr scan trigger test" };

    private static SeerrScanTriggerService CreateService(
        FakePluginConfigProvider provider,
        HttpMessageHandler handler,
        CountingLibraryManager? library = null,
        TimeProvider? timeProvider = null)
        => new(
            library ?? new CountingLibraryManager(),
            new RecordingHttpClientFactory(handler),
            NullLogger<SeerrScanTriggerService>.Instance,
            provider,
            timeProvider ?? TimeProvider.System);

    private static async Task WaitUntilAsync(Func<bool> condition)
    {
        var timeoutAt = DateTime.UtcNow.AddSeconds(5);
        while (!condition() && DateTime.UtcNow < timeoutAt)
        {
            await Task.Delay(10);
        }

        Assert.True(condition(), "Timed out waiting for the Seerr trigger state transition.");
    }

    private sealed class LifecycleHandler : HttpMessageHandler
    {
        private readonly Func<int, CancellationToken, Task<HttpResponseMessage>> _respond;
        private readonly Action? _onFirstRequest;
        private int _requestCount;
        private int _active;
        private int _maximumConcurrency;

        private LifecycleHandler(
            Func<int, CancellationToken, Task<HttpResponseMessage>> respond,
            Action? onFirstRequest = null)
        {
            _respond = respond;
            _onFirstRequest = onFirstRequest;
        }

        public ConcurrentQueue<CapturedRequest> Requests { get; } = new();
        public int RequestCount => Volatile.Read(ref _requestCount);
        public int ActiveCount => Volatile.Read(ref _active);
        public int MaximumConcurrency => Volatile.Read(ref _maximumConcurrency);
        public TaskCompletionSource FirstStarted { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource ReleaseFirst { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource CancellationObserved { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public static LifecycleHandler Immediate(Action? onFirstRequest = null)
            => new(
                (_, _) => Task.FromResult(JsonResponse(HttpStatusCode.OK)),
                onFirstRequest);

        public static LifecycleHandler BlockingFirst(HttpStatusCode firstStatus = HttpStatusCode.OK)
        {
            LifecycleHandler? handler = null;
            handler = new LifecycleHandler(async (requestNumber, cancellationToken) =>
            {
                if (requestNumber == 1)
                {
                    handler!.FirstStarted.TrySetResult();
                    await handler.ReleaseFirst.Task.WaitAsync(cancellationToken);
                    return JsonResponse(firstStatus);
                }

                return JsonResponse(HttpStatusCode.OK);
            });
            return handler;
        }

        public static LifecycleHandler CancellationBlocking()
        {
            LifecycleHandler? handler = null;
            handler = new LifecycleHandler(async (_, cancellationToken) =>
            {
                handler!.FirstStarted.TrySetResult();
                try
                {
                    await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                }
                catch (OperationCanceledException)
                {
                    handler.CancellationObserved.TrySetResult();
                    throw;
                }

                return JsonResponse(HttpStatusCode.OK);
            });
            return handler;
        }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var requestNumber = Interlocked.Increment(ref _requestCount);
            var active = Interlocked.Increment(ref _active);
            UpdateMaximum(active);
            var apiKey = request.Headers.TryGetValues("X-Api-Key", out var values)
                ? values.SingleOrDefault()
                : null;
            Requests.Enqueue(new CapturedRequest(request.RequestUri!.Host, apiKey));
            if (requestNumber == 1)
            {
                _onFirstRequest?.Invoke();
            }

            try
            {
                return await _respond(requestNumber, cancellationToken);
            }
            finally
            {
                Interlocked.Decrement(ref _active);
            }
        }

        private void UpdateMaximum(int active)
        {
            while (true)
            {
                var current = Volatile.Read(ref _maximumConcurrency);
                if (current >= active
                    || Interlocked.CompareExchange(ref _maximumConcurrency, active, current) == current)
                {
                    return;
                }
            }
        }

        private static HttpResponseMessage JsonResponse(HttpStatusCode statusCode)
            => new(statusCode)
            {
                Content = new StringContent("{}", Encoding.UTF8, "application/json"),
            };
    }

    private sealed record CapturedRequest(string Host, string? ApiKey);

    private sealed class ManualTimeProvider : TimeProvider
    {
        private readonly object _sync = new();
        private readonly List<ManualTimer> _timers = new();
        private DateTimeOffset _now;

        public ManualTimeProvider(DateTimeOffset now) => _now = now;

        public override DateTimeOffset GetUtcNow()
        {
            lock (_sync)
            {
                return _now;
            }
        }

        public override ITimer CreateTimer(
            TimerCallback callback,
            object? state,
            TimeSpan dueTime,
            TimeSpan period)
        {
            var timer = new ManualTimer(this, callback, state, dueTime, period);
            lock (_sync)
            {
                _timers.Add(timer);
            }

            return timer;
        }

        public void Advance(TimeSpan amount)
        {
            List<ManualTimer> due;
            DateTimeOffset now;
            lock (_sync)
            {
                _now = _now.Add(amount);
                now = _now;
                due = _timers.Where(timer => timer.IsDue(now)).ToList();
            }

            foreach (var timer in due)
            {
                timer.Fire(now);
            }
        }

        private sealed class ManualTimer : ITimer
        {
            private readonly object _sync = new();
            private readonly ManualTimeProvider _owner;
            private readonly TimerCallback _callback;
            private readonly object? _state;
            private TimeSpan _period;
            private DateTimeOffset _dueAt;
            private bool _armed;
            private bool _disposed;

            public ManualTimer(
                ManualTimeProvider owner,
                TimerCallback callback,
                object? state,
                TimeSpan dueTime,
                TimeSpan period)
            {
                _owner = owner;
                _callback = callback;
                _state = state;
                _period = period;
                _armed = dueTime != Timeout.InfiniteTimeSpan;
                _dueAt = _armed ? owner.GetUtcNow().Add(dueTime) : DateTimeOffset.MaxValue;
            }

            public bool IsDue(DateTimeOffset now)
            {
                lock (_sync)
                {
                    return !_disposed && _armed && _dueAt <= now;
                }
            }

            public void Fire(DateTimeOffset now)
            {
                lock (_sync)
                {
                    if (_disposed || !_armed || _dueAt > now) return;
                    if (_period == Timeout.InfiniteTimeSpan)
                    {
                        _armed = false;
                    }
                    else
                    {
                        _dueAt = now.Add(_period);
                    }
                }

                _callback(_state);
            }

            public bool Change(TimeSpan dueTime, TimeSpan period)
            {
                lock (_sync)
                {
                    if (_disposed) return false;
                    _period = period;
                    _armed = dueTime != Timeout.InfiniteTimeSpan;
                    _dueAt = _armed
                        ? _owner.GetUtcNow().Add(dueTime)
                        : DateTimeOffset.MaxValue;
                    return true;
                }
            }

            public void Dispose()
            {
                lock (_sync)
                {
                    _disposed = true;
                    _armed = false;
                }
            }

            public ValueTask DisposeAsync()
            {
                Dispose();
                return ValueTask.CompletedTask;
            }
        }
    }
}
