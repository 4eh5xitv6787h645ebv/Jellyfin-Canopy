using System;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Configuration;

public sealed class PreferredAudioLanguageConfigurationTests
{
    [Theory]
    [InlineData(null, "")]
    [InlineData("", "")]
    [InlineData("  ", "")]
    [InlineData(" pt-br ", "pt-BR")]
    [InlineData("por-BR", "pt-BR")]
    [InlineData("ZH-hant-tw", "zh-Hant-TW")]
    public void UpdateConfigurationCoreCanonicalizesAdministratorDefault(string? input, string expected)
    {
        var config = new PluginConfiguration { PreferredAudioLanguage = input! };

        JellyfinCanopy.NormalizePreferredAudioLanguageForUpdate(config);

        Assert.Equal(expected, config.PreferredAudioLanguage);
    }

    [Theory]
    [InlineData("bad_tag")]
    [InlineData("und")]
    [InlineData("root")]
    public void UpdateConfigurationCoreRejectsMalformedAdministratorDefault(string input)
    {
        var config = new PluginConfiguration { PreferredAudioLanguage = input };

        Assert.Throws<ArgumentException>(() =>
            JellyfinCanopy.NormalizePreferredAudioLanguageForUpdate(config));
    }

    [Fact]
    public void UpdateConfigurationCoreRejectsOverlongAdministratorDefault()
    {
        var config = new PluginConfiguration { PreferredAudioLanguage = new string('a', 256) };

        Assert.Throws<ArgumentException>(() =>
            JellyfinCanopy.NormalizePreferredAudioLanguageForUpdate(config));
    }
}
