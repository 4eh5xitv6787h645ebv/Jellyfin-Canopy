using System.Reflection;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Configuration
{
    /// <summary>
    /// Contract tests for the declarative config-page field binder.
    ///
    /// The admin config page saves by fetching the live PluginConfiguration and
    /// overwriting a fixed set of keys read from the form: the generic
    /// [data-config-key] binder pass plus the hand-written custom paths
    /// (multi-element enums, validated text, arr instances, *Order keys, owned
    /// flags). These tests pin that key set so a refactor cannot silently drop
    /// (setting becomes un-saveable) or add (setting silently overwritten) a key.
    /// The pinned list in Snapshots/configpage-save-keys.json was extracted from
    /// the last fully hand-written saveConfig implementation.
    ///
    /// The config-page parsing lives in <see cref="ConfigPageSource"/> so this
    /// page→server suite and the server→page <see cref="ConfigControlCoverageTests"/>
    /// share one parser.
    /// </summary>
    public class ConfigPageBinderTests
    {
        [Fact]
        public void SavePath_KeySet_MatchesPinnedContract()
        {
            var expected = ReadPinnedKeys();
            var actual = ConfigPageSource.CollectSavePathKeys();

            var missing = expected.Except(actual).OrderBy(k => k).ToList();
            var extra = actual.Except(expected).OrderBy(k => k).ToList();

            Assert.True(
                missing.Count == 0 && extra.Count == 0,
                "config-page save path key set diverged from the pinned contract "
                + "(Snapshots/configpage-save-keys.json).\n"
                + $"  missing (no longer saved): {string.Join(", ", missing)}\n"
                + $"  extra (newly saved — if intentional, update the snapshot): {string.Join(", ", extra)}");
        }

        [Fact]
        public void BinderKeys_AreRealPluginConfigurationProperties()
        {
            var propertyNames = typeof(PluginConfiguration)
                .GetProperties(BindingFlags.Public | BindingFlags.Instance)
                .Select(p => p.Name)
                .ToHashSet(StringComparer.Ordinal);

            var unknown = ConfigPageSource.BinderKeys()
                .Where(k => !propertyNames.Contains(k))
                .OrderBy(k => k)
                .ToList();

            Assert.True(
                unknown.Count == 0,
                "data-config-key values in configPage.html that are not PluginConfiguration "
                + $"properties (typo?): {string.Join(", ", unknown)}");
        }

        [Fact]
        public void BinderKeys_AreUniquePerField()
        {
            // Two elements bound to the same key would fight over the saved value
            // (last one in DOM order wins silently). The only settings written twice
            // on purpose (ShowLetterboxdLinkAsText / ShowArrLinksAsText via the
            // metadata-icons override) do it in the custom path, not via two
            // binder-annotated elements.
            var duplicates = ConfigPageSource.BinderKeysWithDuplicates()
                .GroupBy(k => k)
                .Where(g => g.Count() > 1)
                .Select(g => g.Key)
                .OrderBy(k => k)
                .ToList();

            Assert.True(duplicates.Count == 0, $"duplicate data-config-key: {string.Join(", ", duplicates)}");
        }

        [Fact]
        public void PauseScreenDelay_IsBoundAsAClampedIntControl()
        {
            var html = ConfigPageSource.Html;
            var js = ConfigPageSource.Js;

            // XCUT-6: the admin control for the pre-existing PauseScreenDelaySeconds
            // per-user default. Bound via the generic [data-config-key] int binder
            // with a fallback, and clamped [1,60] in the save-path override.
            Assert.Contains("data-config-key=\"PauseScreenDelaySeconds\"", html, StringComparison.Ordinal);
            Assert.Matches(
                "<input[^>]*id=\"pauseScreenDelaySeconds\"[^>]*data-config-int[^>]*data-config-fallback=\"5\"",
                html);
            Assert.Contains("PauseScreenDelaySeconds:", js, StringComparison.Ordinal);
        }

        private static HashSet<string> ReadPinnedKeys()
        {
            var path = Path.Combine(AppContext.BaseDirectory, "Snapshots", "configpage-save-keys.json");
            Assert.True(File.Exists(path), $"Missing pinned key list: {path}");
            return JsonSerializer.Deserialize<string[]>(File.ReadAllText(path))!.ToHashSet(StringComparer.Ordinal);
        }
    }
}
