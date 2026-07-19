using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Configuration;

public sealed class PersistedPayloadPolicyTests
{
    [Fact]
    public void Settings_FreeTextFields_AcceptExactBoundaryAndRejectNPlusOne()
    {
        var setters = new (string Name, Action<UserSettings, string> Set)[]
        {
            (nameof(UserSettings.CustomSubtitleTextColor), (p, v) => p.CustomSubtitleTextColor = v),
            (nameof(UserSettings.CustomSubtitleBgColor), (p, v) => p.CustomSubtitleBgColor = v),
            (nameof(UserSettings.WatchProgressMode), (p, v) => p.WatchProgressMode = v),
            (nameof(UserSettings.WatchProgressTimeFormat), (p, v) => p.WatchProgressTimeFormat = v),
            (nameof(UserSettings.QualityTagsPosition), (p, v) => p.QualityTagsPosition = v),
            (nameof(UserSettings.GenreTagsPosition), (p, v) => p.GenreTagsPosition = v),
            (nameof(UserSettings.LanguageTagsPosition), (p, v) => p.LanguageTagsPosition = v),
            (nameof(UserSettings.RatingTagsPosition), (p, v) => p.RatingTagsPosition = v),
            (nameof(UserSettings.LastOpenedTab), (p, v) => p.LastOpenedTab = v),
            (nameof(UserSettings.DisplayLanguage), (p, v) => p.DisplayLanguage = v),
            (nameof(UserSettings.CalendarDisplayMode), (p, v) => p.CalendarDisplayMode = v),
            (nameof(UserSettings.CalendarDefaultViewMode), (p, v) => p.CalendarDefaultViewMode = v)
        };

        foreach (var (name, set) in setters)
        {
            var exact = new UserSettings();
            set(exact, new string('x', PersistedPayloadPolicy.MaximumStandardStringLength));
            Assert.True(PersistedPayloadPolicy.Validate(exact).IsValid, $"{name} exact boundary");

            var over = new UserSettings();
            set(over, new string('x', PersistedPayloadPolicy.MaximumStandardStringLength + 1));
            Assert.Equal(PersistedPayloadStatus.Invalid, PersistedPayloadPolicy.Validate(over).Status);
        }
    }

    [Fact]
    public void Settings_NumericFields_EnforceBothBoundaries()
    {
        AssertRange((p, v) => p.PauseScreenDelaySeconds = v, 1, 60);
        AssertRange((p, v) => p.SelectedStylePresetIndex = v, 0, 5);
        AssertRange((p, v) => p.SelectedFontSizePresetIndex = v, 0, 5);
        AssertRange((p, v) => p.SelectedFontFamilyPresetIndex = v, 0, 4);
        AssertRange((p, v) => p.SubtitleVerticalPosition = v, 0, 100);
        AssertRange((p, v) => p.SubtitleHorizontalPosition = v, 0, 100);

        var orderSetters = new Action<UserSettings, int?>[]
        {
            (p, v) => p.ResolutionTagOrder = v,
            (p, v) => p.SourceTagOrder = v,
            (p, v) => p.DynamicRangeTagOrder = v,
            (p, v) => p.SpecialFormatTagOrder = v,
            (p, v) => p.VideoCodecTagOrder = v,
            (p, v) => p.AudioInfoTagOrder = v
        };
        foreach (var set in orderSetters)
        {
            AssertSettingsValid(set, null);
            AssertSettingsValid(set, 1);
            AssertSettingsValid(set, 6);
            AssertSettingsInvalid(set, 0);
            AssertSettingsInvalid(set, 7);
        }
    }

    [Fact]
    public void ShortcutAndElsewhereFieldsAndLists_EnforceExactBoundaries()
    {
        var shortcutSetters = new Action<Shortcut, string>[]
        {
            (p, v) => p.Name = v,
            (p, v) => p.Key = v,
            (p, v) => p.Label = v,
            (p, v) => p.Category = v
        };
        foreach (var set in shortcutSetters)
        {
            var exactItem = new Shortcut();
            set(exactItem, new string('x', PersistedPayloadPolicy.MaximumStandardStringLength));
            AssertValid(new UserShortcuts { Shortcuts = new List<Shortcut> { exactItem } });

            var overItem = new Shortcut();
            set(overItem, new string('x', PersistedPayloadPolicy.MaximumStandardStringLength + 1));
            AssertInvalid(new UserShortcuts { Shortcuts = new List<Shortcut> { overItem } });
        }

        AssertValid(new UserShortcuts
        {
            Shortcuts = Enumerable.Range(0, PersistedPayloadPolicy.MaximumShortcuts)
                .Select(_ => new Shortcut()).ToList()
        });
        AssertInvalid(new UserShortcuts
        {
            Shortcuts = Enumerable.Range(0, PersistedPayloadPolicy.MaximumShortcuts + 1)
                .Select(_ => new Shortcut()).ToList()
        });

        var exactText = new string('x', PersistedPayloadPolicy.MaximumStandardStringLength);
        var overText = exactText + "x";
        AssertValid(new ElsewhereSettings { Region = exactText });
        AssertInvalid(new ElsewhereSettings { Region = overText });
        AssertValid(new ElsewhereSettings { Regions = new List<string> { exactText } });
        AssertInvalid(new ElsewhereSettings { Regions = new List<string> { overText } });
        AssertValid(new ElsewhereSettings { Services = new List<string> { exactText } });
        AssertInvalid(new ElsewhereSettings { Services = new List<string> { overText } });

        AssertValid(new ElsewhereSettings
        {
            Regions = Enumerable.Repeat(string.Empty, PersistedPayloadPolicy.MaximumElsewhereEntries).ToList(),
            Services = Enumerable.Repeat(string.Empty, PersistedPayloadPolicy.MaximumElsewhereEntries).ToList()
        });
        AssertInvalid(new ElsewhereSettings
        {
            Regions = Enumerable.Repeat(string.Empty, PersistedPayloadPolicy.MaximumElsewhereEntries + 1).ToList()
        });
        AssertInvalid(new ElsewhereSettings
        {
            Services = Enumerable.Repeat(string.Empty, PersistedPayloadPolicy.MaximumElsewhereEntries + 1).ToList()
        });
    }

    [Fact]
    public void ExtensionData_EnforcesPropertyStringDepthAndNodeBoundaries()
    {
        using var nullDocument = JsonDocument.Parse("null");
        var exactProperties = new UserSettings();
        for (var i = 0; i < PersistedPayloadPolicy.MaximumExtensionProperties; i++)
        {
            exactProperties.ExtensionData.Add($"p{i}", nullDocument.RootElement.Clone());
        }
        AssertValid(exactProperties);
        exactProperties.ExtensionData.Add("over", nullDocument.RootElement.Clone());
        AssertInvalid(exactProperties);

        using var exactStringDocument = JsonDocument.Parse(
            JsonSerializer.Serialize(new string('x', PersistedPayloadPolicy.MaximumExtensionStringLength)));
        using var overStringDocument = JsonDocument.Parse(
            JsonSerializer.Serialize(new string('x', PersistedPayloadPolicy.MaximumExtensionStringLength + 1)));
        AssertValid(WithExtension("future", exactStringDocument.RootElement));
        AssertInvalid(WithExtension("future", overStringDocument.RootElement));

        AssertValid(WithExtension(
            new string('p', PersistedPayloadPolicy.MaximumExtensionPropertyNameLength),
            nullDocument.RootElement));
        AssertInvalid(WithExtension(
            new string('p', PersistedPayloadPolicy.MaximumExtensionPropertyNameLength + 1),
            nullDocument.RootElement));

        using var exactDepth = JsonDocument.Parse(NestedArrayJson(PersistedPayloadPolicy.MaximumExtensionDepth - 1));
        using var overDepth = JsonDocument.Parse(NestedArrayJson(PersistedPayloadPolicy.MaximumExtensionDepth));
        AssertValid(WithExtension("future", exactDepth.RootElement));
        AssertInvalid(WithExtension("future", overDepth.RootElement));

        using var exactNodes = JsonDocument.Parse(
            "[" + string.Join(',', Enumerable.Repeat("0", PersistedPayloadPolicy.MaximumExtensionNodes - 1)) + "]");
        using var overNodes = JsonDocument.Parse(
            "[" + string.Join(',', Enumerable.Repeat("0", PersistedPayloadPolicy.MaximumExtensionNodes)) + "]");
        AssertValid(WithExtension("future", exactNodes.RootElement));
        AssertInvalid(WithExtension("future", overNodes.RootElement));
    }

    [Fact]
    public void HiddenContent_FieldsRangesScopesAndLargeLibraryCount_AreBounded()
    {
        var stringFields = new (int Maximum, Action<HiddenContentItem, string> Set)[]
        {
            (128, (p, v) => p.ItemId = v),
            (512, (p, v) => p.Name = v),
            (64, (p, v) => p.Type = v),
            (32, (p, v) => p.TmdbId = v),
            (64, (p, v) => p.HiddenAt = v),
            (512, (p, v) => p.PosterPath = v),
            (128, (p, v) => p.SeriesId = v),
            (512, (p, v) => p.SeriesName = v)
        };
        foreach (var (maximum, set) in stringFields)
        {
            var exact = new HiddenContentItem();
            set(exact, new string('x', maximum));
            AssertHiddenValid("key", exact);

            var over = new HiddenContentItem();
            set(over, new string('x', maximum + 1));
            AssertHiddenInvalid("key", over);
        }

        AssertHiddenValid(new string('k', PersistedPayloadPolicy.MaximumHiddenKeyLength), new HiddenContentItem());
        AssertHiddenInvalid(new string('k', PersistedPayloadPolicy.MaximumHiddenKeyLength + 1), new HiddenContentItem());

        foreach (var scope in new[] { string.Empty, "global", "series", "continuewatching", "nextup", "homesections" })
        {
            AssertHiddenValid("key", new HiddenContentItem { HideScope = scope });
        }
        AssertHiddenInvalid("key", new HiddenContentItem { HideScope = "unknown" });

        AssertHiddenNumberRange((p, v) => p.SeasonNumber = v);
        AssertHiddenNumberRange((p, v) => p.EpisodeNumber = v);

        var largeLibrary = new UserHiddenContent();
        for (var i = 0; i < PersistedPayloadPolicy.MaximumHiddenItems; i++)
        {
            var id = i.ToString("x32");
            largeLibrary.Items.Add(id, new HiddenContentItem
            {
                ItemId = id,
                Name = $"A realistic library title {i} with some descriptive text",
                Type = i % 2 == 0 ? "Movie" : "Episode",
                TmdbId = (100_000 + i).ToString(System.Globalization.CultureInfo.InvariantCulture),
                HiddenAt = "2026-07-15T12:34:56.7890123Z",
                PosterPath = $"/metadata/library/{id}/poster.jpg",
                SeriesId = i % 2 == 0 ? string.Empty : id,
                SeriesName = i % 2 == 0 ? string.Empty : $"A realistic series name {i}",
                SeasonNumber = i % 2 == 0 ? null : 12,
                EpisodeNumber = i % 2 == 0 ? null : 34,
                HideScope = i % 3 == 0 ? "continuewatching" : "global"
            });
        }
        var largeValidation = PersistedPayloadPolicy.Validate(largeLibrary);
        Assert.True(largeValidation.IsValid, "10,000 realistically populated hidden items must remain supported");
        Assert.True(largeValidation.SerializedBytes > 4 * 1024 * 1024, "fixture must catch the former 4 MiB false-positive");
        largeLibrary.Items.Add("over", new HiddenContentItem());
        Assert.Equal(PersistedPayloadStatus.Invalid, PersistedPayloadPolicy.Validate(largeLibrary).Status);
    }

    [Fact]
    public void HiddenContent_LegacyNullStrings_AreAcceptedAndNormalizedOnlyInTheWriteCopy()
    {
        var source = new HiddenContentItem
        {
            ItemId = null!,
            Name = null!,
            Type = null!,
            TmdbId = null!,
            HiddenAt = null!,
            PosterPath = null!,
            SeriesId = null!,
            SeriesName = null!,
            HideScope = null!
        };
        var payload = new UserHiddenContent
        {
            Items = new Dictionary<string, HiddenContentItem> { ["key"] = source }
        };

        Assert.True(PersistedPayloadPolicy.Validate(payload).IsValid);
        var clone = PersistedPayloadPolicy.CloneValidated(payload);
        Assert.Equal(string.Empty, clone.Items["key"].Name);
        Assert.Equal("global", clone.Items["key"].HideScope);
        Assert.Null(source.Name);
        Assert.Null(source.HideScope);
    }

    [Fact]
    public void HiddenContent_VersionedIdentity_IsValidatedAndClonedWithoutAliasing()
    {
        var identity = new HiddenContentIdentity
        {
            Version = 1,
            Provider = "tmdb",
            MediaType = "movie",
            Id = "550"
        };
        var payload = new UserHiddenContent
        {
            Items = new Dictionary<string, HiddenContentItem>
            {
                ["hc1:tmdb:movie:550"] = new HiddenContentItem { TmdbId = "550", Identity = identity }
            }
        };

        Assert.True(PersistedPayloadPolicy.Validate(payload).IsValid);
        var clone = PersistedPayloadPolicy.CloneValidated(payload);
        Assert.NotSame(identity, clone.Items["hc1:tmdb:movie:550"].Identity);
        Assert.Equal("movie", clone.Items["hc1:tmdb:movie:550"].Identity?.MediaType);

        identity.MediaType = "tv";
        Assert.True(PersistedPayloadPolicy.Validate(payload).IsValid);
        identity.Provider = "other";
        AssertHiddenInvalid("key", new HiddenContentItem { TmdbId = "550", Identity = identity });
        identity.Provider = "tmdb";
        identity.Version = 2;
        AssertHiddenInvalid("key", new HiddenContentItem { TmdbId = "550", Identity = identity });
        identity.Version = 1;
        identity.Id = "movie-550";
        AssertHiddenInvalid("key", new HiddenContentItem { TmdbId = "movie-550", Identity = identity });
        identity.Id = "551";
        AssertHiddenInvalid("key", new HiddenContentItem { TmdbId = "550", Identity = identity });
    }

    [Fact]
    public void Theme_DefaultAndTypedOverrides_AreValid()
    {
        var theme = UserThemeConfiguration.CreateDefault("canopy", "canopy-night");
        var profile = Assert.Single(theme.Profiles);
        profile.Tokens["color.primary"] = JsonValue("#7c5cff");
        profile.Tokens["layout.density"] = JsonValue("cozy");
        profile.Tokens["effects.blur"] = JsonValue(18);
        profile.Responsive.Phone = new ThemeBreakpointOverrides();
        profile.Responsive.Phone.Tokens["layout.navigation"] = JsonValue("bottom");
        profile.Accessibility.Motion = "off";
        theme.Schedule.Add(new ThemeScheduleEntry
        {
            Id = "winter",
            ProfileId = ThemeProfile.DefaultId,
            StartMonthDay = "12-01",
            EndMonthDay = "02-29",
            Priority = 10
        });
        theme.LegacyMigration.JellyfishTheme = "Ocean";
        theme.LegacyMigration.Completed = true;

        AssertValid(theme);
    }

    [Fact]
    public void Theme_ProfileIdentityNamesAndCapacity_AreBounded()
    {
        var emoji80 = string.Concat(Enumerable.Repeat("🪼", ThemeConfigurationPolicy.MaximumProfileNameRunes));
        var exact = UserThemeConfiguration.CreateDefault("canopy", "canopy-night");
        exact.Profiles[0].Name = emoji80;
        AssertValid(exact);

        exact.Profiles[0].Name += "🪼";
        AssertInvalid(exact);

        var tooMany = new UserThemeConfiguration
        {
            Profiles = Enumerable.Range(0, ThemeConfigurationPolicy.MaximumProfiles + 1)
                .Select(index => new ThemeProfile { Id = $"profile-{index}", Name = $"Profile {index}" })
                .ToList()
        };
        AssertInvalid(tooMany);

        var duplicate = UserThemeConfiguration.CreateDefault("canopy", "canopy-night");
        duplicate.Profiles.Add(new ThemeProfile());
        AssertInvalid(duplicate);

        var missingActive = UserThemeConfiguration.CreateDefault("canopy", "canopy-night");
        missingActive.ActiveProfileId = "absent";
        AssertInvalid(missingActive);

        var invalidId = UserThemeConfiguration.CreateDefault("canopy", "canopy-night");
        invalidId.Profiles[0].Id = "has spaces";
        invalidId.ActiveProfileId = "has spaces";
        AssertInvalid(invalidId);
    }

    [Fact]
    public void Theme_TokenNamesTypesAndValues_AreAllowlisted()
    {
        var unknown = UserThemeConfiguration.CreateDefault("canopy", "canopy-night");
        unknown.Profiles[0].Tokens["css.selector"] = JsonValue("body{}");
        AssertInvalid(unknown);

        var remote = UserThemeConfiguration.CreateDefault("canopy", "canopy-night");
        remote.Profiles[0].Tokens["color.primary"] = JsonValue("url(https://example.invalid/a.png)");
        AssertInvalid(remote);

        var wrongType = UserThemeConfiguration.CreateDefault("canopy", "canopy-night");
        wrongType.Profiles[0].Tokens["effects.blur"] = JsonValue("48px");
        AssertInvalid(wrongType);

        var outOfRange = UserThemeConfiguration.CreateDefault("canopy", "canopy-night");
        outOfRange.Profiles[0].Tokens["effects.blur"] = JsonValue(49);
        AssertInvalid(outOfRange);

        var invalidResponsive = UserThemeConfiguration.CreateDefault("canopy", "canopy-night");
        var tvOverrides = new ThemeBreakpointOverrides();
        tvOverrides.Tokens["layout.navigation"] = JsonValue("touch-only");
        invalidResponsive.Profiles[0].Responsive.Tv = tvOverrides;
        AssertInvalid(invalidResponsive);
    }

    [Fact]
    public void Theme_SchemaScheduleAccessibilityAndLegacyMigration_AreStrict()
    {
        var future = UserThemeConfiguration.CreateDefault("canopy", "canopy-night");
        future.SchemaVersion = ThemeConfigurationPolicy.CurrentSchemaVersion + 1;
        AssertInvalid(future);

        var invalidSchedule = UserThemeConfiguration.CreateDefault("canopy", "canopy-night");
        invalidSchedule.Schedule.Add(new ThemeScheduleEntry
        {
            Id = "bad",
            ProfileId = "absent",
            StartMonthDay = "02-30",
            EndMonthDay = "03-01"
        });
        AssertInvalid(invalidSchedule);

        var invalidAccessibility = UserThemeConfiguration.CreateDefault("canopy", "canopy-night");
        invalidAccessibility.Profiles[0].Accessibility.Motion = "force-motion";
        AssertInvalid(invalidAccessibility);

        var invalidLegacy = UserThemeConfiguration.CreateDefault("canopy", "canopy-night");
        invalidLegacy.LegacyMigration.JellyfishTheme = "https://example.invalid/theme.css";
        AssertInvalid(invalidLegacy);

        var incompleteLegacy = UserThemeConfiguration.CreateDefault("canopy", "canopy-night");
        incompleteLegacy.LegacyMigration.JellyfishTheme = "Ocean";
        AssertInvalid(incompleteLegacy);

        var missingLegacyEvidence = UserThemeConfiguration.CreateDefault("canopy", "canopy-night");
        missingLegacyEvidence.LegacyMigration.Completed = true;
        AssertInvalid(missingLegacyEvidence);
    }

    [Fact]
    public void Theme_UnknownFieldsArePreservedForDiagnosisAndRejectedBeforePersistence()
    {
        using var css = JsonDocument.Parse("\"body { display: none }\"");
        var topLevel = UserThemeConfiguration.CreateDefault("canopy", "canopy-night");
        topLevel.ExtensionData["CustomCss"] = css.RootElement.Clone();
        AssertInvalid(topLevel);

        var nested = UserThemeConfiguration.CreateDefault("canopy", "canopy-night");
        nested.Profiles[0].ExtensionData["BackgroundUrl"] = css.RootElement.Clone();
        AssertInvalid(nested);

        const string json = """
            {
              "SchemaVersion": 1,
              "ActiveProfileId": "default",
              "Profiles": [{ "Id": "default", "Name": "Default", "UnknownCss": "@import url(https://example.invalid/x.css)" }],
              "Schedule": [],
              "LegacyMigration": {}
            }
            """;
        var parsed = JsonSerializer.Deserialize<UserThemeConfiguration>(json, PersistedJson.ReadOptions);
        Assert.NotNull(parsed);
        Assert.True(parsed!.Profiles[0].ExtensionData.ContainsKey("UnknownCss"));
        Assert.Contains("UnknownCss", JsonSerializer.Serialize(parsed, PersistedJson.WriteOptions), StringComparison.Ordinal);
        AssertInvalid(parsed);
    }

    [Fact]
    public void Theme_HasAnIndependent128KiBSerializedLimit()
    {
        var theme = new UserThemeConfiguration
        {
            ActiveProfileId = "profile-0",
            Profiles = new List<ThemeProfile>()
        };
        for (var index = 0; index < ThemeConfigurationPolicy.MaximumProfiles; index++)
        {
            var profile = new ThemeProfile
            {
                Id = $"profile-{index}",
                Name = new string('x', ThemeConfigurationPolicy.MaximumProfileNameRunes)
            };
            PopulateColorTokens(profile.Tokens);
            profile.Responsive.Phone = ColorBreakpoint();
            profile.Responsive.Tablet = ColorBreakpoint();
            profile.Responsive.Desktop = ColorBreakpoint();
            profile.Responsive.Wide = ColorBreakpoint();
            profile.Responsive.Tv = ColorBreakpoint();
            theme.Profiles.Add(profile);
        }
        for (var index = 0; index < ThemeConfigurationPolicy.MaximumScheduleEntries; index++)
        {
            theme.Schedule.Add(new ThemeScheduleEntry
            {
                Id = $"schedule-{index}",
                ProfileId = $"profile-{index % ThemeConfigurationPolicy.MaximumProfiles}",
                StartMonthDay = "01-01",
                EndMonthDay = "12-31",
                Priority = index
            });
        }

        var validation = PersistedPayloadPolicy.Validate(theme);
        Assert.Equal(PersistedPayloadStatus.TooLarge, validation.Status);
        Assert.True(validation.SerializedBytes > ThemeConfigurationPolicy.MaximumPersistedBytes);
    }

    [Fact]
    public void AggregateByteBudget_AcceptsExactBoundaryAndRejectsNPlusOne()
    {
        Assert.True(PersistedPayloadPolicy.ValidateByteCount(1024, 1024).IsValid);
        Assert.Equal(PersistedPayloadStatus.TooLarge, PersistedPayloadPolicy.ValidateByteCount(1025, 1024).Status);
    }

    private static UserSettings WithExtension(string name, JsonElement value)
    {
        var settings = new UserSettings();
        settings.ExtensionData.Add(name, value.Clone());
        return settings;
    }

    private static string NestedArrayJson(int containers)
        => new string('[', containers) + "0" + new string(']', containers);

    private static JsonElement JsonValue<T>(T value)
    {
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(value));
        return document.RootElement.Clone();
    }

    private static ThemeBreakpointOverrides ColorBreakpoint()
    {
        var breakpoint = new ThemeBreakpointOverrides();
        PopulateColorTokens(breakpoint.Tokens);
        return breakpoint;
    }

    private static void PopulateColorTokens(Dictionary<string, JsonElement> tokens)
    {
        foreach (var name in new[]
        {
            "color.canvas", "color.surface", "color.elevated", "color.overlay",
            "color.text", "color.text-muted", "color.primary", "color.on-primary",
            "color.secondary", "color.positive", "color.caution", "color.negative",
            "color.info", "color.divider", "color.focus"
        })
        {
            tokens[name] = JsonValue("#7c5cffff");
        }

        tokens["type.family-ui"] = JsonValue("inter");
        tokens["type.family-display"] = JsonValue("rounded");
        tokens["type.family-reading"] = JsonValue("serif");
        tokens["type.scale"] = JsonValue(1.25);
        tokens["type.line-height"] = JsonValue(1.5);
        tokens["type.tracking"] = JsonValue(0);
        tokens["type.max-reading-width"] = JsonValue(70);
        tokens["shape.radius-scale"] = JsonValue("rounded");
        tokens["shape.card-radius"] = JsonValue("subtle");
        tokens["shape.control-radius"] = JsonValue("pill");
        tokens["shape.dialog-radius"] = JsonValue("rounded");
        tokens["shape.avatar-shape"] = JsonValue("circle");
        tokens["shape.border-width"] = JsonValue(1);
        tokens["elevation.glow-intensity"] = JsonValue(0.5);
        tokens["elevation.surface-shadow"] = JsonValue("soft");
        tokens["elevation.card-shadow"] = JsonValue("medium");
        tokens["elevation.dialog-shadow"] = JsonValue("strong");
        tokens["elevation.focus-ring"] = JsonValue("medium");
        tokens["space.scale"] = JsonValue("cozy");
        tokens["space.page-gutter"] = JsonValue(1.5);
        tokens["space.section-gap"] = JsonValue(2);
        tokens["space.card-gap"] = JsonValue(1);
        tokens["space.control-gap"] = JsonValue(1);
        tokens["layout.density"] = JsonValue("cozy");
        tokens["layout.navigation"] = JsonValue("auto");
        tokens["layout.home-hero"] = JsonValue("cinematic");
        tokens["layout.details"] = JsonValue("cinematic");
        tokens["layout.seasons"] = JsonValue("auto");
        tokens["layout.card-actions"] = JsonValue("hover");
        tokens["layout.poster-ratio"] = JsonValue("auto");
        tokens["layout.cast-shape"] = JsonValue("circle");
        tokens["effects.level"] = JsonValue("balanced");
        tokens["effects.material"] = JsonValue("glass");
        tokens["effects.blur"] = JsonValue(24);
        tokens["effects.saturation"] = JsonValue(1.25);
        tokens["effects.backdrop-opacity"] = JsonValue(0.75);
        tokens["effects.glow"] = JsonValue(0.5);
        tokens["effects.image-treatment"] = JsonValue("gradient");
        tokens["motion.profile"] = JsonValue("system");
        tokens["motion.duration-scale"] = JsonValue(1);
        tokens["motion.easing"] = JsonValue("smooth");
        tokens["motion.hover-lift"] = JsonValue(4);
        tokens["motion.page-transition"] = JsonValue(true);
        tokens["motion.stagger"] = JsonValue(false);
        tokens["progress.position"] = JsonValue("overlay");
        tokens["progress.thickness"] = JsonValue(4);
        tokens["progress.watched-indicator"] = JsonValue("check");
        tokens["progress.unwatched-indicator"] = JsonValue("corner");
        tokens["player.osd-density"] = JsonValue("standard");
        tokens["player.control-material"] = JsonValue("translucent");
        tokens["player.pause-screen-material"] = JsonValue("glass");
        tokens["player.subtitle-backdrop"] = JsonValue("box");
        tokens["player.trickplay-shape"] = JsonValue("rounded");
        tokens["icon.family"] = JsonValue("lucide");
        tokens["icon.weight"] = JsonValue("regular");
        tokens["icon.size-scale"] = JsonValue(1);
        tokens["icon.multicolor-metadata"] = JsonValue(true);
        tokens["accessibility.underline-links"] = JsonValue(true);
        tokens["accessibility.contrast"] = JsonValue("system");
        tokens["accessibility.motion"] = JsonValue("system");
        tokens["accessibility.transparency"] = JsonValue("system");
        tokens["accessibility.focus-emphasis"] = JsonValue("strong");
        tokens["accessibility.text-scale"] = JsonValue(1.25);
    }

    private static void AssertRange(Action<UserSettings, int> set, int minimum, int maximum)
    {
        AssertSettingsValid(set, minimum);
        AssertSettingsValid(set, maximum);
        AssertSettingsInvalid(set, minimum - 1);
        AssertSettingsInvalid(set, maximum + 1);
    }

    private static void AssertSettingsValid<T>(Action<UserSettings, T> set, T value)
    {
        var settings = new UserSettings();
        set(settings, value);
        AssertValid(settings);
    }

    private static void AssertSettingsInvalid<T>(Action<UserSettings, T> set, T value)
    {
        var settings = new UserSettings();
        set(settings, value);
        AssertInvalid(settings);
    }

    private static void AssertHiddenNumberRange(Action<HiddenContentItem, int?> set)
    {
        foreach (var value in new int?[] { null, 0, 100_000 })
        {
            var item = new HiddenContentItem();
            set(item, value);
            AssertHiddenValid("key", item);
        }
        foreach (var value in new int?[] { -1, 100_001 })
        {
            var item = new HiddenContentItem();
            set(item, value);
            AssertHiddenInvalid("key", item);
        }
    }

    private static void AssertHiddenValid(string key, HiddenContentItem item)
        => Assert.True(PersistedPayloadPolicy.Validate(new UserHiddenContent
        {
            Items = new Dictionary<string, HiddenContentItem> { [key] = item }
        }).IsValid);

    private static void AssertHiddenInvalid(string key, HiddenContentItem item)
        => Assert.Equal(PersistedPayloadStatus.Invalid, PersistedPayloadPolicy.Validate(new UserHiddenContent
        {
            Items = new Dictionary<string, HiddenContentItem> { [key] = item }
        }).Status);

    private static void AssertValid(IRevisionedUserConfiguration value)
        => Assert.True(PersistedPayloadPolicy.Validate(value).IsValid);

    private static void AssertInvalid(IRevisionedUserConfiguration value)
        => Assert.Equal(PersistedPayloadStatus.Invalid, PersistedPayloadPolicy.Validate(value).Status);
}
