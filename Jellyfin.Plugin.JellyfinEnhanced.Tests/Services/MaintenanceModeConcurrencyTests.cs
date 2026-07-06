using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Jellyfin.Data.Events;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Tests.TestDoubles;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Users;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinEnhanced.Tests.Services
{
    /// <summary>
    /// Regression net for CSSVC-4 (unlocked-EnableAsync half): the enable transition
    /// (LoadState → already-active check → per-user UpdatePolicyAsync → SaveState) spans
    /// awaits and used to run OUTSIDE any lock. Two concurrent EnableAsync calls (or an
    /// EnableAsync racing the auto-expiry DisableAsync) both read "inactive" and both
    /// proceed: user policies get double-applied and one SaveState clobbers the other's
    /// AccountDisabled/RemoteDisabled restore lists.
    ///
    /// The fix converts the mutual exclusion to a <c>SemaphoreSlim</c> gate held across the
    /// whole transition, so exactly one enable applies and the second observes the active
    /// state. This test fires two EnableAsync calls concurrently and asserts each target
    /// user's policy is updated at most once. (Confirmed RED by reverting the gate: the
    /// per-user policy update fires twice per user and the count assertion fails.)
    /// </summary>
    public class MaintenanceModeConcurrencyTests : IDisposable
    {
        private readonly string _baseDir;
        private readonly string _stateFilePath;

        public MaintenanceModeConcurrencyTests()
        {
            _baseDir = Path.Combine(Path.GetTempPath(), "je-maint-concurrency-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_baseDir);
            _stateFilePath = Path.Combine(_baseDir, "configurations", "Jellyfin.Plugin.JellyfinEnhanced", "maintenance-state.json");
        }

        public void Dispose()
        {
            try { Directory.Delete(_baseDir, recursive: true); } catch { /* best effort */ }
        }

        [Fact]
        public async Task ConcurrentEnable_AppliesEachUserAtMostOnce_AndKeepsRestoreList()
        {
            const int userCount = 5;
            var users = Enumerable.Range(0, userCount)
                .Select(i => new User($"user{i}", "Prov", "PwProv"))
                .ToList();

            var userManager = new RecordingUserManager(users, perUpdateDelayMs: 3);
            var service = new MaintenanceModeService(userManager, new StubAppPaths(_baseDir), NullLogger<MaintenanceModeService>.Instance);

            // Two enable requests race for the same (initially-inactive) state.
            var t1 = Task.Run(() => service.EnableAsync("maintenance", durationMinutes: 0, action: "disable_accounts", affectedUserIds: null));
            var t2 = Task.Run(() => service.EnableAsync("maintenance", durationMinutes: 0, action: "disable_accounts", affectedUserIds: null));
            await Task.WhenAll(t1, t2);

            // Each non-admin user must be disabled exactly once — never double-applied.
            Assert.Equal(userCount, userManager.DisabledCalls.Count);
            Assert.Equal(userCount, userManager.DisabledCalls.Distinct().Count());

            // The persisted restore list must hold every disabled user (nothing clobbered).
            Assert.True(File.Exists(_stateFilePath));
            var state = JsonSerializer.Deserialize<MaintenanceState>(
                File.ReadAllText(_stateFilePath),
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;

            Assert.True(state.IsActive);
            Assert.Equal(userCount, state.AccountDisabledUserIds.Distinct().Count());
            var expectedIds = users.Select(u => u.Id.ToString()).ToHashSet();
            Assert.True(state.AccountDisabledUserIds.All(id => expectedIds.Contains(id)));
        }

        /// <summary>
        /// Durability net: the enable path persists the restore intent (which users will be
        /// disabled) DURABLY before mutating a single account. If that save fails, the whole
        /// transition must abort with every account still enabled — never leave users
        /// disabled-with-no-restore-list (the old code disabled everyone first and silently
        /// swallowed the failed save). Confirmed RED by reverting to save-after-disable +
        /// swallowed failure: EnableAsync then completes without throwing and DisabledCalls == 3.
        /// </summary>
        [Fact]
        public async Task Enable_WhenStateSaveFails_AbortsBeforeDisablingAnyUser()
        {
            const int userCount = 3;
            var users = Enumerable.Range(0, userCount)
                .Select(i => new User($"user{i}", "Prov", "PwProv"))
                .ToList();

            var userManager = new RecordingUserManager(users, perUpdateDelayMs: 0);
            var service = new MaintenanceModeService(userManager, new StubAppPaths(_baseDir), NullLogger<MaintenanceModeService>.Instance);

            // Force the durable state save to fail: occupy the state-file path with a DIRECTORY so
            // AtomicFile's rename over it throws. The restore-intent save runs BEFORE any account is
            // mutated, so a failed save must abort with every user still enabled.
            Directory.CreateDirectory(Path.GetDirectoryName(_stateFilePath)!);
            Directory.CreateDirectory(_stateFilePath);

            await Assert.ThrowsAnyAsync<Exception>(() =>
                service.EnableAsync("maintenance", durationMinutes: 0, action: "disable_accounts", affectedUserIds: null));

            // Root-cause guarantee: nothing was disabled, so there is no disabled-with-no-restore-list state.
            Assert.Empty(userManager.DisabledCalls);
        }

        private sealed class RecordingUserManager : IUserManager
        {
            private readonly List<User> _users;
            private readonly int _perUpdateDelayMs;

            public RecordingUserManager(List<User> users, int perUpdateDelayMs)
            {
                _users = users;
                _perUpdateDelayMs = perUpdateDelayMs;
            }

            // Every userId passed to UpdatePolicyAsync with IsDisabled=true. A double-apply
            // shows up as the same id appearing twice → Count > userCount.
            public ConcurrentBag<Guid> DisabledCalls { get; } = new();

            public event EventHandler<GenericEventArgs<User>> OnUserUpdated { add { } remove { } }

            public IEnumerable<User> GetUsers() => _users;

            public User? GetUserById(Guid id) => _users.FirstOrDefault(u => u.Id == id);

            // Fresh policy per call so every enable sees the users as not-yet-disabled — that is
            // exactly the read-decide window the unlocked version double-entered.
            public UserDto GetUserDto(User user, string? remoteEndPoint = null)
                => new() { Policy = new UserPolicy { IsDisabled = false, EnableRemoteAccess = true } };

            public async Task UpdatePolicyAsync(Guid userId, UserPolicy policy)
            {
                if (_perUpdateDelayMs > 0)
                {
                    await Task.Delay(_perUpdateDelayMs).ConfigureAwait(false);
                }

                if (policy.IsDisabled)
                {
                    DisabledCalls.Add(userId);
                }
            }

            public IEnumerable<Guid> GetUsersIds() => throw new NotImplementedException();

            public Task InitializeAsync() => throw new NotImplementedException();

            public User? GetFirstUser() => throw new NotImplementedException();

            public User? GetUserByName(string name) => throw new NotImplementedException();

            public Task RenameUser(Guid userId, string oldName, string newName) => throw new NotImplementedException();

            public Task UpdateUserAsync(User user) => throw new NotImplementedException();

            public Task<User> CreateUserAsync(string name) => throw new NotImplementedException();

            public Task DeleteUserAsync(Guid userId) => throw new NotImplementedException();

            public Task ResetPassword(Guid userId) => throw new NotImplementedException();

            public Task ChangePassword(Guid userId, string newPassword) => throw new NotImplementedException();

            public Task<User?> AuthenticateUser(string username, string password, string remoteEndPoint, bool isUserSession) => throw new NotImplementedException();

            public Task<ForgotPasswordResult> StartForgotPasswordProcess(string enteredUsername, bool isInNetwork) => throw new NotImplementedException();

            public Task<PinRedeemResult> RedeemPasswordResetPin(string pin) => throw new NotImplementedException();

            public NameIdPair[] GetAuthenticationProviders() => throw new NotImplementedException();

            public NameIdPair[] GetPasswordResetProviders() => throw new NotImplementedException();

            public Task UpdateConfigurationAsync(Guid userId, UserConfiguration config) => throw new NotImplementedException();

            public Task ClearProfileImageAsync(User user) => throw new NotImplementedException();
        }
    }
}
