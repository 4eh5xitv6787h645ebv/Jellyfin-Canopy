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
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Controller;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model;
using MediaBrowser.Controller.Persistence;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Enums;
using Microsoft.EntityFrameworkCore;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Microsoft.Extensions.Logging;
using MediaBrowser.Common.Api;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>
    /// Jellyseerr/TMDB proxy endpoints (status, validate, search, discover, movie/tv details, requests, quota, issues, raw TMDB proxy).
    /// Split out of the former JellyfinEnhancedController; method bodies, routes
    /// and attributes are unchanged.
    /// </summary>
    [Route("JellyfinEnhanced")]
    [ApiController]
    public class JellyseerrProxyController : JellyfinEnhancedControllerBase
    {
        private readonly IJellyseerrClient _jellyseerr;
        private readonly ISeerrParentalFilter _parentalFilter;

        public JellyseerrProxyController(
            IHttpClientFactory httpClientFactory,
            ILogger<JellyseerrProxyController> logger,
            IUserManager userManager,
            ISeerrCache seerrCache,
            IPluginConfigProvider configProvider,
            IJellyseerrClient jellyseerr,
            ISeerrParentalFilter parentalFilter)
            : base(httpClientFactory, logger, userManager, seerrCache, configProvider)
        {
            _jellyseerr = jellyseerr;
            _parentalFilter = parentalFilter;
        }

        // Thin delegation kept so the ~35 proxy endpoints below read unchanged;
        // the implementation lives on the injected IJellyseerrClient.
        private Task<IActionResult> ProxyJellyseerrRequest(string apiPath, HttpMethod method, string? content = null)
            => _jellyseerr.ProxyRequestAsync(apiPath, method, content, SeerrCaller());

        // Seerr's discover API accepts these params (verified live against
        // Seerr 3.2.0). The correct names are `keywords`, `watchProviders`,
        // `watchRegion` — no `with*` prefix; Seerr rejects `withCompanies`
        // / `withNetworks` / `withOriginalLanguage` as `Unknown query parameter`.
        // `studio` and `network` are accepted on /discover/movies and
        // /discover/tv respectively (handled via path routes).
        private static readonly string[] DiscoverFilterParams = {
            "sortBy", "primaryReleaseDateGte", "primaryReleaseDateLte",
            "firstAirDateGte", "firstAirDateLte",
            "voteAverageGte", "voteAverageLte",
            "withRuntimeGte", "withRuntimeLte",
            "certification", "watchRegion", "language",
            "keywords", "watchProviders"
        };

        private string AppendDiscoverFilters(string basePath)
        {
            var sb = new StringBuilder(basePath);
            foreach (var param in DiscoverFilterParams)
            {
                if (Request.Query.TryGetValue(param, out var value) && !string.IsNullOrEmpty(value))
                {
                    sb.Append($"&{param}={Uri.EscapeDataString(value!)}");
                }
            }
            return sb.ToString();
        }

        [HttpGet("jellyseerr/status")]
        [Authorize]
        public async Task<IActionResult> GetJellyseerrStatus()
            => Ok(new { active = await _jellyseerr.GetStatusActiveAsync() });

        [HttpGet("jellyseerr/validate")]
        [Authorize(Policy = Policies.RequiresElevation)]
        public async Task<IActionResult> ValidateJellyseerr([FromQuery] string url, [FromHeader(Name = "X-Arr-ApiKey")] string apiKey)
        {
            if (string.IsNullOrWhiteSpace(url) || string.IsNullOrWhiteSpace(apiKey))
                return BadRequest(new { ok = false, message = "Missing url or apiKey" });

            if (!IsAllowedUrl(url))
                return BadRequest(new { ok = false, message = "Invalid URL" });

            var http = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
            http.Timeout = TimeSpan.FromSeconds(10);

            // Use the SeerrHttpHelper so the admin gets the same typed errors
            // (HtmlResponse / Cloudflare5xx / UpstreamRedirect / Unauthorized)
            // as runtime fetches — Round-3 found that the validate path
            // returned a generic "Status check failed" for HTML challenge
            // pages, which is the most-confusing first-setup error.
            var requestUri = $"{url.TrimEnd('/')}/api/v1/user";
            try
            {
                using var request = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(
                    HttpMethod.Get, requestUri, apiKey);
                using var resp = await http.SendAsync(request);
                var (_, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(resp, requestUri);
                if (error == null) return Ok(new { ok = true });

                _logger.LogWarning($"Seerr validate failed for {url}: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay} — {error.Message}");
                int httpCode = error.Code switch
                {
                    Helpers.Jellyseerr.SeerrErrorCode.HtmlResponse => 502,
                    Helpers.Jellyseerr.SeerrErrorCode.UpstreamRedirect => 502,
                    Helpers.Jellyseerr.SeerrErrorCode.Cloudflare5xx => 502,
                    _ => error.HttpStatus > 0 ? error.HttpStatus : 502,
                };
                return StatusCode(httpCode, new
                {
                    ok = false,
                    code = error.Code.ToString(),
                    cfRay = error.CfRay,
                    message = error.Message
                });
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"Seerr validate failed for {url}: {ex.Message}");
                return StatusCode(502, new
                {
                    ok = false,
                    code = "Unreachable",
                    message = $"Unable to reach Jellyseerr at {url}: {ex.Message}"
                });
            }
        }

        // Manually trigger Seerr's recently-added library scan against a single URL.
        // Used by the admin "Trigger scan now" button so the test runs against the
        // values currently in the form (which may not be saved yet), exactly like
        // the validate endpoint above.
        [HttpPost("jellyseerr/trigger-recently-added-scan")]
        [Authorize(Policy = Policies.RequiresElevation)]
        public async Task<IActionResult> TriggerJellyseerrRecentlyAddedScan([FromQuery] string url, [FromHeader(Name = "X-Arr-ApiKey")] string apiKey)
        {
            if (string.IsNullOrWhiteSpace(url) || string.IsNullOrWhiteSpace(apiKey))
                return BadRequest(new { ok = false, message = "Missing url or apiKey" });

            if (!IsAllowedUrl(url))
                return BadRequest(new { ok = false, message = "Invalid URL" });

            var http = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
            http.Timeout = TimeSpan.FromSeconds(15);

            // route via SeerrHttpHelper so a Cloudflare/forward-auth
            // 200+HTML response no longer falsely reports `ok=true` to admins.
            var requestUri = $"{url.TrimEnd('/')}/api/v1/settings/jobs/jellyfin-recently-added-scan/run";
            try
            {
                using var request = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(
                    HttpMethod.Post, requestUri, apiKey, bodyJson: "{}");
                using var resp = await http.SendAsync(request);
                var (_, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(resp, requestUri);
                if (error == null)
                {
                    _logger.LogInformation($"[SeerrScan] Manually triggered Seerr recently-added scan via admin button — {url}");
                    return Ok(new { ok = true });
                }

                _logger.LogWarning($"[SeerrScan] Manual trigger failed for {url}: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay} — {error.Message}");
                int httpCode = error.Code switch
                {
                    Helpers.Jellyseerr.SeerrErrorCode.HtmlResponse => 502,
                    Helpers.Jellyseerr.SeerrErrorCode.UpstreamRedirect => 502,
                    Helpers.Jellyseerr.SeerrErrorCode.Cloudflare5xx => 502,
                    _ => error.HttpStatus > 0 ? error.HttpStatus : 502,
                };
                return StatusCode(httpCode, new
                {
                    ok = false,
                    code = error.Code.ToString(),
                    cfRay = error.CfRay,
                    message = error.Message
                });
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"[SeerrScan] Manual trigger threw for {url}: {ex.Message}");
                return StatusCode(502, new
                {
                    ok = false,
                    code = "Unreachable",
                    message = $"Unable to reach Seerr: {ex.Message}"
                });
            }
        }


        [HttpGet("jellyseerr/search")]
        [Authorize]
        public Task<IActionResult> JellyseerrSearch([FromQuery] string? query, [FromQuery] int page = 1, [FromQuery] string? language = null)
        {
            // previously returned ASP.NET model-binding's RFC9110-link
            // error envelope when `query` was null/empty. Now we return a clean
            // structured BadRequest matching the rest of the API.
            if (string.IsNullOrWhiteSpace(query))
            {
                return Task.FromResult<IActionResult>(BadRequest(new
                {
                    error = true,
                    code = "missing_query",
                    message = "Search query is required."
                }));
            }
            // Clamp pathological inputs. Use UTF-16 surrogate-safe truncation so
            // we don't split a high/low surrogate pair.— important
            // for emoji or extended-CJK searches.
            if (query.Length > 256)
            {
                var cut = 256;
                if (cut > 0 && char.IsHighSurrogate(query[cut - 1])) cut--;
                query = query.Substring(0, cut);
            }
            if (page < 1) page = 1;

            var path = $"/api/v1/search?query={Uri.EscapeDataString(query)}&page={page}";
            if (!string.IsNullOrEmpty(language))
                path += $"&language={Uri.EscapeDataString(language)}";
            return ProxyJellyseerrRequest(path, HttpMethod.Get);
        }

        [HttpGet("jellyseerr/sonarr")]
        [Authorize]
        public Task<IActionResult> GetSonarrInstances()
        {
            return ProxyJellyseerrRequest("/api/v1/service/sonarr", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/radarr")]
        [Authorize]
        public Task<IActionResult> GetRadarrInstances()
        {
            return ProxyJellyseerrRequest("/api/v1/service/radarr", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/{type}/{serverId}")]
        [Authorize]
        public Task<IActionResult> GetServiceDetails(string type, int serverId)
        {
            // Allowlist the type segment so only known Seerr service routes are reachable —
            // `/api/v1/service/{type}/{serverId}` is interpolated into the upstream URL, so
            // any user-supplied value would be passed through. Today Seerr only knows
            // sonarr/radarr; reject anything else with 400.
            if (type != "sonarr" && type != "radarr")
            {
                return Task.FromResult<IActionResult>(BadRequest(new { error = true, code = "invalid_service_type", message = "Service type must be 'sonarr' or 'radarr'." }));
            }
            return ProxyJellyseerrRequest($"/api/v1/service/{type}/{serverId}", HttpMethod.Get);
        }

        [HttpPost("jellyseerr/request")]
        [Authorize]
        public async Task<IActionResult> JellyseerrRequest([FromBody] JsonElement requestBody)
        {
            return await ProxyJellyseerrRequest("/api/v1/request", HttpMethod.Post, requestBody.ToString());
        }

        [HttpGet("jellyseerr/request")]
        [Authorize]
        public Task<IActionResult> GetJellyseerrRequests([FromQuery] int take = 500, [FromQuery] int skip = 0, [FromQuery] string filter = "all")
        {
            return ProxyJellyseerrRequest(BuildRequestsProxyPath(take, skip, filter), HttpMethod.Get);
        }

        // Escapes filter (take/skip are ints, already safe) so a crafted value can't smuggle extra
        // query params into the upstream path — matching the sibling GetJellyseerrIssues route.
        // Extracted so the escaping is unit-testable without a live proxy round-trip.
        internal static string BuildRequestsProxyPath(int take, int skip, string filter)
            => $"/api/v1/request?take={take}&skip={skip}&filter={Uri.EscapeDataString(filter)}";

        // Returns the user's Seerr quota with a nextResetAt added per side.
        [HttpGet("jellyseerr/quota")]
        [Authorize]
        public async Task<IActionResult> GetJellyseerrQuota()
        {
            var jellyfinUserId = UserHelper.GetCurrentUserId(User)?.ToString() ?? "";
            var seerrUserId = await _jellyseerr.GetJellyseerrUserId(jellyfinUserId);
            var quotaResult = await ProxyJellyseerrRequest($"/api/v1/user/{seerrUserId}/quota", HttpMethod.Get);

            // Reset-time enrichment is best-effort — fall back to the un-enriched
            // result on any failure (malformed body, Seerr admin shape, etc).
            if (quotaResult is ContentResult cr && cr.StatusCode is null or 200)
            {
                try
                {
                    var quota = JsonNode.Parse(cr.Content ?? "{}")!.AsObject();
                    await EnrichQuotaWithResetAsync(quota, seerrUserId!, _configProvider.Configuration);
                    // Compact output like the old JObject.ToString(Formatting.None).
                    return Content(quota.ToJsonString(), "application/json");
                }
                catch (Exception ex)
                {
                    _logger.LogWarning($"Quota enrichment skipped ({ex.GetType().Name}): {ex.Message}");
                }
            }

            return quotaResult;
        }

        private async Task EnrichQuotaWithResetAsync(JsonObject quota, string seerrUserId, PluginConfiguration config)
        {
            // Parallel: independent HTTP calls, sequential would double worst-case latency.
            var movieTask = ComputeNextResetAsync(quota, "movie", seerrUserId, config);
            var tvTask = ComputeNextResetAsync(quota, "tv", seerrUserId, config);
            await Task.WhenAll(movieTask, tvTask);

            // Seerr admins / no-policy users return {"movie":null,"tv":null}; cast safely.
            if (movieTask.Result.HasValue && quota["movie"] is JsonObject mObj)
            {
                mObj["nextResetAt"] = movieTask.Result.Value.ToString("o");
            }
            if (tvTask.Result.HasValue && quota["tv"] is JsonObject tObj)
            {
                tObj["nextResetAt"] = tvTask.Result.Value.ToString("o");
            }
        }

        private async Task<DateTime?> ComputeNextResetAsync(JsonObject quota, string mediaType, string seerrUserId, PluginConfiguration config)
        {
            var side = quota[mediaType] as JsonObject;
            if (side == null) return null;

            int limit = (int?)side["limit"] ?? 0;
            int used = (int?)side["used"] ?? 0;
            int days = (int?)side["days"] ?? 0;

            // limit=0 is unlimited; no requests means nothing to roll off.
            if (limit <= 0 || used <= 0 || days <= 0) return null;

            var urls = config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            var httpClient = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
            httpClient.Timeout = TimeSpan.FromSeconds(8);

            // Iterate URLs for multi-instance failover, matching ProxyJellyseerrRequest.
            foreach (var rawUrl in urls)
            {
                var trimmedUrl = rawUrl.Trim().TrimEnd('/');
                try
                {
                    // sortDirection=asc returns oldest first; take=20 gives a margin for declined.
                    var requestUri = $"{trimmedUrl}/api/v1/request" +
                                     $"?take=20&skip=0&sortDirection=asc&requestedBy={seerrUserId}&mediaType={mediaType}";

                    using var request = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(
                        HttpMethod.Get, requestUri, config.JellyseerrApiKey, seerrUserId);
                    using var response = await httpClient.SendAsync(request);
                    var (content, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, requestUri);
                    if (error != null)
                    {
                        _logger.LogDebug($"ComputeNextResetAsync({mediaType}) on {trimmedUrl} failed: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay}");
                        continue;
                    }

                    using var doc = JsonDocument.Parse(content!);
                    if (!doc.RootElement.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array)
                    {
                        continue;
                    }

                    // Quota excludes DECLINED (status==3), so we do too.
                    var windowStart = DateTime.UtcNow.AddDays(-days);
                    DateTime? oldestCreatedAt = null;
                    foreach (var req in results.EnumerateArray())
                    {
                        if (req.TryGetProperty("status", out var statusEl) &&
                            statusEl.ValueKind == JsonValueKind.Number &&
                            statusEl.GetInt32() == 3)
                        {
                            continue;
                        }

                        if (!req.TryGetProperty("createdAt", out var createdEl) ||
                            createdEl.ValueKind != JsonValueKind.String)
                        {
                            continue;
                        }

                        if (!DateTime.TryParse(createdEl.GetString(), null,
                            System.Globalization.DateTimeStyles.RoundtripKind, out var createdAt))
                        {
                            continue;
                        }

                        var createdAtUtc = createdAt.ToUniversalTime();
                        if (createdAtUtc < windowStart) continue;

                        if (oldestCreatedAt == null || createdAtUtc < oldestCreatedAt.Value)
                        {
                            oldestCreatedAt = createdAtUtc;
                        }
                    }

                    return oldestCreatedAt?.AddDays(days);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning($"ComputeNextResetAsync({mediaType}) on {trimmedUrl} failed ({ex.GetType().Name}): {ex.Message}");
                }
            }

            return null;
        }

        [HttpGet("jellyseerr/tv/{tmdbId}")]
        [Authorize]
        public Task<IActionResult> GetTvShow(int tmdbId)
        {
            return ProxyJellyseerrRequest($"/api/v1/tv/{tmdbId}", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/tv/{tmdbId}/season/{seasonNumber}")]
        [Authorize]
        public Task<IActionResult> GetTvSeason(int tmdbId, int seasonNumber)
        {
            return ProxyJellyseerrRequest($"/api/v1/tv/{tmdbId}/season/{seasonNumber}", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/movie/{tmdbId}")]
        [Authorize]
        public Task<IActionResult> GetMovie(int tmdbId)
        {
            return ProxyJellyseerrRequest($"/api/v1/movie/{tmdbId}", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/movie/{tmdbId}/similar")]
        [Authorize]
        public Task<IActionResult> GetSimilarMovies(int tmdbId, [FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest($"/api/v1/movie/{tmdbId}/similar?page={page}", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/movie/{tmdbId}/recommendations")]
        [Authorize]
        public Task<IActionResult> GetRecommendedMovies(int tmdbId, [FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest($"/api/v1/movie/{tmdbId}/recommendations?page={page}", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/movie/{tmdbId}/ratingscombined")]
        [Authorize]
        public Task<IActionResult> GetMovieRatingsCombined(int tmdbId)
        {
            return ProxyJellyseerrRequest($"/api/v1/movie/{tmdbId}/ratingscombined", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/tv/{tmdbId}/similar")]
        [Authorize]
        public Task<IActionResult> GetSimilarTvShows(int tmdbId, [FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest($"/api/v1/tv/{tmdbId}/similar?page={page}", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/tv/{tmdbId}/recommendations")]
        [Authorize]
        public Task<IActionResult> GetRecommendedTvShows(int tmdbId, [FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest($"/api/v1/tv/{tmdbId}/recommendations?page={page}", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/tv/{tmdbId}/ratings")]
        [Authorize]
        public Task<IActionResult> GetTvRatingsCombined(int tmdbId)
        {
            return ProxyJellyseerrRequest($"/api/v1/tv/{tmdbId}/ratings", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/tv/network/{networkId}")]
        [Authorize]
        public Task<IActionResult> DiscoverTvByNetwork(int networkId, [FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest(AppendDiscoverFilters($"/api/v1/discover/tv?page={page}&network={networkId}"), HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/movies/studio/{studioId}")]
        [Authorize]
        public Task<IActionResult> DiscoverMoviesByStudio(int studioId, [FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest(AppendDiscoverFilters($"/api/v1/discover/movies?page={page}&studio={studioId}"), HttpMethod.Get);
        }

        [HttpGet("jellyseerr/person/{personId}")]
        [Authorize]
        public Task<IActionResult> GetJellyseerrPerson(int personId)
        {
            // TMDB person id 0 / negative produces a noisy 500 from
            // Seerr. Cheap to reject up-front so admins don't see "code=UpstreamError"
            // for what is really an invalid input.
            if (personId <= 0)
            {
                return Task.FromResult<IActionResult>(BadRequest(new
                {
                    error = true,
                    code = "invalid_person_id",
                    message = "TMDB person id must be positive."
                }));
            }
            return ProxyJellyseerrRequest($"/api/v1/person/{personId}", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/person/{personId}/combined_credits")]
        [Authorize]
        public Task<IActionResult> GetJellyseerrPersonCredits(int personId)
        {
            if (personId <= 0)
            {
                return Task.FromResult<IActionResult>(BadRequest(new
                {
                    error = true,
                    code = "invalid_person_id",
                    message = "TMDB person id must be positive."
                }));
            }
            return ProxyJellyseerrRequest($"/api/v1/person/{personId}/combined_credits", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/tv/genre/{genreId}")]
        [Authorize]
        public Task<IActionResult> DiscoverTvByGenre(int genreId, [FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest(AppendDiscoverFilters($"/api/v1/discover/tv?page={page}&genre={genreId}"), HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/movies/genre/{genreId}")]
        [Authorize]
        public Task<IActionResult> DiscoverMoviesByGenre(int genreId, [FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest(AppendDiscoverFilters($"/api/v1/discover/movies?page={page}&genre={genreId}"), HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/tv/keyword/{keywordId}")]
        [Authorize]
        public Task<IActionResult> DiscoverTvByKeyword(int keywordId, [FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest(AppendDiscoverFilters($"/api/v1/discover/tv?page={page}&keywords={keywordId}"), HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/movies/keyword/{keywordId}")]
        [Authorize]
        public Task<IActionResult> DiscoverMoviesByKeyword(int keywordId, [FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest(AppendDiscoverFilters($"/api/v1/discover/movies?page={page}&keywords={keywordId}"), HttpMethod.Get);
        }

        [HttpGet("tmdb/search/person")]
        [Authorize]
        public Task<IActionResult> SearchTmdbPerson([FromQuery] string query)
        {
            if (string.IsNullOrWhiteSpace(query))
            {
                return Task.FromResult<IActionResult>(BadRequest(new { message = "Query cannot be empty" }));
            }
            return ProxyJellyseerrRequest($"/api/v1/search?query={Uri.EscapeDataString(query)}&page=1", HttpMethod.Get);
        }

        [HttpGet("tmdb/search/keyword")]
        [Authorize]
        public Task<IActionResult> SearchTmdbKeyword([FromQuery] string query)
        {
            if (string.IsNullOrWhiteSpace(query))
            {
                return Task.FromResult<IActionResult>(BadRequest(new { message = "Query cannot be empty" }));
            }
            return ProxyJellyseerrRequest($"/api/v1/search/keyword?query={Uri.EscapeDataString(query)}", HttpMethod.Get);
        }

        [HttpGet("tmdb/genres/movie")]
        [Authorize]
        public Task<IActionResult> GetTmdbMovieGenres()
        {
            return ProxyJellyseerrRequest("/api/v1/genres/movie", HttpMethod.Get);
        }

        [HttpGet("tmdb/genres/tv")]
        [Authorize]
        public Task<IActionResult> GetTmdbTvGenres()
        {
            return ProxyJellyseerrRequest("/api/v1/genres/tv", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/genreslider/movie")]
        [Authorize]
        public Task<IActionResult> GetMovieGenreSlider()
        {
            return ProxyJellyseerrRequest("/api/v1/discover/genreslider/movie", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/genreslider/tv")]
        [Authorize]
        public Task<IActionResult> GetTvGenreSlider()
        {
            return ProxyJellyseerrRequest("/api/v1/discover/genreslider/tv", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/overrideRule")]
        [Authorize]
        public Task<IActionResult> GetOverrideRules()
        {
            return ProxyJellyseerrRequest("/api/v1/overrideRule", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/collection/{collectionId}")]
        [Authorize]
        public Task<IActionResult> GetCollection(int collectionId)
        {
            return ProxyJellyseerrRequest($"/api/v1/collection/{collectionId}", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/settings/partial-requests")]
        [Authorize]
        public async Task<IActionResult> GetJellyseerrPartialRequestsSetting()
        {
            var config = _configProvider.ConfigurationOrNull;
            if (config == null || !config.JellyseerrEnabled || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.JellyseerrApiKey))
            {
                // previously returned 200+false, which made the
                // frontend silently flip the request modal to whole-season
                // mode. Returns 503 with structured `code` so the frontend
                // can keep its last-known state instead of regressing.
                _logger.LogWarning("Seerr integration is not configured or enabled.");
                return StatusCode(503, new { error = true, code = "disabled", message = "Seerr integration not configured." });
            }

            var urls = config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            var httpClient = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);

            foreach (var url in urls)
            {
                var trimmedUrl = url.Trim();
                try
                {
                    var requestUri = $"{trimmedUrl.TrimEnd('/')}/api/v1/settings/main";
                    _logger.LogInformation($"Fetching Seerr partial requests setting from: {requestUri}");

                    using var request = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(
                        HttpMethod.Get, requestUri, config.JellyseerrApiKey);
                    using var response = await httpClient.SendAsync(request);
                    var (responseContent, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, requestUri);

                    if (error == null && responseContent != null)
                    {
                        using var settings = JsonDocument.Parse(responseContent);
                        var partialRequestsEnabled = false;
                        if (settings.RootElement.TryGetProperty("partialRequestsEnabled", out var prop))
                        {
                            partialRequestsEnabled = prop.GetBoolean();
                        }

                        var enableSpecialEpisodes = false;
                        if (settings.RootElement.TryGetProperty("enableSpecialEpisodes", out var specialProp))
                        {
                            enableSpecialEpisodes = specialProp.GetBoolean();
                        }

                        _logger.LogInformation($"Seerr settings — partialRequests: {partialRequestsEnabled}, specialEpisodes: {enableSpecialEpisodes}");
                        return Ok(new { partialRequestsEnabled, enableSpecialEpisodes });
                    }

                    _logger.LogWarning($"Failed to fetch Seerr settings from {trimmedUrl}: code={error!.Code} status={error.HttpStatus} cf-ray={error.CfRay} — {error.Message}");
                }
                catch (Exception ex)
                {
                    _logger.LogError($"Failed to connect to Seerr URL: {trimmedUrl}. Error: {ex.Message}");
                }
            }

            // don't silently default to false on outage — that
            // hides admin-configured "partial requests off" UX state. Return
            // 503 so the frontend can keep last-known state.
            _logger.LogWarning("Could not fetch Seerr settings from any URL — surfacing as 503 unreachable");
            return StatusCode(503, new
            {
                error = true,
                code = "unreachable",
                message = "Could not reach Seerr to read partial-requests setting."
            });
        }

        [HttpGet("tmdb/validate")]
        [Authorize(Policy = Policies.RequiresElevation)]
        public async Task<IActionResult> ValidateTmdb([FromQuery] string apiKey)
        {
            // Admin-only: validates an arbitrary API key against TMDB. Any
            // authenticated user could otherwise use this as a free oracle
            // for testing leaked TMDB keys, matching the pattern in every
            // sibling validate endpoint (arr/validate/sonarr|radarr,
            // jellyseerr/validate).
            if (string.IsNullOrWhiteSpace(apiKey))
            {
                return BadRequest(new { ok = false, message = "API key is missing" });
            }

            var httpClient = Helpers.PluginHttpClients.CreateTmdbClient(_httpClientFactory);
            try
            {
                var requestUri = $"https://api.themoviedb.org/3/configuration?api_key={Uri.EscapeDataString(apiKey)}";
                var response = await httpClient.GetAsync(requestUri);

                if (response.IsSuccessStatusCode)
                {
                    return Ok(new { ok = true });
                }

                if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized)
                {
                    return Unauthorized(new { ok = false, message = "Invalid API Key." });
                }

                return StatusCode((int)response.StatusCode, new { ok = false, message = "Failed to connect to TMDB." });
            }
            catch (Exception ex)
            {
                _logger.LogError($"Exception during TMDB API key validation: {ex.Message}");
                return StatusCode(500, new { ok = false, message = "Could not reach TMDB services." });
            }
        }

        [HttpGet("tmdb/{**apiPath}")]
        [Authorize]
        public async Task<IActionResult> ProxyTmdbRequest(string apiPath)
        {
            var config = _configProvider.ConfigurationOrNull;
            if (config == null || string.IsNullOrEmpty(config.TMDB_API_KEY))
            {
                return StatusCode(503, "TMDB API key is not configured.");
            }

            // The raw TMDB passthrough bypasses the Seerr proxy, so gate it here too —
            // otherwise a restricted user could enumerate above-limit titles or recover a
            // blocked title's metadata/sub-resources through /tmdb/{**apiPath} despite the
            // Seerr routes being blocked. Deny-by-default: only an explicit allow-list of
            // rating-free shapes passes, movie/tv detail + sub-resources are parent-gated,
            // and every other shape (including future/unknown ones) is denied. (No-op
            // unless Seerr is configured + the caller is rating-limited.)
            //
            // The FULL query is forwarded to TMDB below, so it is handed to the gate too:
            // otherwise an append_to_response=similar,recommendations rides on an allowed
            // detail and smuggles above-limit title lists the passthrough cannot body-filter.
            var queryString = HttpContext.Request.QueryString;
            if (await _parentalFilter.IsTmdbProxyPathBlockedAsync($"{apiPath}{queryString}", SeerrCaller()))
            {
                return new StatusCodeResult(403);
            }

            var httpClient = Helpers.PluginHttpClients.CreateTmdbClient(_httpClientFactory);
            var separator = queryString.HasValue ? "&" : "?";
            var requestUri = $"https://api.themoviedb.org/3/{apiPath}{queryString}{separator}api_key={config.TMDB_API_KEY}";

            try
            {
                var response = await httpClient.GetAsync(requestUri);
                var content = await response.Content.ReadAsStringAsync();

                if (response.IsSuccessStatusCode)
                {
                    return Content(content, "application/json");
                }

                return StatusCode((int)response.StatusCode, content);
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to proxy TMDB request. Error: {ex.Message}");
                return StatusCode(500, "Failed to connect to TMDB.");
            }
        }

        [HttpGet("jellyseerr/issue")]
        [Authorize]
        public Task<IActionResult> GetJellyseerrIssues(
            [FromQuery] int? mediaId,
            [FromQuery] int take = 20,
            [FromQuery] int skip = 0,
            [FromQuery] string? filter = "all",
            [FromQuery] string? sort = "added")
        {
            take = Math.Clamp(take, 1, 200);
            skip = Math.Max(0, skip);

            var queryParts = new List<string>
            {
                $"take={take}",
                $"skip={skip}"
            };

            if (mediaId.HasValue && mediaId.Value > 0)
            {
                queryParts.Add($"mediaId={mediaId.Value}");
            }

            if (!string.IsNullOrWhiteSpace(filter))
            {
                queryParts.Add($"filter={Uri.EscapeDataString(filter)}");
            }

            if (!string.IsNullOrWhiteSpace(sort))
            {
                queryParts.Add($"sort={Uri.EscapeDataString(sort)}");
            }

            var queryString = string.Join("&", queryParts);
            var apiPath = string.IsNullOrWhiteSpace(queryString) ? "/api/v1/issue" : $"/api/v1/issue?{queryString}";

            return ProxyJellyseerrRequest(apiPath, HttpMethod.Get);
        }

        [HttpGet("jellyseerr/issue/{id}")]
        [Authorize]
        public Task<IActionResult> GetJellyseerrIssueById(int id)
        {
            // V8-style guard. Seerr returns 500 for /issue/0 or /issue/-1.
            if (id <= 0)
            {
                return Task.FromResult<IActionResult>(BadRequest(new
                {
                    error = true,
                    code = "invalid_issue_id",
                    message = "Issue id must be positive."
                }));
            }
            return ProxyJellyseerrRequest($"/api/v1/issue/{id}", HttpMethod.Get);
        }

        [HttpPost("jellyseerr/issue")]
        [Authorize]
        public async Task<IActionResult> ReportJellyseerrIssue([FromBody] JsonElement issueBody)
        {
            return await ProxyJellyseerrRequest("/api/v1/issue", HttpMethod.Post, issueBody.ToString());
        }
    }
}
