using Microsoft.AspNetCore.Mvc;
using System;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using System.Threading;
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
    /// Per-user settings CRUD (settings/shortcuts/elsewhere/bookmark) and reset-all-users-settings.
    /// Split out of the former JellyfinCanopyController; method bodies, routes
    /// and attributes are unchanged.
    /// </summary>
    [Route("JellyfinCanopy")]
    [ApiController]
    public class UserSettingsController : JellyfinCanopyControllerBase
    {
        private readonly UserConfigurationManager _userConfigurationManager;
        private readonly ILibraryManager _libraryManager;

        public UserSettingsController(
            IHttpClientFactory httpClientFactory,
            ILogger<UserSettingsController> logger,
            IUserManager userManager,
            ISeerrCache seerrCache,
            IPluginConfigProvider configProvider,
            UserConfigurationManager userConfigurationManager,
            ILibraryManager libraryManager)
            : base(httpClientFactory, logger, userManager, seerrCache, configProvider)
        {
            _userConfigurationManager = userConfigurationManager;
            _libraryManager = libraryManager;
        }

        [HttpGet("user-settings/{userId}/settings.json")]
        [Authorize]
        public IActionResult GetUserSettingsSettings(string userId)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            return ReadUserSettingsFile(authorizedUserId);
        }

        private IActionResult ReadUserSettingsFile(
            string authorizedUserId,
            string? targetUserId = null,
            string? targetDisplayName = null)
        {
            UserConfigReadResult<UserSettings> read;
            try
            {
                read = _userConfigurationManager.GetOrCreateUserConfiguration<UserSettings>(
                    authorizedUserId,
                    "settings.json",
                    () =>
                    {
                        if (_configProvider.ConfigurationOrNull is not PluginConfiguration defaults)
                        {
                            return null;
                        }

                        var initial = BuildDefaultUserSettings(defaults);
                        StampServerManagedFields(authorizedUserId, initial);
                        return initial;
                    },
                    IsValidUserFileState);
            }
            catch (Exception ex) when (ex is InvalidDataException || ex is JsonException || ex is IOException || ex is UnauthorizedAccessException)
            {
                _logger.LogError(
                    $"Failed to initialize settings.json for {ResolveUserDisplay(authorizedUserId)} " +
                    $"(exception={ex.GetType().Name}).");
                return StatusCode(StatusCodes.Status503ServiceUnavailable, new UserFileMutationResponse<UserSettings>
                {
                    File = "settings.json",
                    Message = "The settings store or configured defaults are unavailable; initialization was not acknowledged."
                });
            }

            if (!read.HasUsableValue || read.Value == null || !IsValidUserFileState(read.Value))
            {
                return UserFileReadFailure<UserSettings>("settings.json", read.Status, read.FaultDetail);
            }

            if (read.Status == UserConfigReadStatus.Missing && !read.WasCreated)
            {
                return StatusCode(StatusCodes.Status503ServiceUnavailable, new UserFileMutationResponse<UserSettings>
                {
                    File = "settings.json",
                    TargetUserId = targetUserId,
                    TargetDisplayName = targetDisplayName,
                    Message = "Configured settings defaults are unavailable; no implicit default state was returned."
                });
            }

            var userConfig = read.Value;
            if (read.WasCreated)
            {
                if (!LogCrossUserFileMutationIfNeeded(
                        authorizedUserId,
                        "settings.json",
                        userConfig.Revision.ToString(CultureInfo.InvariantCulture),
                        "created default",
                        targetUserId))
                {
                    _logger.LogInformation($"Saved default settings.json for new user {ResolveUserDisplay(authorizedUserId)} from plugin configuration.");
                }
            }

            StampServerManagedFields(authorizedUserId, userConfig);
            SetUserFileEvidence(userConfig);
            if (targetUserId != null && targetDisplayName != null)
            {
                return Ok(new UserFileMutationResponse<UserSettings>
                {
                    Success = true,
                    File = "settings.json",
                    Revision = userConfig.Revision,
                    ContentHash = ContentHash(userConfig),
                    Data = userConfig,
                    TargetUserId = targetUserId,
                    TargetDisplayName = targetDisplayName
                });
            }

            return Ok(userConfig);
        }

        [HttpGet("user-settings/{userId}/shortcuts.json")]
        [Authorize]
        public IActionResult GetUserSettingsShortcuts(string userId)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            return ReadUserFile<UserShortcuts>(authorizedUserId, "shortcuts.json");
        }

        [HttpGet("user-settings/{userId}/elsewhere.json")]
        [Authorize]
        public IActionResult GetUserSettingsElsewhere(string userId)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            return ReadUserFile<ElsewhereSettings>(authorizedUserId, "elsewhere.json");
        }

        [HttpGet("user-settings/{userId}/{fileName}/evidence")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetUserFileEvidence(string userId, string fileName)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            return fileName switch
            {
                "settings.json" => ReadUserFileEvidence<UserSettings>(authorizedUserId, fileName),
                "shortcuts.json" => ReadUserFileEvidence<UserShortcuts>(authorizedUserId, fileName),
                "elsewhere.json" => ReadUserFileEvidence<ElsewhereSettings>(authorizedUserId, fileName),
                _ => NotFound(new { success = false, message = "Unsupported user settings file." })
            };
        }

        [HttpGet("admin/user-settings/{targetUserId}/settings.json")]
        [Authorize(Policy = Policies.RequiresElevation)]
        [Produces("application/json")]
        public IActionResult GetAdminTargetUserSettings(string targetUserId)
        {
            var targetResult = ResolveAdminTargetUser(
                targetUserId,
                out var canonicalTargetUserId,
                out var targetUser);
            if (targetResult != null)
            {
                return targetResult;
            }

            return ReadUserSettingsFile(
                canonicalTargetUserId,
                canonicalTargetUserId,
                targetUser.Username);
        }

        [HttpGet("admin/user-settings/{targetUserId}/shortcuts.json")]
        [Authorize(Policy = Policies.RequiresElevation)]
        [Produces("application/json")]
        public IActionResult GetAdminTargetUserShortcuts(string targetUserId)
        {
            var targetResult = ResolveAdminTargetUser(
                targetUserId,
                out var canonicalTargetUserId,
                out var targetUser);
            if (targetResult != null)
            {
                return targetResult;
            }

            return ReadUserFileEvidence<UserShortcuts>(
                canonicalTargetUserId,
                "shortcuts.json",
                canonicalTargetUserId,
                targetUser.Username);
        }

        [HttpGet("admin/user-settings/{targetUserId}/{fileName}/evidence")]
        [Authorize(Policy = Policies.RequiresElevation)]
        [Produces("application/json")]
        public IActionResult GetAdminTargetUserFileEvidence(string targetUserId, string fileName)
        {
            var targetResult = ResolveAdminTargetUser(
                targetUserId,
                out var canonicalTargetUserId,
                out var targetUser);
            if (targetResult != null)
            {
                return targetResult;
            }

            return fileName switch
            {
                "settings.json" => ReadUserSettingsFile(
                    canonicalTargetUserId,
                    canonicalTargetUserId,
                    targetUser.Username),
                "shortcuts.json" => ReadUserFileEvidence<UserShortcuts>(
                    canonicalTargetUserId,
                    fileName,
                    canonicalTargetUserId,
                    targetUser.Username),
                _ => NotFound(new
                {
                    success = false,
                    code = "unsupported_user_settings_file",
                    message = "Unsupported admin-target user settings file."
                })
            };
        }

        [HttpPost("user-settings/{userId}/settings.json")]
        [Authorize]
        [Produces("application/json")]
        [PersistedPayloadLimit(PersistedPayloadPolicy.StandardRequestBytes)]
        public IActionResult SaveUserSettingsSettings(string userId, [FromBody] UserSettings userConfiguration)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            return CommitUserFile(authorizedUserId, "settings.json", userConfiguration, "settings");
        }

        [HttpPost("user-settings/{userId}/shortcuts.json")]
        [Authorize]
        [Produces("application/json")]
        [PersistedPayloadLimit(PersistedPayloadPolicy.StandardRequestBytes)]
        public IActionResult SaveUserSettingsShortcuts(string userId, [FromBody] UserShortcuts userConfiguration)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            return CommitUserFile(authorizedUserId, "shortcuts.json", userConfiguration, "shortcuts");
        }

        [HttpPost("admin/user-settings/{targetUserId}/settings.json")]
        [Authorize(Policy = Policies.RequiresElevation)]
        [Produces("application/json")]
        [PersistedPayloadLimit(PersistedPayloadPolicy.StandardRequestBytes)]
        public IActionResult SaveAdminTargetUserSettings(
            string targetUserId,
            [FromBody] UserSettings userConfiguration)
        {
            var targetResult = ResolveAdminTargetUser(
                targetUserId,
                out var canonicalTargetUserId,
                out var targetUser);
            if (targetResult != null)
            {
                return targetResult;
            }

            return CommitUserFile(
                canonicalTargetUserId,
                "settings.json",
                userConfiguration,
                "settings",
                canonicalTargetUserId,
                targetUser.Username);
        }

        [HttpPost("admin/user-settings/{targetUserId}/shortcuts.json")]
        [Authorize(Policy = Policies.RequiresElevation)]
        [Produces("application/json")]
        [PersistedPayloadLimit(PersistedPayloadPolicy.StandardRequestBytes)]
        public IActionResult SaveAdminTargetUserShortcuts(
            string targetUserId,
            [FromBody] UserShortcuts userConfiguration)
        {
            var targetResult = ResolveAdminTargetUser(
                targetUserId,
                out var canonicalTargetUserId,
                out var targetUser);
            if (targetResult != null)
            {
                return targetResult;
            }

            return CommitUserFile(
                canonicalTargetUserId,
                "shortcuts.json",
                userConfiguration,
                "shortcuts",
                canonicalTargetUserId,
                targetUser.Username);
        }

        private enum UserFileCommitStatus
        {
            Success,
            PreconditionRequired,
            Conflict,
            Invalid,
            TooLarge
        }

        public sealed class UserFileMutationResponse<T>
            where T : class, IRevisionedUserConfiguration, new()
        {
            public bool Success { get; set; }
            public bool Conflict { get; set; }
            public string Message { get; set; } = string.Empty;
            public string Code { get; set; } = string.Empty;
            public string File { get; set; } = string.Empty;
            public long Revision { get; set; }
            public string ContentHash { get; set; } = string.Empty;
            public T? Data { get; set; }

            [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
            public string? TargetUserId { get; set; }

            [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
            public string? TargetDisplayName { get; set; }
        }

        private sealed class UserFileCommitResult<T>
            where T : class, IRevisionedUserConfiguration, new()
        {
            public UserFileCommitStatus Status { get; set; }
            public T? State { get; set; }
            public string Message { get; set; } = string.Empty;
        }

        private IActionResult CommitUserFile<T>(
            string authorizedUserId,
            string fileName,
            T? candidate,
            string displayName,
            string? targetUserId = null,
            string? targetDisplayName = null)
            where T : class, IRevisionedUserConfiguration, new()
        {
            if (candidate != null)
            {
                StampServerManagedFields(authorizedUserId, candidate);
            }

            var validation = PersistedPayloadPolicy.Validate(candidate);
            if (candidate == null || !validation.IsValid)
            {
                var response = new UserFileMutationResponse<T>
                {
                    Code = validation.Code,
                    File = fileName,
                    TargetUserId = targetUserId,
                    TargetDisplayName = targetDisplayName,
                    Message = validation.Status == PersistedPayloadStatus.TooLarge
                        ? $"The {displayName} payload exceeds the supported size limit."
                        : $"The {displayName} payload is invalid."
                };
                return validation.Status == PersistedPayloadStatus.TooLarge
                    ? StatusCode(StatusCodes.Status413PayloadTooLarge, response)
                    : BadRequest(response);
            }

            // Shortcut entries carry forward-compatible extension members.
            // Detach the validated request graph before it can cross the
            // transaction/write boundary, cloning every nested JsonElement.
            if (candidate is UserShortcuts shortcuts)
            {
                candidate = (T)(object)PersistedPayloadPolicy.CloneValidated(shortcuts);
            }

            if (!TryParseIfMatchRevision(out var expectedRevision))
            {
                return StatusCode(StatusCodes.Status428PreconditionRequired, new UserFileMutationResponse<T>
                {
                    File = fileName,
                    Data = candidate,
                    Revision = candidate.Revision,
                    ContentHash = ContentHash(candidate),
                    TargetUserId = targetUserId,
                    TargetDisplayName = targetDisplayName,
                    Message = $"Saving {displayName} requires If-Match: \"<revision>\" from the latest GET."
                });
            }

            if (candidate.Revision != expectedRevision)
            {
                return BadRequest(new UserFileMutationResponse<T>
                {
                    File = fileName,
                    Data = candidate,
                    Revision = candidate.Revision,
                    ContentHash = ContentHash(candidate),
                    TargetUserId = targetUserId,
                    TargetDisplayName = targetDisplayName,
                    Message = "The body Revision must match the If-Match revision."
                });
            }

            try
            {
                var result = CommitUserFileState(
                    authorizedUserId,
                    fileName,
                    expectedRevision,
                    candidate,
                    preserveAdminTargetExtensions: targetUserId != null);
                if (result.State != null)
                {
                    SetUserFileEvidence(result.State);
                }

                var response = new UserFileMutationResponse<T>
                {
                    Success = result.Status == UserFileCommitStatus.Success,
                    Conflict = result.Status == UserFileCommitStatus.Conflict,
                    Code = result.Status == UserFileCommitStatus.TooLarge
                        ? "payload_too_large"
                        : result.Status == UserFileCommitStatus.Invalid ? "invalid_payload" : string.Empty,
                    Message = result.Message,
                    File = fileName,
                    Revision = result.State?.Revision ?? 0,
                    ContentHash = result.State == null ? string.Empty : ContentHash(result.State),
                    Data = result.State,
                    TargetUserId = targetUserId,
                    TargetDisplayName = targetDisplayName
                };

                if (result.Status == UserFileCommitStatus.Success)
                {
                    if (!LogCrossUserFileMutationIfNeeded(
                            authorizedUserId,
                            fileName,
                            response.Revision.ToString(CultureInfo.InvariantCulture),
                            "saved",
                            targetUserId))
                    {
                        _logger.LogInformation(
                            $"Saved user {displayName} for {ResolveUserDisplay(authorizedUserId)} " +
                            $"to {fileName} at revision {response.Revision} ({response.ContentHash}).");
                    }
                }

                return result.Status switch
                {
                    UserFileCommitStatus.Success => Ok(response),
                    UserFileCommitStatus.PreconditionRequired => StatusCode(StatusCodes.Status428PreconditionRequired, response),
                    UserFileCommitStatus.Conflict => Conflict(response),
                    UserFileCommitStatus.Invalid => BadRequest(response),
                    UserFileCommitStatus.TooLarge => StatusCode(StatusCodes.Status413PayloadTooLarge, response),
                    _ => StatusCode(StatusCodes.Status500InternalServerError, response)
                };
            }
            catch (Exception ex)
            {
                var response = new UserFileMutationResponse<T>
                {
                    File = fileName,
                    TargetUserId = targetUserId,
                    TargetDisplayName = targetDisplayName,
                    Message = ex is UserStoreUnhealthyException
                        ? $"The {displayName} store is quarantined. Retry alone cannot recover it; an administrator must inspect and reset or repair it."
                        : $"The {displayName} store is unavailable; no write was acknowledged."
                };
                if (ex is UserStoreUnhealthyException)
                {
                    // The central store logged the generation exactly once when it
                    // published the marker. Do not amplify logs on client retries.
                    return StatusCode(StatusCodes.Status503ServiceUnavailable, response);
                }

                _logger.LogError(
                    $"Failed to save user {displayName} for {ResolveUserDisplay(authorizedUserId)} " +
                    $"(exception={ex.GetType().Name}).");
                if (ex is InvalidDataException || ex is JsonException || ex is IOException || ex is UnauthorizedAccessException)
                {
                    return StatusCode(StatusCodes.Status503ServiceUnavailable, response);
                }

                return StatusCode(StatusCodes.Status500InternalServerError, response);
            }
        }

        private UserConfigReadStatus RequireUserFileMutationRead<T>(
            string authorizedUserId,
            string fileName,
            UserConfigReadResult<T> read)
            where T : class, new()
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
                throw new UserStoreUnhealthyException(fileName, newlyQuarantined: false);
            }

            if (read.Status == UserConfigReadStatus.Unavailable)
            {
                throw new IOException($"{fileName} is temporarily unavailable.");
            }

            _userConfigurationManager.GetUserConfigurationStrict<T>(
                authorizedUserId,
                fileName);
            throw new InvalidDataException($"{fileName} is corrupt.");
        }

        private UserFileCommitResult<T> CommitUserFileState<T>(
            string authorizedUserId,
            string fileName,
            long? expectedRevision,
            T candidate,
            bool preserveAdminTargetExtensions)
            where T : class, IRevisionedUserConfiguration, new()
        {
            return _userConfigurationManager.TransactUserConfiguration<T, UserFileCommitResult<T>>(
                authorizedUserId,
                fileName,
                current =>
            {
                var readStatus = RequireUserFileMutationRead(
                    authorizedUserId,
                    fileName,
                    _userConfigurationManager.ReadUserConfiguration<T>(
                        authorizedUserId,
                        fileName));
                if (readStatus == UserConfigReadStatus.Missing
                    && typeof(T) == typeof(UserSettings))
                {
                    if (_configProvider.ConfigurationOrNull is not PluginConfiguration defaults)
                    {
                        throw new InvalidDataException(
                            "Configured settings defaults are unavailable.");
                    }

                    var configured = BuildDefaultUserSettings(defaults);
                    if (!PersistedPayloadPolicy.Validate(configured).IsValid)
                    {
                        throw new InvalidDataException(
                            "Configured settings defaults are invalid.");
                    }

                    current = (T)(object)configured;
                }

                StampServerManagedFields(authorizedUserId, current);
                StampServerManagedFields(authorizedUserId, candidate);
                if (!IsValidUserFileState(current))
                {
                    throw new InvalidDataException($"{fileName} has an invalid revision or payload shape.");
                }

                if (!expectedRevision.HasValue)
                {
                    return new UserFileCommitResult<T>
                    {
                        Status = UserFileCommitStatus.PreconditionRequired,
                        State = current,
                        Message = "A revision precondition is required."
                    };
                }

                if (expectedRevision.Value != current.Revision)
                {
                    return new UserFileCommitResult<T>
                    {
                        Status = UserFileCommitStatus.Conflict,
                        State = current,
                        Message = "The user file changed. Rebase the intended fields on the returned state and retry."
                    };
                }

                if (preserveAdminTargetExtensions)
                {
                    if (!TryPreserveAdminTargetExtensions(current, candidate))
                    {
                        return new UserFileCommitResult<T>
                        {
                            Status = UserFileCommitStatus.Invalid,
                            State = current,
                            Message =
                                "Duplicate shortcut rows made opaque extension preservation ambiguous."
                        };
                    }
                }

                if (candidate is UserSettings candidateSettings
                    && !TryNormalizePreferredAudioLanguage(candidateSettings))
                {
                    return new UserFileCommitResult<T>
                    {
                        Status = UserFileCommitStatus.Invalid,
                        State = current,
                        Message = "PreferredAudioLanguage must be null, empty, or a supported BCP-47 language tag no longer than 255 characters."
                    };
                }

                if (string.Equals(ContentHash(current), ContentHash(candidate), StringComparison.Ordinal))
                {
                    return new UserFileCommitResult<T> { Status = UserFileCommitStatus.Success, State = current };
                }

                candidate.Revision = checked(current.Revision + 1);
                var validation = PersistedPayloadPolicy.Validate(candidate);
                if (!validation.IsValid)
                {
                    return new UserFileCommitResult<T>
                    {
                        Status = validation.Status == PersistedPayloadStatus.TooLarge
                            ? UserFileCommitStatus.TooLarge
                            : UserFileCommitStatus.Invalid,
                        State = current,
                        Message = validation.Status == PersistedPayloadStatus.TooLarge
                            ? "The payload exceeds the supported size limit; no mutation was committed."
                            : "The payload is invalid; no mutation was committed."
                    };
                }

                _userConfigurationManager.SaveUserConfiguration(authorizedUserId, fileName, candidate);
                return new UserFileCommitResult<T> { Status = UserFileCommitStatus.Success, State = candidate };
            });
        }

        private static bool TryPreserveAdminTargetExtensions<T>(
            T current,
            T candidate)
            where T : class, IRevisionedUserConfiguration
        {
            if (current is UserSettings currentSettings
                && candidate is UserSettings candidateSettings)
            {
                candidateSettings.ExtensionData =
                    PersistedPayloadPolicy.PreserveExistingExtensionData(
                        candidateSettings.ExtensionData,
                        currentSettings.ExtensionData);
                return true;
            }

            if (current is not UserShortcuts currentShortcuts
                || candidate is not UserShortcuts candidateShortcuts)
            {
                return true;
            }

            candidateShortcuts.ExtensionData =
                PersistedPayloadPolicy.PreserveExistingExtensionData(
                    candidateShortcuts.ExtensionData,
                    currentShortcuts.ExtensionData);
            var used = new bool[currentShortcuts.Shortcuts.Count];
            var matched = new bool[candidateShortcuts.Shortcuts.Count];

            // If a mutation removes one of several schema-identical rows with
            // distinct opaque data, no known field can identify the survivor.
            // Reject instead of grafting one row's future data onto another.
            var checkedGroups = new bool[currentShortcuts.Shortcuts.Count];
            for (var currentIndex = 0;
                 currentIndex < currentShortcuts.Shortcuts.Count;
                 currentIndex++)
            {
                if (checkedGroups[currentIndex]) continue;
                var exemplar = currentShortcuts.Shortcuts[currentIndex];
                var currentGroup = new List<int>();
                for (var sibling = currentIndex;
                     sibling < currentShortcuts.Shortcuts.Count;
                     sibling++)
                {
                    if (SameShortcutFields(
                        exemplar,
                        currentShortcuts.Shortcuts[sibling]))
                    {
                        checkedGroups[sibling] = true;
                        currentGroup.Add(sibling);
                    }
                }

                var candidateCount = candidateShortcuts.Shortcuts.Count(
                    shortcut => SameShortcutFields(exemplar, shortcut));
                if (candidateCount < currentGroup.Count
                    && currentGroup.Skip(1).Any(index =>
                        !ExtensionDataEqual(
                            currentShortcuts.Shortcuts[currentGroup[0]]
                                .ExtensionData,
                            currentShortcuts.Shortcuts[index].ExtensionData)))
                {
                    return false;
                }
            }

            // Match complete schema tuples first. This keeps a shifted
            // duplicate-name row attached to its own opaque data after a
            // different sibling is removed or the list is reordered.
            for (var candidateIndex = 0;
                 candidateIndex < candidateShortcuts.Shortcuts.Count;
                 candidateIndex++)
            {
                var candidateShortcut = candidateShortcuts.Shortcuts[candidateIndex];
                var matchIndex = -1;
                if (candidateIndex < currentShortcuts.Shortcuts.Count
                    && !used[candidateIndex]
                    && SameShortcutFields(
                        candidateShortcut,
                        currentShortcuts.Shortcuts[candidateIndex]))
                {
                    matchIndex = candidateIndex;
                }
                else
                {
                    for (var currentIndex = 0;
                         currentIndex < currentShortcuts.Shortcuts.Count;
                         currentIndex++)
                    {
                        if (!used[currentIndex]
                            && SameShortcutFields(
                                candidateShortcut,
                                currentShortcuts.Shortcuts[currentIndex]))
                        {
                            matchIndex = currentIndex;
                            break;
                        }
                    }
                }

                if (matchIndex >= 0 && !used[matchIndex])
                {
                    used[matchIndex] = true;
                    matched[candidateIndex] = true;
                    candidateShortcut.ExtensionData =
                        PersistedPayloadPolicy.PreserveExistingExtensionData(
                            candidateShortcut.ExtensionData,
                            currentShortcuts.Shortcuts[matchIndex].ExtensionData);
                }
            }

            // A changed row may no longer have an exact tuple. Name is the
            // editor's stable key only when one unused current row has that
            // name; duplicate leftovers are deliberately fail-closed.
            for (var candidateIndex = 0;
                 candidateIndex < candidateShortcuts.Shortcuts.Count;
                 candidateIndex++)
            {
                if (matched[candidateIndex]) continue;
                var candidateShortcut = candidateShortcuts.Shortcuts[candidateIndex];
                var matches = Enumerable.Range(
                        0,
                        currentShortcuts.Shortcuts.Count)
                    .Where(index => !used[index]
                        && string.Equals(
                            candidateShortcut.Name,
                            currentShortcuts.Shortcuts[index].Name,
                            StringComparison.Ordinal))
                    .ToList();
                if (matches.Count > 1) return false;
                if (matches.Count == 0) continue;

                var matchIndex = matches[0];
                used[matchIndex] = true;
                candidateShortcut.ExtensionData =
                    PersistedPayloadPolicy.PreserveExistingExtensionData(
                        candidateShortcut.ExtensionData,
                        currentShortcuts.Shortcuts[matchIndex].ExtensionData);
            }

            return true;
        }

        private static bool SameShortcutFields(Shortcut left, Shortcut right)
            => string.Equals(left.Name, right.Name, StringComparison.Ordinal)
                && string.Equals(left.Key, right.Key, StringComparison.Ordinal)
                && string.Equals(left.Label, right.Label, StringComparison.Ordinal)
                && string.Equals(left.Category, right.Category, StringComparison.Ordinal);

        private static bool ExtensionDataEqual(
            IReadOnlyDictionary<string, JsonElement> left,
            IReadOnlyDictionary<string, JsonElement> right)
        {
            if (left.Count != right.Count) return false;
            using var leftEntries = left.GetEnumerator();
            using var rightEntries = right.GetEnumerator();
            while (leftEntries.MoveNext())
            {
                if (!rightEntries.MoveNext()
                    || !string.Equals(
                        leftEntries.Current.Key,
                        rightEntries.Current.Key,
                        StringComparison.Ordinal)
                    || !string.Equals(
                        leftEntries.Current.Value.GetRawText(),
                        rightEntries.Current.Value.GetRawText(),
                        StringComparison.Ordinal))
                {
                    return false;
                }
            }

            return !rightEntries.MoveNext();
        }

        private static bool IsValidUserFileState<T>(T state)
            where T : class, IRevisionedUserConfiguration
            => PersistedPayloadPolicy.Validate(state).IsValid;

        private static bool TryNormalizePreferredAudioLanguage(UserSettings settings)
        {
            if (!PreferredAudioLanguageNormalizer.TryNormalize(
                    settings.PreferredAudioLanguage,
                    preserveNull: true,
                    out var normalized))
            {
                return false;
            }

            settings.PreferredAudioLanguage = normalized;
            return true;
        }

        private void StampServerManagedFields<T>(string authorizedUserId, T state)
            where T : class, IRevisionedUserConfiguration
        {
            if (state is UserSettings settings)
            {
                settings.IsAdmin = IsUserAdministrator(authorizedUserId);
                if (RatingTagScopePolicyV1.TryNormalize(
                        settings.RatingTagScopeOverrides,
                        out var normalizedRatingScope))
                {
                    settings.RatingTagScopeOverrides = normalizedRatingScope;
                }
            }
        }

        private bool IsUserAdministrator(string userId)
        {
            try
            {
                if (!Guid.TryParse(userId, out var guid) && !Guid.TryParseExact(userId, "N", out guid))
                {
                    return false;
                }

                var user = _userManager.GetUserById(guid);
                return user != null && user.HasPermission(
                    Jellyfin.Database.Implementations.Enums.PermissionKind.IsAdministrator);
            }
            catch
            {
                return false;
            }
        }

        private static string ContentHash<T>(T state)
            where T : class, IRevisionedUserConfiguration
        {
            var node = JsonSerializer.SerializeToNode(state, state.GetType(), PersistedJson.WriteOptions) as JsonObject
                ?? throw new InvalidDataException("User configuration did not serialize as a JSON object.");
            node.Remove(nameof(IRevisionedUserConfiguration.Revision));
            var canonical = node.ToJsonString(PersistedJson.WriteOptions);
            return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
        }

        private void SetUserFileEvidence<T>(T state)
            where T : class, IRevisionedUserConfiguration
        {
            Response.Headers.ETag = $"\"{state.Revision}\"";
            Response.Headers["X-JC-Content-Hash"] = ContentHash(state);
        }

        private IActionResult ReadUserFile<T>(string authorizedUserId, string fileName)
            where T : class, IRevisionedUserConfiguration, new()
        {
            lock (_userConfigurationManager.GetUserFileLock(authorizedUserId, fileName))
            {
                var read = _userConfigurationManager.ReadUserConfiguration<T>(authorizedUserId, fileName);
                if (!read.HasUsableValue || read.Value == null || !IsValidUserFileState(read.Value))
                {
                    return UserFileReadFailure<T>(fileName, read.Status, read.FaultDetail);
                }

                StampServerManagedFields(authorizedUserId, read.Value);
                SetUserFileEvidence(read.Value);
                return Ok(read.Value);
            }
        }

        private IActionResult ReadUserFileEvidence<T>(
            string authorizedUserId,
            string fileName,
            string? targetUserId = null,
            string? targetDisplayName = null)
            where T : class, IRevisionedUserConfiguration, new()
        {
            lock (_userConfigurationManager.GetUserFileLock(authorizedUserId, fileName))
            {
                var read = _userConfigurationManager.ReadUserConfiguration<T>(authorizedUserId, fileName);
                if (!read.HasUsableValue || read.Value == null || !IsValidUserFileState(read.Value))
                {
                    return UserFileReadFailure<T>(fileName, read.Status, read.FaultDetail);
                }

                StampServerManagedFields(authorizedUserId, read.Value);
                SetUserFileEvidence(read.Value);
                return Ok(new UserFileMutationResponse<T>
                {
                    Success = true,
                    File = fileName,
                    Revision = read.Value.Revision,
                    ContentHash = ContentHash(read.Value),
                    Data = read.Value,
                    TargetUserId = targetUserId,
                    TargetDisplayName = targetDisplayName
                });
            }
        }

        private IActionResult? ResolveAdminTargetUser(
            string targetUserId,
            out string canonicalTargetUserId,
            out JUser targetUser)
        {
            canonicalTargetUserId = string.Empty;
            targetUser = null!;

            if (string.IsNullOrWhiteSpace(targetUserId)
                || (!Guid.TryParseExact(targetUserId, "N", out var parsedTargetUserId)
                    && !Guid.TryParseExact(targetUserId, "D", out parsedTargetUserId))
                || parsedTargetUserId == Guid.Empty)
            {
                return BadRequest(new
                {
                    success = false,
                    code = "invalid_target_user_id",
                    message = "targetUserId must be a non-empty GUID in dashed or 32-character format."
                });
            }

            canonicalTargetUserId = parsedTargetUserId.ToString("N");
            try
            {
                var resolved = _userManager.GetUserById(parsedTargetUserId);
                if (resolved == null || resolved.Id != parsedTargetUserId)
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
                    $"Failed to resolve admin-target Jellyfin user {canonicalTargetUserId} " +
                    $"(exception={ex.GetType().Name}).");
                return StatusCode(StatusCodes.Status503ServiceUnavailable, new
                {
                    success = false,
                    code = "target_user_directory_unavailable",
                    message = "The Jellyfin user directory is temporarily unavailable."
                });
            }
        }

        private IActionResult UserFileReadFailure<T>(
            string fileName,
            UserConfigReadStatus status,
            string? detail)
            where T : class, IRevisionedUserConfiguration, new()
        {
            var quarantined = string.Equals(detail, "quarantined-recovery-required", StringComparison.Ordinal);
            if (!quarantined)
            {
                _logger.LogWarning($"Refusing to publish {fileName} (status={status}, detail={detail ?? "invalid-state"}).");
            }
            return StatusCode(StatusCodes.Status503ServiceUnavailable, new UserFileMutationResponse<T>
            {
                File = fileName,
                Message = quarantined
                    ? "User settings are quarantined. Retry alone cannot recover them; an administrator must inspect and reset or repair the store."
                    : "User settings are corrupt or temporarily unavailable. No empty replacement state was published."
            });
        }

        private static UserSettings BuildDefaultUserSettings(PluginConfiguration defaultConfig)
            => new UserSettings
            {
                AutoPauseEnabled = defaultConfig.AutoPauseEnabled,
                AutoResumeEnabled = defaultConfig.AutoResumeEnabled,
                AutoPipEnabled = defaultConfig.AutoPipEnabled,
                LongPress2xEnabled = defaultConfig.LongPress2xEnabled,
                PauseScreenEnabled = defaultConfig.PauseScreenEnabled,
                PauseScreenDelaySeconds = defaultConfig.PauseScreenDelaySeconds,
                AutoSkipIntro = defaultConfig.AutoSkipIntro,
                AutoSkipOutro = defaultConfig.AutoSkipOutro,
                DisableCustomSubtitleStyles = defaultConfig.DisableCustomSubtitleStyles,
                SelectedStylePresetIndex = defaultConfig.DefaultSubtitleStyle,
                SelectedFontSizePresetIndex = defaultConfig.DefaultSubtitleSize,
                SelectedFontFamilyPresetIndex = defaultConfig.DefaultSubtitleFont,
                RandomButtonEnabled = defaultConfig.RandomButtonEnabled,
                RandomUnwatchedOnly = defaultConfig.RandomUnwatchedOnly,
                RandomIncludeMovies = defaultConfig.RandomIncludeMovies,
                RandomIncludeShows = defaultConfig.RandomIncludeShows,
                ShowWatchProgress = defaultConfig.ShowWatchProgress,
                WatchProgressMode = string.IsNullOrWhiteSpace(defaultConfig.WatchProgressDefaultMode) ? "percentage" : defaultConfig.WatchProgressDefaultMode,
                WatchProgressTimeFormat = string.IsNullOrWhiteSpace(defaultConfig.WatchProgressTimeFormat) ? "hours" : defaultConfig.WatchProgressTimeFormat,
                ShowFileSizes = defaultConfig.ShowFileSizes,
                ShowAudioLanguages = defaultConfig.ShowAudioLanguages,
                QualityTagsEnabled = defaultConfig.QualityTagsEnabled,
                ShowResolutionTag = defaultConfig.ShowResolutionTag,
                ShowSourceTag = defaultConfig.ShowSourceTag,
                ShowDynamicRangeTag = defaultConfig.ShowDynamicRangeTag,
                ShowSpecialFormatTag = defaultConfig.ShowSpecialFormatTag,
                ShowVideoCodecTag = defaultConfig.ShowVideoCodecTag,
                ShowAudioInfoTag = defaultConfig.ShowAudioInfoTag,
                // A new user inherits this administrator default dynamically.
                // Empty is a separate, explicit Automatic override.
                PreferredAudioLanguage = null,
                ResolutionTagOrder = defaultConfig.ResolutionTagOrder,
                SourceTagOrder = defaultConfig.SourceTagOrder,
                DynamicRangeTagOrder = defaultConfig.DynamicRangeTagOrder,
                SpecialFormatTagOrder = defaultConfig.SpecialFormatTagOrder,
                VideoCodecTagOrder = defaultConfig.VideoCodecTagOrder,
                AudioInfoTagOrder = defaultConfig.AudioInfoTagOrder,
                GenreTagsEnabled = defaultConfig.GenreTagsEnabled,
                LanguageTagsEnabled = defaultConfig.LanguageTagsEnabled,
                RatingTagsEnabled = defaultConfig.RatingTagsEnabled,
                // The administrator policy remains a live ceiling; a new
                // user's own additive deny set therefore starts empty.
                RatingTagScopeOverrides = RatingTagScopePolicyV1.CreateEmpty(),
                PeopleTagsEnabled = defaultConfig.PeopleTagsEnabled,
                AnimeFillerWarningsEnabled = defaultConfig.AnimeFillerWarningsDefaultEnabled,
                TagsHideOnHover = defaultConfig.TagsHideOnHover,
                QualityTagsPosition = defaultConfig.QualityTagsPosition,
                GenreTagsPosition = defaultConfig.GenreTagsPosition,
                LanguageTagsPosition = defaultConfig.LanguageTagsPosition,
                RatingTagsPosition = defaultConfig.RatingTagsPosition,
                ShowRatingInPlayer = defaultConfig.ShowRatingInPlayer,
                RemoveContinueWatchingEnabled = defaultConfig.RemoveContinueWatchingEnabled,
                HideFavoritesTab = defaultConfig.HideFavoritesTab,
                ReviewsExpandedByDefault = defaultConfig.ReviewsExpandedByDefault,
                DisplayLanguage = defaultConfig.DefaultLanguage,
                CalendarDisplayMode = "list",
                CalendarDefaultViewMode = "agenda",
                LastOpenedTab = "shortcuts"
            };

        [HttpGet("user-settings/{userId}/bookmark.json")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetUserBookmark(string userId)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            try
            {
                var state = _userConfigurationManager.GetBookmarks(authorizedUserId);
                SetBookmarkEtag(state.Revision);
                return Ok(state);
            }
            catch (Exception ex)
            {
                return BookmarkWriteFailure(authorizedUserId, "read bookmarks", ex);
            }
        }

        public sealed class BookmarkPageResponse
        {
            public long Revision { get; set; }
            public int Total { get; set; }
            public int AllTotal { get; set; }
            public int Movie { get; set; }
            public int Tv { get; set; }
            public int Other { get; set; }
            public int StartIndex { get; set; }
            public int Limit { get; set; }
            public bool HasMore { get; set; }
            public Dictionary<string, BookmarkItem> Bookmarks { get; set; } = new Dictionary<string, BookmarkItem>();
        }

        public sealed class BookmarkItemResolutionPayload
        {
            public List<string> ItemIds { get; set; } = new();
        }

        public sealed class BookmarkItemResolution
        {
            public string ItemId { get; set; } = string.Empty;
            public string Status { get; set; } = string.Empty;
            public string Id { get; set; } = string.Empty;
            public string Type { get; set; } = string.Empty;
            public string Name { get; set; } = string.Empty;
            public string SeriesName { get; set; } = string.Empty;
            public int? ParentIndexNumber { get; set; }
            public int? IndexNumber { get; set; }
        }

        public sealed class BookmarkItemResolutionResponse
        {
            public List<BookmarkItemResolution> Items { get; set; } = new();
        }

        /// <summary>
        /// Returns one deterministic, hard-capped bookmark page. ItemId is an
        /// exact optional search key so playback and management clients do not
        /// need to transfer the complete supported collection for one item.
        /// </summary>
        [HttpGet("user-settings/{userId}/bookmark.json/page")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetUserBookmarkPage(
            string userId,
            [FromQuery] int startIndex = 0,
            [FromQuery] int limit = 50,
            [FromQuery] string? itemId = null,
            [FromQuery] string? mediaType = null)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            if (startIndex < 0 || limit < 1 || limit > PersistedPayloadPolicy.MaximumBookmarkPageSize)
            {
                return BadRequest(new BookmarkMutationResponse
                {
                    Success = false,
                    Message = $"startIndex must be non-negative and limit must be 1-{PersistedPayloadPolicy.MaximumBookmarkPageSize}."
                });
            }

            if (itemId != null && (string.IsNullOrWhiteSpace(itemId)
                || itemId.Length > PersistedPayloadPolicy.MaximumBookmarkItemIdLength))
            {
                return BadRequest(new BookmarkMutationResponse
                {
                    Success = false,
                    Message = $"itemId must be 1-{PersistedPayloadPolicy.MaximumBookmarkItemIdLength} characters when supplied."
                });
            }

            if (mediaType != null && mediaType != "movie" && mediaType != "tv" && mediaType != "other")
            {
                return BadRequest(new BookmarkMutationResponse
                {
                    Success = false,
                    Message = "mediaType must be movie, tv, or other when supplied."
                });
            }

            try
            {
                var page = _userConfigurationManager.GetBookmarkPage(
                    authorizedUserId,
                    startIndex,
                    limit,
                    itemId,
                    mediaType);
                SetBookmarkEtag(page.Revision);
                return Ok(new BookmarkPageResponse
                {
                    Revision = page.Revision,
                    Total = page.Total,
                    AllTotal = page.AllTotal,
                    Movie = page.Movie,
                    Tv = page.Tv,
                    Other = page.Other,
                    StartIndex = page.StartIndex,
                    Limit = page.Limit,
                    HasMore = page.StartIndex < page.Total && page.Total - page.StartIndex > page.Bookmarks.Count,
                    Bookmarks = page.Bookmarks
                });
            }
            catch (Exception ex)
            {
                return BookmarkWriteFailure(authorizedUserId, "list bookmarks", ex);
            }
        }

        [HttpGet("user-settings/{userId}/bookmark.json/counts")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetUserBookmarkCounts(string userId)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null) return authorizationResult;
            try
            {
                var counts = _userConfigurationManager.GetBookmarkCounts(authorizedUserId);
                SetBookmarkEtag(counts.Revision);
                return Ok(counts);
            }
            catch (Exception ex)
            {
                return BookmarkWriteFailure(authorizedUserId, "read bookmark counts", ex);
            }
        }

        /// <summary>
        /// Resolves one bounded set of Jellyfin item ids in a single client
        /// request. Per-id status keeps global absence distinct from visibility
        /// or transient failures, so destructive orphan UI remains fail closed.
        /// </summary>
        [HttpPost("user-settings/{userId}/bookmark.json/items/resolve")]
        [Authorize]
        [Produces("application/json")]
        [PersistedPayloadLimit(PersistedPayloadPolicy.BookmarkRequestBytes)]
        public IActionResult ResolveBookmarkItems(
            string userId,
            [FromBody] BookmarkItemResolutionPayload payload,
            CancellationToken cancellationToken)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null) return authorizationResult;
            if (payload?.ItemIds == null || payload.ItemIds.Count == 0
                || payload.ItemIds.Count > PersistedPayloadPolicy.MaximumBookmarkPageSize
                || payload.ItemIds.Distinct(StringComparer.Ordinal).Count() != payload.ItemIds.Count
                || payload.ItemIds.Any(id => id == null
                    || id.Length > PersistedPayloadPolicy.MaximumBookmarkItemIdLength))
            {
                return BadRequest(new BookmarkMutationResponse
                {
                    Success = false,
                    Message = $"Supply 1-{PersistedPayloadPolicy.MaximumBookmarkPageSize} distinct bounded item ids."
                });
            }

            if (!Guid.TryParseExact(authorizedUserId, "N", out var authorizedUserGuid))
            {
                return BadRequest(new BookmarkMutationResponse { Success = false, Message = "Invalid authorized user id." });
            }
            var user = _userManager.GetUserById(authorizedUserGuid);
            if (user == null)
            {
                return NotFound(new BookmarkMutationResponse { Success = false, Message = "The authorized user no longer exists." });
            }

            var response = new BookmarkItemResolutionResponse();
            foreach (var rawItemId in payload.ItemIds)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var resolution = new BookmarkItemResolution { ItemId = rawItemId };
                if (!Guid.TryParse(rawItemId, out var itemId))
                {
                    resolution.Status = "invalid";
                    response.Items.Add(resolution);
                    continue;
                }

                try
                {
                    var global = _libraryManager.GetItemById<BaseItem>(itemId);
                    if (global == null)
                    {
                        resolution.Status = "notFound";
                    }
                    else
                    {
                        var visible = _libraryManager.GetItemById<BaseItem>(itemId, user);
                        if (visible == null)
                        {
                            resolution.Status = "forbidden";
                        }
                        else
                        {
                            resolution.Status = "exists";
                            resolution.Id = visible.Id.ToString("N");
                            resolution.Type = visible.GetType().Name;
                            resolution.Name = visible.Name ?? string.Empty;
                            if (visible is MediaBrowser.Controller.Entities.TV.Episode episode)
                            {
                                resolution.Type = "Episode";
                                resolution.SeriesName = episode.SeriesName ?? string.Empty;
                                resolution.ParentIndexNumber = episode.ParentIndexNumber;
                                resolution.IndexNumber = episode.IndexNumber;
                            }
                        }
                    }
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    resolution.Status = "transient";
                    _logger.LogWarning(
                        $"Bookmark item batch resolution retained {rawItemId}; lookup failed with {ex.GetType().Name}.");
                }
                response.Items.Add(resolution);
            }
            return Ok(response);
        }

        [HttpPost("user-settings/{userId}/bookmark.json")]
        [Authorize]
        [Produces("application/json")]
        [PersistedPayloadLimit(PersistedPayloadPolicy.BookmarkRequestBytes)]
        public IActionResult SaveUserBookmark(string userId, [FromBody] UserBookmark userConfiguration)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            if (userConfiguration == null || userConfiguration.Bookmarks == null)
            {
                return BadRequest(new BookmarkMutationResponse { Success = false, Message = "Bookmarks is required." });
            }

            if (!TryParseIfMatchRevision(out var expectedRevision))
            {
                return StatusCode(StatusCodes.Status428PreconditionRequired, new BookmarkMutationResponse
                {
                    Success = false,
                    Message = "Full bookmark replacement requires If-Match: \"<revision>\" from the latest GET."
                });
            }

            if (userConfiguration.Revision != expectedRevision)
            {
                return BadRequest(new BookmarkMutationResponse
                {
                    Success = false,
                    Message = "The body Revision must match the If-Match revision."
                });
            }

            try
            {
                var result = FromBookmarkStore(_userConfigurationManager.ReplaceBookmarks(
                    authorizedUserId,
                    expectedRevision,
                    userConfiguration.Bookmarks));
                if (result.Status == BookmarkCommitStatus.Success)
                {
                    _logger.LogInformation($"Replaced enhanced bookmarks for {ResolveUserDisplay(authorizedUserId)} at revision {result.State!.Revision}");
                }
                return ToBookmarkActionResult(result);
            }
            catch (Exception ex)
            {
                return BookmarkWriteFailure(authorizedUserId, "replace bookmarks", ex);
            }
        }

        public sealed class AddBookmarkPayload
        {
            public long? Revision { get; set; }
            public string BookmarkId { get; set; } = string.Empty;
            public string ItemId { get; set; } = string.Empty;
            public int IdentityVersion { get; set; }
            public string ItemType { get; set; } = string.Empty;
            public string TmdbId { get; set; } = string.Empty;
            public string TvdbId { get; set; } = string.Empty;
            public string SeriesTmdbId { get; set; } = string.Empty;
            public string SeriesTvdbId { get; set; } = string.Empty;
            public string MediaType { get; set; } = string.Empty;
            public int? SeasonNumber { get; set; }
            public int? EpisodeNumber { get; set; }
            public int? EpisodeEndNumber { get; set; }
            public string Name { get; set; } = string.Empty;
            public double Timestamp { get; set; }
            public string Label { get; set; } = string.Empty;
            public string SyncedFrom { get; set; } = string.Empty;
        }

        [HttpPost("user-settings/{userId}/bookmark.json/add")]
        [Authorize]
        [Produces("application/json")]
        [PersistedPayloadLimit(PersistedPayloadPolicy.BookmarkRequestBytes)]
        public IActionResult AddUserBookmark(string userId, [FromBody] AddBookmarkPayload payload)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            if (payload == null || string.IsNullOrWhiteSpace(payload.ItemId))
            {
                return BadRequest(new { success = false, message = "ItemId is required." });
            }

            if (!payload.Revision.HasValue)
            {
                return PreconditionRequired();
            }

            var now = DateTime.UtcNow.ToString("o");
            var bookmarkId = string.IsNullOrWhiteSpace(payload.BookmarkId)
                ? $"Bm_{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}_{Guid.NewGuid().ToString("N").Substring(0, 9)}"
                : payload.BookmarkId;

            if (!IsValidBookmarkId(bookmarkId))
            {
                return BadRequest(new BookmarkMutationResponse { Success = false, Message = BookmarkInputMessage });
            }

            try
            {
                var item = new BookmarkItem
                {
                    ItemId = payload.ItemId,
                    IdentityVersion = payload.IdentityVersion,
                    ItemType = payload.ItemType ?? string.Empty,
                    TmdbId = payload.TmdbId ?? string.Empty,
                    TvdbId = payload.TvdbId ?? string.Empty,
                    SeriesTmdbId = payload.SeriesTmdbId ?? string.Empty,
                    SeriesTvdbId = payload.SeriesTvdbId ?? string.Empty,
                    MediaType = payload.MediaType ?? string.Empty,
                    SeasonNumber = payload.SeasonNumber,
                    EpisodeNumber = payload.EpisodeNumber,
                    EpisodeEndNumber = payload.EpisodeEndNumber,
                    Name = payload.Name ?? string.Empty,
                    Timestamp = payload.Timestamp,
                    Label = payload.Label ?? string.Empty,
                    CreatedAt = now,
                    UpdatedAt = now,
                    SyncedFrom = payload.SyncedFrom ?? string.Empty
                };
                if (!IsValidBookmarkItem(item))
                {
                    return BadRequest(new BookmarkMutationResponse { Success = false, Message = BookmarkInputMessage });
                }
                var result = ApplyIndexedBookmarkOperations(
                    authorizedUserId,
                    payload.Revision,
                    new[] { new BookmarkOperationPayload { Type = "add", BookmarkId = bookmarkId, Bookmark = item } },
                    includeCompleteSuccess: true);
                if (result.Status == BookmarkCommitStatus.Success)
                {
                    result.ResponseId = bookmarkId;
                    _logger.LogInformation($"Added bookmark {bookmarkId} for {ResolveUserDisplay(authorizedUserId)} at revision {result.State!.Revision}");
                }
                return ToBookmarkActionResult(result);
            }
            catch (Exception ex)
            {
                return BookmarkWriteFailure(authorizedUserId, "add bookmark", ex);
            }
        }

        public sealed class UpdateBookmarkPayload
        {
            public long? Revision { get; set; }
            public BookmarkItem? Bookmark { get; set; }
        }

        [HttpPut("user-settings/{userId}/bookmark.json/{bookmarkId}")]
        [Authorize]
        [Produces("application/json")]
        [PersistedPayloadLimit(PersistedPayloadPolicy.BookmarkRequestBytes)]
        public IActionResult UpdateUserBookmark(string userId, string bookmarkId, [FromBody] UpdateBookmarkPayload payload)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            if (payload == null || !IsValidBookmarkItem(payload.Bookmark) || !IsValidBookmarkId(bookmarkId))
            {
                return BadRequest(new BookmarkMutationResponse { Success = false, Message = BookmarkInputMessage });
            }

            if (!payload.Revision.HasValue)
            {
                return PreconditionRequired();
            }

            try
            {
                var result = ApplyIndexedBookmarkOperations(
                    authorizedUserId,
                    payload.Revision,
                    new[] { new BookmarkOperationPayload { Type = "update", BookmarkId = bookmarkId, Bookmark = payload.Bookmark } },
                    includeCompleteSuccess: true);
                if (result.Status == BookmarkCommitStatus.Success)
                {
                    result.ResponseId = bookmarkId;
                    _logger.LogInformation($"Updated bookmark {bookmarkId} for {ResolveUserDisplay(authorizedUserId)} at revision {result.State!.Revision}");
                }
                return ToBookmarkActionResult(result);
            }
            catch (Exception ex)
            {
                return BookmarkWriteFailure(authorizedUserId, "update bookmark", ex);
            }
        }

        [HttpDelete("user-settings/{userId}/bookmark.json/{bookmarkId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult RemoveUserBookmark(string userId, string bookmarkId, [FromQuery] long? revision)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            if (!IsValidBookmarkId(bookmarkId))
            {
                return BadRequest(new BookmarkMutationResponse { Success = false, Message = BookmarkInputMessage });
            }

            if (!revision.HasValue)
            {
                return PreconditionRequired();
            }

            try
            {
                var result = ApplyIndexedBookmarkOperations(
                    authorizedUserId,
                    revision,
                    new[] { new BookmarkOperationPayload { Type = "delete-strict", BookmarkId = bookmarkId } },
                    includeCompleteSuccess: true);
                if (result.Status == BookmarkCommitStatus.Success)
                {
                    result.Removed = true;
                    _logger.LogInformation($"Removed bookmark {bookmarkId} for {ResolveUserDisplay(authorizedUserId)} at revision {result.State!.Revision}");
                }
                return ToBookmarkActionResult(result);
            }
            catch (Exception ex)
            {
                return BookmarkWriteFailure(authorizedUserId, "remove bookmark", ex);
            }
        }

        public sealed class BookmarkBatchPayload
        {
            public long? Revision { get; set; }
            public bool CompactResponse { get; set; }
            public List<BookmarkOperationPayload> Operations { get; set; } = new List<BookmarkOperationPayload>();
        }

        public sealed class BookmarkOperationPayload
        {
            public string Type { get; set; } = string.Empty;
            public string BookmarkId { get; set; } = string.Empty;
            public string SourceBookmarkId { get; set; } = string.Empty;
            public BookmarkItem? Bookmark { get; set; }
            public double? Timestamp { get; set; }
            public string UpdatedAt { get; set; } = string.Empty;
        }

        public sealed class BookmarkMutationResponse
        {
            public bool Success { get; set; }
            public bool Conflict { get; set; }
            public string Message { get; set; } = string.Empty;
            public string Id { get; set; } = string.Empty;
            public bool? Removed { get; set; }
            public long Revision { get; set; }
            public bool CompleteState { get; set; } = true;
            public Dictionary<string, BookmarkItem> Bookmarks { get; set; } = new Dictionary<string, BookmarkItem>();
            public List<string> DeletedBookmarkIds { get; set; } = new List<string>();
            public int Deleted { get; set; }
            public int RetainedUncertain { get; set; }
            public int Errors { get; set; }
            public int ScannedItems { get; set; }
            public bool HasMore { get; set; }
            public string? NextCursor { get; set; }
        }

        [HttpPost("user-settings/{userId}/bookmark.json/batch")]
        [Authorize]
        [Produces("application/json")]
        [PersistedPayloadLimit(PersistedPayloadPolicy.BookmarkRequestBytes)]
        public IActionResult BatchUserBookmarks(string userId, [FromBody] BookmarkBatchPayload payload)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            if (payload == null || payload.Operations == null || payload.Operations.Count == 0)
            {
                return BadRequest(new BookmarkMutationResponse { Success = false, Message = "At least one operation is required." });
            }

            if (payload.Operations.Count > PersistedPayloadPolicy.MaximumBookmarks)
            {
                return StatusCode(StatusCodes.Status413PayloadTooLarge, new BookmarkMutationResponse
                {
                    Success = false,
                    Message = $"A bookmark batch may contain at most {PersistedPayloadPolicy.MaximumBookmarks:N0} operations."
                });
            }

            if (!payload.Revision.HasValue)
            {
                return PreconditionRequired();
            }

            try
            {
                var result = ApplyIndexedBookmarkOperations(
                    authorizedUserId,
                    payload.Revision,
                    payload.Operations,
                    includeCompleteSuccess: !payload.CompactResponse);
                if (result.Status == BookmarkCommitStatus.Success)
                {
                    _logger.LogInformation(
                        $"Committed {payload.Operations.Count} bookmark operations for {ResolveUserDisplay(authorizedUserId)} at revision {result.State!.Revision}");
                }
                return ToBookmarkActionResult(result, compactSuccess: payload.CompactResponse);
            }
            catch (Exception ex)
            {
                return BookmarkWriteFailure(authorizedUserId, "apply bookmark batch", ex);
            }
        }

        public sealed class BookmarkCleanupPayload
        {
            public long? Revision { get; set; }
            public bool CompactResponse { get; set; }
            public string? Cursor { get; set; }
            public int Limit { get; set; } = PersistedPayloadPolicy.MaximumBookmarkPageSize;
        }

        /// <summary>
        /// Classifies the loaded user's bookmarked Jellyfin items and removes
        /// only entries whose item is authoritatively absent from the server.
        /// A globally present item that is not visible to this user is retained,
        /// as is every malformed, cancelled, or failed lookup.
        /// </summary>
        [HttpPost("user-settings/{userId}/bookmark.json/cleanup")]
        [Authorize]
        [Produces("application/json")]
        [PersistedPayloadLimit(PersistedPayloadPolicy.BookmarkRequestBytes)]
        public IActionResult CleanupUserBookmarks(
            string userId,
            [FromBody] BookmarkCleanupPayload payload,
            CancellationToken cancellationToken)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            if (payload == null || !payload.Revision.HasValue)
            {
                return PreconditionRequired();
            }

            if (payload.Limit < 1 || payload.Limit > PersistedPayloadPolicy.MaximumBookmarkPageSize
                || (payload.Cursor != null && payload.Cursor.Length > PersistedPayloadPolicy.MaximumBookmarkCursorLength))
            {
                return BadRequest(new BookmarkMutationResponse
                {
                    Success = false,
                    Message = $"Cleanup limit must be 1-{PersistedPayloadPolicy.MaximumBookmarkPageSize}; cursor is capped at {PersistedPayloadPolicy.MaximumBookmarkCursorLength} characters."
                });
            }

            if (!Guid.TryParseExact(authorizedUserId, "N", out var authorizedUserGuid))
            {
                return BadRequest(new BookmarkMutationResponse { Success = false, Message = "Invalid authorized user id." });
            }

            var user = _userManager.GetUserById(authorizedUserGuid);
            if (user == null)
            {
                return NotFound(new BookmarkMutationResponse { Success = false, Message = "The authorized user no longer exists." });
            }

            var counts = new BookmarkCleanupCounts();
            try
            {
                var storeCounts = _userConfigurationManager.GetBookmarkCounts(authorizedUserId);
                if (storeCounts.Total > PersistedPayloadPolicy.MaximumBookmarks)
                {
                    counts.RetainedUncertain = storeCounts.Total;
                    counts.Errors = 1;
                    return StatusCode(StatusCodes.Status413PayloadTooLarge, new BookmarkMutationResponse
                    {
                        Success = false,
                        Revision = storeCounts.Revision,
                        Message = $"Bookmark cleanup is bounded to {PersistedPayloadPolicy.MaximumBookmarks:N0} entries; repair or reset the legacy store first.",
                        RetainedUncertain = counts.RetainedUncertain,
                        Errors = counts.Errors
                    });
                }
                var page = _userConfigurationManager.GetBookmarkItemGroups(
                    authorizedUserId,
                    payload.Cursor,
                    payload.Limit);
                if (page.Revision != payload.Revision.Value)
                {
                    var conflict = FromBookmarkStore(_userConfigurationManager.ApplyBookmarkOperations(
                        authorizedUserId,
                        payload.Revision,
                        Array.Empty<BookmarkStoreOperation>()));
                    return ToBookmarkActionResult(conflict, counts, compactSuccess: false);
                }

                var deleteIds = new List<string>();
                foreach (var group in page.Groups)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (!Guid.TryParse(group.ItemId, out var itemId))
                    {
                        counts.RetainedUncertain += group.BookmarkIds.Count;
                        counts.Errors++;
                        continue;
                    }

                    var existence = ClassifyBookmarkItem(itemId, user, cancellationToken);
                    switch (existence.Kind)
                    {
                        case BookmarkItemExistenceKind.NotFound:
                            deleteIds.AddRange(group.BookmarkIds);
                            break;
                        case BookmarkItemExistenceKind.ForbiddenOrNotVisible:
                            counts.RetainedUncertain += group.BookmarkIds.Count;
                            break;
                        case BookmarkItemExistenceKind.TransientFailure:
                            counts.RetainedUncertain += group.BookmarkIds.Count;
                            counts.Errors++;
                            _logger.LogWarning(
                                $"Retaining {group.BookmarkIds.Count} bookmark(s) for item {itemId:N}; existence classification failed: {existence.ErrorType}");
                            break;
                        case BookmarkItemExistenceKind.Cancelled:
                            throw new OperationCanceledException(cancellationToken);
                    }
                }

                cancellationToken.ThrowIfCancellationRequested();
                var result = ApplyIndexedBookmarkOperations(
                    authorizedUserId,
                    payload.Revision,
                    deleteIds.Select(id => new BookmarkOperationPayload
                    {
                        Type = "delete",
                        BookmarkId = id
                    }).ToList(),
                    includeCompleteSuccess: !payload.CompactResponse);
                counts.Deleted = result.Status == BookmarkCommitStatus.Success ? deleteIds.Count : 0;
                counts.DeletedBookmarkIds.AddRange(
                    result.Status == BookmarkCommitStatus.Success
                        ? deleteIds.OrderBy(id => id, StringComparer.Ordinal)
                        : Array.Empty<string>());
                if (result.Status == BookmarkCommitStatus.Success)
                {
                    _logger.LogInformation(
                        $"Bookmark cleanup batch for {ResolveUserDisplay(authorizedUserId)} scanned {page.Groups.Count} items, deleted {counts.Deleted}, retained {counts.RetainedUncertain} uncertain, and observed {counts.Errors} lookup errors at revision {result.State!.Revision}");
                }
                return ToBookmarkActionResult(
                    result,
                    counts,
                    payload.CompactResponse,
                    scannedItems: page.Groups.Count,
                    nextCursor: page.NextCursor);
            }
            catch (OperationCanceledException)
            {
                return StatusCode(499, new BookmarkMutationResponse
                {
                    Success = false,
                    Message = "Bookmark cleanup was cancelled; no deletion set was committed.",
                    RetainedUncertain = counts.RetainedUncertain,
                    Errors = counts.Errors
                });
            }
            catch (ArgumentException ex)
            {
                return BadRequest(new BookmarkMutationResponse { Success = false, Message = ex.Message });
            }
            catch (Exception ex)
            {
                return BookmarkWriteFailure(authorizedUserId, "clean up bookmarks", ex);
            }
        }

        private const string BookmarkFileName = "bookmark.json";
        private const string BookmarkInputMessage = "Bookmark ids and item ids must be 1-256 characters; provider ids are capped at 128, type fields at 64, names and labels at 512, timestamps at 64; Timestamp must be finite and non-negative.";
        private static readonly string BookmarkQuotaMessage = $"A user may store at most {PersistedPayloadPolicy.MaximumBookmarks:N0} bookmarks and {PersistedPayloadPolicy.BookmarkPersistedBytes:N0} indexed payload bytes.";

        private enum BookmarkCommitStatus
        {
            Success,
            PreconditionRequired,
            Conflict,
            Invalid,
            NotFound,
            TooLarge
        }

        private sealed class BookmarkCommitResult
        {
            public BookmarkCommitStatus Status { get; set; }
            public UserBookmark? State { get; set; }
            public string Message { get; set; } = string.Empty;
            public string ResponseId { get; set; } = string.Empty;
            public bool? Removed { get; set; }
        }

        private BookmarkCommitResult ApplyIndexedBookmarkOperations(
            string userId,
            long? expectedRevision,
            IReadOnlyList<BookmarkOperationPayload> operations,
            bool includeCompleteSuccess)
            => FromBookmarkStore(_userConfigurationManager.ApplyBookmarkOperations(
                userId,
                expectedRevision,
                operations.Select(operation => new BookmarkStoreOperation
                {
                    Type = operation.Type,
                    BookmarkId = operation.BookmarkId,
                    SourceBookmarkId = operation.SourceBookmarkId,
                    Bookmark = operation.Bookmark,
                    Timestamp = operation.Timestamp,
                    UpdatedAt = operation.UpdatedAt
                }).ToList(),
                includeCompleteSuccess));

        private static BookmarkCommitResult FromBookmarkStore(BookmarkStoreMutationResult result)
            => new BookmarkCommitResult
            {
                Status = result.Status switch
                {
                    BookmarkStoreStatus.Success => BookmarkCommitStatus.Success,
                    BookmarkStoreStatus.Conflict => BookmarkCommitStatus.Conflict,
                    BookmarkStoreStatus.Invalid => BookmarkCommitStatus.Invalid,
                    BookmarkStoreStatus.NotFound => BookmarkCommitStatus.NotFound,
                    BookmarkStoreStatus.TooLarge => BookmarkCommitStatus.TooLarge,
                    _ => BookmarkCommitStatus.Invalid
                },
                State = result.State ?? new UserBookmark
                {
                    Revision = result.Revision,
                    Bookmarks = new Dictionary<string, BookmarkItem>(StringComparer.Ordinal)
                },
                Message = result.Message
            };

        private sealed class BookmarkCleanupCounts
        {
            public int Deleted { get; set; }
            public int RetainedUncertain { get; set; }
            public int Errors { get; set; }
            public List<string> DeletedBookmarkIds { get; } = new List<string>();
        }

        private enum BookmarkItemExistenceKind
        {
            Exists,
            NotFound,
            ForbiddenOrNotVisible,
            TransientFailure,
            Cancelled
        }

        private readonly struct BookmarkItemExistenceResult
        {
            public BookmarkItemExistenceResult(BookmarkItemExistenceKind kind, string errorType = "")
            {
                Kind = kind;
                ErrorType = errorType;
            }

            public BookmarkItemExistenceKind Kind { get; }
            public string ErrorType { get; }
        }

        private BookmarkItemExistenceResult ClassifyBookmarkItem(
            Guid itemId,
            JUser user,
            CancellationToken cancellationToken)
        {
            if (cancellationToken.IsCancellationRequested)
            {
                return new BookmarkItemExistenceResult(BookmarkItemExistenceKind.Cancelled);
            }

            try
            {
                var serverItem = _libraryManager.GetItemById<BaseItem>(itemId);
                if (serverItem == null)
                {
                    return new BookmarkItemExistenceResult(BookmarkItemExistenceKind.NotFound);
                }

                if (cancellationToken.IsCancellationRequested)
                {
                    return new BookmarkItemExistenceResult(BookmarkItemExistenceKind.Cancelled);
                }

                // Global existence plus a null user-scoped lookup means the
                // item is forbidden/not visible, never deleted.
                return _libraryManager.GetItemById<BaseItem>(itemId, user) == null
                    ? new BookmarkItemExistenceResult(BookmarkItemExistenceKind.ForbiddenOrNotVisible)
                    : new BookmarkItemExistenceResult(BookmarkItemExistenceKind.Exists);
            }
            catch (OperationCanceledException)
            {
                return new BookmarkItemExistenceResult(BookmarkItemExistenceKind.Cancelled);
            }
            catch (Exception ex)
            {
                return new BookmarkItemExistenceResult(
                    BookmarkItemExistenceKind.TransientFailure,
                    ex.GetType().Name);
            }
        }


        private static bool IsValidBookmarkId(string? bookmarkId)
            => PersistedPayloadPolicy.IsValidBookmarkId(bookmarkId);

        private static bool IsValidBookmarkItem(BookmarkItem? bookmark)
            => PersistedPayloadPolicy.IsValidBookmarkItem(bookmark);

        private bool TryParseIfMatchRevision(out long revision)
        {
            revision = -1;
            var raw = Request.Headers["If-Match"].ToString().Trim();
            if (raw.StartsWith("W/", StringComparison.OrdinalIgnoreCase)) return false;
            if (raw.Length < 2 || raw[0] != '"' || raw[^1] != '"') return false;
            raw = raw.Substring(1, raw.Length - 2);
            return long.TryParse(
                    raw,
                    NumberStyles.None,
                    CultureInfo.InvariantCulture,
                    out revision)
                && revision >= 0
                && string.Equals(
                    raw,
                    revision.ToString(CultureInfo.InvariantCulture),
                    StringComparison.Ordinal);
        }

        private IActionResult PreconditionRequired()
            => StatusCode(StatusCodes.Status428PreconditionRequired, new BookmarkMutationResponse
            {
                Success = false,
                Message = "A bookmark Revision from the latest committed state is required."
            });

        private IActionResult ToBookmarkActionResult(
            BookmarkCommitResult result,
            BookmarkCleanupCounts? cleanup = null,
            bool compactSuccess = false,
            int scannedItems = 0,
            string? nextCursor = null)
        {
            if (result.State != null) SetBookmarkEtag(result.State.Revision);
            // Conflicts always carry the complete authoritative state so the
            // caller can rebase. A compact successful receipt carries only the
            // revision and cleanup delta, avoiding an O(total) response for an
            // ordinary one-bookmark mutation.
            var includeCompleteState = !compactSuccess || result.Status == BookmarkCommitStatus.Conflict;
            var response = new BookmarkMutationResponse
            {
                Success = result.Status == BookmarkCommitStatus.Success,
                Conflict = result.Status == BookmarkCommitStatus.Conflict,
                Message = result.Message,
                Id = result.ResponseId,
                Removed = result.Removed,
                Revision = result.State?.Revision ?? 0,
                CompleteState = includeCompleteState,
                Bookmarks = includeCompleteState
                    ? result.State?.Bookmarks ?? new Dictionary<string, BookmarkItem>()
                    : new Dictionary<string, BookmarkItem>(),
                DeletedBookmarkIds = cleanup?.DeletedBookmarkIds ?? new List<string>(),
                Deleted = cleanup?.Deleted ?? 0,
                RetainedUncertain = cleanup?.RetainedUncertain ?? 0,
                Errors = cleanup?.Errors ?? 0,
                ScannedItems = scannedItems,
                HasMore = nextCursor != null,
                NextCursor = nextCursor
            };

            return result.Status switch
            {
                BookmarkCommitStatus.Success => Ok(response),
                BookmarkCommitStatus.PreconditionRequired => StatusCode(StatusCodes.Status428PreconditionRequired, response),
                BookmarkCommitStatus.Conflict => Conflict(response),
                BookmarkCommitStatus.Invalid => BadRequest(response),
                BookmarkCommitStatus.NotFound => NotFound(response),
                BookmarkCommitStatus.TooLarge => StatusCode(StatusCodes.Status413PayloadTooLarge, response),
                _ => StatusCode(StatusCodes.Status500InternalServerError, response)
            };
        }

        private IActionResult BookmarkWriteFailure(string authorizedUserId, string operation, Exception ex)
        {
            if (ex is UserStoreUnhealthyException)
            {
                return StatusCode(StatusCodes.Status503ServiceUnavailable, new BookmarkMutationResponse
                {
                    Success = false,
                    Message = "Bookmark state is quarantined. Retry alone cannot recover it; an administrator must inspect and reset or repair the store."
                });
            }

            _logger.LogError($"Failed to {operation} for {ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
            if (ex is InvalidDataException || ex is JsonException || ex is IOException || ex is UnauthorizedAccessException)
            {
                return StatusCode(StatusCodes.Status503ServiceUnavailable, new BookmarkMutationResponse
                {
                    Success = false,
                    Message = "Bookmark state is corrupt or temporarily unavailable; no mutation was committed."
                });
            }

            return StatusCode(StatusCodes.Status500InternalServerError, new BookmarkMutationResponse
            {
                Success = false,
                Message = "Bookmark mutation failed; no state was acknowledged."
            });
        }

        private void SetBookmarkEtag(long revision)
            => Response.Headers.ETag = $"\"{revision}\"";

        [HttpPost("user-settings/{userId}/elsewhere.json")]
        [Authorize]
        [Produces("application/json")]
        [PersistedPayloadLimit(PersistedPayloadPolicy.StandardRequestBytes)]
        public IActionResult SaveUserSettingsElsewhere(string userId, [FromBody] ElsewhereSettings userConfiguration)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            return CommitUserFile(authorizedUserId, "elsewhere.json", userConfiguration, "elsewhere settings");
        }

        [HttpPost("reset-all-users-settings")]
        [Authorize(Policy = Policies.RequiresElevation)]
        public IActionResult ResetAllUsersSettings()
        {
            var defaultConfig = _configProvider.ConfigurationOrNull;

            if (defaultConfig == null)
            {
                return StatusCode(500, new { success = false, message = "Default plugin configuration not found." });
            }

            var defaultsValidation = BuildDefaultUserSettings(defaultConfig);
            if (!IsValidUserFileState(defaultsValidation))
            {
                return BadRequest(new
                {
                    success = false,
                    message = "Default plugin settings are invalid; no user settings were reset."
                });
            }

            var userCount = 0;
            var skippedSettings = new System.Collections.Generic.List<string>();
            var skippedHc = new System.Collections.Generic.List<string>();
            // Get all user IDs from the UserConfigurationManager's known users
            var userIds = _userConfigurationManager.GetAllUserIds();
            foreach (var userId in userIds)
            {
                try
                {
                    lock (_userConfigurationManager.GetUserFileLock(userId, "settings.json"))
                    {
                        var current = _userConfigurationManager.GetUserConfigurationStrict<UserSettings>(userId, "settings.json");
                        var replacement = BuildDefaultUserSettings(defaultConfig);
                        replacement.Revision = checked(current.Revision + 1);
                        StampServerManagedFields(userId, replacement);
                        _userConfigurationManager.SaveUserConfiguration(userId, "settings.json", replacement);
                    }
                    userCount++;
                }
                catch (Exception ex)
                {
                    _logger.LogWarning($"Skipping settings.json reset for {ResolveUserDisplay(userId)}: {ex.Message}");
                    skippedSettings.Add(userId);
                }

                // Push HC Settings only — user's Items dict is data, not a default. Per-user errors are skipped, not fatal.
                try
                {
                    _userConfigurationManager.RmwUserConfiguration<UserHiddenContent>(
                        userId, "hidden-content.json", hc =>
                        {
                            var replacement = BuildHcDefaultSettings(defaultConfig);
                            replacement.Revision = checked((hc.Settings?.Revision ?? 0) + 1);
                            hc.Settings = replacement;
                            return 1;
                        });
                    Services.HiddenContentResponseFilter.InvalidateUser(userId);
                }
                catch (UserStoreUnhealthyException)
                {
                    // The durable transition was already logged once. Report this
                    // user in the response without amplifying logs on admin retries.
                    skippedHc.Add(userId);
                }
                catch (Exception ex) when (ex is InvalidDataException
                                        || ex is System.Text.Json.JsonException
                                        || ex is IOException
                                        || ex is UnauthorizedAccessException)
                {
                    _logger.LogWarning($"Skipping HC settings reset for {ResolveUserDisplay(userId)}: {ex.Message}");
                    skippedHc.Add(userId);
                }
            }

            _logger.LogInformation($"Reset settings for {userCount}/{userIds.Count()} users to plugin defaults. Skipped settings: {skippedSettings.Count}, skipped HC: {skippedHc.Count}.");
            return Ok(new
            {
                success = true,
                userCount,
                totalUsers = userIds.Count(),
                skippedSettingsUserIds = skippedSettings,
                skippedHcUserIds = skippedHc,
            });
        }
    }
}
