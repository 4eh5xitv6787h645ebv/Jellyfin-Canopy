using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Events;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Hosting;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinEnhanced.EventHandlers
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
            // docs/advanced/performance-rules.md (S1).
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
            }
        }

        // Coalescing core, factored out for testability: enumerate users once and prune each user
        // exactly ONCE for the whole batch of removed ids (not once per id).
        internal static int DrainBatch(
            IReadOnlyCollection<string> removedIds,
            IEnumerable<Guid> userIds,
            Action<Guid, IReadOnlyCollection<string>> pruneUser)
        {
            if (removedIds.Count == 0) return 0;
            var users = 0;
            foreach (var userId in userIds)
            {
                pruneUser(userId, removedIds);
                users++;
            }
            return users;
        }

        // One locked RMW per user that removes every batched orphan id, then invalidates the response
        // filter's HideContext cache for that user if anything changed.
        private void PruneOrphans(Guid userId, IReadOnlyCollection<string> targetIds)
        {
            try
            {
                var removed = _configManager.RmwUserConfiguration<UserHiddenContent>(
                    userId.ToString("N"), "hidden-content.json", hidden =>
                {
                    if (hidden?.Items == null || hidden.Items.Count == 0) return 0;
                    var keysToDrop = new List<string>();
                    foreach (var kvp in hidden.Items)
                    {
                        var entry = kvp.Value;
                        if (entry == null) continue;
                        if (targetIds.Any(t => CwEventHelpers.IdMatches(entry.ItemId, t))) keysToDrop.Add(kvp.Key);
                    }
                    foreach (var k in keysToDrop) hidden.Items.Remove(k);
                    return keysToDrop.Count;
                });
                if (removed > 0)
                {
                    HiddenContentResponseFilter.InvalidateUser(userId.ToString("N"));
                }
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
    }
}
