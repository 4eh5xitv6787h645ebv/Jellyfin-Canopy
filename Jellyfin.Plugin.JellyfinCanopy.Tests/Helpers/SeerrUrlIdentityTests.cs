using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Helpers;

public sealed class SeerrUrlIdentityTests
{
    [Fact]
    public void ConfiguredUrls_CanonicalizeSchemeHostDefaultPortAndTrailingSlash()
    {
        var urls = SeerrClient.GetConfiguredUrls(
            "HTTP://SEERR.EXAMPLE:80/,http://seerr.example\nHTTPS://SEERR.EXAMPLE:443/,https://seerr.example");

        Assert.Equal(
            new[] { "http://seerr.example", "https://seerr.example" },
            urls);
    }

    [Fact]
    public void ConfiguredUrls_PreserveCaseSensitiveReverseProxyPaths()
    {
        var urls = SeerrClient.GetConfiguredUrls(
            "HTTP://SEERR:5055/Tenant/,http://seerr:5055/tenant");

        Assert.Equal(
            new[] { "http://seerr:5055/Tenant", "http://seerr:5055/tenant" },
            urls);
    }

    [Fact]
    public void ConfiguredUrls_CollapseDnsAbsoluteNameTrailingDotAliases()
    {
        var urls = SeerrClient.GetConfiguredUrls(
            "http://seerr.example.:5055/Tenant,http://seerr.example:5055/Tenant");

        Assert.Equal(new[] { "http://seerr.example:5055/Tenant" }, urls);
    }

    [Fact]
    public void ConfiguredUrls_DoNotRepairMultipleTrailingDnsDotsIntoAnotherHost()
    {
        var urls = SeerrClient.GetConfiguredUrls(
            "http://seerr.example..:5055,http://seerr.example:5055");

        Assert.Equal(
            new[] { "http://seerr.example..:5055", "http://seerr.example:5055" },
            urls);
    }

    [Fact]
    public void ConfiguredUrls_DoNotRepairDnsRootOnlyHost()
    {
        Assert.Equal(new[] { "http://." }, SeerrClient.GetConfiguredUrls("http://."));
    }
}
