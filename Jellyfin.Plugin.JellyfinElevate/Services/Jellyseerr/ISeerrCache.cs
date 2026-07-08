using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinElevate.Model.Jellyseerr;

namespace Jellyfin.Plugin.JellyfinElevate.Services.Jellyseerr
{
    /// <summary>
    /// Result shape for the request-page TMDB enrichment cache
    /// (movie/tv detail lookups via Jellyseerr). Moved verbatim from the
    /// former static SeerrCaches holder.
    /// </summary>
    public sealed class TmdbEnrichmentResult
    {
        public string? Title { get; init; }
        public int? Year { get; init; }
        public string? PosterUrl { get; init; }
        public string? DigitalReleaseDate { get; init; }
        public string? TheatricalReleaseDate { get; init; }
        public string? InitialAirDate { get; init; }
        public string? NextAirDate { get; init; }
    }

    /// <summary>
    /// Process-wide Seerr/TMDB caches shared by the JellyfinElevate feature
    /// controllers and the Jellyseerr user-import task. Formerly the static
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
        Dictionary<string, (string JellyseerrUserId, DateTime CachedAt)> UserIdCache { get; }

        object UserIdCacheLock { get; }

        /// <summary>Cache for Seerr user lookups (JellyfinUserId -> full Seerr user payload, null = negative cache).</summary>
        Dictionary<string, (JellyseerrUser? User, DateTime CachedAt)> UserCache { get; }

        object UserCacheLock { get; }

        /// <summary>Cache for Seerr proxy responses (discovery/search endpoints).</summary>
        Dictionary<string, (string Content, DateTime CachedAt)> ResponseCache { get; }

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

        /// <summary>Cache for request-page TMDB enrichments (movie/tv detail lookups via Jellyseerr).</summary>
        Dictionary<string, (TmdbEnrichmentResult Data, DateTime CachedAt)> TmdbEnrichmentCache { get; }

        object TmdbEnrichmentCacheLock { get; }

        ConcurrentDictionary<string, Task<TmdbEnrichmentResult>> TmdbEnrichmentInFlight { get; }

        /// <summary>
        /// User-independent cache of a title's resolved parental score, keyed
        /// <c>"{mediaType}:{tmdbId}:{region}"</c>. A <c>null</c> <c>Score</c> means the
        /// title is unrated/unknown. Populated by the Seerr parental-rating filter
        /// from per-item detail lookups. Certifications rarely change, so this uses a
        /// deliberately long TTL (<see cref="GetParentalRatingCacheTtl"/>). Because the
        /// value depends only on the title (not the caller), it is safe to share
        /// across users.
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

        /// <summary>Clears the Seerr user and user-id caches (e.g. after a bulk user import).</summary>
        void ClearUserCaches();

        /// <summary>Flushes every Seerr-related cache the moment the admin saves config.</summary>
        void ClearAllSeerrCachesOnConfigChange();
    }
}
