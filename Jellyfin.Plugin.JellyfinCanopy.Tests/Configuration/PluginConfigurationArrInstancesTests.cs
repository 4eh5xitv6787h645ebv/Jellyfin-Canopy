using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Jellyfin.Plugin.JellyfinCanopy.Model.Arr;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Configuration;

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
        Assert.Matches("^[0-9a-f]{32}$", instances[0].InstanceId);
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
        Assert.Matches("^[0-9a-f]{32}$", instances[0].InstanceId);
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
    public void InvalidEnabledRows_AreReportedSeparatelyFromFilteredValidRows()
    {
        var config = NewConfig();
        config.RadarrInstances = """
            [
                {"Name":"Good","Url":"http://radarr:7878","ApiKey":"key","Enabled":true},
                {"Name":"Broken","Url":"","ApiKey":"missing-url","Enabled":true},
                {"Name":"Disabled broken","Url":"","ApiKey":"","Enabled":false}
            ]
            """;

        Assert.Single(config.GetEnabledRadarrInstances());
        Assert.True(config.HasInvalidEnabledRadarrInstances());
        Assert.False(config.IsRadarrInstancesCorrupt());
    }

    [Fact]
    public void InvalidDisabledRows_DoNotMakeAuthoritativeSourceSetIncomplete()
    {
        var config = NewConfig();
        config.SonarrInstances =
            """[{"Name":"Disabled broken","Url":"","ApiKey":"","Enabled":false}]""";

        Assert.False(config.HasInvalidEnabledSonarrInstances());
        Assert.False(config.IsSonarrInstancesCorrupt());
    }

    [Fact]
    public void AuthoritativeSnapshot_DoesNotReviveLegacySourceBehindStoredDisabledRows()
    {
        var config = NewConfig();
        config.RadarrInstances =
            """[{"Name":"Disabled broken","Url":"","ApiKey":"","Enabled":false}]""";
        config.RadarrUrl = "http://legacy:7878";
        config.RadarrApiKey = "legacy-key";

        // General config migration behavior remains backward-compatible, while a destructive
        // snapshot honors the explicit modern source set and sees no enabled sources.
        Assert.Single(config.GetEnabledRadarrInstances());
        Assert.Empty(config.GetEnabledRadarrInstancesForAuthoritativeSnapshot());
    }

    [Fact]
    public void TopLevelNullInstanceJson_IsCorruptAndCannotReviveLegacySource()
    {
        var config = NewConfig();
        config.SonarrInstances = "null";
        config.SonarrUrl = "http://legacy:8989";
        config.SonarrApiKey = "legacy-key";

        Assert.True(config.IsSonarrInstancesCorrupt());
        Assert.Empty(config.GetEnabledSonarrInstancesForAuthoritativeSnapshot());
        Assert.Empty(config.GetSonarrInstances());
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

    [Fact]
    public void LegacyInstanceIds_SurviveReorderAndRename()
    {
        var config = NewConfig();
        config.SonarrInstances = """
            [
              {"Name":"First","Url":"http://first:8989","ApiKey":"first-key","Enabled":true},
              {"Name":"Second","Url":"http://second:8989","ApiKey":"second-key","Enabled":true}
            ]
            """;
        var before = config.GetSonarrInstances()
            .ToDictionary(instance => instance.Url, instance => instance.InstanceId);

        config.SonarrInstances = """
            [
              {"Name":"Renamed second","Url":"http://second:8989","ApiKey":"second-key","Enabled":true},
              {"Name":"Renamed first","Url":"http://first:8989","ApiKey":"first-key","Enabled":true}
            ]
            """;
        var after = config.GetSonarrInstances()
            .ToDictionary(instance => instance.Url, instance => instance.InstanceId);

        Assert.Equal(before["http://first:8989"], after["http://first:8989"]);
        Assert.Equal(before["http://second:8989"], after["http://second:8989"]);
    }

    [Fact]
    public void PersistedInstanceId_IsPreservedAcrossConnectionAndDisplayEdits()
    {
        const string id = "0123456789abcdef0123456789abcdef";
        var config = NewConfig();
        config.RadarrInstances =
            $$"""[{"InstanceId":"{{id}}","Name":"Before","Url":"http://old:7878","ApiKey":"old-key"}]""";

        var before = Assert.Single(config.GetRadarrInstances());
        config.RadarrInstances =
            $$"""[{"InstanceId":"{{id}}","Name":"After","Url":"http://new:7878","ApiKey":"new-key"}]""";
        var after = Assert.Single(config.GetRadarrInstances());

        Assert.Equal(id, before.InstanceId);
        Assert.Equal(id, after.InstanceId);
    }

    [Fact]
    public void EnsurePersistedArrInstanceIds_FreezesLegacyFallbackBeforeFirstEditedSave()
    {
        var config = NewConfig();
        config.SonarrInstances = """
            [
              {"Name":"First","Url":"http://first:8989","ApiKey":"first-key","Enabled":true},
              {"Name":"Second","Url":"http://second:8989","ApiKey":"second-key","Enabled":true}
            ]
            """;
        var preEditIds = config.GetSonarrInstances()
            .ToDictionary(instance => instance.Name, instance => instance.InstanceId);

        Assert.True(config.EnsurePersistedArrInstanceIds());

        // This is the raw PluginConfiguration value returned by Jellyfin's admin endpoint.
        // The editor reorders, renames and changes both pieces of connection material while
        // round-tripping only the opaque server-provided identity.
        var projected = JsonSerializer.Deserialize<List<ArrInstance>>(config.SonarrInstances)!;
        projected.Reverse();
        projected[0].Name = "Renamed second";
        projected[0].Url = "https://second-new.example.test";
        projected[0].ApiKey = "second-key-rotated";
        projected[1].Name = "Renamed first";
        projected[1].Url = "https://first-new.example.test";
        projected[1].ApiKey = "first-key-rotated";

        // Prove the edited connection material would produce different legacy fallbacks if
        // startup had not supplied the pre-edit identities to the admin projection.
        Assert.NotEqual(
            preEditIds["Second"],
            ArrIdHelper.GetStableInstanceId(CloneWithoutIdentity(projected[0])));
        Assert.NotEqual(
            preEditIds["First"],
            ArrIdHelper.GetStableInstanceId(CloneWithoutIdentity(projected[1])));

        config.SonarrInstances = JsonSerializer.Serialize(projected);
        Assert.False(config.EnsurePersistedArrInstanceIds());
        var afterSave = config.GetSonarrInstances()
            .ToDictionary(instance => instance.Name, instance => instance.InstanceId);

        Assert.Equal(preEditIds["Second"], afterSave["Renamed second"]);
        Assert.Equal(preEditIds["First"], afterSave["Renamed first"]);
    }

    [Fact]
    public void EnsurePersistedArrInstanceIds_MaterializesLegacySingletonWithItsPreEditIdentity()
    {
        var config = NewConfig();
        config.RadarrInstances = "[]";
        config.RadarrUrl = "http://legacy-radarr:7878";
        config.RadarrExternalUrl = "https://radarr.example.test";
        config.RadarrApiKey = "legacy-key";
        config.RadarrUrlMappings = "http://jellyfin|http://legacy-radarr:7878";
        var expectedId = Assert.Single(config.GetRadarrInstances()).InstanceId;

        Assert.True(config.EnsurePersistedArrInstanceIds());
        var migratedJson = config.RadarrInstances;
        var migrated = Assert.Single(JsonSerializer.Deserialize<List<ArrInstance>>(migratedJson)!);

        Assert.Equal(expectedId, migrated.InstanceId);
        Assert.Equal(config.RadarrUrl, migrated.Url);
        Assert.Equal(config.RadarrApiKey, migrated.ApiKey);
        Assert.False(config.EnsurePersistedArrInstanceIds());
        Assert.Equal(migratedJson, config.RadarrInstances);
    }

    [Fact]
    public void EnsurePersistedArrInstanceIds_RepairsDuplicatesOnceAndPreservesTheRepair()
    {
        var config = NewConfig();
        config.RadarrInstances = """
            [
              {"Name":"One","Url":"http://same:7878","ApiKey":"same-key","Enabled":true},
              {"Name":"Two","Url":"http://same:7878","ApiKey":"same-key","Enabled":true}
            ]
            """;
        var reassigned = new List<string>();

        Assert.True(config.EnsurePersistedArrInstanceIds(
            onRadarrDuplicateReassigned: reassigned.Add));
        var migratedJson = config.RadarrInstances;
        var migrated = JsonSerializer.Deserialize<List<ArrInstance>>(migratedJson)!;

        Assert.Equal(new[] { "One", "Two" }, reassigned);
        Assert.Equal(2, migrated.Select(instance => instance.InstanceId).Distinct().Count());

        reassigned.Clear();
        Assert.False(config.EnsurePersistedArrInstanceIds(
            onRadarrDuplicateReassigned: reassigned.Add));
        Assert.Empty(reassigned);
        Assert.Equal(migratedJson, config.RadarrInstances);
    }

    [Fact]
    public void EnsurePersistedArrInstanceIds_LeavesCorruptModernJsonUntouched()
    {
        var config = NewConfig();
        config.SonarrInstances = "[{not-json";
        config.SonarrUrl = "http://legacy:8989";
        config.SonarrApiKey = "legacy-key";

        Assert.False(config.EnsurePersistedArrInstanceIds());
        Assert.Equal("[{not-json", config.SonarrInstances);
        Assert.True(config.IsSonarrInstancesCorrupt());
    }

    [Fact]
    public void AmbiguousDuplicateIdentity_IsRejectedInsteadOfPublished()
    {
        var config = NewConfig();
        config.SonarrInstances = """
            [
              {"Name":"Duplicate one","Url":"http://same:8989","ApiKey":"same-key","Enabled":true},
              {"Name":"Duplicate two","Url":"http://same:8989","ApiKey":"same-key","Enabled":true}
            ]
            """;

        Assert.Empty(config.GetSonarrInstances());
        Assert.Empty(config.GetEnabledSonarrInstances());
        Assert.True(config.HasInvalidEnabledSonarrInstances());
        Assert.False(config.IsSonarrInstancesCorrupt());
    }

    private static ArrInstance CloneWithoutIdentity(ArrInstance instance) => new()
    {
        Name = instance.Name,
        Url = instance.Url,
        ExternalUrl = instance.ExternalUrl,
        ApiKey = instance.ApiKey,
        UrlMappings = instance.UrlMappings,
        Enabled = instance.Enabled
    };
}
