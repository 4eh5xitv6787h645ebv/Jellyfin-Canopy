using Jellyfin.Plugin.JellyfinElevate.Configuration;
using Jellyfin.Plugin.JellyfinElevate.Services.Jellyseerr;
using Jellyfin.Plugin.JellyfinElevate.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.Services;

/// <summary>
/// Covers the pure helpers on <see cref="JellyseerrClient"/> (formerly
/// JellyseerrUserResolver, now folded into the one Seerr client).
/// NormalizeUserId decides cache-key identity for the process-wide Jellyseerr
/// user caches, and GetConfiguredUrls decides which base URLs the plugin fans
/// requests out to — both must be stable across refactors.
/// </summary>
public class JellyseerrClientTests
{
    // ─── NormalizeUserId ─────────────────────────────────────────────────────

    [Theory]
    [InlineData("ABCDEF12-3456-7890-ABCD-EF1234567890", "abcdef1234567890abcdef1234567890")] // hyphenated uppercase GUID
    [InlineData("abcdef12-3456-7890-abcd-ef1234567890", "abcdef1234567890abcdef1234567890")] // hyphenated lowercase GUID
    [InlineData("abcdef1234567890abcdef1234567890", "abcdef1234567890abcdef1234567890")]     // already canonical
    [InlineData("ABCDEF1234567890ABCDEF1234567890", "abcdef1234567890abcdef1234567890")]     // 32-hex uppercase
    [InlineData("", "")]
    public void NormalizeUserId_StripsDashesAndLowercases(string input, string expected)
    {
        Assert.Equal(expected, JellyseerrClient.NormalizeUserId(input));
    }

    [Fact]
    public void NormalizeUserId_AllGuidRenderings_ProduceTheSameKey()
    {
        // The three call patterns that historically produced distinct keys must collapse to one.
        var guid = Guid.Parse("abcdef12-3456-7890-abcd-ef1234567890");

        var canonical = JellyseerrClient.NormalizeUserId(guid.ToString("N"));
        var hyphenated = JellyseerrClient.NormalizeUserId(guid.ToString());
        var uppercased = JellyseerrClient.NormalizeUserId(guid.ToString().ToUpperInvariant());

        Assert.Equal(canonical, hyphenated);
        Assert.Equal(canonical, uppercased);
    }

    // ─── GetConfiguredUrls ───────────────────────────────────────────────────

    [Fact]
    public void GetConfiguredUrls_Null_ReturnsEmpty()
    {
        Assert.Empty(JellyseerrClient.GetConfiguredUrls(null));
    }

    [Fact]
    public void GetConfiguredUrls_BlankAndWhitespaceEntries_AreDropped()
    {
        Assert.Empty(JellyseerrClient.GetConfiguredUrls("  \n , ,\r\n  "));
    }

    [Fact]
    public void GetConfiguredUrls_SplitsOnNewlinesAndCommas_TrimsAndStripsTrailingSlash()
    {
        var urls = JellyseerrClient.GetConfiguredUrls(
            " http://seerr-a:5055/ \r\nhttp://seerr-b:5055,  https://seerr-c/base/ \n");

        Assert.Equal(
            new[] { "http://seerr-a:5055", "http://seerr-b:5055", "https://seerr-c/base" },
            urls);
    }

    [Fact]
    public void GetConfiguredUrls_EntryOfOnlySlashes_IsDropped()
    {
        // "/" trims to empty after TrimEnd('/') and must not survive as an empty base URL.
        var urls = JellyseerrClient.GetConfiguredUrls("/,http://seerr:5055");

        Assert.Equal(new[] { "http://seerr:5055" }, urls);
    }

    // ─── IPluginConfigProvider seam ──────────────────────────────────────────

    private static JellyseerrClient NewClient(FakePluginConfigProvider provider)
        => new(new ThrowingHttpClientFactory(), NullLogger<JellyseerrClient>.Instance, null!, new SeerrCache(provider), provider, null!);

    [Fact]
    public async Task GetJellyseerrUserId_ReadsConfigThroughInjectedProvider_AndSkipsWorkWhenUnconfigured()
    {
        // Plugin not loaded (provider returns null): resolver must bail out
        // before any HTTP call — the throwing factory proves no request is made.
        var provider = new FakePluginConfigProvider(config: null);
        var client = NewClient(provider);
        Assert.Null(await client.GetJellyseerrUserId("abcdef1234567890abcdef1234567890"));

        // Live provider re-read: same client, config appears but without
        // URL/API key — the config-gate still short-circuits before HTTP.
        provider.Current = new PluginConfiguration { JellyseerrUrls = "", JellyseerrApiKey = "" };
        Assert.Null(await client.GetJellyseerrUserId("abcdef1234567890abcdef1234567890"));
    }

    private sealed class ThrowingHttpClientFactory : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) =>
            throw new InvalidOperationException("Unexpected outbound HTTP call: the config gate should have short-circuited.");
    }
}
