using System.Globalization;
using System.Net;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.AnimeFiller;

/// <summary>Serializes one origin below its published request ceiling and observes server backoff headers.</summary>
internal sealed class ProviderRateGate
{
    private readonly SemaphoreSlim _serial = new(1, 1);
    private readonly object _stateGate = new();
    private readonly TimeProvider _timeProvider;
    private readonly TimeSpan _minimumSpacing;
    private readonly TimeSpan _unadvisedTooManyRequestsBackoff;
    private readonly Func<TimeSpan, CancellationToken, Task> _delay;
    private DateTimeOffset _nextAllowed = DateTimeOffset.MinValue;

    internal ProviderRateGate(
        TimeSpan minimumSpacing,
        TimeProvider? timeProvider = null,
        Func<TimeSpan, CancellationToken, Task>? delay = null,
        TimeSpan? unadvisedTooManyRequestsBackoff = null)
    {
        if (minimumSpacing < TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(minimumSpacing));
        _minimumSpacing = minimumSpacing;
        _unadvisedTooManyRequestsBackoff = unadvisedTooManyRequestsBackoff ?? minimumSpacing;
        if (_unadvisedTooManyRequestsBackoff < minimumSpacing)
        {
            throw new ArgumentOutOfRangeException(nameof(unadvisedTooManyRequestsBackoff));
        }

        _timeProvider = timeProvider ?? TimeProvider.System;
        _delay = delay ?? ((duration, cancellationToken) => Task.Delay(duration, cancellationToken));
    }

    internal async Task WaitAsync(CancellationToken cancellationToken)
    {
        await _serial.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            while (true)
            {
                DateTimeOffset nextAllowed;
                lock (_stateGate) nextAllowed = _nextAllowed;
                var delay = nextAllowed - _timeProvider.GetUtcNow();
                if (delay <= TimeSpan.Zero) break;
                await _delay(delay, cancellationToken).ConfigureAwait(false);
            }

            lock (_stateGate)
            {
                var now = _timeProvider.GetUtcNow();
                _nextAllowed = Max(_nextAllowed, now).Add(_minimumSpacing);
            }
        }
        finally
        {
            _serial.Release();
        }
    }

    internal void Observe(HttpResponseMessage response)
    {
        ArgumentNullException.ThrowIfNull(response);
        var now = _timeProvider.GetUtcNow();
        DateTimeOffset? deferredUntil = response.Headers.RetryAfter?.Delta is { } delta
            ? now.Add(delta)
            : response.Headers.RetryAfter?.Date;

        if (response.Headers.TryGetValues("X-RateLimit-Remaining", out var remainingValues)
            && remainingValues.Any(value => int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var remaining) && remaining <= 0)
            && response.Headers.TryGetValues("X-RateLimit-Reset", out var resetValues))
        {
            var reset = resetValues
                .Select(value => long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var seconds)
                    ? DateTimeOffset.FromUnixTimeSeconds(seconds)
                    : DateTimeOffset.MinValue)
                .Max();
            if (reset > now) deferredUntil = deferredUntil.HasValue ? Max(deferredUntil.Value, reset) : reset;
        }

        if (deferredUntil <= now) deferredUntil = null;
        if (response.StatusCode == HttpStatusCode.TooManyRequests && !deferredUntil.HasValue)
        {
            deferredUntil = now.Add(_unadvisedTooManyRequestsBackoff);
        }

        if (!deferredUntil.HasValue) return;
        lock (_stateGate) _nextAllowed = Max(_nextAllowed, deferredUntil.Value);
    }

    private static DateTimeOffset Max(DateTimeOffset left, DateTimeOffset right) => left >= right ? left : right;
}
