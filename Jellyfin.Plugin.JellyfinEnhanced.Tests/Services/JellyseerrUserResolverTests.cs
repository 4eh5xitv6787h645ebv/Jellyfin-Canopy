using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Tests.TestDoubles;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
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

    // ─── IPluginConfigProvider seam ──────────────────────────────────────────

    private static JellyseerrUserResolver NewResolver(FakePluginConfigProvider provider, string tempDir)
    {
        var logger = new Logger(new SeamStubAppPaths(tempDir), NullLoggerFactory.Instance);
        return new JellyseerrUserResolver(new ThrowingHttpClientFactory(), logger, provider, "[Test]");
    }

    [Fact]
    public async Task GetJellyseerrUserId_ReadsConfigThroughInjectedProvider_AndSkipsWorkWhenUnconfigured()
    {
        var tempDir = Path.Combine(Path.GetTempPath(), "je-resolver-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDir);
        try
        {
            // Plugin not loaded (provider returns null): resolver must bail out
            // before any HTTP call — the throwing factory proves no request is made.
            var provider = new FakePluginConfigProvider(config: null);
            var resolver = NewResolver(provider, tempDir);
            Assert.Null(await resolver.GetJellyseerrUserId("abcdef1234567890abcdef1234567890"));

            // Live provider re-read: same resolver, config appears but without
            // URL/API key — the config-gate still short-circuits before HTTP.
            provider.Current = new PluginConfiguration { JellyseerrUrls = "", JellyseerrApiKey = "" };
            Assert.Null(await resolver.GetJellyseerrUserId("abcdef1234567890abcdef1234567890"));
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { /* best effort */ }
        }
    }

    private sealed class ThrowingHttpClientFactory : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) =>
            throw new InvalidOperationException("Unexpected outbound HTTP call: the config gate should have short-circuited.");
    }

    /// <summary>Minimal IApplicationPaths so the plugin's file Logger can be constructed in tests.</summary>
    private sealed class SeamStubAppPaths : IApplicationPaths
    {
        private readonly string _baseDir;

        public SeamStubAppPaths(string baseDir) => _baseDir = baseDir;

        public string ProgramDataPath => _baseDir;
        public string WebPath => _baseDir;
        public string ProgramSystemPath => _baseDir;
        public string DataPath => _baseDir;
        public string ImageCachePath => _baseDir;
        public string PluginsPath => _baseDir;
        public string PluginConfigurationsPath => _baseDir;
        public string LogDirectoryPath => _baseDir;
        public string ConfigurationDirectoryPath => _baseDir;
        public string SystemConfigurationFilePath => Path.Combine(_baseDir, "system.xml");
        public string CachePath => _baseDir;
        public string TempDirectory => _baseDir;
        public string VirtualDataPath => _baseDir;
        public string TrickplayPath => _baseDir;
        public string BackupPath => _baseDir;

        public void MakeSanityCheckOrThrow()
        {
        }

        public void CreateAndCheckMarker(string path, string markerName, bool recursive = false)
        {
        }
    }
}
