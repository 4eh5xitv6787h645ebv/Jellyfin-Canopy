using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinElevate.Services.Awards;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinElevate.ScheduledTasks
{
    /// <summary>
    /// Rebuilds the global awards index from the awards provider (Wikidata). Runs on an
    /// infrequent cadence — every 7 days by default — because award data changes rarely
    /// (a handful of new results per ceremony each year). There is deliberately NO startup
    /// trigger: the index is loaded from disk on startup and only built there if it has
    /// never been populated, so restarting the server never re-fetches. Admins can retune
    /// the cadence or run it manually from Jellyfin's Scheduled Tasks dashboard.
    ///
    /// The whole run is one bounded set of bulk queries independent of library size, so it
    /// costs the same for a 200-title library as for a 15,000-title one.
    /// </summary>
    public sealed class BuildAwardsCacheTask : IScheduledTask
    {
        private readonly IAwardsProvider _provider;
        private readonly AwardsCacheService _cache;
        private readonly ILogger<BuildAwardsCacheTask> _logger;

        public BuildAwardsCacheTask(IAwardsProvider provider, AwardsCacheService cache, ILogger<BuildAwardsCacheTask> logger)
        {
            _provider = provider;
            _cache = cache;
            _logger = logger;
        }

        public string Name => "Build Awards Cache";

        public string Key => "JellyfinElevateBuildAwardsCache";

        public string Description => "Rebuilds the awards index (wins and nominations from the Oscars, Golden Globes, BAFTA, Cannes, Venice, Berlin, SAG, Critics' Choice and the Emmys) from Wikidata. One bulk fetch, independent of library size, matched to items locally by IMDb/TMDb id. Runs weekly; run it manually once after enabling the Awards feature.";

        public string Category => "Jellyfin Elevate";

        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
        {
            return new[]
            {
                new TaskTriggerInfo
                {
                    Type = TaskTriggerInfoType.IntervalTrigger,
                    IntervalTicks = TimeSpan.FromDays(7).Ticks
                }
            };
        }

        public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            _logger.LogInformation("[Awards] Building awards cache from provider...");
            progress?.Report(0);

            IReadOnlyList<Model.Awards.AwardRow> rows;
            try
            {
                rows = await _provider.FetchAllAsync(progress, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                // Keep the previous (disk-loaded) index rather than wiping it on a transient
                // fetch failure — a stale index is far better than an empty one.
                _logger.LogError("[Awards] Awards fetch failed; keeping the existing index. {Message}", ex.Message);
                progress?.Report(100);
                return;
            }

            if (rows.Count == 0)
            {
                _logger.LogWarning("[Awards] Provider returned no rows; keeping the existing index rather than clearing it.");
                progress?.Report(100);
                return;
            }

            _cache.ReplaceFrom(rows);
            progress?.Report(100);
            _logger.LogInformation("[Awards] Awards cache build complete: {Titles} titles indexed.", _cache.TitleCount);
        }
    }
}
