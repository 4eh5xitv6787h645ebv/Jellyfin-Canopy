using System.Buffers;
using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Jellyfin.Plugin.JellyfinCanopy.Model.Maintainerr;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Maintainerr;

/// <summary>
/// Credential-free, strictly read-only Maintainerr v3.18 transport and mapper.
/// Every upstream request is built from this class's closed GET allowlist.
/// </summary>
public sealed class MaintainerrClient : IMaintainerrClient
{
    internal const int SmallResponseBytes = 64 * 1024;
    internal const int LargeResponseBytes = 2 * 1024 * 1024;
    internal const int MaximumCollections = 500;
    internal const int MaximumCollectionPageSize = 50;
    internal const int MaximumCollectionItems = 1_000_000;
    internal const int MaximumStringLength = 256;
    internal const long MaximumSafeJsonInteger = 9_007_199_254_740_991;
    internal const int MaximumConcurrentUpstreamRequests = 4;
    internal const int MaximumPendingUpstreamRequests = 12;
    internal const int MaximumAdmittedUpstreamRequests =
        MaximumConcurrentUpstreamRequests + MaximumPendingUpstreamRequests;
    internal static readonly TimeSpan RequestDeadline = TimeSpan.FromSeconds(10);
    internal static readonly TimeSpan TestOperationDeadline = TimeSpan.FromSeconds(12);
    internal static readonly TimeSpan ItemStatusOperationDeadline = TimeSpan.FromSeconds(12);
    internal static readonly TimeSpan DashboardOperationDeadline = TimeSpan.FromSeconds(15);
    internal static readonly TimeSpan DashboardCacheTtl = TimeSpan.FromSeconds(30);
    internal static readonly TimeSpan DashboardRefreshMinimumInterval = TimeSpan.FromSeconds(2);
    internal static readonly TimeSpan DashboardFailureBackoffTtl = TimeSpan.FromSeconds(2);
    internal static readonly TimeSpan TransportLogMinimumInterval = TimeSpan.FromSeconds(30);

    private static readonly UTF8Encoding StrictUtf8 = new(false, true);
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = false,
        NumberHandling = JsonNumberHandling.Strict,
    };

    private static readonly HashSet<string> CollectionSorts = new(StringComparer.Ordinal)
    {
        "deleteSoonest",
    };

    private static readonly HashSet<string> MediaTypes = new(StringComparer.Ordinal)
    {
        "movie",
        "show",
        "season",
        "episode",
    };

    private static readonly HashSet<string> OverlayStates = new(StringComparer.Ordinal)
    {
        "idle",
        "running",
        "error",
    };

    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IPluginConfigProvider _configProvider;
    private readonly MaintainerrHostIdentity _hostIdentity;
    private readonly ILogger<MaintainerrClient> _logger;
    private readonly MaintainerrClientTimings _timings;
    private readonly TimeProvider _timeProvider;
    private readonly SemaphoreSlim _upstreamAdmission = new(
        MaximumAdmittedUpstreamRequests,
        MaximumAdmittedUpstreamRequests);
    private readonly SemaphoreSlim _upstreamConcurrency = new(
        MaximumConcurrentUpstreamRequests,
        MaximumConcurrentUpstreamRequests);
    private readonly object _dashboardCacheLock = new();
    private readonly object _transportLogLock = new();
    private readonly DateTimeOffset?[] _transportLogEmittedAt
        = new DateTimeOffset?[Enum.GetValues<MaintainerrEndpoint>().Length];
    private DateTimeOffset? _dashboardMapperLogEmittedAt;
    private DashboardCacheEntry? _dashboardCache;
    private DashboardFailureEntry? _dashboardFailure;
    private DashboardAttemptEntry? _dashboardLastAttempt;
    private DashboardFlight? _dashboardFlight;

    public MaintainerrClient(
        IHttpClientFactory httpClientFactory,
        IPluginConfigProvider configProvider,
        MaintainerrHostIdentity hostIdentity,
        ILogger<MaintainerrClient> logger)
        : this(
            httpClientFactory,
            configProvider,
            hostIdentity,
            logger,
            MaintainerrClientTimings.Default,
            TimeProvider.System)
    {
    }

    internal MaintainerrClient(
        IHttpClientFactory httpClientFactory,
        IPluginConfigProvider configProvider,
        MaintainerrHostIdentity hostIdentity,
        ILogger<MaintainerrClient> logger,
        MaintainerrClientTimings timings,
        TimeProvider? timeProvider = null)
    {
        if (!timings.IsValid)
        {
            throw new ArgumentOutOfRangeException(nameof(timings));
        }

        _httpClientFactory = httpClientFactory;
        _configProvider = configProvider;
        _hostIdentity = hostIdentity;
        _logger = logger;
        _timings = timings;
        _timeProvider = timeProvider ?? TimeProvider.System;
    }

    public async Task<MaintainerrClientResult<MaintainerrTestResponse>> TestAsync(
        string candidateUrl,
        CancellationToken cancellationToken)
    {
        if (!ServiceUrlResolver.TryNormalizeHttpBaseUrl(candidateUrl, out var normalized))
        {
            return MaintainerrClientResult<MaintainerrTestResponse>.Failure(
                MaintainerrErrorCode.InvalidConfiguration);
        }

        using var operation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        operation.CancelAfter(_timings.TestOperationDeadline);
        var statusResult = await ReadConnectionStatusAsync(
            normalized,
            snapshot: null,
            operation.Token).ConfigureAwait(false);
        if (!statusResult.IsSuccess)
        {
            return MaintainerrClientResult<MaintainerrTestResponse>.Failure(
                NormalizeOperationError(statusResult.Error!.Value, cancellationToken),
                statusResult.UpstreamStatus);
        }

        var status = statusResult.Value!;
        return MaintainerrClientResult<MaintainerrTestResponse>.Success(new MaintainerrTestResponse
        {
            Ok = status.Capable && status.IdentityMatch,
            Ready = status.Ready,
            Version = status.Version,
            JellyfinMode = status.JellyfinMode,
            Capable = status.Capable,
            IdentityMatch = status.IdentityMatch,
            IdentityWarning = status.IdentityWarning,
            Error = status.Error,
            Capabilities = new Dictionary<string, bool>(StringComparer.Ordinal)
            {
                ["collections"] = status.Capable,
                ["collectionContent"] = status.Capable,
                ["itemStatus"] = status.Capable && status.IdentityMatch,
                ["rules"] = status.Capable,
                ["storageMetrics"] = status.Capable,
                ["overlays"] = status.Capable,
            },
        });
    }

    public async Task<MaintainerrClientResult<MaintainerrDashboardResponse>> GetDashboardAsync(
        string? currentJellyfinUrl,
        bool forceRefresh,
        CancellationToken cancellationToken)
    {
        var snapshot = MaintainerrIntegrationSnapshot.Capture(_configProvider);
        if (!snapshot.IsActive)
        {
            return MaintainerrClientResult<MaintainerrDashboardResponse>.Failure(
                MapSnapshotError(snapshot.State));
        }

        if (!snapshot.PageEnabled)
        {
            return MaintainerrClientResult<MaintainerrDashboardResponse>.Failure(
                MaintainerrErrorCode.Disabled);
        }

        var browserBase = ServiceUrlResolver.ResolveMappedPublicUrl(
            snapshot.InternalUrl,
            snapshot.ExternalUrl,
            snapshot.UrlMappings,
            currentJellyfinUrl) ?? string.Empty;
        var cacheKey = $"{snapshot.GenerationIdentity}\n{browserBase}";
        DashboardFlight flight;
        lock (_dashboardCacheLock)
        {
            var now = DateTimeOffset.UtcNow;
            var cached = _dashboardCache is { } candidate
                && candidate.Key == cacheKey
                && candidate.ExpiresAt > now
                    ? candidate
                    : null;
            if (_dashboardFlight is { } existing
                && existing.Key == cacheKey
                && !existing.Task.IsCompleted)
            {
                flight = existing;
            }
            else if (!forceRefresh && cached != null)
            {
                return cached.Result;
            }
            else if (_dashboardFailure is { } failure
                && failure.Key == cacheKey
                && failure.ExpiresAt > now)
            {
                return MaintainerrClientResult<MaintainerrDashboardResponse>.Failure(
                    failure.Error,
                    failure.UpstreamStatus);
            }
            else if (forceRefresh
                && _dashboardLastAttempt is { } attempt
                && attempt.Key == cacheKey
                && attempt.StartedAt + _timings.DashboardRefreshMinimumInterval > now)
            {
                return cached?.Result
                    ?? MaintainerrClientResult<MaintainerrDashboardResponse>.Failure(
                        MaintainerrErrorCode.Throttled);
            }
            else
            {
                flight = new DashboardFlight(cacheKey, _timings.DashboardOperationDeadline);
                _dashboardFlight = flight;
                _dashboardLastAttempt = new DashboardAttemptEntry(cacheKey, now);
                flight.Task = PublishDashboardAsync(
                    flight,
                    snapshot,
                    currentJellyfinUrl);
            }

            flight.Waiters++;
        }

        try
        {
            return await flight.Task.WaitAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            return MaintainerrClientResult<MaintainerrDashboardResponse>.Failure(
                MaintainerrErrorCode.Canceled);
        }
        finally
        {
            ReleaseDashboardWaiter(flight);
        }
    }

    private async Task<MaintainerrClientResult<MaintainerrDashboardResponse>> PublishDashboardAsync(
        DashboardFlight flight,
        MaintainerrIntegrationSnapshot snapshot,
        string? currentJellyfinUrl)
    {
        MaintainerrClientResult<MaintainerrDashboardResponse> result;
        try
        {
            result = await LoadDashboardAsync(
                snapshot,
                currentJellyfinUrl,
                flight.Operation.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            result = MaintainerrClientResult<MaintainerrDashboardResponse>.Failure(
                MaintainerrErrorCode.Canceled);
        }
        catch (Exception)
        {
            LogDashboardMapperFailure();
            result = MaintainerrClientResult<MaintainerrDashboardResponse>.Failure(
                MaintainerrErrorCode.UpstreamError);
        }

        if (result.Error == MaintainerrErrorCode.Canceled
            && flight.Deadline.IsCancellationRequested
            && !flight.Abandonment.IsCancellationRequested)
        {
            result = MaintainerrClientResult<MaintainerrDashboardResponse>.Failure(
                MaintainerrErrorCode.Timeout,
                result.UpstreamStatus);
        }

        lock (_dashboardCacheLock)
        {
            if (ReferenceEquals(_dashboardFlight, flight))
            {
                _dashboardFlight = null;
                if (snapshot.IsCurrent(_configProvider)
                    && result.IsSuccess)
                {
                    _dashboardFailure = null;
                    _dashboardCache = new DashboardCacheEntry(
                        flight.Key,
                        result,
                        DateTimeOffset.UtcNow + _timings.DashboardCacheTtl);
                }
                else if (snapshot.IsCurrent(_configProvider)
                    && ShouldBackoffDashboardFailure(result.Error))
                {
                    _dashboardFailure = new DashboardFailureEntry(
                        flight.Key,
                        result.Error!.Value,
                        result.UpstreamStatus,
                        DateTimeOffset.UtcNow + _timings.DashboardFailureBackoffTtl);
                }
            }
        }

        return result;
    }

    private void ReleaseDashboardWaiter(DashboardFlight flight)
    {
        var cancelFlight = false;
        var disposeNow = false;
        lock (_dashboardCacheLock)
        {
            flight.Waiters--;
            if (flight.Waiters == 0)
            {
                if (flight.Task.IsCompleted)
                {
                    disposeNow = true;
                }
                else
                {
                    cancelFlight = true;
                    if (ReferenceEquals(_dashboardFlight, flight))
                    {
                        _dashboardFlight = null;
                    }
                }
            }
        }

        if (cancelFlight)
        {
            flight.Abandonment.Cancel();
            _ = flight.Task.ContinueWith(
                static (_, state) => ((DashboardFlight)state!).Dispose(),
                flight,
                CancellationToken.None,
                TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
        }
        else if (disposeNow)
        {
            flight.Dispose();
        }
    }

    private async Task<MaintainerrClientResult<MaintainerrDashboardResponse>> LoadDashboardAsync(
        MaintainerrIntegrationSnapshot snapshot,
        string? currentJellyfinUrl,
        CancellationToken cancellationToken)
    {
        var statusResult = await ReadConnectionStatusAsync(
            snapshot.InternalUrl,
            snapshot,
            cancellationToken).ConfigureAwait(false);
        if (!statusResult.IsSuccess)
        {
            return MaintainerrClientResult<MaintainerrDashboardResponse>.Failure(
                statusResult.Error!.Value,
                statusResult.UpstreamStatus);
        }

        var status = statusResult.Value!;
        if (!status.JellyfinMode)
        {
            return MaintainerrClientResult<MaintainerrDashboardResponse>.Failure(
                MaintainerrErrorCode.WrongService);
        }

        if (!status.Ready)
        {
            return MaintainerrClientResult<MaintainerrDashboardResponse>.Failure(
                MaintainerrErrorCode.NotReady);
        }

        if (!status.Capable)
        {
            return MaintainerrClientResult<MaintainerrDashboardResponse>.Failure(
                MaintainerrErrorCode.Unsupported);
        }

        var collectionsTask = ReadCollectionsAsync(snapshot, currentJellyfinUrl, cancellationToken);
        var storageTask = ReadStorageAsync(snapshot, cancellationToken);
        var ruleCountTask = ReadRuleCountAsync(snapshot, cancellationToken);
        var ruleStatusTask = ReadRuleStatusAsync(snapshot, cancellationToken);
        var overlayTask = ReadOverlayStatusAsync(snapshot, cancellationToken);

        await Task.WhenAll(
            collectionsTask,
            storageTask,
            ruleCountTask,
            ruleStatusTask,
            overlayTask).ConfigureAwait(false);

        if (!snapshot.IsCurrent(_configProvider))
        {
            return MaintainerrClientResult<MaintainerrDashboardResponse>.Failure(
                MaintainerrErrorCode.ConfigurationChanged);
        }

        var collections = await collectionsTask.ConfigureAwait(false);
        if (!collections.IsSuccess)
        {
            return MaintainerrClientResult<MaintainerrDashboardResponse>.Failure(
                collections.Error!.Value,
                collections.UpstreamStatus);
        }

        var storage = await storageTask.ConfigureAwait(false);
        var ruleCount = await ruleCountTask.ConfigureAwait(false);
        var ruleStatus = await ruleStatusTask.ConfigureAwait(false);
        var overlays = await overlayTask.ConfigureAwait(false);
        var storageSummary = storage.IsSuccess
            ? storage.Value!
            : UnavailableStorage(storage.Error!.Value);
        var rulesSummary = BuildRulesSummary(ruleCount, ruleStatus);
        var overlaySummary = overlays.IsSuccess
            ? overlays.Value!
            : UnavailableOverlay(overlays.Error!.Value);
        var sectionsDegraded = storageSummary.State != "available"
            || rulesSummary.State != "available"
            || overlaySummary.State != "available";

        var dashboardStatus = new MaintainerrDashboardStatus
        {
            Ready = status.Ready,
            Degraded = status.Degraded || sectionsDegraded,
            Version = status.Version,
            JellyfinMode = status.JellyfinMode,
            Capable = status.Capable,
            IdentityMatch = status.IdentityMatch,
            IdentityWarning = status.IdentityWarning,
            Error = status.Error,
        };

        return MaintainerrClientResult<MaintainerrDashboardResponse>.Success(
            new MaintainerrDashboardResponse
            {
                Status = dashboardStatus,
                Collections = collections.Value!,
                Storage = storageSummary,
                Rules = rulesSummary,
                Overlays = overlaySummary,
                Links = BuildAdminLinks(snapshot, currentJellyfinUrl),
            });
    }

    public async Task<MaintainerrClientResult<MaintainerrCollectionContentResponse>> GetCollectionContentAsync(
        int collectionId,
        int page,
        int size,
        string sort,
        string sortOrder,
        CancellationToken cancellationToken)
    {
        if (collectionId <= 0
            || !IsValidCollectionPage(page, size)
            || !CollectionSorts.Contains(sort)
            || (sortOrder != "asc" && sortOrder != "desc"))
        {
            return MaintainerrClientResult<MaintainerrCollectionContentResponse>.Failure(
                MaintainerrErrorCode.InvalidConfiguration);
        }

        var snapshot = MaintainerrIntegrationSnapshot.Capture(_configProvider);
        if (!snapshot.IsActive)
        {
            return MaintainerrClientResult<MaintainerrCollectionContentResponse>.Failure(
                MapSnapshotError(snapshot.State));
        }

        if (!snapshot.PageEnabled)
        {
            return MaintainerrClientResult<MaintainerrCollectionContentResponse>.Failure(
                MaintainerrErrorCode.Disabled);
        }

        var raw = await SendAsync(
            snapshot.InternalUrl,
            MaintainerrEndpoint.CollectionContent,
            snapshot,
            cancellationToken,
            collectionId,
            page,
            size,
            sort,
            sortOrder).ConfigureAwait(false);
        if (!raw.IsSuccess)
        {
            return MaintainerrClientResult<MaintainerrCollectionContentResponse>.Failure(
                raw.Error!.Value,
                raw.UpstreamStatus);
        }

        try
        {
            var upstream = JsonSerializer.Deserialize<UpstreamCollectionContent>(raw.Value!, JsonOptions);
            var offset = ((long)page - 1) * size;
            if (upstream?.Items == null
                || !upstream.TotalSize.HasValue
                || upstream.TotalSize is < 0 or > MaximumCollectionItems
                || upstream.Items.Count > size
                || upstream.Items.Count > upstream.TotalSize
                || (upstream.TotalSize == 0
                    && (page != 1 || upstream.Items.Count != 0))
                || (upstream.TotalSize > 0
                    && (offset >= upstream.TotalSize
                        || upstream.Items.Count == 0
                        || upstream.Items.Count > upstream.TotalSize - offset)))
            {
                throw new JsonException("Invalid Maintainerr collection page envelope.");
            }

            var items = new List<MaintainerrCollectionContentItem>(upstream.Items.Count);
            foreach (var item in upstream.Items)
            {
                if (item.Id is null or <= 0
                    || item.MediaData == null
                    || !TryBoundedString(item.MediaData.Title, out var title)
                    || !TryMediaType(item.MediaData.Type, out var type))
                {
                    throw new JsonException("Invalid Maintainerr collection member.");
                }

                items.Add(new MaintainerrCollectionContentItem
                {
                    Id = item.Id.Value,
                    Title = title,
                    Type = type,
                });
            }

            if (!snapshot.IsCurrent(_configProvider))
            {
                return MaintainerrClientResult<MaintainerrCollectionContentResponse>.Failure(
                    MaintainerrErrorCode.ConfigurationChanged);
            }

            return MaintainerrClientResult<MaintainerrCollectionContentResponse>.Success(
                new MaintainerrCollectionContentResponse
                {
                    Page = page,
                    Size = size,
                    TotalSize = upstream.TotalSize.GetValueOrDefault(),
                    Items = items,
                });
        }
        catch (JsonException)
        {
            return MaintainerrClientResult<MaintainerrCollectionContentResponse>.Failure(
                MaintainerrErrorCode.MalformedResponse);
        }
    }

    public async Task<MaintainerrClientResult<MaintainerrAdminItemStatusResponse>> GetItemStatusAsync(
        string jellyfinItemId,
        MaintainerrCallerRole callerRole,
        string? currentJellyfinUrl,
        CancellationToken cancellationToken)
    {
        if (!Guid.TryParse(jellyfinItemId, out var parsedItemId)
            || callerRole is not MaintainerrCallerRole.Administrator
                and not MaintainerrCallerRole.RegularUser)
        {
            return MaintainerrClientResult<MaintainerrAdminItemStatusResponse>.Failure(
                MaintainerrErrorCode.InvalidConfiguration);
        }

        var snapshot = MaintainerrIntegrationSnapshot.Capture(_configProvider);
        if (!snapshot.IsActive)
        {
            return MaintainerrClientResult<MaintainerrAdminItemStatusResponse>.Failure(
                MapSnapshotError(snapshot.State));
        }

        if (!snapshot.ItemStatusEnabled)
        {
            return MaintainerrClientResult<MaintainerrAdminItemStatusResponse>.Failure(
                MaintainerrErrorCode.Disabled);
        }

        if (callerRole == MaintainerrCallerRole.RegularUser
            && !snapshot.ItemStatusForUsers)
        {
            return MaintainerrClientResult<MaintainerrAdminItemStatusResponse>.Failure(
                MaintainerrErrorCode.Disabled);
        }

        using var operation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        operation.CancelAfter(_timings.ItemStatusOperationDeadline);
        var identity = await ReadMediaServerIdentityAsync(
            snapshot.InternalUrl,
            snapshot,
            operation.Token).ConfigureAwait(false);
        if (!identity.IsSuccess)
        {
            return MaintainerrClientResult<MaintainerrAdminItemStatusResponse>.Failure(
                NormalizeOperationError(identity.Error!.Value, cancellationToken),
                identity.UpstreamStatus);
        }

        if (CompareIdentity(identity.Value?.MachineId) != IdentityState.Matched)
        {
            return MaintainerrClientResult<MaintainerrAdminItemStatusResponse>.Failure(
                MaintainerrErrorCode.IdentityMismatch);
        }

        var raw = await SendAsync(
            snapshot.InternalUrl,
            MaintainerrEndpoint.ItemStatus,
            snapshot,
            operation.Token,
            parsedItemId.ToString("N")).ConfigureAwait(false);
        if (!raw.IsSuccess)
        {
            return MaintainerrClientResult<MaintainerrAdminItemStatusResponse>.Failure(
                NormalizeOperationError(raw.Error!.Value, cancellationToken),
                raw.UpstreamStatus);
        }

        try
        {
            var upstream = JsonSerializer.Deserialize<UpstreamItemStatus>(raw.Value!, JsonOptions);
            if (upstream?.ExcludedFrom == null
                || upstream.ManuallyAddedTo == null
                || upstream.ExcludedFrom.Count > 100
                || upstream.ManuallyAddedTo.Count > 100)
            {
                throw new JsonException("Invalid Maintainerr item status.");
            }

            var browserBase = callerRole == MaintainerrCallerRole.Administrator
                ? ServiceUrlResolver.ResolveMappedPublicUrl(
                    snapshot.InternalUrl,
                    snapshot.ExternalUrl,
                    snapshot.UrlMappings,
                    currentJellyfinUrl)
                : null;
            var excluded = MapStatusLinks(upstream.ExcludedFrom, browserBase);
            var manual = MapStatusLinks(upstream.ManuallyAddedTo, browserBase);

            if (!snapshot.IsCurrent(_configProvider))
            {
                return MaintainerrClientResult<MaintainerrAdminItemStatusResponse>.Failure(
                    MaintainerrErrorCode.ConfigurationChanged);
            }

            return MaintainerrClientResult<MaintainerrAdminItemStatusResponse>.Success(
                new MaintainerrAdminItemStatusResponse
                {
                    ProtectedFromCleanup = excluded.Count > 0,
                    ManuallyManaged = manual.Count > 0,
                    ExcludedFrom = excluded,
                    ManuallyAddedTo = manual,
                });
        }
        catch (JsonException)
        {
            return MaintainerrClientResult<MaintainerrAdminItemStatusResponse>.Failure(
                MaintainerrErrorCode.MalformedResponse);
        }
    }

    private async Task<MaintainerrClientResult<MaintainerrDashboardStatus>> ReadConnectionStatusAsync(
        string baseUrl,
        MaintainerrIntegrationSnapshot? snapshot,
        CancellationToken cancellationToken)
    {
        var readyTask = ReadAsync<UpstreamHealth>(
            baseUrl,
            MaintainerrEndpoint.HealthReady,
            snapshot,
            cancellationToken);
        var appTask = ReadAsync<UpstreamAppStatus>(
            baseUrl,
            MaintainerrEndpoint.AppStatus,
            snapshot,
            cancellationToken);
        var typeTask = ReadAsync<UpstreamMediaServerType>(
            baseUrl,
            MaintainerrEndpoint.MediaServerType,
            snapshot,
            cancellationToken);
        var identityTask = ReadMediaServerIdentityAsync(baseUrl, snapshot, cancellationToken);

        await Task.WhenAll(readyTask, appTask, typeTask, identityTask).ConfigureAwait(false);

        var ready = await readyTask.ConfigureAwait(false);
        var app = await appTask.ConfigureAwait(false);
        var type = await typeTask.ConfigureAwait(false);
        var identity = await identityTask.ConfigureAwait(false);
        var firstFailure = new[] { ready.Error, app.Error, type.Error, identity.Error }
            .FirstOrDefault(error => error.HasValue);
        if (firstFailure.HasValue)
        {
            var status = ready.Error.HasValue
                ? ready.UpstreamStatus
                : app.Error.HasValue
                    ? app.UpstreamStatus
                    : type.Error.HasValue
                        ? type.UpstreamStatus
                        : identity.UpstreamStatus;
            return MaintainerrClientResult<MaintainerrDashboardStatus>.Failure(
                firstFailure.Value,
                status);
        }

        if (!TryBoundedString(app.Value!.Version, out var version, 80)
            || app.Value.Status is not 0 and not 1
            || !TryBoundedString(type.Value!.Type, out var mediaServerType, 32)
            || !TryBoundedString(ready.Value!.Status, out var healthStatus, 32)
            || !TryBoundedString(ready.Value.Database, out var databaseStatus, 32)
            || (healthStatus != "ok" && healthStatus != "degraded")
            || (databaseStatus != "ok" && databaseStatus != "unreachable"))
        {
            return MaintainerrClientResult<MaintainerrDashboardStatus>.Failure(
                MaintainerrErrorCode.MalformedResponse);
        }

        var appHealthy = app.Value.Status == 1;
        var isReady = healthStatus == "ok" && databaseStatus == "ok";
        var jellyfinMode = string.Equals(mediaServerType, "jellyfin", StringComparison.Ordinal);
        var versionCompatible = IsSupportedV318Version(version);
        var identityState = CompareIdentity(identity.Value!.MachineId);
        var identityMatch = identityState == IdentityState.Matched;
        var identityWarning = identityState switch
        {
            IdentityState.Mismatched => "identity_mismatch",
            IdentityState.Unknown => "identity_unknown",
            _ => null,
        };

        // The connection test is intentionally limited to four non-mutating
        // identity/readiness probes. Capability flags therefore describe the
        // reviewed v3.18 contract only when the detected version is in that
        // compatible line; optional runtime endpoints still degrade independently
        // to `unsupported` when their first real read returns 404.
        var capable = appHealthy && isReady && jellyfinMode && versionCompatible;
        return MaintainerrClientResult<MaintainerrDashboardStatus>.Success(
            new MaintainerrDashboardStatus
            {
                Ready = isReady,
                Degraded = !appHealthy
                    || !isReady
                    || !jellyfinMode
                    || !versionCompatible
                    || !identityMatch,
                Version = version,
                JellyfinMode = jellyfinMode,
                Capable = capable,
                IdentityMatch = identityMatch,
                IdentityWarning = identityWarning,
                Error = !appHealthy
                    ? "not_ready"
                    : !isReady
                    ? "not_ready"
                    : !jellyfinMode
                        ? "wrong_service"
                        : !versionCompatible
                            ? "unsupported"
                        : null,
            });
    }

    private async Task<MaintainerrClientResult<UpstreamMediaServerStatus>> ReadMediaServerIdentityAsync(
        string baseUrl,
        MaintainerrIntegrationSnapshot? snapshot,
        CancellationToken cancellationToken)
    {
        var raw = await SendAsync(
            baseUrl,
            MaintainerrEndpoint.MediaServerIdentity,
            snapshot,
            cancellationToken).ConfigureAwait(false);
        if (!raw.IsSuccess)
        {
            return MaintainerrClientResult<UpstreamMediaServerStatus>.Failure(
                raw.Error!.Value,
                raw.UpstreamStatus);
        }

        try
        {
            var identity = JsonSerializer.Deserialize<UpstreamMediaServerStatus>(
                raw.Value!,
                JsonOptions);
            if (identity?.MachineId is { } machineId
                && (machineId.Length > MaximumStringLength || machineId.Any(char.IsControl)))
            {
                return MaintainerrClientResult<UpstreamMediaServerStatus>.Failure(
                    MaintainerrErrorCode.MalformedResponse);
            }

            return MaintainerrClientResult<UpstreamMediaServerStatus>.Success(
                identity ?? new UpstreamMediaServerStatus());
        }
        catch (JsonException)
        {
            return MaintainerrClientResult<UpstreamMediaServerStatus>.Failure(
                MaintainerrErrorCode.MalformedResponse);
        }
    }

    private async Task<MaintainerrClientResult<IReadOnlyList<MaintainerrCollectionSummary>>> ReadCollectionsAsync(
        MaintainerrIntegrationSnapshot snapshot,
        string? currentJellyfinUrl,
        CancellationToken cancellationToken)
    {
        var raw = await SendAsync(
            snapshot.InternalUrl,
            MaintainerrEndpoint.Collections,
            snapshot,
            cancellationToken).ConfigureAwait(false);
        if (!raw.IsSuccess)
        {
            return MaintainerrClientResult<IReadOnlyList<MaintainerrCollectionSummary>>.Failure(
                raw.Error!.Value,
                raw.UpstreamStatus);
        }

        try
        {
            var browserBase = ServiceUrlResolver.ResolveMappedPublicUrl(
                snapshot.InternalUrl,
                snapshot.ExternalUrl,
                snapshot.UrlMappings,
                currentJellyfinUrl);
            var reader = new Utf8JsonReader(raw.Value!, isFinalBlock: true, state: default);
            if (!reader.Read() || reader.TokenType != JsonTokenType.StartArray)
            {
                throw new JsonException("Maintainerr collections root was not an array.");
            }

            var result = new List<MaintainerrCollectionSummary>();
            while (reader.Read() && reader.TokenType != JsonTokenType.EndArray)
            {
                if (result.Count >= MaximumCollections)
                {
                    return MaintainerrClientResult<IReadOnlyList<MaintainerrCollectionSummary>>.Failure(
                        MaintainerrErrorCode.TooLarge);
                }

                var item = JsonSerializer.Deserialize<UpstreamCollection>(ref reader, JsonOptions);
                if (item?.Id is null or <= 0
                    || !TryBoundedString(item.Title, out var title)
                    || !TryMediaType(item.Type, out var type)
                    || item.IsActive == null
                    || item.MediaCount is null or < 0
                    || item.MediaCount > MaximumCollectionItems
                    || item.ManualCollection == null
                    || !ValidOptionalNonNegative(item.DeleteAfterDays, 36_500)
                    || item.HandledMediaAmount is null or < 0 or > 100_000_000
                    || item.LastDurationInSeconds is null or < 0
                    || !ValidOptionalNonNegative(item.TotalSizeBytes, MaximumSafeJsonInteger)
                    || item.HandledMediaSizeBytes is null or < 0 or > MaximumSafeJsonInteger)
                {
                    throw new JsonException("Invalid Maintainerr collection summary.");
                }

                result.Add(new MaintainerrCollectionSummary
                {
                    Id = item.Id.Value,
                    Title = title,
                    Type = type,
                    IsActive = item.IsActive.Value,
                    MediaCount = item.MediaCount.Value,
                    DeleteAfterDays = item.DeleteAfterDays,
                    ManualCollection = item.ManualCollection.Value,
                    HandledMediaAmount = item.HandledMediaAmount,
                    LastDurationInSeconds = item.LastDurationInSeconds,
                    TotalSizeBytes = item.TotalSizeBytes,
                    HandledMediaSizeBytes = item.HandledMediaSizeBytes,
                    Href = ServiceUrlResolver.JoinRelativePath(
                        browserBase,
                        $"/collections/{item.Id.Value.ToString(CultureInfo.InvariantCulture)}"),
                });
            }

            if (reader.TokenType != JsonTokenType.EndArray || reader.Read())
            {
                return MaintainerrClientResult<IReadOnlyList<MaintainerrCollectionSummary>>.Failure(
                    MaintainerrErrorCode.MalformedResponse);
            }

            if (!snapshot.IsCurrent(_configProvider))
            {
                return MaintainerrClientResult<IReadOnlyList<MaintainerrCollectionSummary>>.Failure(
                    MaintainerrErrorCode.ConfigurationChanged);
            }

            return MaintainerrClientResult<IReadOnlyList<MaintainerrCollectionSummary>>.Success(result);
        }
        catch (JsonException)
        {
            return MaintainerrClientResult<IReadOnlyList<MaintainerrCollectionSummary>>.Failure(
                MaintainerrErrorCode.MalformedResponse);
        }
    }

    private async Task<MaintainerrClientResult<MaintainerrStorageSummary>> ReadStorageAsync(
        MaintainerrIntegrationSnapshot snapshot,
        CancellationToken cancellationToken)
    {
        var result = await ReadAsync<UpstreamStorageMetrics>(
            snapshot.InternalUrl,
            MaintainerrEndpoint.StorageMetrics,
            snapshot,
            cancellationToken).ConfigureAwait(false);
        if (!result.IsSuccess)
        {
            return MaintainerrClientResult<MaintainerrStorageSummary>.Failure(
                result.Error!.Value,
                result.UpstreamStatus);
        }

        var source = result.Value!;
        if (source.CollectionSummary == null
            || source.CleanupTotals == null
            || !TryRequiredIsoTimestamp(source.GeneratedAt, out var generatedAt)
            || !source.CollectionSummary.ReclaimableUsingFallback.HasValue
            || !AllPresentSafeJsonIntegers(
                source.CollectionSummary.ReclaimableCount,
                source.CollectionSummary.ActiveSizeBytes,
                source.CollectionSummary.ReclaimableSizedCount,
                source.CollectionSummary.InactiveCount,
                source.CollectionSummary.TotalCollectionCount,
                source.CollectionSummary.MovieSizeBytes,
                source.CollectionSummary.ShowSizeBytes,
                source.CollectionSummary.SeasonSizeBytes,
                source.CollectionSummary.EpisodeSizeBytes,
                source.CollectionSummary.ReclaimableMovieCount,
                source.CollectionSummary.ReclaimableShowCount,
                source.CollectionSummary.ReclaimableSeasonCount,
                source.CollectionSummary.ReclaimableEpisodeCount)
            || !AllPresentSafeJsonIntegers(
                source.CleanupTotals.ItemsHandled,
                source.CleanupTotals.MoviesHandled,
                source.CleanupTotals.ShowsHandled,
                source.CleanupTotals.SeasonsHandled,
                source.CleanupTotals.EpisodesHandled,
                source.CleanupTotals.BytesHandled,
                source.CleanupTotals.MovieBytesHandled,
                source.CleanupTotals.ShowBytesHandled,
                source.CleanupTotals.SeasonBytesHandled,
                source.CleanupTotals.EpisodeBytesHandled))
        {
            return MaintainerrClientResult<MaintainerrStorageSummary>.Failure(
                MaintainerrErrorCode.MalformedResponse);
        }

        var collection = new Dictionary<string, long>(StringComparer.Ordinal)
        {
            ["reclaimableCount"] = source.CollectionSummary.ReclaimableCount.GetValueOrDefault(),
            ["activeSizeBytes"] = source.CollectionSummary.ActiveSizeBytes.GetValueOrDefault(),
            ["reclaimableSizedCount"] = source.CollectionSummary.ReclaimableSizedCount.GetValueOrDefault(),
            ["inactiveCount"] = source.CollectionSummary.InactiveCount.GetValueOrDefault(),
            ["totalCollectionCount"] = source.CollectionSummary.TotalCollectionCount.GetValueOrDefault(),
            ["movieSizeBytes"] = source.CollectionSummary.MovieSizeBytes.GetValueOrDefault(),
            ["showSizeBytes"] = source.CollectionSummary.ShowSizeBytes.GetValueOrDefault(),
            ["seasonSizeBytes"] = source.CollectionSummary.SeasonSizeBytes.GetValueOrDefault(),
            ["episodeSizeBytes"] = source.CollectionSummary.EpisodeSizeBytes.GetValueOrDefault(),
            ["reclaimableMovieCount"] = source.CollectionSummary.ReclaimableMovieCount.GetValueOrDefault(),
            ["reclaimableShowCount"] = source.CollectionSummary.ReclaimableShowCount.GetValueOrDefault(),
            ["reclaimableSeasonCount"] = source.CollectionSummary.ReclaimableSeasonCount.GetValueOrDefault(),
            ["reclaimableEpisodeCount"] = source.CollectionSummary.ReclaimableEpisodeCount.GetValueOrDefault(),
        };
        var cleanup = new Dictionary<string, long>(StringComparer.Ordinal)
        {
            ["itemsHandled"] = source.CleanupTotals.ItemsHandled.GetValueOrDefault(),
            ["moviesHandled"] = source.CleanupTotals.MoviesHandled.GetValueOrDefault(),
            ["showsHandled"] = source.CleanupTotals.ShowsHandled.GetValueOrDefault(),
            ["seasonsHandled"] = source.CleanupTotals.SeasonsHandled.GetValueOrDefault(),
            ["episodesHandled"] = source.CleanupTotals.EpisodesHandled.GetValueOrDefault(),
            ["bytesHandled"] = source.CleanupTotals.BytesHandled.GetValueOrDefault(),
            ["movieBytesHandled"] = source.CleanupTotals.MovieBytesHandled.GetValueOrDefault(),
            ["showBytesHandled"] = source.CleanupTotals.ShowBytesHandled.GetValueOrDefault(),
            ["seasonBytesHandled"] = source.CleanupTotals.SeasonBytesHandled.GetValueOrDefault(),
            ["episodeBytesHandled"] = source.CleanupTotals.EpisodeBytesHandled.GetValueOrDefault(),
        };

        return MaintainerrClientResult<MaintainerrStorageSummary>.Success(
            new MaintainerrStorageSummary
            {
                State = "available",
                GeneratedAt = generatedAt,
                CollectionSummary = collection,
                CleanupTotals = cleanup,
                ReclaimableUsingFallback = source.CollectionSummary.ReclaimableUsingFallback.GetValueOrDefault(),
            });
    }

    private Task<MaintainerrClientResult<int>> ReadRuleCountAsync(
        MaintainerrIntegrationSnapshot snapshot,
        CancellationToken cancellationToken)
        => ReadValidatedScalarAsync(
            snapshot,
            MaintainerrEndpoint.RuleCount,
            value => value is >= 0 and <= 100_000,
            cancellationToken);

    private async Task<MaintainerrClientResult<MaintainerrRulesSummary>> ReadRuleStatusAsync(
        MaintainerrIntegrationSnapshot snapshot,
        CancellationToken cancellationToken)
    {
        var result = await ReadAsync<UpstreamRuleStatus>(
            snapshot.InternalUrl,
            MaintainerrEndpoint.RuleExecutionStatus,
            snapshot,
            cancellationToken).ConfigureAwait(false);
        if (!result.IsSuccess)
        {
            return MaintainerrClientResult<MaintainerrRulesSummary>.Failure(
                result.Error!.Value,
                result.UpstreamStatus);
        }

        var value = result.Value!;
        if (!value.ProcessingQueue.HasValue
            || value.PendingRuleGroupIds == null
            || value.Queue == null
            || value.PendingRuleGroupIds.Count > MaximumCollections
            || value.Queue.Count > MaximumCollections
            || value.PendingRuleGroupIds.Any(id => id <= 0)
            || value.Queue.Any(id => id <= 0)
            || (value.ExecutingRuleGroupId.HasValue && value.ExecutingRuleGroupId <= 0))
        {
            return MaintainerrClientResult<MaintainerrRulesSummary>.Failure(
                MaintainerrErrorCode.MalformedResponse);
        }

        return MaintainerrClientResult<MaintainerrRulesSummary>.Success(
            new MaintainerrRulesSummary
            {
                State = "available",
                ProcessingQueue = value.ProcessingQueue.Value,
                Executing = value.ExecutingRuleGroupId.HasValue,
                PendingCount = value.PendingRuleGroupIds.Count,
                QueueCount = value.Queue.Count,
            });
    }

    private async Task<MaintainerrClientResult<MaintainerrOverlaySummary>> ReadOverlayStatusAsync(
        MaintainerrIntegrationSnapshot snapshot,
        CancellationToken cancellationToken)
    {
        var result = await ReadAsync<UpstreamOverlayStatus>(
            snapshot.InternalUrl,
            MaintainerrEndpoint.OverlayStatus,
            snapshot,
            cancellationToken).ConfigureAwait(false);
        if (!result.IsSuccess)
        {
            return MaintainerrClientResult<MaintainerrOverlaySummary>.Failure(
                result.Error!.Value,
                result.UpstreamStatus);
        }

        if (!TryBoundedString(result.Value!.Status, out var status, 32)
            || !OverlayStates.Contains(status)
            || !TryOptionalIsoTimestamp(result.Value.LastRun, out var lastRun))
        {
            return MaintainerrClientResult<MaintainerrOverlaySummary>.Failure(
                MaintainerrErrorCode.MalformedResponse);
        }

        return MaintainerrClientResult<MaintainerrOverlaySummary>.Success(
            new MaintainerrOverlaySummary
            {
                State = "available",
                Status = status,
                LastRun = lastRun,
            });
    }

    private async Task<MaintainerrClientResult<int>> ReadValidatedScalarAsync(
        MaintainerrIntegrationSnapshot snapshot,
        MaintainerrEndpoint endpoint,
        Func<int, bool> isValid,
        CancellationToken cancellationToken)
    {
        var result = await ReadAsync<int>(
            snapshot.InternalUrl,
            endpoint,
            snapshot,
            cancellationToken).ConfigureAwait(false);
        return result.IsSuccess && isValid(result.Value)
            ? result
            : MaintainerrClientResult<int>.Failure(
                result.Error ?? MaintainerrErrorCode.MalformedResponse,
                result.UpstreamStatus);
    }

    private async Task<MaintainerrClientResult<T>> ReadAsync<T>(
        string baseUrl,
        MaintainerrEndpoint endpoint,
        MaintainerrIntegrationSnapshot? snapshot,
        CancellationToken cancellationToken)
    {
        var raw = await SendAsync(
            baseUrl,
            endpoint,
            snapshot,
            cancellationToken).ConfigureAwait(false);
        if (!raw.IsSuccess)
        {
            return MaintainerrClientResult<T>.Failure(raw.Error!.Value, raw.UpstreamStatus);
        }

        try
        {
            var value = JsonSerializer.Deserialize<T>(raw.Value!, JsonOptions);
            return value == null
                ? MaintainerrClientResult<T>.Failure(MaintainerrErrorCode.MalformedResponse)
                : MaintainerrClientResult<T>.Success(value);
        }
        catch (JsonException)
        {
            return MaintainerrClientResult<T>.Failure(MaintainerrErrorCode.MalformedResponse);
        }
    }

    private async Task<MaintainerrClientResult<byte[]>> SendAsync(
        string baseUrl,
        MaintainerrEndpoint endpoint,
        MaintainerrIntegrationSnapshot? snapshot,
        CancellationToken cancellationToken,
        params object[] routeValues)
    {
        if (!TryBuildEndpoint(baseUrl, endpoint, routeValues, out var target, out var spec)
            || (snapshot != null && (!snapshot.IsCurrent(_configProvider) || !snapshot.ContainsTarget(target))))
        {
            return MaintainerrClientResult<byte[]>.Failure(
                snapshot == null
                    ? MaintainerrErrorCode.InvalidConfiguration
                    : MaintainerrErrorCode.ConfigurationChanged);
        }

        // Admission is non-blocking: at most twelve callers may wait behind the
        // four active requests, so request bursts cannot create an unbounded
        // SemaphoreSlim waiter queue. Callers receive the existing explicit
        // throttled taxonomy and may retry after their own bounded delay.
        if (!_upstreamAdmission.Wait(0))
        {
            return MaintainerrClientResult<byte[]>.Failure(MaintainerrErrorCode.Throttled);
        }

        try
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            deadline.CancelAfter(_timings.RequestDeadline);
            bool allowed;
            try
            {
                allowed = await ArrUrlGuard.IsAllowedUrlAsync(target.AbsoluteUri, deadline.Token)
                    .ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return MaintainerrClientResult<byte[]>.Failure(MaintainerrErrorCode.Canceled);
            }
            catch (OperationCanceledException)
            {
                return MaintainerrClientResult<byte[]>.Failure(MaintainerrErrorCode.Timeout);
            }

            if (!allowed)
            {
                return MaintainerrClientResult<byte[]>.Failure(MaintainerrErrorCode.BlockedTarget);
            }

            if (snapshot != null && (!snapshot.IsCurrent(_configProvider) || !snapshot.ContainsTarget(target)))
            {
                return MaintainerrClientResult<byte[]>.Failure(MaintainerrErrorCode.ConfigurationChanged);
            }

            try
            {
                await _upstreamConcurrency.WaitAsync(deadline.Token).ConfigureAwait(false);
                try
                {
                    using var request = new HttpRequestMessage(HttpMethod.Get, target);
                    request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
                    request.Headers.UserAgent.Add(new ProductInfoHeaderValue("JellyfinCanopy", "2.0"));

                    if (snapshot != null && (!snapshot.IsCurrent(_configProvider) || !snapshot.ContainsTarget(target)))
                    {
                        return MaintainerrClientResult<byte[]>.Failure(
                            MaintainerrErrorCode.ConfigurationChanged);
                    }

                    using var client = PluginHttpClients.CreateMaintainerrClient(_httpClientFactory);
                    client.Timeout = Timeout.InfiniteTimeSpan;
                    using var response = await client.SendAsync(
                        request,
                        HttpCompletionOption.ResponseHeadersRead,
                        deadline.Token).ConfigureAwait(false);

                    var status = (int)response.StatusCode;
                    if (status is >= 300 and < 400)
                    {
                        return MaintainerrClientResult<byte[]>.Failure(
                            MaintainerrErrorCode.Redirect,
                            status);
                    }

                    if (response.StatusCode == HttpStatusCode.NotFound && spec.Optional)
                    {
                        return MaintainerrClientResult<byte[]>.Failure(
                            MaintainerrErrorCode.Unsupported,
                            status);
                    }

                    if (!response.IsSuccessStatusCode
                        && !(endpoint == MaintainerrEndpoint.HealthReady
                            && response.StatusCode == HttpStatusCode.ServiceUnavailable))
                    {
                        return MaintainerrClientResult<byte[]>.Failure(
                            MaintainerrErrorCode.UpstreamError,
                            status);
                    }

                    var mediaType = response.Content.Headers.ContentType?.MediaType;
                    var jsonContent = string.Equals(mediaType, "application/json", StringComparison.OrdinalIgnoreCase)
                        || (mediaType?.StartsWith("application/", StringComparison.OrdinalIgnoreCase) == true
                            && mediaType.EndsWith("+json", StringComparison.OrdinalIgnoreCase));
                    if (!jsonContent
                        && !(spec.AllowTextHtmlJson
                            && string.Equals(mediaType, "text/html", StringComparison.OrdinalIgnoreCase)))
                    {
                        return MaintainerrClientResult<byte[]>.Failure(
                            MaintainerrErrorCode.WrongService,
                            status);
                    }

                    var body = await ReadBoundedBodyAsync(response, spec.MaximumBytes, deadline.Token)
                        .ConfigureAwait(false);
                    if (body == null)
                    {
                        return MaintainerrClientResult<byte[]>.Failure(
                            MaintainerrErrorCode.ResponseTooLarge,
                            status);
                    }

                    try
                    {
                        _ = StrictUtf8.GetString(body);
                    }
                    catch (DecoderFallbackException)
                    {
                        return MaintainerrClientResult<byte[]>.Failure(
                            MaintainerrErrorCode.MalformedResponse,
                            status);
                    }

                    if (snapshot != null && !snapshot.IsCurrent(_configProvider))
                    {
                        return MaintainerrClientResult<byte[]>.Failure(
                            MaintainerrErrorCode.ConfigurationChanged);
                    }

                    return MaintainerrClientResult<byte[]>.Success(body);
                }
                finally
                {
                    _upstreamConcurrency.Release();
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return MaintainerrClientResult<byte[]>.Failure(MaintainerrErrorCode.Canceled);
            }
            catch (OperationCanceledException)
            {
                return MaintainerrClientResult<byte[]>.Failure(MaintainerrErrorCode.Timeout);
            }
            catch (HttpRequestException)
            {
                LogTransportFailure(endpoint, MaintainerrTransportFailureKind.RequestFailed);
                return MaintainerrClientResult<byte[]>.Failure(MaintainerrErrorCode.UpstreamError);
            }
            catch (InvalidOperationException)
            {
                LogTransportFailure(endpoint, MaintainerrTransportFailureKind.NamedClientUnavailable);
                return MaintainerrClientResult<byte[]>.Failure(MaintainerrErrorCode.UpstreamError);
            }
            catch (Exception)
            {
                LogTransportFailure(endpoint, MaintainerrTransportFailureKind.Unexpected);
                return MaintainerrClientResult<byte[]>.Failure(MaintainerrErrorCode.UpstreamError);
            }
        }
        finally
        {
            _upstreamAdmission.Release();
        }
    }

    private void LogTransportFailure(
        MaintainerrEndpoint endpoint,
        MaintainerrTransportFailureKind failureKind)
    {
        if (!_logger.IsEnabled(LogLevel.Debug))
        {
            return;
        }

        var index = (int)endpoint;
        if ((uint)index >= (uint)_transportLogEmittedAt.Length)
        {
            return;
        }

        lock (_transportLogLock)
        {
            var now = _timeProvider.GetUtcNow();
            var previous = _transportLogEmittedAt[index];
            if (previous.HasValue
                && now >= previous.Value
                && now - previous.Value < TransportLogMinimumInterval)
            {
                return;
            }

            _transportLogEmittedAt[index] = now;
        }

        _logger.LogDebug(
            "Maintainerr transport failure for allowlisted endpoint {Endpoint}; kind {FailureKind}.",
            endpoint,
            failureKind);
    }

    internal void LogDashboardMapperFailure()
    {
        if (!_logger.IsEnabled(LogLevel.Debug))
        {
            return;
        }

        lock (_transportLogLock)
        {
            var now = _timeProvider.GetUtcNow();
            var previous = _dashboardMapperLogEmittedAt;
            if (previous.HasValue
                && now >= previous.Value
                && now - previous.Value < TransportLogMinimumInterval)
            {
                return;
            }

            _dashboardMapperLogEmittedAt = now;
        }

        _logger.LogDebug(
            "Maintainerr dashboard mapper failure; kind {FailureKind}.",
            MaintainerrMapperFailureKind.Unexpected);
    }

    private static async Task<byte[]?> ReadBoundedBodyAsync(
        HttpResponseMessage response,
        int maximumBytes,
        CancellationToken cancellationToken)
    {
        if (response.Content.Headers.ContentLength > maximumBytes)
        {
            return null;
        }

        var buffer = ArrayPool<byte>.Shared.Rent(Math.Min(64 * 1024, maximumBytes + 1));
        try
        {
            using var output = new MemoryStream(Math.Min(maximumBytes, 8192));
            using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            while (output.Length <= maximumBytes)
            {
                var remaining = (long)maximumBytes + 1 - output.Length;
                var read = await stream.ReadAsync(
                    buffer.AsMemory(0, (int)Math.Min(buffer.Length, remaining)),
                    cancellationToken).ConfigureAwait(false);
                if (read == 0)
                {
                    return output.ToArray();
                }

                output.Write(buffer, 0, read);
            }

            return null;
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }

    internal static bool TryBuildEndpoint(
        string baseUrl,
        MaintainerrEndpoint endpoint,
        object[] routeValues,
        out Uri target,
        out MaintainerrEndpointSpec spec)
    {
        target = null!;
        spec = EndpointSpec(endpoint);
        if (!ServiceUrlResolver.TryNormalizeHttpBaseUrl(baseUrl, out var normalized))
        {
            return false;
        }

        string relative;
        try
        {
            relative = endpoint switch
            {
                MaintainerrEndpoint.CollectionContent when routeValues is
                    [int collectionId, int page, int size, string sort, string sortOrder]
                    && collectionId > 0 && IsValidCollectionPage(page, size)
                    && CollectionSorts.Contains(sort) && (sortOrder == "asc" || sortOrder == "desc")
                    => $"/api/collections/media/{collectionId.ToString(CultureInfo.InvariantCulture)}/content/{page.ToString(CultureInfo.InvariantCulture)}"
                        + $"?size={size.ToString(CultureInfo.InvariantCulture)}&sort={Uri.EscapeDataString(sort)}&sortOrder={sortOrder}",
                MaintainerrEndpoint.ItemStatus when routeValues is [string itemId]
                    && Guid.TryParse(itemId, out var parsed)
                    => $"/api/media-server/meta/{parsed.ToString("N")}/maintainerr-status",
                _ when routeValues.Length == 0 => spec.Path,
                _ => string.Empty,
            };
        }
        catch (FormatException)
        {
            return false;
        }

        if (string.IsNullOrEmpty(relative)
            || !Uri.TryCreate(normalized + relative, UriKind.Absolute, out var parsedTarget)
            || parsedTarget == null)
        {
            return false;
        }

        target = parsedTarget;
        return true;
    }

    private static MaintainerrEndpointSpec EndpointSpec(MaintainerrEndpoint endpoint)
        => endpoint switch
        {
            MaintainerrEndpoint.HealthReady => new("/api/health/ready", SmallResponseBytes, false, false),
            MaintainerrEndpoint.AppStatus => new("/api/app/status", SmallResponseBytes, true, false),
            MaintainerrEndpoint.MediaServerType => new("/api/media-server/type", SmallResponseBytes, false, false),
            MaintainerrEndpoint.MediaServerIdentity => new("/api/media-server", SmallResponseBytes, false, false),
            MaintainerrEndpoint.StorageMetrics => new("/api/storage-metrics", LargeResponseBytes, false, true),
            MaintainerrEndpoint.OverlayStatus => new("/api/overlays/status", SmallResponseBytes, false, true),
            MaintainerrEndpoint.RuleCount => new("/api/rules/count", SmallResponseBytes, false, true),
            MaintainerrEndpoint.RuleExecutionStatus => new("/api/rules/execute/status", SmallResponseBytes, false, true),
            MaintainerrEndpoint.Collections => new("/api/collections", LargeResponseBytes, false, false),
            MaintainerrEndpoint.CollectionContent => new(string.Empty, LargeResponseBytes, false, true),
            MaintainerrEndpoint.ItemStatus => new(string.Empty, SmallResponseBytes, false, false),
            _ => throw new ArgumentOutOfRangeException(nameof(endpoint)),
        };

    private static bool IsValidCollectionPage(int page, int size)
        => page > 0
            && size is >= 1 and <= MaximumCollectionPageSize
            && ((long)page - 1) * size < MaximumCollectionItems;

    private MaintainerrAdminLinks? BuildAdminLinks(
        MaintainerrIntegrationSnapshot snapshot,
        string? currentJellyfinUrl)
    {
        var browserBase = ServiceUrlResolver.ResolveMappedPublicUrl(
            snapshot.InternalUrl,
            snapshot.ExternalUrl,
            snapshot.UrlMappings,
            currentJellyfinUrl);
        if (browserBase == null)
        {
            return null;
        }

        return new MaintainerrAdminLinks
        {
            Overview = ServiceUrlResolver.JoinRelativePath(browserBase, "/overview"),
            Rules = ServiceUrlResolver.JoinRelativePath(browserBase, "/rules"),
            StorageMetrics = ServiceUrlResolver.JoinRelativePath(browserBase, "/storage-metrics"),
        };
    }

    private static MaintainerrStorageSummary UnavailableStorage(MaintainerrErrorCode error)
        => new()
        {
            State = error == MaintainerrErrorCode.Unsupported ? "unsupported" : "unavailable",
            Error = ErrorName(error),
        };

    internal static MaintainerrRulesSummary BuildRulesSummary(
        MaintainerrClientResult<int> count,
        MaintainerrClientResult<MaintainerrRulesSummary> execution)
    {
        if (count.IsSuccess && execution.IsSuccess)
        {
            return new MaintainerrRulesSummary
            {
                State = "available",
                Count = count.Value,
                ProcessingQueue = execution.Value!.ProcessingQueue,
                Executing = execution.Value.Executing,
                PendingCount = execution.Value.PendingCount,
                QueueCount = execution.Value.QueueCount,
            };
        }

        var state = count.IsSuccess || execution.IsSuccess
            ? "partial"
            : count.Error == MaintainerrErrorCode.Unsupported
                && execution.Error == MaintainerrErrorCode.Unsupported
                ? "unsupported"
                : "unavailable";
        var firstError = state == "unavailable"
            ? new[] { count.Error, execution.Error }
                .FirstOrDefault(error => error.HasValue && error != MaintainerrErrorCode.Unsupported)
                ?? MaintainerrErrorCode.UpstreamError
            : count.Error ?? execution.Error ?? MaintainerrErrorCode.UpstreamError;
        return new MaintainerrRulesSummary
        {
            State = state,
            Error = ErrorName(firstError),
            Count = count.IsSuccess ? count.Value : null,
            ProcessingQueue = execution.IsSuccess ? execution.Value!.ProcessingQueue : null,
            Executing = execution.IsSuccess ? execution.Value!.Executing : null,
            PendingCount = execution.IsSuccess ? execution.Value!.PendingCount : null,
            QueueCount = execution.IsSuccess ? execution.Value!.QueueCount : null,
        };
    }

    private static MaintainerrOverlaySummary UnavailableOverlay(MaintainerrErrorCode error)
        => new()
        {
            State = error == MaintainerrErrorCode.Unsupported ? "unsupported" : "unavailable",
            Error = ErrorName(error),
        };

    private static IReadOnlyList<MaintainerrItemStatusLink> MapStatusLinks(
        IReadOnlyList<UpstreamItemStatusEntry> entries,
        string? browserBase)
    {
        var result = new List<MaintainerrItemStatusLink>(entries.Count);
        foreach (var entry in entries)
        {
            if (!TryBoundedString(entry.Label, out var label))
            {
                throw new JsonException("Invalid Maintainerr status label.");
            }

            string? href = null;
            if (!string.IsNullOrEmpty(entry.TargetPath)
                && IsAllowedStatusTarget(entry.TargetPath))
            {
                href = ServiceUrlResolver.JoinRelativePath(browserBase, entry.TargetPath);
            }

            result.Add(new MaintainerrItemStatusLink { Label = label, Href = href });
        }

        return result;
    }

    internal static bool IsAllowedStatusTarget(string targetPath)
    {
        if (targetPath.Length > 128
            || !targetPath.StartsWith("/collections/", StringComparison.Ordinal)
            || targetPath.StartsWith("//", StringComparison.Ordinal)
            || targetPath.Contains('\\')
            || targetPath.Contains('?')
            || targetPath.Contains('#')
            || targetPath.Any(char.IsControl))
        {
            return false;
        }

        var segments = targetPath.Split('/', StringSplitOptions.RemoveEmptyEntries);
        return segments.Length is 2 or 3
            && segments[0] == "collections"
            && int.TryParse(segments[1], NumberStyles.None, CultureInfo.InvariantCulture, out var id)
            && id > 0
            && (segments.Length == 2 || segments[2] == "exclusions");
    }

    private IdentityState CompareIdentity(string? upstreamIdentity)
    {
        var expected = NormalizeIdentity(_hostIdentity.SystemId);
        var actual = NormalizeIdentity(upstreamIdentity);
        if (expected.Length == 0 || actual.Length == 0)
        {
            return IdentityState.Unknown;
        }

        return string.Equals(expected, actual, StringComparison.OrdinalIgnoreCase)
            ? IdentityState.Matched
            : IdentityState.Mismatched;
    }

    private static string NormalizeIdentity(string? value)
        => string.IsNullOrWhiteSpace(value)
            ? string.Empty
            : value.Trim().Replace("-", string.Empty, StringComparison.Ordinal);

    internal static bool IsSupportedV318Version(string? value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return false;
        }

        var suffix = value.IndexOfAny(['-', '+']);
        var core = suffix < 0 ? value : value[..suffix];
        var parts = core.Split('.');
        return parts.Length == 3
            && int.TryParse(
                parts[0],
                NumberStyles.None,
                CultureInfo.InvariantCulture,
                out var major)
            && int.TryParse(
                parts[1],
                NumberStyles.None,
                CultureInfo.InvariantCulture,
                out var minor)
            && int.TryParse(
                parts[2],
                NumberStyles.None,
                CultureInfo.InvariantCulture,
                out _)
            && major == 3
            && minor == 18;
    }

    private static bool TryMediaType(string? value, out string type)
    {
        type = value ?? string.Empty;
        return MediaTypes.Contains(type);
    }

    private static bool TryBoundedString(string? value, out string bounded, int maximumLength = MaximumStringLength)
    {
        bounded = value ?? string.Empty;
        return !string.IsNullOrWhiteSpace(bounded)
            && bounded.Length <= maximumLength
            && !bounded.Any(char.IsControl);
    }

    private static bool TryOptionalIsoTimestamp(string? value, out string? timestamp)
    {
        timestamp = null;
        if (string.IsNullOrWhiteSpace(value))
        {
            return true;
        }

        if (value.Length > 64
            || !DateTimeOffset.TryParse(
                value,
                CultureInfo.InvariantCulture,
                DateTimeStyles.RoundtripKind,
                out var parsed))
        {
            return false;
        }

        timestamp = parsed.ToString("O", CultureInfo.InvariantCulture);
        return true;
    }

    private static bool TryRequiredIsoTimestamp(string? value, out string timestamp)
    {
        timestamp = string.Empty;
        if (!TryOptionalIsoTimestamp(value, out var parsed) || parsed == null)
        {
            return false;
        }

        timestamp = parsed;
        return true;
    }

    private static bool ValidOptionalNonNegative(int? value, int maximum)
        => !value.HasValue || value is >= 0 && value <= maximum;

    private static bool ValidOptionalNonNegative(long? value, long maximum)
        => !value.HasValue || value is >= 0 && value <= maximum;

    private static bool AllPresentSafeJsonIntegers(params long?[] values)
        => values.All(
            value => value.HasValue
                && value.Value >= 0
                && value.Value <= MaximumSafeJsonInteger);

    private static MaintainerrErrorCode NormalizeOperationError(
        MaintainerrErrorCode error,
        CancellationToken callerToken)
        => error == MaintainerrErrorCode.Canceled && !callerToken.IsCancellationRequested
            ? MaintainerrErrorCode.Timeout
            : error;

    private static bool ShouldBackoffDashboardFailure(MaintainerrErrorCode? error)
        => error.HasValue
            && error is not MaintainerrErrorCode.ConfigurationChanged
                and not MaintainerrErrorCode.Canceled
                and not MaintainerrErrorCode.Throttled;

    private static MaintainerrErrorCode MapSnapshotError(MaintainerrIntegrationState state)
        => state switch
        {
            MaintainerrIntegrationState.Disabled => MaintainerrErrorCode.Disabled,
            MaintainerrIntegrationState.InvalidUrl => MaintainerrErrorCode.InvalidConfiguration,
            MaintainerrIntegrationState.ConfigurationChanged => MaintainerrErrorCode.ConfigurationChanged,
            _ => MaintainerrErrorCode.InvalidConfiguration,
        };

    internal static string ErrorName(MaintainerrErrorCode error)
        => error switch
        {
            MaintainerrErrorCode.InvalidConfiguration => "invalid_configuration",
            MaintainerrErrorCode.BlockedTarget => "blocked_target",
            MaintainerrErrorCode.ResponseTooLarge => "response_too_large",
            MaintainerrErrorCode.TooLarge => "too_large",
            MaintainerrErrorCode.MalformedResponse => "malformed_body",
            MaintainerrErrorCode.ConfigurationChanged => "configuration_changed",
            MaintainerrErrorCode.IdentityMismatch => "identity_mismatch",
            MaintainerrErrorCode.WrongService => "wrong_service",
            MaintainerrErrorCode.NotReady => "not_ready",
            MaintainerrErrorCode.Throttled => "throttled",
            MaintainerrErrorCode.UpstreamError => "upstream_error",
            MaintainerrErrorCode.Unsupported => "unsupported",
            MaintainerrErrorCode.Redirect => "redirect",
            MaintainerrErrorCode.Canceled => "canceled",
            MaintainerrErrorCode.Timeout => "timeout",
            MaintainerrErrorCode.Disabled => "disabled",
            _ => "unavailable",
        };

    internal enum MaintainerrEndpoint
    {
        HealthReady,
        AppStatus,
        MediaServerType,
        MediaServerIdentity,
        StorageMetrics,
        OverlayStatus,
        RuleCount,
        RuleExecutionStatus,
        Collections,
        CollectionContent,
        ItemStatus,
    }

    private enum MaintainerrTransportFailureKind
    {
        RequestFailed,
        NamedClientUnavailable,
        Unexpected,
    }

    private enum MaintainerrMapperFailureKind
    {
        Unexpected,
    }

    internal readonly record struct MaintainerrEndpointSpec(
        string Path,
        int MaximumBytes,
        bool AllowTextHtmlJson,
        bool Optional);

    internal readonly record struct MaintainerrClientTimings(
        TimeSpan RequestDeadline,
        TimeSpan TestOperationDeadline,
        TimeSpan ItemStatusOperationDeadline,
        TimeSpan DashboardOperationDeadline,
        TimeSpan DashboardCacheTtl,
        TimeSpan DashboardRefreshMinimumInterval,
        TimeSpan DashboardFailureBackoffTtl)
    {
        public static MaintainerrClientTimings Default { get; } = new(
            MaintainerrClient.RequestDeadline,
            MaintainerrClient.TestOperationDeadline,
            MaintainerrClient.ItemStatusOperationDeadline,
            MaintainerrClient.DashboardOperationDeadline,
            MaintainerrClient.DashboardCacheTtl,
            MaintainerrClient.DashboardRefreshMinimumInterval,
            MaintainerrClient.DashboardFailureBackoffTtl);

        public bool IsValid => RequestDeadline > TimeSpan.Zero
            && TestOperationDeadline > TimeSpan.Zero
            && ItemStatusOperationDeadline > TimeSpan.Zero
            && DashboardOperationDeadline > TimeSpan.Zero
            && DashboardCacheTtl > TimeSpan.Zero
            && DashboardRefreshMinimumInterval > TimeSpan.Zero
            && DashboardFailureBackoffTtl > TimeSpan.Zero;
    }

    private enum IdentityState
    {
        Unknown,
        Matched,
        Mismatched,
    }

    private sealed record DashboardCacheEntry(
        string Key,
        MaintainerrClientResult<MaintainerrDashboardResponse> Result,
        DateTimeOffset ExpiresAt);

    private sealed record DashboardFailureEntry(
        string Key,
        MaintainerrErrorCode Error,
        int UpstreamStatus,
        DateTimeOffset ExpiresAt);

    private sealed record DashboardAttemptEntry(string Key, DateTimeOffset StartedAt);

    private sealed class DashboardFlight : IDisposable
    {
        public DashboardFlight(string key, TimeSpan operationDeadline)
        {
            Key = key;
            Deadline.CancelAfter(operationDeadline);
            Operation = CancellationTokenSource.CreateLinkedTokenSource(
                Abandonment.Token,
                Deadline.Token);
        }

        public string Key { get; }

        public CancellationTokenSource Abandonment { get; } = new();

        public CancellationTokenSource Deadline { get; } = new();

        public CancellationTokenSource Operation { get; }

        public Task<MaintainerrClientResult<MaintainerrDashboardResponse>> Task { get; set; }
            = null!;

        public int Waiters { get; set; }

        public void Dispose()
        {
            Operation.Dispose();
            Deadline.Dispose();
            Abandonment.Dispose();
        }
    }

    private sealed class UpstreamHealth
    {
        [JsonPropertyName("status")]
        public string? Status { get; set; }

        [JsonPropertyName("database")]
        public string? Database { get; set; }
    }

    private sealed class UpstreamAppStatus
    {
        [JsonPropertyName("status")]
        public int? Status { get; set; }

        [JsonPropertyName("version")]
        public string? Version { get; set; }
    }

    private sealed class UpstreamMediaServerType
    {
        [JsonPropertyName("type")]
        public string? Type { get; set; }
    }

    private sealed class UpstreamMediaServerStatus
    {
        [JsonPropertyName("machineId")]
        public string? MachineId { get; set; }
    }

    private sealed class UpstreamCollection
    {
        [JsonPropertyName("id")]
        public int? Id { get; set; }

        [JsonPropertyName("title")]
        public string? Title { get; set; }

        [JsonPropertyName("type")]
        public string? Type { get; set; }

        [JsonPropertyName("isActive")]
        public bool? IsActive { get; set; }

        [JsonPropertyName("mediaCount")]
        public int? MediaCount { get; set; }

        [JsonPropertyName("deleteAfterDays")]
        public int? DeleteAfterDays { get; set; }

        [JsonPropertyName("manualCollection")]
        public bool? ManualCollection { get; set; }

        [JsonPropertyName("handledMediaAmount")]
        public int? HandledMediaAmount { get; set; }

        [JsonPropertyName("lastDurationInSeconds")]
        public int? LastDurationInSeconds { get; set; }

        [JsonPropertyName("totalSizeBytes")]
        public long? TotalSizeBytes { get; set; }

        [JsonPropertyName("handledMediaSizeBytes")]
        public long? HandledMediaSizeBytes { get; set; }
    }

    private sealed class UpstreamStorageMetrics
    {
        [JsonPropertyName("generatedAt")]
        public string? GeneratedAt { get; set; }

        [JsonPropertyName("collectionSummary")]
        public UpstreamCollectionStorage? CollectionSummary { get; set; }

        [JsonPropertyName("cleanupTotals")]
        public UpstreamCleanupTotals? CleanupTotals { get; set; }
    }

    private sealed class UpstreamCollectionStorage
    {
        [JsonPropertyName("reclaimableCount")]
        public long? ReclaimableCount { get; set; }

        [JsonPropertyName("activeSizeBytes")]
        public long? ActiveSizeBytes { get; set; }

        [JsonPropertyName("reclaimableSizedCount")]
        public long? ReclaimableSizedCount { get; set; }

        [JsonPropertyName("inactiveCount")]
        public long? InactiveCount { get; set; }

        [JsonPropertyName("totalCollectionCount")]
        public long? TotalCollectionCount { get; set; }

        [JsonPropertyName("movieSizeBytes")]
        public long? MovieSizeBytes { get; set; }

        [JsonPropertyName("showSizeBytes")]
        public long? ShowSizeBytes { get; set; }

        [JsonPropertyName("seasonSizeBytes")]
        public long? SeasonSizeBytes { get; set; }

        [JsonPropertyName("episodeSizeBytes")]
        public long? EpisodeSizeBytes { get; set; }

        [JsonPropertyName("reclaimableMovieCount")]
        public long? ReclaimableMovieCount { get; set; }

        [JsonPropertyName("reclaimableShowCount")]
        public long? ReclaimableShowCount { get; set; }

        [JsonPropertyName("reclaimableSeasonCount")]
        public long? ReclaimableSeasonCount { get; set; }

        [JsonPropertyName("reclaimableEpisodeCount")]
        public long? ReclaimableEpisodeCount { get; set; }

        [JsonPropertyName("reclaimableUsingFallback")]
        public bool? ReclaimableUsingFallback { get; set; }
    }

    private sealed class UpstreamCleanupTotals
    {
        [JsonPropertyName("itemsHandled")]
        public long? ItemsHandled { get; set; }

        [JsonPropertyName("moviesHandled")]
        public long? MoviesHandled { get; set; }

        [JsonPropertyName("showsHandled")]
        public long? ShowsHandled { get; set; }

        [JsonPropertyName("seasonsHandled")]
        public long? SeasonsHandled { get; set; }

        [JsonPropertyName("episodesHandled")]
        public long? EpisodesHandled { get; set; }

        [JsonPropertyName("bytesHandled")]
        public long? BytesHandled { get; set; }

        [JsonPropertyName("movieBytesHandled")]
        public long? MovieBytesHandled { get; set; }

        [JsonPropertyName("showBytesHandled")]
        public long? ShowBytesHandled { get; set; }

        [JsonPropertyName("seasonBytesHandled")]
        public long? SeasonBytesHandled { get; set; }

        [JsonPropertyName("episodeBytesHandled")]
        public long? EpisodeBytesHandled { get; set; }
    }

    private sealed class UpstreamRuleStatus
    {
        [JsonPropertyName("processingQueue")]
        public bool? ProcessingQueue { get; set; }

        [JsonPropertyName("executingRuleGroupId")]
        public int? ExecutingRuleGroupId { get; set; }

        [JsonPropertyName("pendingRuleGroupIds")]
        public List<int>? PendingRuleGroupIds { get; set; }

        [JsonPropertyName("queue")]
        public List<int>? Queue { get; set; }
    }

    private sealed class UpstreamOverlayStatus
    {
        [JsonPropertyName("status")]
        public string? Status { get; set; }

        [JsonPropertyName("lastRun")]
        public string? LastRun { get; set; }
    }

    private sealed class UpstreamCollectionContent
    {
        [JsonPropertyName("totalSize")]
        public int? TotalSize { get; set; }

        [JsonPropertyName("items")]
        public List<UpstreamCollectionContentItem>? Items { get; set; }
    }

    private sealed class UpstreamCollectionContentItem
    {
        [JsonPropertyName("id")]
        public int? Id { get; set; }

        [JsonPropertyName("mediaData")]
        public UpstreamMediaData? MediaData { get; set; }
    }

    private sealed class UpstreamMediaData
    {
        [JsonPropertyName("title")]
        public string? Title { get; set; }

        [JsonPropertyName("type")]
        public string? Type { get; set; }
    }

    private sealed class UpstreamItemStatus
    {
        [JsonPropertyName("excludedFrom")]
        public List<UpstreamItemStatusEntry>? ExcludedFrom { get; set; }

        [JsonPropertyName("manuallyAddedTo")]
        public List<UpstreamItemStatusEntry>? ManuallyAddedTo { get; set; }
    }

    private sealed class UpstreamItemStatusEntry
    {
        [JsonPropertyName("label")]
        public string? Label { get; set; }

        [JsonPropertyName("targetPath")]
        public string? TargetPath { get; set; }
    }
}
