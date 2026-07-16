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
