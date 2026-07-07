using Jellyfin.Plugin.JellyfinElevate.Services;
using Jellyfin.Plugin.JellyfinElevate.Tests.TestDoubles;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.Services
{
    /// <summary>
    /// Pins the off-thread flush machinery that keeps tag-cache maintenance off Jellyfin's library
    /// scan thread: the debounce-with-hard-cap due-time math, and the batch dispatch (updates rebuild,
    /// removals remove) with per-entry resilience. Host lookups are injected as delegates, so these
    /// run without a live ILibraryManager or the real Timer.
    /// </summary>
    public sealed class TagCacheServiceFlushTests
    {
        private static readonly TimeSpan Debounce = TimeSpan.FromSeconds(3);
        private static readonly TimeSpan MaxWait = TimeSpan.FromSeconds(30);

        // ApplyBatch only touches the logger + the delegates, so a null ILibraryManager is fine.
        private static TagCacheService NewService() =>
            new(null!, new StubAppPaths(Path.GetTempPath()), NullLogger<TagCacheService>.Instance);

        // ---- ComputeFlushDelay: debounce with a hard max-wait cap --------------------------

        [Fact]
        public void ComputeFlushDelay_NothingPending_ReturnsFullDebounce()
        {
            var due = TagCacheService.ComputeFlushDelay(0, DateTime.UtcNow, Debounce, MaxWait);
            Assert.Equal(Debounce, due);
        }

        [Fact]
        public void ComputeFlushDelay_EarlyInWindow_ReturnsDebounce()
        {
            var now = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
            var first = now.AddSeconds(-1); // 1s since the first pending change
            Assert.Equal(Debounce, TagCacheService.ComputeFlushDelay(first.Ticks, now, Debounce, MaxWait));
        }

        [Fact]
        public void ComputeFlushDelay_NearCap_ClampsToRemainingCap()
        {
            var now = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
            var first = now.AddSeconds(-28); // only 2s of cap left — less than the 3s debounce
            Assert.Equal(TimeSpan.FromSeconds(2), TagCacheService.ComputeFlushDelay(first.Ticks, now, Debounce, MaxWait));
        }

        [Fact]
        public void ComputeFlushDelay_PastCap_ReturnsZero()
        {
            var now = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
            var first = now.AddSeconds(-31); // cap already exceeded (continuous scan) -> flush now
            Assert.Equal(TimeSpan.Zero, TagCacheService.ComputeFlushDelay(first.Ticks, now, Debounce, MaxWait));
        }

        // ---- ApplyBatch: dispatch + resilience + change aggregation ------------------------

        [Fact]
        public void ApplyBatch_RoutesUpdatesToRebuildAndRemovalsToRemove()
        {
            using var svc = NewService();
            var rebuilt = new List<Guid>();
            var removed = new List<Guid>();
            var update = Guid.NewGuid();
            var delete = Guid.NewGuid();

            var changed = svc.ApplyBatch(
                new List<(Guid, bool)> { (update, false), (delete, true) },
                id => { rebuilt.Add(id); return true; },
                id => { removed.Add(id); return true; });

            Assert.True(changed);
            Assert.Equal(new[] { update }, rebuilt);  // update -> rebuild (dispatch not inverted)
            Assert.Equal(new[] { delete }, removed);  // removal -> remove
        }

        [Fact]
        public void ApplyBatch_ReturnsFalseWhenNothingModifiedTheCache()
        {
            using var svc = NewService();
            // e.g. an update whose GetItemById returned null, and a removal of an absent id.
            var changed = svc.ApplyBatch(
                new List<(Guid, bool)> { (Guid.NewGuid(), false), (Guid.NewGuid(), true) },
                _ => false,
                _ => false);

            Assert.False(changed);
        }

        [Fact]
        public void ApplyBatch_OneFailingEntryDoesNotAbortTheRest()
        {
            using var svc = NewService();
            var processed = new List<Guid>();
            var a = Guid.NewGuid();
            var b = Guid.NewGuid();
            var c = Guid.NewGuid();

            var changed = svc.ApplyBatch(
                new List<(Guid, bool)> { (a, false), (b, false), (c, false) },
                id =>
                {
                    processed.Add(id);
                    if (id == b) throw new InvalidOperationException("boom");
                    return true;
                },
                _ => false);

            Assert.Equal(new[] { a, b, c }, processed); // b threw but the batch continued to c
            Assert.True(changed);                        // a and c still counted
        }

        [Fact]
        public void ApplyBatch_EmptyBatchReturnsFalse()
        {
            using var svc = NewService();
            Assert.False(svc.ApplyBatch(new List<(Guid, bool)>(), _ => true, _ => true));
        }

        // ---- Incremental flush invalidates the 60s per-user access cache (CSSVC-5) ---------

        [Fact]
        public void IncrementalFlush_ChangingCache_ClearsUserAccessCache()
        {
            using var svc = NewService();
            svc.SeedUserAccessCacheForTest("user-1");
            Assert.Equal(1, svc.UserAccessCacheCount); // precondition

            // A batch that actually changes the cache (rebuild returns true) must clear the
            // per-user access cache, exactly as BuildFullCache does — otherwise a freshly added
            // item's tags stay invisible to every user for up to 60s.
            var changed = svc.ApplyBatch(
                new List<(Guid, bool)> { (Guid.NewGuid(), false) },
                _ => true,
                _ => false);

            Assert.True(changed);
            Assert.Equal(0, svc.UserAccessCacheCount);
        }

        // ---- Full rebuild must not discard a flush that fires mid-rebuild -------------------

        [Fact]
        public void BuildFullCache_AppliesFlushQueuedDuringRebuild_NotDiscardedBySwap()
        {
            var tempDir = Path.Combine(Path.GetTempPath(), "je-tagcache-rebuild-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempDir);
            try
            {
                var movieId = Guid.NewGuid();
                var key = movieId.ToString("N").ToLowerInvariant();

                var lib = new CountingLibraryManager
                {
                    GetItemListHook = _ => System.Array.Empty<BaseItem>(),                 // full scan finds nothing
                    GetItemByIdHook = id => id == movieId ? new Movie { Id = movieId } : null,
                };
                using var svc = new TagCacheService(lib, new StubAppPaths(tempDir), NullLogger<TagCacheService>.Instance);

                // Simulate an incremental flush firing mid-rebuild (while the rebuild owns the cache).
                // With the fix the flush DEFERS — the change stays pending and is applied to the NEW
                // cache after the swap. Without it, the flush applies to the OLD cache and the swap
                // discards the entry (final Count == 0). Clear the hook so the deferred re-run is a no-op.
                svc.OnBeforeSwapForTest = () =>
                {
                    svc.OnBeforeSwapForTest = null;
                    svc.EnqueueUpdate(movieId);
                    svc.FlushPendingForTest();
                };

                svc.BuildFullCache(progress: null, System.Threading.CancellationToken.None);

                Assert.Equal(1, svc.Count);
                Assert.True(svc.ContainsKeyForTest(key));
            }
            finally
            {
                try { Directory.Delete(tempDir, recursive: true); } catch { /* best-effort */ }
            }
        }

        // ---- Rebuild must not swap lossily while an in-flight flush holds the guard -----------

        [Fact]
        public void BuildFullCache_WhileInFlightFlushHoldsGuard_DoesNotSwapLossily()
        {
            var tempDir = Path.Combine(Path.GetTempPath(), "je-tagcache-guardrace-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempDir);
            try
            {
                var movieId = Guid.NewGuid();
                var key = movieId.ToString("N").ToLowerInvariant();

                var lib = new CountingLibraryManager
                {
                    GetItemListHook = _ => System.Array.Empty<BaseItem>(),                 // rebuild's full scan finds nothing
                    GetItemByIdHook = id => id == movieId ? new Movie { Id = movieId } : null,
                };
                using var svc = new TagCacheService(lib, new StubAppPaths(tempDir), NullLogger<TagCacheService>.Instance);

                // Shrink the rebuild's guard wait so it resolves in ~30ms instead of ~30s while the
                // flush keeps holding the guard.
                svc.SetRebuildFlushGuardSpinsForTest(3);

                using var flushHoldingGuard = new System.Threading.ManualResetEventSlim(false);
                using var rebuildDone = new System.Threading.ManualResetEventSlim(false);

                // Park the flush in the "drained _pending + applied movieId, still holding the guard"
                // state — exactly the in-flight flush that used to lose its delta to the swap.
                svc.OnAfterFlushApplyForTest = () =>
                {
                    svc.OnAfterFlushApplyForTest = null;
                    flushHoldingGuard.Set();
                    rebuildDone.Wait(TimeSpan.FromSeconds(10));
                };

                svc.EnqueueUpdate(movieId);
                var flushThread = new System.Threading.Thread(() => svc.FlushPendingForTest());
                flushThread.Start();

                // Flush has drained _pending and written movieId into the (current) cache.
                Assert.True(flushHoldingGuard.Wait(TimeSpan.FromSeconds(10)));
                Assert.True(svc.ContainsKeyForTest(key));

                // Rebuild runs while the flush still holds the guard: it must NOT swap in the empty
                // newCache (which would drop the flush's delta, gone from _pending). With the fix it
                // waits, times out, and aborts — leaving the applied entry intact. RED against the
                // old timeout-and-proceed-lossy path (final Count == 0, key gone).
                svc.BuildFullCache(progress: null, System.Threading.CancellationToken.None);

                Assert.True(svc.ContainsKeyForTest(key));

                rebuildDone.Set();
                flushThread.Join(TimeSpan.FromSeconds(10));

                Assert.True(svc.ContainsKeyForTest(key));
                Assert.Equal(1, svc.Count);
            }
            finally
            {
                try { Directory.Delete(tempDir, recursive: true); } catch { /* best-effort */ }
            }
        }

        // ---- Save must not clear a dirty bit set by a flush after the snapshot ---------------

        [Fact]
        public void SaveToDisk_PreservesDirtyBitSetByFlushAfterSnapshot()
        {
            using var svc = NewService();

            // Simulate a concurrent flush landing in the snapshot→clear window: it marks the cache
            // dirty (and bumps the dirty version) AFTER SaveToDisk has already snapshotted _cache.
            svc.OnAfterSnapshotForTest = () => svc.MarkDirtyForTest();

            svc.SaveToDisk();

            // The dirty bit set by that flush must survive — otherwise its change is silently dropped
            // (the debounced timer would see _dirty == false and skip the next save). RED against the
            // old unconditional `_dirty = false;` at the end of SaveToDisk.
            Assert.True(svc.IsDirtyForTest);

            svc.OnAfterSnapshotForTest = null; // don't re-fire during dispose's flush
        }

        [Fact]
        public void SaveToDisk_ClearsDirtyBitWhenNoConcurrentFlush()
        {
            using var svc = NewService();
            svc.MarkDirtyForTest();
            Assert.True(svc.IsDirtyForTest);

            svc.SaveToDisk();

            // Normal path: nothing dirtied the cache after the snapshot, so the save clears dirty.
            Assert.False(svc.IsDirtyForTest);
        }

        [Fact]
        public void IncrementalFlush_NoChange_DoesNotClearUserAccessCache()
        {
            using var svc = NewService();
            svc.SeedUserAccessCacheForTest("user-1");

            // A no-op batch (nothing modified the cache) must NOT force every user to recompute
            // their accessible-id set.
            var changed = svc.ApplyBatch(
                new List<(Guid, bool)> { (Guid.NewGuid(), false) },
                _ => false,
                _ => false);

            Assert.False(changed);
            Assert.Equal(1, svc.UserAccessCacheCount);
        }
    }
}
