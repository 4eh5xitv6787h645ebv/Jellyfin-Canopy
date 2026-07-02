using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Jellyseerr;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Jellyseerr
{
    /// <summary>
    /// Singleton implementation of <see cref="ISeerrCache"/>. Fields, locks,
    /// TTL helpers and clear semantics moved verbatim from the former static
    /// <c>Controllers.SeerrCaches</c>; only the storage changed from static to
    /// instance (a single instance is guaranteed by the DI singleton
    /// registration in <see cref="PluginServiceRegistrator"/>).
    /// </summary>
    public sealed class SeerrCache : ISeerrCache
    {
        // TRANSITIONAL: JellyfinEnhanced (BasePlugin) is not DI-resolved, but its
        // UpdateConfiguration override must clear the same cache instance the
        // controllers use. The single DI registration constructs exactly one
        // SeerrCache, whose constructor publishes itself here. Remove once the
        // plugin lifecycle itself is DI-aware.
        public static SeerrCache? Instance { get; private set; }

        public SeerrCache()
        {
            Instance = this;
        }

        // Server-side cache for proxied avatar images to avoid re-fetching from
        // upstream Seerr on every request. Entries expire after 1 hour.
        public ConcurrentDictionary<string, (byte[] Content, string ContentType, string ETag, DateTime CachedAt)> AvatarCache { get; } = new();

        public TimeSpan AvatarCacheDuration { get; } = TimeSpan.FromHours(1);

        // Cache for Seerr user ID lookups (JellyfinUserId -> SeerrUserId)
        public Dictionary<string, (string JellyseerrUserId, DateTime CachedAt)> UserIdCache { get; } = new();

        public object UserIdCacheLock { get; } = new();

        // Cache for Seerr user lookups (JellyfinUserId -> full Seerr user payload, null = negative cache)
        public Dictionary<string, (JellyseerrUser? User, DateTime CachedAt)> UserCache { get; } = new();

        public object UserCacheLock { get; } = new();

        // Cache for Seerr proxy responses (discovery/search endpoints)
        public Dictionary<string, (string Content, DateTime CachedAt)> ResponseCache { get; } = new();

        public object ResponseCacheLock { get; } = new();

        // Throttle for manual user import
        public DateTime LastManualImport { get; set; } = DateTime.MinValue;

        public object ImportThrottleLock { get; } = new();

        // cache the result of /api/v1/status probes so a Seerr outage
        // doesn't cause every failed proxy call to issue a fresh status check.
        // Negative-cached for 30s; positive results expire on the same TTL.
        public (bool Active, DateTime CachedAt)? SeerrStatusCache { get; set; }

        public object SeerrStatusCacheLock { get; } = new();

        public TimeSpan SeerrStatusCacheTtl { get; } = TimeSpan.FromSeconds(30);

        // Cache for request-page TMDB enrichments (movie/tv detail lookups via Jellyseerr)
        public Dictionary<string, (TmdbEnrichmentResult Data, DateTime CachedAt)> TmdbEnrichmentCache { get; } = new();

        public object TmdbEnrichmentCacheLock { get; } = new();

        public ConcurrentDictionary<string, Task<TmdbEnrichmentResult>> TmdbEnrichmentInFlight { get; } = new();

        public TimeSpan GetResponseCacheTtl()
        {
            var minutes = JellyfinEnhanced.Instance?.Configuration?.JellyseerrResponseCacheTtlMinutes ?? 10;
            return TimeSpan.FromMinutes(Math.Max(1, minutes));
        }

        public TimeSpan GetUserIdCacheTtl()
        {
            var minutes = JellyfinEnhanced.Instance?.Configuration?.JellyseerrUserIdCacheTtlMinutes ?? 30;
            return TimeSpan.FromMinutes(Math.Max(1, minutes));
        }

        public TimeSpan GetTmdbEnrichmentCacheTtl()
        {
            var minutes = JellyfinEnhanced.Instance?.Configuration?.JellyseerrResponseCacheTtlMinutes ?? 10;
            return TimeSpan.FromMinutes(Math.Max(1, minutes));
        }

        public void ClearUserCaches()
        {
            lock (UserCacheLock)
            {
                UserCache.Clear();
            }

            lock (UserIdCacheLock)
            {
                UserIdCache.Clear();
            }
        }

        public void ClearAllSeerrCachesOnConfigChange()
        {
            ClearUserCaches();
            lock (ResponseCacheLock)
            {
                ResponseCache.Clear();
            }
            lock (TmdbEnrichmentCacheLock)
            {
                TmdbEnrichmentCache.Clear();
            }
            // Avatar cache may reference the OLD Seerr URL — clear it too.
            AvatarCache.Clear();
            // also flush the cached status probe so admins see fresh
            // reachability immediately after fixing config.
            lock (SeerrStatusCacheLock) { SeerrStatusCache = null; }
        }
    }
}
