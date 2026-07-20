using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Configuration
{
    public class SettingDescriptorsTests
    {
        [Fact]
        public void Registry_Materializes_WithUniqueKeys()
        {
            // BuildRegistry throws on duplicates; touching All both exercises that guard
            // and re-asserts uniqueness explicitly for a readable failure.
            var keys = SettingDescriptors.All.Select(d => d.Key).ToList();
            Assert.NotEmpty(keys);
            Assert.Equal(keys.Count, keys.Distinct(StringComparer.Ordinal).Count());
        }

        [Fact]
        public void Registry_NeverExposesSecrets()
        {
            // The registry is the whitelist; secrets must never gain a client-facing key.
            var clientFacingKeys = SettingDescriptors.All
                .Where(d => d.Exposure != SettingExposure.Neither)
                .Select(d => d.Key)
                .ToHashSet(StringComparer.OrdinalIgnoreCase);

            string[] secretProperties =
            {
                nameof(PluginConfiguration.TMDB_API_KEY),
                nameof(PluginConfiguration.SeerrApiKey),
                nameof(PluginConfiguration.SonarrApiKey),
                nameof(PluginConfiguration.RadarrApiKey),
            };

            foreach (var secret in secretProperties)
            {
                Assert.DoesNotContain(secret, clientFacingKeys);
            }
        }

        [Fact]
        public void BuildPayload_SelectsOnlyRequestedExposure()
        {
            var context = new SettingContext(new PluginConfiguration(), IsAuthenticated: true);

            var publicPayload = SettingDescriptors.BuildPayload(SettingExposure.Public, context);
            var privatePayload = SettingDescriptors.BuildPayload(SettingExposure.Private, context);

            Assert.Contains("ToastDuration", publicPayload.Keys);
            Assert.DoesNotContain("SonarrUrl", publicPayload.Keys);
            Assert.Contains("SonarrUrl", privatePayload.Keys);
            Assert.DoesNotContain("ToastDuration", privatePayload.Keys);
            // Neither-exposure pairing entries stay server-side.
            Assert.DoesNotContain("WatchProgressDefaultMode", publicPayload.Keys);
            Assert.DoesNotContain("WatchProgressDefaultMode", privatePayload.Keys);
        }

        [Fact]
        public void MaintenanceModeAffectedUsers_RedactedForAnonymous()
        {
            var config = new PluginConfiguration { MaintenanceModeAffectedUsers = "guid1,guid2" };

            var anonymous = SettingDescriptors.BuildPayload(
                SettingExposure.Public, new SettingContext(config, IsAuthenticated: false));
            var authenticated = SettingDescriptors.BuildPayload(
                SettingExposure.Public, new SettingContext(config, IsAuthenticated: true));

            // Pre-login callers must not enumerate the targeted account GUIDs.
            Assert.Equal(string.Empty, anonymous["MaintenanceModeAffectedUsers"]);
            // Authenticated callers still see the full value (unchanged behavior).
            Assert.Equal("guid1,guid2", authenticated["MaintenanceModeAffectedUsers"]);
        }

        [Fact]
        public void IntegrationCapabilityFlagsExposeConfigurationWithoutUrlsOrSecrets()
        {
            var config = new PluginConfiguration
            {
                SeerrUrls = "http://seerr.internal:5055",
                SeerrApiKey = "seerr-secret",
                SonarrInstances = """[{"Name":"Main","Url":"http://sonarr:8989","ApiKey":"sonarr-secret","Enabled":true}]""",
                RadarrInstances = """[{"Name":"Disabled","Url":"http://radarr:7878","ApiKey":"radarr-secret","Enabled":false}]""",
                BazarrUrl = "http://bazarr:6767",
            };

            var authenticated = SettingDescriptors.BuildPayload(
                SettingExposure.Public, new SettingContext(config, IsAuthenticated: true));
            Assert.Equal(true, authenticated["SeerrConfigured"]);
            Assert.Equal(true, authenticated["SonarrConfigured"]);
            Assert.Equal(false, authenticated["RadarrConfigured"]);
            Assert.Equal(true, authenticated["BazarrConfigured"]);
            Assert.DoesNotContain(nameof(PluginConfiguration.SeerrApiKey), authenticated.Keys);
            Assert.DoesNotContain(nameof(PluginConfiguration.SonarrApiKey), authenticated.Keys);
            Assert.DoesNotContain(nameof(PluginConfiguration.RadarrApiKey), authenticated.Keys);
            Assert.DoesNotContain(nameof(PluginConfiguration.SonarrInstances), authenticated.Keys);
            Assert.DoesNotContain(nameof(PluginConfiguration.RadarrInstances), authenticated.Keys);

            var anonymous = SettingDescriptors.BuildPayload(
                SettingExposure.Public, new SettingContext(config, IsAuthenticated: false));
            Assert.Equal(false, anonymous["SeerrConfigured"]);
            Assert.Equal(false, anonymous["SonarrConfigured"]);
            Assert.Equal(false, anonymous["RadarrConfigured"]);
            Assert.Equal(false, anonymous["BazarrConfigured"]);
        }
    }
}
