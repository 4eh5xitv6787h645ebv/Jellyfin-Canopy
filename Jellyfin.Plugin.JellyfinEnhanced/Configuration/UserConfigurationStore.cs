using System;
using System.Collections.Concurrent;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinEnhanced.Configuration
{
    /// <summary>
    /// Per-user configuration file IO: path resolution, lenient/strict reads,
    /// atomic saves, and the locked read-modify-write helper. Split out of
    /// UserConfigurationManager (which remains as a thin facade).
    /// </summary>
    internal class UserConfigurationStore
    {
        private readonly string _configBaseDir;
        private readonly ILogger _logger;

        // Static so the Singleton ResponseFilter and the Scoped IEventConsumer share one pool.
        private static readonly ConcurrentDictionary<string, object> _userFileLocks = new ConcurrentDictionary<string, object>();

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
                return File.Exists(configPath);
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
                    var node = JsonNode.Parse(json, documentOptions: PersistedJson.ParseOptions);
                    var settings = PersistedJson.StripNullMembers(node) is JsonNode stripped
                        ? stripped.Deserialize<T>(PersistedJson.ReadOptions)
                        : default;

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

        // Strict read for RMW: existing empty/null/garbage is corruption; backs up to .corrupt-{ts} and throws.
        public T GetUserConfigurationStrict<T>(string userId, string fileName) where T : new()
        {
            var configPath = ResolveUserFile(userId, fileName);
            if (!File.Exists(configPath)) return new T();

            string json;
            try
            {
                json = File.ReadAllText(configPath);
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to read '{fileName}' for user '{userId}': {ex.Message}");
                BackupCorruptFile(configPath);
                throw;
            }

            if (string.IsNullOrWhiteSpace(json)
                || string.Equals(json.Trim(), "null", StringComparison.Ordinal))
            {
                _logger.LogError($"'{fileName}' for user '{userId}' exists but is empty or literal-null; refusing to overwrite.");
                BackupCorruptFile(configPath);
                throw new InvalidDataException($"'{fileName}' is empty or literal null; refusing to overwrite.");
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
                // throws in JsonNode.Parse, and a non-object payload deserializes to null
                // (or throws) — both caught below and backed up.
                var node = JsonNode.Parse(json, documentOptions: PersistedJson.ParseOptions);
                var parsed = PersistedJson.StripNullMembers(node) is JsonNode stripped
                    ? stripped.Deserialize<T>(PersistedJson.ReadOptions)
                    : default;
                if (parsed == null)
                {
                    _logger.LogError($"'{fileName}' for user '{userId}' deserialized to null; refusing to overwrite.");
                    BackupCorruptFile(configPath);
                    throw new InvalidDataException($"'{fileName}' deserialized to null.");
                }
                return parsed;
            }
            catch (InvalidDataException)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to parse '{fileName}' for user '{userId}': {ex.Message}");
                BackupCorruptFile(configPath);
                throw;
            }
        }

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
                var configPath = ResolveUserFile(userId, fileName);

                // Serialize with the runtime type: callers pass both typed DTOs and
                // raw JsonElement payloads (client JSON pass-through). JsonElement is
                // written verbatim — unlike the old JToken.Parse round-trip, which
                // re-parsed and normalized ISO date strings and exponent numbers.
                // Both forms read identically; pinned by RawClientJson_* tests.
                var jsonToSave = JsonSerializer.Serialize(config, config.GetType(), PersistedJson.WriteOptions);

                // AtomicFile owns the per-call temp sibling + rename + temp cleanup.
                AtomicFile.WriteAllText(configPath, jsonToSave);
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to save user configuration for user '{userId}' to file '{fileName}'. Exception: {ex.Message}");
                throw;
            }
        }

        private void BackupCorruptFile(string filePath)
        {
            try
            {
                // Millisecond resolution so two corruption events in the same UTC second get distinct backups.
                var backupPath = filePath + ".corrupt-" + DateTime.UtcNow.ToString("yyyyMMddHHmmssfff");
                if (File.Exists(backupPath))
                {
                    _logger.LogWarning($"Corrupt config backup already exists at {backupPath} — skipping new copy.");
                    return;
                }
                File.Copy(filePath, backupPath);
                _logger.LogWarning($"Corrupt config backed up to {backupPath}");
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to back up corrupt config: {ex.Message}");
            }
        }

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
