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
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using MediaBrowser.Controller;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Jellyfin.Plugin.JellyfinCanopy.Model.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model;
using Jellyfin.Plugin.JellyfinCanopy.Model.Arr;
using Jellyfin.Plugin.JellyfinCanopy.Data;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Controllers
{
    /// <summary>
    /// Jellyfin-native item info (studio/boxset/person/genre), items/by-providers and the avatar proxy.
    /// Split out of the former JellyfinCanopyController; method bodies, routes
    /// and attributes are unchanged.
    /// </summary>
    [Route("JellyfinCanopy")]
    [ApiController]
    public class ItemInfoController : JellyfinCanopyControllerBase
    {
        private readonly ILibraryManager _libraryManager;
        private readonly IItemLookupService _itemLookup;

        public ItemInfoController(
            IHttpClientFactory httpClientFactory,
            ILogger<ItemInfoController> logger,
            IUserManager userManager,
            ISeerrCache seerrCache,
            IPluginConfigProvider configProvider,
            ILibraryManager libraryManager,
            IItemLookupService itemLookup)
            : base(httpClientFactory, logger, userManager, seerrCache, configProvider)
        {
            _libraryManager = libraryManager;
            _itemLookup = itemLookup;
        }

        /// <summary>
        /// Resolves the authenticated caller to a <see cref="JUser"/> so metadata lookups
        /// can be scoped to their accessible libraries. Returns null when the principal
        /// carries no resolvable user id — callers treat that as "no access" (fail-closed).
        /// </summary>
        private JUser? GetCallerUser()
        {
            var id = UserHelper.GetCurrentUserId(User);
            return id.HasValue ? _userManager.GetUserById(id.Value) : null;
        }

        [HttpGet("studio/{studioId}")]
        [Authorize]
        public IActionResult GetStudioInfo(Guid studioId)
        {
            try
            {
                var user = GetCallerUser();
                var studio = user == null ? null : _libraryManager.GetItemById<BaseItem>(studioId, user);
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
                _logger.LogError($"Failed to get studio info for {studioId}: {ex.Message}");
                return StatusCode(500, new { message = "Failed to get studio info" });
            }
        }

        [HttpGet("boxset/{boxsetId}")]
        [Authorize]
        public IActionResult GetBoxSetInfo(Guid boxsetId)
        {
            try
            {
                var user = GetCallerUser();
                var boxset = user == null ? null : _libraryManager.GetItemById<BaseItem>(boxsetId, user);
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
                _logger.LogError($"Failed to get boxset info for {boxsetId}: {ex.Message}");
                return StatusCode(500, new { message = "Failed to get boxset info" });
            }
        }

        [HttpGet("person/{personId}")]
        [Authorize]
        public async Task<IActionResult> GetPersonInfo(Guid personId, [FromQuery] Guid? itemId = null)
        {
            try
            {
                var user = GetCallerUser();
                var person = user == null ? null : _libraryManager.GetItemById<BaseItem>(personId, user);
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
                        // _logger.LogInformation($"Fetching TMDB data for person {personId} (TMDB ID: {tmdbPersonId})");
                        var tmdbPersonData = await GetTmdbPersonData(tmdbPersonId);
                        if (tmdbPersonData != null)
                        {
                            // _logger.LogInformation($"TMDB data received: BirthPlace={tmdbPersonData.BirthPlace}, BirthDate={tmdbPersonData.BirthDate}, DeathDate={tmdbPersonData.DeathDate}");

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
                                // _logger.LogDebug($"Using TMDB birthplace: {birthPlace}");
                            }
                        }
                        else
                        {
                            _logger.LogWarning($"No TMDB data returned for person {personId} (TMDB ID: {tmdbPersonId})");
                        }
                    }
                    catch (Exception ex)
                    {
                        _logger.LogWarning($"Failed to enrich person {personId} with TMDB data: {ex.Message}");
                        // Continue with Jellyfin data only
                    }
                }
                else
                {
                    // _logger.LogDebug($"No TMDB ID available for person {personId}");
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
                        var item = _libraryManager.GetItemById<BaseItem>(itemId.Value, user);
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
                _logger.LogError($"Failed to get person info for {personId}: {ex.Message}");
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
                    _logger.LogWarning("TMDB API key not configured in plugin settings");
                    return null;
                }

                var httpClient = Helpers.PluginHttpClients.CreateTmdbClient(_httpClientFactory);
                var tmdbUrl = $"https://api.themoviedb.org/3/person/{tmdbPersonId}?api_key={config.TMDB_API_KEY}";

                // _logger.LogDebug($"Fetching TMDB person data from: https://api.themoviedb.org/3/person/{tmdbPersonId}");
                var response = await httpClient.GetAsync(tmdbUrl);

                if (!response.IsSuccessStatusCode)
                {
                    _logger.LogWarning($"TMDB API request failed with status {response.StatusCode}");
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
                        // _logger.LogDebug($"Parsed place_of_birth: {birthPlace}");
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
                _logger.LogWarning($"Failed to get TMDB person data for ID {tmdbPersonId}: {ex.Message}");
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
                var user = GetCallerUser();
                var genre = user == null ? null : _libraryManager.GetItemById<BaseItem>(genreId, user);
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
                _logger.LogError($"Failed to get genre info for {genreId}: {ex.Message}");
                return StatusCode(500, new { message = "Failed to get genre info" });
            }
        }

        [HttpGet("proxy/avatar")]
        [Authorize]
        public async Task<IActionResult> ProxyAvatar(
            [FromQuery] string path,
            [FromQuery] string? sourceToken = null)
        {
            var config = _configProvider.ConfigurationOrNull;
            if (config == null
                || string.IsNullOrWhiteSpace(config.SeerrUrls)
                || string.IsNullOrWhiteSpace(config.SeerrApiKey)
                || string.IsNullOrEmpty(path))
            {
                return NotFound();
            }

            var configurationRevision = _configProvider.ConfigurationRevision;
            var configurationStamp = SeerrMutationConfigStamp.Capture(
                config,
                configurationRevision);
            var seerrApiKey = config.SeerrApiKey;
            bool IsConfigurationCurrent() => configurationStamp.Matches(
                _configProvider.ConfigurationOrNull,
                _configProvider.ConfigurationRevision);
            IActionResult ConfigurationChanged() => StatusCode(409, new
            {
                error = true,
                code = "avatar_configuration_changed",
                message = "Seerr configuration changed while fetching the avatar. Refresh the issue list and try again."
            });

            // Normalize before validating the token so both the SSRF guard and
            // HMAC bind the exact path that will be sent upstream.
            if (!SeerrSourceToken.TryNormalizeAvatarPath(path, out var avatarPath))
            {
                _logger.LogWarning("ProxyAvatar: unsafe or unsupported path blocked");
                return BadRequest("Invalid avatar path");
            }

            var jellyfinUserId = UserHelper.GetCurrentUserId(User)?.ToString();
            if (string.IsNullOrEmpty(jellyfinUserId)
                || !SeerrSourceToken.TryValidate(
                    sourceToken,
                    seerrApiKey,
                    SeerrSourceToken.AvatarPurpose,
                    jellyfinUserId,
                    avatarPath,
                    out var sourceClaims))
            {
                return StatusCode(403, new
                {
                    error = true,
                    code = "invalid_source_token",
                    message = "The avatar token is missing, invalid, or expired."
                });
            }

            var seerrUrl = SeerrClient.GetConfiguredUrls(config.SeerrUrls).FirstOrDefault(url => SeerrSourceToken.MatchesSource(
                sourceClaims!.SourceKey,
                seerrApiKey,
                url));
            if (seerrUrl == null)
            {
                return StatusCode(409, new
                {
                    error = true,
                    code = "stale_source_token",
                    message = "The linked Seerr instance changed. Refresh the request list and try again."
                });
            }

            if (!IsConfigurationCurrent())
            {
                return ConfigurationChanged();
            }

            try
            {
                // Partition by configuration revision and a one-way API-key
                // fingerprint as well as source/path. A same-URL credential
                // rotation must not reuse bytes fetched by the prior identity
                // generation, including when a custom provider mutates its
                // configuration object in place without advancing revision.
                var cacheKey = BuildAvatarCacheKey(
                    seerrUrl,
                    avatarPath,
                    configurationRevision,
                    seerrApiKey);

                // Check server-side cache first to avoid hitting upstream Seerr
                // on every request. This is critical for large avatars (e.g., animated
                // GIFs) that would otherwise be re-downloaded on every conditional request.
                if (_seerrCache.AvatarCache.TryGetValue(cacheKey, out var cached)
                    && DateTime.UtcNow - cached.CachedAt < _seerrCache.AvatarCacheDuration)
                {
                    if (!IsConfigurationCurrent())
                    {
                        return ConfigurationChanged();
                    }

                    // Serve 304 if client already has this version
                    if (Request.Headers.TryGetValue("If-None-Match", out var cachedIfNoneMatch)
                        && cachedIfNoneMatch.ToString().Contains(cached.ETag))
                    {
                        Response.Headers["Cache-Control"] = "private, no-cache";
                        Response.Headers["ETag"] = cached.ETag;
                        return StatusCode(304);
                    }

                    Response.Headers["Cache-Control"] = "private, no-cache";
                    Response.Headers["ETag"] = cached.ETag;
                    return File(cached.Content, cached.ContentType);
                }

                var client = Helpers.Seerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
                client.Timeout = TimeSpan.FromSeconds(10);

                if (!IsConfigurationCurrent())
                {
                    return ConfigurationChanged();
                }

                using var avatarRequest = new System.Net.Http.HttpRequestMessage(System.Net.Http.HttpMethod.Get, $"{seerrUrl}{avatarPath}");
                // explicit User-Agent + Accept so Cloudflare's bot
                // mode doesn't return an HTML challenge page that we'd try to
                // serve as an image.
                avatarRequest.Headers.UserAgent.ParseAdd(Helpers.Seerr.SeerrHttpHelper.UserAgent);
                avatarRequest.Headers.Accept.Add(new System.Net.Http.Headers.MediaTypeWithQualityHeaderValue("image/*"));
                using var response = await client.SendAsync(
                    avatarRequest,
                    HttpContext.RequestAborted).ConfigureAwait(false);
                if (!IsConfigurationCurrent())
                {
                    return ConfigurationChanged();
                }

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
                    _logger.LogDebug($"ProxyAvatar rejected unsafe content-type: {contentType}");
                    return NotFound();
                }

                var content = await response.Content.ReadAsByteArrayAsync(
                    HttpContext.RequestAborted).ConfigureAwait(false);
                if (!IsConfigurationCurrent())
                {
                    return ConfigurationChanged();
                }

                // Compute ETag from content hash for conditional request support.
                var hash = SHA256.HashData(content);
                var etag = $"\"{Convert.ToHexString(hash)}\"";

                // Store only in the captured generation. The post-write check
                // closes the narrow check-to-publication race; exact removal
                // cannot delete a newer flight's replacement at the same key.
                var publishedEntry = (
                    Content: content,
                    ContentType: contentType,
                    ETag: etag,
                    CachedAt: DateTime.UtcNow);
                if (!TryPublishAvatarCacheEntry(
                    _seerrCache.AvatarCache,
                    cacheKey,
                    publishedEntry,
                    IsConfigurationCurrent))
                {
                    return ConfigurationChanged();
                }

                if (!IsConfigurationCurrent())
                {
                    _seerrCache.AvatarCache.Remove(cacheKey, publishedEntry);
                    return ConfigurationChanged();
                }

                // Serve 304 if client already has this version
                if (Request.Headers.TryGetValue("If-None-Match", out var ifNoneMatch)
                    && ifNoneMatch.ToString().Contains(etag))
                {
                    Response.Headers["Cache-Control"] = "private, no-cache";
                    Response.Headers["ETag"] = etag;
                    return StatusCode(304);
                }

                // The URL contains a caller-bound authorization token. Shared
                // caches must never satisfy it without re-running this endpoint's
                // authenticated caller/HMAC/source checks. Browsers may retain
                // bytes but must revalidate; the server-side AvatarCache still
                // avoids another upstream download and can answer with 304.
                Response.Headers["Cache-Control"] = "private, no-cache";
                Response.Headers["ETag"] = etag;

                return File(content, contentType);
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"ProxyAvatar exception: {ex.Message}");
                return NotFound();
            }
        }

        internal static string BuildAvatarCacheKey(
            string seerrUrl,
            string avatarPath,
            long configurationRevision,
            string seerrApiKey)
        {
            var apiKeyFingerprint = Convert.ToHexString(
                SHA256.HashData(Encoding.UTF8.GetBytes(seerrApiKey)));
            return $"{configurationRevision.ToString(System.Globalization.CultureInfo.InvariantCulture)}:{apiKeyFingerprint}:{seerrUrl.Length.ToString(System.Globalization.CultureInfo.InvariantCulture)}:{seerrUrl}{avatarPath}";
        }

        internal static bool TryPublishAvatarCacheEntry(
            BoundedTtlCache<string, (byte[] Content, string ContentType, string ETag, DateTime CachedAt)> cache,
            string cacheKey,
            (byte[] Content, string ContentType, string ETag, DateTime CachedAt) entry,
            Func<bool> isConfigurationCurrent)
        {
            if (!isConfigurationCurrent())
            {
                return false;
            }

            cache.TrySet(cacheKey, entry, out var publication);
            if (isConfigurationCurrent())
            {
                return true;
            }

            cache.Remove(publication);
            return false;
        }

        [Authorize]
        [HttpGet("items/by-providers")]
        public ActionResult<Guid?> GetItemIdByProviders([FromQuery] Dictionary<string, string>? providers)
        {
            // Scope the provider lookup to the caller's libraries so a non-admin can't
            // confirm existence / resolve the internal Guid of items they can't access.
            var itemIds = _itemLookup.GetItemIdsByProviders(providers, GetCallerUser());

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
