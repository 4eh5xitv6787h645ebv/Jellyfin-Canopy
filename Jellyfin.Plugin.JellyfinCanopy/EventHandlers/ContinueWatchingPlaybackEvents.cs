using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Events;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Hosting;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.EventHandlers
{
    internal static class CwEventHelpers
    {
        public static bool IdMatches(string entryId, string targetId)
        {
            if (string.IsNullOrEmpty(entryId) || string.IsNullOrEmpty(targetId)) return false;
            if ((Guid.TryParse(entryId, out var a) || Guid.TryParseExact(entryId, "N", out a))
                && (Guid.TryParse(targetId, out var b) || Guid.TryParseExact(targetId, "N", out b)))
            {
                return a == b;
            }
            return string.Equals(entryId, targetId, StringComparison.OrdinalIgnoreCase);
        }
    }

    /// <summary>
    /// Drain-owned lookup index for removed item identifiers. Removed identifiers are normalized
    /// exactly once, before any user is visited; each hidden entry then performs one parse and one
    /// hash membership comparison instead of scanning and reparsing the whole removal batch.
    /// </summary>
    internal sealed class CwRemovedIdIndex
    {
        private readonly HashSet<Guid> _guidIds;
        private readonly HashSet<string> _stringIds;

        private CwRemovedIdIndex(
            HashSet<Guid> guidIds,
            HashSet<string> stringIds,
            int removedIdentifierNormalizations,
            int removedGuidParseAttempts)
        {
            _guidIds = guidIds;
            _stringIds = stringIds;
            RemovedIdentifierNormalizations = removedIdentifierNormalizations;
            RemovedGuidParseAttempts = removedGuidParseAttempts;
        }

        internal int Count => _guidIds.Count + _stringIds.Count;

        // Regression instrumentation: these counters make the linear ownership boundary exact in
        // tests without relying only on wall-clock timing.
        internal int RemovedIdentifierNormalizations { get; }

        internal int RemovedGuidParseAttempts { get; }

        internal long EntryIdentifierNormalizations { get; private set; }

        internal long EntryGuidParseAttempts { get; private set; }

        internal long MembershipComparisons { get; private set; }

        internal static CwRemovedIdIndex Create(IReadOnlyCollection<string> removedIds)
        {
            ArgumentNullException.ThrowIfNull(removedIds);

            var guidIds = new HashSet<Guid>(removedIds.Count);
            var stringIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var guidParseAttempts = 0;
            foreach (var removedId in removedIds)
            {
                if (string.IsNullOrEmpty(removedId)) continue;
                guidParseAttempts++;
                if (Guid.TryParse(removedId, out var guid))
                {
                    guidIds.Add(guid);
                }
                else
                {
                    stringIds.Add(removedId);
                }
            }

            return new CwRemovedIdIndex(
                guidIds,
                stringIds,
                removedIds.Count,
                guidParseAttempts);
        }

        internal bool Contains(string? entryId)
        {
            EntryIdentifierNormalizations++;
            if (string.IsNullOrEmpty(entryId)) return false;

            EntryGuidParseAttempts++;
            MembershipComparisons++;
            return Guid.TryParse(entryId, out var guid)
                ? _guidIds.Contains(guid)
                : _stringIds.Contains(entryId);
        }
    }

    public sealed class ContinueWatchingPlaybackConsumer : IEventConsumer<PlaybackStartEventArgs>
    {
        private static readonly HashSet<string> AutoRemoveScopes =
            new(StringComparer.OrdinalIgnoreCase) { "continuewatching", "homesections" };

        private readonly UserConfigurationManager _configManager;
        private readonly ILogger<ContinueWatchingPlaybackConsumer> _logger;
        private readonly IPluginConfigProvider _configProvider;

        public ContinueWatchingPlaybackConsumer(UserConfigurationManager configManager, ILogger<ContinueWatchingPlaybackConsumer> logger, IPluginConfigProvider configProvider)
        {
            _configManager = configManager;
            _logger = logger;
            _configProvider = configProvider;
        }

        public Task OnEvent(PlaybackStartEventArgs eventArgs)
        {
            try
            {
                // Mirror the response filter's HC + RCW gate (HiddenContentResponseFilter.cs). When admin runs
                // RCW=on / HC=off, the filter still strips continuewatching-scope entries; without this branch
                // resume would never auto-clear those entries and the user would see them stay hidden forever.
                var cfg = _configProvider.ConfigurationOrNull;
                var hcEnabled = cfg?.HiddenContentEnabled == true;
                var rcwEnabled = cfg?.RemoveContinueWatchingEnabled == true;
                if (!hcEnabled && !rcwEnabled)
                {
                    return Task.CompletedTask;
                }

                var item = eventArgs?.Item;
                var session = eventArgs?.Session;
                if (item == null || session == null) return Task.CompletedTask;

                var userId = session.UserId;
                if (userId == Guid.Empty) return Task.CompletedTask;

                var itemIdStr = item.Id.ToString();
                var seriesIdStr = item is Episode ep && ep.SeriesId != Guid.Empty
                    ? ep.SeriesId.ToString()
                    : null;

                int changed;
                try
                {
                    changed = _configManager.RmwUserConfiguration<UserHiddenContent>(
                        userId.ToString("N"), "hidden-content.json", hidden =>
                    {
                        if (hidden?.Items == null || hidden.Items.Count == 0) return 0;
                        var keysToDrop = new List<string>();
                        var keysToDemote = new List<string>();
                        foreach (var kvp in hidden.Items)
                        {
                            var entry = kvp.Value;
                            if (entry == null) continue;
                            var scope = string.IsNullOrEmpty(entry.HideScope) ? "global" : entry.HideScope;
                            if (!AutoRemoveScopes.Contains(scope)) continue;
                            if (string.IsNullOrEmpty(entry.ItemId)) continue;

                            if (!(CwEventHelpers.IdMatches(entry.ItemId, itemIdStr)
                                || (seriesIdStr != null && CwEventHelpers.IdMatches(entry.ItemId, seriesIdStr))))
                            {
                                continue;
                            }

                            // Resume signals the CW filter is unwanted; demote homesections to nextup rather than drop.
                            if (string.Equals(scope, "homesections", StringComparison.OrdinalIgnoreCase))
                            {
                                keysToDemote.Add(kvp.Key);
                            }
                            else
                            {
                                keysToDrop.Add(kvp.Key);
                            }
                        }
                        foreach (var k in keysToDrop) hidden.Items.Remove(k);
                        foreach (var k in keysToDemote)
                        {
                            if (hidden.Items.TryGetValue(k, out var e) && e != null) e.HideScope = "nextup";
                        }
                        return keysToDrop.Count + keysToDemote.Count;
                    });
                }
                catch (UserStoreUnhealthyException)
                {
                    return Task.CompletedTask;
                }
                catch (InvalidDataException ex)
                {
                    _logger.LogWarning($"CW: skipping playback drop for user {userId} due to corrupt hidden-content.json: {ex.Message}");
                    return Task.CompletedTask;
                }

                if (changed > 0)
                {
                    // The response filter caches each user's HideContext for 30s; invalidate now so the
                    // just-resumed item stops being hidden immediately instead of up to 30s later.
                    HiddenContentResponseFilter.InvalidateUser(userId.ToString("N"));
                    _logger.LogInformation($"CW: dropped/demoted {changed} hidden-content entr{(changed == 1 ? "y" : "ies")} for user {userId} on resume of item {item.Id}");
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"CW: playback-start consumer failed: {ex.Message}");
            }

            return Task.CompletedTask;
        }
    }

    public sealed class ContinueWatchingLibraryHook : IHostedService, IDisposable
    {
        private static readonly TimeSpan DrainDebounce = TimeSpan.FromSeconds(2);
        private static readonly TimeSpan DrainRetryDelay = TimeSpan.FromSeconds(2);
        private const int PendingRemovalCapacity = 4096;

        private readonly ILibraryManager _libraryManager;
        private readonly UserConfigurationManager _configManager;
        private readonly IUserManager _userManager;
        private readonly ILogger<ContinueWatchingLibraryHook> _logger;
        private readonly object _lifecycleGate = new();
        private readonly HashSet<string> _pendingRemovals = new(StringComparer.OrdinalIgnoreCase);
        private readonly int _pendingRemovalCapacity;
        private readonly TimeSpan _drainDebounce;
        private readonly TimeSpan _drainRetryDelay;
        private readonly Func<Guid, CwRemovedIdIndex, bool>? _pruneUserForTest;
        private readonly TaskCompletionSource<bool> _disposeCompletion = new(TaskCreationOptions.RunContinuationsAsynchronously);

        private Channel<byte>? _drainSignals;
        private CancellationTokenSource? _flushNow;
        private CancellationTokenSource? _abortWorker;
        private Task? _workerTask;
        private bool _started;
        private bool _subscribed;
        private bool _accepting;
        private bool _stopInitiated;
        private bool _disposed;
        private bool _disposeStarted;
        private string? _terminalFailure;
        private long _rejectedRemovalCount;
        private long _reportedRejectedRemovalCount;

        // Test seams (Tests has InternalsVisibleTo). Both enqueue paths use the production intake
        // fence, so lifecycle races exercise the same acceptance boundary as ItemRemoved.
        internal bool EnqueueRemovalForTest(Guid id) => TryAcceptRemoval(id);

        internal Action? OnBeforeRemovalAcceptanceForTest;

        internal Action? OnDrainProcessingForTest;

        internal Action? OnDrainDebounceStartedForTest;

        internal Action? OnDisposeWaitingForTest;

        internal bool PendingIsEmptyForTest
        {
            get
            {
                lock (_lifecycleGate)
                {
                    return _pendingRemovals.Count == 0;
                }
            }
        }

        internal long RejectedRemovalCountForTest => Interlocked.Read(ref _rejectedRemovalCount);

        internal bool WorkerIsCompletedForTest
        {
            get
            {
                lock (_lifecycleGate)
                {
                    return _workerTask?.IsCompleted != false;
                }
            }
        }

        public ContinueWatchingLibraryHook(
            ILibraryManager libraryManager,
            UserConfigurationManager configManager,
            IUserManager userManager,
            ILogger<ContinueWatchingLibraryHook> logger)
            : this(
                libraryManager,
                configManager,
                userManager,
                logger,
                PendingRemovalCapacity,
                DrainDebounce,
                DrainRetryDelay,
                null)
        {
        }

        internal ContinueWatchingLibraryHook(
            ILibraryManager libraryManager,
            UserConfigurationManager configManager,
            IUserManager userManager,
            ILogger<ContinueWatchingLibraryHook> logger,
            int pendingRemovalCapacity,
            TimeSpan drainDebounce,
            TimeSpan drainRetryDelay,
            Func<Guid, CwRemovedIdIndex, bool>? pruneUserForTest)
        {
            if (pendingRemovalCapacity <= 0)
            {
                throw new ArgumentOutOfRangeException(nameof(pendingRemovalCapacity));
            }

            _libraryManager = libraryManager;
            _configManager = configManager;
            _userManager = userManager;
            _logger = logger;
            _pendingRemovalCapacity = pendingRemovalCapacity;
            _drainDebounce = drainDebounce;
            _drainRetryDelay = drainRetryDelay;
            _pruneUserForTest = pruneUserForTest;
        }

        public Task StartAsync(CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            lock (_lifecycleGate)
            {
                // A hosted-service instance has a single terminal lifecycle. Duplicate starts are
                // harmless, while a start after Stop/Dispose must not reopen closed intake.
                if (_started || _stopInitiated || _disposed) return Task.CompletedTask;

                _drainSignals = Channel.CreateBounded<byte>(new BoundedChannelOptions(1)
                {
                    SingleReader = true,
                    SingleWriter = false,
                    FullMode = BoundedChannelFullMode.DropWrite
                });
                _flushNow = new CancellationTokenSource();
                _abortWorker = new CancellationTokenSource();
                _accepting = true;
                _started = true;
                _subscribed = true;
                _libraryManager.ItemRemoved += OnItemRemoved;

                var signals = _drainSignals;
                var flushNow = _flushNow;
                var abortWorker = _abortWorker;
                _workerTask = Task.Run(() => RunDrainWorkerAsync(signals, flushNow.Token, abortWorker.Token));
            }

            return Task.CompletedTask;
        }

        public async Task StopAsync(CancellationToken cancellationToken)
        {
            Task? worker;
            lock (_lifecycleGate)
            {
                CloseIntakeLocked();
                worker = _workerTask;
            }

            if (worker == null) return;

            try
            {
                // Cancellation only cancels this caller's wait. It does not abandon accepted work:
                // the owned worker remains live, and a later StopAsync can deterministically join it.
                await worker.WaitAsync(cancellationToken).ConfigureAwait(false);

                string? terminalFailure;
                lock (_lifecycleGate)
                {
                    terminalFailure = _terminalFailure;
                }

                if (terminalFailure != null)
                {
                    throw new InvalidOperationException(terminalFailure);
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                _logger.LogWarning("CW: shutdown canceled before accepted orphan-cleanup work was drained; the worker remains active for a later join.");
                throw;
            }
        }

        public void Dispose()
        {
            var ownsDisposal = false;
            Task completion;
            Task? worker = null;
            CancellationTokenSource? abortWorker = null;
            lock (_lifecycleGate)
            {
                if (!_disposeStarted)
                {
                    _disposeStarted = true;
                    _disposed = true;
                    CloseIntakeLocked();
                    abortWorker = _abortWorker;
                    worker = _workerTask;
                    ownsDisposal = true;
                }

                completion = _disposeCompletion.Task;
            }

            if (ownsDisposal)
            {
                Exception? disposalFailure = null;
                try
                {
                    // StopAsync is the normal drain/join path. Dispose is the final safety fence: if
                    // host shutdown skipped or canceled StopAsync, abort retries and join any in-flight
                    // write so no worker can write after any Dispose caller returns.
                    abortWorker?.Cancel();
                    OnDisposeWaitingForTest?.Invoke();
                    worker?.GetAwaiter().GetResult();
                }
                catch (OperationCanceledException)
                {
                    // RunDrainWorkerAsync observes the abort and publishes the shared terminal result.
                }
                catch (Exception ex)
                {
                    disposalFailure = ex;
                }
                finally
                {
                    _flushNow?.Dispose();
                    _abortWorker?.Dispose();
                    if (disposalFailure == null)
                    {
                        _disposeCompletion.TrySetResult(true);
                    }
                    else
                    {
                        _disposeCompletion.TrySetException(disposalFailure);
                    }

                    GC.SuppressFinalize(this);
                }
            }
            else
            {
                OnDisposeWaitingForTest?.Invoke();
            }

            // Every caller, including callers that arrive while the owner is still joining the
            // worker, observes the same terminal completion before returning.
            completion.GetAwaiter().GetResult();
        }

        private void OnItemRemoved(object? sender, ItemChangeEventArgs e)
        {
            // PERF(S1): ItemRemoved fires synchronously on Jellyfin's library-scan thread. Record only
            // the id here (bounded O(1)) and signal the worker; user enumeration and the per-user
            // hidden-content prune (file I/O) run once, off the scan thread, on the owned worker. See
            // docs/developers.md#performance-rules (S1).
            var id = e?.Item?.Id ?? Guid.Empty;
            if (id == Guid.Empty) return;
            OnBeforeRemovalAcceptanceForTest?.Invoke();
            TryAcceptRemoval(id);
        }

        private bool TryAcceptRemoval(Guid id)
        {
            if (id == Guid.Empty) return false;
            lock (_lifecycleGate)
            {
                if (!_accepting || _drainSignals == null) return false;

                var identifier = id.ToString();
                if (_pendingRemovals.Count >= _pendingRemovalCapacity
                    && !_pendingRemovals.Contains(identifier))
                {
                    // Keep every already-accepted exact identity. Broad point-in-time library
                    // negatives are unsafe during scans, so a new distinct id beyond the hard
                    // intake bound is explicitly rejected and counted rather than replacing exact
                    // work with an unrelated full reconciliation.
                    Interlocked.Increment(ref _rejectedRemovalCount);
                    return false;
                }

                _pendingRemovals.Add(identifier);
                _drainSignals.Writer.TryWrite(0);
                return true;
            }
        }

        private void CloseIntakeLocked()
        {
            if (_stopInitiated) return;
            _stopInitiated = true;
            _accepting = false;
            if (_subscribed)
            {
                _libraryManager.ItemRemoved -= OnItemRemoved;
                _subscribed = false;
            }

            _flushNow?.Cancel();
            _drainSignals?.Writer.TryComplete();
        }

        private async Task RunDrainWorkerAsync(
            Channel<byte> signals,
            CancellationToken flushNow,
            CancellationToken abortWorker)
        {
            RemovalBatch? activeBatch = null;
            try
            {
                while (await signals.Reader.WaitToReadAsync(abortWorker).ConfigureAwait(false))
                {
                    signals.Reader.TryRead(out _);
                    OnDrainDebounceStartedForTest?.Invoke();
                    try
                    {
                        await Task.Delay(_drainDebounce, flushNow).ConfigureAwait(false);
                    }
                    catch (OperationCanceledException) when (flushNow.IsCancellationRequested)
                    {
                        // Stop closes intake before canceling this debounce, making the final
                        // snapshot complete. The worker itself is not canceled and drains it below.
                    }

                    abortWorker.ThrowIfCancellationRequested();
                    while (signals.Reader.TryRead(out _)) { }
                    activeBatch = TakePendingBatch();
                    if (activeBatch.Value.IsEmpty) continue;

                    OnDrainProcessingForTest?.Invoke();
                    while (!ProcessBatch(activeBatch.Value))
                    {
                        await Task.Delay(_drainRetryDelay, abortWorker).ConfigureAwait(false);
                    }

                    activeBatch = null;
                }
            }
            catch (OperationCanceledException) when (abortWorker.IsCancellationRequested)
            {
                if (activeBatch.HasValue) RestorePendingBatch(activeBatch.Value);
                int pendingCount;
                lock (_lifecycleGate)
                {
                    pendingCount = _pendingRemovals.Count;
                }

                if (pendingCount > 0)
                {
                    var failure = $"CW: TERMINAL shutdown failure: disposal aborted with {pendingCount} accepted orphan-cleanup id(s) undrained.";
                    lock (_lifecycleGate)
                    {
                        _terminalFailure ??= failure;
                    }

                    _logger.LogError(failure);
                }
            }
            finally
            {
                // Rejections happen on the synchronous event path, where logging would add
                // unbounded host work. Publish one aggregated delta from the owned worker even if
                // Dispose aborts before ProcessBatch is reached; a normal batch report makes this
                // final call a no-op, so each rejected event is reported exactly once.
                ReportRejectedRemovals();
            }
        }

        private RemovalBatch TakePendingBatch()
        {
            lock (_lifecycleGate)
            {
                if (_pendingRemovals.Count == 0) return default;
                var ids = _pendingRemovals.ToArray();
                _pendingRemovals.Clear();
                return new RemovalBatch(ids);
            }
        }

        private void RestorePendingBatch(RemovalBatch batch)
        {
            lock (_lifecycleGate)
            {
                // Intake is already closed on this terminal path. Restoring the active exact batch
                // beside a final pending batch remains bounded at twice the fixed intake capacity.
                foreach (var id in batch.RemovedIds)
                {
                    _pendingRemovals.Add(id);
                }
            }
        }

        private bool ProcessBatch(RemovalBatch batch)
        {
            ReportRejectedRemovals();
            Guid[] userIds;
            try
            {
                userIds = _userManager.GetUsers().Select(user => user.Id).ToArray();
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"CW: orphan-prune user enumeration failed; batch retained for retry: {ex.Message}");
                return false;
            }

            var targetIds = CwRemovedIdIndex.Create(batch.RemovedIds);
            var allSucceeded = true;
            foreach (var userId in userIds)
            {
                allSucceeded &= PruneOrphans(userId, targetIds);
            }

            return allSucceeded;
        }

        private void ReportRejectedRemovals()
        {
            var total = Interlocked.Read(ref _rejectedRemovalCount);
            var previouslyReported = Interlocked.Exchange(ref _reportedRejectedRemovalCount, total);
            if (total > previouslyReported)
            {
                _logger.LogWarning(
                    $"CW: bounded orphan-cleanup intake rejected {total - previouslyReported} distinct removal(s); {total} total rejection(s) since startup.");
            }
        }

        // Coalescing core, factored out for testability: enumerate users once and prune each user
        // exactly ONCE for the whole batch of removed ids (not once per id).
        internal static int DrainBatch(
            IReadOnlyCollection<string> removedIds,
            IEnumerable<Guid> userIds,
            Action<Guid, CwRemovedIdIndex> pruneUser)
        {
            if (removedIds.Count == 0) return 0;
            var targetIds = CwRemovedIdIndex.Create(removedIds);
            var users = 0;
            foreach (var userId in userIds)
            {
                pruneUser(userId, targetIds);
                users++;
            }
            return users;
        }

        // One locked RMW per user that removes every batched orphan id, then invalidates the response
        // filter's HideContext cache for that user if anything changed.
        private bool PruneOrphans(Guid userId, CwRemovedIdIndex targetIds)
        {
            if (_pruneUserForTest != null) return _pruneUserForTest(userId, targetIds);

            try
            {
                var removed = _configManager.RmwUserConfiguration<UserHiddenContent>(
                    userId.ToString("N"),
                    "hidden-content.json",
                    hidden => PruneOrphansCore(hidden, targetIds));
                if (removed > 0)
                {
                    HiddenContentResponseFilter.InvalidateUser(userId.ToString("N"));
                }

                return true;
            }
            catch (UserStoreUnhealthyException)
            {
                // The marker transition is already logged centrally. Repeated
                // library events remain silent, but the accepted batch stays owned for retry.
                return false;
            }
            catch (InvalidDataException ex)
            {
                _logger.LogWarning($"CW: retaining orphan-prune for user {userId} due to corrupt hidden-content.json: {ex.Message}");
                return false;
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"CW: orphan-prune failed for user {userId}; batch retained for retry: {ex.Message}");
                return false;
            }
        }

        // Runs inside the config manager's locked read-modify-write transaction, preserving one
        // atomic mutation per user while making the per-entry work independently testable.
        internal static int PruneOrphansCore(UserHiddenContent? hidden, CwRemovedIdIndex targetIds)
        {
            ArgumentNullException.ThrowIfNull(targetIds);
            if (hidden?.Items == null || hidden.Items.Count == 0) return 0;

            var keysToDrop = new List<string>();
            foreach (var kvp in hidden.Items)
            {
                var entry = kvp.Value;
                if (entry == null) continue;
                if (targetIds.Contains(entry.ItemId)) keysToDrop.Add(kvp.Key);
            }

            foreach (var key in keysToDrop) hidden.Items.Remove(key);
            return keysToDrop.Count;
        }

        private readonly record struct RemovalBatch(string[] RemovedIds)
        {
            internal bool IsEmpty => RemovedIds == null || RemovedIds.Length == 0;
        }
    }
}
