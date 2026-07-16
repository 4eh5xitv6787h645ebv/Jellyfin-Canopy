using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Configuration
{
    internal enum UserFileLockPhase
    {
        Waiting,
        Entered
    }

    internal readonly record struct UserFileLockObservation(
        string Operation,
        string UserId,
        string FileName,
        UserFileLockPhase Phase);

    /// <summary>
    /// Per-user configuration file IO: path resolution, lenient/strict reads,
    /// atomic saves, and the locked read-modify-write helper. Split out of
    /// UserConfigurationManager (which remains as a thin facade).
    /// </summary>
    internal class UserConfigurationStore
    {
        private readonly string _configBaseDir;
        private readonly ILogger _logger;
        private const int MaxCorruptBackupsPerFile = 5;
        private const long MaxCorruptBackupBytesPerFile = 32L * 1024 * 1024;
        private const string UnhealthySuffix = ".unhealthy";

        private static readonly HashSet<string> RecoverableFileNames = new HashSet<string>(StringComparer.Ordinal)
        {
            "settings.json",
            "shortcuts.json",
            "elsewhere.json",
            "bookmark.json",
            "hidden-content.json",
            "spoilerblur.json",
            "processed-watchlist-items.json"
        };

        // Static so the Singleton ResponseFilter and the Scoped IEventConsumer share one pool.
        private static readonly ConcurrentDictionary<string, object> _userFileLocks = new ConcurrentDictionary<string, object>();

        // Deterministic test seam for proving queue order at the actual store
        // ownership boundary. Production leaves this null; no timing or behavior
        // changes occur unless a test explicitly observes the phases.
        internal Action<UserFileLockObservation>? LockObserverForTests { get; set; }

        public UserConfigurationStore(string configBaseDir, ILogger logger)
        {
            _configBaseDir = configBaseDir;
            _logger = logger;
        }

        public object GetUserFileLock(string userId, string fileName)
        {
            var normalized = (userId ?? string.Empty).Replace("-", "").ToLowerInvariant();
            var key = normalized + "|" + (fileName ?? string.Empty);
            return _userFileLocks.GetOrAdd(key, _ => new object());
        }

        private TResult WithUserFileLock<TResult>(
            string operation,
            string userId,
            string fileName,
            Func<TResult> action)
        {
            LockObserverForTests?.Invoke(new UserFileLockObservation(
                operation,
                userId,
                fileName,
                UserFileLockPhase.Waiting));
            lock (GetUserFileLock(userId, fileName))
            {
                LockObserverForTests?.Invoke(new UserFileLockObservation(
                    operation,
                    userId,
                    fileName,
                    UserFileLockPhase.Entered));
                return action();
            }
        }

        private string GetUserConfigDir(string userId)
        {
            var normalizedUserId = (userId ?? string.Empty).Replace("-", "").ToLowerInvariant();
            var userDir = Path.Combine(_configBaseDir, normalizedUserId);

            // Refuse paths outside _configBaseDir in case a future caller forwards untrusted input.
            var fullBase = Path.GetFullPath(_configBaseDir + Path.DirectorySeparatorChar);
            var fullUser = Path.GetFullPath(userDir);
            if (!fullUser.StartsWith(fullBase, StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                    $"Refusing user-config path outside base directory: '{userId}'");
            }

            Directory.CreateDirectory(userDir);
            return userDir;
        }

        private string ResolveUserFile(string userId, string fileName)
        {
            if (string.IsNullOrWhiteSpace(fileName)
                || fileName == "." || fileName == ".."
                || fileName.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0
                || fileName.Contains('/') || fileName.Contains('\\')
                || Path.IsPathRooted(fileName))
            {
                throw new ArgumentException($"Invalid user-config filename: '{fileName}'", nameof(fileName));
            }
            return Path.Combine(GetUserConfigDir(userId), fileName);
        }

        public bool UserConfigurationExists(string userId, string fileName)
        {
            try
            {
                var configPath = ResolveUserFile(userId, fileName);
                // A quarantined file is deliberately absent from its authoritative
                // path, but it is not a first-run/missing store. Treat the durable
                // marker as existence so initialization paths cannot silently seed
                // defaults and bypass explicit recovery.
                return File.Exists(configPath) || UnhealthyMarkerExists(configPath);
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"Error checking existence for '{fileName}' of user '{userId}': {ex.Message}");
                return false;
            }
        }

        // Lenient read; returns new T() on missing/empty/unparseable. Write path should use GetUserConfigurationStrict.
        public T GetUserConfiguration<T>(string userId, string fileName) where T : new()
        {
            var configPath = ResolveUserFile(userId, fileName);

            // Lenient presentation reads keep their historical default-value
            // contract, but never reparse or relog a quarantined generation.
            try
            {
                if (UnhealthyMarkerExists(configPath)) return new T();
            }
            catch
            {
                // Preserve the lenient read contract for ordinary display state.
                // Strict and typed security reads below surface this as unavailable.
                return new T();
            }

            if (File.Exists(configPath))
            {
                try
                {
                    var json = File.ReadAllText(configPath);
                    if (string.IsNullOrWhiteSpace(json))
                    {
                        _logger.LogWarning($"Configuration file '{fileName}' for user '{userId}' is empty. Returning default.");
                        return new T();
                    }

                    // Silently skip JSON null values rather than throwing when the target
                    // C# property is a non-nullable type (e.g. bool). This handles the case
                    // where a field was previously bool? (stored as null on disk) and has
                    // since been changed to bool — without this the deserialization throws,
                    // GetUserConfiguration returns new T(), and the first subsequent save
                    // overwrites the user's real data with defaults.
                    // (Newtonsoft equivalent: NullValueHandling.Ignore on deserialization,
                    // reproduced by the StripNullMembers pre-pass — see PersistedJson.)
                    var settings = TryDeserializeStripped<T>(json);

                    if (settings == null)
                    {
                        _logger.LogWarning($"Deserialization of {fileName} resulted in null. Returning default.");
                        return new T();
                    }

                    return settings;
                }
                catch (Exception ex)
                {
                    _logger.LogError($"Error deserializing '{fileName}' for user '{userId}': {ex.Message}. Returning default configuration.");
                    return new T();
                }
            }

            return new T();
        }

        // Strict read for RMW: existing empty/null/garbage enters a durable,
        // fail-closed recovery state. The original bytes are atomically moved to
        // bounded forensic storage once; subsequent retries inspect only the
        // marker and cannot create more files or logs.
        public T GetUserConfigurationStrict<T>(string userId, string fileName) where T : new()
        {
            lock (GetUserFileLock(userId, fileName))
            {
                var configPath = ResolveUserFile(userId, fileName);
                if (UnhealthyMarkerExists(configPath))
                {
                    throw new UserStoreUnhealthyException(fileName, newlyQuarantined: false);
                }

                if (!File.Exists(configPath)) return new T();

                var sourceLength = new FileInfo(configPath).Length;
                if (sourceLength > PersistedPayloadPolicy.AbsolutePersistedBytes)
                {
                    string sourceHash;
                    using (var source = File.OpenRead(configPath))
                    {
                        sourceHash = Convert.ToHexString(SHA256.HashData(source)).ToLowerInvariant();
                    }

                    var fault = new InvalidDataException(
                        $"'{fileName}' exceeds the absolute {PersistedPayloadPolicy.AbsolutePersistedBytes}-byte store limit.");
                    throw QuarantineCorruptFile(userId, fileName, configPath, sourceHash, sourceLength, fault);
                }

                byte[] sourceBytes;
                string json;
                try
                {
                    sourceBytes = File.ReadAllBytes(configPath);
                    using var reader = new StreamReader(
                        new MemoryStream(sourceBytes, writable: false),
                        Encoding.UTF8,
                        detectEncodingFromByteOrderMarks: true);
                    json = reader.ReadToEnd();
                }
                catch (Exception ex)
                {
                    // An unavailable file is not proof of corrupt content. Do not
                    // create a misleading marker or copy when the bytes could not
                    // be read; callers surface the transient storage failure.
                    _logger.LogError($"Failed to read '{fileName}' for user '{userId}': {ex.Message}");
                    throw;
                }

                if (string.IsNullOrWhiteSpace(json)
                    || string.Equals(json.Trim(), "null", StringComparison.Ordinal))
                {
                    var fault = new InvalidDataException($"'{fileName}' is empty or literal null; refusing to overwrite.");
                    throw QuarantineCorruptFile(userId, fileName, configPath, sourceBytes, fault);
                }

                try
                {
                    // Tolerate the SAME legacy nulls the lenient GET path skips: a field
                    // that was once nullable (bool?/int?/string?) left a literal JSON null
                    // on disk and has since become non-nullable. Binding it directly throws,
                    // which used to 500 every save of an otherwise-fine file while the GET
                    // path read it correctly. Strip null members first (constructor defaults
                    // kept), exactly like GetUserConfiguration. Genuine corruption still
                    // fails: empty/whitespace/literal-null is rejected above, malformed JSON
                    // throws in JsonNode.Parse, and a non-object payload deserializes to null.
                    var parsed = TryDeserializeStripped<T>(json);
                    if (parsed == null)
                    {
                        throw new InvalidDataException($"'{fileName}' deserialized to null.");
                    }
                    return parsed;
                }
                catch (UserStoreUnhealthyException)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    throw QuarantineCorruptFile(userId, fileName, configPath, sourceBytes, ex);
                }
            }
        }

        // Shared JSON-null-tolerant deserialize used by every read path (lenient
        // GET, strict RMW, and the typed policy read) so all three classify a file
        // identically. Applies the StripNullMembers pre-pass (= Newtonsoft
        // NullValueHandling.Ignore) then binds with the shared ReadOptions. Throws
        // only for malformed JSON (JsonNode.Parse); returns null when the payload
        // parses but yields no object (literal null / non-object). Callers decide
        // what a null result means (lenient → new T(); strict/typed → corrupt).
        private static T? TryDeserializeStripped<T>(string json)
        {
            var node = JsonNode.Parse(json, documentOptions: PersistedJson.ParseOptions);
            // Legacy-name adoption runs on the same pre-pass so every read path
            // (lenient GET, typed policy read, strict RMW) sees current member
            // names, and the RMW rewrite self-heals the file on disk.
            return PersistedJson.StripNullMembers(PersistedJson.AdoptLegacySeerrMemberNames(node)) is JsonNode stripped
                ? stripped.Deserialize<T>(PersistedJson.ReadOptions)
                : default;
        }

        // Typed, side-effect-free policy read for security enforcement (Hidden
        // Content, Spoiler Guard). Unlike the lenient GET it never collapses a
        // fault into new T(), and unlike the strict RMW read it neither throws nor
        // rewrites/back-ups the file — enforcement reads must not mutate disk. It
        // classifies the outcome so the caller can retain last-known-good and fail
        // CLOSED on a cold-start fault instead of silently dropping protection.
        //
        //   Missing      → file absent; Value = new T() (an intentionally empty policy).
        //   Valid        → parsed; Value = the deserialized policy.
        //   Corrupt      → exists but empty/literal-null/malformed/deserialized-null; Value = null.
        //   Unavailable  → unreadable (I/O, permissions, or any escaping exception); Value = null.
        public UserConfigReadResult<T> ReadUserConfiguration<T>(string userId, string fileName) where T : new()
        {
            string configPath;
            try
            {
                configPath = ResolveUserFile(userId, fileName);
            }
            catch (Exception ex)
            {
                // A bad userId/fileName is a programming error, not an empty policy.
                // Fail closed: treat as Unavailable so callers retain protection.
                _logger.LogError($"Refusing to resolve policy file '{fileName}' for user '{userId}': {ex.Message}");
                return new UserConfigReadResult<T>(UserConfigReadStatus.Unavailable, default, ex.Message);
            }

            try
            {
                if (UnhealthyMarkerExists(configPath))
                {
                    return new UserConfigReadResult<T>(UserConfigReadStatus.Corrupt, default, "quarantined-recovery-required");
                }
            }
            catch (Exception ex)
            {
                _logger.LogError($"Unable to inspect recovery marker for policy file '{fileName}' for user '{userId}' — treating as UNAVAILABLE (protection retained): {ex.Message}");
                return new UserConfigReadResult<T>(UserConfigReadStatus.Unavailable, default, "recovery-marker-unavailable");
            }

            // Read directly and let the exception type classify the outcome. A
            // File.Exists pre-check must NOT own this decision: File.Exists returns
            // false (rather than throwing) for permission/stat/invalid-path/other
            // I/O failures and for a directory in the file's place, so it would
            // collapse an UNAVAILABLE policy into Missing → an empty fail-open
            // policy. Only a genuinely absent file (FileNotFound/DirectoryNotFound)
            // maps to Missing; every other failure fails closed as Unavailable.
            string json;
            try
            {
                json = File.ReadAllText(configPath);
            }
            catch (FileNotFoundException)
            {
                // ONLY a genuinely absent file is Missing. The user directory is
                // created during ResolveUserFile, so a read-stage
                // DirectoryNotFoundException means a path component vanished or the
                // backing store disconnected between resolution and read — a storage
                // fault, not a never-configured file. It must fall through to
                // Unavailable so last-known-good / fail-closed is retained.
                return new UserConfigReadResult<T>(UserConfigReadStatus.Missing, new T(), null);
            }
            catch (Exception ex)
            {
                _logger.LogError($"Unable to read policy file '{fileName}' for user '{userId}' — treating as UNAVAILABLE (protection retained): {ex.Message}");
                return new UserConfigReadResult<T>(UserConfigReadStatus.Unavailable, default, ex.Message);
            }

            if (string.IsNullOrWhiteSpace(json)
                || string.Equals(json.Trim(), "null", StringComparison.Ordinal))
            {
                _logger.LogError($"Policy file '{fileName}' for user '{userId}' is empty or literal-null — treating as CORRUPT (protection retained).");
                return new UserConfigReadResult<T>(UserConfigReadStatus.Corrupt, default, "empty-or-null");
            }

            try
            {
                var parsed = TryDeserializeStripped<T>(json);
                if (parsed == null)
                {
                    _logger.LogError($"Policy file '{fileName}' for user '{userId}' deserialized to null — treating as CORRUPT (protection retained).");
                    return new UserConfigReadResult<T>(UserConfigReadStatus.Corrupt, default, "deserialized-null");
                }

                return new UserConfigReadResult<T>(UserConfigReadStatus.Valid, parsed, null);
            }
            catch (Exception ex)
            {
                _logger.LogError($"Policy file '{fileName}' for user '{userId}' is malformed — treating as CORRUPT (protection retained): {ex.Message}");
                return new UserConfigReadResult<T>(UserConfigReadStatus.Corrupt, default, ex.Message);
            }
        }

        /// <summary>
        /// Reads or initializes a user file as one logical transaction. The
        /// classified read, candidate construction, validation, and atomic save
        /// all run while holding the same per-user/per-file lock used by writers.
        /// A null factory result preserves the historical missing-value response
        /// without materializing a file.
        /// </summary>
        public UserConfigReadResult<T> GetOrCreateUserConfiguration<T>(
            string userId,
            string fileName,
            Func<T?> create,
            Func<T, bool> isValid)
            where T : class, new()
            => WithUserFileLock("get-or-create", userId, fileName, () =>
            {
                var read = ReadUserConfiguration<T>(userId, fileName);
                if (read.Status != UserConfigReadStatus.Missing)
                {
                    return read;
                }

                var candidate = create();
                if (candidate == null)
                {
                    return read;
                }

                if (!isValid(candidate))
                {
                    throw new InvalidDataException($"Refusing to initialize invalid user configuration '{fileName}'.");
                }

                SaveUserConfiguration(userId, fileName, candidate);
                return new UserConfigReadResult<T>(
                    UserConfigReadStatus.Valid,
                    candidate,
                    faultDetail: null,
                    wasCreated: true);
            });

        /// <summary>
        /// Runs a strict read and caller-owned logical mutation under the central
        /// per-user/per-file lock. Any save performed by the callback is reentrant
        /// on this exact lock, so the complete read/check/write transaction remains
        /// serialized with initialization and other writers.
        /// </summary>
        public TResult TransactUserConfiguration<T, TResult>(
            string userId,
            string fileName,
            Func<T, TResult> transaction)
            where T : class, new()
            => WithUserFileLock("transaction", userId, fileName, () =>
            {
                var current = GetUserConfigurationStrict<T>(userId, fileName);
                return transaction(current);
            });

        // Locked read-modify-write: holds GetUserFileLock, strict-reads, mutates, and saves when the mutator returns > 0.
        public int RmwUserConfiguration<T>(string userId, string fileName, Func<T, int> mutate) where T : class, new()
        {
            lock (GetUserFileLock(userId, fileName))
            {
                var config = GetUserConfigurationStrict<T>(userId, fileName);
                var changed = mutate(config);
                if (changed > 0)
                {
                    SaveUserConfiguration(userId, fileName, config);
                }
                return changed;
            }
        }

        // Atomic save via AtomicFile (temp file + File.Move(overwrite)). RMW callers must hold GetUserFileLock.
        public void SaveUserConfiguration(string userId, string fileName, object config)
        {
            try
            {
                // Serialize with the runtime type: callers pass both typed DTOs and
                // raw JsonElement payloads (client JSON pass-through). JsonElement is
                // written verbatim — unlike the old JToken.Parse round-trip, which
                // re-parsed and normalized ISO date strings and exponent numbers.
                // Both forms read identically; pinned by RawClientJson_* tests.
                var jsonToSave = JsonSerializer.Serialize(config, config.GetType(), PersistedJson.WriteOptions);
                var serializedBytes = Encoding.UTF8.GetByteCount(jsonToSave);
                if (serializedBytes > PersistedPayloadPolicy.AbsolutePersistedBytes)
                {
                    throw new InvalidDataException(
                        $"User configuration exceeds the absolute {PersistedPayloadPolicy.AbsolutePersistedBytes}-byte store limit.");
                }

                // Resolve only after validation so a rejected future caller cannot
                // create a user directory as a side effect of an oversized write.
                var configPath = ResolveUserFile(userId, fileName);
                lock (GetUserFileLock(userId, fileName))
                {
                    if (UnhealthyMarkerExists(configPath))
                    {
                        throw new UserStoreUnhealthyException(fileName, newlyQuarantined: false);
                    }

                    // AtomicFile owns the per-call temp sibling + rename + temp cleanup.
                    AtomicFile.WriteAllText(configPath, jsonToSave);
                }
            }
            catch (UserStoreUnhealthyException)
            {
                // The transition was logged once when the marker was published.
                // Ordinary save retries must not amplify that event.
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogError(
                    $"Failed to save user configuration for user '{userId}' to file '{fileName}' " +
                    $"(exception={ex.GetType().Name}).");
                throw;
            }
        }

        private UserStoreUnhealthyException QuarantineCorruptFile(
            string userId,
            string fileName,
            string filePath,
            byte[] sourceBytes,
            Exception cause)
            => QuarantineCorruptFile(
                userId,
                fileName,
                filePath,
                Convert.ToHexString(SHA256.HashData(sourceBytes)).ToLowerInvariant(),
                sourceBytes.LongLength,
                cause);

        private UserStoreUnhealthyException QuarantineCorruptFile(
            string userId,
            string fileName,
            string filePath,
            string hash,
            long sourceLength,
            Exception cause)
        {
            var markerPath = GetUnhealthyMarkerPath(filePath);
            if (UnhealthyMarkerExists(filePath))
            {
                return new UserStoreUnhealthyException(fileName, newlyQuarantined: false, cause);
            }

            var stamp = DateTime.UtcNow.ToString("yyyyMMddHHmmssfff");
            var quarantineFileName = $"{fileName}.corrupt-{stamp}-{hash.Substring(0, 16)}-{Guid.NewGuid():N}";
            var marker = new UserStoreUnhealthyMarker
            {
                FileName = fileName,
                QuarantineFileName = quarantineFileName,
                ContentSha256 = hash,
                SourceBytes = sourceLength,
                DetectedAtUtc = DateTime.UtcNow.ToString("O")
            };

            // Publish the fail-closed marker first. A crash before the following
            // rename leaves the source plus marker (still unhealthy and recoverable),
            // never an absent source that can be mistaken for first-run defaults.
            AtomicFile.WriteAllText(markerPath, JsonSerializer.Serialize(marker, PersistedJson.WriteOptions));

            var quarantinePath = Path.Combine(Path.GetDirectoryName(filePath)!, quarantineFileName);
            var moved = false;
            try
            {
                File.Move(filePath, quarantinePath);
                moved = true;
                PruneCorruptBackups(filePath);
            }
            catch (Exception ex)
            {
                // The marker remains authoritative. Do not remove it merely because
                // the best-effort rename/prune failed; the admin recovery surface can
                // safely finish or reset this generation later.
                _logger.LogError(
                    $"Per-user store '{fileName}' entered recovery state but its quarantine move did not complete " +
                    $"(exception={ex.GetType().Name}).");
            }

            _logger.LogWarning(
                $"Per-user store '{fileName}' entered recovery state for user '{NormalizeUserId(userId)}' " +
                $"(bytes={sourceLength}, sha256Prefix={hash.Substring(0, 16)}, quarantineComplete={moved}).");
            return new UserStoreUnhealthyException(fileName, newlyQuarantined: true, cause);
        }

        public IReadOnlyList<UserStoreRecoveryStatus> GetUnhealthyUserStores()
        {
            var results = new List<UserStoreRecoveryStatus>();
            if (!Directory.Exists(_configBaseDir)) return results;

            foreach (var userDir in Directory.GetDirectories(_configBaseDir))
            {
                var userId = Path.GetFileName(userDir);
                if (!Guid.TryParseExact(userId, "N", out _)) continue;

                foreach (var markerPath in Directory.GetFiles(userDir, "*" + UnhealthySuffix))
                {
                    var markerFileName = Path.GetFileName(markerPath);
                    var fileName = markerFileName.Substring(0, markerFileName.Length - UnhealthySuffix.Length);
                    if (!IsRecoverableFileName(fileName)) continue;

                    var status = new UserStoreRecoveryStatus
                    {
                        UserId = userId,
                        FileName = fileName
                    };
                    try
                    {
                        var marker = ReadValidMarker(markerPath, fileName);
                        status.MarkerReadable = true;
                        status.DetectedAtUtc = marker.DetectedAtUtc;
                        status.SourceBytes = marker.SourceBytes;
                        status.ContentSha256 = marker.ContentSha256;
                        status.QuarantineFileName = marker.QuarantineFileName;
                        status.QuarantineComplete = File.Exists(Path.Combine(userDir, marker.QuarantineFileName));
                    }
                    catch
                    {
                        // A malformed marker is itself a fail-closed recovery state.
                        // Surface it to the admin without trusting any of its fields.
                        status.MarkerReadable = false;
                        status.QuarantineComplete = false;
                    }

                    results.Add(status);
                }
            }

            return results
                .OrderBy(status => status.UserId, StringComparer.Ordinal)
                .ThenBy(status => status.FileName, StringComparer.Ordinal)
                .ToArray();
        }

        public bool ResetUnhealthyUserStore(string userId, string fileName)
        {
            if (!IsRecoverableFileName(fileName))
            {
                throw new ArgumentException($"Unsupported recoverable user-config filename: '{fileName}'", nameof(fileName));
            }

            lock (GetUserFileLock(userId, fileName))
            {
                var filePath = ResolveUserFile(userId, fileName);
                var markerPath = GetUnhealthyMarkerPath(filePath);
                if (!UnhealthyMarkerExists(filePath)) return false;

                UserStoreUnhealthyMarker? validMarker = null;
                try
                {
                    validMarker = ReadValidMarker(markerPath, fileName);
                }
                catch when (File.Exists(filePath))
                {
                    // A source left in place is still preservable under a fresh,
                    // validated name even when the marker itself was damaged.
                }

                // Preserve any source left by a crash/failed rename before clearing
                // the marker. The marker is deleted last, so every interruption is
                // retry-safe and can never publish an unacknowledged default state.
                if (File.Exists(filePath))
                {
                    var sourceLength = new FileInfo(filePath).Length;
                    string sourceHash;
                    using (var source = File.OpenRead(filePath))
                    {
                        sourceHash = Convert.ToHexString(SHA256.HashData(source)).ToLowerInvariant();
                    }
                    string? preferredName = null;
                    if (validMarker != null
                        && string.Equals(validMarker.ContentSha256, sourceHash, StringComparison.Ordinal))
                    {
                        preferredName = validMarker.QuarantineFileName;
                    }

                    PreserveSourceForReset(filePath, fileName, sourceLength, sourceHash, preferredName);
                }
                else if (validMarker == null
                    || !File.Exists(Path.Combine(Path.GetDirectoryName(filePath)!, validMarker.QuarantineFileName)))
                {
                    throw new InvalidDataException(
                        "The unhealthy marker has no readable source or completed quarantine artifact; refusing to discard the recovery record.");
                }

                File.Delete(markerPath);
                PruneCorruptBackups(filePath);
                _logger.LogInformation(
                    $"Explicitly reset unhealthy per-user store '{fileName}' for user '{NormalizeUserId(userId)}'; " +
                    "the next normal access will initialize defaults.");
                return true;
            }
        }

        private void PreserveSourceForReset(
            string filePath,
            string fileName,
            long sourceLength,
            string sourceHash,
            string? preferredName)
        {
            var directory = Path.GetDirectoryName(filePath)!;
            foreach (var existing in Directory.GetFiles(directory, fileName + ".corrupt-*"))
            {
                try
                {
                    var info = new FileInfo(existing);
                    if (info.Length == sourceLength)
                    {
                        using var candidate = File.OpenRead(existing);
                        if (Convert.ToHexString(SHA256.HashData(candidate)).Equals(sourceHash, StringComparison.OrdinalIgnoreCase))
                        {
                            File.Delete(filePath);
                            return;
                        }
                    }
                }
                catch
                {
                    // An unreadable older artifact cannot authorize deleting the
                    // current source. Preserve the current bytes under a new name.
                }
            }

            var targetName = preferredName;
            if (string.IsNullOrEmpty(targetName)
                || !IsValidQuarantineFileName(fileName, targetName)
                || File.Exists(Path.Combine(directory, targetName)))
            {
                targetName = $"{fileName}.corrupt-{DateTime.UtcNow:yyyyMMddHHmmssfff}-{sourceHash.Substring(0, 16)}-{Guid.NewGuid():N}";
            }

            File.Move(filePath, Path.Combine(directory, targetName));
        }

        private void PruneCorruptBackups(string filePath)
        {
            try
            {
                var retainedBytes = 0L;
                var index = 0;
                foreach (var path in Directory.GetFiles(
                    Path.GetDirectoryName(filePath)!,
                    Path.GetFileName(filePath) + ".corrupt-*")
                    .OrderByDescending(candidate => candidate, StringComparer.Ordinal))
                {
                    var length = new FileInfo(path).Length;
                    // Always retain the newest generation even when an externally
                    // created corrupt source already exceeds the byte budget. Moving
                    // it adds no disk usage; every older generation is then removed.
                    var keep = index == 0
                        || (index < MaxCorruptBackupsPerFile
                            && retainedBytes <= MaxCorruptBackupBytesPerFile - length);
                    if (keep)
                    {
                        retainedBytes += length;
                        index++;
                        continue;
                    }

                    File.Delete(path);
                    _logger.LogWarning(
                        $"Removed stale corrupt config backup for '{Path.GetFileName(filePath)}' " +
                        $"(retaining at most {MaxCorruptBackupsPerFile} generations / {MaxCorruptBackupBytesPerFile} bytes).");
                }
            }
            catch (Exception ex)
            {
                // Retention maintenance is secondary to preserving the new evidence
                // and publishing the unhealthy marker.
                _logger.LogWarning(
                    $"Could not fully enforce corrupt-backup retention for '{Path.GetFileName(filePath)}' " +
                    $"(exception={ex.GetType().Name}).");
            }
        }

        private static UserStoreUnhealthyMarker ReadValidMarker(string markerPath, string expectedFileName)
        {
            var marker = JsonSerializer.Deserialize<UserStoreUnhealthyMarker>(
                File.ReadAllText(markerPath),
                PersistedJson.ReadOptions)
                ?? throw new InvalidDataException("Unhealthy marker deserialized to null.");

            if (marker.Version != UserStoreUnhealthyMarker.CurrentVersion
                || !string.Equals(marker.FileName, expectedFileName, StringComparison.Ordinal)
                || marker.SourceBytes < 0
                || marker.ContentSha256.Length != 64
                || !marker.ContentSha256.All(Uri.IsHexDigit)
                || !IsValidQuarantineFileName(expectedFileName, marker.QuarantineFileName))
            {
                throw new InvalidDataException("Unhealthy marker failed validation.");
            }

            return marker;
        }

        private static bool IsValidQuarantineFileName(string fileName, string quarantineFileName)
            => string.Equals(Path.GetFileName(quarantineFileName), quarantineFileName, StringComparison.Ordinal)
                && quarantineFileName.StartsWith(fileName + ".corrupt-", StringComparison.Ordinal);

        private static string GetUnhealthyMarkerPath(string filePath) => filePath + UnhealthySuffix;

        private static bool UnhealthyMarkerExists(string filePath)
        {
            var markerPath = GetUnhealthyMarkerPath(filePath);
            try
            {
                _ = File.GetAttributes(markerPath);
                return true;
            }
            catch (FileNotFoundException)
            {
                return false;
            }
            catch (DirectoryNotFoundException)
            {
                return false;
            }
        }

        private static bool IsRecoverableFileName(string fileName)
            => RecoverableFileNames.Contains(fileName);

        private static string NormalizeUserId(string userId)
            => (userId ?? string.Empty).Replace("-", string.Empty, StringComparison.Ordinal).ToLowerInvariant();

        /// <summary>
        /// Gets all canonical user IDs that have configuration directories.
        /// Filters out non-user folders (e.g., <c>.migrated-{ts}</c> forensic
        /// backups, <c>.case-rename-{ts}</c> in-flight rename artifacts)
        /// so admin operations like "Reset to defaults" only iterate real
        /// users.
        /// </summary>
        public string[] GetAllUserIds()
        {
            try
            {
                if (!Directory.Exists(_configBaseDir))
                {
                    return Array.Empty<string>();
                }

                var userDirs = Directory.GetDirectories(_configBaseDir);
                var userIds = new System.Collections.Generic.List<string>(userDirs.Length);

                foreach (var dir in userDirs)
                {
                    var name = Path.GetFileName(dir);
                    if (string.IsNullOrEmpty(name)) continue;
                    // Only canonical 32-hex lowercase directories are real users.
                    // Anything else (.migrated-*, .case-rename-*, future top-level
                    // dirs) is filtered out so callers like the Reset-to-defaults
                    // admin endpoint don't iterate it and re-create stale layout.
                    if (!UserDirMigration.CanonicalGuidRe.IsMatch(name)) continue;
                    userIds.Add(name);
                }

                return userIds.ToArray();
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to get all user IDs: {ex.Message}");
                return Array.Empty<string>();
            }
        }
    }
}
