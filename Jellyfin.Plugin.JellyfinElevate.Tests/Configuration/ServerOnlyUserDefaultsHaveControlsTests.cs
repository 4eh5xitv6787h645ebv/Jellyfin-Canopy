using System.Runtime.CompilerServices;
using Jellyfin.Plugin.JellyfinElevate.Configuration;
using Xunit;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.Configuration
{
    /// <summary>
    /// Class guard for XCUT-6: every ServerOnlyUser admin default — a descriptor
    /// with <see cref="SettingExposure.Neither"/> that is the default for a per-user
    /// override (UserSettingsProperty != null) — must expose an admin config-page
    /// control, otherwise admins cannot change the default the way they can for the
    /// per-user field (the pause-screen delay was the lone gap). Catches any future
    /// ServerOnlyUser default shipped without a control.
    /// </summary>
    public class ServerOnlyUserDefaultsHaveControlsTests
    {
        [Fact]
        public void EveryServerOnlyUserDefault_HasAConfigPageControl()
        {
            var html = ReadConfigPageHtml();

            var missing = SettingDescriptors.All
                .Where(d => d.Exposure == SettingExposure.Neither && d.UserSettingsProperty != null)
                .Select(d => d.Key)
                .Where(key => !html.Contains($"data-config-key=\"{key}\"", StringComparison.Ordinal))
                .OrderBy(k => k, StringComparer.Ordinal)
                .ToList();

            Assert.True(
                missing.Count == 0,
                "ServerOnlyUser admin defaults without a data-config-key control in configPage.html "
                + $"(admins cannot change the default): {string.Join(", ", missing)}");
        }

        [Fact]
        public void ThereIsAtLeastOneServerOnlyUserDefault_ToExercise()
        {
            // If this ever hits zero the guard above is vacuously true — fail loudly
            // so the guard cannot silently stop protecting anything.
            var count = SettingDescriptors.All
                .Count(d => d.Exposure == SettingExposure.Neither && d.UserSettingsProperty != null);
            Assert.True(count > 0, "expected at least one ServerOnlyUser admin default");
        }

        private static string ReadConfigPageHtml()
            => File.ReadAllText(Path.Combine(PluginConfigurationDirectory(), "configPage.html"));

        private static string PluginConfigurationDirectory([CallerFilePath] string sourceFile = "")
            => Path.GetFullPath(Path.Combine(
                Path.GetDirectoryName(sourceFile)!,
                "..", "..", "Jellyfin.Plugin.JellyfinElevate", "Configuration"));
    }
}
