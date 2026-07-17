using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;

namespace Jellyfin.Plugin.JellyfinCanopy.Services
{
    /// <summary>
    /// Thread-safe, coalescing set of pending tag-cache changes.
    ///
    /// Jellyfin raises ItemAdded/ItemUpdated/ItemRemoved synchronously on the
    /// library-scan thread, once per item, so a single TV scan can name the same
    /// item repeatedly. Recording is O(1) and last-write-wins per id; dependency
    /// expansion later coalesces shared parents on the worker. <see cref="Drain"/> hands
    /// the background worker exactly one unit of work per distinct id instead of one
    /// per event. This is what keeps the heavy per-item rebuild off the scan thread.
    /// </summary>
    internal sealed class TagCachePendingChanges
    {
        // Changed item id -> latest explicit event token. Dependency expansion happens only
        // after Drain, on the background worker, so recording remains O(1).
        private readonly ConcurrentDictionary<Guid, PendingSlot> _pending = new();

        /// <summary>
        /// Record the latest intent for an id. Last write wins, so a removal that
        /// follows an update (or vice-versa) within one window replaces it. Empty
        /// guids (e.g. an episode with no SeasonId) are ignored.
        /// </summary>
        public void Record(Guid id, bool removed)
        {
            Record(new TagCacheChange(
                id,
                null,
                Guid.Empty,
                Guid.Empty,
                Guid.Empty,
                Guid.Empty,
                removed));
        }

        /// <summary>
        /// Record a library event together with its already-materialized relationship ids.
        /// </summary>
        public bool Record(TagCacheChange change)
        {
            if (change.Id == Guid.Empty) return false;
            while (true)
            {
                if (_pending.TryGetValue(change.Id, out var slot))
                {
                    lock (slot)
                    {
                        if (!slot.Active)
                        {
                            continue;
                        }

                        slot.Change = Merge(slot.Change, change);
                        return change.RetryAttempts == 0 || slot.Change.RetryAttempts != 0;
                    }
                }

                var candidate = new PendingSlot(change);
                if (_pending.TryAdd(change.Id, candidate))
                {
                    return true;
                }
            }
        }

        private static TagCacheChange Merge(TagCacheChange existing, TagCacheChange incoming)
        {
            // A retry recorded by the worker must not overwrite a genuine event that arrived
            // while discovery/rebuild was in flight. Conversely, a later genuine event resets
            // the retry budget and keeps normal last-write-wins intent.
            if (incoming.RetryAttempts != 0 && existing.RetryAttempts == 0)
            {
                return existing;
            }

            // The cache still represents the relationship present before this debounce window.
            // Preserve that earliest parent while taking the latest current parent/intent. This
            // fixed-size merge stays O(1) and repairs both sides of Episode reparenting.
            return incoming with
            {
                PreviousSeriesId = FirstNonEmpty(existing.PreviousSeriesId, incoming.PreviousSeriesId),
                PreviousSeasonId = FirstNonEmpty(existing.PreviousSeasonId, incoming.PreviousSeasonId),
                RetryAttempts = incoming.RetryAttempts == 0
                    ? (byte)0
                    : existing.RetryAttempts >= incoming.RetryAttempts
                        ? existing.RetryAttempts
                        : incoming.RetryAttempts,
            };
        }

        private static Guid FirstNonEmpty(Guid left, Guid right)
            => left != Guid.Empty ? left : right;

        public bool IsEmpty => _pending.IsEmpty;

        public int Count => _pending.Count;

        /// <summary>
        /// Remove and return every pending change. A concurrent record is either merged
        /// into the slot this drain returns or observes the retired slot and creates one
        /// for the next drain, so no change is lost at the handoff boundary.
        /// </summary>
        public IReadOnlyList<TagCacheChange> Drain()
        {
            var batch = new List<TagCacheChange>(_pending.Count);
            foreach (var id in _pending.Keys.ToList())
            {
                if (_pending.TryRemove(id, out var slot))
                {
                    lock (slot)
                    {
                        slot.Active = false;
                        batch.Add(slot.Change);
                    }
                }
            }

            return batch;
        }

        private sealed class PendingSlot
        {
            public PendingSlot(TagCacheChange change)
            {
                Change = change;
            }

            public TagCacheChange Change { get; set; }

            public bool Active { get; set; } = true;
        }
    }
}
