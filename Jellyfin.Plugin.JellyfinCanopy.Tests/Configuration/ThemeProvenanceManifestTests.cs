using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Configuration;

public sealed class ThemeProvenanceManifestTests
{
    [Fact]
    public void PluginAssembly_EmbedsMachineReadableThemeProvenance()
    {
        const string resourceName =
            "Jellyfin.Plugin.JellyfinCanopy.ThemeStudio.provenance.json";
        using var stream = typeof(ThemeConfigurationPolicy).Assembly
            .GetManifestResourceStream(resourceName);
        Assert.NotNull(stream);

        using var document = JsonDocument.Parse(stream!);
        var root = document.RootElement;
        Assert.Equal(1, root.GetProperty("schemaVersion").GetInt32());
        Assert.Matches(
            @"^\d{4}-\d{2}-\d{2}$",
            root.GetProperty("snapshotDate").GetString() ?? string.Empty);
        Assert.False(string.IsNullOrWhiteSpace(root.GetProperty("policy").GetString()));

        var sources = root.GetProperty("sources");
        Assert.True(sources.GetArrayLength() > 15);
        foreach (var source in sources.EnumerateArray())
        {
            Assert.StartsWith(
                "https://github.com/",
                source.GetProperty("url").GetString() ?? string.Empty);
            Assert.False(string.IsNullOrWhiteSpace(source.GetProperty("license").GetString()));
            Assert.False(string.IsNullOrWhiteSpace(source.GetProperty("reuse").GetString()));
            Assert.True(source.GetProperty("usedBy").GetArrayLength() > 0);
        }
    }
}
