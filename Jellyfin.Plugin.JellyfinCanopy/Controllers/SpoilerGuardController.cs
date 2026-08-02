using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Common.Api;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Controllers
{
    /// <summary>
    /// Owns every Spoiler Guard HTTP endpoint: the self-or-admin spoilerblur.json
    /// accessor pair, the corruption-health surface, the per-series / per-movie /
    /// per-collection opt-in toggles, the per-user strip-override prefs and the
    /// pre-acquisition (Seerr / not-yet-downloaded) pending flow. All per-user state
    /// lives in spoilerblur.json; the hosted promoter's instance gate is reconciled
    /// from that authoritative file after every pending-affecting write. Split out
    /// of the monolithic controller; routes are identical to the reference so the
    /// client is unchanged.
    /// </summary>
    [Route("JellyfinCanopy")]
    [ApiController]
    public class SpoilerGuardController : JellyfinCanopyControllerBase
    {
        private readonly UserConfigurationManager _userConfigurationManager;
        private readonly ILibraryManager _libraryManager;
        private readonly ISpoilerGuardItemActionOwner _itemActionOwner;
        private readonly SpoilerPendingService _pendingService;
        private readonly SpoilerUserResolver _resolver;
        private readonly IUserDataManager _userDataManager;

        public SpoilerGuardController(
            IHttpClientFactory httpClientFactory,
            ILogger<SpoilerGuardController> logger,
            IUserManager userManager,
            ISeerrCache seerrCache,
            IPluginConfigProvider configProvider,
            UserConfigurationManager userConfigurationManager,
            ILibraryManager libraryManager,
            ISpoilerGuardItemActionOwner itemActionOwner,
            SpoilerPendingService pendingService,
            SpoilerUserResolver resolver,
            IUserDataManager userDataManager)
            : base(httpClientFactory, logger, userManager, seerrCache, configProvider)
        {
            _userConfigurationManager = userConfigurationManager;
            _libraryManager = libraryManager;
            _itemActionOwner = itemActionOwner;
            _pendingService = pendingService;
            _resolver = resolver;
            _userDataManager = userDataManager;
        }

        private const string SpoilerFileName = "spoilerblur.json";
        private const string SpoilerPrefsResource = "spoiler-guard-prefs.json";
        private const string SpoilerOverridesResource = "spoiler-guard-overrides.json";

        private static bool IsCorruptStoreException(Exception exception)
            => exception is UserStoreUnhealthyException or InvalidDataException or JsonException;

        // Standard corrupt-store response. The store itself logs only the transition;
        // the in-memory banner is likewise recorded only for the new generation so
        // request retries cannot amplify logs or events.
        private IActionResult CorruptStore(string userKey, Exception strictEx)
        {
            SpoilerUserResolver.RecordCorruption(userKey, ResolveUserDisplay(userKey), strictEx.Message);
            return StatusCode(503, new
            {
                success = false,
                message = "Spoiler Guard state is quarantined. Retry alone cannot recover it; an administrator must inspect and reset or repair the store."
            });
        }

        private IActionResult SpoilerConfigurationUnavailable()
            => StatusCode(StatusCodes.Status503ServiceUnavailable, new
            {
                success = false,
                message = "Spoiler Guard configuration is temporarily unavailable; no default state was assumed."
            });

        private UserConfigReadStatus RequireSpoilerMutationRead(
            string userId,
            UserConfigReadResult<UserSpoilerBlur> read)
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
                    SpoilerFileName,
                    newlyQuarantined: false);
            }

            if (read.Status == UserConfigReadStatus.Unavailable)
            {
                throw new IOException("Spoiler Guard state is temporarily unavailable.");
            }

            _userConfigurationManager.GetUserConfigurationStrict<UserSpoilerBlur>(
                userId,
                SpoilerFileName);
            throw new InvalidDataException("Spoiler Guard state is corrupt.");
        }

        // ─── Self-or-admin spoilerblur.json accessor pair ───────────────────────
        // Mirrors the other per-user JC files so an administrator can inspect or
        // repair a user's Spoiler Guard state remotely.

        [HttpGet("user-settings/{userId}/spoilerblur.json")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetUserSpoilerBlur(string userId)
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

            var read = _userConfigurationManager.ReadUserConfiguration<UserSpoilerBlur>(
                authorizedUserId, SpoilerFileName);
            if (!read.HasUsableValue || read.Value == null)
            {
                var quarantined = string.Equals(
                    read.FaultDetail,
                    "quarantined-recovery-required",
                    StringComparison.Ordinal);
                return StatusCode(StatusCodes.Status503ServiceUnavailable, new
                {
                    success = false,
                    message = quarantined
                        ? "Spoiler Guard state is quarantined. Retry alone cannot recover it; an administrator must inspect and reset or repair the store."
                        : "Spoiler Guard state is corrupt or temporarily unavailable. No empty replacement state was published."
                });
            }

            if (read.Status == UserConfigReadStatus.Missing
                && _configProvider.ConfigurationOrNull == null)
            {
                return SpoilerConfigurationUnavailable();
            }

            var responseState = ClonePersisted(read.Value);
            PersistedPayloadPolicy.NormalizeLegacyRuntimeState(responseState);
            if (!PersistedPayloadPolicy.Validate(responseState).IsValid)
            {
                return StatusCode(StatusCodes.Status503ServiceUnavailable, new
                {
                    success = false,
                    message = "Spoiler Guard state is invalid. No replacement state was published."
                });
            }

            return Ok(responseState);
        }

        // Hard cap per spoiler-list dict on the raw full-state save endpoint: the
        // image/field-strip filters iterate this file every request (a Collections
        // key drives a library lookup per key), so an unbounded payload amplifies
        // into millions of lookups per library view. Mirrors the pending path cap.
        private const int MaxSpoilerEntriesPerDict
            = PersistedPayloadPolicy.MaximumSpoilerEntriesPerDictionary;

        [HttpPost("user-settings/{userId}/spoilerblur.json")]
        [Authorize]
        [Produces("application/json")]
        [Consumes("application/json")]
        // Cap the body: 4×1000 entries is a few hundred KB even with long names.
        // 2 MB leaves headroom while removing Kestrel's ~28 MB default as a DoS lever.
        [RequestSizeLimit(2 * 1024 * 1024)]
        public IActionResult SaveUserSpoilerBlur(string userId, [FromBody] UserSpoilerBlur userConfiguration)
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

            if (userConfiguration == null)
            {
                return BadRequest(new { success = false, message = "Invalid Spoiler Guard payload." });
            }

            // Reject oversized payloads rather than silently truncating — dropping
            // entries would confuse a legitimate large list, and over-cap is buggy or hostile.
            if (userConfiguration.Series.Count > MaxSpoilerEntriesPerDict
                || userConfiguration.Movies.Count > MaxSpoilerEntriesPerDict
                || userConfiguration.Collections.Count > MaxSpoilerEntriesPerDict
                || userConfiguration.PendingTmdb.Count > MaxSpoilerEntriesPerDict)
            {
                _logger.LogWarning($"Rejecting oversized Spoiler Guard payload for {ResolveUserDisplay(authorizedUserId)} (series={userConfiguration.Series.Count}, movies={userConfiguration.Movies.Count}, collections={userConfiguration.Collections.Count}, pending={userConfiguration.PendingTmdb.Count}; cap {MaxSpoilerEntriesPerDict}).");
                return StatusCode(413, new { success = false, message = $"Spoiler Guard list exceeds the maximum of {MaxSpoilerEntriesPerDict} entries per category." });
            }
            if (userConfiguration.Prefs == null
                || !PersistedPayloadPolicy.Validate(userConfiguration.Prefs).IsValid
                || userConfiguration.OverridesRevision < 0)
            {
                return BadRequest(new { success = false, message = "Invalid Spoiler Guard state." });
            }

            // Never retain or mutate MVC's bound object graph. This full-state
            // compatibility endpoint deliberately replaces the dictionaries,
            // but its preference subsection still participates in the same CAS
            // protocol as self and elevated preference-only writers.
            var candidate = ClonePersisted(userConfiguration);
            var submittedOverrides = SnapshotOverridesForCompatibility(candidate);
            PersistedPayloadPolicy.NormalizeLegacyRuntimeState(submittedOverrides);
            var submittedOverrideValidation = PersistedPayloadPolicy.Validate(submittedOverrides);
            if (submittedOverrideValidation.Status == PersistedPayloadStatus.TooLarge)
            {
                return StatusCode(StatusCodes.Status413PayloadTooLarge, new
                {
                    success = false,
                    message = "The Spoiler Guard override payload exceeds the supported limit."
                });
            }
            if (!submittedOverrideValidation.IsValid)
            {
                return BadRequest(new
                {
                    success = false,
                    message = "Invalid Spoiler Guard override payload."
                });
            }
            ApplyOverrides(
                candidate,
                PersistedPayloadPolicy.CloneValidated(submittedOverrides));

            // Snapshot under the exact write lock below; a pre-lock read would
            // race pending changes and could unregister a freshly added gate.
            var priorPending = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            try
            {
                lock (_userConfigurationManager.GetUserFileLock(authorizedUserId, SpoilerFileName))
                {
                    // Pre-write strict read so a corrupt existing file enters recovery
                    // instead of being silently overwritten (same as hidden-content).
                    try
                    {
                        var current = _userConfigurationManager.GetUserConfigurationStrict<UserSpoilerBlur>(
                            authorizedUserId, SpoilerFileName);
                        var currentPrefs = current.Prefs ?? new SpoilerBlurUserPrefs();
                        if (!PersistedPayloadPolicy.Validate(currentPrefs).IsValid)
                        {
                            throw new InvalidDataException("Spoiler Guard preferences are invalid.");
                        }
                        if (current.OverridesRevision < 0)
                        {
                            throw new InvalidDataException("Spoiler Guard override revision is invalid.");
                        }
                        var currentOverrides =
                            SnapshotOverridesForCompatibility(current);
                        var currentHadLegacyMetadata =
                            PersistedPayloadPolicy.NormalizeLegacyRuntimeState(
                                currentOverrides);
                        if (!PersistedPayloadPolicy.Validate(currentOverrides).IsValid)
                        {
                            throw new InvalidDataException(
                                "Spoiler Guard override state is invalid.");
                        }
                        currentOverrides = PersistedPayloadPolicy.CloneValidated(
                            currentOverrides);
                        if (candidate.Prefs.Revision != currentPrefs.Revision)
                        {
                            return Conflict(new
                            {
                                success = false,
                                conflict = true,
                                message = "Spoiler Guard preferences changed. Reload and retry.",
                                prefs = currentPrefs
                            });
                        }
                        if (candidate.OverridesRevision != current.OverridesRevision)
                        {
                            return Conflict(new
                            {
                                success = false,
                                conflict = true,
                                message = "Spoiler Guard overrides changed. Reload and retry.",
                                prefs = currentPrefs,
                                overrides = currentOverrides
                            });
                        }

                        // Older full-state clients know nothing about the
                        // override resource's forward-compatible metadata. An
                        // omitted/empty value must not erase fields written by
                        // the elevated resource.
                        if ((candidate.OverridesExtensionData?.Count ?? 0) == 0
                            && (current.OverridesExtensionData?.Count ?? 0) > 0)
                        {
                            candidate.OverridesExtensionData = ClonePersisted(
                                current.OverridesExtensionData!);
                        }

                        candidate.Prefs.Revision = string.Equals(
                            PreferenceContentHash(currentPrefs),
                            PreferenceContentHash(candidate.Prefs),
                            StringComparison.Ordinal)
                            ? currentPrefs.Revision
                            : checked(currentPrefs.Revision + 1);
                        var candidateOverrides = SnapshotOverridesForCompatibility(candidate);
                        var finalOverrideValidation = PersistedPayloadPolicy.Validate(
                            candidateOverrides);
                        if (!finalOverrideValidation.IsValid)
                        {
                            throw new InvalidDataException(
                                "Spoiler Guard override state is invalid.");
                        }
                        candidateOverrides = PersistedPayloadPolicy.CloneValidated(
                            candidateOverrides);
                        candidate.OverridesRevision = current.OverridesRevision;
                        if (currentHadLegacyMetadata
                            || !string.Equals(
                                PreferenceContentHash(currentOverrides),
                                PreferenceContentHash(candidateOverrides),
                                StringComparison.Ordinal))
                        {
                            SpoilerGuardOverridesRevision.Advance(candidate);
                        }
                        candidateOverrides.Revision = candidate.OverridesRevision;
                        ApplyOverrides(candidate, candidateOverrides);
                        if (!PersistedPayloadPolicy.Validate(candidate).IsValid)
                        {
                            throw new InvalidDataException(
                                "Spoiler Guard state is invalid.");
                        }

                        priorPending = new HashSet<string>(
                            current.PendingTmdb.Keys,
                            StringComparer.OrdinalIgnoreCase);
                    }
                    catch (Exception strictEx) when (IsCorruptStoreException(strictEx))
                    {
                        return CorruptStore(authorizedUserId, strictEx);
                    }
                    catch (IOException ioEx)
                    {
                        _logger.LogWarning($"{SpoilerFileName} temporarily unreadable for {ResolveUserDisplay(authorizedUserId)}: {ioEx.Message}");
                        return StatusCode(500, new { success = false, message = "Spoiler Guard store is temporarily unavailable. Please retry." });
                    }

                    _userConfigurationManager.SaveUserConfiguration(authorizedUserId, SpoilerFileName, candidate);
                }

                // Drop the cross-request state cache so the image/strip filters
                // re-read the new state immediately (F7).
                SpoilerUserResolver.InvalidateUser(authorizedUserId);

                // Reconcile the promoter's fast-path gate with the new PendingTmdb
                // set: register keys the payload added, unregister keys it removed.
                // Registration is idempotent, so re-registering survivors is harmless.
                ReconcilePendingGate(
                    authorizedUserId,
                    priorPending,
                    candidate.PendingTmdb.Keys);

                if (!LogCrossUserFileMutationIfNeeded(
                        authorizedUserId,
                        SpoilerFileName,
                        $"prefsRevision={candidate.Prefs.Revision.ToString(CultureInfo.InvariantCulture)}," +
                        $"overridesRevision={candidate.OverridesRevision.ToString(CultureInfo.InvariantCulture)}",
                        "saved"))
                {
                    _logger.LogInformation(
                        $"Saved Spoiler Guard state for {ResolveUserDisplay(authorizedUserId)} " +
                        $"to {SpoilerFileName}");
                }
                return Ok(new
                {
                    success = true,
                    file = SpoilerFileName,
                    prefs = candidate.Prefs,
                    overrides = SnapshotOverridesForCompatibility(candidate)
                });
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to save Spoiler Guard state for {ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save Spoiler Guard state." });
            }
        }

        // ─── Corruption health ───────────────────────────────────────────────────
        // Diagnostic surface so an admin (or a user, for their own events) can check
        // whether Spoiler Guard preferences were reset after a corrupt-file backup.
        // Per-user — each user sees only their OWN events; admins see all.

        [HttpGet("spoiler-blur/health")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetSpoilerBlurHealth()
        {
            // Role-first admin check so Administrator API keys (role claim, no user
            // id) work — same pattern as IsAdminUser() everywhere else.
            var isAdmin = IsAdminUser();
            var userId = UserHelper.GetCurrentUserId(User);
            if (!isAdmin && (userId == null || userId == Guid.Empty)) return Forbid();
            var userKey = userId.HasValue && userId.Value != Guid.Empty
                ? userId.Value.ToString("N")
                : null; // admin API key: no user identity, sees all events

            var log = SpoilerUserResolver.GetCorruptionLog();
            var events = new List<object>();
            foreach (var kvp in log)
            {
                if (!isAdmin && kvp.Key != userKey) continue; // non-admin: only own
                events.Add(new
                {
                    userId = kvp.Key,
                    userDisplay = kvp.Value.UserDisplay,
                    at = kvp.Value.At.ToString("o", CultureInfo.InvariantCulture),
                    reason = kvp.Value.Reason,
                });
            }
            return Ok(new
            {
                healthy = events.Count == 0,
                corruptionEvents = events,
            });
        }

        // Admin acks any corruption event (clears the banner); users ack their own.
        [HttpDelete("spoiler-blur/health/{targetUserId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult AckSpoilerBlurCorruption(string targetUserId)
        {
            var isAdmin = IsAdminUser();
            var userId = UserHelper.GetCurrentUserId(User);
            if (!isAdmin && (userId == null || userId == Guid.Empty)) return Forbid();
            var userKey = userId.HasValue && userId.Value != Guid.Empty
                ? userId.Value.ToString("N")
                : null;

            if (!Guid.TryParse(targetUserId, out var tGuid)
                && !Guid.TryParseExact(targetUserId, "N", out tGuid))
            {
                return BadRequest(new { success = false, message = "Invalid userId." });
            }
            var tKey = tGuid.ToString("N");
            if (!isAdmin && tKey != userKey) return Forbid();
            SpoilerUserResolver.ClearCorruption(tKey);
            return Ok(new { success = true });
        }

        // ─── Current-user strict reads (series list + prefs) ─────────────────────

        [HttpGet("spoiler-blur/series")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetSpoilerBlurSeries()
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();
            var userKey = userId.Value.ToString("N");

            try
            {
                lock (_userConfigurationManager.GetUserFileLock(userKey, SpoilerFileName))
                {
                    // Distinguish a true first-run Missing state from every
                    // persistence fault; File.Exists-style probes are not proof
                    // that configured defaults are safe to assume.
                    var classified = _userConfigurationManager.ReadUserConfiguration<UserSpoilerBlur>(
                        userKey,
                        SpoilerFileName);
                    var status = RequireSpoilerMutationRead(userKey, classified);
                    if (status == UserConfigReadStatus.Missing
                        && _configProvider.ConfigurationOrNull == null)
                    {
                        return SpoilerConfigurationUnavailable();
                    }

                    var state = status == UserConfigReadStatus.Missing
                        ? classified.Value!
                        : _userConfigurationManager.GetUserConfigurationStrict<UserSpoilerBlur>(
                            userKey,
                            SpoilerFileName);
                    return Ok(state);
                }
            }
            catch (Exception strictEx) when (IsCorruptStoreException(strictEx))
            {
                return CorruptStore(userKey, strictEx);
            }
            catch (IOException)
            {
                return StatusCode(StatusCodes.Status503ServiceUnavailable, new
                {
                    success = false,
                    message = "Spoiler Guard state is temporarily unavailable."
                });
            }
        }

        // Per-user override toggles for the admin's strip categories. Nullable bools
        // where null means "inherit admin policy"; SkipDisableConfirm is a permanent
        // flag replacing the per-session "Don't ask for 15 minutes" snooze.
        [HttpGet("spoiler-blur/user-prefs")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetSpoilerBlurUserPrefs()
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();
            var userKey = userId.Value.ToString("N");

            try
            {
                lock (_userConfigurationManager.GetUserFileLock(userKey, SpoilerFileName))
                {
                    var classified = _userConfigurationManager.ReadUserConfiguration<UserSpoilerBlur>(
                        userKey,
                        SpoilerFileName);
                    var status = RequireSpoilerMutationRead(userKey, classified);
                    if (status == UserConfigReadStatus.Missing
                        && _configProvider.ConfigurationOrNull == null)
                    {
                        return SpoilerConfigurationUnavailable();
                    }

                    var state = status == UserConfigReadStatus.Missing
                        ? classified.Value!
                        : _userConfigurationManager.GetUserConfigurationStrict<UserSpoilerBlur>(
                            userKey,
                            SpoilerFileName);
                    if (!PersistedPayloadPolicy
                        .ValidateMutationSource(state).IsValid)
                    {
                        throw new InvalidDataException(
                            "Spoiler Guard state is invalid.");
                    }
                    var prefs = ClonePreference(
                        state.Prefs ?? new SpoilerBlurUserPrefs());
                    if (!PersistedPayloadPolicy.Validate(prefs).IsValid)
                    {
                        throw new InvalidDataException(
                            "Spoiler Guard preferences are invalid.");
                    }
                    return Ok(prefs);
                }
            }
            catch (Exception strictEx) when (IsCorruptStoreException(strictEx))
            {
                return CorruptStore(userKey, strictEx);
            }
            catch (IOException)
            {
                return StatusCode(StatusCodes.Status503ServiceUnavailable, new
                {
                    success = false,
                    message = "Spoiler Guard preferences are temporarily unavailable."
                });
            }
        }

        [HttpPost("spoiler-blur/user-prefs")]
        [Authorize]
        [Produces("application/json")]
        [Consumes("application/json")]
        [RequestSizeLimit(8 * 1024)]
        public IActionResult SetSpoilerBlurUserPrefs([FromBody] SpoilerBlurUserPrefs? body)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();
            if (body == null || !PersistedPayloadPolicy.Validate(body).IsValid)
            {
                return BadRequest(new { success = false, message = "Invalid Spoiler Guard preference payload." });
            }

            var userKey = userId.Value.ToString("N");
            var candidate = ClonePreference(body);
            try
            {
                var changed = false;
                SpoilerBlurUserPrefs? acknowledged = null;
                _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey, SpoilerFileName, state =>
                    {
                        var current = state.Prefs ?? new SpoilerBlurUserPrefs();
                        if (!PersistedPayloadPolicy.Validate(current).IsValid)
                        {
                            throw new InvalidDataException("Spoiler Guard preferences are invalid.");
                        }
                        if (candidate.Revision != current.Revision)
                        {
                            throw new PreferenceRevisionConflictException(ClonePreference(current));
                        }
                        if (string.Equals(
                            PreferenceContentHash(current),
                            PreferenceContentHash(candidate),
                            StringComparison.Ordinal))
                        {
                            acknowledged = ClonePreference(current);
                            return 0;
                        }

                        candidate.Revision = checked(current.Revision + 1);
                        state.Prefs = candidate;
                        var size = PersistedPayloadPolicy.ValidateSerializedSize(
                            state,
                            PersistedPayloadPolicy.AbsolutePersistedBytes);
                        if (!size.IsValid) throw new PreferencePayloadTooLargeException();
                        changed = true;
                        acknowledged = ClonePreference(candidate);
                        return 1;
                    });
                if (changed) SpoilerUserResolver.InvalidateUser(userKey);
                return Ok(new { success = true, prefs = acknowledged ?? candidate });
            }
            catch (PreferenceRevisionConflictException conflict)
            {
                return Conflict(new
                {
                    success = false,
                    conflict = true,
                    message = "Spoiler Guard preferences changed. Reload and retry.",
                    prefs = conflict.Current
                });
            }
            catch (PreferencePayloadTooLargeException)
            {
                return StatusCode(StatusCodes.Status413PayloadTooLarge, new
                {
                    success = false,
                    message = "The resulting Spoiler Guard state exceeds the supported limit."
                });
            }
            catch (Exception strictEx) when (IsCorruptStoreException(strictEx))
            {
                return CorruptStore(userKey, strictEx);
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to save Spoiler Guard user prefs for {ResolveUserDisplay(userKey)}: {ex.GetType().Name}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save user prefs." });
            }
        }

        private sealed class PreferenceRevisionConflictException : Exception
        {
            public PreferenceRevisionConflictException(SpoilerBlurUserPrefs current)
            {
                Current = current;
            }

            public SpoilerBlurUserPrefs Current { get; }
        }

        private sealed class PreferencePayloadTooLargeException : Exception
        {
        }

        private IActionResult SpoilerOverrideCapacityExceeded(string category)
            => StatusCode(StatusCodes.Status429TooManyRequests, new
            {
                success = false,
                code = "spoiler_override_cap_exceeded",
                category,
                maximum = SpoilerGuardOverrideCapacity.MaximumEntriesPerDictionary,
                message =
                    $"Spoiler Guard already has the maximum of " +
                    $"{SpoilerGuardOverrideCapacity.MaximumEntriesPerDictionary} {category} entries. " +
                    "Remove an entry before adding another."
            });

        // ─── Revisioned preference-subsection administration ─────────────────
        // Prefs and the four opt-in dictionaries are separate revisioned
        // resources. Editing either one cannot replace or conflict with the other.

        [HttpGet("admin/user-settings/{targetUserId}/spoiler-guard-prefs.json")]
        [HttpGet("admin/user-settings/{targetUserId}/spoiler-guard-prefs.json/evidence")]
        [Authorize(Policy = Policies.RequiresElevation)]
        [Produces("application/json")]
        public IActionResult GetTargetSpoilerGuardPreferences(string targetUserId)
        {
            var targetError = ResolveExistingTargetUser(
                targetUserId,
                out var targetKey,
                out var targetUser);
            if (targetError != null) return targetError;

            try
            {
                lock (_userConfigurationManager.GetUserFileLock(targetKey, SpoilerFileName))
                {
                    var classified = _userConfigurationManager.ReadUserConfiguration<UserSpoilerBlur>(
                        targetKey,
                        SpoilerFileName);
                    if (!classified.HasUsableValue || classified.Value == null)
                    {
                        return StatusCode(StatusCodes.Status503ServiceUnavailable, new
                        {
                            success = false,
                            message = "Spoiler Guard preferences are corrupt or temporarily unavailable."
                        });
                    }
                    if (classified.Status == UserConfigReadStatus.Missing
                        && _configProvider.ConfigurationOrNull == null)
                    {
                        return SpoilerConfigurationUnavailable();
                    }

                    // The typed read is side-effect-free and already owns the
                    // complete bounded snapshot. A GET must never invoke the
                    // strict mutation reader, which quarantines corrupt bytes.
                    var state = classified.Value;
                    // Prefs share a durable file with the override resource. Do
                    // not acknowledge a partial view of a malformed/over-cap
                    // file: an admin could otherwise rewrite Prefs while
                    // silently carrying invalid override state forward.
                    if (!PersistedPayloadPolicy.ValidateMutationSource(state).IsValid)
                    {
                        throw new InvalidDataException(
                            "Spoiler Guard state is invalid.");
                    }
                    var prefs = ClonePreference(
                        state.Prefs ?? new SpoilerBlurUserPrefs());
                    if (!PersistedPayloadPolicy.Validate(prefs).IsValid)
                    {
                        throw new InvalidDataException("Spoiler Guard preferences are invalid.");
                    }

                    return Ok(PreferenceResponse(
                        SpoilerPrefsResource,
                        targetKey,
                        targetUser.Username,
                        prefs,
                        success: true));
                }
            }
            catch (Exception ex) when (IsCorruptStoreException(ex)
                                      || ex is IOException
                                      || ex is UnauthorizedAccessException)
            {
                _logger.LogWarning(
                    $"Admin Spoiler Guard preference read failed for target {ResolveUserDisplay(targetKey)} " +
                    $"(exception={ex.GetType().Name}).");
                return StatusCode(StatusCodes.Status503ServiceUnavailable, new
                {
                    success = false,
                    message = "Spoiler Guard preferences are corrupt or temporarily unavailable."
                });
            }
        }

        [HttpPost("admin/user-settings/{targetUserId}/spoiler-guard-prefs.json")]
        [Authorize(Policy = Policies.RequiresElevation)]
        [Produces("application/json")]
        [Consumes("application/json")]
        [RequestSizeLimit(8 * 1024)]
        public IActionResult SaveTargetSpoilerGuardPreferences(
            string targetUserId,
            [FromBody] SpoilerBlurUserPrefs? body)
        {
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
                    message = "Invalid Spoiler Guard preference payload."
                });
            }
            var candidate = ClonePreference(body);

            if (!TryParsePreferenceIfMatch(Request, out var expectedRevision))
            {
                return StatusCode(StatusCodes.Status428PreconditionRequired, new
                {
                    success = false,
                    message = "Saving Spoiler Guard preferences requires one strong quoted If-Match revision from the latest GET."
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
                TargetPreferenceResponse<SpoilerBlurUserPrefs> response;
                var changed = false;
                lock (_userConfigurationManager.GetUserFileLock(targetKey, SpoilerFileName))
                {
                    var classified = _userConfigurationManager.ReadUserConfiguration<UserSpoilerBlur>(
                        targetKey,
                        SpoilerFileName);
                    var status = RequireSpoilerMutationRead(targetKey, classified);
                    if (status == UserConfigReadStatus.Missing
                        && _configProvider.ConfigurationOrNull == null)
                    {
                        return SpoilerConfigurationUnavailable();
                    }

                    var state = status == UserConfigReadStatus.Missing
                        ? classified.Value!
                        : _userConfigurationManager.GetUserConfigurationStrict<UserSpoilerBlur>(
                            targetKey,
                            SpoilerFileName);
                    // Validate a detached compatibility view of the complete
                    // co-resident override resource before conflict, no-op, or
                    // success acknowledgement. Preference-only writes preserve
                    // legitimate legacy server names in the raw graph; override
                    // resource mutations are the paths that repair them.
                    if (!PersistedPayloadPolicy
                        .ValidateMutationSource(state).IsValid)
                    {
                        throw new InvalidDataException(
                            "Spoiler Guard state is invalid.");
                    }
                    var current = state.Prefs ?? new SpoilerBlurUserPrefs();
                    if (!PersistedPayloadPolicy.Validate(current).IsValid)
                    {
                        throw new InvalidDataException("Spoiler Guard preferences are invalid.");
                    }
                    if (current.Revision != expectedRevision)
                    {
                        response = PreferenceResponse(
                            SpoilerPrefsResource,
                            targetKey,
                            targetUser.Username,
                            current,
                            success: false,
                            conflict: true,
                            message: "Spoiler Guard preferences changed. Rebase on the returned state.");
                        return Conflict(response);
                    }
                    // Admin-target preference controls edit only schema-owned
                    // fields. Preserve the exact server-held opaque members so
                    // native browser JSON numbers cannot corrupt future data.
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
                            SpoilerPrefsResource,
                            targetKey,
                            targetUser.Username,
                            current,
                            success: true));
                    }

                    candidate.Revision = checked(current.Revision + 1);
                    state.Prefs = candidate;
                    var fullValidation = PersistedPayloadPolicy
                        .ValidateMutationSource(state);
                    if (fullValidation.Status == PersistedPayloadStatus.TooLarge)
                    {
                        return StatusCode(StatusCodes.Status413PayloadTooLarge, new
                        {
                            success = false,
                            message = "The resulting Spoiler Guard state exceeds the supported limit."
                        });
                    }
                    if (!fullValidation.IsValid)
                    {
                        throw new InvalidDataException(
                            "Spoiler Guard state is invalid.");
                    }

                    _userConfigurationManager.SaveUserConfiguration(
                        targetKey,
                        SpoilerFileName,
                        state);
                    changed = true;
                    response = PreferenceResponse(
                        SpoilerPrefsResource,
                        targetKey,
                        targetUser.Username,
                        candidate,
                        success: true);
                }

                if (changed) SpoilerUserResolver.InvalidateUser(targetKey);
                var actor = UserHelper.GetCurrentUserId(User)?.ToString("N") ?? "elevated-principal";
                _logger.LogInformation(
                    $"Admin {ResolveUserDisplay(actor)} updated Spoiler Guard preferences for " +
                    $"{ResolveUserDisplay(targetKey)} at revision {response.Revision}.");
                return Ok(response);
            }
            catch (Exception ex) when (IsCorruptStoreException(ex)
                                      || ex is IOException
                                      || ex is UnauthorizedAccessException
                                      || ex is OverflowException)
            {
                _logger.LogWarning(
                    $"Admin Spoiler Guard preference write failed for target {ResolveUserDisplay(targetKey)} " +
                    $"(exception={ex.GetType().Name}).");
                return StatusCode(StatusCodes.Status503ServiceUnavailable, new
                {
                    success = false,
                    message = "Spoiler Guard preferences are unavailable; no write was acknowledged."
                });
            }
        }

        // ─── Revisioned persistent-override administration ───────────────────

        [HttpGet("admin/user-settings/{targetUserId}/spoiler-guard-overrides.json")]
        [HttpGet("admin/user-settings/{targetUserId}/spoiler-guard-overrides.json/evidence")]
        [Authorize(Policy = Policies.RequiresElevation)]
        [Produces("application/json")]
        public IActionResult GetTargetSpoilerGuardOverrides(string targetUserId)
        {
            var targetError = ResolveExistingTargetUser(
                targetUserId,
                out var targetKey,
                out var targetUser);
            if (targetError != null) return targetError;

            try
            {
                lock (_userConfigurationManager.GetUserFileLock(targetKey, SpoilerFileName))
                {
                    var classified = _userConfigurationManager.ReadUserConfiguration<UserSpoilerBlur>(
                        targetKey,
                        SpoilerFileName);
                    if (!classified.HasUsableValue || classified.Value == null)
                    {
                        return StatusCode(StatusCodes.Status503ServiceUnavailable, new
                        {
                            success = false,
                            message = "Spoiler Guard overrides are corrupt or temporarily unavailable."
                        });
                    }
                    if (classified.Status == UserConfigReadStatus.Missing
                        && _configProvider.ConfigurationOrNull == null)
                    {
                        return SpoilerConfigurationUnavailable();
                    }

                    var state = classified.Value;
                    // Overrides and preferences share one durable file. Refuse
                    // to expose an apparently valid override snapshot while
                    // carrying malformed preferences beside it: a later
                    // override edit must never legitimize those bytes.
                    if (!PersistedPayloadPolicy.ValidateMutationSource(state).IsValid)
                    {
                        throw new InvalidDataException("Spoiler Guard state is invalid.");
                    }
                    var overrides = SnapshotOverrides(state);
                    return Ok(PreferenceResponse(
                        SpoilerOverridesResource,
                        targetKey,
                        targetUser.Username,
                        overrides,
                        success: true));
                }
            }
            catch (Exception ex) when (IsCorruptStoreException(ex)
                                      || ex is IOException
                                      || ex is UnauthorizedAccessException)
            {
                _logger.LogWarning(
                    $"Admin Spoiler Guard override read failed for target {ResolveUserDisplay(targetKey)} " +
                    $"(exception={ex.GetType().Name}).");
                return StatusCode(StatusCodes.Status503ServiceUnavailable, new
                {
                    success = false,
                    message = "Spoiler Guard overrides are corrupt or temporarily unavailable."
                });
            }
        }

        [HttpPost("admin/user-settings/{targetUserId}/spoiler-guard-overrides.json")]
        [Authorize(Policy = Policies.RequiresElevation)]
        [Produces("application/json")]
        [Consumes("application/json")]
        [RequestSizeLimit(PersistedPayloadPolicy.SpoilerOverridesRequestBytes)]
        public IActionResult SaveTargetSpoilerGuardOverrides(
            string targetUserId,
            [FromBody] SpoilerGuardOverrides? body)
        {
            var targetError = ResolveExistingTargetUser(
                targetUserId,
                out var targetKey,
                out var targetUser);
            if (targetError != null) return targetError;

            var bodyValidation = PersistedPayloadPolicy.Validate(body);
            if (bodyValidation.Status == PersistedPayloadStatus.TooLarge)
            {
                return StatusCode(StatusCodes.Status413PayloadTooLarge, new
                {
                    success = false,
                    message = "The Spoiler Guard override payload exceeds the supported limit."
                });
            }
            if (!bodyValidation.IsValid || body == null)
            {
                return BadRequest(new
                {
                    success = false,
                    message = "Invalid Spoiler Guard override payload."
                });
            }
            var candidate = PersistedPayloadPolicy.CloneValidated(body);

            if (!TryParsePreferenceIfMatch(Request, out var expectedRevision))
            {
                return StatusCode(StatusCodes.Status428PreconditionRequired, new
                {
                    success = false,
                    message = "Saving Spoiler Guard overrides requires one strong quoted If-Match revision from the latest GET."
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
                var changed = false;
                HashSet<string>? priorPending = null;
                SpoilerGuardOverrides? acknowledged = null;
                var result = _userConfigurationManager
                    .TransactUserConfiguration<UserSpoilerBlur, IActionResult>(
                        targetKey,
                        SpoilerFileName,
                        state =>
                        {
                            // The transaction owns the exact store lock before
                            // existence is classified, preventing a missing-file
                            // default from racing another writer.
                            var classified = _userConfigurationManager
                                .ReadUserConfiguration<UserSpoilerBlur>(
                                    targetKey,
                                    SpoilerFileName);
                            var status = RequireSpoilerMutationRead(targetKey, classified);
                            if (status == UserConfigReadStatus.Missing
                                && _configProvider.ConfigurationOrNull == null)
                            {
                                return SpoilerConfigurationUnavailable();
                            }

                            // Validate the complete co-resident preference
                            // resource before conflict, no-op, or success
                            // acknowledgement. This keeps override-only writes
                            // fail-closed and byte-preserving when Prefs is
                            // malformed.
                            if (!PersistedPayloadPolicy
                                .ValidateMutationSource(state).IsValid)
                            {
                                throw new InvalidDataException(
                                    "Spoiler Guard state is invalid.");
                            }
                            var current = SnapshotOverrides(state);
                            if (current.Revision != expectedRevision)
                            {
                                return Conflict(PreferenceResponse(
                                    SpoilerOverridesResource,
                                    targetKey,
                                    targetUser.Username,
                                    current,
                                    success: false,
                                    conflict: true,
                                    message: "Spoiler Guard overrides changed. Rebase on the returned state."));
                            }
                            PreserveAdminTargetOverrideExtensions(
                                current,
                                candidate);
                            if (string.Equals(
                                PreferenceContentHash(current),
                                PreferenceContentHash(candidate),
                                StringComparison.Ordinal))
                            {
                                acknowledged = current;
                                return Ok(PreferenceResponse(
                                    SpoilerOverridesResource,
                                    targetKey,
                                    targetUser.Username,
                                    current,
                                    success: true));
                            }

                            var trustedCandidate =
                                PersistedPayloadPolicy.CloneValidated(candidate);
                            var targetValidation = ValidateChangedTargetLocalOverrides(
                                current,
                                trustedCandidate,
                                targetUser);
                            if (targetValidation != null)
                            {
                                return targetValidation;
                            }

                            // Keep the post-validation equality check as an exact-ACK
                            // invariant: validation is deliberately non-mutating.
                            trustedCandidate.Revision = current.Revision;
                            if (string.Equals(
                                PreferenceContentHash(current),
                                PreferenceContentHash(trustedCandidate),
                                StringComparison.Ordinal))
                            {
                                acknowledged = current;
                                return Ok(PreferenceResponse(
                                    SpoilerOverridesResource,
                                    targetKey,
                                    targetUser.Username,
                                    current,
                                    success: true));
                            }

                            trustedCandidate.Revision = checked(current.Revision + 1);
                            var candidateValidation = PersistedPayloadPolicy.Validate(
                                trustedCandidate);
                            if (candidateValidation.Status == PersistedPayloadStatus.TooLarge)
                            {
                                return StatusCode(StatusCodes.Status413PayloadTooLarge, new
                                {
                                    success = false,
                                    message = "The Spoiler Guard override payload exceeds the supported limit."
                                });
                            }
                            if (!candidateValidation.IsValid)
                            {
                                throw new InvalidDataException(
                                    "Spoiler Guard overrides became invalid during the write.");
                            }

                            priorPending = new HashSet<string>(
                                state.PendingTmdb.Keys,
                                StringComparer.OrdinalIgnoreCase);
                            ApplyOverrides(state, trustedCandidate);
                            var fullValidation =
                                PersistedPayloadPolicy.Validate(state);
                            if (fullValidation.Status ==
                                PersistedPayloadStatus.TooLarge)
                            {
                                return StatusCode(StatusCodes.Status413PayloadTooLarge, new
                                {
                                    success = false,
                                    message = "The resulting Spoiler Guard state exceeds the supported limit."
                                });
                            }
                            if (!fullValidation.IsValid)
                            {
                                throw new InvalidDataException(
                                    "Spoiler Guard state is invalid.");
                            }

                            _userConfigurationManager.SaveUserConfiguration(
                                targetKey,
                                SpoilerFileName,
                                state);
                            changed = true;
                            acknowledged = trustedCandidate;
                            return Ok(PreferenceResponse(
                                SpoilerOverridesResource,
                                targetKey,
                                targetUser.Username,
                                trustedCandidate,
                                success: true));
                        });

                if (changed && acknowledged != null)
                {
                    var actor = UserHelper.GetCurrentUserId(User)?.ToString("N")
                        ?? "elevated-principal";
                    try
                    {
                        _logger.LogInformation(
                            $"Admin {ResolveUserDisplay(actor)} updated Spoiler Guard overrides for " +
                            $"{ResolveUserDisplay(targetKey)} at revision {acknowledged.Revision}.");
                    }
                    catch
                    {
                        // Persistence is already committed. Logging must never
                        // turn an acknowledged write into a misleading failure.
                    }

                    try
                    {
                        SpoilerUserResolver.InvalidateUser(targetKey);
                    }
                    catch (Exception ex)
                    {
                        try
                        {
                            _logger.LogWarning(
                                $"Committed Spoiler Guard override revision {acknowledged.Revision} for " +
                                $"{ResolveUserDisplay(targetKey)}, but cache invalidation failed " +
                                $"(exception={ex.GetType().Name}).");
                        }
                        catch
                        {
                            // Best effort after a durable commit.
                        }
                    }

                    try
                    {
                        ReconcilePendingGate(
                            targetKey,
                            priorPending ?? new HashSet<string>(StringComparer.OrdinalIgnoreCase),
                            acknowledged.PendingTmdb.Keys);
                    }
                    catch (Exception ex)
                    {
                        try
                        {
                            _logger.LogWarning(
                                $"Committed Spoiler Guard override revision {acknowledged.Revision} for " +
                                $"{ResolveUserDisplay(targetKey)}, but pending-gate reconciliation failed " +
                                $"(exception={ex.GetType().Name}).");
                        }
                        catch
                        {
                            // Best effort after a durable commit.
                        }
                    }
                }

                return result;
            }
            catch (Exception ex) when (IsCorruptStoreException(ex)
                                      || ex is IOException
                                      || ex is UnauthorizedAccessException
                                      || ex is OverflowException)
            {
                _logger.LogWarning(
                    $"Admin Spoiler Guard override write failed for target {ResolveUserDisplay(targetKey)} " +
                    $"(exception={ex.GetType().Name}).");
                return StatusCode(StatusCodes.Status503ServiceUnavailable, new
                {
                    success = false,
                    message = "Spoiler Guard overrides are unavailable; no write was acknowledged."
                });
            }
        }

        // ─── Per-series opt-in ───────────────────────────────────────────────────

        [HttpPost("spoiler-blur/series/{seriesId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult EnableSpoilerBlurForSeries(string seriesId)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();

            if (!Guid.TryParse(seriesId, out var seriesGuid) && !Guid.TryParseExact(seriesId, "N", out seriesGuid))
            {
                return BadRequest(new { success = false, message = "Invalid seriesId." });
            }

            // Resolve AS THE CALLING USER: GetItemById returns null when filtered out
            // by library access — 404 so we don't leak existence. Any lookup throw is
            // also treated as 404 (arbitrary GUIDs hitting a partially-stored row make
            // Jellyfin's deserializer throw).
            var jUser = _userManager.GetUserById(userId.Value);
            if (jUser == null) return Forbid();
            BaseItem? item = null;
            try
            {
                item = _libraryManager.GetItemById<BaseItem>(seriesGuid, jUser);
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"GetItemById<BaseItem> threw for {seriesGuid}: {ex.GetType().Name}: {ex.Message}");
            }
            if (item is not Series series)
            {
                return NotFound(new { success = false, message = "Series not found or not accessible." });
            }

            var key = seriesGuid.ToString("N");
            var userKey = userId.Value.ToString("N");
            try
            {
                var result = _itemActionOwner.Configure(
                    new SpoilerGuardActorProjection(userId.Value),
                    SpoilerGuardItemProjection.CurrentAccessible(
                        seriesGuid,
                        SpoilerGuardItemKind.Series,
                        series.Name),
                    new SpoilerGuardItemConfiguration(enabled: true));
                if (result.Outcome == SpoilerGuardItemActionOutcome.CapacityExceeded)
                {
                    _logger.LogWarning(
                        $"Spoiler Guard series cap reached for {ResolveUserDisplay(userKey)}; " +
                        $"rejecting new series {key}.");
                    return SpoilerOverrideCapacityExceeded("series");
                }
                _logger.LogInformation($"Spoiler Guard enabled for series '{series.Name}' ({key}) by {ResolveUserDisplay(userKey)}");
                return Ok(new { success = true, seriesId = key, name = series.Name });
            }
            catch (Exception strictEx) when (IsCorruptStoreException(strictEx))
            {
                return CorruptStore(userKey, strictEx);
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to enable spoiler blur for series {key}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save spoiler blur state." });
            }
        }

        [HttpDelete("spoiler-blur/series/{seriesId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult DisableSpoilerBlurForSeries(string seriesId)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();

            if (!Guid.TryParse(seriesId, out var seriesGuid) && !Guid.TryParseExact(seriesId, "N", out seriesGuid))
            {
                return BadRequest(new { success = false, message = "Invalid seriesId." });
            }

            var key = seriesGuid.ToString("N");
            var userKey = userId.Value.ToString("N");
            try
            {
                var result = _itemActionOwner.Configure(
                    new SpoilerGuardActorProjection(userId.Value),
                    SpoilerGuardItemProjection.ActorOwnedRemoval(
                        seriesGuid,
                        SpoilerGuardItemKind.Series),
                    new SpoilerGuardItemConfiguration(enabled: false));
                var removed = result.Removed;
                if (!removed)
                {
                    _logger.LogInformation($"Spoiler Guard disable was a no-op for series {key} by {ResolveUserDisplay(userKey)} — series was not in the user's spoiler-blur list.");
                    return Ok(new { success = true, seriesId = key, removed = false });
                }
                _logger.LogInformation($"Spoiler Guard disabled for series {key} by {ResolveUserDisplay(userKey)}");
                return Ok(new { success = true, seriesId = key, removed = true });
            }
            catch (Exception strictEx) when (IsCorruptStoreException(strictEx))
            {
                return CorruptStore(userKey, strictEx);
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to disable spoiler blur for series {key}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save spoiler blur state." });
            }
        }

        // ─── Per-movie opt-in ────────────────────────────────────────────────────

        public class SpoilerBlurMovieRequest
        {
            public string? MovieName { get; set; }
        }

        [HttpPost("spoiler-blur/movies/{movieId}")]
        [Authorize]
        [RequestSizeLimit(8 * 1024)]
        [Produces("application/json")]
        public IActionResult EnableSpoilerBlurForMovie(string movieId, [FromBody] SpoilerBlurMovieRequest? body = null)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();

            if (!Guid.TryParse(movieId, out var movieGuid) && !Guid.TryParseExact(movieId, "N", out movieGuid))
            {
                return BadRequest(new { success = false, message = "Invalid movieId." });
            }

            var jUser = _userManager.GetUserById(userId.Value);
            if (jUser == null) return Forbid();
            BaseItem? item = null;
            try
            {
                item = _libraryManager.GetItemById<BaseItem>(movieGuid, jUser);
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"GetItemById<BaseItem> threw for {movieGuid}: {ex.GetType().Name}: {ex.Message}");
            }
            if (item is not Movie movie)
            {
                return NotFound(new { success = false, message = "Movie not found or not accessible." });
            }

            var key = movieGuid.ToString("N");
            var userKey = userId.Value.ToString("N");

            // Sanitize the optional client-provided name: strip HTML tags + angle
            // brackets, cap length. Titles legitimately contain apostrophes/quotes,
            // so those are preserved (consumers render via textContent).
            var movieNameSanitized = SanitizeDisplayName(movie.Name ?? string.Empty, body?.MovieName);

            try
            {
                var result = _itemActionOwner.Configure(
                    new SpoilerGuardActorProjection(userId.Value),
                    SpoilerGuardItemProjection.CurrentAccessible(
                        movieGuid,
                        SpoilerGuardItemKind.Movie,
                        movieNameSanitized),
                    new SpoilerGuardItemConfiguration(enabled: true));
                if (result.Outcome == SpoilerGuardItemActionOutcome.CapacityExceeded)
                {
                    _logger.LogWarning(
                        $"Spoiler Guard movie cap reached for {ResolveUserDisplay(userKey)}; " +
                        $"rejecting new movie {key}.");
                    return SpoilerOverrideCapacityExceeded("movies");
                }
                _logger.LogInformation($"Spoiler Guard enabled for movie '{movie.Name}' ({key}) by {ResolveUserDisplay(userKey)}");
                return Ok(new { success = true, movieId = key, name = movie.Name });
            }
            catch (Exception strictEx) when (IsCorruptStoreException(strictEx))
            {
                return CorruptStore(userKey, strictEx);
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to enable spoiler blur for movie {key}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save spoiler blur state." });
            }
        }

        [HttpDelete("spoiler-blur/movies/{movieId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult DisableSpoilerBlurForMovie(string movieId)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();

            if (!Guid.TryParse(movieId, out var movieGuid) && !Guid.TryParseExact(movieId, "N", out movieGuid))
            {
                return BadRequest(new { success = false, message = "Invalid movieId." });
            }

            var key = movieGuid.ToString("N");
            var userKey = userId.Value.ToString("N");
            try
            {
                var result = _itemActionOwner.Configure(
                    new SpoilerGuardActorProjection(userId.Value),
                    SpoilerGuardItemProjection.ActorOwnedRemoval(
                        movieGuid,
                        SpoilerGuardItemKind.Movie),
                    new SpoilerGuardItemConfiguration(enabled: false));
                var removed = result.Removed;
                if (!removed)
                {
                    _logger.LogInformation($"Spoiler Guard disable was a no-op for movie {key} by {ResolveUserDisplay(userKey)} — movie was not in the user's spoiler-blur list.");
                    return Ok(new { success = true, movieId = key, removed = false });
                }
                _logger.LogInformation($"Spoiler Guard disabled for movie {key} by {ResolveUserDisplay(userKey)}");
                return Ok(new { success = true, movieId = key, removed = true });
            }
            catch (Exception strictEx) when (IsCorruptStoreException(strictEx))
            {
                return CorruptStore(userKey, strictEx);
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to disable spoiler blur for movie {key}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save spoiler blur state." });
            }
        }

        // ─── Movie scope probe (for client-side reviews suppression) ─────────────
        // The client can't tell whether a movie is in spoiler scope via a
        // COLLECTION opt-in (that requires the server-side library walk), so it
        // can't decide on its own whether to suppress reviews for a movie. This
        // cheap probe answers "is this movie guarded for ME, and have I played
        // it" so the client can suppress accordingly. Lenient reads throughout:
        // a UI hint must never 503; a missing/corrupt store just yields
        // inScope=false.
        [HttpGet("spoiler-blur/scope/movie/{movieId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetMovieSpoilerScope(string movieId)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();

            if (!Guid.TryParse(movieId, out var movieGuid) && !Guid.TryParseExact(movieId, "N", out movieGuid))
            {
                return BadRequest(new { success = false, message = "Invalid movieId." });
            }

            var userKey = userId.Value.ToString("N");
            var state = _userConfigurationManager.GetUserConfiguration<UserSpoilerBlur>(userKey, SpoilerFileName);
            var inScope = _resolver.IsMovieInSpoilerScope(state, movieGuid);

            // Only resolve the item + user-data when the movie is actually in
            // scope — keeps the common not-guarded answer allocation-light.
            var played = false;
            if (inScope)
            {
                var jUser = _userManager.GetUserById(userId.Value);
                if (jUser != null)
                {
                    try
                    {
                        if (_libraryManager.GetItemById<BaseItem>(movieGuid, jUser) is Movie movie)
                        {
                            played = _userDataManager.GetUserData(jUser, movie)?.Played == true;
                        }
                    }
                    catch (Exception ex)
                    {
                        // Inaccessible / partially-stored row — leave played=false.
                        _logger.LogWarning($"GetMovieSpoilerScope: item/user-data lookup threw for {movieGuid}: {ex.GetType().Name}: {ex.Message}");
                    }
                }
            }

            return Ok(new { inScope, played });
        }

        // ─── Per-collection opt-in (shortcut: protects member movies) ────────────

        public class SpoilerBlurCollectionRequest
        {
            public string? CollectionName { get; set; }
        }

        [HttpPost("spoiler-blur/collections/{collectionId}")]
        [Authorize]
        [RequestSizeLimit(8 * 1024)]
        [Produces("application/json")]
        public IActionResult EnableSpoilerBlurForCollection(string collectionId, [FromBody] SpoilerBlurCollectionRequest? body = null)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();

            if (!Guid.TryParse(collectionId, out var collGuid) && !Guid.TryParseExact(collectionId, "N", out collGuid))
            {
                return BadRequest(new { success = false, message = "Invalid collectionId." });
            }

            var jUser = _userManager.GetUserById(userId.Value);
            if (jUser == null) return Forbid();
            BaseItem? item = null;
            try
            {
                item = _libraryManager.GetItemById<BaseItem>(collGuid, jUser);
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"GetItemById<BaseItem> threw for {collGuid}: {ex.GetType().Name}: {ex.Message}");
            }
            if (item is not BoxSet boxSet)
            {
                return NotFound(new { success = false, message = "Collection not found or not accessible." });
            }

            var key = collGuid.ToString("N");
            var userKey = userId.Value.ToString("N");
            var collNameSanitized = SanitizeDisplayName(boxSet.Name ?? string.Empty, body?.CollectionName);

            try
            {
                var capacityExceeded = false;
                _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey, SpoilerFileName, state =>
                    {
                        if (state.Collections.TryGetValue(key, out var existing))
                        {
                            if (string.Equals(existing.CollectionName, collNameSanitized, StringComparison.Ordinal))
                            {
                                return 0;
                            }
                            existing.CollectionName = collNameSanitized;
                            SpoilerGuardOverridesRevision.Advance(state);
                            return 1;
                        }
                        if (!SpoilerGuardOverrideCapacity.CanInsert(state.Collections, key))
                        {
                            capacityExceeded = true;
                            return 0;
                        }
                        state.Collections[key] = new SpoilerBlurCollectionEntry
                        {
                            CollectionId = key,
                            CollectionName = collNameSanitized,
                            EnabledAt = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture),
                        };
                        SpoilerGuardOverridesRevision.Advance(state);
                        return 1;
                    });
                if (capacityExceeded)
                {
                    _logger.LogWarning(
                        $"Spoiler Guard collection cap reached for {ResolveUserDisplay(userKey)}; " +
                        $"rejecting new collection {key}.");
                    return SpoilerOverrideCapacityExceeded("collections");
                }
                SpoilerUserResolver.InvalidateUser(userKey);
                _logger.LogInformation($"Spoiler Guard enabled for collection '{boxSet.Name}' ({key}) by {ResolveUserDisplay(userKey)}");
                return Ok(new { success = true, collectionId = key, name = boxSet.Name });
            }
            catch (Exception strictEx) when (IsCorruptStoreException(strictEx))
            {
                return CorruptStore(userKey, strictEx);
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to enable spoiler blur for collection {key}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save spoiler blur state." });
            }
        }

        [HttpDelete("spoiler-blur/collections/{collectionId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult DisableSpoilerBlurForCollection(string collectionId)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();

            if (!Guid.TryParse(collectionId, out var collGuid) && !Guid.TryParseExact(collectionId, "N", out collGuid))
            {
                return BadRequest(new { success = false, message = "Invalid collectionId." });
            }

            var key = collGuid.ToString("N");
            var userKey = userId.Value.ToString("N");
            try
            {
                bool removed = false;
                _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey, SpoilerFileName, state =>
                    {
                        removed = state.Collections.Remove(key);
                        if (removed) SpoilerGuardOverridesRevision.Advance(state);
                        return removed ? 1 : 0;
                    });
                SpoilerUserResolver.InvalidateUser(userKey);
                if (!removed)
                {
                    _logger.LogInformation($"Spoiler Guard disable was a no-op for collection {key} by {ResolveUserDisplay(userKey)} — collection was not in the user's spoiler-blur list.");
                    return Ok(new { success = true, collectionId = key, removed = false });
                }
                _logger.LogInformation($"Spoiler Guard disabled for collection {key} by {ResolveUserDisplay(userKey)}");
                return Ok(new { success = true, collectionId = key, removed = true });
            }
            catch (Exception strictEx) when (IsCorruptStoreException(strictEx))
            {
                return CorruptStore(userKey, strictEx);
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to disable spoiler blur for collection {key}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save spoiler blur state." });
            }
        }

        // ─── Pre-acquisition pending (Seerr / not-yet-downloaded) ────────────────

        [HttpPost("spoiler-blur/pending/{mediaType}/{tmdbId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult EnableSpoilerBlurPending(string mediaType, string tmdbId, [FromQuery] string? displayName = null)
        {
            if (_configProvider.ConfigurationOrNull?.SpoilerBlurEnabled != true)
            {
                return StatusCode(503, new { success = false, message = "Spoiler Guard is disabled by the administrator." });
            }

            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();

            if (!TryNormalizePendingRoute(mediaType, tmdbId, out var normalizedType, out var canonicalTmdb, out var routeError))
            {
                return routeError!;
            }

            var jUser = _userManager.GetUserById(userId.Value);
            if (jUser == null) return Forbid();

            var userKey = userId.Value.ToString("N");
            try
            {
                var summary = _pendingService.AddPending(userId.Value, jUser, normalizedType, canonicalTmdb, displayName);
                if (summary.Promoted == "cap-exceeded")
                {
                    if (string.Equals(
                        summary.CapacityCategory,
                        "pending",
                        StringComparison.Ordinal))
                    {
                        return StatusCode(StatusCodes.Status429TooManyRequests, new
                        {
                            success = false,
                            code = "pending_cap_exceeded",
                            category = "pending",
                            maximum = SpoilerPendingService.MaxPendingTmdbPerUser,
                            message = $"You already have the maximum of {SpoilerPendingService.MaxPendingTmdbPerUser} pending spoiler-blur entries. Remove some via the management UI before adding more."
                        });
                    }

                    return SpoilerOverrideCapacityExceeded(
                        summary.CapacityCategory ?? "override");
                }
                return Ok(new { success = true, promoted = summary.Promoted, jellyfinId = summary.JellyfinId, name = summary.Name });
            }
            catch (Exception strictEx) when (IsCorruptStoreException(strictEx))
            {
                return CorruptStore(userKey, strictEx);
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to record spoiler-blur pending {normalizedType}:{canonicalTmdb}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save spoiler-blur pending state." });
            }
        }

        [HttpDelete("spoiler-blur/pending/{mediaType}/{tmdbId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult DisableSpoilerBlurPending(string mediaType, string tmdbId)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();

            if (!TryNormalizePendingRoute(mediaType, tmdbId, out var normalizedType, out var canonicalTmdb, out var routeError))
            {
                return routeError!;
            }

            var pendingKey = $"{normalizedType}:{canonicalTmdb}";
            var userKey = userId.Value.ToString("N");

            // Mirror the POST abstraction: the modal's "Disable spoiler" click needn't
            // know whether the entry is pending or in Series/Movies. Resolve TMDB ->
            // Jellyfin id and remove from whichever side holds it. Pre-compute the id
            // outside the RMW so we don't capture mutated locals into the lambda.
            var jUser = _userManager.GetUserById(userId.Value);
            try
            {
                var existingItem = jUser != null
                    ? _pendingService.FindLibraryItemByTmdb(jUser, normalizedType, canonicalTmdb)
                    : null;
                var seriesKeyToRemove = (existingItem as Series)?.Id.ToString("N");
                var movieKeyToRemove = (existingItem as Movie)?.Id.ToString("N");
                var resultBox = new[] { (Removed: false, From: "none", JellyfinId: (string?)null) };
                _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey, SpoilerFileName, state =>
                    {
                        bool pendingRemoved = state.PendingTmdb.Remove(pendingKey);
                        bool seriesRemoved = seriesKeyToRemove != null && state.Series.Remove(seriesKeyToRemove);
                        bool movieRemoved = movieKeyToRemove != null && state.Movies.Remove(movieKeyToRemove);
                        if (seriesRemoved) resultBox[0] = (true, "series", seriesKeyToRemove);
                        else if (movieRemoved) resultBox[0] = (true, "movie", movieKeyToRemove);
                        else if (pendingRemoved) resultBox[0] = (true, "pending", null);
                        if (resultBox[0].Removed)
                        {
                            SpoilerGuardOverridesRevision.Advance(state);
                        }
                        return resultBox[0].Removed ? 1 : 0;
                    });
                SpoilerUserResolver.InvalidateUser(userKey);
                // Either way the key is no longer pending for this user — keep the
                // promoter's gate consistent so it stops sweeping this user.
                _pendingService.ReconcilePendingKeys(
                    userKey,
                    new[] { pendingKey });
                var (removedAnything, removedFrom, removedJellyfinId) = resultBox[0];
                if (!removedAnything)
                {
                    return Ok(new { success = true, removed = false, removedFrom = "none" });
                }
                _logger.LogInformation($"Spoiler Guard pending DELETE removed {pendingKey} ({removedFrom}) for {ResolveUserDisplay(userKey)}");
                return Ok(new { success = true, removed = true, removedFrom, jellyfinId = removedJellyfinId });
            }
            catch (Exception strictEx) when (IsCorruptStoreException(strictEx))
            {
                return CorruptStore(userKey, strictEx);
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to remove spoiler-blur pending {pendingKey}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save spoiler-blur pending state." });
            }
        }

        // ─── Shared helpers ──────────────────────────────────────────────────────

        private IActionResult? ValidateChangedTargetLocalOverrides(
            SpoilerGuardOverrides current,
            SpoilerGuardOverrides candidate,
            JUser targetUser)
        {
            // Admin writes replace the whole resource, but they must obey the same
            // 500-row admission ceiling as the ordinary pending writer.  A legacy
            // store may already exceed that older operational limit, so allow
            // unchanged rows, edits to existing rows, and progressive removals
            // while it remains over-cap.  A write that introduces a new pending
            // identity may only leave the resulting resource at or below 500.
            if (candidate.PendingTmdb.Count > SpoilerPendingService.MaxPendingTmdbPerUser
                && candidate.PendingTmdb.Keys.Any(
                    key => !current.PendingTmdb.ContainsKey(key)))
            {
                return BadRequest(new
                {
                    success = false,
                    code = "pending_cap_exceeded",
                    category = "pending",
                    maximum = SpoilerPendingService.MaxPendingTmdbPerUser,
                    message =
                        $"New pending overrides may not leave more than " +
                        $"{SpoilerPendingService.MaxPendingTmdbPerUser} entries."
                });
            }

            foreach (var pair in candidate.Series)
            {
                if (current.Series.TryGetValue(pair.Key, out var existing)
                    && PersistedEntryEqual(existing, pair.Value))
                {
                    continue;
                }

                var itemId = Guid.ParseExact(pair.Key, "N");
                var resolveError = ResolveTargetOverrideItem(
                    itemId,
                    targetUser,
                    "series",
                    out var item);
                if (resolveError != null) return resolveError;
                if (item is not Series)
                {
                    return BadRequest(new
                    {
                        success = false,
                        code = "spoiler_override_item_type_mismatch",
                        category = "series",
                        message = "A changed series override does not reference a Series."
                    });
                }

            }

            foreach (var pair in candidate.Movies)
            {
                if (current.Movies.TryGetValue(pair.Key, out var existing)
                    && PersistedEntryEqual(existing, pair.Value))
                {
                    continue;
                }

                var itemId = Guid.ParseExact(pair.Key, "N");
                var resolveError = ResolveTargetOverrideItem(
                    itemId,
                    targetUser,
                    "movies",
                    out var item);
                if (resolveError != null) return resolveError;
                if (item is not Movie)
                {
                    return BadRequest(new
                    {
                        success = false,
                        code = "spoiler_override_item_type_mismatch",
                        category = "movies",
                        message = "A changed movie override does not reference a Movie."
                    });
                }

            }

            foreach (var pair in candidate.Collections)
            {
                if (current.Collections.TryGetValue(pair.Key, out var existing)
                    && PersistedEntryEqual(existing, pair.Value))
                {
                    continue;
                }

                var itemId = Guid.ParseExact(pair.Key, "N");
                var resolveError = ResolveTargetOverrideItem(
                    itemId,
                    targetUser,
                    "collections",
                    out var item);
                if (resolveError != null) return resolveError;
                if (item is not BoxSet)
                {
                    return BadRequest(new
                    {
                        success = false,
                        code = "spoiler_override_item_type_mismatch",
                        category = "collections",
                        message = "A changed collection override does not reference a BoxSet."
                    });
                }

            }

            return null;
        }

        private IActionResult? ResolveTargetOverrideItem(
            Guid itemId,
            JUser targetUser,
            string category,
            out BaseItem item)
        {
            item = null!;
            BaseItem? resolved;
            try
            {
                resolved = _libraryManager.GetItemById<BaseItem>(itemId, targetUser);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(
                    $"Admin Spoiler Guard {category} validation failed closed for " +
                    $"{ResolveUserDisplay(targetUser.Id.ToString("N"))} " +
                    $"(exception={ex.GetType().Name}).");
                return StatusCode(StatusCodes.Status503ServiceUnavailable, new
                {
                    success = false,
                    code = "spoiler_override_item_lookup_unavailable",
                    category,
                    message = "A changed local override could not be validated."
                });
            }

            if (resolved == null || resolved.Id != itemId)
            {
                return NotFound(new
                {
                    success = false,
                    code = "spoiler_override_item_unavailable",
                    category,
                    message =
                        "A changed local override item was not found or is not accessible to the target user."
                });
            }

            item = resolved;
            return null;
        }

        private static bool PersistedEntryEqual<T>(T left, T right)
            where T : class
            => JsonElement.DeepEquals(
                JsonSerializer.SerializeToElement(
                    left,
                    left.GetType(),
                    PersistedJson.WriteOptions),
                JsonSerializer.SerializeToElement(
                    right,
                    right.GetType(),
                    PersistedJson.WriteOptions));

        private static SpoilerGuardOverrides SnapshotOverrides(UserSpoilerBlur state)
        {
            if (state == null || state.OverridesRevision < 0)
            {
                throw new InvalidDataException("Spoiler Guard override state is invalid.");
            }

            var snapshot = SnapshotOverridesForCompatibility(state);
            PersistedPayloadPolicy.NormalizeLegacyRuntimeState(snapshot);
            if (!PersistedPayloadPolicy.Validate(snapshot).IsValid)
            {
                throw new InvalidDataException("Spoiler Guard override state is invalid.");
            }

            return PersistedPayloadPolicy.CloneValidated(snapshot);
        }

        private static SpoilerGuardOverrides SnapshotOverridesForCompatibility(
            UserSpoilerBlur state)
            => ClonePersisted(new SpoilerGuardOverrides
            {
                Revision = state.OverridesRevision,
                Series = state.Series,
                Movies = state.Movies,
                Collections = state.Collections,
                PendingTmdb = state.PendingTmdb,
                ExtensionData = state.OverridesExtensionData
                    ?? new Dictionary<string, JsonElement>(StringComparer.Ordinal)
            });

        private static void ApplyOverrides(
            UserSpoilerBlur state,
            SpoilerGuardOverrides overrides)
        {
            var detached = PersistedPayloadPolicy.CloneValidated(overrides);
            state.Series = detached.Series;
            state.Movies = detached.Movies;
            state.Collections = detached.Collections;
            state.PendingTmdb = detached.PendingTmdb;
            state.OverridesRevision = detached.Revision;
            state.OverridesExtensionData = detached.ExtensionData;
        }

        private static void PreserveAdminTargetOverrideExtensions(
            SpoilerGuardOverrides current,
            SpoilerGuardOverrides candidate)
        {
            candidate.ExtensionData =
                PersistedPayloadPolicy.PreserveExistingExtensionData(
                    candidate.ExtensionData,
                    current.ExtensionData);

            foreach (var pair in candidate.Series)
            {
                if (current.Series.TryGetValue(pair.Key, out var existing))
                {
                    pair.Value.ExtensionData =
                        PersistedPayloadPolicy.PreserveExistingExtensionData(
                            pair.Value.ExtensionData,
                            existing.ExtensionData);
                }
            }

            foreach (var pair in candidate.Movies)
            {
                if (current.Movies.TryGetValue(pair.Key, out var existing))
                {
                    pair.Value.ExtensionData =
                        PersistedPayloadPolicy.PreserveExistingExtensionData(
                            pair.Value.ExtensionData,
                            existing.ExtensionData);
                }
            }

            foreach (var pair in candidate.Collections)
            {
                if (current.Collections.TryGetValue(pair.Key, out var existing))
                {
                    pair.Value.ExtensionData =
                        PersistedPayloadPolicy.PreserveExistingExtensionData(
                            pair.Value.ExtensionData,
                            existing.ExtensionData);
                }
            }

            foreach (var pair in candidate.PendingTmdb)
            {
                if (current.PendingTmdb.TryGetValue(pair.Key, out var existing))
                {
                    pair.Value.ExtensionData =
                        PersistedPayloadPolicy.PreserveExistingExtensionData(
                            pair.Value.ExtensionData,
                            existing.ExtensionData);
                }
            }
        }

        private void ReconcilePendingGate(
            string userKey,
            IEnumerable<string> priorPending,
            IEnumerable<string> currentPending)
            => _pendingService.ReconcilePendingKeys(
                userKey,
                priorPending.Concat(currentPending));

        // Validates the {mediaType}/{tmdbId} route pair shared by the pending
        // POST/DELETE. mediaType must be tv|movie; tmdbId a positive integer.
        private bool TryNormalizePendingRoute(
            string mediaType, string tmdbId,
            out string normalizedType, out string canonicalTmdb, out IActionResult? error)
        {
            normalizedType = (mediaType ?? string.Empty).ToLowerInvariant();
            canonicalTmdb = string.Empty;
            error = null;

            if (normalizedType != "tv" && normalizedType != "movie")
            {
                error = BadRequest(new { success = false, message = "mediaType must be 'tv' or 'movie'." });
                return false;
            }
            // TMDB ids are positive integers; reject anything else so we don't store
            // junk keys the promoter would never match.
            if (string.IsNullOrWhiteSpace(tmdbId)
                || !int.TryParse(tmdbId, NumberStyles.Integer, CultureInfo.InvariantCulture, out var tmdbInt)
                || tmdbInt <= 0)
            {
                error = BadRequest(new { success = false, message = "Invalid tmdbId." });
                return false;
            }
            canonicalTmdb = tmdbInt.ToString(CultureInfo.InvariantCulture);
            return true;
        }

        // Sanitizes an optional client-supplied display name over a server-derived
        // fallback: strip HTML tags + angle brackets, cap at 200 chars, and only
        // override the fallback when something usable remains.
        private static string SanitizeDisplayName(string fallback, string? clientName)
        {
            var boundedFallback = PersistedPayloadPolicy
                .ClampPersistedDisplayName(fallback);
            if (clientName is not string raw || string.IsNullOrEmpty(raw))
            {
                return boundedFallback;
            }
            var cleaned = System.Text.RegularExpressions.Regex.Replace(raw, "<[^>]+>", string.Empty);
            cleaned = cleaned.Replace("<", string.Empty).Replace(">", string.Empty);
            if (cleaned.Length > 200) cleaned = cleaned.Substring(0, 200);
            return string.IsNullOrWhiteSpace(cleaned) ? boundedFallback : cleaned;
        }
    }
}
