using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>
    /// Process-local, bounded idempotency owner for future Platform mutations.
    /// Live entries are never evicted to make room: new work is rejected before its
    /// delegate runs whenever admitting it would cross any bound.
    /// </summary>
    public sealed class PlatformIdempotencyStore
    {
        /// <summary>
        /// Store-issued evidence for one idempotency leader. The invocation
        /// coordinator marks it immediately before spending a capability or entering
        /// an owner; cancellation before that point is known not to have mutated state.
        /// </summary>
        internal sealed class PlatformIdempotencyExecution
        {
            private int _sideEffectStarted;
            private PlatformIdempotencyResult? _abandonedResult;

            internal PlatformIdempotencyExecution()
            {
            }

            internal bool SideEffectStarted => Volatile.Read(ref _sideEffectStarted) != 0;

            internal PlatformIdempotencyResult? AbandonedResult => Volatile.Read(ref _abandonedResult);

            internal void MarkSideEffectStarted()
            {
                if (AbandonedResult is not null)
                {
                    throw new InvalidOperationException("An abandoned execution cannot cross the side-effect boundary.");
                }

                Interlocked.Exchange(ref _sideEffectStarted, 1);
            }

            internal PlatformIdempotencyResult AbandonBeforeSideEffect(PlatformIdempotencyResult result)
            {
                ArgumentNullException.ThrowIfNull(result);
                if (SideEffectStarted
                    || Interlocked.CompareExchange(ref _abandonedResult, result, comparand: null) is not null)
                {
                    throw new InvalidOperationException("The execution can be abandoned exactly once before side effects.");
                }

                return result;
            }
        }

        /// <summary>Terminal entries are reusable for this long.</summary>
        public static readonly TimeSpan EntryTimeToLive = TimeSpan.FromMinutes(10);

        /// <summary>Maximum number of live tuples.</summary>
        public const int MaximumEntries = 1024;

        /// <summary>Maximum total stored and reserved semantic result bytes.</summary>
        public const int MaximumStoredResultBytes = 8 * 1024 * 1024;

        /// <summary>Maximum semantic result bytes for one tuple.</summary>
        public const int MaximumResultBytes = 64 * 1024;

        /// <summary>Maximum coalesced followers retained behind one leader.</summary>
        public const int MaximumFollowersPerEntry = 64;

        /// <summary>Maximum coalesced followers retained across the process.</summary>
        public const int MaximumFollowers = 1024;

        private readonly object _gate = new();
        private readonly Dictionary<StoreKey, Entry> _entries = new();
        private readonly TimeProvider _timeProvider;
        private int _storedBytes;
        private int _reservedBytes;
        private int _followerCount;

        /// <summary>Initializes the process-wide store with the system clock.</summary>
        public PlatformIdempotencyStore()
            : this(TimeProvider.System)
        {
        }

        internal PlatformIdempotencyStore(TimeProvider timeProvider)
        {
            _timeProvider = timeProvider ?? throw new ArgumentNullException(nameof(timeProvider));
        }

        /// <summary>
        /// Executes a leader or joins/replays the same tuple. A follower's cancellation
        /// token only abandons its own wait and can never cancel the leader.
        /// </summary>
        public async Task<PlatformIdempotencyOutcome> ExecuteAsync(
            PlatformIdempotencyRequest request,
            Func<CancellationToken, Task<PlatformIdempotencyResult>> execute,
            CancellationToken requestCancellationToken)
        {
            ArgumentNullException.ThrowIfNull(execute);
            return await ExecuteCoreAsync(
                request,
                async (execution, cancellationToken) =>
                {
                    // Preserve the original public contract: once its delegate is
                    // entered, the store must conservatively treat an exception as an
                    // ambiguous mutation.
                    execution.MarkSideEffectStarted();
                    return await execute(cancellationToken).ConfigureAwait(false);
                },
                requestCancellationToken).ConfigureAwait(false);
        }

        /// <summary>
        /// Executes a coordinator-owned leader with an explicit side-effect boundary.
        /// A leader abandoned before that boundary is removed and one coalesced
        /// follower retries admission; after it, ambiguity is retained as a tombstone.
        /// </summary>
        internal async Task<PlatformIdempotencyOutcome> ExecuteCoordinatedAsync(
            PlatformIdempotencyRequest request,
            Func<PlatformIdempotencyExecution, CancellationToken, Task<PlatformIdempotencyResult>> execute,
            CancellationToken requestCancellationToken)
            => await ExecuteCoreAsync(request, execute, requestCancellationToken).ConfigureAwait(false);

        private async Task<PlatformIdempotencyOutcome> ExecuteCoreAsync(
            PlatformIdempotencyRequest request,
            Func<PlatformIdempotencyExecution, CancellationToken, Task<PlatformIdempotencyResult>> execute,
            CancellationToken requestCancellationToken)
        {
            ArgumentNullException.ThrowIfNull(request);
            ArgumentNullException.ThrowIfNull(execute);
            requestCancellationToken.ThrowIfCancellationRequested();

            var key = new StoreKey(request.ActingUserId, request.Operation, request.Key.Value);
            while (true)
            {
                Task<EntryCompletion>? followerTask = null;
                Entry? leaderEntry = null;
                Entry? followerEntry = null;

                lock (_gate)
                {
                    RemoveExpiredEntries(_timeProvider.GetUtcNow());

                    if (_entries.TryGetValue(key, out var existing))
                    {
                        if (!existing.Fingerprint.Matches(request.Fingerprint))
                        {
                            return new PlatformIdempotencyOutcome(PlatformIdempotencyOutcomeKind.Conflict);
                        }

                        if (existing.State == EntryState.Completed)
                        {
                            return new PlatformIdempotencyOutcome(PlatformIdempotencyOutcomeKind.Replay, existing.Result);
                        }

                        if (existing.State == EntryState.Tombstone)
                        {
                            return new PlatformIdempotencyOutcome(PlatformIdempotencyOutcomeKind.Indeterminate);
                        }

                        if (existing.FollowerCount >= MaximumFollowersPerEntry
                            || _followerCount >= MaximumFollowers)
                        {
                            return new PlatformIdempotencyOutcome(PlatformIdempotencyOutcomeKind.AtCapacity);
                        }

                        existing.FollowerCount++;
                        _followerCount++;
                        followerEntry = existing;
                        followerTask = existing.Completion.Task;
                    }
                    else
                    {
                        if (_entries.Count >= MaximumEntries
                            || _storedBytes + _reservedBytes + request.MaximumResultBytes > MaximumStoredResultBytes)
                        {
                            return new PlatformIdempotencyOutcome(PlatformIdempotencyOutcomeKind.AtCapacity);
                        }

                        leaderEntry = new Entry(request.Fingerprint, request.MaximumResultBytes);
                        _entries.Add(key, leaderEntry);
                        _reservedBytes += request.MaximumResultBytes;
                    }
                }

                if (followerTask is not null)
                {
                    EntryCompletion completion;
                    try
                    {
                        completion = await followerTask.WaitAsync(requestCancellationToken).ConfigureAwait(false);
                    }
                    finally
                    {
                        lock (_gate)
                        {
                            followerEntry!.FollowerCount--;
                            _followerCount--;
                        }
                    }

                    if (completion.Retry)
                    {
                        requestCancellationToken.ThrowIfCancellationRequested();
                        continue;
                    }

                    return completion.Outcome!;
                }

                var execution = new PlatformIdempotencyExecution();
                try
                {
                    requestCancellationToken.ThrowIfCancellationRequested();
                    var result = await execute(execution, requestCancellationToken).ConfigureAwait(false);
                    ArgumentNullException.ThrowIfNull(result);

                    lock (_gate)
                    {
                        _reservedBytes -= leaderEntry!.ReservedBytes;
                        var abandoned = execution.AbandonedResult;
                        if ((abandoned is not null && !ReferenceEquals(abandoned, result))
                            || result.SerializedSizeBytes > leaderEntry.ReservedBytes
                            || result.SerializedSizeBytes > MaximumResultBytes)
                        {
                            MarkTombstone(leaderEntry, _timeProvider.GetUtcNow());
                            return new PlatformIdempotencyOutcome(PlatformIdempotencyOutcomeKind.Indeterminate);
                        }

                        if (abandoned is not null)
                        {
                            _entries.Remove(key);
                            leaderEntry.Completion.TrySetResult(
                                EntryCompletion.FromOutcome(
                                    new PlatformIdempotencyOutcome(
                                        PlatformIdempotencyOutcomeKind.Executed,
                                        abandoned,
                                        wasCoalescedUnstored: true)));
                            return new PlatformIdempotencyOutcome(
                                PlatformIdempotencyOutcomeKind.Executed,
                                abandoned);
                        }

                        leaderEntry.State = EntryState.Completed;
                        leaderEntry.Result = result;
                        leaderEntry.ExpiresAt = _timeProvider.GetUtcNow() + EntryTimeToLive;
                        _storedBytes += result.SerializedSizeBytes;
                        leaderEntry.Completion.TrySetResult(
                            EntryCompletion.FromOutcome(
                                new PlatformIdempotencyOutcome(PlatformIdempotencyOutcomeKind.Replay, result)));
                    }

                    return new PlatformIdempotencyOutcome(PlatformIdempotencyOutcomeKind.Executed, result);
                }
                catch
                {
                    lock (_gate)
                    {
                        _reservedBytes -= leaderEntry!.ReservedBytes;
                        if (execution.SideEffectStarted)
                        {
                            MarkTombstone(leaderEntry, _timeProvider.GetUtcNow());
                        }
                        else
                        {
                            _entries.Remove(key);
                            leaderEntry.Completion.TrySetResult(EntryCompletion.RetryAdmission);
                        }
                    }

                    throw;
                }
            }
        }

        internal int EntryCount
        {
            get
            {
                lock (_gate)
                {
                    RemoveExpiredEntries(_timeProvider.GetUtcNow());
                    return _entries.Count;
                }
            }
        }

        internal int FollowerCount
        {
            get
            {
                lock (_gate)
                {
                    return _followerCount;
                }
            }
        }

        private void MarkTombstone(Entry entry, DateTimeOffset now)
        {
            entry.State = EntryState.Tombstone;
            entry.Result = null;
            entry.ExpiresAt = now + EntryTimeToLive;
            entry.Completion.TrySetResult(
                EntryCompletion.FromOutcome(
                    new PlatformIdempotencyOutcome(PlatformIdempotencyOutcomeKind.Indeterminate)));
        }

        private void RemoveExpiredEntries(DateTimeOffset now)
        {
            List<StoreKey>? expired = null;
            foreach (var pair in _entries)
            {
                var entry = pair.Value;
                if (entry.State != EntryState.InFlight && entry.ExpiresAt <= now)
                {
                    if (entry.State == EntryState.Completed)
                    {
                        _storedBytes -= entry.Result!.SerializedSizeBytes;
                    }

                    (expired ??= new List<StoreKey>()).Add(pair.Key);
                }
            }

            if (expired is not null)
            {
                foreach (var key in expired)
                {
                    _entries.Remove(key);
                }
            }
        }

        private readonly record struct StoreKey(Guid ActingUserId, string Operation, string Key);

        private enum EntryState
        {
            InFlight,
            Completed,
            Tombstone,
        }

        private sealed class Entry
        {
            internal Entry(PlatformSemanticFingerprint fingerprint, int reservedBytes)
            {
                Fingerprint = fingerprint;
                ReservedBytes = reservedBytes;
                Completion = new TaskCompletionSource<EntryCompletion>(
                    TaskCreationOptions.RunContinuationsAsynchronously);
            }

            internal PlatformSemanticFingerprint Fingerprint { get; }

            internal int ReservedBytes { get; }

            internal EntryState State { get; set; }

            internal DateTimeOffset ExpiresAt { get; set; }

            internal PlatformIdempotencyResult? Result { get; set; }

            internal int FollowerCount { get; set; }

            internal TaskCompletionSource<EntryCompletion> Completion { get; }
        }

        private sealed class EntryCompletion
        {
            private EntryCompletion(bool retry, PlatformIdempotencyOutcome? outcome)
            {
                Retry = retry;
                Outcome = outcome;
            }

            internal static EntryCompletion RetryAdmission { get; } = new(true, outcome: null);

            internal bool Retry { get; }

            internal PlatformIdempotencyOutcome? Outcome { get; }

            internal static EntryCompletion FromOutcome(PlatformIdempotencyOutcome outcome)
                => new(false, outcome);
        }
    }
}
