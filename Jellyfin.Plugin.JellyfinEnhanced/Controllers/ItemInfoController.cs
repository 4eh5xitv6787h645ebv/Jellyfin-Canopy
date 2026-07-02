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
using Jellyfin.Plugin.JellyfinEnhanced.Services.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Services;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>
    /// Jellyfin-native item info (studio/boxset/person/genre), items/by-providers and the avatar proxy.
    /// Split out of the former JellyfinEnhancedController; method bodies, routes
    /// and attributes are unchanged.
    /// </summary>
    [Route("JellyfinEnhanced")]
    [ApiController]
    public class ItemInfoController : JellyfinEnhancedControllerBase
    {
        private readonly ILibraryManager _libraryManager;
        private readonly IItemRepository _itemRepository;

        public ItemInfoController(
            IHttpClientFactory httpClientFactory,
            Logger logger,
            IUserManager userManager,
            ISeerrCache seerrCache,
            IPluginConfigProvider configProvider,
            ILibraryManager libraryManager,
            IItemRepository itemRepository)
            : base(httpClientFactory, logger, userManager, seerrCache, configProvider)
        {
            _libraryManager = libraryManager;
            _itemRepository = itemRepository;
        }

        [HttpGet("studio/{studioId}")]
        [Authorize]
        public IActionResult GetStudioInfo(Guid studioId)
        {
            try
            {
                var studio = _libraryManager.GetItemById(studioId);
                if (studio == null)
                {
                    return NotFound(new { message = "Studio not found" });
                }

                // Get TMDB ID from provider IDs if available
                string? tmdbId = null;
                if (studio.ProviderIds != null && studio.ProviderIds.TryGetValue("Tmdb", out var id))
                {
                    tmdbId = id;
                }

                return Ok(new
                {
                    id = studio.Id,
                    name = studio.Name,
                    tmdbId = tmdbId,
                    type = studio.GetType().Name
                });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to get studio info for {studioId}: {ex.Message}");
                return StatusCode(500, new { message = "Failed to get studio info" });
            }
        }

        [HttpGet("boxset/{boxsetId}")]
        [Authorize]
        public IActionResult GetBoxSetInfo(Guid boxsetId)
        {
            try
            {
                var boxset = _libraryManager.GetItemById(boxsetId);
                if (boxset == null || boxset.GetType().Name != "BoxSet")
                {
                    return NotFound(new { message = "BoxSet not found" });
                }

                // Get TMDB collection ID from provider IDs
                string? tmdbId = null;
                if (boxset.ProviderIds != null && boxset.ProviderIds.TryGetValue("Tmdb", out var id))
                {
                    tmdbId = id;
                }

                return Ok(new
                {
                    id = boxset.Id,
                    name = boxset.Name,
                    tmdbId = tmdbId,
                    type = boxset.GetType().Name
                });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to get boxset info for {boxsetId}: {ex.Message}");
                return StatusCode(500, new { message = "Failed to get boxset info" });
            }
        }

        [HttpGet("person/{personId}")]
        [Authorize]
        public async Task<IActionResult> GetPersonInfo(Guid personId, [FromQuery] Guid? itemId = null)
        {
            try
            {
                var person = _libraryManager.GetItemById(personId);
                if (person == null)
                {
                    return NotFound(new { message = "Person not found" });
                }

                // Get TMDB ID from provider IDs if available
                string? tmdbId = null;
                if (person.ProviderIds != null && person.ProviderIds.TryGetValue("Tmdb", out var id))
                {
                    tmdbId = id;
                }

                // Get person-specific data
                // Note: PremiereDate on Person items stores birth date, EndDate stores death date
                var birthDate = person.PremiereDate;
                var endDate = person.EndDate;
                var birthPlace = person.ProductionLocations?.FirstOrDefault() ?? null;

                // Try to enrich with TMDB data if available
                if (!string.IsNullOrEmpty(tmdbId) && int.TryParse(tmdbId, out var tmdbPersonId))
                {
                    try
                    {
                        // _logger.Info($"Fetching TMDB data for person {personId} (TMDB ID: {tmdbPersonId})");
                        var tmdbPersonData = await GetTmdbPersonData(tmdbPersonId);
                        if (tmdbPersonData != null)
                        {
                            // _logger.Info($"TMDB data received: BirthPlace={tmdbPersonData.BirthPlace}, BirthDate={tmdbPersonData.BirthDate}, DeathDate={tmdbPersonData.DeathDate}");

                            // Use TMDB death date if Jellyfin doesn't have it
                            if (!endDate.HasValue && tmdbPersonData.DeathDate.HasValue)
                            {
                                endDate = tmdbPersonData.DeathDate;
                            }

                            // Use TMDB birth date if Jellyfin doesn't have it
                            if (!birthDate.HasValue && tmdbPersonData.BirthDate.HasValue)
                            {
                                birthDate = tmdbPersonData.BirthDate;
                            }

                            // Always prefer TMDB birthplace
                            if (!string.IsNullOrEmpty(tmdbPersonData.BirthPlace))
                            {
                                birthPlace = tmdbPersonData.BirthPlace;
                                // _logger.Debug($"Using TMDB birthplace: {birthPlace}");
                            }
                        }
                        else
                        {
                            _logger.Warning($"No TMDB data returned for person {personId} (TMDB ID: {tmdbPersonId})");
                        }
                    }
                    catch (Exception ex)
                    {
                        _logger.Warning($"Failed to enrich person {personId} with TMDB data: {ex.Message}");
                        // Continue with Jellyfin data only
                    }
                }
                else
                {
                    // _logger.Debug($"No TMDB ID available for person {personId}");
                }



                int? currentAge = null;
                int? ageAtItemRelease = null;
                int? ageAtDeath = null;
                bool isDeceased = endDate.HasValue && endDate.Value < DateTime.Now;

                // Calculate current age or age at death
                if (birthDate.HasValue)
                {
                    if (isDeceased && endDate.HasValue)
                    {
                        // If deceased, calculate age at death
                        ageAtDeath = CalculateAge(birthDate.Value, endDate.Value);
                    }
                    else
                    {
                        // If alive, calculate current age
                        currentAge = CalculateAge(birthDate.Value, DateTime.Now);
                    }

                    // Calculate age at item release if itemId provided
                    if (itemId.HasValue)
                    {
                        var item = _libraryManager.GetItemById(itemId.Value);
                        if (item?.PremiereDate.HasValue ?? false)
                        {
                            ageAtItemRelease = CalculateAge(birthDate.Value, item.PremiereDate.Value);
                        }
                    }
                }

                return Ok(new
                {
                    id = person.Id,
                    name = person.Name,
                    tmdbId = tmdbId,
                    type = person.GetType().Name,
                    birthDate = birthDate?.ToString("yyyy-MM-dd"),
                    deathDate = endDate?.ToString("yyyy-MM-dd"),
                    birthPlace = birthPlace,
                    isDeceased = isDeceased,
                    currentAge = currentAge,
                    ageAtDeath = ageAtDeath,
                    ageAtItemRelease = ageAtItemRelease
                });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to get person info for {personId}: {ex.Message}");
                return StatusCode(500, new { message = "Failed to get person info" });
            }
        }

        private async Task<TmdbPersonData?> GetTmdbPersonData(int tmdbPersonId)
        {
            try
            {
                // Get TMDB API key from configuration
                var config = _configProvider.ConfigurationOrNull;
                if (config == null || string.IsNullOrEmpty(config.TMDB_API_KEY))
                {
                    _logger.Warning("TMDB API key not configured in plugin settings");
                    return null;
                }

                var httpClient = _httpClientFactory.CreateClient();
                var tmdbUrl = $"https://api.themoviedb.org/3/person/{tmdbPersonId}?api_key={config.TMDB_API_KEY}";

                // _logger.Debug($"Fetching TMDB person data from: https://api.themoviedb.org/3/person/{tmdbPersonId}");
                var response = await httpClient.GetAsync(tmdbUrl);

                if (!response.IsSuccessStatusCode)
                {
                    _logger.Warning($"TMDB API request failed with status {response.StatusCode}");
                    return null;
                }

                var content = await response.Content.ReadAsStringAsync();
                var jsonElement = JsonSerializer.Deserialize<JsonElement>(content);

                DateTime? birthDate = null;
                DateTime? deathDate = null;
                string? birthPlace = null;

                // Parse birth date
                if (jsonElement.TryGetProperty("birthday", out var birthdayProp) &&
                    birthdayProp.ValueKind != JsonValueKind.Null &&
                    DateTime.TryParse(birthdayProp.GetString(), out var birth))
                {
                    birthDate = birth;
                }

                // Parse death date
                if (jsonElement.TryGetProperty("deathday", out var deathdayProp) &&
                    deathdayProp.ValueKind != JsonValueKind.Null &&
                    deathdayProp.GetString() is string deathStr &&
                    DateTime.TryParse(deathStr, out var death))
                {
                    deathDate = death;
                }

                // Parse birth place
                if (jsonElement.TryGetProperty("place_of_birth", out var placeProp) &&
                    placeProp.ValueKind != JsonValueKind.Null)
                {
                    birthPlace = placeProp.GetString();
                    if (!string.IsNullOrEmpty(birthPlace))
                    {
                        // _logger.Debug($"Parsed place_of_birth: {birthPlace}");
                    }
                }

                return new TmdbPersonData
                {
                    BirthDate = birthDate,
                    DeathDate = deathDate,
                    BirthPlace = birthPlace
                };
            }
            catch (Exception ex)
            {
                _logger.Warning($"Failed to get TMDB person data for ID {tmdbPersonId}: {ex.Message}");
                return null;
            }
        }

        private int CalculateAge(DateTime birthDate, DateTime referenceDate)
        {
            int age = referenceDate.Year - birthDate.Year;
            if (referenceDate < birthDate.AddYears(age))
            {
                age--;
            }
            return Math.Max(0, age);
        }

        [HttpGet("genre/{genreId}")]
        [Authorize]
        public IActionResult GetGenreInfo(Guid genreId)
        {
            try
            {
                var genre = _libraryManager.GetItemById(genreId);
                if (genre == null)
                {
                    return NotFound(new { message = "Genre not found" });
                }

                return Ok(new
                {
                    id = genre.Id,
                    name = genre.Name,
                    type = genre.GetType().Name
                });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to get genre info for {genreId}: {ex.Message}");
                return StatusCode(500, new { message = "Failed to get genre info" });
            }
        }

        [HttpGet("proxy/avatar")]
        [Authorize]
        public async Task<IActionResult> ProxyAvatar([FromQuery] string path)
        {
            var config = _configProvider.ConfigurationOrNull;
            if (config == null || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(path))
            {
                return NotFound();
            }

            var jellyseerrUrl = config.JellyseerrUrls
                .Split(new[] { '\r', '\n', ',' }, StringSplitOptions.RemoveEmptyEntries)[0]
                .Trim().TrimEnd('/');

            // Strip query string (?v=timestamp) and fragment — only the path is needed.
            var avatarPath = path.Trim();
            var q = avatarPath.IndexOf('?');
            if (q >= 0) avatarPath = avatarPath[..q];
            var f = avatarPath.IndexOf('#');
            if (f >= 0) avatarPath = avatarPath[..f];

            if (!avatarPath.StartsWith('/'))
                avatarPath = $"/{avatarPath}";

            // Block path traversal, scheme injection, and request smuggling.
            if (avatarPath.Contains("..") || avatarPath.Contains("://") || avatarPath.Contains("@")
                || avatarPath.Contains("\r") || avatarPath.Contains("\n")
                || avatarPath.Contains("%0d", StringComparison.OrdinalIgnoreCase)
                || avatarPath.Contains("%0a", StringComparison.OrdinalIgnoreCase)
                || avatarPath.Contains("%00"))
            {
                _logger.Warning("ProxyAvatar: unsafe characters in path blocked");
                return BadRequest("Invalid avatar path");
            }

            // SSRF guard: only allow known Jellyseerr avatar path prefixes.
            if (!avatarPath.StartsWith("/avatar/", StringComparison.OrdinalIgnoreCase)
                && !avatarPath.StartsWith("/avatarproxy/", StringComparison.OrdinalIgnoreCase)
                && !avatarPath.StartsWith("/api/v1/avatar/", StringComparison.OrdinalIgnoreCase))
            {
                _logger.Warning($"ProxyAvatar: path not in allowed list '{avatarPath}'");
                return BadRequest("Invalid avatar path");
            }

            try
            {
                // include the resolved Seerr URL in the cache key
                // so that switching to a different Seerr instance with the same
                // avatar path doesn't serve stale bytes from the old instance.
                var cacheKey = $"{jellyseerrUrl}|{avatarPath}";

                // Check server-side cache first to avoid hitting upstream Seerr
                // on every request. This is critical for large avatars (e.g., animated
                // GIFs) that would otherwise be re-downloaded on every conditional request.
                if (_seerrCache.AvatarCache.TryGetValue(cacheKey, out var cached)
                    && DateTime.UtcNow - cached.CachedAt < _seerrCache.AvatarCacheDuration)
                {
                    // Serve 304 if client already has this version
                    if (Request.Headers.TryGetValue("If-None-Match", out var cachedIfNoneMatch)
                        && cachedIfNoneMatch.ToString().Contains(cached.ETag))
                    {
                        Response.Headers["Cache-Control"] = "public, max-age=3600";
                        Response.Headers["ETag"] = cached.ETag;
                        return StatusCode(304);
                    }

                    Response.Headers["Cache-Control"] = "public, max-age=3600";
                    Response.Headers["ETag"] = cached.ETag;
                    return File(cached.Content, cached.ContentType);
                }

                var client = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
                client.Timeout = TimeSpan.FromSeconds(10);

                using var avatarRequest = new System.Net.Http.HttpRequestMessage(System.Net.Http.HttpMethod.Get, $"{jellyseerrUrl}{avatarPath}");
                // explicit User-Agent + Accept so Cloudflare's bot
                // mode doesn't return an HTML challenge page that we'd try to
                // serve as an image.
                avatarRequest.Headers.UserAgent.ParseAdd(Helpers.Jellyseerr.SeerrHttpHelper.UserAgent);
                avatarRequest.Headers.Accept.Add(new System.Net.Http.Headers.MediaTypeWithQualityHeaderValue("image/*"));
                var response = await client.SendAsync(avatarRequest);
                if (!response.IsSuccessStatusCode)
                {
                    return NotFound();
                }

                // Closed-set MIME whitelist. previously
                // accepted `image/svg+xml`, so a compromised Seerr could serve
                // an SVG with embedded `<script>` that we'd cache for 1 hour.
                // SVG is intentionally excluded — TMDB avatars are always
                // raster formats.
                var contentType = response.Content.Headers.ContentType?.MediaType ?? "image/jpeg";
                var allowedAvatarTypes = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
                {
                    "image/png", "image/jpeg", "image/jpg", "image/gif",
                    "image/webp", "image/avif", "image/bmp"
                };
                if (!allowedAvatarTypes.Contains(contentType))
                {
                    _logger.Debug($"ProxyAvatar rejected unsafe content-type: {contentType}");
                    return NotFound();
                }

                var content = await response.Content.ReadAsByteArrayAsync();

                // Compute ETag from content hash for conditional request support.
                var hash = SHA256.HashData(content);
                var etag = $"\"{Convert.ToHexString(hash)}\"";

                // Store in server-side cache and evict expired entries periodically
                _seerrCache.AvatarCache[cacheKey] = (content, contentType, etag, DateTime.UtcNow);
                if (_seerrCache.AvatarCache.Count > 50 || _seerrCache.AvatarCache.Count % 10 == 0)
                {
                    foreach (var key in _seerrCache.AvatarCache
                        .Where(kv => DateTime.UtcNow - kv.Value.CachedAt > _seerrCache.AvatarCacheDuration)
                        .Select(kv => kv.Key)
                        .ToList())
                    {
                        _seerrCache.AvatarCache.TryRemove(key, out _);
                    }
                }

                // Serve 304 if client already has this version
                if (Request.Headers.TryGetValue("If-None-Match", out var ifNoneMatch)
                    && ifNoneMatch.ToString().Contains(etag))
                {
                    Response.Headers["Cache-Control"] = "public, max-age=3600";
                    Response.Headers["ETag"] = etag;
                    return StatusCode(304);
                }

                Response.Headers["Cache-Control"] = "public, max-age=3600";
                Response.Headers["ETag"] = etag;

                return File(content, contentType);
            }
            catch (Exception ex)
            {
                _logger.Warning($"ProxyAvatar exception: {ex.Message}");
                return NotFound();
            }
        }

        [Authorize]
        [HttpGet("items/by-providers")]
        public ActionResult<Guid?> GetItemIdByProviders([FromQuery] Dictionary<string, string>? providers)
        {
            var itemIds = _itemRepository.GetItemIdsByProviders(providers);

            if (itemIds.Count == 0)
                return BadRequest("No provider ids supplied or no items found");

            return Ok(itemIds.FirstOrDefault());
        }
    }

    public class TmdbPersonData
    {
        public DateTime? BirthDate { get; set; }
        public DateTime? DeathDate { get; set; }
        public string? BirthPlace { get; set; }
    }
}
