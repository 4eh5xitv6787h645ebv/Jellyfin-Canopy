using System.Net;
using System.Net.Http.Headers;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services
{
    public sealed class AvatarFetchServiceTests
    {
        private static readonly byte[] ValidPng = { 137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3 };

        [Fact]
        public async Task ChunkedCapPlusOne_StopsAtBoundaryAndNeverCaches()
        {
            const int cap = 32;
            var bytes = new byte[cap + 1000];
            ValidPng.CopyTo(bytes, 0);
            var stream = new CountingReadStream(bytes);
            var handler = new DelegateHandler((_, _) => Task.FromResult(ImageResponse(stream, "image/png")));
            var (service, cache) = Create(handler, maximumAvatarBytes: cap);

            var result = await service.GetAsync("avatar", "http://seerr/avatar/a.png", () => true, CancellationToken.None);

            Assert.Equal(AvatarFetchStatus.Missing, result.Status);
            Assert.Equal(cap + 1, stream.BytesRead);
            Assert.Empty(cache.AvatarCache);
        }

        [Fact]
        public async Task OneHundredConcurrentColdMisses_InvokeUpstreamOnce()
        {
            var handler = new BlockingSuccessHandler();
            var (service, cache) = Create(handler);

            var calls = Enumerable.Range(0, 100)
                .Select(_ => service.GetAsync(
                    "same-avatar",
                    "http://seerr/avatar/a.png",
                    () => true,
                    CancellationToken.None))
                .ToArray();
            await handler.Started.WaitAsync(TimeSpan.FromSeconds(5));

            Assert.Equal(1, handler.Calls);
            Assert.Equal(1, service.InFlightCount);
            handler.Release();
            var results = await Task.WhenAll(calls);

            Assert.All(results, result => Assert.Equal(AvatarFetchStatus.Available, result.Status));
            Assert.Equal(1, handler.Calls);
            Assert.Single(cache.AvatarCache);
            await WaitForNoFlightsAsync(service);
        }

        [Fact]
        public async Task LeaderCancellation_DoesNotFailLiveFollowerOrRestartUpstream()
        {
            var handler = new BlockingSuccessHandler();
            var (service, cache) = Create(handler);
            using var leaderCancellation = new CancellationTokenSource();

            var leader = service.GetAsync(
                "shared-avatar",
                "http://seerr/avatar/a.png",
                () => true,
                leaderCancellation.Token);
            await handler.Started.WaitAsync(TimeSpan.FromSeconds(5));
            var follower = service.GetAsync(
                "shared-avatar",
                "http://seerr/avatar/a.png",
                () => true,
                CancellationToken.None);

            leaderCancellation.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => leader);
            Assert.Equal(1, handler.Calls);
            Assert.Equal(1, service.InFlightCount);

            handler.Release();
            var result = await follower.WaitAsync(TimeSpan.FromSeconds(5));

            Assert.Equal(AvatarFetchStatus.Available, result.Status);
            Assert.Equal(ValidPng, result.Content);
            Assert.Single(cache.AvatarCache);
            Assert.Equal(1, handler.Calls);
            await WaitForNoFlightsAsync(service);
        }

        [Fact]
        public async Task CallerCancellation_StopsUpstreamReadAndPublishesNothing()
        {
            var stream = new CancellationObservingStream();
            var handler = new DelegateHandler((_, _) => Task.FromResult(ImageResponse(stream, "image/png")));
            var (service, cache) = Create(handler);
            using var cancellation = new CancellationTokenSource();

            var fetch = service.GetAsync(
                "cancelled-avatar",
                "http://seerr/avatar/a.png",
                () => true,
                cancellation.Token);
            await stream.ReadStarted.WaitAsync(TimeSpan.FromSeconds(5));
            cancellation.Cancel();

            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fetch);
            await stream.CancellationObserved.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Empty(cache.AvatarCache);
            await WaitForNoFlightsAsync(service);
        }

        [Fact]
        public async Task InvalidSignature_NeverEntersCache()
        {
            var handler = new DelegateHandler((_, _) => Task.FromResult(ImageResponse(
                new MemoryStream("<html>not an image</html>"u8.ToArray()),
                "image/png")));
            var (service, cache) = Create(handler);

            var result = await service.GetAsync("invalid", "http://seerr/avatar/a.png", () => true, CancellationToken.None);

            Assert.Equal(AvatarFetchStatus.Missing, result.Status);
            Assert.Empty(cache.AvatarCache);
            Assert.Equal(1, service.FailureStateCount);
        }

        [Fact]
        public async Task FailureWindow_CoalescesDefinitiveMissesAndRetriesAfterFakeClockExpiry()
        {
            var clock = new ManualTimeProvider(new DateTimeOffset(2026, 7, 15, 0, 0, 0, TimeSpan.Zero));
            var handler = new CountingStatusHandler(HttpStatusCode.NotFound);
            var (service, _) = Create(handler, clock);

            var first = await Task.WhenAll(Enumerable.Range(0, 100)
                .Select(_ => service.GetAsync("missing", "http://seerr/avatar/missing.png", () => true, CancellationToken.None)));
            Assert.All(first, result => Assert.Equal(AvatarFetchStatus.Missing, result.Status));
            Assert.Equal(1, handler.Calls);

            clock.Advance(TimeSpan.FromSeconds(14));
            Assert.Equal(
                AvatarFetchStatus.Missing,
                (await service.GetAsync("missing", "http://seerr/avatar/missing.png", () => true, CancellationToken.None)).Status);
            Assert.Equal(1, handler.Calls);

            clock.Advance(TimeSpan.FromSeconds(1));
            await Task.WhenAll(Enumerable.Range(0, 100)
                .Select(_ => service.GetAsync("missing", "http://seerr/avatar/missing.png", () => true, CancellationToken.None)));
            Assert.Equal(2, handler.Calls);
        }

        [Fact]
        public async Task StaleLastGood_IsServedDuringFailureAndBackoff()
        {
            var clock = new ManualTimeProvider(new DateTimeOffset(2026, 7, 15, 0, 0, 0, TimeSpan.Zero));
            var handler = new SwitchableHandler();
            var (service, cache) = Create(handler, clock);

            var fresh = await service.GetAsync("last-good", "http://seerr/avatar/a.png", () => true, CancellationToken.None);
            Assert.Equal(AvatarFetchStatus.Available, fresh.Status);
            clock.Advance(TimeSpan.FromHours(2));
            handler.Status = HttpStatusCode.ServiceUnavailable;

            var duringFailure = await service.GetAsync("last-good", "http://seerr/avatar/a.png", () => true, CancellationToken.None);
            var duringBackoff = await service.GetAsync("last-good", "http://seerr/avatar/a.png", () => true, CancellationToken.None);

            Assert.Equal(AvatarFetchStatus.Available, duringFailure.Status);
            Assert.Equal(ValidPng, duringFailure.Content);
            Assert.Equal(AvatarFetchStatus.Available, duringBackoff.Status);
            Assert.Equal(2, handler.Calls);
            Assert.Single(cache.AvatarCache);
        }

        [Fact]
        public async Task MasterDisabledWithRetainedCredentials_DoesNotServeCachedAvatarOrCallUpstream()
        {
            var handler = new SwitchableHandler();
            var (_, cache, service, provider) = CreateWithService(handler);
            var fresh = await service.GetAsync(
                "retained-avatar",
                "http://seerr/avatar/a.png",
                () => true,
                CancellationToken.None);
            Assert.Equal(AvatarFetchStatus.Available, fresh.Status);
            Assert.Single(cache.AvatarCache);
            Assert.Equal(1, handler.Calls);

            provider.Current!.SeerrEnabled = false;
            var disabled = await service.GetAsync(
                "retained-avatar",
                "http://seerr/avatar/a.png",
                () => true,
                CancellationToken.None);

            Assert.Equal(AvatarFetchStatus.ConfigurationChanged, disabled.Status);
            Assert.Equal(1, handler.Calls);
        }

        [Fact]
        public async Task HighCardinality_StaysWithinEntryAndByteBudgets()
        {
            var handler = new DelegateHandler((_, _) => Task.FromResult(ImageResponse(
                new MemoryStream(ValidPng, writable: false),
                "image/png")));
            var (_, cache, service, _) = CreateWithService(handler);

            for (var i = 0; i < 200; i++)
            {
                var result = await service.GetAsync(
                    $"avatar-{i}",
                    $"http://seerr/avatar/{i}.png",
                    () => true,
                    CancellationToken.None);
                Assert.Equal(AvatarFetchStatus.Available, result.Status);
            }

            Assert.True(cache.AvatarCache.Count <= SeerrCache.AvatarMaximumEntries);
            Assert.True(cache.AvatarCache.TotalWeight <= SeerrCache.AvatarMaximumBytes);
        }

        private static (AvatarFetchService Service, SeerrCache Cache) Create(
            HttpMessageHandler handler,
            TimeProvider? timeProvider = null,
            long maximumAvatarBytes = AvatarFetchService.DefaultMaximumAvatarBytes)
        {
            var (_, cache, service, _) = CreateWithService(handler, timeProvider, maximumAvatarBytes);
            return (service, cache);
        }

        private static async Task WaitForNoFlightsAsync(AvatarFetchService service)
        {
            var deadline = DateTime.UtcNow.AddSeconds(5);
            while (service.InFlightCount != 0 && DateTime.UtcNow < deadline)
            {
                await Task.Delay(10);
            }

            Assert.Equal(0, service.InFlightCount);
        }

        private static (
            RecordingHttpClientFactory Factory,
            SeerrCache Cache,
            AvatarFetchService Service,
            FakePluginConfigProvider Provider) CreateWithService(
            HttpMessageHandler handler,
            TimeProvider? timeProvider = null,
            long maximumAvatarBytes = AvatarFetchService.DefaultMaximumAvatarBytes)
        {
            var provider = new FakePluginConfigProvider(new PluginConfiguration
            {
                SeerrEnabled = true,
                SeerrUrls = "http://seerr",
                SeerrApiKey = "key",
            });
            var cache = new SeerrCache(provider);
            var factory = new RecordingHttpClientFactory(handler);
            var service = new AvatarFetchService(
                factory,
                cache,
                provider,
                NullLogger<AvatarFetchService>.Instance,
                timeProvider ?? TimeProvider.System,
                maximumAvatarBytes);
            return (factory, cache, service, provider);
        }

        private static HttpResponseMessage ImageResponse(Stream stream, string contentType)
        {
            var content = new StreamContent(stream);
            content.Headers.ContentType = new MediaTypeHeaderValue(contentType);
            content.Headers.ContentLength = null;
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = content };
        }

        private sealed class DelegateHandler : HttpMessageHandler
        {
            private readonly Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> _send;

            public DelegateHandler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send)
                => _send = send;

            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
                => _send(request, cancellationToken);
        }

        private sealed class BlockingSuccessHandler : HttpMessageHandler
        {
            private readonly TaskCompletionSource _started = new(TaskCreationOptions.RunContinuationsAsynchronously);
            private readonly TaskCompletionSource _release = new(TaskCreationOptions.RunContinuationsAsynchronously);
            private int _calls;

            public Task Started => _started.Task;

            public int Calls => Volatile.Read(ref _calls);

            public void Release() => _release.TrySetResult();

            protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            {
                Interlocked.Increment(ref _calls);
                _started.TrySetResult();
                await _release.Task.WaitAsync(cancellationToken);
                return ImageResponse(new MemoryStream(ValidPng, writable: false), "image/png");
            }
        }

        private sealed class CountingStatusHandler : HttpMessageHandler
        {
            private readonly HttpStatusCode _status;
            private int _calls;

            public CountingStatusHandler(HttpStatusCode status) => _status = status;

            public int Calls => Volatile.Read(ref _calls);

            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            {
                Interlocked.Increment(ref _calls);
                return Task.FromResult(new HttpResponseMessage(_status));
            }
        }

        private sealed class SwitchableHandler : HttpMessageHandler
        {
            private int _calls;

            public HttpStatusCode Status { get; set; } = HttpStatusCode.OK;

            public int Calls => Volatile.Read(ref _calls);

            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            {
                Interlocked.Increment(ref _calls);
                if (Status != HttpStatusCode.OK)
                {
                    return Task.FromResult(new HttpResponseMessage(Status));
                }

                return Task.FromResult(ImageResponse(new MemoryStream(ValidPng, writable: false), "image/png"));
            }
        }

        private sealed class CountingReadStream : MemoryStream
        {
            public CountingReadStream(byte[] bytes)
                : base(bytes, writable: false)
            {
            }

            public int BytesRead { get; private set; }

            public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
            {
                var read = await base.ReadAsync(buffer, cancellationToken);
                BytesRead += read;
                return read;
            }
        }

        private sealed class CancellationObservingStream : Stream
        {
            private readonly TaskCompletionSource _readStarted = new(TaskCreationOptions.RunContinuationsAsynchronously);
            private readonly TaskCompletionSource _cancellationObserved = new(TaskCreationOptions.RunContinuationsAsynchronously);

            public Task ReadStarted => _readStarted.Task;

            public Task CancellationObserved => _cancellationObserved.Task;

            public override bool CanRead => true;
            public override bool CanSeek => false;
            public override bool CanWrite => false;
            public override long Length => throw new NotSupportedException();
            public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }

            public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();

            public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
            {
                _readStarted.TrySetResult();
                try
                {
                    await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                    return 0;
                }
                catch (OperationCanceledException)
                {
                    _cancellationObserved.TrySetResult();
                    throw;
                }
            }

            public override void Flush() => throw new NotSupportedException();
            public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
            public override void SetLength(long value) => throw new NotSupportedException();
            public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        }

        private sealed class ManualTimeProvider : TimeProvider
        {
            private DateTimeOffset _now;

            public ManualTimeProvider(DateTimeOffset now) => _now = now;

            public override DateTimeOffset GetUtcNow() => _now;

            public void Advance(TimeSpan amount) => _now = _now.Add(amount);
        }
    }
}
