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

        // Persisted scheduler identity: Jellyfin keys trigger customizations by
        // this opaque string, so it stays frozen at its pre-rename value — a
        // renamed key would silently reset every admin-customized schedule.
        public string Key => "JellyfinCanopyJellyseerrUserImport";

        public string Description => "Imports Jellyfin users not already mapped on any configured Seerr identity domain into the first configured domain, so they can use Seerr Search without visiting the Seerr UI.\n\nEvery domain's complete user map is checked before importing; an incomplete or internally ambiguous domain map suppresses the run. Configure the task triggers to run this task periodically.";

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
            var integration = SeerrIntegrationPolicy.Capture(_configProvider);
            var config = integration.Configuration;

            if (!integration.IsActive
                || config == null
                || !config.SeerrAutoImportUsers)
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

            var importConfigStamp = SeerrMutationConfigStamp.Capture(
                config,
                integration.ConfigurationRevision);
            SeerrDispatchFence dispatchFence = integration
                .CreateDispatchFence(_configProvider)
                .Restrict(() =>
                {
                    var current = _configProvider.ConfigurationOrNull;
                    return importConfigStamp.Matches(
                            current,
                            _configProvider.ConfigurationRevision)
                        && current?.SeerrAutoImportUsers == true;
                });

            _logger.LogInformation("[Seerr User Import] Starting Seerr user import task...");
            progress?.Report(0);

            var urls = SeerrClient.GetConfiguredUrls(config.SeerrUrls);
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
                userIds,
                urls,
                config.SeerrApiKey,
                _httpClientFactory,
                _logger,
                dispatchFence,
                cancellationToken);

            if (importResult.Succeeded && importResult.Imported > 0)
            {
                // Only flush caches when at least one user was actually
                // imported — otherwise a 0-imported partial-failure run wipes
                // every healthy cache entry.
                _seerrCache.ClearUserCaches();
            }

            if (importResult.Succeeded)
            {
                _logger.LogInformation($"[Seerr User Import] Completed on {importResult.SourceUrl}. {importResult.Imported} new user(s) imported after evaluating {userIds.Count} eligible candidate(s).");
            }
            else
            {
                _logger.LogWarning("[Seerr User Import] User-map preflight or import outcome was incomplete; no mutation was replayed elsewhere.");
            }

            progress?.Report(100);
        }
    }
}
