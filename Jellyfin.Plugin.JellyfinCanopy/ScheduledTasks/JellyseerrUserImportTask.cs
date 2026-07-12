using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Jellyseerr;
using Jellyfin.Plugin.JellyfinCanopy.Services.Jellyseerr;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.ScheduledTasks
{
    public class JellyseerrUserImportTask : IScheduledTask
    {
        private readonly IUserManager _userManager;
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly ILogger<JellyseerrUserImportTask> _logger;
        private readonly ISeerrCache _seerrCache;
        private readonly IPluginConfigProvider _configProvider;

        public JellyseerrUserImportTask(
            IUserManager userManager,
            IHttpClientFactory httpClientFactory,
            ILogger<JellyseerrUserImportTask> logger,
            ISeerrCache seerrCache,
            IPluginConfigProvider configProvider)
        {
            _userManager = userManager;
            _httpClientFactory = httpClientFactory;
            _logger = logger;
            _seerrCache = seerrCache;
            _configProvider = configProvider;
        }

        public string Name => "Import Jellyfin Users to Seerr";

        public string Key => "JellyfinCanopyJellyseerrUserImport";

        public string Description => "Imports all Jellyfin users into Seerr so they can use Seerr Search without needing to visit the Seerr UI.\n\nAlready imported users are automatically skipped. Configure the task triggers to run this task periodically.";

        public string Category => "Jellyfin Canopy";

        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
        {
            return new[]
            {
                new TaskTriggerInfo
                {
                    Type = TaskTriggerInfoType.IntervalTrigger,
                    IntervalTicks = TimeSpan.FromHours(6).Ticks
                }
            };
        }

        public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            var config = _configProvider.ConfigurationOrNull;

            if (config == null || !config.JellyseerrAutoImportUsers || !config.JellyseerrEnabled)
            {
                _logger.LogInformation("[Jellyseerr User Import] Auto-import is disabled in plugin configuration.");
                progress?.Report(100);
                return;
            }

            if (string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.JellyseerrApiKey))
            {
                _logger.LogWarning("[Jellyseerr User Import] Jellyseerr URL or API key not configured.");
                progress?.Report(100);
                return;
            }

            _logger.LogInformation("[Jellyseerr User Import] Starting Jellyseerr user import task...");
            progress?.Report(0);

            var urls = config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            var jellyfinUsers = _userManager.GetUsers().ToList();
            var blockedIds = JellyseerrUserImportHelper.GetBlockedUserIds(config.JellyseerrImportBlockedUsers);
            var userIds = jellyfinUsers
                .Select(u => u.Id.ToString().Replace("-", ""))
                .Where(id => !blockedIds.Contains(id))
                .ToList();

            _logger.LogInformation($"[Jellyseerr User Import] Found {jellyfinUsers.Count} Jellyfin users ({userIds.Count} after excluding {blockedIds.Count} blocked).");
            progress?.Report(25);

            cancellationToken.ThrowIfCancellationRequested();
            var importResult = await JellyseerrUserImportHelper.BulkImportAsync(
                userIds, urls, config.JellyseerrApiKey, _httpClientFactory, _logger, cancellationToken);

            if (importResult.Reached && importResult.Imported > 0)
            {
                // Only flush caches when at least one user was actually
                // imported — otherwise a 0-imported partial-failure run wipes
                // every healthy cache entry.
                _seerrCache.ClearUserCaches();
            }

            if (importResult.Reached)
            {
                _logger.LogInformation($"[Jellyseerr User Import] Completed. {importResult.Imported} new user(s) imported out of {userIds.Count} sent. Errors: {importResult.Errors.Count}");
            }
            else
            {
                _logger.LogWarning("[Jellyseerr User Import] Import failed on all configured Jellyseerr URLs.");
            }

            progress?.Report(100);
        }
    }
}
