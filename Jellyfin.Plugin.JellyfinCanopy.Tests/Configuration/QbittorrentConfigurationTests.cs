using System.Text.Json;
using System.Xml.Serialization;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Configuration;

public sealed class QbittorrentConfigurationTests
{
    [Fact]
    public void DashboardUpdate_PreservesWriteOnlyConnectionValues()
    {
        var current = Connection("http://server.invalid:8080", "operator", "secret", "/source|/library");
        var incoming = new PluginConfiguration();

        JellyfinCanopy.PreserveQbittorrentConnectionForDashboardUpdate(incoming, current);

        Assert.Equal(current.QbittorrentUrl, incoming.QbittorrentUrl);
        Assert.Equal(current.QbittorrentUsername, incoming.QbittorrentUsername);
        Assert.Equal(current.QbittorrentPassword, incoming.QbittorrentPassword);
        Assert.Equal(current.QbittorrentPathMappings, incoming.QbittorrentPathMappings);
    }

    [Fact]
    public void ElevatedUpdate_DoesNotOverwriteExplicitConnectionValues()
    {
        var current = Connection("http://old.invalid", "old", "old-secret", "/old|/old-library");
        var incoming = Connection("http://new.invalid", "new", "new-secret", "/new|/new-library");

        JellyfinCanopy.PreserveQbittorrentConnectionForDashboardUpdate(incoming, current);

        Assert.Equal("http://new.invalid", incoming.QbittorrentUrl);
        Assert.Equal("new", incoming.QbittorrentUsername);
        Assert.Equal("new-secret", incoming.QbittorrentPassword);
        Assert.Equal("/new|/new-library", incoming.QbittorrentPathMappings);
    }

    [Fact]
    public void ConnectionValues_ArePersistedInXmlButExcludedFromJson()
    {
        const string marker = "write-only-marker";
        var configuration = Connection(marker, marker, marker, marker);

        using var writer = new StringWriter();
        new XmlSerializer(typeof(PluginConfiguration)).Serialize(writer, configuration);
        var xml = writer.ToString();
        var json = JsonSerializer.Serialize(configuration);

        Assert.Contains(marker, xml, StringComparison.Ordinal);
        Assert.DoesNotContain(marker, json, StringComparison.Ordinal);
        Assert.DoesNotContain("QbittorrentUrl", json, StringComparison.Ordinal);
        Assert.DoesNotContain("QbittorrentPathMappings", json, StringComparison.Ordinal);
    }

    private static PluginConfiguration Connection(
        string url,
        string username,
        string password,
        string pathMappings)
        => new()
        {
            QbittorrentUrl = url,
            QbittorrentUsername = username,
            QbittorrentPassword = password,
            QbittorrentPathMappings = pathMappings,
        };
}
