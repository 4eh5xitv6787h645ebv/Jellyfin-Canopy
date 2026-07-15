using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
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

        private readonly ILibraryManager _libraryManager;
        private readonly UserConfigurationManager _configManager;
        private readonly IUserManager _userManager;
        private readonly ILogger<ContinueWatchingLibraryHook> _logger;

        // Coalesce a bulk delete (many ItemRemoved events in one burst) into a single debounced
        // drain: without this, each removed item started its own Task.Run that enumerated every user
        // and did a locked per-user disk RMW — O(items × users) file reads on a bulk delete.
        private readonly ConcurrentDictionary<string, byte> _pendingRemovals = new(StringComparer.OrdinalIgnoreCase);
        private readonly Timer _drainTimer;
        // Interlocked flush guard so a StopAsync flush and a concurrent timer tick don't double-drain
        // (mirrors TagCacheService.FlushPending).
        private int _draining;
        private int _drainRearms; // count of times the finally re-armed the timer (test seam)

        // Test seams (Tests has InternalsVisibleTo).
        internal void EnqueueRemovalForTest(Guid id) => _pendingRemovals.TryAdd(id.ToString(), 0);

        internal void DrainForTest() => Drain();

        internal Action? OnDrainProcessingForTest;

        internal int DrainRearmCountForTest => _drainRearms;

        internal bool PendingIsEmptyForTest => _pendingRemovals.IsEmpty;

        public ContinueWatchingLibraryHook(
            ILibraryManager libraryManager,
            UserConfigurationManager configManager,
            IUserManager userManager,
            ILogger<ContinueWatchingLibraryHook> logger)
        {
            _libraryManager = libraryManager;
            _configManager = configManager;
            _userManager = userManager;
            _logger = logger;
            _drainTimer = new Timer(_ => Drain(), null, Timeout.Infinite, Timeout.Infinite);
        }

        public Task StartAsync(CancellationToken cancellationToken)
        {
            _libraryManager.ItemRemoved += OnItemRemoved;
            return Task.CompletedTask;
        }

        public Task StopAsync(CancellationToken cancellationToken)
        {
            _libraryManager.ItemRemoved -= OnItemRemoved;
            // Flush anything queued mid-window so a shutdown doesn't drop pending prunes.
            _drainTimer.Change(Timeout.Infinite, Timeout.Infinite);
            Drain();
            _drainTimer.Dispose();
            return Task.CompletedTask;
        }

        public void Dispose()
        {
            _drainTimer.Dispose();
            GC.SuppressFinalize(this);
        }

        private void OnItemRemoved(object? sender, ItemChangeEventArgs e)
        {
            // PERF(S1): ItemRemoved fires synchronously on Jellyfin's library-scan thread. Record only
            // the id here (O(1)) and (re)arm the debounce timer; the user enumeration and the per-user
            // hidden-content prune (file I/O) run once, off the scan thread, on the timer thread. See
            // docs/developers.md#performance-rules (S1).
            var id = e?.Item?.Id ?? Guid.Empty;
            if (id == Guid.Empty) return;
            _pendingRemovals.TryAdd(id.ToString(), 0);
            _drainTimer.Change(DrainDebounce, Timeout.InfiniteTimeSpan);
        }

        // Snapshot + clear the pending removals, then prune each user ONCE for the whole batch.
        private void Drain()
        {
            if (Interlocked.Exchange(ref _draining, 1) == 1) return;
            try
            {
                if (_pendingRemovals.IsEmpty) return;
                var ids = _pendingRemovals.Keys.ToArray();
                foreach (var k in ids) _pendingRemovals.TryRemove(k, out _);

                OnDrainProcessingForTest?.Invoke();

                var userIds = _userManager.GetUsers().Select(u => u.Id);
                DrainBatch(ids, userIds, PruneOrphans);
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"CW: orphan-prune drain failed: {ex.Message}");
            }
            finally
            {
                Interlocked.Exchange(ref _draining, 0);
                // Re-arm if work arrived while we were draining (a concurrent ItemRemoved, or a timer
                // tick that bailed on the _draining guard): those ids weren't in this drain's snapshot,
                // so without a re-arm they'd sit in _pendingRemovals until the next unrelated event.
                // Fixed delay, no busy-spin. Guard against ObjectDisposedException: StopAsync may have
                // disposed the timer (it drains once more itself), so a late re-arm is a harmless no-op.
                if (!_pendingRemovals.IsEmpty)
                {
                    try
                    {
                        _drainTimer.Change(DrainDebounce, Timeout.InfiniteTimeSpan);
                        Interlocked.Increment(ref _drainRearms);
                    }
                    catch (ObjectDisposedException) { /* shutting down; StopAsync already drained/stopped */ }
                }
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
        private void PruneOrphans(Guid userId, CwRemovedIdIndex targetIds)
        {
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
            }
            catch (UserStoreUnhealthyException)
            {
                // The marker transition is already logged centrally. Repeated
                // library events must remain silent until explicit recovery.
            }
            catch (InvalidDataException ex)
            {
                _logger.LogWarning($"CW: skipping orphan-prune for user {userId} due to corrupt hidden-content.json: {ex.Message}");
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"CW: orphan-prune failed for user {userId}: {ex.Message}");
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
    }
}
