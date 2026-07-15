using System;
using System.Collections;
using System.Collections.Generic;

namespace Jellyfin.Plugin.JellyfinCanopy.Helpers
{
    /// <summary>
    /// Thread-safe, weighted LRU cache with per-entry TTLs and hard capacity
    /// limits. Reads, writes and eviction are O(1) amortized; insertion never
    /// scans the complete cache.
    /// </summary>
    public sealed class BoundedTtlCache<TKey, TValue> : IReadOnlyCollection<KeyValuePair<TKey, TValue>>
        where TKey : notnull
    {
        private const int InsertMaintenanceBudget = 4;

        private readonly object _gate = new();
        private readonly Dictionary<TKey, Entry> _entries;
        private readonly LinkedList<TKey> _lru = new();
        private readonly Func<TKey, TValue, long> _weight;
        private readonly Func<TimeSpan> _defaultTtl;
        private readonly TimeProvider _timeProvider;
        private long _nextVersion;
        private long _totalWeight;
        private long _entryInspections;

        public BoundedTtlCache(
            int maximumEntries,
            long maximumWeight,
            Func<TKey, TValue, long>? weight = null,
            IEqualityComparer<TKey>? comparer = null,
            TimeProvider? timeProvider = null,
            Func<TimeSpan>? defaultTtl = null)
        {
            ArgumentOutOfRangeException.ThrowIfNegativeOrZero(maximumEntries);
            ArgumentOutOfRangeException.ThrowIfNegativeOrZero(maximumWeight);

            MaximumEntries = maximumEntries;
            MaximumWeight = maximumWeight;
            _weight = weight ?? UnitWeight;
            _defaultTtl = defaultTtl ?? DefaultTtl;
            _entries = new Dictionary<TKey, Entry>(comparer);
            _timeProvider = timeProvider ?? TimeProvider.System;
        }

        public int MaximumEntries { get; }

        public long MaximumWeight { get; }

        public TValue this[TKey key]
        {
            get => TryGet(key, out var value)
                ? value
                : throw new KeyNotFoundException($"Cache key '{key}' was not found.");
            set => Set(key, value, _defaultTtl());
        }

        public IReadOnlyCollection<TKey> Keys
        {
            get
            {
                lock (_gate)
                {
                    MaintainUnderLock(_entries.Count);
                    return new List<TKey>(_entries.Keys);
                }
            }
        }

        public IReadOnlyCollection<TValue> Values
        {
            get
            {
                lock (_gate)
                {
                    MaintainUnderLock(_entries.Count);
                    var values = new List<TValue>(_entries.Count);
                    foreach (var entry in _entries.Values)
                    {
                        values.Add(entry.Value);
                    }

                    return values;
                }
            }
        }

        public int Count
        {
            get
            {
                lock (_gate)
                {
                    return _entries.Count;
                }
            }
        }

        public long TotalWeight
        {
            get
            {
                lock (_gate)
                {
                    return _totalWeight;
                }
            }
        }

        internal long EntryInspections
        {
            get
            {
                lock (_gate)
                {
                    return _entryInspections;
                }
            }
        }

        public bool TryGet(TKey key, out TValue value)
        {
            lock (_gate)
            {
                if (!_entries.TryGetValue(key, out var entry))
                {
                    value = default!;
                    return false;
                }

                _entryInspections++;
                if (entry.ExpiresAt <= _timeProvider.GetUtcNow())
                {
                    RemoveEntry(entry);
                    value = default!;
                    return false;
                }

                Touch(entry);
                value = entry.Value;
                return true;
            }
        }

        public bool TryGetValue(TKey key, out TValue value) => TryGet(key, out value);

        public bool Set(TKey key, TValue value, TimeSpan ttl)
            => TrySet(key, value, ttl, out _);

        public bool TrySet(TKey key, TValue value, out CacheToken token)
            => TrySet(key, value, _defaultTtl(), out token);

        public bool TryAdd(TKey key, TValue value)
            => TryAdd(key, value, _defaultTtl(), out _);

        public bool TryAdd(TKey key, TValue value, TimeSpan ttl, out CacheToken token)
        {
            if (ttl <= TimeSpan.Zero)
            {
                token = default;
                return false;
            }

            var weight = _weight(key, value);
            if (weight < 0)
            {
                throw new InvalidOperationException("Cache entry weight cannot be negative.");
            }

            lock (_gate)
            {
                if (_entries.TryGetValue(key, out var current))
                {
                    _entryInspections++;
                    if (current.ExpiresAt > _timeProvider.GetUtcNow())
                    {
                        Touch(current);
                        token = default;
                        return false;
                    }

                    RemoveEntry(current);
                }

                return TrySetUnderLock(key, value, ttl, weight, out token);
            }
        }

        public bool TrySet(TKey key, TValue value, TimeSpan ttl, out CacheToken token)
        {
            if (ttl <= TimeSpan.Zero)
            {
                Remove(key);
                token = default;
                return false;
            }

            var weight = _weight(key, value);
            if (weight < 0)
            {
                throw new InvalidOperationException("Cache entry weight cannot be negative.");
            }

            lock (_gate)
            {
                return TrySetUnderLock(key, value, ttl, weight, out token);
            }
        }

        public bool Remove(TKey key)
        {
            lock (_gate)
            {
                if (!_entries.TryGetValue(key, out var entry))
                {
                    return false;
                }

                RemoveEntry(entry);
                return true;
            }
        }

        public bool Remove(CacheToken token)
        {
            lock (_gate)
            {
                if (token.Version <= 0
                    || !_entries.TryGetValue(token.Key, out var entry)
                    || entry.Version != token.Version)
                {
                    return false;
                }

                RemoveEntry(entry);
                return true;
            }
        }

        public bool Remove(TKey key, TValue expectedValue)
        {
            lock (_gate)
            {
                if (!_entries.TryGetValue(key, out var entry))
                {
                    return false;
                }

                _entryInspections++;
                if (entry.ExpiresAt <= _timeProvider.GetUtcNow())
                {
                    RemoveEntry(entry);
                    return false;
                }

                if (!EqualityComparer<TValue>.Default.Equals(entry.Value, expectedValue))
                {
                    return false;
                }

                RemoveEntry(entry);
                return true;
            }
        }

        public bool ContainsKey(TKey key) => TryGet(key, out _);

        public bool TryRemove(TKey key, out TValue value)
        {
            lock (_gate)
            {
                if (!_entries.TryGetValue(key, out var entry))
                {
                    value = default!;
                    return false;
                }

                _entryInspections++;
                if (entry.ExpiresAt <= _timeProvider.GetUtcNow())
                {
                    RemoveEntry(entry);
                    value = default!;
                    return false;
                }

                value = entry.Value;
                RemoveEntry(entry);
                return true;
            }
        }

        /// <summary>
        /// Atomically adds or updates a live entry. Factories execute under the
        /// cache lock and must not call back into this cache. The returned value
        /// is the computed value even when its weight exceeds the cache budget
        /// and therefore cannot be retained.
        /// </summary>
        public TValue AddOrUpdate(
            TKey key,
            Func<TKey, TValue> addValueFactory,
            Func<TKey, TValue, TValue> updateValueFactory)
        {
            lock (_gate)
            {
                TValue value;
                if (_entries.TryGetValue(key, out var current)
                    && current.ExpiresAt > _timeProvider.GetUtcNow())
                {
                    _entryInspections++;
                    value = updateValueFactory(key, current.Value);
                }
                else
                {
                    if (current != null)
                    {
                        _entryInspections++;
                        RemoveEntry(current);
                    }

                    value = addValueFactory(key);
                }

                var weight = _weight(key, value);
                if (weight < 0)
                {
                    throw new InvalidOperationException("Cache entry weight cannot be negative.");
                }

                TrySetUnderLock(key, value, _defaultTtl(), weight, out _);
                return value;
            }
        }

        public int Maintain(int maximumEntriesToInspect = 64)
        {
            ArgumentOutOfRangeException.ThrowIfNegative(maximumEntriesToInspect);
            lock (_gate)
            {
                return MaintainUnderLock(maximumEntriesToInspect);
            }
        }

        public void Clear()
        {
            lock (_gate)
            {
                _entries.Clear();
                _lru.Clear();
                _totalWeight = 0;
            }
        }

        internal IReadOnlyList<KeyValuePair<TKey, TValue>> Snapshot()
        {
            lock (_gate)
            {
                MaintainUnderLock(_entries.Count);
                var snapshot = new List<KeyValuePair<TKey, TValue>>(_entries.Count);
                foreach (var key in _lru)
                {
                    if (_entries.TryGetValue(key, out var entry))
                    {
                        snapshot.Add(new KeyValuePair<TKey, TValue>(key, entry.Value));
                    }
                }

                return snapshot;
            }
        }

        public IEnumerator<KeyValuePair<TKey, TValue>> GetEnumerator()
            => Snapshot().GetEnumerator();

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();

        private int MaintainUnderLock(int maximumEntriesToInspect)
        {
            var removed = 0;
            var inspected = 0;
            var now = _timeProvider.GetUtcNow();
            var node = _lru.First;
            while (node != null && inspected < maximumEntriesToInspect)
            {
                var next = node.Next;
                if (_entries.TryGetValue(node.Value, out var entry))
                {
                    inspected++;
                    _entryInspections++;
                    if (entry.ExpiresAt <= now)
                    {
                        RemoveEntry(entry);
                        removed++;
                    }
                }

                node = next;
            }

            return removed;
        }

        private static long UnitWeight(TKey key, TValue value) => 1;

        private static TimeSpan DefaultTtl() => TimeSpan.FromMinutes(5);

        private bool TrySetUnderLock(
            TKey key,
            TValue value,
            TimeSpan ttl,
            long weight,
            out CacheToken token)
        {
            if (_entries.TryGetValue(key, out var previous))
            {
                RemoveEntry(previous);
            }

            if (weight > MaximumWeight || ttl <= TimeSpan.Zero)
            {
                token = default;
                return false;
            }

            MaintainUnderLock(InsertMaintenanceBudget);
            var node = _lru.AddLast(key);
            var version = ++_nextVersion;
            var entry = new Entry(
                key,
                value,
                weight,
                _timeProvider.GetUtcNow() + ttl,
                version,
                node);
            _entries.Add(key, entry);
            _totalWeight += weight;

            while (_entries.Count > MaximumEntries || _totalWeight > MaximumWeight)
            {
                var oldest = _lru.First;
                if (oldest == null || !_entries.TryGetValue(oldest.Value, out var eviction))
                {
                    throw new InvalidOperationException("Bounded cache LRU index is inconsistent.");
                }

                _entryInspections++;
                RemoveEntry(eviction);
            }

            if (!_entries.TryGetValue(key, out var retained) || retained.Version != version)
            {
                token = default;
                return false;
            }

            token = new CacheToken(key, version);
            return true;
        }

        private void Touch(Entry entry)
        {
            _lru.Remove(entry.Node);
            _lru.AddLast(entry.Node);
        }

        private void RemoveEntry(Entry entry)
        {
            if (!_entries.Remove(entry.Key))
            {
                return;
            }

            _lru.Remove(entry.Node);
            _totalWeight -= entry.Weight;
        }

        public readonly record struct CacheToken(TKey Key, long Version);

        private sealed record Entry(
            TKey Key,
            TValue Value,
            long Weight,
            DateTimeOffset ExpiresAt,
            long Version,
            LinkedListNode<TKey> Node);
    }
}
