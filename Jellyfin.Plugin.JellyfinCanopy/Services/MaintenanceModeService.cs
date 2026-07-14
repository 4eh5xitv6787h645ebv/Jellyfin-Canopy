using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services
{
    public static class MaintenancePhases
    {
        public const string Inactive = "Inactive";
        public const string Active = "Active";
        public const string Restoring = "Restoring";
        public const string RestoreFailed = "RestoreFailed";
        public const string Faulted = "Faulted";
    }

    public class MaintenanceState
    {
        public int SchemaVersion { get; set; } = 2;
        public string Phase { get; set; } = string.Empty;
        public bool IsActive { get; set; }
        public string Message { get; set; } = string.Empty;
        /// <summary>"disable_accounts" | "disable_remote" | "both"</summary>
        public string Action { get; set; } = "disable_accounts";
        public DateTime StartedAt { get; set; }
        public DateTime? EndsAt { get; set; }
        /// <summary>Users whose accounts were disabled by maintenance mode (so we know what to restore).</summary>
        public List<string> AccountDisabledUserIds { get; set; } = new();
        /// <summary>Users whose remote access was disabled by maintenance mode.</summary>
        public List<string> RemoteDisabledUserIds { get; set; } = new();
        /// <summary>A safe, admin-facing description of a durable recovery fault.</summary>
        public string? FailureReason { get; set; }
        /// <summary>Whether the durable state contains enough evidence to attempt account recovery.</summary>
        public bool RecoveryAvailable { get; set; }
        /// <summary>The last-known-good phase recovered when the primary file is unreadable.</summary>
        public string? RecoveryPhase { get; set; }
    }

    /// <summary>
    /// Owns the complete maintenance-mode state machine. The primary file and its recovery
    /// snapshot are written before user policies are changed, and expiry is driven by one hosted
    /// timer rather than status polling.
    /// </summary>
    public sealed class MaintenanceModeService : IHostedService, IDisposable
    {
        private readonly IUserManager _userManager;
        private readonly ILogger<MaintenanceModeService> _logger;
        private readonly string _stateFilePath;
        private readonly string _recoveryFilePath;
        private readonly TimeProvider _timeProvider;
        private readonly Action<string, string> _writeAllText;
        private readonly SemaphoreSlim _stateGate = new(1, 1);
        private readonly object _stateSync = new();
        private readonly object _timerSync = new();
        private MaintenanceState _state;
        private ITimer? _expiryTimer;
        private Task _backgroundRestoreTask = Task.CompletedTask;
        private bool _started;
        private bool _stopping;
        private bool _disposed;

        public MaintenanceModeService(
            IUserManager userManager,
            IApplicationPaths appPaths,
            ILogger<MaintenanceModeService> logger)
            : this(userManager, appPaths, logger, TimeProvider.System, AtomicFile.WriteAllText)
        {
        }

        internal MaintenanceModeService(
            IUserManager userManager,
            IApplicationPaths appPaths,
            ILogger<MaintenanceModeService> logger,
            TimeProvider timeProvider,
            Action<string, string> writeAllText)
        {
            _userManager = userManager;
            _logger = logger;
            _timeProvider = timeProvider;
            _writeAllText = writeAllText;
            var dir = Path.Combine(appPaths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinCanopy");
            Directory.CreateDirectory(dir);
            _stateFilePath = Path.Combine(dir, "maintenance-state.json");
            _recoveryFilePath = _stateFilePath + ".recovery";
            _state = LoadInitialState();
        }

        public MaintenanceState GetStatus()
        {
            lock (_stateSync)
            {
                return CloneState(_state);
            }
        }

        public async Task StartAsync(CancellationToken cancellationToken)
        {
            await _stateGate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                lock (_timerSync)
                {
                    ObjectDisposedException.ThrowIf(_disposed, this);
                    _started = true;
                    _stopping = false;
                }

                ScheduleExpiry(GetStatus());
            }
            finally
            {
                _stateGate.Release();
            }
        }

        public async Task StopAsync(CancellationToken cancellationToken)
        {
            Task background;
            lock (_timerSync)
            {
                _stopping = true;
                _started = false;
                _expiryTimer?.Dispose();
                _expiryTimer = null;
                background = _backgroundRestoreTask;
            }

            // A restore that has already changed account policy must finish its durable state
            // transition. Abandoning it at host shutdown would recreate the stranded-account bug.
            if (!background.IsCompleted)
            {
                _logger.LogInformation("[Maintenance] Waiting for the in-flight recovery transition during shutdown.");
                await background.WaitAsync(cancellationToken).ConfigureAwait(false);
            }
        }

        /// <param name="action">"disable_accounts" | "disable_remote" | "both"</param>
        /// <param name="affectedUserIds">Specific user IDs to affect; null or empty = all non-admin users.</param>
        public async Task EnableAsync(string message, int durationMinutes, string action, List<string>? affectedUserIds)
        {
            await _stateGate.WaitAsync().ConfigureAwait(false);
            try
            {
                var currentState = GetStatus();
                if (string.Equals(currentState.Phase, MaintenancePhases.Faulted, StringComparison.Ordinal) ||
                    string.Equals(currentState.Phase, MaintenancePhases.Restoring, StringComparison.Ordinal) ||
                    string.Equals(currentState.Phase, MaintenancePhases.RestoreFailed, StringComparison.Ordinal))
                {
                    throw new InvalidOperationException(
                        $"Maintenance mode cannot be enabled while recovery is {currentState.Phase}. " +
                        "Complete or repair the existing recovery state first.");
                }

                if (string.Equals(currentState.Phase, MaintenancePhases.Active, StringComparison.Ordinal))
                {
                    currentState.Message = message ?? string.Empty;
                    currentState.EndsAt = durationMinutes > 0 ? UtcNow().AddMinutes(durationMinutes) : null;
                    currentState.FailureReason = null;
                    currentState.RecoveryAvailable = true;
                    currentState.RecoveryPhase = null;
                    SaveState(currentState);
                    PublishState(currentState);
                    ScheduleExpiry(currentState);
                    _logger.LogInformation("[Maintenance] Message/duration updated (already active).");
                    return;
                }

                bool doAccounts = action == "disable_accounts" || action == "both";
                bool doRemote = action == "disable_remote" || action == "both";

                var allNonAdmin = _userManager.GetUsers()
                    .Where(u => !u.HasPermission(PermissionKind.IsAdministrator))
                    .ToList();

                IEnumerable<Jellyfin.Database.Implementations.Entities.User> targetUsers;
                if (affectedUserIds == null || affectedUserIds.Count == 0)
                {
                    targetUsers = allNonAdmin;
                }
                else
                {
                    var idSet = affectedUserIds
                        .Select(s => Guid.TryParse(s, out var parsed) ? parsed : Guid.Empty)
                        .Where(id => id != Guid.Empty)
                        .ToHashSet();
                    targetUsers = allNonAdmin.Where(u => idSet.Contains(u.Id));
                }

                var plan = new List<(Guid Id, string Username, MediaBrowser.Model.Users.UserPolicy Policy, bool DisableAccount, bool DisableRemote)>();
                foreach (var user in targetUsers)
                {
                    var dto = _userManager.GetUserDto(user, string.Empty);
                    if (dto.Policy == null)
                    {
                        throw new InvalidOperationException($"Cannot read the policy for maintenance target '{user.Username}'.");
                    }

                    bool disableAccount = doAccounts && !dto.Policy.IsDisabled;
                    bool disableRemote = doRemote && dto.Policy.EnableRemoteAccess;
                    if (disableAccount || disableRemote)
                    {
                        plan.Add((user.Id, user.Username, dto.Policy, disableAccount, disableRemote));
                    }
                }

                var now = UtcNow();
                var newState = new MaintenanceState
                {
                    SchemaVersion = 2,
                    Phase = MaintenancePhases.Active,
                    IsActive = true,
                    Message = message ?? string.Empty,
                    Action = action ?? "disable_accounts",
                    StartedAt = now,
                    EndsAt = durationMinutes > 0 ? now.AddMinutes(durationMinutes) : null,
                    AccountDisabledUserIds = plan.Where(p => p.DisableAccount).Select(p => p.Id.ToString()).ToList(),
                    RemoteDisabledUserIds = plan.Where(p => p.DisableRemote).Select(p => p.Id.ToString()).ToList(),
                    RecoveryAvailable = true
                };

                // Both the recovery snapshot and the primary intent exist before the first account
                // mutation. A failed write aborts the request with every account untouched.
                SaveState(newState);
                PublishState(newState);

                foreach (var (id, username, policy, disableAccount, disableRemote) in plan)
                {
                    try
                    {
                        if (disableAccount)
                        {
                            policy.IsDisabled = true;
                        }

                        if (disableRemote)
                        {
                            policy.EnableRemoteAccess = false;
                        }

                        await _userManager.UpdatePolicyAsync(id, policy).ConfigureAwait(false);
                        _logger.LogInformation(
                            "[Maintenance] Updated user '{Username}' (account={DisableAccount}, remote={DisableRemote}).",
                            username,
                            disableAccount,
                            disableRemote);
                    }
                    catch (Exception ex)
                    {
                        // The durable restore intent deliberately retains this user. A retry can
                        // safely re-enable a policy even when this enable mutation never landed.
                        _logger.LogError(ex, "[Maintenance] Failed to update user '{Username}'.", username);
                    }
                }

                ScheduleExpiry(newState);
                _logger.LogInformation(
                    "[Maintenance] Mode enabled. Action={Action}, AccountsDisabled={AccountsDisabled}, RemoteDisabled={RemoteDisabled}.",
                    action,
                    newState.AccountDisabledUserIds.Count,
                    newState.RemoteDisabledUserIds.Count);
            }
            finally
            {
                _stateGate.Release();
            }
        }

        public Task DisableAsync() => DisableCoreAsync(scheduledExpiry: false);

        internal Task WaitForBackgroundRestoreAsync()
        {
            lock (_timerSync)
            {
                return _backgroundRestoreTask;
            }
        }

        private async Task DisableCoreAsync(bool scheduledExpiry)
        {
            await _stateGate.WaitAsync().ConfigureAwait(false);
            try
            {
                var state = GetStatus();
                if (string.Equals(state.Phase, MaintenancePhases.Inactive, StringComparison.Ordinal))
                {
                    _logger.LogInformation("[Maintenance] Already inactive — skipping disable.");
                    return;
                }

                if (string.Equals(state.Phase, MaintenancePhases.Faulted, StringComparison.Ordinal) &&
                    !state.RecoveryAvailable)
                {
                    throw new InvalidOperationException(
                        "Maintenance state is faulted and no recovery ledger is available. " +
                        "Repair the state file and restart Jellyfin before changing account policies.");
                }

                if (scheduledExpiry && !ScheduledRecoveryIsStillDue(state))
                {
                    // The old timer may have fired while an admin extension held _stateGate.
                    // That extension owns the replacement timer; leave it intact and do not
                    // convert a stale callback into an unconditional manual disable.
                    _logger.LogInformation("[Maintenance] Ignoring stale scheduled recovery after the maintenance deadline changed.");
                    return;
                }

                CancelExpiry();
                var restoringState = CloneState(state);
                restoringState.SchemaVersion = 2;
                restoringState.Phase = MaintenancePhases.Restoring;
                restoringState.IsActive = true;
                restoringState.EndsAt = null;
                restoringState.FailureReason = null;
                restoringState.RecoveryAvailable = true;
                restoringState.RecoveryPhase = null;
                SaveState(restoringState);
                PublishState(restoringState);

                var accountIds = ParseIds(restoringState.AccountDisabledUserIds, out var invalidAccountIds);
                var remoteIds = ParseIds(restoringState.RemoteDisabledUserIds, out var invalidRemoteIds);
                var unresolvedIds = new HashSet<Guid>();
                var allIds = accountIds.Union(remoteIds).ToList();

                foreach (var userId in allIds)
                {
                    try
                    {
                        var user = _userManager.GetUserById(userId);
                        if (user == null)
                        {
                            if (IsConfirmedDeleted(userId))
                            {
                                _logger.LogInformation("[Maintenance] Retiring deleted user {UserId} from the restore ledger.", userId);
                            }
                            else
                            {
                                unresolvedIds.Add(userId);
                                _logger.LogWarning("[Maintenance] User {UserId} could not be resolved; retaining the restore record.", userId);
                            }

                            continue;
                        }

                        var dto = _userManager.GetUserDto(user, string.Empty);
                        if (dto.Policy == null)
                        {
                            unresolvedIds.Add(userId);
                            _logger.LogWarning("[Maintenance] User {UserId} has no readable policy; retaining the restore record.", userId);
                            continue;
                        }

                        if (accountIds.Contains(userId))
                        {
                            dto.Policy.IsDisabled = false;
                        }

                        if (remoteIds.Contains(userId))
                        {
                            dto.Policy.EnableRemoteAccess = true;
                        }

                        await _userManager.UpdatePolicyAsync(userId, dto.Policy).ConfigureAwait(false);
                        _logger.LogInformation("[Maintenance] Restored user '{Username}'.", user.Username);
                    }
                    catch (Exception ex)
                    {
                        unresolvedIds.Add(userId);
                        _logger.LogError(ex, "[Maintenance] Failed to restore user {UserId}; retaining the restore record.", userId);
                    }
                }

                bool hasInvalidIds = invalidAccountIds.Count > 0 || invalidRemoteIds.Count > 0;
                if (unresolvedIds.Count > 0 || hasInvalidIds)
                {
                    var failedState = CreateRestoreFailedState(
                        restoringState,
                        restoringState.AccountDisabledUserIds.Where(id => IsUnresolved(id, unresolvedIds, invalidAccountIds)).ToList(),
                        restoringState.RemoteDisabledUserIds.Where(id => IsUnresolved(id, unresolvedIds, invalidRemoteIds)).ToList(),
                        "One or more maintenance account records could not be restored. Retry explicitly after correcting the user-policy fault.");
                    PersistOutcomeOrFallback(failedState, restoringState);
                    throw new InvalidOperationException(failedState.FailureReason);
                }

                var inactiveState = CreateInactiveState();
                PersistOutcomeOrFallback(inactiveState, restoringState);
                _logger.LogInformation("[Maintenance] Mode disabled.");
            }
            finally
            {
                _stateGate.Release();
            }
        }

        private void PersistOutcomeOrFallback(MaintenanceState outcome, MaintenanceState restoringState)
        {
            try
            {
                SaveState(outcome);
                PublishState(outcome);
            }
            catch (Exception outcomeException)
            {
                var fallback = CreateRestoreFailedState(
                    restoringState,
                    restoringState.AccountDisabledUserIds.ToList(),
                    restoringState.RemoteDisabledUserIds.ToList(),
                    "Account restoration ran, but its final durable state could not be committed. The complete recovery ledger was retained for an explicit retry.");
                try
                {
                    SaveState(fallback);
                    PublishState(fallback);
                }
                catch (Exception fallbackException)
                {
                    restoringState.FailureReason = fallback.FailureReason;
                    PublishState(restoringState);
                    _logger.LogCritical(
                        fallbackException,
                        "[Maintenance] Failed to persist both the recovery outcome and durable RestoreFailed fallback.");
                }

                throw new IOException(fallback.FailureReason, outcomeException);
            }
        }

        private bool IsConfirmedDeleted(Guid userId)
        {
            try
            {
                // GetUserById returning null alone is not deletion proof: database/provider faults
                // can surface the same way. A successful authoritative user enumeration that omits
                // the id is the explicit retirement evidence.
                return _userManager.GetUsers().All(user => user.Id != userId);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[Maintenance] Could not confirm whether missing user {UserId} was deleted.", userId);
                return false;
            }
        }

        private void ScheduleExpiry(MaintenanceState state)
        {
            lock (_timerSync)
            {
                _expiryTimer?.Dispose();
                _expiryTimer = null;
                if (!_started || _stopping || _disposed)
                {
                    return;
                }

                string effectivePhase = string.Equals(state.Phase, MaintenancePhases.Faulted, StringComparison.Ordinal)
                    ? state.RecoveryPhase ?? string.Empty
                    : state.Phase;
                TimeSpan? due = null;
                if (string.Equals(effectivePhase, MaintenancePhases.Restoring, StringComparison.Ordinal))
                {
                    due = TimeSpan.Zero;
                }
                else if (string.Equals(effectivePhase, MaintenancePhases.Active, StringComparison.Ordinal) && state.EndsAt.HasValue)
                {
                    due = state.EndsAt.Value - UtcNow();
                    if (due < TimeSpan.Zero)
                    {
                        due = TimeSpan.Zero;
                    }
                }

                if (due.HasValue)
                {
                    _expiryTimer = _timeProvider.CreateTimer(OnExpiryTimer, null, due.Value, Timeout.InfiniteTimeSpan);
                }
            }
        }

        private void CancelExpiry()
        {
            lock (_timerSync)
            {
                _expiryTimer?.Dispose();
                _expiryTimer = null;
            }
        }

        private void OnExpiryTimer(object? state)
        {
            lock (_timerSync)
            {
                _expiryTimer?.Dispose();
                _expiryTimer = null;
                if (_stopping || _disposed || !_backgroundRestoreTask.IsCompleted)
                {
                    return;
                }

                _backgroundRestoreTask = RunScheduledRestoreAsync();
            }
        }

        private async Task RunScheduledRestoreAsync()
        {
            try
            {
                await DisableCoreAsync(scheduledExpiry: true).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                // There is deliberately no automatic retry loop. RestoreFailed is durable and an
                // admin can retry explicitly after fixing the underlying policy/persistence fault.
                _logger.LogError(ex, "[Maintenance] Scheduled recovery stopped; no automatic retry will be queued.");
            }
        }

        private bool ScheduledRecoveryIsStillDue(MaintenanceState state)
        {
            string effectivePhase = string.Equals(state.Phase, MaintenancePhases.Faulted, StringComparison.Ordinal)
                ? state.RecoveryPhase ?? string.Empty
                : state.Phase;
            if (string.Equals(effectivePhase, MaintenancePhases.Restoring, StringComparison.Ordinal))
            {
                return true;
            }

            return string.Equals(effectivePhase, MaintenancePhases.Active, StringComparison.Ordinal) &&
                state.EndsAt.HasValue &&
                UtcNow() >= state.EndsAt.Value;
        }

        private MaintenanceState LoadInitialState()
        {
            var primary = TryReadState(_stateFilePath);
            if (primary.State != null)
            {
                TryRefreshRecoverySnapshot(primary.State);
                return primary.State;
            }

            var recovery = TryReadState(_recoveryFilePath);
            if (recovery.State != null)
            {
                var recovered = CloneState(recovery.State);
                recovered.Phase = MaintenancePhases.Faulted;
                recovered.IsActive = true;
                recovered.FailureReason =
                    "The primary maintenance state is unreadable. A last-known-good recovery ledger is available; disable maintenance to restore it, or repair the primary file and restart Jellyfin.";
                recovered.RecoveryAvailable = true;
                recovered.RecoveryPhase = recovery.State.Phase;
                _logger.LogError(
                    "[Maintenance] Primary state could not be read ({PrimaryFailure}); using the recovery ledger in Faulted state.",
                    primary.Failure ?? "missing");
                return recovered;
            }

            if (!primary.ArtifactExists && !recovery.ArtifactExists)
            {
                return CreateInactiveState();
            }

            _logger.LogCritical(
                "[Maintenance] Neither the primary state nor its recovery snapshot is readable. Account recovery is blocked until the files are repaired.");
            return new MaintenanceState
            {
                SchemaVersion = 2,
                Phase = MaintenancePhases.Faulted,
                IsActive = true,
                FailureReason =
                    "Maintenance state is unreadable and no valid recovery ledger is available. Repair the state files and restart Jellyfin; account mutation is blocked.",
                RecoveryAvailable = false
            };
        }

        private StateReadResult TryReadState(string path)
        {
            bool artifactExists = File.Exists(path) || Directory.Exists(path);
            if (!artifactExists)
            {
                return new StateReadResult(null, false, "missing");
            }

            try
            {
                var json = File.ReadAllText(path);
                using var document = JsonDocument.Parse(json, PersistedJson.ParseOptions);
                if (document.RootElement.ValueKind != JsonValueKind.Object)
                {
                    throw new InvalidDataException("The maintenance state root is not an object.");
                }

                ValidatePersistedShape(document.RootElement);
                var state = JsonSerializer.Deserialize<MaintenanceState>(json, PersistedJson.ReadOptions)
                    ?? throw new InvalidDataException("The maintenance state is empty.");
                if (HasProperty(document.RootElement, nameof(MaintenanceState.SchemaVersion)) && state.SchemaVersion != 2)
                {
                    throw new InvalidDataException($"Unsupported maintenance state schema version {state.SchemaVersion}.");
                }

                if (HasProperty(document.RootElement, nameof(MaintenanceState.Phase)))
                {
                    bool phaseIsInactive = string.Equals(state.Phase, MaintenancePhases.Inactive, StringComparison.Ordinal);
                    if (phaseIsInactive == state.IsActive)
                    {
                        throw new InvalidDataException("The persisted maintenance phase and IsActive flag disagree.");
                    }
                }

                NormalizeAndValidateState(state);
                return new StateReadResult(state, true, null);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[Maintenance] Failed to load state artifact {StateArtifact}.", Path.GetFileName(path));
                return new StateReadResult(null, true, ex.GetType().Name);
            }
        }

        private void TryRefreshRecoverySnapshot(MaintenanceState state)
        {
            try
            {
                var json = JsonSerializer.Serialize(state, PersistedJson.WriteOptions);
                _writeAllText(_recoveryFilePath, json);
            }
            catch (Exception ex)
            {
                // The next state mutation writes recovery first and therefore fails closed. A
                // readable primary remains truthful in the meantime.
                _logger.LogError(ex, "[Maintenance] Could not refresh the recovery snapshot; future mutations will fail closed.");
            }
        }

        private void SaveState(MaintenanceState state)
        {
            NormalizeAndValidateState(state);
            var json = JsonSerializer.Serialize(state, PersistedJson.WriteOptions);
            // Recovery first, primary second. If either write fails, callers do not publish the
            // proposed transition or begin the policy mutations it was meant to authorize.
            _writeAllText(_recoveryFilePath, json);
            _writeAllText(_stateFilePath, json);
        }

        private void PublishState(MaintenanceState state)
        {
            lock (_stateSync)
            {
                _state = CloneState(state);
            }
        }

        private static void NormalizeAndValidateState(MaintenanceState state)
        {
            state.AccountDisabledUserIds ??= new List<string>();
            state.RemoteDisabledUserIds ??= new List<string>();
            state.Message ??= string.Empty;
            state.Action ??= "disable_accounts";
            if (string.IsNullOrWhiteSpace(state.Phase))
            {
                state.Phase = state.IsActive ? MaintenancePhases.Active : MaintenancePhases.Inactive;
            }

            if (state.Phase != MaintenancePhases.Inactive &&
                state.Phase != MaintenancePhases.Active &&
                state.Phase != MaintenancePhases.Restoring &&
                state.Phase != MaintenancePhases.RestoreFailed &&
                state.Phase != MaintenancePhases.Faulted)
            {
                throw new InvalidDataException($"Unknown maintenance phase '{state.Phase}'.");
            }

            if (state.Phase == MaintenancePhases.Inactive)
            {
                if (state.AccountDisabledUserIds.Count != 0 || state.RemoteDisabledUserIds.Count != 0)
                {
                    throw new InvalidDataException("Inactive maintenance state cannot retain recovery records.");
                }

                state.IsActive = false;
                state.RecoveryAvailable = false;
                state.RecoveryPhase = null;
            }
            else
            {
                state.IsActive = true;
                if (state.Phase != MaintenancePhases.Faulted)
                {
                    state.RecoveryAvailable = true;
                    state.RecoveryPhase = null;
                }
            }

            state.SchemaVersion = Math.Max(state.SchemaVersion, 2);
        }

        private static MaintenanceState CreateInactiveState()
            => new()
            {
                SchemaVersion = 2,
                Phase = MaintenancePhases.Inactive,
                IsActive = false,
                RecoveryAvailable = false
            };

        private static MaintenanceState CreateRestoreFailedState(
            MaintenanceState source,
            List<string> accountIds,
            List<string> remoteIds,
            string failureReason)
            => new()
            {
                SchemaVersion = 2,
                Phase = MaintenancePhases.RestoreFailed,
                IsActive = true,
                Message = source.Message,
                Action = source.Action,
                StartedAt = source.StartedAt,
                EndsAt = null,
                AccountDisabledUserIds = accountIds,
                RemoteDisabledUserIds = remoteIds,
                FailureReason = failureReason,
                RecoveryAvailable = true
            };

        private static HashSet<Guid> ParseIds(IEnumerable<string> values, out HashSet<string> invalid)
        {
            var parsed = new HashSet<Guid>();
            invalid = new HashSet<string>(StringComparer.Ordinal);
            foreach (var value in values)
            {
                if (Guid.TryParse(value, out var id))
                {
                    parsed.Add(id);
                }
                else
                {
                    invalid.Add(value);
                }
            }

            return parsed;
        }

        private static bool IsUnresolved(string value, HashSet<Guid> unresolvedIds, HashSet<string> invalidIds)
            => invalidIds.Contains(value) || (Guid.TryParse(value, out var id) && unresolvedIds.Contains(id));

        private static bool HasProperty(JsonElement element, string name)
            => element.EnumerateObject().Any(property => string.Equals(property.Name, name, StringComparison.OrdinalIgnoreCase));

        private static void ValidatePersistedShape(JsonElement element)
        {
            string[] legacyRequired =
            {
                nameof(MaintenanceState.IsActive),
                nameof(MaintenanceState.Message),
                nameof(MaintenanceState.Action),
                nameof(MaintenanceState.StartedAt),
                nameof(MaintenanceState.EndsAt),
                nameof(MaintenanceState.AccountDisabledUserIds),
                nameof(MaintenanceState.RemoteDisabledUserIds)
            };
            foreach (var property in legacyRequired)
            {
                if (!HasProperty(element, property))
                {
                    throw new InvalidDataException($"The maintenance state is missing required property '{property}'.");
                }
            }

            if (GetProperty(element, nameof(MaintenanceState.AccountDisabledUserIds)).ValueKind != JsonValueKind.Array ||
                GetProperty(element, nameof(MaintenanceState.RemoteDisabledUserIds)).ValueKind != JsonValueKind.Array)
            {
                throw new InvalidDataException("Maintenance recovery ledgers must be JSON arrays.");
            }

            bool versioned = HasProperty(element, nameof(MaintenanceState.SchemaVersion));
            string[] versionedRequired =
            {
                nameof(MaintenanceState.Phase),
                nameof(MaintenanceState.FailureReason),
                nameof(MaintenanceState.RecoveryAvailable),
                nameof(MaintenanceState.RecoveryPhase)
            };
            if (versioned && versionedRequired.Any(property => !HasProperty(element, property)))
            {
                throw new InvalidDataException("The versioned maintenance state is incomplete.");
            }
        }

        private static JsonElement GetProperty(JsonElement element, string name)
        {
            foreach (var property in element.EnumerateObject())
            {
                if (string.Equals(property.Name, name, StringComparison.OrdinalIgnoreCase))
                {
                    return property.Value;
                }
            }

            throw new InvalidDataException($"The maintenance state is missing required property '{name}'.");
        }

        private static MaintenanceState CloneState(MaintenanceState state)
            => new()
            {
                SchemaVersion = state.SchemaVersion,
                Phase = state.Phase,
                IsActive = state.IsActive,
                Message = state.Message,
                Action = state.Action,
                StartedAt = state.StartedAt,
                EndsAt = state.EndsAt,
                AccountDisabledUserIds = state.AccountDisabledUserIds.ToList(),
                RemoteDisabledUserIds = state.RemoteDisabledUserIds.ToList(),
                FailureReason = state.FailureReason,
                RecoveryAvailable = state.RecoveryAvailable,
                RecoveryPhase = state.RecoveryPhase
            };

        private DateTime UtcNow() => _timeProvider.GetUtcNow().UtcDateTime;

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }

            lock (_timerSync)
            {
                _disposed = true;
                _stopping = true;
                _expiryTimer?.Dispose();
                _expiryTimer = null;
            }

            // SemaphoreSlim has no unmanaged resource. Do not dispose it here: if host shutdown
            // cancellation stopped waiting in StopAsync, an already-durable recovery transition
            // may still need to release the gate and finish safely in the background.
            GC.SuppressFinalize(this);
        }

        private sealed record StateReadResult(MaintenanceState? State, bool ArtifactExists, string? Failure);
    }
}
