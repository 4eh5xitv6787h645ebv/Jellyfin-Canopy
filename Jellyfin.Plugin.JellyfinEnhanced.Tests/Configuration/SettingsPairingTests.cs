using System.Reflection;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Xunit;

namespace Jellyfin.Plugin.JellyfinEnhanced.Tests.Configuration
{
    /// <summary>
    /// Drift-catcher for the PluginConfiguration (admin defaults) ↔ UserSettings (per-user
    /// overrides) pairing. Historically the two classes re-declared ~40 settings with slightly
    /// different names/nullability and nothing enforced the pairing, which is how silent drift
    /// like WatchProgressMode vs WatchProgressDefaultMode happened. These tests force every new
    /// UserSettings property to either declare its admin default in the SettingDescriptors
    /// registry or be explicitly listed (with a reason) below.
    /// </summary>
    public class SettingsPairingTests
    {
        /// <summary>
        /// UserSettings properties that intentionally have NO admin default in
        /// PluginConfiguration. Adding a property here requires a reason; if an admin default
        /// exists (or is added later), pair it in SettingDescriptors instead.
        /// </summary>
        private static readonly IReadOnlyDictionary<string, string> KnownUnpairedUserSettings = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            // Per-user subtitle fine-tuning. Admins choose per-user starting points via the
            // preset indices (DefaultSubtitleStyle/Size/Font, paired in the registry); the raw
            // custom colors/positions are individual taste with class-initializer defaults only.
            [nameof(UserSettings.CustomSubtitleTextColor)] = "per-user custom color, no admin default by design",
            [nameof(UserSettings.CustomSubtitleBgColor)] = "per-user custom color, no admin default by design",
            [nameof(UserSettings.UsingCustomColors)] = "derived flag for the custom colors above",
            [nameof(UserSettings.SubtitleVerticalPosition)] = "per-user positioning, no admin default by design",
            [nameof(UserSettings.SubtitleHorizontalPosition)] = "per-user positioning, no admin default by design",

            // Pure per-user UI state, never admin-configurable.
            [nameof(UserSettings.LastOpenedTab)] = "UI state; seeded hardcoded to \"shortcuts\"",

            // Per-user calendar view preferences. Seeded hardcoded ("list"/"agenda") in
            // UserSettingsController.GetUserSettingsSettings; no admin default exists today.
            [nameof(UserSettings.CalendarDisplayMode)] = "per-user view preference; seeded hardcoded to \"list\"",
            [nameof(UserSettings.CalendarDefaultViewMode)] = "per-user view preference; seeded hardcoded to \"agenda\"",
        };

        [Fact]
        public void EveryUserSettingMapsToAnAdminDefault_OrIsAKnownException()
        {
            var pairedUserProperties = SettingDescriptors.All
                .Where(d => d.UserSettingsProperty != null)
                .Select(d => d.UserSettingsProperty!)
                .ToHashSet(StringComparer.Ordinal);

            var unaccounted = typeof(UserSettings)
                .GetProperties(BindingFlags.Public | BindingFlags.Instance)
                .Select(p => p.Name)
                .Where(name => !pairedUserProperties.Contains(name) && !KnownUnpairedUserSettings.ContainsKey(name))
                .ToList();

            Assert.True(
                unaccounted.Count == 0,
                "UserSettings properties without an admin-default pairing in SettingDescriptors "
                + "and not in the known-exceptions list (pair them in the registry, or document "
                + $"why no admin default exists): {string.Join(", ", unaccounted)}");
        }

        [Fact]
        public void EveryUserOverridableDescriptor_ResolvesToARealUserSettingsProperty()
        {
            foreach (var descriptor in SettingDescriptors.All.Where(d => d.UserSettingsProperty != null))
            {
                var property = typeof(UserSettings).GetProperty(
                    descriptor.UserSettingsProperty!,
                    BindingFlags.Public | BindingFlags.Instance);

                Assert.True(
                    property != null,
                    $"Descriptor '{descriptor.Key}' claims per-user override '{descriptor.UserSettingsProperty}', "
                    + "which is not a public UserSettings property.");
            }
        }

        [Fact]
        public void EveryUserOverridableDescriptor_HasARealAdminDefaultProperty()
        {
            // For paired settings the descriptor key must be an actual PluginConfiguration
            // property (the admin default), not a computed/derived key.
            foreach (var descriptor in SettingDescriptors.All.Where(d => d.UserSettingsProperty != null))
            {
                var property = typeof(PluginConfiguration).GetProperty(
                    descriptor.Key,
                    BindingFlags.Public | BindingFlags.Instance);

                Assert.True(
                    property != null,
                    $"Descriptor '{descriptor.Key}' declares a per-user override but its key is not "
                    + "a PluginConfiguration property, so there is no admin default to seed from.");
            }
        }

        [Fact]
        public void PairedProperties_HaveCompatibleTypes()
        {
            // Same underlying type modulo nullability (the *TagOrder pairs are int admin-side
            // and int? user-side; that historical mismatch is tolerated, a bool↔string drift is not).
            foreach (var descriptor in SettingDescriptors.All.Where(d => d.UserSettingsProperty != null))
            {
                var adminType = typeof(PluginConfiguration)
                    .GetProperty(descriptor.Key, BindingFlags.Public | BindingFlags.Instance)?
                    .PropertyType;
                var userType = typeof(UserSettings)
                    .GetProperty(descriptor.UserSettingsProperty!, BindingFlags.Public | BindingFlags.Instance)?
                    .PropertyType;

                if (adminType == null || userType == null)
                {
                    continue; // covered by the resolution tests above
                }

                var adminUnderlying = Nullable.GetUnderlyingType(adminType) ?? adminType;
                var userUnderlying = Nullable.GetUnderlyingType(userType) ?? userType;

                Assert.True(
                    adminUnderlying == userUnderlying,
                    $"Type drift for '{descriptor.Key}' ↔ 'UserSettings.{descriptor.UserSettingsProperty}': "
                    + $"admin default is {adminType.Name}, per-user override is {userType.Name}.");
            }
        }
    }
}
