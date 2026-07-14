using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text.Json;
using System.Xml.Linq;

namespace Jellyfin.Plugin.JellyfinCanopy.Configuration
{
    internal enum EnhancedStateMigrationStatus
    {
        NoSource,
        Imported,
        AlreadyImported,
        Conflict,
        Failed,
    }

    /// <summary>
    /// Imports state left by the separately identified Jellyfin Enhanced plugin.
    /// Enhanced remains the rollback owner: its XML and data directory are never
    /// moved, renamed, deleted, or modified. Canopy publishes only a validated,
    /// staged copy and refuses to mix it with independently-created Canopy state.
    /// </summary>
    internal static class EnhancedStateMigration
    {
        internal const string EnhancedAssemblyName = "Jellyfin.Plugin.JellyfinEnhanced";
        internal const string ImportMarkerFileName = ".enhanced-import.json";
        internal const string CompletionMarkerSuffix = ".enhanced-import.json";
        private const long MaxAdministrationXmlBytes = 16L * 1024 * 1024;
        private const long MaxCriticalJsonBytes = 64L * 1024 * 1024;

        private static readonly HashSet<string> CriticalUserFiles = new(StringComparer.OrdinalIgnoreCase)
        {
            "settings.json",
            "shortcuts.json",
            "bookmark.json",
            "elsewhere.json",
            "hidden-content.json",
            "processed-watchlist-items.json",
        };

        internal static EnhancedStateMigrationStatus Run(
            string configDirectory,
            string canopyConfigFilePath,
            string canopyDataDirectoryName,
            Action<string> logInfo,
            Action<string> logError)
        {
            var sourceConfig = Path.Combine(configDirectory, EnhancedAssemblyName + ".xml");
            var sourceData = Path.Combine(configDirectory, EnhancedAssemblyName);
            var targetData = Path.Combine(configDirectory, canopyDataDirectoryName);
            var stagingData = targetData + ".enhanced-importing";
            var markerPath = Path.Combine(targetData, ImportMarkerFileName);
            var completionMarkerPath = canopyConfigFilePath + CompletionMarkerSuffix;

            // Once the complete available source was published, Canopy owns its
            // copy. The preserved Enhanced rollback source is intentionally stale
            // from this point onward and must never be compared or replayed over
            // later Canopy administration changes.
            if (TryReadImportMarker(
                    completionMarkerPath,
                    out var completedConfig,
                    out var completedData,
                    out var completedResolution)
                && (string.Equals(completedResolution, "CanopyWins", StringComparison.Ordinal)
                    || ((!completedConfig || File.Exists(canopyConfigFilePath))
                        && (!completedData
                            || TryReadImportMarker(markerPath, out _, out var dataTreeImported, out var dataResolution)
                                && dataTreeImported
                                && string.Equals(dataResolution, "Imported", StringComparison.Ordinal)))))
            {
                logInfo(string.Equals(completedResolution, "CanopyWins", StringComparison.Ordinal)
                    ? "A prior Jellyfin Enhanced conflict was resolved by preserving the existing Canopy state; the Enhanced rollback source remains unchanged."
                    : "Jellyfin Enhanced state was already imported; leaving both the current Canopy state and Enhanced rollback source unchanged.");
                return EnhancedStateMigrationStatus.AlreadyImported;
            }

            var hasSourceConfig = File.Exists(sourceConfig);
            var hasSourceData = Directory.Exists(sourceData);
            if (!hasSourceConfig && !hasSourceData)
            {
                return EnhancedStateMigrationStatus.NoSource;
            }

            try
            {
                if (hasSourceConfig)
                {
                    ThrowIfReparsePoint(sourceConfig, isDirectory: false);
                }

                if (File.Exists(canopyConfigFilePath))
                {
                    ThrowIfReparsePoint(canopyConfigFilePath, isDirectory: false);
                }

                // Preflight every conflict before writing either destination. A
                // partial import from an earlier attempt is recognized by exact
                // config bytes and the marker published with the staged data tree.
                if (hasSourceConfig && File.Exists(canopyConfigFilePath)
                    && !FilesHaveSameContent(sourceConfig, canopyConfigFilePath))
                {
                    logError($"Jellyfin Enhanced migration conflict: both {Path.GetFileName(sourceConfig)} and {Path.GetFileName(canopyConfigFilePath)} contain independent configuration. Nothing was imported; both remain untouched.");
                    RecordCanopyWins(completionMarkerPath, logInfo, logError);
                    return EnhancedStateMigrationStatus.Conflict;
                }

                var targetDataExists = Directory.Exists(targetData);
                if (targetDataExists)
                {
                    ThrowIfReparsePoint(targetData, isDirectory: true);
                }

                var targetDataIsEmpty = targetDataExists && !Directory.EnumerateFileSystemEntries(targetData).Any();
                var targetDataWasImported = TryReadImportMarker(markerPath, out _, out var dataImported, out var targetResolution)
                    && dataImported
                    && string.Equals(targetResolution, "Imported", StringComparison.Ordinal);
                if (hasSourceData && targetDataExists && !targetDataIsEmpty && !targetDataWasImported)
                {
                    logError($"Jellyfin Enhanced migration conflict: both {sourceData} and {targetData} contain data. Nothing was imported or merged; both remain untouched.");
                    RecordCanopyWins(completionMarkerPath, logInfo, logError);
                    return EnhancedStateMigrationStatus.Conflict;
                }

                if (hasSourceConfig)
                {
                    ValidateEnhancedConfiguration(sourceConfig);
                }

                var needsDataImport = hasSourceData && !targetDataWasImported;
                if (needsDataImport)
                {
                    ValidateCriticalJson(sourceData);
                    DeleteStagingDirectory(stagingData);
                    CopyDirectoryTree(sourceData, stagingData);
                    WriteImportMarker(
                        Path.Combine(stagingData, ImportMarkerFileName),
                        configurationImported: hasSourceConfig,
                        dataImported: true,
                        resolution: "Imported");
                }

                if (hasSourceConfig && !File.Exists(canopyConfigFilePath))
                {
                    AtomicFile.WriteAllBytes(canopyConfigFilePath, File.ReadAllBytes(sourceConfig));
                    logInfo($"Imported Jellyfin Enhanced administration configuration into {Path.GetFileName(canopyConfigFilePath)}; the Enhanced source was preserved for rollback.");
                }

                if (needsDataImport)
                {
                    if (targetDataIsEmpty)
                    {
                        Directory.Delete(targetData);
                    }

                    Directory.Move(stagingData, targetData);
                    logInfo($"Imported Jellyfin Enhanced per-user settings, bookmarks, hidden content, reviews, branding, and supporting data into {Path.GetFileName(targetData)}; the Enhanced source was preserved for rollback.");
                }

                // Publish last. Its presence proves every available source half
                // reached an authoritative destination. A crash before this write
                // is recovered through exact config comparison + the data marker.
                WriteImportMarker(
                    completionMarkerPath,
                    configurationImported: hasSourceConfig,
                    dataImported: hasSourceData,
                    resolution: "Imported");
                return EnhancedStateMigrationStatus.Imported;
            }
            catch (Exception ex)
            {
                try
                {
                    DeleteStagingDirectory(stagingData);
                }
                catch (Exception cleanupEx)
                {
                    logError($"Failed to clean the incomplete Jellyfin Enhanced migration staging directory {stagingData}: {cleanupEx.Message}");
                }

                logError($"Jellyfin Enhanced state migration failed before a complete import was published; the Enhanced source is unchanged and migration will retry on restart: {ex.Message}");
                return EnhancedStateMigrationStatus.Failed;
            }
        }

        private static void ValidateEnhancedConfiguration(string path)
        {
            if (new FileInfo(path).Length > MaxAdministrationXmlBytes)
            {
                throw new InvalidDataException($"{Path.GetFileName(path)} exceeds the {MaxAdministrationXmlBytes / (1024 * 1024)} MiB migration limit.");
            }

            using var stream = File.OpenRead(path);
            var document = XDocument.Load(stream, LoadOptions.PreserveWhitespace);
            if (document.Root == null
                || !string.Equals(document.Root.Name.LocalName, "PluginConfiguration", StringComparison.Ordinal))
            {
                throw new InvalidDataException($"{Path.GetFileName(path)} is not a Jellyfin plugin configuration document.");
            }
        }

        private static void ValidateCriticalJson(string sourceData)
        {
            foreach (var path in EnumerateRegularFiles(sourceData))
            {
                if (!string.Equals(Path.GetExtension(path), ".json", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                var relative = Path.GetRelativePath(sourceData, path);
                var isSharedReviews = string.Equals(relative, "reviews.json", StringComparison.OrdinalIgnoreCase);
                var segments = relative.Split(
                    new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar },
                    StringSplitOptions.RemoveEmptyEntries);
                var isUserFile = segments.Length == 2
                    && UserDirMigration.GuidShapeRe.IsMatch(segments[0])
                    && CriticalUserFiles.Contains(segments[1]);
                if (!isSharedReviews && !isUserFile)
                {
                    continue;
                }

                if (new FileInfo(path).Length > MaxCriticalJsonBytes)
                {
                    throw new InvalidDataException($"Enhanced migration source {relative} exceeds the {MaxCriticalJsonBytes / (1024 * 1024)} MiB validation limit.");
                }

                using var stream = File.OpenRead(path);
                using var document = JsonDocument.Parse(stream, PersistedJson.ParseOptions);
                if (document.RootElement.ValueKind != JsonValueKind.Object)
                {
                    throw new InvalidDataException($"Enhanced migration source {relative} must contain a JSON object.");
                }
            }
        }

        private static void CopyDirectoryTree(string sourceRoot, string destinationRoot)
        {
            Directory.CreateDirectory(destinationRoot);
            var pending = new Stack<(string Source, string Destination)>();
            pending.Push((sourceRoot, destinationRoot));
            while (pending.Count > 0)
            {
                var current = pending.Pop();
                ThrowIfReparsePoint(current.Source, isDirectory: true);

                foreach (var file in Directory.EnumerateFiles(current.Source))
                {
                    ThrowIfReparsePoint(file, isDirectory: false);
                    var info = new FileInfo(file);
                    var destination = Path.Combine(current.Destination, Path.GetFileName(file));
                    File.Copy(file, destination, overwrite: false);
                    File.SetLastWriteTimeUtc(destination, info.LastWriteTimeUtc);
                }

                foreach (var directory in Directory.EnumerateDirectories(current.Source))
                {
                    ThrowIfReparsePoint(directory, isDirectory: true);
                    var destination = Path.Combine(current.Destination, Path.GetFileName(directory));
                    Directory.CreateDirectory(destination);
                    pending.Push((directory, destination));
                }
            }
        }

        private static IEnumerable<string> EnumerateRegularFiles(string sourceRoot)
        {
            var pending = new Stack<string>();
            pending.Push(sourceRoot);
            while (pending.Count > 0)
            {
                var current = pending.Pop();
                ThrowIfReparsePoint(current, isDirectory: true);
                foreach (var file in Directory.EnumerateFiles(current))
                {
                    ThrowIfReparsePoint(file, isDirectory: false);
                    yield return file;
                }

                foreach (var directory in Directory.EnumerateDirectories(current))
                {
                    ThrowIfReparsePoint(directory, isDirectory: true);
                    pending.Push(directory);
                }
            }
        }

        private static void ThrowIfReparsePoint(string path, bool isDirectory)
        {
            var attributes = File.GetAttributes(path);
            if ((attributes & FileAttributes.ReparsePoint) != 0)
            {
                throw new InvalidDataException(
                    $"Refusing to import linked Enhanced data {(isDirectory ? "directory" : "file")} {path}.");
            }
        }

        private static void DeleteStagingDirectory(string path)
        {
            if (Directory.Exists(path))
            {
                ThrowIfReparsePoint(path, isDirectory: true);
                Directory.Delete(path, recursive: true);
            }
        }

        private static bool TryReadImportMarker(
            string path,
            out bool configurationImported,
            out bool dataImported,
            out string resolution)
        {
            configurationImported = false;
            dataImported = false;
            resolution = string.Empty;
            if (!File.Exists(path))
            {
                return false;
            }

            try
            {
                ThrowIfReparsePoint(path, isDirectory: false);
                using var stream = File.OpenRead(path);
                using var document = JsonDocument.Parse(stream, PersistedJson.ParseOptions);
                var root = document.RootElement;
                if (!(root.ValueKind == JsonValueKind.Object
                    && root.TryGetProperty("Source", out var source)
                    && string.Equals(source.GetString(), EnhancedAssemblyName, StringComparison.Ordinal)
                    && root.TryGetProperty("ContractVersion", out var version)
                    && version.ValueKind == JsonValueKind.Number
                    && version.TryGetInt32(out var contractVersion)
                    && contractVersion == 1
                    && root.TryGetProperty("ConfigurationImported", out var configFlag)
                    && (configFlag.ValueKind == JsonValueKind.True || configFlag.ValueKind == JsonValueKind.False)
                    && root.TryGetProperty("DataImported", out var dataFlag)
                    && (dataFlag.ValueKind == JsonValueKind.True || dataFlag.ValueKind == JsonValueKind.False)
                    && root.TryGetProperty("Resolution", out var resolutionValue)
                    && resolutionValue.ValueKind == JsonValueKind.String
                    && (string.Equals(resolutionValue.GetString(), "Imported", StringComparison.Ordinal)
                        || string.Equals(resolutionValue.GetString(), "CanopyWins", StringComparison.Ordinal))))
                {
                    return false;
                }

                configurationImported = configFlag.GetBoolean();
                dataImported = dataFlag.GetBoolean();
                resolution = resolutionValue.GetString()!;
                return true;
            }
            catch
            {
                // An invalid marker is not proof that Canopy owns an imported tree.
                // The normal non-empty-directory conflict path preserves everything.
                return false;
            }
        }

        private static void WriteImportMarker(
            string path,
            bool configurationImported,
            bool dataImported,
            string resolution)
        {
            AtomicFile.WriteAllText(
                path,
                JsonSerializer.Serialize(
                    new
                    {
                        Source = EnhancedAssemblyName,
                        ImportedAtUtc = DateTime.UtcNow,
                        ContractVersion = 1,
                        ConfigurationImported = configurationImported,
                        DataImported = dataImported,
                        Resolution = resolution,
                    },
                    PersistedJson.WriteOptions));
        }

        private static void RecordCanopyWins(
            string completionMarkerPath,
            Action<string> logInfo,
            Action<string> logError)
        {
            try
            {
                WriteImportMarker(
                    completionMarkerPath,
                    configurationImported: false,
                    dataImported: false,
                    resolution: "CanopyWins");
                logInfo($"Recorded the conflict resolution at {Path.GetFileName(completionMarkerPath)} so later startups keep the existing Canopy state without repeating the import attempt.");
            }
            catch (Exception ex)
            {
                // The existing Canopy state is authoritative and remains usable;
                // inability to persist the acknowledgement must not block startup.
                logError($"Could not record the Jellyfin Enhanced conflict resolution; the safe Canopy-wins decision will be re-evaluated next startup: {ex.Message}");
            }
        }

        private static bool FilesHaveSameContent(string leftPath, string rightPath)
        {
            var left = new FileInfo(leftPath);
            var right = new FileInfo(rightPath);
            if (left.Length != right.Length)
            {
                return false;
            }

            using var leftStream = File.OpenRead(leftPath);
            using var rightStream = File.OpenRead(rightPath);
            return SHA256.HashData(leftStream).AsSpan().SequenceEqual(SHA256.HashData(rightStream));
        }
    }
}
