using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Configuration
{
    public sealed class EnhancedStateMigrationTests : IDisposable
    {
        private const string SourceXml = "Jellyfin.Plugin.JellyfinEnhanced.xml";
        private const string TargetXml = "Jellyfin.Plugin.JellyfinCanopy.xml";
        private const string SourceData = "Jellyfin.Plugin.JellyfinEnhanced";
        private const string TargetData = "Jellyfin.Plugin.JellyfinCanopy";
        private const string UserId = "0123456789abcdef0123456789abcdef";

        private readonly string _root = Path.Combine(
            Path.GetTempPath(),
            "jc-enhanced-import-" + Guid.NewGuid().ToString("N"));

        public EnhancedStateMigrationTests()
        {
            Directory.CreateDirectory(_root);
        }

        public void Dispose()
        {
            try
            {
                Directory.Delete(_root, recursive: true);
            }
            catch
            {
                // Best-effort test cleanup.
            }

            GC.SuppressFinalize(this);
        }

        [Fact]
        public void ImportsCompleteEnhancedFixtureAndPreservesRollbackSource()
        {
            WriteSourceConfig("<DevMode>true</DevMode><JellyseerrEnabled>true</JellyseerrEnabled>");
            WriteSourceData(UserId + "/settings.json", "{\"language\":\"fr\"}");
            WriteSourceData(UserId + "/shortcuts.json", "{\"Shortcuts\":[]}");
            WriteSourceData(UserId + "/bookmark.json", "{\"Bookmarks\":{\"Bm_1\":{\"ItemId\":\"abc\"}}}");
            WriteSourceData(UserId + "/elsewhere.json", "{\"Region\":\"AU\"}");
            WriteSourceData(UserId + "/hidden-content.json", "{\"Items\":{\"abc\":{\"ItemId\":\"abc\"}}}");
            WriteSourceData(UserId + "/processed-watchlist-items.json", "{\"Items\":[]}");
            WriteSourceData("reviews.json", "{\"Reviews\":{\"r1\":{\"Content\":\"great\"}}}");
            WriteSourceData("custom_branding/login.css", ".login { color: red; }");
            WriteSourceData("tag-cache.json", "{\"Items\":{}}");

            var status = Run();

            Assert.Equal(EnhancedStateMigrationStatus.Imported, status);
            Assert.Equal(File.ReadAllText(PathOf(SourceXml)), File.ReadAllText(PathOf(TargetXml)));
            Assert.Equal(
                "{\"Bookmarks\":{\"Bm_1\":{\"ItemId\":\"abc\"}}}",
                File.ReadAllText(PathOf(TargetData, UserId, "bookmark.json")));
            Assert.Equal(
                "{\"Items\":{\"abc\":{\"ItemId\":\"abc\"}}}",
                File.ReadAllText(PathOf(TargetData, UserId, "hidden-content.json")));
            Assert.Equal(
                "{\"Reviews\":{\"r1\":{\"Content\":\"great\"}}}",
                File.ReadAllText(PathOf(TargetData, "reviews.json")));
            Assert.Equal(
                ".login { color: red; }",
                File.ReadAllText(PathOf(TargetData, "custom_branding", "login.css")));
            Assert.True(File.Exists(PathOf(TargetData, EnhancedStateMigration.ImportMarkerFileName)));
            Assert.True(File.Exists(PathOf(TargetXml + EnhancedStateMigration.CompletionMarkerSuffix)));

            // The old plugin remains a complete rollback/export source.
            Assert.True(File.Exists(PathOf(SourceXml)));
            Assert.True(File.Exists(PathOf(SourceData, UserId, "settings.json")));
            Assert.True(File.Exists(PathOf(SourceData, "reviews.json")));
        }

        [Fact]
        public void CompletedImportIsIdempotentAndDoesNotReplayLaterSourceChanges()
        {
            WriteSourceConfig("<DevMode>true</DevMode>");
            WriteSourceData(UserId + "/settings.json", "{\"Language\":\"en\"}");
            Assert.Equal(EnhancedStateMigrationStatus.Imported, Run());

            File.WriteAllText(PathOf(TargetXml), "<PluginConfiguration><DevMode>false</DevMode></PluginConfiguration>");
            File.WriteAllText(PathOf(SourceData, UserId, "settings.json"), "{\"Language\":\"de\"}");

            Assert.Equal(EnhancedStateMigrationStatus.AlreadyImported, Run());
            Assert.Contains("<DevMode>false", File.ReadAllText(PathOf(TargetXml)), StringComparison.Ordinal);
            Assert.Equal(
                "{\"Language\":\"en\"}",
                File.ReadAllText(PathOf(TargetData, UserId, "settings.json")));
        }

        [Fact]
        public void ExistingIndependentCanopyConfigRejectsTheWholeImport()
        {
            WriteSourceConfig("<DevMode>true</DevMode>");
            WriteSourceData(UserId + "/settings.json", "{}");
            File.WriteAllText(PathOf(TargetXml), "<PluginConfiguration><DevMode>false</DevMode></PluginConfiguration>");

            Assert.Equal(EnhancedStateMigrationStatus.Conflict, Run());
            Assert.False(Directory.Exists(PathOf(TargetData)));
            Assert.Contains("<DevMode>false", File.ReadAllText(PathOf(TargetXml)), StringComparison.Ordinal);
            Assert.Equal(EnhancedStateMigrationStatus.AlreadyImported, Run());
        }

        [Fact]
        public void ExistingIndependentCanopyDataRejectsTheWholeImport()
        {
            WriteSourceConfig("<DevMode>true</DevMode>");
            WriteSourceData(UserId + "/settings.json", "{\"Language\":\"en\"}");
            Directory.CreateDirectory(PathOf(TargetData, UserId));
            File.WriteAllText(PathOf(TargetData, UserId, "settings.json"), "{\"Language\":\"fr\"}");

            Assert.Equal(EnhancedStateMigrationStatus.Conflict, Run());
            Assert.False(File.Exists(PathOf(TargetXml)));
            Assert.Equal(
                "{\"Language\":\"fr\"}",
                File.ReadAllText(PathOf(TargetData, UserId, "settings.json")));
            Assert.Equal(EnhancedStateMigrationStatus.AlreadyImported, Run());
        }

        [Fact]
        public void RetryFinishesDataAfterConfigWasAlreadyPublished()
        {
            WriteSourceConfig("<DevMode>true</DevMode>");
            File.Copy(PathOf(SourceXml), PathOf(TargetXml));
            WriteSourceData(UserId + "/bookmark.json", "{\"Bookmarks\":{}}");

            Assert.Equal(EnhancedStateMigrationStatus.Imported, Run());
            Assert.True(File.Exists(PathOf(TargetData, UserId, "bookmark.json")));
        }

        [Fact]
        public void RetryFinishesConfigAfterMarkedDataWasAlreadyPublished()
        {
            WriteSourceConfig("<DevMode>true</DevMode>");
            WriteSourceData(UserId + "/bookmark.json", "{\"Bookmarks\":{}}");
            Directory.CreateDirectory(PathOf(TargetData));
            WriteValidTargetMarker();

            Assert.Equal(EnhancedStateMigrationStatus.Imported, Run());
            Assert.True(File.Exists(PathOf(TargetXml)));
        }

        [Fact]
        public void StaleStagingTreeIsRebuiltBeforePublish()
        {
            WriteSourceData(UserId + "/hidden-content.json", "{\"Items\":{}}");
            var staging = PathOf(TargetData + ".enhanced-importing");
            Directory.CreateDirectory(staging);
            File.WriteAllText(Path.Combine(staging, "partial.txt"), "partial");

            Assert.Equal(EnhancedStateMigrationStatus.Imported, Run());
            Assert.False(File.Exists(PathOf(TargetData, "partial.txt")));
            Assert.True(File.Exists(PathOf(TargetData, UserId, "hidden-content.json")));
        }

        [Fact]
        public void InvalidEnhancedXmlFailsWithoutPublishingOrMutatingSource()
        {
            File.WriteAllText(PathOf(SourceXml), "<PluginConfigur");
            WriteSourceData(UserId + "/settings.json", "{}");

            Assert.Equal(EnhancedStateMigrationStatus.Failed, Run());
            Assert.Equal("<PluginConfigur", File.ReadAllText(PathOf(SourceXml)));
            Assert.False(File.Exists(PathOf(TargetXml)));
            Assert.False(Directory.Exists(PathOf(TargetData)));
        }

        [Theory]
        [InlineData("reviews.json")]
        [InlineData(UserId + "/settings.json")]
        [InlineData(UserId + "/bookmark.json")]
        [InlineData(UserId + "/hidden-content.json")]
        public void InvalidCriticalJsonFailsWithoutPublishing(string relativePath)
        {
            WriteSourceConfig("<DevMode>true</DevMode>");
            WriteSourceData(relativePath, "{not-json");

            Assert.Equal(EnhancedStateMigrationStatus.Failed, Run());
            Assert.False(File.Exists(PathOf(TargetXml)));
            Assert.False(Directory.Exists(PathOf(TargetData)));
            Assert.Equal("{not-json", File.ReadAllText(PathOf(SourceData, relativePath)));
        }

        [Fact]
        public void MissingHalfOfSourceImportsTheAvailableHalf()
        {
            WriteSourceData(UserId + "/settings.json", "{}");

            Assert.Equal(EnhancedStateMigrationStatus.Imported, Run());
            Assert.False(File.Exists(PathOf(TargetXml)));
            Assert.True(File.Exists(PathOf(TargetData, UserId, "settings.json")));
        }

        [Fact]
        public void UnrelatedNestedJsonWithACriticalFileNameIsCopiedWithoutUserSchemaValidation()
        {
            WriteSourceData("custom_branding/settings.json", "[\"asset-metadata\"]");

            Assert.Equal(EnhancedStateMigrationStatus.Imported, Run());
            Assert.Equal(
                "[\"asset-metadata\"]",
                File.ReadAllText(PathOf(TargetData, "custom_branding", "settings.json")));
        }

        [Fact]
        public void InvalidMarkerCannotDisguiseIndependentCanopyData()
        {
            WriteSourceData(UserId + "/settings.json", "{\"Language\":\"en\"}");
            Directory.CreateDirectory(PathOf(TargetData));
            File.WriteAllText(PathOf(TargetData, EnhancedStateMigration.ImportMarkerFileName), "{}");

            Assert.Equal(EnhancedStateMigrationStatus.Conflict, Run());
            Assert.False(File.Exists(PathOf(TargetData, UserId, "settings.json")));
        }

        [Fact]
        public void LinkedSourceOrTargetDataFailsClosedWithoutTouchingTheLinkTarget()
        {
            if (OperatingSystem.IsWindows())
            {
                return;
            }

            var realSource = PathOf("real-source");
            Directory.CreateDirectory(realSource);
            File.WriteAllText(Path.Combine(realSource, "reviews.json"), "{\"Reviews\":{}}");
            Directory.CreateSymbolicLink(PathOf(SourceData), realSource);

            Assert.Equal(EnhancedStateMigrationStatus.Failed, Run());
            Assert.True(File.Exists(Path.Combine(realSource, "reviews.json")));
            Directory.Delete(PathOf(SourceData));

            Directory.CreateDirectory(PathOf(SourceData));
            File.WriteAllText(PathOf(SourceData, "reviews.json"), "{\"Reviews\":{}}");
            var realTarget = PathOf("real-target");
            Directory.CreateDirectory(realTarget);
            Directory.CreateSymbolicLink(PathOf(TargetData), realTarget);

            Assert.Equal(EnhancedStateMigrationStatus.Failed, Run());
            Assert.True(Directory.Exists(realTarget));
        }

        [Fact]
        public void NoEnhancedSourceIsANoOp()
        {
            Assert.Equal(EnhancedStateMigrationStatus.NoSource, Run());
            Assert.Empty(Directory.EnumerateFileSystemEntries(_root));
        }

        private EnhancedStateMigrationStatus Run()
            => EnhancedStateMigration.Run(
                _root,
                PathOf(TargetXml),
                TargetData,
                _ => { },
                _ => { });

        private void WriteSourceConfig(string innerXml)
        {
            File.WriteAllText(PathOf(SourceXml), $"<PluginConfiguration>{innerXml}</PluginConfiguration>");
        }

        private void WriteSourceData(string relativePath, string content)
        {
            var path = PathOf(SourceData, relativePath);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, content);
        }

        private void WriteValidTargetMarker()
        {
            File.WriteAllText(
                PathOf(TargetData, EnhancedStateMigration.ImportMarkerFileName),
                "{\"Source\":\"Jellyfin.Plugin.JellyfinEnhanced\",\"ContractVersion\":1,\"ConfigurationImported\":true,\"DataImported\":true,\"Resolution\":\"Imported\"}");
        }

        private string PathOf(params string[] parts)
            => parts.Aggregate(_root, Path.Combine);
    }
}
