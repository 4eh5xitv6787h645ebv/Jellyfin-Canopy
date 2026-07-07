using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinElevate.Configuration;
using Jellyfin.Plugin.JellyfinElevate.Services.Jellyseerr;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Session;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinElevate.Services
{
    /// <summary>
    /// DI hosted service that turns an admin config save into a live push to open
    /// browser sessions, so a toggled setting hot-reloads with no manual refresh.
    ///
    /// Replaces the former <c>SeerrCache.Instance</c> static bridge + the plugin's
    /// <c>UpdateConfiguration</c> override (v12-platform.md §4 S3(f)): the plugin
    /// is not DI-registered, but this service reaches its instance via
    /// <see cref="IPluginManager"/> and subscribes to
    /// <see cref="BasePlugin{T}.ConfigurationChanged"/> — the event raised by the
    /// dashboard/API save path. On each change it (1) flushes the Seerr caches
    /// (the behaviour the removed override used to provide) and (2) pushes a
    /// JE-marked <see cref="SessionMessageType.GeneralCommand"/> to the sessions
    /// of devices REGISTERED as running the JE client (<see cref="ILiveSessionRegistry"/>,
    /// populated by authenticated public-config fetches). The client's live hub
    /// (src/core/live.ts) filters GeneralCommands for the marker and refetches
    /// public-config. Native clients (Android, Android TV, Kodi, …) never receive
    /// the carrier at all — the old broadcast to every user session delivered a
    /// playback-shaped command to clients whose handling is outside our control.
    /// </summary>
    public sealed class LiveNotifierService : IHostedService
    {
        /// <summary>Arguments key stamped on JE's own GeneralCommands; the client keys off it.</summary>
        internal const string MarkerKey = "JellyfinElevate";

        /// <summary>Marker value for a config-changed push (also the client live-event name).</summary>
        internal const string ConfigChangedValue = "config-changed";

        /// <summary>
        /// Carrier command for JE pushes. Chosen because it is NOT handled by the
        /// web client's GeneralCommand switch (serverNotifications.js) — it hits the
        /// default (debug-log) branch and does nothing — so native clients ignore
        /// the message while JE's subscriber keys off <see cref="MarkerKey"/>.
        /// </summary>
        internal const GeneralCommandType CarrierCommand = GeneralCommandType.SetPlaybackOrder;

        private static readonly Guid PluginId = Guid.Parse("9ffa12bc-f4b5-406c-ab1d-d575acbeea7b");

        private readonly IPluginManager _pluginManager;
        private readonly ISessionManager _sessionManager;
        private readonly ILiveSessionRegistry _liveSessionRegistry;
        private readonly ISeerrCache _seerrCache;
        private readonly ILogger<LiveNotifierService> _logger;

        private BasePlugin<PluginConfiguration>? _plugin;
        private EventHandler<BasePluginConfiguration>? _handler;

        public LiveNotifierService(
            IPluginManager pluginManager,
            ISessionManager sessionManager,
            ILiveSessionRegistry liveSessionRegistry,
            ISeerrCache seerrCache,
            ILogger<LiveNotifierService> logger)
        {
            _pluginManager = pluginManager;
            _sessionManager = sessionManager;
            _liveSessionRegistry = liveSessionRegistry;
            _seerrCache = seerrCache;
            _logger = logger;
        }

        public Task StartAsync(CancellationToken cancellationToken)
        {
            try
            {
                _plugin = ResolvePlugin();
                if (_plugin == null)
                {
                    _logger.LogWarning("LiveNotifier: could not locate the Jellyfin Elevate plugin instance; config hot-reload push disabled.");
                    return Task.CompletedTask;
                }

                _handler = (_, _) => OnConfigurationChanged();
                _plugin.ConfigurationChanged += _handler;
                _logger.LogInformation("LiveNotifier: subscribed to plugin ConfigurationChanged for config hot-reload push.");
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "LiveNotifier: failed to subscribe to ConfigurationChanged.");
            }

            return Task.CompletedTask;
        }

        public Task StopAsync(CancellationToken cancellationToken)
        {
            if (_plugin != null && _handler != null)
            {
                _plugin.ConfigurationChanged -= _handler;
                _handler = null;
            }

            return Task.CompletedTask;
        }

        // Reach the (non-DI) plugin instance through IPluginManager, then cast to
        // the typed BasePlugin to expose ConfigurationChanged.
        private BasePlugin<PluginConfiguration>? ResolvePlugin()
        {
            var id = JellyfinElevate.Instance?.Id ?? PluginId;
            var local = _pluginManager.GetPlugin(id);
            return local?.Instance as BasePlugin<PluginConfiguration>;
        }

        // ConfigurationChanged is a synchronous event fired on the save path;
        // never block it or let an exception escape into the host.
        private void OnConfigurationChanged()
            => _ = HandleConfigurationChangedAsync(CancellationToken.None);

        /// <summary>
        /// Flush Seerr caches (preserving the removed override's behaviour) and push
        /// the JE config-changed message to every user session. Internal so a unit
        /// test can drive it directly. Never throws.
        /// </summary>
        internal async Task HandleConfigurationChangedAsync(CancellationToken cancellationToken)
        {
            try
            {
                _seerrCache.ClearAllSeerrCachesOnConfigChange();
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "LiveNotifier: failed to flush Seerr caches on config change.");
            }

            try
            {
                var version = JellyfinElevate.Instance?.Version?.ToString() ?? string.Empty;
                var command = BuildConfigChangedCommand(version);

                // Target ONLY devices that registered as running the JE client
                // (via authenticated JE endpoint calls). The old broadcast to
                // every user session delivered the playback-shaped carrier to
                // native clients (Android, Android TV, Kodi, …) whose handling of
                // it is outside our control. An empty registry (fresh server, no
                // JE session booted yet) means there is nobody to hot-reload —
                // those sessions pick the new config up when they next load.
                //
                // The device id claim is caller-supplied, so each entry is only
                // honoured when its REGISTERING user has a live session on that
                // device — a user can register pushes for their own devices,
                // never someone else's.
                var liveSessions = _sessionManager.Sessions
                    .Select(s => new LiveSessionEntry(s.DeviceId, s.UserId))
                    .ToList();
                var deviceIds = SelectDeliverableDeviceIds(_liveSessionRegistry.GetActiveEntries(), liveSessions);
                foreach (var deviceId in deviceIds)
                {
                    try
                    {
                        await _sessionManager
                            .SendMessageToUserDeviceSessions(deviceId, SessionMessageType.GeneralCommand, command, cancellationToken)
                            .ConfigureAwait(false);
                    }
                    catch (Exception ex)
                    {
                        // A transient send failure for one device must not stop
                        // the push to the rest.
                        _logger.LogDebug(ex, "LiveNotifier: config-changed send failed for device {DeviceId}.", deviceId);
                    }
                }

                _logger.LogInformation("LiveNotifier: pushed config-changed to {Count} JE device(s).", deviceIds.Count);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "LiveNotifier: failed to push config-changed to sessions.");
            }
        }

        /// <summary>
        /// Pure selector for the devices a push may be sent to: a registered
        /// entry is deliverable only when its registering user currently has a
        /// live session on that device (device ids are matched case-insensitively,
        /// like the server's own session lookup). Distinct so one device is never
        /// pushed twice. Internal for direct unit-testing.
        /// </summary>
        internal static IReadOnlyList<string> SelectDeliverableDeviceIds(
            IReadOnlyList<LiveSessionEntry> registered,
            IReadOnlyList<LiveSessionEntry> liveSessions)
        {
            var result = new List<string>();
            foreach (var entry in registered)
            {
                var hasOwnSession = liveSessions.Any(s =>
                    s.UserId == entry.UserId
                    && string.Equals(s.DeviceId, entry.DeviceId, StringComparison.OrdinalIgnoreCase));
                if (hasOwnSession && !result.Contains(entry.DeviceId, StringComparer.OrdinalIgnoreCase))
                {
                    result.Add(entry.DeviceId);
                }
            }

            return result;
        }

        /// <summary>
        /// Build the JE config-changed GeneralCommand. Pure (no host dependencies)
        /// so it is directly unit-testable: asserts the marker, value and version
        /// the client filters on.
        /// </summary>
        internal static GeneralCommand BuildConfigChangedCommand(string version)
        {
            var command = new GeneralCommand { Name = CarrierCommand };
            command.Arguments[MarkerKey] = ConfigChangedValue;
            command.Arguments["Version"] = version ?? string.Empty;
            return command;
        }
    }
}
