using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using MediaBrowser.Model.Updates;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Build
{
    /// <summary>
    /// Proves catalog payloads at the repository limit are consumable through
    /// Jellyfin's own package models without truncating the displayed changelog.
    /// </summary>
    public sealed class PluginCatalogPayloadTests
    {
        [Fact]
        public void MaximumCatalogResponse_PreservesDisplayTextThroughJellyfinPackageModel()
        {
            var root = FindRepositoryRoot();
            var policy = ReadPolicy(root);
            var expected = BuildMaximumChangelog(policy.MaxChangelogBytes, policy.MaxChangelogLines);
            var catalog = JsonNode.Parse(File.ReadAllText(Path.Combine(root, "manifest.json")))!.AsArray();
            catalog[0]!["versions"]![0]!["changelog"] = expected;
            var payload = catalog.ToJsonString();
            var parsed = JsonSerializer.Deserialize<PackageInfo[]>(payload);

            var package = Assert.Single(parsed!);
            Assert.Equal(catalog[0]!["versions"]!.AsArray().Count, package.Versions.Count);
            var changelog = package.Versions[0].Changelog;
            Assert.InRange(Encoding.UTF8.GetByteCount(payload), 1, policy.MaxManifestBytes);
            Assert.Equal(policy.MaxChangelogBytes, Encoding.UTF8.GetByteCount(changelog!));
            Assert.Equal(policy.MaxChangelogLines, changelog!.Split('\n').Length);
            Assert.Equal(expected, changelog);
        }

        [Fact]
        public void CommittedManifest_ParsesThroughJellyfinPackageModel()
        {
            var root = FindRepositoryRoot();
            var policy = ReadPolicy(root);
            var payload = File.ReadAllText(Path.Combine(root, "manifest.json"));
            var parsed = JsonSerializer.Deserialize<PackageInfo[]>(payload);

            var package = Assert.Single(parsed!);
            Assert.Equal("Jellyfin Canopy", package.Name);
            Assert.NotEmpty(package.Versions);
            Assert.All(package.Versions, version =>
            {
                Assert.False(string.IsNullOrWhiteSpace(version.Changelog));
                Assert.InRange(Encoding.UTF8.GetByteCount(version.Changelog), 1, policy.MaxChangelogBytes);
            });
        }

        private static string BuildMaximumChangelog(int maximumBytes, int maximumLines)
        {
            var textBytes = maximumBytes - (maximumLines - 1);
            var lines = Enumerable.Range(0, maximumLines)
                .Select(index =>
                {
                    var start = (index * textBytes) / maximumLines;
                    var end = ((index + 1) * textBytes) / maximumLines;
                    return new string('x', end - start);
                });
            var result = string.Join('\n', lines);
            Assert.Equal(maximumBytes, Encoding.UTF8.GetByteCount(result));
            return result;
        }

        private static (int MaxChangelogBytes, int MaxChangelogLines, int MaxManifestBytes) ReadPolicy(
            string repositoryRoot)
        {
            using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(
                repositoryRoot,
                "scripts",
                "release",
                "manifest-policy.json")));
            var root = document.RootElement;
            return (
                root.GetProperty("maxChangelogBytes").GetInt32(),
                root.GetProperty("maxChangelogLines").GetInt32(),
                root.GetProperty("maxManifestBytes").GetInt32());
        }

        private static string FindRepositoryRoot()
        {
            var directory = new DirectoryInfo(AppContext.BaseDirectory);
            while (directory != null)
            {
                if (File.Exists(Path.Combine(directory.FullName, "package.json"))
                    && File.Exists(Path.Combine(directory.FullName, "manifest.json")))
                {
                    return directory.FullName;
                }
                directory = directory.Parent;
            }
            throw new DirectoryNotFoundException("Could not locate the Jellyfin Canopy repository root.");
        }
    }
}
