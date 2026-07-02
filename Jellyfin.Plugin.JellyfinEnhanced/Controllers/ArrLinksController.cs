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

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>
    /// Arr link endpoints (validate, identify-url, series-slug(s), movie-instances).
    /// Split out of the former JellyfinEnhancedController; method bodies, routes
    /// and attributes are unchanged.
    /// </summary>
    [Route("JellyfinEnhanced")]
    [ApiController]
    public class ArrLinksController : JellyfinEnhancedControllerBase
    {
        public ArrLinksController(
            IHttpClientFactory httpClientFactory,
            Logger logger,
            IUserManager userManager,
            ISeerrCache seerrCache)
            : base(httpClientFactory, logger, userManager, seerrCache)
        {
        }

        // ==================== Arr Links ====================

        [HttpGet("arr/validate/sonarr")]
        [Authorize]
        public async Task<IActionResult> ValidateSonarr([FromQuery] string url, [FromHeader(Name = "X-Arr-ApiKey")] string apiKey)
        {
            return await ValidateArrService("Sonarr", url, apiKey);
        }

        [HttpGet("arr/validate/radarr")]
        [Authorize]
        public async Task<IActionResult> ValidateRadarr([FromQuery] string url, [FromHeader(Name = "X-Arr-ApiKey")] string apiKey)
        {
            return await ValidateArrService("Radarr", url, apiKey);
        }

        private async Task<IActionResult> ValidateArrService(string serviceName, string url, string apiKey)
        {
            if (!IsAdminUser())
                return Forbid();

            if (string.IsNullOrWhiteSpace(url) || string.IsNullOrWhiteSpace(apiKey))
                return BadRequest(new { ok = false, message = $"Missing {serviceName} URL or API key" });

            if (!IsAllowedUrl(url))
                return BadRequest(new { ok = false, message = "Invalid URL" });

            var http = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
            http.DefaultRequestHeaders.Clear();
            http.DefaultRequestHeaders.Add("X-Api-Key", apiKey);
            http.Timeout = TimeSpan.FromSeconds(10);

            try
            {
                using var resp = await http.GetAsync($"{url.TrimEnd('/')}/api/v3/system/status");
                if (resp.IsSuccessStatusCode)
                    return Ok(new { ok = true });

                if (resp.StatusCode == System.Net.HttpStatusCode.Unauthorized ||
                    resp.StatusCode == System.Net.HttpStatusCode.Forbidden)
                    return StatusCode(401, new { ok = false, message = $"API key is invalid or unauthorized for {serviceName}" });

                return StatusCode((int)resp.StatusCode, new { ok = false, message = $"{serviceName} returned an error (status {(int)resp.StatusCode})" });
            }
            catch (TaskCanceledException)
            {
                return StatusCode(504, new { ok = false, message = $"Connection to {serviceName} timed out. Check the URL is correct." });
            }
            catch (Exception ex)
            {
                _logger.Warning($"{serviceName} validate failed for {url}: {ex.Message}");
                return StatusCode(502, new { ok = false, message = $"Could not reach {serviceName}. Check the URL is correct and the server is running." });
            }
        }

        [HttpGet("arr/identify-url")]
        [Authorize]
        public async Task<IActionResult> IdentifyUrl([FromQuery] string url)
        {
            if (!IsAdminUser())
                return Forbid();

            if (string.IsNullOrWhiteSpace(url))
                return BadRequest(new { reachable = false, service = "unknown" });

            if (!IsAllowedUrl(url))
                return BadRequest(new { reachable = false, service = "unknown" });

            var http = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
            http.Timeout = TimeSpan.FromSeconds(5);
            var cleanUrl = url.TrimEnd('/');

            // Try Sonarr/Radarr (/api/v3/system/status)
            try
            {
                using var resp = await http.GetAsync($"{cleanUrl}/api/v3/system/status");
                if (resp.IsSuccessStatusCode)
                {
                    var ct = resp.Content.Headers.ContentType?.MediaType ?? "";
                    if (ct.Contains("json"))
                    {
                        var json = await resp.Content.ReadAsStringAsync();
                        if (json.Contains("appName", StringComparison.Ordinal))
                        {
                            if (json.Contains("Sonarr", StringComparison.OrdinalIgnoreCase))
                                return Ok(new { reachable = true, service = "Sonarr" });
                            if (json.Contains("Radarr", StringComparison.OrdinalIgnoreCase))
                                return Ok(new { reachable = true, service = "Radarr" });
                        }
                    }
                }
                else if (resp.StatusCode == System.Net.HttpStatusCode.Unauthorized ||
                         resp.StatusCode == System.Net.HttpStatusCode.Forbidden)
                {
                    var contentType = resp.Content.Headers.ContentType?.MediaType ?? "";
                    if (contentType.Contains("json"))
                        return Ok(new { reachable = true, service = "arr" });
                }
            }
            catch (HttpRequestException) { /* continue to next service probe */ }
            catch (TaskCanceledException) { /* continue to next service probe */ }

            // Try Jellyfin (/System/Info/Public — public endpoint, returns JSON)
            try
            {
                using var resp = await http.GetAsync($"{cleanUrl}/System/Info/Public");
                if (resp.IsSuccessStatusCode)
                {
                    var ct = resp.Content.Headers.ContentType?.MediaType ?? "";
                    if (ct.Contains("json"))
                    {
                        var body = await resp.Content.ReadAsStringAsync();
                        if (body.Contains("ServerName", StringComparison.OrdinalIgnoreCase))
                            return Ok(new { reachable = true, service = "Jellyfin" });
                    }
                }
            }
            catch (HttpRequestException) { /* continue to next service probe */ }
            catch (TaskCanceledException) { /* continue to next service probe */ }

            // Try Jellyseerr (/api/v1/status — returns JSON)
            try
            {
                using var resp = await http.GetAsync($"{cleanUrl}/api/v1/status");
                if (resp.IsSuccessStatusCode)
                {
                    var ct = resp.Content.Headers.ContentType?.MediaType ?? "";
                    if (ct.Contains("json"))
                        return Ok(new { reachable = true, service = "Seerr" });
                }
            }
            catch (HttpRequestException) { /* continue to next service probe */ }
            catch (TaskCanceledException) { /* continue to next service probe */ }

            // Try generic reachability — also check HTML title for service name
            try
            {
                using var resp = await http.GetAsync(cleanUrl, HttpCompletionOption.ResponseHeadersRead);
                if (resp.IsSuccessStatusCode)
                {
                    // Only read first 64KB — title tag is near the top of the HTML
                    var buffer = new byte[65536];
                    using var stream = await resp.Content.ReadAsStreamAsync();
                    var bytesRead = await stream.ReadAsync(buffer, 0, buffer.Length);
                    var body = System.Text.Encoding.UTF8.GetString(buffer, 0, bytesRead);
                    // Check <title> tag for known service names (SPA root pages)
                    var titleMatch = System.Text.RegularExpressions.Regex.Match(
                        body, @"<title[^>]*>([^<]*)</title>", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                    if (titleMatch.Success)
                    {
                        var title = titleMatch.Groups[1].Value;
                        if (title.Contains("Sonarr", StringComparison.OrdinalIgnoreCase))
                            return Ok(new { reachable = true, service = "Sonarr" });
                        if (title.Contains("Radarr", StringComparison.OrdinalIgnoreCase))
                            return Ok(new { reachable = true, service = "Radarr" });
                        if (title.Contains("Bazarr", StringComparison.OrdinalIgnoreCase))
                            return Ok(new { reachable = true, service = "Bazarr" });
                        if (title.Contains("Jellyseerr", StringComparison.OrdinalIgnoreCase)
                            || title.Contains("Overseerr", StringComparison.OrdinalIgnoreCase))
                            return Ok(new { reachable = true, service = "Seerr" });
                        if (title.Contains("Jellyfin", StringComparison.OrdinalIgnoreCase))
                            return Ok(new { reachable = true, service = "Jellyfin" });
                    }
                }
                return Ok(new { reachable = true, service = "unknown" });
            }
            catch (HttpRequestException)
            {
                return Ok(new { reachable = false, service = "unknown" });
            }
            catch (TaskCanceledException)
            {
                return Ok(new { reachable = false, service = "unknown" });
            }
        }

        [HttpGet("arr/series-slug")]
        [Authorize]
        public async Task<IActionResult> GetSeriesSlug([FromQuery] int tvdbId)
        {
            if (!IsAdminUser())
                return Forbid();

            if (tvdbId <= 0)
                return BadRequest(new { error = "tvdbId must be a positive integer" });

            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null)
                return StatusCode(500, new { error = "Plugin configuration not available" });

            WarnIfArrInstancesCorrupt(config);
            var instances = config.GetEnabledSonarrInstances();
            if (instances.Count == 0)
            {
                if (config.IsSonarrInstancesCorrupt())
                    return StatusCode(500, new { error = "Sonarr instance configuration is corrupt — see server logs" });
                return NotFound(new { error = "Sonarr is not configured" });
            }

            var outcome = await FetchSeriesInfoFromInstance(instances[0], tvdbId, HttpContext.RequestAborted);
            if (outcome.Error != null)
                return StatusCode(502, new { error = $"Sonarr fetch failed: {outcome.Error}" });
            if (outcome.Match == null)
                return NotFound(new { error = "Series not found in Sonarr" });

            // Legacy endpoint: extract titleSlug from the enriched response. Preserve the historical
            // contract — return 404 rather than 200+null if the upstream response lacks titleSlug.
            var titleSlug = (string?)((dynamic)outcome.Match).titleSlug;
            if (string.IsNullOrEmpty(titleSlug))
                return NotFound(new { error = "Series not found in Sonarr" });
            return Ok(new { titleSlug });
        }

        [HttpGet("arr/series-slugs")]
        [Authorize]
        public async Task<IActionResult> GetSeriesSlugs([FromQuery] int tvdbId)
        {
            if (!IsAdminUser())
                return Forbid();

            if (tvdbId <= 0)
                return BadRequest(new { error = "tvdbId must be a positive integer" });

            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null)
                return StatusCode(500, new { error = "Plugin configuration not available" });

            WarnIfArrInstancesCorrupt(config);
            var instances = config.GetEnabledSonarrInstances();
            if (instances.Count == 0)
            {
                var errList = new List<object>();
                if (config.IsSonarrInstancesCorrupt())
                    errList.Add(new { instanceName = "Sonarr", reason = "config corrupt — see server logs" });
                else if (config.GetSonarrInstances().Count > 0)
                    // Distinguish "admin disabled everything" from "never configured" so the
                    // frontend can toast the right message instead of silently showing no links.
                    errList.Add(new { instanceName = "Sonarr", reason = "all Sonarr instances are disabled" });
                return Ok(new { matches = Array.Empty<object>(), errors = errList });
            }

            var ct = HttpContext.RequestAborted;
            var outcomes = await Task.WhenAll(instances.Select(i => FetchSeriesInfoFromInstance(i, tvdbId, ct)));

            var matches = new List<object>();
            var errors = new List<object>();
            for (int i = 0; i < outcomes.Length; i++)
            {
                if (outcomes[i].Match != null) matches.Add(outcomes[i].Match!);
                if (outcomes[i].Error != null)
                    errors.Add(new { instanceName = instances[i].Name, reason = outcomes[i].Error });
            }

            return Ok(new { matches, errors });
        }

        private struct ArrFetchOutcome
        {
            public object? Match;
            public string? Error;
        }

        private static dynamic? SingleItemOrNull(dynamic? data)
        {
            if (data is Newtonsoft.Json.Linq.JArray arr)
                return arr.Count > 0 ? arr[0] : null;
            return data;
        }

        private async Task<ArrFetchOutcome> FetchSeriesInfoFromInstance(ArrInstance instance, int tvdbId, CancellationToken ct)
        {
            var (match, error) = await FetchAndMapAsync<object?>(
                instance,
                $"/api/v3/series?tvdbId={tvdbId}",
                data =>
                {
                    var item = SingleItemOrNull(data);
                    if (item == null) return null;
                    var titleSlug = (string?)item.titleSlug;
                    // Treat empty/missing titleSlug as "no match" rather than returning a record
                    // that would render a broken `/series/null` link on the frontend. The legacy
                    // single-instance endpoint already had this guard; preserve it here.
                    if (string.IsNullOrEmpty(titleSlug)) return null;
                    return new
                    {
                        instanceName = instance.Name,
                        instanceUrl = instance.Url,
                        titleSlug,
                        urlMappings = instance.UrlMappings,
                        episodeFileCount = (int?)item.statistics?.episodeFileCount ?? 0,
                        episodeCount = (int?)item.statistics?.episodeCount ?? 0,
                        percentOfEpisodes = (double?)item.statistics?.percentOfEpisodes ?? 0,
                        sizeOnDisk = (long?)item.statistics?.sizeOnDisk ?? 0,
                        rootFolderPath = GetRootFolderFromPath((string?)item.path)
                    };
                },
                emptyResult: null,
                timeout: TimeSpan.FromSeconds(10),
                contextLabel: $"Sonarr series (TVDB {tvdbId})",
                ct: ct).ConfigureAwait(false);
            return new ArrFetchOutcome { Match = match, Error = error };
        }

        [HttpGet("arr/movie-instances")]
        [Authorize]
        public async Task<IActionResult> GetMovieInstances([FromQuery] int tmdbId)
        {
            if (!IsAdminUser())
                return Forbid();

            if (tmdbId <= 0)
                return BadRequest(new { error = "tmdbId must be a positive integer" });

            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null)
                return StatusCode(500, new { error = "Plugin configuration not available" });

            WarnIfArrInstancesCorrupt(config);
            var instances = config.GetEnabledRadarrInstances();
            if (instances.Count == 0)
            {
                var errList = new List<object>();
                if (config.IsRadarrInstancesCorrupt())
                    errList.Add(new { instanceName = "Radarr", reason = "config corrupt — see server logs" });
                else if (config.GetRadarrInstances().Count > 0)
                    errList.Add(new { instanceName = "Radarr", reason = "all Radarr instances are disabled" });
                return Ok(new { matches = Array.Empty<object>(), errors = errList });
            }

            var ct = HttpContext.RequestAborted;
            var outcomes = await Task.WhenAll(instances.Select(i => FetchMovieInfoFromInstance(i, tmdbId, ct)));

            var matches = new List<object>();
            var errors = new List<object>();
            for (int i = 0; i < outcomes.Length; i++)
            {
                if (outcomes[i].Match != null) matches.Add(outcomes[i].Match!);
                if (outcomes[i].Error != null)
                    errors.Add(new { instanceName = instances[i].Name, reason = outcomes[i].Error });
            }

            return Ok(new { matches, errors });
        }

        private async Task<ArrFetchOutcome> FetchMovieInfoFromInstance(ArrInstance instance, int tmdbId, CancellationToken ct)
        {
            var (match, error) = await FetchAndMapAsync<object?>(
                instance,
                $"/api/v3/movie?tmdbId={tmdbId}",
                data =>
                {
                    var item = SingleItemOrNull(data);
                    if (item == null) return null;
                    return new
                    {
                        instanceName = instance.Name,
                        instanceUrl = instance.Url,
                        urlMappings = instance.UrlMappings,
                        hasFile = (bool?)item.hasFile ?? false,
                        sizeOnDisk = (long?)item.sizeOnDisk ?? 0,
                        rootFolderPath = GetRootFolderFromPath((string?)item.path)
                    };
                },
                emptyResult: null,
                timeout: TimeSpan.FromSeconds(10),
                contextLabel: $"Radarr movie (TMDB {tmdbId})",
                ct: ct).ConfigureAwait(false);
            return new ArrFetchOutcome { Match = match, Error = error };
        }
    }
}
