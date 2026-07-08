using Jellyfin.Plugin.JellyfinElevate.Helpers;
using Xunit;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.Helpers
{
    public class ServiceUrlResolverTests
    {
        [Theory]
        [InlineData("http://sonarr:8989", true)]
        [InlineData("https://sonarr.example.com", true)]
        [InlineData("https://example.com/sonarr", true)]        // base-url/subpath
        [InlineData("  https://example.com/seerr  ", true)]     // trimmed
        [InlineData("http://[2001:db8::1]:5055", true)]         // IPv6 literal
        [InlineData("https://user:pass@example.com", true)]     // credentials-in-url
        [InlineData("", false)]
        [InlineData("   ", false)]
        [InlineData("sonarr.example.com", false)]               // no scheme
        [InlineData("ftp://example.com", false)]
        [InlineData("javascript:alert(1)", false)]
        [InlineData("file:///etc/passwd", false)]
        public void IsWellFormedHttpUrl_ClassifiesCorrectly(string? url, bool expected)
            => Assert.Equal(expected, ServiceUrlResolver.IsWellFormedHttpUrl(url));

        [Fact]
        public void ResolvePublicUrl_UsesExternalWhenWellFormed()
            => Assert.Equal("https://seerr.example.com",
                ServiceUrlResolver.ResolvePublicUrl("http://seerr:5055", "https://seerr.example.com"));

        [Fact]
        public void ResolvePublicUrl_TrimsExternal()
            => Assert.Equal("https://seerr.example.com",
                ServiceUrlResolver.ResolvePublicUrl("http://seerr:5055", "  https://seerr.example.com  "));

        [Theory]
        [InlineData(null)]
        [InlineData("")]
        [InlineData("   ")]
        [InlineData("not-a-url")]
        public void ResolvePublicUrl_FallsBackToInternalWhenExternalMissingOrMalformed(string? external)
            => Assert.Equal("http://seerr:5055",
                ServiceUrlResolver.ResolvePublicUrl("http://seerr:5055", external));

        [Fact]
        public void ResolvePublicUrl_PreservesInternalSubpath()
            => Assert.Equal("http://host/seerr",
                ServiceUrlResolver.ResolvePublicUrl("http://host/seerr", ""));

        [Theory]
        [InlineData("https://seerr.example.com", "https://seerr.example.com")]
        [InlineData("  https://seerr.example.com  ", "https://seerr.example.com")]
        [InlineData("garbage", "")]
        [InlineData("seerr.local:5055", "")]
        [InlineData("", "")]
        [InlineData(null, "")]
        public void SanitizeExternalUrl_KeepsWellFormedBlanksTheRest(string? input, string expected)
            => Assert.Equal(expected, ServiceUrlResolver.SanitizeExternalUrl(input));
    }
}
