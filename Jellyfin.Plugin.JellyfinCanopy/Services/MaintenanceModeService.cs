using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Library;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services
{
    public class MaintenanceState
    {
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
    }

    public class MaintenanceModeService
    {
        private readonly IUserManager _userManager;
        private readonly ILogger<MaintenanceModeService> _logger;
        private readonly string _stateFilePath;
        // Async-compatible mutual exclusion: the enable/disable state transitions
        // (LoadState → decide → per-user UpdatePolicyAsync → SaveState) span awaits, so a
        // plain lock won't do. This singleton holds one gate; leaving it undisposed for the
        // app-lifetime singleton is intentional (matches the plugin's other singletons).
        private readonly SemaphoreSlim _stateGate = new(1, 1);

        public MaintenanceModeService(IUserManager userManager, IApplicationPaths appPaths, ILogger<MaintenanceModeService> logger)
        {
            _userManager = userManager;
            _logger = logger;
            var dir = Path.Combine(appPaths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinCanopy");
            Directory.CreateDirectory(dir);
            _stateFilePath = Path.Combine(dir, "maintenance-state.json");
        }

        public MaintenanceState GetStatus()
        {
            var state = LoadState();
            if (state.IsActive && state.EndsAt.HasValue && DateTime.UtcNow >= state.EndsAt.Value)
            {
                _ = Task.Run(() => DisableAsync());
                return new MaintenanceState { IsActive = false };
            }
            return state;
        }

        /// <param name="action">"disable_accounts" | "disable_remote" | "both"</param>
        /// <param name="affectedUserIds">Specific user IDs to affect; null or empty = all non-admin users.</param>
        public async Task EnableAsync(string message, int durationMinutes, string action, List<string>? affectedUserIds)
        {
            // Serialize the whole read-decide-apply-write transition so two concurrent
            // EnableAsync calls (or an EnableAsync racing the auto-expiry DisableAsync)
            // can't both proceed off the same stale state — which would double-apply user
            // policy changes and clobber the AccountDisabled/RemoteDisabled restore lists.
            await _stateGate.WaitAsync().ConfigureAwait(false);
            try
            {
                var currentState = LoadState();
                if (currentState.IsActive)
                {
                    // Already active — just update message/duration; do not re-apply user changes.
                    // A failed save throws (SaveState no longer swallows) so the caller sees the
                    // failure rather than a false success.
                    currentState.Message = message ?? string.Empty;
                    currentState.EndsAt = durationMinutes > 0 ? DateTime.UtcNow.AddMinutes(durationMinutes) : null;
                    SaveState(currentState);
                    _logger.LogInformation("[Maintenance] Message/duration updated (already active).");
                    return;
                }

                bool doAccounts = action == "disable_accounts" || action == "both";
                bool doRemote   = action == "disable_remote"   || action == "both";

                // Build the target user set: all non-admin users, filtered to the selection
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
                        .Select(s => Guid.TryParse(s, out var g) ? g : Guid.Empty)
                        .Where(g => g != Guid.Empty)
                        .ToHashSet();
                    targetUsers = allNonAdmin.Where(u => idSet.Contains(u.Id));
                }

                // Pass 1 — plan the mutations WITHOUT touching any account. Resolve each user's
                // current policy and record only the users we would actually change (accounts not
                // already disabled / remote not already off). This set IS the restore list.
                var plan = new List<(Guid Id, string Username, MediaBrowser.Model.Users.UserPolicy Policy, bool DisableAccount, bool DisableRemote)>();
                foreach (var user in targetUsers)
                {
                    try
                    {
                        var dto = _userManager.GetUserDto(user, string.Empty);
                        if (dto.Policy == null) continue;

                        bool disableAccount = doAccounts && !dto.Policy.IsDisabled;
                        bool disableRemote  = doRemote  && dto.Policy.EnableRemoteAccess;
                        if (disableAccount || disableRemote)
                        {
                            plan.Add((user.Id, user.Username, dto.Policy, disableAccount, disableRemote));
                        }
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError($"[Maintenance] Failed to read policy for user '{user.Username}': {ex.Message}");
                    }
                }

                var accountDisabled = plan.Where(p => p.DisableAccount).Select(p => p.Id.ToString()).ToList();
                var remoteDisabled  = plan.Where(p => p.DisableRemote).Select(p => p.Id.ToString()).ToList();

                var newState = new MaintenanceState
                {
                    IsActive = true,
                    Message  = message ?? string.Empty,
                    Action   = action ?? "disable_accounts",
                    StartedAt = DateTime.UtcNow,
                    EndsAt   = durationMinutes > 0 ? DateTime.UtcNow.AddMinutes(durationMinutes) : null,
                    AccountDisabledUserIds = accountDisabled,
                    RemoteDisabledUserIds  = remoteDisabled
                };

                // Persist the restore intent DURABLY *before* mutating a single account. If this
                // throws we abort with every account still untouched — we never disable users
                // without a recoverable record of how to restore them. (Previously the save ran
                // AFTER disabling and silently swallowed failures, stranding disabled accounts
                // with no restore list.)
                SaveState(newState);

                // Pass 2 — apply the planned mutations. The restore list is already on disk, so a
                // crash mid-loop leaves a recoverable (still-active) state: the next disable restores
                // every listed user, and re-enabling an account we never got to touch is a no-op.
                foreach (var (id, username, policy, disableAccount, disableRemote) in plan)
                {
                    try
                    {
                        if (disableAccount) policy.IsDisabled = true;
                        if (disableRemote)  policy.EnableRemoteAccess = false;
                        await _userManager.UpdatePolicyAsync(id, policy).ConfigureAwait(false);
                        _logger.LogInformation($"[Maintenance] Updated user '{username}'" +
                            $"{(disableAccount ? " (account disabled)" : "")}" +
                            $"{(disableRemote ? " (remote disabled)" : "")}");
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError($"[Maintenance] Failed to update user '{username}': {ex.Message}");
                    }
                }

                _logger.LogInformation($"[Maintenance] Mode enabled. Action={action}, " +
                    $"AccountsDisabled={accountDisabled.Count}, RemoteDisabled={remoteDisabled.Count}");
            }
            finally
            {
                _stateGate.Release();
            }
        }

        public async Task DisableAsync()
        {
            // Hold the gate across the WHOLE transition — including the restore loop — so a
            // concurrent EnableAsync can't interleave with an in-flight restore and re-toggle the
            // same accounts. A SemaphoreSlim is async-compatible, so spanning the awaits is fine.
            await _stateGate.WaitAsync().ConfigureAwait(false);
            try
            {
                var state = LoadState();
                if (!state.IsActive)
                {
                    _logger.LogInformation("[Maintenance] Already inactive — skipping disable.");
                    return;
                }

                // Collect all unique user IDs that need updating
                var allIds = state.AccountDisabledUserIds
                    .Union(state.RemoteDisabledUserIds)
                    .Distinct()
                    .ToList();

                var accountSet = new HashSet<string>(state.AccountDisabledUserIds);
                var remoteSet  = new HashSet<string>(state.RemoteDisabledUserIds);

                // Restore users FIRST, while the durable state still holds the full restore list.
                // Previously we wrote IsActive=false (which also clears the restore list) BEFORE
                // restoring, so a crash mid-restore left an inactive state with an empty list and
                // stranded the still-disabled accounts. Now the state stays active-with-list until
                // every restore has been applied.
                //
                // Track the users whose restore actually THREW: their UpdatePolicyAsync failed, so
                // they are still disabled/remote-blocked. We must NOT clear their restore record
                // below — that would strand them with nothing to restore from — so they stay in the
                // persisted (still-active) list for a later retry / restart.
                var failedIds = new HashSet<string>();
                foreach (var idStr in allIds)
                {
                    if (!Guid.TryParse(idStr, out var userId)) continue;
                    try
                    {
                        var user = _userManager.GetUserById(userId);
                        if (user == null) continue;

                        var dto = _userManager.GetUserDto(user, string.Empty);
                        if (dto.Policy == null) continue;

                        if (accountSet.Contains(idStr)) dto.Policy.IsDisabled = false;
                        if (remoteSet.Contains(idStr))  dto.Policy.EnableRemoteAccess = true;

                        await _userManager.UpdatePolicyAsync(userId, dto.Policy).ConfigureAwait(false);
                        _logger.LogInformation($"[Maintenance] Restored user '{user.Username}'");
                    }
                    catch (Exception ex)
                    {
                        failedIds.Add(idStr);
                        _logger.LogError($"[Maintenance] Failed to restore user {idStr}: {ex.Message}");
                    }
                }

                // Clear the restore records ONLY for the users we actually restored. If every restore
                // succeeded the state is fully cleared (IsActive=false). If some threw, keep those
                // users — and only those — in a still-active state so the next disable / a restart
                // retries them (IsDisabled=false / EnableRemoteAccess=true is idempotent). A failed
                // restore therefore never drops the record that would let us recover the user.
                MaintenanceState clearedState;
                if (failedIds.Count == 0)
                {
                    clearedState = new MaintenanceState { IsActive = false };
                    _logger.LogInformation("[Maintenance] Mode disabled.");
                }
                else
                {
                    clearedState = new MaintenanceState
                    {
                        IsActive = true,
                        Message = state.Message,
                        Action = state.Action,
                        StartedAt = state.StartedAt,
                        EndsAt = state.EndsAt,
                        AccountDisabledUserIds = state.AccountDisabledUserIds.Where(failedIds.Contains).ToList(),
                        RemoteDisabledUserIds = state.RemoteDisabledUserIds.Where(failedIds.Contains).ToList()
                    };
                    _logger.LogWarning($"[Maintenance] Mode disable incomplete: {failedIds.Count} user(s) could not be restored and stay in the restore list for a later retry.");
                }

                // Persist the outcome durably. If this write fails the state stays as it was on disk
                // (full restore list, still active) and the next disable simply restores again
                // (idempotent), so a failure here is self-healing rather than stranding disabled
                // accounts.
                try
                {
                    SaveState(clearedState);
                }
                catch (Exception ex)
                {
                    _logger.LogError($"[Maintenance] Failed to persist cleared state (restores already applied; will retry on next disable): {ex.Message}");
                }
            }
            finally
            {
                _stateGate.Release();
            }
        }

        private MaintenanceState LoadState()
        {
            try
            {
                if (!File.Exists(_stateFilePath)) return new MaintenanceState();
                var json = File.ReadAllText(_stateFilePath);
                // Newtonsoft equivalent: JsonConvert.DeserializeObject<MaintenanceState>(json).
                return JsonSerializer.Deserialize<MaintenanceState>(json, PersistedJson.ReadOptions) ?? new MaintenanceState();
            }
            catch (Exception ex)
            {
                _logger.LogError($"[Maintenance] Failed to load state: {ex.Message}");
                return new MaintenanceState();
            }
        }

        private void SaveState(MaintenanceState state)
        {
            // Intentionally does NOT swallow write failures. The enable path persists the restore
            // intent BEFORE mutating accounts and must be able to abort the whole transition when
            // the save fails — a lost state save would otherwise strand disabled users with no
            // restore list. Callers that can tolerate a save failure (the disable-path final clear)
            // catch this explicitly.
            // Newtonsoft equivalent: JsonConvert.SerializeObject(state, Formatting.Indented).
            AtomicFile.WriteAllText(_stateFilePath, JsonSerializer.Serialize(state, PersistedJson.WriteOptions));
        }
    }
}
