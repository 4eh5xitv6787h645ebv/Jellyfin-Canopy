using System.Xml.Serialization;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Configuration;

public sealed class LayoutEnforcementConfigurationTests
{
    [Fact]
    public void DefaultPreservesBrowserChoice()
    {
        Assert.Equal("None", new PluginConfiguration().LayoutEnforcement);
    }

    [Theory]
    [InlineData("ForceExperimental", "ForceExperimental")]
    [InlineData("None", "None")]
    [InlineData("DefaultExperimental", "None")]
    [InlineData("ForceLegacy", "None")]
    [InlineData("unexpected", "None")]
    [InlineData("", "None")]
    public void SetterKeepsOnlyModernSteering(string input, string expected)
    {
        var configuration = new PluginConfiguration { LayoutEnforcement = input };

        Assert.Equal(expected, configuration.LayoutEnforcement);
    }

    [Theory]
    [InlineData("DefaultExperimental")]
    [InlineData("ForceLegacy")]
    [InlineData("future-value")]
    public void RetiredOrUnknownXmlValuesNormalizeToNone(string value)
    {
        var serializer = new XmlSerializer(typeof(PluginConfiguration));
        using var reader = new StringReader($"<PluginConfiguration><LayoutEnforcement>{value}</LayoutEnforcement></PluginConfiguration>");

        var configuration = Assert.IsType<PluginConfiguration>(serializer.Deserialize(reader));

        Assert.Equal("None", configuration.LayoutEnforcement);
    }
}
