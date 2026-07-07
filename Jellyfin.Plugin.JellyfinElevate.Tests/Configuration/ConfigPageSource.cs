using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.Configuration
{
    /// <summary>
    /// Single parser for the admin config page (configPage.html + config-page.js),
    /// extracted from <see cref="ConfigPageBinderTests"/> so BOTH that suite (the
    /// page→server direction: every control is a real property) and
    /// <see cref="ConfigControlCoverageTests"/> (the server→page direction: every
    /// admin default has a control) read the SAME writable-key set and can never
    /// drift. Purely reflective over the shipped source files — no plugin runtime.
    /// </summary>
    internal static class ConfigPageSource
    {
        private static readonly Regex BinderKeyRegex = new("data-config-key=\"([^\"]+)\"", RegexOptions.Compiled);
        private static readonly Regex OrderKeyRegex = new("data-order-key=\"([^\"]+)\"", RegexOptions.Compiled);
        private static readonly Regex ConfigAssignRegex = new(@"config\.([A-Za-z_0-9]+) =", RegexOptions.Compiled);
        private static readonly Regex OwnedKeyRegex = new("ownedKey: '([^']+)'", RegexOptions.Compiled);

        /// <summary>Raw configPage.html source.</summary>
        internal static string Html => File.ReadAllText(Path.Combine(ConfigurationDirectory(), "configPage.html"));

        /// <summary>Raw config-page.js source.</summary>
        internal static string Js => File.ReadAllText(Path.Combine(ConfigurationDirectory(), "config-page.js"));

        /// <summary>Every data-config-key occurrence, including duplicates (DOM order).</summary>
        internal static IReadOnlyList<string> BinderKeysWithDuplicates()
            => BinderKeyRegex.Matches(Html).Select(m => m.Groups[1].Value).ToList();

        /// <summary>Distinct data-config-key binder keys.</summary>
        internal static HashSet<string> BinderKeys()
            => BinderKeysWithDuplicates().ToHashSet(StringComparer.Ordinal);

        /// <summary>
        /// The full set of PluginConfiguration keys the config page can WRITE: the
        /// generic [data-config-key] binder keys, the hand-written custom assignments in
        /// buildConfigFromForm + saveArrInstances (config.X = ...), the quality-category
        /// [data-order-key] rows, and the Custom-Tabs ownership flags (ownedKey).
        /// </summary>
        internal static HashSet<string> CollectSavePathKeys()
        {
            var html = Html;
            var js = Js;

            var keys = BinderKeys();

            // Custom assignments inside buildConfigFromForm (the save-path body).
            var buildStart = js.IndexOf("async function buildConfigFromForm()", StringComparison.Ordinal);
            if (buildStart < 0)
            {
                throw new InvalidOperationException("buildConfigFromForm not found in config-page.js");
            }

            var buildEnd = js.IndexOf("return config;", buildStart, StringComparison.Ordinal);
            if (buildEnd <= buildStart)
            {
                throw new InvalidOperationException("buildConfigFromForm return not found");
            }

            foreach (Match m in ConfigAssignRegex.Matches(js[buildStart..buildEnd]))
            {
                keys.Add(m.Groups[1].Value);
            }

            // saveArrInstances writes the instance JSON + mirrored legacy fields.
            var arrStart = js.IndexOf("function saveArrInstances(config)", StringComparison.Ordinal);
            if (arrStart < 0)
            {
                throw new InvalidOperationException("saveArrInstances not found in config-page.js");
            }

            var arrEnd = js.IndexOf("function loadConfig()", arrStart, StringComparison.Ordinal);
            if (arrEnd <= arrStart)
            {
                throw new InvalidOperationException("loadConfig (saveArrInstances end anchor) not found");
            }

            foreach (Match m in ConfigAssignRegex.Matches(js[arrStart..arrEnd]))
            {
                keys.Add(m.Groups[1].Value);
            }

            // Quality-category order keys come from row markup (config[row.dataset.orderKey]).
            foreach (Match m in OrderKeyRegex.Matches(html))
            {
                keys.Add(m.Groups[1].Value);
            }

            // Custom Tabs ownership flags (config[entry.ownedKey]).
            foreach (Match m in OwnedKeyRegex.Matches(js))
            {
                keys.Add(m.Groups[1].Value);
            }

            return keys;
        }

        private static string ConfigurationDirectory([CallerFilePath] string sourceFile = "")
            => Path.GetFullPath(Path.Combine(
                Path.GetDirectoryName(sourceFile)!,
                "..", "..", "Jellyfin.Plugin.JellyfinElevate", "Configuration"));
    }
}
