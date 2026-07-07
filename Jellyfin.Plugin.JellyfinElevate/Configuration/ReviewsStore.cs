using System;
using System.IO;
using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinElevate.Configuration
{
    /// <summary>
    /// Server-wide shared reviews store (reviews.json), split out of
    /// UserConfigurationManager (which remains as a thin facade).
    /// All public operations run inside a single static critical section,
    /// preserving the original locking semantics: the lock is static so
    /// every instance (however constructed by DI) serializes on one lock.
    /// </summary>
    internal class ReviewsStore
    {
        private static readonly object _reviewsFileLock = new object();

        private readonly string _configBaseDir;
        private readonly ILogger _logger;

        public ReviewsStore(string configBaseDir, ILogger logger)
        {
            _configBaseDir = configBaseDir;
            _logger = logger;
        }

        private string ReviewsFilePath => Path.Combine(_configBaseDir, "reviews.json");

        /// <summary>
        /// Reads the reviews store. Caller MUST hold _reviewsFileLock.
        /// </summary>
        /// <param name="throwOnCorruption">
        /// When true (the write path), a parse or I/O failure on an
        /// EXISTING file throws instead of returning an empty store. This
        /// is critical: if a transient read failure on `reviews.json`
        /// silently returned empty, the very next `WriteStoreUnlocked`
        /// would overwrite every server review with `{ "Reviews": {} }`,
        /// turning a transient glitch into permanent data loss. A missing
        /// file is still treated as "empty" because that is the first-ever
        /// write case.
        /// </param>
        private AllReviewsStore ReadStoreUnlocked(bool throwOnCorruption = false)
        {
            var filePath = ReviewsFilePath;
            // A truly missing file is the legitimate first-write case and
            // is always treated as empty, even on the write path.
            if (!File.Exists(filePath)) return new AllReviewsStore();

            string json;
            try
            {
                json = File.ReadAllText(filePath);
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to read shared reviews.json: {ex.Message}");
                if (throwOnCorruption)
                {
                    BackupCorruptFileUnlocked(filePath);
                    throw;
                }
                return new AllReviewsStore();
            }

            // On the WRITE path: an existing file that is empty, whitespace,
            // or literal JSON `null` is suspicious — it's the exact shape a
            // previous crashed/interrupted write would leave behind, and
            // returning empty here would let the next UpsertReview overwrite
            // the file with a one-review store, losing every other review.
            // Treat those states as corruption and throw so the admin finds out.
            if (throwOnCorruption)
            {
                if (string.IsNullOrWhiteSpace(json) ||
                    string.Equals(json.Trim(), "null", StringComparison.Ordinal))
                {
                    _logger.LogError($"reviews.json exists but is empty or literal-null; refusing to write over it. Length={json?.Length ?? 0}");
                    BackupCorruptFileUnlocked(filePath);
                    throw new InvalidDataException("reviews.json is empty or literal null; refusing to overwrite.");
                }
            }
            else
            {
                // Read-only callers accept empty/null as "no reviews".
                if (string.IsNullOrWhiteSpace(json)) return new AllReviewsStore();
            }

            try
            {
                // Newtonsoft equivalent: JsonConvert.DeserializeObject<AllReviewsStore>(json)
                // with default settings (no null-skipping — this store has no
                // non-nullable members a null could break).
                var parsed = JsonSerializer.Deserialize<AllReviewsStore>(json, PersistedJson.ReadOptions);
                if (parsed == null)
                {
                    if (throwOnCorruption)
                    {
                        _logger.LogError("reviews.json deserialized to null; refusing to write over it.");
                        BackupCorruptFileUnlocked(filePath);
                        throw new InvalidDataException("reviews.json deserialized to null.");
                    }
                    return new AllReviewsStore();
                }
                return parsed;
            }
            catch (InvalidDataException)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to parse shared reviews.json: {ex.Message}");
                if (throwOnCorruption)
                {
                    BackupCorruptFileUnlocked(filePath);
                    throw;
                }
                return new AllReviewsStore();
            }
        }

        /// <summary>
        /// Preserves a corrupt reviews.json for forensic recovery. Caller
        /// MUST hold _reviewsFileLock. Never throws — backup failure is
        /// logged separately but doesn't mask the original error.
        /// </summary>
        private void BackupCorruptFileUnlocked(string filePath)
        {
            try
            {
                var backupPath = filePath + ".corrupt-" + DateTime.UtcNow.ToString("yyyyMMddHHmmss");
                if (!File.Exists(backupPath))
                    File.Copy(filePath, backupPath);
                _logger.LogWarning($"Corrupt reviews.json backed up to {backupPath}");
            }
            catch (Exception backupEx)
            {
                _logger.LogError($"Failed to back up corrupt reviews.json: {backupEx.Message}");
            }
        }

        /// <summary>
        /// Writes the reviews store. Caller MUST hold _reviewsFileLock.
        /// Logs the specific failure context before rethrowing so the
        /// server log distinguishes "disk write failed" from generic
        /// controller-level errors.
        /// </summary>
        private void WriteStoreUnlocked(AllReviewsStore store)
        {
            try
            {
                // Newtonsoft equivalent: JsonConvert.SerializeObject(store, Formatting.Indented).
                var json = JsonSerializer.Serialize(store, PersistedJson.WriteOptions);
                AtomicFile.WriteAllText(ReviewsFilePath, json);
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to save shared reviews.json: {ex.Message}");
                throw;
            }
        }

        /// Reads the server-wide reviews store from the shared reviews.json file.
        public AllReviewsStore GetAllReviews()
        {
            lock (_reviewsFileLock)
            {
                return ReadStoreUnlocked();
            }
        }

        /// <summary>
        /// Atomically creates or updates a user's review for a specific item.
        /// The read-modify-write happens inside a single critical section so
        /// concurrent upserts from different users cannot cause lost updates.
        /// </summary>
        public void UpsertReview(string userIdN, string mediaType, string tmdbId,
                                 string content, int? rating, string nowIso)
        {
            lock (_reviewsFileLock)
            {
                // Use throwOnCorruption so we NEVER overwrite an unreadable
                // reviews.json with a fresh single-review store — that would
                // silently wipe every other user's review on a transient
                // read failure.
                var store = ReadStoreUnlocked(throwOnCorruption: true);
                var key = $"{userIdN}:{mediaType}:{tmdbId}";

                if (store.Reviews.TryGetValue(key, out var existing))
                {
                    existing.Content = content;
                    existing.Rating = rating;
                    existing.UpdatedAt = nowIso;
                }
                else
                {
                    store.Reviews[key] = new UserReview
                    {
                        UserId = userIdN,
                        TmdbId = tmdbId,
                        MediaType = mediaType,
                        Content = content,
                        Rating = rating,
                        CreatedAt = nowIso,
                        UpdatedAt = nowIso
                    };
                }

                WriteStoreUnlocked(store);
            }
        }

        /// <summary>
        /// Atomically deletes a review identified by userIdN + mediaType + tmdbId.
        /// Returns true if a review was removed, false if no matching review existed.
        /// </summary>
        public bool DeleteReview(string userIdN, string mediaType, string tmdbId)
        {
            lock (_reviewsFileLock)
            {
                // Same reasoning as UpsertReview — refuse to rewrite a
                // corrupt file.
                var store = ReadStoreUnlocked(throwOnCorruption: true);
                var key = $"{userIdN}:{mediaType}:{tmdbId}";
                if (!store.Reviews.Remove(key)) return false;
                WriteStoreUnlocked(store);
                return true;
            }
        }
    }
}
