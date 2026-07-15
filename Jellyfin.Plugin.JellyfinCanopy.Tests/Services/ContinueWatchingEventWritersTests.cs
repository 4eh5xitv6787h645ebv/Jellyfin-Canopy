using System.Diagnostics;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.EventHandlers;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using Xunit.Abstractions;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services
{
    /// <summary>
    /// Covers the two Continue-Watching event writers: the resume consumer must invalidate the
    /// hidden-content response-filter cache after it drops an entry (otherwise the just-resumed item
    /// stays hidden for up to the 30s cache TTL), and the library-removal hook must coalesce a bulk
    /// delete into one prune per user for the whole batch (not one prune per removed item × per user).
    /// </summary>
    public sealed class ContinueWatchingEventWritersTests
    {
        private readonly ITestOutputHelper _output;

        public ContinueWatchingEventWritersTests(ITestOutputHelper output)
        {
            _output = output;
        }

        private sealed class CollectingLogger<T> : ILogger<T>
        {
            public List<string> Messages { get; } = new();

            public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

            public bool IsEnabled(LogLevel logLevel) => true;

            public void Log<TState>(
                LogLevel logLevel,
                EventId eventId,
                TState state,
                Exception? exception,
                Func<TState, Exception?, string> formatter)
                => Messages.Add(formatter(state, exception));
        }

        [Fact]
        public async Task Consumer_OnResume_InvalidatesHcFilterCache()
        {
            var tempDir = Path.Combine(Path.GetTempPath(), "jc-cw-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempDir);
            try
            {
                var ucm = new UserConfigurationManager(new StubAppPaths(tempDir), NullLogger<UserConfigurationManager>.Instance);

                var userId = Guid.NewGuid();
                var userIdN = userId.ToString("N");
                var itemId = Guid.NewGuid();

                // Seed a continuewatching-scope hidden entry for this item, so the resume drops it.
                var seed = new UserHiddenContent();
                seed.Items["k1"] = new HiddenContentItem { ItemId = itemId.ToString(), HideScope = "continuewatching" };
                ucm.SaveUserConfiguration(userIdN, "hidden-content.json", seed);

                // Seed the response-filter cache; a successful drop must invalidate it.
                HiddenContentResponseFilter.SeedCacheForTest(userIdN);
                Assert.True(HiddenContentResponseFilter.IsCachedForTest(userIdN));

                var provider = new FakePluginConfigProvider(new PluginConfiguration { RemoveContinueWatchingEnabled = true });
                var consumer = new ContinueWatchingPlaybackConsumer(ucm, NullLogger<ContinueWatchingPlaybackConsumer>.Instance, provider);

                var args = new PlaybackStartEventArgs
                {
                    Item = new Movie { Id = itemId },
                    Session = new SessionInfo(null!, NullLogger.Instance) { UserId = userId },
                };

                await consumer.OnEvent(args);

                // The write happened (entry dropped) → the cache for this user must be gone.
                Assert.False(HiddenContentResponseFilter.IsCachedForTest(userIdN));
            }
            finally
            {
                try { Directory.Delete(tempDir, recursive: true); } catch { /* best-effort cleanup */ }
            }
        }

        [Fact]
        public async Task Consumer_QuarantinedStore_SkipsRepeatedPlaybackWithoutLogging()
        {
            var tempDir = Path.Combine(Path.GetTempPath(), "jc-cw-quarantine-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempDir);
            try
            {
                var ucm = new UserConfigurationManager(new StubAppPaths(tempDir), NullLogger<UserConfigurationManager>.Instance);
                var userId = Guid.NewGuid();
                var userDir = Path.Combine(
                    tempDir,
                    "configurations",
                    "Jellyfin.Plugin.JellyfinCanopy",
                    userId.ToString("N"));
                Directory.CreateDirectory(userDir);
                File.WriteAllText(Path.Combine(userDir, "hidden-content.json"), "{{{ corrupt");
                Assert.Throws<UserStoreUnhealthyException>(() =>
                    ucm.GetUserConfigurationStrict<UserHiddenContent>(userId.ToString("N"), "hidden-content.json"));

                var logger = new CollectingLogger<ContinueWatchingPlaybackConsumer>();
                var provider = new FakePluginConfigProvider(new PluginConfiguration { RemoveContinueWatchingEnabled = true });
                var consumer = new ContinueWatchingPlaybackConsumer(ucm, logger, provider);
                var args = new PlaybackStartEventArgs
                {
                    Item = new Movie { Id = Guid.NewGuid() },
                    Session = new SessionInfo(null!, NullLogger.Instance) { UserId = userId }
                };

                await consumer.OnEvent(args);
                await consumer.OnEvent(args);

                Assert.Empty(logger.Messages);
            }
            finally
            {
                try { Directory.Delete(tempDir, recursive: true); } catch { }
            }
        }

        [Fact]
        public void LibraryHook_BulkRemoval_DrainsOncePerUser()
        {
            // A burst of five removed items across two users must prune each user exactly once,
            // handing the whole id batch to that single prune — not five prunes per user.
            var removedIds = Enumerable.Range(0, 5).Select(_ => Guid.NewGuid().ToString()).ToArray();
            var users = new[] { Guid.NewGuid(), Guid.NewGuid() };

            var callsPerUser = new Dictionary<Guid, int>();
            var batchSizesSeen = new List<int>();
            var indexesSeen = new List<CwRemovedIdIndex>();

            var prunedUsers = ContinueWatchingLibraryHook.DrainBatch(
                removedIds,
                users,
                (userId, index) =>
                {
                    callsPerUser[userId] = callsPerUser.GetValueOrDefault(userId) + 1;
                    batchSizesSeen.Add(index.Count);
                    indexesSeen.Add(index);
                });

            Assert.Equal(2, prunedUsers);
            Assert.Equal(1, callsPerUser[users[0]]);
            Assert.Equal(1, callsPerUser[users[1]]);
            // Every prune received the whole batch of 5 ids (coalesced), never a single id at a time.
            Assert.All(batchSizesSeen, size => Assert.Equal(5, size));
            Assert.Same(indexesSeen[0], indexesSeen[1]);
            Assert.Equal(5, indexesSeen[0].RemovedIdentifierNormalizations);
            Assert.Equal(5, indexesSeen[0].RemovedGuidParseAttempts);
        }

        [Fact]
        public void LibraryHook_MixedGuidFormsAndOpaqueIds_MatchExactly()
        {
            var first = Guid.Parse("1f78f651-67a8-4fb4-b24f-6e4b81bc1234");
            var second = Guid.Parse("2a89e762-78b9-40c5-a350-7f5c92cd5678");
            var other = Guid.Parse("3b90f873-89ca-41d6-b461-806da3de9012");
            var removedIds = new[]
            {
                first.ToString("D").ToUpperInvariant(),
                first.ToString("N").ToLowerInvariant(),
                second.ToString("N").ToLowerInvariant(),
                "Opaque-Item"
            };
            var hidden = new UserHiddenContent();
            hidden.Items["first-n-lower"] = new HiddenContentItem { ItemId = first.ToString("N").ToLowerInvariant() };
            hidden.Items["second-d-upper"] = new HiddenContentItem { ItemId = second.ToString("D").ToUpperInvariant() };
            hidden.Items["opaque-case"] = new HiddenContentItem { ItemId = "opaque-item" };
            hidden.Items["keep-guid"] = new HiddenContentItem { ItemId = other.ToString("N") };
            hidden.Items["keep-opaque"] = new HiddenContentItem { ItemId = "opaque-item-extra" };

            var index = CwRemovedIdIndex.Create(removedIds);
            var removed = ContinueWatchingLibraryHook.PruneOrphansCore(hidden, index);

            Assert.Equal(3, removed);
            Assert.Equal(new[] { "keep-guid", "keep-opaque" }, hidden.Items.Keys.OrderBy(key => key));
            Assert.Equal(3, index.Count);
            Assert.Equal(4, index.RemovedIdentifierNormalizations);
            Assert.Equal(4, index.RemovedGuidParseAttempts);
            Assert.Equal(5, index.EntryIdentifierNormalizations);
            Assert.Equal(5, index.EntryGuidParseAttempts);
            Assert.Equal(5, index.MembershipComparisons);
        }

        [Fact]
        public void LibraryHook_FifteenThousandByFifteenThousand_StaysWithinLinearBudgets()
        {
            const int scale = 15_000;
            const long allocationBudget = 8L * 1024 * 1024;
            var timeBudget = TimeSpan.FromSeconds(5);
            var removedIds = new string[scale];
            var hidden = new UserHiddenContent();
            for (var index = 0; index < scale; index++)
            {
                var removedId = DeterministicGuid(index, family: 0x11);
                removedIds[index] = index % 2 == 0
                    ? removedId.ToString("D").ToUpperInvariant()
                    : removedId.ToString("N").ToLowerInvariant();

                hidden.Items[$"hidden-{index}"] = new HiddenContentItem
                {
                    ItemId = index % 2 == 0
                        ? removedId.ToString("N").ToLowerInvariant()
                        : removedId.ToString("D").ToUpperInvariant()
                };
            }

            var allocatedBefore = GC.GetAllocatedBytesForCurrentThread();
            var stopwatch = Stopwatch.StartNew();
            var targetIds = CwRemovedIdIndex.Create(removedIds);
            var removed = ContinueWatchingLibraryHook.PruneOrphansCore(hidden, targetIds);
            stopwatch.Stop();
            var allocated = GC.GetAllocatedBytesForCurrentThread() - allocatedBefore;

            _output.WriteLine(
                "removedIds={0} hiddenEntries={1} removedNormalizations={2} entryNormalizations={3} "
                + "membershipComparisons={4} elapsedMs={5:F3} allocatedBytes={6}",
                scale,
                scale,
                targetIds.RemovedIdentifierNormalizations,
                targetIds.EntryIdentifierNormalizations,
                targetIds.MembershipComparisons,
                stopwatch.Elapsed.TotalMilliseconds,
                allocated);

            Assert.Equal(scale, removed);
            Assert.Empty(hidden.Items);
            Assert.Equal(scale, targetIds.Count);
            Assert.Equal(scale, targetIds.RemovedIdentifierNormalizations);
            Assert.Equal(scale, targetIds.RemovedGuidParseAttempts);
            Assert.Equal(scale, targetIds.EntryIdentifierNormalizations);
            Assert.Equal(scale, targetIds.EntryGuidParseAttempts);
            Assert.Equal(scale, targetIds.MembershipComparisons);
            Assert.True(
                stopwatch.Elapsed < timeBudget,
                $"15k x 15k cleanup took {stopwatch.Elapsed}; budget is {timeBudget}.");
            Assert.True(
                allocated < allocationBudget,
                $"15k x 15k cleanup allocated {allocated} bytes; budget is {allocationBudget} bytes.");
        }

        [Fact]
        public void LibraryHook_EmptyBatch_PrunesNoUser()
        {
            var pruned = ContinueWatchingLibraryHook.DrainBatch(
                Array.Empty<string>(),
                new[] { Guid.NewGuid() },
                (_, _) => Assert.Fail("prune must not run for an empty batch"));

            Assert.Equal(0, pruned);
        }

        [Fact]
        public void LibraryHook_Drain_RearmsTimer_WhenRemovalArrivesMidDrain()
        {
            var tempDir = Path.Combine(Path.GetTempPath(), "jc-cw-drain-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempDir);
            try
            {
                var ucm = new UserConfigurationManager(new StubAppPaths(tempDir), NullLogger<UserConfigurationManager>.Instance);
                using var hook = new ContinueWatchingLibraryHook(
                    new CountingLibraryManager(),
                    ucm,
                    new StubUserManager(),   // no users -> DrainBatch is a no-op; we only test the re-arm
                    NullLogger<ContinueWatchingLibraryHook>.Instance);

                // Item A gives the drain work to snapshot.
                hook.EnqueueRemovalForTest(Guid.NewGuid());

                // Simulate a removal arriving mid-drain (a concurrent ItemRemoved, or a second timer
                // tick that bailed on the _draining guard): it lands AFTER this drain snapshotted its
                // ids, so it is NOT processed by this drain.
                var b = Guid.NewGuid();
                hook.OnDrainProcessingForTest = () =>
                {
                    hook.OnDrainProcessingForTest = null;
                    hook.EnqueueRemovalForTest(b);
                };

                hook.DrainForTest();

                // The drain's finally must re-arm because work (B) still remains — otherwise B sits in
                // _pendingRemovals with no tick to process it until the next unrelated ItemRemoved.
                // RED against the old finally that only reset _draining.
                Assert.Equal(1, hook.DrainRearmCountForTest);
                Assert.False(hook.PendingIsEmptyForTest);
            }
            finally
            {
                try { Directory.Delete(tempDir, recursive: true); } catch { /* best-effort */ }
            }
        }

        private static Guid DeterministicGuid(int value, byte family)
            => new(value, family, 0, family, 0, 0, 0, 0, 0, 0, 1);
    }
}
