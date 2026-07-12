using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Configuration
{
    /// <summary>
    /// W2-TEST-1 — the SERVER→PAGE coverage direction. <see cref="ConfigPageBinderTests"/>
    /// only proves the reverse (every config-page control is a real property); nothing
    /// asserted that every admin-settable DEFAULT actually HAS a control. So a default
    /// admins could never change from its hardcoded value (XCUT-6: the pause-screen delay)
    /// passed the whole suite. This bridges that gap: every descriptor that declares an
    /// admin default and is backed by a real PluginConfiguration property must be writable
    /// from the config page, save a small documented set of deliberately control-less
    /// settings.
    /// </summary>
    public class ConfigControlCoverageTests
    {
        /// <summary>
        /// Admin-settable defaults that intentionally have NO bound config-page control.
        /// Key → reason. Every entry must be a real PluginConfiguration property and must
        /// genuinely lack a control (both enforced by <see cref="KnownControllessDefaults_AreRealPropertiesWithoutAControl"/>),
        /// so this list cannot be abused to silence a real XCUT-6-style gap.
        /// </summary>
        private static readonly Dictionary<string, string> KnownControllessDefaults = new(StringComparer.Ordinal)
        {
            ["ClearLocalStorageTimestamp"] =
                "set by the 'Clear Local Storage' admin button in config-page.js, not a bound field",
            ["ClearTranslationCacheTimestamp"] =
                "set by the ClearTranslationCacheTask scheduled task (XCUT-4 dismissed — not a missing button), not a bound field",
            ["DisableScriptInjectionMiddleware"] =
                "XCUT-8 kill switch — hand-edit-only escape hatch, deliberately never surfaced as a control",
            ["DisableBrandingMiddleware"] =
                "XCUT-8 kill switch — hand-edit-only escape hatch, deliberately never surfaced as a control",
        };

        private static string[] AdminSettableDescriptorKeys()
            => SettingDescriptors.All
                .Where(d => d.Exposure != SettingExposure.Neither || d.UserSettingsProperty != null)
                .Select(d => d.Key)
                .ToArray();

        private static HashSet<string> RealPropertyNames()
            => typeof(PluginConfiguration)
                .GetProperties(BindingFlags.Public | BindingFlags.Instance)
                .Select(p => p.Name)
                .ToHashSet(StringComparer.Ordinal);

        [Fact]
        public void EveryAdminConfigurableDefaultHasAConfigPageControl()
        {
            var realProps = RealPropertyNames();
            var writable = ConfigPageSource.CollectSavePathKeys();

            // Admin-settable descriptor keys that map to a real property (computed/contextual
            // keys like TmdbEnabled or SonarrInstances have no same-named property and fall out).
            var candidates = AdminSettableDescriptorKeys()
                .Where(realProps.Contains)
                .ToList();

            var missing = candidates
                .Where(key => !writable.Contains(key) && !KnownControllessDefaults.ContainsKey(key))
                .OrderBy(k => k, StringComparer.Ordinal)
                .ToList();

            Assert.True(
                missing.Count == 0,
                "Admin-settable defaults with no config-page control (admins can never change them "
                + "from their hardcoded value — the XCUT-6 class). Add a control in configPage.html / "
                + "config-page.js, or, if genuinely control-less, document it in KnownControllessDefaults:\n  "
                + string.Join("\n  ", missing));
        }

        [Fact]
        public void ThereAreAdminConfigurableDefaultsToCheck()
        {
            // Guard against vacuity: if the candidate set ever collapses to empty the coverage
            // test would pass trivially.
            var realProps = RealPropertyNames();
            var count = AdminSettableDescriptorKeys().Count(realProps.Contains);
            Assert.True(count > 50, $"expected many admin-settable defaults, found {count}");
        }

        [Fact]
        public void KnownControllessDefaults_AreRealPropertiesWithoutAControl()
        {
            var realProps = RealPropertyNames();
            var writable = ConfigPageSource.CollectSavePathKeys();

            var typos = KnownControllessDefaults.Keys
                .Where(k => !realProps.Contains(k))
                .OrderBy(k => k, StringComparer.Ordinal)
                .ToList();
            Assert.True(typos.Count == 0,
                $"KnownControllessDefaults keys that are not PluginConfiguration properties: {string.Join(", ", typos)}");

            // If any of these gains a real bound control, remove it from the list — otherwise
            // the exception would mask a control that DOES exist.
            var nowControlled = KnownControllessDefaults.Keys
                .Where(writable.Contains)
                .OrderBy(k => k, StringComparer.Ordinal)
                .ToList();
            Assert.True(nowControlled.Count == 0,
                "KnownControllessDefaults entries that now HAVE a config-page control (remove them "
                + $"from the exception list): {string.Join(", ", nowControlled)}");
        }

        [Fact]
        public void TimestampAndButtonDrivenSettingsHaveATrigger()
        {
            // XCUT-4 ADAPTATION: the two clear-cache timestamps are not bound fields, but each
            // MUST have a real trigger that writes it — otherwise the setting is dead. The local
            // storage timestamp is driven by an admin config-page button; the translation cache
            // timestamp is driven by the ClearTranslationCacheTask scheduled task (this is why
            // XCUT-4 was dismissed as "not a missing button").
            Assert.Matches(new Regex(@"ClearLocalStorageTimestamp\s*="), ConfigPageSource.Js);

            var taskSource = ReadScheduledTask("ClearTranslationCacheTask.cs");
            Assert.Matches(new Regex(@"ClearTranslationCacheTimestamp\s*="), taskSource);
        }

        private static string ReadScheduledTask(string fileName, [CallerFilePath] string sourceFile = "")
            => File.ReadAllText(Path.GetFullPath(Path.Combine(
                Path.GetDirectoryName(sourceFile)!,
                "..", "..", "Jellyfin.Plugin.JellyfinCanopy", "ScheduledTasks", fileName)));
    }
}
