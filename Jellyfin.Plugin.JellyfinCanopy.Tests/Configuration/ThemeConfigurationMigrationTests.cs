using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Configuration;

public sealed class ThemeConfigurationMigrationTests
{
    [Fact]
    public void CurrentSchemaMigrationIsPureAndDeepCloned()
    {
        var source = UserThemeConfiguration.CreateDefault("glass", "canopy-night");
        source.Revision = 7;
        source.Profiles[0].Responsive.Phone = new ThemeBreakpointOverrides();
        source.Profiles[0].Responsive.Phone!.Tokens["layout.navigation"] = JsonValue("bottom");

        Assert.True(ThemeConfigurationMigration.TryMigrate(source, out var migrated));
        Assert.NotNull(migrated);
        Assert.NotSame(source, migrated);
        Assert.NotSame(source.Profiles, migrated!.Profiles);
        Assert.NotSame(source.Profiles[0], migrated.Profiles[0]);
        Assert.NotSame(source.Profiles[0].Responsive, migrated.Profiles[0].Responsive);
        Assert.NotSame(source.Profiles[0].Responsive.Phone, migrated.Profiles[0].Responsive.Phone);
        Assert.Equal(7, migrated.Revision);

        migrated.Profiles[0].BasePreset = "minimal";
        migrated.Profiles[0].Responsive.Phone!.Tokens["layout.navigation"] = JsonValue("sidebar");
        Assert.Equal("glass", source.Profiles[0].BasePreset);
        Assert.Equal("bottom", source.Profiles[0].Responsive.Phone!.Tokens["layout.navigation"].GetString());
    }

    [Fact]
    public void SchemaZeroMigrationRunsInOrderAndAdoptsJellyfishSelection()
    {
        var source = UserThemeConfiguration.CreateDefault("canopy", "canopy-night");
        source.SchemaVersion = 0;
        source.LegacyMigration.JellyfishTheme = "oCeAn";

        Assert.True(ThemeConfigurationMigration.TryMigrate(source, out var migrated));
        Assert.NotNull(migrated);
        Assert.Equal(ThemeConfigurationPolicy.CurrentSchemaVersion, migrated!.SchemaVersion);
        Assert.Equal("Ocean", migrated.LegacyMigration.JellyfishTheme);
        Assert.True(migrated.LegacyMigration.Completed);
        Assert.Equal("jellyfish-ocean", migrated.Profiles[0].Palette);
        Assert.Equal("palette", migrated.Profiles[0].Accent);
        Assert.Equal(0, source.SchemaVersion);
        Assert.False(source.LegacyMigration.Completed);
        Assert.Equal("canopy-night", source.Profiles[0].Palette);
    }

    [Fact]
    public void SchemaOneMigrationNormalizesFormerlyOpenPaletteAndAccentIdentifiers()
    {
        var source = UserThemeConfiguration.CreateDefault("canopy", "remote-gallery-theme");
        source.SchemaVersion = 1;
        source.Profiles[0].Accent = "custom-accent";

        Assert.True(ThemeConfigurationMigration.TryMigrate(source, out var migrated));
        Assert.NotNull(migrated);
        Assert.Equal(ThemeConfigurationPolicy.CurrentSchemaVersion, migrated!.SchemaVersion);
        Assert.Equal("canopy-night", migrated.Profiles[0].Palette);
        Assert.Equal("palette", migrated.Profiles[0].Accent);
        Assert.True(PersistedPayloadPolicy.Validate(migrated).IsValid);
        Assert.Equal("remote-gallery-theme", source.Profiles[0].Palette);
        Assert.Equal("custom-accent", source.Profiles[0].Accent);

        var curated = UserThemeConfiguration.CreateDefault("glass", "catppuccin");
        curated.SchemaVersion = 1;
        curated.Profiles[0].Accent = "pink";
        Assert.True(ThemeConfigurationMigration.TryMigrate(curated, out var preserved));
        Assert.Equal("catppuccin", preserved!.Profiles[0].Palette);
        Assert.Equal("pink", preserved.Profiles[0].Accent);
    }

    [Fact]
    public void SchemaOneMigrationRestoresGeneratedJellyfishAccentWithoutLegacyMetadata()
    {
        var source = UserThemeConfiguration.CreateDefault("canopy", "jellyfish-ocean");
        source.SchemaVersion = 1;
        source.Profiles[0].Accent = "violet";
        source.Profiles.Add(ThemeProfile.CreateDefault("glass", "jellyfish-mint"));
        source.Profiles[1].Id = "scheduled";
        source.Profiles[1].Name = "Scheduled";
        source.Profiles[1].Accent = "violet";
        source.ActiveProfileId = "scheduled";

        Assert.True(ThemeConfigurationMigration.TryMigrate(source, out var migrated));
        Assert.NotNull(migrated);
        Assert.Equal("jellyfish-ocean", migrated!.Profiles[0].Palette);
        Assert.Equal("palette", migrated.Profiles[0].Accent);
        Assert.Equal("jellyfish-mint", migrated.Profiles[1].Palette);
        Assert.Equal("palette", migrated.Profiles[1].Accent);
        Assert.Equal("scheduled", migrated.ActiveProfileId);
        Assert.Equal("violet", source.Profiles[0].Accent);
        Assert.Equal("violet", source.Profiles[1].Accent);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(3)]
    [InlineData(int.MaxValue)]
    public void UnsupportedSchemaVersionsAreRejected(int version)
    {
        var source = UserThemeConfiguration.CreateDefault("canopy", "canopy-night");
        source.SchemaVersion = version;
        Assert.False(ThemeConfigurationMigration.TryMigrate(source, out var migrated));
        Assert.Null(migrated);
    }

    [Fact]
    public void JellyfishMigrationAcceptsNamesOnlyAndReturnsAStagedValidDocument()
    {
        Assert.True(ThemeConfigurationMigration.TryStageJellyfishSelection(
            new ThemeLegacyJellyfishSelection { Theme = "jElLyBlUe" },
            out var migrated));
        Assert.NotNull(migrated);
        Assert.True(PersistedPayloadPolicy.Validate(migrated).IsValid);
        Assert.Equal("Jellyblue", migrated!.LegacyMigration.JellyfishTheme);
        Assert.Equal("jellyfish-jellyblue", migrated.Profiles[0].Palette);
        Assert.Equal("palette", migrated.Profiles[0].Accent);
        Assert.True(migrated.LegacyMigration.Completed);

        Assert.False(ThemeConfigurationMigration.TryStageJellyfishSelection(
            new ThemeLegacyJellyfishSelection { Theme = "https://example.invalid/ocean.css" },
            out _));
        Assert.False(ThemeConfigurationMigration.TryStageJellyfishSelection(
            new ThemeLegacyJellyfishSelection { Theme = "@import url(ocean.css)" },
            out _));
    }

    [Theory]
    [InlineData("Aurora")]
    [InlineData("Banana")]
    [InlineData("Coal")]
    [InlineData("Coral")]
    [InlineData("Forest")]
    [InlineData("Grass")]
    [InlineData("Jellyblue")]
    [InlineData("Jellyflix")]
    [InlineData("Jellypurple")]
    [InlineData("Lavender")]
    [InlineData("Midnight")]
    [InlineData("Mint")]
    [InlineData("Ocean")]
    [InlineData("Peach")]
    [InlineData("Watermelon")]
    public void EveryExistingJellyfishSelectorThemeHasAMigration(string theme)
    {
        Assert.True(ThemeConfigurationMigration.TryStageJellyfishSelection(
            new ThemeLegacyJellyfishSelection { Theme = theme },
            out var migrated));
        Assert.NotNull(migrated);
        Assert.Equal(theme, migrated!.LegacyMigration.JellyfishTheme);
        Assert.Equal("palette", migrated.Profiles[0].Accent);
        Assert.True(PersistedPayloadPolicy.Validate(migrated).IsValid);
    }

    [Fact]
    public void ExportAndImportModelsDoNotAliasPersistedState()
    {
        var source = UserThemeConfiguration.CreateDefault("cinematic", "canopy-night");
        source.ScheduleTimeZone = "utc";
        source.Schedule.Add(new ThemeScheduleEntry
        {
            Id = "winter",
            ProfileId = "default",
            Kind = "holiday",
            StartMonthDay = "12-01",
            EndMonthDay = "02-29"
        });

        var export = ThemeExportDocument.FromConfiguration(source);
        export.Profiles[0].BasePreset = "minimal";
        export.Schedule[0].Enabled = false;
        Assert.Equal("cinematic", source.Profiles[0].BasePreset);
        Assert.Equal("utc", export.ScheduleTimeZone);
        Assert.Equal("holiday", export.Schedule[0].Kind);
        Assert.True(source.Schedule[0].Enabled);

        var imported = export.ToConfiguration();
        Assert.NotNull(imported);
        imported!.Profiles[0].BasePreset = "glass";
        imported.Schedule[0].Priority = 42;
        imported.Schedule[0].Kind = "season";
        Assert.Equal("minimal", export.Profiles[0].BasePreset);
        Assert.Equal(0, export.Schedule[0].Priority);
        Assert.Equal("holiday", export.Schedule[0].Kind);
    }

    private static JsonElement JsonValue<T>(T value)
    {
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(value));
        return document.RootElement.Clone();
    }
}
