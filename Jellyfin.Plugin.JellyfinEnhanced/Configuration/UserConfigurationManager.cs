using System;
using System.IO;
using MediaBrowser.Common.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Configuration
{
    /// <summary>
    /// Manages per-user configuration files stored on the server.
    ///
    /// Thin facade kept for consumer compatibility (controllers, services,
    /// scheduled tasks, DI registration all keep using this type unchanged).
    /// The three responsibilities it used to mix now live in:
    ///   • <see cref="UserConfigurationStore"/> — per-user settings file IO
    ///   • <see cref="UserDirMigration"/> — one-shot case-variant dir migration
    ///   • <see cref="ReviewsStore"/> — shared reviews.json store
    /// </summary>
    public class UserConfigurationManager
    {
        private readonly string _configBaseDir;
        private readonly Logger _logger;
        private readonly UserConfigurationStore _store;
        private readonly ReviewsStore _reviews;

        public UserConfigurationManager(IApplicationPaths appPaths, Logger logger)
        {
            _configBaseDir = Path.Combine(appPaths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced");
            Directory.CreateDirectory(_configBaseDir);
            _logger = logger;
            _store = new UserConfigurationStore(_configBaseDir, logger);
            _reviews = new ReviewsStore(_configBaseDir, logger);

            // One-shot migration: pre-fix callers normalized user IDs case-sensitively
            // (only stripped hyphens), so the same logical user could land in
            // {abcd...}, {ABCD...}, AND {abcd-...} folders. Different request paths
            // hit different folders, so per-user settings appeared to "drift" — see
            // PR #573 thread. Idempotent; cheap when there's nothing to migrate.
            try { new UserDirMigration(_configBaseDir, logger).MigrateCaseVariantUserDirs(); }
            catch (Exception ex) { _logger.Error($"Per-user dir case-variant migration failed: {ex}"); }
        }

        // ─── Per-user settings file IO (UserConfigurationStore) ─────────────────

        public object GetUserFileLock(string userId, string fileName)
            => _store.GetUserFileLock(userId, fileName);

        public bool UserConfigurationExists(string userId, string fileName)
            => _store.UserConfigurationExists(userId, fileName);

        // Lenient read; returns new T() on missing/empty/unparseable. Write path should use GetUserConfigurationStrict.
        public T GetUserConfiguration<T>(string userId, string fileName) where T : new()
            => _store.GetUserConfiguration<T>(userId, fileName);

        // Strict read for RMW: existing empty/null/garbage is corruption; backs up to .corrupt-{ts} and throws.
        public T GetUserConfigurationStrict<T>(string userId, string fileName) where T : new()
            => _store.GetUserConfigurationStrict<T>(userId, fileName);

        // Locked read-modify-write: holds GetUserFileLock, strict-reads, mutates, and saves when the mutator returns > 0.
        public int RmwUserConfiguration<T>(string userId, string fileName, Func<T, int> mutate) where T : class, new()
            => _store.RmwUserConfiguration(userId, fileName, mutate);

        // Atomic save via temp file + File.Move(overwrite). RMW callers must hold GetUserFileLock.
        public void SaveUserConfiguration(string userId, string fileName, object config)
            => _store.SaveUserConfiguration(userId, fileName, config);

        /// <summary>
        /// Gets all canonical user IDs that have configuration directories.
        /// Filters out non-user folders so admin operations like
        /// "Reset to defaults" only iterate real users.
        /// </summary>
        public string[] GetAllUserIds()
            => _store.GetAllUserIds();

        // ─── Shared reviews file (ReviewsStore) ──────────────────────────────────

        /// Reads the server-wide reviews store from the shared reviews.json file.
        public AllReviewsStore GetAllReviews()
            => _reviews.GetAllReviews();

        /// <summary>
        /// Atomically creates or updates a user's review for a specific item.
        /// </summary>
        public void UpsertReview(string userIdN, string mediaType, string tmdbId,
                                 string content, int? rating, string nowIso)
            => _reviews.UpsertReview(userIdN, mediaType, tmdbId, content, rating, nowIso);

        /// <summary>
        /// Atomically deletes a review identified by userIdN + mediaType + tmdbId.
        /// Returns true if a review was removed, false if no matching review existed.
        /// </summary>
        public bool DeleteReview(string userIdN, string mediaType, string tmdbId)
            => _reviews.DeleteReview(userIdN, mediaType, tmdbId);

        // ─── Processed watchlist convenience wrappers ────────────────────────────

        /// Gets processed watchlist items for a user.
        public ProcessedWatchlistItems GetProcessedWatchlistItems(Guid userId)
        {
            return GetUserConfiguration<ProcessedWatchlistItems>(userId.ToString(), "processed-watchlist-items.json");
        }

        /// Saves processed watchlist items for a user.
        public void SaveProcessedWatchlistItems(Guid userId, ProcessedWatchlistItems items)
        {
            SaveUserConfiguration(userId.ToString(), "processed-watchlist-items.json", items);
        }

        /// Cleans up old processed watchlist items (older than specified days).
        public void CleanupOldProcessedWatchlistItems(Guid userId, int daysToKeep = 365)
        {
            try
            {
                var items = GetProcessedWatchlistItems(userId);
                var cutoffDate = System.DateTime.UtcNow.AddDays(-daysToKeep);

                var originalCount = items.Items.Count;
                var itemsToKeep = items.Items.Where(item => item.ProcessedAt > cutoffDate).ToList();

                if (itemsToKeep.Count != originalCount)
                {
                    items.Items = itemsToKeep;
                    SaveProcessedWatchlistItems(userId, items);
                    _logger.Info($"Cleaned up {originalCount - itemsToKeep.Count} old processed watchlist items for user {userId}");
                }
            }
            catch (Exception ex)
            {
                _logger.Error($"Error cleaning up processed watchlist items for user {userId}: {ex.Message}");
            }
        }
    }
}
