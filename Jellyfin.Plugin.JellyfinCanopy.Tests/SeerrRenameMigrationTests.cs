using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests
{
    /// <summary>
    /// The 2.x jellyseerr→seerr identifier rename touches two persisted-name
    /// contracts: the "Jellyseerr*" element names in the plugin config XML and
    /// the "…Jellyseerr…" member names in per-user JSON files. These tests
    /// prove an in-place upgrade adopts both losslessly — and, critically, that
    /// only NAMES are rewritten: element/member VALUES are user data and may
    /// legitimately contain the string (a Seerr instance whose docker hostname
    /// is literally "jellyseerr").
    /// </summary>
    public class SeerrRenameMigrationTests : IDisposable
    {
        private readonly string _dir;

        public SeerrRenameMigrationTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "jc-seerr-rename-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_dir);
        }

        public void Dispose()
        {
            try { Directory.Delete(_dir, recursive: true); } catch { /* best effort */ }
            GC.SuppressFinalize(this);
        }

        private string ConfigPath => Path.Combine(_dir, "Jellyfin.Plugin.JellyfinCanopy.xml");

        private bool Migrate() => JellyfinCanopy.MigrateLegacySeerrElementNamesCore(ConfigPath, _ => { }, _ => { });

        [Fact]
        public void RenamesLegacyElementNamesAndKeepsValues()
        {
            File.WriteAllText(ConfigPath, """
                <?xml version="1.0" encoding="utf-8"?>
                <PluginConfiguration>
                  <JellyseerrEnabled>true</JellyseerrEnabled>
                  <JellyseerrUrls>http://jellyseerr:5055</JellyseerrUrls>
                  <ShowElsewhereOnJellyseerr>true</ShowElsewhereOnJellyseerr>
                  <HiddenContentDefaultShowButtonJellyseerr>false</HiddenContentDefaultShowButtonJellyseerr>
                  <SomethingUnrelated>keep</SomethingUnrelated>
                </PluginConfiguration>
                """.TrimStart());

            Assert.True(Migrate());

            var migrated = File.ReadAllText(ConfigPath);
            Assert.Contains("<SeerrEnabled>true</SeerrEnabled>", migrated);
            Assert.Contains("<ShowElsewhereOnSeerr>true</ShowElsewhereOnSeerr>", migrated);
            Assert.Contains("<HiddenContentDefaultShowButtonSeerr>false</HiddenContentDefaultShowButtonSeerr>", migrated);
            Assert.Contains("<SomethingUnrelated>keep</SomethingUnrelated>", migrated);
            // The VALUE keeps its legacy hostname — only the element name changed.
            Assert.Contains("<SeerrUrls>http://jellyseerr:5055</SeerrUrls>", migrated);
            Assert.DoesNotContain("<JellyseerrEnabled>", migrated);
        }

        [Fact]
        public void AlreadyMigratedConfigIsANoOpEvenWhenValuesContainTheLegacyString()
        {
            var current = """
                <?xml version="1.0" encoding="utf-8"?>
                <PluginConfiguration>
                  <SeerrEnabled>true</SeerrEnabled>
                  <SeerrUrls>http://jellyseerr:5055</SeerrUrls>
                </PluginConfiguration>
                """.TrimStart();
            File.WriteAllText(ConfigPath, current);
            var before = File.GetLastWriteTimeUtc(ConfigPath);

            Assert.True(Migrate());

            // No rename happened, so the file was not rewritten at all.
            Assert.Equal(current, File.ReadAllText(ConfigPath));
            Assert.Equal(before, File.GetLastWriteTimeUtc(ConfigPath));
        }

        [Fact]
        public void MissingConfigIsANoOp()
        {
            Assert.True(Migrate());
            Assert.False(File.Exists(ConfigPath));
        }

        [Fact]
        public void MalformedConfigIsLeftUntouchedAndReportsFailureSoWritesGetSuppressed()
        {
            File.WriteAllText(ConfigPath, "<PluginConfiguration><JellyseerrEnabled>");

            // False = the caller must suppress configuration writes this startup;
            // a save would replace the still-legacy file with loaded defaults.
            Assert.False(Migrate());
            Assert.Equal("<PluginConfiguration><JellyseerrEnabled>", File.ReadAllText(ConfigPath));
        }

        [Fact]
        public void AdoptsPascalCaseLegacyMemberNames()
        {
            var node = JsonNode.Parse("""{"HiddenItems":[],"ShowButtonJellyseerr":false}""");

            PersistedJson.AdoptLegacySeerrMemberNames(node);

            var obj = Assert.IsType<JsonObject>(node);
            Assert.False(obj.ContainsKey("ShowButtonJellyseerr"));
            Assert.False((bool)obj["ShowButtonSeerr"]!);
        }

        [Fact]
        public void AdoptsCamelCaseLegacyMemberNamesRecursively()
        {
            var node = JsonNode.Parse("""{"nested":{"showButtonJellyseerr":true},"list":[{"jellyseerrEnabled":1}]}""");

            PersistedJson.AdoptLegacySeerrMemberNames(node);

            Assert.True((bool)node!["nested"]!["showButtonSeerr"]!);
            Assert.Equal(1, (int)node["list"]![0]!["seerrEnabled"]!);
        }

        [Fact]
        public void CurrentMemberWinsOverALegacyDuplicate()
        {
            var node = JsonNode.Parse("""{"ShowButtonSeerr":true,"ShowButtonJellyseerr":false}""");

            PersistedJson.AdoptLegacySeerrMemberNames(node);

            var obj = Assert.IsType<JsonObject>(node);
            Assert.True((bool)obj["ShowButtonSeerr"]!);
            Assert.False(obj.ContainsKey("ShowButtonJellyseerr"));
        }

        [Fact]
        public void NeverRewritesMemberValues()
        {
            var node = JsonNode.Parse("""{"Url":"http://jellyseerr:5055/api","Note":"Jellyseerr was here"}""");

            PersistedJson.AdoptLegacySeerrMemberNames(node);

            Assert.Equal("http://jellyseerr:5055/api", (string)node!["Url"]!);
            Assert.Equal("Jellyseerr was here", (string)node["Note"]!);
        }
    }
}
