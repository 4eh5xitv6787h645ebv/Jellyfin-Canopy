using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Entities.Security;
using MediaBrowser.Controller.Authentication;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Session;
using MediaBrowser.Model.SyncPlay;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.TestDoubles;

/// <summary>
/// Minimal <see cref="ISessionManager"/> fake for the monitor-idempotency tests. Only the two
/// playback events the auto-request monitors subscribe to are real: each keeps a backing delegate
/// so the test can read the true subscriber count. Every other member throws, matching the repo's
/// NotImplemented-stub convention.
/// </summary>
public sealed class CountingSessionManager : ISessionManager
{
    private EventHandler<PlaybackProgressEventArgs>? _playbackProgress;
    private EventHandler<PlaybackStopEventArgs>? _playbackStopped;

    public event EventHandler<PlaybackProgressEventArgs> PlaybackProgress
    {
        add => _playbackProgress += value;
        remove => _playbackProgress -= value;
    }

    public event EventHandler<PlaybackStopEventArgs> PlaybackStopped
    {
        add => _playbackStopped += value;
        remove => _playbackStopped -= value;
    }

    public event EventHandler<PlaybackProgressEventArgs> PlaybackStart { add { } remove { } }

    public event EventHandler<SessionEventArgs> SessionStarted { add { } remove { } }

    public event EventHandler<SessionEventArgs> SessionEnded { add { } remove { } }

    public event EventHandler<SessionEventArgs> SessionActivity { add { } remove { } }

    public event EventHandler<SessionEventArgs> SessionControllerConnected { add { } remove { } }

    public event EventHandler<SessionEventArgs> CapabilitiesChanged { add { } remove { } }

    /// <summary>Live subscriber count for PlaybackProgress.</summary>
    public int PlaybackProgressCount => _playbackProgress?.GetInvocationList().Length ?? 0;

    /// <summary>Live subscriber count for PlaybackStopped.</summary>
    public int PlaybackStoppedCount => _playbackStopped?.GetInvocationList().Length ?? 0;

    // ---- Everything below is an unused NotImplemented stub (per the repo convention). ----

    // Settable for identity-ladder tests; retains the throwing stub
    // convention until a test opts in via SetSessions.
    private List<SessionInfo>? _sessions;

    public void SetSessions(params SessionInfo[] sessions) => _sessions = sessions.ToList();

    public IEnumerable<SessionInfo> Sessions => _sessions ?? throw new NotImplementedException();

    public Task<SessionInfo> LogSessionActivity(string appName, string appVersion, string deviceId, string deviceName, string remoteEndPoint, User user) => throw new NotImplementedException();

    public void OnSessionControllerConnected(SessionInfo session) => throw new NotImplementedException();

    public void UpdateDeviceName(string sessionId, string reportedDeviceName) => throw new NotImplementedException();

    public Task OnPlaybackStart(PlaybackStartInfo info) => throw new NotImplementedException();

    public Task OnPlaybackProgress(PlaybackProgressInfo info) => throw new NotImplementedException();

    public Task OnPlaybackProgress(PlaybackProgressInfo info, bool isAutomated) => throw new NotImplementedException();

    public Task OnPlaybackStopped(PlaybackStopInfo info) => throw new NotImplementedException();

    public ValueTask ReportSessionEnded(string sessionId) => throw new NotImplementedException();

    public Task SendGeneralCommand(string controllingSessionId, string sessionId, GeneralCommand command, CancellationToken cancellationToken) => throw new NotImplementedException();

    public Task SendMessageCommand(string controllingSessionId, string sessionId, MessageCommand command, CancellationToken cancellationToken) => throw new NotImplementedException();

    public Task SendPlayCommand(string controllingSessionId, string sessionId, PlayRequest command, CancellationToken cancellationToken) => throw new NotImplementedException();

    public Task SendSyncPlayCommand(string sessionId, SendCommand command, CancellationToken cancellationToken) => throw new NotImplementedException();

    public Task SendSyncPlayGroupUpdate<T>(string sessionId, GroupUpdate<T> command, CancellationToken cancellationToken) => throw new NotImplementedException();

    public Task SendBrowseCommand(string controllingSessionId, string sessionId, BrowseRequest command, CancellationToken cancellationToken) => throw new NotImplementedException();

    public Task SendPlaystateCommand(string controllingSessionId, string sessionId, PlaystateRequest command, CancellationToken cancellationToken) => throw new NotImplementedException();

    public Task SendMessageToAdminSessions<T>(SessionMessageType name, T data, CancellationToken cancellationToken) => throw new NotImplementedException();

    public Task SendMessageToUserSessions<T>(List<Guid> userIds, SessionMessageType name, T data, CancellationToken cancellationToken) => throw new NotImplementedException();

    public Task SendMessageToUserSessions<T>(List<Guid> userIds, SessionMessageType name, Func<T> dataFn, CancellationToken cancellationToken) => throw new NotImplementedException();

    public Task SendMessageToUserDeviceSessions<T>(string deviceId, SessionMessageType name, T data, CancellationToken cancellationToken) => throw new NotImplementedException();

    public Task SendRestartRequiredNotification(CancellationToken cancellationToken) => throw new NotImplementedException();

    public void AddAdditionalUser(string sessionId, Guid userId) => throw new NotImplementedException();

    public void RemoveAdditionalUser(string sessionId, Guid userId) => throw new NotImplementedException();

    public void ReportNowViewingItem(string sessionId, string itemId) => throw new NotImplementedException();

    public Task<AuthenticationResult> AuthenticateNewSession(AuthenticationRequest request) => throw new NotImplementedException();

    public Task<AuthenticationResult> AuthenticateDirect(AuthenticationRequest request) => throw new NotImplementedException();

    public void ReportCapabilities(string sessionId, ClientCapabilities capabilities) => throw new NotImplementedException();

    public void ReportTranscodingInfo(string deviceId, TranscodingInfo info) => throw new NotImplementedException();

    public void ClearTranscodingInfo(string deviceId) => throw new NotImplementedException();

    public SessionInfo GetSession(string deviceId, string client, string version) => throw new NotImplementedException();

    public IReadOnlyList<SessionInfoDto> GetSessions(Guid userId, string deviceId, int? activeWithinSeconds, Guid? controllableUserToCheck, bool isApiKey) => throw new NotImplementedException();

    public Task<SessionInfo> GetSessionByAuthenticationToken(string token, string deviceId, string remoteEndpoint) => throw new NotImplementedException();

    public Task<SessionInfo> GetSessionByAuthenticationToken(Device info, string deviceId, string remoteEndpoint, string appVersion) => throw new NotImplementedException();

    public Task Logout(string accessToken) => throw new NotImplementedException();

    public Task Logout(Device device) => throw new NotImplementedException();

    public Task RevokeUserTokens(Guid userId, string currentAccessToken) => throw new NotImplementedException();

    public Task CloseIfNeededAsync(SessionInfo session) => throw new NotImplementedException();

    public Task CloseLiveStreamIfNeededAsync(string liveStreamId, string sessionIdOrPlaySessionId) => throw new NotImplementedException();

    public SessionInfoDto ToSessionInfoDto(SessionInfo sessionInfo) => throw new NotImplementedException();
}
