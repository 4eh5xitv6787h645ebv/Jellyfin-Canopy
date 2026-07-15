using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services
{
    // Lifecycle-owned bridge from Jellyfin's library ItemAdded event to Seerr's
    // recently-added scan. One timer and one worker own automatic and manual
    // triggers so network calls never overlap and shutdown can cancel and join them.
    public sealed class SeerrScanTriggerService : IDisposable
    {
        private const string ScanJobId = "jellyfin-recently-added-scan";
        private const int MinDebounceSeconds = 5;
        private const int MaxDebounceSeconds = 3600;
        private const int MaximumLatencyWindows = 4;

        private readonly ILibraryManager _libraryManager;
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly ILogger<SeerrScanTriggerService> _logger;
        private readonly IPluginConfigProvider _configProvider;
        private readonly TimeProvider _timeProvider;
        private readonly object _stateLock = new();
        private readonly CancellationTokenSource _lifetimeCancellation = new();
        private readonly TaskCompletionSource _disposeFinished =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly ITimer _debounceTimer;

        private DateTimeOffset? _firstPendingAt;
        private int _pendingCount;
        private bool _subscribed;
        private bool _disposed;
        private DispatchPlan? _activePlan;
        private DispatchPlan? _queuedPlan;
        private Task _workerTask = Task.CompletedTask;

        // Deterministic seam for the completion-to-state-transition race. A manual caller that
        // arrives after results publish but before the worker clears _activePlan must queue a new
        // scan rather than joining the already-completed one.
        internal Action? OnAfterPlanCompletedForTest;

        public SeerrScanTriggerService(
            ILibraryManager libraryManager,
            IHttpClientFactory httpClientFactory,
            ILogger<SeerrScanTriggerService> logger,
            IPluginConfigProvider configProvider)
            : this(libraryManager, httpClientFactory, logger, configProvider, TimeProvider.System)
        {
        }

        internal SeerrScanTriggerService(
            ILibraryManager libraryManager,
            IHttpClientFactory httpClientFactory,
            ILogger<SeerrScanTriggerService> logger,
            IPluginConfigProvider configProvider,
            TimeProvider timeProvider)
        {
            _libraryManager = libraryManager;
            _httpClientFactory = httpClientFactory;
            _logger = logger;
            _configProvider = configProvider;
            _timeProvider = timeProvider;
            _debounceTimer = _timeProvider.CreateTimer(
                OnDebounceElapsed,
                null,
                Timeout.InfiniteTimeSpan,
                Timeout.InfiniteTimeSpan);
        }

        public void Initialize()
        {
            lock (_stateLock)
            {
                ObjectDisposedException.ThrowIf(_disposed, this);
                if (_subscribed) return;
                _libraryManager.ItemAdded += OnItemAdded;
                _subscribed = true;
            }

            _logger.LogInformation("[SeerrScan] Subscribed to library ItemAdded events");
        }

        private void OnItemAdded(object? sender, ItemChangeEventArgs e)
        {
            // PERF(S1): Jellyfin raises this synchronously on its scan thread. Configuration and
            // kind checks plus the bounded state update below are the only work done inline.
            try
            {
                if (_configProvider.ConfigurationOrNull is not PluginConfiguration config) return;
                if (!config.TriggerSeerrScanOnItemAdded
                    || !SeerrIntegrationPolicy.AllowsDeferredScheduling(config)) return;

                var kind = e.Item?.GetBaseItemKind();
                if (kind != BaseItemKind.Movie
                    && kind != BaseItemKind.Series
                    && kind != BaseItemKind.Season
                    && kind != BaseItemKind.Episode)
                {
                    return;
                }

                var debounce = TimeSpan.FromSeconds(ClampDebounceSeconds(config.SeerrScanDebounceSeconds));
                lock (_stateLock)
                {
                    if (_disposed) return;
                    var now = _timeProvider.GetUtcNow();
                    _firstPendingAt ??= now;
                    if (_pendingCount < int.MaxValue)
                    {
                        _pendingCount++;
                    }

                    _debounceTimer.Change(
                        ComputeDispatchDelay(_firstPendingAt.Value, now, debounce),
                        Timeout.InfiniteTimeSpan);
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[SeerrScan] OnItemAdded handler failed");
            }
        }

        private void OnDebounceElapsed(object? state)
        {
            try
            {
                lock (_stateLock)
                {
                    if (_disposed) return;
                    _debounceTimer.Change(Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
                    var batchSize = DrainPendingLocked();
                    if (batchSize <= 0) return;

                    QueueAutomaticPlanLocked(CreateAutomaticPlan(batchSize));
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[SeerrScan] Debounce callback failed");
            }
        }

        // Manual and timer dispatches enter the same single-flight worker. A manual trigger drains
        // the trailing timer first. If the same URL/key is already in flight, the caller joins that
        // exact run; otherwise it occupies (or joins) the sole coalesced follow-up slot.
        public async Task<DispatchResult> TriggerNowAsync(
            string url,
            string apiKey,
            CancellationToken cancellationToken = default)
        {
            var results = await TriggerNowAsync(
                new[] { url },
                apiKey,
                cancellationToken).ConfigureAwait(false);
            return FindManualResult(results, url, apiKey);
        }

        public Task<IReadOnlyList<DispatchResult>> TriggerNowAsync(
            IReadOnlyList<string> urls,
            string apiKey,
            CancellationToken cancellationToken = default)
        {
            ArgumentNullException.ThrowIfNull(urls);
            if (urls.Count == 0) throw new ArgumentException("At least one Seerr URL is required.", nameof(urls));

            var integration = SeerrIntegrationPolicy.Capture(_configProvider);
            var allowedUrls = integration.Urls.ToHashSet(StringComparer.Ordinal);
            if (!integration.IsActive
                || !string.Equals(apiKey, integration.ApiKey, StringComparison.Ordinal)
                || urls.Any(url => !allowedUrls.Contains(url)))
            {
                return Task.FromResult<IReadOnlyList<DispatchResult>>(
                    urls.Distinct(StringComparer.Ordinal)
                        .Select(url => DispatchResult.PolicyDeniedResult(
                            url,
                            apiKey,
                            integration.State))
                        .ToArray());
            }

            DispatchPlan plan;
            lock (_stateLock)
            {
                ObjectDisposedException.ThrowIf(_disposed, this);
                _debounceTimer.Change(Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
                var drainedEvents = DrainPendingLocked();
                var manualPlan = DispatchPlan.Manual(
                    urls,
                    apiKey,
                    drainedEvents,
                    integration.CreateDispatchFence(_configProvider),
                    integration.ConfigurationRevision);
                if (drainedEvents > 0)
                {
                    manualPlan.AddTargets(CreateAutomaticPlan(drainedEvents).Targets);
                }

                if (drainedEvents == 0
                    && _queuedPlan == null
                    && _activePlan?.Completion.Task.IsCompleted == false
                    && _activePlan.ContainsAll(manualPlan.Targets))
                {
                    plan = _activePlan;
                }
                else if (_activePlan == null)
                {
                    plan = manualPlan;
                    StartPlanLocked(plan);
                }
                else
                {
                    if (_queuedPlan == null || !_queuedPlan.IsManual)
                    {
                        if (_queuedPlan != null)
                        {
                            manualPlan.AddTargets(_queuedPlan.Targets);
                            manualPlan.AddBatchSize(_queuedPlan.BatchSize);
                        }

                        _queuedPlan?.Completion.TrySetResult(Array.Empty<DispatchResult>());
                        _queuedPlan = manualPlan;
                    }
                    else
                    {
                        _queuedPlan.AddTargets(manualPlan.Targets);
                        _queuedPlan.AddBatchSize(drainedEvents);
                    }

                    plan = _queuedPlan;
                }
            }

            return plan.Completion.Task.WaitAsync(cancellationToken);
        }

        // Direct execution remains an internal test seam for configuration-generation fencing.
        // Production timer and controller paths always use the lifecycle-owned worker above.
        internal Task<IReadOnlyList<DispatchResult>> DispatchAsync(int batchSize)
            => ExecutePlanAsync(CreateAutomaticPlan(batchSize), _lifetimeCancellation.Token);

        internal static TimeSpan ComputeDispatchDelay(
            DateTimeOffset firstPendingAt,
            DateTimeOffset now,
            TimeSpan debounce)
        {
            var maximumLatency = TimeSpan.FromTicks(Math.Min(
                debounce.Ticks * MaximumLatencyWindows,
                TimeSpan.FromSeconds(MaxDebounceSeconds).Ticks));
            var remaining = maximumLatency - (now - firstPendingAt);
            if (remaining <= TimeSpan.Zero) return TimeSpan.Zero;
            return remaining < debounce ? remaining : debounce;
        }

        private static DispatchResult FindManualResult(
            IReadOnlyList<DispatchResult> results,
            string url,
            string apiKey)
        {
            return results.FirstOrDefault(result => string.Equals(result.Url, url, StringComparison.Ordinal)
                    && string.Equals(result.TargetApiKey, apiKey, StringComparison.Ordinal))
                ?? new DispatchResult
                {
                    Url = url,
                    Success = false,
                    StatusCode = 409,
                    ErrorCode = "DispatchSuperseded",
                    Body = "The joined dispatch ended before it reached this Seerr identity domain; retry the trigger.",
                };
        }

        private int DrainPendingLocked()
        {
            var batchSize = _pendingCount;
            _pendingCount = 0;
            _firstPendingAt = null;
            return batchSize;
        }

        private DispatchPlan CreateAutomaticPlan(int batchSize)
        {
            var integration = SeerrIntegrationPolicy.Capture(_configProvider);
            var config = integration.Configuration;
            if (!integration.IsActive
                || config == null
                || !config.TriggerSeerrScanOnItemAdded)
            {
                return DispatchPlan.Automatic(
                    batchSize,
                    Array.Empty<DispatchTarget>(),
                    integration.ConfigurationRevision);
            }

            var targets = integration.Urls
                .Select(url => new DispatchTarget(
                    url,
                    integration.ApiKey,
                    integration.CreateDispatchFence(_configProvider)))
                .ToArray();
            return DispatchPlan.Automatic(
                batchSize,
                targets,
                integration.ConfigurationRevision);
        }

        private void QueueAutomaticPlanLocked(DispatchPlan plan)
        {
            if (_activePlan == null)
            {
                StartPlanLocked(plan);
                return;
            }

            if (_queuedPlan == null)
            {
                _queuedPlan = plan;
                return;
            }

            if (_queuedPlan.IsManual)
            {
                // The queued manual scan is the coalesced follow-up for events that arrived while
                // the active run was in flight. Preserve automatic-only identity domains and their
                // configuration stamps inside that same single follow-up plan.
                _queuedPlan.AddTargets(plan.Targets);
                _queuedPlan.AddBatchSize(plan.BatchSize);
                plan.Completion.TrySetResult(Array.Empty<DispatchResult>());
                return;
            }

            if (_queuedPlan.ConfigurationRevision == plan.ConfigurationRevision)
            {
                _queuedPlan.AddBatchSize(plan.BatchSize);
                plan.Completion.TrySetResult(Array.Empty<DispatchResult>());
                return;
            }

            // A configuration replacement retires the older queued mutation generation.
            _queuedPlan.Completion.TrySetResult(Array.Empty<DispatchResult>());
            _queuedPlan = plan;
        }

        private void StartPlanLocked(DispatchPlan plan)
        {
            _activePlan = plan;
            _workerTask = Task.Run(() => RunWorkerAsync(plan));
        }

        private async Task RunWorkerAsync(DispatchPlan initialPlan)
        {
            var plan = initialPlan;
            while (true)
            {
                IReadOnlyList<DispatchResult> results;
                try
                {
                    results = await ExecutePlanAsync(plan, _lifetimeCancellation.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (_lifetimeCancellation.IsCancellationRequested)
                {
                    results = plan.Targets.Select(DispatchResult.CancelledResult).ToArray();
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "[SeerrScan] Dispatch worker failed");
                    results = plan.Targets.Select(target => new DispatchResult
                    {
                        Url = target.Url,
                        Success = false,
                        Body = ex.Message,
                        TargetApiKey = target.ApiKey,
                    }).ToArray();
                }

                plan.Completion.TrySetResult(results);
                OnAfterPlanCompletedForTest?.Invoke();

                lock (_stateLock)
                {
                    if (_disposed)
                    {
                        _activePlan = null;
                        CompleteAsCancelled(_queuedPlan);
                        _queuedPlan = null;
                        return;
                    }

                    if (_queuedPlan == null)
                    {
                        _activePlan = null;
                        return;
                    }

                    plan = _queuedPlan;
                    _queuedPlan = null;
                    _activePlan = plan;
                }
            }
        }

        private async Task<IReadOnlyList<DispatchResult>> ExecutePlanAsync(
            DispatchPlan plan,
            CancellationToken cancellationToken)
        {
            var results = new List<DispatchResult>();
            if (plan.Targets.Count == 0)
            {
                _logger.LogWarning("[SeerrScan] Cannot dispatch: Seerr URL(s) or API key not configured, or trigger disabled");
                return results;
            }

            for (var targetIndex = 0; targetIndex < plan.Targets.Count; targetIndex++)
            {
                var target = plan.Targets[targetIndex];
                cancellationToken.ThrowIfCancellationRequested();
                if (target.DispatchFence?.CanDispatch() != true)
                {
                    _logger.LogWarning(
                        "[SeerrScan] Configuration changed before dispatch to {Url}; that retired automatic target was not triggered",
                        target.Url);
                    results.Add(DispatchResult.ConfigurationChangedResult(target));
                    continue;
                }

                var result = await PostScanTrigger(
                    target.Url,
                    target.ApiKey,
                    target.DispatchFence!,
                    cancellationToken).ConfigureAwait(false);
                results.Add(result);
                if (result.Success)
                {
                    if (plan.IsManual)
                    {
                        _logger.LogInformation(
                            "[SeerrScan] Triggered Seerr recently-added scan (manual) - {Url}",
                            target.Url);
                    }
                    else
                    {
                        _logger.LogInformation(
                            "[SeerrScan] Triggered Seerr recently-added scan after {BatchSize} library item(s) - {Url}",
                            plan.BatchSize,
                            target.Url);
                    }
                }
                else if (!result.Cancelled)
                {
                    _logger.LogWarning(
                        "[SeerrScan] Trigger failed for {Url}: HTTP {StatusCode} - {Body}",
                        target.Url,
                        result.StatusCode,
                        result.Body);
                }
            }

            return results;
        }

        private async Task<DispatchResult> PostScanTrigger(
            string url,
            string apiKey,
            SeerrDispatchFence dispatchFence,
            CancellationToken cancellationToken)
        {
            var endpoint = $"{url.TrimEnd('/')}/api/v1/settings/jobs/{ScanJobId}/run";
            try
            {
                if (!dispatchFence.CanDispatch())
                {
                    return DispatchResult.ConfigurationChangedResult(
                        new DispatchTarget(url, apiKey, null));
                }

                var http = Helpers.Seerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
                http.Timeout = TimeSpan.FromSeconds(15);
                using var request = Helpers.Seerr.SeerrHttpHelper.BuildRequest(
                    HttpMethod.Post,
                    endpoint,
                    apiKey,
                    bodyJson: "{}");

                var (json, error, httpStatus) = await Helpers.Seerr.SeerrHttpHelper.SendAndReadJsonAsync(
                    http,
                    request,
                    endpoint,
                    dispatchFence,
                    cancellationToken).ConfigureAwait(false);
                return new DispatchResult
                {
                    Url = url,
                    Success = error == null,
                    StatusCode = error?.HttpStatus ?? httpStatus,
                    Body = Truncate(error?.Message ?? (json ?? string.Empty), 256),
                    ErrorCode = error?.Code.ToString() ?? string.Empty,
                    CfRay = error?.CfRay ?? string.Empty,
                    TargetApiKey = apiKey,
                };
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return DispatchResult.CancelledResult(new DispatchTarget(url, apiKey, null));
            }
            catch (Exception ex)
            {
                return new DispatchResult
                {
                    Url = url,
                    Success = false,
                    Body = ex.Message,
                    TargetApiKey = apiKey,
                };
            }
        }

        internal static List<string> ParseUrls(string? raw)
            => Seerr.SeerrClient.GetConfiguredUrls(raw).ToList();

        private static int ClampDebounceSeconds(int requested)
        {
            if (requested < MinDebounceSeconds) return MinDebounceSeconds;
            if (requested > MaxDebounceSeconds) return MaxDebounceSeconds;
            return requested;
        }

        private static string Truncate(string value, int maximumLength)
        {
            if (string.IsNullOrEmpty(value)) return string.Empty;
            return value.Length <= maximumLength
                ? value
                : value.Substring(0, maximumLength) + "...";
        }

        public void Dispose()
        {
            Task worker;
            var ownsDisposal = false;
            lock (_stateLock)
            {
                if (!_disposed)
                {
                    ownsDisposal = true;
                    _disposed = true;
                    if (_subscribed)
                    {
                        _libraryManager.ItemAdded -= OnItemAdded;
                        _subscribed = false;
                    }

                    _pendingCount = 0;
                    _firstPendingAt = null;
                    _debounceTimer.Change(Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
                    _debounceTimer.Dispose();
                    CompleteAsCancelled(_queuedPlan);
                    _queuedPlan = null;
                    _lifetimeCancellation.Cancel();
                }

                worker = _workerTask;
            }

            if (!ownsDisposal)
            {
                _disposeFinished.Task.GetAwaiter().GetResult();
                return;
            }

            try
            {
                worker.GetAwaiter().GetResult();
            }
            catch (OperationCanceledException)
            {
                // Expected when the owned HTTP request observes lifetime cancellation.
            }
            finally
            {
                _lifetimeCancellation.Dispose();
                _disposeFinished.TrySetResult();
                GC.SuppressFinalize(this);
            }
        }

        internal sealed record DispatchTarget(
            string Url,
            string ApiKey,
            SeerrDispatchFence? DispatchFence);

        private static void CompleteAsCancelled(DispatchPlan? plan)
        {
            if (plan == null) return;
            plan.Completion.TrySetResult(
                plan.Targets.Select(DispatchResult.CancelledResult).ToArray());
        }

        private sealed class DispatchPlan
        {
            private readonly List<DispatchTarget> _targets;

            private DispatchPlan(
                bool isManual,
                int batchSize,
                IEnumerable<DispatchTarget> targets,
                long configurationRevision)
            {
                IsManual = isManual;
                BatchSize = batchSize;
                _targets = targets.ToList();
                ConfigurationRevision = configurationRevision;
            }

            public bool IsManual { get; }
            public int BatchSize { get; private set; }
            public IReadOnlyList<DispatchTarget> Targets => _targets;
            public long ConfigurationRevision { get; }
            public TaskCompletionSource<IReadOnlyList<DispatchResult>> Completion { get; } =
                new(TaskCreationOptions.RunContinuationsAsynchronously);

            public static DispatchPlan Manual(
                IEnumerable<string> urls,
                string apiKey,
                int batchSize,
                SeerrDispatchFence dispatchFence,
                long configurationRevision)
                => new(
                    true,
                    batchSize,
                    urls.Distinct(StringComparer.Ordinal)
                        .Select(url => new DispatchTarget(url, apiKey, dispatchFence)),
                    configurationRevision);

            public static DispatchPlan Automatic(
                int batchSize,
                IEnumerable<DispatchTarget> targets,
                long configurationRevision)
                => new(false, batchSize, targets, configurationRevision);

            public bool ContainsAll(IEnumerable<DispatchTarget> targets)
                => targets.All(candidate => _targets.Any(target => SameIdentity(target, candidate)));

            public void AddTargets(IEnumerable<DispatchTarget> targets)
            {
                foreach (var candidate in targets)
                {
                    if (!_targets.Any(target => SameIdentity(target, candidate)))
                    {
                        _targets.Add(candidate);
                    }
                }
            }

            private static bool SameIdentity(DispatchTarget left, DispatchTarget right)
                => string.Equals(left.Url, right.Url, StringComparison.Ordinal)
                    && string.Equals(left.ApiKey, right.ApiKey, StringComparison.Ordinal);

            public void AddBatchSize(int batchSize)
            {
                if (batchSize <= 0 || BatchSize == int.MaxValue) return;
                BatchSize = batchSize > int.MaxValue - BatchSize
                    ? int.MaxValue
                    : BatchSize + batchSize;
            }
        }

        public sealed class DispatchResult
        {
            public string Url { get; set; } = string.Empty;
            public bool Success { get; set; }
            public int StatusCode { get; set; }
            public string Body { get; set; } = string.Empty;
            public string ErrorCode { get; set; } = string.Empty;
            public string CfRay { get; set; } = string.Empty;
            public bool Cancelled { get; set; }
            internal string TargetApiKey { get; set; } = string.Empty;

            internal static DispatchResult CancelledResult(DispatchTarget target)
                => new()
                {
                    Url = target.Url,
                    Success = false,
                    Body = "The Seerr scan trigger was cancelled because the service is stopping.",
                    Cancelled = true,
                    TargetApiKey = target.ApiKey,
                };

            internal static DispatchResult ConfigurationChangedResult(DispatchTarget target)
                => new()
                {
                    Url = target.Url,
                    Success = false,
                    StatusCode = 409,
                    ErrorCode = "ConfigurationChanged",
                    Body = "Seerr configuration changed before this trigger was sent; retry with the current settings.",
                    TargetApiKey = target.ApiKey,
                };

            internal static DispatchResult PolicyDeniedResult(
                string url,
                string apiKey,
                SeerrIntegrationState state)
                => new()
                {
                    Url = url,
                    Success = false,
                    StatusCode = 503,
                    ErrorCode = state == SeerrIntegrationState.Disabled
                        ? "SeerrDisabled"
                        : "ConfigurationChanged",
                    Body = state == SeerrIntegrationState.Disabled
                        ? "Seerr integration is disabled; no scan trigger was sent."
                        : "The supplied Seerr target is not the active saved integration; no scan trigger was sent.",
                    TargetApiKey = apiKey,
                };
        }
    }
}
