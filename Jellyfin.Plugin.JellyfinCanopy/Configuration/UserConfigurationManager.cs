using System;
using System.Collections.Generic;
using System.IO;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Configuration
{
    /// <summary>
    /// Manages per-user configuration files stored on the server.
    ///
    /// Thin facade kept for consumer compatibility (controllers, services,
    /// scheduled tasks, DI registration all keep using this type unchanged).
    /// The three responsibilities it used to mix now live in:
    ///   • <see cref="UserConfigurationStore"/> — per-user settings file IO
    ///   • <see cref="UserDirMigration"/> — one-shot case-variant dir migration
    ///   • <see cref="ReviewsStore"/> — indexed, transactional review store
    /// </summary>
    public class UserConfigurationManager
    {
        private readonly string _configBaseDir;
        private readonly ILogger<UserConfigurationManager> _logger;
        private readonly UserConfigurationStore _store;
        private readonly ReviewsStore _reviews;

        public UserConfigurationManager(IApplicationPaths appPaths, ILogger<UserConfigurationManager> logger)
        {
            _configBaseDir = Path.Combine(appPaths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinCanopy");
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
            catch (Exception ex) { _logger.LogError($"Per-user dir case-variant migration failed: {ex}"); }
        }

        // ─── Per-user settings file IO (UserConfigurationStore) ─────────────────

        public object GetUserFileLock(string userId, string fileName)
            => _store.GetUserFileLock(userId, fileName);

        public bool UserConfigurationExists(string userId, string fileName)
            => _store.UserConfigurationExists(userId, fileName);

        // Lenient read; returns new T() on missing/empty/unparseable. Write path should use GetUserConfigurationStrict.
        public T GetUserConfiguration<T>(string userId, string fileName) where T : new()
            => _store.GetUserConfiguration<T>(userId, fileName);

        // Strict read for RMW: existing empty/null/garbage enters durable quarantine and throws.
        public T GetUserConfigurationStrict<T>(string userId, string fileName) where T : new()
            => _store.GetUserConfigurationStrict<T>(userId, fileName);

        // Typed, side-effect-free policy read for security enforcement: classifies
        // Missing/Valid/Corrupt/Unavailable so callers can retain last-known-good
        // and fail closed instead of collapsing a fault into an empty policy.
        public UserConfigReadResult<T> ReadUserConfiguration<T>(string userId, string fileName) where T : new()
            => _store.ReadUserConfiguration<T>(userId, fileName);

        /// <summary>
        /// Atomically reads or initializes a user file under the store-owned
        /// per-user/per-file lock.
        /// </summary>
        public UserConfigReadResult<T> GetOrCreateUserConfiguration<T>(
            string userId,
            string fileName,
            Func<T?> create,
            Func<T, bool> isValid)
            where T : class, new()
            => _store.GetOrCreateUserConfiguration(userId, fileName, create, isValid);

        /// <summary>
        /// Runs a strict logical transaction under the same store-owned lock used
        /// by first-read initialization.
        /// </summary>
        public TResult TransactUserConfiguration<T, TResult>(
            string userId,
            string fileName,
            Func<T, TResult> transaction)
            where T : class, new()
            => _store.TransactUserConfiguration(userId, fileName, transaction);

        internal Action<UserFileLockObservation>? UserFileLockObserverForTests
        {
            get => _store.LockObserverForTests;
            set => _store.LockObserverForTests = value;
        }

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

        /// <summary>
        /// Returns durable per-user corruption markers for the elevation-gated
        /// recovery surface. No quarantined payload bytes are exposed.
        /// </summary>
        internal IReadOnlyList<UserStoreRecoveryStatus> GetUnhealthyUserStores()
            => _store.GetUnhealthyUserStores();

        /// <summary>
        /// Explicitly retires one unhealthy generation after preserving any
        /// source bytes left by an interrupted quarantine. The next ordinary
        /// access initializes the file's normal defaults.
        /// </summary>
        internal bool ResetUnhealthyUserStore(string userId, string fileName)
            => _store.ResetUnhealthyUserStore(userId, fileName);

        // ─── Indexed shared reviews (ReviewsStore) ───────────────────────────────

        internal ReviewPage GetItemReviews(string mediaType, string tmdbId, int pageSize, string? cursor)
            => _reviews.GetItemReviews(mediaType, tmdbId, pageSize, cursor);

        internal ReviewPage GetAllReviews(int pageSize, string? cursor)
            => _reviews.GetAllReviews(pageSize, cursor);

        internal UserReview? GetReview(string userIdN, string mediaType, string tmdbId)
            => _reviews.GetReview(userIdN, mediaType, tmdbId);

        /// <summary>
        /// Atomically creates or updates a user's review for a specific item.
        /// </summary>
        internal ReviewUpsertOutcome UpsertReview(string userIdN, string mediaType, string tmdbId,
                                                   string content, int? rating, string nowIso)
            => _reviews.UpsertReview(userIdN, mediaType, tmdbId, content, rating, nowIso);

        /// <summary>
        /// Atomically deletes a review identified by userIdN + mediaType + tmdbId.
        /// Returns true if a review was removed, false if no matching review existed.
        /// </summary>
        internal bool DeleteReview(string userIdN, string mediaType, string tmdbId)
            => _reviews.DeleteReview(userIdN, mediaType, tmdbId);

        internal int DeleteUserReviews(string userIdN, int maximum)
            => _reviews.DeleteUserReviews(userIdN, maximum);

        internal ReviewStoreStatus GetReviewStoreStatus()
            => _reviews.GetStatus();

        // ─── Processed watchlist convenience wrappers ────────────────────────────

        /// Gets processed watchlist items for a user.
        public ProcessedWatchlistItems GetProcessedWatchlistItems(Guid userId)
        {
            return GetUserConfiguration<ProcessedWatchlistItems>(userId.ToString(), "processed-watchlist-items.json");
        }

        /// <summary>
        /// Saves processed watchlist items for a user. This is a whole-replace,
        /// last-write-wins write (used for the first-write/full-replace case) — it does
        /// NOT serialize against a concurrent reader-mutator. For in-place marker
        /// mutations (append/prune) that can race the event monitor and the scheduled
        /// sync task, use <see cref="RmwProcessedWatchlistItems"/> instead.
        /// </summary>
        public void SaveProcessedWatchlistItems(Guid userId, ProcessedWatchlistItems items)
        {
            SaveUserConfiguration(userId.ToString(), "processed-watchlist-items.json", items);
        }

        /// <summary>
        /// Locked read-modify-write of a user's processed-watchlist file. All mutators
        /// (WatchlistMonitor + SeerrWatchlistSyncTask) MUST go through this so
        /// concurrent event/scheduled writers cannot lose each other's markers. The
        /// mutator returns the number of changes; a return of 0 skips the save.
        /// Strict-read semantics apply (a corrupt file is quarantined + throws), so callers
        /// running off the request path must catch/log/skip rather than propagate.
        /// </summary>
        public int RmwProcessedWatchlistItems(Guid userId, Func<ProcessedWatchlistItems, int> mutate)
            => RmwUserConfiguration<ProcessedWatchlistItems>(
                   userId.ToString(), "processed-watchlist-items.json", mutate);

        /// Cleans up old processed watchlist items (older than specified days).
        public void CleanupOldProcessedWatchlistItems(Guid userId, int daysToKeep = 365)
        {
            try
            {
                var cutoffDate = System.DateTime.UtcNow.AddDays(-daysToKeep);

                // Serialize the prune through the locked RMW so it can't race an append
                // from the monitor/sync task and lose a just-added marker.
                RmwProcessedWatchlistItems(userId, items =>
                {
                    var originalCount = items.Items.Count;
                    items.Items = items.Items.Where(item => item.ProcessedAt > cutoffDate).ToList();
                    var removed = originalCount - items.Items.Count;
                    if (removed > 0)
                    {
                        _logger.LogInformation($"Cleaned up {removed} old processed watchlist items for user {userId}");
                    }
                    return removed;
                });
            }
            catch (UserStoreUnhealthyException)
            {
                // The quarantine transition was logged once by the store.
            }
            catch (Exception ex)
            {
                _logger.LogError($"Error cleaning up processed watchlist items for user {userId}: {ex.Message}");
            }
        }
    }
}
