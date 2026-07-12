using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests
{
    /// <summary>
    /// The Elevate→Canopy rebrand keeps the plugin GUID but renames the assembly,
    /// which renames the config XML and the plugin-data directory Jellyfin derives
    /// from it. These tests prove an in-place upgrade adopts the legacy state
    /// (no settings/cache loss) and that the index.html script-tag scrubber still
    /// recognizes tags injected by pre-rebrand builds.
    /// </summary>
    public class RebrandMigrationTests : IDisposable
    {
        private const string LegacyXml = "Jellyfin.Plugin.JellyfinElevate.xml";
        private const string NewXml = "Jellyfin.Plugin.JellyfinCanopy.xml";
        private const string LegacyDataDir = "Jellyfin.Plugin.JellyfinElevate";
        private const string NewDataDir = "Jellyfin.Plugin.JellyfinCanopy";

        private readonly string _dir;

        public RebrandMigrationTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "jc-rebrand-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_dir);
        }

        public void Dispose()
        {
            try { Directory.Delete(_dir, recursive: true); } catch { /* best effort */ }
            GC.SuppressFinalize(this);
        }

        private void Migrate() => JellyfinCanopy.MigrateLegacyStateCore(
            _dir,
            Path.Combine(_dir, NewXml),
            NewDataDir,
            _ => { },
            _ => { });

        [Fact]
        public void CopiesLegacyConfigWhenNewIsMissing()
        {
            File.WriteAllText(Path.Combine(_dir, LegacyXml), "<PluginConfiguration><DevMode>true</DevMode></PluginConfiguration>");

            Migrate();

            Assert.Equal(
                "<PluginConfiguration><DevMode>true</DevMode></PluginConfiguration>",
                File.ReadAllText(Path.Combine(_dir, NewXml)));
            // Copy, not move: a rollback to the old DLL must still find its file.
            Assert.True(File.Exists(Path.Combine(_dir, LegacyXml)));
        }

        [Fact]
        public void NeverOverwritesAnExistingCanopyConfig()
        {
            File.WriteAllText(Path.Combine(_dir, LegacyXml), "<old/>");
            File.WriteAllText(Path.Combine(_dir, NewXml), "<new/>");

            Migrate();

            Assert.Equal("<new/>", File.ReadAllText(Path.Combine(_dir, NewXml)));
        }

        [Fact]
        public void MovesLegacyDataDirectoryWithContents()
        {
            var legacyBranding = Path.Combine(_dir, LegacyDataDir, "custom_branding");
            Directory.CreateDirectory(legacyBranding);
            File.WriteAllText(Path.Combine(legacyBranding, "login.css"), ".login {}");

            Migrate();

            Assert.False(Directory.Exists(Path.Combine(_dir, LegacyDataDir)));
            Assert.Equal(
                ".login {}",
                File.ReadAllText(Path.Combine(_dir, NewDataDir, "custom_branding", "login.css")));
        }

        [Fact]
        public void KeepsExistingCanopyDataDirectoryWhenBothExist()
        {
            Directory.CreateDirectory(Path.Combine(_dir, LegacyDataDir));
            var newDir = Path.Combine(_dir, NewDataDir);
            Directory.CreateDirectory(newDir);
            File.WriteAllText(Path.Combine(newDir, "marker.txt"), "canopy");

            Migrate();

            Assert.True(Directory.Exists(Path.Combine(_dir, LegacyDataDir)));
            Assert.Equal("canopy", File.ReadAllText(Path.Combine(newDir, "marker.txt")));
        }

        [Fact]
        public void NoLegacyStateIsANoOp()
        {
            Migrate();

            Assert.False(File.Exists(Path.Combine(_dir, NewXml)));
            Assert.False(Directory.Exists(Path.Combine(_dir, NewDataDir)));
        }

        [Theory]
        [InlineData("Jellyfin Canopy")]
        [InlineData("Jellyfin Elevate")]
        public void ScriptTagScrubberRemovesCurrentAndLegacyTags(string pluginName)
        {
            var html = "<body><script plugin=\"" + pluginName + "\" version=\"1.0.0.0-1\" src=\"../X/script\" defer></script>\n</body>";

            var scrubbed = JellyfinCanopy.OwnScriptTagRegex().Replace(html, string.Empty);

            Assert.Equal("<body></body>", scrubbed);
        }

        [Fact]
        public void ScriptTagScrubberIgnoresOtherPlugins()
        {
            var html = "<body><script plugin=\"Some Other Plugin\" src=\"x.js\"></script></body>";

            Assert.Equal(html, JellyfinCanopy.OwnScriptTagRegex().Replace(html, string.Empty));
        }
    }
}
