using Jellyfin.Plugin.JellyfinEnhanced.Services.Jellyseerr;
using Xunit;

namespace Jellyfin.Plugin.JellyfinEnhanced.Tests.Services;

/// <summary>
/// Covers the pure helpers on <see cref="JellyseerrUserResolver"/> (hoisted from the
/// two auto-request services). NormalizeUserId decides cache-key identity for the
/// process-wide Jellyseerr user-id cache, and GetConfiguredUrls decides which base
/// URLs the plugin fans requests out to — both must be stable across refactors.
/// </summary>
public class JellyseerrUserResolverTests
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
        Assert.Equal(expected, JellyseerrUserResolver.NormalizeUserId(input));
    }

    [Fact]
    public void NormalizeUserId_AllGuidRenderings_ProduceTheSameKey()
    {
        // The three call patterns that historically produced distinct keys must collapse to one.
        var guid = Guid.Parse("abcdef12-3456-7890-abcd-ef1234567890");

        var canonical = JellyseerrUserResolver.NormalizeUserId(guid.ToString("N"));
        var hyphenated = JellyseerrUserResolver.NormalizeUserId(guid.ToString());
        var uppercased = JellyseerrUserResolver.NormalizeUserId(guid.ToString().ToUpperInvariant());

        Assert.Equal(canonical, hyphenated);
        Assert.Equal(canonical, uppercased);
    }

    // ─── GetConfiguredUrls ───────────────────────────────────────────────────

    [Fact]
    public void GetConfiguredUrls_Null_ReturnsEmpty()
    {
        Assert.Empty(JellyseerrUserResolver.GetConfiguredUrls(null));
    }

    [Fact]
    public void GetConfiguredUrls_BlankAndWhitespaceEntries_AreDropped()
    {
        Assert.Empty(JellyseerrUserResolver.GetConfiguredUrls("  \n , ,\r\n  "));
    }

    [Fact]
    public void GetConfiguredUrls_SplitsOnNewlinesAndCommas_TrimsAndStripsTrailingSlash()
    {
        var urls = JellyseerrUserResolver.GetConfiguredUrls(
            " http://seerr-a:5055/ \r\nhttp://seerr-b:5055,  https://seerr-c/base/ \n");

        Assert.Equal(
            new[] { "http://seerr-a:5055", "http://seerr-b:5055", "https://seerr-c/base" },
            urls);
    }

    [Fact]
    public void GetConfiguredUrls_EntryOfOnlySlashes_IsDropped()
    {
        // "/" trims to empty after TrimEnd('/') and must not survive as an empty base URL.
        var urls = JellyseerrUserResolver.GetConfiguredUrls("/,http://seerr:5055");

        Assert.Equal(new[] { "http://seerr:5055" }, urls);
    }
}
