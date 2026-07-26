using Jellyfin.Plugin.JellyfinCanopy.Model.Maintainerr;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Maintainerr;

public enum MaintainerrErrorCode
{
    Disabled,
    InvalidConfiguration,
    BlockedTarget,
    Timeout,
    Canceled,
    Redirect,
    WrongService,
    NotReady,
    Throttled,
    MalformedResponse,
    ResponseTooLarge,
    TooLarge,
    Unsupported,
    UpstreamError,
    IdentityMismatch,
    ConfigurationChanged,
}

public sealed class MaintainerrClientResult<T>
{
    private MaintainerrClientResult(T? value, MaintainerrErrorCode? error, int upstreamStatus)
    {
        Value = value;
        Error = error;
        UpstreamStatus = upstreamStatus;
    }

    public bool IsSuccess => Error == null && Value != null;

    public T? Value { get; }

    public MaintainerrErrorCode? Error { get; }

    public int UpstreamStatus { get; }

    internal static MaintainerrClientResult<T> Success(T value)
        => new(value, null, 200);

    internal static MaintainerrClientResult<T> Failure(
        MaintainerrErrorCode error,
        int upstreamStatus = 0)
        => new(default, error, upstreamStatus);
}

/// <summary>The non-sensitive Jellyfin identity needed for server matching.</summary>
public sealed record MaintainerrHostIdentity(string SystemId);

public enum MaintainerrCallerRole
{
    Administrator,
    RegularUser,
}

public interface IMaintainerrClient
{
    Task<MaintainerrClientResult<MaintainerrTestResponse>> TestAsync(
        string candidateUrl,
        CancellationToken cancellationToken);

    Task<MaintainerrClientResult<MaintainerrDashboardResponse>> GetDashboardAsync(
        string? currentJellyfinUrl,
        bool forceRefresh,
        CancellationToken cancellationToken);

    Task<MaintainerrClientResult<MaintainerrCollectionContentResponse>> GetCollectionContentAsync(
        int collectionId,
        int page,
        int size,
        string sort,
        string sortOrder,
        CancellationToken cancellationToken);

    Task<MaintainerrClientResult<MaintainerrAdminItemStatusResponse>> GetItemStatusAsync(
        string jellyfinItemId,
        MaintainerrCallerRole callerRole,
        string? currentJellyfinUrl,
        CancellationToken cancellationToken);
}
