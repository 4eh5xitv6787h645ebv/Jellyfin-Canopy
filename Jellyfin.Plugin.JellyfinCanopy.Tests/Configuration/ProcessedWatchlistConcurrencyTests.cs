using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Configuration
{
    /// <summary>
    /// Regression net for W4-LEAK-4: the processed-watchlist file is mutated by both
    /// the event-driven <c>WatchlistMonitor</c> (off-thread <c>Task.Run</c>) and the
    /// scheduled <c>SeerrWatchlistSyncTask</c>, plus a periodic cleanup. Before the
    /// fix each did an UNLOCKED get → mutate → save, so a writer's stale-read save could
    /// clobber another writer's just-added "processed" marker (lost update → the item is
    /// re-added / re-requested → user-visible duplicate).
    ///
    /// The fix routes every mutation through <see cref="UserConfigurationManager.RmwProcessedWatchlistItems"/>,
    /// which holds the per-user file lock across the whole read-modify-write. These tests
    /// drive that primitive under heavy contention and assert NO acknowledged marker is
    /// lost. (Confirmed RED by temporarily unlocking the RMW: markers drop and the exact-
    /// count assertions fail.)
    /// </summary>
    public class ProcessedWatchlistConcurrencyTests : IDisposable
    {
        private readonly string _baseDir;
        private readonly UserConfigurationManager _manager;

        public ProcessedWatchlistConcurrencyTests()
        {
            _baseDir = Path.Combine(Path.GetTempPath(), "jc-procwl-concurrency-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_baseDir);
            _manager = new UserConfigurationManager(new StubAppPaths(_baseDir), NullLogger<UserConfigurationManager>.Instance);
        }

        public void Dispose()
        {
            try { Directory.Delete(_baseDir, recursive: true); } catch { /* best effort */ }
        }

        [Fact]
        public async Task ConcurrentRmwAppends_LoseNoMarkers()
        {
            const int writers = 8;
            const int perWriter = 50;
            var userId = Guid.NewGuid();

            var tasks = Enumerable.Range(0, writers).Select(w => Task.Run(() =>
            {
                for (int i = 0; i < perWriter; i++)
                {
                    var tmdbId = (w * 1000) + i;
                    _manager.RmwProcessedWatchlistItems(userId, items =>
                    {
                        // In-lock re-check keeps the append idempotent, matching the production mutators.
                        if (items.Items.Any(p => p.TmdbId == tmdbId && p.MediaType == "movie"))
                        {
                            return 0;
                        }

                        items.Items.Add(new ProcessedWatchlistItem
                        {
                            TmdbId = tmdbId,
                            MediaType = "movie",
                            ProcessedAt = DateTime.UtcNow,
                            Source = "test"
                        });
                        return 1;
                    });
                }
            })).ToArray();

            await Task.WhenAll(tasks);

            var final = _manager.GetProcessedWatchlistItems(userId);
            Assert.Equal(writers * perWriter, final.Items.Count);

            var distinctIds = final.Items.Select(p => p.TmdbId).ToHashSet();
            Assert.Equal(writers * perWriter, distinctIds.Count);
        }

        [Fact]
        public async Task CleanupRmw_ConcurrentWithAppends_DropsNoFreshMarker()
        {
            const int writers = 6;
            const int perWriter = 40;
            var userId = Guid.NewGuid();

            var appenders = Enumerable.Range(0, writers).Select(w => Task.Run(() =>
            {
                for (int i = 0; i < perWriter; i++)
                {
                    var tmdbId = (w * 1000) + i;
                    _manager.RmwProcessedWatchlistItems(userId, items =>
                    {
                        items.Items.Add(new ProcessedWatchlistItem
                        {
                            TmdbId = tmdbId,
                            MediaType = "movie",
                            ProcessedAt = DateTime.UtcNow,
                            Source = "test"
                        });
                        return 1;
                    });
                }
            })).ToList();

            // All appended markers are fresh, so the prune removes nothing — but it still takes
            // the per-user lock, so an unlocked prune racing an append would drop a just-added marker.
            var cleaner = Task.Run(() =>
            {
                for (int k = 0; k < 60; k++)
                {
                    _manager.CleanupOldProcessedWatchlistItems(userId, daysToKeep: 365);
                }
            });

            appenders.Add(cleaner);
            await Task.WhenAll(appenders);

            var final = _manager.GetProcessedWatchlistItems(userId);
            Assert.Equal(writers * perWriter, final.Items.Count);
        }
    }
}
