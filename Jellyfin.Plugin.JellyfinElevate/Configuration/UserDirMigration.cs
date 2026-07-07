using System;
using System.IO;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinElevate.Configuration
{
    /// <summary>
    /// One-shot case-variant user-directory migration, split out of
    /// UserConfigurationManager (which remains as a thin facade and runs this
    /// once from its constructor).
    ///
    /// Until this fix, GetUserConfigDir / GetUserFileLock only stripped hyphens
    /// from the user ID without lowering case. Three call patterns existed:
    ///   • Guid.ToString("N")   → 32 hex, lowercase  ← canonical
    ///   • Guid.ToString()      → 36 hex, hyphenated lowercase
    ///   • {userId} from URL    → whatever case the client sent, sometimes UPPER
    /// Each landed in a separate physical folder for one user GUID. Settings
    /// written under one casing were invisible when read under another.
    /// </summary>
    internal class UserDirMigration
    {
        internal static readonly Regex CanonicalGuidRe = new Regex("^[0-9a-f]{32}$", RegexOptions.Compiled);
        internal static readonly Regex GuidShapeRe    = new Regex("^[0-9a-fA-F-]{32,36}$", RegexOptions.Compiled);

        private readonly string _configBaseDir;
        private readonly ILogger _logger;

        public UserDirMigration(string configBaseDir, ILogger logger)
        {
            _configBaseDir = configBaseDir;
            _logger = logger;
        }

        /// <summary>
        /// Per-instance unique suffix so multiple migration steps in the same
        /// millisecond produce distinct backup / .migrated- names. Combined
        /// with a millisecond timestamp this is collision-free in practice.
        /// </summary>
        private static string MigrationSuffix() =>
            DateTime.UtcNow.ToString("yyyyMMddHHmmssfff") + "-" + Guid.NewGuid().ToString("N").Substring(0, 8);

        /// <summary>
        /// Scans <c>_configBaseDir</c> for case-variant or hyphenated user
        /// folders and merges each into its canonical lowercase 32-hex
        /// sibling. Idempotent; conflict files are kept (newer wins, older
        /// backed up to <c>{file}.pre-case-merge-{ts}</c>) and the source
        /// folder is renamed to <c>{name}.migrated-{ts}</c> for forensic
        /// recovery rather than deleted outright.
        /// </summary>
        public void MigrateCaseVariantUserDirs()
        {
            if (!Directory.Exists(_configBaseDir)) return;

            var allDirs = Directory.GetDirectories(_configBaseDir);
            var migrated = 0;
            var renamed  = 0;
            var failed   = 0;

            foreach (var srcDir in allDirs)
            {
                string srcName;
                try { srcName = Path.GetFileName(srcDir); }
                catch { continue; }

                if (string.IsNullOrEmpty(srcName)) continue;
                // Already canonical — skip.
                if (CanonicalGuidRe.IsMatch(srcName)) continue;
                // Shape gate FIRST so 'foo.migrated-...', 'reviews.json',
                // future top-level dirs, etc. never reach the strip+lower step.
                if (!GuidShapeRe.IsMatch(srcName)) continue;

                var stripped = srcName.Replace("-", "").ToLowerInvariant();
                if (!CanonicalGuidRe.IsMatch(stripped)) continue;

                var dstDir = Path.Combine(_configBaseDir, stripped);

                try
                {
                    if (!Directory.Exists(dstDir))
                    {
                        Directory.Move(srcDir, dstDir);
                        renamed++;
                        _logger.LogInformation($"Migrated user dir '{srcName}' -> '{stripped}'");
                        continue;
                    }

                    // Case-insensitive filesystem (Windows NTFS, default macOS APFS):
                    // src and dst can resolve to the SAME physical directory even
                    // though their string names differ. Don't try to merge — the
                    // merge logic would Directory.Move the only data dir to .migrated-
                    // and the canonical dir would vanish. Instead do a two-step
                    // case-only rename: src -> src.tmp -> dst.
                    var srcFull = Path.GetFullPath(srcDir);
                    var dstFull = Path.GetFullPath(dstDir);
                    if (string.Equals(srcFull, dstFull, StringComparison.OrdinalIgnoreCase)
                        && !string.Equals(srcFull, dstFull, StringComparison.Ordinal))
                    {
                        var tmp = srcDir + ".case-rename-" + MigrationSuffix();
                        Directory.Move(srcDir, tmp);
                        Directory.Move(tmp, dstDir);
                        renamed++;
                        _logger.LogInformation($"Case-only rename on case-insensitive FS: '{srcName}' -> '{stripped}'");
                        continue;
                    }

                    // Both exist as distinct dirs — merge per-file, newer mtime wins,
                    // older backed up. Each per-file step uses its own try/catch so
                    // one bad file doesn't abort the whole dir's merge.
                    var srcFiles = Directory.GetFiles(srcDir);
                    foreach (var srcFile in srcFiles)
                    {
                        var fileName = Path.GetFileName(srcFile);
                        var dstFile  = Path.Combine(dstDir, fileName);

                        try
                        {
                            if (!File.Exists(dstFile))
                            {
                                File.Copy(srcFile, dstFile);
                                continue;
                            }

                            var srcMtime = File.GetLastWriteTimeUtc(srcFile);
                            var dstMtime = File.GetLastWriteTimeUtc(dstFile);
                            if (srcMtime > dstMtime)
                            {
                                // ms-resolution + GUID suffix prevents collisions
                                // when two case-variants of the same canonical GUID
                                // both have a newer file in the same millisecond.
                                var backup = dstFile + ".pre-case-merge-" + MigrationSuffix();
                                File.Copy(dstFile, backup);
                                File.Copy(srcFile, dstFile, overwrite: true);
                                _logger.LogInformation($"Merged '{fileName}' from '{srcName}' (newer) into '{stripped}'");
                            }
                            else
                            {
                                // Source data is dropped from the canonical dir but
                                // preserved under '{srcName}.migrated-{ts}'. Warning
                                // severity so the admin can spot it in logs.
                                _logger.LogWarning($"Kept '{fileName}' from canonical '{stripped}' (newer than '{srcName}'); source-side copy preserved in '.migrated-' sibling");
                            }
                        }
                        catch (Exception fileEx)
                        {
                            _logger.LogError($"Failed to migrate file '{fileName}' in '{srcName}': {fileEx.Message}");
                        }
                    }

                    // Rename source rather than delete so forensic recovery is possible.
                    var migratedName = srcDir + ".migrated-" + MigrationSuffix();
                    Directory.Move(srcDir, migratedName);
                    migrated++;
                    _logger.LogInformation($"Merged user dir '{srcName}' into canonical '{stripped}', source preserved at '{Path.GetFileName(migratedName)}'");
                }
                catch (Exception ex)
                {
                    failed++;
                    _logger.LogError($"Failed to migrate user dir '{srcName}': {ex}");
                }
            }

            if (renamed + migrated + failed > 0)
            {
                if (failed > 0)
                {
                    _logger.LogWarning($"User-dir case migration done with errors: {renamed} renamed, {migrated} merged, {failed} failed (source dirs left intact).");
                }
                else
                {
                    _logger.LogInformation($"User-dir case migration done: {renamed} renamed, {migrated} merged.");
                }
            }
        }
    }
}
