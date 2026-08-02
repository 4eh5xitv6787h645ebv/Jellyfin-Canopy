using Microsoft.AspNetCore.Mvc;
using System;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using MediaBrowser.Controller.Library;
using Jellyfin.Data;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Controllers
{
    /// <summary>
    /// Shared base for the JellyfinCanopy feature controllers: auth/resource
    /// helpers (admin check, per-user resource authorization, current-user
    /// resolution), SSRF URL guard logging, and small shared utilities.
    /// The Seerr plumbing that used to live here (user resolution, proxy core,
    /// watchlist helpers) is <see cref="ISeerrClient"/>; the Arr fetch
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

            if ((!Guid.TryParse(requestedUserId, out var parsedUserId)
                    && !Guid.TryParseExact(requestedUserId, "N", out parsedUserId))
                || parsedUserId == Guid.Empty)
            {
                return BadRequest(new { message = "Invalid userId format." });
            }

            var effectiveUserId = UserHelper.GetUserId(User, parsedUserId);
            if (!effectiveUserId.HasValue)
            {
                return Forbid();
            }

            // A legacy route may authorize an administrator for another user's
            // explicit id. Resolve that cross-user target before any controller
            // can touch its per-user directory. True self access intentionally
            // retains the historical no-directory-lookup behavior.
            var actorId = UserHelper.GetCurrentUserId(User);
            if (!actorId.HasValue || actorId.Value != effectiveUserId.Value)
            {
                try
                {
                    var target = _userManager.GetUserById(effectiveUserId.Value);
                    if (target == null || target.Id != effectiveUserId.Value)
                    {
                        return NotFound(new
                        {
                            success = false,
                            code = "target_user_not_found",
                            message = "The selected Jellyfin user does not exist."
                        });
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(
                        $"Legacy cross-user authorization could not resolve target " +
                        $"{effectiveUserId.Value:N} (exception={ex.GetType().Name}).");
                    return StatusCode(StatusCodes.Status503ServiceUnavailable, new
                    {
                        success = false,
                        code = "target_user_directory_unavailable",
                        message = "The Jellyfin user directory is temporarily unavailable."
                    });
                }
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
        /// The acting caller for <see cref="ISeerrClient.ProxyRequestAsync"/>,
        /// resolved from the authenticated principal (never caller-controlled headers).
        /// </summary>
        protected SeerrCaller SeerrCaller()
            => new(UserHelper.GetCurrentUserId(User)?.ToString(), IsAdminUser());

        protected Guid GetCurrentUserId()
        {
            var claim = User.FindFirst("Jellyfin-UserId")
                     ?? User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)
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

        /// <summary>
        /// Emits the privacy-minimal audit record required when an authenticated
        /// actor mutates another user's file. Returns <see langword="true"/> when
        /// the cross-user record was emitted so callers can retain their legacy
        /// self-write log only for genuine self mutations.
        /// </summary>
        protected bool LogCrossUserFileMutationIfNeeded(
            string authorizedUserId,
            string fileName,
            string revisionEvidence,
            string action,
            string? explicitTargetUserId = null)
        {
            var actorId = UserHelper.GetCurrentUserId(User);
            var actorKey = actorId.HasValue && actorId.Value != Guid.Empty
                ? actorId.Value.ToString("N")
                : null;
            var isCrossUser = actorKey == null
                || !string.IsNullOrEmpty(explicitTargetUserId)
                || !string.Equals(
                    actorKey,
                    authorizedUserId,
                    StringComparison.OrdinalIgnoreCase);
            if (!isCrossUser)
            {
                return false;
            }

            _logger.LogInformation(
                $"Admin {ResolveUserDisplay(actorKey ?? "elevated-principal")} {action} " +
                $"{fileName} for target {ResolveUserDisplay(authorizedUserId)} at revision " +
                $"{revisionEvidence}.");
            return true;
        }

        /// <summary>
        /// Resolves an explicit cross-user target before any per-user filesystem
        /// operation. Endpoint authorization remains the responsibility of the
        /// caller's elevation policy.
        /// </summary>
        protected IActionResult? ResolveExistingTargetUser(
            string targetUserId,
            out string canonicalTargetUserId,
            out JUser targetUser)
        {
            canonicalTargetUserId = string.Empty;
            targetUser = null!;
            if (string.IsNullOrWhiteSpace(targetUserId)
                || (!Guid.TryParseExact(targetUserId, "N", out var parsed)
                    && !Guid.TryParseExact(targetUserId, "D", out parsed))
                || parsed == Guid.Empty)
            {
                return BadRequest(new
                {
                    success = false,
                    code = "invalid_target_user_id",
                    message = "targetUserId must be a non-empty GUID in dashed or 32-character format."
                });
            }

            canonicalTargetUserId = parsed.ToString("N");
            try
            {
                var resolved = _userManager.GetUserById(parsed);
                if (resolved == null || resolved.Id != parsed)
                {
                    return NotFound(new
                    {
                        success = false,
                        code = "target_user_not_found",
                        message = "The selected Jellyfin user does not exist."
                    });
                }

                targetUser = resolved;
                return null;
            }
            catch (Exception ex)
            {
                _logger.LogError(
                    $"Failed to resolve target Jellyfin user {canonicalTargetUserId} " +
                    $"(exception={ex.GetType().Name}).");
                return StatusCode(StatusCodes.Status503ServiceUnavailable, new
                {
                    success = false,
                    code = "target_user_directory_unavailable",
                    message = "The Jellyfin user directory is temporarily unavailable."
                });
            }
        }

        protected sealed class TargetPreferenceResponse<T>
            where T : class, IRevisionedUserConfiguration, new()
        {
            public bool Success { get; set; }
            public bool Conflict { get; set; }
            public string Message { get; set; } = string.Empty;
            public string File { get; set; } = string.Empty;
            public long Revision { get; set; }
            public string ContentHash { get; set; } = string.Empty;
            public T Data { get; set; } = new T();
            public string TargetUserId { get; set; } = string.Empty;
            public string TargetDisplayName { get; set; } = string.Empty;

            [System.Text.Json.Serialization.JsonIgnore(
                Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
            public int? ItemCount { get; set; }
        }

        protected static bool TryParsePreferenceIfMatch(HttpRequest request, out long revision)
        {
            revision = -1;
            var raw = request.Headers.IfMatch.ToString().Trim();
            if (raw.Length < 3 || raw[0] != '"' || raw[^1] != '"') return false;
            var token = raw.Substring(1, raw.Length - 2);
            return long.TryParse(
                token,
                System.Globalization.NumberStyles.None,
                System.Globalization.CultureInfo.InvariantCulture,
                out revision)
                && revision >= 0
                && string.Equals(
                    token,
                    revision.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    StringComparison.Ordinal);
        }

        protected static string PreferenceContentHash<T>(T state)
            where T : class, IRevisionedUserConfiguration
        {
            var node = JsonSerializer.SerializeToNode(
                state,
                state.GetType(),
                PersistedJson.WriteOptions) as JsonObject
                ?? throw new InvalidDataException("Preference state did not serialize as a JSON object.");
            node.Remove(nameof(IRevisionedUserConfiguration.Revision));
            var canonical = node.ToJsonString(PersistedJson.WriteOptions);
            return Convert.ToHexString(
                SHA256.HashData(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
        }

        protected static T ClonePreference<T>(T state)
            where T : class, IRevisionedUserConfiguration, new()
            => ClonePersisted(state);

        protected static T ClonePersisted<T>(T state)
            where T : class
        {
            var bytes = JsonSerializer.SerializeToUtf8Bytes(
                state,
                state.GetType(),
                PersistedJson.WriteOptions);
            return JsonSerializer.Deserialize<T>(bytes, PersistedJson.ReadOptions)
                ?? throw new InvalidDataException("Preference state could not be cloned.");
        }

        protected TargetPreferenceResponse<T> PreferenceResponse<T>(
            string file,
            string targetUserId,
            string targetDisplayName,
            T data,
            bool success,
            bool conflict = false,
            string message = "",
            int? itemCount = null)
            where T : class, IRevisionedUserConfiguration, new()
        {
            var hash = PreferenceContentHash(data);
            Response.Headers.ETag = $"\"{data.Revision}\"";
            Response.Headers["X-JC-Content-Hash"] = hash;
            return new TargetPreferenceResponse<T>
            {
                Success = success,
                Conflict = conflict,
                Message = message,
                File = file,
                Revision = data.Revision,
                ContentHash = hash,
                Data = data,
                TargetUserId = targetUserId,
                TargetDisplayName = targetDisplayName,
                ItemCount = itemCount
            };
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
                var key = CorruptConfigurationKey("sonarr", config.SonarrInstances);
                bool firstSeen;
                lock (_loggedCorruptArrConfigLock) firstSeen = _loggedCorruptArrConfig.Add(key);
                if (firstSeen)
                    _logger.LogError("SonarrInstances config is corrupt JSON — instance list is effectively empty. "
                        + "Endpoints will return no Sonarr data until the admin opens the config page and resets it. "
                        + "The raw value was omitted because instance configuration can contain credentials.");
            }
            if (config.IsRadarrInstancesCorrupt())
            {
                var key = CorruptConfigurationKey("radarr", config.RadarrInstances);
                bool firstSeen;
                lock (_loggedCorruptArrConfigLock) firstSeen = _loggedCorruptArrConfig.Add(key);
                if (firstSeen)
                    _logger.LogError("RadarrInstances config is corrupt JSON — instance list is effectively empty. "
                        + "Endpoints will return no Radarr data until the admin opens the config page and resets it. "
                        + "The raw value was omitted because instance configuration can contain credentials.");
            }
        }

        private static string CorruptConfigurationKey(string source, string? rawValue)
        {
            var digest = SHA256.HashData(Encoding.UTF8.GetBytes(rawValue ?? string.Empty));
            return string.Concat(source, ":", Convert.ToHexString(digest));
        }

        protected static HiddenContentSettings BuildHcDefaultSettings(PluginConfiguration src)
            => HiddenContentDefaults.Create(src);
    }
}
