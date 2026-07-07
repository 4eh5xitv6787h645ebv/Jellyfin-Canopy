using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Model.Tasks;
using Jellyfin.Plugin.JellyfinElevate.Services;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinElevate.ScheduledTasks
{
    /// Scheduled task that signals all clients to clear cached translations on next page load.
    public partial class ClearTranslationCacheTask : IScheduledTask
    {
        private readonly ILogger<ClearTranslationCacheTask> _logger;
        private readonly IPluginConfigProvider _configProvider;

        public ClearTranslationCacheTask(ILogger<ClearTranslationCacheTask> logger, IPluginConfigProvider configProvider)
        {
            _logger = logger;
            _configProvider = configProvider;
        }

        public string Name => "Refresh Translation Cache";

        public string Key => "JellyfinElevateClearTranslationCache";

        public string Description => "Signals all clients to refresh cached translations on next page load. Runs on startup to ensure fresh translations after plugin updates.";

        public string Category => "Jellyfin Elevate";

        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
        {
            return new[]
            {
                new TaskTriggerInfo
                {
                    Type = TaskTriggerInfoType.StartupTrigger
                }
            };
        }

        public Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            var config = _configProvider.ConfigurationOrNull;
            if (config == null)
            {
                _logger.LogWarning("[Clear Translation Cache] Plugin configuration is not available.");
                progress?.Report(100);
                return Task.CompletedTask;
            }

            config.ClearTranslationCacheTimestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            JellyfinElevate.Instance!.SaveConfiguration();

            _logger.LogInformation($"[Clear Translation Cache] Translation cache clear signal set at {new DateTimeOffset(DateTimeOffset.FromUnixTimeMilliseconds(config.ClearTranslationCacheTimestamp).DateTime, TimeSpan.Zero):O}. All clients will clear their translation cache on next page load.");

            progress?.Report(100);
            return Task.CompletedTask;
        }
    }
}
