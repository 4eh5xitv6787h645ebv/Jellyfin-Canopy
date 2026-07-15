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
using Jellyfin.Plugin.JellyfinCanopy.ScheduledTasks;
using Microsoft.Extensions.Logging;
using MediaBrowser.Common.Api;

namespace Jellyfin.Plugin.JellyfinCanopy.Controllers
{
    /// <summary>
    /// Seerr user endpoints (user-status, permission-audit, user list, import-users, watchlist sync, TV-season requests).
    /// Split out of the former JellyfinCanopyController; method bodies, routes
    /// and attributes are unchanged.
    /// </summary>
    [Route("JellyfinCanopy")]
    [ApiController]
    public class SeerrUserController : JellyfinCanopyControllerBase
    {
        private readonly IUserDataManager _userDataManager;
        private readonly ILibraryManager _libraryManager;

        private readonly ISeerrClient _seerr;

        public SeerrUserController(
            IHttpClientFactory httpClientFactory,
            ILogger<SeerrUserController> logger,
            IUserManager userManager,
            ISeerrCache seerrCache,
            IPluginConfigProvider configProvider,
            IUserDataManager userDataManager,
            ILibraryManager libraryManager,
            ISeerrClient seerr)
            : base(httpClientFactory, logger, userManager, seerrCache, configProvider)
        {
            _userDataManager = userDataManager;
            _libraryManager = libraryManager;
            _seerr = seerr;
        }

        // Thin delegation kept so the proxy endpoints below read unchanged.
        private Task<IActionResult> ProxySeerrRequest(string apiPath, HttpMethod method, string? content = null)
            => _seerr.ProxyRequestAsync(
                apiPath,
                method,
                content,
                SeerrCaller(),
                HttpContext.RequestAborted);

        [HttpGet("seerr/user-status")]
        [Authorize]
        public async Task<IActionResult> GetSeerrUserStatus()
        {
            // report a typed `reason` so the frontend can display
            // a meaningful banner instead of silently hiding discovery sections.
            // Possible reasons: disabled, no_user, blocked, unlinked, unreachable.
            var integration = SeerrIntegrationPolicy.Capture(_configProvider);
            if (!integration.IsActive)
            {
                return Ok(new { active = false, userFound = false, reason = "disabled" });
            }

            var config = integration.Configuration!;

            var jellyfinUserId = UserHelper.GetCurrentUserId(User)?.ToString();
            if (string.IsNullOrEmpty(jellyfinUserId))
                return Ok(new { active = false, userFound = false, reason = "no_user" });

            if (_seerr.IsImportBlocked(jellyfinUserId, config))
            {
                return Ok(new { active = true, userFound = false, reason = "blocked" });
            }

            var resolution = await _seerr.ResolveSeerrUser(
                jellyfinUserId,
                cancellationToken: HttpContext.RequestAborted).ConfigureAwait(false);
            if (!integration.IsCurrent(_configProvider))
            {
                return Ok(new { active = false, userFound = false, reason = "disabled" });
            }

            if (resolution.IsFound)
            {
                var seerrUserId = resolution.User!.Id.ToString();
                // Surface the 4K capability so the client can gate its 4K request
                // UI on Seerr actually having 4K enabled AND this user holding the
                // 4K permission (degrade-by-hiding), rather than on the admin
                // toggle alone.
                var cap = await _seerr.GetSeerr4kCapabilityAsync(jellyfinUserId, IsAdminUser());
                if (!integration.IsCurrent(_configProvider))
                {
                    return Ok(new { active = false, userFound = false, reason = "disabled" });
                }

                return Ok(new
                {
                    active = true,
                    userFound = true,
                    seerrUserId = seerrUserId,
                    reason = "linked",
                    movie4kEnabled = cap.Movie4kEnabled,
                    series4kEnabled = cap.Series4kEnabled,
                    canRequest4kMovie = cap.CanRequest4kMovie,
                    canRequest4kTv = cap.CanRequest4kTv
                });
            }

            if (resolution.Status == SeerrUserResolutionStatus.Incomplete)
            {
                return StatusCode(502, new
                {
                    error = true,
                    active = false,
                    userFound = false,
                    reason = "incomplete",
                    code = "user_lookup_incomplete",
                    message = "Seerr returned an incomplete user collection. Please try again."
                });
            }

            if (resolution.Status == SeerrUserResolutionStatus.Unavailable)
            {
                return StatusCode(503, new
                {
                    error = true,
                    active = false,
                    userFound = false,
                    reason = "unavailable",
                });
            }

            return Ok(new
            {
                active = true,
                userFound = false,
                reason = resolution.Status == SeerrUserResolutionStatus.Blocked ? "blocked" : "unlinked"
            });
        }

        [HttpGet("seerr/permission-audit")]
        [Authorize(Policy = Policies.RequiresElevation)]
        public async Task<IActionResult> GetPermissionAudit()
        {
            var integration = SeerrIntegrationPolicy.Capture(_configProvider);
            if (!integration.IsActive || integration.Configuration == null)
            {
                return StatusCode(503, new
                {
                    error = true,
                    active = false,
                    code = "seerr_disabled",
                    message = "Seerr integration is not configured or enabled. No permission audit was published."
                });
            }

            var config = integration.Configuration;
            var auditConfigStamp = SeerrMutationConfigStamp.Capture(
                config,
                integration.ConfigurationRevision);

            bool AuditIsCurrent()
            {
                try
                {
                    return integration.IsCurrent(_configProvider)
                        && auditConfigStamp.Matches(
                            _configProvider.ConfigurationOrNull,
                            _configProvider.ConfigurationRevision);
                }
                catch
                {
                    return false;
                }
            }

            IActionResult ConfigurationChanged()
            {
                var current = SeerrIntegrationPolicy.Capture(_configProvider);
                if (!current.IsActive)
                {
                    return StatusCode(503, new
                    {
                        error = true,
                        active = false,
                        code = "seerr_disabled",
                        message = "Seerr integration was disabled while preparing the audit. No partial permission audit was published."
                    });
                }

                return Conflict(new
                {
                    error = true,
                    active = false,
                    code = "audit_configuration_changed",
                    message = "Seerr configuration changed while preparing the audit. No partial permission audit was published."
                });
            }

            var jellyfinUsers = _userManager.GetUsers()
                .GroupBy(u => u.Id)
                .Select(g => g.First())
                .ToList();
            var results = new List<object>();

            foreach (var jfUser in jellyfinUsers)
            {
                if (!AuditIsCurrent())
                {
                    return ConfigurationChanged();
                }

                var userId = jfUser.Id.ToString("N");
                // allowAutoImport: false — audit must be read-only and must not
                // create Seerr users as a side effect.
                var resolution = await _seerr.ResolveSeerrUser(
                    userId,
                    bypassCache: true,
                    allowAutoImport: false,
                    cancellationToken: HttpContext.RequestAborted).ConfigureAwait(false);
                if (!AuditIsCurrent())
                {
                    return ConfigurationChanged();
                }

                var seerrUser = resolution.User;

                if (resolution.Status is SeerrUserResolutionStatus.Incomplete or SeerrUserResolutionStatus.Unavailable)
                {
                    _logger.LogWarning(
                        "[audit] Seerr user lookup for {User} was {Status}: {Reason}; refusing a partial audit.",
                        jfUser.Username,
                        resolution.Status,
                        resolution.FailureReason);
                    return StatusCode(502, new
                    {
                        error = true,
                        code = "user_lookup_incomplete",
                        message = "Seerr user lookup was incomplete. No partial permission audit was published."
                    });
                }

                if (seerrUser == null)
                {
                    var issue = resolution.Status == SeerrUserResolutionStatus.Blocked
                        ? "Blocked from Seerr by Jellyfin Canopy configuration"
                        : "Not linked to a Seerr account";
                    results.Add(new
                    {
                        jellyfinUsername = jfUser.Username,
                        jellyfinUserId   = userId,
                        linked           = false,
                        permissions      = (int?)null,
                        issues           = new[] { issue }
                    });
                    continue;
                }

                var perms = seerrUser.Permissions;
                bool isAdmin = SeerrPermissionHelper.HasPermission(perms, SeerrPermission.ADMIN);

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
                if (!SeerrPermissionHelper.HasAnyPermission(perms,
                    SeerrPermission.REQUEST | SeerrPermission.REQUEST_MOVIE | SeerrPermission.REQUEST_TV))
                    issues.Add("Cannot make requests (missing REQUEST / REQUEST_MOVIE / REQUEST_TV)");

                // 4K movie requests (only relevant if plugin has 4K enabled)
                if (config.SeerrEnable4KRequests &&
                    !SeerrPermissionHelper.HasAnyPermission(perms,
                        SeerrPermission.REQUEST_4K | SeerrPermission.REQUEST_4K_MOVIE))
                    issues.Add("Cannot request 4K movies (missing REQUEST_4K / REQUEST_4K_MOVIE)");

                // 4K TV requests
                if (config.SeerrEnable4KTvRequests &&
                    !SeerrPermissionHelper.HasAnyPermission(perms,
                        SeerrPermission.REQUEST_4K | SeerrPermission.REQUEST_4K_TV))
                    issues.Add("Cannot request 4K TV (missing REQUEST_4K / REQUEST_4K_TV)");

                // Advanced request options — only relevant if user can already make requests
                if (config.SeerrShowAdvanced)
                {
                    bool canRequest = SeerrPermissionHelper.HasAnyPermission(perms,
                        SeerrPermission.REQUEST | SeerrPermission.REQUEST_MOVIE | SeerrPermission.REQUEST_TV);
                    if (canRequest && !SeerrPermissionHelper.HasPermission(perms, SeerrPermission.REQUEST_ADVANCED))
                        issues.Add("Cannot use advanced request options (missing REQUEST_ADVANCED)");
                }

                // Requests page / view — without REQUEST_VIEW they only see their own requests
                if (config.DownloadsPageEnabled &&
                    !SeerrPermissionHelper.HasAnyPermission(perms,
                        SeerrPermission.REQUEST_VIEW | SeerrPermission.MANAGE_REQUESTS))
                    issues.Add("Can only see own requests on Requests page (missing REQUEST_VIEW / MANAGE_REQUESTS) (Can be ignored if on purpose)");

                // Report issues — MANAGE_ISSUES implies CREATE_ISSUES
                if (config.SeerrShowReportButton &&
                    !SeerrPermissionHelper.HasAnyPermission(perms,
                        SeerrPermission.CREATE_ISSUES | SeerrPermission.MANAGE_ISSUES))
                    issues.Add("Cannot report issues (missing CREATE_ISSUES or MANAGE_ISSUES)");

                // View issues indicator — MANAGE_ISSUES implies VIEW_ISSUES
                if (config.SeerrShowIssueIndicator &&
                    !SeerrPermissionHelper.HasAnyPermission(perms,
                        SeerrPermission.VIEW_ISSUES | SeerrPermission.MANAGE_ISSUES))
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

            if (!AuditIsCurrent())
            {
                return ConfigurationChanged();
            }

            return Ok(results);
        }

        [HttpGet("seerr/user")]
        [Authorize(Policy = Policies.RequiresElevation)]
        public Task<IActionResult> GetSeerrUsers([FromQuery] int take = 1000)
        {
            // Admin-only: this proxies Seerr's full user list, which includes
            // every Seerr user's email, username, plexUsername, permissions,
            // and userType. Without this gate any authenticated Jellyfin user
            // could harvest the entire Seerr roster.
            return ProxySeerrRequest($"/api/v1/user?take={take}", HttpMethod.Get);
        }

        [HttpPost("seerr/request/tv/{tmdbId}/seasons")]
        [Authorize]
        public async Task<IActionResult> RequestTvSeasons(int tmdbId, [FromBody] JsonElement requestBody)
        {
            // enforce that the body's mediaType
            // is "tv" and the body's mediaId matches the route's tmdbId, so
            // logging/audit trails are consistent and a user with REQUEST_TV
            // (but not REQUEST_MOVIE) can't piggyback a movie request through
            // this route. Seerr would re-validate but JC's permission gate at
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
            return await ProxySeerrRequest($"/api/v1/request", HttpMethod.Post, requestBody.ToString());
        }

        [HttpGet("seerr/watchlist")]
        [Authorize]
        public Task<IActionResult> GetSeerrWatchlist([FromQuery] int page = 1)
        {
            // Bug discovered live in round-1 e2e: previous endpoint `/api/v1/user/watchlist`
            // returns 400 from Seerr (`request.params.userId should be number`) —
            // Seerr's user-watchlist endpoint expects the userId in the URL path.
            // The discover endpoint reads X-Api-User from the proxy header instead,
            // returning the same shape and matching how the rest of JC's discovery
            // calls work.
            if (page < 1) page = 1;
            return ProxySeerrRequest($"/api/v1/discover/watchlist?page={page}", HttpMethod.Get);
        }

        [HttpPost("seerr/sync-watchlist")]
        [Authorize(Policy = Policies.RequiresElevation)]
        public async Task<IActionResult> SyncSeerrWatchlist()
        {
            var cancellationToken = HttpContext.RequestAborted;
            try
            {
                var integration = SeerrIntegrationPolicy.Capture(_configProvider);
                var config = integration.Configuration;
                if (!integration.IsActive
                    || config == null
                    || !config.SyncSeerrWatchlist
                    || !SeerrIntegrationPolicy.HasUsableSavedConfiguration(config))
                {
                    return BadRequest(new { error = "Seerr watchlist sync is not enabled" });
                }

                if (string.IsNullOrWhiteSpace(config.SeerrUrls)
                    || string.IsNullOrWhiteSpace(config.SeerrApiKey))
                {
                    return BadRequest(new { error = "Seerr URL or API key not configured" });
                }

                var syncConfigStamp = SeerrMutationConfigStamp.Capture(
                    config,
                    integration.ConfigurationRevision);
                bool CanCommit()
                {
                    try
                    {
                        var current = _configProvider.ConfigurationOrNull;
                        return integration.IsCurrent(_configProvider)
                            && syncConfigStamp.Matches(
                                current,
                                _configProvider.ConfigurationRevision)
                            && current?.SyncSeerrWatchlist == true;
                    }
                    catch
                    {
                        return false;
                    }
                }

                SeerrDispatchFence dispatchFence = integration
                    .CreateDispatchFence(_configProvider)
                    .Restrict(CanCommit);

                _logger.LogInformation("[Manual Watchlist Sync] Starting manual Seerr watchlist sync...");

                var urls = SeerrClient.GetConfiguredUrls(config.SeerrUrls);
                if (urls.Length == 0)
                {
                    return BadRequest(new { error = "No valid Seerr URL configured" });
                }

                // Configured Seerr instances are independent identity domains, not
                // failover replicas. Prove a complete, stable user map for every
                // normalized distinct domain before resolving any instance-local id.
                var httpClient = SeerrHttpHelper.CreateClient(_httpClientFactory);
                if (!integration.IsCurrent(_configProvider))
                {
                    return Conflict(new
                    {
                        error = true,
                        code = "sync_configuration_changed",
                        message = "Seerr configuration changed while staging the sync. No local changes were applied."
                    });
                }

                var userSnapshots = await SeerrWatchlistSyncTask.FetchSeerrUserMapSnapshotsAsync(
                    httpClient,
                    urls,
                    config.SeerrApiKey,
                    dispatchFence,
                    cancellationToken).ConfigureAwait(false);
                if (!userSnapshots.IsComplete)
                {
                    _logger.LogWarning(
                        "[Manual Watchlist Sync] Could not stage every Seerr user identity domain: {Reason}. No local changes were applied.",
                        userSnapshots.FailureReason);
                    return StatusCode(502, new
                    {
                        error = true,
                        code = "user_map_incomplete",
                        message = "A complete Seerr user map could not be read from every configured instance. No local changes were applied."
                    });
                }

                if (!SeerrUserIdentityDomains.TryParse(userSnapshots, out var identityDomains))
                {
                    _logger.LogWarning(
                        "[Manual Watchlist Sync] A Seerr user map contained a malformed or ambiguous linked-user row. No local changes were applied.");
                    return StatusCode(502, new
                    {
                        error = true,
                        code = "user_map_invalid",
                        message = "A Seerr user map contained an invalid or ambiguous linked-user row. No local changes were applied."
                    });
                }

                var blockedIds = SeerrUserImportHelper.GetBlockedUserIds(config.SeerrImportBlockedUsers);
                var users = _userManager.GetUsers()
                    .GroupBy(static user => user.Id)
                    .Select(static group => group.First())
                    .Where(user => !blockedIds.Contains(user.Id.ToString("N")))
                    .ToList();

                // Stage every remote row for every binding before the first local
                // library lookup or write. A failure on a later user/domain therefore
                // cannot publish a complete prefix from an earlier domain.
                var stagedItems = new Dictionary<Guid, IReadOnlyList<WatchlistItem>>();
                foreach (var user in users)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    var bindings = SeerrUserIdentityDomains.FindBindings(identityDomains, user.Id.ToString());
                    if (bindings.Count == 0)
                    {
                        continue;
                    }

                    var itemsByMediaKey = new Dictionary<string, WatchlistItem>(StringComparer.OrdinalIgnoreCase);
                    foreach (var binding in bindings)
                    {
                        cancellationToken.ThrowIfCancellationRequested();
                        if (!integration.IsCurrent(_configProvider))
                        {
                            return Conflict(new
                            {
                                error = true,
                                code = "sync_configuration_changed",
                                message = "Seerr configuration changed while staging the sync. No local changes were applied."
                            });
                        }

                        var watchlistItems = await _seerr.GetWatchlistForUser(
                            binding.SeerrUserId,
                            binding.SourceUrl,
                            cancellationToken).ConfigureAwait(false);
                        if (watchlistItems == null
                            || !TryAddStagedWatchlistItems(watchlistItems, itemsByMediaKey))
                        {
                            _logger.LogWarning(
                                "[Manual Watchlist Sync] Watchlist for {User} from {Source} was incomplete or invalid. No local changes were applied.",
                                user.Username,
                                binding.SourceUrl);
                            return StatusCode(502, new
                            {
                                error = true,
                                code = "watchlist_incomplete",
                                message = "A complete valid Seerr watchlist could not be read for every linked instance. No local changes were applied."
                            });
                        }

                        if (!config.AddRequestedMediaToWatchlist)
                        {
                            continue;
                        }

                        if (!integration.IsCurrent(_configProvider))
                        {
                            return Conflict(new
                            {
                                error = true,
                                code = "sync_configuration_changed",
                                message = "Seerr configuration changed while staging the sync. No local changes were applied."
                            });
                        }

                        var requestItems = await _seerr.GetRequestsForUser(
                            binding.SeerrUserId,
                            binding.SourceUrl,
                            cancellationToken).ConfigureAwait(false);
                        if (requestItems == null
                            || !TryAddStagedWatchlistItems(requestItems, itemsByMediaKey))
                        {
                            _logger.LogWarning(
                                "[Manual Watchlist Sync] Request collection for {User} from {Source} was incomplete or invalid. No local changes were applied.",
                                user.Username,
                                binding.SourceUrl);
                            return StatusCode(502, new
                            {
                                error = true,
                                code = "request_collection_incomplete",
                                message = "A complete valid Seerr request collection could not be read for every linked instance. No local changes were applied."
                            });
                        }
                    }

                    stagedItems.Add(user.Id, itemsByMediaKey.Values.ToArray());
                }

                // The commit phase is deliberately non-cancellable. Cancellation is
                // observed once after the complete remote snapshot is staged; after
                // that boundary the small local batch runs to completion instead of
                // leaving a cancellation-created partial prefix.
                cancellationToken.ThrowIfCancellationRequested();
                if (!integration.IsCurrent(_configProvider))
                {
                    return Conflict(new
                    {
                        error = true,
                        code = "sync_configuration_changed",
                        message = "Seerr configuration changed while staging the sync. No local changes were applied."
                    });
                }

                var commitUserSnapshots = await SeerrWatchlistSyncTask.FetchSeerrUserMapSnapshotsAsync(
                    httpClient,
                    urls,
                    config.SeerrApiKey,
                    dispatchFence,
                    cancellationToken).ConfigureAwait(false);
                if (!commitUserSnapshots.IsComplete
                    || !SeerrUserIdentityDomains.TryParse(
                        commitUserSnapshots,
                        out var commitIdentityDomains)
                    || !SeerrUserIdentityDomains.AreEquivalent(
                        identityDomains,
                        commitIdentityDomains))
                {
                    _logger.LogWarning(
                        "[Manual Watchlist Sync] User ownership changed or could not be revalidated before the local commit. No local changes were applied.");
                    return StatusCode(409, new
                    {
                        error = true,
                        code = "user_binding_changed",
                        message = "Seerr user ownership changed while staging the sync. No local changes were applied."
                    });
                }

                var commitConfig = _configProvider.ConfigurationOrNull;
                if (commitConfig is null
                    || !syncConfigStamp.Matches(
                        commitConfig,
                        _configProvider.ConfigurationRevision)
                    || !SeerrIntegrationPolicy.HasUsableSavedConfiguration(commitConfig)
                    || !commitConfig.SyncSeerrWatchlist)
                {
                    _logger.LogWarning(
                        "[Manual Watchlist Sync] Configuration changed before the local commit. No local changes were applied.");
                    return StatusCode(409, new
                    {
                        error = true,
                        code = "sync_configuration_changed",
                        message = "Seerr configuration changed while staging the sync. No local changes were applied."
                    });
                }

                config = commitConfig;
                int itemsProcessed = 0;
                int itemsAdded = 0;
                var errors = new List<string>();
                foreach (var user in users)
                {
                    if (!CanCommit())
                    {
                        return Conflict(new
                        {
                            error = true,
                            code = "sync_configuration_changed",
                            message = "Seerr configuration changed during the local commit. Remaining changes were stopped."
                        });
                    }

                    if (!stagedItems.TryGetValue(user.Id, out var items))
                    {
                        continue;
                    }

                    foreach (var item in items)
                    {
                        if (!CanCommit())
                        {
                            return Conflict(new
                            {
                                error = true,
                                code = "sync_configuration_changed",
                                message = "Seerr configuration changed during the local commit. Remaining changes were stopped."
                            });
                        }

                        itemsProcessed++;

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
                                if (!CanCommit())
                                {
                                    return Conflict(new
                                    {
                                        error = true,
                                        code = "sync_configuration_changed",
                                        message = "Seerr configuration changed during the local commit. Remaining changes were stopped."
                                    });
                                }

                                userData.Likes = true;
                                _userDataManager.SaveUserData(
                                    user,
                                    libraryItem,
                                    userData,
                                    UserDataSaveReason.UpdateUserRating,
                                    CancellationToken.None);
                                if (!CanCommit())
                                {
                                    return Conflict(new
                                    {
                                        error = true,
                                        code = "sync_configuration_changed",
                                        message = "Seerr configuration changed during the local commit. Remaining changes were stopped."
                                    });
                                }

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

                _logger.LogInformation($"[Manual Watchlist Sync] Sync complete. Processed: {itemsProcessed}, Added: {itemsAdded}");

                return Ok(new
                {
                    success = true,
                    itemsProcessed,
                    itemsAdded,
                    errors = errors.Count > 0 ? errors : null
                });
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogError($"[Manual Watchlist Sync] Fatal error: {ex}");
                return StatusCode(500, new { error = "An internal error occurred during watchlist sync." });
            }
        }

        private static bool TryAddStagedWatchlistItems(
            IEnumerable<WatchlistItem> sourceItems,
            IDictionary<string, WatchlistItem> stagedItems)
        {
            foreach (var item in sourceItems)
            {
                if (item == null || item.TmdbId <= 0)
                {
                    return false;
                }

                var mediaType = item.MediaType?.Trim().ToLowerInvariant();
                if (mediaType is not ("movie" or "tv"))
                {
                    return false;
                }

                var key = $"{mediaType}:{item.TmdbId}";
                stagedItems.TryAdd(key, new WatchlistItem
                {
                    TmdbId = item.TmdbId,
                    MediaType = mediaType,
                    TvdbId = item.TvdbId
                });
            }

            return true;
        }

        [HttpPost("seerr/import-users")]
        [Authorize(Policy = Policies.RequiresElevation)]
        public async Task<IActionResult> ImportSeerrUsers()
        {
            try
            {
                var integration = SeerrIntegrationPolicy.Capture(_configProvider);
                var config = integration.Configuration;
                if (!integration.IsActive || config == null)
                {
                    return BadRequest(new { error = "Seerr integration is not enabled" });
                }

                if (string.IsNullOrEmpty(config.SeerrUrls) || string.IsNullOrEmpty(config.SeerrApiKey))
                {
                    return BadRequest(new { error = "Seerr URL or API key not configured" });
                }

                var importConfigStamp = SeerrMutationConfigStamp.Capture(
                    config,
                    integration.ConfigurationRevision);
                SeerrDispatchFence dispatchFence = integration
                    .CreateDispatchFence(_configProvider)
                    .Restrict(() => importConfigStamp.Matches(
                        _configProvider.ConfigurationOrNull,
                        _configProvider.ConfigurationRevision));

                // Claim the throttle slot atomically to prevent concurrent imports
                lock (_seerrCache.ImportThrottleLock)
                {
                    if ((DateTime.UtcNow - _seerrCache.LastManualImport).TotalSeconds < 30)
                    {
                        return StatusCode(429, new { error = "Import was run recently. Please wait before retrying." });
                    }

                    _seerrCache.LastManualImport = DateTime.UtcNow;
                }

                _logger.LogInformation("[Manual User Import] Starting manual Seerr user import...");

                var urls = SeerrClient.GetConfiguredUrls(config.SeerrUrls);
                var blockedIds = Helpers.Seerr.SeerrUserImportHelper.GetBlockedUserIds(config.SeerrImportBlockedUsers);
                var userIds = _userManager.GetUsers()
                    .Select(u => u.Id.ToString().Replace("-", ""))
                    .Where(id => !blockedIds.Contains(id))
                    .ToList();
                _logger.LogInformation($"[Manual User Import] Evaluating {userIds.Count} unblocked Jellyfin users against every configured Seerr identity domain...");

                var importResult = await Helpers.Seerr.SeerrUserImportHelper.BulkImportAsync(
                    userIds,
                    urls,
                    config.SeerrApiKey,
                    _httpClientFactory,
                    _logger,
                    dispatchFence,
                    HttpContext.RequestAborted).ConfigureAwait(false);

                // only flush user caches when at least one user
                // was actually imported. Previously a 0-imported "success" (all
                // email-collisioned) would wipe every healthy cache entry,
                // forcing a stampede on next request.
                if (importResult.Succeeded && importResult.Imported > 0)
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

                if (importResult.Succeeded)
                {
                    _logger.LogInformation($"[Manual User Import] Completed on {importResult.SourceUrl}. {importResult.Imported} new user(s) imported after evaluating {userIds.Count} eligible candidate(s).");
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
                        error = "The Seerr user-map preflight or import outcome was incomplete. No mutation was replayed elsewhere.",
                        errors = importResult.Errors,
                    });
                }
            }
            catch (HttpRequestException ex)
            {
                _logger.LogError($"[Manual User Import] Connection error: {ex.Message}");
                return StatusCode(502, new { error = "Failed to connect to Seerr. Check server logs for details." });
            }
            catch (JsonException ex)
            {
                _logger.LogError($"[Manual User Import] Invalid Seerr response: {ex.Message}");
                return StatusCode(502, new { error = "Invalid response from Seerr. Check server logs for details." });
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
