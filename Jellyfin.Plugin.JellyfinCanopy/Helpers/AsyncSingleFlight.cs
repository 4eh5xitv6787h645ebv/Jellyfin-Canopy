using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinCanopy.Helpers
{
    /// <summary>
    /// Starts at most one asynchronous factory for a key and removes only the
    /// exact completed flight. <see cref="ConcurrentDictionary{TKey,TValue}.GetOrAdd(TKey,Func{TKey,TValue})"/>
    /// may invoke its value factory more than once under contention, so the
    /// dictionary stores lazy tasks rather than already-started tasks.
    /// </summary>
    internal static class AsyncSingleFlight
    {
        internal static Task<TValue> GetOrAdd<TKey, TValue>(
            ConcurrentDictionary<TKey, Lazy<Task<TValue>>> inFlight,
            TKey key,
            Func<Task<TValue>> factory)
            where TKey : notnull
        {
            ArgumentNullException.ThrowIfNull(inFlight);
            ArgumentNullException.ThrowIfNull(factory);

            var flight = inFlight.GetOrAdd(
                key,
                _ => new Lazy<Task<TValue>>(
                    factory,
                    LazyThreadSafetyMode.ExecutionAndPublication));

            Task<TValue> task;
            try
            {
                task = flight.Value;
            }
            catch
            {
                // A synchronous factory failure is cached by Lazy. Remove that
                // exact flight so a later call can retry.
                TryRemoveExact(inFlight, key, flight);
                throw;
            }

            // Removal follows completion of the shared work, not completion or
            // cancellation of any individual waiter's WaitAsync call.
            _ = task.ContinueWith(
                _ => TryRemoveExact(inFlight, key, flight),
                CancellationToken.None,
                TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
            return task;
        }

        internal static bool TryRemoveExact<TKey, TValue>(
            ConcurrentDictionary<TKey, TValue> dictionary,
            TKey key,
            TValue value)
            where TKey : notnull
            => ((ICollection<KeyValuePair<TKey, TValue>>)dictionary)
                .Remove(new KeyValuePair<TKey, TValue>(key, value));
    }
}
