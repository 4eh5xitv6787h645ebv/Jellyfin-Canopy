using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinEnhanced.Tests.Services
{
    /// <summary>
    /// Architecture guard for PERF(S1). Jellyfin raises ILibraryManager.ItemAdded / ItemUpdated /
    /// ItemRemoved SYNCHRONOUSLY, one item at a time, on the library-scan thread — so a subscriber
    /// that does heavy work inline slows every scan. (The tag cache once rebuilt each parent Series
    /// and Season on every episode event: ~1.5s per event on a large library, measured.)
    ///
    /// These tests fail when (a) new code subscribes to those events without being reviewed for the
    /// record-and-defer pattern, or (b) the reference handler regresses back into inline DB/probe
    /// work. See docs/advanced/performance-rules.md (S1) and TagCacheMonitor + TagCacheService for
    /// the pattern to copy: the handler only records ids; a debounced off-thread worker does the work.
    /// </summary>
    public class LibraryScanEventGuardTests
    {
        // A subscription (+=) to one of the synchronous scan-thread events.
        private static readonly Regex Subscribe = new(
            @"\.(ItemAdded|ItemUpdated|ItemRemoved)\s*\+=", RegexOptions.Compiled);

        // Synchronous DB / media-probe calls that must never run in a scan-thread handler.
        private static readonly Regex InlineHeavyWork = new(
            @"\bGet(ItemById|MediaSources|ItemList|FirstEpisode)\s*[<(]", RegexOptions.Compiled);

        // Files whose scan-thread handler has been reviewed to be O(1) record-and-defer — no DB
        // query, no GetMediaSources, no I/O; heavy work is pushed to a debounced/off-thread worker.
        // Adding a new subscriber? Follow that pattern (TagCacheMonitor is the reference) and list it.
        private static readonly HashSet<string> ReviewedSubscribers = new(StringComparer.Ordinal)
        {
            "TagCacheMonitor.cs",             // record id -> TagCacheService debounced flush worker
            "SeerrScanTriggerService.cs",     // cheap config/kind check -> counter + debounce timer
            "WatchlistMonitor.cs",            // cheap Movie/Series reject -> Task.Run (lookup + writes off-thread)
            "ContinueWatchingPlaybackEvents.cs", // capture id -> Task.Run (GetUsers + per-user prune off-thread)
        };

        [Fact]
        public void OnlyReviewedFilesSubscribeToSynchronousLibraryScanEvents()
        {
            var offenders = SourceFiles()
                .Where(f => Subscribe.IsMatch(File.ReadAllText(f)))
                .Select(f => Path.GetFileName(f)!)
                .Where(name => !ReviewedSubscribers.Contains(name))
                .ToList();

            Assert.True(
                offenders.Count == 0,
                "New subscriber(s) to ILibraryManager.ItemAdded/ItemUpdated/ItemRemoved: "
                + string.Join(", ", offenders) + ".\n"
                + "Jellyfin raises these SYNCHRONOUSLY on the library-scan thread, so the handler must do only "
                + "O(1) record-and-defer work (no DB query, no GetMediaSources, no I/O) and push real work to a "
                + "debounced off-thread worker — see docs/advanced/performance-rules.md (S1) and TagCacheMonitor + "
                + "TagCacheService for the reference. Once your handler follows it, add the file to "
                + "ReviewedSubscribers in this test.");
        }

        [Fact]
        public void ReviewedSubscribersAllStillExistAndSubscribe()
        {
            foreach (var name in ReviewedSubscribers)
            {
                var path = SourceFiles().FirstOrDefault(f => Path.GetFileName(f) == name);
                Assert.True(path != null, $"Reviewed subscriber '{name}' no longer exists — remove it from the allowlist.");
                Assert.True(
                    Subscribe.IsMatch(File.ReadAllText(path!)),
                    $"'{name}' no longer subscribes to library events — remove it from the allowlist so it can't rot.");
            }
        }

        [Fact]
        public void TagCacheMonitor_HandlerDoesNoInlineDbOrProbeWork()
        {
            // The reference record-and-defer handler must only enqueue ids. Any GetItemById /
            // GetMediaSources / GetItemList / GetFirstEpisode here reintroduces the scan-thread stall
            // the fix removed — resolve ids in the off-thread flush (TagCacheService) instead.
            var path = SourceFiles().First(f => Path.GetFileName(f) == "TagCacheMonitor.cs");
            var hits = InlineHeavyWork.Matches(File.ReadAllText(path)).Select(m => m.Value).ToList();

            Assert.True(
                hits.Count == 0,
                "TagCacheMonitor must stay pure record-and-defer, but found inline heavy call(s): "
                + string.Join(", ", hits) + ". Move id resolution/rebuild to the off-thread flush.");
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
