using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Model.Seerr;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Seerr
{
    /// <summary>
    /// Result shape for the request-page TMDB enrichment cache
    /// (movie/tv detail lookups via Seerr). Moved verbatim from the
    /// former static SeerrCaches holder.
    /// </summary>
    public sealed class TmdbEnrichmentResult
    {
        /// <summary>
        /// Gets a value indicating whether the pinned Seerr detail read completed
        /// and produced a parseable response. A complete response may legitimately
        /// omit release dates; transport and parse failures remain incomplete.
        /// </summary>
        public bool IsComplete { get; init; }

        public string? Title { get; init; }
        public int? Year { get; init; }
        public string? PosterUrl { get; init; }
        public string? DigitalReleaseDate { get; init; }
        public string? TheatricalReleaseDate { get; init; }
        public string? InitialAirDate { get; init; }
        public string? NextAirDate { get; init; }
    }

    /// <summary>
    /// Process-wide Seerr/TMDB caches shared by the JellyfinCanopy feature
    /// controllers and the Seerr user-import task. Formerly the static
    /// <c>Controllers.SeerrCaches</c> holder; now a DI singleton so consumers
    /// can be tested with a fresh instance. Every cache, lock and TTL is
    /// preserved with the same granularity and lifetime (one instance per
    /// server process via the singleton registration).
    /// </summary>
    public interface ISeerrCache
    {
        /// <summary>
        /// Server-side cache for proxied avatar images to avoid re-fetching from
        /// upstream Seerr on every request. Entries expire after <see cref="AvatarCacheDuration"/>.
        /// </summary>
        ConcurrentDictionary<string, (byte[] Content, string ContentType, string ETag, DateTime CachedAt)> AvatarCache { get; }

        TimeSpan AvatarCacheDuration { get; }

        /// <summary>Cache for Seerr user ID lookups (JellyfinUserId -> SeerrUserId).</summary>
        Dictionary<string, (string SeerrUserId, DateTime CachedAt, long ConfigurationRevision, string ConfigurationIdentity)> UserIdCache { get; }

        object UserIdCacheLock { get; }

        /// <summary>Cache for Seerr user lookups (JellyfinUserId -> full Seerr user payload, null = negative cache).</summary>
        Dictionary<string, (SeerrUser? User, DateTime CachedAt, long ConfigurationRevision, string ConfigurationIdentity)> UserCache { get; }

        object UserCacheLock { get; }

        /// <summary>
        /// Short-lived retry guard for non-authoritative automatic user-import
        /// failures. A fresh timestamp also reserves an in-flight attempt so a
        /// burst of callers cannot fan out duplicate import POSTs. This is not
        /// an authoritative negative-user cache.
        /// </summary>
        Dictionary<string, DateTime> AutoImportFailureThrottle { get; }

        object AutoImportFailureThrottleLock { get; }

        TimeSpan AutoImportFailureThrottleTtl { get; }

        /// <summary>Cache for Seerr proxy responses (discovery/search endpoints).</summary>
        Dictionary<string, (string Content, DateTime CachedAt, long ConfigurationRevision, string ConfigurationIdentity)> ResponseCache { get; }

        object ResponseCacheLock { get; }

        /// <summary>Throttle for manual user import.</summary>
        DateTime LastManualImport { get; set; }

        object ImportThrottleLock { get; }

        /// <summary>
        /// Caches the result of /api/v1/status probes so a Seerr outage doesn't
        /// cause every failed proxy call to issue a fresh status check.
        /// Negative-cached for 30s; positive results expire on the same TTL.
        /// </summary>
        (bool Active, DateTime CachedAt)? SeerrStatusCache { get; set; }

        object SeerrStatusCacheLock { get; }

        TimeSpan SeerrStatusCacheTtl { get; }

        /// <summary>
        /// Caches Seerr's <c>/api/v1/settings/public</c> 4K flags by exact source
        /// URL. The response is user-neutral within one Seerr instance, but
        /// separate configured instances are distinct settings domains.
        /// </summary>
        Dictionary<string, (bool Movie4kEnabled, bool Series4kEnabled, DateTime CachedAt, long ConfigurationRevision, string ApiKeyFingerprint)> Public4kSettingsCache { get; }

        object Public4kSettingsCacheLock { get; }

        TimeSpan Public4kSettingsCacheTtl { get; }

        /// <summary>Cache for request-page TMDB enrichments (movie/tv detail lookups via Seerr).</summary>
        Dictionary<string, (TmdbEnrichmentResult Data, DateTime CachedAt, long ConfigurationRevision)> TmdbEnrichmentCache { get; }

        object TmdbEnrichmentCacheLock { get; }

        ConcurrentDictionary<string, Lazy<Task<TmdbEnrichmentResult>>> TmdbEnrichmentInFlight { get; }

        /// <summary>
        /// User-independent cache of a title's resolved parental score. Keys
        /// contain <c>mediaType/tmdbId/region</c> plus a configuration revision
        /// and a one-way digest binding the source set, credentials, and full
        /// configuration. A <c>null</c> <c>Score</c> means the title is
        /// unrated/unknown. Certifications rarely change, so this uses a
        /// deliberately long TTL. Values are safe to share across users only
        /// inside that exact configuration generation.
        /// </summary>
        /// <remarks>
        /// Keywords/Genres are the title's cleaned TMDB keyword and genre
        /// name sets for the tag branch of the parental filter (kept separate
        /// because blocked tags match both while allowed tags match keywords
        /// only), or null when the entry was resolved through the light
        /// cert-only endpoints (tag data not fetched) — the filter treats
        /// null Keywords as a cache miss when tag rules are active. Like the
        /// score, they depend only on the title, never the caller.
        /// </remarks>
        ConcurrentDictionary<string, (int? Score, int? SubScore, string[]? Keywords, string[]? Genres, DateTime CachedAt)> CertScoreCache { get; }

        TimeSpan GetResponseCacheTtl();

        /// <summary>TTL for <see cref="CertScoreCache"/> (default 24h, config-driven).</summary>
        TimeSpan GetParentalRatingCacheTtl();

        TimeSpan GetUserIdCacheTtl();

        TimeSpan GetTmdbEnrichmentCacheTtl();

        /// <summary>
        /// Clears the Seerr user, user-id, and auto-import retry caches (e.g.
        /// after a bulk user import).
        /// </summary>
        void ClearUserCaches();

        /// <summary>Flushes every Seerr-related cache the moment the admin saves config.</summary>
        void ClearAllSeerrCachesOnConfigChange();
    }
}
