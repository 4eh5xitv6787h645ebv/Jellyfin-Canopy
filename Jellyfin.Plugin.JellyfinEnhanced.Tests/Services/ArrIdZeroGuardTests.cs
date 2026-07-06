using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinEnhanced.Tests.Services
{
    /// <summary>
    /// Architecture guard for the numeric-id zero-as-key bug class (MB-3, W4-ID-1, W4-ID-2).
    /// A present-but-0 tmdb/tvdb id read straight out of arr/Seerr JSON must be normalized to
    /// null (ArrIdHelper.ToNullableId) before it can key a dict / dedup bucket / provider lookup,
    /// and the request parsers must keep rejecting a 0 id. These tests fail when a new unguarded
    /// site is introduced.
    /// </summary>
    public class ArrIdZeroGuardTests
    {
        // A raw cast of a numeric tmdb/tvdb id out of a JSON node, e.g. (int?)series?["tmdbId"].
        private static readonly Regex ZeroLeakCast = new(
            @"\(int\?\)\s*[A-Za-z_]\w*\??\s*\[\s*""(tmdbId|tvdbId)""\s*\]", RegexOptions.Compiled);

        // Sites that legitimately still hold a raw cast, each with the reason it is safe / the
        // package that owns the fix. An entry is the exact trimmed source line; once the site is
        // routed through ArrIdHelper the entry stops matching a real offender and
        // KnownPendingZeroCastSitesAreAllStillOffenders forces its removal, so the list can't rot.
        private static readonly HashSet<string> KnownPendingZeroCastSites = new(StringComparer.Ordinal)
        {
            // Enrichment-only lookup in GetRequests: a 0 tmdb just yields an empty TMDB enrichment
            // and falls back to the media title — it never becomes a key. Left as-is by design.
            "int? tmdbId = (int?)media?[\"tmdbId\"];",
        };

        // Signature (not call) of a request-item parser: ParseRequestItem[...](JsonElement ...).
        private static readonly Regex ParseRequestSig = new(
            @"ParseRequestItem\w*\s*\(\s*JsonElement", RegexOptions.Compiled);

        // Files whose ParseRequestItem* methods read a numeric id and must keep a zero-guard.
        private static readonly HashSet<string> RequestParseFiles = new(StringComparer.Ordinal)
        {
            "WatchlistMonitor.cs",   // ParseRequestItemWithUser
            "JellyseerrClient.cs",   // ParseRequestItem
        };

        [Fact]
        public void EveryTmdbTvdbCastRoutesThroughArrIdHelper()
        {
            var offenders = new List<string>();
            foreach (var file in SourceFiles())
            {
                var lines = File.ReadAllLines(file);
                for (var i = 0; i < lines.Length; i++)
                {
                    var line = lines[i];
                    if (!ZeroLeakCast.IsMatch(line) || line.Contains("ArrIdHelper.ToNullableId"))
                        continue;
                    if (KnownPendingZeroCastSites.Contains(line.Trim()))
                        continue;
                    offenders.Add($"{Path.GetFileName(file)}:{i + 1}  {line.Trim()}");
                }
            }

            Assert.True(
                offenders.Count == 0,
                "Raw (int?)node[\"tmdbId\"|\"tvdbId\"] cast(s) that don't route through ArrIdHelper.ToNullableId:\n"
                + string.Join("\n", offenders) + "\n"
                + "A present-but-0 id must normalize to null before it keys a dict / dedup bucket / provider "
                + "lookup. Wrap the cast in ArrIdHelper.ToNullableId(...), or (if the 0 is provably harmless) "
                + "add the trimmed line to KnownPendingZeroCastSites with a reason.");
        }

        [Fact]
        public void KnownPendingZeroCastSitesAreAllStillOffenders()
        {
            var liveOffenders = SourceFiles()
                .SelectMany(File.ReadAllLines)
                .Where(l => ZeroLeakCast.IsMatch(l) && !l.Contains("ArrIdHelper.ToNullableId"))
                .Select(l => l.Trim())
                .ToHashSet(StringComparer.Ordinal);

            var stale = KnownPendingZeroCastSites.Where(s => !liveOffenders.Contains(s)).ToList();

            Assert.True(
                stale.Count == 0,
                "Stale KnownPendingZeroCastSites entr(y/ies) — the site was fixed or moved, so drop it "
                + "from the allowlist:\n" + string.Join("\n", stale));
        }

        [Fact]
        public void RequestParsersRejectZeroTmdbIds()
        {
            var offenders = new List<string>();
            foreach (var file in SourceFiles().Where(f => RequestParseFiles.Contains(Path.GetFileName(f)!)))
            {
                var text = File.ReadAllText(file);
                foreach (var body in ExtractParseRequestBodies(text))
                {
                    // Only bodies that actually read a numeric id via GetInt32 must carry a zero-guard.
                    if (!body.Contains(".GetInt32()"))
                        continue;
                    var guarded = body.Contains("> 0") || body.Contains(">= 1")
                        || body.Contains("!= 0") || body.Contains("== 0")
                        || body.Contains("ArrIdHelper.ToNullableId");
                    if (!guarded)
                        offenders.Add(Path.GetFileName(file)!);
                }
            }

            Assert.True(
                offenders.Count == 0,
                "Request parser(s) that read a numeric id via .GetInt32() but carry no zero-guard "
                + "(> 0 / >= 1 / != 0 / == 0 / ArrIdHelper.ToNullableId): "
                + string.Join(", ", offenders.Distinct()) + ".\n"
                + "A request with tmdbId 0 must be dropped, mirroring the sibling parsers.");
        }

        // Body text (from the opening brace to its matching close) of every ParseRequestItem* method.
        private static IEnumerable<string> ExtractParseRequestBodies(string text)
        {
            foreach (Match m in ParseRequestSig.Matches(text))
            {
                var open = text.IndexOf('{', m.Index);
                if (open < 0)
                    continue;

                var depth = 0;
                for (var i = open; i < text.Length; i++)
                {
                    if (text[i] == '{')
                    {
                        depth++;
                    }
                    else if (text[i] == '}')
                    {
                        depth--;
                        if (depth == 0)
                        {
                            yield return text.Substring(open, i - open + 1);
                            break;
                        }
                    }
                }
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
