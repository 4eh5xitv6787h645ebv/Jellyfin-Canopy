using Jellyfin.Plugin.JellyfinEnhanced.Model.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Jellyseerr;
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
    private static SeerrCache PopulatedCache()
    {
        var cache = new SeerrCache();
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
        var cache = new SeerrCache();
        Assert.Same(cache, SeerrCache.Instance);

        cache.UserIdCache["jf-user-a"] = ("1", DateTime.UtcNow);
        SeerrCache.Instance!.ClearAllSeerrCachesOnConfigChange();
        Assert.Empty(cache.UserIdCache);
    }
}
