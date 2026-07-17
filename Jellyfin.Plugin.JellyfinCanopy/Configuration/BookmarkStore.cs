using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Configuration
{
    internal enum BookmarkStoreStatus
    {
        Success,
        Conflict,
        Invalid,
        NotFound,
        TooLarge
    }

    internal sealed class BookmarkStoreOperation
    {
        public string Type { get; set; } = string.Empty;
        public string BookmarkId { get; set; } = string.Empty;
        public string SourceBookmarkId { get; set; } = string.Empty;
        public BookmarkItem? Bookmark { get; set; }
        public double? Timestamp { get; set; }
        public string UpdatedAt { get; set; } = string.Empty;
    }

    internal sealed class BookmarkStoreMutationResult
    {
        public BookmarkStoreStatus Status { get; set; }
        public long Revision { get; set; }
        public bool Changed { get; set; }
        public string Message { get; set; } = string.Empty;
        public UserBookmark? State { get; set; }
    }

    internal sealed class BookmarkStorePage
    {
        public long Revision { get; set; }
        public int Total { get; set; }
        public int AllTotal { get; set; }
        public int Movie { get; set; }
        public int Tv { get; set; }
        public int Other { get; set; }
        public int StartIndex { get; set; }
        public int Limit { get; set; }
        public Dictionary<string, BookmarkItem> Bookmarks { get; set; } = new(StringComparer.Ordinal);
    }

    internal sealed class BookmarkStoreCounts
    {
        public long Revision { get; set; }
        public int Total { get; set; }
        public int Movie { get; set; }
        public int Tv { get; set; }
        public int Other { get; set; }
        public int PayloadBytes { get; set; }
    }

    internal sealed class BookmarkStoreItemGroup
    {
        public string ItemId { get; set; } = string.Empty;
        public List<string> BookmarkIds { get; set; } = new();
    }

    internal sealed class BookmarkStoreItemGroupPage
    {
        public long Revision { get; set; }
        public List<BookmarkStoreItemGroup> Groups { get; set; } = new();
        public string? NextCursor { get; set; }
    }

    /// <summary>
    /// Indexed, transactional per-user bookmark persistence. The SQLite store is
    /// authoritative once a user row exists; the former bookmark.json is a
    /// bounded, lazy, one-time import. Ordinary mutations read and serialize only
    /// touched rows, while SQLite supplies the single atomic commit boundary.
    /// </summary>
    internal sealed class BookmarkStore
    {
        private const string DatabaseFileName = "bookmarks.db";
        private const string LegacyFileName = "bookmark.json";
        private const int PayloadEnvelopeBytes = 32;
        private const int MaximumLegacyRepairBookmarks = 10_000;
        private const int RetainedDatabaseBackups = 5;
        private const long MaximumDatabaseBackupBytes = 1024L * 1024 * 1024;
        private const string DatabaseStoreId = "JellyfinCanopy.Bookmarks";
        private const int DatabaseSchemaVersion = 1;
        private static readonly TimeSpan BackupDebounce = TimeSpan.FromMilliseconds(500);
        private static readonly TimeSpan MinimumBackupInterval = TimeSpan.FromMinutes(15);
        private static readonly object InitializationLock = new();

        private readonly string _configBaseDir;
        private readonly ILogger _logger;
        private volatile bool _ready;
        private Exception? _initializationError;
        private readonly object _backupLock = new();
        private Task? _backupWorker;
        private long _backupRequestGeneration;
        private DateTime _lastBackupUtc;

        public BookmarkStore(string configBaseDir, ILogger logger)
        {
            _configBaseDir = configBaseDir;
            _logger = logger;
        }

        private string DatabasePath => Path.Combine(_configBaseDir, DatabaseFileName);

        public UserBookmark GetState(string userId)
        {
            var userIdN = EnsureUser(userId);
            using var connection = OpenConnection(readOnly: true);
            return ReadState(connection, transaction: null, userIdN);
        }

        public BookmarkStoreCounts GetCounts(string userId)
        {
            var userIdN = EnsureUser(userId);
            using var connection = OpenConnection(readOnly: true);
            using var command = connection.CreateCommand();
            command.CommandText = """
                SELECT u.Revision, u.BookmarkCount, u.PayloadBytes,
                       COALESCE(SUM(CASE WHEN lower(trim(b.MediaType)) IN ('movie', 'film', 'musicvideo') THEN 1 ELSE 0 END), 0),
                       COALESCE(SUM(CASE WHEN lower(trim(b.MediaType)) IN ('tv', 'series', 'season', 'episode', 'tvshow') THEN 1 ELSE 0 END), 0)
                FROM BookmarkUsers u
                LEFT JOIN Bookmarks b ON b.UserId = u.UserId
                WHERE u.UserId = $userId
                GROUP BY u.UserId, u.Revision, u.BookmarkCount, u.PayloadBytes;
                """;
            command.Parameters.AddWithValue("$userId", userIdN);
            using var reader = command.ExecuteReader();
            if (!reader.Read()) throw new InvalidDataException("Bookmark user metadata is missing.");
            var total = reader.GetInt32(1);
            var movie = reader.GetInt32(3);
            var tv = reader.GetInt32(4);
            return new BookmarkStoreCounts
            {
                Revision = reader.GetInt64(0),
                Total = total,
                PayloadBytes = reader.GetInt32(2),
                Movie = movie,
                Tv = tv,
                Other = total - movie - tv
            };
        }

        public BookmarkStorePage GetPage(
            string userId,
            int startIndex,
            int limit,
            string? itemId = null,
            string? mediaType = null)
        {
            var userIdN = EnsureUser(userId);
            using var connection = OpenConnection(readOnly: true);
            using var transaction = connection.BeginTransaction(deferred: true);
            var revision = ReadRevision(connection, transaction, userIdN);
            var categoryCounts = ReadCounts(connection, transaction, userIdN);

            var where = new StringBuilder("UserId = $userId");
            if (itemId != null) where.Append(" AND ItemId = $itemId");
            if (mediaType != null)
            {
                where.Append(mediaType switch
                {
                    "movie" => " AND lower(trim(MediaType)) IN ('movie', 'film', 'musicvideo')",
                    "tv" => " AND lower(trim(MediaType)) IN ('tv', 'series', 'season', 'episode', 'tvshow')",
                    _ => " AND lower(trim(MediaType)) NOT IN ('movie', 'film', 'musicvideo', 'tv', 'series', 'season', 'episode', 'tvshow')"
                });
            }

            using var count = connection.CreateCommand();
            count.Transaction = transaction;
            count.CommandText = $"SELECT COUNT(*) FROM Bookmarks WHERE {where};";
            AddPageParameters(count, userIdN, itemId, mediaType);
            var total = Convert.ToInt32(count.ExecuteScalar(), CultureInfo.InvariantCulture);

            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = $"""
                SELECT BookmarkId, ItemId, IdentityVersion, ItemType, TmdbId, TvdbId,
                       SeriesTmdbId, SeriesTvdbId, MediaType, SeasonNumber, EpisodeNumber,
                       EpisodeEndNumber, Name, Timestamp, Label, CreatedAt, UpdatedAt, SyncedFrom
                FROM Bookmarks
                WHERE {where}
                ORDER BY BookmarkId
                LIMIT $limit OFFSET $offset;
                """;
            AddPageParameters(command, userIdN, itemId, mediaType);
            command.Parameters.AddWithValue("$limit", limit);
            command.Parameters.AddWithValue("$offset", startIndex);
            var bookmarks = ReadBookmarks(command, limit);
            transaction.Commit();
            return new BookmarkStorePage
            {
                Revision = revision,
                Total = total,
                AllTotal = categoryCounts.Total,
                Movie = categoryCounts.Movie,
                Tv = categoryCounts.Tv,
                Other = categoryCounts.Other,
                StartIndex = startIndex,
                Limit = limit,
                Bookmarks = bookmarks
            };
        }

        public BookmarkStoreItemGroupPage GetItemGroups(
            string userId,
            string? afterItemId,
            int limit)
        {
            var userIdN = EnsureUser(userId);
            var decodedCursor = DecodeItemCursor(afterItemId);
            using var connection = OpenConnection(readOnly: true);
            using var transaction = connection.BeginTransaction(deferred: true);
            var revision = ReadRevision(connection, transaction, userIdN);
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = """
                SELECT ItemId, BookmarkId
                FROM Bookmarks
                WHERE UserId = $userId AND ItemId IN (
                    SELECT ItemId
                    FROM Bookmarks
                    WHERE UserId = $userId AND ($hasCursor = 0 OR ItemId > $afterItemId)
                    GROUP BY ItemId
                    ORDER BY ItemId
                    LIMIT $groupLimitPlusOne
                )
                ORDER BY ItemId, BookmarkId;
                """;
            command.Parameters.AddWithValue("$userId", userIdN);
            command.Parameters.AddWithValue("$hasCursor", afterItemId == null ? 0 : 1);
            command.Parameters.AddWithValue("$afterItemId", decodedCursor ?? string.Empty);
            command.Parameters.AddWithValue("$groupLimitPlusOne", limit + 1);
            var groups = new List<BookmarkStoreItemGroup>(limit + 1);
            using (var reader = command.ExecuteReader())
            {
                BookmarkStoreItemGroup? current = null;
                while (reader.Read())
                {
                    var nextItemId = reader.GetString(0);
                    if (current == null || !string.Equals(current.ItemId, nextItemId, StringComparison.Ordinal))
                    {
                        current = new BookmarkStoreItemGroup { ItemId = nextItemId };
                        groups.Add(current);
                    }
                    current.BookmarkIds.Add(reader.GetString(1));
                }
            }
            transaction.Commit();
            var hasMore = groups.Count > limit;
            if (hasMore) groups.RemoveAt(groups.Count - 1);
            return new BookmarkStoreItemGroupPage
            {
                Revision = revision,
                Groups = groups,
                NextCursor = hasMore && groups.Count > 0 ? EncodeItemCursor(groups[^1].ItemId) : null
            };
        }

        public BookmarkStoreMutationResult Apply(
            string userId,
            long? expectedRevision,
            IReadOnlyList<BookmarkStoreOperation> operations,
            bool includeCompleteSuccess = false)
        {
            var userIdN = EnsureUser(userId);
            using var connection = OpenConnection(readOnly: false);
            using var transaction = connection.BeginTransaction(deferred: false);
            var metadata = ReadMetadata(connection, transaction, userIdN);
            if (!expectedRevision.HasValue || expectedRevision.Value != metadata.Revision)
            {
                var state = ReadState(connection, transaction, userIdN);
                transaction.Rollback();
                return new BookmarkStoreMutationResult
                {
                    Status = BookmarkStoreStatus.Conflict,
                    Revision = metadata.Revision,
                    Message = expectedRevision.HasValue
                        ? "Bookmark state changed. Rebase the operation on the returned revision/state and retry."
                        : "A bookmark revision precondition is required.",
                    State = state
                };
            }

            var originals = new Dictionary<string, StoredBookmark?>(StringComparer.Ordinal);
            var pending = new Dictionary<string, StoredBookmark?>(StringComparer.Ordinal);

            StoredBookmark? Effective(string bookmarkId)
            {
                if (pending.TryGetValue(bookmarkId, out var staged)) return staged;
                if (originals.TryGetValue(bookmarkId, out var loaded)) return loaded;
                loaded = ReadStoredBookmark(connection, transaction, userIdN, bookmarkId);
                originals[bookmarkId] = loaded;
                return loaded;
            }

            foreach (var operation in operations)
            {
                if (operation == null || !PersistedPayloadPolicy.IsValidBookmarkId(operation.BookmarkId))
                {
                    transaction.Rollback();
                    return Invalid(metadata.Revision);
                }

                var type = (operation.Type ?? string.Empty).Trim().ToLowerInvariant();
                var existing = Effective(operation.BookmarkId);
                switch (type)
                {
                    case "add":
                        if (!PersistedPayloadPolicy.IsValidBookmarkItem(operation.Bookmark))
                        {
                            transaction.Rollback();
                            return Invalid(metadata.Revision);
                        }
                        var added = StoredBookmark.Create(operation.BookmarkId, operation.Bookmark!);
                        if (existing != null && !BookmarkEquals(existing.Bookmark, added.Bookmark))
                        {
                            transaction.Rollback();
                            return Failure(BookmarkStoreStatus.Conflict, metadata.Revision,
                                $"Bookmark id '{operation.BookmarkId}' already exists with different data.");
                        }
                        if (existing == null) pending[operation.BookmarkId] = added;
                        break;

                    case "update":
                        if (!PersistedPayloadPolicy.IsValidBookmarkItem(operation.Bookmark))
                        {
                            transaction.Rollback();
                            return Invalid(metadata.Revision);
                        }
                        if (existing == null)
                        {
                            var missingState = ReadState(connection, transaction, userIdN);
                            transaction.Rollback();
                            return new BookmarkStoreMutationResult
                            {
                                Status = BookmarkStoreStatus.NotFound,
                                Revision = metadata.Revision,
                                Message = $"Bookmark id '{operation.BookmarkId}' does not exist.",
                                State = missingState
                            };
                        }
                        var updatedBookmark = Clone(operation.Bookmark!);
                        if (string.IsNullOrWhiteSpace(updatedBookmark.CreatedAt))
                        {
                            updatedBookmark.CreatedAt = existing.Bookmark.CreatedAt;
                        }
                        var updated = StoredBookmark.Create(operation.BookmarkId, updatedBookmark);
                        if (!BookmarkEquals(existing.Bookmark, updated.Bookmark)) pending[operation.BookmarkId] = updated;
                        break;

                    case "offset":
                        if (existing == null)
                        {
                            var missingState = ReadState(connection, transaction, userIdN);
                            transaction.Rollback();
                            return new BookmarkStoreMutationResult
                            {
                                Status = BookmarkStoreStatus.NotFound,
                                Revision = metadata.Revision,
                                Message = $"Bookmark id '{operation.BookmarkId}' does not exist.",
                                State = missingState
                            };
                        }
                        var offsetBookmark = Clone(existing.Bookmark);
                        offsetBookmark.Timestamp = operation.Timestamp ?? double.NaN;
                        offsetBookmark.UpdatedAt = operation.UpdatedAt ?? string.Empty;
                        offsetBookmark.SyncedFrom = string.Empty;
                        if (!PersistedPayloadPolicy.IsValidBookmarkItem(offsetBookmark))
                        {
                            transaction.Rollback();
                            return Invalid(metadata.Revision);
                        }
                        var offset = StoredBookmark.Create(operation.BookmarkId, offsetBookmark);
                        if (!BookmarkEquals(existing.Bookmark, offset.Bookmark)) pending[operation.BookmarkId] = offset;
                        break;

                    case "move":
                        if (!PersistedPayloadPolicy.IsValidBookmarkId(operation.SourceBookmarkId)
                            || string.Equals(operation.BookmarkId, operation.SourceBookmarkId, StringComparison.Ordinal)
                            || !PersistedPayloadPolicy.IsValidBookmarkItem(operation.Bookmark))
                        {
                            transaction.Rollback();
                            return Invalid(metadata.Revision);
                        }
                        var source = Effective(operation.SourceBookmarkId);
                        var moved = StoredBookmark.Create(operation.BookmarkId, operation.Bookmark!);
                        if (existing != null && !BookmarkEquals(existing.Bookmark, moved.Bookmark))
                        {
                            transaction.Rollback();
                            return Failure(BookmarkStoreStatus.Conflict, metadata.Revision,
                                $"Bookmark id '{operation.BookmarkId}' already exists with different data.");
                        }
                        // A missing source is an idempotent no-op. It may mean a
                        // prior response was lost or another client deleted it;
                        // never resurrect that content from the request body.
                        if (source == null) break;
                        if (existing == null) pending[operation.BookmarkId] = moved;
                        pending[operation.SourceBookmarkId] = null;
                        break;

                    case "delete-strict":
                        if (existing == null)
                        {
                            var missingState = ReadState(connection, transaction, userIdN);
                            transaction.Rollback();
                            return new BookmarkStoreMutationResult
                            {
                                Status = BookmarkStoreStatus.NotFound,
                                Revision = metadata.Revision,
                                Message = "No matching bookmark to remove.",
                                State = missingState
                            };
                        }
                        pending[operation.BookmarkId] = null;
                        break;

                    case "delete":
                        if (existing != null) pending[operation.BookmarkId] = null;
                        break;

                    default:
                        transaction.Rollback();
                        return Failure(BookmarkStoreStatus.Invalid, metadata.Revision,
                            $"Unsupported bookmark operation type '{operation.Type}'.");
                }
            }

            var count = metadata.Count;
            var payloadBytes = metadata.PayloadBytes;
            foreach (var pair in pending)
            {
                var original = originals[pair.Key];
                if (original != null)
                {
                    count--;
                    payloadBytes -= original.EntryBytes;
                }
                if (pair.Value != null)
                {
                    count++;
                    payloadBytes += pair.Value.EntryBytes;
                }
            }

            if (count > PersistedPayloadPolicy.MaximumBookmarks
                || payloadBytes + PayloadEnvelopeBytes > PersistedPayloadPolicy.BookmarkPersistedBytes)
            {
                transaction.Rollback();
                return Failure(BookmarkStoreStatus.TooLarge, metadata.Revision,
                    $"A user may store at most {PersistedPayloadPolicy.MaximumBookmarks:N0} bookmarks and {PersistedPayloadPolicy.BookmarkPersistedBytes:N0} indexed payload bytes.");
            }

            if (pending.Count == 0)
            {
                var unchanged = includeCompleteSuccess ? ReadState(connection, transaction, userIdN) : null;
                transaction.Commit();
                return new BookmarkStoreMutationResult
                {
                    Status = BookmarkStoreStatus.Success,
                    Revision = metadata.Revision,
                    State = unchanged
                };
            }

            foreach (var pair in pending)
            {
                if (pair.Value == null) Delete(connection, transaction, userIdN, pair.Key);
                else Upsert(connection, transaction, userIdN, pair.Value);
            }
            var revision = checked(metadata.Revision + 1);
            UpdateMetadata(connection, transaction, userIdN, revision, count, payloadBytes);
            var stateAfter = includeCompleteSuccess ? ReadState(connection, transaction, userIdN) : null;
            transaction.Commit();
            ScheduleBoundedBackup();
            return new BookmarkStoreMutationResult
            {
                Status = BookmarkStoreStatus.Success,
                Revision = revision,
                Changed = true,
                State = stateAfter
            };
        }

        public BookmarkStoreMutationResult Replace(
            string userId,
            long? expectedRevision,
            IReadOnlyDictionary<string, BookmarkItem> replacement)
        {
            var userIdN = EnsureUser(userId);
            using var connection = OpenConnection(readOnly: false);
            using var transaction = connection.BeginTransaction(deferred: false);
            var metadata = ReadMetadata(connection, transaction, userIdN);
            var rows = new List<StoredBookmark>(replacement.Count);
            var payloadBytes = 0;
            foreach (var pair in replacement)
            {
                if (!PersistedPayloadPolicy.IsValidBookmarkId(pair.Key)
                    || !PersistedPayloadPolicy.IsValidBookmarkItem(pair.Value))
                {
                    transaction.Rollback();
                    return Invalid(metadata.Revision);
                }
                var row = StoredBookmark.Create(pair.Key, pair.Value);
                rows.Add(row);
                payloadBytes = checked(payloadBytes + row.EntryBytes);
            }
            if (rows.Count > PersistedPayloadPolicy.MaximumBookmarks
                || payloadBytes + PayloadEnvelopeBytes > PersistedPayloadPolicy.BookmarkPersistedBytes)
            {
                transaction.Rollback();
                return Failure(BookmarkStoreStatus.TooLarge, metadata.Revision,
                    $"A user may store at most {PersistedPayloadPolicy.MaximumBookmarks:N0} bookmarks and {PersistedPayloadPolicy.BookmarkPersistedBytes:N0} indexed payload bytes.");
            }

            if (!expectedRevision.HasValue || expectedRevision.Value != metadata.Revision)
            {
                var conflictState = ReadState(connection, transaction, userIdN);
                transaction.Rollback();
                return new BookmarkStoreMutationResult
                {
                    Status = BookmarkStoreStatus.Conflict,
                    Revision = metadata.Revision,
                    Message = "Bookmark state changed. Rebase the replacement and retry.",
                    State = conflictState
                };
            }

            using (var delete = connection.CreateCommand())
            {
                delete.Transaction = transaction;
                delete.CommandText = "DELETE FROM Bookmarks WHERE UserId = $userId;";
                delete.Parameters.AddWithValue("$userId", userIdN);
                delete.ExecuteNonQuery();
            }
            foreach (var row in rows) Upsert(connection, transaction, userIdN, row);
            var revision = checked(metadata.Revision + 1);
            UpdateMetadata(connection, transaction, userIdN, revision, rows.Count, payloadBytes);
            var state = ReadState(connection, transaction, userIdN);
            transaction.Commit();
            ScheduleBoundedBackup();
            return new BookmarkStoreMutationResult
            {
                Status = BookmarkStoreStatus.Success,
                Revision = revision,
                Changed = true,
                State = state
            };
        }

        private string EnsureUser(string userId)
        {
            EnsureReady();
            var userIdN = NormalizeUserId(userId);
            using var connection = OpenConnection(readOnly: false);
            using var transaction = connection.BeginTransaction(deferred: false);
            if (UserExists(connection, transaction, userIdN))
            {
                transaction.Commit();
                return userIdN;
            }

            var legacyPath = Path.Combine(_configBaseDir, userIdN, LegacyFileName);
            var unhealthyPath = legacyPath + ".unhealthy";
            if (File.Exists(unhealthyPath))
            {
                transaction.Rollback();
                throw new UserStoreUnhealthyException(LegacyFileName, newlyQuarantined: false);
            }

            UserBookmark state;
            try
            {
                state = File.Exists(legacyPath) ? ReadLegacy(legacyPath) : new UserBookmark();
            }
            catch (Exception ex) when (ex is InvalidDataException or JsonException)
            {
                transaction.Rollback();
                QuarantineLegacy(legacyPath, unhealthyPath, ex);
                throw new UserStoreUnhealthyException(LegacyFileName, newlyQuarantined: true);
            }
            var rows = state.Bookmarks.Select(pair => StoredBookmark.Create(pair.Key, pair.Value)).ToList();
            var payloadBytes = rows.Sum(row => row.EntryBytes);
            InsertUser(connection, transaction, userIdN, state.Revision, rows.Count, payloadBytes);
            foreach (var row in rows) Upsert(connection, transaction, userIdN, row);
            transaction.Commit();

            if (File.Exists(legacyPath))
            {
                try
                {
                    var archive = legacyPath + ".migrated-" + DateTime.UtcNow.ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture);
                    File.Move(legacyPath, archive, overwrite: false);
                    _logger.LogInformation("Migrated {BookmarkCount} legacy bookmarks for user {UserId} into the indexed store.", rows.Count, userIdN);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "The indexed bookmark store is authoritative, but the legacy file could not be archived.");
                }
            }
            // Lazy imports mark the shared recovery snapshot dirty. The
            // coalesced worker keeps whole-database I/O off this request path.
            ScheduleBoundedBackup();
            return userIdN;
        }

        private UserBookmark ReadLegacy(string path)
        {
            var length = new FileInfo(path).Length;
            if (length > PersistedPayloadPolicy.AbsolutePersistedBytes)
            {
                throw new InvalidDataException("Legacy bookmark.json exceeds the bounded migration size.");
            }
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            var state = JsonSerializer.Deserialize<UserBookmark>(stream, PersistedJson.ReadOptions)
                ?? throw new InvalidDataException("Legacy bookmark.json deserialized to null.");
            if (state.Revision < 0 || state.Bookmarks == null
                || state.Bookmarks.Count > MaximumLegacyRepairBookmarks
                || state.Bookmarks.Any(pair => pair.Value == null))
            {
                throw new InvalidDataException("Legacy bookmark.json has an invalid repair shape.");
            }
            return state;
        }

        private static void QuarantineLegacy(string legacyPath, string unhealthyPath, Exception cause)
        {
            if (!File.Exists(legacyPath)) return;
            var directory = Path.GetDirectoryName(legacyPath)
                ?? throw new InvalidDataException("Legacy bookmark path has no parent directory.", cause);
            var suffix = DateTime.UtcNow.ToString("yyyyMMddHHmmssfff", CultureInfo.InvariantCulture);
            var backup = Path.Combine(directory, LegacyFileName + ".corrupt-" + suffix);
            File.Move(legacyPath, backup, overwrite: false);
            try
            {
                AtomicFile.WriteAllText(
                    unhealthyPath,
                    JsonSerializer.Serialize(new
                    {
                        file = LegacyFileName,
                        quarantinedAt = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture),
                        error = cause.GetType().Name
                    }, PersistedJson.WriteOptions));
            }
            catch
            {
                File.Move(backup, legacyPath, overwrite: false);
                throw;
            }
        }

        private void EnsureReady()
        {
            if (_ready) return;
            lock (InitializationLock)
            {
                if (_ready) return;
                if (_initializationError != null) throw new InvalidDataException("Bookmark database initialization previously failed.", _initializationError);
                try
                {
                    Directory.CreateDirectory(_configBaseDir);
                    CleanupStaleArtifacts();
                    if (File.Exists(DatabasePath))
                    {
                        ValidateExistingDatabaseOrRecover();
                    }
                    else if (HasDatabaseBackups())
                    {
                        // A crash may occur after the primary was quarantined but
                        // before the verified replacement was published. Backups
                        // prove this is recovery, not a first-run empty database.
                        if (!TryRestoreLatestBackup())
                        {
                            throw new InvalidDataException("The primary bookmark database is missing and no valid bounded backup is available.");
                        }
                    }
                    else
                    {
                        CreateEmptyDatabase(DatabasePath);
                    }

                    using (var connection = OpenConnection(readOnly: false))
                    {
                        CreateSchema(connection);
                        VerifyQuickCheck(connection);
                    }
                    _ready = true;
                    InitializeBackupSchedule();
                    ScheduleBoundedBackup();
                    _logger.LogInformation("Indexed bookmark store is ready.");
                }
                catch (Exception ex)
                {
                    _initializationError = ex;
                    _logger.LogError(ex, "Indexed bookmark store initialization failed.");
                    throw;
                }
            }
        }

        private void ValidateExistingDatabaseOrRecover()
        {
            try
            {
                // Validate before any schema creation or writable open. SQLite
                // otherwise treats a zero-byte/truncated file as a new, valid
                // database and silently turns data loss into an empty store.
                using var connection = OpenStandalone(DatabasePath, SqliteOpenMode.ReadOnly);
                VerifyOwnedDatabase(connection);
            }
            catch (Exception ex) when (ex is SqliteException or InvalidDataException)
            {
                _logger.LogError(ex, "Bookmark database failed its integrity check; attempting bounded backup recovery.");
                MoveCorruptDatabaseGroup();
                if (!TryRestoreLatestBackup())
                {
                    throw new InvalidDataException("Bookmark database is corrupt and no valid bounded backup is available.", ex);
                }
            }
        }

        private SqliteConnection OpenConnection(bool readOnly)
        {
            var connection = new SqliteConnection(new SqliteConnectionStringBuilder
            {
                DataSource = DatabasePath,
                Mode = readOnly ? SqliteOpenMode.ReadOnly : SqliteOpenMode.ReadWriteCreate,
                Pooling = false,
                Cache = SqliteCacheMode.Private
            }.ToString());
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
            var connection = new SqliteConnection(new SqliteConnectionStringBuilder
            {
                DataSource = path,
                Mode = mode,
                Pooling = false,
                Cache = SqliteCacheMode.Private
            }.ToString());
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = "PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;";
            command.ExecuteNonQuery();
            return connection;
        }

        private bool CreateBoundedBackup()
        {
            var destinationPath = UniquePath(DatabasePath + ".backup-" + UtcStamp());
            var temporaryPath = destinationPath + ".tmp";
            try
            {
                var sourceBytes = new[] { DatabasePath, DatabasePath + "-wal", DatabasePath + "-shm" }
                    .Where(File.Exists)
                    .Sum(path => new FileInfo(path).Length);
                if (sourceBytes > MaximumDatabaseBackupBytes)
                {
                    _logger.LogWarning(
                        "Skipped bookmark database backup because its {DatabaseBytes} byte source exceeds the {MaximumBytes} byte global snapshot bound.",
                        sourceBytes,
                        MaximumDatabaseBackupBytes);
                    return false;
                }
                using (var source = OpenConnection(readOnly: true))
                using (var destination = OpenStandalone(temporaryPath, SqliteOpenMode.ReadWriteCreate))
                {
                    source.BackupDatabase(destination);
                    using (var journal = destination.CreateCommand())
                    {
                        journal.CommandText = "PRAGMA journal_mode=DELETE;";
                        if (!string.Equals(journal.ExecuteScalar() as string, "delete", StringComparison.OrdinalIgnoreCase))
                        {
                            throw new InvalidDataException("Bookmark backup could not leave WAL journal mode.");
                        }
                    }
                    VerifyOwnedDatabase(destination);
                }
                if (new FileInfo(temporaryPath).Length > MaximumDatabaseBackupBytes)
                {
                    throw new InvalidDataException("Bookmark database backup exceeds the global snapshot bound.");
                }
                TryDelete(temporaryPath + "-wal");
                TryDelete(temporaryPath + "-shm");
                File.Move(temporaryPath, destinationPath);
                PruneFiles(DatabaseFileName + ".backup-*", RetainedDatabaseBackups);
                return true;
            }
            catch (Exception ex)
            {
                TryDelete(temporaryPath);
                TryDelete(temporaryPath + "-wal");
                TryDelete(temporaryPath + "-shm");
                _logger.LogWarning(ex, "Could not create the bounded bookmark database backup.");
                return false;
            }
        }

        private void InitializeBackupSchedule()
        {
            var newest = Directory.GetFiles(_configBaseDir, DatabaseFileName + ".backup-*")
                .Where(IsFinalBackupFile)
                .Select(File.GetLastWriteTimeUtc)
                .DefaultIfEmpty(DateTime.MinValue)
                .Max();
            lock (_backupLock) _lastBackupUtc = newest;
        }

        private void ScheduleBoundedBackup()
        {
            lock (_backupLock)
            {
                _backupRequestGeneration++;
                if (_backupWorker is { IsCompleted: false }) return;
                _backupWorker = Task.Run(RunBackupWorkerAsync);
            }
        }

        private async Task RunBackupWorkerAsync()
        {
            try
            {
                await Task.Delay(BackupDebounce).ConfigureAwait(false);
                while (true)
                {
                    TimeSpan delay;
                    lock (_backupLock)
                    {
                        var due = _lastBackupUtc + MinimumBackupInterval;
                        delay = due > DateTime.UtcNow ? due - DateTime.UtcNow : TimeSpan.Zero;
                    }
                    if (delay > TimeSpan.Zero) await Task.Delay(delay).ConfigureAwait(false);

                    // Capture after the rate-limit wait: every commit completed
                    // before the backup opens is already represented by this
                    // snapshot. Only a write racing the actual attempt needs a
                    // later generation.
                    long generation;
                    lock (_backupLock) generation = _backupRequestGeneration;
                    var created = CreateBoundedBackup();
                    lock (_backupLock)
                    {
                        if (created) _lastBackupUtc = DateTime.UtcNow;
                        // A stable generation has no newer state to protect.
                        // Stop after either success or a bounded failure (for
                        // example, a source above the 1 GiB ceiling) instead of
                        // retrying and logging every debounce interval. A write
                        // that arrived during the attempt advances the
                        // generation and earns one coalesced follow-up.
                        if (_backupRequestGeneration == generation)
                        {
                            _backupWorker = null;
                            return;
                        }
                    }
                    if (!created) await Task.Delay(BackupDebounce).ConfigureAwait(false);
                }
            }
            catch (Exception ex)
            {
                lock (_backupLock) _backupWorker = null;
                _logger.LogWarning(ex, "The deferred bookmark database backup worker stopped unexpectedly.");
            }
        }

        private void MoveCorruptDatabaseGroup()
        {
            var suffix = NextCorruptGroupSuffix();
            foreach (var path in new[] { DatabasePath, DatabasePath + "-wal", DatabasePath + "-shm" })
            {
                if (File.Exists(path)) File.Move(path, path + suffix);
            }
            PruneCorruptDatabaseGroups();
        }

        private bool HasDatabaseBackups()
            => Directory.GetFiles(_configBaseDir, DatabaseFileName + ".backup-*")
                .Any(IsFinalBackupFile);

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
                         .Where(IsFinalBackupFile)
                         .OrderByDescending(File.GetLastWriteTimeUtc)
                         .ThenByDescending(path => path, StringComparer.Ordinal))
            {
                var restore = DatabasePath + ".restoring-" + Guid.NewGuid().ToString("N");
                try
                {
                    if (new FileInfo(backup).Length > MaximumDatabaseBackupBytes)
                    {
                        throw new InvalidDataException("Bookmark database backup exceeds the global snapshot bound.");
                    }
                    File.Copy(backup, restore);
                    using (var connection = OpenStandalone(restore, SqliteOpenMode.ReadWrite))
                    {
                        VerifyOwnedDatabase(connection);
                    }
                    QuarantineLiveSidecars();
                    File.Move(restore, DatabasePath);
                    _logger.LogWarning("Recovered the bookmark database from bounded backup {BackupFile}.", Path.GetFileName(backup));
                    return true;
                }
                catch (Exception ex)
                {
                    TryDelete(restore);
                    _logger.LogWarning(ex, "Rejected an invalid bookmark database backup {BackupFile}.", Path.GetFileName(backup));
                }
            }
            return false;
        }

        private void QuarantineLiveSidecars()
        {
            var suffix = NextCorruptGroupSuffix();
            foreach (var path in new[] { DatabasePath + "-wal", DatabasePath + "-shm" })
            {
                if (File.Exists(path)) File.Move(path, path + suffix);
            }
            PruneCorruptDatabaseGroups();
        }

        private void PruneCorruptDatabaseGroups()
        {
            var primaryFiles = Directory.GetFiles(_configBaseDir, DatabaseFileName + ".corrupt-*")
                .OrderByDescending(File.GetLastWriteTimeUtc).ToArray();
            foreach (var oldPrimary in primaryFiles.Skip(RetainedDatabaseBackups))
            {
                TryDelete(oldPrimary);
                TryDelete(DatabasePath + "-wal" + oldPrimary[DatabasePath.Length..]);
                TryDelete(DatabasePath + "-shm" + oldPrimary[DatabasePath.Length..]);
            }
            foreach (var prefix in new[] { DatabaseFileName + "-wal.corrupt-*", DatabaseFileName + "-shm.corrupt-*" })
            {
                foreach (var orphan in Directory.GetFiles(_configBaseDir, prefix)
                             .OrderByDescending(File.GetLastWriteTimeUtc).Skip(RetainedDatabaseBackups))
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
                DatabaseFileName + ".restoring-*",
                DatabaseFileName + ".backup-*.tmp",
                DatabaseFileName + ".backup-*.tmp-wal",
                DatabaseFileName + ".backup-*.tmp-shm"
            })
            {
                foreach (var path in Directory.GetFiles(_configBaseDir, pattern))
                {
                    if (File.GetLastWriteTimeUtc(path) < cutoff) TryDelete(path);
                }
            }
        }

        private void PruneFiles(string pattern, int keep)
        {
            foreach (var path in Directory.GetFiles(_configBaseDir, Path.GetFileName(pattern))
                         .Where(IsFinalBackupFile)
                         .OrderByDescending(File.GetLastWriteTimeUtc).Skip(keep))
            {
                TryDelete(path);
            }
        }

        private static bool IsFinalBackupFile(string path)
        {
            const string prefix = DatabaseFileName + ".backup-";
            var fileName = Path.GetFileName(path);
            if (!fileName.StartsWith(prefix, StringComparison.Ordinal)) return false;
            var suffix = fileName[prefix.Length..];
            return (suffix.Length == 17 && suffix.All(char.IsAsciiDigit))
                || (suffix.Length == 50
                    && suffix[17] == '-'
                    && suffix[..17].All(char.IsAsciiDigit)
                    && suffix[18..].All(Uri.IsHexDigit));
        }

        private static void CreateSchema(SqliteConnection connection)
        {
            using var command = connection.CreateCommand();
            command.CommandText = """
                CREATE TABLE IF NOT EXISTS BookmarkUsers (
                    UserId TEXT PRIMARY KEY,
                    Revision INTEGER NOT NULL CHECK (Revision >= 0),
                    BookmarkCount INTEGER NOT NULL CHECK (BookmarkCount >= 0),
                    PayloadBytes INTEGER NOT NULL CHECK (PayloadBytes >= 0)
                ) WITHOUT ROWID;

                CREATE TABLE IF NOT EXISTS Bookmarks (
                    UserId TEXT NOT NULL,
                    BookmarkId TEXT NOT NULL,
                    ItemId TEXT NOT NULL,
                    IdentityVersion INTEGER NOT NULL,
                    ItemType TEXT NOT NULL,
                    TmdbId TEXT NOT NULL,
                    TvdbId TEXT NOT NULL,
                    SeriesTmdbId TEXT NOT NULL,
                    SeriesTvdbId TEXT NOT NULL,
                    MediaType TEXT NOT NULL,
                    SeasonNumber INTEGER NULL,
                    EpisodeNumber INTEGER NULL,
                    EpisodeEndNumber INTEGER NULL,
                    Name TEXT NOT NULL,
                    Timestamp REAL NOT NULL,
                    Label TEXT NOT NULL,
                    CreatedAt TEXT NOT NULL,
                    UpdatedAt TEXT NOT NULL,
                    SyncedFrom TEXT NOT NULL,
                    EntryBytes INTEGER NOT NULL CHECK (EntryBytes > 0),
                    PRIMARY KEY (UserId, BookmarkId),
                    FOREIGN KEY (UserId) REFERENCES BookmarkUsers(UserId) ON DELETE CASCADE
                ) WITHOUT ROWID;

                CREATE INDEX IF NOT EXISTS IX_Bookmarks_UserItem
                    ON Bookmarks (UserId, ItemId, BookmarkId);
                CREATE INDEX IF NOT EXISTS IX_Bookmarks_UserMedia
                    ON Bookmarks (UserId, MediaType, BookmarkId);

                CREATE TABLE IF NOT EXISTS BookmarkStoreMetadata (
                    StoreId TEXT PRIMARY KEY,
                    SchemaVersion INTEGER NOT NULL
                ) WITHOUT ROWID;

                INSERT OR IGNORE INTO BookmarkStoreMetadata (StoreId, SchemaVersion)
                    VALUES ('JellyfinCanopy.Bookmarks', 1);
                """;
            command.ExecuteNonQuery();
        }

        private static void VerifyQuickCheck(SqliteConnection connection)
        {
            using var command = connection.CreateCommand();
            command.CommandText = "PRAGMA quick_check;";
            if (!string.Equals(command.ExecuteScalar() as string, "ok", StringComparison.Ordinal))
            {
                throw new InvalidDataException("Bookmark SQLite quick_check did not return ok.");
            }
        }

        private static void VerifyOwnedDatabase(SqliteConnection connection)
        {
            VerifyQuickCheck(connection);
            VerifyRequiredColumns(connection, "BookmarkStoreMetadata", new[] { "StoreId", "SchemaVersion" });
            VerifyRequiredColumns(connection, "BookmarkUsers", new[] { "UserId", "Revision", "BookmarkCount", "PayloadBytes" });
            VerifyRequiredColumns(connection, "Bookmarks", new[]
            {
                "UserId", "BookmarkId", "ItemId", "IdentityVersion", "ItemType", "TmdbId", "TvdbId",
                "SeriesTmdbId", "SeriesTvdbId", "MediaType", "SeasonNumber", "EpisodeNumber",
                "EpisodeEndNumber", "Name", "Timestamp", "Label", "CreatedAt", "UpdatedAt", "SyncedFrom", "EntryBytes"
            });
            using var command = connection.CreateCommand();
            command.CommandText = """
                SELECT
                    (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('BookmarkStoreMetadata', 'BookmarkUsers', 'Bookmarks')),
                    (SELECT COUNT(*) FROM BookmarkStoreMetadata WHERE StoreId = $storeId AND SchemaVersion = $schemaVersion),
                    (SELECT COUNT(*) FROM BookmarkStoreMetadata),
                    (SELECT COUNT(*) FROM BookmarkUsers u
                     WHERE u.BookmarkCount != (SELECT COUNT(*) FROM Bookmarks b WHERE b.UserId = u.UserId)
                        OR u.PayloadBytes != COALESCE((SELECT SUM(b.EntryBytes) FROM Bookmarks b WHERE b.UserId = u.UserId), 0)),
                    (SELECT COUNT(*) FROM Bookmarks b
                     WHERE NOT EXISTS (SELECT 1 FROM BookmarkUsers u WHERE u.UserId = b.UserId));
                """;
            command.Parameters.AddWithValue("$storeId", DatabaseStoreId);
            command.Parameters.AddWithValue("$schemaVersion", DatabaseSchemaVersion);
            try
            {
                using var reader = command.ExecuteReader();
                if (!reader.Read()
                    || reader.GetInt32(0) != 3
                    || reader.GetInt32(1) != 1
                    || reader.GetInt32(2) != 1
                    || reader.GetInt32(3) != 0
                    || reader.GetInt32(4) != 0)
                {
                    throw new InvalidDataException("Bookmark database identity, schema, or metadata invariants are invalid.");
                }
            }
            catch (SqliteException ex)
            {
                throw new InvalidDataException("Bookmark database does not contain the required owned schema.", ex);
            }
        }

        private static void VerifyRequiredColumns(SqliteConnection connection, string table, IReadOnlyCollection<string> required)
        {
            using var command = connection.CreateCommand();
            command.CommandText = $"PRAGMA table_info({table});";
            using var reader = command.ExecuteReader();
            var actual = new HashSet<string>(StringComparer.Ordinal);
            while (reader.Read()) actual.Add(reader.GetString(1));
            if (!required.All(actual.Contains))
            {
                throw new InvalidDataException($"Bookmark database table {table} is missing required owned columns.");
            }
        }

        private static bool UserExists(SqliteConnection connection, SqliteTransaction transaction, string userId)
        {
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = "SELECT EXISTS(SELECT 1 FROM BookmarkUsers WHERE UserId = $userId);";
            command.Parameters.AddWithValue("$userId", userId);
            return Convert.ToInt64(command.ExecuteScalar(), CultureInfo.InvariantCulture) == 1;
        }

        private static void InsertUser(SqliteConnection connection, SqliteTransaction transaction, string userId, long revision, int count, int payloadBytes)
        {
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = "INSERT INTO BookmarkUsers (UserId, Revision, BookmarkCount, PayloadBytes) VALUES ($userId, $revision, $count, $bytes);";
            command.Parameters.AddWithValue("$userId", userId);
            command.Parameters.AddWithValue("$revision", revision);
            command.Parameters.AddWithValue("$count", count);
            command.Parameters.AddWithValue("$bytes", payloadBytes);
            command.ExecuteNonQuery();
        }

        private static (long Revision, int Count, int PayloadBytes) ReadMetadata(SqliteConnection connection, SqliteTransaction transaction, string userId)
        {
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = "SELECT Revision, BookmarkCount, PayloadBytes FROM BookmarkUsers WHERE UserId = $userId;";
            command.Parameters.AddWithValue("$userId", userId);
            using var reader = command.ExecuteReader();
            if (!reader.Read()) throw new InvalidDataException("Bookmark user metadata is missing.");
            return (reader.GetInt64(0), reader.GetInt32(1), reader.GetInt32(2));
        }

        private static long ReadRevision(SqliteConnection connection, SqliteTransaction transaction, string userId)
            => ReadMetadata(connection, transaction, userId).Revision;

        private static BookmarkStoreCounts ReadCounts(
            SqliteConnection connection,
            SqliteTransaction transaction,
            string userId)
        {
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = """
                SELECT u.Revision, u.BookmarkCount, u.PayloadBytes,
                       COALESCE(SUM(CASE WHEN lower(trim(b.MediaType)) IN ('movie', 'film', 'musicvideo') THEN 1 ELSE 0 END), 0),
                       COALESCE(SUM(CASE WHEN lower(trim(b.MediaType)) IN ('tv', 'series', 'season', 'episode', 'tvshow') THEN 1 ELSE 0 END), 0)
                FROM BookmarkUsers u
                LEFT JOIN Bookmarks b ON b.UserId = u.UserId
                WHERE u.UserId = $userId
                GROUP BY u.UserId, u.Revision, u.BookmarkCount, u.PayloadBytes;
                """;
            command.Parameters.AddWithValue("$userId", userId);
            using var reader = command.ExecuteReader();
            if (!reader.Read()) throw new InvalidDataException("Bookmark user metadata is missing.");
            var total = reader.GetInt32(1);
            var movie = reader.GetInt32(3);
            var tv = reader.GetInt32(4);
            return new BookmarkStoreCounts
            {
                Revision = reader.GetInt64(0),
                Total = total,
                PayloadBytes = reader.GetInt32(2),
                Movie = movie,
                Tv = tv,
                Other = total - movie - tv
            };
        }

        private static void UpdateMetadata(SqliteConnection connection, SqliteTransaction transaction, string userId, long revision, int count, int payloadBytes)
        {
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = "UPDATE BookmarkUsers SET Revision = $revision, BookmarkCount = $count, PayloadBytes = $bytes WHERE UserId = $userId;";
            command.Parameters.AddWithValue("$revision", revision);
            command.Parameters.AddWithValue("$count", count);
            command.Parameters.AddWithValue("$bytes", payloadBytes);
            command.Parameters.AddWithValue("$userId", userId);
            command.ExecuteNonQuery();
        }

        private static UserBookmark ReadState(SqliteConnection connection, SqliteTransaction? transaction, string userId)
        {
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = """
                SELECT BookmarkId, ItemId, IdentityVersion, ItemType, TmdbId, TvdbId,
                       SeriesTmdbId, SeriesTvdbId, MediaType, SeasonNumber, EpisodeNumber,
                       EpisodeEndNumber, Name, Timestamp, Label, CreatedAt, UpdatedAt, SyncedFrom
                FROM Bookmarks WHERE UserId = $userId ORDER BY BookmarkId;
                """;
            command.Parameters.AddWithValue("$userId", userId);
            var bookmarks = ReadBookmarks(command, PersistedPayloadPolicy.MaximumBookmarks);
            long revision;
            using (var revisionCommand = connection.CreateCommand())
            {
                revisionCommand.Transaction = transaction;
                revisionCommand.CommandText = "SELECT Revision FROM BookmarkUsers WHERE UserId = $userId;";
                revisionCommand.Parameters.AddWithValue("$userId", userId);
                revision = Convert.ToInt64(revisionCommand.ExecuteScalar(), CultureInfo.InvariantCulture);
            }
            return new UserBookmark { Revision = revision, Bookmarks = bookmarks };
        }

        private static Dictionary<string, BookmarkItem> ReadBookmarks(SqliteCommand command, int capacity)
        {
            var result = new Dictionary<string, BookmarkItem>(Math.Max(0, capacity), StringComparer.Ordinal);
            using var reader = command.ExecuteReader();
            while (reader.Read()) result.Add(reader.GetString(0), ReadBookmark(reader, 1));
            return result;
        }

        private static StoredBookmark? ReadStoredBookmark(SqliteConnection connection, SqliteTransaction transaction, string userId, string bookmarkId)
        {
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = """
                SELECT ItemId, IdentityVersion, ItemType, TmdbId, TvdbId, SeriesTmdbId,
                       SeriesTvdbId, MediaType, SeasonNumber, EpisodeNumber, EpisodeEndNumber,
                       Name, Timestamp, Label, CreatedAt, UpdatedAt, SyncedFrom, EntryBytes
                FROM Bookmarks WHERE UserId = $userId AND BookmarkId = $bookmarkId;
                """;
            command.Parameters.AddWithValue("$userId", userId);
            command.Parameters.AddWithValue("$bookmarkId", bookmarkId);
            using var reader = command.ExecuteReader();
            return reader.Read()
                ? new StoredBookmark(bookmarkId, ReadBookmark(reader, 0), reader.GetInt32(17))
                : null;
        }

        private static BookmarkItem ReadBookmark(SqliteDataReader reader, int offset)
            => new()
            {
                ItemId = reader.GetString(offset),
                IdentityVersion = reader.GetInt32(offset + 1),
                ItemType = reader.GetString(offset + 2),
                TmdbId = reader.GetString(offset + 3),
                TvdbId = reader.GetString(offset + 4),
                SeriesTmdbId = reader.GetString(offset + 5),
                SeriesTvdbId = reader.GetString(offset + 6),
                MediaType = reader.GetString(offset + 7),
                SeasonNumber = reader.IsDBNull(offset + 8) ? null : reader.GetInt32(offset + 8),
                EpisodeNumber = reader.IsDBNull(offset + 9) ? null : reader.GetInt32(offset + 9),
                EpisodeEndNumber = reader.IsDBNull(offset + 10) ? null : reader.GetInt32(offset + 10),
                Name = reader.GetString(offset + 11),
                Timestamp = reader.GetDouble(offset + 12),
                Label = reader.GetString(offset + 13),
                CreatedAt = reader.GetString(offset + 14),
                UpdatedAt = reader.GetString(offset + 15),
                SyncedFrom = reader.GetString(offset + 16)
            };

        private static void Upsert(SqliteConnection connection, SqliteTransaction transaction, string userId, StoredBookmark row)
        {
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = """
                INSERT INTO Bookmarks (
                    UserId, BookmarkId, ItemId, IdentityVersion, ItemType, TmdbId, TvdbId,
                    SeriesTmdbId, SeriesTvdbId, MediaType, SeasonNumber, EpisodeNumber,
                    EpisodeEndNumber, Name, Timestamp, Label, CreatedAt, UpdatedAt, SyncedFrom, EntryBytes)
                VALUES (
                    $userId, $bookmarkId, $itemId, $identityVersion, $itemType, $tmdbId, $tvdbId,
                    $seriesTmdbId, $seriesTvdbId, $mediaType, $seasonNumber, $episodeNumber,
                    $episodeEndNumber, $name, $timestamp, $label, $createdAt, $updatedAt, $syncedFrom, $entryBytes)
                ON CONFLICT(UserId, BookmarkId) DO UPDATE SET
                    ItemId = excluded.ItemId, IdentityVersion = excluded.IdentityVersion,
                    ItemType = excluded.ItemType, TmdbId = excluded.TmdbId, TvdbId = excluded.TvdbId,
                    SeriesTmdbId = excluded.SeriesTmdbId, SeriesTvdbId = excluded.SeriesTvdbId,
                    MediaType = excluded.MediaType, SeasonNumber = excluded.SeasonNumber,
                    EpisodeNumber = excluded.EpisodeNumber, EpisodeEndNumber = excluded.EpisodeEndNumber,
                    Name = excluded.Name, Timestamp = excluded.Timestamp, Label = excluded.Label,
                    CreatedAt = excluded.CreatedAt, UpdatedAt = excluded.UpdatedAt,
                    SyncedFrom = excluded.SyncedFrom, EntryBytes = excluded.EntryBytes;
                """;
            AddBookmarkParameters(command, userId, row);
            command.ExecuteNonQuery();
        }

        private static void AddBookmarkParameters(SqliteCommand command, string userId, StoredBookmark row)
        {
            var bookmark = row.Bookmark;
            command.Parameters.AddWithValue("$userId", userId);
            command.Parameters.AddWithValue("$bookmarkId", row.BookmarkId);
            command.Parameters.AddWithValue("$itemId", bookmark.ItemId);
            command.Parameters.AddWithValue("$identityVersion", bookmark.IdentityVersion);
            command.Parameters.AddWithValue("$itemType", bookmark.ItemType);
            command.Parameters.AddWithValue("$tmdbId", bookmark.TmdbId);
            command.Parameters.AddWithValue("$tvdbId", bookmark.TvdbId);
            command.Parameters.AddWithValue("$seriesTmdbId", bookmark.SeriesTmdbId);
            command.Parameters.AddWithValue("$seriesTvdbId", bookmark.SeriesTvdbId);
            command.Parameters.AddWithValue("$mediaType", bookmark.MediaType);
            command.Parameters.AddWithValue("$seasonNumber", bookmark.SeasonNumber.HasValue ? bookmark.SeasonNumber.Value : DBNull.Value);
            command.Parameters.AddWithValue("$episodeNumber", bookmark.EpisodeNumber.HasValue ? bookmark.EpisodeNumber.Value : DBNull.Value);
            command.Parameters.AddWithValue("$episodeEndNumber", bookmark.EpisodeEndNumber.HasValue ? bookmark.EpisodeEndNumber.Value : DBNull.Value);
            command.Parameters.AddWithValue("$name", bookmark.Name);
            command.Parameters.AddWithValue("$timestamp", bookmark.Timestamp);
            command.Parameters.AddWithValue("$label", bookmark.Label);
            command.Parameters.AddWithValue("$createdAt", bookmark.CreatedAt);
            command.Parameters.AddWithValue("$updatedAt", bookmark.UpdatedAt);
            command.Parameters.AddWithValue("$syncedFrom", bookmark.SyncedFrom);
            command.Parameters.AddWithValue("$entryBytes", row.EntryBytes);
        }

        private static void Delete(SqliteConnection connection, SqliteTransaction transaction, string userId, string bookmarkId)
        {
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = "DELETE FROM Bookmarks WHERE UserId = $userId AND BookmarkId = $bookmarkId;";
            command.Parameters.AddWithValue("$userId", userId);
            command.Parameters.AddWithValue("$bookmarkId", bookmarkId);
            command.ExecuteNonQuery();
        }

        private static void AddPageParameters(SqliteCommand command, string userId, string? itemId, string? mediaType)
        {
            command.Parameters.AddWithValue("$userId", userId);
            if (itemId != null) command.Parameters.AddWithValue("$itemId", itemId);
        }

        private static string EncodeItemCursor(string itemId)
            => "v1." + Convert.ToBase64String(Encoding.UTF8.GetBytes(itemId))
                .TrimEnd('=').Replace('+', '-').Replace('/', '_');

        private static string? DecodeItemCursor(string? cursor)
        {
            if (cursor == null) return null;
            if (!cursor.StartsWith("v1.", StringComparison.Ordinal))
            {
                throw new ArgumentException("Bookmark cleanup cursor is invalid.", nameof(cursor));
            }
            var encoded = cursor[3..].Replace('-', '+').Replace('_', '/');
            encoded = encoded.PadRight((encoded.Length + 3) / 4 * 4, '=');
            try
            {
                var value = Encoding.UTF8.GetString(Convert.FromBase64String(encoded));
                if (value.Length > PersistedPayloadPolicy.MaximumBookmarkItemIdLength
                    || !string.Equals(EncodeItemCursor(value), cursor, StringComparison.Ordinal))
                {
                    throw new ArgumentException("Bookmark cleanup cursor is invalid.", nameof(cursor));
                }
                return value;
            }
            catch (FormatException ex)
            {
                throw new ArgumentException("Bookmark cleanup cursor is invalid.", nameof(cursor), ex);
            }
        }

        private static BookmarkStoreMutationResult Invalid(long revision)
            => Failure(BookmarkStoreStatus.Invalid, revision, "Bookmark input is invalid or exceeds a field limit.");

        private static BookmarkStoreMutationResult Failure(BookmarkStoreStatus status, long revision, string message)
            => new() { Status = status, Revision = revision, Message = message };

        private static string NormalizeUserId(string userId)
        {
            if (!Guid.TryParse(userId, out var parsed) || parsed == Guid.Empty)
            {
                throw new InvalidDataException("Invalid bookmark user id.");
            }
            return parsed.ToString("N");
        }

        private static BookmarkItem Clone(BookmarkItem source)
            => new()
            {
                ItemId = source.ItemId ?? string.Empty,
                IdentityVersion = source.IdentityVersion,
                ItemType = source.ItemType ?? string.Empty,
                TmdbId = source.TmdbId ?? string.Empty,
                TvdbId = source.TvdbId ?? string.Empty,
                SeriesTmdbId = source.SeriesTmdbId ?? string.Empty,
                SeriesTvdbId = source.SeriesTvdbId ?? string.Empty,
                MediaType = source.MediaType ?? string.Empty,
                SeasonNumber = source.SeasonNumber,
                EpisodeNumber = source.EpisodeNumber,
                EpisodeEndNumber = source.EpisodeEndNumber,
                Name = source.Name ?? string.Empty,
                Timestamp = source.Timestamp,
                Label = source.Label ?? string.Empty,
                CreatedAt = source.CreatedAt ?? string.Empty,
                UpdatedAt = source.UpdatedAt ?? string.Empty,
                SyncedFrom = source.SyncedFrom ?? string.Empty
            };

        private static bool BookmarkEquals(BookmarkItem left, BookmarkItem right)
            => left.ItemId == right.ItemId
            && left.IdentityVersion == right.IdentityVersion
            && left.ItemType == right.ItemType
            && left.TmdbId == right.TmdbId
            && left.TvdbId == right.TvdbId
            && left.SeriesTmdbId == right.SeriesTmdbId
            && left.SeriesTvdbId == right.SeriesTvdbId
            && left.MediaType == right.MediaType
            && left.SeasonNumber == right.SeasonNumber
            && left.EpisodeNumber == right.EpisodeNumber
            && left.EpisodeEndNumber == right.EpisodeEndNumber
            && left.Name == right.Name
            && left.Timestamp.Equals(right.Timestamp)
            && left.Label == right.Label
            && left.CreatedAt == right.CreatedAt
            && left.UpdatedAt == right.UpdatedAt
            && left.SyncedFrom == right.SyncedFrom;

        private static string UtcStamp()
            => DateTime.UtcNow.ToString("yyyyMMddHHmmssfff", CultureInfo.InvariantCulture);

        private static string UniquePath(string desired)
            => File.Exists(desired) ? desired + "-" + Guid.NewGuid().ToString("N") : desired;

        private static void TryDelete(string path)
        {
            try
            {
                if (File.Exists(path)) File.Delete(path);
            }
            catch
            {
                // Cleanup must not mask the original storage or recovery failure.
            }
        }

        private sealed record StoredBookmark(string BookmarkId, BookmarkItem Bookmark, int EntryBytes)
        {
            public static StoredBookmark Create(string bookmarkId, BookmarkItem bookmark)
            {
                var cloned = Clone(bookmark);
                var bytes = Encoding.UTF8.GetByteCount(bookmarkId)
                    + JsonSerializer.SerializeToUtf8Bytes(cloned, PersistedJson.WriteOptions).Length
                    + 8;
                return new StoredBookmark(bookmarkId, cloned, bytes);
            }
        }
    }
}
