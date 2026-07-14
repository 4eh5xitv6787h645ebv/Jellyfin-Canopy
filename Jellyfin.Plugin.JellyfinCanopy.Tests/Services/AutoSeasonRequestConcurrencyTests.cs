using System.Net;
using System.Text;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class AutoSeasonRequestConcurrencyTests
{
    [Fact]
    public async Task SeriesDetails_ConcurrentCacheMissesShareOneUpstreamFetch()
    {
        var handler = new BlockingSeriesDetailsHandler();
        var provider = new FakePluginConfigProvider(new PluginConfiguration
        {
            SeerrEnabled = true,
            SeerrUrls = "http://seerr",
            SeerrApiKey = "key",
            SeerrDisableCache = false,
        });
        var service = new AutoSeasonRequestService(
            new RecordingHttpClientFactory(handler),
            NullLogger<AutoSeasonRequestService>.Instance,
            null!,
            null!,
            null!,
            provider,
            null!,
            null!);
        var start = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        var callers = Enumerable.Range(0, 32)
            .Select(_ => Task.Run(async () =>
            {
                await start.Task;
                return await service.GetSeriesDetailsJsonAsync("123", "http://seerr");
            }))
            .ToArray();

        start.SetResult();
        await handler.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await Task.Delay(50);
        Assert.Equal(1, handler.RequestCount);

        handler.Release();
        var results = await Task.WhenAll(callers);
        Assert.All(results, result => Assert.Contains("numberOfSeasons", result));
        Assert.Equal(1, handler.RequestCount);
    }

    [Fact]
    public async Task SeriesDetails_InPlaceCredentialChangePartitionsFlightAndRejectsOldResult()
    {
        var handler = new ConfigurationGenerationHandler();
        var configuration = new PluginConfiguration
        {
            SeerrEnabled = true,
            SeerrUrls = "http://seerr",
            SeerrApiKey = "old-key",
            SeerrDisableCache = false,
        };
        var provider = new FakePluginConfigProvider(configuration);
        var service = new AutoSeasonRequestService(
            new RecordingHttpClientFactory(handler),
            NullLogger<AutoSeasonRequestService>.Instance,
            null!,
            null!,
            null!,
            provider,
            null!,
            null!);

        var oldGeneration = service.GetSeriesDetailsJsonAsync("123", "http://seerr");
        await handler.OldStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));

        // Mutate the same configuration object. Its provider revision does not
        // change, so this specifically exercises the full-config partition key
        // and the captured credential rather than revision-only fencing.
        configuration.SeerrApiKey = "new-key";
        var newGeneration = service.GetSeriesDetailsJsonAsync("123", "http://seerr");
        await handler.NewStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Equal(2, handler.RequestCount);

        handler.ReleaseOld();
        Assert.Null(await oldGeneration);

        handler.ReleaseNew();
        var newContent = await newGeneration;
        Assert.Contains("\"generation\":\"new\"", newContent);

        var cachedContent = await service.GetSeriesDetailsJsonAsync("123", "http://seerr");
        Assert.Equal(newContent, cachedContent);
        Assert.Equal(2, handler.RequestCount);
    }

    private sealed class BlockingSeriesDetailsHandler : HttpMessageHandler
    {
        private readonly TaskCompletionSource _release =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _requestCount;

        public TaskCompletionSource Started { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public int RequestCount => Volatile.Read(ref _requestCount);

        public void Release() => _release.TrySetResult();

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _requestCount);
            Started.TrySetResult();
            await _release.Task.WaitAsync(cancellationToken);
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    "{\"numberOfSeasons\":2,\"seasons\":[]}",
                    Encoding.UTF8,
                    "application/json"),
            };
        }
    }

    private sealed class ConfigurationGenerationHandler : HttpMessageHandler
    {
        private readonly TaskCompletionSource _releaseOld =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _releaseNew =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _requestCount;

        public TaskCompletionSource OldStarted { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource NewStarted { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public int RequestCount => Volatile.Read(ref _requestCount);

        public void ReleaseOld() => _releaseOld.TrySetResult();

        public void ReleaseNew() => _releaseNew.TrySetResult();

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _requestCount);
            var apiKey = Assert.Single(request.Headers.GetValues("X-Api-Key"));
            var (started, release, generation) = apiKey switch
            {
                "old-key" => (OldStarted, _releaseOld, "old"),
                "new-key" => (NewStarted, _releaseNew, "new"),
                _ => throw new InvalidOperationException($"Unexpected API key: {apiKey}"),
            };

            started.TrySetResult();
            await release.Task.WaitAsync(cancellationToken);
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    $"{{\"generation\":\"{generation}\",\"numberOfSeasons\":2,\"seasons\":[]}}",
                    Encoding.UTF8,
                    "application/json"),
            };
        }
    }
}
