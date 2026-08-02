using System;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>Whether current Platform authority admitted or denied an action attempt.</summary>
    internal enum PlatformAuditDecision
    {
        /// <summary>The action passed authority checks, regardless of its later result.</summary>
        Allowed,

        /// <summary>The action was refused before an owner could run.</summary>
        Denied,
    }

    /// <summary>The closed terminal result vocabulary retained by the audit journal.</summary>
    internal enum PlatformAuditResultCode
    {
        /// <summary>The owner completed the mutation successfully.</summary>
        Succeeded,

        /// <summary>A prior identical idempotent execution supplied the result.</summary>
        IdempotencyReplayed,

        /// <summary>Current Jellyfin or feature authority denied the attempt.</summary>
        AuthorityDenied,

        /// <summary>The opaque capability was malformed or did not match its context.</summary>
        CapabilityInvalid,

        /// <summary>The opaque capability had already been consumed.</summary>
        CapabilityReplayed,

        /// <summary>The opaque capability had expired.</summary>
        CapabilityExpired,

        /// <summary>No code-owned operation matched the caller's request.</summary>
        UnknownOperation,

        /// <summary>The bounded typed operation input was invalid.</summary>
        InvalidInput,

        /// <summary>The idempotency tuple conflicted with different input.</summary>
        Conflict,

        /// <summary>A bounded admission or concurrency limit rejected the attempt.</summary>
        RateLimited,

        /// <summary>A prior mutation may have committed without a publishable result.</summary>
        Indeterminate,

        /// <summary>The connected caller canceled the admitted attempt.</summary>
        CallerCancelled,

        /// <summary>The Platform request deadline canceled the admitted attempt.</summary>
        DeadlineExceeded,

        /// <summary>The fixed first-party owner returned a bounded failure.</summary>
        OwnerFailed,

        /// <summary>The Platform kernel failed to classify or complete the attempt.</summary>
        InternalFailure,
    }

    /// <summary>Whether the journal subject was resolved through the code-owned vocabulary.</summary>
    internal enum PlatformAuditSubjectResolution
    {
        /// <summary>A known operation and family are retained.</summary>
        Resolved,

        /// <summary>The fixed unresolved sentinel is retained; caller text is discarded.</summary>
        Unresolved,
    }

    /// <summary>The fixed stages at which audit infrastructure can fail safely.</summary>
    internal enum PlatformAuditFailureStage
    {
        /// <summary>An attempt could not be initialized.</summary>
        Begin,

        /// <summary>A terminal record could not be appended to the bounded journal.</summary>
        Append,

        /// <summary>The already-bounded record could not be published to structured logging.</summary>
        StructuredLog,
    }

    /// <summary>
    /// One immutable, redacted terminal action record. Its shape is an allowlist: there
    /// is deliberately no payload, item, title, capability, key, URL, response, message,
    /// exception, principal, or HTTP object.
    /// </summary>
    internal sealed class PlatformAuditRecord
    {
        internal PlatformAuditRecord(
            PlatformAuditSubjectResolution subjectResolution,
            PlatformOperationId? operation,
            PlatformOperationFamily? family,
            Guid actorUserId,
            bool actorWasElevated,
            string? clientAttributionDigest,
            string? deviceAttributionDigest,
            PlatformAuditDecision decision,
            PlatformAuditResultCode resultCode,
            long durationMilliseconds,
            string correlationId,
            DateTimeOffset startedAtUtc,
            DateTimeOffset completedAtUtc)
        {
            SubjectResolution = subjectResolution;
            Operation = operation;
            Family = family;
            ActorUserId = actorUserId;
            ActorWasElevated = actorWasElevated;
            ClientAttributionDigest = clientAttributionDigest;
            DeviceAttributionDigest = deviceAttributionDigest;
            Decision = decision;
            ResultCode = resultCode;
            DurationMilliseconds = durationMilliseconds;
            CorrelationId = correlationId;
            StartedAtUtc = startedAtUtc;
            CompletedAtUtc = completedAtUtc;
        }

        internal PlatformAuditSubjectResolution SubjectResolution { get; }

        internal PlatformOperationId? Operation { get; }

        internal PlatformOperationFamily? Family { get; }

        internal Guid ActorUserId { get; }

        internal bool ActorWasElevated { get; }

        internal string? ClientAttributionDigest { get; }

        internal string? DeviceAttributionDigest { get; }

        internal PlatformAuditDecision Decision { get; }

        internal PlatformAuditResultCode ResultCode { get; }

        internal long DurationMilliseconds { get; }

        internal string CorrelationId { get; }

        internal DateTimeOffset StartedAtUtc { get; }

        internal DateTimeOffset CompletedAtUtc { get; }
    }

    /// <summary>A constant-size view of failures inside the non-throwing audit owner.</summary>
    internal sealed class PlatformAuditHealthSnapshot
    {
        internal PlatformAuditHealthSnapshot(
            long beginFailureCount,
            long appendFailureCount,
            long structuredLogFailureCount,
            DateTimeOffset? lastBeginFailureAtUtc,
            DateTimeOffset? lastAppendFailureAtUtc,
            DateTimeOffset? lastStructuredLogFailureAtUtc,
            string? lastBeginFailureCorrelationId,
            string? lastAppendFailureCorrelationId,
            string? lastStructuredLogFailureCorrelationId)
        {
            BeginFailureCount = beginFailureCount;
            AppendFailureCount = appendFailureCount;
            StructuredLogFailureCount = structuredLogFailureCount;
            LastBeginFailureAtUtc = lastBeginFailureAtUtc;
            LastAppendFailureAtUtc = lastAppendFailureAtUtc;
            LastStructuredLogFailureAtUtc = lastStructuredLogFailureAtUtc;
            LastBeginFailureCorrelationId = lastBeginFailureCorrelationId;
            LastAppendFailureCorrelationId = lastAppendFailureCorrelationId;
            LastStructuredLogFailureCorrelationId = lastStructuredLogFailureCorrelationId;
        }

        internal long BeginFailureCount { get; }

        internal long AppendFailureCount { get; }

        internal long StructuredLogFailureCount { get; }

        internal DateTimeOffset? LastBeginFailureAtUtc { get; }

        internal DateTimeOffset? LastAppendFailureAtUtc { get; }

        internal DateTimeOffset? LastStructuredLogFailureAtUtc { get; }

        internal string? LastBeginFailureCorrelationId { get; }

        internal string? LastAppendFailureCorrelationId { get; }

        internal string? LastStructuredLogFailureCorrelationId { get; }
    }

    /// <summary>The only coordinator-facing surface of a store-owned audit attempt.</summary>
    internal interface IPlatformAuditAttempt : IDisposable
    {
        /// <summary>Completes the attempt once with a closed terminal result.</summary>
        bool Complete(PlatformAuditResultCode resultCode);
    }

}
