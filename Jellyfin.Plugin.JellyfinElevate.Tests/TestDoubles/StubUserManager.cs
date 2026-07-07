using Jellyfin.Data.Events;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Users;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.TestDoubles;

/// <summary>
/// Minimal <see cref="IUserManager"/> fake exposing a fixed user set via <see cref="GetUsers"/>
/// (default empty). Every other member throws, matching the repo's NotImplemented-stub convention.
/// </summary>
public sealed class StubUserManager : IUserManager
{
    private readonly List<User> _users;

    public StubUserManager(params User[] users) => _users = users.ToList();

    /// <summary>Mutates the fixed user set — used by identity-cache invalidation tests.</summary>
    public void AddUser(User user) => _users.Add(user);

    public event EventHandler<GenericEventArgs<User>> OnUserUpdated { add { } remove { } }

    public IEnumerable<User> GetUsers() => _users;

    public User? GetUserById(Guid id) => _users.FirstOrDefault(u => u.Id == id);

    // ---- Everything below is an unused NotImplemented stub (per the repo convention). ----

    public UserDto GetUserDto(User user, string? remoteEndPoint = null) => throw new NotImplementedException();

    public Task UpdatePolicyAsync(Guid userId, UserPolicy policy) => throw new NotImplementedException();

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
