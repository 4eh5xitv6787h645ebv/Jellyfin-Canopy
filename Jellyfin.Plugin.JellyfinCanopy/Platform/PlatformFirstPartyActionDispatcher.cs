using System;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>Marker implemented only by one named first-party port's typed input.</summary>
    internal interface IPlatformValidatedActionInput
    {
    }

    internal enum PlatformActionPortDecision
    {
        Admitted,
        AuthorityDenied,
        InvalidInput,
        UnknownOwner,
    }

    /// <summary>A named port's current feature-authority and typed-input decision.</summary>
    internal sealed class PlatformActionPortAdmission
    {
        private readonly byte[] _canonicalInput;

        private PlatformActionPortAdmission(
            PlatformActionPortDecision decision,
            IPlatformValidatedActionInput? input,
            ReadOnlySpan<byte> canonicalInput)
        {
            Decision = decision;
            Input = input;
            _canonicalInput = canonicalInput.ToArray();
        }

        internal PlatformActionPortDecision Decision { get; }

        internal IPlatformValidatedActionInput? Input { get; }

        internal ReadOnlyMemory<byte> CanonicalInput => _canonicalInput;

        internal static PlatformActionPortAdmission Admit(
            IPlatformValidatedActionInput input,
            ReadOnlySpan<byte> canonicalInput)
        {
            ArgumentNullException.ThrowIfNull(input);
            if (canonicalInput.Length is < 1 or > PlatformPreparedActionContextOwner.MaximumPrivateStateBytes)
            {
                throw new ArgumentException("Canonical typed input is outside its fixed byte bound.", nameof(canonicalInput));
            }

            return new PlatformActionPortAdmission(PlatformActionPortDecision.Admitted, input, canonicalInput);
        }

        internal static PlatformActionPortAdmission Refuse(PlatformActionPortDecision decision)
        {
            if (decision == PlatformActionPortDecision.Admitted || !Enum.IsDefined(decision))
            {
                throw new ArgumentOutOfRangeException(nameof(decision));
            }

            return new PlatformActionPortAdmission(decision, input: null, ReadOnlySpan<byte>.Empty);
        }
    }

    /// <summary>Closed HTTP-free semantic output from a first-party owning adapter.</summary>
    internal sealed class PlatformActionOwnerResult
    {
        internal PlatformActionOwnerResult(
            PlatformIdempotencyResult result,
            PlatformAuditResultCode auditResultCode)
        {
            Result = result ?? throw new ArgumentNullException(nameof(result));
            if (auditResultCode is not (PlatformAuditResultCode.Succeeded or PlatformAuditResultCode.OwnerFailed))
            {
                throw new ArgumentOutOfRangeException(nameof(auditResultCode));
            }

            AuditResultCode = auditResultCode;
        }

        internal PlatformIdempotencyResult Result { get; }

        internal PlatformAuditResultCode AuditResultCode { get; }

        internal static PlatformActionOwnerResult Succeeded(JsonElement value)
            => new(new PlatformIdempotencyResult(200, "succeeded", value), PlatformAuditResultCode.Succeeded);

        internal static PlatformActionOwnerResult Failed(string errorCode, JsonElement value)
            => new(
                new PlatformIdempotencyResult(PlatformErrorCode.StatusFor(errorCode), errorCode, value),
                PlatformAuditResultCode.OwnerFailed);
    }

    internal interface ISpoilerGuardPlatformActionPort
    {
        PlatformActionPortAdmission ValidateCurrent(
            PlatformActor actor,
            HostAccessibleItem item,
            PlatformPreparedActionContext prepared,
            System.Collections.Immutable.ImmutableArray<PlatformActionAnswer> answers);

        Task<PlatformActionOwnerResult> InvokeAsync(
            PlatformActor actor,
            HostAccessibleItem item,
            IPlatformValidatedActionInput input,
            PlatformIdempotencyKey idempotencyKey,
            CancellationToken cancellationToken);
    }

    internal interface IHiddenContentPlatformActionPort
    {
        PlatformActionPortAdmission ValidateCurrent(
            PlatformActor actor,
            HostAccessibleItem item,
            PlatformPreparedActionContext prepared,
            System.Collections.Immutable.ImmutableArray<PlatformActionAnswer> answers);

        Task<PlatformActionOwnerResult> InvokeAsync(
            PlatformActor actor,
            HostAccessibleItem item,
            IPlatformValidatedActionInput input,
            PlatformIdempotencyKey idempotencyKey,
            CancellationToken cancellationToken);
    }

    internal interface ISeerrPlatformActionPort
    {
        PlatformActionPortAdmission ValidateCurrent(
            PlatformActor actor,
            HostAccessibleItem item,
            PlatformPreparedActionContext prepared,
            System.Collections.Immutable.ImmutableArray<PlatformActionAnswer> answers);

        Task<PlatformActionOwnerResult> InvokeAsync(
            PlatformActor actor,
            HostAccessibleItem item,
            IPlatformValidatedActionInput input,
            PlatformIdempotencyKey idempotencyKey,
            CancellationToken cancellationToken);
    }

    /// <summary>
    /// The complete fixed pilot dispatch table. There is deliberately no handler
    /// registry, collection, service locator, reflection, or caller-selected owner.
    /// </summary>
    internal sealed class PlatformFirstPartyActionDispatcher
    {
        private readonly ISpoilerGuardPlatformActionPort _spoilerGuard;
        private readonly IHiddenContentPlatformActionPort _hiddenContent;
        private readonly ISeerrPlatformActionPort _seerr;

        internal PlatformFirstPartyActionDispatcher(
            ISpoilerGuardPlatformActionPort spoilerGuard,
            IHiddenContentPlatformActionPort hiddenContent,
            ISeerrPlatformActionPort seerr)
        {
            _spoilerGuard = spoilerGuard ?? throw new ArgumentNullException(nameof(spoilerGuard));
            _hiddenContent = hiddenContent ?? throw new ArgumentNullException(nameof(hiddenContent));
            _seerr = seerr ?? throw new ArgumentNullException(nameof(seerr));
        }

        internal PlatformActionPortAdmission ValidateCurrent(
            PlatformOperationDefinition definition,
            PlatformActor actor,
            HostAccessibleItem item,
            PlatformPreparedActionContext prepared,
            System.Collections.Immutable.ImmutableArray<PlatformActionAnswer> answers)
        {
            if (ReferenceEquals(definition, PlatformOperationDefinition.SpoilerGuardConfigureItem))
            {
                return _spoilerGuard.ValidateCurrent(actor, item, prepared, answers);
            }

            if (ReferenceEquals(definition, PlatformOperationDefinition.HiddenContentConfigureItem))
            {
                return _hiddenContent.ValidateCurrent(actor, item, prepared, answers);
            }

            if (ReferenceEquals(definition, PlatformOperationDefinition.SeerrRequestItem))
            {
                return _seerr.ValidateCurrent(actor, item, prepared, answers);
            }

            return PlatformActionPortAdmission.Refuse(PlatformActionPortDecision.UnknownOwner);
        }

        internal Task<PlatformActionOwnerResult> InvokeAsync(
            PlatformOperationDefinition definition,
            PlatformActor actor,
            HostAccessibleItem item,
            IPlatformValidatedActionInput input,
            PlatformIdempotencyKey idempotencyKey,
            CancellationToken cancellationToken)
        {
            if (ReferenceEquals(definition, PlatformOperationDefinition.SpoilerGuardConfigureItem))
            {
                return _spoilerGuard.InvokeAsync(actor, item, input, idempotencyKey, cancellationToken);
            }

            if (ReferenceEquals(definition, PlatformOperationDefinition.HiddenContentConfigureItem))
            {
                return _hiddenContent.InvokeAsync(actor, item, input, idempotencyKey, cancellationToken);
            }

            if (ReferenceEquals(definition, PlatformOperationDefinition.SeerrRequestItem))
            {
                return _seerr.InvokeAsync(actor, item, input, idempotencyKey, cancellationToken);
            }

            return Task.FromResult(
                PlatformActionOwnerResult.Failed(
                    PlatformErrorCode.Unavailable,
                    EmptyValue()));
        }

        private static JsonElement EmptyValue()
        {
            using var document = JsonDocument.Parse("{}");
            return document.RootElement.Clone();
        }
    }
}
