using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services
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

        // Heavy work that must never run synchronously in a scan-thread handler — a SUPERSET
        // denylist (one family per group). Each token is anchored with \s*[<(] (or \s*\() so it
        // only matches an actual CALL, never a same-prefixed name: GetItem(s) but not
        // GetItemKind / GetBaseItemKind; First( but not FirstOrDefault(; Single( but not
        // SingleOrDefault(. Extend this list when a new heavy sink appears; never narrow it.
        private static readonly Regex InlineHeavyWork = new(
            // ILibraryManager / repository reads + media probes:
            @"\bGet(ItemById|Items?|ItemList|MediaSources|MediaStreams|FirstEpisode|People|ImageInfo|Instance|Children|RecursiveChildren|Genres|Studios)\s*[<(]"
            + @"|\bQueryItems?\s*[<(]"
            // Non-DB heavy sinks: file I/O, EF writes, async materialization, LINQ realization:
            + @"|\bFile\.(Read|Write|Append|Open|Copy|Move|Delete)\w*\s*\("
            + @"|\.SaveChanges\w*\s*\("
            + @"|\.(ToListAsync|FirstAsync)\s*\("
            + @"|\.(First|Single)\s*\(",
            RegexOptions.Compiled);

        // A no-arg Initialize() method declaration (not a call) — the entry point re-invoked by a
        // second run of the startup scheduled task.
        private static readonly Regex InitializeDecl = new(
            @"(?:public|private|protected|internal)(?:\s+(?:override|virtual|sealed|new|static))*\s+void\s+Initialize\s*\(\s*\)",
            RegexOptions.Compiled);

        // A direct event subscription to one of this repo's On*-named handlers.
        private static readonly Regex SubscribeHandler = new(@"\+=\s*On", RegexOptions.Compiled);

        // Files whose scan-thread handler has been reviewed to be O(1) record-and-defer — no DB
        // query, no GetMediaSources, no I/O; heavy work is pushed to a debounced/off-thread worker.
        // Adding a new subscriber? Follow that pattern (TagCacheMonitor is the reference) and list it.
        private static readonly HashSet<string> ReviewedSubscribers = new(StringComparer.Ordinal)
        {
            "TagCacheMonitor.cs",             // record id -> TagCacheService debounced flush worker
            "SeerrScanTriggerService.cs",     // cheap config/kind check -> counter + debounce timer
            "WatchlistMonitor.cs",            // constant-time gates -> bounded coalescing channel worker
            "ContinueWatchingPlaybackEvents.cs", // record id -> debounced timer drain (GetUsers + per-user prune off-thread, coalesced)
            "SpoilerSeerrPendingPromoter.cs", // cheap gate ContainsKey -> coalesced Task.Run sweep (GetItemById + RMW off-thread)
        };

        // Off-thread worker methods on the reviewed subscribers: invoked via a debounce Timer or
        // Task.Run (NOT on the scan thread), so heavy work in THEIR bodies is legitimate and must
        // be stripped before scanning so only the SYNCHRONOUS scan-thread portion is checked. Only
        // methods whose sole caller is a timer/deferred invocation belong here (the inline
        // Task.Run(...) lambdas are stripped separately). NEVER list a scan-thread handler — that
        // would hide the exact regression this guard exists to catch. One justification per file.
        private static readonly Dictionary<string, string[]> OffThreadWorkerMethods = new(StringComparer.Ordinal)
        {
            // ScheduleWatchlistCheck (sync handler) performs a non-blocking bounded enqueue;
            // ProcessQueuedItemAsync / ProcessItemForWatchlist run on the owned channel worker.
            ["WatchlistMonitor.cs"] = new[] { "ProcessQueuedItemAsync", "ProcessItemForWatchlist" },
            // OnItemRemoved (sync handler) only records ids + arms a debounce Timer; Drain is the
            // timer callback and DrainBatch/PruneOrphans are its per-user workers (GetUsers + prune).
            ["ContinueWatchingPlaybackEvents.cs"] = new[] { "Drain", "DrainBatch", "PruneOrphans" },
            // OnItemAdded (sync handler) bumps a counter + arms a debounce Timer; OnDebounceElapsed
            // is the timer callback dispatching the scan HTTP POSTs off-thread.
            ["SeerrScanTriggerService.cs"] = new[] { "OnDebounceElapsed", "DispatchAsync", "PostScanTrigger", "TriggerNowAsync" },
            // OnItemAdded (sync handler) does a ContainsKey gate then ScheduleSweep (Task.Run only);
            // SweepPendingUsers + PromoteForUser are the coalesced background workers that run the
            // library reads (GetItemById) + per-user RMW writes off the scan thread.
            ["SpoilerSeerrPendingPromoter.cs"] = new[] { "SweepPendingUsers", "PromoteForUser" },
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
        public void ReviewedSubscribers_HaveNoInlineHeavyWorkOnTheScanThread()
        {
            // EVERY reviewed subscriber's SYNCHRONOUS scan-thread body must be O(1) record-and-defer
            // — not just TagCacheMonitor. Strip comments, then the off-thread regions (Task.Run /
            // Task.Factory.StartNew lambdas + the listed OffThreadWorkerMethods), then assert the
            // broadened denylist finds nothing in what REMAINS (the scan-thread portion).
            var offenders = new List<string>();
            foreach (var name in ReviewedSubscribers)
            {
                var path = SourceFiles().First(f => Path.GetFileName(f) == name);

                var synchronous = StripDeferredRegions(StripComments(File.ReadAllText(path)));
                if (OffThreadWorkerMethods.TryGetValue(name, out var workers))
                {
                    synchronous = StripMethodBodies(synchronous, workers);
                }

                foreach (Match hit in InlineHeavyWork.Matches(synchronous))
                {
                    offenders.Add($"{name}: {hit.Value.Trim()}");
                }
            }

            Assert.True(
                offenders.Count == 0,
                "Inline heavy work found on the library-scan thread (the SYNCHRONOUS body of a reviewed subscriber):\n  "
                + string.Join("\n  ", offenders) + "\n"
                + "Jellyfin raises ItemAdded/ItemUpdated/ItemRemoved SYNCHRONOUSLY on the scan thread, so the handler "
                + "must record ids only and push real work to a debounced/off-thread worker (TagCacheMonitor + "
                + "TagCacheService is the reference). If the flagged call already runs off-thread but is not inside a "
                + "Task.Run lambda, add its method to OffThreadWorkerMethods with a justification — never weaken the denylist.");
        }

        [Fact]
        public void AllMonitorInitializeMethodsAreIdempotent()
        {
            // (1) Any Initialize() that subscribes to events directly (+= On<handler>) must carry an
            // idempotency guard (a _subscribed flag) or delegate to an idempotent EnsureSubscribed().
            // A second run of the startup scheduled task (the dashboard "Run" button always exists)
            // otherwise double-subscribes a handler that only unsubscribes on Dispose.
            var offenders = SourceFiles()
                .Select(f => (Name: Path.GetFileName(f)!, Body: ExtractInitializeBody(File.ReadAllText(f))))
                .Where(x => x.Body != null && SubscribeHandler.IsMatch(x.Body!))
                .Where(x => !x.Body!.Contains("_subscribed") && !x.Body!.Contains("EnsureSubscribed"))
                .Select(x => x.Name)
                .ToList();

            Assert.True(
                offenders.Count == 0,
                "Monitor Initialize() subscribes to events without an idempotency guard: "
                + string.Join(", ", offenders) + ".\n"
                + "A second run of the startup scheduled task (the dashboard \"Run\" button) would double-subscribe. "
                + "Add an `if (_subscribed) return;` guard (see WatchlistMonitor / SeerrScanTriggerService) or delegate "
                + "to an idempotent EnsureSubscribed() (see TagCacheMonitor).");

            // (2) The auto-request monitors subscribe inside SubscribeEvents(), whose only caller is
            // PlaybackWatcherBase.Initialize — assert that base guard is intact so those overrides
            // are covered too.
            var basePath = SourceFiles().First(f => Path.GetFileName(f) == "PlaybackWatcherBase.cs");
            var baseInit = ExtractInitializeBody(File.ReadAllText(basePath));
            Assert.True(
                baseInit != null && baseInit.Contains("_subscribed"),
                "PlaybackWatcherBase.Initialize lost its _subscribed guard — the AutoMovie/AutoSeason request "
                + "monitors subscribe via its SubscribeEvents() and would double-subscribe.");
        }

        // Strips /* */ block comments and // line comments (incl. ///) so a denylist token inside a
        // comment can't false-positive. Over-stripping is safe: it can only HIDE work, and the
        // reviewed files are known-clean — the guard's job is catching a NEW call in the sync body.
        private static string StripComments(string source)
        {
            var withoutBlock = Regex.Replace(source, @"/\*.*?\*/", " ", RegexOptions.Singleline);
            return Regex.Replace(withoutBlock, @"//[^\n]*", string.Empty);
        }

        // Removes the argument region of every Task.Run( / Task.Factory.StartNew( call — the
        // off-thread lambda, expression- or block-bodied — via a paren-depth scan from the call's
        // opening '(' to its matching ')'. Paren (not brace) matching so expression lambdas
        // (Task.Run(() => Foo())) are stripped as cleanly as block lambdas.
        private static string StripDeferredRegions(string source)
        {
            foreach (var marker in new[] { "Task.Run(", "Task.Factory.StartNew(" })
            {
                int index;
                while ((index = source.IndexOf(marker, StringComparison.Ordinal)) >= 0)
                {
                    var close = MatchingDelimiter(source, index + marker.Length - 1, '(', ')');
                    if (close < 0) break; // unbalanced — stop rather than corrupt the source
                    source = source.Remove(index, close - index + 1);
                }
            }

            return source;
        }

        // Removes the brace body of each named method DECLARATION (name '(' … ')' '{' … '}'). Used
        // for off-thread workers invoked via a timer / deferred call rather than an inline Task.Run
        // lambda, so their heavy work is not attributed to the scan thread. Bare CALLS to the method
        // (followed by ')' or ';', not '{') are removed too so the scan can't loop on them.
        private static string StripMethodBodies(string source, IEnumerable<string> methodNames)
        {
            foreach (var method in methodNames)
            {
                var callSite = new Regex(@"\b" + Regex.Escape(method) + @"\s*\(", RegexOptions.Compiled);
                for (var match = callSite.Match(source); match.Success; match = callSite.Match(source))
                {
                    var open = source.IndexOf('(', match.Index);
                    var close = MatchingDelimiter(source, open, '(', ')');
                    if (close < 0) break;

                    var next = FirstNonWhitespace(source, close + 1);
                    if (next >= 0 && source[next] == '{')
                    {
                        var end = MatchingDelimiter(source, next, '{', '}');
                        if (end < 0) break;
                        source = source.Remove(match.Index, end - match.Index + 1); // declaration + body
                    }
                    else
                    {
                        source = source.Remove(match.Index, close - match.Index + 1); // a call — drop it
                    }
                }
            }

            return source;
        }

        // Index of the delimiter that closes the one at openIndex, honouring nesting. -1 if
        // unbalanced. Deliberately literal (does not skip string/char literals): the reviewed
        // regions use only balanced interpolation braces + parens, and over-stripping is safe.
        private static int MatchingDelimiter(string source, int openIndex, char open, char close)
        {
            var depth = 0;
            for (var i = openIndex; i < source.Length; i++)
            {
                if (source[i] == open) depth++;
                else if (source[i] == close && --depth == 0) return i;
            }

            return -1;
        }

        private static int FirstNonWhitespace(string source, int start)
        {
            for (var i = start; i < source.Length; i++)
            {
                if (!char.IsWhiteSpace(source[i])) return i;
            }

            return -1;
        }

        // Returns the braced body of the first no-arg Initialize() declaration, or null if the file
        // has none (e.g. a monitor whose Initialize is inherited).
        private static string? ExtractInitializeBody(string source)
        {
            var m = InitializeDecl.Match(source);
            if (!m.Success) return null;

            var open = source.IndexOf('{', m.Index + m.Length);
            if (open < 0) return null;

            var depth = 0;
            for (var i = open; i < source.Length; i++)
            {
                if (source[i] == '{')
                {
                    depth++;
                }
                else if (source[i] == '}')
                {
                    depth--;
                    if (depth == 0) return source.Substring(open, i - open + 1);
                }
            }

            return null;
        }

        private static IEnumerable<string> SourceFiles()
            => Directory.EnumerateFiles(PluginSourceRoot(), "*.cs", SearchOption.AllDirectories)
                .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}")
                         && !f.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}"));

        private static string PluginSourceRoot([CallerFilePath] string sourceFile = "")
            => Path.GetFullPath(Path.Combine(
                Path.GetDirectoryName(sourceFile)!, "..", "..", "Jellyfin.Plugin.JellyfinCanopy"));
    }
}
