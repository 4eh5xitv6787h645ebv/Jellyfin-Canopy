using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.EventHandlers;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

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
        public void LibraryHook_BulkRemoval_DrainsOncePerUser()
        {
            // A burst of five removed items across two users must prune each user exactly once,
            // handing the whole id batch to that single prune — not five prunes per user.
            var removedIds = Enumerable.Range(0, 5).Select(_ => Guid.NewGuid().ToString()).ToArray();
            var users = new[] { Guid.NewGuid(), Guid.NewGuid() };

            var callsPerUser = new Dictionary<Guid, int>();
            var batchSizesSeen = new List<int>();

            var prunedUsers = ContinueWatchingLibraryHook.DrainBatch(
                removedIds,
                users,
                (userId, ids) =>
                {
                    callsPerUser[userId] = callsPerUser.GetValueOrDefault(userId) + 1;
                    batchSizesSeen.Add(ids.Count);
                });

            Assert.Equal(2, prunedUsers);
            Assert.Equal(1, callsPerUser[users[0]]);
            Assert.Equal(1, callsPerUser[users[1]]);
            // Every prune received the whole batch of 5 ids (coalesced), never a single id at a time.
            Assert.All(batchSizesSeen, size => Assert.Equal(5, size));
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
    }
}
