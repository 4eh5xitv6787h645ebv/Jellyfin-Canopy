using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Model;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services
{
    public sealed class TagCacheProjectionRevisionTests
    {
        private static string Key(Guid id) => id.ToString("N");

        private static TagCacheProjectionRevisionService NewTracker(
            StubUserDataManager userData,
            int capacity = TagCacheProjectionRevisionService.DefaultJournalCapacity)
        {
            return new TagCacheProjectionRevisionService(
                userData,
                NullLogger<TagCacheProjectionRevisionService>.Instance,
                capacity);
        }

        [Fact]
        public void RepeatedEpisodeWatchedToggle_AdvancesRevisionAndReplaysAllDependencies()
        {
            var userData = new StubUserDataManager();
            using var tracker = NewTracker(userData);
            var userId = Guid.NewGuid();
            var seriesId = Guid.NewGuid();
            var seasonId = Guid.NewGuid();
            var episode = new StubEpisode
            {
                Id = Guid.NewGuid(),
                SeasonId = seasonId,
                SeriesId = seriesId
            };
            var expected = new[] { Key(episode.Id), Key(seasonId), Key(seriesId) }
                .OrderBy(static id => id, StringComparer.Ordinal)
                .ToArray();

            var initial = tracker.GetDelta(userId, null, null, requireCursor: false);
            userData.RaiseUserDataSaved(userId, episode, UserDataSaveReason.TogglePlayed);

            var first = tracker.GetDelta(userId, initial.Epoch, initial.Revision, requireCursor: true);
            Assert.False(first.ResetRequired);
            Assert.Equal(1, first.Revision);
            Assert.Equal(expected, first.ItemIds);

            // A repeated toggle is another authoritative transition, even though its
            // dependency set is identical. A client on revision 1 must see it.
            userData.RaiseUserDataSaved(userId, episode, UserDataSaveReason.TogglePlayed);
            var second = tracker.GetDelta(userId, first.Epoch, first.Revision, requireCursor: true);
            Assert.False(second.ResetRequired);
            Assert.Equal(2, second.Revision);
            Assert.Equal(expected, second.ItemIds);

            // Replaying both journal records deduplicates ids without losing the
            // latest revision boundary.
            var aggregate = tracker.GetDelta(userId, initial.Epoch, initial.Revision, requireCursor: true);
            Assert.Equal(2, aggregate.Revision);
            Assert.Equal(expected, aggregate.ItemIds);
        }

        [Fact]
        public void DependencyExpansion_CoversSeasonBoundaryAndSelfProjectedTypes()
        {
            var seriesId = Guid.NewGuid();
            var season = new StubSeason { Id = Guid.NewGuid(), SeriesId = seriesId };
            var episode = new StubEpisode
            {
                Id = Guid.NewGuid(),
                SeasonId = season.Id,
                SeriesId = seriesId
            };
            var movie = new StubMovie { Id = Guid.NewGuid() };
            var series = new StubSeries { Id = seriesId };

            Assert.Equal(
                SortedKeys(episode.Id, season.Id, seriesId),
                TagCacheProjectionRevisionService.ExpandProjectionDependencies(episode));
            Assert.Equal(
                SortedKeys(season.Id, seriesId),
                TagCacheProjectionRevisionService.ExpandProjectionDependencies(season));
            Assert.Equal(
                new[] { Key(movie.Id) },
                TagCacheProjectionRevisionService.ExpandProjectionDependencies(movie));
            Assert.Equal(
                new[] { Key(series.Id) },
                TagCacheProjectionRevisionService.ExpandProjectionDependencies(series));
        }

        [Fact]
        public void PerUserJournals_AreRevisionAndPayloadIsolated()
        {
            var userData = new StubUserDataManager();
            using var tracker = NewTracker(userData);
            var userA = Guid.NewGuid();
            var userB = Guid.NewGuid();
            var movieA = new StubMovie { Id = Guid.NewGuid() };
            var movieB = new StubMovie { Id = Guid.NewGuid() };
            var cursorA = tracker.GetDelta(userA, null, null, requireCursor: false);
            var cursorB = tracker.GetDelta(userB, null, null, requireCursor: false);

            userData.RaiseUserDataSaved(userA, movieA, UserDataSaveReason.TogglePlayed);
            userData.RaiseUserDataSaved(userB, movieB, UserDataSaveReason.TogglePlayed);
            userData.RaiseUserDataSaved(userA, movieA, UserDataSaveReason.TogglePlayed);

            var deltaA = tracker.GetDelta(userA, cursorA.Epoch, cursorA.Revision, requireCursor: true);
            var deltaB = tracker.GetDelta(userB, cursorB.Epoch, cursorB.Revision, requireCursor: true);
            Assert.Equal(2, deltaA.Revision);
            Assert.Equal(new[] { Key(movieA.Id) }, deltaA.ItemIds);
            Assert.Equal(1, deltaB.Revision);
            Assert.Equal(new[] { Key(movieB.Id) }, deltaB.ItemIds);

            var caughtUpB = tracker.GetDelta(userB, deltaB.Epoch, deltaB.Revision, requireCursor: true);
            Assert.False(caughtUpB.ResetRequired);
            Assert.Empty(caughtUpB.ItemIds);
            Assert.Equal(1, caughtUpB.Revision);
        }

        [Fact]
        public void PlaybackProgress_DoesNotAdvanceProjectionRevision()
        {
            var userData = new StubUserDataManager();
            using var tracker = NewTracker(userData);
            var userId = Guid.NewGuid();
            var initial = tracker.GetDelta(userId, null, null, requireCursor: false);

            userData.RaiseUserDataSaved(
                userId,
                new StubMovie { Id = Guid.NewGuid() },
                UserDataSaveReason.PlaybackProgress);

            var delta = tracker.GetDelta(userId, initial.Epoch, initial.Revision, requireCursor: true);
            Assert.False(delta.ResetRequired);
            Assert.Equal(0, delta.Revision);
            Assert.Empty(delta.ItemIds);
        }

        [Fact]
        public void JournalGapAndInvalidCursors_RequireExplicitReset()
        {
            var userData = new StubUserDataManager();
            using var tracker = NewTracker(userData, capacity: 2);
            var userId = Guid.NewGuid();
            var initial = tracker.GetDelta(userId, null, null, requireCursor: false);
            var movies = Enumerable.Range(0, 3)
                .Select(_ => new StubMovie { Id = Guid.NewGuid() })
                .ToArray();
            foreach (var movie in movies)
            {
                userData.RaiseUserDataSaved(userId, movie, UserDataSaveReason.TogglePlayed);
            }

            // Revision 1 is the last cursor still covered by the retained [2,3]
            // records. Revision 0 has a gap and must force a full snapshot.
            var covered = tracker.GetDelta(userId, initial.Epoch, clientRevision: 1, requireCursor: true);
            Assert.False(covered.ResetRequired);
            Assert.Equal(SortedKeys(movies[1].Id, movies[2].Id), covered.ItemIds);

            AssertReset(tracker.GetDelta(userId, initial.Epoch, initial.Revision, requireCursor: true), 3);
            AssertReset(tracker.GetDelta(userId, "different-process", 3, requireCursor: true), 3);
            AssertReset(tracker.GetDelta(userId, initial.Epoch, 4, requireCursor: true), 3);
            AssertReset(tracker.GetDelta(userId, initial.Epoch, -1, requireCursor: true), 3);
            AssertReset(tracker.GetDelta(userId, initial.Epoch, null, requireCursor: true), 3);
            AssertReset(tracker.GetDelta(userId, null, 3, requireCursor: true), 3);
        }

        [Fact]
        public void ConstructorSubscribes_InitializeIsIdempotent_AndDisposeUnsubscribes()
        {
            var userData = new StubUserDataManager();
            var tracker = new TagCacheProjectionRevisionService(
                userData,
                NullLogger<TagCacheProjectionRevisionService>.Instance,
                journalCapacity: 2);

            Assert.Equal(1, userData.UserDataSavedSubscriberCount);
            tracker.Initialize();
            tracker.Initialize();
            Assert.Equal(1, userData.UserDataSavedSubscriberCount);

            tracker.Dispose();
            Assert.Equal(0, userData.UserDataSavedSubscriberCount);
        }

        [Fact]
        public void ProjectionSelection_DirectlyLooksUpOnlyRequestedCachedIdsForThatUser()
        {
            var user = new User("projection-user", "Provider", "PasswordProvider");
            var accessible = new StubMovie { Id = Guid.NewGuid() };
            var inaccessible = new StubMovie { Id = Guid.NewGuid() };
            var missing = Guid.NewGuid();
            var lookups = new List<(Guid Id, User? User)>();
            var library = new CountingLibraryManager
            {
                GetItemByIdUserHook = (id, scopedUser) =>
                {
                    lookups.Add((id, scopedUser));
                    return id == accessible.Id ? accessible : null;
                }
            };
            using var service = new TagCacheService(
                library,
                new StubAppPaths(Path.GetTempPath()),
                NullLogger<TagCacheService>.Instance);
            var accessibleEntry = new TagCacheEntry { Type = "Movie" };
            service.SeedEntryForTest(Key(accessible.Id), accessibleEntry);
            service.SeedEntryForTest(Key(inaccessible.Id), new TagCacheEntry { Type = "Movie" });

            var result = service.GetCacheEntriesForUserByIds(
                user,
                new[]
                {
                    Key(accessible.Id),
                    Key(inaccessible.Id),
                    Key(missing),
                    "not-an-id",
                    Key(accessible.Id)
                });

            var selected = Assert.Single(result);
            Assert.Equal(Key(accessible.Id), selected.Key);
            Assert.Same(accessibleEntry, selected.Value);
            Assert.Equal(new[] { accessible.Id, inaccessible.Id }, lookups.Select(static lookup => lookup.Id));
            Assert.All(lookups, lookup => Assert.Same(user, lookup.User));
        }


        // ── BI-PERF-037 (#98): cross-request season aggregate cache (AC2/AC5) ──

        [Fact]
        public void SeasonAggregate_ReusedAtSameContentRevision_MissAtNewContentRevision()
        {
            var userData = new StubUserDataManager();
            using var tracker = NewTracker(userData);
            var userId = Guid.NewGuid();
            var seasonId = Guid.NewGuid();

            // Nothing cached yet.
            Assert.False(tracker.TryGetSeasonAnyWatched(userId, seasonId, contentRevision: 5, out _));

            var version = tracker.BeginSeasonAggregate(userId, seasonId);
            tracker.CommitSeasonAggregate(userId, seasonId, anyWatched: true, contentRevision: 5, capturedVersion: version);

            // Reused at the SAME content revision (the daily double-fetch / any
            // full/delta at an unchanged relevant revision — AC2).
            Assert.True(tracker.TryGetSeasonAnyWatched(userId, seasonId, contentRevision: 5, out var anyWatched));
            Assert.True(anyWatched);

            // A library add/update/remove bumps the content revision → miss → the
            // caller recomputes, so a journal-invisible deletion can never keep a
            // stale anyWatched=true (byte-identical to recompute-every-request).
            Assert.False(tracker.TryGetSeasonAnyWatched(userId, seasonId, contentRevision: 6, out _));
        }

        [Fact]
        public void SeasonAggregate_UserDataSave_InvalidatesOnlyTheAffectedSeason()
        {
            var userData = new StubUserDataManager();
            using var tracker = NewTracker(userData);
            var userId = Guid.NewGuid();
            var seriesId = Guid.NewGuid();
            var changedSeason = Guid.NewGuid();
            var otherSeason = Guid.NewGuid();

            tracker.CommitSeasonAggregate(
                userId, changedSeason, anyWatched: true, contentRevision: 1,
                capturedVersion: tracker.BeginSeasonAggregate(userId, changedSeason));
            tracker.CommitSeasonAggregate(
                userId, otherSeason, anyWatched: true, contentRevision: 1,
                capturedVersion: tracker.BeginSeasonAggregate(userId, otherSeason));

            // A play/unplay of an episode in changedSeason only.
            userData.RaiseUserDataSaved(
                userId,
                new StubEpisode { Id = Guid.NewGuid(), SeasonId = changedSeason, SeriesId = seriesId },
                UserDataSaveReason.TogglePlayed);

            // Targeted (AC5): changedSeason invalidated, otherSeason still reused.
            Assert.False(tracker.TryGetSeasonAnyWatched(userId, changedSeason, contentRevision: 1, out _));
            Assert.True(tracker.TryGetSeasonAnyWatched(userId, otherSeason, contentRevision: 1, out var otherWatched));
            Assert.True(otherWatched);
        }

        [Fact]
        public void SeasonAggregate_CommitRacingAnInvalidation_IsDiscarded()
        {
            var userData = new StubUserDataManager();
            using var tracker = NewTracker(userData);
            var userId = Guid.NewGuid();
            var seriesId = Guid.NewGuid();
            var seasonId = Guid.NewGuid();

            // Capture the version BEFORE the walk, then a save for this season lands
            // mid-walk (bumping the version), then the walk's result is committed.
            var captured = tracker.BeginSeasonAggregate(userId, seasonId);
            userData.RaiseUserDataSaved(
                userId,
                new StubEpisode { Id = Guid.NewGuid(), SeasonId = seasonId, SeriesId = seriesId },
                UserDataSaveReason.TogglePlayed);
            tracker.CommitSeasonAggregate(userId, seasonId, anyWatched: true, contentRevision: 1, capturedVersion: captured);

            // The commit is discarded (its captured version is stale), so a value
            // computed across the change is never served: the next lookup misses.
            Assert.False(tracker.TryGetSeasonAnyWatched(userId, seasonId, contentRevision: 1, out _));
        }

        private static string[] SortedKeys(params Guid[] ids)
            => ids.Select(Key).OrderBy(static id => id, StringComparer.Ordinal).ToArray();

        private static void AssertReset(
            TagCacheProjectionRevisionService.ProjectionDelta delta,
            long expectedRevision)
        {
            Assert.True(delta.ResetRequired);
            Assert.Equal(expectedRevision, delta.Revision);
            Assert.Empty(delta.ItemIds);
        }
    }
}
