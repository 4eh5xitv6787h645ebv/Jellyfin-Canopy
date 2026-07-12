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
using MediaBrowser.Common.Api;

namespace Jellyfin.Plugin.JellyfinCanopy.Controllers
{
    /// <summary>
    /// Active stream sessions and admin broadcast messages.
    /// Split out of the former JellyfinCanopyController; method bodies, routes
    /// and attributes are unchanged.
    /// </summary>
    [Route("JellyfinCanopy")]
    [ApiController]
    public class ActiveStreamsController : JellyfinCanopyControllerBase
    {
        private readonly MediaBrowser.Controller.Session.ISessionManager _sessionManager;

        public ActiveStreamsController(
            IHttpClientFactory httpClientFactory,
            ILogger<ActiveStreamsController> logger,
            IUserManager userManager,
            ISeerrCache seerrCache,
            IPluginConfigProvider configProvider,
            MediaBrowser.Controller.Session.ISessionManager sessionManager)
            : base(httpClientFactory, logger, userManager, seerrCache, configProvider)
        {
            _sessionManager = sessionManager;
        }

        // ==================== Active Streams ====================

        [HttpGet("active-streams/sessions")]
        [Authorize]
        public IActionResult GetActiveSessions()
        {
            var config = _configProvider.ConfigurationOrNull;
            if (config == null || !config.ActiveStreamsEnabled)
                return StatusCode(503, "Active Streams is not enabled.");

            // Non-admins only allowed if ActiveStreamsAllUsers is on
            if (!IsAdminUser() && !config.ActiveStreamsAllUsers)
                return Forbid();

            var isAdmin = IsAdminUser();

            try
            {
                var sessions = _sessionManager.Sessions
                    .Where(s => s.NowPlayingItem != null)
                    .Select(s => new
                    {
                        // Session id — needed to target the per-session stop /
                        // message actions, which are admin-only. Non-admins get
                        // null (defence in depth: they have no controls, so no
                        // reason to hand them a session-targeting handle). The
                        // client falls back to a non-sensitive composite key for
                        // live-update matching.
                        Id = isAdmin ? s.Id : null,
                        UserId = s.UserId,
                        UserName = s.UserName,
                        Client = s.Client,
                        DeviceName = s.DeviceName,
                        // Whether the client can be remote-controlled (stop /
                        // targeted message). The client hides the action buttons
                        // when false so admins aren't offered a no-op.
                        SupportsRemoteControl = s.SupportsRemoteControl,
                        // IP only for admins
                        RemoteEndPoint = isAdmin ? s.RemoteEndPoint : null,
                        LastActivityDate = s.LastActivityDate,
                        NowPlayingItem = s.NowPlayingItem == null ? null : new
                        {
                            Id = s.NowPlayingItem.Id.ToString("N"),
                            Type = s.NowPlayingItem.Type.ToString(),
                            s.NowPlayingItem.Name,
                            s.NowPlayingItem.SeriesName,
                            s.NowPlayingItem.RunTimeTicks,
                            s.NowPlayingItem.ProductionYear,
                            ParentIndexNumber = s.NowPlayingItem.ParentIndexNumber,
                            IndexNumber = s.NowPlayingItem.IndexNumber,
                            ImageTags = s.NowPlayingItem.ImageTags != null
                                ? s.NowPlayingItem.ImageTags.ToDictionary(kv => kv.Key.ToString(), kv => kv.Value)
                                : null,
                            SeriesId = s.NowPlayingItem.SeriesId?.ToString("N"),
                            SeriesPrimaryImageTag = s.NowPlayingItem.SeriesPrimaryImageTag,
                            MediaStreams = s.NowPlayingItem.MediaStreams?.Select(ms => new
                            {
                                ms.Type,
                                ms.Codec,
                                ms.BitRate
                            })
                        },
                        PlayState = s.PlayState == null ? null : new
                        {
                            s.PlayState.IsPaused,
                            s.PlayState.PositionTicks,
                            s.PlayState.PlayMethod
                        },
                        TranscodingInfo = s.TranscodingInfo == null ? null : new
                        {
                            s.TranscodingInfo.IsVideoDirect,
                            s.TranscodingInfo.VideoCodec,
                            s.TranscodingInfo.AudioCodec,
                            s.TranscodingInfo.Bitrate,
                            s.TranscodingInfo.TranscodeReasons,
                            s.TranscodingInfo.CompletionPercentage,
                            s.TranscodingInfo.Width,
                            s.TranscodingInfo.Height,
                            s.TranscodingInfo.Framerate
                        }
                    });

                return Ok(sessions.ToList());
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to get active sessions: {ex.Message}");
                return StatusCode(500, "Failed to retrieve sessions.");
            }
        }

        // ==================== Session Control (admin-only) ====================

        /// <summary>
        /// Stop playback on a single session (the 396-vote "kill a stream"
        /// action). Admin-gated at the policy level; sends a Stop playstate
        /// command via the same core path the native dashboard uses.
        /// </summary>
        [HttpPost("active-streams/sessions/{sessionId}/stop")]
        [Authorize(Policy = Policies.RequiresElevation)]
        public async Task<IActionResult> StopSession([FromRoute] string sessionId)
        {
            if (string.IsNullOrWhiteSpace(sessionId))
                return BadRequest("Session id is required.");

            var config = _configProvider.ConfigurationOrNull;
            if (config == null || !config.ActiveStreamsEnabled)
                return StatusCode(503, "Active Streams is not enabled.");

            var target = _sessionManager.Sessions.FirstOrDefault(s => s.Id == sessionId);
            if (target == null)
                return NotFound("Session not found.");

            try
            {
                await _sessionManager.SendPlaystateCommand(
                    GetControllingSessionId(),
                    sessionId,
                    new MediaBrowser.Model.Session.PlaystateRequest
                    {
                        Command = MediaBrowser.Model.Session.PlaystateCommand.Stop
                    },
                    CancellationToken.None).ConfigureAwait(false);
                return Ok(new { stopped = true });
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"Stop session {sessionId} failed: {ex.Message}");
                return StatusCode(502, "Failed to stop the session.");
            }
        }

        /// <summary>
        /// Send a message to a single session (targeted, unlike the broadcast).
        /// </summary>
        [HttpPost("active-streams/sessions/{sessionId}/message")]
        [Authorize(Policy = Policies.RequiresElevation)]
        public async Task<IActionResult> MessageSession([FromRoute] string sessionId, [FromBody] BroadcastMessageRequest request)
        {
            if (string.IsNullOrWhiteSpace(sessionId))
                return BadRequest("Session id is required.");
            if (request == null || string.IsNullOrWhiteSpace(request.Text))
                return BadRequest("Message text is required.");

            var config = _configProvider.ConfigurationOrNull;
            if (config == null || !config.ActiveStreamsEnabled)
                return StatusCode(503, "Active Streams is not enabled.");

            var target = _sessionManager.Sessions.FirstOrDefault(s => s.Id == sessionId);
            if (target == null)
                return NotFound("Session not found.");

            try
            {
                await _sessionManager.SendMessageCommand(
                    GetControllingSessionId(),
                    sessionId,
                    new MediaBrowser.Model.Session.MessageCommand
                    {
                        Header = request.Header,
                        Text = request.Text,
                        TimeoutMs = request.TimeoutMs
                    },
                    CancellationToken.None).ConfigureAwait(false);
                return Ok(new { sent = true });
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"Message session {sessionId} failed: {ex.Message}");
                return StatusCode(502, "Failed to message the session.");
            }
        }

        // The admin's own session drives the control commands (matches the
        // native dashboard's controlling-session semantics). An empty string is
        // accepted by the core when the admin's session can't be resolved.
        private string GetControllingSessionId()
        {
            try
            {
                var adminSession = _sessionManager.Sessions
                    .FirstOrDefault(s => s.UserId == GetCurrentUserId());
                return adminSession?.Id ?? string.Empty;
            }
            catch
            {
                return string.Empty;
            }
        }

        [HttpPost("active-streams/broadcast")]
        [Authorize(Policy = Policies.RequiresElevation)]
        public async Task<IActionResult> BroadcastMessage([FromBody] BroadcastMessageRequest request)
        {
            if (request == null || string.IsNullOrWhiteSpace(request.Text))
                return BadRequest("Message text is required.");

            var config = _configProvider.ConfigurationOrNull;
            if (config == null || !config.ActiveStreamsEnabled)
                return StatusCode(503, "Active Streams is not enabled.");

            var sent = 0;
            var skipped = 0;
            var errors = new List<string>();

            // Use the current session as the controlling session (admin's own session)
            var controllingSessionId = GetControllingSessionId();

            var command = new MediaBrowser.Model.Session.MessageCommand
            {
                Header = request.Header,
                Text = request.Text,
                TimeoutMs = request.TimeoutMs
            };

            foreach (var session in _sessionManager.Sessions)
            {
                // Skip sessions with no real user
                if (string.IsNullOrWhiteSpace(session.UserName) ||
                    string.Equals(session.UserName, "Unknown", StringComparison.OrdinalIgnoreCase))
                {
                    skipped++;
                    continue;
                }

                try
                {
                    await _sessionManager.SendMessageCommand(
                        controllingSessionId,
                        session.Id,
                        command,
                        CancellationToken.None).ConfigureAwait(false);
                    sent++;
                }
                catch (Exception ex)
                {
                    _logger.LogWarning($"Broadcast: failed to send to session {session.Id} ({session.UserName}): {ex.Message}");
                    errors.Add($"{session.UserName}: {ex.Message}");
                    skipped++;
                }
            }

            return Ok(new { sent, skipped, errors });
        }
    }

    public class BroadcastMessageRequest
    {
        public string? Header { get; set; }

        public string Text { get; set; } = string.Empty;

        public long? TimeoutMs { get; set; }
    }
}
