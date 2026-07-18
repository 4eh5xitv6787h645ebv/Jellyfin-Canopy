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
using MediaBrowser.Common.Api;

namespace Jellyfin.Plugin.JellyfinCanopy.Controllers
{
    /// <summary>
    /// Seerr/TMDB proxy endpoints (status, validate, search, discover, movie/tv details, requests, quota, issues, raw TMDB proxy).
    /// Split out of the former JellyfinCanopyController; method bodies, routes
    /// and attributes are unchanged.
    /// </summary>
    [Route("JellyfinCanopy")]
    [ApiController]
    public class SeerrProxyController : JellyfinCanopyControllerBase
    {
        private const int MaximumTitleIssueRows = 1_000;

        private readonly ISeerrClient _seerr;
        private readonly ISeerrParentalFilter _parentalFilter;
        private readonly SpoilerPendingService _spoilerPending;

        internal Action? BeforeIssueProjectionPublishForTest { get; set; }

        public SeerrProxyController(
            IHttpClientFactory httpClientFactory,
            ILogger<SeerrProxyController> logger,
            IUserManager userManager,
            ISeerrCache seerrCache,
            IPluginConfigProvider configProvider,
            ISeerrClient seerr,
            ISeerrParentalFilter parentalFilter,
            SpoilerPendingService spoilerPending)
            : base(httpClientFactory, logger, userManager, seerrCache, configProvider)
        {
            _seerr = seerr;
            _parentalFilter = parentalFilter;
            _spoilerPending = spoilerPending;
        }

        // Thin delegation kept so the ~35 proxy endpoints below read unchanged;
        // the implementation lives on the injected ISeerrClient.
        private Task<IActionResult> ProxySeerrRequest(string apiPath, HttpMethod method, string? content = null)
            => _seerr.ProxyRequestAsync(
                apiPath,
                method,
                content,
                SeerrCaller(),
                HttpContext.RequestAborted);

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

        [HttpGet("seerr/status")]
        [Authorize]
        public async Task<IActionResult> GetSeerrStatus()
            => Ok(new { active = await _seerr.GetStatusActiveAsync() });

        [HttpGet("seerr/validate")]
        [Authorize(Policy = Policies.RequiresElevation)]
        public async Task<IActionResult> ValidateSeerr([FromQuery] string url, [FromHeader(Name = "X-Arr-ApiKey")] string apiKey)
        {
            if (string.IsNullOrWhiteSpace(url) || string.IsNullOrWhiteSpace(apiKey))
                return BadRequest(new { ok = false, message = "Missing url or apiKey" });

            if (!IsAllowedUrl(url))
                return BadRequest(new { ok = false, message = "Invalid URL" });

            var http = Helpers.Seerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
            http.Timeout = TimeSpan.FromSeconds(10);

            // Use the SeerrHttpHelper so the admin gets the same typed errors
            // (HtmlResponse / Cloudflare5xx / UpstreamRedirect / Unauthorized)
            // as runtime fetches — Round-3 found that the validate path
            // returned a generic "Status check failed" for HTML challenge
            // pages, which is the most-confusing first-setup error.
            var requestUri = $"{url.TrimEnd('/')}/api/v1/user";
            try
            {
                using var request = Helpers.Seerr.SeerrHttpHelper.BuildRequest(
                    HttpMethod.Get, requestUri, apiKey);
                var (_, error, _) = await Helpers.Seerr.SeerrHttpHelper.SendSetupAndReadJsonAsync(
                    http,
                    request,
                    requestUri);
                if (error == null) return Ok(new { ok = true });

                _logger.LogWarning($"Seerr validate failed for {url}: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay} — {error.Message}");
                int httpCode = error.Code switch
                {
                    Helpers.Seerr.SeerrErrorCode.HtmlResponse => 502,
                    Helpers.Seerr.SeerrErrorCode.UpstreamRedirect => 502,
                    Helpers.Seerr.SeerrErrorCode.Cloudflare5xx => 502,
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
                    message = $"Unable to reach Seerr at {url}: {ex.Message}"
                });
            }
        }

        [HttpGet("seerr/search")]
        [Authorize]
        public Task<IActionResult> SeerrSearch([FromQuery] string? query, [FromQuery] int page = 1, [FromQuery] string? language = null)
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
            return ProxySeerrRequest(path, HttpMethod.Get);
        }

        [HttpGet("seerr/sonarr")]
        [Authorize]
        public Task<IActionResult> GetSonarrInstances()
        {
            return ProxySeerrRequest("/api/v1/service/sonarr", HttpMethod.Get);
        }

        [HttpGet("seerr/radarr")]
        [Authorize]
        public Task<IActionResult> GetRadarrInstances()
        {
            return ProxySeerrRequest("/api/v1/service/radarr", HttpMethod.Get);
        }

        [HttpGet("seerr/{type}/{serverId}")]
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
            return ProxySeerrRequest($"/api/v1/service/{type}/{serverId}", HttpMethod.Get);
        }

        [HttpPost("seerr/request")]
        [Authorize]
        public async Task<IActionResult> SeerrRequest([FromBody] JsonElement requestBody)
        {
            var result = await ProxySeerrRequest("/api/v1/request", HttpMethod.Post, requestBody.ToString());

            // Auto-on-request Spoiler Guard pending — best-effort, never blocks the
            // request. Gated by SpoilerBlurEnabled + SpoilerAutoEnableOnSeerrRequest.
            // Only a 2xx counts as user intent; anything else fails closed.
            try
            {
                var cfg = _configProvider.ConfigurationOrNull;
                if (cfg?.SpoilerBlurEnabled == true
                    && cfg?.SpoilerAutoEnableOnSeerrRequest == true
                    && IsSeerrRequestResultSuccessful(result))
                {
                    // Snapshot identity + body BEFORE Task.Run — HttpContext/User are
                    // invalid after we return; clone the request-scoped JsonElement.
                    var userId = UserHelper.GetCurrentUserId(User);
                    if (userId != null && userId != Guid.Empty)
                    {
                        var capturedUserId = userId.Value;
                        JsonElement bodyClone;
                        try { bodyClone = requestBody.Clone(); }
                        catch { bodyClone = default; }

                        if (bodyClone.ValueKind == JsonValueKind.Object)
                        {
                            _ = Task.Run(() => _spoilerPending.TryAutoEnableFromSeerrRequest(capturedUserId, bodyClone));
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"Spoiler Guard auto-on-request hook threw {ex.GetType().Name}: {ex.Message}");
            }

            return result;
        }

        // True only for a 2xx proxy result. 409 fails closed: it's an ambiguous Seerr
        // conflict (MEDIA_EXISTS vs quota/permission denial) whose body SeerrHttpHelper
        // has already replaced, so we can't distinguish. Null StatusCode counts as OK
        // only for ContentResult (the success path defaults to 200); a null on
        // ObjectResult/StatusCodeResult is failure.
        private static bool IsSeerrRequestResultSuccessful(IActionResult result)
        {
            int? status;
            bool allowNullAsOk = false;
            if (result is ContentResult cr)
            {
                status = cr.StatusCode;
                allowNullAsOk = true;
            }
            else if (result is ObjectResult or)
            {
                status = or.StatusCode;
            }
            else if (result is StatusCodeResult sr)
            {
                status = sr.StatusCode;
            }
            else
            {
                return false;
            }

            if (status is null)
            {
                if (!allowNullAsOk) return false;
                status = 200;
            }
            int sc = status.Value;
            return sc >= 200 && sc < 300;
        }

        [HttpGet("seerr/request")]
        [Authorize]
        public Task<IActionResult> GetSeerrRequests([FromQuery] int take = 500, [FromQuery] int skip = 0, [FromQuery] string filter = "all")
        {
            return ProxySeerrRequest(BuildRequestsProxyPath(take, skip, filter), HttpMethod.Get);
        }

        // Escapes filter (take/skip are ints, already safe) so a crafted value can't smuggle extra
        // query params into the upstream path — matching the sibling GetSeerrIssues route.
        // Extracted so the escaping is unit-testable without a live proxy round-trip.
        internal static string BuildRequestsProxyPath(int take, int skip, string filter)
            => $"/api/v1/request?take={take}&skip={skip}&filter={Uri.EscapeDataString(filter)}";

        // Returns the user's Seerr quota with a nextResetAt added per side.
        [HttpGet("seerr/quota")]
        [Authorize]
        public async Task<IActionResult> GetSeerrQuota()
        {
            var integration = SeerrIntegrationPolicy.Capture(_configProvider);
            if (!integration.IsActive || integration.Configuration == null)
            {
                return StatusCode(503, new
                {
                    error = true,
                    code = "seerr_disabled",
                    message = "Seerr integration is not configured or enabled."
                });
            }

            var requestConfig = integration.Configuration;
            var requestConfigRevision = integration.ConfigurationRevision;
            var requestConfigStamp = SeerrMutationConfigStamp.Capture(
                requestConfig,
                requestConfigRevision);
            SeerrDispatchFence dispatchFence = integration
                .CreateDispatchFence(_configProvider)
                .Restrict(() => requestConfigStamp.Matches(
                    _configProvider.ConfigurationOrNull,
                    _configProvider.ConfigurationRevision));
            IActionResult ConfigurationChanged() => StatusCode(409, new
            {
                error = true,
                code = "quota_configuration_changed",
                message = "Seerr configuration changed during quota lookup. Retry the request."
            });

            if (!requestConfigStamp.Matches(
                    _configProvider.ConfigurationOrNull,
                    _configProvider.ConfigurationRevision))
            {
                return ConfigurationChanged();
            }

            var jellyfinUserId = UserHelper.GetCurrentUserId(User)?.ToString() ?? "";
            var resolution = await _seerr.ResolveSeerrUser(
                jellyfinUserId,
                bypassCache: true,
                allowAutoImport: false,
                cancellationToken: HttpContext.RequestAborted).ConfigureAwait(false);
            if (!requestConfigStamp.Matches(
                    _configProvider.ConfigurationOrNull,
                    _configProvider.ConfigurationRevision))
            {
                return ConfigurationChanged();
            }

            var seerrUser = resolution.User;
            if (seerrUser == null)
            {
                if (resolution.Status is SeerrUserResolutionStatus.Incomplete or SeerrUserResolutionStatus.Unavailable)
                {
                    return StatusCode(502, new
                    {
                        error = true,
                        code = "user_lookup_incomplete",
                        message = "Seerr user lookup was incomplete. Quota was not published."
                    });
                }

                return NotFound(new
                {
                    error = true,
                    code = "unlinked",
                    message = "Current Jellyfin user is not linked to a Seerr user."
                });
            }

            var seerrUserId = seerrUser.Id.ToString(System.Globalization.CultureInfo.InvariantCulture);
            if (seerrUser.Id <= 0 || string.IsNullOrWhiteSpace(seerrUser.SourceUrl))
            {
                _logger.LogWarning(
                    "Quota lookup refused because the resolved Seerr user did not carry a valid source instance.");
                return StatusCode(502, new
                {
                    error = true,
                    code = "source_affinity_unavailable",
                    message = "The linked Seerr instance could not be verified. Quota was not published."
                });
            }

            // The numeric Seerr user id is instance-local. Reuse the exact user
            // context resolved above so the quota request cannot resolve again
            // or fail over to a different configured instance.
            var quotaResult = await _seerr.ProxyRequestAsync(
                $"/api/v1/user/{seerrUserId}/quota",
                HttpMethod.Get,
                content: null,
                SeerrCaller(),
                seerrUser,
                HttpContext.RequestAborted).ConfigureAwait(false);

            if (!requestConfigStamp.Matches(
                    _configProvider.ConfigurationOrNull,
                    _configProvider.ConfigurationRevision))
            {
                return ConfigurationChanged();
            }

            if (quotaResult is ContentResult cr && cr.StatusCode is null or 200)
            {
                try
                {
                    var quota = JsonNode.Parse(cr.Content ?? "{}")!.AsObject();
                    var enrichment = await EnrichQuotaWithResetAsync(
                        quota,
                        seerrUserId,
                        seerrUser.SourceUrl,
                        requestConfig,
                        dispatchFence).ConfigureAwait(false);
                    if (!requestConfigStamp.Matches(
                            _configProvider.ConfigurationOrNull,
                            _configProvider.ConfigurationRevision))
                    {
                        return ConfigurationChanged();
                    }

                    if (enrichment == QuotaResetEnrichmentStatus.InvalidQuota)
                    {
                        return StatusCode(502, new
                        {
                            error = true,
                            code = "quota_projection_invalid",
                            message = "Seerr returned invalid quota data. Quota was not published."
                        });
                    }

                    // Request history is a derived reset-time projection. If it
                    // is incomplete or temporarily disagrees with the quota
                    // snapshot, preserve Seerr's authoritative usage/limit
                    // values but publish no guessed nextResetAt.
                    // Compact output like the old JObject.ToString(Formatting.None).
                    return Content(quota.ToJsonString(), "application/json");
                }
                catch (OperationCanceledException) when (HttpContext.RequestAborted.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    _logger.LogWarning($"Quota enrichment failed closed ({ex.GetType().Name}): {ex.Message}");
                    return StatusCode(502, new
                    {
                        error = true,
                        code = "quota_projection_invalid",
                        message = "Seerr returned invalid quota data. Quota was not published."
                    });
                }
            }

            return quotaResult;
        }

        private async Task<QuotaResetEnrichmentStatus> EnrichQuotaWithResetAsync(
            JsonObject quota,
            string seerrUserId,
            string? sourceUrl,
            PluginConfiguration config,
            SeerrDispatchFence dispatchFence)
        {
            // This endpoint owns the projection; never preserve an upstream or
            // cached value that was not computed from this exact snapshot.
            if (quota["movie"] is JsonObject movieSide) movieSide.Remove("nextResetAt");
            if (quota["tv"] is JsonObject tvSide) tvSide.Remove("nextResetAt");

            // Both quota sides must be projected from the same complete user
            // history snapshot. Apart from avoiding duplicate I/O, sharing the
            // read prevents a request arriving between two independent reads
            // from producing mutually inconsistent reset dates.
            var historySnapshot = new Lazy<Task<SeerrPagedCollectionResult>>(() =>
            {
                var httpClient = Helpers.Seerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
                httpClient.Timeout = TimeSpan.FromSeconds(8);
                return FetchQuotaRequestHistoryAsync(
                    httpClient,
                    sourceUrl ?? string.Empty,
                    config.SeerrApiKey,
                    seerrUserId,
                    dispatchFence,
                    HttpContext.RequestAborted);
            });
            var projectionNow = DateTime.UtcNow;

            var movieTask = ComputeNextResetAsync(
                quota,
                "movie",
                seerrUserId,
                historySnapshot,
                projectionNow);
            var tvTask = ComputeNextResetAsync(
                quota,
                "tv",
                seerrUserId,
                historySnapshot,
                projectionNow);
            await Task.WhenAll(movieTask, tvTask);

            if (movieTask.Result.Status == QuotaResetComputationStatus.InvalidQuota
                || tvTask.Result.Status == QuotaResetComputationStatus.InvalidQuota)
            {
                return QuotaResetEnrichmentStatus.InvalidQuota;
            }

            if (movieTask.Result.Status == QuotaResetComputationStatus.ProjectionUnavailable
                || tvTask.Result.Status == QuotaResetComputationStatus.ProjectionUnavailable)
            {
                quota["resetProjectionComplete"] = false;
                return QuotaResetEnrichmentStatus.ProjectionUnavailable;
            }

            // Seerr admins / no-policy users return {"movie":null,"tv":null}; cast safely.
            if (movieTask.Result.NextResetAt.HasValue && quota["movie"] is JsonObject mObj)
            {
                mObj["nextResetAt"] = movieTask.Result.NextResetAt.Value.ToString("o");
            }
            if (tvTask.Result.NextResetAt.HasValue && quota["tv"] is JsonObject tObj)
            {
                tObj["nextResetAt"] = tvTask.Result.NextResetAt.Value.ToString("o");
            }

            quota["resetProjectionComplete"] = true;
            return QuotaResetEnrichmentStatus.Complete;
        }

        private async Task<QuotaResetComputation> ComputeNextResetAsync(
            JsonObject quota,
            string mediaType,
            string seerrUserId,
            Lazy<Task<SeerrPagedCollectionResult>> historySnapshot,
            DateTime projectionNow)
        {
            if (!int.TryParse(
                    seerrUserId,
                    System.Globalization.NumberStyles.None,
                    System.Globalization.CultureInfo.InvariantCulture,
                    out var expectedSeerrUserId)
                || expectedSeerrUserId <= 0
                || mediaType is not ("movie" or "tv"))
            {
                return QuotaResetComputation.InvalidQuota();
            }

            if (!quota.TryGetPropertyValue(mediaType, out var sideNode))
            {
                return QuotaResetComputation.InvalidQuota();
            }

            // Older/admin Seerr shapes may explicitly use null for an
            // unrestricted side. Missing or any other non-object shape is not
            // equivalent to that explicit value.
            if (sideNode == null) return QuotaResetComputation.Complete();
            if (sideNode is not JsonObject side
                || !TryReadRequiredNonNegativeInt(side, "used", out var used)
                || !TryReadRequiredBoolean(side, "restricted", out var restricted)
                || !TryReadOptionalNonNegativeInt(side, "limit", out var limit)
                || !TryReadOptionalNonNegativeInt(side, "days", out var days)
                || !TryReadOptionalNonNegativeInt(side, "remaining", out var remaining))
            {
                return QuotaResetComputation.InvalidQuota();
            }

            var effectiveLimit = limit ?? 0;
            var expectedRestricted = effectiveLimit > 0 && used >= effectiveLimit;
            if (restricted != expectedRestricted
                || (effectiveLimit <= 0 && (used != 0 || remaining.HasValue))
                || (effectiveLimit > 0
                    && remaining.HasValue
                    && remaining.Value != Math.Max(0, effectiveLimit - used)))
            {
                // The individual quota fields are well-formed, but this
                // snapshot is not internally coherent enough to derive a
                // reset time. Preserve Seerr's authoritative raw quota rather
                // than turning a transient cross-field disagreement into a
                // failure of the quota endpoint.
                return QuotaResetComputation.ProjectionUnavailable();
            }

            // nextResetAt is an eligibility promise (the UI says another
            // request can be made then), not merely the next accounting event.
            // An unrestricted caller can already request now, so publish no
            // future eligibility timestamp. Unlimited, empty, and all-time
            // quotas likewise have no rolling reset to expose.
            if (!restricted
                || effectiveLimit <= 0
                || used == 0
                || !days.HasValue
                || days.Value == 0)
            {
                return QuotaResetComputation.Complete();
            }

            var snapshot = await historySnapshot.Value.ConfigureAwait(false);
            if (!snapshot.IsComplete)
            {
                _logger.LogWarning(
                    "Quota reset enrichment skipped because the {MediaType} request collection from {Url} was incomplete: {Reason}",
                    mediaType,
                    snapshot.SourceUrl,
                    snapshot.FailureReason);
                return QuotaResetComputation.ProjectionUnavailable();
            }

            // Mirror Seerr User.getQuota exactly: count every non-declined
            // parent request newer than the rolling boundary. Movies contribute
            // one unit; TV contributes one unit per requested season. Media
            // status (including BLOCKLISTED) and ignoreQuota are not part of
            // Seerr's quota predicate.
            var windowStart = projectionNow.AddDays(-days.Value);
            var activeContributions = new List<(DateTime CreatedAt, int Units)>();
            var derivedUsage = 0;
            foreach (var req in snapshot.Items)
            {
                if (!QuotaHistoryRowMatchesUser(req, expectedSeerrUserId)
                    || !req.TryGetProperty("type", out var typeEl)
                    || typeEl.ValueKind != JsonValueKind.String)
                {
                    _logger.LogWarning(
                        "Quota reset request history from {Url} contained a row outside the requested user scope or with an invalid type; refusing a partial projection.",
                        snapshot.SourceUrl);
                    return QuotaResetComputation.ProjectionUnavailable();
                }

                var requestType = typeEl.GetString();
                if (requestType is not ("movie" or "tv"))
                {
                    _logger.LogWarning(
                        "Quota reset request history from {Url} contained an invalid request type; refusing a partial projection.",
                        snapshot.SourceUrl);
                    return QuotaResetComputation.ProjectionUnavailable();
                }

                if (!req.TryGetProperty("status", out var statusEl)
                    || statusEl.ValueKind != JsonValueKind.Number
                    || !statusEl.TryGetInt32(out var status)
                    || status is < 1 or > 5)
                {
                    _logger.LogWarning(
                        "Quota reset request history from {Url} contained an invalid status row; refusing a partial projection.",
                        snapshot.SourceUrl);
                    return QuotaResetComputation.ProjectionUnavailable();
                }

                if (!req.TryGetProperty("createdAt", out var createdEl)
                    || createdEl.ValueKind != JsonValueKind.String
                    || !DateTimeOffset.TryParse(
                        createdEl.GetString(),
                        System.Globalization.CultureInfo.InvariantCulture,
                        System.Globalization.DateTimeStyles.RoundtripKind,
                        out var createdAt))
                {
                    _logger.LogWarning(
                        "Quota reset request history from {Url} contained an invalid createdAt row; refusing a partial projection.",
                        snapshot.SourceUrl);
                    return QuotaResetComputation.ProjectionUnavailable();
                }

                var units = 1;
                if (requestType == "tv")
                {
                    if (!req.TryGetProperty("seasons", out var seasons)
                        || seasons.ValueKind != JsonValueKind.Array)
                    {
                        _logger.LogWarning(
                            "Quota reset request history from {Url} contained a TV row without a seasons array; refusing a partial projection.",
                            snapshot.SourceUrl);
                        return QuotaResetComputation.ProjectionUnavailable();
                    }

                    units = seasons.GetArrayLength();
                }

                if (!string.Equals(requestType, mediaType, StringComparison.Ordinal)
                    || status == 3)
                {
                    continue;
                }

                var createdAtUtc = createdAt.UtcDateTime;
                // Seerr uses MoreThan(windowStart), not an inclusive boundary.
                if (createdAtUtc <= windowStart) continue;
                if (derivedUsage > int.MaxValue - units)
                {
                    _logger.LogWarning(
                        "Quota reset request history from {Url} exceeded the supported usage range; refusing a partial projection.",
                        snapshot.SourceUrl);
                    return QuotaResetComputation.ProjectionUnavailable();
                }

                derivedUsage += units;
                if (units > 0)
                {
                    activeContributions.Add((createdAtUtc, units));
                }
            }

            if (derivedUsage != used || (used > 0 && activeContributions.Count == 0))
            {
                _logger.LogWarning(
                    "Quota reported {Used} {MediaType} units, but the complete history from {Url} reconstructed {Derived}; refusing a cross-snapshot reset projection.",
                    used,
                    mediaType,
                    snapshot.SourceUrl,
                    derivedUsage);
                return QuotaResetComputation.ProjectionUnavailable();
            }

            // A lowered quota can leave Seerr reporting used > limit. Expiry of
            // the oldest request alone does not necessarily open a slot: walk
            // contributions in expiry order until the post-expiry usage is
            // strictly below the limit. TV requests contribute all of their
            // season units at their shared request timestamp.
            var expiredUnits = 0L;
            foreach (var contribution in activeContributions.OrderBy(entry => entry.CreatedAt))
            {
                expiredUnits += contribution.Units;
                if ((long)used - expiredUnits < effectiveLimit)
                {
                    return QuotaResetComputation.Complete(
                        contribution.CreatedAt.AddDays(days.Value));
                }
            }

            _logger.LogWarning(
                "Quota reset request history from {Url} could not identify an expiry that opens a {MediaType} quota slot.",
                snapshot.SourceUrl,
                mediaType);
            return QuotaResetComputation.ProjectionUnavailable();
        }

        private static bool TryReadRequiredNonNegativeInt(
            JsonObject owner,
            string propertyName,
            out int value)
        {
            value = 0;
            return owner.TryGetPropertyValue(propertyName, out var node)
                && node is JsonValue jsonValue
                && jsonValue.TryGetValue<int>(out value)
                && value >= 0;
        }

        private static bool TryReadOptionalNonNegativeInt(
            JsonObject owner,
            string propertyName,
            out int? value)
        {
            value = null;
            if (!owner.TryGetPropertyValue(propertyName, out var node))
            {
                return true;
            }

            if (node is not JsonValue jsonValue
                || !jsonValue.TryGetValue<int>(out var parsed)
                || parsed < 0)
            {
                return false;
            }

            value = parsed;
            return true;
        }

        private static bool TryReadRequiredBoolean(
            JsonObject owner,
            string propertyName,
            out bool value)
        {
            value = false;
            return owner.TryGetPropertyValue(propertyName, out var node)
                && node is JsonValue jsonValue
                && jsonValue.TryGetValue<bool>(out value);
        }

        private static bool QuotaHistoryRowMatchesUser(
            JsonElement request,
            int expectedSeerrUserId)
        {
            if (!request.TryGetProperty("requestedBy", out var requestedBy)
                || !TryReadPositiveSeerrUserId(requestedBy, out var actualSeerrUserId)
                || actualSeerrUserId != expectedSeerrUserId)
            {
                return false;
            }
            return true;
        }

        private static bool TryReadPositiveSeerrUserId(JsonElement value, out int userId)
        {
            if (value.ValueKind == JsonValueKind.Object
                && value.TryGetProperty("id", out var nestedId))
            {
                value = nestedId;
            }

            if (value.ValueKind == JsonValueKind.Number)
            {
                return value.TryGetInt32(out userId) && userId > 0;
            }

            if (value.ValueKind == JsonValueKind.String)
            {
                return int.TryParse(
                        value.GetString(),
                        System.Globalization.NumberStyles.None,
                        System.Globalization.CultureInfo.InvariantCulture,
                        out userId)
                    && userId > 0;
            }

            userId = 0;
            return false;
        }

        internal static Task<SeerrPagedCollectionResult> FetchQuotaRequestHistoryAsync(
            HttpClient httpClient,
            string sourceUrl,
            string apiKey,
            string seerrUserId,
            SeerrDispatchFence dispatchFence,
            CancellationToken cancellationToken,
            int pageSize = 100,
            int maximumPages = SeerrPaginationHelper.DefaultMaximumPages,
            int maximumItems = SeerrPaginationHelper.DefaultMaximumItems)
            => SeerrPaginationHelper.FetchAllAsync(
                httpClient,
                new[] { sourceUrl },
                (url, _, skip) => $"{url}/api/v1/user/{Uri.EscapeDataString(seerrUserId)}/requests" +
                    $"?take={pageSize}&skip={skip}",
                apiKey,
                seerrUserId,
                requestedPageSize: pageSize,
                static row => SeerrPaginationHelper.CanonicalPositiveIntegerPropertyIdentity(row, "id"),
                dispatchFence,
                cancellationToken,
                maximumPages,
                maximumItems);

        private enum QuotaResetEnrichmentStatus
        {
            Complete,
            ProjectionUnavailable,
            InvalidQuota,
        }

        private enum QuotaResetComputationStatus
        {
            Complete,
            ProjectionUnavailable,
            InvalidQuota,
        }

        private readonly record struct QuotaResetComputation(
            QuotaResetComputationStatus Status,
            DateTime? NextResetAt)
        {
            public static QuotaResetComputation Complete(DateTime? nextResetAt = null)
                => new(QuotaResetComputationStatus.Complete, nextResetAt);

            public static QuotaResetComputation ProjectionUnavailable()
                => new(QuotaResetComputationStatus.ProjectionUnavailable, null);

            public static QuotaResetComputation InvalidQuota()
                => new(QuotaResetComputationStatus.InvalidQuota, null);
        }

        [HttpGet("seerr/tv/{tmdbId}")]
        [Authorize]
        public Task<IActionResult> GetTvShow(int tmdbId, [FromQuery] bool fresh = false)
        {
            return fresh
                ? _seerr.ProxyFreshTvDetailAsync(
                    tmdbId,
                    SeerrCaller(),
                    HttpContext.RequestAborted)
                : ProxySeerrRequest($"/api/v1/tv/{tmdbId}", HttpMethod.Get);
        }

        [HttpGet("seerr/tv/{tmdbId}/season/{seasonNumber}")]
        [Authorize]
        public Task<IActionResult> GetTvSeason(int tmdbId, int seasonNumber)
        {
            return ProxySeerrRequest($"/api/v1/tv/{tmdbId}/season/{seasonNumber}", HttpMethod.Get);
        }

        [HttpGet("seerr/movie/{tmdbId}")]
        [Authorize]
        public Task<IActionResult> GetMovie(int tmdbId)
        {
            return ProxySeerrRequest($"/api/v1/movie/{tmdbId}", HttpMethod.Get);
        }

        [HttpGet("seerr/movie/{tmdbId}/similar")]
        [Authorize]
        public Task<IActionResult> GetSimilarMovies(int tmdbId, [FromQuery] int page = 1)
        {
            return ProxySeerrRequest($"/api/v1/movie/{tmdbId}/similar?page={page}", HttpMethod.Get);
        }

        [HttpGet("seerr/movie/{tmdbId}/recommendations")]
        [Authorize]
        public Task<IActionResult> GetRecommendedMovies(int tmdbId, [FromQuery] int page = 1)
        {
            return ProxySeerrRequest($"/api/v1/movie/{tmdbId}/recommendations?page={page}", HttpMethod.Get);
        }

        [HttpGet("seerr/movie/{tmdbId}/ratingscombined")]
        [Authorize]
        public Task<IActionResult> GetMovieRatingsCombined(int tmdbId)
        {
            return ProxySeerrRequest($"/api/v1/movie/{tmdbId}/ratingscombined", HttpMethod.Get);
        }

        [HttpGet("seerr/tv/{tmdbId}/similar")]
        [Authorize]
        public Task<IActionResult> GetSimilarTvShows(int tmdbId, [FromQuery] int page = 1)
        {
            return ProxySeerrRequest($"/api/v1/tv/{tmdbId}/similar?page={page}", HttpMethod.Get);
        }

        [HttpGet("seerr/tv/{tmdbId}/recommendations")]
        [Authorize]
        public Task<IActionResult> GetRecommendedTvShows(int tmdbId, [FromQuery] int page = 1)
        {
            return ProxySeerrRequest($"/api/v1/tv/{tmdbId}/recommendations?page={page}", HttpMethod.Get);
        }

        [HttpGet("seerr/tv/{tmdbId}/ratings")]
        [Authorize]
        public Task<IActionResult> GetTvRatingsCombined(int tmdbId)
        {
            return ProxySeerrRequest($"/api/v1/tv/{tmdbId}/ratings", HttpMethod.Get);
        }

        [HttpGet("seerr/discover/tv/network/{networkId}")]
        [Authorize]
        public Task<IActionResult> DiscoverTvByNetwork(int networkId, [FromQuery] int page = 1)
        {
            return ProxySeerrRequest(AppendDiscoverFilters($"/api/v1/discover/tv?page={page}&network={networkId}"), HttpMethod.Get);
        }

        [HttpGet("seerr/discover/movies/studio/{studioId}")]
        [Authorize]
        public Task<IActionResult> DiscoverMoviesByStudio(int studioId, [FromQuery] int page = 1)
        {
            return ProxySeerrRequest(AppendDiscoverFilters($"/api/v1/discover/movies?page={page}&studio={studioId}"), HttpMethod.Get);
        }

        // ── Discover feed rows (Discovery/Trending feature) ──────────────────
        // Base browse shapes not previously proxied: trending, popular (sorted
        // discover), upcoming and the caller's watchlist. All ride ProxyRequestAsync,
        // so they inherit auth, per-user X-Api-User scoping, response caching and the
        // server-side parental-rating filter (paths classified in SeerrParentalFilter).

        [HttpGet("seerr/discover/trending")]
        [Authorize]
        public Task<IActionResult> DiscoverTrending([FromQuery] int page = 1, [FromQuery] string mediaType = "all", [FromQuery] string timeWindow = "week")
        {
            var mt = mediaType is "movie" or "tv" or "all" ? mediaType : "all";
            var tw = timeWindow == "day" ? "day" : "week";
            return ProxySeerrRequest($"/api/v1/discover/trending?page={page}&mediaType={mt}&timeWindow={tw}", HttpMethod.Get);
        }

        [HttpGet("seerr/discover/movies")]
        [Authorize]
        public Task<IActionResult> DiscoverMovies([FromQuery] int page = 1)
        {
            return ProxySeerrRequest(AppendDiscoverFilters($"/api/v1/discover/movies?page={page}"), HttpMethod.Get);
        }

        [HttpGet("seerr/discover/tv")]
        [Authorize]
        public Task<IActionResult> DiscoverTv([FromQuery] int page = 1)
        {
            return ProxySeerrRequest(AppendDiscoverFilters($"/api/v1/discover/tv?page={page}"), HttpMethod.Get);
        }

        [HttpGet("seerr/discover/movies/upcoming")]
        [Authorize]
        public Task<IActionResult> DiscoverMoviesUpcoming([FromQuery] int page = 1)
        {
            return ProxySeerrRequest($"/api/v1/discover/movies/upcoming?page={page}", HttpMethod.Get);
        }

        [HttpGet("seerr/discover/tv/upcoming")]
        [Authorize]
        public Task<IActionResult> DiscoverTvUpcoming([FromQuery] int page = 1)
        {
            return ProxySeerrRequest($"/api/v1/discover/tv/upcoming?page={page}", HttpMethod.Get);
        }

        [HttpGet("seerr/discover/watchlist")]
        [Authorize]
        public Task<IActionResult> DiscoverWatchlist([FromQuery] int page = 1)
        {
            return ProxySeerrRequest($"/api/v1/discover/watchlist?page={page}", HttpMethod.Get);
        }

        [HttpGet("seerr/person/{personId}")]
        [Authorize]
        public Task<IActionResult> GetSeerrPerson(int personId)
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
            return ProxySeerrRequest($"/api/v1/person/{personId}", HttpMethod.Get);
        }

        [HttpGet("seerr/person/{personId}/combined_credits")]
        [Authorize]
        public Task<IActionResult> GetSeerrPersonCredits(int personId)
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
            return ProxySeerrRequest($"/api/v1/person/{personId}/combined_credits", HttpMethod.Get);
        }

        [HttpGet("seerr/discover/tv/genre/{genreId}")]
        [Authorize]
        public Task<IActionResult> DiscoverTvByGenre(int genreId, [FromQuery] int page = 1)
        {
            return ProxySeerrRequest(AppendDiscoverFilters($"/api/v1/discover/tv?page={page}&genre={genreId}"), HttpMethod.Get);
        }

        [HttpGet("seerr/discover/movies/genre/{genreId}")]
        [Authorize]
        public Task<IActionResult> DiscoverMoviesByGenre(int genreId, [FromQuery] int page = 1)
        {
            return ProxySeerrRequest(AppendDiscoverFilters($"/api/v1/discover/movies?page={page}&genre={genreId}"), HttpMethod.Get);
        }

        [HttpGet("seerr/discover/tv/keyword/{keywordId}")]
        [Authorize]
        public Task<IActionResult> DiscoverTvByKeyword(int keywordId, [FromQuery] int page = 1)
        {
            return ProxySeerrRequest(AppendDiscoverFilters($"/api/v1/discover/tv?page={page}&keywords={keywordId}"), HttpMethod.Get);
        }

        [HttpGet("seerr/discover/movies/keyword/{keywordId}")]
        [Authorize]
        public Task<IActionResult> DiscoverMoviesByKeyword(int keywordId, [FromQuery] int page = 1)
        {
            return ProxySeerrRequest(AppendDiscoverFilters($"/api/v1/discover/movies?page={page}&keywords={keywordId}"), HttpMethod.Get);
        }

        [HttpGet("tmdb/search/person")]
        [Authorize]
        public Task<IActionResult> SearchTmdbPerson([FromQuery] string query)
        {
            if (string.IsNullOrWhiteSpace(query))
            {
                return Task.FromResult<IActionResult>(BadRequest(new { message = "Query cannot be empty" }));
            }
            return ProxySeerrRequest($"/api/v1/search?query={Uri.EscapeDataString(query)}&page=1", HttpMethod.Get);
        }

        [HttpGet("tmdb/search/keyword")]
        [Authorize]
        public Task<IActionResult> SearchTmdbKeyword([FromQuery] string query)
        {
            if (string.IsNullOrWhiteSpace(query))
            {
                return Task.FromResult<IActionResult>(BadRequest(new { message = "Query cannot be empty" }));
            }
            return ProxySeerrRequest($"/api/v1/search/keyword?query={Uri.EscapeDataString(query)}", HttpMethod.Get);
        }

        [HttpGet("tmdb/genres/movie")]
        [Authorize]
        public Task<IActionResult> GetTmdbMovieGenres()
        {
            return ProxySeerrRequest("/api/v1/genres/movie", HttpMethod.Get);
        }

        [HttpGet("tmdb/genres/tv")]
        [Authorize]
        public Task<IActionResult> GetTmdbTvGenres()
        {
            return ProxySeerrRequest("/api/v1/genres/tv", HttpMethod.Get);
        }

        [HttpGet("seerr/discover/genreslider/movie")]
        [Authorize]
        public Task<IActionResult> GetMovieGenreSlider()
        {
            return ProxySeerrRequest("/api/v1/discover/genreslider/movie", HttpMethod.Get);
        }

        [HttpGet("seerr/discover/genreslider/tv")]
        [Authorize]
        public Task<IActionResult> GetTvGenreSlider()
        {
            return ProxySeerrRequest("/api/v1/discover/genreslider/tv", HttpMethod.Get);
        }

        [HttpGet("seerr/overrideRule")]
        [Authorize]
        public Task<IActionResult> GetOverrideRules()
        {
            return ProxySeerrRequest("/api/v1/overrideRule", HttpMethod.Get);
        }

        [HttpGet("seerr/collection/{collectionId}")]
        [Authorize]
        public Task<IActionResult> GetCollection(int collectionId)
        {
            return ProxySeerrRequest($"/api/v1/collection/{collectionId}", HttpMethod.Get);
        }

        [HttpGet("seerr/settings/partial-requests")]
        [Authorize]
        public async Task<IActionResult> GetSeerrPartialRequestsSetting()
        {
            var integration = SeerrIntegrationPolicy.Capture(_configProvider);
            if (!integration.IsActive)
            {
                // previously returned 200+false, which made the
                // frontend silently flip the request modal to whole-season
                // mode. Returns 503 with structured `code` so the frontend
                // can refuse to choose a mutation shape and ask for a retry.
                _logger.LogWarning("Seerr integration is not configured or enabled.");
                return StatusCode(503, new { error = true, code = "disabled", message = "Seerr integration not configured." });
            }

            var config = integration.Configuration!;
            var configurationRevision = integration.ConfigurationRevision;
            var configStamp = SeerrMutationConfigStamp.Capture(config, configurationRevision);
            var apiKey = integration.ApiKey;
            var configuredUrls = integration.Urls;
            IActionResult ConfigurationChanged() => StatusCode(409, new
            {
                error = true,
                code = "read_configuration_changed",
                message = "Seerr configuration changed while reading request settings. Retry the request."
            });

            bool IsConfigurationCurrent() => integration.IsCurrent(_configProvider)
                && configStamp.Matches(
                    _configProvider.ConfigurationOrNull,
                    _configProvider.ConfigurationRevision);
            SeerrDispatchFence dispatchFence = integration
                .CreateDispatchFence(_configProvider)
                .Restrict(IsConfigurationCurrent);

            if (!IsConfigurationCurrent())
            {
                return ConfigurationChanged();
            }

            var jellyfinUserId = UserHelper.GetCurrentUserId(User)?.ToString() ?? string.Empty;
            var resolution = await _seerr.ResolveSeerrUser(
                jellyfinUserId,
                bypassCache: true,
                allowAutoImport: false,
                cancellationToken: HttpContext.RequestAborted).ConfigureAwait(false);
            if (!IsConfigurationCurrent())
            {
                return ConfigurationChanged();
            }

            var seerrUser = resolution.User;
            if (seerrUser == null)
            {
                if (resolution.Status is SeerrUserResolutionStatus.Incomplete or SeerrUserResolutionStatus.Unavailable)
                {
                    return StatusCode(502, new
                    {
                        error = true,
                        code = "user_lookup_incomplete",
                        message = "Seerr user lookup was incomplete. Settings were not published."
                    });
                }

                return resolution.Status == SeerrUserResolutionStatus.Blocked
                    ? StatusCode(403, new { error = true, code = "blocked", message = "Seerr is disabled for this account." })
                    : NotFound(new { error = true, code = "unlinked", message = "Current user is not linked to Seerr." });
            }

            var sourceUrl = configuredUrls.FirstOrDefault(url => string.Equals(
                url,
                SeerrUrlIdentity.Normalize(seerrUser.SourceUrl),
                StringComparison.Ordinal));
            if (seerrUser.Id <= 0 || sourceUrl == null)
            {
                return StatusCode(502, new
                {
                    error = true,
                    code = "source_affinity_unavailable",
                    message = "The linked Seerr instance could not be verified. Settings were not published."
                });
            }

            var httpClient = Helpers.Seerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
            var requestUri = $"{sourceUrl.TrimEnd('/')}/api/v1/settings/main";
            try
            {
                if (!IsConfigurationCurrent())
                {
                    return ConfigurationChanged();
                }

                _logger.LogInformation($"Fetching Seerr partial requests setting from: {requestUri}");

                using var request = Helpers.Seerr.SeerrHttpHelper.BuildRequest(
                    HttpMethod.Get, requestUri, apiKey);
                var (responseContent, error, _) = await Helpers.Seerr.SeerrHttpHelper.SendAndReadJsonAsync(
                    httpClient,
                    request,
                    requestUri,
                    dispatchFence,
                    HttpContext.RequestAborted).ConfigureAwait(false);

                if (!IsConfigurationCurrent())
                {
                    return ConfigurationChanged();
                }

                if (error == null && responseContent != null)
                {
                    using var settings = JsonDocument.Parse(responseContent);
                    if (!settings.RootElement.TryGetProperty("partialRequestsEnabled", out var partialProp)
                        || partialProp.ValueKind is not (JsonValueKind.True or JsonValueKind.False)
                        || !settings.RootElement.TryGetProperty("enableSpecialEpisodes", out var specialsProp)
                        || specialsProp.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                    {
                        return StatusCode(502, new
                        {
                            error = true,
                            code = "settings_invalid",
                            message = "Seerr returned invalid request settings."
                        });
                    }

                    var partialRequestsEnabled = partialProp.ValueKind == JsonValueKind.True;
                    var enableSpecialEpisodes = specialsProp.ValueKind == JsonValueKind.True;
                    _logger.LogInformation($"Seerr settings — partialRequests: {partialRequestsEnabled}, specialEpisodes: {enableSpecialEpisodes}");
                    return Ok(new { partialRequestsEnabled, enableSpecialEpisodes });
                }

                _logger.LogWarning($"Failed to fetch Seerr settings from {sourceUrl}: code={error!.Code} status={error.HttpStatus} cf-ray={error.CfRay} — {error.Message}");
            }
            catch (OperationCanceledException) when (HttpContext.RequestAborted.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                if (!IsConfigurationCurrent())
                {
                    return ConfigurationChanged();
                }

                _logger.LogError($"Failed to connect to Seerr URL: {sourceUrl}. Error: {ex.Message}");
            }

            if (!IsConfigurationCurrent())
            {
                return ConfigurationChanged();
            }

            // Do not fail over to another Seerr identity domain and do not
            // silently default to false on outage — that
            // hides admin-configured "partial requests off" UX state. Return
            // 503 so the frontend can keep last-known state.
            _logger.LogWarning("Could not fetch settings from the resolved Seerr source — surfacing as 503 unreachable");
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
            // seerr/validate).
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

            var configurationRevision = _configProvider.ConfigurationRevision;
            var configStamp = SeerrMutationConfigStamp.Capture(config, configurationRevision);
            var tmdbApiKey = config.TMDB_API_KEY;
            bool IsConfigurationCurrent() => configStamp.Matches(
                _configProvider.ConfigurationOrNull,
                _configProvider.ConfigurationRevision);
            IActionResult ConfigurationChanged() => StatusCode(409, new
            {
                error = true,
                code = "read_configuration_changed",
                message = "Plugin configuration changed while reading TMDB metadata. Retry the request."
            });

            if (!IsConfigurationCurrent())
            {
                return ConfigurationChanged();
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
            var isBlocked = await _parentalFilter
                .IsTmdbProxyPathBlockedAsync($"{apiPath}{queryString}", SeerrCaller())
                .ConfigureAwait(false);
            if (!IsConfigurationCurrent())
            {
                return ConfigurationChanged();
            }

            if (isBlocked)
            {
                return new StatusCodeResult(403);
            }

            var httpClient = Helpers.PluginHttpClients.CreateTmdbClient(_httpClientFactory);
            var separator = queryString.HasValue ? "&" : "?";
            var requestUri = $"https://api.themoviedb.org/3/{apiPath}{queryString}{separator}api_key={Uri.EscapeDataString(tmdbApiKey)}";

            try
            {
                if (!IsConfigurationCurrent())
                {
                    return ConfigurationChanged();
                }

                using var response = await httpClient
                    .GetAsync(requestUri, HttpContext.RequestAborted)
                    .ConfigureAwait(false);
                var content = await response.Content
                    .ReadAsStringAsync(HttpContext.RequestAborted)
                    .ConfigureAwait(false);
                if (!IsConfigurationCurrent())
                {
                    return ConfigurationChanged();
                }

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

        [HttpGet("seerr/issue")]
        [Authorize]
        public async Task<IActionResult> GetSeerrIssues(
            [FromQuery] int? mediaId = null,
            [FromQuery] int? tmdbId = null,
            [FromQuery] string? mediaType = null,
            [FromQuery] int take = 20,
            [FromQuery] int skip = 0,
            [FromQuery] string? filter = "all",
            [FromQuery] string? sort = "added")
        {
            skip = Math.Max(0, skip);
            var normalizedMediaType = NormalizeIssueMediaType(mediaType);
            var hasTitleTarget = tmdbId.HasValue || !string.IsNullOrWhiteSpace(mediaType);
            take = Math.Clamp(take, 1, hasTitleTarget ? MaximumTitleIssueRows : 200);
            if (mediaId.HasValue
                || (hasTitleTarget && (tmdbId is not > 0 || normalizedMediaType == null)))
            {
                return BadRequest(new
                {
                    error = true,
                    code = mediaId.HasValue ? "unsupported_media_id_filter" : "invalid_issue_target",
                    message = mediaId.HasValue
                        ? "Seerr does not support mediaId filtering. Use a positive tmdbId with mediaType movie/tv."
                        : "Issue filtering requires a positive tmdbId with mediaType movie/tv."
                });
            }

            var filterValue = string.Equals(filter?.Trim(), "open", StringComparison.OrdinalIgnoreCase)
                ? "open"
                : string.Equals(filter?.Trim(), "resolved", StringComparison.OrdinalIgnoreCase)
                    ? "resolved"
                    : "all";
            var sortValue = string.Equals(sort?.Trim(), "modified", StringComparison.OrdinalIgnoreCase)
                ? "modified"
                : "added";

            var integration = SeerrIntegrationPolicy.Capture(_configProvider);
            var config = integration.Configuration;
            var caller = SeerrCaller();
            if (!integration.IsActive || config == null)
            {
                return StatusCode(503, new { error = true, code = "unavailable", message = "Seerr integration is not available." });
            }

            if (string.IsNullOrWhiteSpace(caller.JellyfinUserId))
            {
                return Forbid();
            }

            var configurationRevision = integration.ConfigurationRevision;
            var configStamp = SeerrMutationConfigStamp.Capture(config, configurationRevision);
            var apiKey = integration.ApiKey;
            var configuredUrls = integration.Urls;
            bool IsConfigurationCurrent() => configStamp.Matches(
                _configProvider.ConfigurationOrNull,
                _configProvider.ConfigurationRevision);
            IActionResult ConfigurationChanged() => StatusCode(409, new
            {
                error = true,
                code = "read_configuration_changed",
                message = "Seerr configuration changed while preparing the issue list. Retry the request."
            });
            if (!IsConfigurationCurrent())
            {
                return ConfigurationChanged();
            }

            // Resolve once so both the issue read and every avatar token are
            // bound to the same current instance-local user domain.
            var resolution = await _seerr.ResolveSeerrUser(
                caller.JellyfinUserId,
                bypassCache: true,
                allowAutoImport: false,
                cancellationToken: HttpContext.RequestAborted).ConfigureAwait(false);
            if (!IsConfigurationCurrent())
            {
                return ConfigurationChanged();
            }

            if (!resolution.IsFound)
            {
                return resolution.Status switch
                {
                    SeerrUserResolutionStatus.Blocked => StatusCode(403, new { error = true, code = "blocked", message = "Seerr is disabled for this account." }),
                    SeerrUserResolutionStatus.NotFound => NotFound(new { error = true, code = "unlinked", message = "Current Jellyfin user is not linked to a Seerr user." }),
                    SeerrUserResolutionStatus.Unavailable => StatusCode(503, new { error = true, code = "unavailable", message = "Seerr integration is not available." }),
                    _ => StatusCode(502, new { error = true, code = "user_lookup_incomplete", message = "Seerr user lookup was incomplete. Please try again." }),
                };
            }

            var seerrUser = resolution.User!;

            // A caller allowed to see OTHERS' issues (Jellyfin admin, Seerr ADMIN,
            // or VIEW_ISSUES/MANAGE_ISSUES) may consume Seerr's unfiltered relations.
            // A CREATE_ISSUES-only reporter is admitted too, but only ever reads
            // their OWN issues through Seerr's ownership-enforced list/detail routes.
            var canViewOthersIssues = caller.IsAdmin
                || SeerrPermissionHelper.HasPermission(seerrUser.Permissions, SeerrPermission.ADMIN)
                || SeerrPermissionHelper.HasAnyPermission(
                    seerrUser.Permissions,
                    SeerrPermission.VIEW_ISSUES | SeerrPermission.MANAGE_ISSUES);
            if (!canViewOthersIssues
                && !SeerrPermissionHelper.HasPermission(
                    seerrUser.Permissions,
                    SeerrPermission.CREATE_ISSUES))
            {
                return StatusCode(403, new
                {
                    error = true,
                    code = "no_issue_view_permission",
                    message = "You do not have permission to view issues in Seerr."
                });
            }

            var normalizedSource = SeerrSourceToken.NormalizeSourceUrl(seerrUser.SourceUrl);
            var configuredSource = configuredUrls.FirstOrDefault(url => string.Equals(
                url,
                normalizedSource,
                StringComparison.Ordinal));
            if (configuredSource == null)
            {
                return StatusCode(502, new
                {
                    error = true,
                    code = "source_affinity_unavailable",
                    message = "The linked Seerr instance could not be verified. No issue list was published."
                });
            }

            var pinnedUser = new SeerrUser
            {
                Id = seerrUser.Id,
                JellyfinUserId = seerrUser.JellyfinUserId,
                Permissions = seerrUser.Permissions,
                SourceUrl = configuredSource,
            };

            // The generic downloads-page list remains an ordinary Seerr-owned
            // page. Seerr does not support mediaId filtering on this endpoint,
            // so never pretend that parameter scopes the upstream query.
            if (!hasTitleTarget)
            {
                var queryParts = new List<string>
                {
                    $"take={take}",
                    $"skip={skip}",
                    $"filter={Uri.EscapeDataString(filterValue)}",
                    $"sort={Uri.EscapeDataString(sortValue)}",
                };
                var apiPath = $"/api/v1/issue?{string.Join("&", queryParts)}";
                var genericResult = await _seerr.ProxyRequestAsync(
                    apiPath,
                    HttpMethod.Get,
                    null,
                    caller,
                    pinnedUser,
                    HttpContext.RequestAborted).ConfigureAwait(false);
                if (!IsConfigurationCurrent())
                {
                    return ConfigurationChanged();
                }

                var decorated = DecorateIssueResult(
                    genericResult,
                    apiKey,
                    caller.JellyfinUserId,
                    configuredSource);
                BeforeIssueProjectionPublishForTest?.Invoke();
                return IsConfigurationCurrent() ? decorated : ConfigurationChanged();
            }

            // A targeted list is owned by Seerr's supported media detail query:
            // Media.getMedia(tmdbId, type) loads its complete `issues` relation.
            // Keep Canopy's stricter issue-view gate above and run the title's
            // parental authorization before asking Seerr for any detail.
            var blocked = await _parentalFilter.IsBlockedAsync(
                normalizedMediaType!,
                tmdbId!.Value,
                caller).ConfigureAwait(false);
            if (!IsConfigurationCurrent())
            {
                return ConfigurationChanged();
            }
            if (blocked)
            {
                return StatusCode(403, new
                {
                    error = true,
                    code = "parental_blocked",
                    message = "This title is unavailable for the current account."
                });
            }

            // A CREATE_ISSUES-only reporter must NOT consume the media detail's
            // unfiltered issue relation (that would expose other reporters' issues).
            // Read their OWN issues through Seerr's ownership-enforced list route,
            // scoped to createdBy = their pinned id, then project just this title.
            // Seerr stays the ownership authority: it filters the list to the caller
            // and 403s a foreign createdBy, so admitting them here is not a global
            // view. The projection is exact only if the caller's complete owned set
            // fit in one bounded page; anything else fails closed, never false-empty.
            if (!canViewOthersIssues)
            {
                var ownedPath = "/api/v1/issue?"
                    + $"createdBy={pinnedUser.Id}"
                    + $"&take={MaximumTitleIssueRows}"
                    + "&skip=0"
                    + $"&filter={Uri.EscapeDataString(filterValue)}"
                    + $"&sort={Uri.EscapeDataString(sortValue)}";
                var ownedResult = await _seerr.ProxyRequestAsync(
                    ownedPath,
                    HttpMethod.Get,
                    null,
                    caller,
                    pinnedUser,
                    HttpContext.RequestAborted).ConfigureAwait(false);
                if (!IsConfigurationCurrent())
                {
                    return ConfigurationChanged();
                }

                if (ownedResult is not ContentResult ownedContent
                    || ownedContent.StatusCode is < 200 or >= 300
                    || string.IsNullOrWhiteSpace(ownedContent.Content))
                {
                    return ownedResult;
                }

                JsonObject? ownedList;
                try
                {
                    ownedList = JsonNode.Parse(ownedContent.Content) as JsonObject;
                }
                catch (JsonException ex)
                {
                    _logger.LogWarning(ex, "Seerr owned-issue list was not valid JSON; no issue projection was published.");
                    return InvalidIssueRelation();
                }

                if (ownedList == null
                    || ownedList["pageInfo"] is not JsonObject ownedPageInfo
                    || !TryReadInt(ownedPageInfo["results"], out var ownedTotal)
                    || ownedTotal < 0
                    || ownedTotal > MaximumTitleIssueRows
                    || ownedList["results"] is not JsonArray ownedResults
                    || ownedResults.Count != ownedTotal)
                {
                    return InvalidIssueRelation();
                }

                var ownedSeenIds = new HashSet<int>();
                var ownedRows = new List<(JsonObject Row, int Id, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt)>();
                foreach (var node in ownedResults)
                {
                    if (node is not JsonObject row
                        || !TryReadPositiveInt(row["id"], out var issueId)
                        || !ownedSeenIds.Add(issueId)
                        || !TryReadInt(row["status"], out var status)
                        || status is not (1 or 2)
                        || !TryReadTimestamp(row["createdAt"], out var createdAt)
                        || !TryReadTimestamp(row["updatedAt"], out var updatedAt)
                        || row["media"] is not JsonObject rowMedia
                        || !TryReadPositiveInt(rowMedia["tmdbId"], out var rowTmdbId)
                        || string.IsNullOrWhiteSpace((string?)rowMedia["mediaType"]))
                    {
                        return InvalidIssueRelation();
                    }

                    // Project only the requested title. Seerr already scoped
                    // ownership; this is a title filter, not an ownership decision.
                    if (rowTmdbId != tmdbId.Value
                        || !string.Equals(
                            (string?)rowMedia["mediaType"],
                            normalizedMediaType,
                            StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }

                    if ((filterValue == "open" && status != 1)
                        || (filterValue == "resolved" && status != 2))
                    {
                        continue;
                    }

                    ownedRows.Add((row, issueId, createdAt, updatedAt));
                }

                var ownedProjection = OrderAndPublishTitleRows(
                    ownedRows,
                    sortValue,
                    take,
                    skip,
                    apiKey,
                    caller.JellyfinUserId,
                    configuredSource);
                BeforeIssueProjectionPublishForTest?.Invoke();
                return IsConfigurationCurrent() ? ownedProjection : ConfigurationChanged();
            }

            var detailResult = await _seerr.ProxyFreshMediaDetailAsync(
                tmdbId.Value,
                normalizedMediaType!,
                caller,
                pinnedUser,
                HttpContext.RequestAborted).ConfigureAwait(false);
            if (!IsConfigurationCurrent())
            {
                return ConfigurationChanged();
            }

            if (detailResult is not ContentResult detailContent
                || detailContent.StatusCode is < 200 or >= 300
                || string.IsNullOrWhiteSpace(detailContent.Content))
            {
                return detailResult;
            }

            JsonObject? detail;
            try
            {
                detail = JsonNode.Parse(detailContent.Content) as JsonObject;
            }
            catch (JsonException ex)
            {
                _logger.LogWarning(ex, "Seerr media detail was not valid JSON; no issue projection was published.");
                return InvalidIssueRelation();
            }

            if (detail == null)
            {
                return InvalidIssueRelation();
            }

            // Seerr collapses both authoritative absence and repository failures
            // to an omitted mediaInfo. Because those states are indistinguishable,
            // missing ownership cannot truthfully prove an exact empty issue set.
            if (!detail.TryGetPropertyValue("mediaInfo", out var mediaInfoNode)
                || mediaInfoNode == null)
            {
                return InvalidIssueRelation();
            }

            if (mediaInfoNode is not JsonObject mediaInfo
                || !TryReadPositiveInt(mediaInfo["id"], out var ownerId)
                || !JsonPositiveIntEquals(mediaInfo["tmdbId"], tmdbId.Value)
                || !string.Equals(
                    (string?)mediaInfo["mediaType"],
                    normalizedMediaType,
                    StringComparison.OrdinalIgnoreCase)
                || mediaInfo["issues"] is not JsonArray relation
                || relation.Count > MaximumTitleIssueRows)
            {
                return InvalidIssueRelation();
            }

            var seenIds = new HashSet<int>();
            var rows = new List<(JsonObject Row, int Id, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt)>();
            foreach (var node in relation)
            {
                if (node is not JsonObject row
                    || !TryReadPositiveInt(row["id"], out var issueId)
                    || !seenIds.Add(issueId)
                    || !TryReadInt(row["status"], out var status)
                    || status is not (1 or 2)
                    || !TryReadTimestamp(row["createdAt"], out var createdAt)
                    || !TryReadTimestamp(row["updatedAt"], out var updatedAt)
                    || !IssueOwnerIsConsistent(row["media"], ownerId, tmdbId.Value, normalizedMediaType!))
                {
                    return InvalidIssueRelation();
                }

                if ((filterValue == "open" && status != 1)
                    || (filterValue == "resolved" && status != 2))
                {
                    continue;
                }

                rows.Add((row, issueId, createdAt, updatedAt));
            }

            var projected = OrderAndPublishTitleRows(
                rows,
                sortValue,
                take,
                skip,
                apiKey,
                caller.JellyfinUserId,
                configuredSource);
            BeforeIssueProjectionPublishForTest?.Invoke();
            return IsConfigurationCurrent() ? projected : ConfigurationChanged();

            IActionResult InvalidIssueRelation() => StatusCode(502, new
            {
                error = true,
                code = "issue_relation_incomplete",
                message = "Seerr did not return a complete title issue relation. No partial result was published."
            });
        }

        // Orders the validated, title-matched issue rows exactly as the client
        // contract expects and hands them to the exact-title pagination and
        // avatar-decoration builder. Shared by the media-detail relation path
        // (VIEW_ISSUES/MANAGE_ISSUES/admin) and the ownership-scoped owned-issue
        // list path (CREATE_ISSUES-only) so both publish an identical contract.
        private IActionResult OrderAndPublishTitleRows(
            List<(JsonObject Row, int Id, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt)> rows,
            string sortValue,
            int take,
            int skip,
            string apiKey,
            string callerId,
            string configuredSource)
        {
            var orderedRows = sortValue == "modified"
                ? rows.OrderByDescending(row => row.UpdatedAt).ThenByDescending(row => row.Id)
                : rows.OrderByDescending(row => row.CreatedAt).ThenByDescending(row => row.Id);
            var matchingRows = orderedRows.Select(row => row.Row).ToArray();
            return BuildExactTitleIssueResult(
                matchingRows,
                take,
                skip,
                apiKey,
                callerId,
                configuredSource);
        }

        private IActionResult BuildExactTitleIssueResult(
            IReadOnlyList<JsonObject> matchingRows,
            int take,
            int skip,
            string apiKey,
            string callerId,
            string configuredSource)
        {
            var pagedRows = new JsonArray();
            foreach (var row in matchingRows.Skip(skip).Take(take))
            {
                pagedRows.Add(row.DeepClone());
            }

            var body = new JsonObject
            {
                ["pageInfo"] = new JsonObject
                {
                    ["pages"] = (int)Math.Ceiling(matchingRows.Count / (double)take),
                    ["pageSize"] = take,
                    ["results"] = matchingRows.Count,
                    ["page"] = ((long)skip / take) + 1L,
                },
                ["results"] = pagedRows,
                [PostPaginationFilterContract.JsonPropertyName] = new JsonObject
                {
                    ["contract"] = "media-relation-owner",
                    ["totalExact"] = true,
                },
            };
            if (!TryDecorateIssueAvatarTokens(
                body,
                apiKey,
                callerId,
                configuredSource))
            {
                return StatusCode(502, new { error = true, code = "upstream_response_invalid", message = "Seerr returned an invalid issue list." });
            }
            return Content(body.ToJsonString(), "application/json");
        }

        private IActionResult DecorateIssueResult(
            IActionResult result,
            string apiKey,
            string callerId,
            string configuredSource)
        {
            if (result is not ContentResult contentResult || string.IsNullOrWhiteSpace(contentResult.Content))
            {
                return result;
            }

            JsonObject? body;
            try
            {
                body = JsonNode.Parse(contentResult.Content) as JsonObject;
            }
            catch (JsonException ex)
            {
                _logger.LogWarning(ex, "Seerr issue response was not valid JSON; refusing an undecorated avatar projection.");
                return StatusCode(502, new { error = true, code = "upstream_response_invalid", message = "Seerr returned an invalid issue list." });
            }

            if (body == null || !TryDecorateIssueAvatarTokens(body, apiKey, callerId, configuredSource))
            {
                return StatusCode(502, new { error = true, code = "upstream_response_invalid", message = "Seerr returned an invalid issue list." });
            }

            contentResult.Content = body.ToJsonString();
            return contentResult;
        }

        private static string? NormalizeIssueMediaType(string? mediaType)
        {
            var normalized = mediaType?.Trim().ToLowerInvariant();
            return normalized is "movie" or "tv" ? normalized : null;
        }

        private static bool IssueOwnerIsConsistent(
            JsonNode? mediaNode,
            int ownerId,
            int tmdbId,
            string mediaType)
        {
            // The owner relation is authoritative. Some Seerr serializers omit
            // the issue's eager back-reference to avoid a cycle; if present it
            // must agree with that owner in every identity domain.
            if (mediaNode == null)
            {
                return true;
            }
            if (mediaNode is not JsonObject media)
            {
                return false;
            }
            return JsonPositiveIntEquals(media["id"], ownerId)
                && JsonPositiveIntEquals(media["tmdbId"], tmdbId)
                && string.Equals((string?)media["mediaType"], mediaType, StringComparison.OrdinalIgnoreCase);
        }

        private static bool JsonPositiveIntEquals(JsonNode? node, int expected)
        {
            if (node is not JsonValue value || expected <= 0)
            {
                return false;
            }

            if (value.TryGetValue<int>(out var numeric))
            {
                return numeric == expected;
            }

            return value.TryGetValue<string>(out var text)
                && int.TryParse(
                    text,
                    System.Globalization.NumberStyles.None,
                    System.Globalization.CultureInfo.InvariantCulture,
                    out var parsed)
                && parsed == expected;
        }

        private static bool TryReadPositiveInt(JsonNode? node, out int value)
        {
            value = 0;
            if (node is not JsonValue jsonValue)
            {
                return false;
            }
            if (jsonValue.TryGetValue<int>(out value))
            {
                return value > 0;
            }
            return jsonValue.TryGetValue<string>(out var text)
                && int.TryParse(
                    text,
                    System.Globalization.NumberStyles.None,
                    System.Globalization.CultureInfo.InvariantCulture,
                    out value)
                && value > 0;
        }

        private static bool TryReadInt(JsonNode? node, out int value)
        {
            value = 0;
            return node is JsonValue jsonValue
                && (jsonValue.TryGetValue<int>(out value)
                    || (jsonValue.TryGetValue<string>(out var text)
                        && int.TryParse(
                            text,
                            System.Globalization.NumberStyles.Integer,
                            System.Globalization.CultureInfo.InvariantCulture,
                            out value)));
        }

        private static bool TryReadTimestamp(JsonNode? node, out DateTimeOffset value)
        {
            value = default;
            return node is JsonValue jsonValue
                && jsonValue.TryGetValue<string>(out var text)
                && DateTimeOffset.TryParse(
                    text,
                    System.Globalization.CultureInfo.InvariantCulture,
                    System.Globalization.DateTimeStyles.AssumeUniversal
                        | System.Globalization.DateTimeStyles.AdjustToUniversal,
                    out value);
        }

        internal static bool TryDecorateIssueAvatarTokens(
            JsonObject body,
            string apiKey,
            string callerId,
            string sourceUrl)
        {
            if (body["results"] is not JsonArray results)
            {
                return false;
            }

            foreach (var row in results)
            {
                var createdBy = (row as JsonObject)?["createdBy"] as JsonObject;
                var avatar = (string?)createdBy?["avatar"];
                if (createdBy == null || string.IsNullOrWhiteSpace(avatar) || !avatar.StartsWith('/'))
                {
                    continue;
                }

                if (!SeerrSourceToken.TryNormalizeAvatarPath(avatar, out var avatarPath))
                {
                    // Never leave an unsafe relative value for the client to
                    // proxy without a valid source-bound token.
                    createdBy["avatar"] = null;
                    continue;
                }

                createdBy["avatar"] = avatarPath;
                createdBy["avatarSourceToken"] = SeerrSourceToken.Create(
                    apiKey,
                    SeerrSourceToken.AvatarPurpose,
                    callerId,
                    sourceUrl,
                    avatarPath);
            }

            return true;
        }

        [HttpGet("seerr/issue/{id}")]
        [Authorize]
        public Task<IActionResult> GetSeerrIssueById(int id)
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
            return ProxySeerrRequest($"/api/v1/issue/{id}", HttpMethod.Get);
        }

        [HttpPost("seerr/issue")]
        [Authorize]
        public async Task<IActionResult> ReportSeerrIssue([FromBody] JsonElement issueBody)
        {
            return await ProxySeerrRequest("/api/v1/issue", HttpMethod.Post, issueBody.ToString());
        }
    }
}
