using System;
using System.Collections.Generic;
using System.Text.Json;

namespace Jellyfin.Plugin.JellyfinCanopy.Configuration
{
    internal enum PersistedPayloadStatus
    {
        Valid,
        Invalid,
        TooLarge
    }

    internal readonly record struct PersistedPayloadValidation(
        PersistedPayloadStatus Status,
        string Code,
        int SerializedBytes)
    {
        public bool IsValid => Status == PersistedPayloadStatus.Valid;

        public static PersistedPayloadValidation Valid(int serializedBytes)
            => new(PersistedPayloadStatus.Valid, string.Empty, serializedBytes);

        public static PersistedPayloadValidation Invalid(string code)
            => new(PersistedPayloadStatus.Invalid, code, 0);

        public static PersistedPayloadValidation TooLarge(int serializedBytes)
            => new(PersistedPayloadStatus.TooLarge, "payload_too_large", serializedBytes);
    }

    /// <summary>
    /// One policy primitive for every complete user-owned configuration payload.
    /// Request limits are enforced before model binding; these typed limits are
    /// the second line of defence before a lock, cache mutation, or disk write.
    /// </summary>
    internal static class PersistedPayloadPolicy
    {
        public const long StandardRequestBytes = 1024 * 1024;
        public const int StandardPersistedBytes = 1024 * 1024;
        public const long HiddenContentRequestBytes = 8L * 1024 * 1024;
        public const int HiddenContentPersistedBytes = 7 * 1024 * 1024;
        public const int AbsolutePersistedBytes = 8 * 1024 * 1024;

        public const int MaximumStandardStringLength = 512;
        public const int MaximumExtensionProperties = 1000;
        public const int MaximumExtensionPropertyNameLength = 256;
        public const int MaximumExtensionStringLength = 4096;
        public const int MaximumExtensionDepth = 16;
        public const int MaximumExtensionNodes = 20_000;
        public const int MaximumShortcuts = 1000;
        public const int MaximumElsewhereEntries = 500;
        public const int MaximumHiddenItems = 10_000;
        public const int MaximumHiddenKeyLength = 256;

        public static PersistedPayloadValidation Validate(IRevisionedUserConfiguration? payload)
            => payload switch
            {
                UserSettings settings => ValidateSettings(settings),
                UserShortcuts shortcuts => ValidateShortcuts(shortcuts),
                ElsewhereSettings elsewhere => ValidateElsewhere(elsewhere),
                UserThemeConfiguration theme => ValidateTheme(theme),
                UserThemeCssConfiguration themeCss => ValidateThemeCss(themeCss),
                null => PersistedPayloadValidation.Invalid("payload_required"),
                _ => PersistedPayloadValidation.Invalid("unsupported_payload")
            };

        public static PersistedPayloadValidation Validate(UserHiddenContent? payload)
        {
            if (payload?.Items == null || payload.Settings == null)
            {
                return PersistedPayloadValidation.Invalid("invalid_hidden_content_shape");
            }

            if (payload.Items.Count > MaximumHiddenItems)
            {
                return PersistedPayloadValidation.Invalid("too_many_hidden_items");
            }

            foreach (var pair in payload.Items)
            {
                if (!IsBoundedRequiredString(pair.Key, MaximumHiddenKeyLength)
                    || !IsValidHiddenItem(pair.Value))
                {
                    return PersistedPayloadValidation.Invalid("invalid_hidden_item");
                }
            }

            return ValidateSerializedSize(payload, HiddenContentPersistedBytes);
        }

        public static UserHiddenContent CloneValidated(UserHiddenContent payload)
        {
            var clone = new UserHiddenContent
            {
                Settings = new HiddenContentSettings
                {
                    Enabled = payload.Settings.Enabled,
                    FilterLibrary = payload.Settings.FilterLibrary,
                    FilterDiscovery = payload.Settings.FilterDiscovery,
                    FilterUpcoming = payload.Settings.FilterUpcoming,
                    FilterCalendar = payload.Settings.FilterCalendar,
                    FilterSearch = payload.Settings.FilterSearch,
                    FilterRecommendations = payload.Settings.FilterRecommendations,
                    FilterRequests = payload.Settings.FilterRequests,
                    FilterNextUp = payload.Settings.FilterNextUp,
                    FilterContinueWatching = payload.Settings.FilterContinueWatching,
                    ShowHideButtons = payload.Settings.ShowHideButtons,
                    ShowHideConfirmation = payload.Settings.ShowHideConfirmation,
                    ShowButtonSeerr = payload.Settings.ShowButtonSeerr,
                    ShowButtonLibrary = payload.Settings.ShowButtonLibrary,
                    ShowButtonDetails = payload.Settings.ShowButtonDetails,
                    ShowButtonCast = payload.Settings.ShowButtonCast,
                    ExperimentalHideCollections = payload.Settings.ExperimentalHideCollections
                },
                Items = new Dictionary<string, HiddenContentItem>(payload.Items.Count, StringComparer.Ordinal)
            };

            foreach (var pair in payload.Items)
            {
                var item = pair.Value;
                clone.Items.Add(pair.Key, new HiddenContentItem
                {
                    ItemId = item.ItemId ?? string.Empty,
                    Name = item.Name ?? string.Empty,
                    Type = item.Type ?? string.Empty,
                    TmdbId = item.TmdbId ?? string.Empty,
                    Identity = item.Identity == null ? null : new HiddenContentIdentity
                    {
                        Version = item.Identity.Version,
                        Provider = item.Identity.Provider ?? string.Empty,
                        MediaType = item.Identity.MediaType ?? string.Empty,
                        Id = item.Identity.Id ?? string.Empty
                    },
                    HiddenAt = item.HiddenAt ?? string.Empty,
                    PosterPath = item.PosterPath ?? string.Empty,
                    SeriesId = item.SeriesId ?? string.Empty,
                    SeriesName = item.SeriesName ?? string.Empty,
                    SeasonNumber = item.SeasonNumber,
                    EpisodeNumber = item.EpisodeNumber,
                    HideScope = item.HideScope ?? "global"
                });
            }

            return clone;
        }

        public static PersistedPayloadValidation ValidateSerializedSize(object payload, int maximumBytes)
        {
            try
            {
                var bytes = JsonSerializer.SerializeToUtf8Bytes(
                    payload,
                    payload.GetType(),
                    PersistedJson.WriteOptions).Length;
                return ValidateByteCount(bytes, maximumBytes);
            }
            catch (JsonException)
            {
                return PersistedPayloadValidation.Invalid("invalid_json_value");
            }
        }

        internal static PersistedPayloadValidation ValidateByteCount(int serializedBytes, int maximumBytes)
            => serializedBytes <= maximumBytes
                ? PersistedPayloadValidation.Valid(serializedBytes)
                : PersistedPayloadValidation.TooLarge(serializedBytes);

        private static PersistedPayloadValidation ValidateSettings(UserSettings settings)
        {
            if (settings.Revision < 0
                || settings.PauseScreenDelaySeconds is < 1 or > 60
                || settings.SelectedStylePresetIndex is < 0 or > 5
                || settings.SelectedFontSizePresetIndex is < 0 or > 5
                || settings.SelectedFontFamilyPresetIndex is < 0 or > 4
                || settings.SubtitleVerticalPosition is < 0 or > 100
                || settings.SubtitleHorizontalPosition is < 0 or > 100
                || !IsOptionalOrder(settings.ResolutionTagOrder)
                || !IsOptionalOrder(settings.SourceTagOrder)
                || !IsOptionalOrder(settings.DynamicRangeTagOrder)
                || !IsOptionalOrder(settings.SpecialFormatTagOrder)
                || !IsOptionalOrder(settings.VideoCodecTagOrder)
                || !IsOptionalOrder(settings.AudioInfoTagOrder)
                || !AreBoundedSettingsStrings(settings)
                || !HasValidExtensionData(settings.ExtensionData))
            {
                return PersistedPayloadValidation.Invalid("invalid_settings_payload");
            }

            return ValidateSerializedSize(settings, StandardPersistedBytes);
        }

        private static PersistedPayloadValidation ValidateShortcuts(UserShortcuts shortcuts)
        {
            if (shortcuts.Revision < 0
                || shortcuts.Shortcuts == null
                || shortcuts.Shortcuts.Count > MaximumShortcuts
                || !HasValidExtensionData(shortcuts.ExtensionData))
            {
                return PersistedPayloadValidation.Invalid("invalid_shortcuts_payload");
            }

            foreach (var shortcut in shortcuts.Shortcuts)
            {
                if (shortcut == null
                    || !IsBoundedString(shortcut.Name, MaximumStandardStringLength)
                    || !IsBoundedString(shortcut.Key, MaximumStandardStringLength)
                    || !IsBoundedString(shortcut.Label, MaximumStandardStringLength)
                    || !IsBoundedString(shortcut.Category, MaximumStandardStringLength))
                {
                    return PersistedPayloadValidation.Invalid("invalid_shortcuts_payload");
                }
            }

            return ValidateSerializedSize(shortcuts, StandardPersistedBytes);
        }

        private static PersistedPayloadValidation ValidateElsewhere(ElsewhereSettings elsewhere)
        {
            if (elsewhere.Revision < 0
                || elsewhere.Regions == null
                || elsewhere.Services == null
                || elsewhere.Regions.Count > MaximumElsewhereEntries
                || elsewhere.Services.Count > MaximumElsewhereEntries
                || !IsBoundedString(elsewhere.Region, MaximumStandardStringLength)
                || !HasValidExtensionData(elsewhere.ExtensionData))
            {
                return PersistedPayloadValidation.Invalid("invalid_elsewhere_payload");
            }

            foreach (var value in elsewhere.Regions)
            {
                if (!IsBoundedString(value, MaximumStandardStringLength))
                {
                    return PersistedPayloadValidation.Invalid("invalid_elsewhere_payload");
                }
            }

            foreach (var value in elsewhere.Services)
            {
                if (!IsBoundedString(value, MaximumStandardStringLength))
                {
                    return PersistedPayloadValidation.Invalid("invalid_elsewhere_payload");
                }
            }

            return ValidateSerializedSize(elsewhere, StandardPersistedBytes);
        }

        private static PersistedPayloadValidation ValidateTheme(UserThemeConfiguration theme)
        {
            if (!ThemeConfigurationPolicy.Validate(theme))
            {
                return PersistedPayloadValidation.Invalid("invalid_theme_payload");
            }

            return ValidateSerializedSize(theme, ThemeConfigurationPolicy.MaximumPersistedBytes);
        }

        private static PersistedPayloadValidation ValidateThemeCss(UserThemeCssConfiguration themeCss)
        {
            if (!ThemeAdvancedCssPolicy.Validate(themeCss))
            {
                return PersistedPayloadValidation.Invalid("invalid_theme_css_payload");
            }

            return ValidateSerializedSize(themeCss, ThemeAdvancedCssPolicy.MaximumPersistedBytes);
        }

        private static bool AreBoundedSettingsStrings(UserSettings settings)
            => IsBoundedString(settings.CustomSubtitleTextColor, MaximumStandardStringLength)
                && IsBoundedString(settings.CustomSubtitleBgColor, MaximumStandardStringLength)
                && IsBoundedString(settings.WatchProgressMode, MaximumStandardStringLength)
                && IsBoundedString(settings.WatchProgressTimeFormat, MaximumStandardStringLength)
                && IsBoundedString(settings.QualityTagsPosition, MaximumStandardStringLength)
                && IsBoundedString(settings.GenreTagsPosition, MaximumStandardStringLength)
                && IsBoundedString(settings.LanguageTagsPosition, MaximumStandardStringLength)
                && IsBoundedString(settings.RatingTagsPosition, MaximumStandardStringLength)
                && IsBoundedString(settings.LastOpenedTab, MaximumStandardStringLength)
                && IsBoundedString(settings.DisplayLanguage, MaximumStandardStringLength)
                && IsBoundedString(settings.CalendarDisplayMode, MaximumStandardStringLength)
                && IsBoundedString(settings.CalendarDefaultViewMode, MaximumStandardStringLength);

        private static bool IsValidHiddenItem(HiddenContentItem? item)
            => item != null
                && IsOptionalBoundedString(item.ItemId, 128)
                && IsOptionalBoundedString(item.Name, 512)
                && IsOptionalBoundedString(item.Type, 64)
                && IsOptionalBoundedString(item.TmdbId, 32)
                && IsValidHiddenIdentity(item.Identity)
                && (item.Identity == null || string.IsNullOrEmpty(item.TmdbId)
                    || string.Equals(item.Identity.Id, item.TmdbId, StringComparison.Ordinal))
                && IsOptionalBoundedString(item.HiddenAt, 64)
                && IsOptionalBoundedString(item.PosterPath, 512)
                && IsOptionalBoundedString(item.SeriesId, 128)
                && IsOptionalBoundedString(item.SeriesName, 512)
                && IsOptionalNonNegativeRange(item.SeasonNumber, 100_000)
                && IsOptionalNonNegativeRange(item.EpisodeNumber, 100_000)
                && item.HideScope is null or "" or "global" or "series" or "continuewatching" or "nextup" or "homesections";

        private static bool IsValidHiddenIdentity(HiddenContentIdentity? identity)
            => identity == null
                || (identity.Version == 1
                    && string.Equals(identity.Provider, "tmdb", StringComparison.Ordinal)
                    && (string.Equals(identity.MediaType, "movie", StringComparison.Ordinal)
                        || string.Equals(identity.MediaType, "tv", StringComparison.Ordinal))
                    && IsPositiveDecimalId(identity.Id));

        private static bool IsPositiveDecimalId(string? value)
        {
            if (string.IsNullOrEmpty(value) || value.Length > 32) return false;
            var nonZero = false;
            foreach (var c in value)
            {
                if (c < '0' || c > '9') return false;
                if (c != '0') nonZero = true;
            }
            return nonZero;
        }

        private static bool HasValidExtensionData(Dictionary<string, JsonElement>? extensionData)
        {
            if (extensionData == null || extensionData.Count > MaximumExtensionProperties)
            {
                return false;
            }

            var nodeCount = 0;
            foreach (var pair in extensionData)
            {
                if (!IsBoundedRequiredString(pair.Key, MaximumExtensionPropertyNameLength)
                    || !VisitExtensionValue(pair.Value, 1, ref nodeCount))
                {
                    return false;
                }
            }

            return true;
        }

        private static bool VisitExtensionValue(JsonElement element, int depth, ref int nodeCount)
        {
            nodeCount++;
            if (depth > MaximumExtensionDepth || nodeCount > MaximumExtensionNodes)
            {
                return false;
            }

            switch (element.ValueKind)
            {
                case JsonValueKind.String:
                    return element.GetString()?.Length <= MaximumExtensionStringLength;
                case JsonValueKind.Object:
                    foreach (var property in element.EnumerateObject())
                    {
                        if (!IsBoundedRequiredString(property.Name, MaximumExtensionPropertyNameLength)
                            || !VisitExtensionValue(property.Value, depth + 1, ref nodeCount))
                        {
                            return false;
                        }
                    }

                    return true;
                case JsonValueKind.Array:
                    foreach (var child in element.EnumerateArray())
                    {
                        if (!VisitExtensionValue(child, depth + 1, ref nodeCount))
                        {
                            return false;
                        }
                    }

                    return true;
                case JsonValueKind.Undefined:
                    return false;
                default:
                    return true;
            }
        }

        private static bool IsOptionalOrder(int? value)
            => !value.HasValue || value.Value is >= 1 and <= 6;

        private static bool IsOptionalNonNegativeRange(int? value, int maximum)
            => !value.HasValue || value.Value >= 0 && value.Value <= maximum;

        private static bool IsBoundedString(string? value, int maximum)
            => value != null && value.Length <= maximum;

        private static bool IsOptionalBoundedString(string? value, int maximum)
            => value == null || value.Length <= maximum;

        private static bool IsBoundedRequiredString(string? value, int maximum)
            => !string.IsNullOrEmpty(value) && value.Length <= maximum;
    }
}
