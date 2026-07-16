using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.AutoRequest
{
    /// <summary>
    /// Owns playback-event singleflight, outcome-aware commit/release, and a
    /// bounded retry backoff. In-flight reservations are never confused with
    /// the one-hour dedup committed by a successful or definitive check.
    /// </summary>
    internal sealed class PlaybackRequestDeduplicator
    {
        internal static readonly TimeSpan CommittedTtl = TimeSpan.FromHours(1);
        internal static readonly TimeSpan RetryStateTtl = TimeSpan.FromHours(1);
        internal static readonly TimeSpan InitialBackoff = TimeSpan.FromSeconds(1);
        internal static readonly TimeSpan MaximumBackoff = TimeSpan.FromMinutes(1);

        private const int MaximumEntries = 16_384;

        private readonly object _gate = new();
        private readonly Dictionary<GenerationKey, long> _inFlight = new();
        private readonly BoundedTtlCache<GenerationKey, byte> _committed;
        private readonly BoundedTtlCache<GenerationKey, RetryState> _retryStates;
        private readonly TimeProvider _timeProvider;
        private long _nextGeneration;

        public PlaybackRequestDeduplicator(TimeProvider? timeProvider = null)
        {
            _timeProvider = timeProvider ?? TimeProvider.System;
            _committed = new BoundedTtlCache<GenerationKey, byte>(
                MaximumEntries,
                MaximumEntries,
                timeProvider: _timeProvider,
                defaultTtl: () => CommittedTtl);
            _retryStates = new BoundedTtlCache<GenerationKey, RetryState>(
                MaximumEntries,
                MaximumEntries,
                timeProvider: _timeProvider,
                defaultTtl: () => RetryStateTtl);
        }

        /// <summary>
        /// Runs <paramref name="operation"/> when the key is neither committed,
        /// reserved, nor inside retry backoff. Returns false when this event was
        /// deduplicated without invoking the operation.
        /// </summary>
        public async Task<bool> ExecuteAsync(
            string generationIdentity,
            string key,
            Func<Task<AutoRequestPlaybackOutcome>> operation)
        {
            ArgumentException.ThrowIfNullOrWhiteSpace(generationIdentity);
            ArgumentException.ThrowIfNullOrWhiteSpace(key);
            ArgumentNullException.ThrowIfNull(operation);

            if (!TryReserve(new GenerationKey(generationIdentity, key), out var reservation))
            {
                return false;
            }

            AutoRequestPlaybackOutcome outcome;
            try
            {
                outcome = await operation().ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                outcome = AutoRequestPlaybackOutcome.Cancelled;
            }
            catch
            {
                Complete(reservation, AutoRequestPlaybackOutcome.RetryableFailure);
                throw;
            }

            Complete(reservation, outcome);
            return true;
        }

        private bool TryReserve(GenerationKey key, out Reservation reservation)
        {
            lock (_gate)
            {
                if (_committed.ContainsKey(key)
                    || _inFlight.ContainsKey(key)
                    || IsBackedOff(key))
                {
                    reservation = default;
                    return false;
                }

                // A permanently incomplete operation must not let an unbounded
                // number of unrelated playback keys accumulate.
                if (_inFlight.Count >= MaximumEntries)
                {
                    reservation = default;
                    return false;
                }

                var generation = ++_nextGeneration;
                _inFlight.Add(key, generation);
                reservation = new Reservation(key, generation);
                return true;
            }
        }

        private bool IsBackedOff(GenerationKey key)
        {
            return _retryStates.TryGet(key, out var state)
                && state.RetryAfter > _timeProvider.GetUtcNow();
        }

        private void Complete(Reservation reservation, AutoRequestPlaybackOutcome outcome)
        {
            lock (_gate)
            {
                if (!_inFlight.TryGetValue(reservation.Key, out var generation)
                    || generation != reservation.Generation)
                {
                    return;
                }

                _inFlight.Remove(reservation.Key);
                if (outcome is AutoRequestPlaybackOutcome.Committed
                    or AutoRequestPlaybackOutcome.DefinitiveNoop)
                {
                    _retryStates.Remove(reservation.Key);
                    _committed.Set(reservation.Key, 0, CommittedTtl);
                    return;
                }

                var failures = _retryStates.TryGet(reservation.Key, out var prior)
                    ? prior.Failures + 1
                    : 1;
                var delay = ComputeBackoff(failures);
                _retryStates.Set(
                    reservation.Key,
                    new RetryState(failures, _timeProvider.GetUtcNow() + delay),
                    RetryStateTtl);
            }
        }

        /// <summary>
        /// The first failure releases for one immediate playback retry. A second
        /// consecutive failure starts exponential backoff, capped at one minute.
        /// </summary>
        internal static TimeSpan ComputeBackoff(int failures)
        {
            if (failures <= 1)
            {
                return TimeSpan.Zero;
            }

            var exponent = Math.Min(failures - 2, 6);
            var delay = TimeSpan.FromTicks(InitialBackoff.Ticks * (1L << exponent));
            return delay <= MaximumBackoff ? delay : MaximumBackoff;
        }

        private readonly record struct GenerationKey(
            string GenerationIdentity,
            string OperationKey);

        private readonly record struct Reservation(GenerationKey Key, long Generation);

        private readonly record struct RetryState(int Failures, DateTimeOffset RetryAfter);
    }
}
