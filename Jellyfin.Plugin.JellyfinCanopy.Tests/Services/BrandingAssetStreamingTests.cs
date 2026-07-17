using System.Diagnostics;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using Xunit.Abstractions;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class BrandingAssetStreamingCollection
{
    public const string Name = "Branding asset streaming";
}

/// <summary>
/// Pins the public-branding response lifecycle. A custom asset is a stable file
/// generation owned by one response: it is streamed through a fixed buffer,
/// cancellation stops the copy, and an owned response never falls through to
/// Jellyfin's static-file middleware after a partial write.
/// </summary>
[Collection(BrandingAssetStreamingCollection.Name)]
public sealed class BrandingAssetStreamingTests : IDisposable
{
    private const int MaximumUploadBytes = 10 * 1024 * 1024;
    private static readonly IServiceProvider Services = new ServiceCollection().BuildServiceProvider();
    private readonly string _directory;
    private readonly ITestOutputHelper _output;

    public BrandingAssetStreamingTests(ITestOutputHelper output)
    {
        _output = output;
        _directory = Path.Combine(Path.GetTempPath(), "jc-branding-stream-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_directory);
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(_directory, recursive: true);
        }
        catch
        {
            // Best effort: a failed assertion must not hide the original failure.
        }
    }

    [Fact]
    public async Task MaximumSizeGets_DoNotAllocateOnePayloadArrayPerRequest()
    {
        var path = AssetPath();
        using (var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        {
            file.SetLength(MaximumUploadBytes);
        }

        var filter = CreateFilter();
        var pipeline = BuildPipeline(filter, _ => Task.CompletedTask);

        // Warm JIT, middleware construction, FileStream internals and the shared copy buffer pool.
        await pipeline(CreateContext(Stream.Null));

        const int requests = 4;
        var allocatedBefore = GC.GetTotalAllocatedBytes(precise: true);
        var timer = Stopwatch.StartNew();
        for (var index = 0; index < requests; index++)
        {
            await pipeline(CreateContext(Stream.Null));
        }

        timer.Stop();
        var allocated = GC.GetTotalAllocatedBytes(precise: true) - allocatedBefore;
        _output.WriteLine(
            "requests={0} payloadBytes={1} allocatedBytes={2} elapsedMs={3:F3}",
            requests,
            MaximumUploadBytes,
            allocated,
            timer.Elapsed.TotalMilliseconds);

        // The old ReadAllBytesAsync path allocates at least 40 MiB here. Leave a
        // generous 2 MiB/request envelope for async/runtime noise while forbidding
        // a payload-sized allocation from returning.
        Assert.True(
            allocated < requests * 2L * 1024 * 1024,
            $"Four {MaximumUploadBytes}-byte responses allocated {allocated} bytes.");
    }

    [Fact]
    public async Task ConcurrentMaximumSizeGets_UseFixedPerResponseBuffersAndReleaseHandles()
    {
        var path = AssetPath();
        using (var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        {
            file.SetLength(MaximumUploadBytes);
        }

        var pipeline = BuildPipeline(CreateFilter(), _ => Task.CompletedTask);
        await pipeline(CreateContext(Stream.Null));
        const int requests = 16;
        var allocatedBefore = GC.GetTotalAllocatedBytes(precise: true);
        await Task.WhenAll(Enumerable.Range(0, requests).Select(_ => pipeline(CreateContext(Stream.Null))));
        var allocated = GC.GetTotalAllocatedBytes(precise: true) - allocatedBefore;

        _output.WriteLine(
            "concurrentRequests={0} payloadBytes={1} allocatedBytes={2}",
            requests,
            MaximumUploadBytes,
            allocated);
        Assert.True(
            allocated < requests * 2L * 1024 * 1024,
            $"{requests} concurrent responses allocated {allocated} bytes.");

        // Every response must dispose its generation handle. An exclusive reopen
        // catches a retained handle on platforms that enforce FileShare in-process.
        using var exclusive = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
        Assert.Equal(MaximumUploadBytes, exclusive.Length);
    }

    [Fact]
    public async Task Get_StreamsExactBodyAndValidatorsWithoutDownstreamFallback()
    {
        var payload = "canopy-branding"u8.ToArray();
        await File.WriteAllBytesAsync(AssetPath(), payload);
        File.SetLastWriteTimeUtc(AssetPath(), new DateTime(2026, 7, 17, 1, 2, 3, DateTimeKind.Utc));
        var downstreamCalls = 0;
        var filter = CreateFilter();
        var pipeline = BuildPipeline(filter, _ =>
        {
            Interlocked.Increment(ref downstreamCalls);
            return Task.CompletedTask;
        });
        using var body = new MemoryStream();
        var context = CreateContext(body);

        await pipeline(context);

        Assert.Equal(0, downstreamCalls);
        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Equal("image/png", context.Response.ContentType);
        Assert.Equal(payload.Length, context.Response.ContentLength);
        Assert.Equal("no-cache", context.Response.Headers.CacheControl.ToString());
        Assert.False(string.IsNullOrWhiteSpace(context.Response.Headers.ETag));
        Assert.False(string.IsNullOrWhiteSpace(context.Response.Headers.LastModified));
        Assert.Equal(payload, body.ToArray());
    }

    [Fact]
    public async Task HeadAndMatchingConditionalGet_ReadNoBody()
    {
        await File.WriteAllBytesAsync(AssetPath(), "validator-body"u8.ToArray());
        var filter = CreateFilter();
        var pipeline = BuildPipeline(filter, _ => throw new Xunit.Sdk.XunitException("Unexpected downstream fallback"));

        var head = CreateContext(new ThrowOnWriteStream(), HttpMethods.Head);
        await pipeline(head);
        Assert.Equal(StatusCodes.Status200OK, head.Response.StatusCode);
        Assert.True(head.Response.ContentLength > 0);
        Assert.False(string.IsNullOrWhiteSpace(head.Response.Headers.ETag));

        var conditional = CreateContext(new ThrowOnWriteStream());
        conditional.Request.Headers.IfNoneMatch = head.Response.Headers.ETag;
        await pipeline(conditional);
        Assert.Equal(StatusCodes.Status304NotModified, conditional.Response.StatusCode);
        Assert.Null(conditional.Response.ContentLength);
    }

    [Fact]
    public async Task RequestCancellation_StopsBlockedCopyPromptlyAndDoesNotFallThrough()
    {
        using (var file = new FileStream(AssetPath(), FileMode.CreateNew, FileAccess.Write, FileShare.None))
        {
            file.SetLength(MaximumUploadBytes);
        }

        var downstreamCalls = 0;
        var sink = new BlockingWriteStream();
        using var aborted = new CancellationTokenSource();
        var context = CreateContext(sink);
        context.RequestAborted = aborted.Token;
        var pipeline = BuildPipeline(CreateFilter(), _ =>
        {
            Interlocked.Increment(ref downstreamCalls);
            return Task.CompletedTask;
        });

        var response = pipeline(context);
        await sink.WriteStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        aborted.Cancel();
        var completedPromptly = await Task.WhenAny(response, Task.Delay(TimeSpan.FromSeconds(1))) == response;
        sink.Release.TrySetResult();
        await response;

        Assert.True(completedPromptly, "RequestAborted did not stop the blocked response copy within one second.");
        Assert.True(sink.ObservedCancellationToken.CanBeCanceled);
        Assert.Equal(0, downstreamCalls);
    }

    [Fact]
    public async Task AtomicReplacementDuringCopy_ServesOneCoherentOpenGeneration()
    {
        var original = Enumerable.Repeat((byte)'A', 256 * 1024).ToArray();
        var replacement = Enumerable.Repeat((byte)'B', original.Length + 17).ToArray();
        await File.WriteAllBytesAsync(AssetPath(), original);
        File.SetLastWriteTimeUtc(AssetPath(), new DateTime(2026, 7, 17, 2, 0, 0, DateTimeKind.Utc));

        var sink = new PausingCaptureStream();
        var pipeline = BuildPipeline(CreateFilter(), _ => throw new Xunit.Sdk.XunitException("Unexpected downstream fallback"));
        var head = CreateContext(Stream.Null, HttpMethods.Head);
        await pipeline(head);
        var originalEtag = head.Response.Headers.ETag.ToString();
        var context = CreateContext(sink);
        var response = pipeline(context);
        await sink.FirstWrite.Task.WaitAsync(TimeSpan.FromSeconds(5));

        await AtomicFile.WriteViaAsync(AssetPath(), stream => stream.WriteAsync(replacement).AsTask());
        sink.Resume.TrySetResult();
        await response;

        Assert.Equal(original.Length, context.Response.ContentLength);
        Assert.Equal(originalEtag, context.Response.Headers.ETag.ToString());
        Assert.Equal(original, sink.ToArray());
        Assert.Equal(replacement, await File.ReadAllBytesAsync(AssetPath()));

        var replacementHead = CreateContext(Stream.Null, HttpMethods.Head);
        await pipeline(replacementHead);
        Assert.Equal(replacement.Length, replacementHead.Response.ContentLength);
        Assert.NotEqual(originalEtag, replacementHead.Response.Headers.ETag.ToString());
    }

    [Fact]
    public async Task OwnedResponseWriteFailure_NeverInvokesStockMiddleware()
    {
        await File.WriteAllBytesAsync(AssetPath(), "partial-response"u8.ToArray());
        var downstreamCalls = 0;
        var context = CreateContext(new ThrowOnWriteStream());
        var pipeline = BuildPipeline(CreateFilter(), _ =>
        {
            Interlocked.Increment(ref downstreamCalls);
            return Task.CompletedTask;
        });

        await pipeline(context);

        Assert.Equal(0, downstreamCalls);
        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
    }

    [Fact]
    public void OpenGeneration_AllowsAtomicReplacementWhileReaderIsAlive()
    {
        Assert.Equal(
            FileShare.Read | FileShare.Delete,
            BrandingAssetStartupFilter.BrandingFileShare);
    }

    [Theory]
    [InlineData("GET", "/api/icon-transparent.hash.png", false, true)]
    [InlineData("POST", "/web/icon-transparent.hash.png", false, true)]
    [InlineData("GET", "/web/icon-transparent.hash.png", true, true)]
    [InlineData("GET", "/proxy/base/web/icon-transparent.hash.png", false, false)]
    public async Task PathMethodAndDisabledContracts_FallThroughOnlyWhenExpected(
        string method,
        string path,
        bool disabled,
        bool expectedFallthrough)
    {
        await File.WriteAllBytesAsync(AssetPath(), "path-contract"u8.ToArray());
        var downstreamCalls = 0;
        var pipeline = BuildPipeline(CreateFilter(disabled), context =>
        {
            Interlocked.Increment(ref downstreamCalls);
            context.Response.StatusCode = StatusCodes.Status418ImATeapot;
            return Task.CompletedTask;
        });
        using var body = new MemoryStream();
        var context = CreateContext(body, method, path);

        await pipeline(context);

        Assert.Equal(expectedFallthrough ? 1 : 0, downstreamCalls);
        Assert.Equal(
            expectedFallthrough ? StatusCodes.Status418ImATeapot : StatusCodes.Status200OK,
            context.Response.StatusCode);
    }

    [Fact]
    public async Task MissingCustomFile_FallsThroughExactlyOnce()
    {
        var downstreamCalls = 0;
        var pipeline = BuildPipeline(CreateFilter(), context =>
        {
            Interlocked.Increment(ref downstreamCalls);
            context.Response.StatusCode = StatusCodes.Status204NoContent;
            return Task.CompletedTask;
        });
        var context = CreateContext(Stream.Null);

        await pipeline(context);

        Assert.Equal(1, downstreamCalls);
        Assert.Equal(StatusCodes.Status204NoContent, context.Response.StatusCode);
    }

    private string AssetPath() => Path.Combine(_directory, "icon-transparent.png");

    private BrandingAssetStartupFilter CreateFilter(bool disabled = false)
        => new(
            NullLogger<BrandingAssetStartupFilter>.Instance,
            new FakePluginConfigProvider(new PluginConfiguration { DisableBrandingMiddleware = disabled }),
            () => _directory);

    private static RequestDelegate BuildPipeline(
        BrandingAssetStartupFilter filter,
        RequestDelegate downstream)
    {
        var builder = new ApplicationBuilder(Services);
        filter.Configure(app => app.Run(downstream))(builder);
        return builder.Build();
    }

    private static DefaultHttpContext CreateContext(
        Stream responseBody,
        string method = "GET",
        string path = "/web/icon-transparent.hash.png")
    {
        var context = new DefaultHttpContext();
        context.Request.Method = method;
        context.Request.Path = path;
        context.Response.Body = responseBody;
        return context;
    }

    private sealed class ThrowOnWriteStream : Stream
    {
        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => 0;
        public override long Position { get => 0; set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new IOException("simulated client write failure");
        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
            => Task.FromException(new IOException("simulated client write failure"));
        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
            => ValueTask.FromException(new IOException("simulated client write failure"));
    }

    private sealed class BlockingWriteStream : Stream
    {
        public TaskCompletionSource WriteStarted { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public CancellationToken ObservedCancellationToken { get; private set; }
        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => 0;
        public override long Position { get => 0; set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
            => WriteCoreAsync(cancellationToken);

        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
            => new(WriteCoreAsync(cancellationToken));

        private async Task WriteCoreAsync(CancellationToken cancellationToken)
        {
            ObservedCancellationToken = cancellationToken;
            WriteStarted.TrySetResult();
            await Release.Task.WaitAsync(cancellationToken);
        }
    }

    private sealed class PausingCaptureStream : Stream
    {
        private readonly MemoryStream _captured = new();
        private int _pauseClaimed;
        public TaskCompletionSource FirstWrite { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Resume { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => _captured.Length;
        public override long Position { get => _captured.Position; set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
            => WriteCoreAsync(buffer.AsMemory(offset, count), cancellationToken);

        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
            => new(WriteCoreAsync(buffer, cancellationToken));

        public byte[] ToArray() => _captured.ToArray();

        protected override void Dispose(bool disposing)
        {
            if (disposing) _captured.Dispose();
            base.Dispose(disposing);
        }

        private async Task WriteCoreAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken)
        {
            await _captured.WriteAsync(buffer, cancellationToken);
            if (Interlocked.Exchange(ref _pauseClaimed, 1) == 0)
            {
                FirstWrite.TrySetResult();
                await Resume.Task.WaitAsync(cancellationToken);
            }
        }
    }
}
