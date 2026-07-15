using Microsoft.AspNetCore.Mvc;
using System;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using System.Collections.Generic;
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
        private readonly AvatarFetchService _avatarFetch;

        public ItemInfoController(
            IHttpClientFactory httpClientFactory,
            ILogger<ItemInfoController> logger,
            IUserManager userManager,
            ISeerrCache seerrCache,
            AvatarFetchService avatarFetch,
            IPluginConfigProvider configProvider,
            ILibraryManager libraryManager,
            IItemLookupService itemLookup)
            : base(httpClientFactory, logger, userManager, seerrCache, configProvider)
        {
            _libraryManager = libraryManager;
            _itemLookup = itemLookup;
            _avatarFetch = avatarFetch;
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
            var integration = SeerrIntegrationPolicy.Capture(_configProvider);
            var config = integration.Configuration;
            if (!integration.IsActive || config == null || string.IsNullOrEmpty(path))
            {
                return NotFound();
            }

            var configurationRevision = integration.ConfigurationRevision;
            var configurationStamp = SeerrMutationConfigStamp.Capture(
                config,
                configurationRevision);
            var seerrApiKey = integration.ApiKey;
            bool IsConfigurationCurrent() => integration.IsCurrent(_configProvider)
                && configurationStamp.Matches(
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

            var seerrUrl = integration.Urls.FirstOrDefault(url => SeerrSourceToken.MatchesSource(
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
                var cacheKey = AvatarFetchService.BuildCacheKey(
                    seerrUrl,
                    avatarPath,
                    configurationRevision,
                    seerrApiKey);

                var avatar = await _avatarFetch.GetAsync(
                    cacheKey,
                    $"{seerrUrl}{avatarPath}",
                    integration
                        .CreateDispatchFence(_configProvider)
                        .Restrict(IsConfigurationCurrent),
                    HttpContext.RequestAborted).ConfigureAwait(false);
                if (avatar.Status == AvatarFetchStatus.ConfigurationChanged || !IsConfigurationCurrent())
                {
                    return ConfigurationChanged();
                }

                if (avatar.Status != AvatarFetchStatus.Available
                    || avatar.Content == null
                    || avatar.ContentType == null
                    || avatar.ETag == null)
                {
                    return NotFound();
                }

                // Serve 304 if client already has this version
                if (Request.Headers.TryGetValue("If-None-Match", out var ifNoneMatch)
                    && ifNoneMatch.ToString().Contains(avatar.ETag))
                {
                    Response.Headers["Cache-Control"] = "private, no-cache";
                    Response.Headers["ETag"] = avatar.ETag;
                    return StatusCode(304);
                }

                // The URL contains a caller-bound authorization token. Shared
                // caches must never satisfy it without re-running this endpoint's
                // authenticated caller/HMAC/source checks. Browsers may retain
                // bytes but must revalidate; the server-side AvatarCache still
                // avoids another upstream download and can answer with 304.
                Response.Headers["Cache-Control"] = "private, no-cache";
                Response.Headers["ETag"] = avatar.ETag;

                return File(avatar.Content, avatar.ContentType);
            }
            catch (OperationCanceledException) when (HttpContext.RequestAborted.IsCancellationRequested)
            {
                return new EmptyResult();
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"ProxyAvatar exception: {ex.Message}");
                return NotFound();
            }
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
