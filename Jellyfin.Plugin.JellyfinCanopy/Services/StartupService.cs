using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services
{
    public class StartupService : IScheduledTask
    {
        private readonly ILogger<StartupService> _logger;
        private readonly IApplicationPaths _applicationPaths;
        private readonly AutoSeasonRequestMonitor _autoSeasonRequestMonitor;
        private readonly AutoMovieRequestMonitor _autoMovieRequestMonitor;
        private readonly WatchlistMonitor _watchlistMonitor;
        private readonly TagCacheLifecycleService _tagCacheLifecycle;
        private readonly SeerrScanTriggerService _seerrScanTriggerService;
        private readonly IPluginConfigProvider _configProvider;

        public string Name => "Jellyfin Canopy Startup";
        public string Key => "JellyfinCanopyStartup";
        public string Description => "Initializes Jellyfin Canopy background services and performs necessary cleanups. The client script is injected at request time by the injection middleware.";
        public string Category => "Jellyfin Canopy";

        public StartupService(
            ILogger<StartupService> logger,
            IApplicationPaths applicationPaths,
            AutoSeasonRequestMonitor autoSeasonRequestMonitor,
            AutoMovieRequestMonitor autoMovieRequestMonitor,
            WatchlistMonitor watchlistMonitor,
            TagCacheLifecycleService tagCacheLifecycle,
            SeerrScanTriggerService seerrScanTriggerService,
            IPluginConfigProvider configProvider)
        {
            _logger = logger;
            _applicationPaths = applicationPaths;
            _autoSeasonRequestMonitor = autoSeasonRequestMonitor;
            _autoMovieRequestMonitor = autoMovieRequestMonitor;
            _watchlistMonitor = watchlistMonitor;
            _tagCacheLifecycle = tagCacheLifecycle;
            _seerrScanTriggerService = seerrScanTriggerService;
            _configProvider = configProvider;
        }

        public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            await Task.Run(async () =>
            {
                _logger.LogInformation("Jellyfin Canopy Startup Task run successfully.");
                EnsureScriptInjected();

                // Initialize auto season request monitoring
                _autoSeasonRequestMonitor.Initialize();

                // Initialize auto movie request monitoring
                _autoMovieRequestMonitor.Initialize();

                // Initialize watchlist monitoring
                _watchlistMonitor.Initialize();

                // Initialize on-demand Seerr recently-added scan trigger
                _seerrScanTriggerService.Initialize();

                // The lifecycle owner checks server mode before any cache disk read,
                // subscription, timer, allocation, or library query. Cache failure
                // never prevents the rest of the plugin from starting; clients retain
                // their live batch fallback until a complete generation is ready.
                try
                {
                    await _tagCacheLifecycle.InitializeAsync(null, cancellationToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "[TagCache] Failed to initialize tag cache; clients will use batch fallback.");
                }

                _logger.LogInformation("Jellyfin Canopy Startup Task completed successfully.");
            }, cancellationToken).ConfigureAwait(false);
        }

        // Request-time script injection (Jellyfin 10.11 & 12).
        //
        // The client <script> tag is injected into web/index.html at request time by
        // ScriptInjectionStartupFilter (and branding by BrandingAssetStartupFilter), so
        // nothing is written to the web folder on startup. The legacy on-disk index.html
        // rewrite is kept only as an explicit fallback for admins who disable the middleware.
        private void EnsureScriptInjected()
        {
            var config = _configProvider.ConfigurationOrNull;

            if (config != null && config.DisableScriptInjectionMiddleware)
            {
                _logger.LogInformation("Script injection middleware is disabled; using the legacy on-disk index.html fallback.");
                JellyfinCanopy.Instance?.InjectScript();
                return;
            }

            _logger.LogInformation("Client script will be injected at request time by the injection middleware.");
        }


        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
        {
            yield return new TaskTriggerInfo()
            {
                Type = TaskTriggerInfoType.StartupTrigger
            };
        }
    }
}
