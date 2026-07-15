using System;
using System.Linq;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using MediaBrowser.Common.Api;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Controllers
{
    /// <summary>
    /// Elevated manual entry point for the lifecycle-owned Seerr scan trigger.
    /// </summary>
    [Route("JellyfinCanopy")]
    [ApiController]
    public sealed class SeerrScanTriggerController : ControllerBase
    {
        private readonly SeerrScanTriggerService _scanTrigger;
        private readonly ILogger<SeerrScanTriggerController> _logger;

        public SeerrScanTriggerController(
            SeerrScanTriggerService scanTrigger,
            ILogger<SeerrScanTriggerController> logger)
        {
            _scanTrigger = scanTrigger;
            _logger = logger;
        }

        // The form deliberately sends one normalized identity domain at a time so it can report
        // partial success. The service coalesces these calls with any pending automatic scan.
        [HttpPost("seerr/trigger-recently-added-scan")]
        [Authorize(Policy = Policies.RequiresElevation)]
        public async Task<IActionResult> TriggerSeerrRecentlyAddedScan(
            [FromQuery] string? url,
            [FromHeader(Name = "X-Arr-ApiKey")] string apiKey,
            [FromQuery] string? urls = null)
        {
            var rawUrls = string.IsNullOrWhiteSpace(urls) ? url : urls;
            if (string.IsNullOrWhiteSpace(rawUrls) || string.IsNullOrWhiteSpace(apiKey))
            {
                return BadRequest(new { ok = false, message = "Missing url or apiKey" });
            }

            var domains = SeerrScanTriggerService.ParseUrls(rawUrls);
            if (domains.Count == 0 || domains.Any(domain => !ArrUrlGuard.IsAllowedUrl(domain)))
            {
                _logger.LogError("Seerr scan trigger rejected one or more outbound URLs");
                return BadRequest(new { ok = false, message = "Invalid URL" });
            }

            try
            {
                // Retain the legacy one-URL response/status contract for cached admin pages while
                // the current page sends every domain in one lifecycle-owned operation.
                if (string.IsNullOrWhiteSpace(urls))
                {
                    var legacyResult = await _scanTrigger.TriggerNowAsync(
                        domains[0],
                        apiKey,
                        HttpContext.RequestAborted).ConfigureAwait(false);
                    return LegacyResult(legacyResult);
                }

                var results = await _scanTrigger.TriggerNowAsync(
                    domains,
                    apiKey,
                    HttpContext.RequestAborted).ConfigureAwait(false);
                var projected = results.Select(result => new
                {
                    domain = result.Url,
                    ok = result.Success,
                    statusCode = result.StatusCode,
                    code = result.ErrorCode,
                    cfRay = result.CfRay,
                    message = result.Body,
                    cancelled = result.Cancelled,
                }).ToArray();
                var succeeded = projected.Count(result => result.ok);
                var outcome = succeeded == projected.Length
                    ? "success"
                    : succeeded > 0 ? "partial" : "failure";
                return Ok(new
                {
                    ok = succeeded == projected.Length,
                    outcome,
                    results = projected,
                });
            }
            catch (OperationCanceledException) when (HttpContext.RequestAborted.IsCancellationRequested)
            {
                throw;
            }
            catch (ObjectDisposedException)
            {
                return StatusCode(503, new
                {
                    ok = false,
                    code = "Stopping",
                    message = "The Seerr scan trigger service is stopping.",
                });
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[SeerrScan] Manual trigger failed");
                return StatusCode(502, new
                {
                    ok = false,
                    code = "Unreachable",
                    message = $"Unable to reach Seerr: {ex.Message}",
                });
            }
        }

        private IActionResult LegacyResult(SeerrScanTriggerService.DispatchResult result)
        {
            if (result.Success)
            {
                return Ok(new { ok = true });
            }

            if (result.Cancelled)
            {
                return StatusCode(503, new
                {
                    ok = false,
                    code = "Stopping",
                    message = result.Body,
                });
            }

            var httpCode = result.ErrorCode switch
            {
                nameof(SeerrErrorCode.HtmlResponse) => 502,
                nameof(SeerrErrorCode.UpstreamRedirect) => 502,
                nameof(SeerrErrorCode.Cloudflare5xx) => 502,
                _ => result.StatusCode > 0 ? result.StatusCode : 502,
            };
            return StatusCode(httpCode, new
            {
                ok = false,
                code = string.IsNullOrEmpty(result.ErrorCode) ? "Unreachable" : result.ErrorCode,
                cfRay = result.CfRay,
                message = result.Body,
            });
        }
    }
}
