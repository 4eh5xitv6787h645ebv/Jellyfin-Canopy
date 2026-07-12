using System;
using System.Net.Http;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Model.Arr;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Arr;
using Jellyfin.Plugin.JellyfinCanopy.Services.Jellyseerr;
using MediaBrowser.Common.Api;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Controllers
{
    /// <summary>
    /// Admin-only Sonarr/Radarr Search, Interactive Search (manual release picker) and management
    /// (monitor / add) endpoints that back the native action-sheet items. Every route is
    /// <see cref="Policies.RequiresElevation"/> (bare empty-body 401/403; JSON envelopes carry only
    /// business errors). Item resolution goes through <see cref="IArrItemResolver"/>; all arr I/O
    /// through <see cref="ArrActionService"/>.
    /// </summary>
    [Route("JellyfinCanopy")]
    [ApiController]
    [Authorize(Policy = Policies.RequiresElevation)]
    public sealed class ArrSearchController : JellyfinCanopyControllerBase
    {
        private readonly IArrItemResolver _resolver;
        private readonly ArrActionService _actions;

        public ArrSearchController(
            IHttpClientFactory httpClientFactory,
            ILogger<ArrSearchController> logger,
            IUserManager userManager,
            ISeerrCache seerrCache,
            IPluginConfigProvider configProvider,
            IArrItemResolver resolver,
            ArrActionService actions)
            : base(httpClientFactory, logger, userManager, seerrCache, configProvider)
        {
            _resolver = resolver;
            _actions = actions;
        }

        // ── request bodies ───────────────────────────────────────────────────
        public sealed class AutoSearchRequest { public Guid ItemId { get; set; } public string? InstanceName { get; set; } }
        public sealed class GrabRequest { public string? Service { get; set; } public string? InstanceName { get; set; } public string? Guid { get; set; } public int IndexerId { get; set; } }
        public sealed class MonitorRequest { public Guid ItemId { get; set; } public bool Monitored { get; set; } public string? InstanceName { get; set; } }
        public sealed class AddRequestBody
        {
            public Guid ItemId { get; set; }
            public string? InstanceName { get; set; }
            public int QualityProfileId { get; set; }
            public string? RootFolderPath { get; set; }
            public bool Monitored { get; set; } = true;
            public bool SearchOnAdd { get; set; } = true;
            public string? Monitor { get; set; }
            public string? MinimumAvailability { get; set; }
        }

        // ── context ──────────────────────────────────────────────────────────

        [HttpGet("arr/search/context")]
        public async Task<IActionResult> GetContext([FromQuery] Guid itemId)
        {
            var config = _configProvider.ConfigurationOrNull;
            if (config == null) return StatusCode(503, new { message = "Plugin configuration unavailable." });
            if (!config.ArrSearchEnabled) return Ok(new ArrContextDto());

            WarnIfArrInstancesCorrupt(config);
            var item = _resolver.Resolve(itemId);
            var dto = await _actions.BuildContextAsync(item, config, HttpContext.RequestAborted).ConfigureAwait(false);
            dto.CanManage = config.ArrSearchManageEnabled;
            return Ok(dto);
        }

        // ── automatic search ─────────────────────────────────────────────────

        [HttpPost("arr/search/auto")]
        public async Task<IActionResult> AutoSearch([FromBody] AutoSearchRequest body)
        {
            var config = RequireEnabled(out var error);
            if (config == null) return error!;

            var item = _resolver.Resolve(body.ItemId);
            if (item.Kind == ArrMediaKind.Unknown) return NotFound(new { message = "Item is not a movie, series, season or episode." });

            var result = await _actions.DispatchAutoSearchAsync(item, config, NullIfBlank(body.InstanceName), HttpContext.RequestAborted).ConfigureAwait(false);
            return Ok(result);
        }

        // ── interactive search ───────────────────────────────────────────────

        [HttpGet("arr/search/releases")]
        public async Task<IActionResult> GetReleases([FromQuery] Guid itemId, [FromQuery] string instanceName)
        {
            var config = RequireEnabled(out var error);
            if (config == null) return error!;
            if (string.IsNullOrWhiteSpace(instanceName)) return BadRequest(new { message = "instanceName is required." });

            var item = _resolver.Resolve(itemId);
            if (item.Kind == ArrMediaKind.Unknown) return NotFound(new { message = "Item is not a movie, series, season or episode." });

            var result = await _actions.ListReleasesAsync(item, config, instanceName, HttpContext.RequestAborted).ConfigureAwait(false);
            return Ok(result);
        }

        [HttpPost("arr/search/grab")]
        public async Task<IActionResult> Grab([FromBody] GrabRequest body)
        {
            var config = RequireEnabled(out var error);
            if (config == null) return error!;
            var service = NormalizeService(body.Service);
            if (service == null) return BadRequest(new { message = "service must be 'sonarr' or 'radarr'." });
            if (string.IsNullOrWhiteSpace(body.InstanceName) || string.IsNullOrWhiteSpace(body.Guid) || body.IndexerId <= 0)
                return BadRequest(new { message = "instanceName, guid and indexerId are required." });

            var (ok, grabError) = await _actions.GrabAsync(config, service, body.InstanceName!, body.Guid!, body.IndexerId, HttpContext.RequestAborted).ConfigureAwait(false);
            if (!ok) return StatusCode(502, new { ok = false, message = $"Grab failed: {grabError}" });
            return Ok(new { ok = true });
        }

        // ── monitor toggle (management gate) ─────────────────────────────────

        [HttpPost("arr/search/monitor")]
        public async Task<IActionResult> SetMonitored([FromBody] MonitorRequest body)
        {
            var config = RequireManage(out var error);
            if (config == null) return error!;

            var item = _resolver.Resolve(body.ItemId);
            if (item.Kind == ArrMediaKind.Unknown) return NotFound(new { message = "Item is not a movie, series, season or episode." });

            var result = await _actions.SetMonitoredAsync(item, config, body.Monitored, NullIfBlank(body.InstanceName), HttpContext.RequestAborted).ConfigureAwait(false);
            return Ok(result);
        }

        // ── add to arr (management gate) ─────────────────────────────────────

        [HttpGet("arr/search/add-options")]
        public async Task<IActionResult> GetAddOptions([FromQuery] string service, [FromQuery] string instanceName)
        {
            var config = RequireManage(out var error);
            if (config == null) return error!;
            var normalized = NormalizeService(service);
            if (normalized == null) return BadRequest(new { message = "service must be 'sonarr' or 'radarr'." });
            if (string.IsNullOrWhiteSpace(instanceName)) return BadRequest(new { message = "instanceName is required." });

            var result = await _actions.GetAddOptionsAsync(config, normalized, instanceName, HttpContext.RequestAborted).ConfigureAwait(false);
            return Ok(result);
        }

        [HttpPost("arr/search/add")]
        public async Task<IActionResult> Add([FromBody] AddRequestBody body)
        {
            var config = RequireManage(out var error);
            if (config == null) return error!;
            if (string.IsNullOrWhiteSpace(body.InstanceName)) return BadRequest(new { message = "instanceName is required." });
            if (string.IsNullOrWhiteSpace(body.RootFolderPath) || body.QualityProfileId <= 0)
                return BadRequest(new { message = "qualityProfileId and rootFolderPath are required." });

            var item = _resolver.Resolve(body.ItemId);
            if (item.Kind is not (ArrMediaKind.Movie or ArrMediaKind.Series))
                return NotFound(new { message = "Only a movie or series can be added." });

            var request = new ArrAddRequest(body.InstanceName!, body.QualityProfileId, body.RootFolderPath!, body.Monitored, body.SearchOnAdd, body.Monitor, body.MinimumAvailability);
            var (ok, addError, arrId) = await _actions.AddAsync(item, config, request, HttpContext.RequestAborted).ConfigureAwait(false);
            if (!ok) return StatusCode(502, new { ok = false, message = $"Add failed: {addError}" });
            return Ok(new { ok = true, arrId });
        }

        // ── queue status (feedback — shares the Downloads-page data source) ──

        [HttpGet("arr/search/status")]
        public async Task<IActionResult> GetStatus([FromQuery] Guid itemId)
        {
            var config = _configProvider.ConfigurationOrNull;
            if (config == null) return StatusCode(503, new { message = "Plugin configuration unavailable." });
            if (!config.ArrSearchEnabled) return Ok(new { items = Array.Empty<object>() });

            var item = _resolver.Resolve(itemId);
            var rows = await _actions.GetQueueStatusAsync(item, config, HttpContext.RequestAborted).ConfigureAwait(false);
            return Ok(new { items = rows });
        }

        // ── helpers ──────────────────────────────────────────────────────────

        private Configuration.PluginConfiguration? RequireEnabled(out IActionResult? error)
        {
            var config = _configProvider.ConfigurationOrNull;
            if (config == null) { error = StatusCode(503, new { message = "Plugin configuration unavailable." }); return null; }
            if (!config.ArrSearchEnabled) { error = NotFound(new { message = "arr Search is disabled." }); return null; }
            WarnIfArrInstancesCorrupt(config);
            error = null;
            return config;
        }

        private Configuration.PluginConfiguration? RequireManage(out IActionResult? error)
        {
            var config = RequireEnabled(out error);
            if (config == null) return null;
            if (!config.ArrSearchManageEnabled) { error = NotFound(new { message = "arr management actions are disabled." }); return null; }
            return config;
        }

        private static string? NormalizeService(string? service)
        {
            if (string.IsNullOrWhiteSpace(service)) return null;
            var s = service.Trim().ToLowerInvariant();
            return s is "sonarr" or "radarr" ? s : null;
        }

        private static string? NullIfBlank(string? value) => string.IsNullOrWhiteSpace(value) ? null : value;
    }
}
