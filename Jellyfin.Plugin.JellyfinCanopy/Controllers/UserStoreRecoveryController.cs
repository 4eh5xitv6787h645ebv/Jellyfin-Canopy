using System;
using System.IO;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using MediaBrowser.Common.Api;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Controllers
{
    /// <summary>
    /// Elevation-gated recovery surface for per-user JSON stores that have been
    /// quarantined by a strict read. It exposes metadata only, never payload bytes.
    /// </summary>
    [Route("JellyfinCanopy/admin/user-store-recovery")]
    [ApiController]
    [Authorize(Policy = Policies.RequiresElevation)]
    public sealed class UserStoreRecoveryController : ControllerBase
    {
        private readonly UserConfigurationManager _manager;
        private readonly ILogger<UserStoreRecoveryController> _logger;

        public UserStoreRecoveryController(
            UserConfigurationManager manager,
            ILogger<UserStoreRecoveryController> logger)
        {
            _manager = manager;
            _logger = logger;
        }

        [HttpGet]
        [Produces("application/json")]
        public IActionResult GetUnhealthyStores()
        {
            var stores = _manager.GetUnhealthyUserStores();
            return Ok(new
            {
                healthy = stores.Count == 0,
                stores,
                message = stores.Count == 0
                    ? "No per-user stores require recovery."
                    : "Retry alone cannot recover these stores. Inspect the named quarantine artifact, then explicitly reset the store or perform the documented offline repair."
            });
        }

        [HttpPost("{userId}/{fileName}/reset")]
        [Produces("application/json")]
        public IActionResult ResetUnhealthyStore(string userId, string fileName)
        {
            if ((!Guid.TryParse(userId, out var userGuid)
                    && !Guid.TryParseExact(userId, "N", out userGuid))
                || userGuid == Guid.Empty)
            {
                return BadRequest(new { success = false, message = "Invalid userId." });
            }

            var canonicalUserId = userGuid.ToString("N");
            try
            {
                if (!_manager.ResetUnhealthyUserStore(canonicalUserId, fileName))
                {
                    return NotFound(new
                    {
                        success = false,
                        message = "The requested per-user store is not in recovery state."
                    });
                }

                if (string.Equals(fileName, "hidden-content.json", StringComparison.Ordinal))
                {
                    HiddenContentResponseFilter.InvalidateUser(canonicalUserId);
                }
                else if (string.Equals(fileName, "spoilerblur.json", StringComparison.Ordinal))
                {
                    SpoilerUserResolver.InvalidateUser(canonicalUserId);
                    SpoilerUserResolver.ClearCorruption(canonicalUserId);
                }

                return Ok(new
                {
                    success = true,
                    userId = canonicalUserId,
                    file = fileName,
                    message = "The unhealthy marker was cleared after preserving forensic bytes. The next normal access will initialize defaults."
                });
            }
            catch (ArgumentException)
            {
                return BadRequest(new { success = false, message = "Unsupported per-user store filename." });
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidDataException or JsonException)
            {
                _logger.LogError(
                    ex,
                    "Failed to reset unhealthy per-user store {FileName} for {UserId}; the marker remains active.",
                    fileName,
                    canonicalUserId);
                return StatusCode(StatusCodes.Status503ServiceUnavailable, new
                {
                    success = false,
                    message = "The recovery reset could not be committed; the store remains quarantined."
                });
            }
        }
    }
}
