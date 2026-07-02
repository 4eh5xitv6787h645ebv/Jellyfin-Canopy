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
using Jellyfin.Plugin.JellyfinEnhanced.Services;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>
    /// Active stream sessions and admin broadcast messages.
    /// Split out of the former JellyfinEnhancedController; method bodies, routes
    /// and attributes are unchanged.
    /// </summary>
    [Route("JellyfinEnhanced")]
    [ApiController]
    public class ActiveStreamsController : JellyfinEnhancedControllerBase
    {
        private readonly MediaBrowser.Controller.Session.ISessionManager _sessionManager;

        public ActiveStreamsController(
            IHttpClientFactory httpClientFactory,
            Logger logger,
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
                        UserId = s.UserId,
                        UserName = s.UserName,
                        Client = s.Client,
                        DeviceName = s.DeviceName,
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
                _logger.Error($"Failed to get active sessions: {ex.Message}");
                return StatusCode(500, "Failed to retrieve sessions.");
            }
        }

        [HttpPost("active-streams/broadcast")]
        [Authorize]
        public async Task<IActionResult> BroadcastMessage([FromBody] BroadcastMessageRequest request)
        {
            if (!IsAdminUser())
                return Forbid();

            if (request == null || string.IsNullOrWhiteSpace(request.Text))
                return BadRequest("Message text is required.");

            var config = _configProvider.ConfigurationOrNull;
            if (config == null || !config.ActiveStreamsEnabled)
                return StatusCode(503, "Active Streams is not enabled.");

            var sent = 0;
            var skipped = 0;
            var errors = new List<string>();

            // Use the current session as the controlling session (admin's own session)
            var controllingSessionId = string.Empty;
            try
            {
                var adminSession = _sessionManager.Sessions
                    .FirstOrDefault(s => s.UserId == GetCurrentUserId());
                controllingSessionId = adminSession?.Id ?? string.Empty;
            }
            catch { /* non-fatal — empty string is accepted */ }

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
                    _logger.Warning($"Broadcast: failed to send to session {session.Id} ({session.UserName}): {ex.Message}");
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
