using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using SkiaSharp;

namespace Jellyfin.Plugin.JellyfinCanopy.Services
{
    internal enum SpoilerTransformStatus
    {
        Available,
        NoContent,
        Unrecognized,
        Rejected,
    }

    internal sealed record SpoilerTransformResult(
        SpoilerTransformStatus Status,
        byte[]? Bytes = null)
    {
        public static SpoilerTransformResult Available(byte[] bytes) => new(SpoilerTransformStatus.Available, bytes);

        public static SpoilerTransformResult NoContent() => new(SpoilerTransformStatus.NoContent);

        public static SpoilerTransformResult Unrecognized() => new(SpoilerTransformStatus.Unrecognized);

        public static SpoilerTransformResult Rejected() => new(SpoilerTransformStatus.Rejected);
    }

    // Produces a "spoiler-style" blurred version of an input image, using
    // SkiaSharp's CreateBlur ImageFilter (a separable Gaussian implemented
    // in native code, with proper edge handling).
    //
    // Why SkiaSharp:
    //   - Jellyfin loads SkiaSharp.dll as its own thumbnail engine, so we
    //     reference it without shipping a copy.
    //   - Native, ~130 ms on 1280x720; pure-managed alternatives were 2 s+.
    //   - No banding artefacts at any sigma (ImageSharp's GaussianBlur
    //     produced visible vertical-stripe artefacts at sigma >= 25 on
    //     cartoon-style sources).
    //
    // Cache results by (originalEtag, sigma) keyed by the caller. The cache
    // is bounded by entry count and total bytes; overflow evicts oldest.
    public sealed class ImageBlurService
    {
        private const int MaxCacheEntries = 256;
        private const long MaxCacheBytes = 64L * 1024 * 1024; // 64 MiB

        // Every protected source is bounded before it reaches Skia. The encoded
        // ceiling accommodates high-quality 4K artwork while preventing one image
        // request from materializing an arbitrarily large managed buffer.
        internal const long MaximumEncodedImageBytes = 32L * 1024 * 1024;

        // Metadata budgets are checked before allocating a bitmap. The source
        // pixel budget admits ordinary 8K artwork, but rejects header bombs and
        // impossible row strides. The actual decoded bitmap is sampled to the
        // much smaller MaxDecodeEdgePx / MaxDecodedBytes budget below.
        internal const int MaximumSourceDimension = 16 * 1024;
        internal const long MaximumSourcePixels = 128L * 1024 * 1024;
        internal const long MaximumDecodedBytes = 16L * 1024 * 1024;
        private const long MaximumFallbackDecodePixels = 16L * 1024 * 1024;
        private const long MaximumFallbackDecodeBytes = 64L * 1024 * 1024;
        private const int MaximumConcurrentTransforms = 2;

        // Decoded source pixel ceiling (long edge). Episode thumbnails are at
        // most ~1280x720; constraining bounds runtime in case Jellyfin serves
        // a 4K backdrop here.
        private const int MaxDecodeEdgePx = 1920;

        // Sigma range exposed to admins. 1 = barely blurred, 100 = solid
        // blob. Default 40 hides scene content while keeping silhouettes
        // and dominant colours visible for cartoon-style children's shows.
        private const float MinSigma = 1f;
        private const float MaxSigma = 100f;

        private readonly ILogger<ImageBlurService> _logger;
        private readonly ConcurrentDictionary<string, CacheEntry> _cache = new();
        private readonly ConcurrentDictionary<string, TransformFlight> _transformFlights = new(StringComparer.Ordinal);
        private readonly SemaphoreSlim _transformSlots;
        private long _cacheBytes;
        private int _transformExecutionCount;
        private int _decodeAttemptCount;
        private int _rejectedSourceCount;
        private readonly object _evictionLock = new();

        // Hardcoded last-resort fallback served when both the parent-art path
        // AND the SkiaSharp StockCard render fail. A flat-fill 16x16 #101010
        // JPEG, pre-encoded so it has no runtime decode/encode dependency —
        // if Skia is broken in-process, the Spoiler Guard threat model still
        // requires that we DO NOT serve the original spoiler bytes through
        // the hide-mode path. 285 bytes; lifetime of the process.
        private static readonly byte[] _hardcodedFallbackJpeg = Convert.FromBase64String(
            "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEi" +
            "MEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7" +
            "Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAQABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEA" +
            "AAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhED" +
            "EQA/AJKAD//Z");

        // Public accessor for the structural-fallback bytes. Callers in
        // SpoilerBlurImageFilter use this when StockCard returns null so the
        // hide-mode fail-closed invariant doesn't depend on Skia liveness.
        public byte[] HardcodedFallbackJpeg => _hardcodedFallbackJpeg;

        public ImageBlurService(ILogger<ImageBlurService> logger)
            : this(logger, MaximumConcurrentTransforms)
        {
        }

        internal ImageBlurService(ILogger<ImageBlurService> logger, int maximumConcurrentTransforms)
        {
            ArgumentOutOfRangeException.ThrowIfNegativeOrZero(maximumConcurrentTransforms);
            _logger = logger;
            _transformSlots = new SemaphoreSlim(maximumConcurrentTransforms, maximumConcurrentTransforms);
        }

        /// <summary>
        /// Coalesces the complete cold transform pipeline for one privacy-safe key.
        /// The shared work owns its cancellation token: one disconnected caller
        /// detaches without cancelling live followers, while the final departing
        /// caller cancels queued extraction/transform work. A process-wide slot
        /// budget also bounds different-key encoded buffers and native Skia work.
        /// </summary>
        internal async Task<SpoilerTransformResult> RunBoundedTransformAsync(
            string transformKey,
            Func<CancellationToken, Task<SpoilerTransformResult>> transform,
            Func<ValueTask>? releaseUnusedInput,
            CancellationToken callerCancellationToken)
        {
            ArgumentException.ThrowIfNullOrWhiteSpace(transformKey);
            ArgumentNullException.ThrowIfNull(transform);
            if (callerCancellationToken.IsCancellationRequested)
            {
                if (releaseUnusedInput != null)
                {
                    await releaseUnusedInput().ConfigureAwait(false);
                }

                callerCancellationToken.ThrowIfCancellationRequested();
            }

            while (true)
            {
                var candidate = new TransformFlight();
                var flight = _transformFlights.GetOrAdd(transformKey, candidate);
                if (!ReferenceEquals(flight, candidate))
                {
                    candidate.DisposeUnused();
                }

                if (!flight.TryJoin())
                {
                    _transformFlights.TryRemove(new KeyValuePair<string, TransformFlight>(transformKey, flight));
                    continue;
                }

                var isLeader = ReferenceEquals(flight, candidate);
                if (isLeader)
                {
                    _ = CompleteTransformFlightAsync(transformKey, transform, flight);
                }

                try
                {
                    return await flight.Completion.Task.WaitAsync(callerCancellationToken).ConfigureAwait(false);
                }
                finally
                {
                    flight.Leave();
                    if (!isLeader && releaseUnusedInput != null)
                    {
                        try
                        {
                            await releaseUnusedInput().ConfigureAwait(false);
                        }
                        catch (Exception ex)
                        {
                            _logger.LogDebug(ex, "Spoiler Guard could not release a coalesced follower input.");
                        }
                    }
                }
            }
        }

        // Returns a tiny solid-#101010 JPEG sized to the input (or default
        // 600x900 poster ratio if input bytes can't be decoded). Used by
        // SpoilerBlurMode == "hide" — instead of blurring the actual
        // image, we return a generic placeholder so the user sees a
        // blank card. Cheap (~1 KB output), no per-image variation.
        // Output matches Jellyfin's default dark-theme --card-bg-color so
        // the placeholder blends with the card chrome the way an empty
        // "missing episode" card does rather than reading as a distinct
        // grey block. Only probes the input for dimensions — never blurs it.
        public byte[]? StockCard(byte[] input, string? cacheKey)
        {
            if (!string.IsNullOrEmpty(cacheKey)
                && _cache.TryGetValue(cacheKey, out var cached))
            {
                Interlocked.Exchange(ref cached.LastAccessTicks, DateTime.UtcNow.Ticks);
                return cached.Bytes;
            }

            int width = 600;
            int height = 900;
            try
            {
                if (input != null
                    && input.Length > 0
                    && TryReadSourceInfo(input, out var sourceInfo))
                {
                    width = sourceInfo.Width;
                    height = sourceInfo.Height;
                    var longEdge = Math.Max(width, height);
                    if (longEdge > MaxDecodeEdgePx)
                    {
                        var ratio = (float)MaxDecodeEdgePx / longEdge;
                        width = Math.Max(1, (int)(width * ratio));
                        height = Math.Max(1, (int)(height * ratio));
                    }
                }
            }
            catch (Exception ex)
            {
                // Debug-level (suppressed in normal operation) so a malformed-image
                // flood — a corrupt poster somewhere in the library — can't fill the log.
                _logger.LogDebug($"Spoiler Guard stock-card probe failed for input ({input?.Length ?? 0} bytes): {ex.GetType().Name}: {ex.Message}. Using default dims 600x900.");
            }

            byte[]? output;
            try
            {
                using var surface = SKSurface.Create(new SKImageInfo(width, height));
                if (surface == null) return null;
                surface.Canvas.Clear(new SKColor(0x10, 0x10, 0x10));
                using var image = surface.Snapshot();
                using var encoded = image.Encode(SKEncodedImageFormat.Jpeg, 70);
                if (encoded == null) return null;
                output = encoded.ToArray();
            }
            catch (Exception ex)
            {
                _logger.LogError($"Spoiler Guard stock-card render failed: {ex.Message}");
                return null;
            }

            if (!string.IsNullOrEmpty(cacheKey))
            {
                StoreInCache(cacheKey, output);
            }
            return output;
        }

        // Re-encode `source` JPEG bytes resized to match the
        // dimensions of `referenceBytes` (or, if the source is much
        // larger than the reference, scale it down). Used by the
        // hide-mode parent-art fallback (Series Backdrop for
        // episodes, Series Primary for seasons, Collection Primary
        // for collection-opted movies) so the placeholder card
        // doesn't shift the client's grid layout. Cached in the same
        // LRU as Blur/StockCard.
        public byte[]? ResizeToMatch(byte[] source, byte[] referenceBytes, string? cacheKey)
        {
            if (source == null || source.Length == 0) return null;

            if (!string.IsNullOrEmpty(cacheKey)
                && _cache.TryGetValue(cacheKey, out var cached))
            {
                Interlocked.Exchange(ref cached.LastAccessTicks, DateTime.UtcNow.Ticks);
                return cached.Bytes;
            }

            int targetW = 600, targetH = 900;
            try
            {
                if (referenceBytes != null
                    && referenceBytes.Length > 0
                    && TryReadSourceInfo(referenceBytes, out var referenceInfo))
                {
                    targetW = referenceInfo.Width;
                    targetH = referenceInfo.Height;
                }
            }
            catch (Exception ex)
            {
                // Debug-level since this fires for any malformed reference and we
                // have a sane default (600x900).
                _logger.LogDebug($"Spoiler Guard parent-art reference probe failed: {ex.GetType().Name}: {ex.Message}. Using default dims 600x900.");
            }

            byte[]? output;
            try
            {
                using var srcBitmap = DecodeBounded(source);
                if (srcBitmap == null) return null;

                int srcW = srcBitmap.Width;
                int srcH = srcBitmap.Height;
                if (srcW <= 0 || srcH <= 0) return null;

                // Cap target at MaxDecodeEdgePx so we don't blow memory
                // on a huge poster fed through a small thumbnail request.
                var longEdge = Math.Max(targetW, targetH);
                if (longEdge > MaxDecodeEdgePx)
                {
                    var ratio = (float)MaxDecodeEdgePx / longEdge;
                    targetW = Math.Max(1, (int)(targetW * ratio));
                    targetH = Math.Max(1, (int)(targetH * ratio));
                }

                var info = new SKImageInfo(targetW, targetH);
                using var dst = new SKBitmap(info);
                if (!srcBitmap.ScalePixels(dst, new SKSamplingOptions(SKCubicResampler.Mitchell)))
                {
                    return null;
                }
                using var image = SKImage.FromBitmap(dst);
                using var encoded = image.Encode(SKEncodedImageFormat.Jpeg, 85);
                if (encoded == null) return null;
                output = encoded.ToArray();
            }
            catch (Exception ex)
            {
                _logger.LogError($"Spoiler Guard parent-art resize failed: {ex.Message}");
                return null;
            }

            if (!string.IsNullOrEmpty(cacheKey))
            {
                StoreInCache(cacheKey, output);
            }

            return output;
        }

        // Blurs <paramref name="input"/> with a Gaussian of <paramref name="requestedSigma"/>
        // (clamped to [MinSigma, MaxSigma]) and returns JPEG bytes.
        // <paramref name="cacheKey"/> should uniquely identify the source
        // image + sigma; pass null/empty to skip the cache. Returns null on any
        // decode/encode failure — the caller should fall back rather than serve
        // a broken image.
        public byte[]? Blur(byte[] input, float requestedSigma, string? cacheKey)
        {
            if (input == null || input.Length == 0) return null;

            var sigma = Math.Clamp(requestedSigma, MinSigma, MaxSigma);

            if (!string.IsNullOrEmpty(cacheKey)
                && _cache.TryGetValue(cacheKey, out var cached))
            {
                // Interlocked.Exchange for atomic 64-bit write — torn
                // reads on 32-bit ARM hosts could yield unstable LRU sort
                // order during eviction.
                Interlocked.Exchange(ref cached.LastAccessTicks, DateTime.UtcNow.Ticks);
                return cached.Bytes;
            }

            byte[]? output;
            try
            {
                output = BlurInternal(input, sigma);
            }
            catch (Exception ex)
            {
                _logger.LogError($"Spoiler Guard failed: {ex.Message}");
                return null;
            }

            if (output == null) return null;

            if (!string.IsNullOrEmpty(cacheKey))
            {
                StoreInCache(cacheKey, output);
            }

            return output;
        }

        private byte[]? BlurInternal(byte[] input, float sigma)
        {
            using var bitmap = DecodeBounded(input);
            if (bitmap == null) return null;

            int width = bitmap.Width;
            int height = bitmap.Height;
            if (width <= 0 || height <= 0) return null;

            using var surface = SKSurface.Create(new SKImageInfo(width, height));
            if (surface == null) return null;

            using var paint = new SKPaint
            {
                // Clamp tile mode samples the edge pixel beyond the canvas
                // so we don't get a black halo from the kernel reading
                // transparent pixels. The SKImageFilter is owned by the
                // SKPaint via SkiaSharp's internal ref-counting — wrapping
                // it in `using var` and assigning to ImageFilter caused
                // the filter to be released early in some draw paths and
                // silently produce unblurred output.
                ImageFilter = SKImageFilter.CreateBlur(sigma, sigma, SKShaderTileMode.Clamp),
                IsAntialias = true,
            };

            surface.Canvas.Clear(SKColors.Transparent);
            surface.Canvas.DrawBitmap(bitmap, 0, 0, paint);

            using var image = surface.Snapshot();
            // Quality 85: heavily smoothed images don't benefit from
            // higher q; 85 keeps file size small (~30-40 KB at 1280x720).
            using var encoded = image.Encode(SKEncodedImageFormat.Jpeg, 85);
            if (encoded == null) return null;
            return encoded.ToArray();
        }

        private async Task CompleteTransformFlightAsync(
            string transformKey,
            Func<CancellationToken, Task<SpoilerTransformResult>> transform,
            TransformFlight flight)
        {
            var flightToken = flight.CancellationToken;
            var slotHeld = false;
            try
            {
                // Publish the flight before invoking a factory that may complete
                // synchronously (FileContentResult + native Skia). Without this
                // boundary, the first request could finish the whole cold transform
                // before concurrent callers have a chance to join it.
                await Task.Yield();
                await _transformSlots.WaitAsync(flightToken).ConfigureAwait(false);
                slotHeld = true;
                Interlocked.Increment(ref _transformExecutionCount);
                flight.Completion.TrySetResult(await transform(flightToken).ConfigureAwait(false));
            }
            catch (OperationCanceledException) when (flightToken.IsCancellationRequested)
            {
                flight.Completion.TrySetCanceled(flightToken);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Spoiler Guard bounded transform failed for key {TransformKey}.", transformKey);
                flight.Completion.TrySetResult(SpoilerTransformResult.Rejected());
            }
            finally
            {
                if (slotHeld)
                {
                    _transformSlots.Release();
                }

                flight.MarkComplete();
                _transformFlights.TryRemove(new KeyValuePair<string, TransformFlight>(transformKey, flight));
            }
        }

        private SKBitmap? DecodeBounded(byte[] input)
        {
            if (input.LongLength > MaximumEncodedImageBytes)
            {
                Interlocked.Increment(ref _rejectedSourceCount);
                return null;
            }

            using var stream = new SKMemoryStream(input);
            using var codec = SKCodec.Create(stream);
            if (codec == null || !IsSourceInfoAllowed(codec.Info))
            {
                Interlocked.Increment(ref _rejectedSourceCount);
                return null;
            }

            var sourceInfo = codec.Info;
            var desiredScale = Math.Min(1f, (float)MaxDecodeEdgePx / Math.Max(sourceInfo.Width, sourceInfo.Height));
            var scaled = codec.GetScaledDimensions(desiredScale);

            // Some codecs expose only coarse native sampling ratios. Step down
            // until the codec advertises a destination inside our allocation
            // budget. Formats with no safe sampled decode (notably large PNGs
            // on some Skia builds) fail closed instead of allocating full size.
            for (var attempt = 0; attempt < 8 && Math.Max(scaled.Width, scaled.Height) > MaxDecodeEdgePx; attempt++)
            {
                desiredScale *= 0.75f;
                scaled = codec.GetScaledDimensions(desiredScale);
            }

            if (scaled.Width <= 0 || scaled.Height <= 0)
            {
                Interlocked.Increment(ref _rejectedSourceCount);
                return null;
            }

            var requiresPostDecodeResize = Math.Max(scaled.Width, scaled.Height) > MaxDecodeEdgePx;
            if (requiresPostDecodeResize)
            {
                // PNG/BMP and a few platform codecs cannot sample during decode.
                // Preserve ordinary 4K artwork compatibility with a separately
                // bounded full decode, then immediately resize. Adversarial or
                // very large sources still reject before native allocation.
                var sourcePixels = (long)sourceInfo.Width * sourceInfo.Height;
                var sourceBytes = sourcePixels * 4;
                if (sourcePixels > MaximumFallbackDecodePixels
                    || sourceBytes > MaximumFallbackDecodeBytes)
                {
                    Interlocked.Increment(ref _rejectedSourceCount);
                    return null;
                }

                scaled = new SKSizeI(sourceInfo.Width, sourceInfo.Height);
            }

            var decodeInfo = new SKImageInfo(
                scaled.Width,
                scaled.Height,
                SKColorType.Rgba8888,
                SKAlphaType.Premul);
            var allocationBudget = requiresPostDecodeResize
                ? MaximumFallbackDecodeBytes
                : MaximumDecodedBytes;
            if (decodeInfo.BytesSize64 <= 0
                || decodeInfo.BytesSize64 > allocationBudget
                || decodeInfo.RowBytes64 <= 0
                || decodeInfo.RowBytes64 > (requiresPostDecodeResize
                    ? (long)MaximumSourceDimension * 4
                    : (long)MaxDecodeEdgePx * 4))
            {
                Interlocked.Increment(ref _rejectedSourceCount);
                return null;
            }

            Interlocked.Increment(ref _decodeAttemptCount);
            var bitmap = SKBitmap.Decode(codec, decodeInfo);
            if (bitmap == null)
            {
                return null;
            }

            if (bitmap.Width <= 0 || bitmap.Height <= 0 || bitmap.ByteCount > allocationBudget)
            {
                bitmap.Dispose();
                Interlocked.Increment(ref _rejectedSourceCount);
                return null;
            }

            if (requiresPostDecodeResize)
            {
                var ratio = (float)MaxDecodeEdgePx / Math.Max(bitmap.Width, bitmap.Height);
                var targetWidth = Math.Max(1, (int)(bitmap.Width * ratio));
                var targetHeight = Math.Max(1, (int)(bitmap.Height * ratio));
                var resized = bitmap.Resize(
                    new SKImageInfo(targetWidth, targetHeight, SKColorType.Rgba8888, SKAlphaType.Premul),
                    SKSamplingOptions.Default);
                bitmap.Dispose();
                if (resized == null
                    || Math.Max(resized.Width, resized.Height) > MaxDecodeEdgePx
                    || resized.ByteCount > MaximumDecodedBytes)
                {
                    resized?.Dispose();
                    Interlocked.Increment(ref _rejectedSourceCount);
                    return null;
                }

                return resized;
            }

            return bitmap;
        }

        private bool TryReadSourceInfo(byte[] input, out SKImageInfo info)
        {
            info = default;
            if (input.LongLength > MaximumEncodedImageBytes)
            {
                Interlocked.Increment(ref _rejectedSourceCount);
                return false;
            }

            using var stream = new SKMemoryStream(input);
            using var codec = SKCodec.Create(stream);
            if (codec == null || !IsSourceInfoAllowed(codec.Info))
            {
                Interlocked.Increment(ref _rejectedSourceCount);
                return false;
            }

            info = codec.Info;
            return true;
        }

        internal static bool IsSourceInfoAllowed(SKImageInfo info)
            => info.Width > 0
                && info.Height > 0
                && info.Width <= MaximumSourceDimension
                && info.Height <= MaximumSourceDimension
                && (long)info.Width * info.Height <= MaximumSourcePixels
                && (long)info.Width * 4 <= MaximumSourceDimension * 4L;

        // Test seam (Tests has InternalsVisibleTo): current entry count, so a
        // test can prove eviction keeps the cache bounded at MaxCacheEntries.
        internal int CacheEntryCountForTest => _cache.Count;

        internal int InFlightCountForTest => _transformFlights.Count;

        internal int TransformExecutionCountForTest => Volatile.Read(ref _transformExecutionCount);

        internal int DecodeAttemptCountForTest => Volatile.Read(ref _decodeAttemptCount);

        internal int RejectedSourceCountForTest => Volatile.Read(ref _rejectedSourceCount);

        private void StoreInCache(string key, byte[] bytes)
        {
            var entry = new CacheEntry
            {
                Bytes = bytes,
                LastAccessTicks = DateTime.UtcNow.Ticks,
            };

            if (_cache.TryAdd(key, entry))
            {
                Interlocked.Add(ref _cacheBytes, bytes.LongLength);
            }
            else
            {
                // Race: another caller blurred the same key first. Their entry is fine; drop ours.
                return;
            }

            EvictIfOverCap();
        }

        private void EvictIfOverCap()
        {
            // Serialize eviction so two threads observing the cap
            // exceeded don't both snapshot and over-evict. The
            // blur-and-store path holds this lock only for the eviction
            // window, which is rare (cap-only) and short — not on the
            // hot path.
            if (_cache.Count <= MaxCacheEntries
                && Interlocked.Read(ref _cacheBytes) <= MaxCacheBytes)
            {
                return;
            }

            lock (_evictionLock)
            {
                // Re-check under the lock — another thread may already have evicted.
                if (_cache.Count <= MaxCacheEntries
                    && Interlocked.Read(ref _cacheBytes) <= MaxCacheBytes)
                {
                    return;
                }

                var snapshot = _cache.ToArray();
                Array.Sort(snapshot, (a, b) => a.Value.LastAccessTicks.CompareTo(b.Value.LastAccessTicks));

                foreach (var kvp in snapshot)
                {
                    if (_cache.Count <= MaxCacheEntries / 2
                        && Interlocked.Read(ref _cacheBytes) <= MaxCacheBytes / 2)
                    {
                        break;
                    }
                    if (_cache.TryRemove(kvp.Key, out var removed))
                    {
                        Interlocked.Add(ref _cacheBytes, -removed.Bytes.LongLength);
                    }
                }
            }
        }

        private sealed class CacheEntry
        {
            public required byte[] Bytes { get; init; }
            public long LastAccessTicks;
        }

        private sealed class TransformFlight
        {
            private readonly object _gate = new();
            private readonly CancellationTokenSource _cancellation = new();
            private int _participants;
            private bool _accepting = true;
            private bool _complete;
            private bool _disposed;
            private bool _cancellationRequested;
            private bool _cancellationCompleted;

            public TaskCompletionSource<SpoilerTransformResult> Completion { get; } = new(
                TaskCreationOptions.RunContinuationsAsynchronously);

            public CancellationToken CancellationToken => _cancellation.Token;

            public bool TryJoin()
            {
                lock (_gate)
                {
                    if (!_accepting)
                    {
                        return false;
                    }

                    _participants++;
                    return true;
                }
            }

            public void Leave()
            {
                var cancel = false;
                var dispose = false;
                lock (_gate)
                {
                    if (_participants <= 0)
                    {
                        return;
                    }

                    _participants--;
                    if (_participants == 0)
                    {
                        if (_complete)
                        {
                            dispose = MarkDisposedUnderLock();
                        }
                        else
                        {
                            _accepting = false;
                            _cancellationRequested = true;
                            cancel = true;
                        }
                    }
                }

                if (cancel)
                {
                    _cancellation.Cancel();
                    lock (_gate)
                    {
                        _cancellationCompleted = true;
                        if (_complete && _participants == 0)
                        {
                            dispose = MarkDisposedUnderLock();
                        }
                    }
                }

                if (dispose)
                {
                    _cancellation.Dispose();
                }
            }

            public void MarkComplete()
            {
                var dispose = false;
                lock (_gate)
                {
                    _accepting = false;
                    _complete = true;
                    if (_participants == 0
                        && (!_cancellationRequested || _cancellationCompleted))
                    {
                        dispose = MarkDisposedUnderLock();
                    }
                }

                if (dispose)
                {
                    _cancellation.Dispose();
                }
            }

            public void DisposeUnused()
            {
                var dispose = false;
                lock (_gate)
                {
                    _accepting = false;
                    _complete = true;
                    dispose = MarkDisposedUnderLock();
                }

                if (dispose)
                {
                    _cancellation.Dispose();
                }
            }

            private bool MarkDisposedUnderLock()
            {
                if (_disposed)
                {
                    return false;
                }

                _disposed = true;
                return true;
            }
        }
    }
}
