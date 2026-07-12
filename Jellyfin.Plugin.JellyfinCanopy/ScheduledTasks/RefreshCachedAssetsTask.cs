using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.ScheduledTasks
{
    /// <summary>
    /// Refreshes the local mirror of every third-party asset in the
    /// <see cref="AssetCacheManifest"/> (fonts, icon sets, flags, theme CSS, data files) so
    /// browsers are served exclusively from /JellyfinCanopy/assets/*. Default cadence:
    /// on startup plus every 24 hours — admins can retune it in Jellyfin's task scheduler.
    /// Refreshes use conditional GETs (ETag/Last-Modified) where upstream offers them, and a
    /// single failing asset never aborts the rest of the run.
    /// </summary>
    public class RefreshCachedAssetsTask : IScheduledTask
    {
        private readonly ILogger<RefreshCachedAssetsTask> _logger;
        private readonly AssetCacheService _assetCache;
        private readonly IPluginConfigProvider _configProvider;

        public RefreshCachedAssetsTask(ILogger<RefreshCachedAssetsTask> logger, AssetCacheService assetCache, IPluginConfigProvider configProvider)
        {
            _logger = logger;
            _assetCache = assetCache;
            _configProvider = configProvider;
        }

        public string Name => "Refresh Cached Assets";

        public string Key => "JellyfinCanopyRefreshCachedAssets";

        public string Description => "Downloads and refreshes the locally served copies of third-party assets (fonts, icons, flags, theme CSS) so browsers never contact a CDN.";

        public string Category => "Jellyfin Canopy";

        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
        {
            return new[]
            {
                new TaskTriggerInfo
                {
                    Type = TaskTriggerInfoType.StartupTrigger
                },
                new TaskTriggerInfo
                {
                    Type = TaskTriggerInfoType.IntervalTrigger,
                    IntervalTicks = TimeSpan.FromHours(24).Ticks
                }
            };
        }

        public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            if (_configProvider.ConfigurationOrNull?.AssetCacheEnabled == false)
            {
                _logger.LogInformation("[Asset Cache] Local asset serving is disabled in the plugin configuration; skipping refresh.");
                progress?.Report(100);
                return;
            }

            var summary = await _assetCache.RefreshAllAsync(progress, cancellationToken).ConfigureAwait(false);
            _logger.LogInformation(
                $"[Asset Cache] Refresh complete: {summary.Attempted} attempted, " +
                $"{summary.Succeeded} downloaded, {summary.NotModified} already current, {summary.Failed} failed.");
            progress?.Report(100);
        }
    }
}
