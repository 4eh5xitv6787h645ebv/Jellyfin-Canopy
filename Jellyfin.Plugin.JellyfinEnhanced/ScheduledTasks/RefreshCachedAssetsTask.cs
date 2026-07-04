using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks
{
    /// <summary>
    /// Refreshes the local mirror of every third-party asset in the
    /// <see cref="AssetCacheManifest"/> (fonts, icon sets, flags, theme CSS, data files) so
    /// browsers are served exclusively from /JellyfinEnhanced/assets/*. Default cadence:
    /// on startup plus every 24 hours — admins can retune it in Jellyfin's task scheduler.
    /// Refreshes use conditional GETs (ETag/Last-Modified) where upstream offers them, and a
    /// single failing asset never aborts the rest of the run.
    /// </summary>
    public class RefreshCachedAssetsTask : IScheduledTask
    {
        private readonly ILogger<RefreshCachedAssetsTask> _logger;
        private readonly AssetCacheService _assetCache;

        public RefreshCachedAssetsTask(ILogger<RefreshCachedAssetsTask> logger, AssetCacheService assetCache)
        {
            _logger = logger;
            _assetCache = assetCache;
        }

        public string Name => "Refresh Cached Assets";

        public string Key => "JellyfinEnhancedRefreshCachedAssets";

        public string Description => "Downloads and refreshes the locally served copies of third-party assets (fonts, icons, flags, theme CSS) so browsers never contact a CDN.";

        public string Category => "Jellyfin Enhanced";

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
            var summary = await _assetCache.RefreshAllAsync(progress, cancellationToken).ConfigureAwait(false);
            _logger.LogInformation(
                $"[Asset Cache] Refresh complete: {summary.Attempted} attempted, " +
                $"{summary.Succeeded} downloaded, {summary.NotModified} already current, {summary.Failed} failed.");
            progress?.Report(100);
        }
    }
}
