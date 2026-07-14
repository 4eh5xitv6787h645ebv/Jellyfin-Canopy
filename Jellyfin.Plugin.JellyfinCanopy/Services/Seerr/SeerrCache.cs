using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Model.Seerr;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Seerr
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
        private readonly IPluginConfigProvider _configProvider;

        public SeerrCache(IPluginConfigProvider configProvider)
        {
            _configProvider = configProvider;
        }

        // Server-side cache for proxied avatar images to avoid re-fetching from
        // upstream Seerr on every request. Entries expire after 1 hour.
        public ConcurrentDictionary<string, (byte[] Content, string ContentType, string ETag, DateTime CachedAt)> AvatarCache { get; } = new();

        public TimeSpan AvatarCacheDuration { get; } = TimeSpan.FromHours(1);

        // Cache for Seerr user ID lookups (JellyfinUserId -> SeerrUserId)
        public Dictionary<string, (string SeerrUserId, DateTime CachedAt, long ConfigurationRevision, string ConfigurationIdentity)> UserIdCache { get; } = new();

        public object UserIdCacheLock { get; } = new();

        // Cache for Seerr user lookups (JellyfinUserId -> full Seerr user payload, null = negative cache)
        public Dictionary<string, (SeerrUser? User, DateTime CachedAt, long ConfigurationRevision, string ConfigurationIdentity)> UserCache { get; } = new();

        public object UserCacheLock { get; } = new();

        // A non-authoritative, short-lived retry guard for failed automatic
        // imports. The timestamp is written before the POST and retained only
        // when its outcome is incomplete, preventing concurrent/repeated
        // requests from creating an import storm without publishing absence.
        public Dictionary<string, DateTime> AutoImportFailureThrottle { get; } = new();

        public object AutoImportFailureThrottleLock { get; } = new();

        public TimeSpan AutoImportFailureThrottleTtl { get; } = TimeSpan.FromSeconds(60);

        // Cache for Seerr proxy responses (discovery/search endpoints)
        public Dictionary<string, (string Content, DateTime CachedAt, long ConfigurationRevision, string ConfigurationIdentity)> ResponseCache { get; } = new();

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

        // Source-keyed cache of Seerr's /api/v1/settings/public 4K flags.
        public Dictionary<string, (bool Movie4kEnabled, bool Series4kEnabled, DateTime CachedAt, long ConfigurationRevision, string ApiKeyFingerprint)> Public4kSettingsCache { get; } = new(StringComparer.Ordinal);

        public object Public4kSettingsCacheLock { get; } = new();

        public TimeSpan Public4kSettingsCacheTtl { get; } = TimeSpan.FromMinutes(5);

        // Cache for request-page TMDB enrichments (movie/tv detail lookups via Seerr)
        public Dictionary<string, (TmdbEnrichmentResult Data, DateTime CachedAt, long ConfigurationRevision)> TmdbEnrichmentCache { get; } = new();

        public object TmdbEnrichmentCacheLock { get; } = new();

        public ConcurrentDictionary<string, Lazy<Task<TmdbEnrichmentResult>>> TmdbEnrichmentInFlight { get; } = new();

        // User-independent cache of a title's resolved parental signals. The
        // title/region prefix is generation-scoped by revision plus a digest of
        // source, credentials, and full configuration. Null Score =
        // unrated/unknown; null Keywords = tag data not fetched (light
        // cert-only endpoint) — a tag-rule pass treats that as a miss.
        public ConcurrentDictionary<string, (int? Score, int? SubScore, string[]? Keywords, string[]? Genres, DateTime CachedAt)> CertScoreCache { get; } = new();

        public TimeSpan GetResponseCacheTtl()
        {
            var minutes = _configProvider.ConfigurationOrNull?.SeerrResponseCacheTtlMinutes ?? 10;
            return TimeSpan.FromMinutes(Math.Max(1, minutes));
        }

        public TimeSpan GetParentalRatingCacheTtl()
        {
            var minutes = _configProvider.ConfigurationOrNull?.SeerrParentalRatingCacheTtlMinutes ?? 1440;
            return TimeSpan.FromMinutes(Math.Max(1, minutes));
        }

        public TimeSpan GetUserIdCacheTtl()
        {
            var minutes = _configProvider.ConfigurationOrNull?.SeerrUserIdCacheTtlMinutes ?? 30;
            return TimeSpan.FromMinutes(Math.Max(1, minutes));
        }

        public TimeSpan GetTmdbEnrichmentCacheTtl()
        {
            var minutes = _configProvider.ConfigurationOrNull?.SeerrResponseCacheTtlMinutes ?? 10;
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

            lock (AutoImportFailureThrottleLock)
            {
                AutoImportFailureThrottle.Clear();
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
            // Certification scores are user-independent, but flush on config change
            // anyway so a changed DEFAULT_REGION re-resolves ratings immediately.
            CertScoreCache.Clear();
            // Avatar cache may reference the OLD Seerr URL — clear it too.
            AvatarCache.Clear();
            // also flush the cached status probe so admins see fresh
            // reachability immediately after fixing config.
            lock (SeerrStatusCacheLock) { SeerrStatusCache = null; }
            // Flush the cached 4K capability so a changed Seerr URL / key
            // re-resolves movie4kEnabled/series4kEnabled immediately.
            lock (Public4kSettingsCacheLock) { Public4kSettingsCache.Clear(); }
        }
    }
}
