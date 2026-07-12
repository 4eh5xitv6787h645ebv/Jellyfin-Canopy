using Microsoft.AspNetCore.Mvc;
using System;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using System.Collections.Generic;
using MediaBrowser.Controller.Library;
using Jellyfin.Data;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Jellyseerr;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Controllers
{
    /// <summary>
    /// Shared base for the JellyfinCanopy feature controllers: auth/resource
    /// helpers (admin check, per-user resource authorization, current-user
    /// resolution), SSRF URL guard logging, and small shared utilities.
    /// The Seerr plumbing that used to live here (user resolution, proxy core,
    /// watchlist helpers) is <see cref="IJellyseerrClient"/>; the Arr fetch
    /// plumbing is <see cref="Services.Arr.ArrFetchService"/>.
    /// </summary>
    public abstract class JellyfinCanopyControllerBase : ControllerBase
    {
        protected readonly IHttpClientFactory _httpClientFactory;
        protected readonly ILogger _logger;
        protected readonly IUserManager _userManager;
        protected readonly ISeerrCache _seerrCache;
        protected readonly IPluginConfigProvider _configProvider;

        protected JellyfinCanopyControllerBase(
            IHttpClientFactory httpClientFactory,
            ILogger logger,
            IUserManager userManager,
            ISeerrCache seerrCache,
            IPluginConfigProvider configProvider)
        {
            _httpClientFactory = httpClientFactory;
            _logger = logger;
            _userManager = userManager;
            _seerrCache = seerrCache;
            _configProvider = configProvider;
        }

        // ── Auth / resource helpers ──────────────────────────────────────────

        protected IActionResult? AuthorizeUserConfigAccess(string requestedUserId, out string authorizedUserId)
        {
            authorizedUserId = string.Empty;

            if (string.IsNullOrWhiteSpace(requestedUserId))
            {
                return BadRequest(new { message = "userId is required." });
            }

            if (!Guid.TryParse(requestedUserId, out var parsedUserId) && !Guid.TryParseExact(requestedUserId, "N", out parsedUserId))
            {
                return BadRequest(new { message = "Invalid userId format." });
            }

            var effectiveUserId = UserHelper.GetUserId(User, parsedUserId);
            if (!effectiveUserId.HasValue)
            {
                return Forbid();
            }

            // UserConfigurationManager expects folder names in N format (without dashes).
            authorizedUserId = effectiveUserId.Value.ToString("N");
            return null;
        }

        protected IActionResult? AuthorizeUserAccess(Guid requestedUserId, out JUser user)
        {
            user = null!;
            var effectiveUserId = UserHelper.GetUserId(User, requestedUserId);
            if (!effectiveUserId.HasValue)
            {
                return Forbid();
            }

            var resolvedUser = _userManager.GetUserById(effectiveUserId.Value);
            if (resolvedUser is null)
            {
                return NotFound();
            }

            user = resolvedUser;
            return null;
        }

        // previously a single `User.IsInRole("Administrator")`
        // magic-string check. Cross-check against the IUserManager-resolved
        // Jellyfin user's actual `IsAdministrator` permission so a future
        // Jellyfin core role-name rename can't silently downgrade JC's
        // admin gates. Falls back to the role claim if the user lookup
        // fails (which would be a programmer error since `[Authorize]`
        // gates every admin endpoint).
        //
        // NOTE: this is only for endpoints with genuinely mixed per-role logic
        // (admin sees more fields / verbose errors). Endpoint-level admin gates
        // use [Authorize(Policy = Policies.RequiresElevation)] instead.
        protected bool IsAdminUser()
        {
            if (User.IsInRole("Administrator")) return true;
            try
            {
                var jfUserId = UserHelper.GetCurrentUserId(User);
                if (!jfUserId.HasValue) return false;
                var u = _userManager.GetUserById(jfUserId.Value);
                return u != null && u.HasPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.IsAdministrator);
            }
            catch { return false; }
        }

        /// <summary>
        /// The acting caller for <see cref="IJellyseerrClient.ProxyRequestAsync"/>,
        /// resolved from the authenticated principal (never caller-controlled headers).
        /// </summary>
        protected JellyseerrCaller SeerrCaller()
            => new(UserHelper.GetCurrentUserId(User)?.ToString(), IsAdminUser());

        protected Guid GetCurrentUserId()
        {
            var claim = User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)
                     ?? User.FindFirst("sub")
                     ?? User.FindFirst("Sid");
            if (claim != null && Guid.TryParse(claim.Value, out var id))
                return id;
            return Guid.Empty;
        }

        protected string ResolveUserDisplay(string userId)
        {
            try
            {
                // Accept both dashed and dashless GUIDs
                if (Guid.TryParse(userId, out var guid) ||
                    Guid.TryParseExact(userId, "N", out guid))
                {
                    var user = _userManager.GetUserById(guid);
                    if (user != null)
                        return $"{user.Username} ({userId})";
                }
            }
            catch { /* non-fatal */ }
            return userId;
        }

        // ── SSRF URL guard (with admin-diagnosable logging) ──────────────────

        protected bool IsAllowedUrl(string url)
        {
            var allowed = ArrUrlGuard.IsAllowedUrl(url);
            if (!allowed && !string.IsNullOrWhiteSpace(url))
            {
                // Log at Error so admins can diagnose "instance doesn't return data"
                // issues caused by a URL that hits the block list (e.g. metadata endpoints, loopback).
                _logger.LogError($"IsAllowedUrl rejected outbound URL: {url}");
            }
            return allowed;
        }

        // ── Shared utilities ─────────────────────────────────────────────────

        // Once-per-value dedup so corrupted instance config logs at Error on first hit and stops
        // spamming on subsequent reads. Keyed by the raw stored JSON so a corrupt→fix→corrupt
        // cycle gets a fresh log entry.
        private static readonly HashSet<string> _loggedCorruptArrConfig = new();
        private static readonly object _loggedCorruptArrConfigLock = new();

        protected void WarnIfArrInstancesCorrupt(PluginConfiguration config)
        {
            if (config.IsSonarrInstancesCorrupt())
            {
                var key = "sonarr:" + (config.SonarrInstances ?? "");
                bool firstSeen;
                lock (_loggedCorruptArrConfigLock) firstSeen = _loggedCorruptArrConfig.Add(key);
                if (firstSeen)
                    _logger.LogError("SonarrInstances config is corrupt JSON — instance list is effectively empty. "
                        + "Endpoints will return no Sonarr data until the admin opens the config page and resets it. "
                        + $"Raw value (first 200 chars): {(config.SonarrInstances ?? "").Substring(0, Math.Min(200, (config.SonarrInstances ?? "").Length))}");
            }
            if (config.IsRadarrInstancesCorrupt())
            {
                var key = "radarr:" + (config.RadarrInstances ?? "");
                bool firstSeen;
                lock (_loggedCorruptArrConfigLock) firstSeen = _loggedCorruptArrConfig.Add(key);
                if (firstSeen)
                    _logger.LogError("RadarrInstances config is corrupt JSON — instance list is effectively empty. "
                        + "Endpoints will return no Radarr data until the admin opens the config page and resets it. "
                        + $"Raw value (first 200 chars): {(config.RadarrInstances ?? "").Substring(0, Math.Min(200, (config.RadarrInstances ?? "").Length))}");
            }
        }

        protected static HiddenContentSettings BuildHcDefaultSettings(PluginConfiguration src)
        {
            return new HiddenContentSettings
            {
                Enabled = src.HiddenContentDefaultEnabled,
                ShowHideButtons = src.HiddenContentDefaultShowHideButtons,
                ShowHideConfirmation = src.HiddenContentDefaultShowHideConfirmation,
                ShowButtonJellyseerr = src.HiddenContentDefaultShowButtonJellyseerr,
                ShowButtonLibrary = src.HiddenContentDefaultShowButtonLibrary,
                ShowButtonDetails = src.HiddenContentDefaultShowButtonDetails,
                ShowButtonCast = src.HiddenContentDefaultShowButtonCast,
                FilterLibrary = src.HiddenContentDefaultFilterLibrary,
                FilterDiscovery = src.HiddenContentDefaultFilterDiscovery,
                FilterSearch = src.HiddenContentDefaultFilterSearch,
                FilterCalendar = src.HiddenContentDefaultFilterCalendar,
                FilterUpcoming = src.HiddenContentDefaultFilterUpcoming,
                FilterRecommendations = src.HiddenContentDefaultFilterRecommendations,
                FilterRequests = src.HiddenContentDefaultFilterRequests,
                FilterNextUp = src.HiddenContentDefaultFilterNextUp,
                FilterContinueWatching = src.HiddenContentDefaultFilterContinueWatching,
                ExperimentalHideCollections = src.HiddenContentDefaultExperimentalHideCollections,
            };
        }
    }
}
