using System;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>
    /// The sole production owner of installed-provider calls. It consumes only a completed
    /// bound operation and a minimal host-authored projection, and publishes provider data
    /// only through the registry's protected result-release linearization point.
    /// </summary>
    internal sealed class PlatformProviderInvocationService
    {
        internal const int CooperativeCancellationGraceMilliseconds = 250;

        private readonly Lazy<PlatformProviderRegistry> _registry;
        private readonly IPlatformProviderBindingHost _host;
        private readonly TimeProvider _timeProvider;

        internal PlatformProviderInvocationService(
            Lazy<PlatformProviderRegistry> registry,
            IPlatformProviderBindingHost host)
            : this(registry, host, TimeProvider.System)
        {
        }

        internal PlatformProviderInvocationService(
            Lazy<PlatformProviderRegistry> registry,
            IPlatformProviderBindingHost host,
            TimeProvider timeProvider)
        {
            ArgumentNullException.ThrowIfNull(registry);
            ArgumentNullException.ThrowIfNull(host);
            ArgumentNullException.ThrowIfNull(timeProvider);
            _registry = registry;
            _host = host;
            _timeProvider = timeProvider;
        }

        internal async Task<PlatformProviderInvocationResult> InvokeAsync(
            PlatformProviderBoundOperation boundOperation,
            PlatformProviderInvocationRequest request,
            CancellationToken callerCancellation)
        {
            if (boundOperation is null || request is null)
            {
                return Rejected(PlatformProviderInvocationStatus.InvalidRequest);
            }

            if (callerCancellation.IsCancellationRequested)
            {
                return Rejected(PlatformProviderInvocationStatus.CallerCancelled);
            }

            if (request.RemainingDeadlineMilliseconds is < 1
                or > PlatformProviderAbiContract.MaximumRemainingDeadlineMilliseconds)
            {
                return Rejected(PlatformProviderInvocationStatus.InvalidRequest);
            }

            CancellationTokenSource deadlineCancellation;
            long invocationStarted;
            try
            {
                invocationStarted = _timeProvider.GetTimestamp();
                deadlineCancellation = new CancellationTokenSource(
                    TimeSpan.FromMilliseconds(request.RemainingDeadlineMilliseconds),
                    _timeProvider);
            }
            catch (Exception)
            {
                return Rejected(PlatformProviderInvocationStatus.InvocationFailed);
            }

            PlatformProviderRequestPayloadValidationResult requestPayload;
            try
            {
                requestPayload = BuildRequestPayload(
                    boundOperation,
                    request,
                    request.RemainingDeadlineMilliseconds);
            }
            catch (Exception)
            {
                deadlineCancellation.Dispose();
                return Rejected(PlatformProviderInvocationStatus.InvalidRequest);
            }

            if (requestPayload.Status != PlatformProviderRequestPayloadValidationStatus.Succeeded
                || requestPayload.RequestJson is null)
            {
                deadlineCancellation.Dispose();
                return Rejected(Map(requestPayload.Status));
            }

            if (callerCancellation.IsCancellationRequested)
            {
                deadlineCancellation.Dispose();
                return Rejected(PlatformProviderInvocationStatus.CallerCancelled);
            }

            if (deadlineCancellation.IsCancellationRequested)
            {
                deadlineCancellation.Dispose();
                return Rejected(PlatformProviderInvocationStatus.DeadlineExceeded);
            }

            PlatformProviderRegistry registry;
            PlatformProviderInvocationLeaseResult leaseResult;
            try
            {
                registry = _registry.Value;
                leaseResult = registry.TryAcquireInvocationLease(boundOperation.Claim);
            }
            catch (Exception)
            {
                var status = callerCancellation.IsCancellationRequested
                    ? PlatformProviderInvocationStatus.CallerCancelled
                    : deadlineCancellation.IsCancellationRequested
                        ? PlatformProviderInvocationStatus.DeadlineExceeded
                        : PlatformProviderInvocationStatus.AuthorityUnavailable;
                deadlineCancellation.Dispose();
                return Rejected(status);
            }

            var invocationLease = leaseResult.Lease;
            if (callerCancellation.IsCancellationRequested)
            {
                invocationLease?.Dispose();
                deadlineCancellation.Dispose();
                return Rejected(PlatformProviderInvocationStatus.CallerCancelled);
            }

            if (deadlineCancellation.IsCancellationRequested)
            {
                invocationLease?.Dispose();
                deadlineCancellation.Dispose();
                return Rejected(PlatformProviderInvocationStatus.DeadlineExceeded);
            }

            if (leaseResult.Status != PlatformProviderInvocationLeaseStatus.Acquired
                || invocationLease is null)
            {
                deadlineCancellation.Dispose();
                return Rejected(leaseResult.Status == PlatformProviderInvocationLeaseStatus.ProviderBusy
                    ? PlatformProviderInvocationStatus.ProviderBusy
                    : PlatformProviderInvocationStatus.AuthorityChanged);
            }

            if (invocationLease.GenerationCancellation.IsCancellationRequested)
            {
                deadlineCancellation.Dispose();
                invocationLease.Dispose();
                return Rejected(PlatformProviderInvocationStatus.GenerationCancelled);
            }

            var remainingDeadlineMilliseconds = RemainingDeadlineMilliseconds(
                invocationStarted,
                request.RemainingDeadlineMilliseconds);
            if (remainingDeadlineMilliseconds <= 0
                || deadlineCancellation.IsCancellationRequested)
            {
                deadlineCancellation.Dispose();
                invocationLease.Dispose();
                return Rejected(PlatformProviderInvocationStatus.DeadlineExceeded);
            }

            try
            {
                requestPayload = BuildRequestPayload(
                    boundOperation,
                    request,
                    remainingDeadlineMilliseconds);
            }
            catch (Exception)
            {
                deadlineCancellation.Dispose();
                invocationLease.Dispose();
                return Rejected(PlatformProviderInvocationStatus.InvalidRequest);
            }

            if (requestPayload.Status != PlatformProviderRequestPayloadValidationStatus.Succeeded
                || requestPayload.RequestJson is null)
            {
                deadlineCancellation.Dispose();
                invocationLease.Dispose();
                return Rejected(Map(requestPayload.Status));
            }

            if (callerCancellation.IsCancellationRequested)
            {
                deadlineCancellation.Dispose();
                invocationLease.Dispose();
                return Rejected(PlatformProviderInvocationStatus.CallerCancelled);
            }

            if (invocationLease.GenerationCancellation.IsCancellationRequested)
            {
                deadlineCancellation.Dispose();
                invocationLease.Dispose();
                return Rejected(PlatformProviderInvocationStatus.GenerationCancelled);
            }

            if (deadlineCancellation.IsCancellationRequested)
            {
                deadlineCancellation.Dispose();
                invocationLease.Dispose();
                return Rejected(PlatformProviderInvocationStatus.DeadlineExceeded);
            }

            InvocationCancellationOwner cancellation;
            try
            {
                cancellation = new InvocationCancellationOwner(
                    callerCancellation,
                    invocationLease.GenerationCancellation,
                    deadlineCancellation);
            }
            catch (Exception)
            {
                deadlineCancellation.Dispose();
                invocationLease.Dispose();
                return Rejected(PlatformProviderInvocationStatus.InvocationFailed);
            }

            Task<string> providerTask;
            try
            {
                var returned = boundOperation.Entrypoint.InvocationMethod.Invoke(
                    boundOperation.Entrypoint.Instance,
                    new object?[]
                    {
                        boundOperation.Claim.Operation.Id,
                        requestPayload.RequestJson,
                        cancellation.ProviderCancellation,
                    });
                if (returned is not Task<string> exactTask)
                {
                    cancellation.Dispose();
                    invocationLease.Dispose();
                    return Rejected(PlatformProviderInvocationStatus.InvocationFailed);
                }

                providerTask = exactTask;
            }
            catch (TargetInvocationException)
            {
                var status = CancellationStatus(
                    callerCancellation,
                    invocationLease.GenerationCancellation,
                    cancellation.DeadlineCancellation)
                    ?? PlatformProviderInvocationStatus.ProviderFaulted;
                cancellation.Dispose();
                invocationLease.Dispose();
                return Rejected(status);
            }
            catch (Exception)
            {
                cancellation.Dispose();
                invocationLease.Dispose();
                return Rejected(PlatformProviderInvocationStatus.InvocationFailed);
            }

            return await AwaitProviderAsync(
                    registry,
                    boundOperation,
                    request,
                    invocationLease,
                    providerTask,
                    cancellation,
                    callerCancellation)
                .ConfigureAwait(false);
        }

        private async Task<PlatformProviderInvocationResult> AwaitProviderAsync(
            PlatformProviderRegistry registry,
            PlatformProviderBoundOperation boundOperation,
            PlatformProviderInvocationRequest request,
            PlatformProviderInvocationLease invocationLease,
            Task<string> providerTask,
            InvocationCancellationOwner cancellation,
            CancellationToken callerCancellation)
        {
            string? responseJson;
            try
            {
                responseJson = await providerTask
                    .WaitAsync(cancellation.ProviderCancellation)
                    .ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                var cancellationResult = await ResolveCancellationAsync(
                        providerTask,
                        invocationLease,
                        cancellation,
                        callerCancellation)
                    .ConfigureAwait(false);
                if (cancellationResult.HasValue)
                {
                    return cancellationResult.Value;
                }

                CompleteOwnedInvocation(providerTask, invocationLease, cancellation);
                return Rejected(PlatformProviderInvocationStatus.ProviderFaulted);
            }
            catch (Exception)
            {
                CompleteOwnedInvocation(providerTask, invocationLease, cancellation);
                return Rejected(PlatformProviderInvocationStatus.ProviderFaulted);
            }

            if (callerCancellation.IsCancellationRequested)
            {
                CompleteOwnedInvocation(providerTask, invocationLease, cancellation);
                return Rejected(PlatformProviderInvocationStatus.CallerCancelled);
            }

            if (invocationLease.GenerationCancellation.IsCancellationRequested)
            {
                CompleteOwnedInvocation(providerTask, invocationLease, cancellation);
                return Rejected(PlatformProviderInvocationStatus.AuthorityChanged);
            }

            if (cancellation.DeadlineCancellation.IsCancellationRequested)
            {
                CompleteOwnedInvocation(providerTask, invocationLease, cancellation);
                return Rejected(PlatformProviderInvocationStatus.DeadlineExceeded);
            }

            PlatformProviderResponsePayloadValidationResult responsePayload;
            try
            {
                responsePayload = PlatformProviderJsonPayloadValidator.ValidateResponse(
                    responseJson,
                    request.CorrelationId,
                    boundOperation.Claim.NegotiatedProtocol,
                    boundOperation.Schemas.ResponseSchema);
            }
            catch (Exception)
            {
                CompleteOwnedInvocation(providerTask, invocationLease, cancellation);
                return Rejected(PlatformProviderInvocationStatus.InvocationFailed);
            }

            var postValidationCancellation = CancellationStatus(
                callerCancellation,
                invocationLease.GenerationCancellation,
                cancellation.DeadlineCancellation);
            if (postValidationCancellation.HasValue)
            {
                CompleteOwnedInvocation(providerTask, invocationLease, cancellation);
                return Rejected(postValidationCancellation.Value
                    == PlatformProviderInvocationStatus.GenerationCancelled
                        ? PlatformProviderInvocationStatus.AuthorityChanged
                        : postValidationCancellation.Value);
            }

            if (responsePayload.Status != PlatformProviderResponsePayloadValidationStatus.Succeeded
                || !responsePayload.Result.HasValue)
            {
                CompleteOwnedInvocation(providerTask, invocationLease, cancellation);
                return Rejected(Map(responsePayload.Status));
            }

            var hostRequest = new PlatformProviderHostBindingRequest(
                boundOperation.Claim.PluginId,
                boundOperation.Claim.HostVersion);
            try
            {
                if (_host.Revalidate(hostRequest, boundOperation.Entrypoint)
                    != PlatformProviderHostBindingStatus.Bound)
                {
                    CompleteOwnedInvocation(providerTask, invocationLease, cancellation);
                    return Rejected(PlatformProviderInvocationStatus.AuthorityChanged);
                }
            }
            catch (Exception)
            {
                CompleteOwnedInvocation(providerTask, invocationLease, cancellation);
                return Rejected(PlatformProviderInvocationStatus.AuthorityChanged);
            }

            var postHostCancellation = CancellationStatus(
                callerCancellation,
                invocationLease.GenerationCancellation,
                cancellation.DeadlineCancellation);
            if (postHostCancellation.HasValue)
            {
                CompleteOwnedInvocation(providerTask, invocationLease, cancellation);
                return Rejected(postHostCancellation.Value
                    == PlatformProviderInvocationStatus.GenerationCancelled
                        ? PlatformProviderInvocationStatus.AuthorityChanged
                        : postHostCancellation.Value);
            }

            PlatformProviderResultReleaseLease? resultRelease;
            try
            {
                resultRelease = registry.TryAcquireResultReleaseLease(
                    invocationLease,
                    callerCancellation,
                    cancellation.DeadlineCancellation);
            }
            catch (Exception)
            {
                CompleteOwnedInvocation(providerTask, invocationLease, cancellation);
                return Rejected(PlatformProviderInvocationStatus.ResultReleaseRejected);
            }

            if (resultRelease is null)
            {
                var cancellationStatus = CancellationStatus(
                    callerCancellation,
                    invocationLease.GenerationCancellation,
                    cancellation.DeadlineCancellation);
                var authorityChanged = invocationLease.GenerationCancellation.IsCancellationRequested
                    || !registry.RevalidateOperationBindingClaim(boundOperation.Claim);
                CompleteOwnedInvocation(providerTask, invocationLease, cancellation);
                if (cancellationStatus == PlatformProviderInvocationStatus.CallerCancelled)
                {
                    return Rejected(PlatformProviderInvocationStatus.CallerCancelled);
                }

                return Rejected(authorityChanged
                    ? PlatformProviderInvocationStatus.AuthorityChanged
                    : cancellationStatus
                        ?? PlatformProviderInvocationStatus.ResultReleaseRejected);
            }

            PlatformProviderInvocationResult successfulResult = default;
            var resultConstructed = false;
            try
            {
                successfulResult = PlatformProviderInvocationResult.Succeeded(
                    responsePayload.Result.Value);
                resultConstructed = true;
            }
            catch (Exception)
            {
                // Bounded local result ownership still fails closed without extending
                // the protected release lease into provider-facing cleanup.
            }
            finally
            {
                resultRelease.Dispose();
            }

            CompleteOwnedInvocation(providerTask, invocationLease, cancellation);
            return resultConstructed
                ? successfulResult
                : Rejected(PlatformProviderInvocationStatus.InvocationFailed);
        }

        private async Task<PlatformProviderInvocationResult?> ResolveCancellationAsync(
            Task<string> providerTask,
            PlatformProviderInvocationLease invocationLease,
            InvocationCancellationOwner cancellation,
            CancellationToken callerCancellation)
        {
            if (callerCancellation.IsCancellationRequested)
            {
                OwnRunaway(providerTask, invocationLease, cancellation);
                return Rejected(PlatformProviderInvocationStatus.CallerCancelled);
            }

            if (invocationLease.GenerationCancellation.IsCancellationRequested)
            {
                OwnRunaway(providerTask, invocationLease, cancellation);
                return Rejected(PlatformProviderInvocationStatus.GenerationCancelled);
            }

            if (!cancellation.DeadlineCancellation.IsCancellationRequested)
            {
                return null;
            }

            try
            {
                using var priorityCancellation = CancellationTokenSource.CreateLinkedTokenSource(
                    callerCancellation,
                    invocationLease.GenerationCancellation);
                await providerTask.WaitAsync(
                        TimeSpan.FromMilliseconds(CooperativeCancellationGraceMilliseconds),
                        _timeProvider,
                        priorityCancellation.Token)
                    .ConfigureAwait(false);
            }
            catch (OperationCanceledException)
                when (callerCancellation.IsCancellationRequested
                    || invocationLease.GenerationCancellation.IsCancellationRequested)
            {
                if (callerCancellation.IsCancellationRequested)
                {
                    OwnRunaway(providerTask, invocationLease, cancellation);
                    return Rejected(PlatformProviderInvocationStatus.CallerCancelled);
                }

                OwnRunaway(providerTask, invocationLease, cancellation);
                return Rejected(PlatformProviderInvocationStatus.GenerationCancelled);
            }
            catch (TimeoutException)
            {
                OwnRunaway(providerTask, invocationLease, cancellation);
                return Rejected(PlatformProviderInvocationStatus.ProviderIgnoredCancellation);
            }
            catch (Exception)
            {
                // A cooperative cancellation or provider fault after the deadline remains
                // a deadline outcome; provider exception details never cross the boundary.
            }

            CompleteOwnedInvocation(providerTask, invocationLease, cancellation);
            return Rejected(PlatformProviderInvocationStatus.DeadlineExceeded);
        }

        private static void OwnRunaway(
            Task<string> providerTask,
            PlatformProviderInvocationLease invocationLease,
            InvocationCancellationOwner cancellation)
        {
            if (providerTask.IsCompleted)
            {
                CompleteOwnedInvocation(providerTask, invocationLease, cancellation);
                return;
            }

            _ = ObserveRunawayAsync(providerTask, invocationLease, cancellation);
        }

        private static async Task ObserveRunawayAsync(
            Task<string> providerTask,
            PlatformProviderInvocationLease invocationLease,
            InvocationCancellationOwner cancellation)
        {
            try
            {
                _ = await providerTask.ConfigureAwait(false);
            }
            catch (Exception)
            {
                // The task remains owned and its terminal fault is intentionally redacted.
            }
            finally
            {
                cancellation.Dispose();
                invocationLease.Dispose();
            }
        }

        private static void CompleteOwnedInvocation(
            Task<string> providerTask,
            PlatformProviderInvocationLease invocationLease,
            InvocationCancellationOwner cancellation)
        {
            if (providerTask.IsFaulted)
            {
                _ = providerTask.Exception;
            }

            cancellation.Dispose();
            invocationLease.Dispose();
        }

        private PlatformProviderRequestPayloadValidationResult BuildRequestPayload(
            PlatformProviderBoundOperation boundOperation,
            PlatformProviderInvocationRequest request,
            int remainingDeadlineMilliseconds) =>
            PlatformProviderJsonPayloadValidator.BuildRequest(
                new PlatformProviderRequestEnvelopeValues(
                    request.CorrelationId,
                    boundOperation.Claim.NegotiatedProtocol,
                    boundOperation.Claim.Operation.RequiredCapabilities.Capabilities
                        .Select(capability => capability.Id.Value),
                    request.UserAttribution,
                    request.DeviceAttribution,
                    request.ItemId?.ToString("D"),
                    request.Surface,
                    request.Locale,
                    request.AccessibilityHints,
                    remainingDeadlineMilliseconds,
                    request.Input),
                boundOperation.Schemas.RequestSchema);

        private int RemainingDeadlineMilliseconds(long startedTimestamp, int originalMilliseconds)
        {
            var elapsed = _timeProvider.GetElapsedTime(startedTimestamp);
            var remaining = originalMilliseconds - elapsed.TotalMilliseconds;
            return remaining <= 0
                ? 0
                : Math.Max(1, (int)Math.Floor(remaining));
        }

        private static PlatformProviderInvocationStatus? CancellationStatus(
            CancellationToken callerCancellation,
            CancellationToken generationCancellation,
            CancellationToken deadlineCancellation)
        {
            if (callerCancellation.IsCancellationRequested)
            {
                return PlatformProviderInvocationStatus.CallerCancelled;
            }

            if (generationCancellation.IsCancellationRequested)
            {
                return PlatformProviderInvocationStatus.GenerationCancelled;
            }

            return deadlineCancellation.IsCancellationRequested
                ? PlatformProviderInvocationStatus.DeadlineExceeded
                : null;
        }

        private static PlatformProviderInvocationStatus Map(
            PlatformProviderRequestPayloadValidationStatus status) => status switch
            {
                PlatformProviderRequestPayloadValidationStatus.InvalidRequest =>
                    PlatformProviderInvocationStatus.InvalidRequest,
                PlatformProviderRequestPayloadValidationStatus.RequestSchemaRejected =>
                    PlatformProviderInvocationStatus.RequestSchemaRejected,
                _ => PlatformProviderInvocationStatus.InvocationFailed,
            };

        private static PlatformProviderInvocationStatus Map(
            PlatformProviderResponsePayloadValidationStatus status) => status switch
            {
                PlatformProviderResponsePayloadValidationStatus.ResponseMissing =>
                    PlatformProviderInvocationStatus.ResponseMissing,
                PlatformProviderResponsePayloadValidationStatus.ResponseTooLarge =>
                    PlatformProviderInvocationStatus.ResponseTooLarge,
                PlatformProviderResponsePayloadValidationStatus.ResponseInvalidJson =>
                    PlatformProviderInvocationStatus.ResponseInvalidJson,
                PlatformProviderResponsePayloadValidationStatus.ResponseEnvelopeMismatch =>
                    PlatformProviderInvocationStatus.ResponseEnvelopeMismatch,
                PlatformProviderResponsePayloadValidationStatus.ResponseSchemaRejected =>
                    PlatformProviderInvocationStatus.ResponseSchemaRejected,
                _ => PlatformProviderInvocationStatus.InvocationFailed,
            };

        private static PlatformProviderInvocationResult Rejected(
            PlatformProviderInvocationStatus status) =>
            PlatformProviderInvocationResult.Rejected(status);

        /// <summary>
        /// Owns the provider-visible cancellation source until the real provider task ends.
        /// Upstream registrations call cancellation outside the registry gate and suppress
        /// arbitrary provider callback exceptions at this redaction boundary.
        /// </summary>
        private sealed class InvocationCancellationOwner : IDisposable
        {
            private readonly CancellationTokenSource _providerCancellation = new();
            private readonly CancellationTokenSource _deadlineCancellation;
            private readonly CancellationTokenRegistration _callerRegistration;
            private readonly CancellationTokenRegistration _generationRegistration;
            private readonly CancellationTokenRegistration _deadlineRegistration;
            private int _disposed;

            internal InvocationCancellationOwner(
                CancellationToken callerCancellation,
                CancellationToken generationCancellation,
                CancellationTokenSource deadlineCancellation)
            {
                ArgumentNullException.ThrowIfNull(deadlineCancellation);
                _deadlineCancellation = deadlineCancellation;
                _callerRegistration = callerCancellation.UnsafeRegister(
                    static owner => ((InvocationCancellationOwner)owner!).CancelProviderSafely(),
                    this);
                _generationRegistration = generationCancellation.UnsafeRegister(
                    static owner => ((InvocationCancellationOwner)owner!).CancelProviderSafely(),
                    this);
                _deadlineRegistration = _deadlineCancellation.Token.UnsafeRegister(
                    static owner => ((InvocationCancellationOwner)owner!).CancelProviderSafely(),
                    this);
            }

            internal CancellationToken ProviderCancellation => _providerCancellation.Token;

            internal CancellationToken DeadlineCancellation => _deadlineCancellation.Token;

            public void Dispose()
            {
                if (Interlocked.Exchange(ref _disposed, 1) != 0)
                {
                    return;
                }

                _deadlineRegistration.Dispose();
                _generationRegistration.Dispose();
                _callerRegistration.Dispose();
                _deadlineCancellation.Dispose();
                _providerCancellation.Dispose();
            }

            private void CancelProviderSafely()
            {
                try
                {
                    _providerCancellation.Cancel();
                }
                catch (Exception)
                {
                    // Provider cancellation callbacks are foreign code and stay redacted.
                }
            }
        }
    }
}
