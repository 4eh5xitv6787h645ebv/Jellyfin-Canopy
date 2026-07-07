using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Jellyfin.Data.Events;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinElevate.Services;
using Jellyfin.Plugin.JellyfinElevate.Tests.TestDoubles;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Users;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.Services
{
    /// <summary>
    /// Durability net for the disable path: when one user's restore throws mid-loop (caught +
    /// logged + continue), the state must NOT be blanket-cleared — that would leave that user
    /// disabled/remote-blocked with NO restore record. The failed user must stay in the persisted
    /// (still-active) restore list so a later retry / restart can recover them, while every
    /// successfully-restored user's record is cleared.
    ///
    /// Confirmed RED by reverting DisableAsync to the unconditional
    /// <c>SaveState(new MaintenanceState { IsActive = false })</c>: the persisted state then has
    /// IsActive=false and an empty list, stranding the failed user.
    /// </summary>
    public class MaintenanceModeRestoreTests : IDisposable
    {
        private readonly string _baseDir;
        private readonly string _stateFilePath;

        public MaintenanceModeRestoreTests()
        {
            _baseDir = Path.Combine(Path.GetTempPath(), "je-maint-restore-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_baseDir);
            _stateFilePath = Path.Combine(_baseDir, "configurations", "Jellyfin.Plugin.JellyfinElevate", "maintenance-state.json");
        }

        public void Dispose()
        {
            try { Directory.Delete(_baseDir, recursive: true); } catch { /* best effort */ }
        }

        [Fact]
        public async Task Disable_WhenOneUserRestoreFails_KeepsThatUsersRecord_AndClearsTheRest()
        {
            var users = Enumerable.Range(0, 3)
                .Select(i => new User($"user{i}", "Prov", "PwProv"))
                .ToList();
            var failUser = users[1];

            var userManager = new RestoreFailingUserManager(users, failRestoreFor: failUser.Id);
            var service = new MaintenanceModeService(userManager, new StubAppPaths(_baseDir), NullLogger<MaintenanceModeService>.Instance);

            // Enable disables all three accounts and persists the full restore list.
            await service.EnableAsync("maintenance", durationMinutes: 0, action: "disable_accounts", affectedUserIds: null);

            // Disable: user1's restore throws; the other two restore fine.
            await service.DisableAsync();

            Assert.True(File.Exists(_stateFilePath));
            var state = JsonSerializer.Deserialize<MaintenanceState>(
                File.ReadAllText(_stateFilePath),
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;

            // The failed user's record survives so a retry/restart can still re-enable them...
            Assert.True(state.IsActive);
            Assert.Equal(new[] { failUser.Id.ToString() }, state.AccountDisabledUserIds.ToArray());

            // ...and the two successfully-restored users' records are cleared.
            Assert.DoesNotContain(users[0].Id.ToString(), state.AccountDisabledUserIds);
            Assert.DoesNotContain(users[2].Id.ToString(), state.AccountDisabledUserIds);

            // The two that succeeded were actually restored; the failing one was attempted and threw.
            Assert.Equal(2, userManager.RestoredOk.Count);
            Assert.Contains(users[0].Id, userManager.RestoredOk);
            Assert.Contains(users[2].Id, userManager.RestoredOk);
        }

        /// <summary>
        /// Minimal <see cref="IUserManager"/> fake that disables cleanly but throws when restoring
        /// a chosen user. The enable phase sets IsDisabled=true; the restore phase sets it false, so
        /// the double distinguishes the two by the policy value it receives.
        /// </summary>
        private sealed class RestoreFailingUserManager : IUserManager
        {
            private readonly List<User> _users;
            private readonly Guid _failRestoreFor;

            public RestoreFailingUserManager(List<User> users, Guid failRestoreFor)
            {
                _users = users;
                _failRestoreFor = failRestoreFor;
            }

            /// <summary>User ids whose restore (IsDisabled=false) was applied successfully.</summary>
            public List<Guid> RestoredOk { get; } = new();

            public event EventHandler<GenericEventArgs<User>> OnUserUpdated { add { } remove { } }

            public IEnumerable<User> GetUsers() => _users;

            public User? GetUserById(Guid id) => _users.FirstOrDefault(u => u.Id == id);

            public UserDto GetUserDto(User user, string? remoteEndPoint = null)
                => new() { Policy = new UserPolicy { IsDisabled = false, EnableRemoteAccess = true } };

            public Task UpdatePolicyAsync(Guid userId, UserPolicy policy)
            {
                // Restore phase clears IsDisabled; enable phase sets it. Only fail on restore.
                if (!policy.IsDisabled)
                {
                    if (userId == _failRestoreFor)
                    {
                        throw new InvalidOperationException("restore boom");
                    }

                    RestoredOk.Add(userId);
                }

                return Task.CompletedTask;
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
