using System;
using System.Buffers.Binary;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>The three cancellation signals kept distinct below the HTTP boundary.</summary>
    internal readonly record struct PlatformInvocationCancellation(
        CancellationToken ExecutionToken,
        CancellationToken CallerToken,
        CancellationToken DeadlineToken)
    {
        internal PlatformAuditResultCode AuditResult()
        {
            // A disconnected caller wins a simultaneous race, matching the Platform
            // lifecycle filters and avoiding attribution of peer aborts to the host.
            if (CallerToken.IsCancellationRequested)
            {
                return PlatformAuditResultCode.CallerCancelled;
            }

            return DeadlineToken.IsCancellationRequested
                ? PlatformAuditResultCode.DeadlineExceeded
                : PlatformAuditResultCode.InternalFailure;
        }
    }

    /// <summary>A transport-neutral semantic result selected by the coordinator.</summary>
    internal sealed class PlatformActionInvocationOutcome
    {
        internal PlatformActionInvocationOutcome(PlatformIdempotencyResult result, bool replayed)
        {
            Result = result ?? throw new ArgumentNullException(nameof(result));
            Replayed = replayed;
        }

        internal PlatformIdempotencyResult Result { get; }

        internal bool Replayed { get; }
    }

    /// <summary>
    /// Single admission and invocation-time reauthorization coordinator for the fixed
    /// first-party pilot actions.
    /// </summary>
    public sealed class PlatformActionInvocationCoordinator
    {
        internal const int MaximumSemanticResultBytes = 32 * 1024;

        private static readonly byte[] FingerprintDomain =
            Encoding.ASCII.GetBytes("jellyfin-canopy/platform-action-semantic-fingerprint/v1");

        private readonly IPlatformHost _host;
        private readonly PlatformPreparedActionContextOwner _preparedContexts;
        private readonly PlatformActionCapabilityService _capabilities;
        private readonly PlatformIdempotencyStore _idempotency;
        private readonly PlatformActionAdmissionLimiter _admission;
        private readonly PlatformFirstPartyActionDispatcher _dispatcher;
        private readonly PlatformAuditStore _audit;

        internal PlatformActionInvocationCoordinator(
            IPlatformHost host,
            PlatformPreparedActionContextOwner preparedContexts,
            PlatformActionCapabilityService capabilities,
            PlatformIdempotencyStore idempotency,
            PlatformActionAdmissionLimiter admission,
            PlatformFirstPartyActionDispatcher dispatcher,
            PlatformAuditStore audit)
        {
            _host = host ?? throw new ArgumentNullException(nameof(host));
            _preparedContexts = preparedContexts ?? throw new ArgumentNullException(nameof(preparedContexts));
            _capabilities = capabilities ?? throw new ArgumentNullException(nameof(capabilities));
            _idempotency = idempotency ?? throw new ArgumentNullException(nameof(idempotency));
            _admission = admission ?? throw new ArgumentNullException(nameof(admission));
            _dispatcher = dispatcher ?? throw new ArgumentNullException(nameof(dispatcher));
            _audit = audit ?? throw new ArgumentNullException(nameof(audit));
        }

        internal async Task<PlatformActionInvocationOutcome> InvokeAsync(
            PlatformActor boundaryActor,
            PlatformActionInvokeRequest request,
            PlatformInvocationCancellation cancellation)
        {
            ArgumentNullException.ThrowIfNull(boundaryActor);
            ArgumentNullException.ThrowIfNull(request);
            if (cancellation.ExecutionToken.IsCancellationRequested)
            {
                using var canceled = _audit.BeginUnresolved(boundaryActor);
                canceled.Complete(cancellation.AuditResult());
                cancellation.ExecutionToken.ThrowIfCancellationRequested();
            }

            var inspection = _capabilities.Inspect(request.Capability);
            if (cancellation.ExecutionToken.IsCancellationRequested)
            {
                using var canceled = _audit.BeginUnresolved(boundaryActor);
                canceled.Complete(cancellation.AuditResult());
                cancellation.ExecutionToken.ThrowIfCancellationRequested();
            }

            if (inspection.Kind != PlatformCapabilityInspectionKind.Authentic)
            {
                using var unresolved = _audit.BeginUnresolved(boundaryActor);
                var code = inspection.Kind == PlatformCapabilityInspectionKind.Expired
                    ? PlatformAuditResultCode.CapabilityExpired
                    : PlatformAuditResultCode.CapabilityInvalid;
                unresolved.Complete(code);
                return Reject(PlatformErrorCode.NotFound);
            }

            var prepared = _preparedContexts.Resolve(request.Capability, inspection);
            if (cancellation.ExecutionToken.IsCancellationRequested)
            {
                using var canceled = _audit.BeginUnresolved(boundaryActor);
                canceled.Complete(cancellation.AuditResult());
                cancellation.ExecutionToken.ThrowIfCancellationRequested();
            }

            if (prepared is null)
            {
                using var unresolved = _audit.BeginUnresolved(boundaryActor);
                unresolved.Complete(PlatformAuditResultCode.CapabilityInvalid);
                return Reject(PlatformErrorCode.NotFound);
            }

            using var attempt = _audit.Begin(boundaryActor, prepared.Definition);
            try
            {
                cancellation.ExecutionToken.ThrowIfCancellationRequested();
                var current = ResolveCurrent(boundaryActor, prepared);
                cancellation.ExecutionToken.ThrowIfCancellationRequested();
                if (current is null)
                {
                    return Complete(attempt, PlatformAuditResultCode.AuthorityDenied, PlatformErrorCode.NotFound);
                }

                var capabilityValidation = _capabilities.ValidateCurrent(
                    inspection,
                    current.Actor,
                    prepared.Definition.Id.Value,
                    current.Item.Id,
                    current.Item.Kind,
                    prepared.Digest.Span);
                cancellation.ExecutionToken.ThrowIfCancellationRequested();
                if (capabilityValidation.Kind != PlatformCapabilityValidationKind.Valid)
                {
                    return CompleteCapabilityValidation(attempt, capabilityValidation.Kind);
                }

                var admittedInput = _dispatcher.ValidateCurrent(
                    prepared.Definition,
                    current.Actor,
                    current.Item,
                    prepared,
                    request.Answers);
                cancellation.ExecutionToken.ThrowIfCancellationRequested();
                if (admittedInput.Decision != PlatformActionPortDecision.Admitted)
                {
                    return CompletePortRefusal(attempt, admittedInput.Decision);
                }

                var idempotencyRequest = new PlatformIdempotencyRequest(
                    current.Actor.UserId,
                    prepared.Definition.Id.Value,
                    request.IdempotencyKey,
                    CreateFingerprint(prepared, admittedInput.CanonicalInput.Span),
                    MaximumSemanticResultBytes);
                var leaderAudit = PlatformAuditResultCode.InternalFailure;
                var idempotencyOutcome = await _idempotency.ExecuteCoordinatedAsync(
                    idempotencyRequest,
                    async (execution, executionToken) =>
                    {
                        using var lease = await _admission.AcquireAsync(
                            current.Actor,
                            prepared.Definition,
                            executionToken).ConfigureAwait(false);
                        if (lease.Kind != PlatformActionAdmissionKind.Acquired)
                        {
                            leaderAudit = PlatformAuditResultCode.RateLimited;
                            return execution.AbandonBeforeSideEffect(ErrorResult(PlatformErrorCode.RateLimited));
                        }

                        executionToken.ThrowIfCancellationRequested();
                        var refreshed = ResolveCurrent(boundaryActor, prepared);
                        executionToken.ThrowIfCancellationRequested();
                        if (refreshed is null)
                        {
                            leaderAudit = PlatformAuditResultCode.AuthorityDenied;
                            return execution.AbandonBeforeSideEffect(ErrorResult(PlatformErrorCode.NotFound));
                        }

                        var refreshedCapability = _capabilities.ValidateCurrent(
                            inspection,
                            refreshed.Actor,
                            prepared.Definition.Id.Value,
                            refreshed.Item.Id,
                            refreshed.Item.Kind,
                            prepared.Digest.Span);
                        executionToken.ThrowIfCancellationRequested();
                        if (refreshedCapability.Kind != PlatformCapabilityValidationKind.Valid)
                        {
                            leaderAudit = AuditFor(refreshedCapability.Kind);
                            return execution.AbandonBeforeSideEffect(ErrorResult(ErrorFor(refreshedCapability.Kind)));
                        }

                        var refreshedInput = _dispatcher.ValidateCurrent(
                            prepared.Definition,
                            refreshed.Actor,
                            refreshed.Item,
                            prepared,
                            request.Answers);
                        executionToken.ThrowIfCancellationRequested();
                        if (refreshedInput.Decision != PlatformActionPortDecision.Admitted)
                        {
                            leaderAudit = AuditFor(refreshedInput.Decision);
                            return execution.AbandonBeforeSideEffect(ErrorResult(ErrorFor(refreshedInput.Decision)));
                        }

                        if (!CanonicalInputMatches(admittedInput.CanonicalInput.Span, refreshedInput.CanonicalInput.Span))
                        {
                            leaderAudit = PlatformAuditResultCode.AuthorityDenied;
                            return execution.AbandonBeforeSideEffect(ErrorResult(PlatformErrorCode.NotFound));
                        }

                        // Capability consumption is itself a durable replay decision.
                        // From this exact point onward an exception must retain an
                        // indeterminate idempotency tombstone.
                        executionToken.ThrowIfCancellationRequested();
                        execution.MarkSideEffectStarted();
                        var consumed = _capabilities.Consume(refreshedCapability);
                        if (consumed != PlatformCapabilityConsumeKind.Consumed)
                        {
                            leaderAudit = AuditFor(consumed);
                            return ErrorResult(ErrorFor(consumed));
                        }

                        var owner = await _dispatcher.InvokeAsync(
                            prepared.Definition,
                            refreshed.Actor,
                            refreshed.Item,
                            refreshedInput.Input!,
                            request.IdempotencyKey,
                            executionToken).ConfigureAwait(false);
                        leaderAudit = owner.AuditResultCode;
                        return owner.Result;
                    },
                    cancellation.ExecutionToken).ConfigureAwait(false);

                // A fixed owner may complete successfully without observing the linked
                // token. Keep the semantic result safely stored for a later replay, but
                // arbitrate cancellation before selecting this request's terminal audit
                // and transport outcome. The lifecycle boundary then applies its normal
                // caller-abort/no-write or deadline/timeout behavior.
                cancellation.ExecutionToken.ThrowIfCancellationRequested();
                if (idempotencyOutcome.WasCoalescedUnstored)
                {
                    return Complete(
                        attempt,
                        AuditForUnstored(idempotencyOutcome.Result!),
                        idempotencyOutcome.Result!,
                        replayed: false);
                }

                if (idempotencyOutcome.Kind == PlatformIdempotencyOutcomeKind.Replay)
                {
                    // A coalesced follower may have waited for the leader after its
                    // initial checks. Never release the stored result across authority
                    // or typed-input drift that happened during that wait.
                    var replayCurrent = ResolveCurrent(boundaryActor, prepared);
                    cancellation.ExecutionToken.ThrowIfCancellationRequested();
                    if (replayCurrent is null)
                    {
                        return Complete(attempt, PlatformAuditResultCode.AuthorityDenied, PlatformErrorCode.NotFound);
                    }

                    var replayCapability = _capabilities.ValidateCurrent(
                        inspection,
                        replayCurrent.Actor,
                        prepared.Definition.Id.Value,
                        replayCurrent.Item.Id,
                        replayCurrent.Item.Kind,
                        prepared.Digest.Span);
                    cancellation.ExecutionToken.ThrowIfCancellationRequested();
                    if (replayCapability.Kind != PlatformCapabilityValidationKind.Valid)
                    {
                        return CompleteCapabilityValidation(attempt, replayCapability.Kind);
                    }

                    var replayInput = _dispatcher.ValidateCurrent(
                        prepared.Definition,
                        replayCurrent.Actor,
                        replayCurrent.Item,
                        prepared,
                        request.Answers);
                    cancellation.ExecutionToken.ThrowIfCancellationRequested();
                    if (replayInput.Decision != PlatformActionPortDecision.Admitted)
                    {
                        return CompletePortRefusal(attempt, replayInput.Decision);
                    }

                    if (!CanonicalInputMatches(
                            admittedInput.CanonicalInput.Span,
                            replayInput.CanonicalInput.Span))
                    {
                        return Complete(attempt, PlatformAuditResultCode.AuthorityDenied, PlatformErrorCode.NotFound);
                    }
                }

                return idempotencyOutcome.Kind switch
                {
                    PlatformIdempotencyOutcomeKind.Executed =>
                        Complete(attempt, leaderAudit, idempotencyOutcome.Result!, replayed: false),
                    PlatformIdempotencyOutcomeKind.Replay =>
                        Complete(attempt, PlatformAuditResultCode.IdempotencyReplayed, idempotencyOutcome.Result!, replayed: true),
                    PlatformIdempotencyOutcomeKind.Conflict =>
                        Complete(attempt, PlatformAuditResultCode.Conflict, PlatformErrorCode.Conflict),
                    PlatformIdempotencyOutcomeKind.AtCapacity =>
                        Complete(attempt, PlatformAuditResultCode.RateLimited, PlatformErrorCode.RateLimited),
                    PlatformIdempotencyOutcomeKind.Indeterminate =>
                        Complete(attempt, PlatformAuditResultCode.Indeterminate, PlatformErrorCode.Conflict),
                    _ => Complete(attempt, PlatformAuditResultCode.InternalFailure, PlatformErrorCode.InternalError),
                };
            }
            catch (OperationCanceledException)
            {
                attempt.Complete(cancellation.AuditResult());
                throw;
            }
        }

        private CurrentAuthority? ResolveCurrent(
            PlatformActor boundaryActor,
            PlatformPreparedActionContext prepared)
        {
            var user = _host.Users.Find(boundaryActor.UserId);
            var actor = PlatformActorBoundaryFilter.Reauthorize(boundaryActor, user);
            if (actor is null)
            {
                return null;
            }

            if (!HasRequiredAuthority(prepared.Definition, actor))
            {
                return null;
            }

            var access = _host.Library.FindAccessible(actor.UserId, prepared.Item.Id);
            if (access.Item is not HostAccessibleItem item
                || item.Id != prepared.Item.Id
                || item.Kind != prepared.Item.Kind
                || item.SeriesId != prepared.Item.SeriesId
                || !prepared.Definition.SupportedItemKinds.Contains(item.Kind))
            {
                return null;
            }

            return new CurrentAuthority(actor, item);
        }

        private static bool HasRequiredAuthority(
            PlatformOperationDefinition definition,
            PlatformActor actor)
            => definition.Authority == PlatformAuthorityLevel.Authenticated
                || (definition.Authority == PlatformAuthorityLevel.Elevated && actor.IsElevated);

        private static PlatformSemanticFingerprint CreateFingerprint(
            PlatformPreparedActionContext prepared,
            ReadOnlySpan<byte> canonicalInput)
        {
            using var stream = new MemoryStream();
            stream.Write(FingerprintDomain);
            WriteString(stream, prepared.Definition.Id.Value);
            WriteString(stream, prepared.Definition.InputSchemaId.Value);
            Span<byte> item = stackalloc byte[16];
            prepared.Item.Id.TryWriteBytes(item);
            stream.Write(item);
            stream.WriteByte((byte)prepared.Item.Kind);
            stream.Write(prepared.Digest.Span);
            Span<byte> length = stackalloc byte[4];
            BinaryPrimitives.WriteInt32BigEndian(length, canonicalInput.Length);
            stream.Write(length);
            stream.Write(canonicalInput);
            return new PlatformSemanticFingerprint(
                SHA256.HashData(stream.GetBuffer().AsSpan(0, checked((int)stream.Length))));
        }

        private static bool CanonicalInputMatches(ReadOnlySpan<byte> first, ReadOnlySpan<byte> second)
        {
            var firstDigest = SHA256.HashData(first);
            var secondDigest = SHA256.HashData(second);
            return CryptographicOperations.FixedTimeEquals(firstDigest, secondDigest);
        }

        private static void WriteString(Stream stream, string value)
        {
            var bytes = Encoding.UTF8.GetBytes(value);
            Span<byte> length = stackalloc byte[2];
            BinaryPrimitives.WriteUInt16BigEndian(length, checked((ushort)bytes.Length));
            stream.Write(length);
            stream.Write(bytes);
        }

        private static PlatformActionInvocationOutcome CompleteCapabilityValidation(
            IPlatformAuditAttempt attempt,
            PlatformCapabilityValidationKind kind)
            => Complete(attempt, AuditFor(kind), ErrorFor(kind));

        private static PlatformActionInvocationOutcome CompletePortRefusal(
            IPlatformAuditAttempt attempt,
            PlatformActionPortDecision decision)
            => Complete(attempt, AuditFor(decision), ErrorFor(decision));

        private static PlatformActionInvocationOutcome Complete(
            IPlatformAuditAttempt attempt,
            PlatformAuditResultCode audit,
            string errorCode)
        {
            attempt.Complete(audit);
            return Reject(errorCode);
        }

        private static PlatformActionInvocationOutcome Complete(
            IPlatformAuditAttempt attempt,
            PlatformAuditResultCode audit,
            PlatformIdempotencyResult result,
            bool replayed)
        {
            attempt.Complete(audit);
            return new PlatformActionInvocationOutcome(result, replayed);
        }

        private static PlatformActionInvocationOutcome Reject(string errorCode)
            => new(ErrorResult(errorCode), replayed: false);

        private static PlatformIdempotencyResult ErrorResult(string errorCode)
        {
            using var document = JsonDocument.Parse("{}");
            return new PlatformIdempotencyResult(
                PlatformErrorCode.StatusFor(errorCode),
                errorCode,
                document.RootElement);
        }

        private static PlatformAuditResultCode AuditFor(PlatformCapabilityValidationKind kind) => kind switch
        {
            PlatformCapabilityValidationKind.Expired => PlatformAuditResultCode.CapabilityExpired,
            PlatformCapabilityValidationKind.StaleAuthority or PlatformCapabilityValidationKind.NotAuthorized
                => PlatformAuditResultCode.AuthorityDenied,
            _ => PlatformAuditResultCode.CapabilityInvalid,
        };

        private static string ErrorFor(PlatformCapabilityValidationKind kind) => kind switch
        {
            PlatformCapabilityValidationKind.Expired
                or PlatformCapabilityValidationKind.StaleAuthority
                or PlatformCapabilityValidationKind.NotAuthorized => PlatformErrorCode.NotFound,
            _ => PlatformErrorCode.NotFound,
        };

        private static PlatformAuditResultCode AuditFor(PlatformCapabilityConsumeKind kind) => kind switch
        {
            PlatformCapabilityConsumeKind.Replay => PlatformAuditResultCode.CapabilityReplayed,
            PlatformCapabilityConsumeKind.Expired => PlatformAuditResultCode.CapabilityExpired,
            PlatformCapabilityConsumeKind.StaleAuthority => PlatformAuditResultCode.AuthorityDenied,
            _ => PlatformAuditResultCode.CapabilityInvalid,
        };

        private static string ErrorFor(PlatformCapabilityConsumeKind kind) => kind switch
        {
            PlatformCapabilityConsumeKind.Replay => PlatformErrorCode.Conflict,
            _ => PlatformErrorCode.NotFound,
        };

        private static PlatformAuditResultCode AuditFor(PlatformActionPortDecision decision) => decision switch
        {
            PlatformActionPortDecision.AuthorityDenied => PlatformAuditResultCode.AuthorityDenied,
            PlatformActionPortDecision.InvalidInput => PlatformAuditResultCode.InvalidInput,
            PlatformActionPortDecision.UnknownOwner => PlatformAuditResultCode.OwnerFailed,
            _ => PlatformAuditResultCode.InternalFailure,
        };

        private static PlatformAuditResultCode AuditForUnstored(PlatformIdempotencyResult result)
            => result.OutcomeCode switch
            {
                PlatformErrorCode.RateLimited => PlatformAuditResultCode.RateLimited,
                PlatformErrorCode.NotFound => PlatformAuditResultCode.AuthorityDenied,
                PlatformErrorCode.InvalidRequest => PlatformAuditResultCode.InvalidInput,
                _ => PlatformAuditResultCode.InternalFailure,
            };

        private static string ErrorFor(PlatformActionPortDecision decision) => decision switch
        {
            PlatformActionPortDecision.AuthorityDenied => PlatformErrorCode.NotFound,
            PlatformActionPortDecision.InvalidInput => PlatformErrorCode.InvalidRequest,
            PlatformActionPortDecision.UnknownOwner => PlatformErrorCode.Unavailable,
            _ => PlatformErrorCode.InternalError,
        };

        private sealed record CurrentAuthority(PlatformActor Actor, HostAccessibleItem Item);
    }
}
