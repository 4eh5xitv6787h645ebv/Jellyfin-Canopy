using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinElevate.Model;
using Jellyfin.Plugin.JellyfinElevate.Services;
using Jellyfin.Plugin.JellyfinElevate.Tests.TestDoubles;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Model.Dto;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using Episode = MediaBrowser.Controller.Entities.TV.Episode;
using Series = MediaBrowser.Controller.Entities.TV.Series;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.Services
{
    /// <summary>
    /// Pins the incremental reconcile that replaced the old wholesale rebuild in
    /// <see cref="TagCacheService.BuildFullCache"/>: unchanged items are reused (their media never
    /// re-probed), only real changes rebuild, removals are the sole trigger for a client
    /// full-reload (a <see cref="TagCacheService.Version"/> bump), and adds/edits flow through the
    /// timestamp so the incremental ?since= delta carries them without a version bump. The pure
    /// decision helpers (<c>ShouldRebuild</c>, <c>ContentEquals</c>) are tested directly; the wiring
    /// is driven through a fake <see cref="ILibraryManager"/>.
    /// </summary>
    public sealed class TagCacheReconcileTests
    {
        private static readonly DateTime T0 = new(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        private static readonly CancellationToken CT = CancellationToken.None;

        private static string Key(Guid id) => id.ToString("N").ToLowerInvariant();

        private static string NewTempDir()
        {
            var d = Path.Combine(Path.GetTempPath(), "je-tagcache-reconcile-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(d);
            return d;
        }

        private static TagCacheService NewSvc(CountingLibraryManager lib, string dir) =>
            new(lib, new StubAppPaths(dir), NullLogger<TagCacheService>.Instance);

        // ── ShouldRebuild: the pure gate ──────────────────────────────────────────────────

        [Fact]
        public void ShouldRebuild_NewItem_Always()
            => Assert.True(TagCacheService.ShouldRebuild(BaseItemKind.Movie, old: null, revision: 123, parentSeriesRatingChanged: false));

        [Fact]
        public void ShouldRebuild_UnchangedLeaf_Reuses()
        {
            var old = new TagCacheEntry { SourceRevision = 123 };
            Assert.False(TagCacheService.ShouldRebuild(BaseItemKind.Movie, old, revision: 123, parentSeriesRatingChanged: false));
        }

        [Fact]
        public void ShouldRebuild_ChangedRevision_Rebuilds()
        {
            var old = new TagCacheEntry { SourceRevision = 123 };
            Assert.True(TagCacheService.ShouldRebuild(BaseItemKind.Movie, old, revision: 999, parentSeriesRatingChanged: false));
        }

        [Theory]
        [InlineData(BaseItemKind.Series)]
        [InlineData(BaseItemKind.Season)]
        public void ShouldRebuild_Containers_AlwaysRebuild_EvenWhenRevisionUnchanged(BaseItemKind kind)
        {
            // Containers derive from their child episodes, which their own DateLastSaved doesn't track.
            var old = new TagCacheEntry { SourceRevision = 123 };
            Assert.True(TagCacheService.ShouldRebuild(kind, old, revision: 123, parentSeriesRatingChanged: false));
        }

        [Fact]
        public void ShouldRebuild_EpisodeUnchangedButParentSeriesRatingChanged_Rebuilds()
        {
            var old = new TagCacheEntry { SourceRevision = 123 };
            Assert.True(TagCacheService.ShouldRebuild(BaseItemKind.Episode, old, revision: 123, parentSeriesRatingChanged: true));
        }

        [Fact]
        public void ShouldRebuild_EpisodeUnchangedAndParentSeriesUnchanged_Reuses()
        {
            var old = new TagCacheEntry { SourceRevision = 123 };
            Assert.False(TagCacheService.ShouldRebuild(BaseItemKind.Episode, old, revision: 123, parentSeriesRatingChanged: false));
        }

        // ── ContentEquals: ignores volatile fields, order-insensitive on hash-ordered arrays ──

        [Fact]
        public void ContentEquals_SameContentDifferentVolatileFields_True()
        {
            var a = new TagCacheEntry { Type = "Movie", Genres = new[] { "Drama" }, CommunityRating = 7.5f, LastUpdated = 1, SourceRevision = 10 };
            var b = new TagCacheEntry { Type = "Movie", Genres = new[] { "Drama" }, CommunityRating = 7.5f, LastUpdated = 999, SourceRevision = 20 };
            Assert.True(TagCacheService.ContentEquals(a, b));
        }

        [Fact]
        public void ContentEquals_DifferentGenre_False()
        {
            var a = new TagCacheEntry { Type = "Movie", Genres = new[] { "Drama" } };
            var b = new TagCacheEntry { Type = "Movie", Genres = new[] { "Comedy" } };
            Assert.False(TagCacheService.ContentEquals(a, b));
        }

        [Fact]
        public void ContentEquals_DifferentRating_False()
        {
            var a = new TagCacheEntry { Type = "Movie", CommunityRating = 7.5f };
            var b = new TagCacheEntry { Type = "Movie", CommunityRating = 8.0f };
            Assert.False(TagCacheService.ContentEquals(a, b));
        }

        [Fact]
        public void ContentEquals_AudioLanguagesInDifferentOrder_True()
        {
            // AudioLanguages comes from a HashSet<string>; .NET randomises string hashing per process,
            // so the array order can differ across restarts for the same languages. The signature
            // must sort it, or every multi-language item would churn on each reconcile.
            var a = new TagCacheEntry { Type = "Movie", AudioLanguages = new[] { "eng", "jpn" } };
            var b = new TagCacheEntry { Type = "Movie", AudioLanguages = new[] { "jpn", "eng" } };
            Assert.True(TagCacheService.ContentEquals(a, b));
        }

        // ── Reconcile wiring, driven through a fake library ───────────────────────────────

        [Fact]
        public void Reconcile_UnchangedItem_ReusesEntry_NoProbe_NoVersionBump()
        {
            var dir = NewTempDir();
            try
            {
                var id = Guid.NewGuid();
                var movie = new StubMovie { Id = id, Name = "M", DateLastSaved = T0, CommunityRating = 6.0f };
                var lib = new CountingLibraryManager { GetItemListHook = _ => new List<BaseItem> { movie } };
                using var svc = NewSvc(lib, dir);

                svc.BuildFullCache(null, CT);
                var first = svc.GetEntryForTest(Key(id));
                var versionAfterFirst = svc.Version;
                var lastModAfterFirst = svc.LastModified;
                Assert.NotNull(first);

                // Nothing about the item changed (same DateLastSaved) -> reuse the SAME instance.
                svc.BuildFullCache(null, CT);
                var second = svc.GetEntryForTest(Key(id));

                Assert.Same(first, second);                       // reused, not re-probed
                Assert.Equal(versionAfterFirst, svc.Version);     // no removal -> no version bump
                Assert.Equal(lastModAfterFirst, svc.LastModified); // no change -> timestamp not advanced
            }
            finally { TryDelete(dir); }
        }

        [Fact]
        public void Reconcile_ContentChanged_Rebuilds_AdvancesTimestamp_NoVersionBump()
        {
            var dir = NewTempDir();
            try
            {
                var id = Guid.NewGuid();
                var movie = new StubMovie { Id = id, Name = "M", DateLastSaved = T0, CommunityRating = 6.0f };
                var lib = new CountingLibraryManager { GetItemListHook = _ => new List<BaseItem> { movie } };
                using var svc = NewSvc(lib, dir);

                svc.BuildFullCache(null, CT);
                var lastModAfterFirst = svc.LastModified;
                var versionAfterFirst = svc.Version;

                // A real edit: bump the source revision AND change content.
                movie.DateLastSaved = T0.AddHours(1);
                movie.CommunityRating = 9.0f;
                svc.BuildFullCache(null, CT);

                var entry = svc.GetEntryForTest(Key(id));
                Assert.NotNull(entry);
                Assert.Equal(9.0f, entry!.CommunityRating);        // rebuilt with new content
                Assert.True(svc.LastModified >= lastModAfterFirst); // delta advanced
                Assert.Equal(versionAfterFirst, svc.Version);       // still no removal
            }
            finally { TryDelete(dir); }
        }

        [Fact]
        public void Reconcile_RevisionChangedButContentIdentical_RetainsTimestamp()
        {
            var dir = NewTempDir();
            try
            {
                var id = Guid.NewGuid();
                var movie = new StubMovie { Id = id, Name = "M", DateLastSaved = T0, CommunityRating = 6.0f };
                var lib = new CountingLibraryManager { GetItemListHook = _ => new List<BaseItem> { movie } };
                using var svc = NewSvc(lib, dir);

                svc.BuildFullCache(null, CT);
                var originalLastUpdated = svc.GetEntryForTest(Key(id))!.LastUpdated;
                var lastModAfterFirst = svc.LastModified;

                // A no-op re-save: DateLastSaved moves (forces a rebuild) but content is identical.
                movie.DateLastSaved = T0.AddHours(1);
                svc.BuildFullCache(null, CT);

                var entry = svc.GetEntryForTest(Key(id));
                Assert.NotNull(entry);
                Assert.Equal(originalLastUpdated, entry!.LastUpdated);          // timestamp retained -> no delta churn
                Assert.Equal(T0.AddHours(1).Ticks, entry.SourceRevision);       // but gate refreshed
                Assert.Equal(lastModAfterFirst, svc.LastModified);              // no client-visible change
            }
            finally { TryDelete(dir); }
        }

        [Fact]
        public void Reconcile_AddedItem_Included_NoVersionBump()
        {
            var dir = NewTempDir();
            try
            {
                var a = new StubMovie { Id = Guid.NewGuid(), Name = "A", DateLastSaved = T0 };
                var b = new StubMovie { Id = Guid.NewGuid(), Name = "B", DateLastSaved = T0 };
                var scan = new List<BaseItem> { a };
                var lib = new CountingLibraryManager { GetItemListHook = _ => scan };
                using var svc = NewSvc(lib, dir);

                svc.BuildFullCache(null, CT);
                var versionAfterFirst = svc.Version;

                scan.Add(b);                                   // B appears in the library
                svc.BuildFullCache(null, CT);

                Assert.True(svc.ContainsKeyForTest(Key(b.Id)));
                Assert.Equal(versionAfterFirst, svc.Version);  // add flows via the delta, not a full reload
            }
            finally { TryDelete(dir); }
        }

        [Fact]
        public void Reconcile_RemovedItem_Dropped_BumpsVersion()
        {
            var dir = NewTempDir();
            try
            {
                var a = new StubMovie { Id = Guid.NewGuid(), Name = "A", DateLastSaved = T0 };
                var b = new StubMovie { Id = Guid.NewGuid(), Name = "B", DateLastSaved = T0 };
                var scan = new List<BaseItem> { a, b };
                var lib = new CountingLibraryManager { GetItemListHook = _ => scan };
                using var svc = NewSvc(lib, dir);

                svc.BuildFullCache(null, CT);
                var versionAfterFirst = svc.Version;

                scan.Remove(b);                                // B removed from the library
                svc.BuildFullCache(null, CT);

                Assert.False(svc.ContainsKeyForTest(Key(b.Id)));
                Assert.Equal(versionAfterFirst + 1, svc.Version); // removal forces a client full reload
            }
            finally { TryDelete(dir); }
        }

        [Fact]
        public void Reconcile_SeriesRatingChange_RederivesEpisodeInheritedRating()
        {
            var dir = NewTempDir();
            try
            {
                var seriesId = Guid.NewGuid();
                var epId = Guid.NewGuid();
                var series = new StubSeries { Id = seriesId, Name = "S", DateLastSaved = T0, CommunityRating = 5.0f };
                // Episode has NO rating of its own -> inherits the series rating.
                var ep = new StubEpisode { Id = epId, Name = "E", DateLastSaved = T0, SeriesId = seriesId };
                var scan = new List<BaseItem> { series, ep };

                var lib = new CountingLibraryManager
                {
                    // Full scan vs the container's first-episode lookup (ParentId set).
                    GetItemListHook = q => q.ParentId == Guid.Empty ? scan : new List<BaseItem> { ep },
                    GetItemByIdHook = id => id == seriesId ? series : id == epId ? ep : null,
                };
                using var svc = NewSvc(lib, dir);

                svc.BuildFullCache(null, CT);
                Assert.Equal(5.0f, svc.GetEntryForTest(Key(epId))!.CommunityRating); // inherited

                // The series' own rating changes; the episode's DateLastSaved does NOT move.
                series.CommunityRating = 8.0f;
                series.DateLastSaved = T0.AddHours(1);
                svc.BuildFullCache(null, CT);

                // Episode's inherited rating must follow even though its own revision is unchanged.
                Assert.Equal(8.0f, svc.GetEntryForTest(Key(epId))!.CommunityRating);
                Assert.Equal(0L, svc.Version); // no removal
            }
            finally { TryDelete(dir); }
        }

        // ── Probe failure must keep last-good data, not publish a degraded (empty) entry ──────

        [Fact]
        public void Reconcile_ProbeFailureOnChangedItem_KeepsLastGood_AndRecoversNextReconcile()
        {
            var dir = NewTempDir();
            try
            {
                var id = Guid.NewGuid();
                var movie = new ProbeControlledMovie { Id = id, Name = "M", DateLastSaved = T0, CommunityRating = 6.0f };
                var lib = new CountingLibraryManager
                {
                    GetItemListHook = _ => new List<BaseItem> { movie },
                    GetItemByIdHook = i => i == id ? movie : null,
                };
                using var svc = NewSvc(lib, dir);

                svc.BuildFullCache(null, CT);                       // builds cleanly
                var good = svc.GetEntryForTest(Key(id));
                Assert.NotNull(good);
                Assert.Equal(6.0f, good!.CommunityRating);

                // The item changes AND its media probe now throws.
                movie.DateLastSaved = T0.AddHours(1);
                movie.CommunityRating = 9.0f;
                movie.ThrowOnProbe = true;
                svc.BuildFullCache(null, CT);

                // Last-good retained (same instance, old content) with its OLD SourceRevision, so it
                // stays a rebuild candidate — NOT a degraded entry stamped with the new revision.
                var afterFail = svc.GetEntryForTest(Key(id));
                Assert.Same(good, afterFail);
                Assert.Equal(6.0f, afterFail!.CommunityRating);
                Assert.Equal(T0.Ticks, afterFail.SourceRevision);

                // Probe recovers -> the next reconcile rebuilds (revision still mismatched).
                movie.ThrowOnProbe = false;
                svc.BuildFullCache(null, CT);
                var recovered = svc.GetEntryForTest(Key(id));
                Assert.NotNull(recovered);
                Assert.Equal(9.0f, recovered!.CommunityRating);
                Assert.Equal(T0.AddHours(1).Ticks, recovered.SourceRevision);
            }
            finally { TryDelete(dir); }
        }

        [Fact]
        public void Reconcile_ProbeFailure_RequeuesForOffThreadFlushRetry()
        {
            var dir = NewTempDir();
            try
            {
                var id = Guid.NewGuid();
                var movie = new ProbeControlledMovie { Id = id, Name = "M", DateLastSaved = T0, CommunityRating = 6.0f };
                var lib = new CountingLibraryManager
                {
                    GetItemListHook = _ => new List<BaseItem> { movie },
                    GetItemByIdHook = i => i == id ? movie : null,
                };
                using var svc = NewSvc(lib, dir);

                svc.BuildFullCache(null, CT);
                var good = svc.GetEntryForTest(Key(id));

                movie.DateLastSaved = T0.AddHours(1);
                movie.CommunityRating = 9.0f;
                movie.ThrowOnProbe = true;
                svc.BuildFullCache(null, CT);            // fails -> keeps old + re-queues id
                Assert.Same(good, svc.GetEntryForTest(Key(id)));

                // The re-queued item recovers through the existing flush path once the probe heals,
                // without waiting for the next daily reconcile.
                movie.ThrowOnProbe = false;
                svc.FlushPendingForTest();
                var recovered = svc.GetEntryForTest(Key(id));
                Assert.NotNull(recovered);
                Assert.Equal(9.0f, recovered!.CommunityRating);
            }
            finally { TryDelete(dir); }
        }

        private static void TryDelete(string dir)
        {
            try { Directory.Delete(dir, recursive: true); } catch { /* best-effort */ }
        }

        /// <summary>A Movie whose media probe can be made to throw, to exercise the last-good path.</summary>
        private sealed class ProbeControlledMovie : Movie
        {
            public bool ThrowOnProbe { get; set; }

            public override string GetClientTypeName() => "Movie";

            public override IReadOnlyList<MediaSourceInfo> GetMediaSources(bool enablePathSubstitution)
            {
                if (ThrowOnProbe) throw new InvalidOperationException("transient probe failure");
                return Array.Empty<MediaSourceInfo>();
            }
        }
    }
}
