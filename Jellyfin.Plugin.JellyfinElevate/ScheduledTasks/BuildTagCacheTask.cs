using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinElevate.Services;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinElevate.ScheduledTasks
{
    /// <summary>
    /// Scheduled task that builds the server-side tag cache for all library items.
    /// Runs daily at 3 AM. Can also be run manually from the admin dashboard.
    /// On startup, the cache is loaded from disk instead (TagCacheMonitor handles
    /// any items added/changed while the server was off via Jellyfin's library scan events).
    /// </summary>
    public class BuildTagCacheTask : IScheduledTask
    {
        private readonly TagCacheService _tagCacheService;
        private readonly TagCacheMonitor _tagCacheMonitor;
        private readonly ILogger<BuildTagCacheTask> _logger;

        public BuildTagCacheTask(TagCacheService tagCacheService, TagCacheMonitor tagCacheMonitor, ILogger<BuildTagCacheTask> logger)
        {
            _tagCacheService = tagCacheService;
            _tagCacheMonitor = tagCacheMonitor;
            _logger = logger;
        }

        public string Name => "Build Tag Cache";

        public string Key => "JellyfinElevateBuildTagCache";

        public string Description => "Pre-computes tag data (genres, ratings, languages, quality stream info) for all library items. Clients load this cache in a single request instead of making per-page API calls. Run this manually after first install to build the initial cache.";

        public string Category => "Jellyfin Elevate";

        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
        {
            return new[]
            {
                new TaskTriggerInfo
                {
                    Type = TaskTriggerInfoType.DailyTrigger,
                    TimeOfDayTicks = TimeSpan.FromHours(3).Ticks
                }
            };
        }

        public Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            _tagCacheService.BuildFullCache(progress, cancellationToken);
            // Ensure the monitor is subscribed to events after the first build
            _tagCacheMonitor.EnsureSubscribed();
            return Task.CompletedTask;
        }
    }
}
