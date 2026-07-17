using System.Diagnostics;
using Jellyfin.Database.Implementations.Entities;
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
        public async Task LibraryHook_Lifecycle_IsIdempotentAndTerminal()
        {
            var tempDir = Path.Combine(Path.GetTempPath(), "jc-cw-lifecycle-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempDir);
            try
            {
                var ucm = new UserConfigurationManager(new StubAppPaths(tempDir), NullLogger<UserConfigurationManager>.Instance);
                var library = new CountingLibraryManager();
                var hook = new ContinueWatchingLibraryHook(
                    library,
                    ucm,
                    new StubUserManager(),
                    NullLogger<ContinueWatchingLibraryHook>.Instance);

                await hook.StartAsync(CancellationToken.None);
                await hook.StartAsync(CancellationToken.None);
                Assert.Equal(1, library.ItemRemovedCount);

                await hook.StopAsync(CancellationToken.None);
                await hook.StopAsync(CancellationToken.None);
                Assert.Equal(0, library.ItemRemovedCount);

                await hook.StartAsync(CancellationToken.None);
                Assert.Equal(0, library.ItemRemovedCount);

                hook.Dispose();
                hook.Dispose();
            }
            finally
            {
                try { Directory.Delete(tempDir, recursive: true); } catch { /* best-effort */ }
            }
        }

        [Fact]
        public async Task LibraryHook_StopWaitsForActiveDrainAndProcessesRemovalAcceptedAfterSnapshot()
        {
            var tempDir = Path.Combine(Path.GetTempPath(), "jc-cw-stop-drain-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempDir);
            using var enteredDrain = new ManualResetEventSlim();
            using var releaseDrain = new ManualResetEventSlim();
            try
            {
                var ucm = new UserConfigurationManager(
                    new StubAppPaths(tempDir),
                    NullLogger<UserConfigurationManager>.Instance);
                var user = new User("cw-worker", "provider", "password-provider");
                var batches = 0;
                using var hook = new ContinueWatchingLibraryHook(
                    new CountingLibraryManager(),
                    ucm,
                    new StubUserManager(user),
                    NullLogger<ContinueWatchingLibraryHook>.Instance,
                    pendingRemovalCapacity: 32,
                    drainDebounce: TimeSpan.Zero,
                    drainRetryDelay: TimeSpan.Zero,
                    pruneUserForTest: (_, index) =>
                    {
                        Assert.Equal(1, index.Count);
                        Interlocked.Increment(ref batches);

                        if (!enteredDrain.IsSet)
                        {
                            enteredDrain.Set();
                            releaseDrain.Wait();
                        }

                        return true;
                    });

                await hook.StartAsync(CancellationToken.None);
                var first = Guid.NewGuid();
                var second = Guid.NewGuid();
                Assert.True(hook.EnqueueRemovalForTest(first));
                Assert.True(enteredDrain.Wait(TimeSpan.FromSeconds(10)));

                // B is accepted after A left the pending snapshot. Stop must join
                // the active drain and keep ownership until B is processed too.
                Assert.True(hook.EnqueueRemovalForTest(second));
                var stop = hook.StopAsync(CancellationToken.None);
                var stopWaitedForActiveDrain = !stop.IsCompleted;

                releaseDrain.Set();
                await stop;

                Assert.True(stopWaitedForActiveDrain);
                Assert.True(hook.PendingIsEmptyForTest);
                Assert.False(hook.EnqueueRemovalForTest(Guid.NewGuid()));
                Assert.Equal(2, batches);
            }
            finally
            {
                releaseDrain.Set();
                try { Directory.Delete(tempDir, recursive: true); } catch { /* best-effort */ }
            }
        }

        [Fact]
        public async Task LibraryHook_AlreadyDispatchedHandlerCannotAcceptAfterStopClosesIntake()
        {
            var tempDir = Path.Combine(Path.GetTempPath(), "jc-cw-dispatched-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempDir);
            using var handlerEntered = new ManualResetEventSlim();
            using var releaseHandler = new ManualResetEventSlim();
            try
            {
                var library = new CountingLibraryManager();
                var hook = new ContinueWatchingLibraryHook(
                    library,
                    new UserConfigurationManager(new StubAppPaths(tempDir), NullLogger<UserConfigurationManager>.Instance),
                    new StubUserManager(),
                    NullLogger<ContinueWatchingLibraryHook>.Instance);
                await hook.StartAsync(CancellationToken.None);
                hook.OnBeforeRemovalAcceptanceForTest = () =>
                {
                    handlerEntered.Set();
                    releaseHandler.Wait();
                };

                var dispatched = Task.Run(() => library.RaiseItemRemoved(new Movie { Id = Guid.NewGuid() }));
                Assert.True(handlerEntered.Wait(TimeSpan.FromSeconds(10)));

                await hook.StopAsync(CancellationToken.None);
                releaseHandler.Set();
                await dispatched;

                Assert.True(hook.PendingIsEmptyForTest);
                hook.Dispose();
            }
            finally
            {
                releaseHandler.Set();
                try { Directory.Delete(tempDir, recursive: true); } catch { }
            }
        }

        [Fact]
        public async Task LibraryHook_CanceledStopIsObservableAndLaterStopJoinsWorker()
        {
            var tempDir = Path.Combine(Path.GetTempPath(), "jc-cw-cancel-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempDir);
            using var writeEntered = new ManualResetEventSlim();
            using var releaseWrite = new ManualResetEventSlim();
            try
            {
                var logger = new CollectingLogger<ContinueWatchingLibraryHook>();
                var user = new User("cw-cancel", "provider", "password-provider");
                using var hook = new ContinueWatchingLibraryHook(
                    new CountingLibraryManager(),
                    new UserConfigurationManager(new StubAppPaths(tempDir), NullLogger<UserConfigurationManager>.Instance),
                    new StubUserManager(user),
                    logger,
                    pendingRemovalCapacity: 32,
                    drainDebounce: TimeSpan.Zero,
                    drainRetryDelay: TimeSpan.Zero,
                    pruneUserForTest: (_, _) =>
                    {
                        writeEntered.Set();
                        releaseWrite.Wait();
                        return true;
                    });

                await hook.StartAsync(CancellationToken.None);
                Assert.True(hook.EnqueueRemovalForTest(Guid.NewGuid()));
                Assert.True(writeEntered.Wait(TimeSpan.FromSeconds(10)));

                using var canceled = new CancellationTokenSource();
                canceled.Cancel();
                await Assert.ThrowsAnyAsync<OperationCanceledException>(() => hook.StopAsync(canceled.Token));
                Assert.Contains(logger.Messages, message => message.Contains("shutdown canceled", StringComparison.Ordinal));

                releaseWrite.Set();
                await hook.StopAsync(CancellationToken.None);
                Assert.True(hook.PendingIsEmptyForTest);
            }
            finally
            {
                releaseWrite.Set();
                try { Directory.Delete(tempDir, recursive: true); } catch { }
            }
        }

        [Fact]
        public async Task LibraryHook_DisposeAfterCanceledStopReportsTerminalUndrainedWork()
        {
            var tempDir = Path.Combine(Path.GetTempPath(), "jc-cw-terminal-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempDir);
            using var pruneAttempted = new ManualResetEventSlim();
            try
            {
                var logger = new CollectingLogger<ContinueWatchingLibraryHook>();
                var user = new User("cw-terminal", "provider", "password-provider");
                var hook = new ContinueWatchingLibraryHook(
                    new CountingLibraryManager(),
                    new UserConfigurationManager(new StubAppPaths(tempDir), NullLogger<UserConfigurationManager>.Instance),
                    new StubUserManager(user),
                    logger,
                    pendingRemovalCapacity: 32,
                    drainDebounce: TimeSpan.Zero,
                    drainRetryDelay: TimeSpan.FromHours(1),
                    pruneUserForTest: (_, _) =>
                    {
                        pruneAttempted.Set();
                        return false;
                    });

                await hook.StartAsync(CancellationToken.None);
                Assert.True(hook.EnqueueRemovalForTest(Guid.NewGuid()));
                Assert.True(pruneAttempted.Wait(TimeSpan.FromSeconds(10)));

                using var canceled = new CancellationTokenSource();
                canceled.Cancel();
                await Assert.ThrowsAnyAsync<OperationCanceledException>(() => hook.StopAsync(canceled.Token));

                hook.Dispose();

                Assert.False(hook.PendingIsEmptyForTest);
                Assert.Contains(
                    logger.Messages,
                    message => message.Contains("TERMINAL shutdown failure", StringComparison.Ordinal)
                        && message.Contains("undrained", StringComparison.Ordinal));

                // All terminal lifecycle combinations remain idempotent after the failure report.
                hook.Dispose();
                var terminal = await Assert.ThrowsAsync<InvalidOperationException>(
                    () => hook.StopAsync(CancellationToken.None));
                Assert.Contains("TERMINAL shutdown failure", terminal.Message, StringComparison.Ordinal);
            }
            finally
            {
                try { Directory.Delete(tempDir, recursive: true); } catch { }
            }
        }

        [Fact]
        public async Task LibraryHook_TransientPruneFailureRetainsBatchForRetry()
        {
            var tempDir = Path.Combine(Path.GetTempPath(), "jc-cw-retry-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempDir);
            try
            {
                var attempts = 0;
                var user = new User("cw-retry", "provider", "password-provider");
                using var hook = new ContinueWatchingLibraryHook(
                    new CountingLibraryManager(),
                    new UserConfigurationManager(new StubAppPaths(tempDir), NullLogger<UserConfigurationManager>.Instance),
                    new StubUserManager(user),
                    NullLogger<ContinueWatchingLibraryHook>.Instance,
                    pendingRemovalCapacity: 32,
                    drainDebounce: TimeSpan.Zero,
                    drainRetryDelay: TimeSpan.Zero,
                    pruneUserForTest: (_, _) => Interlocked.Increment(ref attempts) >= 2);

                await hook.StartAsync(CancellationToken.None);
                Assert.True(hook.EnqueueRemovalForTest(Guid.NewGuid()));
                await hook.StopAsync(CancellationToken.None);

                Assert.Equal(2, attempts);
                Assert.True(hook.PendingIsEmptyForTest);
            }
            finally
            {
                try { Directory.Delete(tempDir, recursive: true); } catch { }
            }
        }

        [Fact]
        public async Task LibraryHook_CapacityOverflowRejectsNewIdentityWithoutDiscardingAcceptedIds()
        {
            var tempDir = Path.Combine(Path.GetTempPath(), "jc-cw-overflow-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempDir);
            try
            {
                var acceptedBatchSize = 0;
                var logger = new CollectingLogger<ContinueWatchingLibraryHook>();
                var user = new User("cw-overflow", "provider", "password-provider");
                using var hook = new ContinueWatchingLibraryHook(
                    new CountingLibraryManager(),
                    new UserConfigurationManager(new StubAppPaths(tempDir), NullLogger<UserConfigurationManager>.Instance),
                    new StubUserManager(user),
                    logger,
                    pendingRemovalCapacity: 2,
                    drainDebounce: TimeSpan.FromHours(1),
                    drainRetryDelay: TimeSpan.Zero,
                    pruneUserForTest: (_, index) =>
                    {
                        acceptedBatchSize = index.Count;
                        return true;
                    });

                await hook.StartAsync(CancellationToken.None);
                Assert.True(hook.EnqueueRemovalForTest(Guid.NewGuid()));
                Assert.True(hook.EnqueueRemovalForTest(Guid.NewGuid()));
                Assert.False(hook.EnqueueRemovalForTest(Guid.NewGuid()));
                Assert.Equal(1, hook.RejectedRemovalCountForTest);

                await hook.StopAsync(CancellationToken.None);

                Assert.Equal(2, acceptedBatchSize);
                Assert.True(hook.PendingIsEmptyForTest);
                Assert.Contains(
                    logger.Messages,
                    message => message.Contains("rejected 1 distinct removal", StringComparison.Ordinal));
            }
            finally
            {
                try { Directory.Delete(tempDir, recursive: true); } catch { }
            }
        }

        [Fact]
        public async Task LibraryHook_ImmediateDisposeDuringDebounceReportsRejectedOverflowExactlyOnce()
        {
            var tempDir = Path.Combine(Path.GetTempPath(), "jc-cw-overflow-dispose-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempDir);
            using var debounceEntered = new ManualResetEventSlim();
            using var releaseDebounce = new ManualResetEventSlim();
            using var abortRequested = new ManualResetEventSlim();
            try
            {
                var logger = new CollectingLogger<ContinueWatchingLibraryHook>();
                var scanChecks = 0;
                var itemLookups = 0;
                var library = new CountingLibraryManager
                {
                    IsScanRunningHook = () =>
                    {
                        Interlocked.Increment(ref scanChecks);
                        return true;
                    },
                    GetItemByIdNonGenericHook = _ =>
                    {
                        Interlocked.Increment(ref itemLookups);
                        return null;
                    }
                };
                var user = new User("cw-overflow-dispose", "provider", "password-provider");
                var hook = new ContinueWatchingLibraryHook(
                    library,
                    new UserConfigurationManager(new StubAppPaths(tempDir), NullLogger<UserConfigurationManager>.Instance),
                    new StubUserManager(user),
                    logger,
                    pendingRemovalCapacity: 1,
                    drainDebounce: TimeSpan.FromHours(1),
                    drainRetryDelay: TimeSpan.Zero,
                    pruneUserForTest: (_, _) =>
                        throw new Xunit.Sdk.XunitException("Dispose must abort before any config prune"));
                hook.OnDrainDebounceStartedForTest = () =>
                {
                    debounceEntered.Set();
                    releaseDebounce.Wait();
                };
                hook.OnDisposeWaitingForTest = abortRequested.Set;

                await hook.StartAsync(CancellationToken.None);
                Assert.True(hook.EnqueueRemovalForTest(Guid.NewGuid()));
                Assert.True(debounceEntered.Wait(TimeSpan.FromSeconds(10)));
                Assert.False(hook.EnqueueRemovalForTest(Guid.NewGuid()));

                var dispose = Task.Run(hook.Dispose);
                Assert.True(abortRequested.Wait(TimeSpan.FromSeconds(10)));
                releaseDebounce.Set();
                await dispose;

                Assert.Equal(1, hook.RejectedRemovalCountForTest);
                Assert.Single(
                    logger.Messages,
                    message => message.Contains("bounded orphan-cleanup intake rejected 1 distinct removal", StringComparison.Ordinal));
                Assert.Equal(0, Volatile.Read(ref scanChecks));
                Assert.Equal(0, Volatile.Read(ref itemLookups));
                Assert.True(hook.WorkerIsCompletedForTest);
            }
            finally
            {
                releaseDebounce.Set();
                try { Directory.Delete(tempDir, recursive: true); } catch { }
            }
        }

        [Theory]
        [InlineData(false)]
        [InlineData(true)]
        public async Task LibraryHook_OverflowNeverUsesTransientGlobalNullToPruneUnrelatedGuid(bool scanRunning)
        {
            var tempDir = Path.Combine(Path.GetTempPath(), "jc-cw-overflow-null-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempDir);
            try
            {
                var firstRemoved = Guid.NewGuid();
                var secondRemoved = Guid.NewGuid();
                var rejectedRemoved = Guid.NewGuid();
                var unrelated = Guid.NewGuid();
                var scanChecks = 0;
                var itemLookups = 0;
                var library = new CountingLibraryManager
                {
                    // Even with no scan reported and every global lookup transiently null, exact-id
                    // cleanup must never consult this broad negative source.
                    IsScanRunningHook = () =>
                    {
                        Interlocked.Increment(ref scanChecks);
                        return scanRunning;
                    },
                    GetItemByIdNonGenericHook = _ =>
                    {
                        Interlocked.Increment(ref itemLookups);
                        return null;
                    }
                };
                var user = new User("cw-overflow-scan", "provider", "password-provider");
                var userId = user.Id.ToString("N");
                var ucm = new UserConfigurationManager(
                    new StubAppPaths(tempDir),
                    NullLogger<UserConfigurationManager>.Instance);
                var seed = new UserHiddenContent();
                seed.Items["removed-1"] = new HiddenContentItem { ItemId = firstRemoved.ToString("N") };
                seed.Items["removed-2"] = new HiddenContentItem { ItemId = secondRemoved.ToString("N") };
                seed.Items["unrelated"] = new HiddenContentItem { ItemId = unrelated.ToString("N") };
                ucm.SaveUserConfiguration(userId, "hidden-content.json", seed);

                using var hook = new ContinueWatchingLibraryHook(
                    library,
                    ucm,
                    new StubUserManager(user),
                    NullLogger<ContinueWatchingLibraryHook>.Instance,
                    pendingRemovalCapacity: 2,
                    drainDebounce: TimeSpan.FromHours(1),
                    drainRetryDelay: TimeSpan.Zero,
                    pruneUserForTest: null);

                await hook.StartAsync(CancellationToken.None);
                Assert.True(hook.EnqueueRemovalForTest(firstRemoved));
                Assert.True(hook.EnqueueRemovalForTest(secondRemoved));
                Assert.False(hook.EnqueueRemovalForTest(rejectedRemoved));
                await hook.StopAsync(CancellationToken.None);

                var stored = ucm.GetUserConfigurationStrict<UserHiddenContent>(userId, "hidden-content.json");
                Assert.Equal(new[] { "unrelated" }, stored.Items.Keys);
                Assert.Equal(0, Volatile.Read(ref scanChecks));
                Assert.Equal(0, Volatile.Read(ref itemLookups));
                Assert.Equal(1, hook.RejectedRemovalCountForTest);
            }
            finally
            {
                try { Directory.Delete(tempDir, recursive: true); } catch { }
            }
        }

        [Fact]
        public async Task LibraryHook_ConcurrentDisposeCallersJoinSameWorkerCompletion()
        {
            var tempDir = Path.Combine(Path.GetTempPath(), "jc-cw-dispose-join-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempDir);
            using var writeEntered = new ManualResetEventSlim();
            using var releaseWrite = new ManualResetEventSlim();
            using var bothDisposeCallersWaiting = new ManualResetEventSlim();
            try
            {
                var disposeWaiters = 0;
                var user = new User("cw-dispose-join", "provider", "password-provider");
                var hook = new ContinueWatchingLibraryHook(
                    new CountingLibraryManager(),
                    new UserConfigurationManager(new StubAppPaths(tempDir), NullLogger<UserConfigurationManager>.Instance),
                    new StubUserManager(user),
                    NullLogger<ContinueWatchingLibraryHook>.Instance,
                    pendingRemovalCapacity: 32,
                    drainDebounce: TimeSpan.Zero,
                    drainRetryDelay: TimeSpan.Zero,
                    pruneUserForTest: (_, _) =>
                    {
                        writeEntered.Set();
                        releaseWrite.Wait();
                        return true;
                    });
                hook.OnDisposeWaitingForTest = () =>
                {
                    if (Interlocked.Increment(ref disposeWaiters) == 2)
                    {
                        bothDisposeCallersWaiting.Set();
                    }
                };

                await hook.StartAsync(CancellationToken.None);
                Assert.True(hook.EnqueueRemovalForTest(Guid.NewGuid()));
                Assert.True(writeEntered.Wait(TimeSpan.FromSeconds(10)));

                var firstDispose = Task.Run(hook.Dispose);
                var secondDispose = Task.Run(hook.Dispose);
                Assert.True(bothDisposeCallersWaiting.Wait(TimeSpan.FromSeconds(10)));
                Assert.False(firstDispose.IsCompleted);
                Assert.False(secondDispose.IsCompleted);

                releaseWrite.Set();
                await Task.WhenAll(firstDispose, secondDispose);

                Assert.True(hook.WorkerIsCompletedForTest);
                hook.Dispose();
            }
            finally
            {
                releaseWrite.Set();
                try { Directory.Delete(tempDir, recursive: true); } catch { }
            }
        }

        [Fact]
        public async Task LibraryHook_DisposeRacingStopCannotTurnUndrainedAbortIntoSuccessfulStop()
        {
            var tempDir = Path.Combine(Path.GetTempPath(), "jc-cw-stop-dispose-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempDir);
            using var pruneEntered = new ManualResetEventSlim();
            using var releasePrune = new ManualResetEventSlim();
            using var disposeWaiting = new ManualResetEventSlim();
            try
            {
                var logger = new CollectingLogger<ContinueWatchingLibraryHook>();
                var user = new User("cw-stop-dispose", "provider", "password-provider");
                var hook = new ContinueWatchingLibraryHook(
                    new CountingLibraryManager(),
                    new UserConfigurationManager(new StubAppPaths(tempDir), NullLogger<UserConfigurationManager>.Instance),
                    new StubUserManager(user),
                    logger,
                    pendingRemovalCapacity: 32,
                    drainDebounce: TimeSpan.Zero,
                    drainRetryDelay: TimeSpan.FromHours(1),
                    pruneUserForTest: (_, _) =>
                    {
                        pruneEntered.Set();
                        releasePrune.Wait();
                        return false;
                    });
                hook.OnDisposeWaitingForTest = disposeWaiting.Set;

                await hook.StartAsync(CancellationToken.None);
                Assert.True(hook.EnqueueRemovalForTest(Guid.NewGuid()));
                Assert.True(pruneEntered.Wait(TimeSpan.FromSeconds(10)));

                var stop = hook.StopAsync(CancellationToken.None);
                var dispose = Task.Run(hook.Dispose);
                Assert.True(disposeWaiting.Wait(TimeSpan.FromSeconds(10)));
                releasePrune.Set();

                await dispose;
                var terminal = await Assert.ThrowsAsync<InvalidOperationException>(async () => await stop);
                Assert.Contains("TERMINAL shutdown failure", terminal.Message, StringComparison.Ordinal);
                Assert.Contains(logger.Messages, message => message.Contains("undrained", StringComparison.Ordinal));
                Assert.True(hook.WorkerIsCompletedForTest);
            }
            finally
            {
                releasePrune.Set();
                try { Directory.Delete(tempDir, recursive: true); } catch { }
            }
        }

        [Fact]
        public async Task LibraryHook_BurstCoalescesDuplicatesIntoOneWritePerUser()
        {
            var tempDir = Path.Combine(Path.GetTempPath(), "jc-cw-burst-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempDir);
            try
            {
                var firstUser = new User("cw-burst-1", "provider", "password-provider");
                var secondUser = new User("cw-burst-2", "provider", "password-provider");
                var calls = new Dictionary<Guid, int>();
                var removed = Enumerable.Range(0, 5).Select(_ => Guid.NewGuid()).ToArray();
                using var hook = new ContinueWatchingLibraryHook(
                    new CountingLibraryManager(),
                    new UserConfigurationManager(new StubAppPaths(tempDir), NullLogger<UserConfigurationManager>.Instance),
                    new StubUserManager(firstUser, secondUser),
                    NullLogger<ContinueWatchingLibraryHook>.Instance,
                    pendingRemovalCapacity: 32,
                    drainDebounce: TimeSpan.FromHours(1),
                    drainRetryDelay: TimeSpan.Zero,
                    pruneUserForTest: (userId, index) =>
                    {
                        calls[userId] = calls.GetValueOrDefault(userId) + 1;
                        Assert.Equal(removed.Length, index.Count);
                        return true;
                    });

                await hook.StartAsync(CancellationToken.None);
                foreach (var id in removed)
                {
                    Assert.True(hook.EnqueueRemovalForTest(id));
                    Assert.True(hook.EnqueueRemovalForTest(id));
                }

                await hook.StopAsync(CancellationToken.None);

                Assert.Equal(1, calls[firstUser.Id]);
                Assert.Equal(1, calls[secondUser.Id]);
            }
            finally
            {
                try { Directory.Delete(tempDir, recursive: true); } catch { }
            }
        }

        private static Guid DeterministicGuid(int value, byte family)
            => new(value, family, 0, family, 0, 0, 0, 0, 0, 0, 1);
    }
}
