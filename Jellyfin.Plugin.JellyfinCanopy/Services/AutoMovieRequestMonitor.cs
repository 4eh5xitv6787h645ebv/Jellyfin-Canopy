using System;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Services.AutoRequest;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services
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
            ILogger<AutoMovieRequestMonitor> logger,
            IPluginConfigProvider configProvider)
            : base(sessionManager, userManager, libraryManager, logger, configProvider)
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
        // async void handler: the catch below is double-guarded so an exception escaping it
        // (e.g. a logging failure) can't crash the host. See PlaybackWatcherBase.
        private async void OnPlaybackProgress(object? sender, PlaybackProgressEventArgs e)
        {
            try
            {
                // Check if auto-movie-request is enabled
                var integration = GetEnabledIntegration();
                if (integration?.Configuration is not PluginConfiguration config)
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
                        var session = e.Session;
                        var item = e.Item;
                        if (session == null || item == null)
                        {
                            return;
                        }

                        var userId = session.UserId;
                        var sessionItemKey = $"{userId}_{item.Id}";

                        await ExecuteDeduplicatedAsync(
                            integration,
                            sessionItemKey,
                            async () =>
                            {
                                _logger.LogInformation($"[Auto-Movie-Request] Movie '{item.Name}' started by {session.UserName ?? "Unknown"}, checking for collection");
                                return await _autoMovieRequestService
                                    .CheckMovieForCollectionRequestAsync(item, userId, integration)
                                    .ConfigureAwait(false);
                            }).ConfigureAwait(false);
                    }
                }
            }
            catch (Exception ex)
            {
                // async void: an exception escaping this catch would become an unobserved exception
                // that crashes the host, so guard the logging call itself.
                try { _logger.LogError($"[Auto-Movie-Request] Error in OnPlaybackProgress: {ex.Message}"); }
                catch { /* never let a logging failure crash the host from an async void handler */ }
            }
        }
    }
}
