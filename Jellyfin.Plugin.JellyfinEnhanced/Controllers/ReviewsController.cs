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

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>
    /// User reviews CRUD and admin review management.
    /// Split out of the former JellyfinEnhancedController; method bodies, routes
    /// and attributes are unchanged.
    /// </summary>
    [Route("JellyfinEnhanced")]
    [ApiController]
    public class ReviewsController : JellyfinEnhancedControllerBase
    {
        private readonly UserConfigurationManager _userConfigurationManager;

        public ReviewsController(
            IHttpClientFactory httpClientFactory,
            Logger logger,
            IUserManager userManager,
            ISeerrCache seerrCache,
            UserConfigurationManager userConfigurationManager)
            : base(httpClientFactory, logger, userManager, seerrCache)
        {
            _userConfigurationManager = userConfigurationManager;
        }

        // ─── User Reviews (shared reviews.json at plugin config root) ────────────

        public sealed class ReviewPayload
        {
            public string Content { get; set; } = string.Empty;
            public int? Rating { get; set; }
        }

        private static readonly System.Text.RegularExpressions.Regex _tmdbIdRegex =
            new System.Text.RegularExpressions.Regex(@"^\d+$", System.Text.RegularExpressions.RegexOptions.Compiled);

        // Extended key for season/episode reviews: {tmdbId}:s{n} or {tmdbId}:s{n}e{n}
        private static readonly System.Text.RegularExpressions.Regex _tmdbIdExtendedRegex =
            new System.Text.RegularExpressions.Regex(@"^\d+(:s\d+(:e\d+)?)?$", System.Text.RegularExpressions.RegexOptions.Compiled);

        private static bool IsValidTmdbKey(string tmdbId) =>
            !string.IsNullOrWhiteSpace(tmdbId) && _tmdbIdExtendedRegex.IsMatch(tmdbId);

        [HttpGet("reviews/{mediaType}/{tmdbId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetItemReviews(string mediaType, string tmdbId)
        {
            if (mediaType != "movie" && mediaType != "tv")
                return BadRequest(new { message = "MediaType must be 'movie' or 'tv'." });

            if (!IsValidTmdbKey(tmdbId))
                return BadRequest(new { message = "Invalid TmdbId." });

            var config = JellyfinEnhanced.Instance?.Configuration;
            var viewerIsAdmin = IsAdminUser();
            var hideHiddenAuthors = config?.HideReviewsFromHiddenUsers ?? true;
            var hideDisabledAuthors = config?.HideReviewsFromDisabledUsers ?? true;

            // Resolve the current viewer's "N"-format user id so we can
            // always show their OWN review back to them, even when the
            // viewer themselves is hidden/disabled in Jellyfin and the
            // hide filters would otherwise drop their author record.
            // Without this, a hidden non-admin user posting a review would
            // immediately lose visibility of their own content (issue 546).
            var viewerUserId = UserHelper.GetCurrentUserId(User);
            var viewerUserIdN = viewerUserId?.ToString("N");
            if (string.IsNullOrEmpty(viewerUserIdN))
            {
                // Anomalous: [Authorize] passed but the Jellyfin-UserId
                // claim is missing or unparseable. The self-review bypass
                // below will silently no-op, so warn here to give a
                // diagnostic trail if a hidden user reports the symptom
                // again with no obvious cause.
                _logger.Warning($"GetItemReviews: could not resolve viewer user id from claims on {mediaType}:{tmdbId}; self-review bypass disabled.");
            }

            var suffix = $":{mediaType}:{tmdbId}";
            var store = _userConfigurationManager.GetAllReviews();
            var results = new List<object>();

            foreach (var kvp in store.Reviews)
            {
                if (!kvp.Key.EndsWith(suffix, StringComparison.Ordinal)) continue;

                // Per-review try/catch: if anything blows up while looking up
                // the author or evaluating their permissions, we skip just
                // this review with a warning. Without this, a single corrupt
                // or orphaned record would 500 the entire GetItemReviews call
                // and hide every other review on the item.
                try
                {
                    var review = kvp.Value;

                    string displayName = review.UserId;
                    Jellyfin.Database.Implementations.Entities.User? jellyfinUser = null;
                    if (Guid.TryParseExact(review.UserId, "N", out var userGuid))
                    {
                        jellyfinUser = _userManager.GetUserById(userGuid);
                        if (jellyfinUser != null) displayName = jellyfinUser.Username;
                    }

                    // The viewer's own review is ALWAYS visible to themselves,
                    // regardless of admin status or hide filters. The hide
                    // filters exist to let admins moderate OTHER users'
                    // content, not to make a user's own writing invisible to
                    // them. Skipping the filter for self also prevents the
                    // confusing "I just posted, where did it go?" symptom
                    // when the viewer's own account has IsHidden set.
                    //
                    // Require jellyfinUser != null on the self-bypass so an
                    // orphaned-self record (auth token still resolves to a
                    // deleted user — Jellyfin doesn't universally invalidate
                    // tokens on user delete) still falls into the orphan
                    // hide path below instead of being served back with a
                    // raw-Guid display name.
                    var isOwnReview = jellyfinUser != null
                        && !string.IsNullOrEmpty(viewerUserIdN)
                        && string.Equals(review.UserId, viewerUserIdN, StringComparison.OrdinalIgnoreCase);

                    // Admin viewers always see every review so they can moderate.
                    if (!viewerIsAdmin && !isOwnReview)
                    {
                        // Orphaned authors (Jellyfin user was deleted) are
                        // hidden from non-admin viewers IF either hide toggle
                        // is on — fail CLOSED. Otherwise a deleted problem
                        // user's review would resurface for everyone. Admins
                        // still see them so orphans can be cleaned up.
                        if (jellyfinUser == null)
                        {
                            if (hideHiddenAuthors || hideDisabledAuthors)
                            {
                                _logger.Warning($"Hiding orphaned review for unknown userId={review.UserId} on {mediaType}:{tmdbId} from non-admin viewer.");
                                continue;
                            }
                        }
                        else
                        {
                            if (hideHiddenAuthors && jellyfinUser.HasPermission(PermissionKind.IsHidden))
                                continue;
                            if (hideDisabledAuthors && jellyfinUser.HasPermission(PermissionKind.IsDisabled))
                                continue;
                        }
                    }

                    results.Add(new
                    {
                        userId = review.UserId,
                        userName = displayName,
                        tmdbId = review.TmdbId,
                        mediaType = review.MediaType,
                        content = review.Content,
                        rating = review.Rating,
                        createdAt = review.CreatedAt,
                        updatedAt = review.UpdatedAt
                    });
                }
                catch (Exception ex)
                {
                    _logger.Warning($"Skipping review key={kvp.Key} due to filter error: {ex.Message}");
                }
            }

            return Ok(new { reviews = results });
        }

        [HttpPost("reviews/{mediaType}/{tmdbId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult UpsertReview(string mediaType, string tmdbId, [FromBody] ReviewPayload payload)
        {
            if (mediaType != "movie" && mediaType != "tv")
                return BadRequest(new { success = false, message = "MediaType must be 'movie' or 'tv'." });

            if (!IsValidTmdbKey(tmdbId))
                return BadRequest(new { success = false, message = "Invalid TmdbId." });

            if (payload == null)
                return BadRequest(new { success = false, message = "Invalid review payload." });

            var normalizedContent = payload.Content?.Trim() ?? string.Empty;

            if (string.IsNullOrWhiteSpace(normalizedContent) && !payload.Rating.HasValue)
                return BadRequest(new { success = false, message = "A rating or review text is required." });

            if (normalizedContent.Length > 2000)
                return BadRequest(new { success = false, message = "Review content must not exceed 2000 characters." });

            if (payload.Rating.HasValue && (payload.Rating.Value < 1 || payload.Rating.Value > 5))
                return BadRequest(new { success = false, message = "Rating must be between 1 and 5." });

            var currentUserId = UserHelper.GetCurrentUserId(User);
            if (!currentUserId.HasValue || currentUserId.Value == Guid.Empty) return Forbid();
            var userIdN = currentUserId.Value.ToString("N");

            try
            {
                var now = DateTime.UtcNow.ToString("o");
                _userConfigurationManager.UpsertReview(
                    userIdN, mediaType, tmdbId, normalizedContent, payload.Rating, now);
                _logger.Info($"Saved review for {mediaType}:{tmdbId} by user {ResolveUserDisplay(userIdN)}.");
                return Ok(new { success = true });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to save review for user {ResolveUserDisplay(userIdN)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save review." });
            }
        }

        [HttpPost("reviews/admin/{userIdN}/{mediaType}/{tmdbId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult AdminUpsertReview(string userIdN, string mediaType, string tmdbId, [FromBody] ReviewPayload payload)
        {
            if (!IsAdminUser())
                return Forbid();

            if (string.IsNullOrWhiteSpace(userIdN) || !Guid.TryParseExact(userIdN, "N", out _))
                return BadRequest(new { success = false, message = "Invalid userId (expected 32-char hex)." });

            if (mediaType != "movie" && mediaType != "tv")
                return BadRequest(new { success = false, message = "MediaType must be 'movie' or 'tv'." });

            if (!IsValidTmdbKey(tmdbId))
                return BadRequest(new { success = false, message = "Invalid TmdbId." });

            if (payload == null)
                return BadRequest(new { success = false, message = "Invalid review payload." });

            var normalizedContent = payload.Content?.Trim() ?? string.Empty;

            if (string.IsNullOrWhiteSpace(normalizedContent) && !payload.Rating.HasValue)
                return BadRequest(new { success = false, message = "A rating or review text is required." });

            if (normalizedContent.Length > 2000)
                return BadRequest(new { success = false, message = "Review content must not exceed 2000 characters." });

            if (payload.Rating.HasValue && (payload.Rating.Value < 1 || payload.Rating.Value > 5))
                return BadRequest(new { success = false, message = "Rating must be between 1 and 5." });

            try
            {
                var now = DateTime.UtcNow.ToString("o");
                _userConfigurationManager.UpsertReview(
                    userIdN, mediaType, tmdbId, normalizedContent, payload.Rating, now);
                _logger.Info($"Admin saved review for {mediaType}:{tmdbId} on behalf of {ResolveUserDisplay(userIdN)}.");
                return Ok(new { success = true });
            }
            catch (Exception ex)
            {
                _logger.Error($"Admin failed to save review for user {ResolveUserDisplay(userIdN)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save review." });
            }
        }

        [HttpDelete("reviews/{mediaType}/{tmdbId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult DeleteReview(string mediaType, string tmdbId)
        {
            if (mediaType != "movie" && mediaType != "tv")
                return BadRequest(new { success = false, message = "MediaType must be 'movie' or 'tv'." });

            if (!IsValidTmdbKey(tmdbId))
                return BadRequest(new { success = false, message = "Invalid TmdbId." });

            var currentUserId = UserHelper.GetCurrentUserId(User);
            if (!currentUserId.HasValue || currentUserId.Value == Guid.Empty) return Forbid();
            var userIdN = currentUserId.Value.ToString("N");

            try
            {
                if (_userConfigurationManager.DeleteReview(userIdN, mediaType, tmdbId))
                    _logger.Info($"Deleted review for {mediaType}:{tmdbId} by user {ResolveUserDisplay(userIdN)}.");
                return Ok(new { success = true });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to delete review for user {ResolveUserDisplay(userIdN)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to delete review." });
            }
        }

        [HttpDelete("reviews/admin/{userIdN}/{mediaType}/{tmdbId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult AdminDeleteReview(string userIdN, string mediaType, string tmdbId)
        {
            if (!IsAdminUser())
                return Forbid();

            if (mediaType != "movie" && mediaType != "tv")
                return BadRequest(new { success = false, message = "MediaType must be 'movie' or 'tv'." });

            if (!IsValidTmdbKey(tmdbId))
                return BadRequest(new { success = false, message = "Invalid TmdbId." });

            if (string.IsNullOrWhiteSpace(userIdN) || !Guid.TryParseExact(userIdN, "N", out _))
                return BadRequest(new { success = false, message = "Invalid userId (expected 32-char hex)." });

            try
            {
                var removed = _userConfigurationManager.DeleteReview(userIdN, mediaType, tmdbId);
                if (removed)
                {
                    _logger.Info($"Admin deleted review for {mediaType}:{tmdbId} by user {ResolveUserDisplay(userIdN)}.");
                    return Ok(new { success = true, removed = true });
                }
                // Fail explicitly: nothing to delete means the review was
                // already gone (race with a concurrent delete, wrong
                // userIdN, or a stale admin click). Returning 200 here
                // lets the frontend think it succeeded and refresh to a
                // list that looks the same as before.
                return NotFound(new { success = false, removed = false, message = "No matching review to delete." });
            }
            catch (Exception ex)
            {
                _logger.Error($"Admin failed to delete review for {mediaType}:{tmdbId} user {ResolveUserDisplay(userIdN)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to delete review." });
            }
        }
    }
}
