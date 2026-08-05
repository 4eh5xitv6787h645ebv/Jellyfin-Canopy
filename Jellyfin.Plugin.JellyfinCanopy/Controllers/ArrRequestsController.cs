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
using Jellyfin.Plugin.JellyfinCanopy.Data;
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
        private readonly Services.Arr.ArrDownloadActivityService? _downloadActivity;
        private readonly ISeerrParentalFilter _parentalFilter;
        private readonly IItemLookupService _itemLookup;
        private readonly Services.Arr.CalendarRequesterTagResolver? _calendarRequesterTags;

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
            IItemLookupService itemLookup,
            ISeerrParentalFilter parentalFilter,
            Services.Arr.ArrDownloadActivityService? downloadActivity = null,
            Services.Arr.CalendarRequesterTagResolver? calendarRequesterTags = null)
            : base(httpClientFactory, logger, userManager, seerrCache, configProvider)
        {
            _seerr = seerr;
            _ = arrFetch;
            _downloadActivity = downloadActivity;
            _parentalFilter = parentalFilter;
            _itemLookup = itemLookup;
            _calendarRequesterTags = calendarRequesterTags;
        }

        [HttpGet("arr/queue")]
        [Authorize]
        public async Task<IActionResult> GetDownloadQueue(
            [FromQuery] int historyPage = 1,
            [FromQuery] int historyPageSize = 20,
            [FromQuery] string? search = null)
        {
            var config = _configProvider.ConfigurationOrNull;
            if (config == null)
                return StatusCode(500, "Plugin configuration not available");

            // These are authorization gates, not only navigation preferences. An authenticated
            // caller cannot bypass a disabled surface by calling the route directly.
            if (!config.DownloadsPageEnabled || !config.ShowDownloadsInRequests)
                return NotFound();

            var configurationRevision = _configProvider.ConfigurationRevision;
            var configStamp = SeerrMutationConfigStamp.Capture(config, configurationRevision);
            var isAdmin = IsAdminUser();
            var seerrEnabled = SeerrIntegrationPolicy.HasUsableSavedConfiguration(config);
            var seerrApiKey = config.SeerrApiKey;
            var configuredUrls = SeerrClient.GetConfiguredUrls(config.SeerrUrls);
            if (!IsReadConfigurationCurrent(configStamp))
                return ReadConfigurationChanged("the download queue");

            var allowedRequests = new HashSet<(int TmdbId, string MediaType)>();
            var allowedTvTvdb = new HashSet<int>();
            // With no usable Seerr integration, an empty association set is authoritative:
            // origin remains Unknown, but the optional provenance source is not "down".
            // A configured integration becomes incomplete until the current user's pinned
            // source and complete request collection are positively resolved below.
            var seerrScopeComplete = isAdmin
                || !seerrEnabled
                || configuredUrls.Length == 0
                || string.IsNullOrWhiteSpace(seerrApiKey);
            if (!isAdmin)
            {
                seerrScopeComplete = !seerrEnabled
                    || configuredUrls.Length == 0
                    || string.IsNullOrWhiteSpace(seerrApiKey);
                var jellyfinUserId = UserHelper.GetCurrentUserId(User);
                if (jellyfinUserId.HasValue
                    && seerrEnabled
                    && configuredUrls.Length > 0
                    && !string.IsNullOrWhiteSpace(seerrApiKey))
                {
                    var userResolution = await _seerr.ResolveSeerrUser(
                        jellyfinUserId.Value.ToString(),
                        bypassCache: true,
                        allowAutoImport: false,
                        cancellationToken: HttpContext.RequestAborted).ConfigureAwait(false);
                    if (!IsReadConfigurationCurrent(configStamp))
                        return ReadConfigurationChanged("the download queue");

                    var seerrUser = userResolution.User;
                    if (seerrUser == null)
                    {
                        // A conclusive "not linked" result is a complete empty request scope.
                        // Transient/incomplete resolution remains visibly degraded.
                        seerrScopeComplete = userResolution.Status is not
                            (SeerrUserResolutionStatus.Incomplete
                            or SeerrUserResolutionStatus.Unavailable);
                    }
                    else
                    {
                        var configuredSource = configuredUrls.FirstOrDefault(url =>
                            string.Equals(
                                url,
                                SeerrUrlIdentity.Normalize(seerrUser.SourceUrl),
                                StringComparison.Ordinal));
                        if (configuredSource != null)
                        {
                            var userRequests = await _seerr.GetRequestsForUser(
                                seerrUser.Id.ToString(CultureInfo.InvariantCulture),
                                configuredSource,
                                config,
                                configurationRevision,
                                seerrApiKey,
                                configuredUrls,
                                HttpContext.RequestAborted).ConfigureAwait(false);
                            if (!IsReadConfigurationCurrent(configStamp))
                                return ReadConfigurationChanged("the download queue");

                            if (userRequests != null)
                            {
                                seerrScopeComplete = true;
                                allowedRequests = new HashSet<(int, string)>(userRequests
                                    .Where(request => request.TmdbId > 0)
                                    .Select(request => (request.TmdbId, request.MediaType)));
                                allowedTvTvdb = new HashSet<int>(userRequests
                                    .Where(request => request.MediaType == "tv"
                                        && request.TvdbId is > 0)
                                    .Select(request => request.TvdbId!.Value));
                            }
                        }
                    }
                }
            }

            var currentUserId = UserHelper.GetCurrentUserId(User);
            var currentUser = currentUserId.HasValue
                ? _userManager.GetUserById(currentUserId.Value)
                : null;
            if (!isAdmin && currentUser == null)
                return Forbid();

            if (_downloadActivity == null)
                return StatusCode(500, new
                {
                    error = true,
                    code = "download_activity_unavailable",
                    message = "Download activity is temporarily unavailable.",
                });

            WarnIfArrInstancesCorrupt(config);
            var response = await _downloadActivity.GetActivityAsync(
                config,
                new Services.Arr.ArrDownloadAccessContext
                {
                    IsAdmin = isAdmin,
                    User = currentUser,
                    SeerrScopeComplete = seerrScopeComplete,
                    SeerrRequests = allowedRequests,
                    SeerrTvTvdbIds = allowedTvTvdb,
                    SeerrArrScopes =
                        Services.Arr.ArrDownloadActivityService.GetUnambiguousSeerrArrScopes(
                            config,
                            configuredUrls.Length),
                    FilterByUserRequests = config.DownloadsFilterByUserRequests,
                    AllowActive = isAdmin || config.DownloadsAllowActiveForRegularUsers,
                    AllowProcessing = isAdmin || config.DownloadsAllowProcessingForRegularUsers,
                    AllowWarnings = isAdmin || config.DownloadsAllowWarningsForRegularUsers,
                    AllowHistory = isAdmin || config.DownloadsAllowHistoryForRegularUsers,
                    AllowProvenance = isAdmin || config.DownloadsAllowProvenanceForRegularUsers,
                    DetailedLifecycle = isAdmin || config.DownloadsDetailedLifecycleForRegularUsers,
                    HistoryPage = Math.Max(1, historyPage),
                    HistoryPageSize = Math.Clamp(
                        historyPageSize,
                        1,
                        Services.Arr.ArrDownloadActivityService.MaxHistoryPageSize),
                    Search = (search ?? string.Empty).Trim()[..Math.Min(
                        (search ?? string.Empty).Trim().Length,
                        100)],
                },
                HttpContext.RequestAborted).ConfigureAwait(false);
            if (!IsReadConfigurationCurrent(configStamp))
                return ReadConfigurationChanged("the download queue");

            return Ok(response);
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

        [HttpGet("arr/requests")]
        [Authorize]
        public async Task<IActionResult> GetRequests([FromQuery] int take = 20, [FromQuery] int skip = 0, [FromQuery] string? filter = null, [FromQuery] bool userOnly = false)
        {
            take = Math.Clamp(take, 1, 200);
            skip = Math.Max(0, skip);

            var pageConfig = _configProvider.ConfigurationOrNull;
            if (pageConfig == null)
                return StatusCode(500, "Plugin configuration not available");
            if (!pageConfig.DownloadsPageEnabled)
                return NotFound();

            var integration = SeerrIntegrationPolicy.Capture(_configProvider);
            if (integration.State == SeerrIntegrationState.Disabled)
            {
                return Ok(new
                {
                    error = false,
                    code = "seerr_disabled",
                    disabled = true,
                    requests = Array.Empty<object>(),
                    totalPages = 0,
                    totalResults = 0,
                    canApproveRequests = false,
                });
            }

            if (!integration.IsActive
                && integration.State != SeerrIntegrationState.ConfigurationUnavailable)
            {
                return Ok(new
                {
                    error = false,
                    code = "seerr_unavailable",
                    disabled = false,
                    requests = Array.Empty<object>(),
                    totalPages = 0,
                    totalResults = 0,
                    canApproveRequests = false,
                });
            }

            var config = integration.Configuration;
            if (!integration.IsActive || config == null)
                return StatusCode(500, "Plugin configuration not available");
            if (!config.DownloadsPageEnabled)
                return NotFound();

            if (!IsAdminUser() && !config.RequestsAllowSeerrStatusAndHistoryForRegularUsers)
            {
                return Ok(new
                {
                    error = false,
                    code = "seerr_status_history_hidden",
                    disabled = false,
                    requests = Array.Empty<object>(),
                    totalPages = 0,
                    totalResults = 0,
                    canApproveRequests = false,
                });
            }

            var configurationRevision = integration.ConfigurationRevision;
            var configStamp = SeerrMutationConfigStamp.Capture(config, configurationRevision);
            var seerrApiKey = integration.ApiKey;
            var configuredUrls = integration.Urls;
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

                var jellyfinUserGuid = UserHelper.GetCurrentUserId(User);
                var jellyfinUserId = jellyfinUserGuid?.ToString();

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
                SeerrDispatchFence dispatchFence = integration
                    .CreateDispatchFence(_configProvider)
                    .Restrict(() => IsReadConfigurationCurrent(configStamp));

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
                    dispatchFence,
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

                var jellyfinCaller = jellyfinUserGuid.HasValue
                    ? _userManager.GetUserById(jellyfinUserGuid.Value)
                    : null;
                if (!TryApplyRequestLibraryScope(
                    results,
                    jellyfinCaller,
                    _itemLookup,
                    out var libraryScopedResults))
                {
                    _logger.LogWarning(
                        "Could not prove the complete caller-scoped Jellyfin library projection for the Seerr request list; refusing partial output.");
                    return StatusCode(502, new
                    {
                        error = true,
                        code = "library_scope_incomplete",
                        message = "Jellyfin library access could not be verified. Please try again.",
                        requests = Array.Empty<object>(),
                        totalPages = 0,
                        totalResults = 0,
                    });
                }

                results = libraryScopedResults;
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
                        var jellyfinMediaId = ReadJsonString(
                            media?[is4kRequest ? "jellyfinMediaId4k" : "jellyfinMediaId"]);
                        if (string.IsNullOrWhiteSpace(jellyfinMediaId))
                        {
                            jellyfinMediaId = null;
                        }

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
                            // Only the already-authorized request edition is projected.
                            // The sibling edition must never become a navigation fallback.
                            jellyfinMediaId = jellyfinMediaId,
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
        /// Returns one complete, allowlisted media-key snapshot for the calendar.
        /// Callers without request-view permission (or callers that set
        /// <paramref name="userOnly"/>) are scoped to their own rows before projection.
        /// Pagination and parental filtering are intentionally server-owned: filtering
        /// individual upstream pages would make the compact key set incomplete.
        /// Raw Seerr request rows are never returned from this endpoint.
        /// </summary>
        [HttpGet("arr/request-snapshot")]
        [Authorize]
        public async Task<IActionResult> GetCompleteUserRequestSnapshot([FromQuery] bool userOnly = false)
        {
            var liveConfiguration = _configProvider.ConfigurationOrNull;
            var configurationRevision = _configProvider.ConfigurationRevision;
            if (liveConfiguration == null)
            {
                return StatusCode(500, new
                {
                    error = true,
                    code = "configuration_unavailable",
                    message = "Plugin configuration is not available.",
                    requests = Array.Empty<object>(),
                });
            }

            PluginConfiguration config;
            SeerrMutationConfigStamp configStamp;
            try
            {
                (config, configStamp) = SeerrMutationConfigStamp.CaptureOwnedSnapshot(
                    liveConfiguration,
                    configurationRevision);
            }
            catch
            {
                return ReadConfigurationChanged("the request snapshot");
            }

            var seerrEnabled = SeerrIntegrationPolicy.HasUsableSavedConfiguration(config);
            var fallbackEnabled = config.CalendarRequesterTagFallbackEnabled;
            if (!IsReadConfigurationCurrent(configStamp))
                return ReadConfigurationChanged("the request snapshot");

            if (!seerrEnabled && !fallbackEnabled)
            {
                return CompleteRequestSnapshot(Array.Empty<Services.Arr.CalendarRequesterMediaKey>());
            }

            var jellyfinUserGuid = UserHelper.GetCurrentUserId(User);
            if (!jellyfinUserGuid.HasValue)
            {
                return BadRequest(new
                {
                    error = true,
                    code = "missing_user",
                    message = "Jellyfin user identity was not available.",
                    requests = Array.Empty<object>(),
                });
            }

            var currentUser = _userManager.GetUserById(jellyfinUserGuid.Value);
            if (currentUser == null)
            {
                return StatusCode(403, new
                {
                    error = true,
                    code = "jellyfin_user_unavailable",
                    message = "The authenticated Jellyfin user is not available.",
                    requests = Array.Empty<object>(),
                });
            }

            var initialJellyfinIdentity = JellyfinReadIdentitySnapshot.Capture(currentUser);
            var projectedKeys = new Dictionary<string, Services.Arr.CalendarRequesterMediaKey>(
                StringComparer.Ordinal);
            var authoritativeOwnerKeys = new HashSet<string>(StringComparer.Ordinal);
            SeerrUserResolution? initialResolution = null;
            SeerrUser? initialSeerrUser = null;

            if (seerrEnabled)
            {
                var integration = SeerrIntegrationPolicy.Capture(_configProvider);
                var activeConfiguration = integration.Configuration;
                if (!integration.IsActive || activeConfiguration == null)
                {
                    return ReadConfigurationChanged("the request snapshot");
                }

                config = activeConfiguration;
                configStamp = integration.ConfigurationStamp;
                fallbackEnabled = config.CalendarRequesterTagFallbackEnabled;
                var configuredUrls = integration.Urls;
                var seerrApiKey = integration.ApiKey;
                if (!IsReadConfigurationCurrent(configStamp))
                    return ReadConfigurationChanged("the request snapshot");

                initialResolution = await _seerr.ResolveSeerrUser(
                    jellyfinUserGuid.Value.ToString(),
                    bypassCache: true,
                    allowAutoImport: false,
                    cancellationToken: HttpContext.RequestAborted).ConfigureAwait(false);
                if (!IsReadConfigurationCurrent(configStamp))
                    return ReadConfigurationChanged("the request snapshot");

                initialSeerrUser = initialResolution.User;
                if (initialSeerrUser == null
                    && initialResolution.Status is SeerrUserResolutionStatus.Incomplete
                        or SeerrUserResolutionStatus.Unavailable)
                {
                    return IncompleteUserLookup();
                }

                if (initialSeerrUser == null && !fallbackEnabled)
                {
                    return NotFound(new
                    {
                        error = true,
                        code = "user_unlinked",
                        message = "Current Jellyfin user is not linked to a Seerr user.",
                        requests = Array.Empty<object>(),
                    });
                }

                if (initialSeerrUser == null
                    && initialResolution.Status is not (SeerrUserResolutionStatus.NotFound
                        or SeerrUserResolutionStatus.Blocked))
                {
                    return IncompleteUserLookup();
                }

                if (initialSeerrUser == null && configuredUrls.Length > MaxRequestSnapshotSeerrSources)
                {
                    return StatusCode(502, new
                    {
                        error = true,
                        code = "source_bound_exceeded",
                        message = "Too many Seerr identity domains were configured to prove requester ownership safely.",
                        requests = Array.Empty<object>(),
                    });
                }

                var jellyfinAdmin = IsAdminUser();
                var canViewAllRequests = initialSeerrUser != null
                    && (jellyfinAdmin || SeerrPermissionHelper.HasAnyPermission(
                        initialSeerrUser.Permissions,
                        SeerrPermission.ADMIN | SeerrPermission.MANAGE_REQUESTS | SeerrPermission.REQUEST_VIEW));
                var selfScoped = userOnly || !canViewAllRequests;
                var client = SeerrHttpHelper.CreateClient(_httpClientFactory);
                client.Timeout = TimeSpan.FromSeconds(15);
                var dispatchFence = integration
                    .CreateDispatchFence(_configProvider)
                    .Restrict(() => IsReadConfigurationCurrent(configStamp));
                var snapshots = new List<SeerrPagedCollectionResult>();

                if (initialSeerrUser != null)
                {
                    var normalizedResolvedSource = SeerrUrlIdentity.Normalize(initialSeerrUser.SourceUrl);
                    var configuredSource = configuredUrls.FirstOrDefault(url => string.Equals(
                        url,
                        normalizedResolvedSource,
                        StringComparison.Ordinal));
                    if (configuredSource == null)
                    {
                        return SourceAffinityUnavailable();
                    }

                    var snapshot = await FetchUserRequestSnapshotAsync(
                        client,
                        new[] { configuredSource },
                        seerrApiKey,
                        initialSeerrUser.Id.ToString(CultureInfo.InvariantCulture),
                        dispatchFence,
                        HttpContext.RequestAborted,
                        // Fallback precedence requires the complete all-owner ledger.
                        // With fallback off, retain the existing optimized self scope.
                        selfScoped: fallbackEnabled ? false : selfScoped,
                        includeApiUserHeader: fallbackEnabled
                            ? false
                            : selfScoped || !jellyfinAdmin).ConfigureAwait(false);
                    snapshots.Add(snapshot);
                }
                else
                {
                    // A conclusively unlinked/blocked user has no source affinity. To prove
                    // that a tag does not override any authoritative owner, every configured
                    // Seerr identity domain must complete independently.
                    foreach (var configuredSource in configuredUrls)
                    {
                        HttpContext.RequestAborted.ThrowIfCancellationRequested();
                        var snapshot = await FetchUserRequestSnapshotAsync(
                            client,
                            new[] { configuredSource },
                            seerrApiKey,
                            string.Empty,
                            dispatchFence,
                            HttpContext.RequestAborted,
                            selfScoped: false,
                            includeApiUserHeader: false).ConfigureAwait(false);
                        snapshots.Add(snapshot);
                    }
                }

                if (!IsReadConfigurationCurrent(configStamp))
                    return ReadConfigurationChanged("the request snapshot");

                var selectedRows = new JsonArray();
                foreach (var snapshot in snapshots)
                {
                    if (!snapshot.IsComplete)
                    {
                        _logger.LogWarning(
                            "Calendar request ownership collection was incomplete: {Reason}",
                            snapshot.FailureReason);
                        return UpstreamCollectionIncomplete();
                    }

                    var seenRequestIds = new HashSet<int>();
                    foreach (var row in snapshot.Items)
                    {
                        if (!TryParseRequestSnapshotRow(row, out var parsedRow)
                            || !seenRequestIds.Add(parsedRow.RequestId))
                        {
                            return InvalidRequestKeyCollection();
                        }

                        var canonicalKey = CanonicalRequestKey(parsedRow.TmdbId, parsedRow.Type);
                        authoritativeOwnerKeys.Add(canonicalKey);
                        var selected = initialSeerrUser != null
                            && (!selfScoped || parsedRow.OwnerId == initialSeerrUser.Id);
                        if (selected)
                        {
                            selectedRows.Add(JsonNode.Parse(row.GetRawText()));
                        }
                    }
                }

                if (selectedRows.Count > 0)
                {
                    var completeJson = JsonSerializer.Serialize(new
                    {
                        results = selectedRows,
                        pageInfo = new
                        {
                            page = 1,
                            pages = 1,
                            pageSize = selectedRows.Count,
                            results = selectedRows.Count,
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
                        return ParentalFilterIncomplete();
                    }

                    JsonArray? results;
                    try
                    {
                        results = (JsonNode.Parse(parental.Body) as JsonObject)?["results"] as JsonArray;
                    }
                    catch (JsonException)
                    {
                        return InvalidRequestKeyCollection();
                    }

                    if (results == null)
                    {
                        return InvalidRequestKeyCollection();
                    }

                    var seenFilteredRequestIds = new HashSet<int>();
                    foreach (var row in results)
                    {
                        if (!TryParseRequestSnapshotRow(row as JsonObject, out var parsedRow)
                            || !seenFilteredRequestIds.Add(parsedRow.RequestId)
                            || (selfScoped && parsedRow.OwnerId != initialSeerrUser!.Id))
                        {
                            return InvalidRequestKeyCollection();
                        }

                        AddProjectedKey(projectedKeys, parsedRow.TmdbId, parsedRow.Type);
                    }
                }
            }

            if (fallbackEnabled)
            {
                if (_calendarRequesterTags == null)
                {
                    return StatusCode(500, new
                    {
                        error = true,
                        code = "requester_tag_resolver_unavailable",
                        message = "Calendar requester-tag attribution is not available.",
                        requests = Array.Empty<object>(),
                    });
                }

                var tagResolution = _calendarRequesterTags.Resolve(
                    config,
                    currentUser,
                    HttpContext.RequestAborted);
                if (!tagResolution.IsComplete)
                {
                    _logger.LogWarning(
                        "Calendar requester-tag resolution was incomplete: {Reason}",
                        tagResolution.FailureReason);
                    return StatusCode(502, new
                    {
                        error = true,
                        code = "requester_tag_collection_incomplete",
                        message = "Requester tags could not be resolved completely. Check the Calendar requester-tag configuration and retry.",
                        requests = Array.Empty<object>(),
                    });
                }

                foreach (var key in tagResolution.Keys)
                {
                    var canonicalKey = CanonicalRequestKey(key.TmdbId, key.Type);
                    if (!authoritativeOwnerKeys.Contains(canonicalKey))
                    {
                        projectedKeys.TryAdd(canonicalKey, key);
                    }
                }
            }

            if (projectedKeys.Count > RequestKeyMaxItems)
            {
                return StatusCode(502, new
                {
                    error = true,
                    code = "request_key_bound_exceeded",
                    message = "The complete request-key collection exceeded its safe bound.",
                    requests = Array.Empty<object>(),
                });
            }

            if (!IsReadConfigurationCurrent(configStamp))
                return ReadConfigurationChanged("the request snapshot");

            if (seerrEnabled && initialResolution != null)
            {
                var freshResolution = await _seerr.ResolveSeerrUser(
                    jellyfinUserGuid.Value.ToString(),
                    bypassCache: true,
                    allowAutoImport: false,
                    cancellationToken: HttpContext.RequestAborted).ConfigureAwait(false);
                if (!IsReadConfigurationCurrent(configStamp))
                    return ReadConfigurationChanged("the request snapshot");

                if (!SameSeerrIdentity(initialResolution, freshResolution))
                {
                    return StatusCode(409, new
                    {
                        error = true,
                        code = "read_identity_changed",
                        message = "The linked Seerr identity changed while preparing the request snapshot. Retry the request.",
                        requests = Array.Empty<object>(),
                    });
                }
            }

            var freshUser = _userManager.GetUserById(jellyfinUserGuid.Value);
            if (freshUser == null
                || !initialJellyfinIdentity.Matches(freshUser))
            {
                return StatusCode(409, new
                {
                    error = true,
                    code = "read_identity_changed",
                    message = "The Jellyfin user identity or access policy changed while preparing the request snapshot. Retry the request.",
                    requests = Array.Empty<object>(),
                });
            }

            if (!IsReadConfigurationCurrent(configStamp))
                return ReadConfigurationChanged("the request snapshot");

            return CompleteRequestSnapshot(projectedKeys.Values);

            ObjectResult IncompleteUserLookup()
                => StatusCode(502, new
                {
                    error = true,
                    code = "user_lookup_incomplete",
                    message = "Seerr user lookup was incomplete. No partial request snapshot was published.",
                    requests = Array.Empty<object>(),
                });

            ObjectResult SourceAffinityUnavailable()
                => StatusCode(502, new
                {
                    error = true,
                    code = "source_affinity_unavailable",
                    message = "The linked Seerr instance could not be verified. No request snapshot was published.",
                    requests = Array.Empty<object>(),
                });

            ObjectResult UpstreamCollectionIncomplete()
                => StatusCode(502, new
                {
                    error = true,
                    code = "upstream_collection_incomplete",
                    message = "Seerr returned an incomplete request collection. Please try again.",
                    requests = Array.Empty<object>(),
                });

            ObjectResult InvalidRequestKeyCollection()
                => StatusCode(502, new
                {
                    error = true,
                    code = "upstream_collection_invalid",
                    message = "Seerr returned an invalid request collection. Please try again.",
                    requests = Array.Empty<object>(),
                });
        }

        private OkObjectResult CompleteRequestSnapshot(
            IEnumerable<Services.Arr.CalendarRequesterMediaKey> mediaKeys)
        {
            var requests = mediaKeys
                .Distinct()
                .OrderBy(key => key.Type, StringComparer.Ordinal)
                .ThenBy(key => key.TmdbId)
                .Select(key => new { tmdbId = key.TmdbId, type = key.Type })
                .ToList();
            return Ok(new
            {
                // This is an output allowlist, not a redaction pass. Raw tags,
                // mappings, owner identities, URLs, and upstream rows have no path
                // into the Calendar response.
                requests,
                requestKeyCount = requests.Count,
                complete = true,
            });
        }

        private static string CanonicalRequestKey(int tmdbId, string type)
            => $"{type}:{tmdbId.ToString(CultureInfo.InvariantCulture)}";

        private static void AddProjectedKey(
            IDictionary<string, Services.Arr.CalendarRequesterMediaKey> destination,
            int tmdbId,
            string type)
        {
            var canonicalKey = CanonicalRequestKey(tmdbId, type);
            destination.TryAdd(
                canonicalKey,
                new Services.Arr.CalendarRequesterMediaKey(tmdbId, type));
        }

        private static bool TryParseRequestSnapshotRow(
            JsonElement row,
            out ParsedRequestSnapshotRow parsed)
        {
            parsed = default;
            if (row.ValueKind != JsonValueKind.Object
                || !TryReadPositiveJsonInt(row, "id", out var requestId)
                || !row.TryGetProperty("requestedBy", out var requestedBy)
                || requestedBy.ValueKind != JsonValueKind.Object
                || !TryReadPositiveJsonInt(requestedBy, "id", out var ownerId)
                || !row.TryGetProperty("media", out var media)
                || media.ValueKind != JsonValueKind.Object
                || !TryReadPositiveJsonInt(media, "tmdbId", out var tmdbId))
            {
                return false;
            }

            var requestType = TryReadJsonString(row, "type")?.Trim().ToLowerInvariant();
            var nestedType = TryReadJsonString(media, "mediaType")?.Trim().ToLowerInvariant();
            var type = requestType ?? nestedType;
            if (type is not ("movie" or "tv")
                || (nestedType != null
                    && (nestedType is not ("movie" or "tv")
                        || !string.Equals(type, nestedType, StringComparison.Ordinal))))
            {
                return false;
            }

            parsed = new ParsedRequestSnapshotRow(requestId, ownerId, tmdbId, type);
            return true;
        }

        private static bool TryParseRequestSnapshotRow(
            JsonObject? row,
            out ParsedRequestSnapshotRow parsed)
        {
            parsed = default;
            if (row == null)
            {
                return false;
            }

            var requestId = ReadPositiveJsonInt(row["id"]);
            var requestedBy = row["requestedBy"] as JsonObject;
            var ownerId = ReadPositiveJsonInt(requestedBy?["id"]);
            var media = row["media"] as JsonObject;
            var tmdbId = ReadPositiveJsonInt(media?["tmdbId"]);
            var requestType = ReadJsonString(row["type"])?.Trim().ToLowerInvariant();
            var nestedType = ReadJsonString(media?["mediaType"])?.Trim().ToLowerInvariant();
            var type = requestType ?? nestedType;
            if (requestId is not > 0
                || ownerId is not > 0
                || tmdbId is not > 0
                || type is not ("movie" or "tv")
                || (nestedType != null
                    && (nestedType is not ("movie" or "tv")
                        || !string.Equals(type, nestedType, StringComparison.Ordinal))))
            {
                return false;
            }

            parsed = new ParsedRequestSnapshotRow(
                requestId.Value,
                ownerId.Value,
                tmdbId.Value,
                type);
            return true;
        }

        private static string? TryReadJsonString(JsonElement owner, string propertyName)
            => owner.TryGetProperty(propertyName, out var value)
                && value.ValueKind == JsonValueKind.String
                ? value.GetString()
                : null;

        private static bool SameSeerrIdentity(
            SeerrUserResolution initial,
            SeerrUserResolution current)
        {
            if (initial.Status != current.Status)
            {
                return false;
            }

            if (initial.User == null || current.User == null)
            {
                return initial.User == null
                    && current.User == null
                    && initial.Status is SeerrUserResolutionStatus.NotFound
                        or SeerrUserResolutionStatus.Blocked;
            }

            return initial.User.Id == current.User.Id
                && initial.User.Permissions == current.User.Permissions
                && string.Equals(
                    SeerrUrlIdentity.Normalize(initial.User.SourceUrl),
                    SeerrUrlIdentity.Normalize(current.User.SourceUrl),
                    StringComparison.Ordinal);
        }

        /// <summary>
        /// Immutable caller identity/access projection for one request snapshot. Jellyfin's
        /// whole User.RowVersion also changes for ordinary LastActivityDate heartbeats, so it
        /// is too broad for a retry fence. These are the stable identity and policy inputs used
        /// by authentication, ConfigureUserAccess, and InternalItemsQuery.SetUser.
        /// </summary>
        private sealed class JellyfinReadIdentitySnapshot
        {
            private readonly Guid _id;
            private readonly long _internalId;
            private readonly string _username;
            private readonly int? _maxParentalRatingScore;
            private readonly int? _maxParentalRatingSubScore;
            private readonly (PermissionKind Kind, bool Value)[] _permissions;
            private readonly (PreferenceKind Kind, string Value)[] _preferences;
            private readonly (DynamicDayOfWeek Day, double Start, double End)[] _accessSchedules;

            private JellyfinReadIdentitySnapshot(JUser user)
            {
                _id = user.Id;
                _internalId = user.InternalId;
                _username = user.Username;
                _maxParentalRatingScore = user.MaxParentalRatingScore;
                _maxParentalRatingSubScore = user.MaxParentalRatingSubScore;
                _permissions = user.Permissions
                    .Select(permission => (permission.Kind, permission.Value))
                    .OrderBy(permission => permission.Kind)
                    .ThenBy(permission => permission.Value)
                    .ToArray();
                _preferences = user.Preferences
                    .Select(preference => (preference.Kind, preference.Value))
                    .OrderBy(preference => preference.Kind)
                    .ThenBy(preference => preference.Value, StringComparer.Ordinal)
                    .ToArray();
                _accessSchedules = user.AccessSchedules
                    .Select(schedule => (schedule.DayOfWeek, schedule.StartHour, schedule.EndHour))
                    .OrderBy(schedule => schedule.DayOfWeek)
                    .ThenBy(schedule => schedule.StartHour)
                    .ThenBy(schedule => schedule.EndHour)
                    .ToArray();
            }

            public static JellyfinReadIdentitySnapshot Capture(JUser user)
                => new(user);

            public bool Matches(JUser user)
                => user.Id == _id
                    && user.InternalId == _internalId
                    && string.Equals(user.Username, _username, StringComparison.Ordinal)
                    && user.MaxParentalRatingScore == _maxParentalRatingScore
                    && user.MaxParentalRatingSubScore == _maxParentalRatingSubScore
                    && _permissions.SequenceEqual(user.Permissions
                        .Select(permission => (permission.Kind, permission.Value))
                        .OrderBy(permission => permission.Kind)
                        .ThenBy(permission => permission.Value))
                    && _preferences.SequenceEqual(user.Preferences
                        .Select(preference => (preference.Kind, preference.Value))
                        .OrderBy(preference => preference.Kind)
                        .ThenBy(preference => preference.Value, StringComparer.Ordinal))
                    && _accessSchedules.SequenceEqual(user.AccessSchedules
                        .Select(schedule => (schedule.DayOfWeek, schedule.StartHour, schedule.EndHour))
                        .OrderBy(schedule => schedule.DayOfWeek)
                        .ThenBy(schedule => schedule.StartHour)
                        .ThenBy(schedule => schedule.EndHour));
        }

        private readonly record struct ParsedRequestSnapshotRow(
            int RequestId,
            int OwnerId,
            int TmdbId,
            string Type);

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
        internal const int MaxRequestSnapshotSeerrSources = 8;

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
            SeerrDispatchFence dispatchFence,
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
                dispatchFence,
                cancellationToken,
                maximumPages: maxPages,
                maximumItems: maxItems);

        internal static Task<SeerrPagedCollectionResult> FetchUserRequestSnapshotAsync(
            HttpClient httpClient,
            IEnumerable<string> seerrUrls,
            string apiKey,
            string seerrUserId,
            SeerrDispatchFence dispatchFence,
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
                dispatchFence,
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
            SeerrDispatchFence dispatchFence,
            CancellationToken cancellationToken,
            int pageSize = ComingSoonPageSize,
            int maxItems = ComingSoonMaxItems,
            int maxPages = ComingSoonMaxPagesPerFilter)
            => FetchComingSoonCollectionAsync(
                httpClient,
                new[] { seerrUrl },
                apiKey,
                scopeParam,
                dispatchFence,
                cancellationToken,
                pageSize,
                maxItems,
                maxPages);

        internal static Task<SeerrPagedCollectionResult> FetchComingSoonCollectionAsync(
            HttpClient httpClient,
            IEnumerable<string> seerrUrls,
            string apiKey,
            string scopeParam,
            SeerrDispatchFence dispatchFence,
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
                dispatchFence,
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

        /// <summary>
        /// Applies Jellyfin library visibility to one already-complete, caller/parental-scoped
        /// Seerr request collection. Normal and 4K requests are independent visibility domains:
        /// only the selected edition's media id authorizes that request, and a missing/blank
        /// selected id means that edition is not yet linked and remains eligible under Seerr
        /// scope. Both recognized id fields are still schema-validated before any lookup. A
        /// present selected id must be positively returned by one complete caller-scoped batch
        /// lookup. Any malformed id, invalid edition flag, missing caller, or lookup failure
        /// rejects the whole snapshot rather than publishing a convincing filtered prefix.
        /// </summary>
        internal static bool TryApplyRequestLibraryScope(
            JsonArray source,
            Jellyfin.Database.Implementations.Entities.User? user,
            IItemLookupService itemLookup,
            out JsonArray filtered)
        {
            filtered = new JsonArray();
            if (user == null)
            {
                return false;
            }

            var rows = new List<(
                JsonObject Row,
                Guid? EffectiveJellyfinId,
                bool Is4k)>(source.Count);
            var itemIds = new HashSet<Guid>();

            foreach (var node in source)
            {
                if (node is not JsonObject row || row["media"] is not JsonObject media)
                {
                    return false;
                }

                if (!TryReadOptionalJellyfinId(media, "jellyfinMediaId", out var standardId)
                    || !TryReadOptionalJellyfinId(media, "jellyfinMediaId4k", out var fourKId)
                    || !TryReadRequestEdition(row, out var is4k))
                {
                    return false;
                }

                var effectiveId = is4k ? fourKId : standardId;
                if (effectiveId.HasValue)
                {
                    itemIds.Add(effectiveId.Value);
                }

                rows.Add((row, effectiveId, is4k));
            }

            IReadOnlySet<Guid> accessibleIds;
            try
            {
                if (itemIds.Count == 0)
                {
                    accessibleIds = new HashSet<Guid>();
                }
                else
                {
                    accessibleIds = itemLookup.GetAccessibleItemIdsBatch(
                        itemIds.ToList(),
                        user);
                    if (accessibleIds == null)
                    {
                        return false;
                    }
                }
            }
            catch
            {
                return false;
            }

            foreach (var (row, effectiveJellyfinId, is4k) in rows)
            {
                if (!effectiveJellyfinId.HasValue
                    || accessibleIds.Contains(effectiveJellyfinId.Value))
                {
                    var clone = (JsonObject)row.DeepClone();
                    if (clone["media"] is not JsonObject cloneMedia)
                    {
                        return false;
                    }

                    // Bind projection to the exact normalized id that passed the
                    // selected-edition access check. The inactive sibling never
                    // becomes a fallback.
                    cloneMedia[is4k ? "jellyfinMediaId4k" : "jellyfinMediaId"] =
                        effectiveJellyfinId?.ToString();
                    filtered.Add(clone);
                }
            }

            return true;
        }

        private static bool TryReadOptionalJellyfinId(
            JsonObject media,
            string propertyName,
            out Guid? jellyfinId)
        {
            jellyfinId = null;
            if (!media.TryGetPropertyValue(propertyName, out var idNode)
                || idNode == null)
            {
                return true;
            }

            if (idNode is not JsonValue idValue
                || !idValue.TryGetValue<string>(out var idText))
            {
                return false;
            }

            if (string.IsNullOrWhiteSpace(idText))
            {
                return true;
            }

            if (!Guid.TryParse(idText, out var parsed) || parsed == Guid.Empty)
            {
                return false;
            }

            jellyfinId = parsed;
            return true;
        }

        private static bool TryReadRequestEdition(JsonObject row, out bool is4k)
        {
            is4k = false;
            return row.TryGetPropertyValue("is4k", out var is4kNode)
                && is4kNode is JsonValue value
                && value.TryGetValue<bool>(out is4k);
        }

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

            var pageConfig = _configProvider.ConfigurationOrNull;
            if (pageConfig == null)
                return StatusCode(500, "Plugin configuration not available");
            if (!pageConfig.DownloadsPageEnabled)
                return NotFound();

            var integration = SeerrIntegrationPolicy.Capture(_configProvider);
            if (!integration.IsActive)
            {
                return StatusCode(503, new
                {
                    error = true,
                    code = integration.State == SeerrIntegrationState.Disabled
                        ? "seerr_disabled"
                        : "seerr_unavailable",
                    message = integration.State == SeerrIntegrationState.Disabled
                        ? "Seerr integration is disabled."
                        : "Seerr is not configured.",
                    canApproveRequests = false,
                });
            }

            var config = integration.Configuration!;
            if (!config.DownloadsPageEnabled)
                return NotFound();

            // The admin feature toggle gates the action server-side too — the
            // client hides the buttons when it's off, but the server still
            // enforces so a crafted request can't bypass a disabled feature.
            if (!config.RequestApprovalsEnabled)
                return StatusCode(403, new { error = true, message = "In-app request approvals are disabled." });

            var mutationConfigStamp = SeerrMutationConfigStamp.Capture(
                config,
                integration.ConfigurationRevision);

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

            var configuredUrls = integration.Urls;
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
                || !SeerrIntegrationPolicy.HasUsableSavedConfiguration(currentConfig)
                || !currentConfig.DownloadsPageEnabled
                || !currentConfig.RequestApprovalsEnabled)
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
            SeerrDispatchFence dispatchFence = integration
                .CreateDispatchFence(_configProvider)
                .Restrict(() => mutationConfigStamp.Matches(
                    _configProvider.ConfigurationOrNull,
                    _configProvider.ConfigurationRevision)
                    && _configProvider.ConfigurationOrNull?.RequestApprovalsEnabled == true);
            var client = Helpers.Seerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
            using var httpRequest = Helpers.Seerr.SeerrHttpHelper.BuildRequest(
                HttpMethod.Post, requestUri, config.SeerrApiKey, seerrUser.Id.ToString());
            var (content, error, _) = await Helpers.Seerr.SeerrHttpHelper.SendAndReadJsonAsync(
                client,
                httpRequest,
                requestUri,
                dispatchFence,
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
            var integration = SeerrIntegrationPolicy.Capture(_configProvider);
            SeerrDispatchFence dispatchFence = integration
                .CreateDispatchFence(_configProvider)
                .Restrict(() => IsReadConfigurationCurrent(configStamp));
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
                        dispatchFence,
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
                        Helpers.BoundedTtlCache<string, (TmdbEnrichmentResult Data, DateTime CachedAt, long ConfigurationRevision)>.CacheToken publication;
                        lock (_seerrCache.TmdbEnrichmentCacheLock)
                        {
                            _seerrCache.TmdbEnrichmentCache.TrySet(cacheKey, (
                                fetchedResult,
                                DateTime.UtcNow,
                                configurationRevision), cacheTtl, out publication);
                        }

                        // A save can race the final publication check. Entries
                        // are generation-tagged and therefore unreadable, but
                        // eagerly remove this exact stale publication as well.
                        if (!IsReadConfigurationCurrent(configStamp))
                        {
                            lock (_seerrCache.TmdbEnrichmentCacheLock)
                            {
                                _seerrCache.TmdbEnrichmentCache.Remove(publication);
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
