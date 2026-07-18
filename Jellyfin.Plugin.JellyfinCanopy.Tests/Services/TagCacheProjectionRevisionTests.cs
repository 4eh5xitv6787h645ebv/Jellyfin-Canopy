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

        // ── BI-PERF-037 (#98): per-(user, season) watched-aggregate cache ─────

        [Fact]
        public void SeasonAggregate_UserStateChange_EvictsOnlyTheAffectedUserSeasonPair()
        {
            var userData = new StubUserDataManager();
            using var tracker = NewTracker(userData);
            var userA = Guid.NewGuid();
            var userB = Guid.NewGuid();
            var seriesId = Guid.NewGuid();
            var seasonOne = Guid.NewGuid();
            var seasonTwo = Guid.NewGuid();

            tracker.PublishSeasonAggregate(userA, seasonOne, observedRevision: 0, anyWatched: true);
            tracker.PublishSeasonAggregate(userA, seasonTwo, observedRevision: 0, anyWatched: false);
            tracker.PublishSeasonAggregate(userB, seasonOne, observedRevision: 0, anyWatched: true);

            userData.RaiseUserDataSaved(
                userA,
                new StubEpisode { Id = Guid.NewGuid(), SeasonId = seasonOne, SeriesId = seriesId },
                UserDataSaveReason.TogglePlayed);

            // ONLY (userA, seasonOne) is evicted — targeted, not a global flush.
            Assert.False(tracker.TryGetSeasonAggregate(userA, seasonOne, out _));
            Assert.True(tracker.TryGetSeasonAggregate(userA, seasonTwo, out var unaffected));
            Assert.False(unaffected);
            Assert.True(tracker.TryGetSeasonAggregate(userB, seasonOne, out var otherUser));
            Assert.True(otherUser);
        }

        [Fact]
        public void SeasonAggregate_MovieAndSeriesEvents_DoNotFlushSeasonAggregates()
        {
            var userData = new StubUserDataManager();
            using var tracker = NewTracker(userData);
            var userId = Guid.NewGuid();
            var seasonId = Guid.NewGuid();
            tracker.PublishSeasonAggregate(userId, seasonId, observedRevision: 0, anyWatched: true);

            userData.RaiseUserDataSaved(
                userId, new StubMovie { Id = Guid.NewGuid() }, UserDataSaveReason.TogglePlayed);
            userData.RaiseUserDataSaved(
                userId, new StubSeries { Id = Guid.NewGuid() }, UserDataSaveReason.TogglePlayed);

            Assert.True(tracker.TryGetSeasonAggregate(userId, seasonId, out var anyWatched));
            Assert.True(anyWatched);
            // The existing revision/dependency journal is unchanged by aggregate
            // bookkeeping: both saves advanced the projection revision normally.
            Assert.Equal(2, tracker.GetDelta(userId, null, null, requireCursor: false).Revision);
        }

        [Fact]
        public void SeasonAggregate_SeasonEvent_EvictsThatSeasonsOwnAggregate()
        {
            var userData = new StubUserDataManager();
            using var tracker = NewTracker(userData);
            var userId = Guid.NewGuid();
            var seasonId = Guid.NewGuid();
            tracker.PublishSeasonAggregate(userId, seasonId, observedRevision: 0, anyWatched: false);

            userData.RaiseUserDataSaved(
                userId,
                new StubSeason { Id = seasonId, SeriesId = Guid.NewGuid() },
                UserDataSaveReason.TogglePlayed);

            Assert.False(tracker.TryGetSeasonAggregate(userId, seasonId, out _));
        }

        [Fact]
        public void SeasonAggregate_PublishFencedAgainstRacingInvalidation()
        {
            var userData = new StubUserDataManager();
            using var tracker = NewTracker(userData);
            var userId = Guid.NewGuid();
            var seriesId = Guid.NewGuid();
            var seasonId = Guid.NewGuid();

            // Compute observed revision 0; the season's own state then changes
            // BEFORE publication → the stale value must not be published.
            var observed = tracker.GetJournalRevision(userId);
            userData.RaiseUserDataSaved(
                userId,
                new StubEpisode { Id = Guid.NewGuid(), SeasonId = seasonId, SeriesId = seriesId },
                UserDataSaveReason.TogglePlayed);
            tracker.PublishSeasonAggregate(userId, seasonId, observed, anyWatched: false);
            Assert.False(tracker.TryGetSeasonAggregate(userId, seasonId, out _));

            // An UNRELATED change after the observation does not block publication.
            var observedAfter = tracker.GetJournalRevision(userId);
            userData.RaiseUserDataSaved(
                userId, new StubMovie { Id = Guid.NewGuid() }, UserDataSaveReason.TogglePlayed);
            tracker.PublishSeasonAggregate(userId, seasonId, observedAfter, anyWatched: true);
            Assert.True(tracker.TryGetSeasonAggregate(userId, seasonId, out var published));
            Assert.True(published);
        }

        [Fact]
        public void SeasonAggregate_JournalGapAfterObservation_RefusesPublication()
        {
            var userData = new StubUserDataManager();
            using var tracker = NewTracker(userData, capacity: 2);
            var userId = Guid.NewGuid();
            var seasonId = Guid.NewGuid();

            var observed = tracker.GetJournalRevision(userId);
            // Three unrelated saves overflow the capacity-2 journal: the rows
            // covering observed+1 are gone, so the season's unchanged-ness is
            // unprovable — publication must fail safe (recompute next request).
            for (var i = 0; i < 3; i++)
            {
                userData.RaiseUserDataSaved(
                    userId, new StubMovie { Id = Guid.NewGuid() }, UserDataSaveReason.TogglePlayed);
            }

            tracker.PublishSeasonAggregate(userId, seasonId, observed, anyWatched: true);
            Assert.False(tracker.TryGetSeasonAggregate(userId, seasonId, out _));
        }

        [Fact]
        public void SeasonAggregate_CapRetainsTheFull15kAcceptanceWorkload()
        {
            // The documented hard cap must hold the complete 15k-entry acceptance
            // workload (every entry a distinct season) with headroom; eviction
            // beyond the cap only ever forces a safe recompute.
            Assert.True(
                TagCacheProjectionRevisionService.SeasonAggregateMaximumEntries >= 15_000,
                "Season-aggregate cap must retain the 15k acceptance workload.");

            var userData = new StubUserDataManager();
            using var tracker = NewTracker(userData);
            var userId = Guid.NewGuid();
            var first = Guid.NewGuid();
            tracker.PublishSeasonAggregate(userId, first, observedRevision: 0, anyWatched: true);
            for (var i = 0; i < 15_000; i++)
            {
                tracker.PublishSeasonAggregate(userId, Guid.NewGuid(), observedRevision: 0, anyWatched: false);
            }

            // Under the cap nothing is evicted; the store stays bounded.
            Assert.True(tracker.TryGetSeasonAggregate(userId, first, out _));
            Assert.Equal(15_001, tracker.SeasonAggregateCountForTest);
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
