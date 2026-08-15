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
    [InlineData(null, "US")]
    public void UpdateNormalization_IsDeterministicAndPreservesValidUncommonSyntax(
        string? persisted,
        string expected)
    {
        var config = new PluginConfiguration { DEFAULT_REGION = persisted! };

        JellyfinCanopy.NormalizeDefaultStreamingRegionForUpdate(config);

        Assert.Equal(expected, config.DEFAULT_REGION);
    }
}
