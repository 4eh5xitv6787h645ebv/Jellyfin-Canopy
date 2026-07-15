using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
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
        internal const int AvatarMaximumEntries = 64;
        internal const long AvatarMaximumBytes = 32 * 1024 * 1024;
        internal const int UserMaximumEntries = 2048;
        internal const long UserMaximumBytes = 4 * 1024 * 1024;
        internal const int ResponseMaximumEntries = 256;
        internal const long ResponseMaximumBytes = 32 * 1024 * 1024;
        internal const int TmdbEnrichmentMaximumEntries = 512;
        internal const long TmdbEnrichmentMaximumBytes = 4 * 1024 * 1024;
        internal const int CertificationMaximumEntries = 4096;
        internal const long CertificationMaximumBytes = 16 * 1024 * 1024;
        internal const int Public4kMaximumEntries = 64;

        private readonly IPluginConfigProvider _configProvider;
        private readonly object _importThrottleLock = new();
        private DateTime _lastManualImport = DateTime.MinValue;
        private string _lastManualImportGenerationIdentity = string.Empty;

        public SeerrCache(IPluginConfigProvider configProvider)
        {
            _configProvider = configProvider;
            AvatarCache = new(
                AvatarMaximumEntries,
                AvatarMaximumBytes,
                AvatarWeight,
                StringComparer.Ordinal,
                defaultTtl: () => AvatarCacheDuration);
            UserIdCache = new(
                UserMaximumEntries,
                UserMaximumBytes,
                UserIdWeight,
                StringComparer.Ordinal,
                defaultTtl: GetUserIdCacheTtl);
            UserCache = new(
                UserMaximumEntries,
                UserMaximumBytes,
                UserWeight,
                StringComparer.Ordinal,
                defaultTtl: GetUserIdCacheTtl);
            AutoImportFailureThrottle = new(
                maximumEntries: UserMaximumEntries,
                maximumWeight: UserMaximumEntries, // unit-weight entries
                comparer: StringComparer.Ordinal,
                defaultTtl: () => AutoImportFailureThrottleTtl);
            ResponseCache = new(
                ResponseMaximumEntries,
                ResponseMaximumBytes,
                ResponseWeight,
                StringComparer.Ordinal,
                defaultTtl: GetResponseCacheTtl);
            Public4kSettingsCache = new(
                maximumEntries: Public4kMaximumEntries,
                maximumWeight: Public4kMaximumEntries, // unit-weight entries
                comparer: StringComparer.Ordinal,
                defaultTtl: () => Public4kSettingsCacheTtl);
            TmdbEnrichmentCache = new(
                TmdbEnrichmentMaximumEntries,
                TmdbEnrichmentMaximumBytes,
                TmdbEnrichmentWeight,
                StringComparer.Ordinal,
                defaultTtl: GetTmdbEnrichmentCacheTtl);
            CertScoreCache = new(
                CertificationMaximumEntries,
                CertificationMaximumBytes,
                CertificationWeight,
                StringComparer.Ordinal,
                defaultTtl: GetParentalRatingCacheTtl);
        }

        // Server-side cache for proxied avatar images to avoid re-fetching from
        // upstream Seerr on every request. Entries expire after 1 hour.
        public BoundedTtlCache<string, (byte[] Content, string ContentType, string ETag, DateTime CachedAt)> AvatarCache { get; }

        public TimeSpan AvatarCacheDuration { get; } = TimeSpan.FromHours(1);

        // Cache for Seerr user ID lookups (JellyfinUserId -> SeerrUserId)
        public BoundedTtlCache<string, (string SeerrUserId, DateTime CachedAt, long ConfigurationRevision, string ConfigurationIdentity)> UserIdCache { get; }

        public object UserIdCacheLock { get; } = new();

        // Cache for Seerr user lookups (JellyfinUserId -> full Seerr user payload, null = negative cache)
        public BoundedTtlCache<string, (SeerrUser? User, DateTime CachedAt, long ConfigurationRevision, string ConfigurationIdentity)> UserCache { get; }

        public object UserCacheLock { get; } = new();

        // A generation-scoped, non-authoritative short retry guard for failed
        // automatic imports. The timestamp is written before the POST and
        // retained only when its outcome is incomplete, preventing a same-
        // generation storm without suppressing a replacement Seerr endpoint.
        public BoundedTtlCache<string, DateTime> AutoImportFailureThrottle { get; }

        public object AutoImportFailureThrottleLock { get; } = new();

        public TimeSpan AutoImportFailureThrottleTtl { get; } = TimeSpan.FromSeconds(60);

        // Cache for Seerr proxy responses (discovery/search endpoints)
        public BoundedTtlCache<string, (string Content, DateTime CachedAt, long ConfigurationRevision, string ConfigurationIdentity)> ResponseCache { get; }

        public object ResponseCacheLock { get; } = new();

        public bool TryReserveManualImport(string generationIdentity, DateTime utcNow)
        {
            ArgumentException.ThrowIfNullOrWhiteSpace(generationIdentity);
            lock (_importThrottleLock)
            {
                if (string.Equals(
                        _lastManualImportGenerationIdentity,
                        generationIdentity,
                        StringComparison.Ordinal)
                    && (utcNow - _lastManualImport).TotalSeconds < 30)
                {
                    return false;
                }

                _lastManualImport = utcNow;
                _lastManualImportGenerationIdentity = generationIdentity;
                return true;
            }
        }

        public void ReleaseManualImport(string generationIdentity)
        {
            ArgumentException.ThrowIfNullOrWhiteSpace(generationIdentity);
            lock (_importThrottleLock)
            {
                if (!string.Equals(
                    _lastManualImportGenerationIdentity,
                    generationIdentity,
                    StringComparison.Ordinal))
                {
                    return;
                }

                _lastManualImport = DateTime.MinValue;
                _lastManualImportGenerationIdentity = string.Empty;
            }
        }

        // cache the result of /api/v1/status probes so a Seerr outage
        // doesn't cause every failed proxy call to issue a fresh status check.
        // Negative-cached for 30s; positive results expire on the same TTL.
        public (bool Active, DateTime CachedAt)? SeerrStatusCache { get; set; }

        public object SeerrStatusCacheLock { get; } = new();

        public TimeSpan SeerrStatusCacheTtl { get; } = TimeSpan.FromSeconds(30);

        // Source-keyed cache of Seerr's /api/v1/settings/public 4K flags.
        public BoundedTtlCache<string, (bool Movie4kEnabled, bool Series4kEnabled, DateTime CachedAt, long ConfigurationRevision, string ApiKeyFingerprint)> Public4kSettingsCache { get; }

        public object Public4kSettingsCacheLock { get; } = new();

        public TimeSpan Public4kSettingsCacheTtl { get; } = TimeSpan.FromMinutes(5);

        // Cache for request-page TMDB enrichments (movie/tv detail lookups via Seerr)
        public BoundedTtlCache<string, (TmdbEnrichmentResult Data, DateTime CachedAt, long ConfigurationRevision)> TmdbEnrichmentCache { get; }

        public object TmdbEnrichmentCacheLock { get; } = new();

        public ConcurrentDictionary<string, Lazy<Task<TmdbEnrichmentResult>>> TmdbEnrichmentInFlight { get; } = new();

        // User-independent cache of a title's resolved parental signals. The
        // title/region prefix is generation-scoped by revision plus a digest of
        // source, credentials, and full configuration. Null Score =
        // unrated/unknown; null Keywords = tag data not fetched (light
        // cert-only endpoint) — a tag-rule pass treats that as a miss.
        public BoundedTtlCache<string, (int? Score, int? SubScore, string[]? Keywords, string[]? Genres, DateTime CachedAt)> CertScoreCache { get; }

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

        private static long AvatarWeight(
            string key,
            (byte[] Content, string ContentType, string ETag, DateTime CachedAt) value)
            => (key.Length * 2L)
                + value.Content.LongLength
                + (value.ContentType.Length * 2L)
                + (value.ETag.Length * 2L)
                + 128;

        private static long UserIdWeight(
            string key,
            (string SeerrUserId, DateTime CachedAt, long ConfigurationRevision, string ConfigurationIdentity) value)
            => ((key.Length + value.SeerrUserId.Length + value.ConfigurationIdentity.Length) * 2L) + 128;

        private static long UserWeight(
            string key,
            (SeerrUser? User, DateTime CachedAt, long ConfigurationRevision, string ConfigurationIdentity) value)
            => ((key.Length
                    + value.ConfigurationIdentity.Length
                    + (value.User?.JellyfinUserId?.Length ?? 0)
                    + (value.User?.SourceUrl?.Length ?? 0)) * 2L)
                + 256;

        private static long ResponseWeight(
            string key,
            (string Content, DateTime CachedAt, long ConfigurationRevision, string ConfigurationIdentity) value)
            => ((key.Length + value.Content.Length) * 2L)
                + (value.ConfigurationIdentity.Length * 2L)
                + 128;

        private static long TmdbEnrichmentWeight(
            string key,
            (TmdbEnrichmentResult Data, DateTime CachedAt, long ConfigurationRevision) value)
            => ((key.Length
                    + (value.Data.Title?.Length ?? 0)
                    + (value.Data.PosterUrl?.Length ?? 0)
                    + (value.Data.DigitalReleaseDate?.Length ?? 0)
                    + (value.Data.TheatricalReleaseDate?.Length ?? 0)
                    + (value.Data.InitialAirDate?.Length ?? 0)
                    + (value.Data.NextAirDate?.Length ?? 0)) * 2L)
                + 256;

        private static long CertificationWeight(
            string key,
            (int? Score, int? SubScore, string[]? Keywords, string[]? Genres, DateTime CachedAt) value)
            => (key.Length * 2L)
                + StringArrayWeight(value.Keywords)
                + StringArrayWeight(value.Genres)
                + 128;

        private static long StringArrayWeight(string[]? values)
        {
            if (values == null)
            {
                return 0;
            }

            long weight = values.Length * 8L;
            foreach (var value in values)
            {
                weight += (value?.Length ?? 0) * 2L;
            }

            return weight;
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
            lock (_importThrottleLock)
            {
                _lastManualImport = DateTime.MinValue;
                _lastManualImportGenerationIdentity = string.Empty;
            }
        }
    }
}
