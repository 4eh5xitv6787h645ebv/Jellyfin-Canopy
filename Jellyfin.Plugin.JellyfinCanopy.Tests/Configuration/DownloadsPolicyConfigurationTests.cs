using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Configuration;

public sealed class DownloadsPolicyConfigurationTests
{
    private static readonly string[] PolicyKeys =
    {
        nameof(PluginConfiguration.DownloadsAllowActiveForRegularUsers),
        nameof(PluginConfiguration.DownloadsAllowProcessingForRegularUsers),
        nameof(PluginConfiguration.DownloadsAllowWarningsForRegularUsers),
        nameof(PluginConfiguration.DownloadsAllowHistoryForRegularUsers),
        nameof(PluginConfiguration.DownloadsAllowProvenanceForRegularUsers),
        nameof(PluginConfiguration.DownloadsDetailedLifecycleForRegularUsers),
        nameof(PluginConfiguration.RequestsAllowSeerrStatusAndHistoryForRegularUsers),
        nameof(PluginConfiguration.DownloadsHistoryWindowDays),
    };

    [Fact]
    public void Defaults_AreConservativeAndHistoryWindowIsBounded()
    {
        var config = new PluginConfiguration();

        Assert.True(config.DownloadsAllowActiveForRegularUsers);
        Assert.True(config.DownloadsAllowProcessingForRegularUsers);
        Assert.False(config.DownloadsAllowWarningsForRegularUsers);
        Assert.False(config.DownloadsAllowHistoryForRegularUsers);
        Assert.False(config.DownloadsAllowProvenanceForRegularUsers);
        Assert.False(config.DownloadsDetailedLifecycleForRegularUsers);
        Assert.True(config.RequestsAllowSeerrStatusAndHistoryForRegularUsers);
        Assert.Equal(7, config.DownloadsHistoryWindowDays);

        config.DownloadsHistoryWindowDays = 0;
        Assert.Equal(1, config.DownloadsHistoryWindowDays);
        config.DownloadsHistoryWindowDays = 99;
        Assert.Equal(30, config.DownloadsHistoryWindowDays);
    }

    [Fact]
    public void PolicyValues_ArePublicConfigOnlyAfterAuthentication()
    {
        var config = new PluginConfiguration
        {
            DownloadsAllowActiveForRegularUsers = true,
            DownloadsAllowProcessingForRegularUsers = true,
            DownloadsAllowWarningsForRegularUsers = true,
            DownloadsAllowHistoryForRegularUsers = true,
            DownloadsAllowProvenanceForRegularUsers = true,
            DownloadsDetailedLifecycleForRegularUsers = true,
            RequestsAllowSeerrStatusAndHistoryForRegularUsers = true,
            DownloadsHistoryWindowDays = 23,
        };
        var authenticated = SettingDescriptors.BuildPayload(
            SettingExposure.Public,
            new SettingContext(config, IsAuthenticated: true));
        var anonymous = SettingDescriptors.BuildPayload(
            SettingExposure.Public,
            new SettingContext(config, IsAuthenticated: false));

        foreach (var key in PolicyKeys[..^1])
        {
            Assert.Equal(true, authenticated[key]);
            Assert.Equal(false, anonymous[key]);
        }

        Assert.Equal(23, authenticated[nameof(PluginConfiguration.DownloadsHistoryWindowDays)]);
        Assert.Equal(0, anonymous[nameof(PluginConfiguration.DownloadsHistoryWindowDays)]);
        Assert.All(
            PolicyKeys,
            key => Assert.DoesNotContain(
                key,
                SettingDescriptors.BuildPayload(
                    SettingExposure.Private,
                    new SettingContext(config, IsAuthenticated: true)).Keys));
    }
}
