using System;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>Closed, redaction-safe outcomes for one explicit registry request.</summary>
    internal enum PlatformProviderRegistryOrchestrationStatus
    {
        Applied = 1,
        Superseded = 2,
        Cancelled = 3,
        AcquisitionFailed = 4,
        ReconcileRejected = 5,
        Stopped = 6,
        EpochExhausted = 7,
        NotStarted = 8,
    }

    /// <summary>
    /// Bounded orchestration evidence. It contains no paths, manifests, exceptions,
    /// host topology or authority-bearing values.
    /// </summary>
    internal readonly record struct PlatformProviderRegistryOrchestrationResult
    {
        private PlatformProviderRegistryOrchestrationResult(
            PlatformProviderRegistryOrchestrationStatus status,
            int acquisitionCount,
            PlatformProviderRegistryMutationStatus? registryStatus)
        {
            if (!Enum.IsDefined(status)
                || acquisitionCount is < 0 or > PlatformProviderRegistryOrchestrator.MaximumAcquisitionsPerRequest
                || (status == PlatformProviderRegistryOrchestrationStatus.Applied
                    && registryStatus != PlatformProviderRegistryMutationStatus.Applied)
                || (status == PlatformProviderRegistryOrchestrationStatus.ReconcileRejected
                    && (registryStatus is null
                        || registryStatus is PlatformProviderRegistryMutationStatus.Applied
                            or PlatformProviderRegistryMutationStatus.StaleReconciliation))
                || (status is not (
                        PlatformProviderRegistryOrchestrationStatus.Applied
                        or PlatformProviderRegistryOrchestrationStatus.ReconcileRejected)
                    && registryStatus is not null))
            {
                throw new ArgumentOutOfRangeException(nameof(status));
            }

            Status = status;
            AcquisitionCount = acquisitionCount;
            RegistryStatus = registryStatus;
        }

        internal PlatformProviderRegistryOrchestrationStatus Status { get; }

        internal int AcquisitionCount { get; }

        internal PlatformProviderRegistryMutationStatus? RegistryStatus { get; }

        internal static PlatformProviderRegistryOrchestrationResult From(
            PlatformProviderRegistryOrchestrationStatus status,
            int acquisitionCount,
            PlatformProviderRegistryMutationStatus? registryStatus = null) =>
            new(status, acquisitionCount, registryStatus);
    }

    /// <summary>
    /// The one production acquisition-to-reconcile owner. Construction and StartAsync perform
    /// no durable or host reads; ApplicationStarted requests the first lazy reconciliation.
    /// </summary>
    internal sealed class PlatformProviderRegistryOrchestrator : IHostedService
    {
        internal const int MaximumAcquisitionsPerRequest = 1;
        internal const int CompletionEventId = 5201;

        private static readonly EventId CompletionEvent = new(
            CompletionEventId,
            "PlatformProviderRegistryReconciliationCompleted");

        private readonly object _gate = new();
        private readonly IPlatformInstalledManifestSweepSource _sweepSource;
        private readonly Lazy<PlatformProviderRegistry> _registry;
        private readonly IHostApplicationLifetime? _applicationLifetime;
        private readonly ILogger<PlatformProviderRegistryOrchestrator> _logger;
        private readonly CancellationTokenSource _lifetimeCancellation = new();
        private CancellationTokenRegistration _startupRegistration;
        private ReconciliationRequest? _active;
        private ReconciliationRequest? _pending;
        private CancellationTokenSource? _activeAttemptCancellation;
        private Task? _startupDispatch;
        private Task? _worker;
        private long _requestedEpoch;
        private bool _started;
        private bool _applicationStarted;
        private bool _stopping;

        internal PlatformProviderRegistryOrchestrator(
            IPlatformInstalledManifestSweepSource sweepSource,
            Lazy<PlatformProviderRegistry> registry,
            IHostApplicationLifetime applicationLifetime,
            ILogger<PlatformProviderRegistryOrchestrator> logger)
        {
            ArgumentNullException.ThrowIfNull(sweepSource);
            ArgumentNullException.ThrowIfNull(registry);
            ArgumentNullException.ThrowIfNull(applicationLifetime);
            ArgumentNullException.ThrowIfNull(logger);
            _sweepSource = sweepSource;
            _registry = registry;
            _applicationLifetime = applicationLifetime;
            _logger = logger;
        }

        /// <summary>Test seam that does not subscribe to host lifecycle.</summary>
        internal PlatformProviderRegistryOrchestrator(
            IPlatformInstalledManifestSweepSource sweepSource,
            PlatformProviderRegistry registry,
            ILogger<PlatformProviderRegistryOrchestrator>? logger = null)
        {
            ArgumentNullException.ThrowIfNull(sweepSource);
            ArgumentNullException.ThrowIfNull(registry);
            _sweepSource = sweepSource;
            _registry = new Lazy<PlatformProviderRegistry>(() => registry);
            _logger = logger ?? NullLogger<PlatformProviderRegistryOrchestrator>.Instance;
            _applicationStarted = true;
        }

        public Task StartAsync(CancellationToken cancellationToken)
        {
            if (cancellationToken.IsCancellationRequested)
            {
                return Task.FromCanceled(cancellationToken);
            }

            lock (_gate)
            {
                if (_started || _stopping)
                {
                    return Task.CompletedTask;
                }

                if (_applicationLifetime is null)
                {
                    throw new InvalidOperationException("The test-only orchestrator cannot be hosted.");
                }

                _started = true;
                _startupRegistration = _applicationLifetime.ApplicationStarted.Register(
                    static owner => ((PlatformProviderRegistryOrchestrator)owner!).RequestStartup(),
                    this);
                return Task.CompletedTask;
            }
        }

        public async Task StopAsync(CancellationToken cancellationToken)
        {
            Task? worker;
            Task? startupDispatch;
            ReconciliationRequest? pending;
            CancellationTokenRegistration startupRegistration;
            CancellationTokenSource? activeAttemptCancellation;
            lock (_gate)
            {
                if (_stopping)
                {
                    worker = _worker;
                    startupDispatch = _startupDispatch;
                    pending = null;
                    startupRegistration = default;
                    activeAttemptCancellation = null;
                }
                else
                {
                    _stopping = true;
                    startupRegistration = _startupRegistration;
                    _startupRegistration = default;
                    activeAttemptCancellation = _activeAttemptCancellation;
                    pending = _pending;
                    _pending = null;
                    worker = _worker;
                    startupDispatch = _startupDispatch;
                    if (_registry.IsValueCreated)
                    {
                        _ = _registry.Value.BeginReconciliation();
                    }
                }
            }

            startupRegistration.Dispose();
            CancelSafely(_lifetimeCancellation);
            CancelSafely(activeAttemptCancellation);
            if (pending is not null)
            {
                pending.Complete(Result(PlatformProviderRegistryOrchestrationStatus.Stopped, 0));
                pending.Dispose();
            }
            if (startupDispatch is not null)
            {
                await startupDispatch.ConfigureAwait(false);
                lock (_gate)
                {
                    worker = _worker;
                }
            }
            if (worker is not null)
            {
                // Deliberately join the owned worker. #648 remains required before this can
                // claim bounded shutdown when a kernel or storage driver never returns.
                await worker.ConfigureAwait(false);
            }
        }

        internal ValueTask<PlatformProviderRegistryOrchestrationResult> ReconcileAsync(
            CancellationToken cancellationToken)
        {
            var request = Request(cancellationToken);
            return new ValueTask<PlatformProviderRegistryOrchestrationResult>(request.Completion.Task);
        }

        private ReconciliationRequest Request(CancellationToken cancellationToken)
        {
            ReconciliationRequest? activeToCancel = null;
            ReconciliationRequest? supersededPending = null;
            CancellationTokenSource? attemptToCancel = null;
            ReconciliationRequest request;
            lock (_gate)
            {
                if (_stopping)
                {
                    return ReconciliationRequest.Completed(Result(
                        PlatformProviderRegistryOrchestrationStatus.Stopped,
                        0));
                }

                if (!_applicationStarted)
                {
                    return ReconciliationRequest.Completed(Result(
                        PlatformProviderRegistryOrchestrationStatus.NotStarted,
                        0));
                }

                PlatformProviderRegistry registry;
                try
                {
                    registry = _registry.Value;
                }
                catch (Exception)
                {
                    return ReconciliationRequest.Completed(Result(
                        PlatformProviderRegistryOrchestrationStatus.AcquisitionFailed,
                        0));
                }

                if (_requestedEpoch == long.MaxValue)
                {
                    _ = registry.BeginReconciliation();
                    return ReconciliationRequest.Completed(Result(
                        PlatformProviderRegistryOrchestrationStatus.EpochExhausted,
                        0));
                }

                request = new ReconciliationRequest(
                    ++_requestedEpoch,
                    registry.BeginReconciliation(),
                    cancellationToken);
                if (_active is null)
                {
                    _active = request;
                    _worker = Task.Run(ProcessRequestsAsync);
                    return request;
                }

                supersededPending = _pending;
                _pending = request;
                activeToCancel = _active;
                attemptToCancel = _activeAttemptCancellation;
            }

            activeToCancel?.CancelAsSupersededSafely();
            CancelSafely(attemptToCancel);
            if (supersededPending is not null)
            {
                supersededPending.Complete(Result(
                    PlatformProviderRegistryOrchestrationStatus.Superseded,
                    0));
                supersededPending.Dispose();
            }

            return request;
        }

        private void RequestStartup()
        {
            lock (_gate)
            {
                if (_stopping)
                {
                    return;
                }

                _applicationStarted = true;
                _startupDispatch ??= Task.Run(() =>
                {
                    _ = Request(CancellationToken.None);
                });
            }
        }

        private async Task ProcessRequestsAsync()
        {
            while (true)
            {
                ReconciliationRequest request;
                CancellationToken attemptToken;
                lock (_gate)
                {
                    request = _active!;
                    _activeAttemptCancellation = CancellationTokenSource.CreateLinkedTokenSource(
                        _lifetimeCancellation.Token,
                        request.CancellationToken,
                        request.SupersessionToken);
                    attemptToken = _activeAttemptCancellation.Token;
                }

                PlatformProviderRegistryOrchestrationResult result;
                try
                {
                    result = await ExecuteRequestAsync(request, attemptToken).ConfigureAwait(false);
                }
                catch (Exception)
                {
                    result = Result(PlatformProviderRegistryOrchestrationStatus.AcquisitionFailed, 1);
                }

                TryLogCompletion(request.RequestedEpoch, result);
                request.Complete(result);

                lock (_gate)
                {
                    _activeAttemptCancellation.Dispose();
                    _activeAttemptCancellation = null;
                    request.Dispose();
                    if (_stopping)
                    {
                        _active = null;
                        return;
                    }

                    _active = _pending;
                    _pending = null;
                    if (_active is null)
                    {
                        return;
                    }
                }
            }
        }

        private async ValueTask<PlatformProviderRegistryOrchestrationResult> ExecuteRequestAsync(
            ReconciliationRequest request,
            CancellationToken attemptToken)
        {
            var registry = _registry.Value;
            using var cancellationRegistration = attemptToken.Register(
                static state =>
                {
                    var abandonment = (ReconciliationAbandonment)state!;
                    abandonment.Registry.AbandonReconciliation(abandonment.Epoch);
                },
                new ReconciliationAbandonment(registry, request.RegistryEpoch!));
            if (attemptToken.IsCancellationRequested)
            {
                return CancellationResult(request, 0);
            }

            PlatformInstalledManifestSweep sweep;
            try
            {
                sweep = await _sweepSource.SweepAsync(attemptToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (attemptToken.IsCancellationRequested)
            {
                return CancellationResult(request, 1);
            }
            catch (Exception)
            {
                return Result(PlatformProviderRegistryOrchestrationStatus.AcquisitionFailed, 1);
            }

            if (attemptToken.IsCancellationRequested)
            {
                return CancellationResult(request, 1);
            }

            var reconciliation = registry.Reconcile(request.RegistryEpoch!, sweep);
            if (reconciliation.Status == PlatformProviderRegistryMutationStatus.StaleReconciliation)
            {
                return Result(PlatformProviderRegistryOrchestrationStatus.Superseded, 1);
            }

            return reconciliation.Status == PlatformProviderRegistryMutationStatus.Applied
                ? Result(
                    PlatformProviderRegistryOrchestrationStatus.Applied,
                    1,
                    reconciliation.Status)
                : Result(
                    PlatformProviderRegistryOrchestrationStatus.ReconcileRejected,
                    1,
                    reconciliation.Status);
        }

        private PlatformProviderRegistryOrchestrationResult CancellationResult(
            ReconciliationRequest request,
            int acquisitionCount)
        {
            lock (_gate)
            {
                if (_stopping)
                {
                    return Result(PlatformProviderRegistryOrchestrationStatus.Stopped, acquisitionCount);
                }

                return request.CancellationToken.IsCancellationRequested
                    ? Result(PlatformProviderRegistryOrchestrationStatus.Cancelled, acquisitionCount)
                    : Result(PlatformProviderRegistryOrchestrationStatus.Superseded, acquisitionCount);
            }
        }

        private void TryLogCompletion(
            long requestedEpoch,
            PlatformProviderRegistryOrchestrationResult result)
        {
            try
            {
                _logger.LogInformation(
                    CompletionEvent,
                    "Platform provider registry request {RequestedEpoch} completed with {Status}; acquisitions={AcquisitionCount}; registry={RegistryStatus}",
                    requestedEpoch,
                    result.Status,
                    result.AcquisitionCount,
                    result.RegistryStatus);
            }
            catch (Exception)
            {
                // Diagnostics must never strand the authority-critical owned worker.
            }
        }

        private static void CancelSafely(CancellationTokenSource? cancellation)
        {
            if (cancellation is null)
            {
                return;
            }

            try
            {
                cancellation.Cancel();
            }
            catch (Exception)
            {
                // Epoch supersession is authoritative; cancellation is cooperative cleanup.
            }
        }

        private static PlatformProviderRegistryOrchestrationResult Result(
            PlatformProviderRegistryOrchestrationStatus status,
            int acquisitionCount,
            PlatformProviderRegistryMutationStatus? registryStatus = null) =>
            PlatformProviderRegistryOrchestrationResult.From(status, acquisitionCount, registryStatus);

        private sealed class ReconciliationRequest
        {
            private readonly CancellationTokenSource _supersession = new();

            internal ReconciliationRequest(
                long requestedEpoch,
                IPlatformProviderRegistryReconciliationEpoch? registryEpoch,
                CancellationToken cancellationToken)
            {
                RequestedEpoch = requestedEpoch;
                RegistryEpoch = registryEpoch;
                CancellationToken = cancellationToken;
                Completion = new TaskCompletionSource<PlatformProviderRegistryOrchestrationResult>(
                    TaskCreationOptions.RunContinuationsAsynchronously);
            }

            internal long RequestedEpoch { get; }

            internal IPlatformProviderRegistryReconciliationEpoch? RegistryEpoch { get; }

            internal CancellationToken CancellationToken { get; }

            internal CancellationToken SupersessionToken => _supersession.Token;

            internal TaskCompletionSource<PlatformProviderRegistryOrchestrationResult> Completion { get; }

            internal void Complete(PlatformProviderRegistryOrchestrationResult result)
                => Completion.TrySetResult(result);

            internal void CancelAsSupersededSafely()
            {
                try
                {
                    _supersession.Cancel();
                }
                catch (Exception)
                {
                    // The registry epoch was already superseded under the owner gate.
                }
            }

            internal void Dispose() => _supersession.Dispose();

            internal static ReconciliationRequest Completed(
                PlatformProviderRegistryOrchestrationResult result)
            {
                var request = new ReconciliationRequest(
                    0,
                    null,
                    CancellationToken.None);
                request.Complete(result);
                request.Dispose();
                return request;
            }
        }

        private sealed record ReconciliationAbandonment(
            PlatformProviderRegistry Registry,
            IPlatformProviderRegistryReconciliationEpoch Epoch);
    }
}
