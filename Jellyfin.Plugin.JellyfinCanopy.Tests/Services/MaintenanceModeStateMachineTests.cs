using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Events;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Users;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services
{
    public sealed class MaintenanceModeStateMachineTests : IDisposable
    {
        private readonly string _baseDir;
        private readonly string _stateFilePath;
        private readonly string _recoveryFilePath;

        public MaintenanceModeStateMachineTests()
        {
            _baseDir = Path.Combine(Path.GetTempPath(), "jc-maint-state-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_baseDir);
            _stateFilePath = Path.Combine(
                _baseDir,
                "configurations",
                "Jellyfin.Plugin.JellyfinCanopy",
                "maintenance-state.json");
            _recoveryFilePath = _stateFilePath + ".recovery";
        }

        public void Dispose()
        {
            try
            {
                Directory.Delete(_baseDir, recursive: true);
            }
            catch
            {
                // Best-effort test cleanup.
            }
        }

        [Fact]
        public async Task CorruptPrimary_ReportsFaulted_AndRestoresFromRecoveryLedger()
        {
            var user = NewUser("recoverable");
            var users = new StateMachineUserManager(user);
            using (var first = CreateService(users))
            {
                await first.EnableAsync("maintenance", 0, "disable_accounts", null);
            }

            Assert.True(users.Policy(user.Id).IsDisabled);
            // Syntactically valid truncation is more dangerous than malformed JSON: without
            // strict shape validation it deserializes to a fresh IsActive=false object and can
            // overwrite the only complete recovery ledger.
            File.WriteAllText(_stateFilePath, "{\"IsActive\":false}");

            using var restarted = CreateService(users);
            var faulted = restarted.GetStatus();
            Assert.Equal(MaintenancePhases.Faulted, faulted.Phase);
            Assert.True(faulted.IsActive);
            Assert.True(faulted.RecoveryAvailable);
            Assert.Equal(MaintenancePhases.Active, faulted.RecoveryPhase);
            Assert.Equal(new[] { user.Id.ToString() }, faulted.AccountDisabledUserIds);

            await restarted.DisableAsync();

            Assert.False(users.Policy(user.Id).IsDisabled);
            Assert.Equal(MaintenancePhases.Inactive, restarted.GetStatus().Phase);
            Assert.Equal(MaintenancePhases.Inactive, ReadState(_stateFilePath).Phase);
        }

        [Fact]
        public async Task CorruptPrimaryAndRecovery_StayFaulted_AndRefuseMutation()
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_stateFilePath)!);
            File.WriteAllText(_stateFilePath, "{}");
            File.WriteAllText(_recoveryFilePath, "{\"IsActive\":false}");

            var primaryBytes = File.ReadAllBytes(_stateFilePath);
            var recoveryBytes = File.ReadAllBytes(_recoveryFilePath);
            using var service = CreateService(new StateMachineUserManager());

            var status = service.GetStatus();
            Assert.Equal(MaintenancePhases.Faulted, status.Phase);
            Assert.True(status.IsActive);
            Assert.False(status.RecoveryAvailable);
            await Assert.ThrowsAsync<InvalidOperationException>(() => service.DisableAsync());
            await Assert.ThrowsAsync<InvalidOperationException>(() =>
                service.EnableAsync("replacement", 0, "disable_accounts", null));
            Assert.Equal(primaryBytes, File.ReadAllBytes(_stateFilePath));
            Assert.Equal(recoveryBytes, File.ReadAllBytes(_recoveryFilePath));
        }

        [Fact]
        public async Task ExpiryRunsWithoutPolling_AndOneHundredStatusReadsObserveSingleFlightRestore()
        {
            var now = new DateTimeOffset(2026, 7, 14, 12, 0, 0, TimeSpan.Zero);
            var clock = new ManualTimeProvider(now);
            var user = NewUser("blocked-restore");
            var users = new StateMachineUserManager(user) { BlockRestores = true };
            using var service = CreateService(users, clock);
            await service.StartAsync(CancellationToken.None);
            await service.EnableAsync("maintenance", 1, "disable_accounts", null);

            clock.Advance(TimeSpan.FromMinutes(1));
            await users.RestoreStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));

            for (int i = 0; i < 100; i++)
            {
                var status = service.GetStatus();
                Assert.True(status.IsActive);
                Assert.Equal(MaintenancePhases.Restoring, status.Phase);
            }

            clock.Advance(TimeSpan.FromHours(1));
            Assert.Equal(1, users.RestoreCalls);
            users.ReleaseRestores();
            await service.WaitForBackgroundRestoreAsync().WaitAsync(TimeSpan.FromSeconds(5));

            Assert.Equal(1, users.RestoreCalls);
            Assert.False(users.Policy(user.Id).IsDisabled);
            Assert.Equal(MaintenancePhases.Inactive, service.GetStatus().Phase);
        }

        [Fact]
        public async Task RestoreFailure_IsDurableRetainsOnlyUnresolvedIds_AndDoesNotRetryAutomatically()
        {
            var now = new DateTimeOffset(2026, 7, 14, 12, 0, 0, TimeSpan.Zero);
            var clock = new ManualTimeProvider(now);
            var good = NewUser("good");
            var failed = NewUser("failed");
            var users = new StateMachineUserManager(good, failed);
            users.FailRestoreFor.Add(failed.Id);
            using var service = CreateService(users, clock);
            await service.StartAsync(CancellationToken.None);
            await service.EnableAsync("maintenance", 1, "disable_accounts", null);

            clock.Advance(TimeSpan.FromMinutes(1));
            await service.WaitForBackgroundRestoreAsync().WaitAsync(TimeSpan.FromSeconds(5));

            var status = service.GetStatus();
            Assert.Equal(MaintenancePhases.RestoreFailed, status.Phase);
            Assert.True(status.IsActive);
            Assert.Equal(new[] { failed.Id.ToString() }, status.AccountDisabledUserIds);
            Assert.Equal(MaintenancePhases.RestoreFailed, ReadState(_stateFilePath).Phase);
            Assert.Equal(new[] { failed.Id.ToString() }, ReadState(_recoveryFilePath).AccountDisabledUserIds);
            Assert.False(users.Policy(good.Id).IsDisabled);
            Assert.True(users.Policy(failed.Id).IsDisabled);

            int callsAfterFailure = users.RestoreCalls;
            clock.Advance(TimeSpan.FromDays(7));
            Assert.Equal(callsAfterFailure, users.RestoreCalls);
        }

        [Fact]
        public async Task ExpiryThatQueuedBehindAnExtension_DoesNotCancelTheNewDeadlineOrRestoreEarly()
        {
            var now = new DateTimeOffset(2026, 7, 14, 12, 0, 0, TimeSpan.Zero);
            var clock = new ManualTimeProvider(now);
            var user = NewUser("extended");
            var users = new StateMachineUserManager(user);
            using var extensionWriterEntered = new ManualResetEventSlim();
            using var releaseExtensionWriter = new ManualResetEventSlim();
            bool blockExtendedActiveWrite = false;

            void BlockingWriter(string path, string json)
            {
                var state = JsonSerializer.Deserialize<MaintenanceState>(json, PersistedJson.ReadOptions)!;
                if (blockExtendedActiveWrite &&
                    path == _recoveryFilePath &&
                    state.Phase == MaintenancePhases.Active)
                {
                    blockExtendedActiveWrite = false;
                    extensionWriterEntered.Set();
                    releaseExtensionWriter.Wait(TimeSpan.FromSeconds(5));
                }

                AtomicFile.WriteAllText(path, json);
            }

            using var service = CreateService(users, clock, BlockingWriter);
            await service.StartAsync(CancellationToken.None);
            await service.EnableAsync("maintenance", 1, "disable_accounts", null);
            blockExtendedActiveWrite = true;

            var extension = Task.Run(() =>
                service.EnableAsync("extended", 10, "disable_accounts", null));
            Assert.True(extensionWriterEntered.Wait(TimeSpan.FromSeconds(5)));

            // The old timer fires while the extension owns the state gate. Its queued recovery
            // must re-read the later EndsAt after it wins the gate, not act like a manual disable.
            clock.Advance(TimeSpan.FromMinutes(1));
            var staleScheduledRecovery = service.WaitForBackgroundRestoreAsync();
            Assert.False(staleScheduledRecovery.IsCompleted);
            releaseExtensionWriter.Set();
            await extension.WaitAsync(TimeSpan.FromSeconds(5));
            await staleScheduledRecovery.WaitAsync(TimeSpan.FromSeconds(5));

            var status = service.GetStatus();
            Assert.Equal(MaintenancePhases.Active, status.Phase);
            Assert.True(status.EndsAt > clock.GetUtcNow().UtcDateTime);
            Assert.True(users.Policy(user.Id).IsDisabled);
            Assert.Equal(0, users.RestoreCalls);
        }

        [Fact]
        public async Task StopCancellation_DoesNotHangOnBlockedRestore_AndRecoveryCanFinishSafely()
        {
            var clock = new ManualTimeProvider(new DateTimeOffset(2026, 7, 14, 12, 0, 0, TimeSpan.Zero));
            var user = NewUser("shutdown");
            var users = new StateMachineUserManager(user) { BlockRestores = true };
            using var service = CreateService(users, clock);
            await service.StartAsync(CancellationToken.None);
            await service.EnableAsync("maintenance", 1, "disable_accounts", null);
            clock.Advance(TimeSpan.FromMinutes(1));
            await users.RestoreStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));

            using var cancelled = new CancellationTokenSource();
            cancelled.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => service.StopAsync(cancelled.Token));
            Assert.Equal(MaintenancePhases.Restoring, service.GetStatus().Phase);

            users.ReleaseRestores();
            await service.WaitForBackgroundRestoreAsync().WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(MaintenancePhases.Inactive, service.GetStatus().Phase);
        }

        [Fact]
        public async Task MissingAndNullPolicyUsersRemainRecoverable_ButConfirmedDeletedUserIsRetired()
        {
            var transientMissing = NewUser("transient");
            var nullPolicy = NewUser("null-policy");
            var deletedId = Guid.NewGuid();
            var users = new StateMachineUserManager(transientMissing, nullPolicy);
            users.ReturnNullFromLookupFor.Add(transientMissing.Id);
            users.ReturnNullPolicyFor.Add(nullPolicy.Id);
            SeedState(new MaintenanceState
            {
                Phase = MaintenancePhases.Active,
                IsActive = true,
                Message = "maintenance",
                StartedAt = DateTime.UtcNow,
                AccountDisabledUserIds = new List<string>
                {
                    transientMissing.Id.ToString(),
                    nullPolicy.Id.ToString(),
                    deletedId.ToString()
                },
                RecoveryAvailable = true
            });

            using var service = CreateService(users);
            await Assert.ThrowsAsync<InvalidOperationException>(() => service.DisableAsync());

            var persisted = ReadState(_stateFilePath);
            Assert.Equal(MaintenancePhases.RestoreFailed, persisted.Phase);
            Assert.Contains(transientMissing.Id.ToString(), persisted.AccountDisabledUserIds);
            Assert.Contains(nullPolicy.Id.ToString(), persisted.AccountDisabledUserIds);
            Assert.DoesNotContain(deletedId.ToString(), persisted.AccountDisabledUserIds);
        }

        [Fact]
        public async Task FinalOutcomeWriteFailure_PersistsRestoreFailedWithCompleteLedger()
        {
            var user = NewUser("final-write");
            var users = new StateMachineUserManager(user);
            bool failInactivePrimaryOnce = true;
            void WriteWithOneShotFailure(string path, string json)
            {
                var phase = JsonSerializer.Deserialize<MaintenanceState>(json, PersistedJson.ReadOptions)?.Phase;
                if (path == _stateFilePath && phase == MaintenancePhases.Inactive && failInactivePrimaryOnce)
                {
                    failInactivePrimaryOnce = false;
                    throw new IOException("injected final primary failure");
                }

                AtomicFile.WriteAllText(path, json);
            }

            using var service = CreateService(users, TimeProvider.System, WriteWithOneShotFailure);
            await service.EnableAsync("maintenance", 0, "disable_accounts", null);
            await Assert.ThrowsAsync<IOException>(() => service.DisableAsync());

            Assert.False(users.Policy(user.Id).IsDisabled);
            var primary = ReadState(_stateFilePath);
            var recovery = ReadState(_recoveryFilePath);
            Assert.Equal(MaintenancePhases.RestoreFailed, primary.Phase);
            Assert.Equal(MaintenancePhases.RestoreFailed, recovery.Phase);
            Assert.Equal(new[] { user.Id.ToString() }, primary.AccountDisabledUserIds);
            Assert.Equal(primary.AccountDisabledUserIds, recovery.AccountDisabledUserIds);
        }

        [Fact]
        public async Task RestartDuringRestoring_ResumesOneDeterministicRecovery()
        {
            var clock = new ManualTimeProvider(new DateTimeOffset(2026, 7, 14, 12, 0, 0, TimeSpan.Zero));
            var user = NewUser("restart");
            var users = new StateMachineUserManager(user);
            users.Policy(user.Id).IsDisabled = true;
            SeedState(new MaintenanceState
            {
                Phase = MaintenancePhases.Restoring,
                IsActive = true,
                Message = "maintenance",
                StartedAt = clock.GetUtcNow().UtcDateTime,
                AccountDisabledUserIds = new List<string> { user.Id.ToString() },
                RecoveryAvailable = true
            });

            using var service = CreateService(users, clock);
            await service.StartAsync(CancellationToken.None);
            clock.Advance(TimeSpan.Zero);
            await service.WaitForBackgroundRestoreAsync().WaitAsync(TimeSpan.FromSeconds(5));

            Assert.Equal(1, users.RestoreCalls);
            Assert.False(users.Policy(user.Id).IsDisabled);
            Assert.Equal(MaintenancePhases.Inactive, service.GetStatus().Phase);
        }

        private MaintenanceModeService CreateService(
            StateMachineUserManager users,
            TimeProvider? timeProvider = null,
            Action<string, string>? writer = null)
            => new(
                users,
                new StubAppPaths(_baseDir),
                NullLogger<MaintenanceModeService>.Instance,
                timeProvider ?? TimeProvider.System,
                writer ?? AtomicFile.WriteAllText);

        private void SeedState(MaintenanceState state)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_stateFilePath)!);
            var json = JsonSerializer.Serialize(state, PersistedJson.WriteOptions);
            AtomicFile.WriteAllText(_stateFilePath, json);
            AtomicFile.WriteAllText(_recoveryFilePath, json);
        }

        private static MaintenanceState ReadState(string path)
            => JsonSerializer.Deserialize<MaintenanceState>(File.ReadAllText(path), PersistedJson.ReadOptions)!;

        private static User NewUser(string name) => new(name, "Prov", "PwProv");

        private sealed class StateMachineUserManager : IUserManager
        {
            private readonly Dictionary<Guid, User> _users;
            private readonly Dictionary<Guid, UserPolicy> _policies;
            private readonly TaskCompletionSource _releaseRestores = new(TaskCreationOptions.RunContinuationsAsynchronously);

            public StateMachineUserManager(params User[] users)
            {
                _users = users.ToDictionary(user => user.Id);
                _policies = users.ToDictionary(
                    user => user.Id,
                    _ => new UserPolicy { IsDisabled = false, EnableRemoteAccess = true });
            }

            public bool BlockRestores { get; set; }
            public int RestoreCalls { get; private set; }
            public HashSet<Guid> FailRestoreFor { get; } = new();
            public HashSet<Guid> ReturnNullFromLookupFor { get; } = new();
            public HashSet<Guid> ReturnNullPolicyFor { get; } = new();
            public TaskCompletionSource RestoreStarted { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

            public event EventHandler<GenericEventArgs<User>> OnUserUpdated { add { } remove { } }

            public UserPolicy Policy(Guid id) => _policies[id];

            public void ReleaseRestores() => _releaseRestores.TrySetResult();

            public IEnumerable<User> GetUsers() => _users.Values;

            public User? GetUserById(Guid id)
                => ReturnNullFromLookupFor.Contains(id) ? null : _users.GetValueOrDefault(id);

            public UserDto GetUserDto(User user, string? remoteEndPoint = null)
                => new()
                {
                    Policy = ReturnNullPolicyFor.Contains(user.Id)
                        ? null
                        : new UserPolicy
                        {
                            IsDisabled = _policies[user.Id].IsDisabled,
                            EnableRemoteAccess = _policies[user.Id].EnableRemoteAccess
                        }
                };

            public async Task UpdatePolicyAsync(Guid userId, UserPolicy policy)
            {
                bool restoring = !policy.IsDisabled && _policies[userId].IsDisabled;
                if (restoring)
                {
                    RestoreCalls++;
                    RestoreStarted.TrySetResult();
                    if (BlockRestores)
                    {
                        await _releaseRestores.Task.ConfigureAwait(false);
                    }

                    if (FailRestoreFor.Contains(userId))
                    {
                        throw new InvalidOperationException("injected restore failure");
                    }
                }

                _policies[userId] = new UserPolicy
                {
                    IsDisabled = policy.IsDisabled,
                    EnableRemoteAccess = policy.EnableRemoteAccess
                };
            }

            public IEnumerable<Guid> GetUsersIds() => _users.Keys;
            public Task InitializeAsync() => Task.CompletedTask;
            public User? GetFirstUser() => _users.Values.FirstOrDefault();
            public User? GetUserByName(string name) => _users.Values.FirstOrDefault(user => user.Username == name);
            public Task RenameUser(Guid userId, string oldName, string newName) => throw new NotImplementedException();
            public Task UpdateUserAsync(User user) => throw new NotImplementedException();
            public Task<User> CreateUserAsync(string name) => throw new NotImplementedException();
            public Task DeleteUserAsync(Guid userId) => throw new NotImplementedException();
            public Task ResetPassword(Guid userId) => throw new NotImplementedException();
            public Task ChangePassword(Guid userId, string newPassword) => throw new NotImplementedException();
            public Task<User?> AuthenticateUser(string username, string password, string remoteEndPoint, bool isUserSession) => throw new NotImplementedException();
            public Task<ForgotPasswordResult> StartForgotPasswordProcess(string enteredUsername, bool isInNetwork) => throw new NotImplementedException();
            public Task<PinRedeemResult> RedeemPasswordResetPin(string pin) => throw new NotImplementedException();
            public NameIdPair[] GetAuthenticationProviders() => Array.Empty<NameIdPair>();
            public NameIdPair[] GetPasswordResetProviders() => Array.Empty<NameIdPair>();
            public Task UpdateConfigurationAsync(Guid userId, UserConfiguration config) => throw new NotImplementedException();
            public Task ClearProfileImageAsync(User user) => throw new NotImplementedException();
        }

        private sealed class ManualTimeProvider : TimeProvider
        {
            private readonly object _sync = new();
            private readonly List<ManualTimer> _timers = new();
            private DateTimeOffset _now;

            public ManualTimeProvider(DateTimeOffset now)
            {
                _now = now;
            }

            public override DateTimeOffset GetUtcNow()
            {
                lock (_sync)
                {
                    return _now;
                }
            }

            public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
            {
                var timer = new ManualTimer(this, callback, state, dueTime, period);
                lock (_sync)
                {
                    _timers.Add(timer);
                }

                return timer;
            }

            public void Advance(TimeSpan amount)
            {
                List<ManualTimer> due;
                lock (_sync)
                {
                    _now = _now.Add(amount);
                    due = _timers.Where(timer => timer.IsDue(_now)).ToList();
                }

                foreach (var timer in due)
                {
                    timer.Fire();
                }
            }

            private sealed class ManualTimer : ITimer
            {
                private readonly ManualTimeProvider _owner;
                private readonly TimerCallback _callback;
                private readonly object? _state;
                private TimeSpan _period;
                private DateTimeOffset _dueAt;
                private bool _disposed;

                public ManualTimer(
                    ManualTimeProvider owner,
                    TimerCallback callback,
                    object? state,
                    TimeSpan dueTime,
                    TimeSpan period)
                {
                    _owner = owner;
                    _callback = callback;
                    _state = state;
                    _period = period;
                    _dueAt = owner.GetUtcNow().Add(dueTime);
                }

                public bool IsDue(DateTimeOffset now) => !_disposed && _dueAt <= now;

                public void Fire()
                {
                    if (_disposed)
                    {
                        return;
                    }

                    if (_period == Timeout.InfiniteTimeSpan)
                    {
                        _disposed = true;
                    }
                    else
                    {
                        _dueAt = _dueAt.Add(_period);
                    }

                    _callback(_state);
                }

                public bool Change(TimeSpan dueTime, TimeSpan period)
                {
                    if (_disposed)
                    {
                        return false;
                    }

                    _period = period;
                    _dueAt = _owner.GetUtcNow().Add(dueTime);
                    return true;
                }

                public void Dispose() => _disposed = true;

                public ValueTask DisposeAsync()
                {
                    Dispose();
                    return ValueTask.CompletedTask;
                }
            }
        }
    }
}
