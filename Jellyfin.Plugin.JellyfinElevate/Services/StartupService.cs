using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinElevate.Services
{
    public class StartupService : IScheduledTask
    {
        private readonly ILogger<StartupService> _logger;
        private readonly IApplicationPaths _applicationPaths;
        private readonly AutoSeasonRequestMonitor _autoSeasonRequestMonitor;
        private readonly AutoMovieRequestMonitor _autoMovieRequestMonitor;
        private readonly WatchlistMonitor _watchlistMonitor;
        private readonly TagCacheService _tagCacheService;
        private readonly TagCacheMonitor _tagCacheMonitor;
        private readonly SeerrScanTriggerService _seerrScanTriggerService;
        private readonly Awards.AwardsCacheService _awardsCacheService;
        private readonly Awards.IAwardsProvider _awardsProvider;
        private readonly IPluginConfigProvider _configProvider;

        public string Name => "Jellyfin Elevate Startup";
        public string Key => "JellyfinElevateStartup";
        public string Description => "Initializes Jellyfin Elevate background services and performs necessary cleanups. The client script is injected at request time by the injection middleware.";
        public string Category => "Jellyfin Elevate";

        public StartupService(ILogger<StartupService> logger, IApplicationPaths applicationPaths, AutoSeasonRequestMonitor autoSeasonRequestMonitor, AutoMovieRequestMonitor autoMovieRequestMonitor, WatchlistMonitor watchlistMonitor, TagCacheService tagCacheService, TagCacheMonitor tagCacheMonitor, SeerrScanTriggerService seerrScanTriggerService, Awards.AwardsCacheService awardsCacheService, Awards.IAwardsProvider awardsProvider, IPluginConfigProvider configProvider)
        {
            _logger = logger;
            _applicationPaths = applicationPaths;
            _autoSeasonRequestMonitor = autoSeasonRequestMonitor;
            _autoMovieRequestMonitor = autoMovieRequestMonitor;
            _watchlistMonitor = watchlistMonitor;
            _tagCacheService = tagCacheService;
            _tagCacheMonitor = tagCacheMonitor;
            _seerrScanTriggerService = seerrScanTriggerService;
            _awardsCacheService = awardsCacheService;
            _awardsProvider = awardsProvider;
            _configProvider = configProvider;
        }

        public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            await Task.Run(() =>
            {
                _logger.LogInformation("Jellyfin Elevate Startup Task run successfully.");
                EnsureScriptInjected();

                // Initialize auto season request monitoring
                _autoSeasonRequestMonitor.Initialize();

                // Initialize auto movie request monitoring
                _autoMovieRequestMonitor.Initialize();

                // Initialize watchlist monitoring
                _watchlistMonitor.Initialize();

                // Initialize on-demand Seerr recently-added scan trigger
                _seerrScanTriggerService.Initialize();

                // Load tag cache from disk. New/changed items are picked up by the
                // monitor via Jellyfin's library scan events (ItemAdded/ItemUpdated).
                // A full rebuild runs daily at 3 AM or can be triggered manually.
                // Wrapped in try/catch so a cache failure never prevents the rest of
                // the plugin from working (tags just fall back to batch mode).
                try
                {
                    _tagCacheService.LoadFromDisk();
                    _tagCacheMonitor.Initialize();

                    // First install: if no cache exists, build it now so tags work immediately
                    if (_tagCacheService.Count == 0)
                    {
                        _logger.LogInformation("[TagCache] No cache on disk, building initial cache...");
                        _tagCacheService.BuildFullCache(null, CancellationToken.None);
                    }
                }
                catch (System.Exception ex)
                {
                    _logger.LogError($"[TagCache] Failed to initialize tag cache (tags will use batch fallback): {ex.Message}");
                }

                // Load the awards index from disk. It is rebuilt from Wikidata only on the
                // weekly scheduled task (or a manual run), never on every startup — a restart
                // must not re-fetch. See BuildAwardsCacheTask.
                try
                {
                    _awardsCacheService.LoadFromDisk();
                }
                catch (System.Exception ex)
                {
                    _logger.LogError($"[Awards] Failed to load awards index (awards section will be empty until the next refresh): {ex.Message}");
                }

                _logger.LogInformation("Jellyfin Elevate Startup Task completed successfully.");
            }, cancellationToken);

            // First install only: if the feature is enabled but the index has never been built,
            // populate it once now so awards appear without waiting up to a week for the scheduled
            // task. Done after the sync init block (off the tag-cache path) and outside the disk
            // load's try/catch. A restart with an existing on-disk index skips this entirely.
            await BuildInitialAwardsIndexIfNeededAsync(cancellationToken).ConfigureAwait(false);
        }

        private async Task BuildInitialAwardsIndexIfNeededAsync(CancellationToken cancellationToken)
        {
            if (_configProvider.ConfigurationOrNull?.ShowAwards != true || !_awardsCacheService.IsEmpty)
            {
                return;
            }

            try
            {
                _logger.LogInformation("[Awards] Feature enabled and no index on disk; building the initial awards index...");

                // Reserve the generation before fetching so a concurrent manual "Build Awards
                // Cache" run started later (higher generation) wins over this slower startup build.
                var generation = _awardsCacheService.NextRefreshGeneration();
                var result = await _awardsProvider.FetchAllAsync(null, cancellationToken).ConfigureAwait(false);

                // TryReplaceFrom publishes atomically: on first install (empty index) even a partial
                // result is published; but a partial result is rejected once a complete index exists,
                // and a stale generation is rejected once a newer refresh has published.
                if (_awardsCacheService.TryReplaceFrom(result.Rows, result.Complete, generation))
                {
                    _logger.LogInformation("[Awards] Initial awards index built: {0} titles.", _awardsCacheService.TitleCount);
                }
                else
                {
                    _logger.LogWarning("[Awards] Initial awards index not published (no rows, or a complete index already exists); the weekly task will refresh.");
                }
            }
            catch (OperationCanceledException)
            {
                // Server shutting down mid-fetch — the weekly task will build it later.
            }
            catch (System.Exception ex)
            {
                _logger.LogError($"[Awards] Initial awards index build failed (the weekly task will retry): {ex.Message}");
            }
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
                JellyfinElevate.Instance?.InjectScript();
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