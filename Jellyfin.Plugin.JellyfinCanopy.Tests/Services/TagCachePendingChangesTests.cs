using System;
using System.Linq;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services
{
    /// <summary>
    /// Pins the coalescing core that keeps tag-cache maintenance off Jellyfin's
    /// library-scan thread. A scan can raise the same item repeatedly; the cheap event
    /// tokens must collapse before worker-side relationship expansion and rebuilding.
    /// </summary>
    public class TagCachePendingChangesTests
    {
        [Fact]
        public void LaterRealUpdate_ResetsRetryBudget()
        {
            var id = Guid.NewGuid();
            var pending = new TagCachePendingChanges();
            pending.Record(Change(id, BaseItemKind.Series, retryAttempts: 2));
            pending.Record(Change(id, BaseItemKind.Series));

            var change = Assert.Single(pending.Drain());
            Assert.False(change.Removed);
            Assert.Equal(0, change.RetryAttempts);
        }

        [Fact]
        public void RealRemoval_WinsOverLaterRetry()
        {
            var id = Guid.NewGuid();
            var pending = new TagCachePendingChanges();
            pending.Record(Change(id, BaseItemKind.Series, removed: true));
            pending.Record(Change(id, BaseItemKind.Series, retryAttempts: 1));

            var change = Assert.Single(pending.Drain());
            Assert.True(change.Removed);
            Assert.Equal(0, change.RetryAttempts);
        }

        [Fact]
        public void RealUpdate_WinsOverLaterStaleRetryWithoutRestoringItsBudget()
        {
            var id = Guid.NewGuid();
            var pending = new TagCachePendingChanges();
            pending.Record(Change(id, BaseItemKind.Series));

            var retryRetained = pending.Record(Change(id, BaseItemKind.Series, retryAttempts: 8));

            Assert.False(retryRetained);
            var change = Assert.Single(pending.Drain());
            Assert.False(change.Removed);
            Assert.Equal(0, change.RetryAttempts);
        }

        [Fact]
        public void RepeatedScanThreadRecords_DoNotAllocatePerEventClosures()
        {
            var pending = new TagCachePendingChanges();
            var change = Change(Guid.NewGuid(), BaseItemKind.Episode);
            pending.Record(change); // warm dictionary/JIT paths
            var before = GC.GetAllocatedBytesForCurrentThread();

            for (var index = 0; index < 10_000; index++)
            {
                pending.Record(change);
            }

            var allocated = GC.GetAllocatedBytesForCurrentThread() - before;
            Assert.True(allocated < 4_096, $"Repeated records allocated {allocated:N0} bytes");
        }

        [Fact]
        public void EpisodeReparenting_PreservesOldParentsAndLatestNewParents()
        {
            var id = Guid.NewGuid();
            var oldSeries = Guid.NewGuid();
            var oldSeason = Guid.NewGuid();
            var intermediateSeries = Guid.NewGuid();
            var intermediateSeason = Guid.NewGuid();
            var latestSeries = Guid.NewGuid();
            var latestSeason = Guid.NewGuid();
            var pending = new TagCachePendingChanges();
            pending.Record(new TagCacheChange(
                id,
                BaseItemKind.Episode,
                intermediateSeries,
                intermediateSeason,
                oldSeries,
                oldSeason,
                Removed: false));
            pending.Record(new TagCacheChange(
                id,
                BaseItemKind.Episode,
                latestSeries,
                latestSeason,
                oldSeries,
                oldSeason,
                Removed: false));

            var change = Assert.Single(pending.Drain());
            Assert.Equal(oldSeries, change.PreviousSeriesId);
            Assert.Equal(oldSeason, change.PreviousSeasonId);
            Assert.Equal(latestSeries, change.SeriesId);
            Assert.Equal(latestSeason, change.SeasonId);
        }

        [Fact]
        public void Record_CoalescesRepeatedIdsIntoOneUnitOfWork()
        {
            var pending = new TagCachePendingChanges();
            var seriesId = Guid.NewGuid();

            // A large series scan touching the same parent series on every Episode event.
            for (var i = 0; i < 10_000; i++) pending.Record(seriesId, removed: false);

            var batch = pending.Drain();

            Assert.Single(batch);
            Assert.Equal(seriesId, batch[0].Id);
            Assert.False(batch[0].Removed);
        }

        [Fact]
        public void Record_LastWriteWinsForIntent()
        {
            var pending = new TagCachePendingChanges();
            var id = Guid.NewGuid();

            pending.Record(id, removed: false); // added during the scan
            pending.Record(id, removed: true);  // then deleted

            var batch = pending.Drain();

            Assert.Single(batch);
            Assert.True(batch[0].Removed); // removal is the final intent

            // ...and the reverse ordering resolves to an update.
            pending.Record(id, removed: true);
            pending.Record(id, removed: false);
            Assert.False(pending.Drain().Single().Removed);
        }

        [Fact]
        public void Record_IgnoresEmptyGuid()
        {
            var pending = new TagCachePendingChanges();

            // e.g. an episode whose SeasonId is Guid.Empty.
            pending.Record(Guid.Empty, removed: false);

            Assert.True(pending.IsEmpty);
            Assert.Empty(pending.Drain());
        }

        [Fact]
        public void Drain_EmptiesTheSet()
        {
            var pending = new TagCachePendingChanges();
            pending.Record(Guid.NewGuid(), removed: false);
            pending.Record(Guid.NewGuid(), removed: false);

            var first = pending.Drain();
            var second = pending.Drain();

            Assert.Equal(2, first.Count);
            Assert.Empty(second);
            Assert.True(pending.IsEmpty);
        }

        [Fact]
        public void Drain_ReturnsEachDistinctIdExactlyOnce()
        {
            var pending = new TagCachePendingChanges();
            var a = Guid.NewGuid();
            var b = Guid.NewGuid();

            pending.Record(a, removed: false);
            pending.Record(b, removed: false);
            pending.Record(a, removed: false); // dup
            pending.Record(b, removed: true);  // dup, flips intent

            var byId = pending.Drain().ToDictionary(x => x.Id, x => x.Removed);

            Assert.Equal(2, byId.Count);
            Assert.False(byId[a]);
            Assert.True(byId[b]);
        }

        private static TagCacheChange Change(
            Guid id,
            BaseItemKind? kind,
            bool removed = false,
            byte retryAttempts = 0)
            => new(
                id,
                kind,
                Guid.Empty,
                Guid.Empty,
                Guid.Empty,
                Guid.Empty,
                removed,
                retryAttempts);
    }
}
