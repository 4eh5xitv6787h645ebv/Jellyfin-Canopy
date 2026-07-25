using System.Net;
using System.Net.Http.Headers;
using System.Text;
using Jellyfin.Plugin.JellyfinCanopy.Model.Arr;
using Jellyfin.Plugin.JellyfinCanopy.Services.Arr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class ArrFetchResponseBoundsTests
{
    [Fact]
    public async Task ChunkedExactCap_MapsCompleteJsonAndDisposesResponse()
    {
        const int cap = 64;
        var stream = new TrackingStream(Encoding.UTF8.GetBytes(JsonWithExactLength(cap)));
        var mapperCalls = 0;

        var (result, error) = await SendAsync(
            StreamingJsonResponse(stream),
            cap,
            _ =>
            {
                mapperCalls++;
                return "mapped";
            });

        Assert.Equal("mapped", result);
        Assert.Null(error);
        Assert.Equal(1, mapperCalls);
        Assert.Equal(cap, stream.BytesRead);
        Assert.True(stream.WasDisposed);
    }

    [Fact]
    public async Task ChunkedCapPlusOne_StopsAtSentinelWithoutEagerBuffering()
    {
        const int cap = 64;
        var stream = new TrackingStream(
            Encoding.UTF8.GetBytes(JsonWithExactLength(cap + 1)),
            blockAtEnd: true);
        var mapperCalls = 0;

        var (result, error) = await SendAsync(
            StreamingJsonResponse(stream),
            cap,
            _ =>
            {
                mapperCalls++;
                return "mapped";
            });

        Assert.Equal("empty", result);
        Assert.Equal("response too large", error);
        Assert.Equal(0, mapperCalls);
        Assert.Equal(cap + 1, stream.BytesRead);
        Assert.True(stream.WasDisposed);
    }

    [Fact]
    public async Task DeclaredCapPlusOne_IsRejectedWithoutReadingBody()
    {
        const int cap = 64;
        var stream = new TrackingStream(Encoding.UTF8.GetBytes("{}"), blockAtEnd: true);
        var response = StreamingJsonResponse(stream);
        response.Content.Headers.ContentLength = cap + 1;

        var (result, error) = await SendAsync(response, cap, _ => "mapped");

        Assert.Equal("empty", result);
        Assert.Equal("response too large", error);
        Assert.Equal(0, stream.ReadCalls);
        Assert.True(stream.WasDisposed);
    }

    [Fact]
    public async Task RequestDeadline_CoversBlockedResponseBody()
    {
        var stream = new TrackingStream([], blockAtEnd: true);

        var (result, error) = await SendAsync(
            StreamingJsonResponse(stream),
            maxBodyBytes: 64,
            _ => "mapped",
            timeout: TimeSpan.FromMilliseconds(250));

        Assert.Equal("empty", result);
        Assert.Equal("timeout", error);
        Assert.True(stream.CancellationObserved);
        Assert.True(stream.WasDisposed);
    }

    [Fact]
    public async Task CallerCancellation_DuringBodyReadIsRethrown()
    {
        var stream = new TrackingStream([], blockAtEnd: true);
        using var cts = new CancellationTokenSource();

        var request = SendAsync(
            StreamingJsonResponse(stream),
            maxBodyBytes: 64,
            _ => "mapped",
            timeout: TimeSpan.FromSeconds(10),
            ct: cts.Token);
        await stream.ReadStarted.WaitAsync(TimeSpan.FromSeconds(2));
        cts.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => request);
        Assert.True(stream.CancellationObserved);
        Assert.True(stream.WasDisposed);
    }

    private static Task<(string Result, string? Error)> SendAsync(
        HttpResponseMessage response,
        int maxBodyBytes,
        Func<System.Text.Json.Nodes.JsonNode?, string> mapper,
        TimeSpan? timeout = null,
        CancellationToken ct = default)
    {
        var fetch = new ArrFetchService(
            new RecordingHttpClientFactory(new StaticResponseHandler(response)),
            NullLogger<ArrFetchService>.Instance);
        return fetch.SendAndMapAsync(
            new ArrInstance
            {
                Name = "bounded",
                Url = "http://localhost:8989",
                ApiKey = "secret",
            },
            HttpMethod.Get,
            "/api/v3/test",
            jsonBody: null,
            mapper,
            emptyResult: "empty",
            timeout ?? TimeSpan.FromSeconds(2),
            contextLabel: "bounded response test",
            ct,
            maxBodyBytes);
    }

    private static HttpResponseMessage StreamingJsonResponse(Stream stream)
    {
        var content = new StreamContent(stream);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        return new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = content,
        };
    }

    private static string JsonWithExactLength(int length)
    {
        const string prefix = "{\"value\":\"";
        const string suffix = "\"}";
        var padding = length - prefix.Length - suffix.Length;
        Assert.True(padding >= 0);
        return string.Concat(prefix, new string('x', padding), suffix);
    }

    private sealed class StaticResponseHandler(HttpResponseMessage response) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
            => Task.FromResult(response);
    }

    private sealed class TrackingStream(byte[] data, bool blockAtEnd = false) : Stream
    {
        private int _position;
        private readonly TaskCompletionSource<bool> _readStarted = new(
            TaskCreationOptions.RunContinuationsAsynchronously);

        public int ReadCalls { get; private set; }

        public int BytesRead { get; private set; }

        public bool CancellationObserved { get; private set; }

        public bool WasDisposed { get; private set; }

        public Task ReadStarted => _readStarted.Task;

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => throw new NotSupportedException();

        public override long Position
        {
            get => _position;
            set => throw new NotSupportedException();
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            ReadCalls++;
            _readStarted.TrySetResult(true);
            var available = data.Length - _position;
            if (available <= 0)
            {
                return 0;
            }

            var copied = Math.Min(available, count);
            data.AsSpan(_position, copied).CopyTo(buffer.AsSpan(offset, copied));
            _position += copied;
            BytesRead += copied;
            return copied;
        }

        public override async ValueTask<int> ReadAsync(
            Memory<byte> buffer,
            CancellationToken cancellationToken = default)
        {
            ReadCalls++;
            _readStarted.TrySetResult(true);
            var available = data.Length - _position;
            if (available > 0)
            {
                var copied = Math.Min(available, buffer.Length);
                data.AsMemory(_position, copied).CopyTo(buffer);
                _position += copied;
                BytesRead += copied;
                return copied;
            }

            if (!blockAtEnd)
            {
                return 0;
            }

            try
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                return 0;
            }
            catch (OperationCanceledException)
            {
                CancellationObserved = true;
                throw;
            }
        }

        public override void Flush()
        {
        }

        protected override void Dispose(bool disposing)
        {
            WasDisposed = true;
            base.Dispose(disposing);
        }

        public override long Seek(long offset, SeekOrigin origin)
            => throw new NotSupportedException();

        public override void SetLength(long value)
            => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count)
            => throw new NotSupportedException();
    }
}
