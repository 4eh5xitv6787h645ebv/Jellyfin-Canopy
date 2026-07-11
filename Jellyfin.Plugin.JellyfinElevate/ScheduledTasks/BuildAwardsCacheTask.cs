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

            Services.Awards.AwardsFetchResult result;
            try
            {
                result = await _provider.FetchAllAsync(progress, cancellationToken).ConfigureAwait(false);
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

            // TryReplaceFrom decides publication atomically: a complete run always publishes; a
            // partial run (some ceremony queries failed) publishes only when the index is still
            // empty (first install), never over an existing complete index — so a single timed-out
            // query can't erase that ceremony's awards, and it can't race the startup build.
            var published = _cache.TryReplaceFrom(result.Rows, result.Complete);
            progress?.Report(100);
            if (published)
            {
                _logger.LogInformation(
                    "[Awards] Awards cache build complete ({Completeness}): {Titles} titles indexed.",
                    result.Complete ? "full" : "partial first build", _cache.TitleCount);
            }
            else
            {
                _logger.LogWarning("[Awards] Refresh not published (empty or partial over an existing index); kept the existing index.");
            }
        }
    }
}
