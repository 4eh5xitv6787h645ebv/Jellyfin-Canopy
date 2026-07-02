using Microsoft.AspNetCore.Mvc;
using System;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Security.Cryptography;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.StaticFiles;
using Newtonsoft.Json.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Controller;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model;
using MediaBrowser.Controller.Persistence;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Extensions;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Enums;
using Microsoft.EntityFrameworkCore;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>
    /// Process-wide Seerr/TMDB caches shared by the JellyfinEnhanced feature
    /// controllers. Moved verbatim from the former JellyfinEnhancedController:
    /// the fields stay static with the same names, locks, TTL helpers and
    /// lifetimes, so cache semantics are unchanged by the controller split.
    /// </summary>
    internal static class SeerrCaches
    {
        // Server-side cache for proxied avatar images to avoid re-fetching from
        // upstream Seerr on every request. Entries expire after 1 hour.
        internal static readonly ConcurrentDictionary<string, (byte[] Content, string ContentType, string ETag, DateTime CachedAt)> _avatarCache = new();
        internal static readonly TimeSpan _avatarCacheDuration = TimeSpan.FromHours(1);

        // Cache for Seerr user ID lookups (JellyfinUserId -> SeerrUserId)
        internal static readonly Dictionary<string, (string JellyseerrUserId, DateTime CachedAt)> _userIdCache = new();
        internal static readonly object _userIdCacheLock = new();

        // Cache for Seerr user lookups (JellyfinUserId -> full Seerr user payload, null = negative cache)
        internal static readonly Dictionary<string, (JellyseerrUser? User, DateTime CachedAt)> _userCache = new();
        internal static readonly object _userCacheLock = new();

        // Cache for Seerr proxy responses (discovery/search endpoints)
        internal static readonly Dictionary<string, (string Content, DateTime CachedAt)> _responseCache = new();
        internal static readonly object _responseCacheLock = new();

        // Throttle for manual user import
        internal static DateTime _lastManualImport = DateTime.MinValue;
        internal static readonly object _importThrottleLock = new();

        // cache the result of /api/v1/status probes so a Seerr outage
        // doesn't cause every failed proxy call to issue a fresh status check.
        // Negative-cached for 30s; positive results expire on the same TTL.
        internal static (bool Active, DateTime CachedAt)? _seerrStatusCache;
        internal static readonly object _seerrStatusCacheLock = new();
        internal static readonly TimeSpan _seerrStatusCacheTtl = TimeSpan.FromSeconds(30);

        // Cache for request-page TMDB enrichments (movie/tv detail lookups via Jellyseerr)
        internal static readonly Dictionary<string, (TmdbEnrichmentResult Data, DateTime CachedAt)> _tmdbEnrichmentCache = new();
        internal static readonly object _tmdbEnrichmentCacheLock = new();
        internal static readonly ConcurrentDictionary<string, Task<TmdbEnrichmentResult>> _tmdbEnrichmentInFlight = new();

        internal static TimeSpan GetResponseCacheTtl()
        {
            var minutes = JellyfinEnhanced.Instance?.Configuration?.JellyseerrResponseCacheTtlMinutes ?? 10;
            return TimeSpan.FromMinutes(Math.Max(1, minutes));
        }

        internal static TimeSpan GetUserIdCacheTtl()
        {
            var minutes = JellyfinEnhanced.Instance?.Configuration?.JellyseerrUserIdCacheTtlMinutes ?? 30;
            return TimeSpan.FromMinutes(Math.Max(1, minutes));
        }

        internal static TimeSpan GetTmdbEnrichmentCacheTtl()
        {
            var minutes = JellyfinEnhanced.Instance?.Configuration?.JellyseerrResponseCacheTtlMinutes ?? 10;
            return TimeSpan.FromMinutes(Math.Max(1, minutes));
        }

        internal sealed class TmdbEnrichmentResult
        {
            public string? Title { get; init; }
            public int? Year { get; init; }
            public string? PosterUrl { get; init; }
            public string? DigitalReleaseDate { get; init; }
            public string? TheatricalReleaseDate { get; init; }
            public string? InitialAirDate { get; init; }
            public string? NextAirDate { get; init; }
        }

        internal static void ClearUserCaches()
        {
            lock (_userCacheLock)
            {
                _userCache.Clear();
            }

            lock (_userIdCacheLock)
            {
                _userIdCache.Clear();
            }
        }

        public static void ClearAllSeerrCachesOnConfigChange()
        {
            ClearUserCaches();
            lock (_responseCacheLock)
            {
                _responseCache.Clear();
            }
            lock (_tmdbEnrichmentCacheLock)
            {
                _tmdbEnrichmentCache.Clear();
            }
            // Avatar cache may reference the OLD Seerr URL — clear it too.
            _avatarCache.Clear();
            // also flush the cached status probe so admins see fresh
            // reachability immediately after fixing config.
            lock (_seerrStatusCacheLock) { _seerrStatusCache = null; }
        }
    }
}
