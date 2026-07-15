using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Configuration
{
    /// <summary>
    /// Indexed, transactional server-wide review persistence. The SQLite file is
    /// authoritative once created; reviews.json is only a bounded, one-time import.
    /// Connections are short-lived and unpooled so plugin unload never leaves a
    /// provider pool holding the database or its WAL open.
    /// </summary>
    internal sealed class ReviewsStore
    {
        private const string DatabaseFileName = "reviews.db";
        private const string LegacyFileName = "reviews.json";
        private static readonly object InitializationLock = new object();

        private readonly string _configBaseDir;
        private readonly ILogger _logger;
        private volatile bool _ready;
        private Exception? _initializationError;

        public ReviewsStore(string configBaseDir, ILogger logger)
        {
            _configBaseDir = configBaseDir;
            _logger = logger;
        }

        private string DatabasePath => Path.Combine(_configBaseDir, DatabaseFileName);

        private string LegacyPath => Path.Combine(_configBaseDir, LegacyFileName);

        public ReviewPage GetItemReviews(string mediaType, string target, int pageSize, string? cursor)
        {
            EnsureReady();
            var boundedSize = NormalizePageSize(pageSize);
            var afterUserId = DecodeItemCursor(cursor);

            using var connection = OpenConnection(readOnly: true);
            using var command = connection.CreateCommand();
            command.CommandText = """
                SELECT UserId, MediaType, Target, Content, Rating, CreatedAt, UpdatedAt
                FROM Reviews
                WHERE MediaType = $mediaType
                  AND Target = $target
                  AND UserId > $afterUserId
                ORDER BY UserId
                LIMIT $limit;
                """;
            command.Parameters.AddWithValue("$mediaType", mediaType);
            command.Parameters.AddWithValue("$target", target);
            command.Parameters.AddWithValue("$afterUserId", afterUserId);
            command.Parameters.AddWithValue("$limit", boundedSize + 1);

            var reviews = ReadReviews(command, boundedSize + 1);
            return BuildPage(reviews, boundedSize, review => EncodeCursor(review.UserId));
        }

        public ReviewPage GetAllReviews(int pageSize, string? cursor)
        {
            EnsureReady();
            var boundedSize = NormalizePageSize(pageSize);
            var after = DecodeAdminCursor(cursor);

            using var connection = OpenConnection(readOnly: true);
            using var command = connection.CreateCommand();
            command.CommandText = """
                SELECT UserId, MediaType, Target, Content, Rating, CreatedAt, UpdatedAt
                FROM Reviews
                WHERE (UserId, MediaType, Target) > ($userId, $mediaType, $target)
                ORDER BY UserId, MediaType, Target
                LIMIT $limit;
                """;
            command.Parameters.AddWithValue("$userId", after.UserId);
            command.Parameters.AddWithValue("$mediaType", after.MediaType);
            command.Parameters.AddWithValue("$target", after.Target);
            command.Parameters.AddWithValue("$limit", boundedSize + 1);

            var reviews = ReadReviews(command, boundedSize + 1);
            return BuildPage(
                reviews,
                boundedSize,
                review => EncodeCursor(review.UserId + "\0" + review.MediaType + "\0" + review.TmdbId));
        }

        public UserReview? GetReview(string userIdN, string mediaType, string target)
        {
            EnsureReady();
            using var connection = OpenConnection(readOnly: true);
            using var command = connection.CreateCommand();
            command.CommandText = """
                SELECT UserId, MediaType, Target, Content, Rating, CreatedAt, UpdatedAt
                FROM Reviews
                WHERE UserId = $userId AND MediaType = $mediaType AND Target = $target;
                """;
            command.Parameters.AddWithValue("$userId", userIdN);
            command.Parameters.AddWithValue("$mediaType", mediaType);
            command.Parameters.AddWithValue("$target", target);
            using var reader = command.ExecuteReader();
            return reader.Read() ? ReadReview(reader) : null;
        }

        public ReviewUpsertOutcome UpsertReview(
            string userIdN,
            string mediaType,
            string target,
            string content,
            int? rating,
            string nowIso)
        {
            EnsureReady();
            using var connection = OpenConnection(readOnly: false);
            using var transaction = connection.BeginTransaction(deferred: false);

            var exists = ReviewExists(connection, transaction, userIdN, mediaType, target);
            if (exists)
            {
                using var update = connection.CreateCommand();
                update.Transaction = transaction;
                update.CommandText = """
                    UPDATE Reviews
                    SET Content = $content, Rating = $rating, UpdatedAt = $updatedAt
                    WHERE UserId = $userId AND MediaType = $mediaType AND Target = $target;
                    """;
                AddReviewMutationParameters(update, userIdN, mediaType, target, content, rating, nowIso);
                update.ExecuteNonQuery();
                transaction.Commit();
                return ReviewUpsertOutcome.Updated;
            }

            EnforceCreateQuota(connection, transaction, userIdN);
            using var insert = connection.CreateCommand();
            insert.Transaction = transaction;
            insert.CommandText = """
                INSERT INTO Reviews (UserId, MediaType, Target, Content, Rating, CreatedAt, UpdatedAt)
                VALUES ($userId, $mediaType, $target, $content, $rating, $updatedAt, $updatedAt);
                """;
            AddReviewMutationParameters(insert, userIdN, mediaType, target, content, rating, nowIso);
            insert.ExecuteNonQuery();
            transaction.Commit();
            return ReviewUpsertOutcome.Created;
        }

        public bool DeleteReview(string userIdN, string mediaType, string target)
        {
            EnsureReady();
            using var connection = OpenConnection(readOnly: false);
            using var transaction = connection.BeginTransaction(deferred: false);
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = """
                DELETE FROM Reviews
                WHERE UserId = $userId AND MediaType = $mediaType AND Target = $target;
                """;
            command.Parameters.AddWithValue("$userId", userIdN);
            command.Parameters.AddWithValue("$mediaType", mediaType);
            command.Parameters.AddWithValue("$target", target);
            var removed = command.ExecuteNonQuery() == 1;
            transaction.Commit();
            return removed;
        }

        public int DeleteUserReviews(string userIdN, int maximum)
        {
            EnsureReady();
            var boundedMaximum = Math.Clamp(maximum, 1, ReviewLimits.MaximumPageSize);
            using var connection = OpenConnection(readOnly: false);
            using var transaction = connection.BeginTransaction(deferred: false);
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = """
                DELETE FROM Reviews
                WHERE (UserId, MediaType, Target) IN (
                    SELECT UserId, MediaType, Target
                    FROM Reviews
                    WHERE UserId = $userId
                    ORDER BY MediaType, Target
                    LIMIT $limit
                );
                """;
            command.Parameters.AddWithValue("$userId", userIdN);
            command.Parameters.AddWithValue("$limit", boundedMaximum);
            var removed = command.ExecuteNonQuery();
            transaction.Commit();
            return removed;
        }

        public ReviewStoreStatus GetStatus()
        {
            EnsureReady();
            using var connection = OpenConnection(readOnly: true);
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT TotalCount FROM ReviewStats WHERE Id = 1;";
            return new ReviewStoreStatus { TotalReviews = Convert.ToInt64(command.ExecuteScalar(), CultureInfo.InvariantCulture) };
        }

        private void EnsureReady()
        {
            if (_ready)
            {
                return;
            }

            lock (InitializationLock)
            {
                if (_ready)
                {
                    return;
                }

                if (_initializationError != null)
                {
                    throw new ReviewStoreUnavailableException("The review store is unavailable.", _initializationError);
                }

                try
                {
                    Directory.CreateDirectory(_configBaseDir);
                    CleanupStaleArtifacts();
                    if (File.Exists(DatabasePath))
                    {
                        ValidateExistingDatabaseOrRecover();
                        ArchiveLingeringLegacyFile();
                    }
                    else if (HasDatabaseBackups())
                    {
                        // Recovery may have been interrupted after quarantining
                        // the primary but before restoring it. Never treat that
                        // crash state as a first run and publish an empty store.
                        if (!TryRestoreLatestBackup())
                        {
                            throw new InvalidDataException("The primary review database is missing and no valid bounded backup is available.");
                        }

                        // Backups prove a database was previously authoritative,
                        // so any legacy JSON still present is a stale crash relic.
                        ArchiveLingeringLegacyFile();
                    }
                    else if (File.Exists(LegacyPath))
                    {
                        MigrateLegacyJson();
                    }
                    else
                    {
                        CreateEmptyDatabase(DatabasePath);
                    }

                    using (var connection = OpenConnection(readOnly: false))
                    {
                        CreateSchema(connection);
                        VerifyAndRepairCounters(connection);
                        VerifyQuickCheck(connection);
                    }

                    CreateBoundedBackup();
                    _ready = true;
                    _logger.LogInformation("Indexed review store is ready.");
                }
                catch (Exception ex)
                {
                    _initializationError = ex;
                    _logger.LogError(ex, "Indexed review store initialization failed; review operations will return unavailable.");
                    throw new ReviewStoreUnavailableException("The review store is unavailable.", ex);
                }
            }
        }

        private void ValidateExistingDatabaseOrRecover()
        {
            try
            {
                using var connection = OpenConnection(readOnly: false);
                CreateSchema(connection);
                VerifyQuickCheck(connection);
            }
            catch (Exception ex) when (ex is SqliteException or InvalidDataException)
            {
                _logger.LogError(ex, "Review database failed its integrity check; attempting a bounded backup recovery.");
                MoveCorruptDatabaseGroup();
                if (!TryRestoreLatestBackup())
                {
                    throw new InvalidDataException("Review database is corrupt and no valid bounded backup is available.", ex);
                }
            }
        }

        private SqliteConnection OpenConnection(bool readOnly)
        {
            var builder = new SqliteConnectionStringBuilder
            {
                DataSource = DatabasePath,
                Mode = readOnly ? SqliteOpenMode.ReadOnly : SqliteOpenMode.ReadWriteCreate,
                Pooling = false,
                Cache = SqliteCacheMode.Private
            };
            var connection = new SqliteConnection(builder.ToString());
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = readOnly
                ? "PRAGMA busy_timeout=5000; PRAGMA query_only=ON;"
                : "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;";
            command.ExecuteNonQuery();
            return connection;
        }

        private static void CreateEmptyDatabase(string path)
        {
            using var connection = OpenStandalone(path, SqliteOpenMode.ReadWriteCreate);
            CreateSchema(connection);
        }

        private static SqliteConnection OpenStandalone(string path, SqliteOpenMode mode)
        {
            var builder = new SqliteConnectionStringBuilder
            {
                DataSource = path,
                Mode = mode,
                Pooling = false,
                Cache = SqliteCacheMode.Private
            };
            var connection = new SqliteConnection(builder.ToString());
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = "PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;";
            command.ExecuteNonQuery();
            return connection;
        }

        private static void CreateSchema(SqliteConnection connection)
        {
            using var command = connection.CreateCommand();
            command.CommandText = """
                CREATE TABLE IF NOT EXISTS Reviews (
                    UserId TEXT NOT NULL,
                    MediaType TEXT NOT NULL,
                    Target TEXT NOT NULL,
                    Content TEXT NOT NULL,
                    Rating INTEGER NULL,
                    CreatedAt TEXT NOT NULL,
                    UpdatedAt TEXT NOT NULL,
                    PRIMARY KEY (UserId, MediaType, Target)
                ) WITHOUT ROWID;

                CREATE INDEX IF NOT EXISTS IX_Reviews_Target
                    ON Reviews (MediaType, Target, UserId);

                CREATE TABLE IF NOT EXISTS ReviewStats (
                    Id INTEGER PRIMARY KEY CHECK (Id = 1),
                    TotalCount INTEGER NOT NULL CHECK (TotalCount >= 0)
                );

                INSERT OR IGNORE INTO ReviewStats (Id, TotalCount) VALUES (1, 0);

                CREATE TABLE IF NOT EXISTS UserReviewStats (
                    UserId TEXT PRIMARY KEY,
                    ReviewCount INTEGER NOT NULL CHECK (ReviewCount > 0)
                ) WITHOUT ROWID;

                CREATE TRIGGER IF NOT EXISTS Reviews_AfterInsert
                AFTER INSERT ON Reviews
                BEGIN
                    UPDATE ReviewStats SET TotalCount = TotalCount + 1 WHERE Id = 1;
                    INSERT INTO UserReviewStats (UserId, ReviewCount) VALUES (NEW.UserId, 1)
                    ON CONFLICT(UserId) DO UPDATE SET ReviewCount = ReviewCount + 1;
                END;

                CREATE TRIGGER IF NOT EXISTS Reviews_AfterDelete
                AFTER DELETE ON Reviews
                BEGIN
                    UPDATE ReviewStats SET TotalCount = TotalCount - 1 WHERE Id = 1;
                    UPDATE UserReviewStats SET ReviewCount = ReviewCount - 1 WHERE UserId = OLD.UserId;
                    DELETE FROM UserReviewStats WHERE UserId = OLD.UserId AND ReviewCount <= 0;
                END;
                """;
            command.ExecuteNonQuery();
        }

        private static void VerifyAndRepairCounters(SqliteConnection connection)
        {
            using var transaction = connection.BeginTransaction(deferred: false);
            var actualTotal = ExecuteInt64(connection, transaction, "SELECT COUNT(*) FROM Reviews;");
            var storedTotal = ExecuteInt64(connection, transaction, "SELECT TotalCount FROM ReviewStats WHERE Id = 1;");
            var missingOrDifferentUsers = ExecuteInt64(
                connection,
                transaction,
                """
                SELECT COUNT(*) FROM (
                    SELECT UserId, COUNT(*) AS ActualCount FROM Reviews GROUP BY UserId
                    EXCEPT
                    SELECT UserId, ReviewCount FROM UserReviewStats
                );
                """);
            var extraOrDifferentUsers = ExecuteInt64(
                connection,
                transaction,
                """
                SELECT COUNT(*) FROM (
                    SELECT UserId, ReviewCount FROM UserReviewStats
                    EXCEPT
                    SELECT UserId, COUNT(*) AS ActualCount FROM Reviews GROUP BY UserId
                );
                """);

            if (actualTotal != storedTotal || missingOrDifferentUsers != 0 || extraOrDifferentUsers != 0)
            {
                using var repair = connection.CreateCommand();
                repair.Transaction = transaction;
                repair.CommandText = """
                    UPDATE ReviewStats SET TotalCount = (SELECT COUNT(*) FROM Reviews) WHERE Id = 1;
                    DELETE FROM UserReviewStats;
                    INSERT INTO UserReviewStats (UserId, ReviewCount)
                    SELECT UserId, COUNT(*) FROM Reviews GROUP BY UserId;
                    """;
                repair.ExecuteNonQuery();
            }

            transaction.Commit();
        }

        private static long ExecuteInt64(SqliteConnection connection, SqliteTransaction transaction, string sql)
        {
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = sql;
            var scalar = command.ExecuteScalar();
            return Convert.ToInt64(scalar, CultureInfo.InvariantCulture);
        }

        private static void VerifyQuickCheck(SqliteConnection connection)
        {
            using var command = connection.CreateCommand();
            command.CommandText = "PRAGMA quick_check;";
            var result = command.ExecuteScalar() as string;
            if (!string.Equals(result, "ok", StringComparison.Ordinal))
            {
                throw new InvalidDataException("SQLite quick_check did not return ok.");
            }
        }

        private void MigrateLegacyJson()
        {
            var length = new FileInfo(LegacyPath).Length;
            if (length > ReviewLimits.LegacyJsonBytes)
            {
                BackupLegacyFailure();
                throw new InvalidDataException("Legacy reviews.json exceeds the bounded migration size.");
            }

            AllReviewsStore legacy;
            try
            {
                using var stream = new FileStream(LegacyPath, FileMode.Open, FileAccess.Read, FileShare.Read);
                legacy = JsonSerializer.Deserialize<AllReviewsStore>(stream, PersistedJson.ReadOptions)
                    ?? throw new InvalidDataException("Legacy reviews.json deserialized to null.");
            }
            catch
            {
                BackupLegacyFailure();
                throw;
            }

            var normalized = NormalizeLegacyReviews(legacy);
            var tempPath = DatabasePath + ".migrating-" + Guid.NewGuid().ToString("N");
            try
            {
                using (var connection = OpenStandalone(tempPath, SqliteOpenMode.ReadWriteCreate))
                {
                    using (var journal = connection.CreateCommand())
                    {
                        journal.CommandText = "PRAGMA journal_mode=DELETE;";
                        journal.ExecuteNonQuery();
                    }

                    CreateSchema(connection);
                    using var transaction = connection.BeginTransaction(deferred: false);
                    foreach (var review in normalized)
                    {
                        InsertMigratedReview(connection, transaction, review);
                    }

                    transaction.Commit();
                    VerifyAndRepairCounters(connection);
                    VerifyQuickCheck(connection);
                    VerifyMigratedContent(connection, normalized);
                }

                File.Move(tempPath, DatabasePath, overwrite: false);
                try
                {
                    ArchiveLingeringLegacyFile();
                }
                catch (Exception ex)
                {
                    // The verified database is authoritative after its atomic
                    // move. A read-only legacy file must not make that durable
                    // migration unusable; the next startup retries archiving it.
                    _logger.LogWarning(ex, "The verified legacy review file could not be archived; the database remains authoritative.");
                }
                _logger.LogInformation("Migrated {ReviewCount} legacy reviews into the indexed review store.", normalized.Count);
            }
            catch
            {
                TryDelete(tempPath);
                BackupLegacyFailure();
                throw;
            }
        }

        private static List<UserReview> NormalizeLegacyReviews(AllReviewsStore legacy)
        {
            var selected = new Dictionary<string, UserReview>(StringComparer.Ordinal);
            foreach (var pair in legacy.Reviews)
            {
                if (!TryParseLegacyKey(pair.Key, out var userId, out var mediaType, out var target)
                    || !ReviewTarget.TryNormalizeLegacy(mediaType, target, out var canonicalTarget))
                {
                    throw new InvalidDataException("Legacy reviews.json contains an invalid review namespace.");
                }

                var review = pair.Value ?? throw new InvalidDataException("Legacy reviews.json contains a null review.");
                var canonical = new UserReview
                {
                    UserId = userId,
                    MediaType = mediaType,
                    TmdbId = canonicalTarget,
                    Content = review.Content ?? string.Empty,
                    Rating = review.Rating,
                    CreatedAt = review.CreatedAt ?? string.Empty,
                    UpdatedAt = review.UpdatedAt ?? string.Empty
                };
                var key = userId + ":" + mediaType + ":" + canonicalTarget;
                if (!selected.TryGetValue(key, out var existing)
                    || string.CompareOrdinal(canonical.UpdatedAt, existing.UpdatedAt) > 0)
                {
                    selected[key] = canonical;
                }
            }

            return selected.Values
                .OrderBy(review => review.UserId, StringComparer.Ordinal)
                .ThenBy(review => review.MediaType, StringComparer.Ordinal)
                .ThenBy(review => review.TmdbId, StringComparer.Ordinal)
                .ToList();
        }

        private static bool TryParseLegacyKey(string key, out string userId, out string mediaType, out string target)
        {
            userId = string.Empty;
            mediaType = string.Empty;
            target = string.Empty;
            var first = key.IndexOf(':', StringComparison.Ordinal);
            var second = first < 0 ? -1 : key.IndexOf(':', first + 1);
            if (first <= 0 || second <= first + 1 || second == key.Length - 1)
            {
                return false;
            }

            if (!Guid.TryParseExact(key[..first], "N", out var parsedUser) || parsedUser == Guid.Empty)
            {
                return false;
            }

            userId = parsedUser.ToString("N");
            mediaType = key[(first + 1)..second];
            target = key[(second + 1)..];
            return true;
        }

        private static void InsertMigratedReview(SqliteConnection connection, SqliteTransaction transaction, UserReview review)
        {
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = """
                INSERT INTO Reviews (UserId, MediaType, Target, Content, Rating, CreatedAt, UpdatedAt)
                VALUES ($userId, $mediaType, $target, $content, $rating, $createdAt, $updatedAt);
                """;
            command.Parameters.AddWithValue("$userId", review.UserId);
            command.Parameters.AddWithValue("$mediaType", review.MediaType);
            command.Parameters.AddWithValue("$target", review.TmdbId);
            command.Parameters.AddWithValue("$content", review.Content);
            command.Parameters.AddWithValue("$rating", review.Rating.HasValue ? review.Rating.Value : DBNull.Value);
            command.Parameters.AddWithValue("$createdAt", review.CreatedAt);
            command.Parameters.AddWithValue("$updatedAt", review.UpdatedAt);
            command.ExecuteNonQuery();
        }

        private static void VerifyMigratedContent(SqliteConnection connection, IReadOnlyList<UserReview> expected)
        {
            using var command = connection.CreateCommand();
            command.CommandText = """
                SELECT UserId, MediaType, Target, Content, Rating, CreatedAt, UpdatedAt
                FROM Reviews ORDER BY UserId, MediaType, Target;
                """;
            var actual = ReadReviews(command, expected.Count + 1);
            if (actual.Count != expected.Count
                || !CryptographicOperations.FixedTimeEquals(HashReviews(expected), HashReviews(actual)))
            {
                throw new InvalidDataException("Legacy review migration verification failed.");
            }
        }

        private static byte[] HashReviews(IEnumerable<UserReview> reviews)
        {
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            foreach (var review in reviews)
            {
                AppendHashField(hash, review.UserId);
                AppendHashField(hash, review.MediaType);
                AppendHashField(hash, review.TmdbId);
                AppendHashField(hash, review.Content);
                AppendHashField(hash, review.Rating?.ToString(CultureInfo.InvariantCulture) ?? string.Empty);
                AppendHashField(hash, review.CreatedAt);
                AppendHashField(hash, review.UpdatedAt);
            }

            return hash.GetHashAndReset();
        }

        private static void AppendHashField(IncrementalHash hash, string value)
        {
            var bytes = Encoding.UTF8.GetBytes(value);
            hash.AppendData(BitConverter.GetBytes(bytes.Length));
            hash.AppendData(bytes);
        }

        private void ArchiveLingeringLegacyFile()
        {
            if (!File.Exists(LegacyPath))
            {
                return;
            }

            var archive = LegacyPath + ".migrated-" + UtcStamp();
            File.Move(LegacyPath, UniquePath(archive));
            PruneFiles(LegacyPath + ".migrated-*", ReviewLimits.RetainedBackups);
        }

        private void BackupLegacyFailure()
        {
            if (!File.Exists(LegacyPath))
            {
                return;
            }

            try
            {
                var sourceHash = SHA256.HashData(File.ReadAllBytes(LegacyPath));
                foreach (var existing in Directory.GetFiles(_configBaseDir, LegacyFileName + ".corrupt-*"))
                {
                    if (CryptographicOperations.FixedTimeEquals(sourceHash, SHA256.HashData(File.ReadAllBytes(existing))))
                    {
                        return;
                    }
                }

                File.Copy(LegacyPath, UniquePath(LegacyPath + ".corrupt-" + UtcStamp()));
                PruneFiles(LegacyPath + ".corrupt-*", ReviewLimits.RetainedBackups);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to preserve a corrupt legacy review file.");
            }
        }

        private void CreateBoundedBackup()
        {
            var destinationPath = UniquePath(DatabasePath + ".backup-" + UtcStamp());
            var temporaryPath = destinationPath + ".tmp";
            try
            {
                using (var source = OpenConnection(readOnly: true))
                using (var destination = OpenStandalone(temporaryPath, SqliteOpenMode.ReadWriteCreate))
                {
                    source.BackupDatabase(destination);
                    VerifyQuickCheck(destination);
                }

                File.Move(temporaryPath, destinationPath);
                PruneFiles(DatabasePath + ".backup-*", ReviewLimits.RetainedBackups);
            }
            catch (Exception ex)
            {
                TryDelete(temporaryPath);
                _logger.LogWarning(ex, "Could not create the bounded review database backup.");
            }
        }

        private void MoveCorruptDatabaseGroup()
        {
            var suffix = NextCorruptGroupSuffix();
            foreach (var path in new[] { DatabasePath, DatabasePath + "-wal", DatabasePath + "-shm" })
            {
                if (File.Exists(path))
                {
                    File.Move(path, path + suffix);
                }
            }

            PruneCorruptDatabaseGroups();
        }

        private bool HasDatabaseBackups()
            => Directory.GetFiles(_configBaseDir, DatabaseFileName + ".backup-*")
                .Any(path => !path.EndsWith(".tmp", StringComparison.Ordinal));

        private string NextCorruptGroupSuffix()
        {
            var suffix = ".corrupt-" + UtcStamp();
            while (new[] { DatabasePath, DatabasePath + "-wal", DatabasePath + "-shm" }
                   .Any(path => File.Exists(path + suffix)))
            {
                suffix = ".corrupt-" + UtcStamp() + "-" + Guid.NewGuid().ToString("N");
            }

            return suffix;
        }

        private bool TryRestoreLatestBackup()
        {
            foreach (var backup in Directory.GetFiles(_configBaseDir, DatabaseFileName + ".backup-*")
                         .Where(path => !path.EndsWith(".tmp", StringComparison.Ordinal))
                         .OrderByDescending(File.GetLastWriteTimeUtc))
            {
                var restore = DatabasePath + ".restoring-" + Guid.NewGuid().ToString("N");
                try
                {
                    File.Copy(backup, restore);
                    using (var connection = OpenStandalone(restore, SqliteOpenMode.ReadWrite))
                    {
                        VerifyQuickCheck(connection);
                    }

                    QuarantineLiveSidecars();
                    File.Move(restore, DatabasePath);
                    _logger.LogWarning("Recovered the review database from bounded backup {BackupFile}.", Path.GetFileName(backup));
                    return true;
                }
                catch (Exception ex)
                {
                    TryDelete(restore);
                    _logger.LogWarning(ex, "Rejected an invalid review database backup {BackupFile}.", Path.GetFileName(backup));
                }
            }

            return false;
        }

        private void QuarantineLiveSidecars()
        {
            var suffix = NextCorruptGroupSuffix();
            foreach (var path in new[] { DatabasePath + "-wal", DatabasePath + "-shm" })
            {
                if (File.Exists(path))
                {
                    File.Move(path, path + suffix);
                }
            }

            PruneCorruptDatabaseGroups();
        }

        private void PruneCorruptDatabaseGroups()
        {
            var primaryFiles = Directory.GetFiles(_configBaseDir, DatabaseFileName + ".corrupt-*")
                .OrderByDescending(File.GetLastWriteTimeUtc)
                .ToArray();
            foreach (var oldPrimary in primaryFiles.Skip(ReviewLimits.RetainedBackups))
            {
                TryDelete(oldPrimary);
                TryDelete(DatabasePath + "-wal" + oldPrimary[DatabasePath.Length..]);
                TryDelete(DatabasePath + "-shm" + oldPrimary[DatabasePath.Length..]);
            }

            foreach (var sidecarPrefix in new[] { DatabaseFileName + "-wal.corrupt-*", DatabaseFileName + "-shm.corrupt-*" })
            {
                foreach (var orphan in Directory.GetFiles(_configBaseDir, sidecarPrefix)
                             .OrderByDescending(File.GetLastWriteTimeUtc)
                             .Skip(ReviewLimits.RetainedBackups))
                {
                    TryDelete(orphan);
                }
            }
        }

        private void CleanupStaleArtifacts()
        {
            var cutoff = DateTime.UtcNow.AddDays(-1);
            foreach (var pattern in new[]
                     {
                         DatabaseFileName + ".migrating-*",
                         DatabaseFileName + ".restoring-*",
                         DatabaseFileName + ".backup-*.tmp"
                     })
            {
                foreach (var path in Directory.GetFiles(_configBaseDir, pattern))
                {
                    if (File.GetLastWriteTimeUtc(path) < cutoff)
                    {
                        TryDelete(path);
                    }
                }
            }
        }

        private void PruneFiles(string pattern, int keep)
        {
            foreach (var path in Directory.GetFiles(_configBaseDir, Path.GetFileName(pattern))
                         .Where(path => !path.EndsWith(".tmp", StringComparison.Ordinal))
                         .OrderByDescending(File.GetLastWriteTimeUtc)
                         .Skip(keep))
            {
                TryDelete(path);
            }
        }

        private static bool ReviewExists(
            SqliteConnection connection,
            SqliteTransaction transaction,
            string userIdN,
            string mediaType,
            string target)
        {
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = """
                SELECT EXISTS(
                    SELECT 1 FROM Reviews
                    WHERE UserId = $userId AND MediaType = $mediaType AND Target = $target
                );
                """;
            command.Parameters.AddWithValue("$userId", userIdN);
            command.Parameters.AddWithValue("$mediaType", mediaType);
            command.Parameters.AddWithValue("$target", target);
            return Convert.ToInt64(command.ExecuteScalar(), CultureInfo.InvariantCulture) == 1;
        }

        private static void EnforceCreateQuota(SqliteConnection connection, SqliteTransaction transaction, string userIdN)
        {
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = """
                SELECT
                    (SELECT TotalCount FROM ReviewStats WHERE Id = 1),
                    COALESCE((SELECT ReviewCount FROM UserReviewStats WHERE UserId = $userId), 0);
                """;
            command.Parameters.AddWithValue("$userId", userIdN);
            using var reader = command.ExecuteReader();
            reader.Read();
            var total = reader.GetInt64(0);
            var user = reader.GetInt64(1);
            if (total >= ReviewLimits.TotalReviews)
            {
                throw new ReviewQuotaExceededException("review_total_limit", "The server review limit has been reached.");
            }

            if (user >= ReviewLimits.PerUserReviews)
            {
                throw new ReviewQuotaExceededException("review_user_limit", "The per-user review limit has been reached.");
            }
        }

        private static void AddReviewMutationParameters(
            SqliteCommand command,
            string userIdN,
            string mediaType,
            string target,
            string content,
            int? rating,
            string nowIso)
        {
            command.Parameters.AddWithValue("$userId", userIdN);
            command.Parameters.AddWithValue("$mediaType", mediaType);
            command.Parameters.AddWithValue("$target", target);
            command.Parameters.AddWithValue("$content", content);
            command.Parameters.AddWithValue("$rating", rating.HasValue ? rating.Value : DBNull.Value);
            command.Parameters.AddWithValue("$updatedAt", nowIso);
        }

        private static List<UserReview> ReadReviews(SqliteCommand command, int capacity)
        {
            var reviews = new List<UserReview>(capacity);
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                reviews.Add(ReadReview(reader));
            }

            return reviews;
        }

        private static UserReview ReadReview(SqliteDataReader reader)
            => new UserReview
            {
                UserId = reader.GetString(0),
                MediaType = reader.GetString(1),
                TmdbId = reader.GetString(2),
                Content = reader.GetString(3),
                Rating = reader.IsDBNull(4) ? null : reader.GetInt32(4),
                CreatedAt = reader.GetString(5),
                UpdatedAt = reader.GetString(6)
            };

        private static ReviewPage BuildPage(
            List<UserReview> reviews,
            int pageSize,
            Func<UserReview, string> cursorFactory)
        {
            if (reviews.Count <= pageSize)
            {
                return new ReviewPage(reviews, null);
            }

            reviews.RemoveAt(reviews.Count - 1);
            return new ReviewPage(reviews, cursorFactory(reviews[^1]));
        }

        private static int NormalizePageSize(int pageSize)
            => pageSize <= 0 ? ReviewLimits.DefaultPageSize : Math.Min(pageSize, ReviewLimits.MaximumPageSize);

        private static string DecodeItemCursor(string? cursor)
        {
            if (string.IsNullOrEmpty(cursor))
            {
                return string.Empty;
            }

            var decoded = DecodeCursor(cursor);
            if (!Guid.TryParseExact(decoded, "N", out _))
            {
                throw new ArgumentException("Invalid review cursor.", nameof(cursor));
            }

            return decoded;
        }

        private static (string UserId, string MediaType, string Target) DecodeAdminCursor(string? cursor)
        {
            if (string.IsNullOrEmpty(cursor))
            {
                return (string.Empty, string.Empty, string.Empty);
            }

            var parts = DecodeCursor(cursor).Split('\0');
            if (parts.Length != 3
                || !Guid.TryParseExact(parts[0], "N", out _)
                || (parts[1] != "movie" && parts[1] != "tv")
                || !ReviewTarget.TryValidate(parts[1], parts[2], out _))
            {
                throw new ArgumentException("Invalid review cursor.", nameof(cursor));
            }

            return (parts[0], parts[1], parts[2]);
        }

        private static string EncodeCursor(string value)
            => Convert.ToBase64String(Encoding.UTF8.GetBytes(value)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

        private static string DecodeCursor(string value)
        {
            try
            {
                var base64 = value.Replace('-', '+').Replace('_', '/');
                base64 = base64.PadRight(base64.Length + ((4 - (base64.Length % 4)) % 4), '=');
                return Encoding.UTF8.GetString(Convert.FromBase64String(base64));
            }
            catch (FormatException ex)
            {
                throw new ArgumentException("Invalid review cursor.", nameof(value), ex);
            }
        }

        private static string UtcStamp()
            => DateTime.UtcNow.ToString("yyyyMMddHHmmssfff", CultureInfo.InvariantCulture);

        private static string UniquePath(string desired)
        {
            if (!File.Exists(desired))
            {
                return desired;
            }

            return desired + "-" + Guid.NewGuid().ToString("N");
        }

        private static void TryDelete(string path)
        {
            try
            {
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
            catch
            {
                // Cleanup must not hide the original storage or recovery failure.
            }
        }
    }
}
