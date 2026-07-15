using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Model.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

/// <summary>
/// Covers the clear semantics of <see cref="SeerrCache"/> (formerly the static
/// SeerrCaches holder): the config-change hook must flush every Seerr-related
/// cache, while the post-import <c>ClearUserCaches</c> must flush only the
/// user/user-id caches and leave response/enrichment/avatar entries intact.
/// </summary>
public class SeerrCacheTests
{
    private static SeerrCache NewCache(PluginConfiguration? config = null) =>
        new(new FakePluginConfigProvider(config));

    private static SeerrCache PopulatedCache()
    {
        var cache = NewCache();
        cache.UserIdCache["jf-user-a"] = ("1", DateTime.UtcNow, 1, "test-generation");
        cache.UserIdCache["jf-user-b"] = ("2", DateTime.UtcNow, 1, "test-generation");
        cache.UserCache["jf-user-a"] = (new SeerrUser { Id = 1 }, DateTime.UtcNow, 1, "test-generation");
        cache.UserCache["jf-user-b"] = (null, DateTime.UtcNow, 1, "test-generation"); // negative entry
        cache.AutoImportFailureThrottle["jf-user-c"] = DateTime.UtcNow;
        cache.ResponseCache["jf-user-a:/api/v1/discover/movies"] = ("{}", DateTime.UtcNow, 1, "test-generation");
        cache.TmdbEnrichmentCache["movie:1"] = (new TmdbEnrichmentResult { Title = "T" }, DateTime.UtcNow, 1);
        cache.Public4kSettingsCache["http://seerr:5055"] = (true, true, DateTime.UtcNow, 1, "fingerprint");
        cache.CertScoreCache["movie:1"] = (12, null, null, null, DateTime.UtcNow);
        cache.AvatarCache["avatar-key"] = (new byte[] { 1 }, "image/png", "etag", DateTime.UtcNow);
        cache.SeerrStatusCache = (true, DateTime.UtcNow);
        Assert.True(cache.TryReserveManualImport("generation-a", DateTime.UtcNow));
        return cache;
    }

    [Fact]
    public void ClearAllSeerrCachesOnConfigChange_EmptiesEveryPopulatedCache()
    {
        var cache = PopulatedCache();

        cache.ClearAllSeerrCachesOnConfigChange();

        Assert.Empty(cache.UserIdCache);
        Assert.Empty(cache.UserCache);
        Assert.Empty(cache.AutoImportFailureThrottle);
        Assert.Empty(cache.ResponseCache);
        Assert.Empty(cache.TmdbEnrichmentCache);
        Assert.Empty(cache.Public4kSettingsCache);
        Assert.Empty(cache.CertScoreCache);
        Assert.Empty(cache.AvatarCache);
        Assert.Null(cache.SeerrStatusCache);
        Assert.True(cache.TryReserveManualImport("generation-a", DateTime.UtcNow));
    }

    [Fact]
    public void ClearUserCaches_ClearsOnlyUserCaches_LeavesOtherCachesIntact()
    {
        var cache = PopulatedCache();

        cache.ClearUserCaches();

        // user-scoped caches are flushed...
        Assert.Empty(cache.UserIdCache);
        Assert.Empty(cache.UserCache);
        Assert.Empty(cache.AutoImportFailureThrottle);
        // ...but non-user caches keep their entries.
        Assert.Single(cache.ResponseCache);
        Assert.Single(cache.TmdbEnrichmentCache);
        Assert.Single(cache.Public4kSettingsCache);
        Assert.Single(cache.CertScoreCache);
        Assert.Single(cache.AvatarCache);
        Assert.NotNull(cache.SeerrStatusCache);
        Assert.False(cache.TryReserveManualImport("generation-a", DateTime.UtcNow));
    }

    [Fact]
    public void ManualImportThrottle_IsGenerationScopedAndOldReleaseCannotClearReplacement()
    {
        var cache = NewCache();
        var now = new DateTime(2026, 7, 16, 0, 0, 0, DateTimeKind.Utc);

        Assert.True(cache.TryReserveManualImport("generation-a", now));
        Assert.False(cache.TryReserveManualImport("generation-a", now.AddSeconds(1)));
        Assert.True(cache.TryReserveManualImport("generation-b", now.AddSeconds(1)));

        cache.ReleaseManualImport("generation-a");
        Assert.False(cache.TryReserveManualImport("generation-b", now.AddSeconds(2)));

        cache.ReleaseManualImport("generation-b");
        Assert.True(cache.TryReserveManualImport("generation-b", now.AddSeconds(2)));
    }

    [Fact]
    public void PolicyInvalidation_FencesWatchlistGenerationAndClearsSharedActiveState()
    {
        var provider = new FakePluginConfigProvider(new PluginConfiguration
        {
            SeerrEnabled = false,
            SeerrUrls = "http://seerr:5055",
            SeerrApiKey = "retained-key",
        });
        var cache = PopulatedCache();
        var watchlist = new WatchlistMonitor(
            null!,
            null!,
            null!,
            null!,
            null!,
            NullLogger<WatchlistMonitor>.Instance,
            provider);
        var generation = watchlist.ConfigurationGenerationNumber;

        var failures = SeerrIntegrationPolicy.InvalidateCachedActiveState(cache, watchlist);

        Assert.Empty(failures);
        Assert.Equal(generation + 1, watchlist.ConfigurationGenerationNumber);
        Assert.Empty(cache.UserCache);
        Assert.Empty(cache.ResponseCache);
        Assert.Empty(cache.AvatarCache);
        Assert.Empty(cache.Public4kSettingsCache);
        Assert.Empty(cache.CertScoreCache);
        Assert.Null(cache.SeerrStatusCache);
        watchlist.Dispose();
    }

    [Fact]
    public void CacheTtls_AreReadThroughConfigProvider()
    {
        var cache = NewCache(new PluginConfiguration
        {
            SeerrUserIdCacheTtlMinutes = 45,
            SeerrResponseCacheTtlMinutes = 7,
        });

        Assert.Equal(TimeSpan.FromMinutes(45), cache.GetUserIdCacheTtl());
        Assert.Equal(TimeSpan.FromMinutes(7), cache.GetResponseCacheTtl());
        // enrichment TTL intentionally shares the response-cache setting
        Assert.Equal(TimeSpan.FromMinutes(7), cache.GetTmdbEnrichmentCacheTtl());
    }

    [Fact]
    public void CacheTtls_FallBackToDefaults_WhenPluginNotLoaded()
    {
        var cache = NewCache(config: null);

        Assert.Equal(TimeSpan.FromMinutes(30), cache.GetUserIdCacheTtl());
        Assert.Equal(TimeSpan.FromMinutes(10), cache.GetResponseCacheTtl());
    }

    [Fact]
    public void CacheTtls_ClampToOneMinute_AndReReadLiveConfig()
    {
        var provider = new FakePluginConfigProvider(new PluginConfiguration
        {
            SeerrResponseCacheTtlMinutes = 0, // admin typo: clamp, don't disable
        });
        var cache = new SeerrCache(provider);

        Assert.Equal(TimeSpan.FromMinutes(1), cache.GetResponseCacheTtl());

        // The provider contract is LIVE reads: an admin save (new config object)
        // must be visible on the very next access, with no snapshotting.
        provider.Current = new PluginConfiguration { SeerrResponseCacheTtlMinutes = 25 };
        Assert.Equal(TimeSpan.FromMinutes(25), cache.GetResponseCacheTtl());
    }
}
