using System.Text.RegularExpressions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Configuration
{
    /// <summary>
    /// Rebrand contract for the managed Custom Tabs sync (config-page.js): every
    /// managed entry whose marker carries the Canopy brand class must declare the
    /// pre-2.0 Elevate marker as its legacyHtml, and the sync must consult it.
    /// Without this, upgrading strands the user's existing tab (its marker is
    /// never recognized) and the next save adds a duplicate. Static-source guard
    /// in the same style as <see cref="ConfigPageBinderTests"/> — the sync's only
    /// behavioral harness is the live e2e suite.
    /// </summary>
    public class CustomTabLegacyMarkerTests
    {
        private static readonly Regex EntryRegex = new(
            @"\{\s*masterKey:\s*'[^']+'[^}]*?html:\s*'(?<html>[^']+)'(?:[^}]*?legacyHtml:\s*'(?<legacy>[^']+)')?[^}]*\}",
            RegexOptions.Compiled);

        [Fact]
        public void EveryBrandedManagedEntryDeclaresItsElevateLegacyMarker()
        {
            var matches = EntryRegex.Matches(ConfigPageSource.Js);
            Assert.True(matches.Count >= 4, "expected the four managed Custom Tabs entries in config-page.js");

            foreach (Match m in matches)
            {
                var html = m.Groups["html"].Value;
                if (!html.Contains("jellyfincanopy", StringComparison.Ordinal))
                {
                    continue; // brand-free marker (Bookmarks) never changed
                }

                var legacy = m.Groups["legacy"];
                Assert.True(legacy.Success, $"managed entry '{html}' is missing its legacyHtml Elevate marker");
                Assert.Equal(
                    html.Replace("jellyfincanopy", "jellyfinelevate", StringComparison.Ordinal),
                    legacy.Value);
            }
        }

        [Fact]
        public void SyncAdoptsLegacyMarkersInPlace()
        {
            // The load-bearing lines of the adoption path — if the sync loop stops
            // consulting legacyHtml, upgrades silently duplicate tabs again.
            Assert.Contains("cfg.Tabs[i].ContentHtml === entry.legacyHtml", ConfigPageSource.Js, StringComparison.Ordinal);
            Assert.Contains("cfg.Tabs[legacyIdx].ContentHtml = entry.html", ConfigPageSource.Js, StringComparison.Ordinal);
        }
    }
}
