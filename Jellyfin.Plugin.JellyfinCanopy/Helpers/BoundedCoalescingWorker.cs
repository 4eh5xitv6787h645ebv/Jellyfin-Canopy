using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinCanopy.Helpers
{
    /// <summary>
    /// A single-consumer, bounded work queue that keeps only the newest value for each key.
    /// Producers never wait: a distinct key is rejected once the fixed state capacity is full,
    /// while updates to an already queued or active key are coalesced in constant time. The
    /// processor must honor its cancellation token: disposal deliberately joins without a timeout
    /// so returning from disposal is proof that no late work remains.
    /// </summary>
    internal sealed class BoundedCoalescingWorker<TKey, TValue> : IDisposable, IAsyncDisposable
        where TKey : notnull
    {
        private readonly object _gate = new();
        private readonly Dictionary<TKey, WorkState> _states;
        private readonly Channel<TKey> _channel;
        private readonly CancellationTokenSource _lifetimeCts = new();
        private readonly Func<TValue, CancellationToken, Task> _processor;
        private readonly Action<Exception>? _failureObserver;
        private readonly int _capacity;
        private readonly int _maximumAttempts;
        private readonly Task _workerTask;
        private long _enqueued;
        private long _coalesced;
        private long _dropped;
        private long _processed;
        private long _failures;
        private long _retried;
        private long _cancelled;
        private int _queued;
        private int _peakQueued;
        private bool _disposed;
        private TaskCompletionSource? _shutdownCompletion;

        public BoundedCoalescingWorker(
            int capacity,
            int maximumAttempts,
            Func<TValue, CancellationToken, Task> processor,
            IEqualityComparer<TKey>? comparer = null,
            Action<Exception>? failureObserver = null)
        {
            if (capacity <= 0) throw new ArgumentOutOfRangeException(nameof(capacity));
            if (maximumAttempts <= 0) throw new ArgumentOutOfRangeException(nameof(maximumAttempts));

            _capacity = capacity;
            _maximumAttempts = maximumAttempts;
            _processor = processor ?? throw new ArgumentNullException(nameof(processor));
            _failureObserver = failureObserver;
            _states = new Dictionary<TKey, WorkState>(capacity, comparer);
            _channel = Channel.CreateBounded<TKey>(new BoundedChannelOptions(capacity)
            {
                SingleReader = true,
                SingleWriter = false,
                FullMode = BoundedChannelFullMode.Wait,
                AllowSynchronousContinuations = false,
            });
            _workerTask = RunAsync();
        }

        public CoalescingWorkerMetrics Metrics
        {
            get
            {
                lock (_gate)
                {
                    return new CoalescingWorkerMetrics(
                        Capacity: _capacity,
                        WorkerTasks: 1,
                        StateCount: _states.Count,
                        QueueDepth: _queued,
                        PeakQueueDepth: _peakQueued,
                        Enqueued: _enqueued,
                        Coalesced: _coalesced,
                        Dropped: _dropped,
                        Processed: _processed,
                        Failures: _failures,
                        Retried: _retried,
                        Cancelled: _cancelled);
                }
            }
        }

        public bool TryEnqueue(TKey key, TValue value)
        {
            lock (_gate)
            {
                if (_disposed)
                {
                    _dropped++;
                    return false;
                }

                if (_states.TryGetValue(key, out var existing))
                {
                    existing.Value = value;
                    existing.Version++;
                    existing.Attempt = 0;
                    _coalesced++;
                    return true;
                }

                if (_states.Count >= _capacity)
                {
                    _dropped++;
                    return false;
                }

                var state = new WorkState(value);
                _states.Add(key, state);
                if (!TryPublishLocked(key, state))
                {
                    _states.Remove(key);
                    _dropped++;
                    return false;
                }

                _enqueued++;
                return true;
            }
        }

        public void Dispose()
        {
            DisposeAsync().AsTask().GetAwaiter().GetResult();
            GC.SuppressFinalize(this);
        }

        public ValueTask DisposeAsync()
        {
            TaskCompletionSource shutdownCompletion;
            lock (_gate)
            {
                if (_shutdownCompletion != null)
                {
                    return new ValueTask(_shutdownCompletion.Task);
                }

                shutdownCompletion = new TaskCompletionSource(
                    TaskCreationOptions.RunContinuationsAsynchronously);
                _shutdownCompletion = shutdownCompletion;
                _disposed = true;
                _cancelled += _states.Count;
                _states.Clear();
                _queued = 0;
                _channel.Writer.TryComplete();
            }

            _ = FinishDisposeAsync(shutdownCompletion);
            return new ValueTask(shutdownCompletion.Task);
        }

        private async Task FinishDisposeAsync(TaskCompletionSource shutdownCompletion)
        {
            Exception? shutdownFailure = null;
            try
            {
                _lifetimeCts.Cancel();
            }
            catch (Exception ex)
            {
                shutdownFailure = ex;
            }

            try
            {
                await _workerTask.ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (_lifetimeCts.IsCancellationRequested)
            {
                // Expected deterministic shutdown path.
            }
            catch (Exception ex)
            {
                shutdownFailure = shutdownFailure == null
                    ? ex
                    : new AggregateException(shutdownFailure, ex);
            }
            finally
            {
                _lifetimeCts.Dispose();
            }

            if (shutdownFailure == null)
            {
                shutdownCompletion.TrySetResult();
            }
            else
            {
                shutdownCompletion.TrySetException(shutdownFailure);
            }
        }

        private async Task RunAsync()
        {
            try
            {
                await foreach (var key in _channel.Reader.ReadAllAsync(_lifetimeCts.Token).ConfigureAwait(false))
                {
                    TValue value;
                    long version;
                    int attempt;
                    lock (_gate)
                    {
                        if (_disposed || !_states.TryGetValue(key, out var state))
                        {
                            continue;
                        }

                        state.Queued = false;
                        _queued--;
                        value = state.Value;
                        version = state.Version;
                        attempt = state.Attempt;
                    }

                    Exception? failure = null;
                    try
                    {
                        await _processor(value, _lifetimeCts.Token).ConfigureAwait(false);
                    }
                    catch (OperationCanceledException) when (_lifetimeCts.IsCancellationRequested)
                    {
                        throw;
                    }
                    catch (Exception ex)
                    {
                        failure = ex;
                        ObserveFailure(ex);
                    }

                    lock (_gate)
                    {
                        if (_disposed || !_states.TryGetValue(key, out var current))
                        {
                            continue;
                        }

                        if (failure == null)
                        {
                            _processed++;
                            if (current.Version == version)
                            {
                                _states.Remove(key);
                            }
                            else
                            {
                                current.Attempt = 0;
                                PublishRequiredLocked(key, current);
                            }

                            continue;
                        }

                        _failures++;
                        if (current.Version != version)
                        {
                            current.Attempt = 0;
                            PublishRequiredLocked(key, current);
                        }
                        else if (attempt + 1 < _maximumAttempts)
                        {
                            current.Attempt = attempt + 1;
                            _retried++;
                            PublishRequiredLocked(key, current);
                        }
                        else
                        {
                            _states.Remove(key);
                        }
                    }

                }
            }
            catch (OperationCanceledException) when (_lifetimeCts.IsCancellationRequested)
            {
                // Expected deterministic shutdown path.
            }
        }

        private bool TryPublishLocked(TKey key, WorkState state)
        {
            if (!_channel.Writer.TryWrite(key)) return false;
            state.Queued = true;
            _queued++;
            if (_queued > _peakQueued) _peakQueued = _queued;
            return true;
        }

        private void ObserveFailure(Exception failure)
        {
            if (_failureObserver == null) return;
            try
            {
                _failureObserver(failure);
            }
            catch
            {
                // Diagnostics must never terminate the bounded worker.
            }
        }

        private void PublishRequiredLocked(TKey key, WorkState state)
        {
            // The channel capacity equals the maximum state count. An active key occupies state
            // capacity but no channel slot, so its replacement/retry always has one reserved slot.
            if (!TryPublishLocked(key, state))
            {
                throw new InvalidOperationException("Coalescing worker lost its reserved channel slot.");
            }
        }

        private sealed class WorkState
        {
            public WorkState(TValue value)
            {
                Value = value;
            }

            public TValue Value { get; set; }

            public long Version { get; set; }

            public int Attempt { get; set; }

            public bool Queued { get; set; }

        }
    }

    internal readonly record struct CoalescingWorkerMetrics(
        int Capacity,
        int WorkerTasks,
        int StateCount,
        int QueueDepth,
        int PeakQueueDepth,
        long Enqueued,
        long Coalesced,
        long Dropped,
        long Processed,
        long Failures,
        long Retried,
        long Cancelled);
}
