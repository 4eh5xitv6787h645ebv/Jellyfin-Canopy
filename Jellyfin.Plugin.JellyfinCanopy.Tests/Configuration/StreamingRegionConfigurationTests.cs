using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Configuration;

public sealed class StreamingRegionConfigurationTests
{
    [Theory]
    [InlineData(" us ", "US")]
    [InlineData("xk", "XK")]
    [InlineData("", "US")]
    [InlineData("  ", "US")]
    [InlineData("USA", "US")]
    [InlineData("1A", "US")]
    [InlineData("ZZ", "US")]
    [InlineData(null, "US")]
    public void UpdateNormalization_IsDeterministicAndPreservesValidUncommonSyntax(
        string? persisted,
        string expected)
    {
        var config = new PluginConfiguration { DEFAULT_REGION = persisted! };

        JellyfinCanopy.NormalizeDefaultStreamingRegionForUpdate(config);

        Assert.Equal(expected, config.DEFAULT_REGION);
    }

    [Fact]
    public void SupportedCatalog_IsExactAndPreservesUncommonCodes()
    {
        Assert.Equal(139, StreamingRegionNormalizer.SupportedCount);
        Assert.True(StreamingRegionNormalizer.IsSupported("xk"));
        Assert.Equal("XK", StreamingRegionNormalizer.Normalize(" xk "));
        Assert.False(StreamingRegionNormalizer.IsSupported("ZZ"));
    }

    [Fact]
    public void UserOverrides_InheritForUnknownAndFilterManualRegions()
    {
        Assert.Equal(string.Empty, StreamingRegionNormalizer.NormalizeOverride("ZZ"));
        Assert.Equal(string.Empty, StreamingRegionNormalizer.NormalizeOverride("malformed"));
        Assert.Equal("XK", StreamingRegionNormalizer.NormalizeOverride(" xk "));
        Assert.Equal(
            new[] { "CA", "XK" },
            StreamingRegionNormalizer.NormalizeOverrides(new[] { "ca", "ZZ", "XK", "CA", "bad" }));
    }
}
