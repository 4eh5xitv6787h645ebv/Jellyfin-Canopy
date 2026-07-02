using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Xunit;

namespace Jellyfin.Plugin.JellyfinEnhanced.Tests.Configuration;

/// <summary>
/// Covers the corruption-aware Sonarr/Radarr instance deserialization and the
/// legacy single-instance migration fallback in <see cref="PluginConfiguration"/>.
/// These semantics guard real user config files: corrupt JSON must never be
/// silently replaced, and legacy URL/API-key fields must keep working.
/// </summary>
public class PluginConfigurationArrInstancesTests
{
    private static PluginConfiguration NewConfig() => new();

    [Fact]
    public void GetSonarrInstances_ValidJson_ReturnsParsedInstances()
    {
        var config = NewConfig();
        config.SonarrInstances = """[{"Name":"TV","Url":"http://sonarr:8989","ApiKey":"abc123"}]""";

        var instances = config.GetSonarrInstances();

        Assert.Single(instances);
        Assert.Equal("TV", instances[0].Name);
        Assert.Equal("http://sonarr:8989", instances[0].Url);
        Assert.True(instances[0].Enabled); // Enabled defaults true for pre-Enabled configs
        Assert.False(config.IsSonarrInstancesCorrupt());
    }

    [Fact]
    public void GetSonarrInstances_EmptyJson_FallsBackToLegacyFields()
    {
        var config = NewConfig();
        config.SonarrInstances = string.Empty;
        config.SonarrUrl = "http://legacy:8989";
        config.SonarrApiKey = "legacykey";

        var instances = config.GetSonarrInstances();

        Assert.Single(instances);
        Assert.Equal("Sonarr", instances[0].Name);
        Assert.Equal("http://legacy:8989", instances[0].Url);
        Assert.Equal("legacykey", instances[0].ApiKey);
    }

    [Fact]
    public void GetSonarrInstances_CorruptJson_ReturnsEmptyAndDoesNotSynthesizeLegacyInstance()
    {
        var config = NewConfig();
        config.SonarrInstances = "[{not json";
        config.SonarrUrl = "http://legacy:8989";
        config.SonarrApiKey = "legacykey";

        var instances = config.GetSonarrInstances();

        // Corrupt input must not fall back to legacy fields: the caller surfaces
        // corruption and refuses to overwrite the stored value on save.
        Assert.Empty(instances);
        Assert.True(config.IsSonarrInstancesCorrupt());
    }

    [Fact]
    public void GetSonarrInstances_EmptyArrayFollowedByJunk_IsCorruptNotEmpty()
    {
        var config = NewConfig();
        // Regression guard for the documented `[]junk` case: must be classified
        // by the real parser as corrupt, not short-circuited to "explicitly empty".
        config.SonarrInstances = "[]junk";
        config.SonarrUrl = "http://legacy:8989";
        config.SonarrApiKey = "legacykey";

        Assert.Empty(config.GetSonarrInstances());
        Assert.True(config.IsSonarrInstancesCorrupt());
    }

    [Fact]
    public void GetSonarrInstances_NullEntriesAndBlankRows_AreDroppedAndLegacyFallbackStillRuns()
    {
        var config = NewConfig();
        // `[null]` deserializes to a one-element list containing null; rows with
        // blank Url/ApiKey are also dropped. Everything dropped => explicitly empty
        // => the legacy fallback must still run.
        config.SonarrInstances = """[null, {"Name":"NoKey","Url":"http://x","ApiKey":""}]""";
        config.SonarrUrl = "http://legacy:8989";
        config.SonarrApiKey = "legacykey";

        var instances = config.GetSonarrInstances();

        Assert.Single(instances);
        Assert.Equal("Sonarr", instances[0].Name);
        Assert.False(config.IsSonarrInstancesCorrupt());
    }

    [Fact]
    public void GetSonarrInstances_EmptyJsonAndNoLegacyFields_ReturnsEmpty()
    {
        var config = NewConfig();
        config.SonarrInstances = string.Empty;
        config.SonarrUrl = string.Empty;
        config.SonarrApiKey = string.Empty;

        Assert.Empty(config.GetSonarrInstances());
        Assert.False(config.IsSonarrInstancesCorrupt());
    }

    [Fact]
    public void GetEnabledSonarrInstances_SkipsDisabledWithoutRemovingThem()
    {
        var config = NewConfig();
        config.SonarrInstances = """
            [
                {"Name":"On","Url":"http://a","ApiKey":"k1","Enabled":true},
                {"Name":"Off","Url":"http://b","ApiKey":"k2","Enabled":false}
            ]
            """;

        Assert.Equal(2, config.GetSonarrInstances().Count);
        var enabled = config.GetEnabledSonarrInstances();
        Assert.Single(enabled);
        Assert.Equal("On", enabled[0].Name);
    }

    [Fact]
    public void GetRadarrInstances_MirrorsSonarrSemantics()
    {
        var config = NewConfig();
        config.RadarrInstances = "not-json-at-all";
        config.RadarrUrl = "http://legacy:7878";
        config.RadarrApiKey = "legacykey";

        Assert.Empty(config.GetRadarrInstances());
        Assert.True(config.IsRadarrInstancesCorrupt());

        config.RadarrInstances = string.Empty;
        Assert.Single(config.GetRadarrInstances());
        Assert.Equal("Radarr", config.GetRadarrInstances()[0].Name);
        Assert.False(config.IsRadarrInstancesCorrupt());
    }
}
