using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services
{
    /// <summary>
    /// The next-unwatched boundary owner behind the advanced Spoiler Guard
    /// category reveals: pure categorization (fail-closed to Other), bounded
    /// caching with TTL, O(1) eviction on UserDataSaved, and the cache cap.
    /// </summary>
    public sealed class SpoilerNextUnwatchedServiceTests
    {
        private static SpoilerNextUnwatchedService NewService(StubUserDataManager? userData = null)
            => new(
                new CountingLibraryManager(),
                new StubUserManager(),
                userData ?? new StubUserDataManager(),
                NullLogger<SpoilerNextUnwatchedService>.Instance);

        private static SpoilerNextUnwatchedService.NextUnwatchedBoundary Boundary(
            Guid? episodeId = null, int season = 2, int episode = 5)
            => new(episodeId ?? Guid.NewGuid(), season, episode);

        // ─── Categorize (pure) ───────────────────────────────────────────────

        [Fact]
        public void Categorize_NullBoundary_IsOther()
        {
            Assert.Equal(
                SpoilerEpisodeCategory.Other,
                SpoilerNextUnwatchedService.Categorize(null, Guid.NewGuid(), 2, 5));
        }

        [Fact]
        public void Categorize_MatchingEpisodeId_WithValidIndexes_IsNextEpisode()
        {
            var id = Guid.NewGuid();
            Assert.Equal(
                SpoilerEpisodeCategory.NextEpisode,
                SpoilerNextUnwatchedService.Categorize(Boundary(id, season: 2, episode: 5), id, 2, 5));
        }

        [Theory]
        [InlineData(null, null)] // both indexes missing
        [InlineData(null, 5)]    // season missing
        [InlineData(2, null)]    // episode missing
        [InlineData(0, 5)]       // season 0 (stale boundary after a metadata move)
        public void Categorize_MatchingEpisodeId_WithoutValidIndexes_FailsClosedToOther(int? season, int? episode)
        {
            // A DTO that cannot prove it is a well-formed regular episode never
            // earns a reveal, even when its id equals the cached boundary.
            var id = Guid.NewGuid();
            Assert.Equal(
                SpoilerEpisodeCategory.Other,
                SpoilerNextUnwatchedService.Categorize(Boundary(id), id, season, episode));
        }

        [Fact]
        public void Categorize_DifferentIdWithBoundaryCoordinates_IsOnlyCurrentSeason()
        {
            // Duplicate season/episode numbering (alternate versions) must not
            // inherit the NextEpisode mask — identity comes from the id alone.
            Assert.Equal(
                SpoilerEpisodeCategory.CurrentSeason,
                SpoilerNextUnwatchedService.Categorize(Boundary(season: 2, episode: 5), Guid.NewGuid(), 2, 5));
        }

        [Theory]
        [InlineData(2, 4)] // earlier in the boundary season (skipped)
        [InlineData(2, 6)] // later in the boundary season
        public void Categorize_SameSeasonOtherEpisode_IsCurrentSeason(int season, int episode)
        {
            Assert.Equal(
                SpoilerEpisodeCategory.CurrentSeason,
                SpoilerNextUnwatchedService.Categorize(Boundary(season: 2, episode: 5), Guid.NewGuid(), season, episode));
        }

        [Theory]
        [InlineData(1, 3)]  // earlier season (skipped episodes)
        [InlineData(3, 1)]  // future season
        [InlineData(0, 2)]  // specials never categorize by season membership
        [InlineData(-1, 2)] // malformed season index
        public void Categorize_OtherSeasonsAndSpecials_AreOther(int season, int episode)
        {
            Assert.Equal(
                SpoilerEpisodeCategory.Other,
                SpoilerNextUnwatchedService.Categorize(Boundary(season: 2, episode: 5), Guid.NewGuid(), season, episode));
        }

        [Fact]
        public void Categorize_MissingIndexNumbers_AreOther()
        {
            var boundary = Boundary(season: 2, episode: 5);
            Assert.Equal(
                SpoilerEpisodeCategory.Other,
                SpoilerNextUnwatchedService.Categorize(boundary, Guid.NewGuid(), null, 5));
            Assert.Equal(
                SpoilerEpisodeCategory.Other,
                SpoilerNextUnwatchedService.Categorize(boundary, Guid.NewGuid(), 2, null));
        }

        // ─── GetBoundary caching ─────────────────────────────────────────────

        [Fact]
        public void GetBoundary_EmptyGuids_ReturnNullWithoutComputing()
        {
            using var service = NewService();
            var computeCalls = 0;
            service.BoundaryComputerForTest = (_, _) => { computeCalls++; return Boundary(); };

            Assert.Null(service.GetBoundary(Guid.Empty, Guid.NewGuid()));
            Assert.Null(service.GetBoundary(Guid.NewGuid(), Guid.Empty));
            Assert.Equal(0, computeCalls);
        }

        [Fact]
        public void GetBoundary_CachesWithinTtl_AndCachesNullResults()
        {
            using var service = NewService();
            var computeCalls = 0;
            service.BoundaryComputerForTest = (_, _) => { computeCalls++; return null; };
            var user = Guid.NewGuid();
            var series = Guid.NewGuid();

            Assert.Null(service.GetBoundary(user, series));
            Assert.Null(service.GetBoundary(user, series));

            // A fully-watched series (null boundary) is also cached — the
            // negative answer must not re-query per item.
            Assert.Equal(1, computeCalls);
        }

        [Fact]
        public void GetBoundary_RecomputesAfterTtlExpiry()
        {
            using var service = NewService();
            var computeCalls = 0;
            long now = 0;
            service.ClockTicksForTest = () => now;
            service.BoundaryComputerForTest = (_, _) => { computeCalls++; return Boundary(); };
            var user = Guid.NewGuid();
            var series = Guid.NewGuid();

            service.GetBoundary(user, series);
            now += SpoilerNextUnwatchedService.CacheTtl.Ticks - 1;
            service.GetBoundary(user, series);
            Assert.Equal(1, computeCalls);

            now += 2;
            service.GetBoundary(user, series);
            Assert.Equal(2, computeCalls);
        }

        [Fact]
        public void GetBoundary_EvictsOnUserDataSavedForThatUsersSeries()
        {
            var userData = new StubUserDataManager();
            using var service = NewService(userData);
            var computeCalls = 0;
            service.BoundaryComputerForTest = (_, _) => { computeCalls++; return Boundary(); };
            var user = Guid.NewGuid();
            var otherUser = Guid.NewGuid();
            var series = Guid.NewGuid();
            var episode = new Episode { Id = Guid.NewGuid(), SeriesId = series };

            service.GetBoundary(user, series);
            Assert.Equal(1, computeCalls);

            // Another user's watched-state change must not evict this user's key.
            userData.RaiseUserDataSaved(otherUser, episode, UserDataSaveReason.TogglePlayed);
            service.GetBoundary(user, series);
            Assert.Equal(1, computeCalls);

            userData.RaiseUserDataSaved(user, episode, UserDataSaveReason.TogglePlayed);
            service.GetBoundary(user, series);
            Assert.Equal(2, computeCalls);
        }

        [Fact]
        public void Dispose_Unsubscribes_SoLaterEventsDoNotTouchTheService()
        {
            var userData = new StubUserDataManager();
            var service = NewService(userData);
            Assert.Equal(1, userData.UserDataSavedSubscriberCount);
            service.Dispose();
            Assert.Equal(0, userData.UserDataSavedSubscriberCount);
        }

        // ─── ComputeBoundary (the real bounded query path, no seam) ──────────

        private static SpoilerNextUnwatchedService NewLiveService(
            CountingLibraryManager lib, out StubUserManager users, StubUserDataManager? userData = null)
        {
            users = new StubUserManager
            {
                GetUserByIdHook = _ => new User("boundary-user", "provider", "password-provider"),
            };
            return new SpoilerNextUnwatchedService(
                lib, users, userData ?? new StubUserDataManager(),
                NullLogger<SpoilerNextUnwatchedService>.Instance);
        }

        [Fact]
        public async Task ColdMiss_FailsClosedWithoutInlineQuery_ThenBackgroundFillPublishes()
        {
            var seriesId = Guid.NewGuid();
            var episodeId = Guid.NewGuid();
            InternalItemsQuery? seen = null;
            var lib = new CountingLibraryManager
            {
                GetItemListHook = q =>
                {
                    seen = q;
                    return new List<BaseItem>
                    {
                        new Episode { Id = episodeId, SeriesId = seriesId, ParentIndexNumber = 2, IndexNumber = 5 },
                    };
                },
            };
            using var service = NewLiveService(lib, out _);
            var fills = new List<Task>();
            service.BackgroundFillObserverForTest = fills.Add;
            var user = Guid.NewGuid();

            // PERF(S3): the miss itself must not touch the library on the
            // calling thread — it fails closed and schedules the fill.
            Assert.Null(service.GetBoundary(user, seriesId));
            _ = Assert.Single(fills);
            await Task.WhenAll(fills);

            var boundary = service.GetBoundary(user, seriesId);
            Assert.Equal(new SpoilerNextUnwatchedService.NextUnwatchedBoundary(episodeId, 2, 5), boundary);
            Assert.NotNull(seen);
            Assert.Equal(seriesId, seen!.ParentId);
            Assert.Equal(1, seen.Limit);
            Assert.False(seen.IsPlayed ?? true);
            Assert.Equal(0, seen.ParentIndexNumberNotEquals);
            Assert.Equal(1, lib.GetItemListCallCount);
        }

        [Fact]
        public async Task ColdMiss_CoalescesConcurrentRequestsToOneFill()
        {
            var lib = new CountingLibraryManager { GetItemListHook = _ => new List<BaseItem>() };
            using var service = NewLiveService(lib, out _);
            var fills = new List<Task>();
            service.BackgroundFillObserverForTest = fills.Add;
            var user = Guid.NewGuid();
            var series = Guid.NewGuid();

            // A 100-episode page hits the same missing key repeatedly; only
            // one background fill may be scheduled for it.
            for (var i = 0; i < 100; i++) Assert.Null(service.GetBoundary(user, series));
            _ = Assert.Single(fills);
            await Task.WhenAll(fills);
            Assert.Equal(1, lib.GetItemListCallCount);
        }

        [Theory]
        [InlineData(0, 2)]      // season 0 result (defensive: query already excludes)
        [InlineData(null, 2)]   // missing season index
        [InlineData(2, null)]   // missing episode index
        public async Task BackgroundFill_UnusableFirstEpisode_PublishesNull(int? season, int? episode)
        {
            var lib = new CountingLibraryManager
            {
                GetItemListHook = _ => new List<BaseItem>
                {
                    new Episode { Id = Guid.NewGuid(), ParentIndexNumber = season, IndexNumber = episode },
                },
            };
            using var service = NewLiveService(lib, out _);
            var fills = new List<Task>();
            service.BackgroundFillObserverForTest = fills.Add;
            var user = Guid.NewGuid();
            var series = Guid.NewGuid();

            Assert.Null(service.GetBoundary(user, series));
            await Task.WhenAll(fills);
            Assert.Null(service.GetBoundary(user, series));
            Assert.Equal(1, lib.GetItemListCallCount);
        }

        [Fact]
        public async Task BackgroundFill_UnknownUser_PublishesNullWithoutQuerying()
        {
            var lib = new CountingLibraryManager { GetItemListHook = _ => new List<BaseItem>() };
            using var service = NewLiveService(lib, out var users);
            users.GetUserByIdHook = _ => null;
            var fills = new List<Task>();
            service.BackgroundFillObserverForTest = fills.Add;
            var user = Guid.NewGuid();
            var series = Guid.NewGuid();

            Assert.Null(service.GetBoundary(user, series));
            await Task.WhenAll(fills);
            Assert.Null(service.GetBoundary(user, series));
            Assert.Equal(0, lib.GetItemListCallCount);
        }

        [Fact]
        public async Task BackgroundFill_QueryFault_PublishesFailClosedNull_AndCachesIt()
        {
            var calls = 0;
            var lib = new CountingLibraryManager
            {
                GetItemListHook = _ => { calls++; throw new InvalidOperationException("db saturated"); },
            };
            using var service = NewLiveService(lib, out _);
            var fills = new List<Task>();
            service.BackgroundFillObserverForTest = fills.Add;
            var user = Guid.NewGuid();
            var series = Guid.NewGuid();

            Assert.Null(service.GetBoundary(user, series));
            await Task.WhenAll(fills);
            // The fault result is cached like any other answer — a broken
            // library must not turn the strip path into a fill-churn loop.
            Assert.Null(service.GetBoundary(user, series));
            Assert.Null(service.GetBoundary(user, series));
            Assert.Equal(1, calls);
            _ = Assert.Single(fills);
        }

        [Fact]
        public async Task InvalidationDuringActiveFill_DiscardsTheStaleBoundary()
        {
            // A fill that read played-state BEFORE a watched-state change must
            // not publish after the change evicts the key — otherwise a stale
            // NextEpisode mask could pin the wrong reveal for the full TTL.
            var seriesId = Guid.NewGuid();
            var user = Guid.NewGuid();
            var staleEpisode = new Episode { Id = Guid.NewGuid(), SeriesId = seriesId, ParentIndexNumber = 2, IndexNumber = 5 };
            var userData = new StubUserDataManager();
            var lib = new CountingLibraryManager
            {
                GetItemListHook = _ => new List<BaseItem> { staleEpisode },
            };
            using var service = NewLiveService(lib, out _, userData);
            var fills = new List<Task>();
            service.BackgroundFillObserverForTest = fills.Add;
            // The user marks an episode of this series watched exactly between
            // the worker's library read and its publish step.
            service.BeforePublishForTest = () =>
                userData.RaiseUserDataSaved(user, staleEpisode, UserDataSaveReason.TogglePlayed);

            Assert.Null(service.GetBoundary(user, seriesId));
            await Task.WhenAll(fills);

            // The stale computation was discarded; the key is a fresh miss that
            // schedules a new fill rather than serving the pre-change answer.
            service.BeforePublishForTest = null;
            Assert.Null(service.GetBoundary(user, seriesId));
            Assert.Equal(2, fills.Count);
            await Task.WhenAll(fills);
            Assert.NotNull(service.GetBoundary(user, seriesId));
        }

        [Fact]
        public async Task InvalidationAfterPublish_WithdrawsTheJustPublishedBoundary()
        {
            // The narrowest interleaving: the worker passes its token check and
            // publishes, and the invalidation lands before the worker's
            // recheck. Because Invalidate removes the token FIRST, the recheck
            // fails and the worker withdraws its own stale publication.
            var seriesId = Guid.NewGuid();
            var user = Guid.NewGuid();
            var staleEpisode = new Episode { Id = Guid.NewGuid(), SeriesId = seriesId, ParentIndexNumber = 2, IndexNumber = 5 };
            var userData = new StubUserDataManager();
            var lib = new CountingLibraryManager
            {
                GetItemListHook = _ => new List<BaseItem> { staleEpisode },
            };
            using var service = NewLiveService(lib, out _, userData);
            var fills = new List<Task>();
            service.BackgroundFillObserverForTest = fills.Add;
            service.AfterPublishForTest = () =>
                userData.RaiseUserDataSaved(user, staleEpisode, UserDataSaveReason.TogglePlayed);

            Assert.Null(service.GetBoundary(user, seriesId));
            await Task.WhenAll(fills);

            // The stale entry was withdrawn; the key misses again and refills.
            service.AfterPublishForTest = null;
            Assert.Null(service.GetBoundary(user, seriesId));
            Assert.Equal(2, fills.Count);
            await Task.WhenAll(fills);
            Assert.NotNull(service.GetBoundary(user, seriesId));
        }

        [Fact]
        public void GetBoundary_CapOverflow_ClearsAndStaysBounded()
        {
            using var service = NewService();
            service.BoundaryComputerForTest = (_, _) => Boundary();
            var user = Guid.NewGuid();

            for (var i = 0; i < SpoilerNextUnwatchedService.MaxCacheEntries; i++)
            {
                service.GetBoundary(user, Guid.NewGuid());
            }

            // The insert past the cap clears the map first; the map never
            // exceeds the cap and the answer is still served.
            var computeCallsBefore = 0;
            service.BoundaryComputerForTest = (_, _) => { computeCallsBefore++; return Boundary(); };
            var series = Guid.NewGuid();
            Assert.NotNull(service.GetBoundary(user, series));
            Assert.Equal(1, computeCallsBefore);

            // The cleared map re-caches the key normally afterwards.
            Assert.NotNull(service.GetBoundary(user, series));
            Assert.Equal(1, computeCallsBefore);
        }
    }
}
