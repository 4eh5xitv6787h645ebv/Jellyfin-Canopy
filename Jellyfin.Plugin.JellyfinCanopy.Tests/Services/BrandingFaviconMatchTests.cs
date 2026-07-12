using Jellyfin.Plugin.JellyfinCanopy.Services;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

/// <summary>
/// SRV-4: the favicon override pattern required a content-hash segment
/// (<c>^favicon\..*\.ico$</c>), so the bare <c>favicon.ico</c> jellyfin-web
/// actually serves never matched and a custom favicon was never applied. Both
/// the bare and hashed forms must now map to the on-disk favicon override.
/// </summary>
public class BrandingFaviconMatchTests
{
    [Theory]
    [InlineData("/web/favicon.ico")]              // bare — was never matched before
    [InlineData("/web/favicon.b1946ac9.ico")]     // content-hashed form still matches
    [InlineData("/web/FAVICON.ICO")]              // case-insensitive
    public void Favicon_BareAndHashed_MapToOverride(string path)
    {
        Assert.Equal("favicon.ico", BrandingAssetStartupFilter.MatchBrandingAsset(path));
    }

    [Theory]
    [InlineData("/web/icon-transparent.abc.png", "icon-transparent.png")] // other assets unaffected
    [InlineData("/web/favicon.png", null)]      // not an .ico
    [InlineData("/web/notfavicon.ico", null)]   // must anchor on the favicon basename
    [InlineData("/api/favicon.ico", null)]      // only under /web/
    public void OtherPaths_MapAsExpected(string path, string? expected)
    {
        Assert.Equal(expected, BrandingAssetStartupFilter.MatchBrandingAsset(path));
    }
}
