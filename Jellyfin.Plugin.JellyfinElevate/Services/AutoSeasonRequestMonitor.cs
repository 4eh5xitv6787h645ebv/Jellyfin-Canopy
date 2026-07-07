using System;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinElevate.Configuration;
using Jellyfin.Plugin.JellyfinElevate.Services.AutoRequest;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinElevate.Services
{
    // Monitors playback events to automatically request next seasons when threshold is reached.
    public class AutoSeasonRequestMonitor : PlaybackWatcherBase
    {
        private readonly AutoSeasonRequestService _autoSeasonRequestService;

        public AutoSeasonRequestMonitor(
            ISessionManager sessionManager,
            IUserManager userManager,
            ILibraryManager libraryManager,
            AutoSeasonRequestService autoSeasonRequestService,
            ILogger<AutoSeasonRequestMonitor> logger,
            IPluginConfigProvider configProvider)
            : base(sessionManager, userManager, libraryManager, logger, configProvider)
        {
            _autoSeasonRequestService = autoSeasonRequestService;
        }

        protected override string LogPrefix => "[Auto-Season-Request]";

        protected override string FeatureNoun => "auto-season-request";

        protected override string DisabledMonitoringName => "Auto-request";

        protected override bool IsFeatureEnabled(PluginConfiguration config) => config.AutoSeasonRequestEnabled;

        protected override void SubscribeEvents()
        {
            // Subscribe to playback events
            _sessionManager.PlaybackStopped += OnPlaybackStopped;
            _sessionManager.PlaybackProgress += OnPlaybackProgress;
        }

        protected override void UnsubscribeEvents()
        {
            _sessionManager.PlaybackStopped -= OnPlaybackStopped;
            _sessionManager.PlaybackProgress -= OnPlaybackProgress;
        }

        // Handle playback stopped events to check if we should request next season.
        // async void handler: the catch below is double-guarded so an exception escaping it
        // (e.g. a logging failure) can't crash the host. See PlaybackWatcherBase.
        private async void OnPlaybackStopped(object? sender, PlaybackStopEventArgs e)
        {
            try
            {
                // Check if auto-season-request is enabled
                var config = GetEnabledConfiguration();
                if (config == null)
                {
                    return;
                }

                // Only process TV episodes
                if (e.Item?.GetBaseItemKind() != BaseItemKind.Episode)
                {
                    return;
                }

                _logger.LogDebug($"[Auto-Season-Request] PlaybackStopped event fired for episode: {e.Item?.Name}");

                // Check if the episode was watched (at least 90% completion)
                var playedToCompletion = e.PlayedToCompletion;
                var completionPercentage = 0.0;
                if (e.Item != null && e.PlaybackPositionTicks.HasValue && e.Item.RunTimeTicks.HasValue && e.Item.RunTimeTicks.Value > 0)
                {
                    completionPercentage = (double)e.PlaybackPositionTicks.Value / e.Item.RunTimeTicks.Value;
                }
                //This probably can be removed but leaving it for now as a debug log

                _logger.LogInformation($"[Auto-Season-Request] Episode '{e.Item?.Name ?? "Unknown"}' - PlayedToCompletion: {playedToCompletion}, Completion: {completionPercentage:P1}");

                if (playedToCompletion || completionPercentage >= 0.9)
                {
                    // Deduplicate stop events for the same user+item (same pattern as OnPlaybackProgress)
                    if (e.Session?.UserId == null || e.Item?.Id == null)
                    {
                        return;
                    }

                    var sessionItemKey = $"stopped_{e.Session.UserId}_{e.Item.Id}";
                    if (!TryMarkChecked(sessionItemKey))
                    {
                        _logger.LogDebug($"[Auto-Season-Request] PlaybackStopped already processed for '{e.Item?.Name}', skipping duplicate");
                        return;
                    }

                    _logger.LogInformation($"[Auto-Season-Request] Episode '{e.Item?.Name ?? "Unknown"}' completed by {e.Session?.UserName ?? "Unknown"}, checking threshold");

                    // Process this episode completion
                    if (e.Item != null && e.Session?.UserId != null)
                    {
                        await _autoSeasonRequestService.CheckEpisodeCompletionAsync(e.Item, e.Session.UserId);
                    }
                    else
                    {
                        _logger.LogWarning("[Auto-Season-Request] Item or Session/UserId is null, cannot process");
                    }
                }
                //This probably can be removed but leaving it for now as a debug log
                else
                {
                    _logger.LogDebug($"[Auto-Season-Request] Episode not completed enough ({completionPercentage:P1}), skipping");
                }
            }
            catch (Exception ex)
            {
                // async void: an exception escaping this catch would become an unobserved exception
                // that crashes the host, so guard the logging call itself.
                try { _logger.LogError($"[Auto-Season-Request] Error in OnPlaybackStopped: {ex.Message}"); }
                catch { /* never let a logging failure crash the host from an async void handler */ }
            }
        }

        // Handle playback progress events to detect when user starts watching a new episode.
        // async void handler: the catch below is double-guarded so an exception escaping it
        // (e.g. a logging failure) can't crash the host. See PlaybackWatcherBase.
        private async void OnPlaybackProgress(object? sender, PlaybackProgressEventArgs e)
        {
            try
            {
                // Check if auto-season-request is enabled
                var config = GetEnabledConfiguration();
                if (config == null)
                {
                    return;
                }

                // Only process TV episodes
                if (e.Item?.GetBaseItemKind() != BaseItemKind.Episode)
                {
                    return;
                }

                // Only check when episode just started (within first 2 minutes)
                if (e.PlaybackPositionTicks.HasValue && e.Item.RunTimeTicks.HasValue && e.Item.RunTimeTicks.Value > 0)
                {
                    var progressPercentage = (double)e.PlaybackPositionTicks.Value / e.Item.RunTimeTicks.Value;
                    var progressMinutes = TimeSpan.FromTicks(e.PlaybackPositionTicks.Value).TotalMinutes;

                    // Only trigger on episode start (less than 2 minutes in)
                    if (progressMinutes <= 2 && progressPercentage < 0.05)
                    {
                        // Create a unique key using userId and item ID
                        if (e.Session?.UserId == null || e.Item?.Id == null)
                        {
                            return;
                        }

                        var sessionItemKey = $"{e.Session.UserId}_{e.Item.Id}";

                        // Skip if we've checked this user+item combination in the last hour
                        if (!TryMarkChecked(sessionItemKey))
                        {
                            return;
                        }

                        _logger.LogInformation($"[Auto-Season-Request] Episode '{e.Item?.Name ?? "Unknown"}' started by {e.Session?.UserName ?? "Unknown"}, checking threshold");

                        if (e.Item != null && e.Session?.UserId != null)
                        {
                            await _autoSeasonRequestService.CheckEpisodeCompletionAsync(e.Item, e.Session.UserId);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                // async void: an exception escaping this catch would become an unobserved exception
                // that crashes the host, so guard the logging call itself.
                try { _logger.LogError($"[Auto-Season-Request] Error in OnPlaybackProgress: {ex.Message}"); }
                catch { /* never let a logging failure crash the host from an async void handler */ }
            }
        }
    }
}
