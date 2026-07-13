using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Model;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services
{
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
        private volatile ConcurrentDictionary<string, TagCacheEntry> _cache = new();
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

        // Test seam: invoked inside BuildFullCache while the flush guard is held, just BEFORE the
        // cache swap, so a test can simulate an incremental flush firing mid-rebuild.
        internal Action? OnBeforeSwapForTest;

        // Test seam: invoked inside FlushPending after the batch is applied but BEFORE the flush
        // guard (_flushing) is released, so a test can park a flush in the "drained + applied, still
        // holding the guard" state and drive the rebuild against it deterministically.
        internal Action? OnAfterFlushApplyForTest;

        // Incremental cache maintenance. Library-scan events are recorded here (O(1),
        // no DB/probe work) and drained by a debounced background worker so scans are
        // never blocked and repeated hits on the same id coalesce to one rebuild.
        private readonly TagCachePendingChanges _pending = new();
        private Timer? _flushTimer;
        private long _firstPendingTicks; // 0 = nothing pending since last flush
        private int _flushing;           // 0/1 non-reentrancy guard for the worker
        private static readonly TimeSpan FlushDebounce = TimeSpan.FromSeconds(3);
        private static readonly TimeSpan FlushMaxWait = TimeSpan.FromSeconds(30);

        // Spin budget the full rebuild uses to acquire the flush guard (spins × 10ms ≈ 30s). Far
        // larger than Dispose's 5s default: a rebuild that can't take the guard must NOT fall back
        // to a lossy swap (see BuildFullCache), so it waits out an in-flight flush instead. A field
        // (not a const) only so a test can shrink it to exercise the wait/abort path without a real
        // multi-second wait.
        private int _rebuildFlushGuardSpins = 3000;
        internal void SetRebuildFlushGuardSpinsForTest(int spins) => _rebuildFlushGuardSpins = spins;

        // Bump whenever a TagCacheEntry field the STRIP paths depend on is added,
        // so a cache serialized by an older build is discarded and rebuilt. v2
        // added SeriesId, which the Spoiler Guard tag-strip requires: a v1 cache
        // has null SeriesId on every episode, so the strip skips them and unstripped
        // ratings leak onto guarded cards via renderFromServerCache. Discarding
        // starts empty (client falls back to the live/per-batch strip) until rebuild.
        private const int CurrentCacheSchemaVersion = 2;

        // User access cache: avoids expensive GetItemIds query on every request
        private readonly ConcurrentDictionary<string, (HashSet<string> Ids, DateTime CachedAt)> _userAccessCache = new();
        private static readonly TimeSpan UserAccessCacheTtl = TimeSpan.FromSeconds(60);

        public static readonly HashSet<BaseItemKind> TaggableTypes = new()
        {
            BaseItemKind.Movie,
            BaseItemKind.Episode,
            BaseItemKind.Series,
            BaseItemKind.Season,
            BaseItemKind.BoxSet,
        };

        public TagCacheService(ILibraryManager libraryManager, IApplicationPaths applicationPaths, ILogger<TagCacheService> logger)
        {
            _libraryManager = libraryManager;
            _applicationPaths = applicationPaths;
            _logger = logger;
        }

        public long Version => Interlocked.Read(ref _version);
        public long LastModified => Interlocked.Read(ref _lastModified);
        public int Count => _cache.Count;

        // Test seams for the user-access cache invalidation contract (Tests has InternalsVisibleTo).
        internal int UserAccessCacheCount => _userAccessCache.Count;

        internal void SeedUserAccessCacheForTest(string userKey, params string[] itemIds)
            => _userAccessCache[userKey] = (
                new HashSet<string>(itemIds, StringComparer.Ordinal),
                DateTime.UtcNow);

        internal void FlushPendingForTest() => FlushPending();

        internal bool ContainsKeyForTest(string key) => _cache.ContainsKey(key);

        internal void SeedEntryForTest(string key, TagCacheEntry entry) => _cache[key] = entry;

        // Deterministic controller-cursor race seams. A test captures the reader's
        // dictionary, then swaps the live cache/cursor exactly where a reconcile can.
        internal Action? OnAfterUserCacheSnapshotForTest;

        internal void SwapCacheAndCursorForTest(
            IReadOnlyDictionary<string, TagCacheEntry> entries,
            long version,
            long lastModified)
        {
            _cache = new ConcurrentDictionary<string, TagCacheEntry>(entries, StringComparer.Ordinal);
            Interlocked.Exchange(ref _version, version);
            Interlocked.Exchange(ref _lastModified, lastModified);
        }

        // Read the live cache entry for a key (or null). Lets reconcile tests assert reference
        // identity (proving an unchanged item was reused, not re-probed) and timestamp retention.
        internal TagCacheEntry? GetEntryForTest(string key) => _cache.TryGetValue(key, out var e) ? e : null;

        private string CacheFilePath =>
            Path.Combine(_applicationPaths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinCanopy", "tag-cache.json");

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
        {
            _logger.LogInformation("[TagCache] Starting cache reconcile...");
            var sw = System.Diagnostics.Stopwatch.StartNew();

            // Serialize the reconcile against incremental flushes: hold the flush guard across the
            // whole pass + swap. While we hold it, a FlushPending that fires sees _flushing==1 and
            // re-arms WITHOUT draining (it never mutates the OLD _cache), so events raised during
            // the reconcile stay in _pending and are applied onto the NEW cache below.
            //
            // Crucially we take the guard BEFORE the library snapshot below. If a flush is ALREADY
            // running when we start it has already drained _pending and is mutating _cache — its
            // deltas are gone from _pending, so proceeding to swap would silently drop them (the
            // post-swap drain finds nothing to re-apply). That is the lost-update window. So instead
            // of a lossy timeout-and-proceed, we WAIT (bounded) for the in-flight flush to finish;
            // once it does, its changes are committed to the library and the fresh scan below
            // captures them. Only if a flush is STILL running after ~30s do we abort this reconcile
            // rather than swap lossily — incremental flushes keep the cache fresh and the scheduled
            // task retries next cycle. AcquireFlushGuard polls (10ms sleeps), so this neither
            // busy-spins nor deadlocks (the single guard is always released by its holder).
            if (!AcquireFlushGuard(maxSpins: _rebuildFlushGuardSpins, spinMs: 10))
            {
                _logger.LogWarning("[TagCache] Skipping reconcile: an incremental flush is still running after the guard wait; retrying next cycle to avoid a lost-update swap.");
                return;
            }

            try
            {
                // Stable snapshot of the current cache. The guard keeps flushes from mutating it
                // while we reconcile, so both the rating pre-pass and the main loop read one state.
                var oldCache = _cache;

                var allItems = _libraryManager.GetItemList(new InternalItemsQuery
                {
                    IncludeItemTypes = TaggableTypes.ToArray(),
                    IsVirtualItem = false,
                    Recursive = true
                }).ToList();

                _logger.LogInformation($"[TagCache] Found {allItems.Count} taggable items");

                // Pass 1: which series' own rating changed since its cached entry was built. An
                // Episode with no rating of its own inherits its parent series' rating, so a series
                // rating change must re-derive those episodes even when the episode's own
                // DateLastSaved is unchanged. A Series entry stores the series' own rating verbatim
                // (no fallback), so comparing the live value against the old entry is exact.
                var seriesRatingChanged = new HashSet<Guid>();
                foreach (var item in allItems)
                {
                    if (item.GetBaseItemKind() != BaseItemKind.Series) continue;
                    var sKey = item.Id.ToString("N").ToLowerInvariant();
                    if (!oldCache.TryGetValue(sKey, out var oldSeries)
                        || oldSeries.CommunityRating != item.CommunityRating
                        || oldSeries.CriticRating != item.CriticRating)
                    {
                        seriesRatingChanged.Add(item.Id);
                    }
                }

                var newCache = new ConcurrentDictionary<string, TagCacheEntry>();
                var changed = false; // an add or a genuine content change (drives the ?since= delta)
                var processed = 0;

                foreach (var item in allItems)
                {
                    cancellationToken.ThrowIfCancellationRequested();

                    var key = item.Id.ToString("N").ToLowerInvariant();
                    var kind = item.GetBaseItemKind();
                    var revision = item.DateLastSaved.Ticks;
                    oldCache.TryGetValue(key, out var old);

                    var parentSeriesRatingChanged =
                        kind == BaseItemKind.Episode
                        && item is MediaBrowser.Controller.Entities.TV.Episode epDep
                        && seriesRatingChanged.Contains(epDep.SeriesId);

                    if (!ShouldRebuild(kind, old, revision, parentSeriesRatingChanged))
                    {
                        // Unchanged: reuse the existing entry verbatim — no media probe, timestamp
                        // preserved. old is non-null here (ShouldRebuild returns true when it is).
                        newCache[key] = old!;
                    }
                    else
                    {
                        var entry = BuildEntryForItem(item);
                        if (entry == null)
                        {
                            // Unexpected build failure (a bug, not a media-probe failure — those return
                            // a degraded entry below): keep the last-good entry rather than dropping it
                            // (dropping would look like a removal and force a client full reload). Its
                            // OLD SourceRevision keeps it a rebuild candidate next cycle.
                            if (old != null) newCache[key] = old;
                        }
                        else
                        {
                            // A degraded entry (media probe failed) carries SourceRevision == 0
                            // (unconfirmed): keep its fresh probe-independent data (own + inherited
                            // rating/genres) but retain the last-good streams, and leave it unconfirmed
                            // so the gate rebuilds it every cycle until the probe recovers.
                            if (entry.SourceRevision == 0 && old != null)
                            {
                                entry.StreamData = old.StreamData;
                                entry.AudioLanguages = old.AudioLanguages;
                            }

                            if (old != null && ContentEquals(old, entry))
                            {
                                // Rebuilt but content-identical (e.g. a container whose first episode
                                // is unchanged, or a no-op re-save): retain the old timestamp so the
                                // client delta doesn't churn. SourceRevision is still refreshed.
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
                    if (processed % 500 == 0)
                    {
                        progress?.Report((double)processed / allItems.Count * 100);
                    }
                }

                // A key that was cached but is no longer in the library is a removal — the one
                // transition the incremental ?since= delta cannot express (it carries no tombstone),
                // so it is the sole trigger for a client full reload via a Version bump.
                var removed = false;
                foreach (var key in oldCache.Keys)
                {
                    if (!newCache.ContainsKey(key)) { removed = true; break; }
                }

                OnBeforeSwapForTest?.Invoke();

                // Atomic reference swap — readers see old or new cache, never partial.
                _cache = newCache;

                if (changed || removed)
                {
                    Interlocked.Exchange(ref _lastModified, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                    // Added/updated/removed items may change a user's accessible set. Only cleared on
                    // an actual change so a no-op reconcile doesn't force every user to recompute.
                    _userAccessCache.Clear();
                }
                if (removed)
                {
                    Interlocked.Increment(ref _version);
                }

                // Apply events queued while we were reconciling onto the freshly-published cache, so
                // the swap can't strand a change that arrived mid-reconcile. A removal here bumps
                // Version too (same client-reload contract).
                if (ApplyPendingBatch(_pending.Drain(), out var drainRemoved))
                {
                    Interlocked.Exchange(ref _lastModified, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                }
                if (drainRemoved)
                {
                    Interlocked.Increment(ref _version);
                }

                progress?.Report(100);

                sw.Stop();
                _logger.LogInformation($"[TagCache] Reconcile complete: {_cache.Count} entries (changed={changed}, removed={removed || drainRemoved}) in {sw.Elapsed.TotalSeconds:F1}s");
            }
            finally
            {
                // We only reach the try after acquiring the guard above, so always release it.
                Interlocked.Exchange(ref _flushing, 0);
            }

            SaveToDisk();
        }

        /// <summary>
        /// Decide whether the reconcile must rebuild an item's entry, or can reuse the cached one.
        /// Pure so the gate can be unit-tested without a live library. A rebuild is required for a
        /// new item, for containers (Series/Season) whose derived data tracks their child episodes
        /// rather than their own timestamp, when the source revision changed, or when an Episode's
        /// parent-series rating changed (the episode inherits it when it has none of its own).
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
            _pending.Record(itemId, removed: false); // PERF(S1): O(1) record-and-defer, safe on the scan thread
            ScheduleFlush();
        }

        /// <summary>
        /// Queue an item to be removed from the cache. Called by TagCacheMonitor on
        /// ItemRemoved. Like <see cref="EnqueueUpdate"/>, this does no work on the
        /// caller's thread beyond recording the id.
        /// </summary>
        public void EnqueueRemoval(Guid itemId)
        {
            if (itemId == Guid.Empty) return;
            _pending.Record(itemId, removed: true);
            ScheduleFlush();
        }

        /// <summary>
        /// Stamp the first-pending time (if unset) and arm the debounced background flush.
        /// </summary>
        private void ScheduleFlush()
        {
            Interlocked.CompareExchange(ref _firstPendingTicks, DateTime.UtcNow.Ticks, 0);
            ArmFlushTimer(ComputeFlushDelay());
        }

        /// <summary>
        /// Arm (or reset) the single flush timer to fire once after <paramref name="due"/>.
        /// </summary>
        private void ArmFlushTimer(TimeSpan due)
        {
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

            var timer = new Timer(_ => FlushPending(), null, due, Timeout.InfiniteTimeSpan);
            var old = Interlocked.Exchange(ref _flushTimer, timer);
            if (old != null && !ReferenceEquals(old, timer))
            {
                old.Dispose();
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
            // Non-reentrant: if a flush already owns the batch, retry after the debounce.
            // (Retry via ArmFlushTimer, NOT ScheduleFlush: once the first pending change is older
            // than FlushMaxWait, ScheduleFlush would compute a zero delay and busy-spin the timer
            // until the running flush exits.)
            if (Interlocked.Exchange(ref _flushing, 1) == 1)
            {
                ArmFlushTimer(FlushDebounce);
                return;
            }

            try
            {
                Interlocked.Exchange(ref _firstPendingTicks, 0);
                if (ApplyPendingBatch(_pending.Drain(), out var removed))
                {
                    Interlocked.Exchange(ref _lastModified, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                    // A removal is the client's only full-reload trigger: the ?since= delta carries
                    // no tombstone, so bump Version so already-loaded clients drop the stale key.
                    // ScheduleDebouncedSave persists the bumped version.
                    if (removed) Interlocked.Increment(ref _version);
                    ScheduleDebouncedSave();
                }

                OnAfterFlushApplyForTest?.Invoke();
            }
            finally
            {
                Interlocked.Exchange(ref _flushing, 0);
                // Ids recorded while we were draining/applying: run again (cap-aware).
                if (!_pending.IsEmpty) ScheduleFlush();
            }
        }

        /// <summary>
        /// Spin-acquire the single-flush guard (<c>_flushing</c>) so no incremental flush mutates
        /// <c>_cache</c> concurrently. Returns false if it couldn't be taken within the cap (an
        /// unusually long in-flight flush) — the caller then proceeds best-effort rather than
        /// blocking a rebuild/shutdown indefinitely. Callers that acquired MUST release it with
        /// <c>Interlocked.Exchange(ref _flushing, 0)</c>.
        /// </summary>
        private bool AcquireFlushGuard(int maxSpins = 500, int spinMs = 10)
        {
            for (var i = 0; i < maxSpins; i++) // ~5s cap by default, well under the shutdown grace period
            {
                if (Interlocked.CompareExchange(ref _flushing, 1, 0) == 0)
                {
                    return true;
                }

                Thread.Sleep(spinMs);
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
        /// reporting whether any entry was actually removed from the cache. A removal is the only
        /// transition the client's ?since= delta can't express (no tombstone), so callers bump
        /// <see cref="Version"/> on it to force a client full reload. Wrapping the remove delegate
        /// keeps <see cref="ApplyBatch"/>'s tested signature untouched.
        /// </summary>
        private bool ApplyPendingBatch(IReadOnlyList<(Guid Id, bool Removed)> batch, out bool removedFromCache)
        {
            var removed = false;
            var changed = ApplyBatch(
                batch,
                RebuildEntry,
                id => { var r = RemoveEntry(id); if (r) removed = true; return r; });
            removedFromCache = removed;
            return changed;
        }

        /// <summary>
        /// Resolve an id to its live library item and (re)build its cache entry.
        /// Returns true if the cache was modified. Runs on the flush worker only.
        /// </summary>
        private bool RebuildEntry(Guid id)
        {
            var item = _libraryManager.GetItemById<BaseItem>(id);
            if (item == null) return false; // gone before we processed it; ItemRemoved cleans up

            var kind = item.GetBaseItemKind();
            if (!TaggableTypes.Contains(kind)) return false;

            var entry = BuildEntryForItem(item);
            if (entry == null) return false;

            var key = id.ToString("N").ToLowerInvariant();
            // A degraded entry (media probe failed) carries SourceRevision == 0: retain the last-good
            // streams and leave it unconfirmed so the next reconcile rebuilds it. Mirrors the
            // reconcile so an incremental event during a probe outage doesn't drop the streams.
            if (entry.SourceRevision == 0 && _cache.TryGetValue(key, out var existing) && existing != null)
            {
                entry.StreamData = existing.StreamData;
                entry.AudioLanguages = existing.AudioLanguages;
            }
            _cache[key] = entry;
            return true;
        }

        private bool RemoveEntry(Guid id)
        {
            var key = id.ToString("N").ToLowerInvariant();
            return _cache.TryRemove(key, out _);
        }

        /// <summary>
        /// Get cache entries filtered by a user's library access.
        /// User access IDs are cached for 60 seconds to avoid expensive DB queries.
        /// Optionally returns only entries modified after a given timestamp.
        /// </summary>
        public Dictionary<string, TagCacheEntry> GetCacheForUser(JUser user, long? since = null)
        {
            // Capture local reference for thread safety (cache reference may be swapped)
            var cache = _cache;
            OnAfterUserCacheSnapshotForTest?.Invoke();
            var userKey = user.Id.ToString("N");

            // Check user access cache
            HashSet<string> accessibleSet;
            if (_userAccessCache.TryGetValue(userKey, out var cached) && DateTime.UtcNow - cached.CachedAt < UserAccessCacheTtl)
            {
                accessibleSet = cached.Ids;
            }
            else
            {
                var accessibleIds = _libraryManager.GetItemIds(new InternalItemsQuery(user)
                {
                    IncludeItemTypes = TaggableTypes.ToArray(),
                    Recursive = true
                });
                accessibleSet = new HashSet<string>(
                    accessibleIds.Select(id => id.ToString("N").ToLowerInvariant())
                );
                _userAccessCache[userKey] = (accessibleSet, DateTime.UtcNow);
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

            // Capture the current dictionary once. A full reconcile may atomically
            // replace _cache while this request runs, but it never mutates this
            // captured dictionary after the swap.
            var cache = _cache;
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
            // Clone StreamData (same cross-user-mutation hazard). qualitytags.js
            // recomputes overlay text from Codec/Height/VideoRangeType, so dropping
            // DisplayTitle/ItemName/paths is acceptable.
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
                        Height = st.Height,
                        Channels = st.Channels,
                        ChannelLayout = st.ChannelLayout,
                        VideoRangeType = st.VideoRangeType,
                        DisplayTitle = null,
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
        /// </summary>
        internal static void StripCacheForUser(
            IDictionary<string, TagCacheEntry> items,
            bool stripGenres,
            bool stripRatings,
            bool sanitizeTitleStreams,
            Func<string, TagCacheEntry, TagStripDecision> resolve)
        {
            foreach (var key in items.Keys.ToList())
            {
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
        {
            var path = CacheFilePath;
            if (!File.Exists(path))
            {
                _logger.LogInformation("[TagCache] No cache file found, starting empty");
                return;
            }

            try
            {
                var json = File.ReadAllText(path);
                var data = JsonSerializer.Deserialize<TagCacheDiskFormat>(json);
                if (data?.Items != null)
                {
                    // Discard a cache written by an older schema (e.g. predating
                    // SeriesId) rather than serving entries the strip paths can't
                    // process. Starting empty is safe — the Build task rebuilds it.
                    if (data.SchemaVersion != CurrentCacheSchemaVersion)
                    {
                        _logger.LogInformation($"[TagCache] On-disk cache schema v{data.SchemaVersion} != current v{CurrentCacheSchemaVersion}; discarding {data.Items.Count} entries and rebuilding on next scan.");
                        return;
                    }
                    var loaded = new ConcurrentDictionary<string, TagCacheEntry>(data.Items);
                    _cache = loaded;
                    Interlocked.Exchange(ref _version, data.Version);
                    Interlocked.Exchange(ref _lastModified, data.LastModified);
                    _logger.LogInformation($"[TagCache] Loaded {_cache.Count} entries from disk (v{data.Version}, schema v{data.SchemaVersion})");
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"[TagCache] Failed to load cache from disk: {ex.Message}");
            }
        }

        /// <summary>
        /// Persist the cache to disk using atomic write (temp file + rename).
        /// </summary>
        public void SaveToDisk()
        {
            lock (_saveLock)
            {
                try
                {
                    var dir = Path.GetDirectoryName(CacheFilePath);
                    if (dir != null) Directory.CreateDirectory(dir);

                    // Capture the dirty version BEFORE reading _cache. A flush that lands after this
                    // (mutating _cache and bumping _dirtyVersion) is then detected below so we don't
                    // clear a dirty bit whose change we didn't actually persist.
                    var versionAtSnapshot = Interlocked.Read(ref _dirtyVersion);

                    var data = new TagCacheDiskFormat
                    {
                        SchemaVersion = CurrentCacheSchemaVersion,
                        Version = Interlocked.Read(ref _version),
                        LastModified = Interlocked.Read(ref _lastModified),
                        Items = new Dictionary<string, TagCacheEntry>(_cache)
                    };

                    OnAfterSnapshotForTest?.Invoke();

                    var json = JsonSerializer.Serialize(data, new JsonSerializerOptions { WriteIndented = false });
                    AtomicFile.WriteAllText(CacheFilePath, json);

                    // Only clear the dirty bit if no flush recorded a change after our snapshot. If a
                    // concurrent flush bumped _dirtyVersion in the snapshot→persist window, leave _dirty
                    // set so the debounced timer persists the newer state — never wipe an unpersisted
                    // change. (Also write-failure-safe: a throw above skips the clear entirely.)
                    if (Interlocked.Read(ref _dirtyVersion) == versionAtSnapshot)
                    {
                        _dirty = false;
                    }

                    _logger.LogInformation($"[TagCache] Saved {_cache.Count} entries to disk");
                }
                catch (Exception ex)
                {
                    _logger.LogError($"[TagCache] Failed to save cache to disk: {ex.Message}");
                }
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
                if (_dirty) SaveToDisk();
            }, null, TimeSpan.FromSeconds(30), Timeout.InfiniteTimeSpan);
            var old = Interlocked.Exchange(ref _debounceSaveTimer, timer);
            if (old != null && !ReferenceEquals(old, timer))
            {
                old.Dispose();
            }
        }

        public void Dispose()
        {
            var flush = Interlocked.Exchange(ref _flushTimer, null);
            flush?.Dispose(); // stops future callbacks; an in-flight one may still be applying

            // Take ownership of the flush guard before persisting. Timer.Dispose() does not wait
            // for a running callback, so without this Dispose could drain an already-emptied
            // _pending, skip the save, and lose the in-flight flush's applied batch (it only
            // schedules a debounced save that never fires during shutdown). Waiting for _flushing
            // to release means that flush has finished and set _dirty, so the save below catches it.
            var acquired = AcquireFlushGuard();

            // Apply anything still queued in the debounce window so a change made moments before
            // shutdown is persisted — matching the old synchronous handler, which applied to the
            // cache inline and let the trailing SaveToDisk() flush it. Without this, queued-but-
            // unflushed changes (and the fact that startup only rebuilds when the cache is empty)
            // would leave those items stale until the next event or the daily rebuild.
            try
            {
                if (ApplyPendingBatch(_pending.Drain(), out var removed))
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
            if (_dirty) SaveToDisk();
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

                // Capture parent series ID for Episodes/Seasons so the Spoiler
                // Guard filter can strip unwatched-episode entries without a
                // library lookup per entry on every GetTagCache request.
                string? seriesIdN = null;
                if (item is MediaBrowser.Controller.Entities.TV.Episode tcEp)
                {
                    if (tcEp.SeriesId != Guid.Empty) seriesIdN = tcEp.SeriesId.ToString("N");
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
                    // Capture the source revision so the reconcile can skip re-probing an
                    // item whose DateLastSaved is unchanged. Set here so BOTH the daily
                    // reconcile and the incremental RebuildEntry populate the gate key.
                    SourceRevision = item.DateLastSaved.Ticks,
                };

                if (isContainer)
                {
                    var firstEp = GetFirstEpisode(item);
                    if (firstEp != null)
                    {
                        if (entry.Genres == null || entry.Genres.Length == 0)
                        {
                            entry.Genres = firstEp.Genres;
                        }

                        var media = ExtractMediaData(firstEp);
                        if (media == null)
                        {
                            probeFailed = true; // leave StreamData/AudioLanguages for the caller to retain last-good
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
                        var series = GetParentSeries(item);
                        if (series != null)
                        {
                            entry.CommunityRating = series.CommunityRating;
                            entry.CriticRating = series.CriticRating;
                            if (entry.Genres == null || entry.Genres.Length == 0)
                            {
                                entry.Genres = series.Genres;
                            }
                        }
                    }

                    // For Season: store parent series TMDB ID + season number for user review key
                    if (kind == BaseItemKind.Season && item is MediaBrowser.Controller.Entities.TV.Season season)
                    {
                        var series = GetParentSeries(item);
                        if (series?.ProviderIds?.TryGetValue("Tmdb", out var seriesTmdb) == true)
                            entry.SeriesTmdbId = seriesTmdb;
                        entry.SeasonNumber = season.IndexNumber;
                    }
                }
                else
                {
                    var media = ExtractMediaData(item);
                    if (media == null)
                    {
                        probeFailed = true; // leave StreamData/AudioLanguages for the caller to retain last-good
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

                    if (kind == BaseItemKind.Episode && entry.CommunityRating == null)
                    {
                        var series = GetParentSeries(item);
                        if (series != null)
                        {
                            entry.CommunityRating = series.CommunityRating;
                            entry.CriticRating = series.CriticRating;
                        }
                    }

                    // For Episode: store parent series TMDB ID + season/episode numbers for user review key
                    if (kind == BaseItemKind.Episode && item is MediaBrowser.Controller.Entities.TV.Episode ep)
                    {
                        var series = GetParentSeries(item);
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
                foreach (var source in mediaSources)
                {
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
                            Height = s.Height,
                            Channels = s.Channels,
                            ChannelLayout = s.ChannelLayout,
                            VideoRangeType = s.VideoRangeType.ToString(),
                            DisplayTitle = s.DisplayTitle
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
            try
            {
                var epQuery = new InternalItemsQuery
                {
                    ParentId = container.Id,
                    IncludeItemTypes = new[] { BaseItemKind.Episode },
                    Recursive = true,
                    Limit = 1,
                    OrderBy = new[] { (ItemSortBy.PremiereDate, JSortOrder.Ascending) }
                };
                return _libraryManager.GetItemList(epQuery).FirstOrDefault();
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"[TagCache] Failed to get first episode for {container.Id}: {ex.Message}");
                return null;
            }
        }

        private BaseItem? GetParentSeries(BaseItem item)
        {
            try
            {
                Guid? seriesId = null;
                if (item is MediaBrowser.Controller.Entities.TV.Episode ep)
                    seriesId = ep.SeriesId;
                else if (item is MediaBrowser.Controller.Entities.TV.Season season)
                    seriesId = season.SeriesId;

                if (seriesId.HasValue && seriesId.Value != Guid.Empty)
                {
                    return _libraryManager.GetItemById<BaseItem>(seriesId.Value);
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"[TagCache] Failed to get parent series for {item.Id}: {ex.Message}");
            }
            return null;
        }

        private class TagCacheDiskFormat
        {
            // On-disk entry schema. Absent (0) in caches written before this
            // field existed, so they read as != CurrentCacheSchemaVersion and
            // are discarded + rebuilt. Distinct from Version (content revision).
            public int SchemaVersion { get; set; }
            public long Version { get; set; }
            public long LastModified { get; set; }
            public Dictionary<string, TagCacheEntry> Items { get; set; } = new();
        }
    }
}
