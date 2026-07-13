using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Configuration
{
    /// <summary>
    /// The 2.x pages-framework rework dropped the Custom-Tabs delivery mode, so the
    /// one-time startup cleanup (<see cref="JellyfinCanopy.CleanupManagedCustomTabsCore"/>)
    /// removes the home-page tabs Jellyfin Canopy previously pushed into the external
    /// Custom Tabs plugin's config. These tests prove it removes ONLY Canopy-owned
    /// entries (by their exact ContentHtml markers, current and pre-2.0 Elevate),
    /// leaves admin-made tabs untouched, is idempotent, and never throws on a missing
    /// or malformed file.
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

        private bool Cleanup() => JellyfinCanopy.CleanupManagedCustomTabsCore(ConfigPath, _ => { }, _ => { });

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
            WriteConfig(
                Tab("Calendar", "<div class=\"jellyfincanopy calendar\"></div>"),
                Tab("Bookmarks", "<div class=\"sections bookmarks\"></div>"),
                Tab("My Homelab", "<div class=\"admins own tab\"></div>"),
                Tab("Requests", "<div class=\"jellyfincanopy requests\"></div>"));

            Assert.True(Cleanup());

            var result = File.ReadAllText(ConfigPath);
            // Every Canopy marker is gone.
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
        public void RemovesPreRebrandElevateMarkers()
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

        [Fact]
        public void EveryMarkerIsRecognizedAndRemoved()
        {
            var tabs = JellyfinCanopy.CanopyCustomTabMarkers
                .Select((html, i) => Tab("Tab" + i, html))
                .ToArray();
            WriteConfig(tabs);

            Assert.True(Cleanup());

            Assert.Empty(System.Xml.Linq.XDocument.Parse(File.ReadAllText(ConfigPath)).Descendants("TabConfig"));
        }
    }
}
