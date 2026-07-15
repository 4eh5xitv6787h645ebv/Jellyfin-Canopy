using Microsoft.AspNetCore.Mvc;
using System;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Globalization;
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
using Jellyfin.Plugin.JellyfinCanopy.Model.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model;
using MediaBrowser.Controller.Persistence;
using Jellyfin.Plugin.JellyfinCanopy.Model.Arr;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Enums;
using Microsoft.EntityFrameworkCore;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
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
        // Process-wide because a per-request gate still permits N concurrent
        // callers to multiply the upstream detail fan-out by N.
        private static readonly SemaphoreSlim _requestEnrichmentGate = new(
            MaxConcurrentRequestEnrichments,
            MaxConcurrentRequestEnrichments);

        private readonly ISeerrClient _seerr;
        private readonly Services.Arr.ArrFetchService _arrFetch;
        private readonly ISeerrParentalFilter _parentalFilter;

        private bool IsReadConfigurationCurrent(SeerrMutationConfigStamp stamp)
            => stamp.Matches(
                _configProvider.ConfigurationOrNull,
                _configProvider.ConfigurationRevision);

        private ObjectResult ReadConfigurationChanged(string resource)
            => StatusCode(409, new
            {
                error = true,
                code = "read_configuration_changed",
                message = $"Seerr configuration changed while preparing {resource}. Retry the request.",
            });

        public ArrRequestsController(
            IHttpClientFactory httpClientFactory,
            ILogger<ArrRequestsController> logger,
            IUserManager userManager,
            ISeerrCache seerrCache,
            IPluginConfigProvider configProvider,
            ISeerrClient seerr,
            Services.Arr.ArrFetchService arrFetch,
            ISeerrParentalFilter parentalFilter)
            : base(httpClientFactory, logger, userManager, seerrCache, configProvider)
        {
            _seerr = seerr;
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

            var configurationRevision = _configProvider.ConfigurationRevision;
            var configStamp = SeerrMutationConfigStamp.Capture(config, configurationRevision);
            var seerrEnabled = config.SeerrEnabled;
            var seerrApiKey = config.SeerrApiKey;
            var configuredUrls = SeerrClient.GetConfiguredUrls(config.SeerrUrls);
            if (!IsReadConfigurationCurrent(configStamp))
                return ReadConfigurationChanged("the download queue");

            // Non-admin users can only see downloads for items they requested via Seerr
            // unless the admin has disabled per-user filtering
            HashSet<(int TmdbId, string MediaType)>? allowedRequests = null;
            HashSet<int>? allowedTvTvdb = null;
            if (!IsAdminUser() && config.DownloadsFilterByUserRequests)
            {
                if (!seerrEnabled || configuredUrls.Length == 0 || string.IsNullOrWhiteSpace(seerrApiKey))
                {
                    return Ok(new { items = new List<object>(), errors = new List<object>() });
                }

                var jellyfinUserId = UserHelper.GetCurrentUserId(User)?.ToString();
                if (string.IsNullOrEmpty(jellyfinUserId))
                {
                    return Ok(new { items = new List<object>(), errors = new List<object>() });
                }

                var userResolution = await _seerr.ResolveSeerrUser(
                    jellyfinUserId,
                    bypassCache: true,
                    allowAutoImport: false,
                    cancellationToken: HttpContext.RequestAborted).ConfigureAwait(false);
                if (!IsReadConfigurationCurrent(configStamp))
                    return ReadConfigurationChanged("the download queue");

                var seerrUser = userResolution.User;
                if (seerrUser == null)
                {
                    if (userResolution.Status is SeerrUserResolutionStatus.Incomplete or SeerrUserResolutionStatus.Unavailable)
                    {
                        return StatusCode(502, new
                        {
                            error = true,
                            code = "user_lookup_incomplete",
                            message = "Seerr user lookup was incomplete. No partial download queue was published.",
                            items = Array.Empty<object>(),
                            errors = Array.Empty<object>(),
                        });
                    }

                    return Ok(new { items = new List<object>(), errors = new List<object>() });
                }

                var configuredSource = configuredUrls.FirstOrDefault(url => string.Equals(
                        url,
                        SeerrUrlIdentity.Normalize(seerrUser.SourceUrl),
                        StringComparison.Ordinal));
                if (configuredSource == null)
                {
                    return StatusCode(502, new
                    {
                        error = true,
                        code = "source_affinity_unavailable",
                        message = "The linked Seerr instance could not be verified. No download queue was published.",
                        items = Array.Empty<object>(),
                        errors = Array.Empty<object>(),
                    });
                }

                var userRequests = await _seerr.GetRequestsForUser(
                    seerrUser.Id.ToString(),
                    configuredSource,
                    config,
                    configurationRevision,
                    seerrApiKey,
                    configuredUrls,
                    HttpContext.RequestAborted).ConfigureAwait(false);
                if (!IsReadConfigurationCurrent(configStamp))
                    return ReadConfigurationChanged("the download queue");

                if (userRequests == null)
                {
                    return StatusCode(502, new
                    {
                        error = true,
                        code = "upstream_collection_incomplete",
                        message = "Seerr returned an incomplete request collection. No partial download queue was published.",
                        items = Array.Empty<object>(),
                        errors = Array.Empty<object>(),
                    });
                }

                if (userRequests.Count == 0)
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
            if (!IsReadConfigurationCurrent(configStamp))
                return ReadConfigurationChanged("the download queue");

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

            if (!IsReadConfigurationCurrent(configStamp))
                return ReadConfigurationChanged("the download queue");

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

            var configurationRevision = _configProvider.ConfigurationRevision;
            var configStamp = SeerrMutationConfigStamp.Capture(config, configurationRevision);
            var seerrApiKey = config.SeerrApiKey;
            var configuredUrls = SeerrClient.GetConfiguredUrls(config.SeerrUrls);
            var enrichmentCacheEnabled = !config.SeerrDisableCache;
            var requestApprovalsEnabled = config.RequestApprovalsEnabled;
            if (!IsReadConfigurationCurrent(configStamp))
                return ReadConfigurationChanged("the request list");

            if (configuredUrls.Length == 0 || string.IsNullOrWhiteSpace(seerrApiKey))
            {
                return Ok(new { requests = new List<object>(), totalPages = 0, totalResults = 0 });
            }

            try
            {
                // iterate every configured Seerr URL, not
                // just the first one. Previously a downed primary URL produced
                // an immediate 502 even when a second URL would have answered.
                var allUrls = configuredUrls.ToList();
                if (allUrls.Count == 0)
                {
                    return StatusCode(503, new { error = true, code = "disabled", message = "Seerr URL not configured." });
                }
                var client = Helpers.Seerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
                client.Timeout = TimeSpan.FromSeconds(15);
                bool hasRequestViewPermission = false;

                var jellyfinUserId = UserHelper.GetCurrentUserId(User)?.ToString();

                if (string.IsNullOrEmpty(jellyfinUserId))
                {
                    _logger.LogWarning("Could not find Jellyfin User ID in claims.");
                    return BadRequest(new { message = "Jellyfin User ID was not provided in claims." });
                }

                var userResolution = await _seerr.ResolveSeerrUser(
                    jellyfinUserId,
                    bypassCache: true,
                    allowAutoImport: false,
                    cancellationToken: HttpContext.RequestAborted).ConfigureAwait(false);
                if (!IsReadConfigurationCurrent(configStamp))
                    return ReadConfigurationChanged("the request list");

                var seerrUser = userResolution.User;

                if (seerrUser == null)
                {
                    if (userResolution.Status is SeerrUserResolutionStatus.Incomplete or SeerrUserResolutionStatus.Unavailable)
                    {
                        return StatusCode(502, new
                        {
                            error = true,
                            code = "user_lookup_incomplete",
                            message = "Seerr user lookup was incomplete. Please try again.",
                            requests = Array.Empty<object>(),
                            totalPages = 0,
                            totalResults = 0,
                        });
                    }

                    _logger.LogWarning($"Could not find a Seerr user for Jellyfin user {ResolveUserDisplay(jellyfinUserId)}. Aborting request.");
                    return NotFound(new { message = "Current Jellyfin user is not linked to a Seerr user." });
                }

                // Seerr user ids and request ids are instance-local. Publishing
                // actionable rows is only safe when user resolution proved one
                // source that still exists in the current configuration.
                var resolvedSource = SeerrSourceToken.NormalizeSourceUrl(seerrUser.SourceUrl);
                var configuredSource = allUrls.FirstOrDefault(url => string.Equals(
                    url,
                    resolvedSource,
                    StringComparison.Ordinal));
                if (configuredSource == null)
                {
                    return StatusCode(502, new
                    {
                        error = true,
                        code = "source_affinity_unavailable",
                        message = "The linked Seerr instance could not be verified. No request list was published.",
                        requests = Array.Empty<object>(),
                        totalPages = 0,
                        totalResults = 0,
                    });
                }

                var requestUrls = new[] { configuredSource };

                // Check if user has permission to view all requests
                // Jellyfin admins can always view all requests regardless of Seerr permissions
                hasRequestViewPermission = IsAdminUser() || SeerrPermissionHelper.HasAnyPermission(
                    seerrUser.Permissions,
                    SeerrPermission.ADMIN | SeerrPermission.MANAGE_REQUESTS | SeerrPermission.REQUEST_VIEW
                );

                // "comingsoon" is a custom projection over one complete processing
                // snapshot. Every other filter is also read as one complete stable
                // collection, then parentally filtered and paged locally.
                var isComingSoonFilter = string.Equals(filter, "comingsoon", StringComparison.OrdinalIgnoreCase);
                var upstreamFilter = filter?.ToLowerInvariant() switch
                {
                    "pending" => "pending",
                    "approved" => "approved",
                    "available" => "available",
                    "processing" => "processing",
                    "comingsoon" => "processing",
                    _ => "all",
                };

                // If user lacks permission or user-only is requested, filter to only their requests
                bool selfScoped = !hasRequestViewPermission || userOnly;
                var scopeParam = selfScoped ? $"&requestedBy={seerrUser.Id}" : string.Empty;
                var completeRequestSnapshot = await FetchRequestListCollectionAsync(
                    client,
                    requestUrls,
                    seerrApiKey,
                    upstreamFilter,
                    scopeParam,
                    HttpContext.RequestAborted).ConfigureAwait(false);
                if (!IsReadConfigurationCurrent(configStamp))
                    return ReadConfigurationChanged("the request list");

                if (!completeRequestSnapshot.IsComplete)
                {
                    _logger.LogWarning(
                        "Complete request collection ({Filter}) from {Url} was incomplete: {Reason}",
                        upstreamFilter,
                        completeRequestSnapshot.SourceUrl,
                        completeRequestSnapshot.FailureReason);
                    return StatusCode(502, new
                    {
                        error = true,
                        code = "upstream_collection_incomplete",
                        message = "Seerr returned an incomplete request collection. Please try again.",
                        requests = Array.Empty<object>(),
                        totalPages = 0,
                        totalResults = 0,
                    });
                }

                var seerrUrl = completeRequestSnapshot.SourceUrl;
                var completeComingSoonSnapshot = isComingSoonFilter ? completeRequestSnapshot : null;
                var json = JsonSerializer.Serialize(new
                {
                    results = completeRequestSnapshot.Items,
                    pageInfo = new
                    {
                        page = 1,
                        pages = completeRequestSnapshot.Items.Count == 0 ? 0 : 1,
                        pageSize = completeRequestSnapshot.Items.Count,
                        results = completeRequestSnapshot.Items.Count,
                    },
                });

                // Enforce each caller's own parental-rating limit on the request list —
                // the same gate the /seerr/request route applies via ProxyRequestAsync.
                // Reuses the "/api/v1/request" classification (Category.List, nested `media`),
                // resolves the caller from the auth principal (never a client header), and is
                // a no-op for admins / no-limit users / feature off. Runs on the
                // complete snapshot before local pagination, so totals and page
                // windows describe the caller-visible collection rather than one
                // independently filtered upstream slice.
                if (!isComingSoonFilter)
                {
                    SeerrParentalResult parental;
                    try
                    {
                        parental = await _parentalFilter.ApplyAsync(
                            json,
                            "/api/v1/request",
                            SeerrCaller()).ConfigureAwait(false);
                        if (!IsReadConfigurationCurrent(configStamp))
                            return ReadConfigurationChanged("the request list");
                    }
                    catch (Exception ex)
                    {
                        _logger.LogWarning(ex, "Strict request-list parental filtering threw; refusing partial or unfiltered output.");
                        return ParentalFilterIncomplete();
                    }

                    if (!parental.Succeeded || parental.Block)
                    {
                        return ParentalFilterIncomplete();
                    }

                    json = parental.Body;
                }

                var data = JsonNode.Parse(json)!.AsObject();

                var requests = new List<object>();
                if (data["results"] is not JsonArray results)
                {
                    return StatusCode(502, new
                    {
                        error = true,
                        code = "upstream_collection_invalid",
                        message = "Seerr returned an invalid request collection. Please try again.",
                        requests = Array.Empty<object>(),
                        totalPages = 0,
                        totalResults = 0,
                    });
                }

                // "Coming Soon" comes from one complete `filter=processing`
                // snapshot. In Seerr this is the approved-request status plus
                // non-terminal media states (including queued "Approved" and
                // partially available TV), so it covers every status this view
                // can show without scanning terminal request history. Reading
                // `processing` and `approved` separately has a race: a request that moves
                // between those states between reads can appear in neither collection.
                // Status and future-date classification happen locally after the one
                // authoritative snapshot is complete and parentally filtered.
                int comingSoonTotal = 0;
                if (isComingSoonFilter)
                {
                    var snapshot = completeComingSoonSnapshot!;
                    var candidateItems = new List<JsonElement>(snapshot.Items.Count);
                    foreach (var item in snapshot.Items)
                    {
                        if (!TryClassifyComingSoonCandidate(item, out var include))
                        {
                            _logger.LogWarning(
                                "Complete coming-soon collection from {Url} contained an invalid processing row; refusing a partial projection.",
                                snapshot.SourceUrl);
                            return StatusCode(502, new
                            {
                                error = true,
                                code = "upstream_collection_invalid",
                                message = "Seerr returned an invalid request collection. Please try again.",
                                requests = Array.Empty<object>(),
                                totalPages = 0,
                                totalResults = 0,
                            });
                        }

                        if (include) candidateItems.Add(item);
                    }

                    // Filter only after the raw collection is complete. Applying
                    // the parental gate page-by-page can leave a caller with a
                    // successfully filtered prefix when a later page fails.
                    var combinedJson = JsonSerializer.Serialize(new
                    {
                        results = candidateItems,
                        pageInfo = new
                        {
                            page = 1,
                            pages = candidateItems.Count == 0 ? 0 : 1,
                            pageSize = candidateItems.Count,
                            results = candidateItems.Count,
                        },
                    });
                    var combinedParental = await _parentalFilter.ApplyAsync(
                        combinedJson,
                        "/api/v1/request",
                        SeerrCaller()).ConfigureAwait(false);
                    if (!IsReadConfigurationCurrent(configStamp))
                        return ReadConfigurationChanged("the request list");

                    if (!combinedParental.Succeeded || combinedParental.Block)
                    {
                        return ParentalFilterIncomplete();
                    }

                    JsonObject? combinedData;
                    try
                    {
                        combinedData = JsonNode.Parse(combinedParental.Body) as JsonObject;
                    }
                    catch (JsonException ex)
                    {
                        _logger.LogWarning(
                            ex,
                            "Strict coming-soon parental filtering returned malformed JSON; refusing an empty or unfiltered projection.");
                        return ParentalFilterIncomplete();
                    }

                    if (combinedData?["results"] is not JsonArray combinedResults)
                    {
                        _logger.LogWarning(
                            "Strict coming-soon parental filtering returned no results array; refusing an empty projection.");
                        return ParentalFilterIncomplete();
                    }

                    results = combinedResults;
                }

                // Defense-in-depth backstop: the admin-key fetch scopes to the caller by
                // appending &requestedBy=; if that param were ever dropped or ignored
                // upstream, a self-scoped caller must still never receive another user's
                // rows. Drop any row not owned by the caller when they lack request-view
                // permission (or explicitly asked for user-only) before deriving the
                // authoritative local total and page window.
                if (selfScoped)
                {
                    if (!TryApplySelfScope(results, seerrUser.Id, out _))
                    {
                        _logger.LogWarning(
                            "Complete self-scoped request collection from {Url} contained a missing or invalid owner; refusing a partial projection.",
                            seerrUrl);
                        return StatusCode(502, new
                        {
                            error = true,
                            code = "upstream_collection_invalid",
                            message = "Seerr returned an invalid request collection. Please try again.",
                            requests = Array.Empty<object>(),
                            totalPages = 0,
                            totalResults = 0,
                        });
                    }
                }

                var normalFilteredTotal = 0;
                if (!isComingSoonFilter)
                {
                    normalFilteredTotal = results.Count;
                    var windowedResults = new JsonArray();
                    foreach (var row in results.Skip(skip).Take(take))
                    {
                        windowedResults.Add(row?.DeepClone());
                    }

                    results = windowedResults;
                }

                if (results.Count > 0)
                {
                    var requestIds = new Dictionary<JsonNode, int>();
                    foreach (var row in results)
                    {
                        var requestId = ReadPositiveJsonInt((row as JsonObject)?["id"]);
                        if (row == null || requestId is not > 0)
                        {
                            return StatusCode(502, new
                            {
                                error = true,
                                code = "upstream_collection_invalid",
                                message = "Seerr returned an invalid request collection. Please try again.",
                                requests = Array.Empty<object>(),
                                totalPages = 0,
                                totalResults = 0,
                            });
                        }

                        requestIds[row] = requestId.Value;
                    }

                    var enrichmentTasks = results.Select(async req =>
                    {
                        HttpContext.RequestAborted.ThrowIfCancellationRequested();
                        var media = req?["media"] as JsonObject;
                        var requestedBy = req?["requestedBy"] as JsonObject;
                        var requestId = requestIds[req!];
                        var requestSourceToken = SeerrSourceToken.Create(
                            seerrApiKey,
                            SeerrSourceToken.RequestActionPurpose,
                            jellyfinUserId,
                            configuredSource,
                            requestId.ToString(CultureInfo.InvariantCulture),
                            binding: seerrUser.Id.ToString(CultureInfo.InvariantCulture))!;

                        int? reqStatus = (int?)req?["status"];
                        var is4kRequest = ReadJsonBoolean(req?["is4k"]);
                        var mediaStatusProperty = is4kRequest ? "status4k" : "status";
                        var downloadStatusProperty = is4kRequest ? "downloadStatus4k" : "downloadStatus";
                        int? mediaStatusVal = (int?)media?[mediaStatusProperty];
                        bool hasActiveDownload = (media?[downloadStatusProperty] as JsonArray)?.Count > 0;
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
                        var enrichmentComplete = !isComingSoonFilter;

                        if (tmdbId.HasValue && !string.IsNullOrEmpty(type))
                        {
                            var enrichedData = await EnrichWithTmdbData(
                                client,
                                tmdbId.Value,
                                type,
                                seerrUrl!,
                                seerrApiKey,
                                enrichmentCacheEnabled,
                                configurationRevision,
                                configStamp,
                                HttpContext.RequestAborted).ConfigureAwait(false);
                            enrichmentComplete = enrichedData.IsComplete;
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
                        if (SeerrSourceToken.TryNormalizeAvatarPath(avatar, out var avatarPath))
                        {
                            var avatarSourceToken = SeerrSourceToken.Create(
                                seerrApiKey,
                                SeerrSourceToken.AvatarPurpose,
                                jellyfinUserId,
                                configuredSource,
                                avatarPath)!;
                            avatarUrl = $"/JellyfinCanopy/proxy/avatar?path={Uri.EscapeDataString(avatarPath)}&sourceToken={Uri.EscapeDataString(avatarSourceToken)}";
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

                        return (Projection: new
                        {
                            id = requestId,
                            sourceToken = requestSourceToken,
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
                        }, EnrichmentComplete: enrichmentComplete);
                    }).ToList();

                    var enrichmentResults = await Task.WhenAll(enrichmentTasks);
                    if (!IsReadConfigurationCurrent(configStamp))
                        return ReadConfigurationChanged("the request list");

                    // Apply server-side filtering for "comingsoon"
                    if (isComingSoonFilter)
                    {
                        // Release dates are supplied by one pinned detail read per
                        // candidate. If any of those reads fails, filtering the
                        // default/null projection would silently publish a partial
                        // collection with dishonest totals. Treat enrichment as part
                        // of the complete snapshot and fail the whole response.
                        if (enrichmentResults.Any(static result => !result.EnrichmentComplete))
                        {
                            return StatusCode(502, new
                            {
                                error = true,
                                code = "upstream_enrichment_incomplete",
                                message = "Seerr could not completely enrich the request collection. Please try again.",
                                requests = Array.Empty<object>(),
                                totalPages = 0,
                                totalResults = 0,
                            });
                        }

                        var enrichedRequests = enrichmentResults
                            .Select(static result => result.Projection)
                            .ToArray();

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
                        requests.AddRange(enrichmentResults.Select(static result => result.Projection));
                    }
                }

                // Both paths derive totals from their complete, post-parental,
                // post-owner-scope collections. Coming Soon applies its future-date
                // classification before paging; normal filters page immediately.
                var totalResults = isComingSoonFilter ? comingSoonTotal : normalFilteredTotal;
                var totalPages = (int)Math.Ceiling((double)totalResults / take);

                // Fold the admin feature toggle into the capability the client
                // renders on: when In-App Request Approvals is disabled, the
                // server never advertises the capability, so the buttons never
                // render even if a stale client config flag says otherwise.
                var canApproveRequests = requestApprovalsEnabled
                    && (IsAdminUser() || SeerrPermissionHelper.HasAnyPermission(
                        seerrUser.Permissions,
                        SeerrPermission.ADMIN | SeerrPermission.MANAGE_REQUESTS
                    ));

                if (!IsReadConfigurationCurrent(configStamp))
                    return ReadConfigurationChanged("the request list");

                return Ok(new
                {
                    requests = requests,
                    totalPages = totalPages,
                    totalResults = totalResults,
                    canApproveRequests = canApproveRequests
                });
            }
            catch (OperationCanceledException) when (HttpContext.RequestAborted.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                if (!IsReadConfigurationCurrent(configStamp))
                    return ReadConfigurationChanged("the request list");

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

        /// <summary>
        /// Returns one complete request snapshot for collection consumers. Callers
        /// without request-view permission (or callers that set <paramref name="userOnly"/>)
        /// receive only their own rows; authorized request viewers retain the broader
        /// season-status visibility exposed by Seerr. Raw rows serve season-status
        /// checks while compact media keys serve the calendar's "requested" filter.
        /// Pagination and parental filtering are intentionally server-owned: filtering
        /// individual upstream pages makes visible row counts and totals unsuitable as
        /// continuation data.
        /// </summary>
        [HttpGet("arr/request-snapshot")]
        [Authorize]
        public async Task<IActionResult> GetCompleteUserRequestSnapshot([FromQuery] bool userOnly = false)
        {
            var config = _configProvider.ConfigurationOrNull;
            if (config == null)
            {
                return StatusCode(500, new
                {
                    error = true,
                    code = "configuration_unavailable",
                    message = "Plugin configuration is not available.",
                    requests = Array.Empty<object>(),
                });
            }

            var configurationRevision = _configProvider.ConfigurationRevision;
            var configStamp = SeerrMutationConfigStamp.Capture(config, configurationRevision);
            var seerrEnabled = config.SeerrEnabled;
            var seerrApiKey = config.SeerrApiKey;
            var configuredUrls = SeerrClient.GetConfiguredUrls(config.SeerrUrls);
            if (!IsReadConfigurationCurrent(configStamp))
                return ReadConfigurationChanged("the request snapshot");

            if (!seerrEnabled
                || configuredUrls.Length == 0
                || string.IsNullOrWhiteSpace(seerrApiKey))
            {
                return Ok(new
                {
                    results = Array.Empty<object>(),
                    pageInfo = new { page = 1, pages = 0, pageSize = 0, results = 0 },
                    requests = Array.Empty<object>(),
                    totalResults = 0,
                    requestKeyCount = 0,
                    complete = true,
                });
            }

            var jellyfinUserId = UserHelper.GetCurrentUserId(User)?.ToString();
            if (string.IsNullOrEmpty(jellyfinUserId))
            {
                return BadRequest(new
                {
                    error = true,
                    code = "missing_user",
                    message = "Jellyfin user identity was not available.",
                    requests = Array.Empty<object>(),
                });
            }

            var userResolution = await _seerr.ResolveSeerrUser(
                jellyfinUserId,
                bypassCache: true,
                allowAutoImport: false,
                cancellationToken: HttpContext.RequestAborted).ConfigureAwait(false);
            if (!IsReadConfigurationCurrent(configStamp))
                return ReadConfigurationChanged("the request snapshot");

            var seerrUser = userResolution.User;
            if (seerrUser == null)
            {
                if (userResolution.Status is SeerrUserResolutionStatus.Incomplete or SeerrUserResolutionStatus.Unavailable)
                {
                    return StatusCode(502, new
                    {
                        error = true,
                        code = "user_lookup_incomplete",
                        message = "Seerr user lookup was incomplete. No partial request snapshot was published.",
                        requests = Array.Empty<object>(),
                    });
                }

                return NotFound(new
                {
                    error = true,
                    code = "user_unlinked",
                    message = "Current Jellyfin user is not linked to a Seerr user.",
                    requests = Array.Empty<object>(),
                });
            }

            var jellyfinAdmin = IsAdminUser();
            var canViewAllRequests = jellyfinAdmin || SeerrPermissionHelper.HasAnyPermission(
                seerrUser.Permissions,
                SeerrPermission.ADMIN | SeerrPermission.MANAGE_REQUESTS | SeerrPermission.REQUEST_VIEW);
            var selfScoped = userOnly || !canViewAllRequests;

            // Seerr user ids are instance-local. A missing source, or one that
            // was removed/replaced after resolution, must not fall back to a
            // different configured identity domain with the same numeric id.
            var normalizedResolvedSource = SeerrUrlIdentity.Normalize(seerrUser.SourceUrl);
            var configuredSource = configuredUrls.FirstOrDefault(url => string.Equals(
                    url,
                    normalizedResolvedSource,
                    StringComparison.Ordinal));
            if (configuredSource == null)
            {
                return StatusCode(502, new
                {
                    error = true,
                    code = "source_affinity_unavailable",
                    message = "The linked Seerr instance could not be verified. No request snapshot was published.",
                    requests = Array.Empty<object>(),
                });
            }

            var urls = new[] { configuredSource };
            var client = SeerrHttpHelper.CreateClient(_httpClientFactory);
            client.Timeout = TimeSpan.FromSeconds(15);
            var snapshot = await FetchUserRequestSnapshotAsync(
                client,
                urls,
                seerrApiKey,
                seerrUser.Id.ToString(System.Globalization.CultureInfo.InvariantCulture),
                HttpContext.RequestAborted,
                selfScoped: selfScoped,
                includeApiUserHeader: selfScoped || !jellyfinAdmin).ConfigureAwait(false);
            if (!IsReadConfigurationCurrent(configStamp))
                return ReadConfigurationChanged("the request snapshot");

            if (!snapshot.IsComplete)
            {
                _logger.LogWarning(
                    "Calendar request-key collection from {Url} was incomplete: {Reason}",
                    snapshot.SourceUrl,
                    snapshot.FailureReason);
                return StatusCode(502, new
                {
                    error = true,
                    code = "upstream_collection_incomplete",
                    message = "Seerr returned an incomplete request collection. Please try again.",
                    requests = Array.Empty<object>(),
                });
            }

            // Apply the caller's parental policy once to the complete collection.
            // This avoids publishing a successfully filtered prefix when a later
            // upstream page fails and keeps the post-filter total authoritative.
            var completeJson = JsonSerializer.Serialize(new
            {
                results = snapshot.Items,
                pageInfo = new
                {
                    page = 1,
                    pages = snapshot.Items.Count == 0 ? 0 : 1,
                    pageSize = snapshot.Items.Count,
                    results = snapshot.Items.Count,
                },
            });
            SeerrParentalResult parental;
            try
            {
                parental = await _parentalFilter.ApplyAsync(
                    completeJson,
                    "/api/v1/request",
                    SeerrCaller()).ConfigureAwait(false);
                if (!IsReadConfigurationCurrent(configStamp))
                    return ReadConfigurationChanged("the request snapshot");
            }
            catch (Exception ex)
            {
                if (!IsReadConfigurationCurrent(configStamp))
                    return ReadConfigurationChanged("the request snapshot");

                _logger.LogWarning(ex, "Strict request-snapshot parental filtering threw; refusing unfiltered output.");
                return ParentalFilterIncomplete();
            }

            if (!parental.Succeeded || parental.Block)
            {
                _logger.LogWarning(
                    "Strict request-snapshot parental filtering did not produce a usable filtered collection (Succeeded={Succeeded}, Block={Block}).",
                    parental.Succeeded,
                    parental.Block);
                return ParentalFilterIncomplete();
            }

            var data = JsonNode.Parse(parental.Body)?.AsObject();
            var results = data?["results"] as JsonArray;
            if (results == null)
            {
                return StatusCode(502, new
                {
                    error = true,
                    code = "upstream_collection_invalid",
                    message = "Seerr returned an invalid request collection. Please try again.",
                    requests = Array.Empty<object>(),
                });
            }

            var keys = new List<object>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var seenRequestIds = new HashSet<int>();
            var scopedResults = new JsonArray();
            foreach (var row in results)
            {
                var request = row as JsonObject;
                var requestedBy = request?["requestedBy"] as JsonObject;
                var ownerId = ReadPositiveJsonInt(requestedBy?["id"]);
                if (ownerId is not > 0)
                {
                    return InvalidRequestKeyCollection();
                }

                if (selfScoped && ownerId != seerrUser.Id)
                {
                    // The admin-key request is upstream-scoped, but keep a local
                    // privacy backstop in case that query parameter is ignored.
                    continue;
                }

                var requestId = ReadPositiveJsonInt(request?["id"]);
                if (requestId is not > 0 || !seenRequestIds.Add(requestId.Value))
                {
                    return InvalidRequestKeyCollection();
                }

                var media = request?["media"] as JsonObject;
                var tmdbId = ReadPositiveJsonInt(media?["tmdbId"]);
                var requestMediaType = ReadJsonString(request?["type"])?.Trim().ToLowerInvariant();
                var nestedMediaType = ReadJsonString(media?["mediaType"])?.Trim().ToLowerInvariant();
                var mediaType = requestMediaType ?? nestedMediaType;
                if (tmdbId is not > 0 || (mediaType != "movie" && mediaType != "tv"))
                {
                    return InvalidRequestKeyCollection();
                }

                if (nestedMediaType != null
                    && (nestedMediaType is not ("movie" or "tv")
                        || !string.Equals(mediaType, nestedMediaType, StringComparison.Ordinal)))
                {
                    return InvalidRequestKeyCollection();
                }

                var key = $"{mediaType}:{tmdbId.Value}";
                if (seen.Add(key))
                {
                    keys.Add(new { tmdbId = tmdbId.Value, type = mediaType });
                }

                scopedResults.Add(row?.DeepClone());
            }

            if (!IsReadConfigurationCurrent(configStamp))
                return ReadConfigurationChanged("the request snapshot");

            return Ok(new
            {
                // Full raw rows retain Seerr's season request details for the
                // more-info modal. Compact keys avoid making the calendar know
                // that upstream schema. Both projections come from this same
                // complete, post-filter snapshot.
                results = scopedResults,
                pageInfo = new
                {
                    page = 1,
                    pages = scopedResults.Count == 0 ? 0 : 1,
                    pageSize = scopedResults.Count,
                    results = scopedResults.Count,
                },
                requests = keys,
                totalResults = scopedResults.Count,
                requestKeyCount = keys.Count,
                complete = true,
            });

            ObjectResult InvalidRequestKeyCollection()
            {
                _logger.LogWarning(
                    "Complete calendar request-key collection from {Url} contained an invalid self-scoped row; refusing a partial result.",
                    snapshot.SourceUrl);
                return StatusCode(502, new
                {
                    error = true,
                    code = "upstream_collection_invalid",
                    message = "Seerr returned an invalid request collection. Please try again.",
                    requests = Array.Empty<object>(),
                });
            }
        }

        private ObjectResult ParentalFilterIncomplete()
            => StatusCode(502, new
            {
                error = true,
                code = "parental_filter_incomplete",
                message = "The complete request collection could not be filtered safely. Please try again.",
                requests = Array.Empty<object>(),
            });

        /// <summary>
        /// Validates every request owner before mutating the collection, then
        /// removes well-formed foreign rows. The upstream <c>requestedBy</c>
        /// query is only an optimization; this is the privacy backstop when an
        /// admin-key response ignores that scope.
        /// </summary>
        internal static bool TryApplySelfScope(
            JsonArray results,
            int expectedOwnerId,
            out int removed)
        {
            removed = 0;
            var owners = new int[results.Count];
            for (var i = 0; i < results.Count; i++)
            {
                var owner = ReadPositiveJsonInt(
                    ((results[i] as JsonObject)?["requestedBy"] as JsonObject)?["id"]);
                if (owner is not > 0)
                {
                    return false;
                }

                owners[i] = owner.Value;
            }

            for (var i = results.Count - 1; i >= 0; i--)
            {
                if (owners[i] == expectedOwnerId) continue;
                results.RemoveAt(i);
                removed++;
            }

            return true;
        }

        // Builds the outer-catch "requests fetch failed" message. Admins see the raw exception text;
        // non-admins get the Seerr URL/host rewritten to <seerr-url>. Extracted so the redaction is
        // unit-testable without a live HTTP round-trip.
        internal static string BuildRequestsFetchErrorMessage(bool isAdmin, string exMessage)
        {
            var full = $"Failed to fetch requests from Seerr: {exMessage}";
            return isAdmin ? full : Helpers.Seerr.SeerrError.SanitizeMessage(full);
        }

        // Coming-soon reads one complete non-terminal (`processing`) collection,
        // then classifies future dates locally. Bounded so a huge or broken Seerr
        // cannot drive unbounded calls or publish a truncated prefix.
        internal const int ComingSoonPageSize = 100;
        internal const int ComingSoonMaxItems = 5000;
        internal const int ComingSoonMaxPagesPerFilter = 1000;
        internal const int MaxConcurrentRequestEnrichments = 12;

        internal const int RequestKeyPageSize = 200;
        internal const int RequestKeyMaxItems = 5000;
        internal const int RequestKeyMaxPages = 1000;

        /// <summary>
        /// Reads one complete, stable request-list snapshot for the caller's pinned
        /// Seerr identity domain. The shared paginator follows upstream metadata,
        /// advances by actual returned rows, performs two identical scans, and
        /// exposes no prefix when either scan is incomplete or unstable.
        /// </summary>
        internal static Task<SeerrPagedCollectionResult> FetchRequestListCollectionAsync(
            HttpClient httpClient,
            IEnumerable<string> seerrUrls,
            string apiKey,
            string filter,
            string scopeParam,
            CancellationToken cancellationToken,
            int pageSize = ComingSoonPageSize,
            int maxItems = ComingSoonMaxItems,
            int maxPages = ComingSoonMaxPagesPerFilter)
            => SeerrPaginationHelper.FetchAllAsync(
                httpClient,
                seerrUrls,
                (url, _, skip) => $"{url}/api/v1/request?take={pageSize}&skip={skip}&filter={Uri.EscapeDataString(filter)}{scopeParam}",
                apiKey,
                apiUserId: null,
                requestedPageSize: pageSize,
                RequestRowIdentity,
                cancellationToken,
                maximumPages: maxPages,
                maximumItems: maxItems);

        internal static Task<SeerrPagedCollectionResult> FetchUserRequestSnapshotAsync(
            HttpClient httpClient,
            IEnumerable<string> seerrUrls,
            string apiKey,
            string seerrUserId,
            CancellationToken cancellationToken,
            bool selfScoped = true,
            int pageSize = RequestKeyPageSize,
            int maxItems = RequestKeyMaxItems,
            int maxPages = RequestKeyMaxPages,
            bool includeApiUserHeader = true)
            => SeerrPaginationHelper.FetchAllAsync(
                httpClient,
                seerrUrls,
                (url, _, skip) => $"{url}/api/v1/request?take={pageSize}&skip={skip}&filter=all{(selfScoped ? $"&requestedBy={Uri.EscapeDataString(seerrUserId)}" : string.Empty)}",
                apiKey,
                includeApiUserHeader ? seerrUserId : null,
                requestedPageSize: pageSize,
                RequestRowIdentity,
                cancellationToken,
                maximumPages: maxPages,
                maximumItems: maxItems);

        /// <summary>
        /// Reads one complete coming-soon request collection. The common paginator
        /// follows Seerr's own completion metadata, advances skip by actual returned
        /// rows, rejects repeated/non-advancing pages, and exposes no partial prefix.
        /// </summary>
        internal static Task<SeerrPagedCollectionResult> FetchComingSoonCollectionAsync(
            HttpClient httpClient,
            string seerrUrl,
            string apiKey,
            string scopeParam,
            CancellationToken cancellationToken,
            int pageSize = ComingSoonPageSize,
            int maxItems = ComingSoonMaxItems,
            int maxPages = ComingSoonMaxPagesPerFilter)
            => FetchComingSoonCollectionAsync(
                httpClient,
                new[] { seerrUrl },
                apiKey,
                scopeParam,
                cancellationToken,
                pageSize,
                maxItems,
                maxPages);

        internal static Task<SeerrPagedCollectionResult> FetchComingSoonCollectionAsync(
            HttpClient httpClient,
            IEnumerable<string> seerrUrls,
            string apiKey,
            string scopeParam,
            CancellationToken cancellationToken,
            int pageSize = ComingSoonPageSize,
            int maxItems = ComingSoonMaxItems,
            int maxPages = ComingSoonMaxPagesPerFilter)
            => FetchRequestListCollectionAsync(
                httpClient,
                seerrUrls,
                apiKey,
                "processing",
                scopeParam,
                cancellationToken,
                pageSize,
                maxItems,
                maxPages);

        private static string? RequestRowIdentity(JsonElement row)
            => SeerrPaginationHelper.CanonicalPositiveIntegerPropertyIdentity(row, "id");

        internal static bool TryClassifyComingSoonCandidate(JsonElement row, out bool include)
        {
            include = false;
            if (row.ValueKind != JsonValueKind.Object
                || !TryReadPositiveJsonInt(row, "id", out _)
                || !row.TryGetProperty("status", out var requestStatusElement)
                || requestStatusElement.ValueKind != JsonValueKind.Number
                || !requestStatusElement.TryGetInt32(out var requestStatus)
                || requestStatus != 2
                || !row.TryGetProperty("type", out var typeElement)
                || typeElement.ValueKind != JsonValueKind.String
                || !row.TryGetProperty("is4k", out var is4kElement)
                || is4kElement.ValueKind is not (JsonValueKind.True or JsonValueKind.False)
                || !row.TryGetProperty("requestedBy", out var requestedBy)
                || requestedBy.ValueKind != JsonValueKind.Object
                || !TryReadPositiveJsonInt(requestedBy, "id", out _)
                || !row.TryGetProperty("media", out var media)
                || media.ValueKind != JsonValueKind.Object)
            {
                return false;
            }

            var type = typeElement.GetString();
            if (type is not ("movie" or "tv")) return false;

            if (!TryReadPositiveJsonInt(media, "tmdbId", out _)
                || !media.TryGetProperty("mediaType", out var nestedType)
                || nestedType.ValueKind != JsonValueKind.String
                || !string.Equals(type, nestedType.GetString(), StringComparison.Ordinal))
            {
                return false;
            }

            var is4kRequest = is4kElement.ValueKind == JsonValueKind.True;
            var mediaStatusProperty = is4kRequest ? "status4k" : "status";
            var downloadStatusProperty = is4kRequest ? "downloadStatus4k" : "downloadStatus";
            if (!media.TryGetProperty(mediaStatusProperty, out var mediaStatusElement)
                || mediaStatusElement.ValueKind != JsonValueKind.Number
                || !mediaStatusElement.TryGetInt32(out var mediaStatus)
                || mediaStatus is < 1 or > 4
                || !media.TryGetProperty(downloadStatusProperty, out var downloads)
                || downloads.ValueKind != JsonValueKind.Array)
            {
                // Seerr's processing filter is defined as UNKNOWN through
                // PARTIALLY_AVAILABLE. A missing/out-of-range value means this
                // row is not a trustworthy member of that collection.
                return false;
            }

            var hasActiveDownload = downloads.GetArrayLength() > 0;
            var status = GetMediaStatus(requestStatus, mediaStatus, hasActiveDownload);
            include = type == "tv"
                ? status is "Processing" or "Approved" or "Partially Available"
                : status is "Processing" or "Approved";
            return true;
        }

        private static bool TryReadPositiveJsonInt(
            JsonElement owner,
            string propertyName,
            out int value)
        {
            value = 0;
            return owner.TryGetProperty(propertyName, out var element)
                && element.ValueKind == JsonValueKind.Number
                && element.TryGetInt32(out value)
                && value > 0;
        }

        private static int? ReadPositiveJsonInt(JsonNode? node)
            => node is JsonValue value && value.TryGetValue<int>(out var parsed)
                ? ArrIdHelper.ToNullableId(parsed)
                : null;

        private static string? ReadJsonString(JsonNode? node)
            => node is JsonValue value && value.TryGetValue<string>(out var parsed)
                ? parsed
                : null;

        private static bool ReadJsonBoolean(JsonNode? node)
            => node is JsonValue value
                && value.TryGetValue<bool>(out var parsed)
                && parsed;

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
        public async Task<IActionResult> ActOnRequest(
            [FromRoute] int requestId,
            [FromQuery] string? sourceToken = null)
        {
            var action = HttpContext.Request.Path.Value?.Contains("/approve", StringComparison.OrdinalIgnoreCase) == true ? "approve" : "decline";

            var config = _configProvider.ConfigurationOrNull;
            if (config == null
                || !config.SeerrEnabled
                || string.IsNullOrWhiteSpace(config.SeerrUrls)
                || string.IsNullOrWhiteSpace(config.SeerrApiKey))
                return StatusCode(503, new { error = true, message = "Seerr not configured." });

            // The admin feature toggle gates the action server-side too — the
            // client hides the buttons when it's off, but the server still
            // enforces so a crafted request can't bypass a disabled feature.
            if (!config.RequestApprovalsEnabled)
                return StatusCode(403, new { error = true, message = "In-app request approvals are disabled." });

            var mutationConfigStamp = SeerrMutationConfigStamp.Capture(
                config,
                _configProvider.ConfigurationRevision);

            var jellyfinUserId = UserHelper.GetCurrentUserId(User)?.ToString();
            if (string.IsNullOrEmpty(jellyfinUserId))
                return BadRequest(new { message = "Jellyfin User ID not found." });

            if (requestId <= 0
                || !SeerrSourceToken.TryValidate(
                    sourceToken,
                    config.SeerrApiKey,
                    SeerrSourceToken.RequestActionPurpose,
                    jellyfinUserId,
                    requestId.ToString(CultureInfo.InvariantCulture),
                    out var sourceClaims))
            {
                return StatusCode(403, new
                {
                    error = true,
                    code = "invalid_source_token",
                    message = "The request action token is missing, invalid, or expired. Refresh the request list and try again."
                });
            }

            var configuredUrls = SeerrClient.GetConfiguredUrls(config.SeerrUrls);
            var tokenSource = configuredUrls.FirstOrDefault(url => SeerrSourceToken.MatchesSource(
                sourceClaims!.SourceKey,
                config.SeerrApiKey,
                url));
            if (tokenSource == null)
            {
                return StatusCode(409, new
                {
                    error = true,
                    code = "stale_source_token",
                    message = "The linked Seerr instance changed. Refresh the request list before trying again."
                });
            }

            var userResolution = await _seerr.ResolveSeerrUser(
                jellyfinUserId,
                bypassCache: true,
                allowAutoImport: false,
                cancellationToken: HttpContext.RequestAborted).ConfigureAwait(false);

            var currentConfig = _configProvider.ConfigurationOrNull;
            if (!mutationConfigStamp.Matches(
                    currentConfig,
                    _configProvider.ConfigurationRevision)
                || currentConfig == null
                || !currentConfig.SeerrEnabled
                || !currentConfig.RequestApprovalsEnabled
                || string.IsNullOrWhiteSpace(currentConfig.SeerrUrls)
                || string.IsNullOrWhiteSpace(currentConfig.SeerrApiKey))
            {
                return StatusCode(409, new
                {
                    error = true,
                    code = "mutation_configuration_changed",
                    message = "Seerr approval configuration changed while preparing the action. No mutation was attempted; refresh and try again."
                });
            }

            config = currentConfig;
            configuredUrls = SeerrClient.GetConfiguredUrls(config.SeerrUrls);
            tokenSource = configuredUrls.FirstOrDefault(url => SeerrSourceToken.MatchesSource(
                sourceClaims!.SourceKey,
                config.SeerrApiKey,
                url));
            if (tokenSource == null)
            {
                return StatusCode(409, new
                {
                    error = true,
                    code = "stale_source_token",
                    message = "The linked Seerr instance changed. Refresh the request list before trying again."
                });
            }

            var seerrUser = userResolution.User;
            if (seerrUser == null)
            {
                if (userResolution.Status is SeerrUserResolutionStatus.Incomplete or SeerrUserResolutionStatus.Unavailable)
                {
                    return StatusCode(502, new
                    {
                        error = true,
                        code = "user_lookup_incomplete",
                        message = "Seerr user lookup was incomplete. No request action was attempted."
                    });
                }

                return NotFound(new { message = "Current user is not linked to a Seerr account." });
            }

            var resolvedSource = SeerrSourceToken.NormalizeSourceUrl(seerrUser.SourceUrl);
            if (!string.Equals(resolvedSource, tokenSource, StringComparison.Ordinal)
                || !string.Equals(
                    sourceClaims!.Binding,
                    seerrUser.Id.ToString(CultureInfo.InvariantCulture),
                    StringComparison.Ordinal))
            {
                // Seerr request ids are instance-local. Never send an action
                // when the caller's current mapping differs from the source
                // that issued the list row, even if the numeric id exists on
                // both instances.
                return StatusCode(409, new
                {
                    error = true,
                    code = "stale_source_token",
                    message = "The linked Seerr instance changed. Refresh the request list before trying again."
                });
            }

            bool canApprove = IsAdminUser() || SeerrPermissionHelper.HasAnyPermission(
                seerrUser.Permissions,
                SeerrPermission.ADMIN | SeerrPermission.MANAGE_REQUESTS
            );
            if (!canApprove)
                return StatusCode(403, new { error = true, message = "You do not have permission to approve or decline requests." });

            var requestUri = $"{tokenSource}/api/v1/request/{requestId}/{action}";
            var client = Helpers.Seerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
            using var httpRequest = Helpers.Seerr.SeerrHttpHelper.BuildRequest(
                HttpMethod.Post, requestUri, config.SeerrApiKey, seerrUser.Id.ToString());
            var (content, error, _) = await Helpers.Seerr.SeerrHttpHelper.SendAndReadJsonAsync(
                client,
                httpRequest,
                requestUri,
                HttpContext.RequestAborted).ConfigureAwait(false);

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
                _seerr.EvictMediaDetailCache(tmdbId, mediaType);
            }
            catch { /* best-effort — a parse failure just leaves the cache to TTL */ }
        }

        private async Task<(bool IsComplete, string? Title, int? Year, string? PosterUrl, string? DigitalReleaseDate, string? TheatricalReleaseDate, string? InitialAirDate, string? NextAirDate)> EnrichWithTmdbData(
            HttpClient client,
            int tmdbId,
            string type,
            string seerrUrl,
            string apiKey,
            bool cacheEnabled,
            long configurationRevision,
            SeerrMutationConfigStamp configStamp,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!IsReadConfigurationCurrent(configStamp))
            {
                return default;
            }

            var normalizedSource = SeerrUrlIdentity.Normalize(seerrUrl);
            if (normalizedSource == null)
            {
                return default;
            }

            var mediaType = type == "movie" ? "movie" : "tv";
            // TMDB projections come through the pinned Seerr identity domain,
            // whose locale/configuration and even payload can differ. Keep both
            // the cache and single-flight lease source-bound so concurrent
            // requests for the same TMDB id on A and B cannot share A's body.
            var apiKeyFingerprint = Convert.ToHexString(
                SHA256.HashData(Encoding.UTF8.GetBytes(apiKey)));
            var cacheKey = $"{configurationRevision}:{apiKeyFingerprint}:{normalizedSource.Length}:{normalizedSource}:{mediaType}:{tmdbId}";
            var cacheTtl = _seerrCache.GetTmdbEnrichmentCacheTtl();

            if (cacheEnabled)
            {
                TmdbEnrichmentResult? cachedResult = null;
                lock (_seerrCache.TmdbEnrichmentCacheLock)
                {
                    if (_seerrCache.TmdbEnrichmentCache.TryGetValue(cacheKey, out var cached) &&
                        cached.ConfigurationRevision == configurationRevision &&
                        DateTime.UtcNow - cached.CachedAt < cacheTtl)
                    {
                        cachedResult = cached.Data;
                    }
                }

                if (cachedResult != null)
                {
                    if (!IsReadConfigurationCurrent(configStamp))
                    {
                        return default;
                    }

                    return (
                        cachedResult.IsComplete,
                        cachedResult.Title,
                        cachedResult.Year,
                        cachedResult.PosterUrl,
                        cachedResult.DigitalReleaseDate,
                        cachedResult.TheatricalReleaseDate,
                        cachedResult.InitialAirDate,
                        cachedResult.NextAirDate);
                }
            }

            async Task<TmdbEnrichmentResult> FetchEnrichmentAsync(CancellationToken fetchCancellationToken)
            {
                // The process-wide lease belongs to the actual upstream work,
                // not to an individual (and possibly canceled) waiter. For a
                // cached flight this method runs once behind AsyncSingleFlight;
                // for cache-disabled calls it directly bounds that HTTP fetch.
                await _requestEnrichmentGate.WaitAsync(fetchCancellationToken).ConfigureAwait(false);
                try
                {
                    if (!IsReadConfigurationCurrent(configStamp))
                    {
                        return new TmdbEnrichmentResult();
                    }

                    var endpoint = type == "movie" ? "movie" : "tv";
                    var enrichUri = $"{normalizedSource}/api/v1/{endpoint}/{tmdbId}";
                    using var enrichRequest = Helpers.Seerr.SeerrHttpHelper.BuildRequest(
                        HttpMethod.Get, enrichUri, apiKey);
                    var (content, enrichError, _) = await Helpers.Seerr.SeerrHttpHelper.SendAndReadJsonAsync(
                        client,
                        enrichRequest,
                        enrichUri,
                        fetchCancellationToken).ConfigureAwait(false);

                    if (!IsReadConfigurationCurrent(configStamp))
                    {
                        return new TmdbEnrichmentResult();
                    }

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
                        IsComplete = true,
                        Title = title,
                        Year = year,
                        PosterUrl = posterUrl,
                        DigitalReleaseDate = digitalReleaseDate,
                        TheatricalReleaseDate = theatricalReleaseDate,
                        InitialAirDate = initialAirDate,
                        NextAirDate = nextAirDate
                    };
                }
                catch (OperationCanceledException) when (fetchCancellationToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    _logger.LogWarning($"Failed to enrich request with TMDB data: {ex.Message}");
                    return new TmdbEnrichmentResult();
                }
                finally
                {
                    _requestEnrichmentGate.Release();
                }
            }

            TmdbEnrichmentResult result;
            if (cacheEnabled)
            {
                async Task<TmdbEnrichmentResult> FetchAndCacheEnrichmentAsync()
                {
                    var fetchedResult = await FetchEnrichmentAsync(CancellationToken.None)
                        .ConfigureAwait(false);

                    // Don't cache empty enrichment results from upstream
                    // failures. Cache publication is part of the shared task,
                    // so completion/removal never exposes a miss first.
                    var isEmpty = string.IsNullOrEmpty(fetchedResult.Title)
                        && fetchedResult.Year == null
                        && string.IsNullOrEmpty(fetchedResult.PosterUrl);
                    if (!isEmpty && IsReadConfigurationCurrent(configStamp))
                    {
                        lock (_seerrCache.TmdbEnrichmentCacheLock)
                        {
                            _seerrCache.TmdbEnrichmentCache[cacheKey] = (
                                fetchedResult,
                                DateTime.UtcNow,
                                configurationRevision);

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

                        // A save can race the final publication check. Entries
                        // are generation-tagged and therefore unreadable, but
                        // eagerly remove this exact stale publication as well.
                        if (!IsReadConfigurationCurrent(configStamp))
                        {
                            lock (_seerrCache.TmdbEnrichmentCacheLock)
                            {
                                if (_seerrCache.TmdbEnrichmentCache.TryGetValue(cacheKey, out var published)
                                    && published.ConfigurationRevision == configurationRevision)
                                {
                                    _seerrCache.TmdbEnrichmentCache.Remove(cacheKey);
                                }
                            }
                        }
                    }

                    return fetchedResult;
                }

                // The coalesced task is shared by unrelated HTTP requests, so it
                // cannot be owned by whichever request happened to create it.
                // Each caller cancels only its wait; the shared 15-second HTTP
                // timeout still bounds the underlying work for other waiters.
                var fetchTask = Helpers.AsyncSingleFlight.GetOrAdd(
                    _seerrCache.TmdbEnrichmentInFlight,
                    cacheKey,
                    FetchAndCacheEnrichmentAsync);
                result = await fetchTask.WaitAsync(cancellationToken).ConfigureAwait(false);
            }
            else
            {
                result = await FetchEnrichmentAsync(cancellationToken).ConfigureAwait(false);
            }

            result ??= new TmdbEnrichmentResult();
            if (!IsReadConfigurationCurrent(configStamp))
            {
                return default;
            }

            return (result.IsComplete, result.Title, result.Year, result.PosterUrl, result.DigitalReleaseDate, result.TheatricalReleaseDate, result.InitialAirDate, result.NextAirDate);
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
