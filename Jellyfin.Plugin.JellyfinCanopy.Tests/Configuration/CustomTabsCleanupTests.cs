using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Configuration
{
    /// <summary>
    /// The 2.x pages-framework rework dropped the Custom-Tabs delivery mode, so the
    /// one-time startup cleanup (<see cref="JellyfinCanopy.CleanupManagedCustomTabsCore"/>)
    /// removes the home-page tabs Jellyfin Canopy previously pushed into the external
    /// Custom Tabs plugin's config. Ownership is decided by the retired
    /// *CustomTabJeOwned flags still present as ignored elements in Canopy's own
    /// config XML: a current-name marker is removed only when its flag was true (an
    /// admin who hand-pasted the same marker keeps their tab); pre-2.0 Elevate
    /// markers are always Canopy's. Idempotent; never throws on a missing or
    /// malformed file.
    ///
    /// The external Custom Tabs plugin (IAmParadox27, GUID fbacd0b6-…) stores its
    /// config as a standard Jellyfin BasePluginConfiguration — an XML file — so the
    /// fixtures are the XML Jellyfin's XmlSerializer produces for it, NOT JSON.
    /// </summary>
    public class CustomTabsCleanupTests : IDisposable
    {
        private readonly string _dir;

        public CustomTabsCleanupTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "jc-customtabs-cleanup-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_dir);
        }

        public void Dispose()
        {
            try { Directory.Delete(_dir, recursive: true); } catch { /* best effort */ }
            GC.SuppressFinalize(this);
        }

        private string ConfigPath => Path.Combine(_dir, "Jellyfin.Plugin.CustomTabs.xml");

        private readonly HashSet<string> _ownedFlags = new(StringComparer.Ordinal);

        private bool Cleanup() => JellyfinCanopy.CleanupManagedCustomTabsCore(ConfigPath, _ownedFlags, _ => { }, _ => { });

        /// <summary>Arm the ownership flags the caller reads off PluginConfiguration.</summary>
        private void WriteCanopyConfig(params string[] ownedFlagNames)
        {
            foreach (var name in ownedFlagNames) _ownedFlags.Add(name);
        }

        // A tab element for the fixture. ContentHtml is XML-escaped exactly the way
        // Jellyfin's XmlSerializer writes a TabConfig.ContentHtml string.
        private static string Tab(string title, string contentHtml)
            => $"    <TabConfig>\n      <ContentHtml>{System.Security.SecurityElement.Escape(contentHtml)}</ContentHtml>\n      <Title>{title}</Title>\n    </TabConfig>\n";

        private void WriteConfig(params string[] tabs)
            => File.WriteAllText(ConfigPath,
                "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n"
                + "<PluginConfiguration xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xmlns:xsd=\"http://www.w3.org/2001/XMLSchema\">\n"
                + "  <Tabs>\n"
                + string.Concat(tabs)
                + "  </Tabs>\n"
                + "</PluginConfiguration>\n");

        [Fact]
        public void RemovesOnlyCanopyOwnedEntriesAndKeepsForeignOnes()
        {
            WriteCanopyConfig("CalendarCustomTabJeOwned", "BookmarksCustomTabJeOwned", "DownloadsCustomTabJeOwned");
            WriteConfig(
                Tab("Calendar", "<div class=\"jellyfincanopy calendar\"></div>"),
                Tab("Bookmarks", "<div class=\"sections bookmarks\"></div>"),
                Tab("My Homelab", "<div class=\"admins own tab\"></div>"),
                Tab("Requests", "<div class=\"jellyfincanopy requests\"></div>"));

            Assert.True(Cleanup());

            var result = File.ReadAllText(ConfigPath);
            // Every Canopy-owned marker is gone.
            Assert.DoesNotContain("jellyfincanopy calendar", result);
            Assert.DoesNotContain("sections bookmarks", result);
            Assert.DoesNotContain("jellyfincanopy requests", result);
            // The admin's hand-made tab and its title survive untouched.
            Assert.Contains("admins own tab", result);
            Assert.Contains("<Title>My Homelab</Title>", result);
            // Still a well-formed config with exactly the one surviving tab.
            var doc = System.Xml.Linq.XDocument.Parse(result);
            Assert.Single(doc.Descendants("TabConfig"));
        }

        [Fact]
        public void RemovesPreRebrandElevateMarkersWithoutAnyOwnershipFlags()
        {
            WriteConfig(
                Tab("Hidden Content", "<div class=\"jellyfinelevate hidden-content\"></div>"),
                Tab("Calendar", "<div class=\"jellyfinelevate calendar\"></div>"),
                Tab("Keep Me", "<div class=\"not ours\"></div>"));

            Assert.True(Cleanup());

            var result = File.ReadAllText(ConfigPath);
            Assert.DoesNotContain("jellyfinelevate", result);
            Assert.Contains("not ours", result);
            Assert.Single(System.Xml.Linq.XDocument.Parse(result).Descendants("TabConfig"));
        }

        [Fact]
        public void UnownedCurrentMarkerIsTheAdminsTabAndSurvives()
        {
            // No Canopy config at all (or flags false): the admin hand-pasted the
            // same marker following the old manual instructions — their tab stays.
            WriteConfig(
                Tab("My Calendar", "<div class=\"jellyfincanopy calendar\"></div>"),
                Tab("Old Elevate", "<div class=\"jellyfinelevate calendar\"></div>"));

            Assert.True(Cleanup());

            var result = File.ReadAllText(ConfigPath);
            // The unowned current marker survives; the Elevate-era marker is
            // uniquely Canopy's and goes regardless of flags.
            Assert.Contains("jellyfincanopy calendar", result);
            Assert.DoesNotContain("jellyfinelevate calendar", result);
            Assert.Single(System.Xml.Linq.XDocument.Parse(result).Descendants("TabConfig"));
        }

        [Fact]
        public void OwnershipFlagsGateEachPageIndependently()
        {
            WriteCanopyConfig("CalendarCustomTabJeOwned");
            WriteConfig(
                Tab("Calendar", "<div class=\"jellyfincanopy calendar\"></div>"),
                Tab("Requests", "<div class=\"jellyfincanopy requests\"></div>"));

            Assert.True(Cleanup());

            var result = File.ReadAllText(ConfigPath);
            Assert.DoesNotContain("jellyfincanopy calendar", result);
            // Requests was never Canopy-created on this install — it stays.
            Assert.Contains("jellyfincanopy requests", result);
        }

        [Fact]
        public void MissingConfigIsANoOp()
        {
            Assert.True(Cleanup());
            Assert.False(File.Exists(ConfigPath));
        }

        [Fact]
        public void ConfigWithNoCanopyEntriesIsLeftByteForByteUntouched()
        {
            WriteConfig(
                Tab("My Homelab", "<div class=\"admins own tab\"></div>"),
                Tab("Docs", "<div class=\"admin docs\"></div>"));
            var before = File.ReadAllText(ConfigPath);
            var beforeWrite = File.GetLastWriteTimeUtc(ConfigPath);

            Assert.True(Cleanup());

            // Nothing to remove ⇒ no rewrite at all (avoids per-boot churn).
            Assert.Equal(before, File.ReadAllText(ConfigPath));
            Assert.Equal(beforeWrite, File.GetLastWriteTimeUtc(ConfigPath));
        }

        [Fact]
        public void IsIdempotent_SecondRunIsANoOp()
        {
            WriteCanopyConfig("CalendarCustomTabJeOwned");
            WriteConfig(
                Tab("Calendar", "<div class=\"jellyfincanopy calendar\"></div>"),
                Tab("Keep", "<div class=\"keep me\"></div>"));

            Assert.True(Cleanup());
            var afterFirst = File.ReadAllText(ConfigPath);
            var afterFirstWrite = File.GetLastWriteTimeUtc(ConfigPath);

            // Second pass finds no Canopy entry ⇒ no further write.
            Assert.True(Cleanup());
            Assert.Equal(afterFirst, File.ReadAllText(ConfigPath));
            Assert.Equal(afterFirstWrite, File.GetLastWriteTimeUtc(ConfigPath));
        }

        [Fact]
        public void MalformedConfigIsLeftUntouchedAndReportsFailure()
        {
            const string garbage = "<PluginConfiguration><Tabs><TabConfig>";
            File.WriteAllText(ConfigPath, garbage);

            // False = a present file could not be processed; the file is not rewritten
            // and startup is never blocked (the caller only logs).
            Assert.False(Cleanup());
            Assert.Equal(garbage, File.ReadAllText(ConfigPath));
        }
    }

    /// <summary>
    /// The retired PluginPages integration wrote page entries (Canopy-namespaced Ids)
    /// into that external plugin's config.json; the one-time cleanup removes exactly
    /// those, current and pre-2.0 Elevate, leaving foreign pages untouched.
    /// </summary>
    public class PluginPagesCleanupTests : IDisposable
    {
        private readonly string _dir;

        public PluginPagesCleanupTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "jc-pluginpages-cleanup-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_dir);
        }

        public void Dispose()
        {
            try { Directory.Delete(_dir, recursive: true); } catch { /* best effort */ }
            GC.SuppressFinalize(this);
        }

        private string ConfigPath => Path.Combine(_dir, "config.json");

        private bool Cleanup() => JellyfinCanopy.CleanupRetiredPluginPagesCore(ConfigPath, _ => { }, _ => { });

        [Fact]
        public void RemovesCanopyAndElevatePagesKeepsForeignOnes()
        {
            File.WriteAllText(ConfigPath,
                "{\"Pages\":[" +
                "{\"Id\":\"Jellyfin.Plugin.JellyfinCanopy\",\"DisplayText\":\"Canopy\"}," +
                "{\"Id\":\"Jellyfin.Plugin.JellyfinCanopy.CalendarPage\",\"DisplayText\":\"Calendar\"}," +
                "{\"Id\":\"Jellyfin.Plugin.JellyfinElevate.DownloadsPage\",\"DisplayText\":\"Requests\"}," +
                "{\"Id\":\"Some.Other.Plugin.Page\",\"DisplayText\":\"Keep me\"}" +
                "]}");

            Assert.True(Cleanup());

            var json = System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(ConfigPath))!;
            var pages = json["Pages"]!.AsArray();
            Assert.Single(pages);
            Assert.Equal("Some.Other.Plugin.Page", (string?)pages[0]!["Id"]);
        }

        [Fact]
        public void MissingOrForeignOnlyConfigIsANoOp()
        {
            Assert.True(Cleanup());

            File.WriteAllText(ConfigPath, "{\"Pages\":[{\"Id\":\"Some.Other.Plugin.Page\"}]}");
            var before = File.GetLastWriteTimeUtc(ConfigPath);
            Assert.True(Cleanup());
            Assert.Equal(before, File.GetLastWriteTimeUtc(ConfigPath));
        }

        [Fact]
        public void MalformedConfigIsLeftUntouchedAndReportsFailure()
        {
            File.WriteAllText(ConfigPath, "{not json");
            Assert.False(Cleanup());
            Assert.Equal("{not json", File.ReadAllText(ConfigPath));
        }
    }
}
