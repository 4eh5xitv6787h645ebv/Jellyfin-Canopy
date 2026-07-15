using System.Security.Cryptography;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Build
{
    /// <summary>
    /// Proves that BuildClientBundle embeds the exact reviewed dist bytes rather
    /// than a stale or independently generated resource set.
    /// </summary>
    public sealed class EmbeddedBundleEquivalenceTests
    {
        private static readonly string[] BundleFiles =
        {
            "jc.bundle.js",
            "jc.bundle.js.map",
            "login-image.js",
            "login-image.js.map",
            "splashscreen.js",
            "splashscreen.js.map",
            "translations.js",
            "translations.js.map"
        };

        [Fact]
        public void PluginAssembly_EmbedsExactGeneratedBundleBytes()
        {
            var repositoryRoot = FindRepositoryRoot();
            var distDirectory = Path.Combine(
                repositoryRoot,
                "Jellyfin.Plugin.JellyfinCanopy",
                "dist");
            var assembly = typeof(ConfigController).Assembly;
            const string prefix = "Jellyfin.Plugin.JellyfinCanopy.dist.";
            var expectedResources = BundleFiles
                .Select(name => prefix + name)
                .OrderBy(name => name, StringComparer.Ordinal)
                .ToArray();
            var embeddedResources = assembly.GetManifestResourceNames()
                .Where(name => name.StartsWith(prefix, StringComparison.Ordinal))
                .OrderBy(name => name, StringComparer.Ordinal)
                .ToArray();

            Assert.Equal(expectedResources, embeddedResources);
            foreach (var name in BundleFiles)
            {
                var file = Path.Combine(distDirectory, name);
                Assert.True(File.Exists(file), $"Generated bundle file is missing: {file}");
                using var stream = assembly.GetManifestResourceStream(prefix + name);
                Assert.NotNull(stream);
                using var memory = new MemoryStream();
                stream!.CopyTo(memory);
                var embedded = memory.ToArray();
                var generated = File.ReadAllBytes(file);

                Assert.Equal(generated.Length, embedded.Length);
                Assert.Equal(SHA256.HashData(generated), SHA256.HashData(embedded));
            }
        }

        private static string FindRepositoryRoot()
        {
            var directory = new DirectoryInfo(AppContext.BaseDirectory);
            while (directory != null)
            {
                if (File.Exists(Path.Combine(directory.FullName, "package.json"))
                    && Directory.Exists(Path.Combine(directory.FullName, "Jellyfin.Plugin.JellyfinCanopy")))
                {
                    return directory.FullName;
                }
                directory = directory.Parent;
            }
            throw new DirectoryNotFoundException("Could not locate the Jellyfin Canopy repository root.");
        }
    }
}
