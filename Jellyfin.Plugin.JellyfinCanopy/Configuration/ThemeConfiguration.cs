using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinCanopy.Configuration
{
    /// <summary>
    /// Complete, revisioned Theme Studio state for one Jellyfin user. Theme
    /// documents contain typed data only; raw CSS belongs to a separate,
    /// explicitly gated feature and is never accepted by this model.
    /// </summary>
    public sealed class UserThemeConfiguration : IRevisionedUserConfiguration
    {
        public UserThemeConfiguration()
        {
            Profiles.Add(ThemeProfile.CreateDefault("canopy", "canopy-night"));
        }

        public long Revision { get; set; }

        public int SchemaVersion { get; set; } = ThemeConfigurationPolicy.CurrentSchemaVersion;

        public string ActiveProfileId { get; set; } = ThemeProfile.DefaultId;

        public List<ThemeProfile> Profiles { get; set; } = new List<ThemeProfile>();

        public string ScheduleTimeZone { get; set; } = "local";

        public List<ThemeScheduleEntry> Schedule { get; set; } = new List<ThemeScheduleEntry>();

        public ThemeLegacyMigration LegacyMigration { get; set; } = new ThemeLegacyMigration();

        [JsonExtensionData]
        public Dictionary<string, JsonElement> ExtensionData { get; set; }
            = new Dictionary<string, JsonElement>(StringComparer.Ordinal);

        public static UserThemeConfiguration CreateDefault(string preset, string palette)
            => new UserThemeConfiguration
            {
                Profiles = new List<ThemeProfile> { ThemeProfile.CreateDefault(preset, palette) }
            };
    }

    public sealed class ThemeProfile
    {
        public const string DefaultId = "default";

        private Dictionary<string, JsonElement> _tokens = new(StringComparer.Ordinal);

        public string Id { get; set; } = DefaultId;

        public string Name { get; set; } = "Default";

        public string BasePreset { get; set; } = "canopy";

        public int? PresetVersion { get; set; }

        public bool FreezePresetVersion { get; set; }

        public string Palette { get; set; } = "canopy-night";

        public string Accent { get; set; } = "violet";

        public string Mode { get; set; } = "system";

        public Dictionary<string, JsonElement> Tokens
        {
            get => _tokens;
            set => _tokens = value == null
                ? new Dictionary<string, JsonElement>(StringComparer.Ordinal)
                : new Dictionary<string, JsonElement>(value, StringComparer.Ordinal);
        }

        public ThemeResponsiveSettings Responsive { get; set; } = new ThemeResponsiveSettings();

        public ThemeAccessibilitySettings Accessibility { get; set; } = new ThemeAccessibilitySettings();

        [JsonExtensionData]
        public Dictionary<string, JsonElement> ExtensionData { get; set; }
            = new Dictionary<string, JsonElement>(StringComparer.Ordinal);

        public static ThemeProfile CreateDefault(string preset, string palette)
            => new ThemeProfile
            {
                BasePreset = preset,
                Palette = palette
            };
    }

    public sealed class ThemeResponsiveSettings
    {
        public ThemeBreakpointOverrides? Phone { get; set; }

        public ThemeBreakpointOverrides? Tablet { get; set; }

        public ThemeBreakpointOverrides? Desktop { get; set; }

        public ThemeBreakpointOverrides? Wide { get; set; }

        public ThemeBreakpointOverrides? Tv { get; set; }

        [JsonExtensionData]
        public Dictionary<string, JsonElement> ExtensionData { get; set; }
            = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
    }

    public sealed class ThemeBreakpointOverrides
    {
        private Dictionary<string, JsonElement> _tokens = new(StringComparer.Ordinal);

        public Dictionary<string, JsonElement> Tokens
        {
            get => _tokens;
            set => _tokens = value == null
                ? new Dictionary<string, JsonElement>(StringComparer.Ordinal)
                : new Dictionary<string, JsonElement>(value, StringComparer.Ordinal);
        }

        [JsonExtensionData]
        public Dictionary<string, JsonElement> ExtensionData { get; set; }
            = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
    }

    public sealed class ThemeAccessibilitySettings
    {
        public string Motion { get; set; } = "system";

        public string Contrast { get; set; } = "system";

        public string Transparency { get; set; } = "system";

        public string FocusEmphasis { get; set; } = "system";

        public bool UnderlineLinks { get; set; }

        [JsonExtensionData]
        public Dictionary<string, JsonElement> ExtensionData { get; set; }
            = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
    }

    public sealed class ThemeScheduleEntry
    {
        public string Id { get; set; } = string.Empty;

        public string ProfileId { get; set; } = string.Empty;

        public string Kind { get; set; } = "season";

        public string StartMonthDay { get; set; } = string.Empty;

        public string EndMonthDay { get; set; } = string.Empty;

        public int Priority { get; set; }

        public bool Enabled { get; set; } = true;

        [JsonExtensionData]
        public Dictionary<string, JsonElement> ExtensionData { get; set; }
            = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
    }

    public sealed class ThemeLegacyMigration
    {
        public string JellyfishTheme { get; set; } = string.Empty;

        public bool Completed { get; set; }

        [JsonExtensionData]
        public Dictionary<string, JsonElement> ExtensionData { get; set; }
            = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
    }

    /// <summary>
    /// Shareable Theme Studio document. Server/user identity, optimistic
    /// revision evidence, and migration diagnostics are deliberately absent.
    /// </summary>
    public sealed class ThemeExportDocument
    {
        public int SchemaVersion { get; set; } = ThemeConfigurationPolicy.CurrentSchemaVersion;

        public string ActiveProfileId { get; set; } = ThemeProfile.DefaultId;

        public List<ThemeProfile> Profiles { get; set; } = new List<ThemeProfile>();

        public string ScheduleTimeZone { get; set; } = "local";

        public List<ThemeScheduleEntry> Schedule { get; set; } = new List<ThemeScheduleEntry>();

        [JsonExtensionData]
        public Dictionary<string, JsonElement> ExtensionData { get; set; }
            = new Dictionary<string, JsonElement>(StringComparer.Ordinal);

        public static ThemeExportDocument FromConfiguration(UserThemeConfiguration source)
            => new ThemeExportDocument
            {
                SchemaVersion = source.SchemaVersion,
                ActiveProfileId = source.ActiveProfileId,
                Profiles = source.Profiles.Select(ThemeConfigurationClone.Profile).ToList(),
                ScheduleTimeZone = source.ScheduleTimeZone,
                Schedule = source.Schedule.Select(ThemeConfigurationClone.ScheduleEntry).ToList(),
                ExtensionData = ThemeConfigurationClone.ExtensionData(source.ExtensionData)
            };

        public UserThemeConfiguration? ToConfiguration()
        {
            if (!ThemeConfigurationClone.IsCloneable(this))
            {
                return null;
            }

            return new UserThemeConfiguration
            {
                Revision = 0,
                SchemaVersion = SchemaVersion,
                ActiveProfileId = ActiveProfileId,
                Profiles = Profiles.Select(ThemeConfigurationClone.Profile).ToList(),
                ScheduleTimeZone = ScheduleTimeZone,
                Schedule = Schedule.Select(ThemeConfigurationClone.ScheduleEntry).ToList(),
                LegacyMigration = new ThemeLegacyMigration(),
                ExtensionData = ThemeConfigurationClone.ExtensionData(ExtensionData)
            };
        }
    }

    internal static class ThemeConfigurationClone
    {
        public static bool IsCloneable(UserThemeConfiguration source)
            => source.Profiles != null
                && source.Schedule != null
                && source.LegacyMigration != null
                && source.ExtensionData != null
                && source.LegacyMigration.ExtensionData != null
                && source.Profiles.All(IsCloneable)
                && source.Schedule.All(IsCloneable);

        public static bool IsCloneable(ThemeExportDocument source)
            => source.Profiles != null
                && source.Schedule != null
                && source.ExtensionData != null
                && source.Profiles.All(IsCloneable)
                && source.Schedule.All(IsCloneable);

        public static UserThemeConfiguration Configuration(UserThemeConfiguration source)
            => new UserThemeConfiguration
            {
                Revision = source.Revision,
                SchemaVersion = source.SchemaVersion,
                ActiveProfileId = source.ActiveProfileId,
                Profiles = source.Profiles.Select(Profile).ToList(),
                ScheduleTimeZone = source.ScheduleTimeZone,
                Schedule = source.Schedule.Select(ScheduleEntry).ToList(),
                LegacyMigration = LegacyMigration(source.LegacyMigration),
                ExtensionData = ExtensionData(source.ExtensionData)
            };

        public static ThemeProfile Profile(ThemeProfile source)
            => new ThemeProfile
            {
                Id = source.Id,
                Name = source.Name,
                BasePreset = source.BasePreset,
                PresetVersion = source.PresetVersion,
                FreezePresetVersion = source.FreezePresetVersion,
                Palette = source.Palette,
                Accent = source.Accent,
                Mode = source.Mode,
                Tokens = ExtensionData(source.Tokens),
                Responsive = Responsive(source.Responsive),
                Accessibility = Accessibility(source.Accessibility),
                ExtensionData = ExtensionData(source.ExtensionData)
            };

        public static ThemeScheduleEntry ScheduleEntry(ThemeScheduleEntry source)
            => new ThemeScheduleEntry
            {
                Id = source.Id,
                ProfileId = source.ProfileId,
                Kind = source.Kind,
                StartMonthDay = source.StartMonthDay,
                EndMonthDay = source.EndMonthDay,
                Priority = source.Priority,
                Enabled = source.Enabled,
                ExtensionData = ExtensionData(source.ExtensionData)
            };

        public static Dictionary<string, JsonElement> ExtensionData(Dictionary<string, JsonElement> source)
            => source.ToDictionary(
                pair => pair.Key,
                pair => pair.Value.Clone(),
                StringComparer.Ordinal);

        private static bool IsCloneable(ThemeProfile? profile)
            => profile != null
                && profile.Tokens != null
                && profile.Responsive != null
                && profile.Accessibility != null
                && profile.ExtensionData != null
                && profile.Responsive.ExtensionData != null
                && profile.Accessibility.ExtensionData != null
                && IsCloneable(profile.Responsive.Phone)
                && IsCloneable(profile.Responsive.Tablet)
                && IsCloneable(profile.Responsive.Desktop)
                && IsCloneable(profile.Responsive.Wide)
                && IsCloneable(profile.Responsive.Tv);

        private static bool IsCloneable(ThemeScheduleEntry? entry)
            => entry != null && entry.ExtensionData != null;

        private static bool IsCloneable(ThemeBreakpointOverrides? breakpoint)
            => breakpoint == null
                || (breakpoint.Tokens != null && breakpoint.ExtensionData != null);

        private static ThemeResponsiveSettings Responsive(ThemeResponsiveSettings source)
            => new ThemeResponsiveSettings
            {
                Phone = Breakpoint(source.Phone),
                Tablet = Breakpoint(source.Tablet),
                Desktop = Breakpoint(source.Desktop),
                Wide = Breakpoint(source.Wide),
                Tv = Breakpoint(source.Tv),
                ExtensionData = ExtensionData(source.ExtensionData)
            };

        private static ThemeBreakpointOverrides? Breakpoint(ThemeBreakpointOverrides? source)
            => source == null
                ? null
                : new ThemeBreakpointOverrides
                {
                    Tokens = ExtensionData(source.Tokens),
                    ExtensionData = ExtensionData(source.ExtensionData)
                };

        private static ThemeAccessibilitySettings Accessibility(ThemeAccessibilitySettings source)
            => new ThemeAccessibilitySettings
            {
                Motion = source.Motion,
                Contrast = source.Contrast,
                Transparency = source.Transparency,
                FocusEmphasis = source.FocusEmphasis,
                UnderlineLinks = source.UnderlineLinks,
                ExtensionData = ExtensionData(source.ExtensionData)
            };

        private static ThemeLegacyMigration LegacyMigration(ThemeLegacyMigration source)
            => new ThemeLegacyMigration
            {
                JellyfishTheme = source.JellyfishTheme,
                Completed = source.Completed,
                ExtensionData = ExtensionData(source.ExtensionData)
            };
    }
}
