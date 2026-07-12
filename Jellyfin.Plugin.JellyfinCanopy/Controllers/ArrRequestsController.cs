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
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using MediaBrowser.Controller;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Jellyfin.Plugin.JellyfinCanopy.Model.Jellyseerr;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Jellyseerr;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model;
using MediaBrowser.Controller.Persistence;
using Jellyfin.Plugin.JellyfinCanopy.Model.Arr;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Enums;
using Microsoft.EntityFrameworkCore;
using Jellyfin.Plugin.JellyfinCanopy.Services.Jellyseerr;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Controllers
{
    /// <summary>
    /// Arr download queue plus Seerr requests list and approve/decline.
    /// Split out of the former JellyfinCanopyController; method bodies, routes
    /// and attributes are unchanged.
    /// </summary>
    [Route("JellyfinCanopy")]
    [ApiController]
    public class ArrRequestsController : JellyfinCanopyControllerBase
    {
        private readonly IJellyseerrClient _jellyseerr;
        private readonly Services.Arr.ArrFetchService _arrFetch;
        private readonly ISeerrParentalFilter _parentalFilter;

        public ArrRequestsController(
            IHttpClientFactory httpClientFactory,
            ILogger<ArrRequestsController> logger,
            IUserManager userManager,
            ISeerrCache seerrCache,
            IPluginConfigProvider configProvider,
            IJellyseerrClient jellyseerr,
            Services.Arr.ArrFetchService arrFetch,
            ISeerrParentalFilter parentalFilter)
            : base(httpClientFactory, logger, userManager, seerrCache, configProvider)
        {
            _jellyseerr = jellyseerr;
            _arrFetch = arrFetch;
            _parentalFilter = parentalFilter;
        }

        [HttpGet("arr/queue")]
        [Authorize]
        public async Task<IActionResult> GetDownloadQueue()
        {
            var config = _configProvider.ConfigurationOrNull;
            if (config == null)
                return StatusCode(500, "Plugin configuration not available");

            // Non-admin users can only see downloads for items they requested via Seerr
            // unless the admin has disabled per-user filtering
            HashSet<(int TmdbId, string MediaType)>? allowedRequests = null;
            HashSet<int>? allowedTvTvdb = null;
            if (!IsAdminUser() && config.DownloadsFilterByUserRequests)
            {
                if (!config.JellyseerrEnabled || string.IsNullOrWhiteSpace(config.JellyseerrUrls) || string.IsNullOrWhiteSpace(config.JellyseerrApiKey))
                {
                    return Ok(new { items = new List<object>(), errors = new List<object>() });
                }

                var jellyfinUserId = UserHelper.GetCurrentUserId(User)?.ToString();
                if (string.IsNullOrEmpty(jellyfinUserId))
                {
                    return Ok(new { items = new List<object>(), errors = new List<object>() });
                }

                var jellyseerrUserId = await _jellyseerr.GetJellyseerrUserId(jellyfinUserId);
                if (string.IsNullOrEmpty(jellyseerrUserId))
                {
                    return Ok(new { items = new List<object>(), errors = new List<object>() });
                }

                var userRequests = await _jellyseerr.GetRequestsForUser(jellyseerrUserId);
                if (userRequests == null || userRequests.Count == 0)
                {
                    return Ok(new { items = new List<object>(), errors = new List<object>() });
                }

                allowedRequests = new HashSet<(int, string)>(userRequests.Select(r => (r.TmdbId, r.MediaType)));

                // Sonarr is TVDB-native and routinely reports series.tmdbId 0 for its download
                // records, so a TV request must also be matchable by TVDB id — otherwise the user's
                // own TV download is silently dropped.
                allowedTvTvdb = new HashSet<int>(userRequests
                    .Where(r => r.MediaType == "tv" && r.TvdbId is > 0)
                    .Select(r => r.TvdbId!.Value));
            }

            WarnIfArrInstancesCorrupt(config);
            var sonarrInstances = config.GetEnabledSonarrInstances();
            var radarrInstances = config.GetEnabledRadarrInstances();

            var ct = HttpContext.RequestAborted;
            var sonarrTasks = sonarrInstances.Select((i, idx) => FetchSonarrQueue(i, idx, allowedRequests, allowedTvTvdb, ct)).ToList();
            var radarrTasks = radarrInstances.Select((i, idx) => FetchRadarrQueue(i, idx, allowedRequests, ct)).ToList();

            var sonarrResults = await Task.WhenAll(sonarrTasks);
            var radarrResults = await Task.WhenAll(radarrTasks);

            var items = new List<object>();
            var errors = new List<object>();
            if (config.IsSonarrInstancesCorrupt())
                errors.Add(new { instanceName = "Sonarr", source = "Sonarr", reason = "config corrupt — see server logs" });
            else if (sonarrInstances.Count == 0 && config.GetSonarrInstances().Count > 0)
                errors.Add(new { instanceName = "Sonarr", source = "Sonarr", reason = "all Sonarr instances are disabled" });
            if (config.IsRadarrInstancesCorrupt())
                errors.Add(new { instanceName = "Radarr", source = "Radarr", reason = "config corrupt — see server logs" });
            else if (radarrInstances.Count == 0 && config.GetRadarrInstances().Count > 0)
                errors.Add(new { instanceName = "Radarr", source = "Radarr", reason = "all Radarr instances are disabled" });
            for (int i = 0; i < sonarrResults.Length; i++)
            {
                items.AddRange(sonarrResults[i].Items);
                if (sonarrResults[i].Error != null)
                    errors.Add(new { instanceName = sonarrInstances[i].Name, source = "Sonarr", reason = sonarrResults[i].Error });
            }
            for (int i = 0; i < radarrResults.Length; i++)
            {
                items.AddRange(radarrResults[i].Items);
                if (radarrResults[i].Error != null)
                    errors.Add(new { instanceName = radarrInstances[i].Name, source = "Radarr", reason = radarrResults[i].Error });
            }

            return Ok(new { items, errors });
        }

        private static string? PosterFromImages(JsonNode? images)
        {
            if (images is not JsonArray imageArray) return null;
            foreach (var img in imageArray)
            {
                if ((string?)img?["coverType"] == "poster")
                    return (string?)img?["remoteUrl"] ?? (string?)img?["url"];
            }
            return null;
        }

        // Per-user download-queue match for a Sonarr record. A Seerr TV request carries both a TMDB
        // and (usually) a TVDB id, but Sonarr download records report the series with tmdbId 0, so the
        // record must match either the TMDB set or the TV-TVDB set. Both ids are re-normalized here so a
        // 0 can never key a match. allowedRequests == null means unfiltered (admin) passthrough.
        internal static bool IsSonarrQueueItemAllowed(
            int? tmdbId,
            int? tvdbId,
            HashSet<(int TmdbId, string MediaType)>? allowedRequests,
            HashSet<int>? allowedTvTvdb)
        {
            if (allowedRequests == null)
                return true;

            tmdbId = ArrIdHelper.ToNullableId(tmdbId);
            tvdbId = ArrIdHelper.ToNullableId(tvdbId);

            bool tmdbOk = tmdbId is int tm && allowedRequests.Contains((tm, "tv"));
            bool tvdbOk = tvdbId is int tv && allowedTvTvdb != null && allowedTvTvdb.Contains(tv);
            return tmdbOk || tvdbOk;
        }

        private Task<(List<object> Items, string? Error)> FetchSonarrQueue(ArrInstance instance, int instanceIndex, HashSet<(int TmdbId, string MediaType)>? allowedRequests, HashSet<int>? allowedTvTvdb, CancellationToken ct)
        {
            return _arrFetch.FetchAndMapAsync<List<object>>(
                instance,
                "/api/v3/queue?includeEpisode=true&includeSeries=true&sortKey=timeleft&sortDirection=ascending&pageSize=1000",
                data =>
                {
                    var items = new List<object>();
                    if (data?["records"] is not JsonArray records) return items;
                    foreach (var record in records)
                    {
                        var series = record?["series"];
                        var episode = record?["episode"];
                        int? tmdbId = ArrIdHelper.ToNullableId((int?)series?["tmdbId"]);
                        int? tvdbId = ArrIdHelper.ToNullableId((int?)series?["tvdbId"]);
                        if (!IsSonarrQueueItemAllowed(tmdbId, tvdbId, allowedRequests, allowedTvTvdb))
                            continue;

                        var seasonNumber = (int?)episode?["seasonNumber"];
                        var episodeNumber = (int?)episode?["episodeNumber"];
                        items.Add(new
                        {
                            // Namespace the per-instance queue id by source + the instance's unique
                            // position so two Sonarr instances that both number queue records from 1 —
                            // even with an identical or blank display name — can't collide.
                            id = ArrIdHelper.NamespacedId(nameof(ArrType.Sonarr), instanceIndex, record?["id"]),
                            source = nameof(ArrType.Sonarr),
                            instanceName = instance.Name,
                            title = (string?)series?["title"] ?? "Unknown",
                            subtitle = $"S{seasonNumber:D2}E{episodeNumber:D2} - {(string?)episode?["title"]}",
                            seasonNumber = seasonNumber,
                            episodeNumber = episodeNumber,
                            status = (string?)record?["status"] ?? "Unknown",
                            progress = CalculateProgress((double?)record?["size"], (double?)record?["sizeleft"]),
                            totalSize = (long?)record?["size"],
                            sizeRemaining = (long?)record?["sizeleft"],
                            timeRemaining = (string?)record?["timeleft"],
                            posterUrl = PosterFromImages(series?["images"]),
                            tmdbId = tmdbId
                        });
                    }
                    return items;
                },
                emptyResult: new List<object>(),
                timeout: TimeSpan.FromSeconds(10),
                contextLabel: "Sonarr queue",
                ct: ct);
        }

        private Task<(List<object> Items, string? Error)> FetchRadarrQueue(ArrInstance instance, int instanceIndex, HashSet<(int TmdbId, string MediaType)>? allowedRequests, CancellationToken ct)
        {
            return _arrFetch.FetchAndMapAsync<List<object>>(
                instance,
                "/api/v3/queue?includeMovie=true&pageSize=1000",
                data =>
                {
                    var items = new List<object>();
                    if (data?["records"] is not JsonArray records) return items;
                    foreach (var record in records)
                    {
                        var movie = record?["movie"];
                        int? tmdbId = ArrIdHelper.ToNullableId((int?)movie?["tmdbId"]);
                        if (allowedRequests != null && (!tmdbId.HasValue || !allowedRequests.Contains((tmdbId.Value, "movie"))))
                            continue;

                        items.Add(new
                        {
                            // Namespace the per-instance queue id by source + the instance's unique
                            // position so two Radarr instances that both number queue records from 1 —
                            // even with an identical or blank display name — can't collide.
                            id = ArrIdHelper.NamespacedId(nameof(ArrType.Radarr), instanceIndex, record?["id"]),
                            source = nameof(ArrType.Radarr),
                            instanceName = instance.Name,
                            title = (string?)movie?["title"] ?? "Unknown",
                            subtitle = movie?["year"]?.ToString(),
                            seasonNumber = (int?)null,
                            episodeNumber = (int?)null,
                            status = (string?)record?["status"] ?? "Unknown",
                            progress = CalculateProgress((double?)record?["size"], (double?)record?["sizeleft"]),
                            totalSize = (long?)record?["size"],
                            sizeRemaining = (long?)record?["sizeleft"],
                            timeRemaining = (string?)record?["timeleft"],
                            posterUrl = PosterFromImages(movie?["images"]),
                            tmdbId = tmdbId
                        });
                    }
                    return items;
                },
                emptyResult: new List<object>(),
                timeout: TimeSpan.FromSeconds(10),
                contextLabel: "Radarr queue",
                ct: ct);
        }

        private static double CalculateProgress(double? size, double? sizeleft)
        {
            if (size == null || size == 0) return 0;
            if (sizeleft == null) return 100;
            return Math.Round((1 - (sizeleft.Value / size.Value)) * 100, 1);
        }

        [HttpGet("arr/requests")]
        [Authorize]
        public async Task<IActionResult> GetRequests([FromQuery] int take = 20, [FromQuery] int skip = 0, [FromQuery] string? filter = null, [FromQuery] bool userOnly = false)
        {
            take = Math.Clamp(take, 1, 200);
            skip = Math.Max(0, skip);

            var config = _configProvider.ConfigurationOrNull;
            if (config == null)
                return StatusCode(500, "Plugin configuration not available");

            if (string.IsNullOrWhiteSpace(config.JellyseerrUrls) || string.IsNullOrWhiteSpace(config.JellyseerrApiKey))
            {
                return Ok(new { requests = new List<object>(), totalPages = 0, totalResults = 0 });
            }

            try
            {
                // iterate every configured Seerr URL, not
                // just the first one. Previously a downed primary URL produced
                // an immediate 502 even when a second URL would have answered.
                var allUrls = config.JellyseerrUrls.Split(new[] { '\r', '\n', ',' }, StringSplitOptions.RemoveEmptyEntries)
                    .Select(u => u.Trim().TrimEnd('/'))
                    .Where(u => !string.IsNullOrWhiteSpace(u))
                    .ToList();
                if (allUrls.Count == 0)
                {
                    return StatusCode(503, new { error = true, code = "disabled", message = "Seerr URL not configured." });
                }
                var client = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
                client.Timeout = TimeSpan.FromSeconds(15);
                bool hasRequestViewPermission = false;

                var jellyfinUserId = UserHelper.GetCurrentUserId(User)?.ToString();

                if (string.IsNullOrEmpty(jellyfinUserId))
                {
                    _logger.LogWarning("Could not find Jellyfin User ID in claims.");
                    return BadRequest(new { message = "Jellyfin User ID was not provided in claims." });
                }

                var jellyseerrUser = await _jellyseerr.GetJellyseerrUser(jellyfinUserId);

                if (jellyseerrUser == null)
                {
                    _logger.LogWarning($"Could not find a Seerr user for Jellyfin user {ResolveUserDisplay(jellyfinUserId)}. Aborting request.");
                    return NotFound(new { message = "Current Jellyfin user is not linked to a Seerr user." });
                }

                // Check if user has permission to view all requests
                // Jellyfin admins can always view all requests regardless of Seerr permissions
                hasRequestViewPermission = IsAdminUser() || JellyseerrPermissionHelper.HasAnyPermission(
                    jellyseerrUser.Permissions,
                    JellyseerrPermission.ADMIN | JellyseerrPermission.MANAGE_REQUESTS | JellyseerrPermission.REQUEST_VIEW
                );

                // Build filter parameter
                // "comingsoon" is a custom filter - fetch processing items and filter server-side
                var isComingSoonFilter = string.Equals(filter, "comingsoon", StringComparison.OrdinalIgnoreCase);
                var filterParam = filter?.ToLower() switch
                {
                    "pending" => "&filter=pending",
                    "approved" => "&filter=approved",
                    "available" => "&filter=available",
                    "processing" => "&filter=processing",
                    "comingsoon" => "&filter=processing", // Fetch processing, then filter for future dates
                    _ => ""
                };

                // If user lacks permission or user-only is requested, filter to only their requests
                if (!hasRequestViewPermission || userOnly)
                {
                    filterParam += $"&requestedBy={jellyseerrUser.Id}";
                }

                // iterate URLs; only return 502 if ALL fail.
                // Per-URL try/catch so a DNS failure or timeout on URL #1 doesn't
                // escape and prevent URL #2 from being tried.
                string? json = null;
                string? jellyseerrUrl = null;     // url that responded (for downstream enrichment)
                Helpers.Jellyseerr.SeerrError? lastError = null;
                foreach (var candidateUrl in allUrls)
                {
                    var requestsUri = $"{candidateUrl}/api/v1/request?take={take}&skip={skip}{filterParam}";
                    try
                    {
                        using var requestsRequest = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(
                            HttpMethod.Get, requestsUri, config.JellyseerrApiKey);
                        using var response = await client.SendAsync(requestsRequest);
                        var (urlJson, urlError) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, requestsUri);
                        if (urlError == null && urlJson != null)
                        {
                            json = urlJson;
                            jellyseerrUrl = candidateUrl;
                            break;
                        }
                        lastError = urlError;
                        _logger.LogWarning($"Seerr requests fetch failed at {candidateUrl}: code={urlError!.Code} status={urlError.HttpStatus} cf-ray={urlError.CfRay} — {urlError.Message}");
                    }
                    catch (Exception innerEx)
                    {
                        lastError = new Helpers.Jellyseerr.SeerrError
                        {
                            Code = Helpers.Jellyseerr.SeerrErrorCode.Unreachable,
                            HttpStatus = 0,
                            Url = candidateUrl,
                            Message = $"Failed to reach {candidateUrl}: {innerEx.Message}",
                            UserMessage = "Can't reach Seerr right now. Please try again in a moment."
                        };
                        _logger.LogWarning($"Seerr requests fetch threw at {candidateUrl}: {innerEx.Message}");
                    }
                }
                if (json == null)
                {
                    var error = lastError!;
                    int httpCode = error.Code switch
                    {
                        Helpers.Jellyseerr.SeerrErrorCode.HtmlResponse => 502,
                        Helpers.Jellyseerr.SeerrErrorCode.UpstreamRedirect => 502,
                        Helpers.Jellyseerr.SeerrErrorCode.Cloudflare5xx => 502,
                        _ => error.HttpStatus > 0 ? error.HttpStatus : 502,
                    };
                    return StatusCode(httpCode, new
                    {
                        error = true,
                        code = error.Code.ToString(),
                        cfRay = error.CfRay,
                        message = IsAdminUser() ? error.Message : Helpers.Jellyseerr.SeerrError.SanitizeMessage(error.Message),
                        requests = new List<object>(),
                        totalPages = 0,
                        totalResults = 0
                    });
                }

                // Enforce each caller's own parental-rating limit on the request list —
                // the same gate the /jellyseerr/request route applies via ProxyRequestAsync.
                // Reuses the "/api/v1/request" classification (Category.List, nested `media`),
                // resolves the caller from the auth principal (never a client header), and is
                // a no-op for admins / no-limit users / feature off. Never throws (the filter
                // passes the body through on any fault). Runs before enrichment so the TMDB
                // round-trips only fire for surviving rows.
                var parental = await _parentalFilter.ApplyAsync(json!, "/api/v1/request", SeerrCaller());
                json = parental.Body; // Block is never set for a list endpoint.

                var data = JsonNode.Parse(json!)!.AsObject();

                var requests = new List<object>();
                var results = data["results"] as JsonArray;
                bool selfScoped = !hasRequestViewPermission || userOnly;

                // "Coming Soon" is aggregated across ALL upstream pages of `processing` AND
                // `approved` — the single-page path only ever saw page 1 of processing, so
                // future-dated requests further in (and every `approved` item) were unreachable
                // and the paginator was wrong. Each aggregated page is parental-filtered and the
                // rows are deduped by request id; the full future set is ordered and windowed
                // locally below (ARR-5).
                int comingSoonTotal = 0;
                if (isComingSoonFilter)
                {
                    var scopeParam = selfScoped ? $"&requestedBy={jellyseerrUser.Id}" : string.Empty;

                    async Task<(int RawCount, JsonArray? Filtered)> FetchComingSoonPage(string upstreamFilter, int pageSkip, int pageTake)
                    {
                        var pageUri = $"{jellyseerrUrl}/api/v1/request?take={pageTake}&skip={pageSkip}&filter={upstreamFilter}{scopeParam}";
                        try
                        {
                            using var pageRequest = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(
                                HttpMethod.Get, pageUri, config.JellyseerrApiKey);
                            using var pageResponse = await client.SendAsync(pageRequest);
                            var (pageJson, pageError) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(pageResponse, pageUri);
                            if (pageError != null || pageJson == null)
                            {
                                return (0, null);
                            }

                            // Count the RAW upstream rows BEFORE the parental filter shrinks the
                            // page, so aggregation paginates by the true upstream page length
                            // (SEC-SEERR-3): otherwise a rating-limited caller's filtered short
                            // pages would stop the walk early and hide future-dated items.
                            var rawCount = (JsonNode.Parse(pageJson) as JsonObject)?["results"] is JsonArray rawResults
                                ? rawResults.Count
                                : 0;

                            // Every aggregated page gets the same parental gate as the primary fetch.
                            var pageParental = await _parentalFilter.ApplyAsync(pageJson, "/api/v1/request", SeerrCaller());
                            var pageData = JsonNode.Parse(pageParental.Body)!.AsObject();
                            return (rawCount, pageData["results"] as JsonArray);
                        }
                        catch (Exception ex)
                        {
                            _logger.LogWarning($"Coming-soon page fetch failed ({upstreamFilter} skip={pageSkip}): {ex.Message}");
                            return (0, null);
                        }
                    }

                    var rawPages = await AggregateComingSoonPagesAsync(
                        FetchComingSoonPage, ComingSoonUpstreamFilters, ComingSoonPageSize, ComingSoonMaxItems);

                    // Deep-clone each row into a fresh array so it can be re-parented cleanly.
                    var combinedResults = new JsonArray();
                    foreach (var obj in rawPages)
                    {
                        combinedResults.Add(obj.DeepClone());
                    }

                    data["results"] = combinedResults;
                    results = combinedResults;
                }

                // Defense-in-depth backstop: the admin-key fetch scopes to the caller by
                // appending &requestedBy=; if that param were ever dropped or ignored
                // upstream, a self-scoped caller must still never receive another user's
                // rows. Drop any row not owned by the caller when they lack request-view
                // permission (or explicitly asked for user-only), and track the count so the
                // page total stays honest.
                int removedByScope = 0;
                if (selfScoped && results != null)
                {
                    for (var i = results.Count - 1; i >= 0; i--)
                    {
                        var ownerId = (int?)((results[i] as JsonObject)?["requestedBy"] as JsonObject)?["id"];
                        if (ownerId != jellyseerrUser.Id)
                        {
                            results.RemoveAt(i);
                            removedByScope++;
                        }
                    }
                }

                if (results != null)
                {
                    // Enrich all requests in parallel for better performance
                    var enrichmentTasks = results.Select(async req =>
                    {
                        var media = req?["media"] as JsonObject;
                        var requestedBy = req?["requestedBy"] as JsonObject;

                        int? reqStatus = (int?)req?["status"];
                        int? mediaStatusVal = (int?)media?["status"];
                        bool hasActiveDownload = (media?["downloadStatus"] as JsonArray)?.Count > 0
                            || (media?["downloadStatus4k"] as JsonArray)?.Count > 0;
                        string mediaStatus = GetMediaStatus(reqStatus, mediaStatusVal, hasActiveDownload);

                        string? type = (string?)req?["type"];
                        int? tmdbId = (int?)media?["tmdbId"];

                        // Enrich with TMDB data to get title and poster
                        string? title = null;
                        int? year = null;
                        string? posterUrl = null;
                        string? digitalReleaseDate = null;
                        string? theatricalReleaseDate = null;
                        string? initialAirDate = null;
                        string? nextAirDate = null;

                        if (tmdbId.HasValue && !string.IsNullOrEmpty(type))
                        {
                            var enrichedData = await EnrichWithTmdbData(client, tmdbId.Value, type, jellyseerrUrl!, config.JellyseerrApiKey);
                            title = enrichedData.Title;
                            year = enrichedData.Year;
                            posterUrl = enrichedData.PosterUrl;

                            if (type == "tv")
                            {
                                initialAirDate = enrichedData.InitialAirDate;
                                nextAirDate = enrichedData.NextAirDate;
                            }
                            else
                            {
                                digitalReleaseDate = enrichedData.DigitalReleaseDate;
                                theatricalReleaseDate = enrichedData.TheatricalReleaseDate;
                            }
                        }

                        // Fallback to media object if enrichment didn't work
                        if (string.IsNullOrEmpty(title))
                        {
                            title = (string?)media?["title"];
                            if (string.IsNullOrEmpty(title))
                                title = (string?)media?["name"];
                            if (string.IsNullOrEmpty(title))
                                title = (string?)media?["originalTitle"];
                            if (string.IsNullOrEmpty(title))
                                title = (string?)media?["originalName"];
                            if (string.IsNullOrEmpty(title))
                                title = "Unknown";
                        }

                        // Fallback year from media object
                        if (!year.HasValue)
                        {
                            string? releaseDate = (string?)media?["releaseDate"];
                            string? firstAirDate = (string?)media?["firstAirDate"];
                            if (!string.IsNullOrEmpty(releaseDate) && releaseDate.Length >= 4)
                                year = int.TryParse(releaseDate.Substring(0, 4), out var y) ? y : null;
                            else if (!string.IsNullOrEmpty(firstAirDate) && firstAirDate.Length >= 4)
                                year = int.TryParse(firstAirDate.Substring(0, 4), out var y2) ? y2 : null;
                        }

                        // Fallback poster from media object
                        if (string.IsNullOrEmpty(posterUrl))
                        {
                            string? posterPath = (string?)media?["posterPath"];
                            if (!string.IsNullOrEmpty(posterPath))
                                posterUrl = $"https://image.tmdb.org/t/p/w300{posterPath}";
                        }

                        // Get requester info
                        string? displayName = (string?)requestedBy?["displayName"];
                        string? username = (string?)requestedBy?["username"];
                        string? avatar = (string?)requestedBy?["avatar"];

                        // Proxy avatar through our backend to avoid CORS/mixed content issues
                        string? avatarUrl = null;
                        if (!string.IsNullOrEmpty(avatar))
                        {
                            avatarUrl = $"/JellyfinCanopy/proxy/avatar?path={Uri.EscapeDataString(avatar)}";
                        }

                        // Seerr's createdAt ISO string is forwarded verbatim. (The old
                        // Newtonsoft parser auto-promoted it to a Date token and
                        // re-serialized it in "o" format; JsonNode keeps the original
                        // text — both are ISO 8601 the frontend parses identically.)
                        string? createdAtStr = null;
                        var createdAtToken = req?["createdAt"];
                        if (createdAtToken != null)
                        {
                            createdAtStr = createdAtToken.ToString();
                        }

                        return new
                        {
                            id = (int?)req?["id"],
                            type = type,
                            title = title,
                            year = year,
                            posterUrl = posterUrl,
                            tmdbId = tmdbId,
                            mediaStatus = mediaStatus,
                            // Raw Seerr request status (1=Pending, 2=Approved, 3=Declined,
                            // 4=Failed, 5=Completed). Exposed separately from mediaStatus
                            // because mediaStatus collapses to the media's availability
                            // (e.g. "Partially Available" for a show that already has some
                            // seasons), which masks a still-pending request and prevents the
                            // approve/decline buttons from rendering.
                            requestStatus = reqStatus,
                            requestedBy = displayName ?? username ?? "Unknown",
                            requestedByAvatar = avatarUrl,
                            createdAt = createdAtStr,
                            jellyfinMediaId = (string?)media?["jellyfinMediaId"],
                            digitalReleaseDate = digitalReleaseDate,
                            theatricalReleaseDate = theatricalReleaseDate,
                            initialAirDate = initialAirDate,
                            nextAirDate = nextAirDate
                        };
                    }).ToList();

                    var enrichedRequests = await Task.WhenAll(enrichmentTasks);

                    // Apply server-side filtering for "comingsoon"
                    if (isComingSoonFilter)
                    {
                        var today = DateTime.UtcNow.Date;
                        enrichedRequests = enrichedRequests
                            .Where(r =>
                            {
                                var status = (r.mediaStatus ?? "").ToLower();
                                var itemType = r.type;

                                // For TV shows: include if has future nextAirDate
                                // (can be processing, approved, or even partially available with upcoming episodes)
                                if (itemType == "tv")
                                {
                                    var airDate = r.nextAirDate;
                                    if (!string.IsNullOrEmpty(airDate) && DateTime.TryParse(airDate, out var ad) && ad.Date > today)
                                    {
                                        // Include processing, approved, or partially available TV shows with upcoming episodes
                                        return status == "processing" || status == "approved" || status == "partially available";
                                    }
                                    return false;
                                }

                                // For movies: check digital or theatrical release dates
                                // Only include processing or approved movies
                                if (status != "processing" && status != "approved")
                                    return false;

                                var digitalDate = r.digitalReleaseDate;
                                var theatricalDate = r.theatricalReleaseDate;

                                // Check if has a future release date
                                if (!string.IsNullOrEmpty(digitalDate) && DateTime.TryParse(digitalDate, out var dd) && dd.Date > today)
                                    return true;
                                if (!string.IsNullOrEmpty(theatricalDate) && DateTime.TryParse(theatricalDate, out var td) && td.Date > today)
                                    return true;

                                return false;
                            })
                            .OrderBy(r =>
                            {
                                // Sort by the earliest future date
                                DateTime? bestDate = null;
                                var today = DateTime.UtcNow.Date;

                                // For TV shows, use nextAirDate
                                if (r.type == "tv" && !string.IsNullOrEmpty(r.nextAirDate) && DateTime.TryParse(r.nextAirDate, out var airDate) && airDate.Date > today)
                                {
                                    bestDate = airDate;
                                }
                                else
                                {
                                    // For movies, use digital or theatrical date
                                    if (!string.IsNullOrEmpty(r.digitalReleaseDate) && DateTime.TryParse(r.digitalReleaseDate, out var dd) && dd.Date > today)
                                        bestDate = dd;
                                    if (!string.IsNullOrEmpty(r.theatricalReleaseDate) && DateTime.TryParse(r.theatricalReleaseDate, out var td) && td.Date > today)
                                    {
                                        if (bestDate == null || td < bestDate)
                                            bestDate = td;
                                    }
                                }

                                return bestDate ?? DateTime.MaxValue;
                            })
                            .ToArray();

                        // enrichedRequests is now the full future-dated, ordered set across all
                        // aggregated pages; window it locally and report the honest total (ARR-5).
                        var (comingSoonPage, comingSoonFilteredTotal, _) = PaginateFiltered(enrichedRequests, skip, take);
                        comingSoonTotal = comingSoonFilteredTotal;
                        requests.AddRange(comingSoonPage);
                    }
                    else
                    {
                        requests.AddRange(enrichedRequests);
                    }
                }

                var pageInfo = data["pageInfo"] as JsonObject;
                // pageInfo.results already reflects any parental removals (the filter
                // decrements it); subtract the DiD-backstop removals on top so the page
                // count never over-reports what the caller can actually see.
                // Coming-soon totals come from the FULL aggregated+filtered set (not just the
                // windowed page), so the client paginator walks every future-dated request.
                var totalResults = isComingSoonFilter ? comingSoonTotal : Math.Max(0, ((int?)pageInfo?["results"] ?? 0) - removedByScope);
                var totalPages = (int)Math.Ceiling((double)totalResults / take);

                // Fold the admin feature toggle into the capability the client
                // renders on: when In-App Request Approvals is disabled, the
                // server never advertises the capability, so the buttons never
                // render even if a stale client config flag says otherwise.
                var canApproveRequests = config.RequestApprovalsEnabled
                    && (IsAdminUser() || JellyseerrPermissionHelper.HasAnyPermission(
                        jellyseerrUser.Permissions,
                        JellyseerrPermission.ADMIN | JellyseerrPermission.MANAGE_REQUESTS
                    ));

                return Ok(new
                {
                    requests = requests,
                    totalPages = totalPages,
                    totalResults = totalResults,
                    canApproveRequests = canApproveRequests
                });
            }
            catch (Exception ex)
            {
                // previously every error returned 200+empty,
                // making the requests page indistinguishable from "no requests".
                // Now we surface a structured 502 so the frontend can render a
                // banner (and the user knows to fix their config rather than
                // assume they have no requests).
                _logger.LogWarning($"Failed to fetch Seerr requests: {ex.Message}");
                return StatusCode(502, new
                {
                    error = true,
                    code = "requests_fetch_failed",
                    // Sanitize for non-admins: an HttpRequestException/URI-bearing message can carry
                    // the internal Seerr host:port, which a non-admin caller must not see. The full
                    // detail stays in the server log above.
                    message = BuildRequestsFetchErrorMessage(IsAdminUser(), ex.Message),
                    requests = new List<object>(),
                    totalPages = 0,
                    totalResults = 0,
                });
            }
        }

        // Builds the outer-catch "requests fetch failed" message. Admins see the raw exception text;
        // non-admins get the Seerr URL/host rewritten to <seerr-url>. Extracted so the redaction is
        // unit-testable without a live HTTP round-trip.
        internal static string BuildRequestsFetchErrorMessage(bool isAdmin, string exMessage)
        {
            var full = $"Failed to fetch requests from Jellyseerr: {exMessage}";
            return isAdmin ? full : Helpers.Jellyseerr.SeerrError.SanitizeMessage(full);
        }

        // Coming-soon aggregates every upstream page across these filters so future-dated
        // requests beyond the first page (and `approved` items, which the single-page path
        // never fetched) are reachable. Bounded so a huge Seerr can't drive unbounded calls.
        internal const int ComingSoonPageSize = 100;
        internal const int ComingSoonMaxItems = 500;
        // Hard ceiling on upstream pages walked per filter. The maxItems / raw-length guards only
        // terminate the walk when surviving rows accumulate or a short page arrives; a pathological
        // upstream that returns full pages whose rows are ALL filtered out (or all duplicates) never
        // advances either, so this cap guarantees termination. Set well above the pages a normal
        // Seerr needs (maxItems/pageSize ≈ 5) so it never truncates real data, while still bounding
        // worst-case calls.
        internal const int ComingSoonMaxPagesPerFilter = 50;
        internal static readonly string[] ComingSoonUpstreamFilters = { "processing", "approved" };

        /// <summary>
        /// Walks every upstream page for each coming-soon filter (via the injected page
        /// fetcher) and returns the combined request rows, deduped by request id. The fetcher
        /// returns the RAW upstream page length alongside the parental-filtered rows;
        /// pagination terminates on the raw length so parental filtering (which shrinks a page
        /// below <paramref name="pageSize"/>) cannot truncate the walk early. Stops at a
        /// short/empty raw page or the <paramref name="maxItems"/> cap. Extracted so the
        /// aggregate-all-pages fix is unit-testable without a live Seerr.
        /// </summary>
        internal static async Task<List<JsonObject>> AggregateComingSoonPagesAsync(
            Func<string, int, int, Task<(int RawCount, JsonArray? Filtered)>> fetchPage,
            IReadOnlyList<string> upstreamFilters,
            int pageSize,
            int maxItems,
            int maxPagesPerFilter = ComingSoonMaxPagesPerFilter)
        {
            var combined = new List<JsonObject>();
            var seenIds = new HashSet<int>();

            foreach (var filter in upstreamFilters)
            {
                var pagesWalked = 0;
                for (int skip = 0; combined.Count < maxItems; skip += pageSize)
                {
                    // Hard page bound: when every raw row is filtered out (or a duplicate),
                    // combined.Count never advances, so neither the maxItems loop condition nor the
                    // short-page break below can fire — a never-short upstream would loop forever.
                    // Cap the pages walked so the walk always terminates; the normal finite-stream
                    // terminations below still run first for well-behaved upstreams.
                    if (pagesWalked >= maxPagesPerFilter)
                    {
                        break;
                    }

                    pagesWalked++;

                    var (rawCount, filtered) = await fetchPage(filter, skip, pageSize).ConfigureAwait(false);
                    if (rawCount <= 0)
                    {
                        break; // no upstream rows (empty page or fetch failure) → last page
                    }

                    if (filtered != null)
                    {
                        foreach (var node in filtered)
                        {
                            if (node is not JsonObject obj)
                            {
                                continue;
                            }

                            var id = (int?)obj["id"];
                            // Dedupe by request id so a row present under both processing and
                            // approved (or across overlapping pages) is only counted once.
                            if (id.HasValue && !seenIds.Add(id.Value))
                            {
                                continue;
                            }

                            combined.Add(obj);
                            if (combined.Count >= maxItems)
                            {
                                break;
                            }
                        }
                    }

                    // Terminate on the RAW upstream page length, not the filtered count: the
                    // parental filter shrinks pages below pageSize, so breaking on the filtered
                    // count would stop the walk early and hide future-dated items from a
                    // rating-limited caller (SEC-SEERR-3).
                    if (rawCount < pageSize)
                    {
                        break;
                    }
                }
            }

            return combined;
        }

        /// <summary>
        /// Windows a fully-filtered, ordered set locally so paging walks the real filtered
        /// set and the totals are honest (ARR-5). Returns the requested page plus the total
        /// item and page counts computed from the whole set.
        /// </summary>
        internal static (List<T> Page, int TotalResults, int TotalPages) PaginateFiltered<T>(
            IReadOnlyList<T> filteredOrdered, int skip, int take)
        {
            var totalResults = filteredOrdered.Count;
            var totalPages = take > 0 ? (int)Math.Ceiling((double)totalResults / take) : 0;
            var page = filteredOrdered.Skip(skip).Take(take).ToList();
            return (page, totalResults, totalPages);
        }

        [HttpPost("arr/requests/{requestId}/approve")]
        [HttpPost("arr/requests/{requestId}/decline")]
        [Authorize]
        public async Task<IActionResult> ActOnRequest([FromRoute] int requestId)
        {
            var action = HttpContext.Request.Path.Value?.Contains("/approve", StringComparison.OrdinalIgnoreCase) == true ? "approve" : "decline";

            var config = _configProvider.ConfigurationOrNull;
            if (config == null || string.IsNullOrWhiteSpace(config.JellyseerrUrls) || string.IsNullOrWhiteSpace(config.JellyseerrApiKey))
                return StatusCode(503, new { error = true, message = "Seerr not configured." });

            // The admin feature toggle gates the action server-side too — the
            // client hides the buttons when it's off, but the server still
            // enforces so a crafted request can't bypass a disabled feature.
            if (!config.RequestApprovalsEnabled)
                return StatusCode(403, new { error = true, message = "In-app request approvals are disabled." });

            var jellyfinUserId = UserHelper.GetCurrentUserId(User)?.ToString();
            if (string.IsNullOrEmpty(jellyfinUserId))
                return BadRequest(new { message = "Jellyfin User ID not found." });

            var jellyseerrUser = await _jellyseerr.GetJellyseerrUser(jellyfinUserId);
            if (jellyseerrUser == null)
                return NotFound(new { message = "Current user is not linked to a Seerr account." });

            bool canApprove = IsAdminUser() || JellyseerrPermissionHelper.HasAnyPermission(
                jellyseerrUser.Permissions,
                JellyseerrPermission.ADMIN | JellyseerrPermission.MANAGE_REQUESTS
            );
            if (!canApprove)
                return StatusCode(403, new { error = true, message = "You do not have permission to approve or decline requests." });

            var jellyseerrUrl = config.JellyseerrUrls
                .Split(new[] { '\r', '\n', ',' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(u => u.Trim().TrimEnd('/'))
                .FirstOrDefault(u => !string.IsNullOrWhiteSpace(u));

            if (string.IsNullOrEmpty(jellyseerrUrl))
                return StatusCode(503, new { error = true, message = "No valid Seerr URL configured." });

            var requestUri = $"{jellyseerrUrl}/api/v1/request/{requestId}/{action}";
            var client = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
            using var httpRequest = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(
                HttpMethod.Post, requestUri, config.JellyseerrApiKey, jellyseerrUser.Id.ToString());
            using var response = await client.SendAsync(httpRequest);
            var (content, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, requestUri);

            if (error != null)
            {
                _logger.LogWarning($"Seerr {action} request {requestId} failed: {error.Code} {error.HttpStatus}");
                return StatusCode(error.HttpStatus > 0 ? error.HttpStatus : 502,
                    IsAdminUser() ? error.ToAdminResponseShape() : error.ToResponseShape());
            }

            // The requests LIST the page reads is fetched fresh (uncached), so it
            // reflects the new status immediately. The shared movie/tv DETAIL cache,
            // however, embeds mediaInfo.requests[].status — evict the affected
            // media's detail entries so other surfaces (more-info modal, item
            // details) don't serve a stale request status until the cache TTL.
            EvictDetailCacheFromRequestResponse(content);

            return Ok(new { success = true });
        }

        /// <summary>
        /// Best-effort eviction of the shared movie/tv detail cache for the media a
        /// just-approved/declined request points at. Seerr's approve/decline
        /// response is the MediaRequest object, carrying <c>type</c> ("movie"/"tv")
        /// and a <c>media</c> object with the TMDB id — enough to target the exact
        /// cached detail entries whose embedded request status just changed.
        /// </summary>
        private void EvictDetailCacheFromRequestResponse(string? content)
        {
            if (string.IsNullOrEmpty(content)) return;
            try
            {
                using var doc = System.Text.Json.JsonDocument.Parse(content);
                var root = doc.RootElement;
                if (root.ValueKind != System.Text.Json.JsonValueKind.Object) return;
                if (!root.TryGetProperty("type", out var typeEl)) return;
                var mediaType = typeEl.GetString();
                if (mediaType != "movie" && mediaType != "tv") return;
                if (!root.TryGetProperty("media", out var mediaEl)
                    || mediaEl.ValueKind != System.Text.Json.JsonValueKind.Object) return;
                if (!mediaEl.TryGetProperty("tmdbId", out var tmdbEl)
                    || !tmdbEl.TryGetInt32(out var tmdbId)) return;
                _jellyseerr.EvictMediaDetailCache(tmdbId, mediaType);
            }
            catch { /* best-effort — a parse failure just leaves the cache to TTL */ }
        }

        private async Task<(string? Title, int? Year, string? PosterUrl, string? DigitalReleaseDate, string? TheatricalReleaseDate, string? InitialAirDate, string? NextAirDate)> EnrichWithTmdbData(HttpClient client, int tmdbId, string type, string jellyseerrUrl, string apiKey)
        {
            var cacheKey = $"{(type == "movie" ? "movie" : "tv")}:{tmdbId}";
            var cacheTtl = _seerrCache.GetTmdbEnrichmentCacheTtl();
            var cacheEnabled = !(_configProvider.ConfigurationOrNull?.JellyseerrDisableCache ?? false);

            if (cacheEnabled)
            {
                lock (_seerrCache.TmdbEnrichmentCacheLock)
                {
                    if (_seerrCache.TmdbEnrichmentCache.TryGetValue(cacheKey, out var cached) &&
                        DateTime.UtcNow - cached.CachedAt < cacheTtl)
                    {
                        var hit = cached.Data;
                        return (hit.Title, hit.Year, hit.PosterUrl, hit.DigitalReleaseDate, hit.TheatricalReleaseDate, hit.InitialAirDate, hit.NextAirDate);
                    }
                }
            }

            async Task<TmdbEnrichmentResult> FetchEnrichmentAsync()
            {
                try
                {
                    var endpoint = type == "movie" ? "movie" : "tv";
                    var enrichUri = $"{jellyseerrUrl}/api/v1/{endpoint}/{tmdbId}";
                    using var enrichRequest = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(
                        HttpMethod.Get, enrichUri, apiKey);
                    using var response = await client.SendAsync(enrichRequest);
                    var (content, enrichError) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, enrichUri);

                    if (enrichError != null || content == null)
                    {
                        return new TmdbEnrichmentResult();
                    }

                    var data = System.Text.Json.JsonSerializer.Deserialize<System.Text.Json.JsonElement>(content);

                    string? title = null;
                    int? year = null;
                    string? posterUrl = null;
                    string? digitalReleaseDate = null;
                    string? theatricalReleaseDate = null;
                    string? initialAirDate = null;
                    string? nextAirDate = null;

                    if (type == "movie")
                    {
                        if (data.TryGetProperty("title", out var titleProp))
                            title = titleProp.GetString();
                        if (data.TryGetProperty("releaseDate", out var rd) && !string.IsNullOrEmpty(rd.GetString()) && rd.GetString()!.Length >= 4)
                        {
                            year = int.TryParse(rd.GetString()!.Substring(0, 4), out var y) ? y : null;
                            theatricalReleaseDate = rd.GetString();
                        }

                        if (data.TryGetProperty("releases", out var releases) && releases.TryGetProperty("results", out var results))
                        {
                            foreach (var regionRelease in results.EnumerateArray())
                            {
                                if (regionRelease.TryGetProperty("release_dates", out var releaseDates))
                                {
                                    foreach (var release in releaseDates.EnumerateArray())
                                    {
                                        if (release.TryGetProperty("type", out var typeProp))
                                        {
                                            var releaseType = typeProp.GetInt32();
                                            if (releaseType == 4 && release.TryGetProperty("release_date", out var digitalDateProp))
                                            {
                                                var dateStr = digitalDateProp.GetString();
                                                if (!string.IsNullOrEmpty(dateStr))
                                                {
                                                    if (digitalReleaseDate == null || string.Compare(dateStr, digitalReleaseDate, StringComparison.Ordinal) < 0)
                                                    {
                                                        digitalReleaseDate = dateStr.Length >= 10 ? dateStr.Substring(0, 10) : dateStr;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    else
                    {
                        if (data.TryGetProperty("name", out var nameProp))
                            title = nameProp.GetString();

                        if (data.TryGetProperty("firstAirDate", out var fad) && !string.IsNullOrEmpty(fad.GetString()))
                        {
                            initialAirDate = fad.GetString();
                            if (initialAirDate != null && initialAirDate.Length >= 4)
                                year = int.TryParse(initialAirDate.Substring(0, 4), out var y) ? y : null;
                        }

                        if (data.TryGetProperty("nextEpisodeToAir", out var nextEp) && nextEp.ValueKind != System.Text.Json.JsonValueKind.Null)
                        {
                            if (nextEp.TryGetProperty("airDate", out var airDateProp))
                            {
                                nextAirDate = airDateProp.GetString();
                            }
                        }
                    }

                    if (data.TryGetProperty("posterPath", out var poster) && poster.ValueKind != System.Text.Json.JsonValueKind.Null)
                    {
                        posterUrl = $"https://image.tmdb.org/t/p/w300{poster.GetString()}";
                    }

                    return new TmdbEnrichmentResult
                    {
                        Title = title,
                        Year = year,
                        PosterUrl = posterUrl,
                        DigitalReleaseDate = digitalReleaseDate,
                        TheatricalReleaseDate = theatricalReleaseDate,
                        InitialAirDate = initialAirDate,
                        NextAirDate = nextAirDate
                    };
                }
                catch (Exception ex)
                {
                    _logger.LogWarning($"Failed to enrich request with TMDB data: {ex.Message}");
                    return new TmdbEnrichmentResult();
                }
            }

            TmdbEnrichmentResult result;
            if (cacheEnabled)
            {
                var fetchTask = _seerrCache.TmdbEnrichmentInFlight.GetOrAdd(cacheKey, _ => FetchEnrichmentAsync());
                try
                {
                    result = await fetchTask;
                }
                finally
                {
                    _seerrCache.TmdbEnrichmentInFlight.TryRemove(cacheKey, out _);
                }

                // don't cache empty enrichment
                // results from upstream failures. Otherwise a Cloudflare-blip
                // pollutes the cache with null titles/posters for the full TTL
                // (default 10 min) — even after Seerr recovers and the user
                // refreshes the requests page, posters stay missing.
                bool isEmpty = result == null
                    || (string.IsNullOrEmpty(result.Title)
                        && result.Year == null
                        && string.IsNullOrEmpty(result.PosterUrl));
                if (!isEmpty)
                {
                    lock (_seerrCache.TmdbEnrichmentCacheLock)
                    {
                        _seerrCache.TmdbEnrichmentCache[cacheKey] = (result!, DateTime.UtcNow);

                        if (_seerrCache.TmdbEnrichmentCache.Count > 500 || _seerrCache.TmdbEnrichmentCache.Count % 100 == 0)
                        {
                            var staleKeys = _seerrCache.TmdbEnrichmentCache
                                .Where(kv => DateTime.UtcNow - kv.Value.CachedAt > cacheTtl)
                                .Select(kv => kv.Key)
                                .ToList();
                            foreach (var staleKey in staleKeys)
                            {
                                _seerrCache.TmdbEnrichmentCache.Remove(staleKey);
                            }
                        }
                    }
                }
            }
            else
            {
                result = await FetchEnrichmentAsync();
            }

            result ??= new TmdbEnrichmentResult();
            return (result.Title, result.Year, result.PosterUrl, result.DigitalReleaseDate, result.TheatricalReleaseDate, result.InitialAirDate, result.NextAirDate);
        }

        private static string GetMediaStatus(int? requestStatus, int? mediaStatus, bool hasActiveDownload = false)
        {
            // MediaStatus: 1 = Unknown, 2 = Pending, 3 = Processing, 4 = Partially Available, 5 = Available, 6 = Blocklisted, 7 = Deleted
            // MediaRequestStatus: 1 = Pending, 2 = Approved, 3 = Declined, 4 = Failed, 5 = Completed

            // Check media status first (higher priority)
            if (mediaStatus == 7) return "Deleted";
            if (mediaStatus == 6) return "Blocklisted";
            if (mediaStatus == 5) return "Available";
            if (mediaStatus == 4) return "Partially Available";
            // MediaStatus.PROCESSING (3): only show "Processing" when Radarr/Sonarr is actively downloading.
            // Without active download data the request is approved-but-queued — Seerr labels that "Requested".
            if (mediaStatus == 3) return hasActiveDownload ? "Processing" : "Approved";
            if (mediaStatus == 2) return "Pending";

            // Fall back to request status
            if (requestStatus == 5) return "Completed";
            if (requestStatus == 4) return "Failed";
            if (requestStatus == 3) return "Declined";
            if (requestStatus == 2) return "Approved";
            if (requestStatus == 1) return "Pending";

            // Default fallback
            return "Unknown";
        }
    }
}
