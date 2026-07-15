using System;
using System.Collections.Concurrent;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Seerr
{
    internal enum AvatarFetchStatus
    {
        Available,
        Missing,
        ConfigurationChanged,
    }

    internal sealed record AvatarFetchResult(
        AvatarFetchStatus Status,
        byte[]? Content = null,
        string? ContentType = null,
        string? ETag = null);

    /// <summary>
    /// Bounded streaming owner for authenticated Seerr avatar reads. It coalesces one cold flight
    /// per generation-aware cache key, validates declared and streamed sizes plus raster signatures,
    /// retains a bounded last-good copy, and suppresses repeated definitive misses during a short
    /// exponential outage window.
    /// </summary>
    public sealed class AvatarFetchService
    {
        internal const long DefaultMaximumAvatarBytes = 8L * 1024 * 1024;
        private const int MaximumFailureStates = 2048;

        private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(10);
        private static readonly TimeSpan LastGoodRetention = TimeSpan.FromHours(24);
        private static readonly TimeSpan FailureStateRetention = TimeSpan.FromHours(24);
        private static readonly TimeSpan[] FailureBackoff =
        {
            TimeSpan.FromSeconds(15),
            TimeSpan.FromSeconds(30),
            TimeSpan.FromMinutes(1),
            TimeSpan.FromMinutes(2),
            TimeSpan.FromMinutes(5),
        };

        private readonly IHttpClientFactory _httpClientFactory;
        private readonly ISeerrCache _cache;
        private readonly IPluginConfigProvider _configProvider;
        private readonly ILogger<AvatarFetchService> _logger;
        private readonly TimeProvider _timeProvider;
        private readonly long _maximumAvatarBytes;
        private readonly ConcurrentDictionary<string, AvatarFlight> _flights = new(StringComparer.Ordinal);
        private readonly BoundedTtlCache<string, FailureState> _failures;

        public AvatarFetchService(
            IHttpClientFactory httpClientFactory,
            ISeerrCache cache,
            IPluginConfigProvider configProvider,
            ILogger<AvatarFetchService> logger)
            : this(
                httpClientFactory,
                cache,
                configProvider,
                logger,
                TimeProvider.System,
                DefaultMaximumAvatarBytes)
        {
        }

        internal AvatarFetchService(
            IHttpClientFactory httpClientFactory,
            ISeerrCache cache,
            IPluginConfigProvider configProvider,
            ILogger<AvatarFetchService> logger,
            TimeProvider timeProvider,
            long maximumAvatarBytes)
        {
            ArgumentOutOfRangeException.ThrowIfNegativeOrZero(maximumAvatarBytes);
            _httpClientFactory = httpClientFactory;
            _cache = cache;
            _configProvider = configProvider;
            _logger = logger;
            _timeProvider = timeProvider;
            _maximumAvatarBytes = maximumAvatarBytes;
            _failures = new BoundedTtlCache<string, FailureState>(
                MaximumFailureStates,
                MaximumFailureStates,
                comparer: StringComparer.Ordinal,
                timeProvider: timeProvider,
                defaultTtl: () => FailureStateRetention);
        }

        internal int InFlightCount => _flights.Count;

        internal int FailureStateCount => _failures.Count;

        internal async Task<AvatarFetchResult> GetAsync(
            string cacheKey,
            string upstreamUrl,
            SeerrDispatchFence dispatchFence,
            CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(dispatchFence);
            var integration = SeerrIntegrationPolicy.Capture(_configProvider);
            if (!integration.IsActive
                || !integration.Urls.Any(url => upstreamUrl.StartsWith(
                    url + "/",
                    StringComparison.Ordinal)))
            {
                return ConfigurationChanged();
            }

            SeerrDispatchFence authorizedFence = integration
                .CreateDispatchFence(_configProvider)
                .Restrict(dispatchFence.CanDispatch);

            // Authorization precedes last-good and backoff reads: disabling the
            // master switch must not keep advertising or serving cached active
            // integration state.
            if (!authorizedFence.CanDispatch())
            {
                return ConfigurationChanged();
            }

            if (TryGetLastGood(cacheKey, out var cached) && IsFresh(cached))
            {
                return Available(cached);
            }

            if (IsBackedOff(cacheKey))
            {
                return cached.Content != null ? Available(cached) : Missing();
            }

            while (true)
            {
                var candidate = new AvatarFlight();
                var flight = _flights.GetOrAdd(cacheKey, candidate);
                if (!flight.TryJoin())
                {
                    _flights.TryRemove(new KeyValuePair<string, AvatarFlight>(cacheKey, flight));
                    continue;
                }

                if (ReferenceEquals(flight, candidate))
                {
                    _ = CompleteFlightAsync(
                        cacheKey,
                        upstreamUrl,
                        authorizedFence,
                        candidate);
                }

                try
                {
                    return await flight.Completion.Task.WaitAsync(cancellationToken).ConfigureAwait(false);
                }
                finally
                {
                    flight.Leave();
                }
            }
        }

        internal static string BuildCacheKey(
            string seerrUrl,
            string avatarPath,
            long configurationRevision,
            string seerrApiKey)
        {
            var apiKeyFingerprint = Convert.ToHexString(
                SHA256.HashData(Encoding.UTF8.GetBytes(seerrApiKey)));
            return $"{configurationRevision.ToString(System.Globalization.CultureInfo.InvariantCulture)}:{apiKeyFingerprint}:{seerrUrl.Length.ToString(System.Globalization.CultureInfo.InvariantCulture)}:{seerrUrl}{avatarPath}";
        }

        internal static bool TryPublishCacheEntry(
            BoundedTtlCache<string, (byte[] Content, string ContentType, string ETag, DateTime CachedAt)> cache,
            string cacheKey,
            (byte[] Content, string ContentType, string ETag, DateTime CachedAt) entry,
            TimeSpan retention,
            SeerrDispatchFence dispatchFence)
        {
            if (!dispatchFence.CanDispatch() || !cache.TrySet(cacheKey, entry, retention, out var publication))
            {
                return false;
            }

            if (dispatchFence.CanDispatch())
            {
                return true;
            }

            cache.Remove(publication);
            return false;
        }

        private async Task CompleteFlightAsync(
            string cacheKey,
            string upstreamUrl,
            SeerrDispatchFence dispatchFence,
            AvatarFlight flight)
        {
            var flightCancellationToken = flight.CancellationToken;
            try
            {
                var result = await FetchLeaderAsync(
                    cacheKey,
                    upstreamUrl,
                    dispatchFence,
                    flightCancellationToken).ConfigureAwait(false);
                flight.Completion.TrySetResult(result);
            }
            catch (OperationCanceledException) when (flightCancellationToken.IsCancellationRequested)
            {
                flight.Completion.TrySetCanceled(flightCancellationToken);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Avatar fetch flight failed unexpectedly for key {AvatarKey}.", LogKey(cacheKey));
                flight.Completion.TrySetResult(FailureResult(
                    cacheKey,
                    "internal fetch failure",
                    dispatchFence));
            }
            finally
            {
                flight.MarkComplete();
                _flights.TryRemove(new KeyValuePair<string, AvatarFlight>(cacheKey, flight));
            }
        }

        private async Task<AvatarFetchResult> FetchLeaderAsync(
            string cacheKey,
            string upstreamUrl,
            SeerrDispatchFence dispatchFence,
            CancellationToken cancellationToken)
        {
            TryGetLastGood(cacheKey, out var lastGood);
            if (IsFresh(lastGood))
            {
                return Available(lastGood);
            }

            if (IsBackedOff(cacheKey))
            {
                return lastGood.Content != null ? Available(lastGood) : Missing();
            }

            if (!dispatchFence.CanDispatch())
            {
                return ConfigurationChanged();
            }

            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(RequestTimeout);
            var fetchToken = timeout.Token;

            try
            {
                var client = Helpers.Seerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
                using var request = new HttpRequestMessage(HttpMethod.Get, upstreamUrl);
                request.Headers.UserAgent.ParseAdd(Helpers.Seerr.SeerrHttpHelper.UserAgent);
                request.Headers.Accept.ParseAdd("image/*");
                if (!dispatchFence.CanDispatch(request.RequestUri))
                {
                    return ConfigurationChanged();
                }

                using var response = await client.SendAsync(
                    request,
                    HttpCompletionOption.ResponseHeadersRead,
                    fetchToken).ConfigureAwait(false);

                if (!dispatchFence.CanDispatch(request.RequestUri))
                {
                    return ConfigurationChanged();
                }

                if (!response.IsSuccessStatusCode)
                {
                    return FailureResult(
                        cacheKey,
                        $"HTTP {(int)response.StatusCode}",
                        dispatchFence,
                        lastGood);
                }

                var contentType = response.Content.Headers.ContentType?.MediaType;
                if (!IsAllowedContentType(contentType))
                {
                    return FailureResult(
                        cacheKey,
                        $"disallowed content type '{contentType ?? "missing"}'",
                        dispatchFence,
                        lastGood);
                }

                var declaredLength = response.Content.Headers.ContentLength;
                if (declaredLength.HasValue && declaredLength.Value > _maximumAvatarBytes)
                {
                    return FailureResult(
                        cacheKey,
                        $"declared size {declaredLength.Value} exceeds {_maximumAvatarBytes}-byte cap",
                        dispatchFence,
                        lastGood);
                }

                byte[]? content;
                await using (var stream = await response.Content.ReadAsStreamAsync(fetchToken).ConfigureAwait(false))
                {
                    content = await ReadWithCapAsync(stream, _maximumAvatarBytes, fetchToken).ConfigureAwait(false);
                }

                if (content == null)
                {
                    return FailureResult(
                        cacheKey,
                        $"stream exceeds {_maximumAvatarBytes}-byte cap",
                        dispatchFence,
                        lastGood);
                }

                if (!HasMatchingSignature(content, contentType!))
                {
                    return FailureResult(
                        cacheKey,
                        $"signature does not match {contentType}",
                        dispatchFence,
                        lastGood);
                }

                if (!dispatchFence.CanDispatch())
                {
                    return ConfigurationChanged();
                }

                var etag = $"\"{Convert.ToHexString(SHA256.HashData(content))}\"";
                var entry = (
                    Content: content,
                    ContentType: contentType!,
                    ETag: etag,
                    CachedAt: _timeProvider.GetUtcNow().UtcDateTime);
                if (!TryPublishCacheEntry(
                    _cache.AvatarCache,
                    cacheKey,
                    entry,
                    LastGoodRetention,
                    dispatchFence))
                {
                    return dispatchFence.CanDispatch()
                        ? FailureResult(
                            cacheKey,
                            "cache capacity rejected avatar",
                            dispatchFence,
                            lastGood)
                        : ConfigurationChanged();
                }

                ClearFailure(cacheKey);
                return Available(entry);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (OperationCanceledException)
            {
                return FailureResult(
                    cacheKey,
                    "upstream timed out",
                    dispatchFence,
                    lastGood);
            }
            catch (Exception ex)
            {
                return FailureResult(
                    cacheKey,
                    ex.GetType().Name,
                    dispatchFence,
                    lastGood);
            }
        }

        private AvatarFetchResult FailureResult(
            string cacheKey,
            string reason,
            SeerrDispatchFence dispatchFence,
            (byte[] Content, string ContentType, string ETag, DateTime CachedAt) lastGood = default)
        {
            if (!dispatchFence.CanDispatch())
            {
                return ConfigurationChanged();
            }

            var failures = 1;
            if (_failures.TryGet(cacheKey, out var previous))
            {
                failures = Math.Min(previous.ConsecutiveFailures + 1, FailureBackoff.Length);
            }

            var delay = FailureBackoff[Math.Min(failures - 1, FailureBackoff.Length - 1)];
            _failures.TrySet(
                cacheKey,
                new FailureState(failures, _timeProvider.GetUtcNow().Add(delay)),
                FailureStateRetention,
                out var publication);
            if (!dispatchFence.CanDispatch())
            {
                _failures.Remove(publication);
                return ConfigurationChanged();
            }

            _logger.LogWarning(
                "Avatar upstream unavailable for key {AvatarKey} ({Reason}); retry in {Delay}. Consecutive failures: {Failures}; last-good: {LastGood}.",
                LogKey(cacheKey),
                reason,
                delay,
                failures,
                lastGood.Content != null ? "available" : "missing");
            return lastGood.Content != null ? Available(lastGood) : Missing();
        }

        private bool TryGetLastGood(
            string cacheKey,
            out (byte[] Content, string ContentType, string ETag, DateTime CachedAt) entry)
            => _cache.AvatarCache.TryGet(cacheKey, out entry);

        private bool IsFresh((byte[] Content, string ContentType, string ETag, DateTime CachedAt) entry)
            => entry.Content != null
                && _timeProvider.GetUtcNow().UtcDateTime - entry.CachedAt < _cache.AvatarCacheDuration;

        private bool IsBackedOff(string cacheKey)
            => _failures.TryGet(cacheKey, out var failure)
                && _timeProvider.GetUtcNow() < failure.RetryAfter;

        private void ClearFailure(string cacheKey)
        {
            if (_failures.Remove(cacheKey))
            {
                _logger.LogInformation("Avatar upstream recovered for key {AvatarKey}; outage backoff cleared.", LogKey(cacheKey));
            }
        }

        private static string LogKey(string cacheKey)
            => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(cacheKey)))[..12];

        private static bool IsAllowedContentType(string? contentType)
            => contentType is not null && contentType.ToLowerInvariant() switch
            {
                "image/png" or "image/jpeg" or "image/jpg" or "image/gif" or
                "image/webp" or "image/avif" or "image/bmp" => true,
                _ => false,
            };

        private static bool HasMatchingSignature(ReadOnlySpan<byte> content, string contentType)
            => contentType.ToLowerInvariant() switch
            {
                "image/png" => content.StartsWith(new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A }),
                "image/jpeg" or "image/jpg" => content.StartsWith(new byte[] { 0xFF, 0xD8, 0xFF }),
                "image/gif" => content.StartsWith("GIF87a"u8) || content.StartsWith("GIF89a"u8),
                "image/webp" => content.Length >= 12 && content[..4].SequenceEqual("RIFF"u8) && content.Slice(8, 4).SequenceEqual("WEBP"u8),
                "image/bmp" => content.StartsWith("BM"u8),
                "image/avif" => content.Length >= 12
                    && content.Slice(4, 4).SequenceEqual("ftyp"u8)
                    && (content.Slice(8, 4).SequenceEqual("avif"u8)
                        || content.Slice(8, 4).SequenceEqual("avis"u8)
                        || content.Slice(8, 4).SequenceEqual("mif1"u8)),
                _ => false,
            };

        private static async Task<byte[]?> ReadWithCapAsync(
            Stream stream,
            long maximumBytes,
            CancellationToken cancellationToken)
        {
            using var buffer = new MemoryStream();
            var chunk = new byte[81920];
            while (buffer.Length <= maximumBytes)
            {
                var remainingThroughCap = maximumBytes + 1 - buffer.Length;
                var requested = (int)Math.Min(chunk.Length, remainingThroughCap);
                var read = await stream.ReadAsync(
                    chunk.AsMemory(0, requested),
                    cancellationToken).ConfigureAwait(false);
                if (read == 0)
                {
                    return buffer.ToArray();
                }

                buffer.Write(chunk, 0, read);
            }

            return null;
        }

        private static AvatarFetchResult Available(
            (byte[] Content, string ContentType, string ETag, DateTime CachedAt) entry)
            => new(AvatarFetchStatus.Available, entry.Content, entry.ContentType, entry.ETag);

        private static AvatarFetchResult Missing() => new(AvatarFetchStatus.Missing);

        private static AvatarFetchResult ConfigurationChanged() => new(AvatarFetchStatus.ConfigurationChanged);

        private sealed record FailureState(int ConsecutiveFailures, DateTimeOffset RetryAfter);

        private sealed class AvatarFlight
        {
            private readonly object _gate = new();
            private readonly CancellationTokenSource _cancellation = new();
            private int _participants;
            private bool _accepting = true;
            private bool _complete;

            public TaskCompletionSource<AvatarFetchResult> Completion { get; } = new(
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
                lock (_gate)
                {
                    if (_participants <= 0)
                    {
                        return;
                    }

                    _participants--;
                    if (_participants != 0)
                    {
                        return;
                    }

                    if (_complete)
                    {
                        _cancellation.Dispose();
                    }
                    else
                    {
                        _accepting = false;
                        _cancellation.Cancel();
                    }
                }
            }

            public void MarkComplete()
            {
                lock (_gate)
                {
                    _accepting = false;
                    _complete = true;
                    if (_participants == 0)
                    {
                        _cancellation.Dispose();
                    }
                }
            }
        }
    }
}
