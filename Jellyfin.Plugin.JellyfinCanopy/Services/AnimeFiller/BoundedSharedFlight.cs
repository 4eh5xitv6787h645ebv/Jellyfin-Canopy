using System.Collections.Concurrent;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.AnimeFiller;

/// <summary>
/// Coalesces identical work while placing a hard bound on distinct active keys.
/// The shared operation is cancelled once its final caller stops waiting.
/// </summary>
internal sealed class BoundedSharedFlight<TKey, TValue>
    where TKey : notnull
{
    private readonly ConcurrentDictionary<TKey, Entry> _entries;
    private readonly SemaphoreSlim _capacity;

    internal BoundedSharedFlight(int maximumActiveKeys, IEqualityComparer<TKey>? comparer = null)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(maximumActiveKeys);
        _entries = new ConcurrentDictionary<TKey, Entry>(comparer ?? EqualityComparer<TKey>.Default);
        _capacity = new SemaphoreSlim(maximumActiveKeys, maximumActiveKeys);
    }

    internal int ActiveCount => _entries.Count;

    internal async Task<SharedFlightResult<TValue>> RunAsync(
        TKey key,
        Func<CancellationToken, Task<TValue>> factory,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(factory);
        cancellationToken.ThrowIfCancellationRequested();

        while (true)
        {
            if (_entries.TryGetValue(key, out var existing))
            {
                if (existing.TryAddWaiter()) return await AwaitAsync(existing, cancellationToken).ConfigureAwait(false);
                await Task.Yield();
                continue;
            }

            if (!_capacity.Wait(0)) return new SharedFlightResult<TValue>(false, default!);
            var created = new Entry();
            if (!_entries.TryAdd(key, created))
            {
                created.Dispose();
                _capacity.Release();
                continue;
            }

            _ = created.TryAddWaiter();
            _ = created.StartAsync(factory, () => Complete(key, created));
            return await AwaitAsync(created, cancellationToken).ConfigureAwait(false);
        }
    }

    private static async Task<SharedFlightResult<TValue>> AwaitAsync(Entry entry, CancellationToken cancellationToken)
    {
        try
        {
            var value = await entry.Task.WaitAsync(cancellationToken).ConfigureAwait(false);
            return new SharedFlightResult<TValue>(true, value);
        }
        finally
        {
            entry.RemoveWaiter();
        }
    }

    private void Complete(TKey key, Entry entry)
    {
        if (_entries.TryGetValue(key, out var current) && ReferenceEquals(current, entry))
        {
            _entries.TryRemove(key, out _);
            _capacity.Release();
        }

        entry.Dispose();
    }

    private sealed class Entry : IDisposable
    {
        private readonly object _gate = new();
        private readonly CancellationTokenSource _workCancellation = new();
        private readonly TaskCompletionSource<TValue> _completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _waiters;
        private bool _accepting = true;

        internal Task<TValue> Task => _completion.Task;

        internal bool TryAddWaiter()
        {
            lock (_gate)
            {
                if (!_accepting) return false;
                _waiters++;
                return true;
            }
        }

        internal void RemoveWaiter()
        {
            var cancel = false;
            lock (_gate)
            {
                _waiters--;
                if (_waiters == 0 && !_completion.Task.IsCompleted)
                {
                    _accepting = false;
                    cancel = true;
                }
            }

            if (cancel) _workCancellation.Cancel();
        }

        internal async Task StartAsync(Func<CancellationToken, Task<TValue>> factory, Action complete)
        {
            try
            {
                _completion.TrySetResult(await factory(_workCancellation.Token).ConfigureAwait(false));
            }
            catch (OperationCanceledException exception)
            {
                _completion.TrySetCanceled(exception.CancellationToken);
            }
            catch (Exception exception)
            {
                _completion.TrySetException(exception);
            }
            finally
            {
                lock (_gate) _accepting = false;
                complete();
            }
        }

        public void Dispose() => _workCancellation.Dispose();
    }
}

internal readonly record struct SharedFlightResult<TValue>(bool Accepted, TValue Value);
