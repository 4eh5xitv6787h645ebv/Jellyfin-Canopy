using System;
using System.Linq;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.AutoRequest
{
    /// <summary>
    /// Shared plumbing for the auto-request playback monitors (movie collections and
    /// next seasons): dependency fields, enable-gated Initialize/Dispose subscription
    /// management, and the checked-session dedup cache with 1-hour expiry.
    ///
    /// Subclasses keep only their trigger predicate and handling logic. The playback
    /// event handlers themselves stay in the subclasses as async void with their own
    /// try/catch.
    ///
    /// Because those handlers are async void, an exception escaping their catch (e.g. from
    /// the catch block itself) would become an unobserved exception that crashes the host.
    /// Each subclass handler therefore double-guards its catch — the logging call inside the
    /// outer catch is itself wrapped in a swallowing try/catch.
    /// </summary>
    public abstract class PlaybackWatcherBase : IDisposable
    {
        protected readonly ISessionManager _sessionManager;
        protected readonly IUserManager _userManager;
        protected readonly ILibraryManager _libraryManager;
        protected readonly ILogger _logger;
        protected readonly IPluginConfigProvider _configProvider;

        // Track which user+item combinations have already been checked to avoid duplicate checks
        private readonly Dictionary<string, DateTime> _checkedSessions = new();
        private readonly object _sessionLock = new();
        private readonly object _subLock = new();
        private bool _subscribed;

        protected PlaybackWatcherBase(
            ISessionManager sessionManager,
            IUserManager userManager,
            ILibraryManager libraryManager,
            ILogger logger,
            IPluginConfigProvider configProvider)
        {
            _sessionManager = sessionManager;
            _userManager = userManager;
            _libraryManager = libraryManager;
            _logger = logger;
            _configProvider = configProvider;
        }

        /// <summary>Log prefix including brackets, e.g. "[Auto-Movie-Request]".</summary>
        protected abstract string LogPrefix { get; }

        /// <summary>Lowercase feature noun for the config-null log, e.g. "auto-movie-request".</summary>
        protected abstract string FeatureNoun { get; }

        /// <summary>Name used in the disabled log, e.g. "Auto-Movie-Request" or "Auto-request".</summary>
        protected abstract string DisabledMonitoringName { get; }

        /// <summary>Whether this watcher's feature flag is enabled in configuration.</summary>
        protected abstract bool IsFeatureEnabled(PluginConfiguration config);

        /// <summary>Subscribe this watcher's handlers to session-manager events.</summary>
        protected abstract void SubscribeEvents();

        /// <summary>Unsubscribe this watcher's handlers from session-manager events.</summary>
        protected abstract void UnsubscribeEvents();

        // Initialize and start monitoring playback events.
        public void Initialize()
        {
            // Only initialize if the feature is enabled in plugin configuration.
            var config = _configProvider.ConfigurationOrNull as PluginConfiguration;
            if (config == null)
            {
                _logger.LogWarning($"{LogPrefix} Configuration is null - skipping {FeatureNoun} monitoring initialization");
                return;
            }

            if (!IsFeatureEnabled(config) || !config.SeerrEnabled)
            {
                _logger.LogInformation($"{LogPrefix} {DisabledMonitoringName} monitoring is disabled in configuration - not subscribing to playback events");
                return;
            }

            // Guard against a second startup-task run double-subscribing (a dashboard "Run" button
            // always exists). The disabled-feature early-return stays ahead of the lock so re-running
            // the task after enabling the feature still subscribes.
            lock (_subLock)
            {
                if (_subscribed) return;
                SubscribeEvents();
                _subscribed = true;
            }

            _logger.LogInformation($"{LogPrefix} Successfully subscribed to playback events");
        }

        /// <summary>
        /// Returns the plugin configuration when this watcher's feature (and Seerr)
        /// is enabled, otherwise null. Event handlers use this as their fast-exit gate.
        /// </summary>
        protected PluginConfiguration? GetEnabledConfiguration()
        {
            var config = _configProvider.ConfigurationOrNull as PluginConfiguration;
            if (config == null || !IsFeatureEnabled(config) || !config.SeerrEnabled)
            {
                return null;
            }

            return config;
        }

        /// <summary>
        /// Thread-safe dedup: prunes cache entries older than 1 hour, then returns false
        /// if <paramref name="sessionItemKey"/> was already checked within the last hour,
        /// or marks it checked and returns true.
        /// </summary>
        protected bool TryMarkChecked(string sessionItemKey)
        {
            lock (_sessionLock)
            {
                // Clean up expired cache entries (older than 1 hour)
                var expiredKeys = _checkedSessions.Where(kvp => (DateTime.Now - kvp.Value).TotalHours > 1)
                    .Select(kvp => kvp.Key)
                    .ToList();
                foreach (var key in expiredKeys)
                {
                    _checkedSessions.Remove(key);
                }

                // Skip if we've checked this user+item combination in the last hour
                if (_checkedSessions.ContainsKey(sessionItemKey))
                {
                    return false;
                }

                // Mark as checked with current timestamp
                _checkedSessions[sessionItemKey] = DateTime.Now;
                return true;
            }
        }

        // Cleanup when the plugin is disposed.
        public void Dispose()
        {
            _logger.LogInformation($"{LogPrefix} Unsubscribing from playback events");

            lock (_subLock)
            {
                UnsubscribeEvents();
                _subscribed = false;
            }

            GC.SuppressFinalize(this);
        }
    }
}
