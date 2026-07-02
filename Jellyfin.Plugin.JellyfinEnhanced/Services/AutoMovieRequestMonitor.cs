using System;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.AutoRequest;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    // Monitors playback events to automatically request next movies in collections.
    public class AutoMovieRequestMonitor : PlaybackWatcherBase
    {
        private readonly AutoMovieRequestService _autoMovieRequestService;

        public AutoMovieRequestMonitor(
            ISessionManager sessionManager,
            IUserManager userManager,
            ILibraryManager libraryManager,
            AutoMovieRequestService autoMovieRequestService,
            Logger logger)
            : base(sessionManager, userManager, libraryManager, logger)
        {
            _autoMovieRequestService = autoMovieRequestService;
        }

        protected override string LogPrefix => "[Auto-Movie-Request]";

        protected override string FeatureNoun => "auto-movie-request";

        protected override string DisabledMonitoringName => "Auto-Movie-Request";

        protected override bool IsFeatureEnabled(PluginConfiguration config) => config.AutoMovieRequestEnabled;

        protected override void SubscribeEvents()
        {
            // Subscribe to playback progress events (to detect when user starts watching)
            _sessionManager.PlaybackProgress += OnPlaybackProgress;
        }

        protected override void UnsubscribeEvents()
        {
            _sessionManager.PlaybackProgress -= OnPlaybackProgress;
        }

        // Handle playback progress events to detect when user starts watching a movie.
        // NOTE: async void event handler kept as-is in this mechanical phase (see PlaybackWatcherBase).
        private async void OnPlaybackProgress(object? sender, PlaybackProgressEventArgs e)
        {
            try
            {
                // Check if auto-movie-request is enabled
                var config = GetEnabledConfiguration();
                if (config == null)
                {
                    return;
                }

                // Only process movies
                if (e.Item?.GetBaseItemKind() != BaseItemKind.Movie)
                {
                    return;
                }

                // Check if conditions for triggering are met based on configuration
                if (e.PlaybackPositionTicks.HasValue && e.Item.RunTimeTicks.HasValue && e.Item.RunTimeTicks.Value > 0)
                {
                    var progressPercentage = (double)e.PlaybackPositionTicks.Value / e.Item.RunTimeTicks.Value;
                    var progressMinutes = TimeSpan.FromTicks(e.PlaybackPositionTicks.Value).TotalMinutes;

                    var triggerType = config.AutoMovieRequestTriggerType ?? "Both";
                    var minutesWatched = config.AutoMovieRequestMinutesWatched;

                    bool shouldTrigger = false;

                    if (triggerType == "OnStart")
                    {
                        // Trigger only on movie start (less than 5 minutes in and less than 5% progress)
                        shouldTrigger = (progressMinutes <= 5 && progressPercentage < 0.05);
                    }
                    else if (triggerType == "OnMinutesWatched")
                    {
                        // Trigger only when user has watched for configured minutes
                        shouldTrigger = (progressMinutes >= minutesWatched);
                    }
                    else if (triggerType == "Both")
                    {
                        // Trigger on either condition
                        shouldTrigger = (progressMinutes <= 5 && progressPercentage < 0.05) || (progressMinutes >= minutesWatched);
                    }

                    if (shouldTrigger)
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

                        _logger.Info($"[Auto-Movie-Request] Movie '{e.Item?.Name ?? "Unknown"}' started by {e.Session?.UserName ?? "Unknown"}, checking for collection");

                        if (e.Item != null && e.Session?.UserId != null)
                        {
                            await _autoMovieRequestService.CheckMovieForCollectionRequestAsync(e.Item, e.Session.UserId);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.Error($"[Auto-Movie-Request] Error in OnPlaybackProgress: {ex.Message}");
            }
        }
    }
}
