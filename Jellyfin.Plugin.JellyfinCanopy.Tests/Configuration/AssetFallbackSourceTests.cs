using System.Text.RegularExpressions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Configuration
{
    /// <summary>Guards the no-third-party-browser-assets half of the local mirror contract.</summary>
    public sealed class AssetFallbackSourceTests
    {
        private static readonly Regex AutomaticRemoteAsset = new(
            "(?:src|srcset)\\s*=\\s*['\"]\\s*https?://" +
            "|url\\(\\s*['\"]?\\s*https?://" +
            "|@import\\s+(?:url\\()?\\s*['\"]?\\s*https?://" +
            "|onerror\\s*=\\s*['\"][^'\"]*https?://" +
            "|<link\\b[^>]*\\bhref\\s*=\\s*['\"]\\s*https?://" +
            "|(?:fetch|import)\\s*\\(\\s*['\"]\\s*https?://",
            RegexOptions.Compiled | RegexOptions.IgnoreCase);

        [Fact]
        public void ConfigPage_OutageFallbacks_CannotInitiateThirdPartyAssetRequests()
        {
            var match = AutomaticRemoteAsset.Match(ConfigPageSource.Html);

            Assert.False(match.Success, $"Automatic remote asset fallback remains in configPage.html: {match.Value}");
        }
    }
}
