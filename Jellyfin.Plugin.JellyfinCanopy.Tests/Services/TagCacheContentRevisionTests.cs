using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Model;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Entities;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services
{
    public sealed class TagCacheContentRevisionTests
    {
        [Fact]
        public void RemovalOnlyDelta_DeletesAuthorizedIdAndAdvancesCursor()
        {
            var id = Guid.NewGuid();
            using var harness = new Harness(new[] { id });
            harness.Service.SeedEntryForTest(Key(id), Entry("before"));

            var full = harness.Service.GetFullContentForUser(harness.User);
            Assert.Single(full.Items);
            Assert.Equal(0, full.Revision);

            harness.Service.PublishRemovalForTest(Key(id));
            var delta = harness.Service.GetContentDeltaForUser(harness.User, full.Epoch, full.Revision);

            Assert.False(delta.ResetRequired);
            Assert.Equal(1, delta.Revision);
            Assert.Empty(delta.Items);
            Assert.Equal(new[] { Key(id) }, delta.RemovedIds);
            Assert.Equal(1, delta.JournalRowsVisited);

            var empty = harness.Service.GetContentDeltaForUser(harness.User, delta.Epoch, delta.Revision);
            Assert.Equal(delta.Revision, empty.Revision);
            Assert.Empty(empty.Items);
            Assert.Empty(empty.RemovedIds);
            Assert.Equal(0, empty.JournalRowsVisited);
        }

        [Fact]
        public void RevisionsAreStrictlyMonotonicWithoutWallClockOrdering()
        {
            var a = Guid.NewGuid();
            var b = Guid.NewGuid();
            using var harness = new Harness(new[] { a, b });
            harness.Service.GetFullContentForUser(harness.User);

            harness.Service.SetLegacyTimestampForTest(1_000);
            harness.Service.PublishUpsertForTest(Key(a), Entry("same-millisecond-a"));
            var afterA = harness.Service.ContentRevision;
            harness.Service.SetLegacyTimestampForTest(1_000);
            harness.Service.PublishUpsertForTest(Key(b), Entry("same-millisecond-b"));
            var afterB = harness.Service.ContentRevision;
            harness.Service.SetLegacyTimestampForTest(999);
            harness.Service.PublishUpsertForTest(Key(a), Entry("clock-rollback-a"));
            var afterRollback = harness.Service.ContentRevision;

            Assert.Equal(1, afterA);
            Assert.Equal(2, afterB);
            Assert.Equal(3, afterRollback);
            var delta = harness.Service.GetContentDeltaForUser(harness.User, harness.Service.ContentEpoch, 0);
            Assert.Equal(3, delta.Revision);
            Assert.Equal(3, delta.JournalRowsVisited);
            Assert.Equal("clock-rollback-a", delta.Items[Key(a)].Type);
            Assert.Equal("same-millisecond-b", delta.Items[Key(b)].Type);
        }

        [Fact]
        public void RetentionGapWrongEpochAndFutureCursorRequireDeterministicReset()
        {
            var ids = Enumerable.Range(0, 3).Select(_ => Guid.NewGuid()).ToArray();
            using var harness = new Harness(ids, journalCapacity: 2);
            var full = harness.Service.GetFullContentForUser(harness.User);
            foreach (var id in ids)
            {
                harness.Service.PublishUpsertForTest(Key(id), Entry("Movie"));
            }

            var covered = harness.Service.GetContentDeltaForUser(harness.User, full.Epoch, 1);
            Assert.False(covered.ResetRequired);
            Assert.Equal(3, covered.Revision);
            Assert.Equal(2, covered.JournalRowsVisited);

            AssertReset(harness.Service.GetContentDeltaForUser(harness.User, full.Epoch, 0), 3);
            AssertReset(harness.Service.GetContentDeltaForUser(harness.User, "unknown-epoch", 3), 3);
            AssertReset(harness.Service.GetContentDeltaForUser(harness.User, full.Epoch, 4), 3);
            AssertReset(harness.Service.GetContentDeltaForUser(harness.User, full.Epoch, -1), 3);
            AssertReset(harness.Service.GetContentDeltaForUser(harness.User, full.Epoch, null), 3);
            AssertReset(harness.Service.GetContentDeltaForUser(harness.User, null, 3), 3);
        }

        [Fact]
        public void RepeatedItemMutationsPublishOnlyTheLastStateAtTheLatestRevision()
        {
            var id = Guid.NewGuid();
            using var harness = new Harness(new[] { id });
            var full = harness.Service.GetFullContentForUser(harness.User);

            harness.Service.PublishUpsertForTest(Key(id), Entry("first"));
            harness.Service.PublishRemovalForTest(Key(id));
            harness.Service.PublishUpsertForTest(Key(id), Entry("last"));

            var delta = harness.Service.GetContentDeltaForUser(harness.User, full.Epoch, full.Revision);
            Assert.Equal(3, delta.Revision);
            Assert.Equal(3, delta.JournalRowsVisited);
            Assert.Empty(delta.RemovedIds);
            Assert.Equal("last", Assert.Single(delta.Items).Value.Type);
        }

        [Fact]
        public void TombstonesAreReturnedOnlyToUsersWhoseFullSnapshotContainedTheId()
        {
            var id = Guid.NewGuid();
            using var harness = new Harness(Array.Empty<Guid>());
            var authorized = harness.User;
            var hidden = new User("hidden", "Provider", "PasswordProvider");
            harness.Library.GetItemIdsHook = query => ReferenceEquals(query.User, authorized)
                ? new[] { id }
                : Array.Empty<Guid>();
            harness.Service.SeedEntryForTest(Key(id), Entry("Movie"));

            var authorizedFull = harness.Service.GetFullContentForUser(authorized);
            var hiddenFull = harness.Service.GetFullContentForUser(hidden);
            Assert.Contains(Key(id), authorizedFull.Items.Keys);
            Assert.Empty(hiddenFull.Items);
            harness.Service.PublishRemovalForTest(Key(id));

            var allowed = harness.Service.GetContentDeltaForUser(
                authorized,
                authorizedFull.Epoch,
                authorizedFull.Revision);
            var denied = harness.Service.GetContentDeltaForUser(
                hidden,
                hiddenFull.Epoch,
                hiddenFull.Revision);

            Assert.Equal(new[] { Key(id) }, allowed.RemovedIds);
            Assert.Empty(denied.RemovedIds);
            Assert.Empty(denied.Items);
        }

        [Fact]
        public void FifteenThousandEntryCache_OneOrNoMutationVisitsOnlyJournalSuffix()
        {
            const int scale = 15_000;
            var ids = Enumerable.Range(0, scale).Select(_ => Guid.NewGuid()).ToArray();
            using var harness = new Harness(ids);
            harness.Service.SwapCacheAndCursorForTest(
                ids.ToDictionary(Key, _ => Entry("Movie"), StringComparer.Ordinal),
                version: 0,
                lastModified: 0);
            var full = harness.Service.GetFullContentForUser(harness.User);
            Assert.Equal(scale, full.Items.Count);
            var proofRowsAfterFull = harness.Service.ServedContentIdsVisited;

            var target = ids[scale / 2];
            harness.Service.PublishUpsertForTest(Key(target), Entry("changed"));
            var delta = harness.Service.GetContentDeltaForUser(harness.User, full.Epoch, full.Revision);

            Assert.Equal(1, delta.JournalRowsVisited);
            Assert.Equal(1, harness.Service.ServedContentIdsVisited - proofRowsAfterFull);
            Assert.Single(delta.Items);
            Assert.Empty(delta.RemovedIds);
            Assert.True(JsonSerializer.SerializeToUtf8Bytes(delta.Items).Length < 512);

            var noChange = harness.Service.GetContentDeltaForUser(
                harness.User,
                delta.Epoch,
                delta.Revision);
            Assert.Equal(0, noChange.JournalRowsVisited);
            Assert.Equal(1, harness.Service.ServedContentIdsVisited - proofRowsAfterFull);
            Assert.Empty(noChange.Items);
            Assert.Empty(noChange.RemovedIds);
        }

        private static string Key(Guid id) => id.ToString("N");

        private static TagCacheEntry Entry(string type) => new() { Type = type };

        private static void AssertReset(TagCacheService.ContentDelta delta, long expectedRevision)
        {
            Assert.True(delta.ResetRequired);
            Assert.Equal(expectedRevision, delta.Revision);
            Assert.Empty(delta.Items);
            Assert.Empty(delta.RemovedIds);
            Assert.Equal(0, delta.JournalRowsVisited);
        }

        private sealed class Harness : IDisposable
        {
            private readonly string _tempDir;

            public Harness(IReadOnlyCollection<Guid> accessibleIds, int journalCapacity = TagCacheService.DefaultContentJournalCapacity)
            {
                _tempDir = Path.Combine(Path.GetTempPath(), "jc-tag-content-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(_tempDir);
                User = new User("content-user", "Provider", "PasswordProvider");
                var accessible = accessibleIds.ToHashSet();
                Library = new CountingLibraryManager
                {
                    GetItemIdsHook = _ => accessibleIds.ToArray(),
                    GetItemByIdUserHook = (id, _) => accessible.Contains(id)
                        ? new StubMovie { Id = id }
                        : null,
                };
                Service = new TagCacheService(
                    Library,
                    new StubAppPaths(_tempDir),
                    NullLogger<TagCacheService>.Instance,
                    journalCapacity);
            }

            public User User { get; }

            public CountingLibraryManager Library { get; }

            public TagCacheService Service { get; }

            public void Dispose()
            {
                Service.Dispose();
                try
                {
                    Directory.Delete(_tempDir, recursive: true);
                }
                catch
                {
                    // Best-effort test cleanup.
                }
            }
        }
    }
}
