using System.Net;
using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Helpers;

/// <summary>
/// Covers the pure response-classification and message-sanitization logic in
/// <see cref="SeerrHttpHelper"/> / <see cref="SeerrError"/>. These paths decide
/// what error text reaches non-admin users, so URL leaking is the key concern.
/// </summary>
public class SeerrHttpHelperTests
{
    private static HttpResponseMessage JsonResponse(HttpStatusCode status, string body = "{}")
    {
        return new HttpResponseMessage(status)
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        };
    }

    [Fact]
    public async Task ReadResponseAsync_SuccessJson_ReturnsBodyWithoutError()
    {
        using var response = JsonResponse(HttpStatusCode.OK, """{"ok":true}""");

        var (json, error) = await SeerrHttpHelper.ReadResponseAsync(response, "http://seerr/api");

        Assert.Null(error);
        Assert.Equal("""{"ok":true}""", json);
    }

    [Theory]
    [InlineData(HttpStatusCode.Unauthorized, SeerrErrorCode.Unauthorized)]
    [InlineData(HttpStatusCode.Forbidden, SeerrErrorCode.Forbidden)]
    [InlineData(HttpStatusCode.InternalServerError, SeerrErrorCode.UpstreamError)]
    public async Task ReadResponseAsync_ErrorStatuses_MapToExpectedCodes(HttpStatusCode status, SeerrErrorCode expected)
    {
        using var response = JsonResponse(status);

        var (json, error) = await SeerrHttpHelper.ReadResponseAsync(response, "http://seerr/api");

        Assert.Null(json);
        Assert.NotNull(error);
        Assert.Equal(expected, error!.Code);
        Assert.Equal((int)status, error.HttpStatus);
    }

    [Fact]
    public async Task ReadResponseAsync_HtmlBody_IsClassifiedAsHtmlResponse()
    {
        // A reverse proxy intercepting the request returns 200 + HTML login page;
        // this must be rejected, not parsed as JSON.
        using var response = new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("<html>login</html>", Encoding.UTF8, "text/html"),
        };

        var (json, error) = await SeerrHttpHelper.ReadResponseAsync(response, "http://seerr/api");

        Assert.Null(json);
        Assert.Equal(SeerrErrorCode.HtmlResponse, error!.Code);
    }

    [Fact]
    public async Task ReadResponseAsync_RedirectWithLocation_IsUpstreamRedirect()
    {
        using var response = JsonResponse(HttpStatusCode.Found);
        response.Headers.Location = new Uri("http://proxy/login");

        var (_, error) = await SeerrHttpHelper.ReadResponseAsync(response, "http://seerr/api");

        Assert.Equal(SeerrErrorCode.UpstreamRedirect, error!.Code);
    }

    [Fact]
    public async Task ReadResponseAsync_CloudflareStatus_IsCloudflare5xxWithCfRay()
    {
        using var response = JsonResponse((HttpStatusCode)522);
        response.Headers.Add("cf-ray", "abc123-LHR");

        var (_, error) = await SeerrHttpHelper.ReadResponseAsync(response, "http://seerr/api");

        Assert.Equal(SeerrErrorCode.Cloudflare5xx, error!.Code);
        Assert.Equal("abc123-LHR", error.CfRay);
    }

    [Fact]
    public async Task ReadResponseAsync_DeclaredOversize_IsRejectedBeforeBodyRead()
    {
        const int cap = 8;
        var stream = new TrackingStream(Encoding.UTF8.GetBytes("{}"));
        using var response = StreamingJsonResponse(stream);
        response.Content.Headers.ContentLength = cap + 1;

        var (json, error) = await SeerrHttpHelper.ReadResponseAsync(response, "http://seerr/api", cap);

        Assert.Null(json);
        Assert.Equal(SeerrErrorCode.ResponseTooLarge, error!.Code);
        Assert.Equal(0, stream.ReadCalls);
    }

    [Fact]
    public async Task ReadResponseAsync_ChunkedCapPlusOne_StopsAtSentinel()
    {
        const int cap = 8;
        var stream = new TrackingStream(new byte[cap + 128]);
        using var response = StreamingJsonResponse(stream);

        var (json, error) = await SeerrHttpHelper.ReadResponseAsync(response, "http://seerr/api", cap);

        Assert.Null(json);
        Assert.Equal(SeerrErrorCode.ResponseTooLarge, error!.Code);
        Assert.Equal(cap + 1, stream.BytesRead);
        Assert.True(stream.WasDisposed);
    }

    [Fact]
    public async Task ReadResponseAsync_MultibyteUtf8_IsLimitedByRawBytes()
    {
        var utf8 = Encoding.UTF8.GetBytes("\"éé\"");
        Assert.Equal(6, utf8.Length);
        using var response = StreamingJsonResponse(new TrackingStream(utf8));

        var (json, error) = await SeerrHttpHelper.ReadResponseAsync(response, "http://seerr/api", 5);

        Assert.Null(json);
        Assert.Equal(SeerrErrorCode.ResponseTooLarge, error!.Code);
    }

    [Fact]
    public async Task ReadResponseAsync_ExactCapCompleteJson_Succeeds()
    {
        using var response = StreamingJsonResponse(new TrackingStream(Encoding.UTF8.GetBytes("{}")));

        var (json, error) = await SeerrHttpHelper.ReadResponseAsync(response, "http://seerr/api", 2);

        Assert.Null(error);
        Assert.Equal("{}", json);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("{")]
    [InlineData("{} trailing")]
    public async Task ReadResponseAsync_InvalidOrIncompleteJson_ReturnsParseError(string body)
    {
        var bytes = Encoding.UTF8.GetBytes(body);
        using var response = StreamingJsonResponse(new TrackingStream(bytes));

        var (json, error) = await SeerrHttpHelper.ReadResponseAsync(response, "http://seerr/api", bytes.Length);

        Assert.Null(json);
        Assert.Equal(SeerrErrorCode.ParseError, error!.Code);
    }

    [Fact]
    public async Task SendAndReadJsonAsync_BodyBlockingAfterCap_DoesNotEagerlyBuffer()
    {
        const int cap = 8;
        var stream = new TrackingStream(new byte[cap + 1], blockAtEnd: true);
        using var client = new HttpClient(new StaticResponseHandler(StreamingJsonResponse(stream)));
        using var request = new HttpRequestMessage(HttpMethod.Get, "http://seerr/api");

        var resultTask = SeerrHttpHelper.SendAndReadJsonAsync(
            client,
            request,
            request.RequestUri!.ToString(),
            cap,
            SeerrDispatchFenceTestFactory.Create());
        var completed = await Task.WhenAny(resultTask, Task.Delay(TimeSpan.FromSeconds(2)));

        Assert.Same(resultTask, completed);
        var (json, error, _) = await resultTask;
        Assert.Null(json);
        Assert.Equal(SeerrErrorCode.ResponseTooLarge, error!.Code);
        Assert.Equal(cap + 1, stream.BytesRead);
    }

    [Fact]
    public async Task SendAndReadJsonAsync_CancellationStopsBlockedBodyRead()
    {
        var stream = new TrackingStream([], blockAtEnd: true);
        using var client = new HttpClient(new StaticResponseHandler(StreamingJsonResponse(stream)));
        using var request = new HttpRequestMessage(HttpMethod.Get, "http://seerr/api");
        using var cts = new CancellationTokenSource();

        var resultTask = SeerrHttpHelper.SendAndReadJsonAsync(
            client,
            request,
            request.RequestUri!.ToString(),
            8,
            SeerrDispatchFenceTestFactory.Create(),
            cts.Token);
        await stream.ReadStarted.WaitAsync(TimeSpan.FromSeconds(2));
        cts.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => resultTask);

        Assert.True(stream.CancellationObserved);
    }

    [Fact]
    public async Task SendAndReadJsonAsync_CancellationStopsUpstreamSend()
    {
        var handler = new BlockingHandler();
        using var client = new HttpClient(handler);
        using var request = new HttpRequestMessage(HttpMethod.Get, "http://seerr/api");
        using var cts = new CancellationTokenSource();

        var resultTask = SeerrHttpHelper.SendAndReadJsonAsync(
            client,
            request,
            request.RequestUri!.ToString(),
            8,
            SeerrDispatchFenceTestFactory.Create(),
            cts.Token);
        await handler.SendStarted.WaitAsync(TimeSpan.FromSeconds(2));
        cts.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => resultTask);
        Assert.True(handler.CancellationObserved);
    }

    [Theory]
    [InlineData("application/json", true)]
    [InlineData("application/problem+json", true)]
    [InlineData("text/html", false)]
    [InlineData("text/plain", false)]
    public void IsJsonContentType_ClassifiesMediaTypes(string mediaType, bool expected)
    {
        using var response = new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("x", Encoding.UTF8, mediaType),
        };

        Assert.Equal(expected, SeerrHttpHelper.IsJsonContentType(response));
    }

    [Fact]
    public void TryDeserialize_InvalidJson_ReturnsParseErrorNotException()
    {
        var (result, error) = SeerrHttpHelper.TryDeserialize<Dictionary<string, string>>("{broken", "http://seerr/api");

        Assert.Null(result);
        Assert.Equal(SeerrErrorCode.ParseError, error!.Code);
    }

    [Fact]
    public void SeerrRequestCallers_DoNotBypassBoundedTransport()
    {
        var directSend = new Regex(@"\.SendAsync\s*\(", RegexOptions.Compiled);
        var offenders = Directory
            .EnumerateFiles(PluginSourceRoot(), "*.cs", SearchOption.AllDirectories)
            .Where(path => !path.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                && !path.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            .Where(path =>
            {
                var source = File.ReadAllText(path);
                return source.Contains("SeerrHttpHelper.BuildRequest", StringComparison.Ordinal)
                    && directSend.IsMatch(source);
            })
            .Select(Path.GetFileName)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();

        Assert.True(
            offenders.Length == 0,
            "Seerr request caller(s) bypass the ResponseHeadersRead + bounded JSON transport: "
            + string.Join(", ", offenders));
    }

    private static string PluginSourceRoot([CallerFilePath] string sourceFile = "")
        => Path.GetFullPath(Path.Combine(
            Path.GetDirectoryName(sourceFile)!, "..", "..", "Jellyfin.Plugin.JellyfinCanopy"));

    private static HttpResponseMessage StreamingJsonResponse(Stream stream)
    {
        var content = new StreamContent(stream);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        return new HttpResponseMessage(HttpStatusCode.OK) { Content = content };
    }

    private sealed class StaticResponseHandler(HttpResponseMessage response) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken) => Task.FromResult(response);
    }

    private sealed class BlockingHandler : HttpMessageHandler
    {
        private readonly TaskCompletionSource<bool> _sendStarted = new(
            TaskCreationOptions.RunContinuationsAsynchronously);

        public Task SendStarted => _sendStarted.Task;

        public bool CancellationObserved { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            _sendStarted.TrySetResult(true);
            try
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                throw new InvalidOperationException("The blocking handler unexpectedly resumed.");
            }
            catch (OperationCanceledException)
            {
                CancellationObserved = true;
                throw;
            }
        }
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

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}

/// <summary>Sanitization of admin-facing messages before they reach non-admin users.</summary>
public class SeerrErrorSanitizeTests
{
    [Theory]
    [InlineData("Seerr returned 502 from http://192.168.0.84:5056/api/v1/status.",
                "Seerr returned 502 from <seerr-url>.")]
    [InlineData("redirect to https://seerr.example.com/login detected",
                "redirect to <seerr-url> detected")]
    [InlineData("no urls here", "no urls here")]
    [InlineData("", "")]
    public void SanitizeMessage_ReplacesUrlsAndPreservesPunctuation(string input, string expected)
    {
        Assert.Equal(expected, SeerrError.SanitizeMessage(input));
    }

    [Fact]
    public void ToResponseShape_UsesUserMessageNeverTechnicalMessage()
    {
        var error = new SeerrError
        {
            Code = SeerrErrorCode.UpstreamError,
            HttpStatus = 502,
            Message = "Seerr returned 502 from http://internal-host:5055/api.",
            UserMessage = "Seerr returned an error. Please try again in a moment.",
        };

        var shape = error.ToResponseShape();
        var messageProp = shape.GetType().GetProperty("message")!.GetValue(shape) as string;

        Assert.DoesNotContain("internal-host", messageProp);
        Assert.Equal(error.UserMessage, messageProp);
    }
}
