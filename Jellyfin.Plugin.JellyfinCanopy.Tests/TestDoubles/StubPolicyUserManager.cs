using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Jellyfin.Data.Events;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Users;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;

/// <summary>
/// Policy-aware <see cref="IUserManager"/> fake: resolves each guid to its own
/// (User, UserPolicy) pair, with GetUserDto keyed by reference to the exact User
/// GetUserById returned — so per-caller policy mixups fail loudly. Extracted from
/// SeerrParentalFilterTests so the rating and tag suites share one copy.
/// </summary>
    public sealed class StubPolicyUserManager : IUserManager
    {
        private readonly IReadOnlyDictionary<Guid, (User User, UserPolicy Policy)> _users;

        public StubPolicyUserManager(IReadOnlyDictionary<Guid, (User User, UserPolicy Policy)> users)
        {
            _users = users;
        }

        /// <summary>Single-user convenience.</summary>
        public StubPolicyUserManager(Guid id, User user, UserPolicy policy)
            : this(new Dictionary<Guid, (User User, UserPolicy Policy)> { [id] = (user, policy) })
        {
        }

        public event EventHandler<GenericEventArgs<User>> OnUserUpdated { add { } remove { } }

        // Resolve the ACTUAL user for this id — not a fixed one. A caller→user mixup
        // (hardcoded id, admin's policy, dropped mapping) now surfaces as null here,
        // which fails the gate loudly instead of silently applying the wrong limits.
        public User? GetUserById(Guid id) => _users.TryGetValue(id, out var entry) ? entry.User : null;

        // Policy is keyed to the SAME user object GetUserById returned (reference match),
        // so each caller's own BlockUnratedItems is applied — never a shared one.
        public UserDto GetUserDto(User user, string? remoteEndPoint = null)
        {
            foreach (var entry in _users.Values)
            {
                if (ReferenceEquals(entry.User, user))
                {
                    return new UserDto { Policy = entry.Policy };
                }
            }

            throw new InvalidOperationException($"GetUserDto called for an unregistered user '{user.Username}'.");
        }

        public IEnumerable<User> GetUsers() => throw new NotImplementedException();

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

        public Task UpdatePolicyAsync(Guid userId, UserPolicy policy) => throw new NotImplementedException();

        public Task ClearProfileImageAsync(User user) => throw new NotImplementedException();
    }
