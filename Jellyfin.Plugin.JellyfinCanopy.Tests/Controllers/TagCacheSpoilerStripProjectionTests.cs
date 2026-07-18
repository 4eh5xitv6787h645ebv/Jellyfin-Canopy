using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Security.Claims;
using System.Text.Json;
using System.Threading;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Model;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Entities;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using BoxSet = MediaBrowser.Controller.Entities.Movies.BoxSet;
using Season = MediaBrowser.Controller.Entities.TV.Season;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers
{
    /// <summary>
    /// BI-PERF-037 (#98): the Spoiler Guard tag-cache projection must acquire its
    /// runtime facts (item resolution, played state, season index/any-watched) in
    /// BOUNDED BATCH manager calls instead of per-entry N+1 scalar lookups —
    /// while producing byte-identical fail-closed output to the unchanged pure
    /// <see cref="TagCacheService.ResolveTagStripDecision"/>, reusing each
    /// season's watched aggregate per relevant revision, and failing CLOSED on
    /// cancellation (never a partially-unstripped 200).
    /// </summary>
    public sealed class TagCacheSpoilerStripProjectionTests
    {
        // ── AC1: bounded batch calls, never one manager call per entry ─────────

        [Fact]
        public void BroadScope15kResponse_UsesBoundedBatchCalls_NotPerEntryLookups()
        {
            using var harness = new Harness();
            var seriesId = Guid.NewGuid();
            var keys = new List<string>(15_000);
            for (var i = 0; i < 14_000; i++)
            {
                keys.Add(harness.SeedGuardedEpisode(seriesId, played: i % 2 == 0));
            }

            for (var i = 0; i < 1_000; i++)
            {
                keys.Add(harness.SeedGuardedMovie(played: i % 2 == 0));
            }

            harness.SeedAccess(keys);
            harness.SaveSpoilerState(Harness.StateWithSeries(seriesId, harness.GuardedMovieIds));

            var payload = Harness.Payload(harness.Controller.GetTagCache(harness.User.Id));

            Assert.Equal(15_000, payload.GetProperty("count").GetInt32());
            // The projection performs exactly ONE user-scoped item batch and ONE
            // deduplicated user-data batch — and ZERO scalar manager calls.
            Assert.Equal(1, harness.Library.GetItemListCallCount);
            Assert.Equal(0, harness.Library.GetItemByIdCallCount);
            Assert.Equal(0, harness.Library.GetItemByIdUserCallCount);
            Assert.Equal(1, harness.UserData.GetUserDataBatchCallCount);
            Assert.Equal(15_000, harness.UserData.GetUserDataBatchItemCount);
            Assert.Equal(0, harness.UserData.GetUserDataCallCount);
            // Episode/Movie-only data set: no season walk at all.
            Assert.Equal(0, harness.TotalSeasonWalks);
        }

        [Fact]
        public void LargeSeries_WalksEachUncachedSeasonOnce_WithOneDeduplicatedUserDataBatch()
        {
            using var harness = new Harness();
            var seriesId = Guid.NewGuid();
            var keys = new List<string>();
            for (var seasonNumber = 2; seasonNumber <= 31; seasonNumber++)
            {
                keys.Add(harness.SeedGuardedSeason(seriesId, seasonNumber, episodeCount: 100));
            }

            harness.SeedAccess(keys);
            harness.SaveSpoilerState(Harness.StateWithSeries(seriesId));

            Harness.Payload(harness.Controller.GetTagCache(harness.User.Id));

            Assert.Equal(1, harness.Library.GetItemListCallCount);
            Assert.Equal(0, harness.Library.GetItemByIdCallCount);
            Assert.Equal(30, harness.TotalSeasonWalks);
            Assert.All(harness.SeasonWalkCounts.Values, static walks => Assert.Equal(1, walks));
            // 30 seasons × 100 episodes → ONE deduplicated batch, no per-episode calls.
            Assert.Equal(1, harness.UserData.GetUserDataBatchCallCount);
            Assert.Equal(3_000, harness.UserData.GetUserDataBatchItemCount);
            Assert.Equal(0, harness.UserData.GetUserDataCallCount);

            // A second identical request reuses every cached (user, season)
            // aggregate: no walk and no user-data batch at all.
            Harness.Payload(harness.Controller.GetTagCache(harness.User.Id));
            Assert.Equal(30, harness.TotalSeasonWalks);
            Assert.Equal(1, harness.UserData.GetUserDataBatchCallCount);
        }

        // ── AC2: season aggregate computed at most once per relevant revision ──

        [Fact]
        public void SeasonAggregate_ReusedAcrossStabilizationPassesAndAcrossRequestsAtSameRevision()
        {
            using var harness = new Harness();
            var seriesId = Guid.NewGuid();
            var seasonKey = harness.SeedGuardedSeason(seriesId, seasonNumber: 2, episodeCount: 5);
            var seasonId = Guid.ParseExact(seasonKey, "N");
            harness.SeedAccess(new[] { seasonKey });
            harness.SaveSpoilerState(Harness.StateWithSeries(seriesId));

            // Force a second stabilization pass: an unrelated Movie user-data save
            // lands DURING the first pass's season walk, advancing the projection
            // revision without touching this season.
            var raised = false;
            harness.OnSeasonWalk = _ =>
            {
                if (!raised)
                {
                    raised = true;
                    harness.UserData.RaiseUserDataSaved(
                        harness.User.Id,
                        new StubMovie { Id = Guid.NewGuid() },
                        MediaBrowser.Model.Entities.UserDataSaveReason.TogglePlayed);
                }
            };

            var full = Harness.Payload(harness.Controller.GetTagCache(harness.User.Id));
            Assert.False(full.GetProperty("reset").GetBoolean());
            // Two strips ran (revision advanced mid-request), but the episode
            // enumeration executed exactly once — the aggregate was reused.
            Assert.Equal(1, harness.TotalSeasonWalks);
            Assert.Equal(1, harness.Library.GetItemListCallCount);

            // A content delta returning the same Season at the same projection
            // revision reuses the aggregate across requests: still one walk total.
            harness.OnSeasonWalk = null;
            harness.Cache.PublishUpsertForTest(seasonKey, harness.Cache.GetEntryForTest(seasonKey)!.Clone());
            var delta = Harness.Payload(harness.Controller.GetTagCache(
                harness.User.Id,
                contentEpoch: full.GetProperty("contentEpoch").GetString(),
                contentRevision: full.GetProperty("contentRevision").GetInt64(),
                projectionEpoch: full.GetProperty("projectionEpoch").GetString(),
                projectionRevision: full.GetProperty("projectionRevision").GetInt64()));
            Assert.False(delta.GetProperty("reset").GetBoolean());
            Assert.True(delta.GetProperty("items").TryGetProperty(seasonKey, out _));
            Assert.Equal(1, harness.TotalSeasonWalks);

            // An episode change IN that season invalidates the aggregate: the next
            // request recomputes exactly once at the new relevant revision.
            harness.UserData.RaiseUserDataSaved(
                harness.User.Id,
                new StubEpisode { Id = Guid.NewGuid(), SeasonId = seasonId, SeriesId = seriesId },
                MediaBrowser.Model.Entities.UserDataSaveReason.TogglePlayed);
            Harness.Payload(harness.Controller.GetTagCache(harness.User.Id));
            Assert.Equal(2, harness.TotalSeasonWalks);
        }

        // ── AC3: explicit call/allocation/time budgets at 15k scale ────────────

        // Manager-call ceilings are exact (the algorithmic contract). The
        // allocation/time ceilings are coarse regression tripwires calibrated from
        // repeated local Release runs of this exact scope (measured ≈ 12 MB and
        // ≈ 40 ms on the dev machine) with generous headroom for CI variance; the
        // old per-entry N+1 path is excluded primarily by the exact call counts.
        private const long BudgetMaxItemBatches = 1;
        private const long BudgetMaxUserDataBatches = 1;
        private const long BudgetMaxScalarManagerCalls = 0;
        private const long BudgetMaxAllocatedBytes = 128L * 1024 * 1024;
        private const long BudgetMaxElapsedMilliseconds = 5_000;

        [Fact]
        public void Benchmark15kBroadScope_StaysWithinCallAllocationAndTimeBudgets()
        {
            using var harness = new Harness();
            var seriesId = Guid.NewGuid();
            var keys = new List<string>(15_000);
            for (var i = 0; i < 15_000; i++)
            {
                keys.Add(harness.SeedGuardedEpisode(seriesId, played: false));
            }

            harness.SeedAccess(keys);
            harness.SaveSpoilerState(Harness.StateWithSeries(seriesId));

            // Warm pass: JIT + test infrastructure, excluded from measurement.
            Harness.Payload(harness.Controller.GetTagCache(harness.User.Id));

            var itemBatchesBefore = harness.Library.GetItemListCallCount;
            var userDataBatchesBefore = harness.UserData.GetUserDataBatchCallCount;
            var allocatedBefore = GC.GetAllocatedBytesForCurrentThread();
            var stopwatch = Stopwatch.StartNew();

            var result = harness.Controller.GetTagCache(harness.User.Id);

            stopwatch.Stop();
            var allocatedBytes = GC.GetAllocatedBytesForCurrentThread() - allocatedBefore;
            var payload = Harness.Payload(result);
            Assert.Equal(15_000, payload.GetProperty("count").GetInt32());

            // The second request memoizes nothing across requests for items
            // (request-scoped), so it still proves the bounded batch shape.
            AssertWithinBudget(
                harness.Library.GetItemListCallCount - itemBatchesBefore,
                BudgetMaxItemBatches,
                "projection item batches");
            AssertWithinBudget(
                harness.UserData.GetUserDataBatchCallCount - userDataBatchesBefore,
                BudgetMaxUserDataBatches,
                "user-data batches");
            AssertWithinBudget(
                harness.Library.GetItemByIdCallCount
                + harness.Library.GetItemByIdUserCallCount
                + harness.UserData.GetUserDataCallCount,
                BudgetMaxScalarManagerCalls,
                "scalar manager calls");
            AssertWithinBudget(allocatedBytes, BudgetMaxAllocatedBytes, "allocated bytes");
            AssertWithinBudget(stopwatch.ElapsedMilliseconds, BudgetMaxElapsedMilliseconds, "elapsed ms");
        }

        [Fact]
        public void BudgetAssertion_RejectsBudgetPlusOne()
        {
            // The ceilings above are ASSERTED, not logged: one unit over any
            // budget fails the test.
            Assert.ThrowsAny<Xunit.Sdk.XunitException>(
                () => AssertWithinBudget(BudgetMaxItemBatches + 1, BudgetMaxItemBatches, "boundary"));
        }

        private static void AssertWithinBudget(long actual, long budget, string what)
            => Assert.True(
                actual <= budget,
                $"{what}: {actual} exceeded the budget of {budget}.");

        // ── AC4: output parity with the pure fail-closed decision ──────────────

        [Fact]
        public void OptimizedProjection_MatchesScalarReferenceOutput_AcrossWatchedScopeMatrix()
        {
            using var harness = new Harness();
            var guardedSeries = Guid.NewGuid();
            var otherSeries = Guid.NewGuid();
            var keys = new List<string>();

            // Episodes: watched / unwatched / unguarded / no-series / unresolved /
            // wrong live type.
            keys.Add(harness.SeedGuardedEpisode(guardedSeries, played: true));
            keys.Add(harness.SeedGuardedEpisode(guardedSeries, played: false));
            keys.Add(harness.SeedGuardedEpisode(otherSeries, played: false));
            var epNoSeries = Guid.NewGuid().ToString("N");
            harness.Cache.SeedEntryForTest(epNoSeries, Harness.EpisodeEntry(null));
            keys.Add(epNoSeries);
            var epUnresolved = Guid.NewGuid().ToString("N");
            harness.Cache.SeedEntryForTest(epUnresolved, Harness.EpisodeEntry(guardedSeries.ToString("N")));
            keys.Add(epUnresolved);
            var epWrongType = Guid.NewGuid();
            harness.LiveItems[epWrongType] = new StubSeason { Id = epWrongType, SeriesId = guardedSeries, IndexNumber = 1 };
            harness.Cache.SeedEntryForTest(epWrongType.ToString("N"), Harness.EpisodeEntry(guardedSeries.ToString("N")));
            keys.Add(epWrongType.ToString("N"));

            // Non-guid Episode key (guarded scope): fail-closed strip, no fact call.
            const string NonGuidKey = "not-a-guid-key";
            harness.Cache.SeedEntryForTest(NonGuidKey, Harness.EpisodeEntry(guardedSeries.ToString("N")));

            // Movies: direct watched/unwatched, via collection watched/unwatched,
            // out of scope.
            keys.Add(harness.SeedGuardedMovie(played: true));
            keys.Add(harness.SeedGuardedMovie(played: false));
            var collectionMovieWatched = harness.SeedMovie(played: true);
            var collectionMovieUnwatched = harness.SeedMovie(played: false);
            keys.Add(collectionMovieWatched);
            keys.Add(collectionMovieUnwatched);
            keys.Add(harness.SeedMovie(played: false)); // out of scope entirely
            var collectionId = harness.SeedCollection(
                Guid.ParseExact(collectionMovieWatched, "N"),
                Guid.ParseExact(collectionMovieUnwatched, "N"));

            // Series: guarded and unguarded.
            var guardedSeriesKey = guardedSeries.ToString("N");
            harness.Cache.SeedEntryForTest(guardedSeriesKey, Harness.SeriesEntry());
            keys.Add(guardedSeriesKey);
            var otherSeriesKey = otherSeries.ToString("N");
            harness.Cache.SeedEntryForTest(otherSeriesKey, Harness.SeriesEntry());
            keys.Add(otherSeriesKey);

            // Seasons: S0, S1 (with and without ratings), S2 any-watched, S2
            // unwatched, unresolved, wrong live type, stale cached SeasonNumber,
            // probe failure.
            keys.Add(harness.SeedGuardedSeason(guardedSeries, seasonNumber: 0, episodeCount: 2));
            keys.Add(harness.SeedGuardedSeason(guardedSeries, seasonNumber: 1, episodeCount: 2));
            var s1NoRatings = harness.SeedGuardedSeason(guardedSeries, seasonNumber: 1, episodeCount: 2);
            harness.Cache.GetEntryForTest(s1NoRatings)!.CommunityRating = null;
            harness.Cache.GetEntryForTest(s1NoRatings)!.CriticRating = null;
            keys.Add(s1NoRatings);
            var s2Watched = harness.SeedGuardedSeason(guardedSeries, seasonNumber: 2, episodeCount: 3, watchedEpisodes: 1);
            keys.Add(s2Watched);
            keys.Add(harness.SeedGuardedSeason(guardedSeries, seasonNumber: 2, episodeCount: 3));
            var seasonUnresolved = Guid.NewGuid().ToString("N");
            harness.Cache.SeedEntryForTest(seasonUnresolved, Harness.SeasonEntry(guardedSeries.ToString("N"), 2));
            keys.Add(seasonUnresolved);
            var seasonWrongType = Guid.NewGuid();
            harness.LiveItems[seasonWrongType] = new StubMovie { Id = seasonWrongType };
            harness.Cache.SeedEntryForTest(seasonWrongType.ToString("N"), Harness.SeasonEntry(guardedSeries.ToString("N"), 2));
            keys.Add(seasonWrongType.ToString("N"));
            var seasonStale = harness.SeedGuardedSeason(guardedSeries, seasonNumber: 2, episodeCount: 2);
            // Stale cached metadata says S1; the LIVE index (2, unwatched) must
            // drive the decision → full strip, not SeasonRatingOnly.
            harness.Cache.GetEntryForTest(seasonStale)!.SeasonNumber = 1;
            keys.Add(seasonStale);
            var seasonProbeFailure = harness.SeedGuardedSeason(guardedSeries, seasonNumber: 3, episodeCount: 2);
            harness.ProbeFailureSeasons.Add(Guid.ParseExact(seasonProbeFailure, "N"));
            keys.Add(seasonProbeFailure);

            // Unknown type: kept even in guarded scope.
            var boxSetKey = Guid.NewGuid().ToString("N");
            harness.Cache.SeedEntryForTest(boxSetKey, new TagCacheEntry { Type = "BoxSet", Genres = new[] { "Keep" } });
            keys.Add(boxSetKey);

            var accessKeys = new List<string>(keys) { NonGuidKey };
            harness.SeedAccess(accessKeys);
            var state = Harness.StateWithSeries(guardedSeries, harness.GuardedMovieIds);
            state.Collections[collectionId.ToString("N")] = new SpoilerBlurCollectionEntry
            {
                CollectionId = collectionId.ToString("N"),
            };
            harness.SaveSpoilerState(state);

            // BoxSet.GetLinkedChildren resolves through the static host
            // LibraryManager; point it at the harness for the collection rows.
            var previousLibraryManager = BaseItem.LibraryManager;
            BaseItem.LibraryManager = harness.Library;
            try
            {
                var expected = harness.ComputeScalarReferenceOutput(state);
                var payload = Harness.Payload(harness.Controller.GetTagCache(harness.User.Id));

                AssertEntryParity(expected, payload);
            }
            finally
            {
                BaseItem.LibraryManager = previousLibraryManager;
            }

            // The shared cached entries were never mutated: guarded rows were
            // cloned, and this seeded instance still carries its original fields.
            var sharedUnwatched = harness.Cache.GetEntryForTest(keys[1])!;
            Assert.Equal(new[] { "Guarded-Genre" }, sharedUnwatched.Genres);
            Assert.Equal(8.5f, sharedUnwatched.CommunityRating);
        }

        [Fact]
        public void FailClosedSentinel_StripsEveryRecognizedEntry_WithZeroManagerCalls()
        {
            using var harness = new Harness();
            var seriesId = Guid.NewGuid();
            var keys = new List<string>
            {
                harness.SeedGuardedEpisode(seriesId, played: true),
                harness.SeedGuardedMovie(played: true),
                harness.SeedGuardedSeason(seriesId, seasonNumber: 1, episodeCount: 2),
            };
            var seriesKey = seriesId.ToString("N");
            harness.Cache.SeedEntryForTest(seriesKey, Harness.SeriesEntry());
            keys.Add(seriesKey);
            var boxSetKey = Guid.NewGuid().ToString("N");
            harness.Cache.SeedEntryForTest(boxSetKey, new TagCacheEntry { Type = "BoxSet", Genres = new[] { "Keep" } });
            keys.Add(boxSetKey);
            harness.SeedAccess(keys);

            // A corrupt policy with no last-known-good yields the FailClosed
            // sentinel: every recognized entry strips WITHOUT consulting any
            // runtime fact — so the projection performs no manager call at all.
            harness.WriteCorruptSpoilerState();

            var expected = harness.ComputeScalarReferenceOutput(new UserSpoilerBlur { FailClosed = true });
            var payload = Harness.Payload(harness.Controller.GetTagCache(harness.User.Id));

            AssertEntryParity(expected, payload);
            Assert.Empty(payload.GetProperty("items").GetProperty(keys[0]).GetProperty("Genres").EnumerateArray());
            Assert.Equal("Keep", payload.GetProperty("items").GetProperty(boxSetKey).GetProperty("Genres")[0].GetString());
            Assert.Equal(0, harness.Library.GetItemListCallCount);
            Assert.Equal(0, harness.Library.GetItemByIdCallCount);
            Assert.Equal(0, harness.UserData.GetUserDataBatchCallCount);
            Assert.Equal(0, harness.UserData.GetUserDataCallCount);
        }

        private static void AssertEntryParity(
            IReadOnlyDictionary<string, TagCacheEntry> expected,
            JsonElement payload)
        {
            var items = payload.GetProperty("items");
            var actualKeys = items.EnumerateObject().Select(static property => property.Name)
                .OrderBy(static key => key, StringComparer.Ordinal)
                .ToArray();
            Assert.Equal(
                expected.Keys.OrderBy(static key => key, StringComparer.Ordinal).ToArray(),
                actualKeys);
            foreach (var (key, entry) in expected)
            {
                // Byte-identical: both sides serialize the same TagCacheEntry type
                // through the same serializer defaults.
                Assert.Equal(
                    JsonSerializer.Serialize(entry),
                    items.GetProperty(key).GetRawText());
            }
        }

        // ── AC6: cancellation fails closed ─────────────────────────────────────

        [Fact]
        public void CancellationDuringItemBatch_PropagatesWithoutServingPartiallyStrippedPayload()
        {
            using var harness = new Harness();
            var seriesId = Guid.NewGuid();
            var keys = new List<string> { harness.SeedGuardedEpisode(seriesId, played: false) };
            harness.SeedAccess(keys);
            harness.SaveSpoilerState(Harness.StateWithSeries(seriesId));

            using var cts = new CancellationTokenSource();
            var innerHook = harness.Library.GetItemListHook!;
            harness.Library.GetItemListHook = query =>
            {
                // Cancellation observed while the synchronous manager call is in
                // flight: the checkpoint AFTER the call must throw.
                cts.Cancel();
                return innerHook(query);
            };
            var servedBefore = harness.Cache.ServedContentIdsVisited;

            Assert.Throws<OperationCanceledException>(
                () => harness.Controller.GetTagCache(harness.User.Id, cancellationToken: cts.Token));

            // GetFullContentForUser recorded its own served ids before the strip;
            // the final publication (and the 200 payload) never happened.
            Assert.Equal(servedBefore + 1, harness.Cache.ServedContentIdsVisited);
        }

        [Fact]
        public void CancellationDuringSeasonWalk_PropagatesInsteadOfFailingOpen()
        {
            using var harness = new Harness();
            var seriesId = Guid.NewGuid();
            var keys = new List<string> { harness.SeedGuardedSeason(seriesId, seasonNumber: 2, episodeCount: 3) };
            harness.SeedAccess(keys);
            harness.SaveSpoilerState(Harness.StateWithSeries(seriesId));

            using var cts = new CancellationTokenSource();
            harness.OnSeasonWalk = _ => cts.Cancel();

            Assert.Throws<OperationCanceledException>(
                () => harness.Controller.GetTagCache(harness.User.Id, cancellationToken: cts.Token));
        }

        [Fact]
        public void OperationCanceledFromSeasonProbe_IsNeverSwallowedIntoAStripSuccess()
        {
            using var harness = new Harness();
            var seriesId = Guid.NewGuid();
            var keys = new List<string> { harness.SeedGuardedSeason(seriesId, seasonNumber: 2, episodeCount: 3) };
            harness.SeedAccess(keys);
            harness.SaveSpoilerState(Harness.StateWithSeries(seriesId));

            // The probe-failure catch (Exception) path treats faults as
            // unwatched → strip; OperationCanceledException must NOT take it.
            harness.OnSeasonWalk = _ => throw new OperationCanceledException();

            Assert.Throws<OperationCanceledException>(
                () => harness.Controller.GetTagCache(harness.User.Id));
        }

        [Fact]
        public void AlreadyCancelledToken_FailsBeforeAnyProjectionWork()
        {
            using var harness = new Harness();
            var seriesId = Guid.NewGuid();
            var keys = new List<string> { harness.SeedGuardedEpisode(seriesId, played: false) };
            harness.SeedAccess(keys);
            harness.SaveSpoilerState(Harness.StateWithSeries(seriesId));

            using var cts = new CancellationTokenSource();
            cts.Cancel();

            Assert.Throws<OperationCanceledException>(
                () => harness.Controller.GetTagCache(harness.User.Id, cancellationToken: cts.Token));
            Assert.Equal(0, harness.Library.GetItemListCallCount);
            Assert.Equal(0, harness.UserData.GetUserDataBatchCallCount);
        }

        // ── Harness ────────────────────────────────────────────────────────────

        private sealed class Harness : IDisposable
        {
            private readonly string _tempDir;
            private readonly TagCacheProjectionRevisionService _projection;
            private readonly UserConfigurationManager _userConfig;

            public Harness()
            {
                _tempDir = Path.Combine(
                    Path.GetTempPath(),
                    "jc-tagcache-strip-projection-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(_tempDir);

                User = new User("strip-projection", "Provider", "PasswordProvider");
                Users = new StubUserManager(User);
                Library = new CountingLibraryManager();
                Library.ConfigureUserAccessHook = static (_, _) => { };
                Library.GetItemListHook = query => (query.ItemIds ?? Array.Empty<Guid>())
                    .Select(id => LiveItems.TryGetValue(id, out var item) ? item : null)
                    .Where(static item => item != null)
                    .Select(static item => item!)
                    .ToList();
                Library.GetItemByIdNonGenericHook = id => LiveItems.TryGetValue(id, out var item) ? item : null;
                Library.GetItemByIdUserHook = (id, _) => LiveItems.TryGetValue(id, out var item) ? item : null;
                UserData = new StubUserDataManager
                {
                    GetUserDataBatchHook = (items, _) =>
                    {
                        var result = new Dictionary<Guid, UserItemData>();
                        foreach (var item in items)
                        {
                            if (PlayedIds.Contains(item.Id))
                            {
                                result[item.Id] = new UserItemData
                                {
                                    Key = item.Id.ToString("N"),
                                    Played = true,
                                };
                            }
                        }

                        return result;
                    },
                };
                var appPaths = new StubAppPaths(_tempDir);
                var config = new PluginConfiguration
                {
                    TagCacheServerMode = true,
                    SpoilerBlurEnabled = true,
                    SpoilerStripTags = true,
                    SpoilerStripRatings = true,
                };
                var configProvider = new FakePluginConfigProvider(config);
                _userConfig = new UserConfigurationManager(
                    appPaths,
                    NullLogger<UserConfigurationManager>.Instance);
                var markers = new SpoilerIdentityService(
                    Users,
                    NullLogger<SpoilerIdentityService>.Instance);
                var identity = new RequestIdentityService(
                    new CountingSessionManager(),
                    Users,
                    markers,
                    NullLogger<RequestIdentityService>.Instance);
                var resolver = new SpoilerUserResolver(
                    _userConfig,
                    Library,
                    NullLogger<SpoilerUserResolver>.Instance,
                    identity);

                Cache = new TagCacheService(
                    Library,
                    appPaths,
                    NullLogger<TagCacheService>.Instance);
                _projection = new TagCacheProjectionRevisionService(
                    UserData,
                    NullLogger<TagCacheProjectionRevisionService>.Instance);
                Projection = _projection;
                Controller = new TagCacheController(
                    new RecordingHttpClientFactory(new HttpClientHandler()),
                    NullLogger<TagCacheController>.Instance,
                    Users,
                    new SeerrCache(configProvider),
                    configProvider,
                    Cache,
                    Library,
                    UserData,
                    resolver,
                    _userConfig,
                    _projection);
                Controller.ControllerContext = new ControllerContext
                {
                    HttpContext = new DefaultHttpContext
                    {
                        User = new ClaimsPrincipal(new ClaimsIdentity(
                            new[] { new Claim("Jellyfin-UserId", User.Id.ToString()) },
                            "TestAuth")),
                    },
                };
                Controller.SeasonEpisodeEnumeratorForTest = (season, _) =>
                {
                    SeasonWalkCounts[season.Id] = SeasonWalkCounts.TryGetValue(season.Id, out var walks)
                        ? walks + 1
                        : 1;
                    OnSeasonWalk?.Invoke(season.Id);
                    if (ProbeFailureSeasons.Contains(season.Id))
                    {
                        throw new InvalidOperationException("season probe failure (test)");
                    }

                    return SeasonEpisodes.TryGetValue(season.Id, out var episodes)
                        ? episodes
                        : Array.Empty<BaseItem>();
                };
            }

            public User User { get; }

            public StubUserManager Users { get; }

            public TagCacheService Cache { get; }

            public CountingLibraryManager Library { get; }

            public TagCacheProjectionRevisionService Projection { get; }

            public StubUserDataManager UserData { get; }

            public TagCacheController Controller { get; }

            public Dictionary<Guid, BaseItem> LiveItems { get; } = new();

            public HashSet<Guid> PlayedIds { get; } = new();

            public Dictionary<Guid, List<BaseItem>> SeasonEpisodes { get; } = new();

            public HashSet<Guid> ProbeFailureSeasons { get; } = new();

            public Dictionary<Guid, int> SeasonWalkCounts { get; } = new();

            public List<Guid> GuardedMovieIds { get; } = new();

            public Action<Guid>? OnSeasonWalk { get; set; }

            public int TotalSeasonWalks => SeasonWalkCounts.Values.Sum();

            public string UserIdN => User.Id.ToString("N");

            public static UserSpoilerBlur StateWithSeries(Guid seriesId, IEnumerable<Guid>? movieIds = null)
            {
                var state = new UserSpoilerBlur();
                var seriesIdN = seriesId.ToString("N");
                state.Series[seriesIdN] = new SpoilerBlurSeriesEntry { SeriesId = seriesIdN };
                foreach (var movieId in movieIds ?? Array.Empty<Guid>())
                {
                    var movieIdN = movieId.ToString("N");
                    state.Movies[movieIdN] = new SpoilerBlurMovieEntry { MovieId = movieIdN };
                }

                return state;
            }

            public static TagCacheEntry EpisodeEntry(string? seriesIdN) => new()
            {
                Type = "Episode",
                SeriesId = seriesIdN,
                Genres = new[] { "Guarded-Genre" },
                CommunityRating = 8.5f,
                CriticRating = 91f,
                AudioLanguages = new[] { "eng" },
            };

            public static TagCacheEntry SeriesEntry() => new()
            {
                Type = "Series",
                Genres = new[] { "Series-Genre" },
                CommunityRating = 9.1f,
            };

            public static TagCacheEntry SeasonEntry(string seriesIdN, int seasonNumber) => new()
            {
                Type = "Season",
                SeriesId = seriesIdN,
                SeasonNumber = seasonNumber,
                Genres = new[] { "Season-Genre" },
                CommunityRating = 7.7f,
                CriticRating = 80f,
            };

            public string SeedGuardedEpisode(Guid seriesId, bool played)
            {
                var id = Guid.NewGuid();
                LiveItems[id] = new StubEpisode { Id = id, SeriesId = seriesId };
                if (played)
                {
                    PlayedIds.Add(id);
                }

                var key = id.ToString("N");
                Cache.SeedEntryForTest(key, EpisodeEntry(seriesId.ToString("N")));
                return key;
            }

            public string SeedGuardedMovie(bool played)
            {
                var key = SeedMovie(played);
                GuardedMovieIds.Add(Guid.ParseExact(key, "N"));
                return key;
            }

            public string SeedMovie(bool played)
            {
                var id = Guid.NewGuid();
                LiveItems[id] = new StubMovie { Id = id };
                if (played)
                {
                    PlayedIds.Add(id);
                }

                var key = id.ToString("N");
                Cache.SeedEntryForTest(key, new TagCacheEntry
                {
                    Type = "Movie",
                    Genres = new[] { "Movie-Genre" },
                    CommunityRating = 6.6f,
                });
                return key;
            }

            public string SeedGuardedSeason(
                Guid seriesId,
                int seasonNumber,
                int episodeCount,
                int watchedEpisodes = 0)
            {
                var id = Guid.NewGuid();
                LiveItems[id] = new StubSeason { Id = id, SeriesId = seriesId, IndexNumber = seasonNumber };
                var episodes = new List<BaseItem>(episodeCount);
                for (var i = 0; i < episodeCount; i++)
                {
                    var episodeId = Guid.NewGuid();
                    episodes.Add(new StubEpisode { Id = episodeId, SeriesId = seriesId, SeasonId = id });
                    if (i < watchedEpisodes)
                    {
                        PlayedIds.Add(episodeId);
                    }
                }

                SeasonEpisodes[id] = episodes;
                var key = id.ToString("N");
                Cache.SeedEntryForTest(key, SeasonEntry(seriesId.ToString("N"), seasonNumber));
                return key;
            }

            public Guid SeedCollection(params Guid[] movieIds)
            {
                var id = Guid.NewGuid();
                LiveItems[id] = new BoxSet
                {
                    Id = id,
                    LinkedChildren = movieIds
                        .Select(static movieId => new LinkedChild { ItemId = movieId })
                        .ToArray(),
                };
                return id;
            }

            public void SeedAccess(IEnumerable<string> keys)
                => Cache.SeedUserAccessCacheForTest(UserIdN, keys.ToArray());

            public void SaveSpoilerState(UserSpoilerBlur state)
            {
                _userConfig.SaveUserConfiguration(UserIdN, "spoilerblur.json", state);
                SpoilerUserResolver.InvalidateUser(UserIdN);
            }

            public void WriteCorruptSpoilerState()
            {
                var dir = Path.Combine(
                    _tempDir,
                    "configurations",
                    "Jellyfin.Plugin.JellyfinCanopy",
                    UserIdN.ToLowerInvariant());
                Directory.CreateDirectory(dir);
                File.WriteAllText(Path.Combine(dir, "spoilerblur.json"), "{not valid json!");
                SpoilerUserResolver.InvalidateUser(UserIdN);
            }

            /// <summary>
            /// The AC4 reference: the UNCHANGED pure decision fed by the ORIGINAL
            /// scalar delegate semantics (per-entry item lookup, per-item played
            /// probe, per-season episode walk with catch-all → unwatched), applied
            /// through the same StripCacheForUser/ApplyTagStrip pipeline. The
            /// optimized projection's served output must match this byte for byte.
            /// </summary>
            public Dictionary<string, TagCacheEntry> ComputeScalarReferenceOutput(UserSpoilerBlur state)
            {
                var accessible = new HashSet<string>(
                    ReadSeededAccess(),
                    StringComparer.Ordinal);
                var items = new Dictionary<string, TagCacheEntry>(StringComparer.Ordinal);
                foreach (var key in accessible)
                {
                    var entry = Cache.GetEntryForTest(key);
                    if (entry != null)
                    {
                        items[key] = entry;
                    }
                }

                bool IsPlayed(Guid id)
                    => LiveItems.TryGetValue(id, out var item) && PlayedIds.Contains(item.Id);

                int? SeasonIndexNumber(Guid id)
                    => LiveItems.TryGetValue(id, out var item) && item is Season season
                        ? season.IndexNumber
                        : null;

                bool SeasonAnyWatched(Guid id)
                {
                    if (!LiveItems.TryGetValue(id, out var item) || item is not Season season)
                    {
                        return false;
                    }

                    if (ProbeFailureSeasons.Contains(season.Id))
                    {
                        return false; // scalar probe fault → assume unwatched
                    }

                    return SeasonEpisodes.TryGetValue(season.Id, out var episodes)
                        && episodes.Any(episode => PlayedIds.Contains(episode.Id));
                }

                bool IsMovieInScope(Guid id)
                {
                    if (state.Movies.ContainsKey(id.ToString("N")))
                    {
                        return true;
                    }

                    foreach (var collectionKey in state.Collections.Keys)
                    {
                        if (Guid.TryParse(collectionKey, out var collectionId)
                            && LiveItems.TryGetValue(collectionId, out var collection)
                            && collection is BoxSet boxSet
                            && boxSet.LinkedChildren.Any(child => child.ItemId == id))
                        {
                            return true;
                        }
                    }

                    return false;
                }

                TagCacheService.StripCacheForUser(
                    items,
                    stripGenres: true,
                    stripRatings: true,
                    sanitizeTitleStreams: false,
                    resolve: (key, entry) => TagCacheService.ResolveTagStripDecision(
                        key,
                        entry,
                        state,
                        IsMovieInScope,
                        IsPlayed,
                        SeasonIndexNumber,
                        SeasonAnyWatched,
                        onKeyNotGuid: static _ => { }));
                return items;
            }

            private IEnumerable<string> ReadSeededAccess()
                => Cache.GetCacheForUser(User).Keys;

            public void Dispose()
            {
                SpoilerUserResolver.InvalidateUser(UserIdN);
                _projection.Dispose();
                Cache.Dispose();
                try
                {
                    Directory.Delete(_tempDir, recursive: true);
                }
                catch
                {
                    // Best-effort test cleanup.
                }
            }

            public static JsonElement Payload(IActionResult result)
            {
                var ok = Assert.IsType<OkObjectResult>(result);
                using var json = JsonDocument.Parse(JsonSerializer.Serialize(ok.Value));
                return json.RootElement.Clone();
            }
        }
    }
}
