using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Tests.TestDoubles;
using Xunit;

namespace Jellyfin.Plugin.JellyfinEnhanced.Tests.Services;

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
        cache.UserIdCache["jf-user-a"] = ("1", DateTime.UtcNow);
        cache.UserIdCache["jf-user-b"] = ("2", DateTime.UtcNow);
        cache.UserCache["jf-user-a"] = (new JellyseerrUser { Id = 1 }, DateTime.UtcNow);
        cache.UserCache["jf-user-b"] = (null, DateTime.UtcNow); // negative entry
        cache.ResponseCache["jf-user-a:/api/v1/discover/movies"] = ("{}", DateTime.UtcNow);
        cache.TmdbEnrichmentCache["movie:1"] = (new TmdbEnrichmentResult { Title = "T" }, DateTime.UtcNow);
        cache.AvatarCache["avatar-key"] = (new byte[] { 1 }, "image/png", "etag", DateTime.UtcNow);
        cache.SeerrStatusCache = (true, DateTime.UtcNow);
        return cache;
    }

    [Fact]
    public void ClearAllSeerrCachesOnConfigChange_EmptiesEveryPopulatedCache()
    {
        var cache = PopulatedCache();

        cache.ClearAllSeerrCachesOnConfigChange();

        Assert.Empty(cache.UserIdCache);
        Assert.Empty(cache.UserCache);
        Assert.Empty(cache.ResponseCache);
        Assert.Empty(cache.TmdbEnrichmentCache);
        Assert.Empty(cache.AvatarCache);
        Assert.Null(cache.SeerrStatusCache);
    }

    [Fact]
    public void ClearUserCaches_ClearsOnlyUserCaches_LeavesOtherCachesIntact()
    {
        var cache = PopulatedCache();

        cache.ClearUserCaches();

        // user-scoped caches are flushed...
        Assert.Empty(cache.UserIdCache);
        Assert.Empty(cache.UserCache);
        // ...but non-user caches keep their entries.
        Assert.Single(cache.ResponseCache);
        Assert.Single(cache.TmdbEnrichmentCache);
        Assert.Single(cache.AvatarCache);
        Assert.NotNull(cache.SeerrStatusCache);
    }

    [Fact]
    public void Constructor_PublishesTransitionalStaticInstance()
    {
        // The plugin's UpdateConfiguration hook clears caches through
        // SeerrCache.Instance; it must point at the most recently constructed
        // (i.e. the DI-singleton) instance.
        var cache = NewCache();
        Assert.Same(cache, SeerrCache.Instance);

        cache.UserIdCache["jf-user-a"] = ("1", DateTime.UtcNow);
        SeerrCache.Instance!.ClearAllSeerrCachesOnConfigChange();
        Assert.Empty(cache.UserIdCache);
    }

    [Fact]
    public void CacheTtls_AreReadThroughConfigProvider()
    {
        var cache = NewCache(new PluginConfiguration
        {
            JellyseerrUserIdCacheTtlMinutes = 45,
            JellyseerrResponseCacheTtlMinutes = 7,
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
            JellyseerrResponseCacheTtlMinutes = 0, // admin typo: clamp, don't disable
        });
        var cache = new SeerrCache(provider);

        Assert.Equal(TimeSpan.FromMinutes(1), cache.GetResponseCacheTtl());

        // The provider contract is LIVE reads: an admin save (new config object)
        // must be visible on the very next access, with no snapshotting.
        provider.Current = new PluginConfiguration { JellyseerrResponseCacheTtlMinutes = 25 };
        Assert.Equal(TimeSpan.FromMinutes(25), cache.GetResponseCacheTtl());
    }
}
