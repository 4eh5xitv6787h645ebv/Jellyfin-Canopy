using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.ScheduledTasks
{
    public class SeerrUserImportTask : IScheduledTask
    {
        private readonly IUserManager _userManager;
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly ILogger<SeerrUserImportTask> _logger;
        private readonly ISeerrCache _seerrCache;
        private readonly IPluginConfigProvider _configProvider;

        public SeerrUserImportTask(
            IUserManager userManager,
            IHttpClientFactory httpClientFactory,
            ILogger<SeerrUserImportTask> logger,
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

        public string Key => "JellyfinCanopySeerrUserImport";

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

            if (config == null || !config.SeerrAutoImportUsers || !config.SeerrEnabled)
            {
                _logger.LogInformation("[Seerr User Import] Auto-import is disabled in plugin configuration.");
                progress?.Report(100);
                return;
            }

            if (string.IsNullOrEmpty(config.SeerrUrls) || string.IsNullOrEmpty(config.SeerrApiKey))
            {
                _logger.LogWarning("[Seerr User Import] Seerr URL or API key not configured.");
                progress?.Report(100);
                return;
            }

            _logger.LogInformation("[Seerr User Import] Starting Seerr user import task...");
            progress?.Report(0);

            var urls = config.SeerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            var jellyfinUsers = _userManager.GetUsers().ToList();
            var blockedIds = SeerrUserImportHelper.GetBlockedUserIds(config.SeerrImportBlockedUsers);
            var userIds = jellyfinUsers
                .Select(u => u.Id.ToString().Replace("-", ""))
                .Where(id => !blockedIds.Contains(id))
                .ToList();

            _logger.LogInformation($"[Seerr User Import] Found {jellyfinUsers.Count} Jellyfin users ({userIds.Count} after excluding {blockedIds.Count} blocked).");
            progress?.Report(25);

            cancellationToken.ThrowIfCancellationRequested();
            var importResult = await SeerrUserImportHelper.BulkImportAsync(
                userIds, urls, config.SeerrApiKey, _httpClientFactory, _logger, cancellationToken);

            if (importResult.Reached && importResult.Imported > 0)
            {
                // Only flush caches when at least one user was actually
                // imported — otherwise a 0-imported partial-failure run wipes
                // every healthy cache entry.
                _seerrCache.ClearUserCaches();
            }

            if (importResult.Reached)
            {
                _logger.LogInformation($"[Seerr User Import] Completed. {importResult.Imported} new user(s) imported out of {userIds.Count} sent. Errors: {importResult.Errors.Count}");
            }
            else
            {
                _logger.LogWarning("[Seerr User Import] Import failed on all configured Seerr URLs.");
            }

            progress?.Report(100);
        }
    }
}
