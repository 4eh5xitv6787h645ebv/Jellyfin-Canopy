using System.Xml.Serialization;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Configuration;

public sealed class PlatformConfigurationCompatibilityTests
{
    [Fact]
    public void MissingPlatformEnabledElementDefaultsTrueForExistingInstallations()
    {
        const string legacy = """
            <?xml version="1.0" encoding="utf-16"?>
            <PluginConfiguration xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
              <ToastDuration>900</ToastDuration>
            </PluginConfiguration>
            """;

        var parsed = Deserialize(legacy);

        Assert.True(parsed.PlatformEnabled);
        Assert.Equal(900, parsed.ToastDuration);
    }

    [Fact]
    public void ExplicitFalseRoundTripsThroughJellyfinXmlConfiguration()
    {
        var configuration = new PluginConfiguration { PlatformEnabled = false };
        var serializer = new XmlSerializer(typeof(PluginConfiguration));
        using var writer = new StringWriter();
        serializer.Serialize(writer, configuration);

        var xml = writer.ToString();
        var parsed = Deserialize(xml);

        Assert.Contains("<PlatformEnabled>false</PlatformEnabled>", xml, StringComparison.Ordinal);
        Assert.False(parsed.PlatformEnabled);
    }

    private static PluginConfiguration Deserialize(string xml)
    {
        var serializer = new XmlSerializer(typeof(PluginConfiguration));
        using var reader = new StringReader(xml);
        return Assert.IsType<PluginConfiguration>(serializer.Deserialize(reader));
    }
}
