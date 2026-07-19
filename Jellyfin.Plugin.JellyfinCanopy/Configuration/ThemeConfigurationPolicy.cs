using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.Json;

namespace Jellyfin.Plugin.JellyfinCanopy.Configuration
{
    internal static class ThemeConfigurationPolicy
    {
        public const int CurrentSchemaVersion = 2;
        public const int MaximumPersistedBytes = 128 * 1024;
        public const int MaximumProfiles = 24;
        public const int MaximumScheduleEntries = 32;
        public const int MaximumProfileNameRunes = 80;
        public const int MaximumTokenOverridesPerScope = 128;

        private static readonly HashSet<string> Modes = new(StringComparer.Ordinal)
        {
            "system", "dark", "light"
        };

        private static readonly HashSet<string> BasePresets = new(StringComparer.Ordinal)
        {
            "canopy", "minimal", "cinematic", "glass", "material", "studio",
            "tv-focus", "oled", "high-contrast"
        };

        private static readonly HashSet<string> Palettes = new(StringComparer.Ordinal)
        {
            "canopy-night", "neutral", "vivid", "catppuccin", "dracula",
            "spring", "summer", "autumn", "winter",
            "jellyfish-aurora", "jellyfish-banana", "jellyfish-coal",
            "jellyfish-coral", "jellyfish-forest", "jellyfish-grass",
            "jellyfish-jellyblue", "jellyfish-jellyflix", "jellyfish-jellypurple",
            "jellyfish-lavender", "jellyfish-midnight", "jellyfish-mint",
            "jellyfish-ocean", "jellyfish-peach", "jellyfish-watermelon"
        };

        private static readonly HashSet<string> Accents = new(StringComparer.Ordinal)
        {
            "palette", "violet", "blue", "cyan", "teal", "green",
            "amber", "orange", "red", "pink", "neutral"
        };

        private static readonly HashSet<string> SystemChoices = new(StringComparer.Ordinal)
        {
            "system", "on", "off"
        };

        private static readonly HashSet<string> FocusChoices = new(StringComparer.Ordinal)
        {
            "system", "standard", "strong"
        };

        private static readonly IReadOnlyDictionary<string, TokenRule> TokenRules = BuildTokenRules();

        public static bool Validate(UserThemeConfiguration? document)
        {
            if (document == null
                || document.Revision < 0
                || document.SchemaVersion != CurrentSchemaVersion
                || document.Profiles == null
                || document.Schedule == null
                || document.LegacyMigration == null
                || !HasNoUnknownFields(document.ExtensionData)
                || !HasNoUnknownFields(document.LegacyMigration.ExtensionData)
                || document.Profiles.Count is < 1 or > MaximumProfiles
                || document.Schedule.Count > MaximumScheduleEntries
                || !IsIdentifier(document.ActiveProfileId))
            {
                return false;
            }

            var profileIds = new HashSet<string>(StringComparer.Ordinal);
            foreach (var profile in document.Profiles)
            {
                if (!ValidateProfile(profile) || !profileIds.Add(profile.Id))
                {
                    return false;
                }
            }

            if (!profileIds.Contains(document.ActiveProfileId))
            {
                return false;
            }

            var scheduleIds = new HashSet<string>(StringComparer.Ordinal);
            foreach (var entry in document.Schedule)
            {
                if (!ValidateScheduleEntry(entry, profileIds) || !scheduleIds.Add(entry.Id))
                {
                    return false;
                }
            }

            return document.LegacyMigration.JellyfishTheme != null
                && (document.LegacyMigration.JellyfishTheme.Length == 0
                ? !document.LegacyMigration.Completed
                : document.LegacyMigration.Completed
                    && IsJellyfishTheme(document.LegacyMigration.JellyfishTheme));
        }

        public static bool IsJellyfishTheme(string? value)
            => ThemeConfigurationMigration.TryCanonicalizeJellyfishTheme(value, out _);

        public static bool IsPalette(string? value)
            => value != null && Palettes.Contains(value);

        public static bool IsAccent(string? value)
            => value != null && Accents.Contains(value);

        private static bool ValidateProfile(ThemeProfile? profile)
            => profile != null
                && IsIdentifier(profile.Id)
                && IsDisplayName(profile.Name)
                && BasePresets.Contains(profile.BasePreset)
                && IsPalette(profile.Palette)
                && IsAccent(profile.Accent)
                && Modes.Contains(profile.Mode)
                && (!profile.FreezePresetVersion || profile.PresetVersion is > 0)
                && (profile.PresetVersion == null || profile.PresetVersion is > 0 and <= 10_000)
                && HasNoUnknownFields(profile.ExtensionData)
                && ValidateTokenMap(profile.Tokens)
                && ValidateResponsive(profile.Responsive)
                && ValidateAccessibility(profile.Accessibility);

        private static bool ValidateResponsive(ThemeResponsiveSettings? responsive)
            => responsive != null
                && HasNoUnknownFields(responsive.ExtensionData)
                && ValidateBreakpoint(responsive.Phone)
                && ValidateBreakpoint(responsive.Tablet)
                && ValidateBreakpoint(responsive.Desktop)
                && ValidateBreakpoint(responsive.Wide)
                && ValidateBreakpoint(responsive.Tv);

        private static bool ValidateBreakpoint(ThemeBreakpointOverrides? breakpoint)
            => breakpoint == null
                || (HasNoUnknownFields(breakpoint.ExtensionData)
                    && ValidateTokenMap(breakpoint.Tokens));

        private static bool ValidateAccessibility(ThemeAccessibilitySettings? settings)
            => settings != null
                && HasNoUnknownFields(settings.ExtensionData)
                && SystemChoices.Contains(settings.Motion)
                && SystemChoices.Contains(settings.Contrast)
                && SystemChoices.Contains(settings.Transparency)
                && FocusChoices.Contains(settings.FocusEmphasis);

        private static bool ValidateScheduleEntry(ThemeScheduleEntry? entry, HashSet<string> profileIds)
            => entry != null
                && HasNoUnknownFields(entry.ExtensionData)
                && IsIdentifier(entry.Id)
                && profileIds.Contains(entry.ProfileId)
                && IsMonthDay(entry.StartMonthDay)
                && IsMonthDay(entry.EndMonthDay)
                && entry.Priority is >= 0 and <= 100;

        private static bool HasNoUnknownFields(Dictionary<string, JsonElement>? extensionData)
            => extensionData != null && extensionData.Count == 0;

        private static bool ValidateTokenMap(Dictionary<string, JsonElement>? tokens)
        {
            if (tokens == null || tokens.Count > MaximumTokenOverridesPerScope)
            {
                return false;
            }

            foreach (var pair in tokens)
            {
                if (!TokenRules.TryGetValue(pair.Key, out var rule) || !rule.Validate(pair.Value))
                {
                    return false;
                }
            }

            return true;
        }

        private static bool IsDisplayName(string? value)
            => value != null
                && value.Length > 0
                && string.Equals(value, value.Trim(), StringComparison.Ordinal)
                && value.EnumerateRunes().Count() <= MaximumProfileNameRunes
                && !value.Any(char.IsControl);

        private static bool IsIdentifier(string? value)
        {
            if (string.IsNullOrEmpty(value) || value.Length > 64 || value[0] is < 'a' or > 'z')
            {
                return false;
            }

            foreach (var c in value)
            {
                if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-'))
                {
                    return false;
                }
            }

            return true;
        }

        private static bool IsMonthDay(string value)
            => DateTime.TryParseExact(
                "2000-" + value,
                "yyyy-MM-dd",
                CultureInfo.InvariantCulture,
                DateTimeStyles.None,
                out _);

        private static IReadOnlyDictionary<string, TokenRule> BuildTokenRules()
        {
            var rules = new Dictionary<string, TokenRule>(StringComparer.Ordinal);

            Add(rules, TokenRule.Color(),
                "color.canvas", "color.surface", "color.elevated", "color.overlay",
                "color.text", "color.text-muted", "color.primary", "color.on-primary",
                "color.secondary", "color.positive", "color.caution", "color.negative",
                "color.info", "color.divider", "color.focus");
            Add(rules, TokenRule.Choice("system", "inter", "serif", "rounded", "monospace"),
                "type.family-ui", "type.family-display", "type.family-reading");
            Add(rules, TokenRule.Number(0.75, 1.5), "type.scale");
            Add(rules, TokenRule.Number(1, 2), "type.line-height");
            Add(rules, TokenRule.Number(-0.05, 0.2), "type.tracking");
            Add(rules, TokenRule.Number(30, 100), "type.max-reading-width");
            Add(rules, TokenRule.Choice("square", "subtle", "rounded", "pill"),
                "shape.radius-scale", "shape.card-radius", "shape.control-radius", "shape.dialog-radius");
            Add(rules, TokenRule.Choice("circle", "rounded", "square"), "shape.avatar-shape");
            Add(rules, TokenRule.Number(0, 4), "shape.border-width");
            Add(rules, TokenRule.Number(0, 1), "elevation.glow-intensity");
            Add(rules, TokenRule.Choice("none", "soft", "medium", "strong"),
                "elevation.surface-shadow", "elevation.card-shadow", "elevation.dialog-shadow", "elevation.focus-ring");
            Add(rules, TokenRule.Choice("compact", "cozy", "spacious"), "space.scale", "layout.density");
            Add(rules, TokenRule.Number(0.5, 3), "space.page-gutter", "space.section-gap", "space.card-gap", "space.control-gap");
            Add(rules, TokenRule.Choice("auto", "header", "sidebar", "pills", "bottom"), "layout.navigation");
            Add(rules, TokenRule.Choice("off", "compact", "cinematic"), "layout.home-hero");
            Add(rules, TokenRule.Choice("classic", "compact", "cinematic"), "layout.details");
            Add(rules, TokenRule.Choice("list", "grid", "auto"), "layout.seasons");
            Add(rules, TokenRule.Choice("hover", "always", "menu"), "layout.card-actions");
            Add(rules, TokenRule.Choice("poster", "backdrop", "square", "auto"), "layout.poster-ratio");
            Add(rules, TokenRule.Choice("circle", "rounded", "square"), "layout.cast-shape");
            Add(rules, TokenRule.Choice("full", "balanced", "minimal"), "effects.level");
            Add(rules, TokenRule.Choice("solid", "translucent", "glass"), "effects.material");
            Add(rules, TokenRule.Number(0, 48), "effects.blur");
            Add(rules, TokenRule.Number(0, 2), "effects.saturation");
            Add(rules, TokenRule.Number(0, 1), "effects.backdrop-opacity", "effects.glow");
            Add(rules, TokenRule.Choice("none", "dim", "gradient", "blur"), "effects.image-treatment");
            Add(rules, TokenRule.Choice("off", "calm", "expressive", "system"), "motion.profile");
            Add(rules, TokenRule.Number(0, 2), "motion.duration-scale");
            Add(rules, TokenRule.Choice("standard", "smooth", "spring"), "motion.easing");
            Add(rules, TokenRule.Number(0, 12), "motion.hover-lift");
            Add(rules, TokenRule.Boolean(), "motion.page-transition", "motion.stagger");
            Add(rules, TokenRule.Choice("overlay", "bottom", "floating"), "progress.position");
            Add(rules, TokenRule.Number(1, 12), "progress.thickness");
            Add(rules, TokenRule.Choice("corner", "floating", "check", "none"),
                "progress.watched-indicator", "progress.unwatched-indicator");
            Add(rules, TokenRule.Choice("compact", "standard", "cinematic"), "player.osd-density");
            Add(rules, TokenRule.Choice("solid", "translucent", "glass"),
                "player.control-material", "player.pause-screen-material");
            Add(rules, TokenRule.Choice("none", "shadow", "solid", "box"), "player.subtitle-backdrop");
            Add(rules, TokenRule.Choice("rounded", "square", "pill"), "player.trickplay-shape");
            Add(rules, TokenRule.Choice("material", "lucide", "system"), "icon.family");
            Add(rules, TokenRule.Choice("light", "regular", "bold"), "icon.weight");
            Add(rules, TokenRule.Number(0.75, 1.5), "icon.size-scale");
            Add(rules, TokenRule.Boolean(), "icon.multicolor-metadata", "accessibility.underline-links");
            Add(rules, TokenRule.Choice("system", "on", "off"),
                "accessibility.contrast", "accessibility.motion", "accessibility.transparency");
            Add(rules, TokenRule.Choice("system", "standard", "strong"), "accessibility.focus-emphasis");
            Add(rules, TokenRule.Number(0.75, 2), "accessibility.text-scale");

            return rules;
        }

        private static void Add(Dictionary<string, TokenRule> target, TokenRule rule, params string[] names)
        {
            foreach (var name in names)
            {
                target.Add(name, rule);
            }
        }

        private sealed class TokenRule
        {
            private readonly Func<JsonElement, bool> _validate;

            private TokenRule(Func<JsonElement, bool> validate)
            {
                _validate = validate;
            }

            public bool Validate(JsonElement value) => _validate(value);

            public static TokenRule Boolean()
                => new(value => value.ValueKind is JsonValueKind.True or JsonValueKind.False);

            public static TokenRule Number(double minimum, double maximum)
                => new(value => value.ValueKind == JsonValueKind.Number
                    && value.TryGetDouble(out var number)
                    && double.IsFinite(number)
                    && number >= minimum
                    && number <= maximum);

            public static TokenRule Choice(params string[] choices)
            {
                var allowed = new HashSet<string>(choices, StringComparer.Ordinal);
                return new TokenRule(value => value.ValueKind == JsonValueKind.String
                    && value.GetString() is string text
                    && allowed.Contains(text));
            }

            public static TokenRule Color()
                => new(value => value.ValueKind == JsonValueKind.String
                    && value.GetString() is string text
                    && IsHexColor(text));

            private static bool IsHexColor(string value)
            {
                if (value.Length is not (7 or 9) || value[0] != '#')
                {
                    return false;
                }

                for (var index = 1; index < value.Length; index++)
                {
                    var c = value[index];
                    if (!((c >= '0' && c <= '9')
                        || (c >= 'a' && c <= 'f')
                        || (c >= 'A' && c <= 'F')))
                    {
                        return false;
                    }
                }

                return true;
            }
        }
    }
}
