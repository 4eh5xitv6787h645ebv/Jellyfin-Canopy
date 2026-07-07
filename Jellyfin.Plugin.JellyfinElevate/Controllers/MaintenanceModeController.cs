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
using MediaBrowser.Common.Api;
using Jellyfin.Plugin.JellyfinElevate.Configuration;
using MediaBrowser.Controller;
using Jellyfin.Plugin.JellyfinElevate.Helpers;
using Jellyfin.Plugin.JellyfinElevate.Model.Jellyseerr;
using Jellyfin.Plugin.JellyfinElevate.Helpers.Jellyseerr;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model;
using MediaBrowser.Controller.Persistence;
using Jellyfin.Plugin.JellyfinElevate.Model.Arr;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Enums;
using Microsoft.EntityFrameworkCore;
using Jellyfin.Plugin.JellyfinElevate.Services.Jellyseerr;
using Jellyfin.Plugin.JellyfinElevate.Services;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinElevate.Controllers
{
    /// <summary>
    /// Maintenance mode status/enable/disable/users/broadcast.
    /// Split out of the former JellyfinElevateController; method bodies, routes
    /// and attributes are unchanged.
    /// </summary>
    [Route("JellyfinElevate")]
    [ApiController]
    public class MaintenanceModeController : JellyfinElevateControllerBase
    {
        private readonly MediaBrowser.Controller.Session.ISessionManager _sessionManager;
        private readonly Services.MaintenanceModeService _maintenanceModeService;

        public MaintenanceModeController(
            IHttpClientFactory httpClientFactory,
            ILogger<MaintenanceModeController> logger,
            IUserManager userManager,
            ISeerrCache seerrCache,
            IPluginConfigProvider configProvider,
            MediaBrowser.Controller.Session.ISessionManager sessionManager,
            Services.MaintenanceModeService maintenanceModeService)
            : base(httpClientFactory, logger, userManager, seerrCache, configProvider)
        {
            _sessionManager = sessionManager;
            _maintenanceModeService = maintenanceModeService;
        }

        // ── Maintenance Mode ────────────────────────────────────────────────────

        [Authorize(Policy = Policies.RequiresElevation)]
        [HttpGet("MaintenanceMode/Status")]
        public IActionResult GetMaintenanceStatus()
        {
            var state = _maintenanceModeService.GetStatus();
            return Ok(new
            {
                state.IsActive,
                state.Message,
                state.Action,
                state.StartedAt,
                state.EndsAt,
                AccountDisabledCount = state.AccountDisabledUserIds.Count,
                RemoteDisabledCount  = state.RemoteDisabledUserIds.Count
            });
        }

        [Authorize(Policy = Policies.RequiresElevation)]
        [HttpPost("MaintenanceMode/Enable")]
        public async Task<IActionResult> EnableMaintenanceMode([FromBody] MaintenanceModeRequest request)
        {
            await _maintenanceModeService.EnableAsync(
                request.Message ?? string.Empty,
                request.DurationMinutes,
                request.Action ?? "disable_accounts",
                request.AffectedUserIds).ConfigureAwait(false);
            return Ok(new { success = true });
        }

        [Authorize(Policy = Policies.RequiresElevation)]
        [HttpPost("MaintenanceMode/Disable")]
        public async Task<IActionResult> DisableMaintenanceMode()
        {
            await _maintenanceModeService.DisableAsync().ConfigureAwait(false);
            return Ok(new { success = true });
        }

        [Authorize(Policy = Policies.RequiresElevation)]
        [HttpGet("MaintenanceMode/Users")]
        public IActionResult GetMaintenanceModeUsers()
        {
            var users = _userManager.GetUsers()
                .Where(u => !u.HasPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.IsAdministrator))
                .Select(u => new { Id = u.Id.ToString(), u.Username })
                .OrderBy(u => u.Username)
                .ToList();
            return Ok(users);
        }

        [Authorize(Policy = Policies.RequiresElevation)]
        [HttpPost("MaintenanceMode/Broadcast")]
        public async Task<IActionResult> BroadcastMaintenanceMessage([FromBody] MaintenanceBroadcastRequest request)
        {
            if (request == null || string.IsNullOrWhiteSpace(request.Text))
                return BadRequest("Message text is required.");

            var controllingSessionId = string.Empty;
            try
            {
                var adminSession = _sessionManager.Sessions.FirstOrDefault(s => s.UserId == GetCurrentUserId());
                controllingSessionId = adminSession?.Id ?? string.Empty;
            }
            catch { /* non-fatal */ }

            var command = new MediaBrowser.Model.Session.MessageCommand
            {
                Header = request.Header ?? "Server Maintenance",
                Text = request.Text,
                TimeoutMs = request.TimeoutMs > 0 ? request.TimeoutMs : 30000
            };

            var sent = 0; var skipped = 0; var errors = new List<string>();
            foreach (var session in _sessionManager.Sessions)
            {
                if (string.IsNullOrWhiteSpace(session.UserName) ||
                    string.Equals(session.UserName, "Unknown", StringComparison.OrdinalIgnoreCase))
                { skipped++; continue; }
                try
                {
                    await _sessionManager.SendMessageCommand(controllingSessionId, session.Id, command, CancellationToken.None).ConfigureAwait(false);
                    sent++;
                }
                catch (Exception ex)
                {
                    skipped++;
                    errors.Add($"{session.UserName}: {ex.Message}");
                }
            }

            return Ok(new { sent, skipped, errors });
        }

        public class MaintenanceBroadcastRequest
        {
            public string? Header { get; set; }
            public string Text { get; set; } = string.Empty;
            public long TimeoutMs { get; set; } = 30000;
        }
    }

    public class MaintenanceModeRequest
    {
        public string? Message { get; set; }
        public int DurationMinutes { get; set; }
        /// <summary>"disable_accounts" | "disable_remote" | "both"</summary>
        public string Action { get; set; } = "disable_accounts";
        /// <summary>Specific user IDs to affect. Null or empty = all non-admin users.</summary>
        public List<string>? AffectedUserIds { get; set; }
    }
}
