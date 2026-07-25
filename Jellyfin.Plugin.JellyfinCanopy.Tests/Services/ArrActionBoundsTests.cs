using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Model.Arr;
using Jellyfin.Plugin.JellyfinCanopy.Services.Arr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

/// <summary>
/// Regression coverage for the process-wide Arr action fan-out bounds. Blocking handlers make
/// permit ownership observable without timing sleeps.
/// </summary>
public sealed class ArrActionBoundsTests
{
    [Fact]
    public async Task Resolver_CapsInstancesAndReportsExplicitDegradedResult()
    {
        var handler = new ImmediateArrHandler();
        var resolver = NewResolver(handler);
        var instances = Instances(ArrTargetResolver.MaxResolvedInstances + 1);

        var (matches, errors) = await resolver.ResolveMatchesAsync(
            Movie(),
            instances,
            "radarr",
            CancellationToken.None);

        Assert.Equal(ArrTargetResolver.MaxResolvedInstances, handler.MovieLookups);
        Assert.Equal(ArrTargetResolver.MaxResolvedInstances, matches.Count);
        var error = Assert.Single(errors);
        Assert.Equal("radarr", error.InstanceName);
        Assert.Contains(
            $"{ArrTargetResolver.MaxResolvedInstances} configured instances",
            error.Reason,
            StringComparison.Ordinal);
        Assert.DoesNotContain(matches, match => match.Instance.Name == instances[^1].Name);
    }

    [Fact]
    public async Task NamedDispatch_PreselectsTargetBeyondGlobalCap()
    {
        var handler = new ImmediateArrHandler();
        var fetch = NewFetch(handler);
        var actions = new ArrActionService(
            fetch,
            new ArrTargetResolver(fetch),
            NullLogger<ArrActionService>.Instance);
        var instances = Instances(ArrTargetResolver.MaxResolvedInstances + 1);
        var target = instances[^1];
        var config = RadarrConfig(instances);

        var result = await actions.DispatchAutoSearchAsync(
            Movie(),
            config,
            target.Name,
            CancellationToken.None);

        var dispatched = Assert.Single(result.Dispatched);
        Assert.Equal(target.Name, dispatched.InstanceName);
        Assert.Empty(result.Errors);
        Assert.Equal(1, handler.MovieLookups);
        Assert.Equal(1, handler.Commands);
        Assert.All(handler.ApiKeys, key => Assert.Equal(target.ApiKey, key));
    }

    [Fact]
    public async Task NamedMutations_MissingInstanceFailBeforeAnyResolution()
    {
        var handler = new ImmediateArrHandler();
        var fetch = NewFetch(handler);
        var actions = new ArrActionService(
            fetch,
            new ArrTargetResolver(fetch),
            NullLogger<ArrActionService>.Instance);
        var config = RadarrConfig(Instances(1));

        var search = await actions.DispatchAutoSearchAsync(
            Movie(),
            config,
            "missing",
            CancellationToken.None);
        var monitor = await actions.SetMonitoredAsync(
            Movie(),
            config,
            monitored: true,
            instanceName: "missing",
            ct: CancellationToken.None);

        Assert.Contains(search.Errors, error => error.Reason == "instance not found");
        Assert.Contains(monitor.Errors, error => error.Reason == "instance not found");
        Assert.Equal(0, handler.MovieLookups);
        Assert.Equal(0, handler.Commands);
        Assert.Empty(handler.ApiKeys);
    }

    [Fact]
    public async Task Status_UsesCentralResolverCapAndMarksSnapshotIncomplete()
    {
        var handler = new ImmediateArrHandler();
        var fetch = NewFetch(handler);
        var actions = new ArrActionService(
            fetch,
            new ArrTargetResolver(fetch),
            NullLogger<ArrActionService>.Instance);

        var status = await actions.GetQueueStatusAsync(
            Movie(),
            RadarrConfig(Instances(ArrTargetResolver.MaxResolvedInstances + 1)),
            CancellationToken.None);

        Assert.False(status.IsComplete);
        Assert.Empty(status.Items);
        Assert.Equal(ArrTargetResolver.MaxResolvedInstances, handler.MovieLookups);
        Assert.Equal(ArrTargetResolver.MaxResolvedInstances, handler.QueueRequests);
        var error = Assert.Single(status.Errors);
        Assert.Contains(
            $"{ArrTargetResolver.MaxResolvedInstances} configured instances",
            error.Reason,
            StringComparison.Ordinal);
    }

    [Fact]
    public async Task ResolverGate_IsSharedAcrossCallersForCompleteEpisodeResolution()
    {
        var handler = new BlockingEpisodeHandler();
        var resolver = NewResolver(handler);
        var instances = Instances(ArrTargetResolver.MaxConcurrentInstanceResolutions * 2);

        var first = resolver.ResolveMatchesAsync(
            Episode(),
            instances.Take(ArrTargetResolver.MaxConcurrentInstanceResolutions).ToList(),
            "sonarr",
            CancellationToken.None);
        var second = resolver.ResolveMatchesAsync(
            Episode(),
            instances.Skip(ArrTargetResolver.MaxConcurrentInstanceResolutions).ToList(),
            "sonarr",
            CancellationToken.None);

        await handler.CapacityReached.WaitAsync(TimeSpan.FromSeconds(5));

        // Each blocked episode request has already completed its series lookup. If a permit were
        // released between those two requests, the other caller's series lookups would start too.
        Assert.Equal(ArrTargetResolver.MaxConcurrentInstanceResolutions, handler.SeriesLookups);
        Assert.Equal(ArrTargetResolver.MaxConcurrentInstanceResolutions, handler.EpisodeLookups);
        Assert.Equal(ArrTargetResolver.MaxConcurrentInstanceResolutions, handler.MaxActiveEpisodes);

        handler.Release();
        var results = await Task.WhenAll(first, second).WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Equal(instances.Count, results.Sum(result => result.Matches.Count));
        Assert.Equal(instances.Count, handler.SeriesLookups);
        Assert.Equal(instances.Count, handler.EpisodeLookups);
        Assert.All(results, result => Assert.Empty(result.Errors));
    }

    [Fact]
    public async Task ResolverGate_CancelledWaitDoesNotStartOrLeakPermit()
    {
        var handler = new BlockingMovieHandler();
        var resolver = NewResolver(handler);
        var active = resolver.ResolveMatchesAsync(
            Movie(),
            Instances(ArrTargetResolver.MaxConcurrentInstanceResolutions),
            "radarr",
            CancellationToken.None);

        await handler.CapacityReached.WaitAsync(TimeSpan.FromSeconds(5));

        using var cancelled = new CancellationTokenSource();
        var waiting = resolver.ResolveMatchesAsync(
            Movie(),
            Instances(1, "cancelled"),
            "radarr",
            cancelled.Token);
        cancelled.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => waiting);
        Assert.Equal(ArrTargetResolver.MaxConcurrentInstanceResolutions, handler.MovieLookups);

        handler.Release();
        await active.WaitAsync(TimeSpan.FromSeconds(5));

        var (matches, errors) = await resolver.ResolveMatchesAsync(
            Movie(),
            Instances(1, "after"),
            "radarr",
            CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Single(matches);
        Assert.Empty(errors);
        Assert.Equal(ArrTargetResolver.MaxConcurrentInstanceResolutions + 1, handler.MovieLookups);
    }

    [Fact]
    public async Task StatusCollectionGate_IsSharedAcrossCallersForEveryQueuePage()
    {
        var handler = new BlockingSecondQueuePageHandler();
        var fetch = NewFetch(handler);
        var actions = new ArrActionService(
            fetch,
            new ArrTargetResolver(fetch),
            NullLogger<ArrActionService>.Instance);
        var calls = Enumerable.Range(0, ArrActionService.MaxConcurrentStatusCollections * 2)
            .Select(index => actions.QueueForInstanceGatedAsync(
                Match(Instance($"queue-{index}", index)),
                "radarr",
                CancellationToken.None))
            .ToArray();

        var capacity = handler.CapacityReached;
        var signaled = await Task.WhenAny(capacity, Task.Delay(TimeSpan.FromSeconds(5)));
        Assert.True(
            ReferenceEquals(capacity, signaled),
            $"queue gate did not fill: page1={handler.FirstPageRequests}, page2={handler.SecondPageRequests}");

        // Four complete collectors own the permits while blocked on page two. No fifth collector
        // may even begin page one until one of those complete collections finishes.
        Assert.Equal(ArrActionService.MaxConcurrentStatusCollections, handler.FirstPageRequests);
        Assert.Equal(ArrActionService.MaxConcurrentStatusCollections, handler.SecondPageRequests);
        Assert.Equal(ArrActionService.MaxConcurrentStatusCollections, handler.MaxActiveSecondPages);

        handler.Release();
        var results = await Task.WhenAll(calls).WaitAsync(TimeSpan.FromSeconds(5));

        Assert.All(results, result =>
        {
            Assert.Null(result.Error);
            Assert.Equal(101, result.Items.Count);
        });
        Assert.Equal(calls.Length, handler.FirstPageRequests);
        Assert.Equal(calls.Length, handler.SecondPageRequests);
        Assert.Equal(ArrActionService.MaxConcurrentStatusCollections, handler.MaxActiveSecondPages);
    }

    [Fact]
    public async Task StatusCollectionGate_CancelledWaitDoesNotStartOrLeakPermit()
    {
        var handler = new BlockingQueueHandler();
        var fetch = NewFetch(handler);
        var actions = new ArrActionService(
            fetch,
            new ArrTargetResolver(fetch),
            NullLogger<ArrActionService>.Instance);
        var match = Match(Instance("active"));
        var active = Enumerable.Range(0, ArrActionService.MaxConcurrentStatusCollections)
            .Select(_ => actions.QueueForInstanceGatedAsync(match, "radarr", CancellationToken.None))
            .ToArray();

        await handler.CapacityReached.WaitAsync(TimeSpan.FromSeconds(5));

        using var cancelled = new CancellationTokenSource();
        var waiting = actions.QueueForInstanceGatedAsync(
            Match(Instance("cancelled")),
            "radarr",
            cancelled.Token);
        cancelled.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => waiting);
        Assert.Equal(ArrActionService.MaxConcurrentStatusCollections, handler.QueueRequests);

        handler.Release();
        await Task.WhenAll(active).WaitAsync(TimeSpan.FromSeconds(5));

        var after = await actions.QueueForInstanceGatedAsync(
            Match(Instance("after")),
            "radarr",
            CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Null(after.Error);
        Assert.Equal(
            ArrActionService.MaxConcurrentStatusCollections + 1,
            handler.QueueRequests);
    }

    private static ArrFetchService NewFetch(HttpMessageHandler handler)
        => new(new RecordingHttpClientFactory(handler), NullLogger<ArrFetchService>.Instance);

    private static ArrTargetResolver NewResolver(HttpMessageHandler handler)
        => new(NewFetch(handler));

    private static ArrResolvedItem Movie()
        => new() { Kind = ArrMediaKind.Movie, TmdbId = 27205, Name = "Movie" };

    private static ArrResolvedItem Episode()
        => new()
        {
            Kind = ArrMediaKind.Episode,
            SeriesTvdbId = 81189,
            SeasonNumber = 1,
            EpisodeNumber = 2,
            Name = "Episode",
        };

    private static ArrInstance Instance(string name, int index = 0)
        => new()
        {
            Name = name,
            Url = "http://localhost:7878",
            ApiKey = $"key-{index}-{name}",
            Enabled = true,
        };

    private static List<ArrInstance> Instances(int count, string prefix = "instance")
        => Enumerable.Range(0, count)
            .Select(index => Instance($"{prefix}-{index}", index))
            .ToList();

    private static PluginConfiguration RadarrConfig(IReadOnlyList<ArrInstance> instances)
        => new() { RadarrInstances = JsonSerializer.Serialize(instances) };

    private static ArrInstanceMatch Match(ArrInstance instance)
        => new()
        {
            Instance = instance,
            Service = "radarr",
            ArrId = 7,
            Monitored = true,
        };

    private static HttpResponseMessage Json(string body)
        => new(HttpStatusCode.OK)
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        };

    private static int QueryInt(Uri uri, string name)
    {
        foreach (var part in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var pair = part.Split('=', 2);
            if (pair.Length == 2 && string.Equals(pair[0], name, StringComparison.Ordinal))
                return int.Parse(pair[1], System.Globalization.CultureInfo.InvariantCulture);
        }

        return 0;
    }

    private static string ApiKey(HttpRequestMessage request)
        => request.Headers.TryGetValues("X-Api-Key", out var values)
            ? Assert.Single(values)
            : string.Empty;

    private sealed class ImmediateArrHandler : HttpMessageHandler
    {
        private int _movieLookups;
        private int _commands;
        private int _queueRequests;

        public int MovieLookups => Volatile.Read(ref _movieLookups);

        public int Commands => Volatile.Read(ref _commands);

        public int QueueRequests => Volatile.Read(ref _queueRequests);

        public ConcurrentBag<string> ApiKeys { get; } = new();

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            ApiKeys.Add(ApiKey(request));
            if (request.RequestUri!.AbsolutePath.EndsWith("/api/v3/movie", StringComparison.Ordinal))
            {
                Interlocked.Increment(ref _movieLookups);
                return Task.FromResult(Json("""[{"id":7,"monitored":true,"hasFile":false}]"""));
            }

            if (request.RequestUri.AbsolutePath.EndsWith("/api/v3/command", StringComparison.Ordinal))
            {
                Interlocked.Increment(ref _commands);
                return Task.FromResult(Json("""{"id":9}"""));
            }

            if (request.RequestUri.AbsolutePath.EndsWith("/api/v3/queue", StringComparison.Ordinal))
            {
                Interlocked.Increment(ref _queueRequests);
                var pageSize = QueryInt(request.RequestUri, "pageSize");
                return Task.FromResult(Json(
                    $$"""{"page":1,"pageSize":{{pageSize}},"totalRecords":0,"records":[]}"""));
            }

            return Task.FromResult(Json("{}"));
        }
    }

    private sealed class BlockingEpisodeHandler : HttpMessageHandler
    {
        private readonly TaskCompletionSource<bool> _capacityReached =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource<bool> _release =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _seriesLookups;
        private int _episodeLookups;
        private int _activeEpisodes;
        private int _maxActiveEpisodes;

        public Task CapacityReached => _capacityReached.Task;

        public int SeriesLookups => Volatile.Read(ref _seriesLookups);

        public int EpisodeLookups => Volatile.Read(ref _episodeLookups);

        public int MaxActiveEpisodes => Volatile.Read(ref _maxActiveEpisodes);

        public void Release() => _release.TrySetResult(true);

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path.EndsWith("/api/v3/series", StringComparison.Ordinal))
            {
                Interlocked.Increment(ref _seriesLookups);
                return Json("""[{"id":7,"monitored":true}]""");
            }

            if (!path.EndsWith("/api/v3/episode", StringComparison.Ordinal))
                return Json("{}");

            var count = Interlocked.Increment(ref _episodeLookups);
            var active = Interlocked.Increment(ref _activeEpisodes);
            ObserveMaximum(ref _maxActiveEpisodes, active);
            if (count == ArrTargetResolver.MaxConcurrentInstanceResolutions)
                _capacityReached.TrySetResult(true);

            try
            {
                await _release.Task.WaitAsync(cancellationToken);
                return Json("""[{"id":701,"seasonNumber":1,"episodeNumber":2,"monitored":true,"hasFile":false}]""");
            }
            finally
            {
                Interlocked.Decrement(ref _activeEpisodes);
            }
        }
    }

    private sealed class BlockingMovieHandler : HttpMessageHandler
    {
        private readonly TaskCompletionSource<bool> _capacityReached =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource<bool> _release =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _movieLookups;

        public Task CapacityReached => _capacityReached.Task;

        public int MovieLookups => Volatile.Read(ref _movieLookups);

        public void Release() => _release.TrySetResult(true);

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            if (!request.RequestUri!.AbsolutePath.EndsWith("/api/v3/movie", StringComparison.Ordinal))
                return Json("{}");

            var count = Interlocked.Increment(ref _movieLookups);
            if (count == ArrTargetResolver.MaxConcurrentInstanceResolutions)
                _capacityReached.TrySetResult(true);

            await _release.Task.WaitAsync(cancellationToken);
            return Json("""[{"id":7,"monitored":true,"hasFile":false}]""");
        }
    }

    private sealed class BlockingSecondQueuePageHandler : HttpMessageHandler
    {
        private readonly TaskCompletionSource<bool> _capacityReached =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource<bool> _release =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _firstPageRequests;
        private int _secondPageRequests;
        private int _activeSecondPages;
        private int _maxActiveSecondPages;

        public Task CapacityReached => _capacityReached.Task;

        public int FirstPageRequests => Volatile.Read(ref _firstPageRequests);

        public int SecondPageRequests => Volatile.Read(ref _secondPageRequests);

        public int MaxActiveSecondPages => Volatile.Read(ref _maxActiveSecondPages);

        public void Release() => _release.TrySetResult(true);

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path.EndsWith("/api/v3/movie", StringComparison.Ordinal))
                return Json("""[{"id":7,"monitored":true,"hasFile":false}]""");

            if (!path.EndsWith("/api/v3/queue", StringComparison.Ordinal))
                return Json("{}");

            var page = QueryInt(request.RequestUri, "page");
            var pageSize = QueryInt(request.RequestUri, "pageSize");
            if (page == 1)
            {
                Interlocked.Increment(ref _firstPageRequests);
                return Json(QueuePage(1, pageSize));
            }

            var count = Interlocked.Increment(ref _secondPageRequests);
            var active = Interlocked.Increment(ref _activeSecondPages);
            ObserveMaximum(ref _maxActiveSecondPages, active);
            if (count == ArrActionService.MaxConcurrentStatusCollections)
                _capacityReached.TrySetResult(true);

            try
            {
                await _release.Task.WaitAsync(cancellationToken);
                return Json(QueuePage(2, pageSize));
            }
            finally
            {
                Interlocked.Decrement(ref _activeSecondPages);
            }
        }
    }

    private sealed class BlockingQueueHandler : HttpMessageHandler
    {
        private readonly TaskCompletionSource<bool> _capacityReached =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource<bool> _release =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _queueRequests;

        public Task CapacityReached => _capacityReached.Task;

        public int QueueRequests => Volatile.Read(ref _queueRequests);

        public void Release() => _release.TrySetResult(true);

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            if (!request.RequestUri!.AbsolutePath.EndsWith("/api/v3/queue", StringComparison.Ordinal))
                return Json("{}");

            var count = Interlocked.Increment(ref _queueRequests);
            if (count == ArrActionService.MaxConcurrentStatusCollections)
                _capacityReached.TrySetResult(true);

            await _release.Task.WaitAsync(cancellationToken);
            var pageSize = QueryInt(request.RequestUri, "pageSize");
            return Json(
                $$"""{"page":1,"pageSize":{{pageSize}},"totalRecords":0,"records":[]}""");
        }
    }

    private static string QueuePage(int page, int pageSize)
    {
        var firstId = page == 1 ? 1 : pageSize + 1;
        var count = page == 1 ? pageSize : 1;
        var body = new StringBuilder()
            .Append("{\"page\":").Append(page)
            .Append(",\"pageSize\":").Append(pageSize)
            .Append(",\"totalRecords\":").Append(pageSize + 1)
            .Append(",\"records\":[");
        for (var offset = 0; offset < count; offset++)
        {
            if (offset > 0)
                body.Append(',');
            body.Append("{\"id\":").Append(firstId + offset)
                .Append(",\"status\":\"downloading\",\"trackedDownloadState\":\"downloading\"")
                .Append(",\"size\":100,\"sizeleft\":50}");
        }

        return body.Append("]}").ToString();
    }

    private static void ObserveMaximum(ref int maximum, int candidate)
    {
        var observed = Volatile.Read(ref maximum);
        while (candidate > observed)
        {
            var previous = Interlocked.CompareExchange(ref maximum, candidate, observed);
            if (previous == observed)
                return;
            observed = previous;
        }
    }
}
