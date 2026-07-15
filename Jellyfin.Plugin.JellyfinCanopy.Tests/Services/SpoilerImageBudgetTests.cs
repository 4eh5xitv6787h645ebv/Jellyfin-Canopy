using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using SkiaSharp;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services
{
    public sealed class SpoilerImageBudgetTests
    {
        [Fact]
        public async Task ChunkedInput_StopsAtCapPlusOne()
        {
            const int cap = 32;
            var stream = new CountingNonSeekableStream(new byte[cap + 1000]);
            var result = new FileStreamResult(stream, "image/jpeg");

            var extracted = await Jellyfin.Plugin.JellyfinCanopy.Services.SpoilerBlurImageFilter.ExtractBytesAsync(
                result,
                cap,
                CancellationToken.None);

            Assert.Equal(
                Jellyfin.Plugin.JellyfinCanopy.Services.SpoilerBlurImageFilter.ImageExtractionStatus.Rejected,
                extracted.Status);
            Assert.Null(extracted.Bytes);
            Assert.Equal(cap + 1, stream.BytesRead);
        }

        [Fact]
        public async Task Cancellation_StopsInputExtraction()
        {
            var stream = new CancellationObservingStream();
            var result = new FileStreamResult(stream, "image/jpeg");
            using var cancellation = new CancellationTokenSource();

            var extraction = Jellyfin.Plugin.JellyfinCanopy.Services.SpoilerBlurImageFilter.ExtractBytesAsync(
                result,
                1024,
                cancellation.Token);
            await stream.ReadStarted.WaitAsync(TimeSpan.FromSeconds(5));
            cancellation.Cancel();

            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => extraction);
            await stream.CancellationObserved.WaitAsync(TimeSpan.FromSeconds(5));
        }

        [Fact]
        public async Task StatusOnlyResult_RemainsUnderCallerNoContentPolicy()
        {
            var result = new NotFoundResult();

            var extracted = await Jellyfin.Plugin.JellyfinCanopy.Services.SpoilerBlurImageFilter.ExtractBytesAsync(
                result,
                1024,
                CancellationToken.None);

            Assert.Equal(
                Jellyfin.Plugin.JellyfinCanopy.Services.SpoilerBlurImageFilter.ImageExtractionStatus.Unrecognized,
                extracted.Status);
            Assert.True(Jellyfin.Plugin.JellyfinCanopy.Services.SpoilerBlurImageFilter.IsRecognizedNoContentResult(result));
            Assert.False(Jellyfin.Plugin.JellyfinCanopy.Services.SpoilerBlurImageFilter.IsRecognizedNoContentResult(
                new StatusCodeResult(304)));
            Assert.False(Jellyfin.Plugin.JellyfinCanopy.Services.SpoilerBlurImageFilter.CanEnterTransformFlight(
                new StatusCodeResult(304)));
            Assert.True(Jellyfin.Plugin.JellyfinCanopy.Services.SpoilerBlurImageFilter.CanEnterTransformFlight(
                new FileContentResult(new byte[] { 1 }, "image/jpeg")));
            var unknownFile = new UnknownFileResult();
            Assert.False(Jellyfin.Plugin.JellyfinCanopy.Services.SpoilerBlurImageFilter.CanEnterTransformFlight(unknownFile));
            Assert.False(Jellyfin.Plugin.JellyfinCanopy.Services.SpoilerBlurImageFilter.IsRecognizedNoContentResult(unknownFile));
        }

        [Fact]
        public void ReplacedEmptyFileStream_IsDisposed()
        {
            var stream = new MemoryStream();
            var result = new FileStreamResult(stream, "image/jpeg");

            Jellyfin.Plugin.JellyfinCanopy.Services.SpoilerBlurImageFilter.DisposeReplacedFileStream(result);

            Assert.Throws<ObjectDisposedException>(() => stream.ReadByte());
        }

        [Fact]
        public void HugeDimensionHeader_IsRejectedBeforeDecodeAllocation()
        {
            var service = new Jellyfin.Plugin.JellyfinCanopy.Services.ImageBlurService(
                NullLogger<Jellyfin.Plugin.JellyfinCanopy.Services.ImageBlurService>.Instance);
            var png = BuildHeaderBombPng(30_000, 30_000);

            var result = service.Blur(png, 40, "header-bomb");

            Assert.Null(result);
            Assert.Equal(0, service.DecodeAttemptCountForTest);
            Assert.True(service.RejectedSourceCountForTest > 0);
        }

        [Fact]
        public void StockCard_UsesMetadataWithoutPixelDecode()
        {
            var service = new Jellyfin.Plugin.JellyfinCanopy.Services.ImageBlurService(
                NullLogger<Jellyfin.Plugin.JellyfinCanopy.Services.ImageBlurService>.Instance);

            var result = service.StockCard(service.HardcodedFallbackJpeg, "metadata-only");

            Assert.NotNull(result);
            Assert.Equal(0, service.DecodeAttemptCountForTest);
        }

        [Fact]
        public async Task FourKConcurrentColdRequests_SampleDecodeOnce()
        {
            var service = new Jellyfin.Plugin.JellyfinCanopy.Services.ImageBlurService(
                NullLogger<Jellyfin.Plugin.JellyfinCanopy.Services.ImageBlurService>.Instance);
            var fourK = EncodeJpeg(3840, 2160);

            var requests = Enumerable.Range(0, 32)
                .Select(_ => service.RunBoundedTransformAsync(
                    "4k-same-key",
                    _ => Task.FromResult(BuildBlurResult(service, fourK, "4k-output")),
                    releaseUnusedInput: null,
                    CancellationToken.None))
                .ToArray();
            var results = await Task.WhenAll(requests);

            Assert.All(results, result => Assert.Equal(
                Jellyfin.Plugin.JellyfinCanopy.Services.SpoilerTransformStatus.Available,
                result.Status));
            Assert.Equal(1, service.TransformExecutionCountForTest);
            Assert.Equal(1, service.DecodeAttemptCountForTest);
            Assert.Equal(0, service.InFlightCountForTest);

            using var output = SKBitmap.Decode(results[0].Bytes);
            Assert.NotNull(output);
            Assert.True(Math.Max(output.Width, output.Height) <= 1920);
        }

        [Fact]
        public void FourKPng_UsesBoundedDecodeFallbackAndStillBlurs()
        {
            var service = new Jellyfin.Plugin.JellyfinCanopy.Services.ImageBlurService(
                NullLogger<Jellyfin.Plugin.JellyfinCanopy.Services.ImageBlurService>.Instance);
            var fourK = EncodeImage(3840, 2160, SKEncodedImageFormat.Png);

            var result = service.Blur(fourK, 40, "4k-png");

            Assert.NotNull(result);
            Assert.Equal(1, service.DecodeAttemptCountForTest);
            using var output = SKBitmap.Decode(result);
            Assert.NotNull(output);
            Assert.True(Math.Max(output.Width, output.Height) <= 1920);
        }

        [Fact]
        public async Task OneHundredColdRequests_ExtractDecodeAndTransformOnce()
        {
            var service = new Jellyfin.Plugin.JellyfinCanopy.Services.ImageBlurService(
                NullLogger<Jellyfin.Plugin.JellyfinCanopy.Services.ImageBlurService>.Instance);
            var releaseRead = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var readStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var streams = Enumerable.Range(0, 100)
                .Select(_ => new GateCountingStream(service.HardcodedFallbackJpeg, readStarted, releaseRead))
                .ToArray();
            var factoryCalls = 0;

            var requests = streams.Select(stream =>
            {
                var source = new FileStreamResult(stream, "image/jpeg");
                return service.RunBoundedTransformAsync(
                    "whole-pipeline",
                    async token =>
                    {
                        Interlocked.Increment(ref factoryCalls);
                        try
                        {
                            var extracted = await Jellyfin.Plugin.JellyfinCanopy.Services.SpoilerBlurImageFilter.ExtractBytesAsync(
                                source,
                                1024,
                                token);
                            Assert.Equal(
                                Jellyfin.Plugin.JellyfinCanopy.Services.SpoilerBlurImageFilter.ImageExtractionStatus.Available,
                                extracted.Status);
                            return BuildBlurResult(service, extracted.Bytes!, "whole-pipeline-output");
                        }
                        finally
                        {
                            await stream.DisposeAsync();
                        }
                    },
                    () => stream.DisposeAsync(),
                    CancellationToken.None);
            }).ToArray();

            await readStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
            releaseRead.TrySetResult();
            var results = await Task.WhenAll(requests);

            Assert.All(results, result => Assert.Equal(
                Jellyfin.Plugin.JellyfinCanopy.Services.SpoilerTransformStatus.Available,
                result.Status));
            Assert.Equal(1, factoryCalls);
            Assert.Equal(1, service.TransformExecutionCountForTest);
            Assert.Equal(1, service.DecodeAttemptCountForTest);
            Assert.Equal(service.HardcodedFallbackJpeg.Length, streams.Sum(stream => stream.BytesRead));
            Assert.All(streams, stream => Assert.Equal(1, stream.DisposeCount));
        }

        [Fact]
        public async Task LeaderCancellation_DoesNotPoisonLiveFollower()
        {
            var service = new Jellyfin.Plugin.JellyfinCanopy.Services.ImageBlurService(
                NullLogger<Jellyfin.Plugin.JellyfinCanopy.Services.ImageBlurService>.Instance);
            var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            using var leaderCancellation = new CancellationTokenSource();

            async Task<Jellyfin.Plugin.JellyfinCanopy.Services.SpoilerTransformResult> Factory(CancellationToken token)
            {
                started.TrySetResult();
                await release.Task.WaitAsync(token);
                return Jellyfin.Plugin.JellyfinCanopy.Services.SpoilerTransformResult.Available(new byte[] { 1, 2, 3 });
            }

            var leader = service.RunBoundedTransformAsync(
                "shared",
                Factory,
                releaseUnusedInput: null,
                leaderCancellation.Token);
            await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
            var follower = service.RunBoundedTransformAsync(
                "shared",
                Factory,
                releaseUnusedInput: null,
                CancellationToken.None);

            leaderCancellation.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => leader);
            Assert.Equal(1, service.TransformExecutionCountForTest);
            release.TrySetResult();

            var result = await follower.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(Jellyfin.Plugin.JellyfinCanopy.Services.SpoilerTransformStatus.Available, result.Status);
            Assert.Equal(new byte[] { 1, 2, 3 }, result.Bytes);
            Assert.Equal(1, service.TransformExecutionCountForTest);
            Assert.Equal(0, service.InFlightCountForTest);
        }

        [Fact]
        public async Task LastCallerCancellation_StopsSharedWork()
        {
            var service = new Jellyfin.Plugin.JellyfinCanopy.Services.ImageBlurService(
                NullLogger<Jellyfin.Plugin.JellyfinCanopy.Services.ImageBlurService>.Instance);
            var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var cancellationObserved = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            using var cancellation = new CancellationTokenSource();

            async Task<Jellyfin.Plugin.JellyfinCanopy.Services.SpoilerTransformResult> Factory(CancellationToken token)
            {
                started.TrySetResult();
                try
                {
                    await Task.Delay(Timeout.InfiniteTimeSpan, token);
                    return Jellyfin.Plugin.JellyfinCanopy.Services.SpoilerTransformResult.Rejected();
                }
                catch (OperationCanceledException)
                {
                    cancellationObserved.TrySetResult();
                    throw;
                }
            }

            var transform = service.RunBoundedTransformAsync(
                "cancel-last",
                Factory,
                releaseUnusedInput: null,
                cancellation.Token);
            await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
            cancellation.Cancel();

            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => transform);
            await cancellationObserved.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await WaitForAsync(() => service.InFlightCountForTest == 0);
            Assert.Equal(0, service.InFlightCountForTest);
        }

        [Fact]
        public async Task DifferentKeys_NeverExceedGlobalTransformBudget()
        {
            var service = new Jellyfin.Plugin.JellyfinCanopy.Services.ImageBlurService(
                NullLogger<Jellyfin.Plugin.JellyfinCanopy.Services.ImageBlurService>.Instance,
                maximumConcurrentTransforms: 2);
            var active = 0;
            var maximumActive = 0;

            async Task<Jellyfin.Plugin.JellyfinCanopy.Services.SpoilerTransformResult> Factory(CancellationToken token)
            {
                var nowActive = Interlocked.Increment(ref active);
                UpdateMaximum(ref maximumActive, nowActive);
                try
                {
                    await Task.Delay(40, token);
                    return Jellyfin.Plugin.JellyfinCanopy.Services.SpoilerTransformResult.Available(new byte[] { 1 });
                }
                finally
                {
                    Interlocked.Decrement(ref active);
                }
            }

            await Task.WhenAll(Enumerable.Range(0, 12).Select(i => service.RunBoundedTransformAsync(
                $"different-{i}",
                Factory,
                releaseUnusedInput: null,
                CancellationToken.None)));

            Assert.InRange(maximumActive, 1, 2);
            Assert.Equal(12, service.TransformExecutionCountForTest);
        }

        private static Jellyfin.Plugin.JellyfinCanopy.Services.SpoilerTransformResult BuildBlurResult(
            Jellyfin.Plugin.JellyfinCanopy.Services.ImageBlurService service,
            byte[] input,
            string cacheKey)
        {
            var blurred = service.Blur(input, 40, cacheKey);
            return blurred == null
                ? Jellyfin.Plugin.JellyfinCanopy.Services.SpoilerTransformResult.Rejected()
                : Jellyfin.Plugin.JellyfinCanopy.Services.SpoilerTransformResult.Available(blurred);
        }

        private static byte[] EncodeJpeg(int width, int height)
            => EncodeImage(width, height, SKEncodedImageFormat.Jpeg);

        private static byte[] EncodeImage(int width, int height, SKEncodedImageFormat format)
        {
            using var bitmap = new SKBitmap(width, height);
            bitmap.Erase(new SKColor(40, 80, 120));
            using var image = SKImage.FromBitmap(bitmap);
            using var encoded = image.Encode(format, 85);
            Assert.NotNull(encoded);
            return encoded.ToArray();
        }

        private static byte[] BuildHeaderBombPng(int width, int height)
        {
            using var bitmap = new SKBitmap(1, 1);
            bitmap.Erase(SKColors.Black);
            using var image = SKImage.FromBitmap(bitmap);
            using var encoded = image.Encode(SKEncodedImageFormat.Png, 100);
            Assert.NotNull(encoded);
            var bytes = encoded.ToArray();

            WriteBigEndian(bytes, 16, width);
            WriteBigEndian(bytes, 20, height);
            var crc = Crc32(bytes.AsSpan(12, 17));
            WriteBigEndian(bytes, 29, unchecked((int)crc));
            return bytes;
        }

        private static void WriteBigEndian(byte[] bytes, int offset, int value)
        {
            bytes[offset] = (byte)((uint)value >> 24);
            bytes[offset + 1] = (byte)((uint)value >> 16);
            bytes[offset + 2] = (byte)((uint)value >> 8);
            bytes[offset + 3] = (byte)value;
        }

        private static uint Crc32(ReadOnlySpan<byte> bytes)
        {
            var crc = 0xFFFFFFFFu;
            foreach (var value in bytes)
            {
                crc ^= value;
                for (var bit = 0; bit < 8; bit++)
                {
                    crc = (crc & 1) != 0 ? (crc >> 1) ^ 0xEDB88320u : crc >> 1;
                }
            }

            return ~crc;
        }

        private static void UpdateMaximum(ref int maximum, int candidate)
        {
            while (true)
            {
                var current = Volatile.Read(ref maximum);
                if (candidate <= current || Interlocked.CompareExchange(ref maximum, candidate, current) == current)
                {
                    return;
                }
            }
        }

        private static async Task WaitForAsync(Func<bool> predicate)
        {
            var deadline = DateTime.UtcNow.AddSeconds(5);
            while (!predicate() && DateTime.UtcNow < deadline)
            {
                await Task.Delay(10);
            }
        }

        private sealed class CountingNonSeekableStream : Stream
        {
            private readonly MemoryStream _inner;

            public CountingNonSeekableStream(byte[] bytes) => _inner = new MemoryStream(bytes, writable: false);

            public int BytesRead { get; private set; }
            public override bool CanRead => true;
            public override bool CanSeek => false;
            public override bool CanWrite => false;
            public override long Length => throw new NotSupportedException();
            public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
            public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
            public override void Flush() => throw new NotSupportedException();
            public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
            public override void SetLength(long value) => throw new NotSupportedException();
            public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

            public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
            {
                var read = await _inner.ReadAsync(buffer, cancellationToken);
                BytesRead += read;
                return read;
            }
        }

        private sealed class UnknownFileResult : FileResult
        {
            public UnknownFileResult()
                : base("image/jpeg")
            {
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

        private sealed class GateCountingStream : Stream
        {
            private readonly MemoryStream _inner;
            private readonly TaskCompletionSource _started;
            private readonly TaskCompletionSource _release;
            private int _firstRead = 1;
            private int _disposeCount;

            public GateCountingStream(
                byte[] bytes,
                TaskCompletionSource started,
                TaskCompletionSource release)
            {
                _inner = new MemoryStream(bytes, writable: false);
                _started = started;
                _release = release;
            }

            public int BytesRead { get; private set; }
            public int DisposeCount => Volatile.Read(ref _disposeCount);
            public override bool CanRead => true;
            public override bool CanSeek => false;
            public override bool CanWrite => false;
            public override long Length => throw new NotSupportedException();
            public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
            public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
            public override void Flush() => throw new NotSupportedException();
            public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
            public override void SetLength(long value) => throw new NotSupportedException();
            public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

            public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
            {
                if (Interlocked.Exchange(ref _firstRead, 0) == 1)
                {
                    _started.TrySetResult();
                    await _release.Task.WaitAsync(cancellationToken);
                }

                var read = await _inner.ReadAsync(buffer, cancellationToken);
                BytesRead += read;
                return read;
            }

            public override ValueTask DisposeAsync()
            {
                if (Interlocked.Increment(ref _disposeCount) == 1)
                {
                    _inner.Dispose();
                }

                GC.SuppressFinalize(this);
                return ValueTask.CompletedTask;
            }
        }
    }
}
