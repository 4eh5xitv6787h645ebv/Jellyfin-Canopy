using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinEnhanced.Tests.Configuration
{
    /// <summary>
    /// Architecture guard for the durability class (W4-LEAK-5/6/7, MB-2, CSSVC-4).
    /// Every overwrite of a persisted config / user / shared file MUST go through
    /// Configuration/AtomicFile.cs (crash-safe temp+rename). A raw
    /// File.WriteAllText / File.WriteAllBytes / new FileStream(FileMode.Create) on a
    /// persisted file can leave it truncated/half-written on a crash, disk-full, or
    /// client disconnect — that is exactly the torn-write class this guard forbids.
    ///
    /// The regex uses a \b word boundary before File. so the sanctioned
    /// AtomicFile.WriteAllText / AtomicFile.WriteAllBytes call sites do NOT count as
    /// raw writes; only genuine File.* calls do.
    /// </summary>
    public class AtomicFileWriteGuardTests
    {
        // A raw persisted write: File.WriteAll{Text,Bytes}[Async](...) or a
        // truncating new FileStream(..., FileMode.Create, ...). The \bFile\. boundary
        // excludes AtomicFile.WriteAll* (no boundary between "Atomic" and "File").
        private static readonly Regex RawWrite = new(
            @"\bFile\.WriteAllText\s*\(|\bFile\.WriteAllTextAsync\s*\(|\bFile\.WriteAllBytes\s*\(|\bFile\.WriteAllBytesAsync\s*\(|new\s+FileStream\s*\([^)]*FileMode\.Create",
            RegexOptions.Compiled);

        // The ONLY sanctioned raw-write sites, each with its justification.
        private static readonly HashSet<string> Allowed = new(StringComparer.Ordinal)
        {
            "AtomicFile.cs",                         // the sanctioned temp+rename helper itself
            "JellyfinEnhancedFileLoggerProvider.cs", // append-only log writer (AppendAllText), torn append loses only the tail
        };

        [Fact]
        public void NoPersistedFileWriteBypassesAtomicFile()
        {
            var offenders = SourceFiles()
                .Where(f => RawWrite.IsMatch(File.ReadAllText(f)))
                .Select(f => Path.GetFileName(f)!)
                .Where(name => !Allowed.Contains(name))
                .OrderBy(name => name, StringComparer.Ordinal)
                .ToList();

            Assert.True(
                offenders.Count == 0,
                "File(s) write a persisted file without AtomicFile: " + string.Join(", ", offenders) + ".\n"
                + "Route the write through Configuration/AtomicFile.cs (crash-safe temp+rename). If this is a "
                + "genuinely append-only or non-persisted write, add the file to the Allowed set with a "
                + "justifying comment. See docs/advanced/project-structure.md and W4-LEAK-5/6/7.");
        }

        [Fact]
        public void AllowlistedFilesStillExist()
        {
            foreach (var name in Allowed)
            {
                var path = SourceFiles().FirstOrDefault(f => Path.GetFileName(f) == name);
                Assert.True(path != null,
                    $"Allowlisted raw-write file '{name}' no longer exists — remove it from Allowed so the list can't rot.");
            }
        }

        private static IEnumerable<string> SourceFiles()
            => Directory.EnumerateFiles(PluginSourceRoot(), "*.cs", SearchOption.AllDirectories)
                .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}")
                         && !f.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}"));

        private static string PluginSourceRoot([CallerFilePath] string sourceFile = "")
            => Path.GetFullPath(Path.Combine(
                Path.GetDirectoryName(sourceFile)!, "..", "..", "Jellyfin.Plugin.JellyfinEnhanced"));
    }
}
