using System;
using System.Linq;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services
{
    /// <summary>
    /// Pins the coalescing core that keeps tag-cache maintenance off Jellyfin's
    /// library-scan thread. The scan raises one event per item (and, for episodes,
    /// the monitor also names the parent Series and Season), so the same id can be
    /// recorded hundreds of times per scan — this must collapse to one rebuild.
    /// </summary>
    public class TagCachePendingChangesTests
    {
        [Fact]
        public void Record_CoalescesRepeatedIdsIntoOneUnitOfWork()
        {
            var pending = new TagCachePendingChanges();
            var seriesId = Guid.NewGuid();

            // A 300-episode series scan touching the same parent series every time.
            for (var i = 0; i < 300; i++) pending.Record(seriesId, removed: false);

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
    }
}
