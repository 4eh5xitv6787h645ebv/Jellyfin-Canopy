using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Configuration;

public sealed class ShortcutConfigurationNormalizerTests
{
    private static readonly IReadOnlyList<Shortcut> Defaults = new[]
    {
        new Shortcut { Name = "First", Key = "F", Label = "First", Category = "Global" },
        new Shortcut { Name = "Second", Key = "S", Label = "Second", Category = "Player" }
    };

    [Fact]
    public void PersistedEmptyBinding_WinsConstructorDefault_AndSurvives()
    {
        var disabled = new Shortcut
        {
            Name = "First",
            Key = string.Empty,
            Label = "First",
            Category = "Global",
            ExtensionData = new Dictionary<string, JsonElement>(StringComparer.Ordinal)
            {
                ["Future"] = JsonDocument.Parse("{\"owner\":\"persisted\"}").RootElement.Clone()
            }
        };

        var result = ShortcutConfigurationNormalizer.Normalize(
            new Shortcut?[] { Defaults[0], disabled },
            Defaults);

        Assert.True(result.Changed);
        Assert.Equal(1, result.DuplicatesDropped);
        Assert.Same(disabled, result.Shortcuts[0]);
        Assert.Equal(string.Empty, result.Shortcuts[0].Key);
        Assert.Equal("persisted", result.Shortcuts[0].ExtensionData["Future"].GetProperty("owner").GetString());
        Assert.Equal("Second", result.Shortcuts[1].Name);
    }

    [Fact]
    public void MissingDefaults_Backfill_WithoutReplacingUnknownDisabledRows()
    {
        var custom = new Shortcut { Name = "FutureAction", Key = string.Empty, Label = "Future" };

        var result = ShortcutConfigurationNormalizer.Normalize(
            new Shortcut?[] { custom },
            Defaults);

        Assert.Same(custom, result.Shortcuts[0]);
        Assert.Equal(string.Empty, result.Shortcuts[0].Key);
        Assert.Equal(new[] { "First", "Second" }, result.MissingDefaults.Select(item => item.Name));
        Assert.Equal(new[] { "FutureAction", "First", "Second" }, result.Shortcuts.Select(item => item.Name));
    }

    [Fact]
    public void LastNamedRowWins_AndNamelessRowsAreTheOnlyMalformedEntries()
    {
        var earlier = new Shortcut { Name = "First", Key = "A" };
        var winner = new Shortcut { Name = "First", Key = "B" };

        var result = ShortcutConfigurationNormalizer.Normalize(
            new Shortcut?[]
            {
                earlier,
                null,
                new Shortcut { Name = string.Empty, Key = "X" },
                winner,
                new Shortcut { Name = "Unknown", Key = string.Empty }
            },
            Defaults);

        Assert.Equal(1, result.DuplicatesDropped);
        Assert.Equal(2, result.MalformedDropped);
        Assert.Same(winner, Assert.Single(result.Shortcuts, item => item.Name == "First"));
        Assert.Equal(string.Empty, Assert.Single(result.Shortcuts, item => item.Name == "Unknown").Key);
    }

    [Fact]
    public void NullKey_NormalizesToIntentionalEmpty_AndResultIsIdempotent()
    {
        var disabled = new Shortcut { Name = "First", Key = null! };
        var first = ShortcutConfigurationNormalizer.Normalize(
            new Shortcut?[] { disabled, Defaults[1] },
            Defaults);

        Assert.Equal(1, first.NullKeysNormalized);
        Assert.Null(disabled.Key);
        Assert.NotSame(disabled, first.Shortcuts[0]);
        Assert.Equal(string.Empty, first.Shortcuts[0].Key);

        var second = ShortcutConfigurationNormalizer.Normalize(first.Shortcuts, Defaults);
        Assert.False(second.Changed);
        Assert.Equal(first.Shortcuts, second.Shortcuts);
    }
}
