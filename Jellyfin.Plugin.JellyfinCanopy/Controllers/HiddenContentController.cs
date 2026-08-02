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
using System.Globalization;
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
using Microsoft.Extensions.Logging;
using MediaBrowser.Common.Api;

namespace Jellyfin.Plugin.JellyfinCanopy.Controllers
{
    /// <summary>
    /// User and admin hidden-content endpoints plus continue-watching / next-up hide-unhide.
    /// Split out of the former JellyfinCanopyController; method bodies, routes
    /// and attributes are unchanged.
    /// </summary>
    [Route("JellyfinCanopy")]
    [ApiController]
    public class HiddenContentController : JellyfinCanopyControllerBase
    {
        private readonly UserConfigurationManager _userConfigurationManager;
        private readonly ILibraryManager _libraryManager;
        private readonly IHiddenContentItemActionOwner _hiddenContentItemActionOwner;
        private const string HiddenContentFileName = "hidden-content.json";
        private const string HiddenSettingsResource = "hidden-content-settings.json";
        private const int MaximumAdminItemBatch = 200;

        private sealed class HiddenAdminPayloadTooLargeException : Exception
        {
        }

        private sealed class HiddenItemCapacityExceededException : Exception
        {
        }

        private IActionResult HiddenItemCapacityExceeded()
            => StatusCode(StatusCodes.Status413PayloadTooLarge, new
            {
                success = false,
                code = "hidden_content_cap_exceeded",
                maximum = PersistedPayloadPolicy.MaximumHiddenItems,
                message =
                    $"Hidden Content already has the maximum of " +
                    $"{PersistedPayloadPolicy.MaximumHiddenItems} entries. " +
                    "Remove an entry before adding another."
            });

        private void SetAdminHiddenItemsEvidence(long itemsRevision)
            => Response.Headers.ETag =
                $"\"{itemsRevision.ToString(CultureInfo.InvariantCulture)}\"";

        private IActionResult AdminHiddenItemsConflict(
            string targetUserId,
            string targetDisplayName,
            long itemsRevision)
        {
            SetAdminHiddenItemsEvidence(itemsRevision);
            return Conflict(new
            {
                success = false,
                conflict = true,
                code = "hidden_content_items_conflict",
                message =
                    "Hidden Content items changed. Reload the returned target evidence and retry.",
                userId = targetUserId,
                userName = targetDisplayName,
                targetUserId,
                targetDisplayName,
                itemsRevision
            });
        }

        private static bool HiddenItemsEqual(
            Dictionary<string, HiddenContentItem> left,
            Dictionary<string, HiddenContentItem> right)
            => JsonElement.DeepEquals(
                JsonSerializer.SerializeToElement(left, PersistedJson.WriteOptions),
                JsonSerializer.SerializeToElement(right, PersistedJson.WriteOptions));

        private IActionResult QuarantinedHiddenStore()
            => StatusCode(StatusCodes.Status503ServiceUnavailable, new
            {
                success = false,
                message = "Hidden-content state is quarantined. Retry alone cannot recover it; an administrator must inspect and reset or repair the store."
            });

        private IActionResult HiddenConfigurationUnavailable()
            => StatusCode(StatusCodes.Status503ServiceUnavailable, new
            {
                success = false,
                message = "Hidden Content configuration is temporarily unavailable; no default state was assumed."
            });

        private IActionResult? AuthorizeHiddenAdminConfiguration()
        {
            var configuration = _configProvider.ConfigurationOrNull;
            if (configuration == null)
            {
                return HiddenConfigurationUnavailable();
            }

            return configuration.HiddenContentAdmin ? null : Forbid();
        }

        private UserConfigReadStatus RequireHiddenMutationRead(
            string userId,
            UserConfigReadResult<UserHiddenContent> read)
        {
            if (read.HasUsableValue && read.Value != null)
            {
                return read.Status;
            }

            if (string.Equals(
                read.FaultDetail,
                "quarantined-recovery-required",
                StringComparison.Ordinal))
            {
                throw new UserStoreUnhealthyException(
                    HiddenContentFileName,
                    newlyQuarantined: false);
            }

            if (read.Status == UserConfigReadStatus.Unavailable)
            {
                throw new IOException("Hidden-content state is temporarily unavailable.");
            }

            // Preserve strict-writer recovery semantics for confirmed corrupt
            // bytes. This call is made while the same file lock is held and is
            // expected to publish quarantine state and throw.
            _userConfigurationManager.GetUserConfigurationStrict<UserHiddenContent>(
                userId,
                HiddenContentFileName);
            throw new InvalidDataException("Hidden-content state is corrupt.");
        }

        public HiddenContentController(
            IHttpClientFactory httpClientFactory,
            ILogger<HiddenContentController> logger,
            IUserManager userManager,
            ISeerrCache seerrCache,
            IPluginConfigProvider configProvider,
            UserConfigurationManager userConfigurationManager,
            ILibraryManager libraryManager,
            IHiddenContentItemActionOwner hiddenContentItemActionOwner)
            : base(httpClientFactory, logger, userManager, seerrCache, configProvider)
        {
            _userConfigurationManager = userConfigurationManager;
            _libraryManager = libraryManager;
            _hiddenContentItemActionOwner = hiddenContentItemActionOwner;
        }

        [HttpGet("user-settings/{userId}/hidden-content.json")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetUserHiddenContent(string userId)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }
            var targetResult = ResolveExistingTargetUser(
                authorizedUserId,
                out authorizedUserId,
                out _);
            if (targetResult != null)
            {
                return targetResult;
            }

            UserConfigReadResult<UserHiddenContent> read;
            try
            {
                read = _userConfigurationManager.GetOrCreateUserConfiguration<UserHiddenContent>(
                    authorizedUserId,
                    HiddenContentFileName,
                    () =>
                    {
                        if (_configProvider.ConfigurationOrNull is not PluginConfiguration defaults)
                        {
                            return null;
                        }

                        return new UserHiddenContent
                        {
                            Settings = BuildHcDefaultSettings(defaults)
                        };
                    },
                    state => PersistedPayloadPolicy
                        .ValidateMutationSource(state).IsValid);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(
                    $"Failed to initialize hidden-content.json for {ResolveUserDisplay(authorizedUserId)} " +
                    $"(exception={ex.GetType().Name}).");
                return StatusCode(StatusCodes.Status503ServiceUnavailable, new
                {
                    success = false,
                    message = "Hidden-content state or configured defaults are unavailable; initialization was not acknowledged."
                });
            }

            if (!read.HasUsableValue || read.Value == null)
            {
                return string.Equals(read.FaultDetail, "quarantined-recovery-required", StringComparison.Ordinal)
                    ? QuarantinedHiddenStore()
                    : StatusCode(StatusCodes.Status503ServiceUnavailable, new
                    {
                        success = false,
                        message = "Hidden-content state is corrupt or temporarily unavailable. No empty replacement state was published."
                    });
            }

            var responseState = ClonePersisted(read.Value);
            PersistedPayloadPolicy.NormalizeLegacyRuntimeState(responseState);
            if (!PersistedPayloadPolicy
                .ValidateMutationCandidate(responseState).IsValid)
            {
                return StatusCode(StatusCodes.Status503ServiceUnavailable, new
                {
                    success = false,
                    message = "Hidden-content state is invalid. No replacement state was published."
                });
            }

            if (read.Status == UserConfigReadStatus.Missing && !read.WasCreated)
            {
                return HiddenConfigurationUnavailable();
            }

            if (read.WasCreated)
            {
                var crossUserLogged = LogCrossUserFileMutationIfNeeded(
                    authorizedUserId,
                    HiddenContentFileName,
                    $"settingsRevision={read.Value.Settings.Revision.ToString(CultureInfo.InvariantCulture)}," +
                    $"itemsRevision={read.Value.ItemsRevision.ToString(CultureInfo.InvariantCulture)}",
                    "seeded defaults in");
                if (!crossUserLogged)
                {
                    _logger.LogInformation(
                        $"Seeded default hidden-content.json for new user " +
                        $"{ResolveUserDisplay(authorizedUserId)} from plugin configuration.");
                }
            }

            return Ok(responseState);
        }

        [HttpPost("user-settings/{userId}/hidden-content.json")]
        [Authorize]
        [Produces("application/json")]
        [PersistedPayloadLimit(PersistedPayloadPolicy.HiddenContentRequestBytes)]
        public IActionResult SaveUserHiddenContent(string userId, [FromBody] UserHiddenContent userConfiguration)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }
            var targetResult = ResolveExistingTargetUser(
                authorizedUserId,
                out authorizedUserId,
                out _);
            if (targetResult != null)
            {
                return targetResult;
            }

            // Never mutate or retain MVC's bound graph. A normal global-hide
            // client submits Jellyfin-derived title/index metadata through this
            // full resource, so normalize those narrow fields on a detached copy
            // before applying the durable policy.
            var sourceValidation = PersistedPayloadPolicy
                .ValidateMutationSource(userConfiguration);
            if (!sourceValidation.IsValid)
            {
                var response = new PersistedPayloadErrorResponse
                {
                    Code = sourceValidation.Code,
                    Message = sourceValidation.Status
                        == PersistedPayloadStatus.TooLarge
                        ? "The normalized hidden-content payload exceeds the supported size limit."
                        : "The normalized hidden-content payload is invalid."
                };
                return sourceValidation.Status == PersistedPayloadStatus.TooLarge
                    ? StatusCode(StatusCodes.Status413PayloadTooLarge, response)
                    : BadRequest(response);
            }

            var validatedCopy = PersistedPayloadPolicy.CloneValidated(
                userConfiguration);
            PersistedPayloadPolicy.NormalizeLegacyRuntimeState(validatedCopy);
            var validation = PersistedPayloadPolicy.Validate(validatedCopy);
            if (!validation.IsValid)
            {
                var response = new PersistedPayloadErrorResponse
                {
                    Code = validation.Code,
                    Message = validation.Status == PersistedPayloadStatus.TooLarge
                        ? "The normalized hidden-content payload exceeds the supported size limit."
                        : "The normalized hidden-content payload is invalid."
                };
                return validation.Status == PersistedPayloadStatus.TooLarge
                    ? StatusCode(StatusCodes.Status413PayloadTooLarge, response)
                    : BadRequest(response);
            }

            try
            {
                lock (_userConfigurationManager.GetUserFileLock(authorizedUserId, "hidden-content.json"))
                {
                    // Pre-write strict read so a corrupt existing file enters recovery
                    // and returns 503 instead of being overwritten.
                    try
                    {
                        var current = _userConfigurationManager.GetUserConfigurationStrict<UserHiddenContent>(
                            authorizedUserId, "hidden-content.json");
                        if (!PersistedPayloadPolicy.ValidateMutationSource(current).IsValid)
                        {
                            throw new InvalidDataException("Hidden-content state is invalid.");
                        }
                        if (validatedCopy.Settings.Revision != current.Settings.Revision)
                        {
                            return Conflict(new
                            {
                                success = false,
                                conflict = true,
                                message = "Hidden Content preferences changed. Reload and retry.",
                                settings = current.Settings,
                                itemsRevision = current.ItemsRevision,
                                hiddenContent = current
                            });
                        }
                        if (validatedCopy.ItemsRevision != current.ItemsRevision)
                        {
                            return Conflict(new
                            {
                                success = false,
                                conflict = true,
                                message = "Hidden Content items changed. Reload and retry.",
                                settings = current.Settings,
                                itemsRevision = current.ItemsRevision,
                                hiddenContent = current
                            });
                        }

                        var settingsChanged = !string.Equals(
                            PreferenceContentHash(current.Settings),
                            PreferenceContentHash(validatedCopy.Settings),
                            StringComparison.Ordinal);
                        validatedCopy.Settings.Revision = settingsChanged
                            ? checked(current.Settings.Revision + 1)
                            : current.Settings.Revision;
                        validatedCopy.ItemsRevision = current.ItemsRevision;
                        if (!HiddenItemsEqual(current.Items, validatedCopy.Items))
                        {
                            HiddenContentRevision.AdvanceItems(validatedCopy);
                        }
                        validation = PersistedPayloadPolicy.Validate(validatedCopy);
                        if (!validation.IsValid)
                        {
                            var response = new PersistedPayloadErrorResponse
                            {
                                Code = validation.Code,
                                Message = validation.Status == PersistedPayloadStatus.TooLarge
                                    ? "The revisioned hidden-content payload exceeds the supported size limit."
                                    : "The revisioned hidden-content payload is invalid."
                            };
                            return validation.Status == PersistedPayloadStatus.TooLarge
                                ? StatusCode(StatusCodes.Status413PayloadTooLarge, response)
                                : BadRequest(response);
                        }
                    }
                    catch (UserStoreUnhealthyException)
                    {
                        return QuarantinedHiddenStore();
                    }
                    catch (Exception strictEx) when (strictEx is InvalidDataException
                                                  || strictEx is System.Text.Json.JsonException)
                    {
                        _logger.LogWarning(
                            $"hidden-content.json corrupt for {ResolveUserDisplay(authorizedUserId)} " +
                            $"(recovery required; exception={strictEx.GetType().Name}).");
                        return StatusCode(503, new { success = false, message = "Hidden-content store is corrupt and requires administrator recovery." });
                    }
                    catch (IOException ioEx)
                    {
                        _logger.LogWarning(
                            $"hidden-content.json temporarily unreadable for {ResolveUserDisplay(authorizedUserId)} " +
                            $"(exception={ioEx.GetType().Name}).");
                        return StatusCode(500, new { success = false, message = "Hidden-content store is temporarily unavailable. Please retry." });
                    }

                    _userConfigurationManager.SaveUserConfiguration(authorizedUserId, "hidden-content.json", validatedCopy);
                }
                Services.HiddenContentResponseFilter.InvalidateUser(authorizedUserId);
                if (!LogCrossUserFileMutationIfNeeded(
                        authorizedUserId,
                        "hidden-content.json",
                        $"settingsRevision={validatedCopy.Settings.Revision.ToString(CultureInfo.InvariantCulture)}," +
                        $"itemsRevision={validatedCopy.ItemsRevision.ToString(CultureInfo.InvariantCulture)}",
                        "saved"))
                {
                    _logger.LogInformation(
                        $"Saved hidden content for {ResolveUserDisplay(authorizedUserId)} to hidden-content.json " +
                        $"(items={validatedCopy.Items.Count}, bytes={validation.SerializedBytes}).");
                }
                return Ok(new
                {
                    success = true,
                    file = "hidden-content.json",
                    settings = validatedCopy.Settings,
                    itemsRevision = validatedCopy.ItemsRevision
                });
            }
            catch (UserStoreUnhealthyException)
            {
                return QuarantinedHiddenStore();
            }
            catch (Exception ex)
            {
                _logger.LogError(
                    $"Failed to save hidden content for {ResolveUserDisplay(authorizedUserId)} " +
                    $"(exception={ex.GetType().Name}).");
                return StatusCode(500, new { success = false, message = "Failed to save hidden content." });
            }
        }

        // ─── Revisioned preference-subsection administration ───
        // These endpoints never accept the hidden item dictionary. They perform a
        // strict, locked RMW of Settings only and therefore preserve concurrent
        // hide/unhide mutations and every unrelated item.

        [HttpGet("admin/user-settings/{targetUserId}/hidden-content-settings.json")]
        [HttpGet("admin/user-settings/{targetUserId}/hidden-content-settings.json/evidence")]
        [Authorize(Policy = Policies.RequiresElevation)]
        [Produces("application/json")]
        public IActionResult GetTargetHiddenContentSettings(string targetUserId)
        {
            var adminConfiguration = AuthorizeHiddenAdminConfiguration();
            if (adminConfiguration != null) return adminConfiguration;
            var targetError = ResolveExistingTargetUser(
                targetUserId,
                out var targetKey,
                out var targetUser);
            if (targetError != null) return targetError;

            try
            {
                lock (_userConfigurationManager.GetUserFileLock(targetKey, HiddenContentFileName))
                {
                    HiddenContentSettings settings;
                    var itemCount = 0;
                    var read = _userConfigurationManager.ReadUserConfiguration<UserHiddenContent>(
                        targetKey,
                        HiddenContentFileName);
                    if (read.Status == UserConfigReadStatus.Missing)
                    {
                        if (_configProvider.ConfigurationOrNull is not PluginConfiguration defaults)
                        {
                            return HiddenConfigurationUnavailable();
                        }

                        settings = BuildHcDefaultSettings(defaults);
                    }
                    else
                    {
                        if (read.Status != UserConfigReadStatus.Valid || read.Value == null)
                        {
                            _logger.LogWarning(
                                $"Admin hidden-content preference read failed closed for target " +
                                $"{ResolveUserDisplay(targetKey)} (status={read.Status}).");
                            return string.Equals(
                                read.FaultDetail,
                                "quarantined-recovery-required",
                                StringComparison.Ordinal)
                                ? QuarantinedHiddenStore()
                                : StatusCode(StatusCodes.Status503ServiceUnavailable, new
                                {
                                    success = false,
                                    message = "Hidden-content preferences are corrupt or temporarily unavailable."
                                });
                        }

                        var state = read.Value;
                        settings = state.Settings ?? throw new InvalidDataException(
                            "Hidden-content settings are missing.");
                        itemCount = state.Items?.Count ?? 0;
                        if (!PersistedPayloadPolicy.ValidateMutationSource(state).IsValid)
                        {
                            throw new InvalidDataException("Hidden-content state is invalid.");
                        }
                    }

                    if (!PersistedPayloadPolicy.Validate(settings).IsValid)
                    {
                        throw new InvalidDataException("Hidden-content settings are invalid.");
                    }

                    return Ok(PreferenceResponse(
                        HiddenSettingsResource,
                        targetKey,
                        targetUser.Username,
                        ClonePreference(settings),
                        success: true,
                        itemCount: itemCount));
                }
            }
            catch (UserStoreUnhealthyException)
            {
                return QuarantinedHiddenStore();
            }
            catch (Exception ex) when (ex is InvalidDataException or JsonException or IOException)
            {
                _logger.LogWarning(
                    $"Admin hidden-content preference read failed for target {ResolveUserDisplay(targetKey)} " +
                    $"(exception={ex.GetType().Name}).");
                return StatusCode(StatusCodes.Status503ServiceUnavailable, new
                {
                    success = false,
                    message = "Hidden-content preferences are corrupt or temporarily unavailable."
                });
            }
        }

        [HttpPost("admin/user-settings/{targetUserId}/hidden-content-settings.json")]
        [Authorize(Policy = Policies.RequiresElevation)]
        [Produces("application/json")]
        [Consumes("application/json")]
        [RequestSizeLimit(8 * 1024)]
        public IActionResult SaveTargetHiddenContentSettings(
            string targetUserId,
            [FromBody] HiddenContentSettings? body)
        {
            var adminConfiguration = AuthorizeHiddenAdminConfiguration();
            if (adminConfiguration != null) return adminConfiguration;
            var targetError = ResolveExistingTargetUser(
                targetUserId,
                out var targetKey,
                out var targetUser);
            if (targetError != null) return targetError;
            if (body == null || !PersistedPayloadPolicy.Validate(body).IsValid)
            {
                return BadRequest(new
                {
                    success = false,
                    message = "Invalid Hidden Content preference payload."
                });
            }
            var candidate = ClonePreference(body);

            if (!TryParsePreferenceIfMatch(Request, out var expectedRevision))
            {
                return StatusCode(StatusCodes.Status428PreconditionRequired, new
                {
                    success = false,
                    message = "Saving Hidden Content preferences requires one strong quoted If-Match revision from the latest GET."
                });
            }
            if (candidate.Revision != expectedRevision)
            {
                return BadRequest(new
                {
                    success = false,
                    message = "The body Revision must match If-Match."
                });
            }

            try
            {
                TargetPreferenceResponse<HiddenContentSettings> response;
                var changed = false;
                lock (_userConfigurationManager.GetUserFileLock(targetKey, HiddenContentFileName))
                {
                    var classified = _userConfigurationManager.ReadUserConfiguration<UserHiddenContent>(
                        targetKey,
                        HiddenContentFileName);
                    var missing = RequireHiddenMutationRead(targetKey, classified)
                        == UserConfigReadStatus.Missing;
                    var state = _userConfigurationManager.GetUserConfigurationStrict<UserHiddenContent>(
                        targetKey,
                        HiddenContentFileName);
                    if (missing)
                    {
                        if (_configProvider.ConfigurationOrNull is not PluginConfiguration defaults)
                        {
                            throw new InvalidDataException(
                                "Configured Hidden Content defaults are unavailable.");
                        }

                        state.Settings = BuildHcDefaultSettings(defaults);
                    }

                    var current = state.Settings ?? throw new InvalidDataException(
                        "Hidden-content settings are missing.");
                    if (!PersistedPayloadPolicy.Validate(current).IsValid
                        || !PersistedPayloadPolicy
                            .ValidateMutationSource(state).IsValid)
                    {
                        throw new InvalidDataException("Hidden-content state is invalid.");
                    }
                    if (current.Revision != expectedRevision)
                    {
                        response = PreferenceResponse(
                            HiddenSettingsResource,
                            targetKey,
                            targetUser.Username,
                            current,
                            success: false,
                            conflict: true,
                            message: "Hidden Content preferences changed. Rebase on the returned state.",
                            itemCount: state.Items.Count);
                        return Conflict(response);
                    }
                    // Admin-target preference controls edit only schema-owned
                    // fields. Unknown extension members are opaque persisted
                    // data and must never be replaced by the browser's lossy
                    // JSON number projection.
                    candidate.ExtensionData =
                        PersistedPayloadPolicy.PreserveExistingExtensionData(
                            candidate.ExtensionData,
                            current.ExtensionData);
                    if (string.Equals(
                        PreferenceContentHash(current),
                        PreferenceContentHash(candidate),
                        StringComparison.Ordinal))
                    {
                        return Ok(PreferenceResponse(
                            HiddenSettingsResource,
                            targetKey,
                            targetUser.Username,
                            current,
                            success: true,
                            itemCount: state.Items.Count));
                    }

                    candidate.Revision = checked(current.Revision + 1);
                    state.Settings = candidate;
                    var validation = PersistedPayloadPolicy
                        .ValidateMutationSource(state);
                    if (!validation.IsValid)
                    {
                        return validation.Status == PersistedPayloadStatus.TooLarge
                            ? StatusCode(StatusCodes.Status413PayloadTooLarge, new
                            {
                                success = false,
                                message = "The resulting hidden-content state exceeds the supported limit."
                            })
                            : BadRequest(new
                            {
                                success = false,
                                message = "The resulting hidden-content state is invalid."
                            });
                    }

                    _userConfigurationManager.SaveUserConfiguration(
                        targetKey,
                        HiddenContentFileName,
                        state);
                    changed = true;
                    response = PreferenceResponse(
                        HiddenSettingsResource,
                        targetKey,
                        targetUser.Username,
                        candidate,
                        success: true,
                        itemCount: state.Items.Count);
                }

                if (changed) HiddenContentResponseFilter.InvalidateUser(targetKey);
                var actor = UserHelper.GetCurrentUserId(User)?.ToString("N") ?? "elevated-principal";
                _logger.LogInformation(
                    $"Admin {ResolveUserDisplay(actor)} updated Hidden Content preferences for " +
                    $"{ResolveUserDisplay(targetKey)} at revision {response.Revision}.");
                return Ok(response);
            }
            catch (UserStoreUnhealthyException)
            {
                return QuarantinedHiddenStore();
            }
            catch (Exception ex) when (ex is InvalidDataException or JsonException or IOException
                                      or UnauthorizedAccessException or OverflowException)
            {
                _logger.LogWarning(
                    $"Admin Hidden Content preference write failed for target {ResolveUserDisplay(targetKey)} " +
                    $"(exception={ex.GetType().Name}).");
                return StatusCode(StatusCodes.Status503ServiceUnavailable, new
                {
                    success = false,
                    message = "Hidden-content preferences are unavailable; no write was acknowledged."
                });
            }
        }

        // ─── Admin cross-user hidden-content visibility ───
        // Lets an admin see what other users have hidden, surfaced as a read-only user filter on
        // the Hidden Content page/tab. Both endpoints are admin-gated server-side via
        // [Authorize(Policy = Policies.RequiresElevation)] (bare 403 for non-admins)
        // and never mutate another user's data — the client `isAdmin` flag is a UX convenience only,
        // never the security boundary. See the js/enhanced/hidden-content-page-* modules for the consuming UI.

        /// <summary>
        /// Admin-only: lists users who have hidden at least one item, together with their
        /// hidden-item count, to populate the admin user-filter dropdown on the Hidden Content page.
        /// The calling admin is excluded because their own list is shown via the default view.
        /// </summary>
        /// <remarks>
        /// Candidate directory enumeration is cheap, but full hidden-content
        /// payloads are deserialized for at most one bounded page. The returned
        /// cursor is opaque to clients and pagination never accumulates state on
        /// the server.
        /// </remarks>
        [HttpGet("admin/hidden-content-users")]
        [Authorize(Policy = Policies.RequiresElevation)]
        [Produces("application/json")]
        public IActionResult GetHiddenContentUsers(
            [FromQuery] int? limit = null,
            [FromQuery] string? cursor = null)
        {
            // Honour the admin config toggle: the whole cross-user feature can be disabled.
            var adminConfiguration = AuthorizeHiddenAdminConfiguration();
            if (adminConfiguration != null) return adminConfiguration;

            const int maximumPageSize = 100;
            var pageSize = limit ?? maximumPageSize;
            if (pageSize is < 1 or > maximumPageSize)
            {
                return BadRequest(new
                {
                    success = false,
                    message = $"limit must be between 1 and {maximumPageSize}."
                });
            }

            string? cursorKey = null;
            if (!string.IsNullOrEmpty(cursor))
            {
                if (!Guid.TryParseExact(cursor, "N", out var cursorGuid)
                    || cursorGuid == Guid.Empty
                    || !string.Equals(
                        cursor,
                        cursorGuid.ToString("N"),
                        StringComparison.Ordinal))
                {
                    return BadRequest(new
                    {
                        success = false,
                        message = "Invalid cursor."
                    });
                }

                cursorKey = cursor;
            }

            // The caller's own list is reachable through the default "My hidden content" option,
            // so omit them here to avoid a confusing duplicate entry.
            var currentUserIdN = UserHelper.GetCurrentUserId(User)?.ToString("N");

            // Preserve IUserManager's authoritative user order, seek the opaque
            // cursor, and stop after one bounded page plus lookahead. No complete
            // user/config-directory snapshot is allocated or sorted.
            var window = new List<(string UserId, string UserName)>(pageSize + 1);
            try
            {
                var afterCursor = cursorKey == null;
                foreach (var user in _userManager.GetUsers())
                {
                    if (user == null || user.Id == Guid.Empty) continue;
                    var userIdN = user.Id.ToString("N");
                    if (string.Equals(
                        userIdN,
                        currentUserIdN,
                        StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }

                    if (!afterCursor)
                    {
                        if (string.Equals(userIdN, cursorKey, StringComparison.Ordinal))
                        {
                            afterCursor = true;
                        }

                        continue;
                    }

                    window.Add((userIdN, user.Username));
                    if (window.Count > pageSize) break;
                }

                if (!afterCursor)
                {
                    return BadRequest(new
                    {
                        success = false,
                        message = "The cursor is no longer present in the Jellyfin user directory."
                    });
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(
                    $"Unable to enumerate Hidden Content users: {ex.GetType().Name}: {ex.Message}");
                return StatusCode(StatusCodes.Status503ServiceUnavailable, new
                {
                    success = false,
                    message = "Hidden Content users are temporarily unavailable."
                });
            }

            var truncated = window.Count > pageSize;
            var page = window.Take(pageSize).ToList();
            var nextCursor = truncated && page.Count > 0 ? page[^1].UserId : null;

            var users = new List<(string UserId, string UserName, int Count)>();
            foreach (var candidate in page)
            {
                var userIdN = candidate.UserId;
                try
                {
                    var read = _userConfigurationManager
                        .ReadExistingUserConfiguration<UserHiddenContent>(
                            userIdN,
                            HiddenContentFileName);
                    if (read.Status == UserConfigReadStatus.Missing)
                        continue;
                    if (read.IsFault || !read.HasUsableValue || read.Value == null)
                    {
                        _logger.LogWarning(
                            $"Hidden Content user page failed closed for " +
                            $"{ResolveUserDisplay(userIdN)} (status={read.Status}).");
                        return StatusCode(StatusCodes.Status503ServiceUnavailable, new
                        {
                            success = false,
                            message = "A Hidden Content user record is corrupt or temporarily unavailable."
                        });
                    }
                    if (!PersistedPayloadPolicy
                        .ValidateMutationSource(read.Value).IsValid)
                    {
                        _logger.LogWarning(
                            $"Hidden Content user page rejected invalid persisted state for " +
                            $"{ResolveUserDisplay(userIdN)}.");
                        return StatusCode(StatusCodes.Status503ServiceUnavailable, new
                        {
                            success = false,
                            message = "A Hidden Content user record is invalid."
                        });
                    }

                    var count = read.Value.Items?.Count ?? 0;
                    if (count == 0)
                        continue;

                    users.Add((userIdN, candidate.UserName, count));
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(
                        $"Hidden Content user page failed for {ResolveUserDisplay(userIdN)}: " +
                        $"{ex.GetType().Name}: {ex.Message}");
                    return StatusCode(StatusCodes.Status503ServiceUnavailable, new
                    {
                        success = false,
                        message = "Hidden Content users are temporarily unavailable."
                    });
                }
            }

            var result = users
                .OrderBy(u => u.UserName, StringComparer.OrdinalIgnoreCase)
                .Select(u => new { userId = u.UserId, userName = u.UserName, count = u.Count })
                .ToList();

            return Ok(new
            {
                users = result,
                limit = pageSize,
                scanned = page.Count,
                truncated,
                nextCursor
            });
        }

        /// <summary>
        /// Admin-only: returns a single user's hidden content (read-only) so an admin can review
        /// what that user has hidden. Validates the id format and never writes.
        /// </summary>
        [HttpGet("admin/hidden-content/{userId}")]
        [Authorize(Policy = Policies.RequiresElevation)]
        [Produces("application/json")]
        public IActionResult GetUserHiddenContentForAdmin(string userId)
        {
            // Honour the admin config toggle.
            var adminConfiguration = AuthorizeHiddenAdminConfiguration();
            if (adminConfiguration != null) return adminConfiguration;

            // Match the AdminUpsertReview contract: expect a 32-char hex (N-format) id. This also
            // guards the filesystem path independently of GetUserConfigDir()'s canonicalization.
            if (string.IsNullOrWhiteSpace(userId) || !Guid.TryParseExact(userId, "N", out var userGuid) || userGuid == Guid.Empty)
                return BadRequest(new { success = false, message = "Invalid userId (expected 32-char hex)." });

            // Resolve the user before touching the config store: this returns a clean 404 for an
            // unknown id and avoids creating an empty per-user directory as a read side effect.
            var targetError = ResolveExistingTargetUser(
                userGuid.ToString("N"),
                out var userIdN,
                out var user);
            if (targetError != null) return targetError;

            try
            {
                lock (_userConfigurationManager.GetUserFileLock(userIdN, HiddenContentFileName))
                {
                    // Only a classified Missing result is a legitimate empty
                    // state. File.Exists-style probes collapse I/O failures to
                    // false and could otherwise present an unavailable store as
                    // a convincing empty list.
                    var read = _userConfigurationManager.ReadUserConfiguration<UserHiddenContent>(
                        userIdN,
                        HiddenContentFileName);
                    if (read.IsFault || !read.HasUsableValue || read.Value == null)
                    {
                        _logger.LogWarning(
                            $"Admin hidden-content read failed closed for " +
                            $"{ResolveUserDisplay(userIdN)} (status={read.Status}).");
                        return string.Equals(
                            read.FaultDetail,
                            "quarantined-recovery-required",
                            StringComparison.Ordinal)
                            ? QuarantinedHiddenStore()
                            : StatusCode(StatusCodes.Status503ServiceUnavailable, new
                            {
                                success = false,
                                message = "Hidden-content state is corrupt or temporarily unavailable."
                            });
                    }

                    UserHiddenContent config;
                    if (read.Status == UserConfigReadStatus.Missing)
                    {
                        if (_configProvider.ConfigurationOrNull is not PluginConfiguration defaults)
                        {
                            return HiddenConfigurationUnavailable();
                        }

                        config = new UserHiddenContent
                        {
                            Settings = BuildHcDefaultSettings(defaults)
                        };
                    }
                    else
                    {
                        config = read.Value;
                    }

                    var responseConfig = ClonePersisted(config);
                    PersistedPayloadPolicy.NormalizeLegacyRuntimeState(
                        responseConfig);
                    if (!PersistedPayloadPolicy
                        .ValidateMutationCandidate(responseConfig).IsValid)
                    {
                        throw new InvalidDataException("Hidden-content state is invalid.");
                    }

                    SetAdminHiddenItemsEvidence(responseConfig.ItemsRevision);
                    return Ok(new
                    {
                        userId = userIdN,
                        userName = user.Username,
                        hiddenContent = responseConfig
                    });
                }
            }
            catch (UserStoreUnhealthyException)
            {
                return QuarantinedHiddenStore();
            }
            catch (Exception ex) when (ex is InvalidDataException or JsonException)
            {
                _logger.LogWarning(
                    $"Admin hidden-content read failed closed for {ResolveUserDisplay(userIdN)} " +
                    $"(exception={ex.GetType().Name}).");
                return StatusCode(StatusCodes.Status503ServiceUnavailable, new
                {
                    success = false,
                    message = "Hidden-content state is corrupt and requires administrator recovery."
                });
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"Admin hidden-content read failed for {ResolveUserDisplay(userIdN)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to load hidden content." });
            }
        }

        /// <summary>
        /// Admin-only: unhides one or more items from another user's hidden content
        /// (admin editing). The body is a JSON array of item keys (keys of UserHiddenContent.Items).
        /// Read-modify-write under the per-user file lock so it can't clobber a concurrent change by
        /// the user themselves. Returns how many items were actually removed.
        /// </summary>
        [HttpPost("admin/hidden-content/{userId}/unhide")]
        [Authorize(Policy = Policies.RequiresElevation)]
        [Produces("application/json")]
        [Consumes("application/json")]
        [RequestSizeLimit(64 * 1024)]
        public IActionResult AdminUnhideForUser(string userId, [FromBody] List<string> keys)
        {
            // Honour the admin config toggle: cross-user management can be disabled.
            var adminConfiguration = AuthorizeHiddenAdminConfiguration();
            if (adminConfiguration != null) return adminConfiguration;

            if (string.IsNullOrWhiteSpace(userId) || !Guid.TryParseExact(userId, "N", out var userGuid) || userGuid == Guid.Empty)
                return BadRequest(new { success = false, message = "Invalid userId (expected 32-char hex)." });

            var targetError = ResolveExistingTargetUser(
                userGuid.ToString("N"),
                out var userIdN,
                out var user);
            if (targetError != null) return targetError;

            if (!TryParsePreferenceIfMatch(Request, out var expectedRevision))
            {
                return StatusCode(StatusCodes.Status428PreconditionRequired, new
                {
                    success = false,
                    message = "Admin Hidden Content item changes require one strong quoted If-Match items revision from the latest GET."
                });
            }

            if (keys == null || keys.Count == 0)
                return BadRequest(new { success = false, message = "No item keys provided." });
            if (keys.Count > MaximumAdminItemBatch)
                return BadRequest(new { success = false, message = $"Too many item keys (max {MaximumAdminItemBatch})." });
            if (keys.Any(static key => string.IsNullOrEmpty(key) || key.Length > PersistedPayloadPolicy.MaximumHiddenKeyLength))
                return BadRequest(new { success = false, message = "One or more item keys are invalid." });
            var boundedKeys = keys.Distinct(StringComparer.Ordinal).ToArray();

            try
            {
                var removed = 0;
                var itemsRevision = 0L;
                var conflict = false;
                // RMW holds the per-user file lock, strict-reads (corruption → quarantine + throw), applies
                // the mutation, and persists only when it reports a change (returns > 0).
                _userConfigurationManager.RmwUserConfiguration<UserHiddenContent>(userIdN, "hidden-content.json", cfg =>
                {
                    RequireHiddenMutationRead(
                        userIdN,
                        _userConfigurationManager.ReadUserConfiguration<UserHiddenContent>(
                            userIdN,
                            HiddenContentFileName));
                    if (!PersistedPayloadPolicy.ValidateMutationSource(cfg).IsValid)
                    {
                        throw new InvalidDataException("Hidden-content state is invalid.");
                    }
                    itemsRevision = cfg.ItemsRevision;
                    if (itemsRevision != expectedRevision)
                    {
                        conflict = true;
                        return 0;
                    }

                    var count = 0;
                    foreach (var key in boundedKeys)
                    {
                        if (cfg.Items.Remove(key)) count++;
                    }
                    if (count > 0)
                    {
                        HiddenContentRevision.AdvanceItems(cfg);
                        PersistedPayloadPolicy.NormalizeLegacyRuntimeState(cfg);
                    }
                    if (count > 0)
                    {
                        var validation = PersistedPayloadPolicy
                            .ValidateMutationCandidate(cfg);
                        if (!validation.IsValid)
                        {
                            if (validation.Status == PersistedPayloadStatus.TooLarge)
                                throw new HiddenAdminPayloadTooLargeException();
                            throw new InvalidDataException("Hidden-content state is invalid.");
                        }
                    }
                    removed = count;
                    itemsRevision = cfg.ItemsRevision;
                    return count;
                });

                if (conflict)
                {
                    return AdminHiddenItemsConflict(
                        userIdN,
                        user.Username,
                        itemsRevision);
                }

                if (removed > 0)
                    Services.HiddenContentResponseFilter.InvalidateUser(userIdN);
                LogCrossUserFileMutationIfNeeded(
                    userIdN,
                    HiddenContentFileName,
                    $"itemsRevision={itemsRevision.ToString(CultureInfo.InvariantCulture)}",
                    "unhid items in",
                    explicitTargetUserId: userIdN);
                SetAdminHiddenItemsEvidence(itemsRevision);
                return Ok(new
                {
                    success = true,
                    removed,
                    itemsRevision,
                    userId = userIdN,
                    userName = user.Username,
                    targetUserId = userIdN,
                    targetDisplayName = user.Username
                });
            }
            catch (UserStoreUnhealthyException)
            {
                return QuarantinedHiddenStore();
            }
            catch (HiddenAdminPayloadTooLargeException)
            {
                return StatusCode(StatusCodes.Status413PayloadTooLarge, new
                {
                    success = false,
                    message = "The resulting hidden-content state exceeds the supported limit."
                });
            }
            catch (Exception ex) when (ex is InvalidDataException || ex is System.Text.Json.JsonException)
            {
                _logger.LogWarning($"hidden-content.json corrupt for {ResolveUserDisplay(userIdN)} during admin unhide (recovery required): {ex.Message}");
                return StatusCode(503, new { success = false, message = "Hidden-content store is corrupt and requires administrator recovery." });
            }
            catch (IOException ioEx)
            {
                _logger.LogWarning($"hidden-content.json temporarily unreadable for {ResolveUserDisplay(userIdN)}: {ioEx.Message}");
                return StatusCode(503, new { success = false, message = "Hidden-content store is temporarily unavailable. Please retry." });
            }
            catch (Exception ex)
            {
                _logger.LogError($"Admin unhide failed for {ResolveUserDisplay(userIdN)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to update hidden content." });
            }
        }

        /// <summary>
        /// Admin-only: hides one or more items on behalf of another user (admin adding).
        /// The body is a list of hidden-content items (the same shape the client stores). Each is keyed
        /// by its exact Jellyfin item id (or versioned provider identity) and RMW-merged into the user's hidden-content.json without
        /// overwriting an item the user already hid. Returns how many were newly added.
        /// </summary>
        [HttpPost("admin/hidden-content/{userId}/hide")]
        [Authorize(Policy = Policies.RequiresElevation)]
        [Produces("application/json")]
        [Consumes("application/json")]
        [RequestSizeLimit(512 * 1024)]
        public IActionResult AdminHideForUser(string userId, [FromBody] List<HiddenContentItem> items)
        {
            // Adding is a management operation: gated by the admin config toggle.
            var adminConfiguration = AuthorizeHiddenAdminConfiguration();
            if (adminConfiguration != null) return adminConfiguration;

            if (string.IsNullOrWhiteSpace(userId) || !Guid.TryParseExact(userId, "N", out var userGuid) || userGuid == Guid.Empty)
                return BadRequest(new { success = false, message = "Invalid userId (expected 32-char hex)." });

            var targetError = ResolveExistingTargetUser(
                userGuid.ToString("N"),
                out var userIdN,
                out var user);
            if (targetError != null) return targetError;

            if (!TryParsePreferenceIfMatch(Request, out var expectedRevision))
            {
                return StatusCode(StatusCodes.Status428PreconditionRequired, new
                {
                    success = false,
                    message = "Admin Hidden Content item changes require one strong quoted If-Match items revision from the latest GET."
                });
            }

            if (items == null || items.Count == 0)
                return BadRequest(new { success = false, message = "No items provided." });
            if (items.Count > MaximumAdminItemBatch)
                return BadRequest(new { success = false, message = $"Too many items (max {MaximumAdminItemBatch})." });

            // Trim any admin-supplied string to a sane maximum before it is written to another user's store.
            static string Clamp(string? s, int max) =>
                string.IsNullOrEmpty(s) ? string.Empty : (s.Length <= max ? s : s.Substring(0, max));

            static HiddenContentIdentity? ResolveIdentity(HiddenContentItem item)
            {
                var mediaType = item.Identity?.MediaType;
                var provider = item.Identity?.Provider;
                var id = item.Identity?.Id;
                if (item.Identity != null)
                {
                    if (item.Identity.Version != 1
                        || !string.Equals(provider, "tmdb", StringComparison.Ordinal)
                        || (mediaType != "movie" && mediaType != "tv")
                        || string.IsNullOrEmpty(id)
                        || id.Length > 32
                        || id.Any(static c => c < '0' || c > '9')
                        || id.All(static c => c == '0')
                        || (!string.IsNullOrEmpty(item.TmdbId) && !string.Equals(item.TmdbId, id, StringComparison.Ordinal))) return null;

                    return new HiddenContentIdentity { Version = 1, Provider = "tmdb", MediaType = mediaType, Id = id };
                }

                mediaType = string.Equals(item.Type, "Movie", StringComparison.OrdinalIgnoreCase) ? "movie"
                    : (string.Equals(item.Type, "Series", StringComparison.OrdinalIgnoreCase) ? "tv" : null);
                id = item.TmdbId;
                if ((mediaType != "movie" && mediaType != "tv")
                    || string.IsNullOrEmpty(id)
                    || id.Length > 32
                    || id.Any(static c => c < '0' || c > '9')
                    || id.All(static c => c == '0')) return null;
                return new HiddenContentIdentity { Version = 1, Provider = "tmdb", MediaType = mediaType, Id = id };
            }

            static HiddenContentItem BuildTrustedLocalItem(
                BaseItem libraryItem,
                string? requestedScope)
            {
                var typeName = libraryItem.GetType().Name;
                var tmdbId = libraryItem.ProviderIds.TryGetValue("Tmdb", out var providerTmdbId)
                    ? providerTmdbId
                    : string.Empty;
                var mediaType = string.Equals(typeName, "Movie", StringComparison.Ordinal)
                    ? "movie"
                    : (string.Equals(typeName, "Series", StringComparison.Ordinal) ? "tv" : null);
                HiddenContentIdentity? identity = null;
                if (mediaType != null
                    && !string.IsNullOrEmpty(tmdbId)
                    && tmdbId.Length <= 32
                    && tmdbId.All(static c => c >= '0' && c <= '9')
                    && tmdbId.Any(static c => c != '0'))
                {
                    identity = new HiddenContentIdentity
                    {
                        Version = 1,
                        Provider = "tmdb",
                        MediaType = mediaType,
                        Id = tmdbId
                    };
                }

                var entry = new HiddenContentItem
                {
                    ItemId = libraryItem.Id.ToString("N"),
                    Name = PersistedPayloadPolicy.ClampPersistedDisplayName(
                        libraryItem.Name),
                    Type = Clamp(typeName, 64),
                    TmdbId = identity?.Id ?? string.Empty,
                    Identity = identity,
                    HiddenAt = DateTime.UtcNow.ToString(
                        "o",
                        System.Globalization.CultureInfo.InvariantCulture),
                    HideScope = requestedScope is "global" or "continuewatching" or "nextup" or "homesections"
                        ? requestedScope
                        : "global"
                };

                if (libraryItem is MediaBrowser.Controller.Entities.TV.Episode episode)
                {
                    entry.SeriesId = episode.SeriesId == Guid.Empty
                        ? string.Empty
                        : episode.SeriesId.ToString("N");
                    entry.SeriesName = PersistedPayloadPolicy
                        .ClampPersistedDisplayName(episode.SeriesName);
                    entry.SeasonNumber = PersistedPayloadPolicy.NormalizeHiddenIndex(
                        episode.ParentIndexNumber);
                    entry.EpisodeNumber = PersistedPayloadPolicy.NormalizeHiddenIndex(
                        episode.IndexNumber);
                }

                return entry;
            }

            static bool HasLocalItem(UserHiddenContent config, Guid itemId)
                => config.Items.Any(pair =>
                    (Guid.TryParse(pair.Key, out var keyId) && keyId == itemId)
                    || (pair.Value != null
                        && Guid.TryParse(pair.Value.ItemId, out var valueId)
                        && valueId == itemId));

            try
            {
                // Treat every non-empty ItemId as a local Jellyfin identity. Resolve
                // it in the TARGET user's library projection and derive persisted
                // metadata from that authoritative item. An administrator's own
                // visibility must never grant the target a hidden row for content
                // they cannot access. Empty ItemId remains the separate provider-
                // only (Seerr/TMDB) path.
                var preparedItems = new List<HiddenContentItem>(items.Count);
                foreach (var source in items)
                {
                    if (source == null) continue;
                    if (string.IsNullOrEmpty(source.ItemId))
                    {
                        preparedItems.Add(ClonePersisted(source));
                        continue;
                    }

                    if ((!Guid.TryParseExact(source.ItemId, "N", out var localItemId)
                            && !Guid.TryParseExact(source.ItemId, "D", out localItemId))
                        || localItemId == Guid.Empty)
                    {
                        return BadRequest(new
                        {
                            success = false,
                            message = "A local ItemId is invalid."
                        });
                    }

                    var libraryItem = _libraryManager.GetItemById<BaseItem>(localItemId, user);
                    if (libraryItem == null || libraryItem.Id != localItemId)
                    {
                        return NotFound(new
                        {
                            success = false,
                            message = "A local item was not found or is not accessible to the target user."
                        });
                    }

                    preparedItems.Add(BuildTrustedLocalItem(libraryItem, source.HideScope));
                }

                var added = 0;
                var itemsRevision = 0L;
                var conflict = false;
                _userConfigurationManager.TransactUserConfiguration<UserHiddenContent, int>(
                    userIdN,
                    HiddenContentFileName,
                    cfg =>
                    {
                        // Classify existence only after the transaction owns the
                        // exact file lock. A zero-item file is an existing
                        // preference store and must not be reseeded, while an I/O
                        // fault must never be collapsed into a missing store.
                        var missing = RequireHiddenMutationRead(
                            userIdN,
                            _userConfigurationManager.ReadUserConfiguration<UserHiddenContent>(
                                userIdN,
                                HiddenContentFileName))
                            == UserConfigReadStatus.Missing;
                        if (!PersistedPayloadPolicy.ValidateMutationSource(cfg).IsValid)
                        {
                            throw new InvalidDataException("Hidden-content state is invalid.");
                        }
                        itemsRevision = cfg.ItemsRevision;
                        if (itemsRevision != expectedRevision)
                        {
                            conflict = true;
                            return 0;
                        }

                        if (missing)
                        {
                            if (_configProvider.ConfigurationOrNull is not PluginConfiguration defaults)
                            {
                                throw new InvalidDataException(
                                    "Configured Hidden Content defaults are unavailable.");
                            }

                            // Admin item management follows configured first-user
                            // defaults exactly; unlike a user's scoped hide action,
                            // it does not implicitly enable Hidden Content.
                            cfg.Settings = BuildHcDefaultSettings(defaults);
                        }

                        var count = 0;
                        foreach (var source in preparedItems)
                        {
                            var it = source;
                            var identity = ResolveIdentity(it);
                            // An explicit identity is authoritative. Unknown versions and malformed
                            // values must not be silently downgraded to an exact-only or legacy row.
                            if (it.Identity != null && identity == null) continue;
                            // Exact local identity wins. Provider-only rows use the same
                            // versioned key as the browser; ambiguous legacy rows are refused.
                            var key = !string.IsNullOrEmpty(it.ItemId)
                                ? it.ItemId
                                : (identity != null ? $"hc1:tmdb:{identity.MediaType}:{identity.Id}" : null);
                            if (string.IsNullOrEmpty(key) || key.Length > 256) continue;
                            if (cfg.Items.ContainsKey(key)) continue; // never clobber the user's own hide
                            if (Guid.TryParse(it.ItemId, out var exactItemId)
                                && HasLocalItem(cfg, exactItemId)) continue;
                            if (identity != null && string.IsNullOrEmpty(it.ItemId) && cfg.Items.Values.Any(existing =>
                            {
                                if (existing == null) return false;
                                var current = ResolveIdentity(existing);
                                return current != null
                                    && string.Equals(current.Provider, identity.Provider, StringComparison.Ordinal)
                                    && string.Equals(current.MediaType, identity.MediaType, StringComparison.Ordinal)
                                    && string.Equals(current.Id, identity.Id, StringComparison.Ordinal);
                            })) continue;
                            // Cross-user write path: bound the admin-supplied free-text fields and constrain
                            // HideScope to the known set, so a compromised admin token can't persist multi-MB
                            // strings or an unrecognised scope into another user's store.
                            it.Name = PersistedPayloadPolicy.ClampPersistedDisplayName(
                                it.Name);
                            it.SeriesName = PersistedPayloadPolicy
                                .ClampPersistedDisplayName(it.SeriesName);
                            it.PosterPath = Clamp(it.PosterPath, 512);
                            it.SeriesId = Clamp(it.SeriesId, 128);
                            it.Type = Clamp(it.Type, 64);
                            it.TmdbId = Clamp(it.TmdbId, 32);
                            it.Identity = identity;
                            it.HiddenAt = string.IsNullOrEmpty(it.HiddenAt) ? DateTime.UtcNow.ToString("o") : Clamp(it.HiddenAt, 64);
                            it.SeasonNumber = PersistedPayloadPolicy.NormalizeHiddenIndex(
                                it.SeasonNumber);
                            it.EpisodeNumber = PersistedPayloadPolicy.NormalizeHiddenIndex(
                                it.EpisodeNumber);
                            it.HideScope = it.HideScope is "global" or "continuewatching" or "nextup" or "homesections" ? it.HideScope : "global";
                            if (cfg.Items.Count >= PersistedPayloadPolicy.MaximumHiddenItems)
                            {
                                throw new HiddenItemCapacityExceededException();
                            }
                            cfg.Items[key] = it;
                            count++;
                        }
                        if (count > 0)
                        {
                            HiddenContentRevision.AdvanceItems(cfg);
                            PersistedPayloadPolicy.NormalizeLegacyRuntimeState(cfg);
                        }
                        if (count > 0)
                        {
                            var validation = PersistedPayloadPolicy
                                .ValidateMutationCandidate(cfg);
                            if (!validation.IsValid)
                            {
                                if (validation.Status == PersistedPayloadStatus.TooLarge)
                                    throw new HiddenAdminPayloadTooLargeException();
                                throw new InvalidDataException("Hidden-content state is invalid.");
                            }
                        }
                        added = count;
                        itemsRevision = cfg.ItemsRevision;
                        if (count > 0)
                        {
                            _userConfigurationManager.SaveUserConfiguration(
                                userIdN,
                                HiddenContentFileName,
                                cfg);
                        }

                        return count;
                    });

                if (conflict)
                {
                    return AdminHiddenItemsConflict(
                        userIdN,
                        user.Username,
                        itemsRevision);
                }

                if (added > 0)
                    Services.HiddenContentResponseFilter.InvalidateUser(userIdN);
                LogCrossUserFileMutationIfNeeded(
                    userIdN,
                    HiddenContentFileName,
                    $"itemsRevision={itemsRevision.ToString(CultureInfo.InvariantCulture)}",
                    "hid items in",
                    explicitTargetUserId: userIdN);
                SetAdminHiddenItemsEvidence(itemsRevision);
                return Ok(new
                {
                    success = true,
                    added,
                    itemsRevision,
                    userId = userIdN,
                    userName = user.Username,
                    targetUserId = userIdN,
                    targetDisplayName = user.Username
                });
            }
            catch (UserStoreUnhealthyException)
            {
                return QuarantinedHiddenStore();
            }
            catch (HiddenAdminPayloadTooLargeException)
            {
                return StatusCode(StatusCodes.Status413PayloadTooLarge, new
                {
                    success = false,
                    message = "The resulting hidden-content state exceeds the supported limit."
                });
            }
            catch (HiddenItemCapacityExceededException)
            {
                return HiddenItemCapacityExceeded();
            }
            catch (Exception ex) when (ex is InvalidDataException || ex is System.Text.Json.JsonException)
            {
                _logger.LogWarning($"hidden-content.json corrupt for {ResolveUserDisplay(userIdN)} during admin hide (recovery required): {ex.Message}");
                return StatusCode(503, new { success = false, message = "Hidden-content store is corrupt and requires administrator recovery." });
            }
            catch (IOException ioEx)
            {
                _logger.LogWarning($"hidden-content.json temporarily unreadable for {ResolveUserDisplay(userIdN)}: {ioEx.Message}");
                return StatusCode(503, new { success = false, message = "Hidden-content store is temporarily unavailable. Please retry." });
            }
            catch (Exception ex)
            {
                _logger.LogError($"Admin hide failed for {ResolveUserDisplay(userIdN)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to update hidden content." });
            }
        }

        // ─── Remove from Continue Watching ─── HideScope=continuewatching in hidden-content.json; surfaced via HC's management page.

        // Picks the WIDER of two HC scopes; disjoint rank-2 scopes (continuewatching ⊕ nextup) compose to homesections.
        private static string? WiderScope(string? a, string? b)
        {
            if (string.IsNullOrEmpty(a)) return b;
            if (string.IsNullOrEmpty(b)) return a;
            var ra = ScopeRank(a);
            var rb = ScopeRank(b);
            if (ra == 2 && rb == 2 && !string.Equals(a, b, StringComparison.OrdinalIgnoreCase)) return "homesections";
            return ra >= rb ? a : b;
        }

        private static int ScopeRank(string scope)
        {
            if (string.Equals(scope, "global", StringComparison.OrdinalIgnoreCase)) return 4;
            if (string.Equals(scope, "homesections", StringComparison.OrdinalIgnoreCase)) return 3;
            if (string.Equals(scope, "nextup", StringComparison.OrdinalIgnoreCase)
                || string.Equals(scope, "continuewatching", StringComparison.OrdinalIgnoreCase)) return 2;
            return 1; // unknown / future
        }

        private static string? EarliestHiddenAt(string? a, string? b)
        {
            DateTime? da = TryParseIso(a);
            DateTime? db = TryParseIso(b);
            if (da == null) return b ?? a;
            if (db == null) return a;
            return da <= db ? a : b;
        }

        private static DateTime? TryParseIso(string? s)
        {
            if (string.IsNullOrWhiteSpace(s)) return null;
            return DateTime.TryParse(s, System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.RoundtripKind, out var dt) ? (DateTime?)dt : null;
        }

        // Widens an existing HC scope to also cover a new targetScope (continuewatching|nextup)
        // hide without ever narrowing the user's earlier intent. Mirrors the client-side
        // mergeCwScope in hidden-content.js: global/homesections stay; same scope stays; the
        // other home surface (or any unknown value) composes up to homesections.
        private static string MergeHomeScope(string existing, string targetScope)
        {
            if (string.IsNullOrEmpty(existing)) return targetScope;
            if (string.Equals(existing, "global", StringComparison.OrdinalIgnoreCase)) return "global";
            if (string.Equals(existing, "homesections", StringComparison.OrdinalIgnoreCase)) return "homesections";
            if (string.Equals(existing, targetScope, StringComparison.OrdinalIgnoreCase)) return targetScope;
            return "homesections";
        }

        [HttpPost("continue-watching/hide/{itemId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult HideFromContinueWatching(string itemId) => HideFromHomeSurface(itemId, "continuewatching");

        [HttpPost("next-up/hide/{itemId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult HideFromNextUp(string itemId) => HideFromHomeSurface(itemId, "nextup");

        private static bool TryCreateHiddenContentItemProjection(
            BaseItem item,
            out HiddenContentItemProjection projection)
        {
            HiddenContentItemKind kind;
            switch (item)
            {
                case MediaBrowser.Controller.Entities.Movies.Movie:
                    kind = HiddenContentItemKind.Movie;
                    break;
                case MediaBrowser.Controller.Entities.TV.Series:
                    kind = HiddenContentItemKind.Series;
                    break;
                case MediaBrowser.Controller.Entities.TV.Episode:
                    kind = HiddenContentItemKind.Episode;
                    break;
                default:
                    projection = null!;
                    return false;
            }

            var episode = item as MediaBrowser.Controller.Entities.TV.Episode;
            item.ProviderIds.TryGetValue("Tmdb", out var tmdbId);
            projection = new HiddenContentItemProjection(
                item.Id,
                kind,
                item.Name,
                tmdbId,
                episode?.SeriesId,
                episode?.SeriesName,
                episode?.ParentIndexNumber,
                episode?.IndexNumber);
            return true;
        }

        private IActionResult ConfigureAccessibleHomeSurfaceHide(
            Guid userId,
            HiddenContentItemProjection item,
            string targetScope)
        {
            try
            {
                var scope = string.Equals(targetScope, "continuewatching", StringComparison.Ordinal)
                    ? HiddenContentItemScope.ContinueWatching
                    : HiddenContentItemScope.NextUp;
                var result = _hiddenContentItemActionOwner.Configure(
                    new HiddenContentActorProjection(userId),
                    item,
                    HiddenContentItemConfiguration.LegacyHomeSurface(hidden: true, scope));
                if (result.Outcome == HiddenContentItemActionOutcome.CapacityExceeded)
                {
                    return HiddenItemCapacityExceeded();
                }

                if (result.Outcome == HiddenContentItemActionOutcome.PayloadTooLarge)
                {
                    return StatusCode(StatusCodes.Status413PayloadTooLarge, new
                    {
                        success = false,
                        message = "The resulting hidden-content state exceeds the supported limit."
                    });
                }

                return Ok(new
                {
                    success = true,
                    key = result.Key,
                    entry = LegacyHiddenContentEntry(result.Entry),
                    itemsRevision = result.ItemsRevision,
                    settingsRevision = result.SettingsRevision,
                    hiddenContentEnabled = result.HiddenContentEnabled,
                    settingsChanged = result.SettingsChanged
                });
            }
            catch (UserStoreUnhealthyException)
            {
                return QuarantinedHiddenStore();
            }
            catch (Exception ex) when (ex is InvalidDataException || ex is JsonException)
            {
                return StatusCode(503, new { success = false, message = "Hidden-content store is corrupt and requires administrator recovery." });
            }
            catch (IOException)
            {
                return StatusCode(503, new
                {
                    success = false,
                    message = "Hidden-content store is temporarily unavailable. Please retry."
                });
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to add {targetScope} hide for user {userId}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to hide item." });
            }
        }

        private static HiddenContentItem? LegacyHiddenContentEntry(HiddenContentItemState? entry)
            => entry == null
                ? null
                : new HiddenContentItem
                {
                    ItemId = entry.ItemId,
                    Name = entry.Name,
                    Type = entry.Type,
                    TmdbId = entry.TmdbId,
                    Identity = entry.Identity == null
                        ? null
                        : new HiddenContentIdentity
                        {
                            Version = entry.Identity.Version,
                            Provider = entry.Identity.Provider,
                            MediaType = entry.Identity.MediaType,
                            Id = entry.Identity.Id,
                        },
                    HiddenAt = entry.HiddenAt,
                    PosterPath = entry.PosterPath,
                    SeriesId = entry.SeriesId,
                    SeriesName = entry.SeriesName,
                    SeasonNumber = entry.SeasonNumber,
                    EpisodeNumber = entry.EpisodeNumber,
                    HideScope = entry.HideScope,
                };

        // Shared implementation for "Remove from Continue Watching" / "Remove from Next Up".
        // Records a scoped HC entry (HideScope=continuewatching|nextup) under a server-side
        // read-modify-write so a concurrent hide can't clobber it. An existing entry's scope
        // is widened — never narrowed — via MergeHomeScope (e.g. continuewatching ⊕ nextup → homesections).
        private IActionResult HideFromHomeSurface(string itemId, string targetScope)
        {
            var userId = UserHelper.GetCurrentUserId(User) ?? Guid.Empty;
            if (userId == Guid.Empty) return Forbid();

            if (!Guid.TryParse(itemId, out var itemGuid) && !Guid.TryParseExact(itemId, "N", out itemGuid))
            {
                return BadRequest(new { success = false, message = "Invalid itemId." });
            }

            var user = _userManager.GetUserById(userId);
            if (user == null) return Forbid();

            var jfItem = _libraryManager.GetItemById<MediaBrowser.Controller.Entities.BaseItem>(itemGuid, user);
            if (jfItem == null)
            {
                return NotFound(new { success = false, message = "Item not found or not accessible." });
            }

            if (TryCreateHiddenContentItemProjection(jfItem, out var projection))
            {
                // The user-scoped lookup above is the only authority that may mint
                // this projection. Supported exact-item mutations invoke the owner once.
                return ConfigureAccessibleHomeSurfaceHide(userId, projection, targetScope);
            }

            // Backward-compatibility path for legacy item kinds that predate the
            // closed native Movie/Series/Episode contract. Platform callers cannot
            // enter this transport-owned shim.
            string? seriesId = null;
            string? seriesName = null;
            int? seasonNumber = null;
            int? episodeNumber = null;
            string typeName = jfItem.GetType().Name;
            var tmdbId = jfItem.ProviderIds.TryGetValue("Tmdb", out var providerTmdbId)
                ? providerTmdbId
                : string.Empty;
            var mediaType = string.Equals(typeName, "Movie", StringComparison.Ordinal) ? "movie"
                : (string.Equals(typeName, "Series", StringComparison.Ordinal) ? "tv" : null);
            HiddenContentIdentity? providerIdentity = null;
            if (mediaType != null
                && !string.IsNullOrEmpty(tmdbId)
                && tmdbId.Length <= 32
                && tmdbId.All(static c => c >= '0' && c <= '9')
                && tmdbId.Any(static c => c != '0'))
            {
                providerIdentity = new HiddenContentIdentity
                {
                    Version = 1,
                    Provider = "tmdb",
                    MediaType = mediaType,
                    Id = tmdbId
                };
            }

            if (jfItem is MediaBrowser.Controller.Entities.TV.Episode ep)
            {
                seriesId = ep.SeriesId == Guid.Empty ? null : ep.SeriesId.ToString();
                seriesName = ep.SeriesName;
                seasonNumber = ep.ParentIndexNumber;
                episodeNumber = ep.IndexNumber;
            }

            var entry = new HiddenContentItem
            {
                ItemId = itemGuid.ToString(),
                Name = PersistedPayloadPolicy.ClampPersistedDisplayName(jfItem.Name),
                Type = typeName,
                TmdbId = providerIdentity?.Id ?? string.Empty,
                Identity = providerIdentity,
                HiddenAt = DateTime.UtcNow.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
                PosterPath = string.Empty,
                SeriesId = seriesId ?? string.Empty,
                SeriesName = PersistedPayloadPolicy.ClampPersistedDisplayName(
                    seriesName),
                SeasonNumber = PersistedPayloadPolicy.NormalizeHiddenIndex(
                    seasonNumber),
                EpisodeNumber = PersistedPayloadPolicy.NormalizeHiddenIndex(
                    episodeNumber),
                HideScope = targetScope
            };

            var key = entry.ItemId;
            var authorizedUserId = userId.ToString("N");

            try
            {
                var keyN = itemGuid.ToString("N");
                var itemsRevision = 0L;
                var settingsRevision = 0L;
                var hiddenContentEnabled = true;
                var settingsChanged = false;
                var capacityExceeded = false;

                _userConfigurationManager.TransactUserConfiguration<UserHiddenContent, int>(
                    authorizedUserId,
                    HiddenContentFileName,
                    h =>
                    {
                        // Classify existence only after the transaction owns the
                        // exact file lock. An existing zero-item file is still an
                        // existing user preference store; an I/O fault is never
                        // proof that configured defaults should be seeded.
                        var missing = RequireHiddenMutationRead(
                            authorizedUserId,
                            _userConfigurationManager.ReadUserConfiguration<UserHiddenContent>(
                                authorizedUserId,
                                HiddenContentFileName))
                            == UserConfigReadStatus.Missing;
                        if (!PersistedPayloadPolicy
                            .ValidateMutationSource(h).IsValid)
                        {
                            throw new InvalidDataException(
                                "Hidden-content state is invalid.");
                        }
                        if (missing)
                        {
                            if (_configProvider.ConfigurationOrNull is not PluginConfiguration defaults)
                            {
                                throw new InvalidDataException(
                                    "Configured Hidden Content defaults are unavailable.");
                            }

                            h.Settings = BuildHcDefaultSettings(defaults);
                            // The user just performed a hide via the Remove feature, so filtering
                            // must be active for it to take effect — even if the admin's HC default
                            // is disabled. (Existing files keep whatever the user chose.)
                            if (!h.Settings.Enabled)
                            {
                                h.Settings.Enabled = true;
                                h.Settings.Revision = checked(h.Settings.Revision + 1);
                                settingsChanged = true;
                            }
                        }

                        if (h.Items.Count > PersistedPayloadPolicy.MaximumHiddenItems)
                        {
                            throw new HiddenItemCapacityExceededException();
                        }

                        // Merge with existing entries (under either hyphenated or N-format key) — pick the wider scope.
                        h.Items.TryGetValue(key, out var hyphenEntry);
                        h.Items.TryGetValue(keyN, out var nEntry);
                        if (hyphenEntry == null
                            && nEntry == null
                            && h.Items.Count >= PersistedPayloadPolicy.MaximumHiddenItems)
                        {
                            capacityExceeded = true;
                            return 0;
                        }

                        // Reconcile provider metadata as one atomic pair. A stored typed identity
                        // outranks fresh library metadata, which outranks an untyped legacy TMDB id.
                        // This prevents one GUID variant's legacy id from masking the other's typed
                        // identity or producing a mismatched Identity/TmdbId pair.
                        var identityEntry = hyphenEntry?.Identity != null
                            ? hyphenEntry
                            : (nEntry?.Identity != null ? nEntry : null);
                        if (identityEntry?.Identity != null)
                        {
                            entry.Identity = ClonePersisted(
                                identityEntry.Identity);
                            var supportedTmdbIdentity = entry.Identity.Version == 1
                                && string.Equals(entry.Identity.Provider, "tmdb", StringComparison.Ordinal)
                                && (string.Equals(entry.Identity.MediaType, "movie", StringComparison.Ordinal)
                                    || string.Equals(entry.Identity.MediaType, "tv", StringComparison.Ordinal))
                                && entry.Identity.Id.Length <= 32
                                && entry.Identity.Id.All(static c => c >= '0' && c <= '9')
                                && entry.Identity.Id.Any(static c => c != '0');
                            entry.TmdbId = supportedTmdbIdentity
                                ? entry.Identity.Id
                                : (identityEntry.TmdbId ?? string.Empty);
                        }
                        else if (providerIdentity == null)
                        {
                            entry.TmdbId = !string.IsNullOrEmpty(hyphenEntry?.TmdbId)
                                ? hyphenEntry.TmdbId
                                : (nEntry?.TmdbId ?? string.Empty);
                        }

                        var existingScope = WiderScope(
                            hyphenEntry?.HideScope,
                            nEntry?.HideScope);

                        if (!string.IsNullOrEmpty(existingScope))
                        {
                            entry.HideScope = MergeHomeScope(existingScope, targetScope);
                        }

                        // Preserve the earliest HiddenAt across both entries so re-affirming doesn't reset history.
                        var existingHiddenAt = EarliestHiddenAt(
                            hyphenEntry?.HiddenAt,
                            nEntry?.HiddenAt);
                        if (!string.IsNullOrEmpty(existingHiddenAt))
                        {
                            entry.HiddenAt = existingHiddenAt;
                        }

                        h.Items.Remove(keyN);
                        h.Items[key] = entry;
                        itemsRevision = HiddenContentRevision.AdvanceItems(h);
                        PersistedPayloadPolicy.NormalizeLegacyRuntimeState(h);
                        settingsRevision = h.Settings.Revision;
                        hiddenContentEnabled = h.Settings.Enabled;
                        var validation = PersistedPayloadPolicy
                            .ValidateMutationCandidate(h);
                        if (!validation.IsValid)
                        {
                            if (validation.Status == PersistedPayloadStatus.TooLarge)
                            {
                                throw new HiddenAdminPayloadTooLargeException();
                            }

                            throw new InvalidDataException(
                                "Hidden-content candidate state is invalid.");
                        }
                        _userConfigurationManager.SaveUserConfiguration(
                            authorizedUserId,
                            HiddenContentFileName,
                            h);
                        return 1;
                    });
                if (capacityExceeded)
                {
                    return HiddenItemCapacityExceeded();
                }
                Services.HiddenContentResponseFilter.InvalidateUser(authorizedUserId);
                return Ok(new
                {
                    success = true,
                    key,
                    entry,
                    itemsRevision,
                    settingsRevision,
                    hiddenContentEnabled,
                    settingsChanged
                });
            }
            catch (UserStoreUnhealthyException)
            {
                return QuarantinedHiddenStore();
            }
            catch (HiddenAdminPayloadTooLargeException)
            {
                return StatusCode(StatusCodes.Status413PayloadTooLarge, new
                {
                    success = false,
                    message = "The resulting hidden-content state exceeds the supported limit."
                });
            }
            catch (HiddenItemCapacityExceededException)
            {
                return HiddenItemCapacityExceeded();
            }
            catch (Exception ex) when (ex is InvalidDataException || ex is System.Text.Json.JsonException)
            {
                return StatusCode(503, new { success = false, message = "Hidden-content store is corrupt and requires administrator recovery." });
            }
            catch (IOException)
            {
                return StatusCode(503, new
                {
                    success = false,
                    message = "Hidden-content store is temporarily unavailable. Please retry."
                });
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to add {targetScope} hide for user {userId}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to hide item." });
            }
        }

        [HttpDelete("continue-watching/hide/{itemId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult UnhideFromContinueWatching(string itemId) => UnhideFromHomeSurface(itemId, "continuewatching");

        [HttpDelete("next-up/hide/{itemId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult UnhideFromNextUp(string itemId) => UnhideFromHomeSurface(itemId, "nextup");

        // Drops the scoped HC entry for {itemId} whose HideScope exactly matches targetScope
        // (mirror of the scoped POST). Wider composite scopes (e.g. homesections) are left
        // intact — narrowing them is handled by the Hidden Content management page.
        private IActionResult UnhideFromHomeSurface(string itemId, string targetScope)
        {
            var userId = UserHelper.GetCurrentUserId(User) ?? Guid.Empty;
            if (userId == Guid.Empty) return Forbid();

            if (!Guid.TryParse(itemId, out var itemGuid) && !Guid.TryParseExact(itemId, "N", out itemGuid))
            {
                return BadRequest(new { success = false, message = "Invalid itemId." });
            }

            var authorizedUserId = userId.ToString("N");
            var canonical = itemGuid.ToString();
            var canonicalN = itemGuid.ToString("N");

            var user = _userManager.GetUserById(userId);
            if (user == null)
            {
                return Forbid();
            }

            BaseItem? currentItem;
            try
            {
                currentItem = _libraryManager.GetItemById<BaseItem>(itemGuid, user);
            }
            catch (Exception ex)
            {
                // A host lookup failure is not proof of inaccessibility, so it may
                // not fall through to orphan repair.
                _logger.LogError($"Failed to resolve {targetScope} item for user {userId}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to unhide." });
            }

            if (currentItem != null
                && TryCreateHiddenContentItemProjection(currentItem, out var projection))
            {
                try
                {
                    var scope = string.Equals(targetScope, "continuewatching", StringComparison.Ordinal)
                        ? HiddenContentItemScope.ContinueWatching
                        : HiddenContentItemScope.NextUp;
                    var result = _hiddenContentItemActionOwner.Configure(
                        new HiddenContentActorProjection(userId),
                        projection,
                        HiddenContentItemConfiguration.LegacyHomeSurface(hidden: false, scope));
                    if (!result.Changed)
                    {
                        return NotFound(new { success = false, message = "No matching hidden-content entry." });
                    }

                    return Ok(new { success = true, itemsRevision = result.ItemsRevision });
                }
                catch (UserStoreUnhealthyException)
                {
                    return QuarantinedHiddenStore();
                }
                catch (Exception ex) when (ex is InvalidDataException || ex is JsonException)
                {
                    return StatusCode(503, new { success = false, message = "Hidden-content store is corrupt and requires administrator recovery." });
                }
                catch (Exception ex)
                {
                    _logger.LogError($"Failed to remove {targetScope} hide for user {userId}: {ex.Message}");
                    return StatusCode(500, new { success = false, message = "Failed to unhide." });
                }
            }

            // Legacy repair orchestration only: inaccessible, deleted, excluded, or
            // unsupported rows may be deleted without ever entering the exact owner.
            try
            {
                var itemsRevision = 0L;
                var dropped = _userConfigurationManager.RmwUserConfiguration<UserHiddenContent>(
                    authorizedUserId, "hidden-content.json", h =>
                {
                    if (h?.Items == null || h.Items.Count == 0) return 0;
                    var dropKeys = new List<string>();
                    foreach (var kvp in h.Items)
                    {
                        var entry = kvp.Value;
                        if (entry == null) continue;
                        if (!string.Equals(entry.HideScope, targetScope, StringComparison.OrdinalIgnoreCase))
                            continue;
                        var entryId = entry.ItemId ?? string.Empty;
                        if (string.Equals(entryId, canonical, StringComparison.OrdinalIgnoreCase)
                            || string.Equals(entryId, canonicalN, StringComparison.OrdinalIgnoreCase))
                        {
                            dropKeys.Add(kvp.Key);
                        }
                    }
                    foreach (var k in dropKeys) h.Items.Remove(k);
                    if (dropKeys.Count > 0)
                    {
                        itemsRevision = HiddenContentRevision.AdvanceItems(h);
                    }
                    else itemsRevision = h.ItemsRevision;
                    return dropKeys.Count;
                });

                if (dropped == 0) return NotFound(new { success = false, message = "No matching hidden-content entry." });
                Services.HiddenContentResponseFilter.InvalidateUser(authorizedUserId);
                return Ok(new { success = true, itemsRevision });
            }
            catch (UserStoreUnhealthyException)
            {
                return QuarantinedHiddenStore();
            }
            catch (Exception ex) when (ex is InvalidDataException || ex is System.Text.Json.JsonException)
            {
                return StatusCode(503, new { success = false, message = "Hidden-content store is corrupt and requires administrator recovery." });
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to remove {targetScope} hide for user {userId}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to unhide." });
            }
        }
    }
}
