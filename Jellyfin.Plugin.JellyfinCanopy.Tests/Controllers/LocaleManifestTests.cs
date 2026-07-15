using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers
{
    public sealed class LocaleManifestTests
    {
        [Fact]
        public void SupportedLocaleInventory_MatchesEmbeddedCatalogsExactly()
        {
            const string prefix = "Jellyfin.Plugin.JellyfinCanopy.js.locales.";
            const string suffix = ".json";
            var embeddedLocales = typeof(ConfigController).Assembly
                .GetManifestResourceNames()
                .Where(name => name.StartsWith(prefix, StringComparison.Ordinal)
                    && name.EndsWith(suffix, StringComparison.Ordinal))
                .Select(name => name.Substring(prefix.Length, name.Length - prefix.Length - suffix.Length))
                .OrderBy(name => name, StringComparer.Ordinal)
                .ToArray();
            var registeredLocales = ConfigController.SupportedLocaleCodes
                .OrderBy(name => name, StringComparer.Ordinal)
                .ToArray();

            Assert.Equal(26, registeredLocales.Length);
            Assert.Contains("en", registeredLocales);
            Assert.Equal(registeredLocales, embeddedLocales);
        }
    }
}
