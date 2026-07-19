using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinCanopy.Configuration
{
    /// <summary>
    /// Non-persisting request used to stage a migration from the existing
    /// Jellyfish selector. Only a canonical bundled theme name is accepted;
    /// CSS imports, URLs, and filenames are deliberately outside the contract.
    /// </summary>
    public sealed class ThemeLegacyJellyfishSelection
    {
        public string Theme { get; set; } = string.Empty;

        [JsonExtensionData]
        public Dictionary<string, JsonElement> ExtensionData { get; set; }
            = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
    }

    /// <summary>
    /// Pure, ordered Theme Studio schema migrations. Persistence and revision
    /// advancement remain caller-owned so validation can always occur before an
    /// atomic write.
    /// </summary>
    internal static class ThemeConfigurationMigration
    {
        public const int OldestSupportedSchemaVersion = 0;

        private static readonly IReadOnlyDictionary<string, string> JellyfishNames
            = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["Aurora"] = "Aurora",
                ["Banana"] = "Banana",
                ["Coal"] = "Coal",
                ["Coral"] = "Coral",
                ["Forest"] = "Forest",
                ["Grass"] = "Grass",
                ["Jellyblue"] = "Jellyblue",
                ["Jellyflix"] = "Jellyflix",
                ["Jellypurple"] = "Jellypurple",
                ["Lavender"] = "Lavender",
                ["Midnight"] = "Midnight",
                ["Mint"] = "Mint",
                ["Ocean"] = "Ocean",
                ["Peach"] = "Peach",
                ["Watermelon"] = "Watermelon"
            };

        public static bool TryMigrate(
            UserThemeConfiguration? source,
            out UserThemeConfiguration? migrated)
        {
            migrated = null;
            if (source == null
                || source.SchemaVersion < OldestSupportedSchemaVersion
                || source.SchemaVersion > ThemeConfigurationPolicy.CurrentSchemaVersion
                || !ThemeConfigurationClone.IsCloneable(source))
            {
                return false;
            }

            var current = ThemeConfigurationClone.Configuration(source);
            while (current.SchemaVersion < ThemeConfigurationPolicy.CurrentSchemaVersion)
            {
                current = current.SchemaVersion switch
                {
                    0 => MigrateV0ToV1(current),
                    1 => MigrateV1ToV2(current),
                    _ => throw new InvalidOperationException(
                        $"No Theme Studio migration is registered for schema {current.SchemaVersion}.")
                };
            }

            migrated = current;
            return true;
        }

        public static bool TryStageJellyfishSelection(
            ThemeLegacyJellyfishSelection? selection,
            out UserThemeConfiguration? migrated)
        {
            migrated = null;
            if (selection == null
                || selection.ExtensionData == null
                || selection.ExtensionData.Count != 0
                || !TryCanonicalizeJellyfishTheme(selection.Theme, out var canonical))
            {
                return false;
            }

            var result = UserThemeConfiguration.CreateDefault(
                "canopy",
                "jellyfish-" + canonical.ToLowerInvariant());
            result.Profiles[0].Accent = "palette";
            result.LegacyMigration = new ThemeLegacyMigration
            {
                JellyfishTheme = canonical,
                Completed = true
            };
            migrated = result;
            return true;
        }

        public static bool TryCanonicalizeJellyfishTheme(string? value, out string canonical)
        {
            if (JellyfishNames.TryGetValue(value ?? string.Empty, out var match))
            {
                canonical = match;
                return true;
            }

            canonical = string.Empty;
            return false;
        }

        private static UserThemeConfiguration MigrateV0ToV1(UserThemeConfiguration source)
        {
            var migrated = ThemeConfigurationClone.Configuration(source);
            migrated.SchemaVersion = 1;

            if (!string.IsNullOrEmpty(migrated.LegacyMigration.JellyfishTheme)
                && TryCanonicalizeJellyfishTheme(
                    migrated.LegacyMigration.JellyfishTheme,
                    out var canonical))
            {
                migrated.LegacyMigration.JellyfishTheme = canonical;
                migrated.LegacyMigration.Completed = true;
                if (migrated.Profiles.Count > 0)
                {
                    migrated.Profiles[0].Palette = "jellyfish-" + canonical.ToLowerInvariant();
                    migrated.Profiles[0].Accent = "palette";
                }
            }

            return migrated;
        }

        private static UserThemeConfiguration MigrateV1ToV2(UserThemeConfiguration source)
        {
            var migrated = ThemeConfigurationClone.Configuration(source);
            migrated.SchemaVersion = 2;
            var legacyJellyfishPalette = migrated.LegacyMigration.Completed
                && TryCanonicalizeJellyfishTheme(
                    migrated.LegacyMigration.JellyfishTheme,
                    out var canonical)
                    ? "jellyfish-" + canonical.ToLowerInvariant()
                    : null;

            for (var index = 0; index < migrated.Profiles.Count; index++)
            {
                var profile = migrated.Profiles[index];
                var hasGeneratedLegacyJellyfishAccent = index == 0
                    && legacyJellyfishPalette != null
                    && string.Equals(profile.Palette, legacyJellyfishPalette, StringComparison.Ordinal)
                    && string.Equals(profile.Accent, "violet", StringComparison.Ordinal);

                if (!ThemeConfigurationPolicy.IsPalette(profile.Palette))
                {
                    profile.Palette = "canopy-night";
                }

                if (hasGeneratedLegacyJellyfishAccent
                    || !ThemeConfigurationPolicy.IsAccent(profile.Accent))
                {
                    profile.Accent = "palette";
                }
            }

            return migrated;
        }

        public static string NormalizeAdministratorPalette(string? value)
            => ThemeConfigurationPolicy.IsPalette(value) ? value! : "canopy-night";
    }
}
