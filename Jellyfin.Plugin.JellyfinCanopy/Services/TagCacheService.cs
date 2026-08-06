using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Jellyfin.Plugin.JellyfinCanopy.Model;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services
{
    internal delegate bool TagCachePublicationFence();

    /// <summary>
    /// Manages a server-side pre-computed tag cache for all library items.
    /// The cache is stored in memory (ConcurrentDictionary) and persisted to disk as JSON.
    /// Clients fetch the full cache in one GET request instead of making per-page batch calls.
    /// </summary>
    public class TagCacheService : IDisposable
    {
        private readonly ILibraryManager _libraryManager;
        private readonly IApplicationPaths _applicationPaths;
        private readonly ILogger<TagCacheService> _logger;
        private readonly ILinkedChildrenService? _linkedChildrenService;
        private volatile ConcurrentDictionary<string, TagCacheEntry> _cache = new();
        private volatile Dictionary<Guid, Guid[]> _collectionMembers = new();
        private volatile Dictionary<Guid, Guid[]> _collectionParents = new();
        private volatile HashSet<Guid> _unindexedCollections = new();
        private readonly object _contentGate = new();
        private readonly string _contentEpoch = Guid.NewGuid().ToString("N");
        private readonly ContentChange?[] _contentJournal;
        private int _contentJournalStart;
        private int _contentJournalCount;
        private long _contentRevision;
        private long _servedContentIdsVisited;
        internal const int DefaultContentJournalCapacity = 4096;

        private sealed class ContentChange
        {
            public ContentChange(long revision, string itemId, bool removed)
            {
                Revision = revision;
                ItemId = itemId;
                Removed = removed;
            }

            public long Revision { get; }

            public string ItemId { get; }

            public bool Removed { get; }
        }

        private sealed class ServedContentState
        {
            // This is deliberately an "ever served in this process epoch" set. A
            // later device/request must not erase the proof an older browser needs
            // to receive a tombstone. The outer cache supplies the hard memory/TTL
            // bound; an evicted state receives resetRequired rather than raw ids.
            public HashSet<string> VisibleIds { get; } = new(StringComparer.Ordinal);
        }

        internal sealed class ContentDelta
        {
            public ContentDelta(
                string epoch,
                long revision,
                bool resetRequired,
                Dictionary<string, TagCacheEntry> items,
                string[] removedIds,
                int journalRowsVisited)
            {
                Epoch = epoch;
                Revision = revision;
                ResetRequired = resetRequired;
                Items = items;
                RemovedIds = removedIds;
                JournalRowsVisited = journalRowsVisited;
            }

            public string Epoch { get; }

            public long Revision { get; }

            public bool ResetRequired { get; }

            public Dictionary<string, TagCacheEntry> Items { get; }

            public string[] RemovedIds { get; }

            public int JournalRowsVisited { get; }
        }

        private static readonly TimeSpan ServedContentStateTtl = TimeSpan.FromHours(24);
        private readonly BoundedTtlCache<string, ServedContentState> _servedContentStates = new(
            maximumEntries: 2_048,
            maximumWeight: 2_000_000,
            weight: static (key, state) => key.Length + state.VisibleIds.Count,
            comparer: StringComparer.Ordinal,
            defaultTtl: () => ServedContentStateTtl);
        private readonly object _saveLock = new();
        private long _version;
        private long _lastModified;
        private Timer? _debounceSaveTimer;
        private volatile bool _dirty;
        // Monotonic counter bumped every time the cache is marked dirty. SaveToDisk captures it
        // BEFORE its snapshot and only clears _dirty if it is unchanged afterwards, so a flush that
        // dirties the cache AFTER the snapshot (but before the clear) is never wiped — its change
        // stays scheduled for the next save instead of being silently dropped.
        private long _dirtyVersion;

        // Test seam (Tests has InternalsVisibleTo): invoked inside SaveToDisk immediately AFTER the
        // cache/version snapshot and BEFORE the dirty-bit clear, so a test can deterministically
        // simulate a flush landing in that exact window.
        internal Action? OnAfterSnapshotForTest;

        // Test seam after disk bytes are read but before their deserialized snapshot
        // can cross the lifecycle generation fence.
        internal Action? OnAfterDiskReadForTest;

        internal Action? OnBeforeCachePersistForTest;

        // Test seam: invoked inside BuildFullCache while the flush guard is held, just BEFORE the
        // cache swap, so a test can simulate an incremental flush firing mid-rebuild.
        internal Action? OnBeforeSwapForTest;

        // Test seam after the pending-container handoff has completed under _lifecycleGate but
        // before its O(N) drain starts. Tests park the worker here to prove scan-thread enqueue is
        // not held behind handoff materialization.
        internal Action? OnBeforePendingHandoffDrainForTest;

        // Test seam after rollback has validated its lifecycle generation and captured the live
        // target, but before its O(N) older-prefix replay begins outside _lifecycleGate.
        internal Action? OnBeforePendingRestoreReplayForTest;

        // Test seam: invoked inside FlushPending after the batch is applied but BEFORE the flush
        // guard (_flushing) is released, so a test can park a flush in the "drained + applied, still
        // holding the guard" state and drive the rebuild against it deterministically.
        internal Action? OnAfterFlushApplyForTest;

        // Test seam after a user-access cache miss and before joining the
        // per-user singleflight. A delayed miss must re-check the cache inside
        // the winning Lazy so it cannot query after another flight publishes.
        internal Action? OnAfterUserAccessCacheMissForTest;

        // Incremental cache maintenance. Library-scan events are recorded here (O(1),
        // no DB/probe work) and drained by a debounced background worker so scans are
        // never blocked and repeated hits on the same id coalesce to one rebuild.
        private TagCachePendingChanges _pending = new();
        private readonly object _lifecycleGate = new();
        private Timer? _flushTimer;
        private long _firstPendingTicks; // 0 = nothing pending since last flush
        private int _flushing;           // 0/1 non-reentrancy guard for the worker
        private int _disposed;           // 0/1; prevents timer resurrection during shutdown
        private int _suspended;          // 0/1; disabled server mode accepts no work
        private long _lifecycleGeneration;
        private long _retryBackoffTicks;
        private long _removedDependencyEntriesVisited;
        private long _collectionReverseRebuildsForTest;
        private int _repairIncomplete;
        private long _libraryEventGeneration;
        private int _loadFromDiskCalls;
        private int _saveToDiskCalls;
        private static readonly TimeSpan FlushDebounce = TimeSpan.FromSeconds(3);
        private static readonly TimeSpan FlushMaxWait = TimeSpan.FromSeconds(30);
        internal const int FullCachePageSize = 500;

        private sealed class MonitorLease : IDisposable
        {
            private object? _gate;

            public MonitorLease(object gate)
            {
                _gate = gate;
            }

            public void Dispose()
            {
                var gate = Interlocked.Exchange(ref _gate, null);
                if (gate != null)
                {
                    Monitor.Exit(gate);
                }
            }
        }

        // Spin budget the full rebuild uses to acquire the flush guard (spins × 10ms ≈ 30s). Far
        // larger than Dispose's 5s default: a rebuild that can't take the guard must NOT fall back
        // to a lossy swap (see BuildFullCache), so it waits out an in-flight flush instead. A field
        // (not a const) only so a test can shrink it to exercise the wait/abort path without a real
        // multi-second wait.
        private int _rebuildFlushGuardSpins = 3000;
        internal void SetRebuildFlushGuardSpinsForTest(int spins) => _rebuildFlushGuardSpins = spins;
        private int _disposeFlushGuardSpins = 500;
        internal void SetDisposeFlushGuardSpinsForTest(int spins) => _disposeFlushGuardSpins = spins;

        // Bump whenever a TagCacheEntry field the STRIP paths depend on is added,
        // so a cache serialized by an older build is discarded and rebuilt. v2
        // added SeriesId, which the Spoiler Guard tag-strip requires: a v1 cache
        // has null SeriesId on every episode, so the strip skips them and unstripped
        // ratings leak onto guarded cards via renderFromServerCache. Discarding
        // starts empty (client falls back to the live/per-batch strip) until rebuild.
        // v3 adds persisted Episode SeasonId and stream-source identity. Both are
        // correctness-critical dependency metadata, so older entries are rebuilt.
        // v4 added stream Width so cropped DCI 8K is distinguishable from 4K
        // (#681). v5 additionally invalidates rows produced by the former
        // CommunityRating-only inheritance check, which could overwrite a
        // child's valid CriticRating of 0 or 7 (#682). v6 projects audio
        // default/index/source identity for deterministic live/cache parity
        // when selecting one preferred-language quality track (#664). v7 adds a
        // complete, validated BoxSet forward-membership snapshot plus explicit
        // over-cap/unavailable sentinels; its derived reverse map lets Movie
        // removal/move invalidation survive restart after live old edges disappear.
        private const int CurrentCacheSchemaVersion = 7;

        // User access cache: avoids expensive GetItemIds query on every request.
        // Jellyfin increments User.RowVersion for every persisted policy update,
        // including EnabledFolders/EnableAllFolders. The authorization generation
        // must therefore be part of both the cache and singleflight key: a request
        // under generation R+1 may never join or reuse work started under R.
        private static readonly TimeSpan UserAccessCacheTtl = TimeSpan.FromSeconds(60);
        private readonly BoundedTtlCache<string, (HashSet<string> Ids, DateTime CachedAt)> _userAccessCache = new(
            maximumEntries: 2_048,
            maximumWeight: 2_000_000,
            weight: static (key, entry) => key.Length + entry.Ids.Count,
            comparer: StringComparer.Ordinal,
            defaultTtl: () => UserAccessCacheTtl);
        private readonly ConcurrentDictionary<string, Lazy<HashSet<string>>> _userAccessInFlight = new(StringComparer.Ordinal);

        public static readonly HashSet<BaseItemKind> TaggableTypes = new()
        {
            BaseItemKind.Movie,
            BaseItemKind.Episode,
            BaseItemKind.Series,
            BaseItemKind.Season,
            BaseItemKind.BoxSet,
        };

        public TagCacheService(ILibraryManager libraryManager, IApplicationPaths applicationPaths, ILogger<TagCacheService> logger)
            : this(libraryManager, applicationPaths, logger, null, DefaultContentJournalCapacity)
        {
        }

        public TagCacheService(
            ILibraryManager libraryManager,
            IApplicationPaths applicationPaths,
            ILogger<TagCacheService> logger,
            ILinkedChildrenService linkedChildrenService)
            : this(libraryManager, applicationPaths, logger, linkedChildrenService, DefaultContentJournalCapacity)
        {
        }

        internal TagCacheService(
            ILibraryManager libraryManager,
            IApplicationPaths applicationPaths,
            ILogger<TagCacheService> logger,
            int contentJournalCapacity)
            : this(libraryManager, applicationPaths, logger, null, contentJournalCapacity)
        {
        }

        internal TagCacheService(
            ILibraryManager libraryManager,
            IApplicationPaths applicationPaths,
            ILogger<TagCacheService> logger,
            ILinkedChildrenService? linkedChildrenService,
            int contentJournalCapacity)
        {
            if (contentJournalCapacity <= 0)
            {
                throw new ArgumentOutOfRangeException(nameof(contentJournalCapacity));
            }

            _libraryManager = libraryManager;
            _applicationPaths = applicationPaths;
            _logger = logger;
            _linkedChildrenService = linkedChildrenService;
            _contentJournal = new ContentChange[contentJournalCapacity];
        }

        internal IReadOnlyList<Guid> GetCollectionMemberIds(Guid collectionId)
            => _linkedChildrenService?.GetLinkedChildrenIds(collectionId, (int)LinkedChildType.Manual)
                ?? throw new InvalidOperationException("Linked-children relationship service is unavailable.");

        internal IReadOnlyList<Guid> GetCollectionParentIds(Guid movieId)
            => _linkedChildrenService?.GetManualLinkedParentIds(movieId, BaseItemKind.BoxSet)
                ?? throw new InvalidOperationException("Linked-children relationship service is unavailable.");

        public long Version
        {
            get
            {
                lock (_contentGate)
                {
                    return Interlocked.Read(ref _version);
                }
            }
        }

        public long LastModified
        {
            get
            {
                lock (_contentGate)
                {
                    return Interlocked.Read(ref _lastModified);
                }
            }
        }

        public int Count
        {
            get
            {
                lock (_contentGate)
                {
                    return _cache.Count;
                }
            }
        }
        internal long ContentRevision => Interlocked.Read(ref _contentRevision);
        internal long ServedContentIdsVisited => Interlocked.Read(ref _servedContentIdsVisited);
        internal void SetLegacyTimestampForTest(long timestamp)
            => Interlocked.Exchange(ref _lastModified, timestamp);

        // Test seams for the user-access cache invalidation contract (Tests has InternalsVisibleTo).
        internal int UserAccessCacheCount => _userAccessCache.Count;

        internal void SeedUserAccessCacheForTest(string userKey, params string[] itemIds)
            => _userAccessCache[AuthorizationKey(userKey, 0)] = (
                new HashSet<string>(itemIds, StringComparer.Ordinal),
                DateTime.UtcNow);

        internal void FlushPendingForTest() => FlushPending();

        internal int PendingChangeCountForTest => Volatile.Read(ref _pending).Count;

        internal IReadOnlyList<TagCacheChange> DrainPendingForTest() => Volatile.Read(ref _pending).Drain();

        internal bool HasFlushTimerForTest => Volatile.Read(ref _flushTimer) != null;

        internal bool IsSuspendedForTest => Volatile.Read(ref _suspended) != 0;

        internal int LoadFromDiskCallsForTest => Volatile.Read(ref _loadFromDiskCalls);

        internal int SaveToDiskCallsForTest => Volatile.Read(ref _saveToDiskCalls);

        internal long RemovedDependencyEntriesVisitedForTest
            => Interlocked.Read(ref _removedDependencyEntriesVisited);

        internal long CollectionReverseRebuildsForTest
            => Interlocked.Read(ref _collectionReverseRebuildsForTest);

        internal bool IsContentGateHeldByCurrentThreadForTest => Monitor.IsEntered(_contentGate);

        internal bool ContainsKeyForTest(string key) => _cache.ContainsKey(key);

        internal void SeedEntryForTest(string key, TagCacheEntry entry) => _cache[key] = entry;

        internal void SeedCollectionMembershipForTest(Guid collectionId, params Guid[] memberIds)
        {
            var replacement = new Dictionary<Guid, Guid[]>(_collectionMembers)
            {
                [collectionId] = memberIds.Distinct().OrderBy(static id => id).ToArray(),
            };
            _collectionMembers = replacement;
            _collectionParents = BuildCollectionParents(replacement);
            var unindexed = new HashSet<Guid>(_unindexedCollections);
            unindexed.Remove(collectionId);
            _unindexedCollections = unindexed;
        }

        internal void SeedUnindexedCollectionForTest(Guid collectionId)
        {
            var unindexed = new HashSet<Guid>(_unindexedCollections) { collectionId };
            _unindexedCollections = unindexed;
        }

        internal bool IsCollectionUnindexedForTest(Guid collectionId)
            => _unindexedCollections.Contains(collectionId);

        internal IReadOnlyList<Guid> GetIndexedCollectionMembersForTest(Guid collectionId)
            => _collectionMembers.TryGetValue(collectionId, out var members)
                ? members
                : Array.Empty<Guid>();

        // Deterministic controller-cursor race seams. A test captures the reader's
        // dictionary, then swaps the live cache/cursor exactly where a reconcile can.
        internal Action? OnAfterUserCacheSnapshotForTest;

        internal void SwapCacheAndCursorForTest(
            IReadOnlyDictionary<string, TagCacheEntry> entries,
            long version,
            long lastModified)
        {
            lock (_contentGate)
            {
                _cache = new ConcurrentDictionary<string, TagCacheEntry>(entries, StringComparer.Ordinal);
                _collectionMembers = new Dictionary<Guid, Guid[]>();
                _collectionParents = new Dictionary<Guid, Guid[]>();
                _unindexedCollections = new HashSet<Guid>();
                Interlocked.Exchange(ref _version, version);
                Interlocked.Exchange(ref _lastModified, lastModified);
            }
        }

        internal void PublishUpsertForTest(string key, TagCacheEntry entry)
        {
            lock (_contentGate)
            {
                _cache[key] = entry;
                RecordContentChangeLocked(key, removed: false);
            }
        }

        internal void PublishRemovalForTest(string key)
        {
            lock (_contentGate)
            {
                _cache.TryRemove(key, out _);
                RecordContentChangeLocked(key, removed: true);
            }
        }

        // Read the live cache entry for a key (or null). Lets reconcile tests assert reference
        // identity (proving an unchanged item was reused, not re-probed) and timestamp retention.
        internal TagCacheEntry? GetEntryForTest(string key) => _cache.TryGetValue(key, out var e) ? e : null;

        private string CacheFilePath =>
            Path.Combine(_applicationPaths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinCanopy", "tag-cache.json");

        private string RepairMarkerPath => CacheFilePath + ".incomplete";

        /// <summary>
        /// Reconcile the tag cache against the current library. Called by the scheduled task
        /// (daily / manual) and by the first-install build. Rather than rebuilding every entry,
        /// it reuses the existing entry for any item whose source revision
        /// (<see cref="BaseItem.DateLastSaved"/>) is unchanged — skipping the media probe — and
        /// only (re)builds new or changed items, drops items no longer in the library, and bumps
        /// <see cref="Version"/> (the client's full-reload signal) only when something is actually
        /// removed. Containers (Series/Season) derive from their child episodes, which their own
        /// timestamp does not track, so they are always rebuilt; a structural comparison then
        /// retains the old timestamp when nothing really changed, so the client delta doesn't churn.
        /// </summary>
        public void BuildFullCache(IProgress<double>? progress, CancellationToken cancellationToken)
            => BuildFullCache(progress, cancellationToken, canPublish: null);

        /// <summary>
        /// Build a private replacement through fixed-size library pages. When supplied,
        /// <paramref name="canPublish"/> owns the lifecycle generation fence and is
        /// rechecked under the content gate before the complete swap/journal/save action.
        /// A failed page, cancellation, persistence failure, or rejected fence leaves the live
        /// cache and its disk snapshot untouched.
        /// </summary>
        internal bool BuildFullCache(
            IProgress<double>? progress,
            CancellationToken cancellationToken,
            TagCachePublicationFence? canPublish)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (Volatile.Read(ref _suspended) != 0)
            {
                _logger.LogInformation("[TagCache] Reconcile skipped while server cache mode is disabled.");
                return false;
            }

            _logger.LogInformation("[TagCache] Starting bounded cache reconcile...");
            var sw = System.Diagnostics.Stopwatch.StartNew();

            // The guard is acquired before the first page so a flush that already drained
            // its queue cannot be lost at publication. Cancellation interrupts the bounded
            // wait instead of sleeping for the former fixed ~30 second window.
            if (!AcquireFlushGuard(
                    maxSpins: _rebuildFlushGuardSpins,
                    spinMs: 10,
                    cancellationToken))
            {
                _logger.LogWarning("[TagCache] Skipping reconcile: an incremental flush still owns the writer guard.");
                return false;
            }

            try
            {
                var oldCache = _cache;
                var newCache = new ConcurrentDictionary<string, TagCacheEntry>(StringComparer.Ordinal);
                var newCollectionMembers = new Dictionary<Guid, Guid[]>();
                var newUnindexedCollections = new HashSet<Guid>();
                var changed = false;
                var processed = 0;
                var changedCollectionParents = new HashSet<Guid>();
                var changedMovieIds = new HashSet<Guid>();
                var eventGeneration = Interlocked.Read(ref _libraryEventGeneration);

                // Resolve Series first in its own bounded pass. Episode inheritance can
                // then use this authoritative parent snapshot without a scalar database
                // lookup per episode, while only Series rows plus one input page coexist
                // with the old and replacement dictionaries.
                ReadPages(new[] { BaseItemKind.Series });
                ReadPages(
                    TaggableTypes.Where(static kind => kind != BaseItemKind.Series).ToArray());

                foreach (var pair in oldCache)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (!newCache.ContainsKey(pair.Key)
                        && string.Equals(pair.Value.Type, nameof(BaseItemKind.Movie), StringComparison.Ordinal)
                        && Guid.TryParseExact(pair.Key, "N", out var removedMovieId))
                    {
                        changedMovieIds.Add(removedMovieId);
                    }
                }
                var newCollectionParents = BuildCollectionParents(newCollectionMembers);
                if (newCollectionMembers.Count != _collectionMembers.Count
                    || newCollectionMembers.Keys.Any(id => CollectionMembershipChanged(id, _collectionMembers, newCollectionMembers))
                    || !_unindexedCollections.SetEquals(newUnindexedCollections))
                {
                    changed = true;
                }
                foreach (var movieId in changedMovieIds)
                {
                    AddKnownParents(_collectionParents, movieId, changedCollectionParents);
                    AddKnownParents(newCollectionParents, movieId, changedCollectionParents);
                }

                cancellationToken.ThrowIfCancellationRequested();
                if (Interlocked.Read(ref _libraryEventGeneration) != eventGeneration)
                {
                    throw new InvalidOperationException("The Jellyfin library changed during tag-cache paging; the unpublished replacement was discarded to avoid an offset-page omission.");
                }

                OnBeforeSwapForTest?.Invoke();
                cancellationToken.ThrowIfCancellationRequested();

                // Drain and fully prepare the handoff while the single-writer guard is held
                // but before entering _contentGate. Host relationship/library reads and the
                // one reverse-map rebuild for this batch must never extend the publication lock.
                var detachedPending = DetachPendingForHandoff(out var handoffGeneration);
                OnBeforePendingHandoffDrainForTest?.Invoke();
                var pendingBatch = detachedPending.Drain();
                PendingBatchPlan pendingPlan;
                try
                {
                    pendingPlan = PreparePendingBatch(
                        pendingBatch,
                        newCache,
                        newCollectionMembers,
                        newCollectionParents,
                        newUnindexedCollections);
                }
                catch
                {
                    RestoreDrainedPendingBatch(pendingBatch, handoffGeneration);
                    throw;
                }

                var removed = false;
                var drainRemoved = false;
                bool Publish()
                {
                    // Publish the swap and journal under one gate. Derive upserts and
                    // removals directly from the two required snapshots instead of
                    // retaining additional O(N) id lists.
                    lock (_contentGate)
                    {
                        if (Volatile.Read(ref _disposed) != 0
                            || Volatile.Read(ref _suspended) != 0
                            || (canPublish != null && !canPublish()))
                        {
                            return false;
                        }

                        var priorVersion = Interlocked.Read(ref _version);
                        var priorLastModified = Interlocked.Read(ref _lastModified);
                        var priorContentRevision = _contentRevision;
                        var priorJournalStart = _contentJournalStart;
                        var priorJournalCount = _contentJournalCount;
                        var priorJournal = (ContentChange?[])_contentJournal.Clone();
                        var priorDirty = _dirty;
                        var priorDirtyVersion = Interlocked.Read(ref _dirtyVersion);
                        var priorCollectionMembers = _collectionMembers;
                        var priorCollectionParents = _collectionParents;
                        var priorUnindexedCollections = _unindexedCollections;
                        try
                        {
                            _cache = newCache;
                            _collectionMembers = newCollectionMembers;
                            _collectionParents = newCollectionParents;
                            _unindexedCollections = newUnindexedCollections;
                            foreach (var pair in newCache)
                            {
                                if (!oldCache.TryGetValue(pair.Key, out var previous)
                                    || !ContentEquals(previous, pair.Value)
                                    || (string.Equals(pair.Value.Type, nameof(BaseItemKind.BoxSet), StringComparison.Ordinal)
                                        && previous.SourceRevision != pair.Value.SourceRevision)
                                    || (Guid.TryParseExact(pair.Key, "N", out var itemId)
                                        && (changedCollectionParents.Contains(itemId)
                                            || CollectionMembershipChanged(itemId, priorCollectionMembers, newCollectionMembers)
                                            || priorUnindexedCollections.Contains(itemId) != newUnindexedCollections.Contains(itemId))))
                                {
                                    RecordContentChangeLocked(pair.Key, removed: false);
                                }
                            }

                            foreach (var key in oldCache.Keys)
                            {
                                if (!newCache.ContainsKey(key))
                                {
                                    removed = true;
                                    RecordContentChangeLocked(key, removed: true);
                                }
                            }

                            if (changed || removed)
                            {
                                Interlocked.Exchange(ref _lastModified, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                                _userAccessCache.Clear();
                            }

                            if (removed)
                            {
                                Interlocked.Increment(ref _version);
                            }

                            if (ApplyPreparedPendingBatchLocked(pendingPlan, out drainRemoved))
                            {
                                Interlocked.Exchange(ref _lastModified, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                                _userAccessCache.Clear();
                            }

                            if (drainRemoved)
                            {
                                Interlocked.Increment(ref _version);
                            }

                            if (!SaveToDisk(
                                    writerGuardHeld: true,
                                    canCommit: canPublish,
                                    clearRepairMarker: true))
                            {
                                if (canPublish != null && !canPublish())
                                {
                                    throw new OperationCanceledException(
                                        "The tag-cache lifecycle generation was revoked before disk commit.",
                                        cancellationToken);
                                }

                                throw new IOException("The complete tag-cache replacement could not be persisted.");
                            }
                        }
                        catch
                        {
                            _cache = oldCache;
                            _collectionMembers = priorCollectionMembers;
                            _collectionParents = priorCollectionParents;
                            _unindexedCollections = priorUnindexedCollections;
                            Interlocked.Exchange(ref _version, priorVersion);
                            Interlocked.Exchange(ref _lastModified, priorLastModified);
                            Interlocked.Exchange(ref _contentRevision, priorContentRevision);
                            _contentJournalStart = priorJournalStart;
                            _contentJournalCount = priorJournalCount;
                            Array.Copy(priorJournal, _contentJournal, _contentJournal.Length);
                            _dirty = priorDirty;
                            Interlocked.Exchange(ref _dirtyVersion, priorDirtyVersion);
                            RestoreDrainedPendingBatch(pendingBatch, handoffGeneration);

                            throw;
                        }
                    }

                    return true;
                }

                var published = Publish();
                if (!published)
                {
                    RestoreDrainedPendingBatch(pendingBatch, handoffGeneration);
                    _logger.LogInformation("[TagCache] Discarded completed replacement because its lifecycle generation is no longer enabled.");
                    return false;
                }

                PublishPendingFollowups(pendingPlan);

                progress?.Report(100);
                sw.Stop();
                _logger.LogInformation(
                    "[TagCache] Bounded reconcile complete: {Count} entries (changed={Changed}, removed={Removed}) in {Seconds:F1}s",
                    _cache.Count,
                    changed,
                    removed || drainRemoved,
                    sw.Elapsed.TotalSeconds);
                return true;

                void ReadPages(BaseItemKind[] includeTypes)
                {
                    var included = includeTypes.ToHashSet();
                    var startIndex = 0;
                    var expectedTotal = -1;
                    var cacheCountBeforePass = newCache.Count;

                    while (true)
                    {
                        cancellationToken.ThrowIfCancellationRequested();
                        var pageResult = _libraryManager.GetItemsResult(new InternalItemsQuery
                        {
                            IncludeItemTypes = includeTypes,
                            IsVirtualItem = false,
                            Recursive = true,
                            StartIndex = startIndex,
                            Limit = FullCachePageSize,
                            EnableTotalRecordCount = expectedTotal < 0,
                            OrderBy = new[] { (ItemSortBy.SortName, JSortOrder.Ascending) }
                        });
                        cancellationToken.ThrowIfCancellationRequested();
                        var page = pageResult.Items;

                        if (expectedTotal < 0)
                        {
                            expectedTotal = pageResult.TotalRecordCount;
                        }

                        if (page.Count > FullCachePageSize)
                        {
                            throw new InvalidOperationException($"Tag-cache page exceeded the fixed limit of {FullCachePageSize} rows.");
                        }

                        if (page.Count == 0 && startIndex < expectedTotal)
                        {
                            throw new InvalidOperationException("Tag-cache paging ended before Jellyfin's authoritative row count was reached.");
                        }

                        foreach (var item in page)
                        {
                            cancellationToken.ThrowIfCancellationRequested();
                            var kind = item.GetBaseItemKind();
                            // Defensive filtering also keeps lightweight test managers
                            // honest when they return an unfiltered backing collection.
                            if (!included.Contains(kind))
                            {
                                continue;
                            }

                            ProcessItem(item);
                        }

                        startIndex += page.Count;
                        if (startIndex >= expectedTotal)
                        {
                            break;
                        }

                        progress?.Report(Math.Min(99, processed * 100.0 / (processed + FullCachePageSize)));
                    }

                    var distinctRows = newCache.Count - cacheCountBeforePass;
                    if (distinctRows != expectedTotal)
                    {
                        throw new InvalidOperationException(
                            $"Tag-cache paging returned {distinctRows} distinct rows for Jellyfin's authoritative count of {expectedTotal}; the unpublished replacement was discarded.");
                    }
                }

                void ProcessItem(BaseItem item)
                {
                    var key = item.Id.ToString("N").ToLowerInvariant();
                    var kind = item.GetBaseItemKind();
                    var revision = item.DateLastSaved.Ticks;
                    oldCache.TryGetValue(key, out var old);
                    if (kind == BaseItemKind.BoxSet)
                    {
                        var membership = ReadCollectionMembers(item.Id);
                        if (membership.Unindexed)
                        {
                            newUnindexedCollections.Add(item.Id);
                        }
                        else
                        {
                            newCollectionMembers[item.Id] = membership.MemberIds;
                        }
                    }
                    if (kind == BaseItemKind.Movie
                        && (old == null || old.SourceRevision != revision))
                    {
                        changedMovieIds.Add(item.Id);
                    }

                    TagCacheEntry? parentSeriesRefresh = null;
                    var parentOrRelationshipChanged = false;
                    if (kind == BaseItemKind.Episode
                        && item is MediaBrowser.Controller.Entities.TV.Episode episode
                        && old != null
                        && old.SourceRevision == revision)
                    {
                        TagCacheEntry? parentSeries = null;
                        if (episode.SeriesId != Guid.Empty)
                        {
                            newCache.TryGetValue(FormatId(episode.SeriesId)!, out parentSeries);
                        }
                        var relationshipChanged = !string.Equals(old.SeriesId, FormatId(episode.SeriesId), StringComparison.Ordinal)
                            || !string.Equals(old.SeasonId, FormatId(episode.SeasonId), StringComparison.Ordinal);
                        if (relationshipChanged)
                        {
                            parentOrRelationshipChanged = true;
                            if (episode.SeriesId == Guid.Empty || parentSeries != null)
                            {
                                parentSeriesRefresh = TagCacheDependencyGraph.ApplySeasonRelationshipRefreshFromCache(
                                    parentSeries,
                                    episode,
                                    old,
                                    DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                            }
                        }
                        else if (parentSeries != null)
                        {
                            parentOrRelationshipChanged = TagCacheDependencyGraph.TryPrepareParentSeriesRefreshFromCache(
                                parentSeries,
                                episode,
                                old,
                                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                                out parentSeriesRefresh);
                        }
                    }

                    if (!ShouldRebuild(kind, old, revision, parentOrRelationshipChanged))
                    {
                        newCache[key] = old!;
                    }
                    else
                    {
                        var entry = parentSeriesRefresh ?? BuildEntryForItem(item);
                        if (entry == null)
                        {
                            if (old != null)
                            {
                                newCache[key] = old;
                            }
                            else
                            {
                                throw new InvalidOperationException($"Could not build a complete tag-cache entry for new item {key}.");
                            }
                        }
                        else
                        {
                            if (entry.SourceRevision == 0
                                && old != null
                                && string.Equals(entry.StreamSourceId, old.StreamSourceId, StringComparison.Ordinal))
                            {
                                RetainLastGoodProbeData(entry, old);
                            }

                            if (old != null && ContentEquals(old, entry))
                            {
                                entry.LastUpdated = old.LastUpdated;
                            }
                            else
                            {
                                changed = true;
                            }

                            newCache[key] = entry;
                        }
                    }

                    processed++;
                }
            }
            finally
            {
                Interlocked.Exchange(ref _flushing, 0);
            }

        }

        /// <summary>
        /// Decide whether the reconcile must rebuild an item's entry, or can reuse the cached one.
        /// Pure so the gate can be unit-tested without a live library. A rebuild is required for a
        /// new item, for containers (Series/Season) whose derived data tracks their child episodes
        /// rather than their own timestamp, when the source revision changed, or when an Episode's
        /// parent-Series derived surface changed (rating or TMDB metadata that the Episode inherits).
        /// </summary>
        internal static bool ShouldRebuild(BaseItemKind kind, TagCacheEntry? old, long revision, bool parentSeriesRatingChanged)
        {
            if (old == null) return true;
            if (kind == BaseItemKind.Series || kind == BaseItemKind.Season) return true;
            if (old.SourceRevision != revision) return true;
            if (kind == BaseItemKind.Episode && parentSeriesRatingChanged) return true;
            return false;
        }

        /// <summary>
        /// Two entries are content-equal when everything a client renders is identical, ignoring the
        /// volatile bookkeeping fields (LastUpdated = when WE built it, SourceRevision = the source
        /// gate). Used to retain the old timestamp when a rebuild produced no real change, so the
        /// client delta doesn't churn.
        /// </summary>
        internal static bool ContentEquals(TagCacheEntry a, TagCacheEntry b)
        {
            if (ReferenceEquals(a, b)) return true;
            if (a == null || b == null) return false;
            return ContentSignature(a) == ContentSignature(b);
        }

        private static string ContentSignature(TagCacheEntry e)
        {
            // Clone() is the audited copy-every-field method, so a new field is captured
            // automatically. Zero the volatile fields and normalise the one hash-ordered collection:
            // AudioLanguages is built from a HashSet<string>, and .NET randomises string hashing per
            // process, so its array order can differ across restarts for the same languages — sorting
            // a COPY (Clone() is shallow; the array is shared with the real entry) prevents a false
            // "changed" that would churn the delta.
            var copy = e.Clone();
            copy.LastUpdated = 0;
            copy.SourceRevision = 0;
            if (copy.AudioLanguages is { Length: > 1 })
            {
                var langs = (string[])copy.AudioLanguages.Clone();
                Array.Sort(langs, StringComparer.Ordinal);
                copy.AudioLanguages = langs;
            }
            return JsonSerializer.Serialize(copy);
        }

        private static void RetainLastGoodProbeData(TagCacheEntry current, TagCacheEntry previous)
        {
            var freshIdentity = current.StreamData;
            if (previous.StreamData != null)
            {
                current.StreamData = string.Equals(
                        freshIdentity?.ItemName,
                        previous.StreamData.ItemName,
                        StringComparison.Ordinal)
                    && string.Equals(
                        freshIdentity?.ItemPath,
                        previous.StreamData.ItemPath,
                        StringComparison.Ordinal)
                    ? previous.StreamData
                    : new TagStreamData
                    {
                        Streams = previous.StreamData.Streams,
                        Sources = previous.StreamData.Sources,
                        ItemName = freshIdentity?.ItemName,
                        ItemPath = freshIdentity?.ItemPath,
                    };
            }

            current.AudioLanguages = previous.AudioLanguages;
        }

        /// <summary>
        /// Queue an item to be (re)built in the cache. Called by TagCacheMonitor on
        /// ItemAdded/ItemUpdated. This only records the id and arms a debounced
        /// background flush — it performs NO database query and NO media probe, so it
        /// is safe to call on Jellyfin's synchronous library-scan thread. The heavy
        /// BuildEntryForItem work happens off-thread in <see cref="FlushPending"/>,
        /// and a burst of events for the same id collapses to a single rebuild.
        /// </summary>
        public void EnqueueUpdate(Guid itemId)
        {
            if (itemId == Guid.Empty) return;
            lock (_lifecycleGate)
            {
                if (Volatile.Read(ref _disposed) != 0 || Volatile.Read(ref _suspended) != 0) return;
                _pending.Record(itemId, removed: false); // PERF(S1): O(1) record-and-defer, safe on the scan thread
                Interlocked.Increment(ref _libraryEventGeneration);
                Interlocked.Exchange(ref _retryBackoffTicks, 0);
                ScheduleFlush();
            }
        }

        /// <summary>
        /// Queue an item to be removed from the cache. Called by TagCacheMonitor on
        /// ItemRemoved. Like <see cref="EnqueueUpdate"/>, this does no work on the
        /// caller's thread beyond recording the id.
        /// </summary>
        public void EnqueueRemoval(Guid itemId)
        {
            if (itemId == Guid.Empty) return;
            lock (_lifecycleGate)
            {
                if (Volatile.Read(ref _disposed) != 0 || Volatile.Read(ref _suspended) != 0) return;
                _pending.Record(itemId, removed: true);
                Interlocked.Increment(ref _libraryEventGeneration);
                Interlocked.Exchange(ref _retryBackoffTicks, 0);
                ScheduleFlush();
            }
        }

        /// <summary>
        /// Record one explicit library event with its cheap relationship identity. The synchronous
        /// scan thread stops here; parent/descendant expansion and all library queries run later in
        /// <see cref="FlushPending"/>.
        /// </summary>
        internal void EnqueueItemChange(BaseItem item, bool removed)
        {
            lock (_lifecycleGate)
            {
                if (Volatile.Read(ref _disposed) != 0 || Volatile.Read(ref _suspended) != 0) return;
                var key = item.Id.ToString("N").ToLowerInvariant();
                _cache.TryGetValue(key, out var previous);
                var change = TagCacheDependencyGraph.Capture(item, removed, previous);
                if (change.Id == Guid.Empty) return;
                _pending.Record(change);
                Interlocked.Increment(ref _libraryEventGeneration);
                Interlocked.Exchange(ref _retryBackoffTicks, 0);
                ScheduleFlush();
            }
        }

        /// <summary>
        /// Detach pending work in O(1) under the lifecycle gate. The worker drains the retired
        /// container after leaving the gate, so a large handoff never stalls synchronous scan
        /// events from recording into the new container.
        /// </summary>
        private TagCachePendingChanges DetachPendingForHandoff(out long generation)
        {
            lock (_lifecycleGate)
            {
                generation = Interlocked.Read(ref _lifecycleGeneration);
                return SwapPendingContainerLocked(retireDetached: true);
            }
        }

        /// <summary>
        /// Restore a failed handoff as an older chronological prefix. Lifecycle validation and
        /// target capture are O(1) under the gate; per-key replay occurs outside it. RecordOlder
        /// makes a real event racing the replay the newer suffix regardless of lock ordering.
        /// Suspend retires the captured target, revoking any replay still in progress.
        /// </summary>
        private void RestoreDrainedPendingBatch(
            IReadOnlyList<TagCacheChange> olderBatch,
            long expectedGeneration)
        {
            if (olderBatch.Count == 0) return;
            TagCachePendingChanges restoreTarget;
            lock (_lifecycleGate)
            {
                if (Volatile.Read(ref _disposed) != 0)
                {
                    // A full writer owns _flushing until this method returns, so Dispose either
                    // observes this marker before its final save or has already selected the
                    // timeout/marker path. Startup must rebuild rather than trust a snapshot that
                    // could not reclaim the detached handoff batch.
                    Interlocked.Exchange(ref _repairIncomplete, 1);
                    MarkDirty();
                    return;
                }

                if (Volatile.Read(ref _suspended) != 0
                    || Interlocked.Read(ref _lifecycleGeneration) != expectedGeneration)
                {
                    return;
                }

                restoreTarget = _pending;
            }

            OnBeforePendingRestoreReplayForTest?.Invoke();
            foreach (var older in olderBatch) restoreTarget.RecordOlder(older);
        }

        private TagCachePendingChanges SwapPendingContainerLocked(bool retireDetached)
        {
            var detached = Interlocked.Exchange(ref _pending, new TagCachePendingChanges());
            if (retireDetached)
            {
                detached.Retire();
            }

            return detached;
        }

        /// <summary>
        /// Stamp the first-pending time (if unset) and arm the debounced background flush.
        /// </summary>
        private void ScheduleFlush()
        {
            if (Volatile.Read(ref _disposed) != 0 || Volatile.Read(ref _suspended) != 0) return;
            Interlocked.CompareExchange(ref _firstPendingTicks, DateTime.UtcNow.Ticks, 0);
            ArmFlushTimer(ComputeFlushDelay());
        }

        /// <summary>
        /// Arm (or reset) the single flush timer to fire once after <paramref name="due"/>.
        /// </summary>
        private void ArmFlushTimer(TimeSpan due)
        {
            lock (_lifecycleGate)
            {
                if (Volatile.Read(ref _disposed) != 0 || Volatile.Read(ref _suspended) != 0) return;
                var existing = _flushTimer;
                if (existing != null)
                {
                    try
                    {
                        existing.Change(due, Timeout.InfiniteTimeSpan);
                        return;
                    }
                    catch (ObjectDisposedException) { }
                }

                // Publication is serialized with Dispose's disposed transition. Either this timer
                // is visible before shutdown (and Dispose takes it), or shutdown wins and no timer
                // is created; there is no check-then-publish resurrection window.
                var timer = new Timer(_ => FlushPending(), null, due, Timeout.InfiniteTimeSpan);
                var old = Interlocked.Exchange(ref _flushTimer, timer);
                if (old != null && !ReferenceEquals(old, timer))
                {
                    old.Dispose();
                }
            }
        }

        private TimeSpan ComputeFlushDelay() =>
            ComputeFlushDelay(Interlocked.Read(ref _firstPendingTicks), DateTime.UtcNow, FlushDebounce, FlushMaxWait);

        /// <summary>
        /// Debounced due-time with a hard cap: normally <paramref name="debounce"/> after the last
        /// change, but never later than <paramref name="maxWait"/> after the first pending change,
        /// so a continuous scan that keeps resetting the debounce still flushes periodically. Pure
        /// (clock passed in) so the cap math is unit-testable without wall-clock waits.
        /// </summary>
        internal static TimeSpan ComputeFlushDelay(long firstPendingTicks, DateTime nowUtc, TimeSpan debounce, TimeSpan maxWait)
        {
            if (firstPendingTicks == 0) return debounce;

            var elapsed = nowUtc - new DateTime(firstPendingTicks, DateTimeKind.Utc);
            var remainingCap = maxWait - elapsed;
            if (remainingCap <= TimeSpan.Zero) return TimeSpan.Zero;
            return remainingCap < debounce ? remainingCap : debounce;
        }

        /// <summary>
        /// Drain the pending set and apply each change on a background thread. Never
        /// runs on the scan thread. Non-reentrant: an overlapping timer tick re-arms
        /// instead of running a second concurrent flush.
        /// </summary>
        private void FlushPending()
        {
            if (Volatile.Read(ref _disposed) != 0 || Volatile.Read(ref _suspended) != 0) return;
            // Non-reentrant: if a flush already owns the batch, retry after the debounce.
            // (Retry via ArmFlushTimer, NOT ScheduleFlush: once the first pending change is older
            // than FlushMaxWait, ScheduleFlush would compute a zero delay and busy-spin the timer
            // until the running flush exits.)
            if (Interlocked.Exchange(ref _flushing, 1) == 1)
            {
                ArmFlushTimer(FlushDebounce);
                return;
            }

            // Dispose may win after the callback's entry check but before it acquires the guard.
            // Re-check while owning the guard so no callback can mutate after shutdown persistence.
            if (Volatile.Read(ref _disposed) != 0 || Volatile.Read(ref _suspended) != 0)
            {
                Interlocked.Exchange(ref _flushing, 0);
                return;
            }

            try
            {
                Interlocked.Exchange(ref _firstPendingTicks, 0);
                var changed = ApplyPendingBatch(_pending.Drain(), out var removed);

                OnAfterFlushApplyForTest?.Invoke();

                if (Volatile.Read(ref _suspended) != 0)
                {
                    ClearMemoryForDisabledMode();
                    return;
                }

                // Dispose can time out while this owner is blocked after draining. Enqueue and
                // Dispose share _lifecycleGate, so once _disposed is visible no new work can arrive;
                // this final handoff drain captures every event recorded during the in-flight pass.
                if (Volatile.Read(ref _disposed) != 0 && !_pending.IsEmpty)
                {
                    changed |= ApplyPendingBatch(_pending.Drain(), out var handoffRemoved);
                    removed |= handoffRemoved;
                }

                if (changed)
                {
                    Interlocked.Exchange(ref _lastModified, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                    // Current clients consume the tombstone journal. Retain Version
                    // for an older cached bundle whose ?since= shape cannot delete.
                    if (removed) Interlocked.Increment(ref _version);
                    ScheduleDebouncedSave();
                    // If shutdown timed out waiting for this in-flight callback, Dispose cannot
                    // persist our later mutation. Complete the atomic save here instead of leaving
                    // a dirty cache with no live debounce timer.
                    if (Volatile.Read(ref _disposed) != 0)
                    {
                        SaveToDisk(writerGuardHeld: true);
                    }
                }
                else if (Volatile.Read(ref _disposed) != 0
                    && Volatile.Read(ref _repairIncomplete) != 0)
                {
                    SaveToDisk(writerGuardHeld: true);
                }
            }
            finally
            {
                Interlocked.Exchange(ref _flushing, 0);
                // Ids recorded while we were draining/applying: run again. Retries use an
                // exponential global delay; a genuine new event clears it in EnqueueItemChange.
                lock (_lifecycleGate)
                {
                    if (!_pending.IsEmpty
                        && Volatile.Read(ref _disposed) == 0
                        && Volatile.Read(ref _suspended) == 0)
                    {
                        var backoffTicks = Interlocked.Exchange(ref _retryBackoffTicks, 0);
                        if (backoffTicks > 0)
                        {
                            Interlocked.Exchange(ref _firstPendingTicks, DateTime.UtcNow.Ticks);
                            ArmFlushTimer(TimeSpan.FromTicks(backoffTicks));
                        }
                        else
                        {
                            ScheduleFlush();
                        }
                    }
                }
            }
        }

        /// <summary>
        /// Spin-acquire the single-flush guard (<c>_flushing</c>) so no incremental flush mutates
        /// <c>_cache</c> concurrently. Returns false if it couldn't be taken within the cap (an
        /// unusually long in-flight flush) — the caller then proceeds best-effort rather than
        /// blocking a rebuild/shutdown indefinitely. Callers that acquired MUST release it with
        /// <c>Interlocked.Exchange(ref _flushing, 0)</c>.
        /// </summary>
        private bool AcquireFlushGuard(
            int maxSpins = 500,
            int spinMs = 10,
            CancellationToken cancellationToken = default)
        {
            for (var i = 0; i < maxSpins; i++) // ~5s cap by default, well under the shutdown grace period
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (Interlocked.CompareExchange(ref _flushing, 1, 0) == 0)
                {
                    return true;
                }

                if (cancellationToken.WaitHandle.WaitOne(spinMs))
                {
                    cancellationToken.ThrowIfCancellationRequested();
                }
            }

            return false;
        }

        /// <summary>
        /// Apply a drained batch: removals -> <paramref name="remove"/>, updates -> <paramref name="rebuild"/>.
        /// A failing entry is logged and skipped, never aborting the rest of the batch. Returns true if any
        /// change modified the cache. The host lookups live behind the delegates so the dispatch, resilience
        /// and change-aggregation can be unit-tested without a live library.
        /// </summary>
        internal bool ApplyBatch(IReadOnlyList<(Guid Id, bool Removed)> batch, Func<Guid, bool> rebuild, Func<Guid, bool> remove)
        {
            var changed = false;
            foreach (var (id, removed) in batch)
            {
                try
                {
                    changed |= removed ? remove(id) : rebuild(id);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning($"[TagCache] Failed to apply pending change for {id}: {ex.Message}");
                }
            }

            if (changed)
            {
                // Symmetry with BuildFullCache: a changed incremental batch must also drop the 60s
                // per-user accessible-id cache. Otherwise a freshly added/updated item's tag entry is
                // filtered out of every user's GetCacheForUser response for up to UserAccessCacheTtl.
                // Cleared here — the single choke point shared by the debounced flush and the
                // dispose-time drain — so both incremental paths invalidate it. Only on an actual
                // change, so a no-op flush doesn't force every user to recompute their accessible set.
                _userAccessCache.Clear();
            }

            return changed;
        }

        /// <summary>
        /// Apply a drained pending batch via the standard rebuild/remove delegates, additionally
        /// reporting whether any entry was actually removed from the cache. The remove delegate
        /// publishes a journal tombstone; callers additionally bump the legacy <see cref="Version"/>
        /// signal for cached pre-journal clients. Wrapping it keeps <see cref="ApplyBatch"/>'s
        /// tested signature untouched.
        /// </summary>
        private bool ApplyPendingBatch(IReadOnlyList<TagCacheChange> batch, out bool removedFromCache)
        {
            var plan = PreparePendingBatch(
                batch,
                _cache,
                _collectionMembers,
                _collectionParents,
                _unindexedCollections);
            bool changed;
            lock (_contentGate)
            {
                changed = ApplyPreparedPendingBatchLocked(plan, out removedFromCache);
            }

            PublishPendingFollowups(plan);
            if (changed)
            {
                _userAccessCache.Clear();
            }

            return changed;
        }

        private PendingBatchPlan PreparePendingBatch(
            IReadOnlyList<TagCacheChange> batch,
            IReadOnlyDictionary<string, TagCacheEntry> cacheSnapshot,
            IReadOnlyDictionary<Guid, Guid[]> collectionMembersSnapshot,
            IReadOnlyDictionary<Guid, Guid[]> collectionParentsSnapshot,
            IReadOnlySet<Guid> unindexedCollectionsSnapshot)
        {
            var expandedSeries = new HashSet<Guid>();
            var derivedEntries = new Dictionary<Guid, TagCacheEntry>();
            var ordered = ExpandDependencies(
                batch,
                expandedSeries,
                derivedEntries,
                cacheSnapshot,
                collectionParentsSnapshot,
                unindexedCollectionsSnapshot);
            // ExpandDependencies already owns the prepared-entry dictionary. Reuse it as
            // the final plan map so large Series repairs do not allocate a second O(N)
            // dictionary merely to republish the same derived entries.
            var entries = derivedEntries;
            var followupSeries = new HashSet<Guid>();
            Dictionary<Guid, Guid[]>? replacementMembers = null;
            HashSet<Guid>? replacementUnindexed = null;
            var membershipChanged = false;

            void EnsureMembershipCopy()
            {
                replacementMembers ??= new Dictionary<Guid, Guid[]>(collectionMembersSnapshot);
                replacementUnindexed ??= new HashSet<Guid>(unindexedCollectionsSnapshot);
            }

            foreach (var change in ordered)
            {
                try
                {
                    if (change.Removed)
                    {
                        var key = change.Id.ToString("N");
                        if (cacheSnapshot.ContainsKey(key)
                            && (collectionMembersSnapshot.ContainsKey(change.Id)
                                || unindexedCollectionsSnapshot.Contains(change.Id)))
                        {
                            EnsureMembershipCopy();
                            replacementMembers!.Remove(change.Id);
                            replacementUnindexed!.Remove(change.Id);
                            membershipChanged = true;
                        }

                        continue;
                    }

                    BaseItem? item = null;
                    TagCacheEntry? entry;
                    if (derivedEntries.TryGetValue(change.Id, out var derived))
                    {
                        // The dependency expander has already produced the complete entry.
                        // The former PublishPreparedEntry path performed no additional probe,
                        // retention, relationship, or follow-up work; preserve that allocation-
                        // tight behavior for large Series descendant batches.
                        _ = derived;
                        continue;
                    }
                    else
                    {
                        item = _libraryManager.GetItemById<BaseItem>(change.Id);
                        if (item == null || !TaggableTypes.Contains(item.GetBaseItemKind()))
                        {
                            QueueRetry(change, "item is not yet resolvable");
                            continue;
                        }

                        entry = BuildEntryForItem(item);
                        if (entry == null)
                        {
                            QueueRetry(change, "item entry could not be prepared");
                            continue;
                        }
                    }

                    var entryKey = change.Id.ToString("N");
                    if (entry.SourceRevision == 0
                        && cacheSnapshot.TryGetValue(entryKey, out var existing)
                        && string.Equals(entry.StreamSourceId, existing.StreamSourceId, StringComparison.Ordinal))
                    {
                        RetainLastGoodProbeData(entry, existing);
                    }

                    var kind = item?.GetBaseItemKind() ?? ParseKind(entry.Type);
                    if (kind == BaseItemKind.BoxSet)
                    {
                        var membership = ReadCollectionMembers(change.Id);
                        EnsureMembershipCopy();
                        if (membership.Unindexed)
                        {
                            replacementMembers!.Remove(change.Id);
                            replacementUnindexed!.Add(change.Id);
                        }
                        else
                        {
                            replacementMembers![change.Id] = membership.MemberIds;
                            replacementUnindexed!.Remove(change.Id);
                        }

                        membershipChanged = true;
                    }

                    if (kind == BaseItemKind.Series
                        && !expandedSeries.Contains(change.Id)
                        && cacheSnapshot.TryGetValue(entryKey, out existing)
                        && TagCacheDependencyGraph.ParentSeriesSurfaceChanged(existing, entry))
                    {
                        followupSeries.Add(change.Id);
                    }

                    entries[change.Id] = entry;
                }
                catch (Exception ex)
                {
                    QueueRetry(change, ex.Message);
                }
            }

            Dictionary<Guid, Guid[]>? replacementParents = null;
            if (membershipChanged)
            {
                replacementParents = BuildCollectionParents(replacementMembers!);
                Interlocked.Increment(ref _collectionReverseRebuildsForTest);
            }

            return new PendingBatchPlan(
                ordered,
                entries,
                replacementMembers,
                replacementParents,
                replacementUnindexed,
                followupSeries);
        }

        private bool ApplyPreparedPendingBatchLocked(PendingBatchPlan plan, out bool removedFromCache)
        {
            if (!Monitor.IsEntered(_contentGate))
            {
                throw new InvalidOperationException("Prepared pending batches must publish under the content gate.");
            }

            var changed = false;
            var removed = false;
            if (plan.CollectionMembers != null
                && plan.CollectionParents != null
                && plan.UnindexedCollections != null)
            {
                _collectionMembers = plan.CollectionMembers;
                _collectionParents = plan.CollectionParents;
                _unindexedCollections = plan.UnindexedCollections;
            }

            foreach (var change in plan.OrderedChanges)
            {
                var key = change.Id.ToString("N");
                if (change.Removed)
                {
                    if (_cache.TryRemove(key, out _))
                    {
                        RecordContentChangeLocked(key, removed: true);
                        changed = true;
                        removed = true;
                    }

                    continue;
                }

                if (plan.Entries.TryGetValue(change.Id, out var entry))
                {
                    _cache[key] = entry;
                    RecordContentChangeLocked(key, removed: false);
                    changed = true;
                }
            }

            removedFromCache = removed;
            return changed;
        }

        private void PublishPendingFollowups(PendingBatchPlan plan)
        {
            lock (_lifecycleGate)
            {
                if (Volatile.Read(ref _disposed) != 0 || Volatile.Read(ref _suspended) != 0) return;
                foreach (var seriesId in plan.FollowupSeriesIds)
                {
                    _pending.Record(new TagCacheChange(
                        seriesId,
                        BaseItemKind.Series,
                        Guid.Empty,
                        Guid.Empty,
                        Guid.Empty,
                        Guid.Empty,
                        Removed: false));
                }

                if (plan.FollowupSeriesIds.Count != 0)
                {
                    ScheduleFlush();
                }
            }
        }

        private sealed record PendingBatchPlan(
            IReadOnlyList<TagCacheChange> OrderedChanges,
            IReadOnlyDictionary<Guid, TagCacheEntry> Entries,
            Dictionary<Guid, Guid[]>? CollectionMembers,
            Dictionary<Guid, Guid[]>? CollectionParents,
            HashSet<Guid>? UnindexedCollections,
            IReadOnlySet<Guid> FollowupSeriesIds);

        /// <summary>
        /// Expand the centralized derived-entry graph on the background flush worker. Explicit
        /// event intent is installed first, so a same-batch removal cannot be overwritten by a
        /// derived parent/descendant rebuild. Series discovery is constrained to one ancestor and
        /// every returned row is relationship-verified before it can enter the batch.
        /// </summary>
        private IReadOnlyList<TagCacheChange> ExpandDependencies(
            IReadOnlyList<TagCacheChange> batch,
            ISet<Guid> expandedSeries,
            IDictionary<Guid, TagCacheEntry> preparedEntries,
            IReadOnlyDictionary<string, TagCacheEntry> cacheSnapshot,
            IReadOnlyDictionary<Guid, Guid[]> collectionParentsSnapshot,
            IReadOnlySet<Guid> unindexedCollectionsSnapshot)
        {
            var targets = new Dictionary<Guid, TagCacheChange>();
            foreach (var change in batch)
            {
                if (change.Id != Guid.Empty) targets[change.Id] = change;
            }

            foreach (var change in batch.Where(TagCacheDependencyGraph.NeedsCollectionParentDiscovery))
            {
                var oldParents = new HashSet<Guid>();
                AddKnownParents(collectionParentsSnapshot, change.Id, oldParents);
                // An over-cap collection cannot have a complete reverse index. Recheck it on
                // the background worker for any Movie change so a 20,001 -> 20,000 removal
                // transitions back to indexed/servable even when Jellyfin's live reverse edge
                // has already disappeared. Event capture itself remains O(1).
                oldParents.UnionWith(unindexedCollectionsSnapshot);
                foreach (var parentId in oldParents)
                {
                    targets.TryAdd(parentId, DependencyTarget(parentId, BaseItemKind.BoxSet));
                }

                if (_linkedChildrenService != null)
                {
                    try
                    {
                        var parentIds = GetCollectionParentIds(change.Id);
                        if (parentIds.Count > TagCollectionLanguageCoverageProjector.MaximumMembershipEdgesPerRequest
                            || parentIds.Any(static id => id == Guid.Empty))
                        {
                            throw new InvalidOperationException("Collection reverse membership exceeded its safety bound or returned an empty id.");
                        }

                        foreach (var parentId in parentIds.Distinct())
                        {
                            targets.TryAdd(parentId, DependencyTarget(parentId, BaseItemKind.BoxSet));
                        }
                    }
                    catch (Exception ex)
                    {
                        QueueRetry(change, $"collection parent discovery failed: {ex.Message}");
                    }
                }
            }

            var removedSeriesIds = batch
                .Where(static change => change.Removed && change.Kind == BaseItemKind.Series)
                .Select(static change => change.Id)
                .ToHashSet();
            var removedSeasonIds = batch
                .Where(static change => change.Removed && change.Kind == BaseItemKind.Season)
                .Select(static change => change.Id)
                .ToHashSet();
            var explicitRemovedIds = batch
                .Where(static change => change.Removed)
                .Select(static change => change.Id)
                .ToHashSet();
            var explicitChangeIds = batch.Select(static change => change.Id).ToHashSet();
            var movedSeasonExpectedEpisodes = batch
                .Where(static change => !change.Removed
                    && change.Kind == BaseItemKind.Season
                    && change.SeriesId != change.PreviousSeriesId)
                .ToDictionary(
                    static change => change.Id,
                    static _ => new HashSet<Guid>());
            var seriesExpectedDescendants = batch
                .Where(TagCacheDependencyGraph.NeedsSeriesDescendantDiscovery)
                .ToDictionary(
                    static change => change.Id,
                    static _ => new HashSet<Guid>());
            var cachedSeriesDescendants = new Dictionary<Guid, HashSet<Guid>>();
            var cachedSeasonEpisodes = new Dictionary<Guid, HashSet<Guid>>();

            // One O(cache-size) relationship-index pass covers every removed container and every
            // descendant-completeness check in the batch. Rebuilding these expected sets from the
            // cache on every retry prevents a transiently partial Jellyfin snapshot from becoming
            // authoritative merely because the original removal event has already been consumed.
            if (removedSeriesIds.Count != 0
                || removedSeasonIds.Count != 0
                || movedSeasonExpectedEpisodes.Count != 0
                || seriesExpectedDescendants.Count != 0)
            {
                foreach (var cached in cacheSnapshot)
                {
                    Interlocked.Increment(ref _removedDependencyEntriesVisited);
                    if (!Guid.TryParseExact(cached.Key, "N", out var descendantId))
                    {
                        continue;
                    }

                    var cachedKind = ParseKind(cached.Value.Type);
                    var cachedSeriesId = ParseId(cached.Value.SeriesId);
                    var cachedSeasonId = ParseId(cached.Value.SeasonId);
                    if ((cachedKind == BaseItemKind.Episode || cachedKind == BaseItemKind.Season)
                        && cachedSeriesId is { } indexedSeriesId)
                    {
                        if (!cachedSeriesDescendants.TryGetValue(indexedSeriesId, out var indexedDescendants))
                        {
                            indexedDescendants = new HashSet<Guid>();
                            cachedSeriesDescendants[indexedSeriesId] = indexedDescendants;
                        }

                        indexedDescendants.Add(descendantId);
                    }

                    if (cachedKind == BaseItemKind.Episode && cachedSeasonId is { } indexedSeasonId)
                    {
                        if (!cachedSeasonEpisodes.TryGetValue(indexedSeasonId, out var indexedEpisodes))
                        {
                            indexedEpisodes = new HashSet<Guid>();
                            cachedSeasonEpisodes[indexedSeasonId] = indexedEpisodes;
                        }

                        indexedEpisodes.Add(descendantId);
                    }

                    if (!explicitChangeIds.Contains(descendantId)
                        && cachedKind == BaseItemKind.Episode
                        && cachedSeasonId is { } expectedSeasonId
                        && movedSeasonExpectedEpisodes.TryGetValue(expectedSeasonId, out var expectedEpisodes))
                    {
                        expectedEpisodes.Add(descendantId);
                    }

                    if (!explicitChangeIds.Contains(descendantId)
                        && (cachedKind == BaseItemKind.Episode || cachedKind == BaseItemKind.Season)
                        && cachedSeriesId is { } expectedSeriesId
                        && seriesExpectedDescendants.TryGetValue(expectedSeriesId, out var expectedDescendants))
                    {
                        expectedDescendants.Add(descendantId);
                    }

                    // Jellyfin reports only the top-level folder after recursively deleting
                    // children, so synthesize descendant removals from the cached relationships.
                    var matchedSeries = cachedSeriesId is { } removedSeriesId
                        && removedSeriesIds.Contains(removedSeriesId);
                    var matchedSeason = cachedSeasonId is { } removedSeasonId
                        && removedSeasonIds.Contains(removedSeasonId);
                    if (!matchedSeries && !matchedSeason)
                    {
                        continue;
                    }

                    // A Season explicitly escaping a removed Series owns its children. Until its
                    // live descendant snapshot proves their disposition, keep cached Episodes
                    // fail-safe instead of publishing synthetic tombstones from the old Series.
                    if (!explicitChangeIds.Contains(descendantId)
                        && string.Equals(cached.Value.Type, BaseItemKind.Episode.ToString(), StringComparison.Ordinal)
                        && cachedSeasonId is { } protectedSeasonId
                        && movedSeasonExpectedEpisodes.ContainsKey(protectedSeasonId))
                    {
                        continue;
                    }

                    if (targets.TryGetValue(descendantId, out var explicitChange)
                        && TagCacheDependencyGraph.ExplicitChangeEscapedRemovedContainers(
                            explicitChange,
                            matchedSeries,
                            matchedSeason,
                            removedSeriesIds,
                            removedSeasonIds))
                    {
                        continue;
                    }

                    targets[descendantId] = RemovalTarget(descendantId, ParseKind(cached.Value.Type));
                    preparedEntries.Remove(descendantId);
                }
            }

            void InstallConfirmedContainerRemoval(Guid containerId, BaseItemKind containerKind)
            {
                targets[containerId] = RemovalTarget(containerId, containerKind);
                preparedEntries.Remove(containerId);
                var descendants = containerKind == BaseItemKind.Series
                    ? cachedSeriesDescendants.GetValueOrDefault(containerId)
                    : cachedSeasonEpisodes.GetValueOrDefault(containerId);
                if (descendants == null)
                {
                    return;
                }

                foreach (var descendantId in descendants)
                {
                    // A live, explicit or relationship-verified escape is newer evidence than
                    // the cached owner index and must survive the synthetic recursive removal.
                    if (targets.TryGetValue(descendantId, out var currentTarget) && !currentTarget.Removed)
                    {
                        continue;
                    }

                    cacheSnapshot.TryGetValue(descendantId.ToString("N"), out var cachedDescendant);
                    targets[descendantId] = RemovalTarget(descendantId, ParseKind(cachedDescendant?.Type));
                    preparedEntries.Remove(descendantId);
                }
            }

            foreach (var change in batch)
            {
                foreach (var parent in TagCacheDependencyGraph.DirectDerivedTargets(change))
                {
                    var isPreviousOnlyOwner = parent.Id == change.PreviousSeriesId
                            && parent.Id != change.SeriesId
                        || parent.Id == change.PreviousSeasonId
                            && parent.Id != change.SeasonId;
                    if (isPreviousOnlyOwner && !cacheSnapshot.ContainsKey(parent.Id.ToString("N")))
                    {
                        continue;
                    }

                    targets.TryAdd(parent.Id, DependencyTarget(parent.Id, parent.Kind));
                }

                if (!change.Removed
                    && change.Kind == BaseItemKind.Season
                    && change.SeriesId != change.PreviousSeriesId)
                {
                    try
                    {
                        BaseItem? newSeries = null;
                        if (change.SeriesId != Guid.Empty)
                        {
                            newSeries = _libraryManager.GetItemById<BaseItem>(change.SeriesId);
                            if (newSeries == null || newSeries.GetBaseItemKind() != BaseItemKind.Series)
                            {
                                throw new InvalidOperationException("moved Season parent Series is not yet resolvable");
                            }
                        }

                        var seasonEpisodes = _libraryManager.GetItemList(new InternalItemsQuery
                        {
                            AncestorIds = new[] { change.Id },
                            IncludeItemTypes = new[] { BaseItemKind.Episode },
                            IsVirtualItem = false,
                            Recursive = true,
                        });
                        var inconsistentEpisodeRelationship = false;
                        var discoveredEpisodeIds = new HashSet<Guid>();
                        foreach (var episode in seasonEpisodes.OfType<MediaBrowser.Controller.Entities.TV.Episode>())
                        {
                            if (episode.SeasonId != change.Id)
                            {
                                continue;
                            }

                            if (episode.SeriesId != change.SeriesId)
                            {
                                inconsistentEpisodeRelationship = true;
                                continue;
                            }

                            discoveredEpisodeIds.Add(episode.Id);

                            var episodeTarget = DependencyTarget(episode.Id, BaseItemKind.Episode);
                            var canReplaceSyntheticRemoval = targets.TryGetValue(episode.Id, out var currentTarget)
                                && currentTarget.Removed
                                && !explicitRemovedIds.Contains(episode.Id)
                                && !removedSeriesIds.Contains(episode.SeriesId)
                                && !removedSeasonIds.Contains(episode.SeasonId);
                            if ((targets.TryAdd(episode.Id, episodeTarget) || canReplaceSyntheticRemoval)
                                && cacheSnapshot.TryGetValue(episode.Id.ToString("N").ToLowerInvariant(), out var existing))
                            {
                                targets[episode.Id] = episodeTarget;
                                if (existing.SourceRevision == episode.DateLastSaved.Ticks)
                                {
                                    preparedEntries[episode.Id] = TagCacheDependencyGraph.ApplySeasonRelationshipRefresh(
                                        newSeries,
                                        episode,
                                        existing,
                                        DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                                }
                                else
                                {
                                    preparedEntries.Remove(episode.Id);
                                }
                            }
                        }

                        if (inconsistentEpisodeRelationship)
                        {
                            QueueRetry(change, "one or more Episodes still expose the old Series during Season reparent");
                        }

                        if (movedSeasonExpectedEpisodes.TryGetValue(change.Id, out var expectedEpisodes)
                            && !expectedEpisodes.IsSubsetOf(discoveredEpisodeIds))
                        {
                            QueueRetry(change, "moved Season descendant discovery omitted one or more cached Episodes");
                        }
                    }
                    catch (Exception ex)
                    {
                        QueueRetry(change, $"moved Season descendant discovery failed: {ex.Message}");
                    }
                }

                if (!TagCacheDependencyGraph.NeedsSeriesDescendantDiscovery(change)) continue;
                try
                {
                    var series = _libraryManager.GetItemById<BaseItem>(change.Id);
                    if (series == null || series.GetBaseItemKind() != BaseItemKind.Series)
                    {
                        throw new InvalidOperationException("Series is not yet resolvable");
                    }

                    var descendantSnapshot = _libraryManager.GetItemList(new InternalItemsQuery
                    {
                        AncestorIds = new[] { change.Id },
                        IncludeItemTypes = TagCacheDependencyGraph.DescendantKinds(),
                        IsVirtualItem = false,
                        Recursive = true,
                        OrderBy = new[] { (ItemSortBy.PremiereDate, JSortOrder.Ascending) },
                    }).ToList();
                    var formattedSeriesId = FormatId(change.Id);
                    var snapshotIds = descendantSnapshot.Select(static item => item.Id).ToHashSet();
                    var oldSeriesRepairIds = new HashSet<Guid>();
                    foreach (var descendant in descendantSnapshot)
                    {
                        if (descendant is not MediaBrowser.Controller.Entities.TV.Episode
                            && descendant is not MediaBrowser.Controller.Entities.TV.Season)
                        {
                            continue;
                        }

                        if (cacheSnapshot.TryGetValue(descendant.Id.ToString("N"), out var cachedDescendant)
                            && ParseId(cachedDescendant.SeriesId) is { } oldSeriesId
                            && oldSeriesId != change.Id
                            && (descendant is MediaBrowser.Controller.Entities.TV.Episode episode
                                    && episode.SeriesId == change.Id
                                || descendant is MediaBrowser.Controller.Entities.TV.Season season
                                    && season.SeriesId == change.Id))
                        {
                            oldSeriesRepairIds.Add(oldSeriesId);
                        }
                    }

                    // A partial new-Series snapshot can omit an item whose cache still points at
                    // an old owner, so it is absent from the new owner's expected set. Once any
                    // stale old owner is observed, bulk-confirm only that owner's omitted cached
                    // rows and fold live rows that really moved to this Series into the snapshot.
                    var staleRelationshipCandidates = oldSeriesRepairIds
                        .SelectMany(id => cachedSeriesDescendants.GetValueOrDefault(id) ?? Enumerable.Empty<Guid>())
                        .Where(id => !snapshotIds.Contains(id) && !explicitChangeIds.Contains(id))
                        .ToHashSet();
                    if (staleRelationshipCandidates.Count != 0)
                    {
                        var confirmedCandidates = _libraryManager.GetItemList(new InternalItemsQuery
                        {
                            ItemIds = staleRelationshipCandidates.ToArray(),
                            IncludeItemTypes = TagCacheDependencyGraph.DescendantKinds(),
                            IsVirtualItem = false,
                        });
                        var confirmedCandidateIds = confirmedCandidates.Select(static item => item.Id).ToHashSet();
                        foreach (var candidate in confirmedCandidates)
                        {
                            var related = candidate is MediaBrowser.Controller.Entities.TV.Episode relatedEpisode
                                    && relatedEpisode.SeriesId == change.Id
                                || candidate is MediaBrowser.Controller.Entities.TV.Season relatedSeason
                                    && relatedSeason.SeriesId == change.Id;
                            if (related && snapshotIds.Add(candidate.Id))
                            {
                                descendantSnapshot.Add(candidate);
                            }
                        }

                        const int MaximumScalarRelationshipConfirmations = 32;
                        var scalarConfirmations = 0;
                        foreach (var omittedCandidateId in staleRelationshipCandidates.Except(confirmedCandidateIds))
                        {
                            if (scalarConfirmations++ >= MaximumScalarRelationshipConfirmations)
                            {
                                QueueRetry(change, "partial relationship confirmation exceeded its bounded scalar budget");
                                break;
                            }

                            var candidate = _libraryManager.GetItemById<BaseItem>(omittedCandidateId);
                            if (candidate == null)
                            {
                                if (cacheSnapshot.TryGetValue(omittedCandidateId.ToString("N"), out var missingCached)
                                    && ParseKind(missingCached.Type) is { } missingKind)
                                {
                                    if (missingKind == BaseItemKind.Series || missingKind == BaseItemKind.Season)
                                    {
                                        InstallConfirmedContainerRemoval(omittedCandidateId, missingKind);
                                    }
                                    else
                                    {
                                        targets[omittedCandidateId] = RemovalTarget(omittedCandidateId, missingKind);
                                        preparedEntries.Remove(omittedCandidateId);
                                    }
                                }

                                continue;
                            }

                            var related = candidate is MediaBrowser.Controller.Entities.TV.Episode relatedEpisode
                                    && relatedEpisode.SeriesId == change.Id
                                || candidate is MediaBrowser.Controller.Entities.TV.Season relatedSeason
                                    && relatedSeason.SeriesId == change.Id;
                            if (related && snapshotIds.Add(candidate.Id))
                            {
                                descendantSnapshot.Add(candidate);
                            }
                        }
                    }

                    var firstEpisodesBySeason = new Dictionary<Guid, BaseItem>();
                    var discoveredDescendantIds = new HashSet<Guid>();
                    var inconsistentSeriesRelationship = false;
                    foreach (var episode in descendantSnapshot.OfType<MediaBrowser.Controller.Entities.TV.Episode>())
                    {
                        if (episode.SeriesId != change.Id)
                        {
                            inconsistentSeriesRelationship = true;
                            continue;
                        }

                        if (episode.SeasonId != Guid.Empty)
                        {
                            firstEpisodesBySeason.TryAdd(episode.SeasonId, episode);
                        }
                    }
                    if (inconsistentSeriesRelationship)
                    {
                        QueueRetry(change, "Series descendant discovery returned one or more foreign Episodes");
                    }
                    BaseItem? FirstEpisodeFromSnapshot(BaseItem container)
                        => firstEpisodesBySeason.GetValueOrDefault(container.Id);
                    var oldSeasonRepairIds = new HashSet<Guid>();

                    foreach (var descendant in descendantSnapshot)
                    {
                        var related = descendant is MediaBrowser.Controller.Entities.TV.Episode relatedEpisode
                                && relatedEpisode.SeriesId == change.Id
                            || descendant is MediaBrowser.Controller.Entities.TV.Season relatedSeason
                                && relatedSeason.SeriesId == change.Id;
                        if (!related)
                        {
                            continue;
                        }

                        discoveredDescendantIds.Add(descendant.Id);

                        var key = descendant.Id.ToString("N").ToLowerInvariant();
                        cacheSnapshot.TryGetValue(key, out var existing);
                        var lastUpdated = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                        if (existing == null)
                        {
                            targets.TryAdd(
                                descendant.Id,
                                DependencyTarget(descendant.Id, descendant.GetBaseItemKind()));
                        }
                        else if (!string.Equals(existing.SeriesId, formattedSeriesId, StringComparison.Ordinal)
                            || descendant is MediaBrowser.Controller.Entities.TV.Episode movedEpisode
                                && !string.Equals(existing.SeasonId, FormatId(movedEpisode.SeasonId), StringComparison.Ordinal))
                        {
                            // The stable subtree can repair missed relationship metadata without
                            // turning a parent event into N media probes. Also repair the old
                            // relationship owner so a missed reparent cannot strand its projection.
                            if (ParseId(existing.SeriesId) is { } oldSeriesId && oldSeriesId != change.Id)
                            {
                                oldSeriesRepairIds.Add(oldSeriesId);
                            }

                            if (descendant is MediaBrowser.Controller.Entities.TV.Episode episode)
                            {
                                var oldSeasonId = ParseId(existing.SeasonId);
                                if (oldSeasonId.HasValue && oldSeasonId.Value != episode.SeasonId)
                                {
                                    oldSeasonRepairIds.Add(oldSeasonId.Value);
                                    if (episode.SeasonId != Guid.Empty)
                                    {
                                        targets.TryAdd(
                                            episode.SeasonId,
                                            DependencyTarget(episode.SeasonId, BaseItemKind.Season));
                                    }
                                }
                            }

                            var descendantTarget = DependencyTarget(descendant.Id, descendant.GetBaseItemKind());
                            var canReplaceSyntheticRemoval = targets.TryGetValue(descendant.Id, out var currentTarget)
                                && currentTarget.Removed
                                && !explicitRemovedIds.Contains(descendant.Id);
                            if (targets.TryAdd(descendant.Id, descendantTarget) || canReplaceSyntheticRemoval)
                            {
                                targets[descendant.Id] = descendantTarget;
                                if (existing.SourceRevision == descendant.DateLastSaved.Ticks)
                                {
                                    preparedEntries[descendant.Id] = TagCacheDependencyGraph.ApplySeriesRelationshipRefresh(
                                        series,
                                        descendant,
                                        existing,
                                        FirstEpisodeFromSnapshot,
                                        lastUpdated);
                                }
                                else
                                {
                                    preparedEntries.Remove(descendant.Id);
                                }
                            }
                        }
                        else if (existing.SourceRevision != descendant.DateLastSaved.Ticks)
                        {
                            targets.TryAdd(
                                descendant.Id,
                                DependencyTarget(descendant.Id, descendant.GetBaseItemKind()));
                            preparedEntries.Remove(descendant.Id);
                        }
                        else if (TagCacheDependencyGraph.TryPrepareParentSeriesRefresh(
                                series,
                                descendant,
                                existing,
                                FirstEpisodeFromSnapshot,
                                lastUpdated,
                                out var prepared)
                            && targets.TryAdd(
                                descendant.Id,
                                DependencyTarget(descendant.Id, descendant.GetBaseItemKind())))
                        {
                            preparedEntries[descendant.Id] = prepared!;
                        }
                    }

                    var oldOwnerKinds = oldSeriesRepairIds
                        .Select(static id => (Id: id, Kind: BaseItemKind.Series))
                        .Concat(oldSeasonRepairIds.Select(static id => (Id: id, Kind: BaseItemKind.Season)))
                        .Where(owner => !explicitChangeIds.Contains(owner.Id)
                            && cacheSnapshot.ContainsKey(owner.Id.ToString("N")))
                        .GroupBy(static owner => owner.Id)
                        .ToDictionary(static group => group.Key, static group => group.First().Kind);
                    if (oldOwnerKinds.Count != 0)
                    {
                        var liveOldOwners = _libraryManager.GetItemList(new InternalItemsQuery
                        {
                            ItemIds = oldOwnerKinds.Keys.ToArray(),
                            IncludeItemTypes = new[] { BaseItemKind.Series, BaseItemKind.Season },
                            IsVirtualItem = false,
                        })
                            .Where(item => oldOwnerKinds.TryGetValue(item.Id, out var expectedKind)
                                && item.GetBaseItemKind() == expectedKind)
                            .ToDictionary(static item => item.Id);
                        const int MaximumScalarOwnerConfirmations = 32;
                        var scalarOwnerConfirmations = 0;
                        foreach (var oldOwner in oldOwnerKinds)
                        {
                            if (liveOldOwners.ContainsKey(oldOwner.Key))
                            {
                                targets[oldOwner.Key] = DependencyTarget(oldOwner.Key, oldOwner.Value);
                                preparedEntries.Remove(oldOwner.Key);
                                continue;
                            }

                            if (scalarOwnerConfirmations++ >= MaximumScalarOwnerConfirmations)
                            {
                                QueueRetry(change, "old relationship-owner confirmation exceeded its bounded scalar budget");
                                break;
                            }

                            var liveOwner = _libraryManager.GetItemById<BaseItem>(oldOwner.Key);
                            if (liveOwner != null && liveOwner.GetBaseItemKind() == oldOwner.Value)
                            {
                                targets[oldOwner.Key] = DependencyTarget(oldOwner.Key, oldOwner.Value);
                                preparedEntries.Remove(oldOwner.Key);
                            }
                            else
                            {
                                InstallConfirmedContainerRemoval(oldOwner.Key, oldOwner.Value);
                            }
                        }
                    }

                    if (seriesExpectedDescendants.TryGetValue(change.Id, out var expectedDescendants)
                        && expectedDescendants.Any(id => !discoveredDescendantIds.Contains(id)
                            && (!targets.TryGetValue(id, out var target) || !target.Removed)))
                    {
                        QueueRetry(change, "Series descendant discovery omitted one or more cached descendants");
                    }

                    expandedSeries.Add(change.Id);
                }
                catch (Exception ex)
                {
                    QueueRetry(change, $"derived Series discovery failed: {ex.Message}");
                }
            }

            // Apply relationship sources before their derived containers. Besides being linear,
            // this closes the in-flight reparent window where a concurrently arriving event could
            // otherwise capture the pre-batch cached parent after a new parent had already rebuilt.
            var ordered = new List<TagCacheChange>(targets.Count);
            for (var rank = 0; rank <= 2; rank++)
            {
                foreach (var target in targets.Values)
                {
                    if (DependencyRank(target.Kind) == rank)
                    {
                        ordered.Add(target);
                    }
                }
            }

            return ordered;
        }

        private static TagCacheChange DependencyTarget(Guid id, BaseItemKind? kind)
            => new(
                id,
                kind,
                Guid.Empty,
                Guid.Empty,
                Guid.Empty,
                Guid.Empty,
                Removed: false);

        private static TagCacheChange RemovalTarget(Guid id, BaseItemKind? kind = null)
            => new(
                id,
                kind,
                Guid.Empty,
                Guid.Empty,
                Guid.Empty,
                Guid.Empty,
                Removed: true);

        private static int DependencyRank(BaseItemKind? kind)
            => kind switch
            {
                BaseItemKind.Season => 1,
                BaseItemKind.BoxSet => 1,
                BaseItemKind.Series => 2,
                _ => 0,
            };

        private static BaseItemKind? ParseKind(string? value)
            => Enum.TryParse<BaseItemKind>(value, ignoreCase: false, out var kind) ? kind : null;

        private static string? FormatId(Guid id)
            => id == Guid.Empty ? null : id.ToString("N");

        private static Guid? ParseId(string? value)
            => Guid.TryParseExact(value, "N", out var id) ? id : null;

        private void QueueRetry(TagCacheChange change, string reason)
        {
            if (change.Removed)
            {
                return;
            }

            lock (_lifecycleGate)
            {
                if (Volatile.Read(ref _disposed) != 0)
                {
                    Interlocked.Exchange(ref _repairIncomplete, 1);
                    MarkDirty();
                    return;
                }

                if (Volatile.Read(ref _suspended) != 0)
                {
                    return;
                }

                var attempts = change.RetryAttempts == byte.MaxValue
                    ? byte.MaxValue
                    : (byte)(change.RetryAttempts + 1);
                if (!_pending.Record(change with { RetryAttempts = attempts }))
                {
                    return;
                }

                var delay = ComputeRetryDelay(attempts);
                SetMax(ref _retryBackoffTicks, delay.Ticks);
                if (attempts <= 3 || (attempts & (attempts - 1)) == 0 || attempts == byte.MaxValue)
                {
                    _logger.LogWarning(
                        $"[TagCache] Pending repair for {change.Id} remains owned; retry attempt {attempts} is queued after {delay}: {reason}");
                }
            }
        }

        internal static TimeSpan ComputeRetryDelay(byte attempts)
        {
            var exponent = Math.Min(Math.Max(attempts - 1, 0), 7);
            return TimeSpan.FromTicks(Math.Min(
                FlushDebounce.Ticks * (1L << exponent),
                TimeSpan.FromMinutes(5).Ticks));
        }

        private static void SetMax(ref long location, long value)
        {
            var current = Interlocked.Read(ref location);
            while (current < value)
            {
                var observed = Interlocked.CompareExchange(ref location, value, current);
                if (observed == current) return;
                current = observed;
            }
        }

        private void RecordContentChangeLocked(string itemId, bool removed)
        {
            var revision = checked(++_contentRevision);
            var change = new ContentChange(revision, itemId, removed);
            if (_contentJournalCount < _contentJournal.Length)
            {
                var index = (_contentJournalStart + _contentJournalCount) % _contentJournal.Length;
                _contentJournal[index] = change;
                _contentJournalCount++;
                return;
            }

            _contentJournal[_contentJournalStart] = change;
            _contentJournalStart = (_contentJournalStart + 1) % _contentJournal.Length;
        }

        private void PublishServedState(string userKey, IEnumerable<string> visibleIds)
        {
            if (!_servedContentStates.TryGetValue(userKey, out var state))
            {
                state = new ServedContentState();
            }

            // Mutate the process-private state under _contentGate, then re-set it
            // so BoundedTtlCache reweighs/evicts in O(1). Copying the existing set
            // here would turn every one-row delta into O(all ids ever served).
            foreach (var visibleId in visibleIds)
            {
                Interlocked.Increment(ref _servedContentIdsVisited);
                state.VisibleIds.Add(visibleId);
            }

            _servedContentStates.Set(userKey, state, ServedContentStateTtl);
        }

        /// <summary>
        /// Record every row actually emitted by the controller, including rows
        /// introduced by a projection-only response. Content-journal tombstones
        /// may disclose an id only after this process has served that id to the
        /// same authenticated user.
        /// </summary>
        internal void PublishServedContentForUser(JUser user, IEnumerable<string> visibleIds)
        {
            ArgumentNullException.ThrowIfNull(user);
            ArgumentNullException.ThrowIfNull(visibleIds);
            var authorizationKey = AuthorizationKey(user);
            lock (_contentGate)
            {
                PublishServedState(authorizationKey, visibleIds);
            }
        }

        /// <summary>
        /// Return one authoritative personalized snapshot and establish the
        /// server-side authorization proof used to filter later tombstones. The
        /// revision is captured before row selection: a concurrent mutation can
        /// cause one harmless duplicate in the next delta, never a skipped row.
        /// </summary>
        internal ContentDelta GetFullContentForUser(JUser user)
        {
            ArgumentNullException.ThrowIfNull(user);
            var authorizationKey = AuthorizationKey(user);
            var contentEpoch = ContentEpochFor(authorizationKey);
            long revision;
            lock (_contentGate)
            {
                revision = _contentRevision;
            }

            var items = GetCacheForUser(user);
            lock (_contentGate)
            {
                PublishServedState(authorizationKey, items.Keys);
            }
            return new ContentDelta(
                contentEpoch,
                revision,
                resetRequired: false,
                items,
                Array.Empty<string>(),
                journalRowsVisited: 0);
        }

        /// <summary>
        /// Return only content mutations after a process-local monotonic cursor.
        /// The fixed-size ring permits direct O(changes) suffix access; it never
        /// scans the shared cache. Missing authorization history, an epoch change,
        /// a future revision, or a journal gap fails closed with resetRequired.
        /// </summary>
        internal ContentDelta GetContentDeltaForUser(
            JUser user,
            string? clientEpoch,
            long? clientRevision)
        {
            ArgumentNullException.ThrowIfNull(user);
            var authorizationKey = AuthorizationKey(user);
            var contentEpoch = ContentEpochFor(authorizationKey);

            lock (_contentGate)
            {
                var currentRevision = _contentRevision;
                if (string.IsNullOrWhiteSpace(clientEpoch)
                    || !clientRevision.HasValue
                    || !string.Equals(clientEpoch, contentEpoch, StringComparison.Ordinal)
                    || clientRevision.Value < 0
                    || clientRevision.Value > currentRevision
                    || !_servedContentStates.TryGetValue(authorizationKey, out var served))
                {
                    return ContentResetLocked(contentEpoch, currentRevision);
                }

                var requestedRevision = clientRevision.Value;
                if (requestedRevision == currentRevision)
                {
                    return new ContentDelta(
                        contentEpoch,
                        currentRevision,
                        resetRequired: false,
                        new Dictionary<string, TagCacheEntry>(StringComparer.Ordinal),
                        Array.Empty<string>(),
                        journalRowsVisited: 0);
                }

                var earliestRetained = currentRevision - _contentJournalCount + 1;
                if (_contentJournalCount == 0 || requestedRevision < earliestRetained - 1)
                {
                    return ContentResetLocked(contentEpoch, currentRevision);
                }

                // Each revision maps to exactly one ring row, so start directly at
                // requested+1 instead of walking retained history. Last mutation
                // wins when one id appears repeatedly in the requested suffix.
                var finalChanges = new Dictionary<string, bool>(StringComparer.Ordinal);
                var firstOffset = checked((int)(requestedRevision + 1 - earliestRetained));
                var rowsVisited = 0;
                for (var offset = firstOffset; offset < _contentJournalCount; offset++)
                {
                    var index = (_contentJournalStart + offset) % _contentJournal.Length;
                    var change = _contentJournal[index]
                        ?? throw new InvalidOperationException("Tag-cache content journal contains an empty retained row.");
                    finalChanges[change.ItemId] = change.Removed;
                    rowsVisited++;
                }

                var candidateUpserts = finalChanges
                    .Where(static pair => !pair.Value)
                    .Select(static pair => pair.Key)
                    .ToArray();
                var items = GetCacheEntriesForUserByIds(user, candidateUpserts);
                var removedIds = new HashSet<string>(StringComparer.Ordinal);
                foreach (var (itemId, removed) in finalChanges)
                {
                    // A content deletion and a now-inaccessible upsert are both
                    // tombstones, but only when this authenticated user was actually
                    // served that id earlier in this process epoch. Raw hidden ids
                    // never cross the endpoint; evicted proof forces a reset above.
                    if ((removed || !items.ContainsKey(itemId))
                        && served.VisibleIds.Contains(itemId))
                    {
                        removedIds.Add(itemId);
                    }
                }

                PublishServedState(authorizationKey, items.Keys);
                return new ContentDelta(
                    contentEpoch,
                    currentRevision,
                    resetRequired: false,
                    items,
                    removedIds.OrderBy(static id => id, StringComparer.Ordinal).ToArray(),
                    rowsVisited);
            }
        }

        internal ContentDelta GetCurrentContentControl(JUser user)
        {
            ArgumentNullException.ThrowIfNull(user);
            var contentEpoch = ContentEpochFor(AuthorizationKey(user));
            lock (_contentGate)
            {
                return new ContentDelta(
                    contentEpoch,
                    _contentRevision,
                    resetRequired: false,
                    new Dictionary<string, TagCacheEntry>(StringComparer.Ordinal),
                    Array.Empty<string>(),
                    journalRowsVisited: 0);
            }
        }

        private static ContentDelta ContentResetLocked(string contentEpoch, long currentRevision)
            => new(
                contentEpoch,
                currentRevision,
                resetRequired: true,
                new Dictionary<string, TagCacheEntry>(StringComparer.Ordinal),
                Array.Empty<string>(),
                journalRowsVisited: 0);

        /// <summary>
        /// Get cache entries filtered by a user's library access.
        /// User access IDs are cached for 60 seconds to avoid expensive DB queries.
        /// Optionally returns only entries modified after a given timestamp.
        /// </summary>
        public Dictionary<string, TagCacheEntry> GetCacheForUser(JUser user, long? since = null)
        {
            ArgumentNullException.ThrowIfNull(user);
            ConcurrentDictionary<string, TagCacheEntry> cache;
            lock (_contentGate)
            {
                // A failed full publication can roll back the replacement. Capture
                // only after that transaction commits or restores the prior cache.
                cache = _cache;
            }
            OnAfterUserCacheSnapshotForTest?.Invoke();
            var authorizationKey = AuthorizationKey(user);

            // Check user access cache
            HashSet<string> accessibleSet;
            if (_userAccessCache.TryGetValue(authorizationKey, out var cached) && DateTime.UtcNow - cached.CachedAt < UserAccessCacheTtl)
            {
                accessibleSet = cached.Ids;
            }
            else
            {
                OnAfterUserAccessCacheMissForTest?.Invoke();
                var flight = _userAccessInFlight.GetOrAdd(
                    authorizationKey,
                    _ => new Lazy<HashSet<string>>(
                        () =>
                        {
                            if (_userAccessCache.TryGetValue(authorizationKey, out var published)
                                && DateTime.UtcNow - published.CachedAt < UserAccessCacheTtl)
                            {
                                return published.Ids;
                            }

                            var accessibleIds = _libraryManager.GetItemIds(new InternalItemsQuery(user)
                            {
                                IncludeItemTypes = TaggableTypes.ToArray(),
                                Recursive = true,
                            });
                            var result = new HashSet<string>(
                                accessibleIds.Select(id => id.ToString("N").ToLowerInvariant()));
                            _userAccessCache.Set(
                                authorizationKey,
                                (result, DateTime.UtcNow),
                                UserAccessCacheTtl);
                            return result;
                        },
                        LazyThreadSafetyMode.ExecutionAndPublication));
                try
                {
                    accessibleSet = flight.Value;
                }
                finally
                {
                    ((ICollection<KeyValuePair<string, Lazy<HashSet<string>>>>)_userAccessInFlight)
                        .Remove(new KeyValuePair<string, Lazy<HashSet<string>>>(authorizationKey, flight));
                }
            }

            var result = new Dictionary<string, TagCacheEntry>();
            foreach (var kvp in cache)
            {
                if (!accessibleSet.Contains(kvp.Key)) continue;
                if (since.HasValue && kvp.Value.LastUpdated <= since.Value) continue;
                result[kvp.Key] = kvp.Value;
            }

            return result;
        }

        private static string AuthorizationKey(JUser user)
            => AuthorizationKey(user.Id.ToString("N"), user.RowVersion);

        private static string AuthorizationKey(string userKey, uint rowVersion)
            => string.Concat(userKey, ":", rowVersion.ToString(CultureInfo.InvariantCulture));

        private string ContentEpochFor(string authorizationKey)
            => $"{_contentEpoch}:{authorizationKey}";

        /// <summary>
        /// Select a small, server-generated set of cache entries for one user without
        /// enumerating the shared cache or materialising the user's full accessible-id
        /// set. Missing and inaccessible ids are intentionally omitted; the controller
        /// still returns them in <c>projectionIds</c> as deletion/access tombstones.
        /// </summary>
        internal Dictionary<string, TagCacheEntry> GetCacheEntriesForUserByIds(
            JUser user,
            IEnumerable<string> itemIds)
        {
            ArgumentNullException.ThrowIfNull(user);
            ArgumentNullException.ThrowIfNull(itemIds);

            ConcurrentDictionary<string, TagCacheEntry> cache;
            lock (_contentGate)
            {
                // Do not expose a replacement while its disk commit can still fail
                // and roll back under the same gate.
                cache = _cache;
            }
            var result = new Dictionary<string, TagCacheEntry>(StringComparer.Ordinal);
            foreach (var itemId in itemIds)
            {
                if (!Guid.TryParseExact(itemId, "N", out var id))
                {
                    continue;
                }

                var key = id.ToString("N");
                if (result.ContainsKey(key) || !cache.TryGetValue(key, out var entry))
                {
                    continue;
                }

                // This overload performs Jellyfin's per-user access validation. It
                // is O(number of projection changes), unlike GetCacheForUser's full
                // GetItemIds query + shared-cache scan.
                if (_libraryManager.GetItemById<BaseItem>(id, user) == null)
                {
                    continue;
                }

                result[key] = entry;
            }

            return result;
        }

        /// <summary>
        /// Read shared Episode evidence for ids already returned by a caller-scoped
        /// library query. This method performs no authorization by design; only the
        /// request-scoped language projector may call it with those verified ids.
        /// </summary>
        internal Dictionary<Guid, TagCacheEntry> GetCachedEntriesByIds(IEnumerable<Guid> itemIds)
        {
            ArgumentNullException.ThrowIfNull(itemIds);
            ConcurrentDictionary<string, TagCacheEntry> cache;
            lock (_contentGate)
            {
                cache = _cache;
            }

            var result = new Dictionary<Guid, TagCacheEntry>();
            foreach (var id in itemIds)
            {
                if (id != Guid.Empty && cache.TryGetValue(id.ToString("N"), out var entry))
                {
                    result[id] = entry;
                }
            }

            return result;
        }

        // ── Spoiler Guard per-user tag-strip (F3) ────────────────────────────
        //
        // The JC tag pipeline reads the server cache BEFORE it fetches per-batch
        // tag-data, so a guarded (unwatched, spoiler-listed) card would still
        // render rating/genre overlays from the cached entry unless we strip the
        // cache response too. TagCacheService stores ONE shared TagCacheEntry per
        // item across ALL users, so the strip NEVER mutates a cached entry — it
        // replaces the affected key with a stripped Clone() for this response only.
        //
        // The gating logic (scope + watched) is pulled out into pure static helpers
        // so the controller can inject the runtime facts as delegates
        // (IUserDataManager / ILibraryManager) and the unit tests can drive it with
        // in-memory fakes — no live library required.

        internal enum TagStripDecision
        {
            /// <summary>Not in spoiler scope, or already watched → serve the shared entry unchanged.</summary>
            Keep,
            /// <summary>Exempt season (S≤1 or any episode watched) → strip only the series-fallback rating.</summary>
            SeasonRatingOnly,
            /// <summary>Guarded + unwatched → full strip per the enabled toggles.</summary>
            Strip,
        }

        /// <summary>
        /// The rating projection shared by every guarded-Season response surface.
        /// <see cref="Suppressed"/> is deliberately independent from whether either
        /// source rating was populated: clients must not fall back to the parent
        /// Series when policy says ratings are hidden and the Season itself happens
        /// to carry null ratings.
        /// </summary>
        internal readonly record struct GuardedSeasonRatingProjection(
            float? CommunityRating,
            float? CriticRating,
            bool Suppressed);

        /// <summary>
        /// Canonical guarded-Season decision. Season 0/1 and a later Season with at
        /// least one watched episode keep their non-rating metadata, but ratings stay
        /// hidden because the Season card can carry the guarded Series fallback.
        /// Missing season numbering fails closed to the full configured strip.
        /// </summary>
        internal static TagStripDecision ResolveGuardedSeasonStripDecision(
            int? seasonIndexNumber,
            bool seasonAnyWatched)
        {
            if (!seasonIndexNumber.HasValue)
            {
                return TagStripDecision.Strip;
            }

            return seasonIndexNumber.Value <= 1 || seasonAnyWatched
                ? TagStripDecision.SeasonRatingOnly
                : TagStripDecision.Strip;
        }

        /// <summary>
        /// Apply the rating part of a guarded-Season decision without touching any
        /// non-rating fields. Used by the tag cache, tag-data endpoint and native DTO
        /// filter so their exemption behavior cannot drift again.
        /// </summary>
        internal static GuardedSeasonRatingProjection ProjectGuardedSeasonRatings(
            float? communityRating,
            float? criticRating,
            TagStripDecision decision,
            bool stripRatings)
        {
            var suppressed = stripRatings && decision != TagStripDecision.Keep;
            return suppressed
                ? new GuardedSeasonRatingProjection(null, null, Suppressed: true)
                : new GuardedSeasonRatingProjection(communityRating, criticRating, Suppressed: false);
        }

        /// <summary>
        /// Resolve the strip decision for a single cache entry. Pure: the two runtime
        /// facts the reference reads from the live library (played-state, season
        /// index / any-watched) are injected as delegates, so this mirrors the
        /// GetCacheForUser gating without a live ILibraryManager/IUserDataManager.
        /// </summary>
        /// <param name="key">Cache key (item id, N format).</param>
        /// <param name="entry">The shared cache entry (never mutated here).</param>
        /// <param name="spState">The requesting user's spoiler state.</param>
        /// <param name="isMovieInScope">Movie scope test (direct opt-in or via an opted-in collection).</param>
        /// <param name="isPlayed">Played test for Episode/Movie entries (false when the item can't be resolved → strip).</param>
        /// <param name="seasonIndexNumber">Season IndexNumber, or null when the id isn't a resolvable Season → strip.</param>
        /// <param name="seasonAnyWatched">Any-episode-watched probe, only invoked for guarded seasons with IndexNumber &gt; 1.</param>
        /// <param name="onKeyNotGuid">Callback when a cache key doesn't parse as a Guid (played check skipped, entry still stripped).</param>
        internal static TagStripDecision ResolveTagStripDecision(
            string key,
            TagCacheEntry entry,
            UserSpoilerBlur spState,
            Func<Guid, bool> isMovieInScope,
            Func<Guid, bool> isPlayed,
            Func<Guid, int?> seasonIndexNumber,
            Func<Guid, bool> seasonAnyWatched,
            Action<string> onKeyNotGuid)
        {
            var isEpisode = string.Equals(entry.Type, "Episode", StringComparison.Ordinal);
            var isSeason = string.Equals(entry.Type, "Season", StringComparison.Ordinal);
            var isMovie = string.Equals(entry.Type, "Movie", StringComparison.Ordinal);
            var isSeries = string.Equals(entry.Type, "Series", StringComparison.Ordinal);
            if (!isEpisode && !isSeason && !isMovie && !isSeries) return TagStripDecision.Keep;

            // Fail-closed: the user's policy read faulted with no last-known-good.
            // Strip every recognized entry regardless of scope or watched state rather
            // than leak genres / ratings / title-bearing stream data.
            if (spState.FailClosed) return TagStripDecision.Strip;

            // ── Scope gate ──
            if (isMovie)
            {
                // In scope if directly in Movies dict OR a child of an opted-in collection.
                if (!Guid.TryParse(key, out var mGuid)) return TagStripDecision.Keep;
                if (!isMovieInScope(mGuid)) return TagStripDecision.Keep;
            }
            else if (isSeries)
            {
                // Series-level entry: strip only when Spoiler Guard is on for THIS
                // series (key == series ID). Covers home-rail cards bound to seriesId
                // when "Use episode images in Next Up/Continue Watching" is OFF.
                if (!spState.Series.ContainsKey(key)) return TagStripDecision.Keep;
            }
            else
            {
                // Episode/Season resolved via the entry's captured parent SeriesId.
                if (string.IsNullOrEmpty(entry.SeriesId)) return TagStripDecision.Keep;
                if (!spState.Series.ContainsKey(entry.SeriesId)) return TagStripDecision.Keep;
            }

            // ── Watched / season-exempt gate ──
            // Played state is checked in-memory (no per-entry library scan). Episodes:
            // Played skips the strip. Seasons: S≤1 OR any-episode-watched are exempt
            // (poster + non-rating tags kept, only the series-fallback rating stripped).
            if (Guid.TryParse(key, out var entryGuid))
            {
                if (isEpisode || isMovie)
                {
                    if (isPlayed(entryGuid)) return TagStripDecision.Keep;
                }
                else if (isSeason)
                {
                    var sNum = seasonIndexNumber(entryGuid);
                    // S0/S1 posters always pass (their existence isn't a spoiler),
                    // as do seasons with any watched episode — "exempt". Avoid the
                    // episode walk for S0/S1, and fail closed when the Season cannot
                    // be resolved to an index number.
                    var anyWatched = sNum.HasValue
                        && sNum.Value > 1
                        && seasonAnyWatched(entryGuid);
                    return ResolveGuardedSeasonStripDecision(sNum, anyWatched);
                }
            }
            else
            {
                // A future TagCacheService key-format change is observable rather than
                // silently stripping every rail; the played check is skipped, but the
                // scope-matched entry is still stripped (fail-closed).
                onKeyNotGuid(key);
            }

            return TagStripDecision.Strip;
        }

        /// <summary>
        /// Produce the entry to serve for a resolved decision. NEVER mutates
        /// <paramref name="entry"/>: returns a stripped <see cref="TagCacheEntry.Clone"/>
        /// when something changes, else the original shared instance.
        /// </summary>
        internal static TagCacheEntry ApplyTagStrip(
            TagCacheEntry entry,
            TagStripDecision decision,
            bool stripGenres,
            bool stripRatings,
            bool sanitizeTitleStreams)
        {
            if (decision == TagStripDecision.Keep) return entry;

            if (decision == TagStripDecision.SeasonRatingOnly)
            {
                // Exempt seasons keep their poster + non-rating tags, but a season
                // carries only the series-FALLBACK rating (hidden on the guarded
                // series everywhere else). Strip just the rating so it can't surface
                // via the server tag cache. Nothing to do when ratings aren't being
                // stripped or the entry has no rating — serve the shared instance.
                var projected = ProjectGuardedSeasonRatings(
                    entry.CommunityRating,
                    entry.CriticRating,
                    decision,
                    stripRatings);
                if (projected.Suppressed && (entry.CommunityRating != null || entry.CriticRating != null))
                {
                    var seasonStripped = entry.Clone();
                    seasonStripped.CommunityRating = projected.CommunityRating;
                    seasonStripped.CriticRating = projected.CriticRating;
                    return seasonStripped;
                }
                return entry;
            }

            // Full strip. Clone before mutating — see TagCacheEntry.Clone().
            var stripped = entry.Clone();
            if (stripGenres)
            {
                stripped.Genres = Array.Empty<string>();
                stripped.AudioLanguages = null;
                stripped.StreamData = null;
            }
            if (stripRatings)
            {
                stripped.CommunityRating = null;
                stripped.CriticRating = null;
            }
            // When StreamData wasn't already wiped by the tag-strip but title
            // replacement / overview strip is on, sanitize its title-bearing fields.
            // Clone StreamData (same cross-user-mutation hazard). Quality Tags
            // recomputes overlay text from Codec/Width/Height/VideoRangeType, so
            // dropping DisplayTitle/ItemName/paths is acceptable.
            if (sanitizeTitleStreams && stripped.StreamData != null && !stripGenres)
            {
                var sd = stripped.StreamData;
                stripped.StreamData = new TagStreamData
                {
                    ItemName = null,
                    ItemPath = null,
                    Streams = sd.Streams?.Select(st => new TagMediaStream
                    {
                        Type = st.Type,
                        Language = st.Language,
                        Codec = st.Codec,
                        CodecTag = st.CodecTag,
                        Profile = st.Profile,
                        Width = st.Width,
                        Height = st.Height,
                        Channels = st.Channels,
                        ChannelLayout = st.ChannelLayout,
                        VideoRangeType = st.VideoRangeType,
                        DisplayTitle = null,
                        IsDefault = st.IsDefault,
                        Index = st.Index,
                        SourceIndex = st.SourceIndex,
                    }).ToList(),
                    Sources = sd.Sources?.Select(_ => new TagMediaSource
                    {
                        Path = null,
                        Name = null,
                    }).ToList(),
                };
            }
            return stripped;
        }

        /// <summary>
        /// Walk a per-user cache response and replace each guarded entry with its
        /// stripped clone. Mutates the supplied dictionary (a per-request result), not
        /// the shared cache. <paramref name="resolve"/> yields the per-entry decision.
        /// Cancellation propagates (BI-PERF-037): the caller must treat it as a
        /// failed request, never serve the partially stripped dictionary.
        /// </summary>
        internal static void StripCacheForUser(
            IDictionary<string, TagCacheEntry> items,
            bool stripGenres,
            bool stripRatings,
            bool sanitizeTitleStreams,
            Func<string, TagCacheEntry, TagStripDecision> resolve,
            CancellationToken cancellationToken = default)
        {
            foreach (var key in items.Keys.ToList())
            {
                cancellationToken.ThrowIfCancellationRequested();
                var entry = items[key];
                if (entry == null) continue;
                var decision = resolve(key, entry);
                if (decision == TagStripDecision.Keep) continue;
                items[key] = ApplyTagStrip(entry, decision, stripGenres, stripRatings, sanitizeTitleStreams);
            }
        }

        /// <summary>
        /// Load the cache from disk on startup.
        /// </summary>
        public void LoadFromDisk()
            => LoadFromDisk(canPublish: null, onWriterGuardAcquired: null);

        internal bool LoadFromDisk(
            TagCachePublicationFence? canPublish,
            Action? onWriterGuardAcquired = null)
        {
            Interlocked.Increment(ref _loadFromDiskCalls);
            if (!AcquireFlushGuard(maxSpins: _rebuildFlushGuardSpins, spinMs: 10))
            {
                _logger.LogWarning("[TagCache] Could not acquire the writer guard for a stable disk load.");
                return false;
            }

            try
            {
                onWriterGuardAcquired?.Invoke();
                var path = CacheFilePath;
                if (File.Exists(RepairMarkerPath))
                {
                    _logger.LogInformation("[TagCache] Incomplete shutdown repair marker found; rebuilding from the library while preserving the last complete snapshot bytes.");
                    return false;
                }

                if (!File.Exists(path))
                {
                    _logger.LogInformation("[TagCache] No cache file found, starting empty");
                    return false;
                }

                try
                {
                    var json = File.ReadAllText(path);
                    OnAfterDiskReadForTest?.Invoke();
                    var data = JsonSerializer.Deserialize<TagCacheDiskFormat>(json);
                    if (data?.Items != null
                        && data.CollectionMembers != null
                        && data.UnindexedCollectionIds != null)
                    {
                        if (data.IncompleteRepair)
                        {
                            _logger.LogInformation("[TagCache] Discarding cache with an incomplete shutdown repair; rebuilding from the library.");
                            return false;
                        }

                        // Discard a cache written by an older schema (e.g. predating
                        // SeriesId) rather than serving entries the strip paths can't
                        // process. Starting empty is safe — the Build task rebuilds it.
                        if (data.SchemaVersion != CurrentCacheSchemaVersion)
                        {
                            _logger.LogInformation($"[TagCache] On-disk cache schema v{data.SchemaVersion} != current v{CurrentCacheSchemaVersion}; discarding {data.Items.Count} entries and rebuilding on next scan.");
                            return false;
                        }
                        var loaded = new ConcurrentDictionary<string, TagCacheEntry>(data.Items);
                        var loadedMembers = data.CollectionMembers;
                        var loadedUnindexed = data.UnindexedCollectionIds;
                        if (!ValidateCollectionMembershipSnapshot(loaded, loadedMembers, loadedUnindexed))
                        {
                            _logger.LogInformation("[TagCache] Discarding malformed collection membership snapshot and rebuilding from the library.");
                            return false;
                        }
                        var loadedParents = BuildCollectionParents(loadedMembers);
                        lock (_contentGate)
                        {
                            if (Volatile.Read(ref _suspended) != 0
                                || (canPublish != null && !canPublish()))
                            {
                                _logger.LogInformation("[TagCache] Discarded disk load because its lifecycle generation is no longer enabled.");
                                return false;
                            }

                            _cache = loaded;
                            _collectionMembers = loadedMembers;
                            _collectionParents = loadedParents;
                            _unindexedCollections = loadedUnindexed;
                            Interlocked.Exchange(ref _version, data.Version);
                            Interlocked.Exchange(ref _lastModified, data.LastModified);
                        }

                        _logger.LogInformation($"[TagCache] Loaded {_cache.Count} entries from disk (v{data.Version}, schema v{data.SchemaVersion})");
                        return true;
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning($"[TagCache] Failed to load cache from disk: {ex.Message}");
                }

                return false;
            }
            finally
            {
                Interlocked.Exchange(ref _flushing, 0);
            }
        }

        /// <summary>
        /// Persist the cache to disk using atomic write (temp file + rename).
        /// </summary>
        public bool SaveToDisk()
            => SaveToDisk(writerGuardHeld: false);

        private bool SaveToDisk(
            bool writerGuardHeld,
            TagCachePublicationFence? canCommit = null,
            bool clearRepairMarker = false)
        {
            var acquired = false;
            if (!writerGuardHeld)
            {
                acquired = AcquireFlushGuard(maxSpins: _rebuildFlushGuardSpins, spinMs: 10);
                if (!acquired)
                {
                    MarkDirty();
                    _logger.LogWarning("[TagCache] Could not acquire the writer guard for a stable disk snapshot.");
                    return false;
                }
            }

            try
            {
                lock (_saveLock)
                {
                    if (Volatile.Read(ref _suspended) != 0)
                    {
                        return false;
                    }

                    Interlocked.Increment(ref _saveToDiskCalls);
                    try
                    {
                        var dir = Path.GetDirectoryName(CacheFilePath);
                        if (dir != null) Directory.CreateDirectory(dir);

                        // The writer guard stays held for streaming so this reference is
                        // an immutable cache/metadata snapshot without an O(N) clone.
                        var versionAtSnapshot = Interlocked.Read(ref _dirtyVersion);
                        var cacheSnapshot = _cache;
                        var collectionMembersSnapshot = _collectionMembers;
                        var unindexedCollectionsSnapshot = _unindexedCollections;
                        var cacheVersion = Interlocked.Read(ref _version);
                        var lastModified = Interlocked.Read(ref _lastModified);
                        var incompleteRepair = Volatile.Read(ref _repairIncomplete) != 0;

                        OnAfterSnapshotForTest?.Invoke();

                    // Stream directly into AtomicFile's durable temp sibling. The old
                    // Dictionary clone + complete JSON string briefly retained two
                    // additional O(N) representations beside old/new cache snapshots.
                        OnBeforeCachePersistForTest?.Invoke();
                        var committed = AtomicFile.WriteVia(CacheFilePath, stream =>
                        {
                            using var writer = new Utf8JsonWriter(stream);
                            writer.WriteStartObject();
                            writer.WriteNumber(nameof(TagCacheDiskFormat.SchemaVersion), CurrentCacheSchemaVersion);
                            writer.WriteNumber(nameof(TagCacheDiskFormat.Version), cacheVersion);
                            writer.WriteNumber(nameof(TagCacheDiskFormat.LastModified), lastModified);
                            writer.WriteBoolean(nameof(TagCacheDiskFormat.IncompleteRepair), incompleteRepair);
                            writer.WritePropertyName(nameof(TagCacheDiskFormat.Items));
                            JsonSerializer.Serialize(writer, cacheSnapshot);
                            writer.WritePropertyName(nameof(TagCacheDiskFormat.CollectionMembers));
                            JsonSerializer.Serialize(writer, collectionMembersSnapshot);
                            writer.WritePropertyName(nameof(TagCacheDiskFormat.UnindexedCollectionIds));
                            JsonSerializer.Serialize(writer, unindexedCollectionsSnapshot);
                            writer.WriteEndObject();
                            writer.Flush();
                        }, () => AcquireCommitLease(canCommit));
                        if (!committed)
                        {
                            MarkDirty();
                            _logger.LogInformation("[TagCache] Discarded a completed disk temp file because its lifecycle generation is no longer enabled.");
                            return false;
                        }

                        if (clearRepairMarker && !incompleteRepair)
                        {
                            AtomicFile.DeleteIfExists(RepairMarkerPath);
                        }

                    // Only clear the dirty bit if no flush recorded a change after our snapshot. If a
                    // concurrent flush bumped _dirtyVersion in the snapshot→persist window, leave _dirty
                    // set so the debounced timer persists the newer state — never wipe an unpersisted
                    // change. (Also write-failure-safe: a throw above skips the clear entirely.)
                        if (Interlocked.Read(ref _dirtyVersion) == versionAtSnapshot)
                        {
                            _dirty = false;
                        }

                        _logger.LogInformation($"[TagCache] Saved {cacheSnapshot.Count} entries to disk");
                        return true;
                    }
                    catch (Exception ex)
                    {
                        MarkDirty();
                        _logger.LogError($"[TagCache] Failed to save cache to disk: {ex.Message}");
                        return false;
                    }
                }
            }
            finally
            {
                if (acquired)
                {
                    Interlocked.Exchange(ref _flushing, 0);
                }
            }
        }

        private IDisposable? AcquireCommitLease(TagCachePublicationFence? canCommit)
        {
            Monitor.Enter(_lifecycleGate);
            if (Volatile.Read(ref _suspended) != 0
                || (canCommit != null && !canCommit()))
            {
                Monitor.Exit(_lifecycleGate);
                return null;
            }

            return new MonitorLease(_lifecycleGate);
        }

        private bool PersistIncompleteRepairMarker()
        {
            try
            {
                var dir = Path.GetDirectoryName(RepairMarkerPath);
                if (dir != null) Directory.CreateDirectory(dir);

                // Do not wait behind the active cache writer or replace the last
                // complete snapshot. The tiny sidecar makes startup rebuild while
                // preserving those durable bytes for diagnostics/recovery.
                AtomicFile.WriteAllText(RepairMarkerPath, "incomplete\n");
                return true;
            }
            catch (Exception ex)
            {
                _logger.LogError($"[TagCache] Failed to persist the incomplete-repair marker: {ex.Message}");
                return false;
            }
        }

        // Mark the cache dirty and advance the dirty version. SaveToDisk uses the version to detect
        // a flush that dirtied the cache after its snapshot (see #3), so every dirty-mark must bump it.
        private void MarkDirty()
        {
            Interlocked.Increment(ref _dirtyVersion);
            _dirty = true;
        }

        // Test seams (Tests has InternalsVisibleTo) for the dirty-bit-preservation contract.
        internal void MarkDirtyForTest() => MarkDirty();

        internal bool IsDirtyForTest => _dirty;

        private void ScheduleDebouncedSave()
        {
            lock (_lifecycleGate)
            {
                if (Volatile.Read(ref _disposed) != 0 || Volatile.Read(ref _suspended) != 0) return;
                MarkDirty();
                // Reuse existing timer if possible, otherwise create a new one.
                // Change() resets the countdown without creating a new object.
                var existing = _debounceSaveTimer;
                if (existing != null)
                {
                    try
                    {
                        existing.Change(TimeSpan.FromSeconds(30), Timeout.InfiniteTimeSpan);
                        return;
                    }
                    catch (ObjectDisposedException) { }
                }

                var timer = new Timer(_ =>
                {
                    if (_dirty && Volatile.Read(ref _suspended) == 0) SaveToDisk();
                }, null, TimeSpan.FromSeconds(30), Timeout.InfiniteTimeSpan);
                var old = Interlocked.Exchange(ref _debounceSaveTimer, timer);
                if (old != null && !ReferenceEquals(old, timer))
                {
                    old.Dispose();
                }
            }
        }

        /// <summary>
        /// Resume accepting incremental work for a newly enabled lifecycle generation.
        /// The lifecycle owner keeps requests unavailable until a current snapshot has
        /// been loaded or built.
        /// </summary>
        internal void Resume()
        {
            lock (_lifecycleGate)
            {
                ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
                Interlocked.Increment(ref _lifecycleGeneration);
                Volatile.Write(ref _suspended, 0);
            }
        }

        /// <summary>
        /// Stop timers and queued work and drop the in-memory snapshot when server mode
        /// is disabled. The disk file is retained as last-good startup data, but cannot
        /// be served while the lifecycle readiness gate is closed.
        /// </summary>
        internal void Suspend()
        {
            Timer? flush;
            Timer? save;
            lock (_lifecycleGate)
            {
                if (Volatile.Read(ref _disposed) != 0)
                {
                    return;
                }

                Interlocked.Increment(ref _lifecycleGeneration);
                Volatile.Write(ref _suspended, 1);
                flush = Interlocked.Exchange(ref _flushTimer, null);
                save = Interlocked.Exchange(ref _debounceSaveTimer, null);
                SwapPendingContainerLocked(retireDetached: true);
                Interlocked.Exchange(ref _firstPendingTicks, 0);
                Interlocked.Exchange(ref _retryBackoffTicks, 0);
            }

            flush?.Dispose();
            save?.Dispose();

            // Do not block the synchronous configuration-save thread behind an O(N)
            // publication or fsync. Fast-path the clear when both gates are free;
            // otherwise queue one cleanup that re-checks suspension after the active
            // writer finishes. The readiness/config gates were revoked above already.
            if (!TryClearMemoryForDisabledMode())
            {
                ThreadPool.QueueUserWorkItem(_ => ClearMemoryForDisabledMode());
                _logger.LogInformation("[TagCache] Disabled mode revoked an in-flight writer; memory cleanup will complete after that writer exits.");
            }
        }

        private bool TryClearMemoryForDisabledMode()
        {
            if (!Monitor.TryEnter(_contentGate))
            {
                return false;
            }

            try
            {
                if (!Monitor.TryEnter(_saveLock))
                {
                    return false;
                }

                try
                {
                    ClearMemoryForDisabledModeLocked();
                    return true;
                }
                finally
                {
                    Monitor.Exit(_saveLock);
                }
            }
            finally
            {
                Monitor.Exit(_contentGate);
            }
        }

        private void ClearMemoryForDisabledMode()
        {
            lock (_contentGate)
            {
                lock (_saveLock)
                {
                    ClearMemoryForDisabledModeLocked();
                }
            }
        }

        private void ClearMemoryForDisabledModeLocked()
        {
            if (Volatile.Read(ref _suspended) == 0)
            {
                return;
            }

            _cache = new ConcurrentDictionary<string, TagCacheEntry>(StringComparer.Ordinal);
            _collectionMembers = new Dictionary<Guid, Guid[]>();
            _collectionParents = new Dictionary<Guid, Guid[]>();
            _unindexedCollections = new HashSet<Guid>();
            _userAccessCache.Clear();
            _userAccessInFlight.Clear();
            _servedContentStates.Clear();
            _dirty = false;
        }

        public void Dispose()
        {
            TagCachePendingChanges shutdownPending;
            lock (_lifecycleGate)
            {
                if (Interlocked.Exchange(ref _disposed, 1) != 0)
                {
                    return;
                }

                Interlocked.Increment(ref _lifecycleGeneration);
                // Keep the detached container writable until the in-flight writer releases
                // _flushing. A restore that captured it before disposal then completes before
                // the final drain below; a timeout is already covered by the repair marker.
                shutdownPending = SwapPendingContainerLocked(retireDetached: false);
            }

            var flush = Interlocked.Exchange(ref _flushTimer, null);
            flush?.Dispose(); // stops future callbacks; an in-flight one may still be applying

            // Take ownership of the flush guard before persisting. Timer.Dispose() does not wait
            // for a running callback, so without this Dispose could drain an already-emptied
            // _pending, skip the save, and lose the in-flight flush's applied batch (it only
            // schedules a debounced save that never fires during shutdown). Waiting for _flushing
            // to release means that flush has finished and set _dirty, so the save below catches it.
            var acquired = AcquireFlushGuard(maxSpins: _disposeFlushGuardSpins, spinMs: 10);
            var writerTimedOut = !acquired;

            // Apply anything still queued in the debounce window so a change made moments before
            // shutdown is persisted — matching the old synchronous handler, which applied to the
            // cache inline and let the trailing SaveToDisk() flush it. Without this, queued-but-
            // unflushed changes (and the fact that startup only rebuilds when the cache is empty)
            // would leave those items stale until the next event or the daily rebuild.
            try
            {
                if (!acquired)
                {
                    // The owner may be an incremental flush (which self-persists) OR a full
                    // reconcile that can still be cancelled/throw before its post-swap drain/save.
                    // Persist a fail-closed marker now; startup discards this snapshot rather than
                    // trusting pending work that shutdown could not prove was handed off.
                    Interlocked.Exchange(ref _repairIncomplete, 1);
                    MarkDirty();
                    PersistIncompleteRepairMarker();
                    _logger.LogWarning("[TagCache] Shutdown timed out waiting for an in-flight cache writer; marking the disk snapshot incomplete for startup rebuild.");
                }
                else if (ApplyPendingBatch(shutdownPending.Drain(), out var removed))
                {
                    Interlocked.Exchange(ref _lastModified, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                    // Persist a Version bump for a shutdown-time removal so clients reconnecting
                    // after restart (which loads Version from disk) drop the stale key.
                    if (removed) Interlocked.Increment(ref _version);
                    MarkDirty();
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"[TagCache] Failed to flush pending changes on dispose: {ex.Message}");
            }
            finally
            {
                if (acquired) Interlocked.Exchange(ref _flushing, 0);
            }

            var timer = Interlocked.Exchange(ref _debounceSaveTimer, null);
            timer?.Dispose();
            if (_dirty && !writerTimedOut) SaveToDisk();
        }

        /// <summary>
        /// Build a TagCacheEntry for a single library item.
        /// For Series/Season, resolves first-episode data server-side.
        /// If the media probe fails, the probe-independent data (own + inherited rating/genres) is
        /// still built and the entry is stamped SourceRevision == 0 (unconfirmed) so the reconcile
        /// retains the last-good streams and rebuilds it every cycle until the probe recovers,
        /// rather than confirming a degraded entry. Returns null only on an UNEXPECTED failure.
        /// </summary>
        private TagCacheEntry? BuildEntryForItem(BaseItem item)
        {
            try
            {
                var kind = item.GetBaseItemKind();
                var isContainer = kind == BaseItemKind.Series || kind == BaseItemKind.Season;
                var probeFailed = false;
                BaseItem? parentSeries = null;
                var parentSeriesResolved = false;
                BaseItem? ResolveParentSeriesOnce()
                {
                    if (!parentSeriesResolved)
                    {
                        parentSeriesResolved = true;
                        parentSeries = GetParentSeries(item);
                    }

                    return parentSeries;
                }

                // Capture parent series ID for Episodes/Seasons so the Spoiler
                // Guard filter can strip unwatched-episode entries without a
                // library lookup per entry on every GetTagCache request.
                string? seriesIdN = null;
                string? seasonIdN = null;
                if (item is MediaBrowser.Controller.Entities.TV.Episode tcEp)
                {
                    if (tcEp.SeriesId != Guid.Empty) seriesIdN = tcEp.SeriesId.ToString("N");
                    if (tcEp.SeasonId != Guid.Empty) seasonIdN = tcEp.SeasonId.ToString("N");
                }
                else if (item is MediaBrowser.Controller.Entities.TV.Season tcSeason)
                {
                    if (tcSeason.SeriesId != Guid.Empty) seriesIdN = tcSeason.SeriesId.ToString("N");
                }

                var entry = new TagCacheEntry
                {
                    Type = kind.ToString(),
                    TmdbId = item.ProviderIds?.TryGetValue("Tmdb", out var tmdbId) == true ? tmdbId : null,
                    Genres = item.Genres,
                    CommunityRating = item.CommunityRating,
                    CriticRating = item.CriticRating,
                    LastUpdated = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    SeriesId = seriesIdN,
                    SeasonId = seasonIdN,
                    // Capture the source revision so the reconcile can skip re-probing an
                    // item whose DateLastSaved is unchanged. Set here so both the daily
                    // reconcile and the incremental pending-batch preparer populate the gate key.
                    SourceRevision = item.DateLastSaved.Ticks,
                };

                if (isContainer)
                {
                    var firstEp = GetFirstEpisode(item);
                    if (firstEp != null)
                    {
                        entry.StreamSourceId = firstEp.Id.ToString("N");
                        if (entry.Genres == null || entry.Genres.Length == 0)
                        {
                            entry.Genres = firstEp.Genres;
                        }

                        var media = ExtractMediaData(firstEp);
                        if (media == null)
                        {
                            probeFailed = true;
                            entry.StreamData = new TagStreamData
                            {
                                ItemName = firstEp.Name,
                                ItemPath = string.IsNullOrEmpty(firstEp.Path) ? null : Path.GetFileName(firstEp.Path),
                            };
                        }
                        else
                        {
                            entry.StreamData = new TagStreamData
                            {
                                Streams = media.Value.Streams,
                                Sources = media.Value.Sources,
                                ItemName = firstEp.Name,
                                ItemPath = string.IsNullOrEmpty(firstEp.Path) ? null : Path.GetFileName(firstEp.Path)
                            };
                            entry.AudioLanguages = media.Value.Languages;
                        }
                    }

                    if (kind == BaseItemKind.Season && entry.CommunityRating == null)
                    {
                        var series = ResolveParentSeriesOnce();
                        if (series != null)
                        {
                            if (TagCacheRatingInheritance.ShouldInherit(
                                entry.CommunityRating,
                                entry.CriticRating))
                            {
                                entry.CommunityRating = series.CommunityRating;
                                entry.CriticRating = series.CriticRating;
                            }

                            if (entry.Genres == null || entry.Genres.Length == 0)
                            {
                                entry.Genres = series.Genres;
                            }
                        }
                    }

                    // For Season: store parent series TMDB ID + season number for user review key
                    if (kind == BaseItemKind.Season && item is MediaBrowser.Controller.Entities.TV.Season season)
                    {
                        var series = ResolveParentSeriesOnce();
                        if (series?.ProviderIds?.TryGetValue("Tmdb", out var seriesTmdb) == true)
                            entry.SeriesTmdbId = seriesTmdb;
                        entry.SeasonNumber = season.IndexNumber;
                    }
                }
                else
                {
                    entry.StreamSourceId = item.Id.ToString("N");
                    var media = ExtractMediaData(item);
                    if (media == null)
                    {
                        probeFailed = true;
                        entry.StreamData = new TagStreamData
                        {
                            ItemName = item.Name,
                            ItemPath = string.IsNullOrEmpty(item.Path) ? null : Path.GetFileName(item.Path),
                        };
                    }
                    else
                    {
                        entry.StreamData = new TagStreamData
                        {
                            Streams = media.Value.Streams,
                            Sources = media.Value.Sources,
                            ItemName = item.Name,
                            ItemPath = string.IsNullOrEmpty(item.Path) ? null : Path.GetFileName(item.Path)
                        };
                        entry.AudioLanguages = media.Value.Languages;
                    }

                    if (kind == BaseItemKind.Episode
                        && TagCacheRatingInheritance.ShouldInherit(
                            entry.CommunityRating,
                            entry.CriticRating))
                    {
                        var series = ResolveParentSeriesOnce();
                        if (series != null)
                        {
                            entry.CommunityRating = series.CommunityRating;
                            entry.CriticRating = series.CriticRating;
                        }
                    }

                    // For Episode: store parent series TMDB ID + season/episode numbers for user review key
                    if (kind == BaseItemKind.Episode && item is MediaBrowser.Controller.Entities.TV.Episode ep)
                    {
                        var series = ResolveParentSeriesOnce();
                        if (series?.ProviderIds?.TryGetValue("Tmdb", out var seriesTmdb) == true)
                            entry.SeriesTmdbId = seriesTmdb;
                        entry.SeasonNumber = ep.ParentIndexNumber;
                        entry.EpisodeNumber = ep.IndexNumber;
                    }
                }

                if (probeFailed)
                {
                    // Mark unconfirmed so the reconcile gate rebuilds this item every cycle until the
                    // probe recovers, and retains its last-good streams in the meantime. 0 also means
                    // "unconfirmed" for a pre-upgrade on-disk entry, so the semantics are consistent.
                    entry.SourceRevision = 0;
                }

                return entry;
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"[TagCache] Failed to build entry for {item.Id}: {ex.Message}");
                return null;
            }
        }

        // Returns null when the media probe itself FAILED (GetMediaSources threw), distinct from a
        // successful-but-empty result for an item that legitimately has no media. This matters for
        // the revision-gated reconcile: on a real failure BuildEntryForItem stamps SourceRevision==0
        // (unconfirmed) instead of the current revision, so the gate keeps rebuilding the item until
        // the probe recovers rather than confirming — and reusing — a silently-degraded entry.
        private (List<TagMediaStream> Streams, List<TagMediaSource> Sources, string[] Languages)? ExtractMediaData(BaseItem item)
        {
            var streams = new List<TagMediaStream>();
            var sources = new List<TagMediaSource>();
            var languages = new HashSet<string>();

            try
            {
                var mediaSources = item.GetMediaSources(false);
                for (var sourceIndex = 0; sourceIndex < mediaSources.Count; sourceIndex++)
                {
                    var source = mediaSources[sourceIndex];
                    sources.Add(new TagMediaSource
                    {
                        Path = string.IsNullOrEmpty(source.Path) ? null : Path.GetFileName(source.Path),
                        Name = source.Name
                    });

                    if (source.MediaStreams == null) continue;
                    foreach (var s in source.MediaStreams)
                    {
                        if (s.Type != MediaStreamType.Video && s.Type != MediaStreamType.Audio)
                            continue;

                        streams.Add(new TagMediaStream
                        {
                            Type = s.Type.ToString(),
                            Language = s.Language,
                            Codec = s.Codec,
                            CodecTag = s.CodecTag,
                            Profile = s.Profile,
                            Width = s.Width,
                            Height = s.Height,
                            Channels = s.Channels,
                            ChannelLayout = s.ChannelLayout,
                            VideoRangeType = s.VideoRangeType.ToString(),
                            DisplayTitle = s.DisplayTitle,
                            IsDefault = s.IsDefault,
                            Index = s.Index,
                            SourceIndex = sourceIndex
                        });

                        if (s.Type == MediaStreamType.Audio && !string.IsNullOrEmpty(s.Language))
                        {
                            var lang = s.Language.ToLowerInvariant();
                            if (lang != "und" && lang != "root")
                            {
                                languages.Add(lang);
                            }
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"[TagCache] Failed to extract media data for {item.Id}: {ex.Message}");
                return null; // real probe failure — signal it so the caller keeps last-good data
            }

            return (streams, sources, languages.ToArray());
        }

        private BaseItem? GetFirstEpisode(BaseItem container)
        {
            var epQuery = new InternalItemsQuery
            {
                ParentId = container.Id,
                IncludeItemTypes = new[] { BaseItemKind.Episode },
                Recursive = true,
                Limit = 1,
                OrderBy = new[] { (ItemSortBy.PremiereDate, JSortOrder.Ascending) },
            };
            return _libraryManager.GetItemList(epQuery).FirstOrDefault();
        }

        private BaseItem? GetParentSeries(BaseItem item)
        {
            Guid? seriesId = null;
            if (item is MediaBrowser.Controller.Entities.TV.Episode ep)
            {
                seriesId = ep.SeriesId;
            }
            else if (item is MediaBrowser.Controller.Entities.TV.Season season)
            {
                seriesId = season.SeriesId;
            }

            if (!seriesId.HasValue || seriesId.Value == Guid.Empty)
            {
                return null;
            }

            return _libraryManager.GetItemById<BaseItem>(seriesId.Value)
                ?? throw new InvalidOperationException(
                    $"Parent Series {seriesId.Value} for {item.Id} is not yet resolvable");
        }

        private CollectionMembershipSnapshot ReadCollectionMembers(Guid collectionId)
        {
            if (_linkedChildrenService == null)
            {
                return new CollectionMembershipSnapshot(Array.Empty<Guid>(), Unindexed: true);
            }

            var members = GetCollectionMemberIds(collectionId);
            // The pinned Jellyfin API returns a fully materialized list; validate it
            // immediately and never construct a larger union/reverse index from it.
            if (members.Count > TagCollectionLanguageCoverageProjector.MaximumMembershipEdgesPerRequest)
            {
                return new CollectionMembershipSnapshot(Array.Empty<Guid>(), Unindexed: true);
            }

            if (members.Any(static id => id == Guid.Empty))
            {
                throw new InvalidOperationException("Collection membership returned an empty id.");
            }

            return new CollectionMembershipSnapshot(
                members.Distinct().OrderBy(static id => id).ToArray(),
                Unindexed: false);
        }

        private static bool ValidateCollectionMembershipSnapshot(
            IReadOnlyDictionary<string, TagCacheEntry> cache,
            IReadOnlyDictionary<Guid, Guid[]> members,
            IReadOnlySet<Guid> unindexed)
        {
            var boxSets = cache.Where(static pair => string.Equals(pair.Value.Type, nameof(BaseItemKind.BoxSet), StringComparison.Ordinal))
                .Select(static pair => Guid.TryParseExact(pair.Key, "N", out var id) ? id : Guid.Empty)
                .ToHashSet();
            if (boxSets.Contains(Guid.Empty)
                || unindexed.Contains(Guid.Empty)
                || unindexed.Any(id => !boxSets.Contains(id))
                || members.Keys.Any(id => id == Guid.Empty || !boxSets.Contains(id) || unindexed.Contains(id))
                || !boxSets.SetEquals(members.Keys.Concat(unindexed)))
            {
                return false;
            }

            return members.Values.All(memberIds => memberIds != null
                && memberIds.Length <= TagCollectionLanguageCoverageProjector.MaximumMembershipEdgesPerRequest
                && memberIds.All(static id => id != Guid.Empty)
                && memberIds.Distinct().Count() == memberIds.Length);
        }

        private static Dictionary<Guid, Guid[]> BuildCollectionParents(
            IReadOnlyDictionary<Guid, Guid[]> membersByCollection)
        {
            var mutable = new Dictionary<Guid, List<Guid>>();
            foreach (var (collectionId, memberIds) in membersByCollection)
            {
                foreach (var memberId in memberIds)
                {
                    if (!mutable.TryGetValue(memberId, out var parents))
                    {
                        parents = new List<Guid>();
                        mutable[memberId] = parents;
                    }

                    parents.Add(collectionId);
                }
            }

            return mutable.ToDictionary(
                static pair => pair.Key,
                static pair => pair.Value.Distinct().OrderBy(static id => id).ToArray());
        }

        private static void AddKnownParents(
            IReadOnlyDictionary<Guid, Guid[]> parentsByMember,
            Guid memberId,
            ISet<Guid> destination)
        {
            if (parentsByMember.TryGetValue(memberId, out var parents))
            {
                destination.UnionWith(parents);
            }
        }

        private static bool CollectionMembershipChanged(
            Guid collectionId,
            IReadOnlyDictionary<Guid, Guid[]> before,
            IReadOnlyDictionary<Guid, Guid[]> after)
        {
            before.TryGetValue(collectionId, out var oldMembers);
            after.TryGetValue(collectionId, out var newMembers);
            return !(oldMembers ?? Array.Empty<Guid>()).SequenceEqual(newMembers ?? Array.Empty<Guid>());
        }

        private class TagCacheDiskFormat
        {
            // On-disk entry schema. Absent (0) in caches written before this
            // field existed, so they read as != CurrentCacheSchemaVersion and
            // are discarded + rebuilt. Distinct from Version (content revision).
            public int SchemaVersion { get; set; }
            public long Version { get; set; }
            public long LastModified { get; set; }
            public bool IncompleteRepair { get; set; }
            public Dictionary<string, TagCacheEntry> Items { get; set; } = new();
            public Dictionary<Guid, Guid[]>? CollectionMembers { get; set; }
            public HashSet<Guid>? UnindexedCollectionIds { get; set; }
        }

        private readonly record struct CollectionMembershipSnapshot(Guid[] MemberIds, bool Unindexed);
    }
}
