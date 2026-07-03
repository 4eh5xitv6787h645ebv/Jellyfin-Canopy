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
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Controller;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model;
using MediaBrowser.Controller.Persistence;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Enums;
using Microsoft.EntityFrameworkCore;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>
    /// Jellyseerr user endpoints (user-status, permission-audit, user list, import-users, watchlist sync, TV-season requests).
    /// Split out of the former JellyfinEnhancedController; method bodies, routes
    /// and attributes are unchanged.
    /// </summary>
    [Route("JellyfinEnhanced")]
    [ApiController]
    public class JellyseerrUserController : JellyfinEnhancedControllerBase
    {
        private readonly IUserDataManager _userDataManager;
        private readonly ILibraryManager _libraryManager;

        public JellyseerrUserController(
            IHttpClientFactory httpClientFactory,
            ILogger<JellyseerrUserController> logger,
            IUserManager userManager,
            ISeerrCache seerrCache,
            IPluginConfigProvider configProvider,
            IUserDataManager userDataManager,
            ILibraryManager libraryManager)
            : base(httpClientFactory, logger, userManager, seerrCache, configProvider)
        {
            _userDataManager = userDataManager;
            _libraryManager = libraryManager;
        }

        [HttpGet("jellyseerr/user-status")]
        [Authorize]
        public async Task<IActionResult> GetJellyseerrUserStatus()
        {
            // report a typed `reason` so the frontend can display
            // a meaningful banner instead of silently hiding discovery sections.
            // Possible reasons: disabled, no_user, blocked, unlinked, unreachable.
            var config = _configProvider.ConfigurationOrNull;
            if (config == null || !config.JellyseerrEnabled ||
                string.IsNullOrEmpty(config.JellyseerrApiKey) ||
                string.IsNullOrEmpty(config.JellyseerrUrls))
            {
                return Ok(new { active = false, userFound = false, reason = "disabled" });
            }

            var jellyfinUserId = UserHelper.GetCurrentUserId(User)?.ToString();
            if (string.IsNullOrEmpty(jellyfinUserId))
                return Ok(new { active = false, userFound = false, reason = "no_user" });

            if (IsJellyseerrImportBlocked(jellyfinUserId, config))
            {
                return Ok(new { active = true, userFound = false, reason = "blocked" });
            }

            // GetSeerrUserId uses the user ID cache (30-min TTL).
            // A successful user lookup implicitly proves Seerr is reachable.
            var jellyseerrUserId = await GetJellyseerrUserId(jellyfinUserId);
            if (!string.IsNullOrEmpty(jellyseerrUserId))
            {
                return Ok(new { active = true, userFound = true, jellyseerrUserId = jellyseerrUserId, reason = "linked" });
            }

            // User not found — could be server unreachable, HTML challenge from
            // proxy, or user genuinely not linked. Probe /status to distinguish
            // "unreachable" from "unlinked".
            var statusResult = await GetJellyseerrStatus() as OkObjectResult;
            bool active = false;
            if (statusResult?.Value is not null)
            {
                var json = System.Text.Json.JsonSerializer.Serialize(statusResult.Value);
                using var doc = JsonDocument.Parse(json);
                if (doc.RootElement.TryGetProperty("active", out var a))
                    active = a.GetBoolean();
            }
            return Ok(new
            {
                active,
                userFound = false,
                reason = active ? "unlinked" : "unreachable"
            });
        }

        [HttpGet("jellyseerr/permission-audit")]
        [Authorize]
        public async Task<IActionResult> GetPermissionAudit()
        {
            if (!IsAdminUser()) return Forbid();

            var config = _configProvider.ConfigurationOrNull;
            if (config == null || !config.JellyseerrEnabled ||
                string.IsNullOrEmpty(config.JellyseerrApiKey) ||
                string.IsNullOrEmpty(config.JellyseerrUrls))
                return StatusCode(503, "Seerr integration is not configured or enabled.");

            var jellyfinUsers = _userManager.GetUsers()
                .GroupBy(u => u.Id)
                .Select(g => g.First())
                .ToList();
            var results = new List<object>();

            foreach (var jfUser in jellyfinUsers)
            {
                var userId = jfUser.Id.ToString("N");
                // allowAutoImport: false — audit must be read-only and must not
                // create Seerr users as a side effect.
                var seerrUser = await GetJellyseerrUser(userId, bypassCache: true, allowAutoImport: false);

                if (seerrUser == null)
                {
                    // Null has 5 distinct causes: user genuinely unlinked, blocked
                    // by JE config, every Seerr URL HTTP-failed, every URL threw,
                    // or JSON shape mismatch. The UI renders them all as "Not
                    // linked", which misleads admins during transient Seerr
                    // outages. Leave a breadcrumb in the server log so the cause
                    // can be correlated with the preceding WARN/ERROR lines
                    // that GetJellyseerrUser already emits.
                    _logger.LogInformation($"[audit] user {jfUser.Username} ({userId}): GetJellyseerrUser returned null — see preceding log lines for cause");
                    results.Add(new
                    {
                        jellyfinUsername = jfUser.Username,
                        jellyfinUserId   = userId,
                        linked           = false,
                        permissions      = (int?)null,
                        issues           = new[] { "Not linked to a Seerr account" }
                    });
                    continue;
                }

                var perms = seerrUser.Permissions;
                bool isAdmin = JellyseerrPermissionHelper.HasPermission(perms, JellyseerrPermission.ADMIN);

                // Admins inherit all permissions — nothing to flag
                if (isAdmin)
                {
                    results.Add(new
                    {
                        jellyfinUsername = jfUser.Username,
                        jellyfinUserId   = userId,
                        linked           = true,
                        permissions      = (int)perms,
                        issues           = Array.Empty<string>()
                    });
                    continue;
                }

                var issues = new List<string>();

                // Search & request
                if (!JellyseerrPermissionHelper.HasAnyPermission(perms,
                    JellyseerrPermission.REQUEST | JellyseerrPermission.REQUEST_MOVIE | JellyseerrPermission.REQUEST_TV))
                    issues.Add("Cannot make requests (missing REQUEST / REQUEST_MOVIE / REQUEST_TV)");

                // 4K movie requests (only relevant if plugin has 4K enabled)
                if (config.JellyseerrEnable4KRequests &&
                    !JellyseerrPermissionHelper.HasAnyPermission(perms,
                        JellyseerrPermission.REQUEST_4K | JellyseerrPermission.REQUEST_4K_MOVIE))
                    issues.Add("Cannot request 4K movies (missing REQUEST_4K / REQUEST_4K_MOVIE)");

                // 4K TV requests
                if (config.JellyseerrEnable4KTvRequests &&
                    !JellyseerrPermissionHelper.HasAnyPermission(perms,
                        JellyseerrPermission.REQUEST_4K | JellyseerrPermission.REQUEST_4K_TV))
                    issues.Add("Cannot request 4K TV (missing REQUEST_4K / REQUEST_4K_TV)");

                // Advanced request options — only relevant if user can already make requests
                if (config.JellyseerrShowAdvanced)
                {
                    bool canRequest = JellyseerrPermissionHelper.HasAnyPermission(perms,
                        JellyseerrPermission.REQUEST | JellyseerrPermission.REQUEST_MOVIE | JellyseerrPermission.REQUEST_TV);
                    if (canRequest && !JellyseerrPermissionHelper.HasPermission(perms, JellyseerrPermission.REQUEST_ADVANCED))
                        issues.Add("Cannot use advanced request options (missing REQUEST_ADVANCED)");
                }

                // Requests page / view — without REQUEST_VIEW they only see their own requests
                if (config.DownloadsPageEnabled &&
                    !JellyseerrPermissionHelper.HasAnyPermission(perms,
                        JellyseerrPermission.REQUEST_VIEW | JellyseerrPermission.MANAGE_REQUESTS))
                    issues.Add("Can only see own requests on Requests page (missing REQUEST_VIEW / MANAGE_REQUESTS) (Can be ignored if on purpose)");

                // Report issues — MANAGE_ISSUES implies CREATE_ISSUES
                if (config.JellyseerrShowReportButton &&
                    !JellyseerrPermissionHelper.HasAnyPermission(perms,
                        JellyseerrPermission.CREATE_ISSUES | JellyseerrPermission.MANAGE_ISSUES))
                    issues.Add("Cannot report issues (missing CREATE_ISSUES or MANAGE_ISSUES)");

                // View issues indicator — MANAGE_ISSUES implies VIEW_ISSUES
                if (config.JellyseerrShowIssueIndicator &&
                    !JellyseerrPermissionHelper.HasAnyPermission(perms,
                        JellyseerrPermission.VIEW_ISSUES | JellyseerrPermission.MANAGE_ISSUES))
                    issues.Add("Cannot view issues from others or count indicator (missing VIEW_ISSUES or MANAGE_ISSUES)");


                results.Add(new
                {
                    jellyfinUsername = jfUser.Username,
                    jellyfinUserId   = userId,
                    linked           = true,
                    permissions      = (int)perms,
                    issues
                });
            }

            return Ok(results);
        }

        [HttpGet("jellyseerr/user")]
        [Authorize]
        public Task<IActionResult> GetJellyseerrUsers([FromQuery] int take = 1000)
        {
            // Admin-only: this proxies Seerr's full user list, which includes
            // every Seerr user's email, username, plexUsername, permissions,
            // and userType. Without this gate any authenticated Jellyfin user
            // could harvest the entire Seerr roster.
            if (!IsAdminUser())
            {
                return Task.FromResult<IActionResult>(Forbid());
            }
            return ProxyJellyseerrRequest($"/api/v1/user?take={take}", HttpMethod.Get);
        }

        [HttpPost("jellyseerr/request/tv/{tmdbId}/seasons")]
        [Authorize]
        public async Task<IActionResult> RequestTvSeasons(int tmdbId, [FromBody] JsonElement requestBody)
        {
            // enforce that the body's mediaType
            // is "tv" and the body's mediaId matches the route's tmdbId, so
            // logging/audit trails are consistent and a user with REQUEST_TV
            // (but not REQUEST_MOVIE) can't piggyback a movie request through
            // this route. Seerr would re-validate but JE's permission gate at
            // line ~620 only sees apiPath="/api/v1/request".
            if (tmdbId <= 0)
            {
                return BadRequest(new { error = true, code = "invalid_tmdb_id", message = "TMDB id must be positive." });
            }
            try
            {
                if (requestBody.TryGetProperty("mediaType", out var mtEl)
                    && mtEl.ValueKind == JsonValueKind.String
                    && !string.Equals(mtEl.GetString(), "tv", StringComparison.OrdinalIgnoreCase))
                {
                    return BadRequest(new { error = true, code = "media_type_mismatch", message = "Body mediaType must be 'tv' on the seasons route." });
                }
                if (requestBody.TryGetProperty("mediaId", out var midEl) && midEl.ValueKind == JsonValueKind.Number)
                {
                    if (midEl.GetInt32() != tmdbId)
                    {
                        return BadRequest(new { error = true, code = "media_id_mismatch", message = "Body mediaId must match the {tmdbId} in the URL." });
                    }
                }
            }
            catch (InvalidOperationException)
            {
                // requestBody not a JSON object — let downstream Seerr return its own validation error.
            }
            return await ProxyJellyseerrRequest($"/api/v1/request", HttpMethod.Post, requestBody.ToString());
        }

        [HttpGet("jellyseerr/watchlist")]
        [Authorize]
        public Task<IActionResult> GetJellyseerrWatchlist([FromQuery] int page = 1)
        {
            // Bug discovered live in round-1 e2e: previous endpoint `/api/v1/user/watchlist`
            // returns 400 from Seerr (`request.params.userId should be number`) —
            // Seerr's user-watchlist endpoint expects the userId in the URL path.
            // The discover endpoint reads X-Api-User from the proxy header instead,
            // returning the same shape and matching how the rest of JE's discovery
            // calls work.
            if (page < 1) page = 1;
            return ProxyJellyseerrRequest($"/api/v1/discover/watchlist?page={page}", HttpMethod.Get);
        }

        [HttpPost("jellyseerr/sync-watchlist")]
        [Authorize]
        public async Task<IActionResult> SyncJellyseerrWatchlist()
        {
            if (!IsAdminUser())
            {
                return Forbid();
            }

            try
            {
                var config = _configProvider.ConfigurationOrNull;
                if (config == null || !config.JellyseerrEnabled || !config.SyncJellyseerrWatchlist)
                {
                    return BadRequest(new { error = "Jellyseerr watchlist sync is not enabled" });
                }

                _logger.LogInformation("[Manual Watchlist Sync] Starting manual Seerr watchlist sync...");

                int itemsProcessed = 0;
                int itemsAdded = 0;
                var errors = new List<string>();

                foreach (var user in _userManager.GetUsers())
                {
                    try
                    {
                        _logger.LogInformation($"[Manual Watchlist Sync] Processing user: {user.Username} ({user.Id})");

                        // Get Seerr user ID for this Jellyfin user
                        var jellyseerrUserId = await GetJellyseerrUserId(user.Id.ToString());
                        if (string.IsNullOrEmpty(jellyseerrUserId))
                        {
                            _logger.LogWarning($"[Manual Watchlist Sync] Could not find Seerr user for {user.Username}");
                            continue;
                        }

                        // Get watchlist from Seerr
                        var watchlistItems = await GetJellyseerrWatchlistForUser(jellyseerrUserId);
                        if (watchlistItems == null || watchlistItems.Count == 0)
                        {
                            _logger.LogInformation($"[Manual Watchlist Sync] No watchlist items found for {user.Username}");
                            watchlistItems = new List<WatchlistItem>();
                        }

                        _logger.LogInformation($"[Manual Watchlist Sync] Found {watchlistItems.Count} watchlist items for {user.Username}");

                        var requestItems = await GetJellyseerrRequestsForUser(jellyseerrUserId);
                        if (requestItems != null && requestItems.Count > 0)
                        {
                            _logger.LogInformation($"[Manual Watchlist Sync] Found {requestItems.Count} request items for {user.Username}");
                            watchlistItems.AddRange(requestItems);
                        }

                        var processedKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

                        // Process each watchlist item
                        foreach (var item in watchlistItems)
                        {
                            itemsProcessed++;

                            var key = $"{item.MediaType}:{item.TmdbId}";
                            if (!processedKeys.Add(key))
                            {
                                continue;
                            }

                            // Find the item in Jellyfin library by TMDB ID
                            var libraryItem = FindItemByTmdbId(item.TmdbId, item.MediaType);
                            if (libraryItem != null)
                            {
                                var userData = _userDataManager.GetUserData(user, libraryItem);
                                if (userData == null)
                                {
                                    _logger.LogWarning($"[Manual Watchlist Sync] User data was null for '{libraryItem.Name}' and user {user.Username}; skipping.");
                                }
                                else if (userData.Likes != true)
                                {
                                    userData.Likes = true;
                                    _userDataManager.SaveUserData(user, libraryItem, userData, UserDataSaveReason.UpdateUserRating, default);
                                    itemsAdded++;
                                    _logger.LogInformation($"[Manual Watchlist Sync] Added '{libraryItem.Name}' to watchlist for {user.Username}");
                                }
                            }
                            else
                            {
                                // Item not in library yet - WatchlistMonitor will automatically add it when it arrives
                                _logger.LogDebug($"[Manual Watchlist Sync] Item TMDB {item.TmdbId} ({item.MediaType}) not in library yet for {user.Username} - will be auto-added by WatchlistMonitor when available");
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError($"[Manual Watchlist Sync] Error processing user {user.Username}: {ex.Message}");
                        errors.Add("Failed to sync watchlist for a user.");
                    }
                }

                _logger.LogInformation($"[Manual Watchlist Sync] Sync complete. Processed: {itemsProcessed}, Added: {itemsAdded}");

                return Ok(new
                {
                    success = true,
                    itemsProcessed,
                    itemsAdded,
                    errors = errors.Count > 0 ? errors : null
                });
            }
            catch (Exception ex)
            {
                _logger.LogError($"[Manual Watchlist Sync] Fatal error: {ex}");
                return StatusCode(500, new { error = "An internal error occurred during watchlist sync." });
            }
        }

        [HttpPost("jellyseerr/import-users")]
        [Authorize]
        public async Task<IActionResult> ImportJellyseerrUsers()
        {
            if (!IsAdminUser())
            {
                return Forbid();
            }

            try
            {
                var config = _configProvider.ConfigurationOrNull;
                if (config == null || !config.JellyseerrEnabled)
                {
                    return BadRequest(new { error = "Jellyseerr integration is not enabled" });
                }

                if (string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.JellyseerrApiKey))
                {
                    return BadRequest(new { error = "Jellyseerr URL or API key not configured" });
                }

                // Claim the throttle slot atomically to prevent concurrent imports
                lock (_seerrCache.ImportThrottleLock)
                {
                    if ((DateTime.UtcNow - _seerrCache.LastManualImport).TotalSeconds < 30)
                    {
                        return StatusCode(429, new { error = "Import was run recently. Please wait before retrying." });
                    }

                    _seerrCache.LastManualImport = DateTime.UtcNow;
                }

                _logger.LogInformation("[Manual User Import] Starting manual Jellyseerr user import...");

                var urls = config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
                var blockedIds = Helpers.Jellyseerr.JellyseerrUserImportHelper.GetBlockedUserIds(config.JellyseerrImportBlockedUsers);
                var userIds = _userManager.GetUsers()
                    .Select(u => u.Id.ToString().Replace("-", ""))
                    .Where(id => !blockedIds.Contains(id))
                    .ToList();
                _logger.LogInformation($"[Manual User Import] Importing {userIds.Count} Jellyfin users...");

                var importResult = await Helpers.Jellyseerr.JellyseerrUserImportHelper.BulkImportAsync(
                    userIds, urls, config.JellyseerrApiKey, _httpClientFactory, _logger);

                // only flush user caches when at least one user
                // was actually imported. Previously a 0-imported "success" (all
                // email-collisioned) would wipe every healthy cache entry,
                // forcing a stampede on next request.
                if (importResult.Reached && importResult.Imported > 0)
                {
                    _seerrCache.ClearUserCaches();
                }

                // Reset the throttle slot when nothing was imported AND we got
                // any kind of error, so the admin can fix Seerr-side issues
                // and retry without waiting 30s.
                if (importResult.Imported == 0 && importResult.Errors.Count > 0)
                {
                    lock (_seerrCache.ImportThrottleLock)
                    {
                        _seerrCache.LastManualImport = DateTime.MinValue;
                    }
                }

                if (importResult.Reached)
                {
                    _logger.LogInformation($"[Manual User Import] Completed. {importResult.Imported} new user(s) imported out of {userIds.Count} sent. Errors: {importResult.Errors.Count}");
                    return Ok(new
                    {
                        success = true,
                        usersImported = importResult.Imported,
                        totalUsers = userIds.Count,
                        errors = importResult.Errors,
                    });
                }
                else
                {
                    return StatusCode(502, new
                    {
                        error = "Import failed on all configured Jellyseerr URLs.",
                        errors = importResult.Errors,
                    });
                }
            }
            catch (HttpRequestException ex)
            {
                _logger.LogError($"[Manual User Import] Connection error: {ex.Message}");
                return StatusCode(502, new { error = "Failed to connect to Jellyseerr. Check server logs for details." });
            }
            catch (JsonException ex)
            {
                _logger.LogError($"[Manual User Import] Invalid Jellyseerr response: {ex.Message}");
                return StatusCode(502, new { error = "Invalid response from Jellyseerr. Check server logs for details." });
            }
        }

        private BaseItem? FindItemByTmdbId(int tmdbId, string mediaType)
        {
            var query = new InternalItemsQuery
            {
                HasTmdbId = true,
                IncludeItemTypes = mediaType == "tv" ? new[] { Jellyfin.Data.Enums.BaseItemKind.Series } : new[] { Jellyfin.Data.Enums.BaseItemKind.Movie }
            };

            var items = _libraryManager.GetItemList(query);
            return items.FirstOrDefault(i =>
            {
                if (i.ProviderIds != null && i.ProviderIds.TryGetValue("Tmdb", out var tmdbIdStr))
                {
                    return tmdbIdStr == tmdbId.ToString();
                }
                return false;
            });
        }
    }
}
