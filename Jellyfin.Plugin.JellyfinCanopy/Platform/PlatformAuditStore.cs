using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>
    /// Process-local owner of bounded, redacted first-party action audit records.
    /// </summary>
    /// <remarks>
    /// The fixed ring retains at most <see cref="MaximumRecords"/> records and evicts
    /// strictly in terminal insertion order. All writers share one short lock; there is
    /// no work proportional to users or library size. Structured publication happens
    /// after the lock and cannot delay another append.
    /// </remarks>
    public sealed class PlatformAuditStore
    {
        /// <summary>The exact process-wide recent-record capacity.</summary>
        public const int MaximumRecords = 1024;

        internal const int AttributionDigestCharacters = 64;

        private const int AttributionKeyBytes = 32;
        private const string UnresolvedSubject = "unresolved";
        private const string UnavailableAttribution = "unavailable";
        private const string UnavailableCorrelation = "unavailable";

        private readonly object _gate = new();
        private readonly object _healthGate = new();
        private readonly PlatformAuditRecord?[] _records = new PlatformAuditRecord?[MaximumRecords];
        private readonly ILogger<PlatformAuditStore> _logger;
        private readonly TimeProvider _timeProvider;
        private readonly byte[] _attributionKey;
        private int _nextIndex;
        private int _count;
        private bool _failureWarningEmitted;
        private long _beginFailureCount;
        private long _appendFailureCount;
        private long _structuredLogFailureCount;
        private DateTimeOffset? _lastBeginFailureAtUtc;
        private DateTimeOffset? _lastAppendFailureAtUtc;
        private DateTimeOffset? _lastStructuredLogFailureAtUtc;
        private string? _lastBeginFailureCorrelationId;
        private string? _lastAppendFailureCorrelationId;
        private string? _lastStructuredLogFailureCorrelationId;

        /// <summary>
        /// One-shot terminal completion handle used by the future action coordinator.
        /// Its constructor and redacted prefix are store-private, so same-assembly code
        /// cannot bypass <see cref="Begin"/> and inject raw text into audit or logging.
        /// </summary>
        private sealed class AuditAttempt : IPlatformAuditAttempt
        {
            private readonly PlatformAuditStore? _owner;
            private readonly AuditPrefix? _prefix;
            private int _completed;

            internal AuditAttempt(PlatformAuditStore owner, AuditPrefix prefix)
            {
                _owner = owner;
                _prefix = prefix;
            }

            private AuditAttempt()
            {
                _completed = 1;
            }

            internal static IPlatformAuditAttempt Disabled { get; } = new AuditAttempt();

            /// <summary>
            /// Publishes at most one terminal record. Audit failures are retained in
            /// bounded health state and never escape across the action boundary.
            /// </summary>
            public bool Complete(PlatformAuditResultCode resultCode)
            {
                if (Interlocked.CompareExchange(ref _completed, 1, 0) != 0)
                {
                    return false;
                }

                if (_owner is not null && _prefix is not null)
                {
                    _owner.TryComplete(
                        _prefix,
                        Enum.IsDefined(resultCode) ? resultCode : PlatformAuditResultCode.InternalFailure);
                }

                return true;
            }

            /// <inheritdoc />
            public void Dispose() => Complete(PlatformAuditResultCode.InternalFailure);
        }

        /// <summary>Store-private redacted evidence captured before an action begins.</summary>
        private sealed class AuditPrefix
        {
            internal AuditPrefix(
                PlatformAuditSubjectResolution subjectResolution,
                PlatformOperationId? operation,
                PlatformOperationFamily? family,
                Guid actorUserId,
                bool actorWasElevated,
                string? clientAttributionDigest,
                string? deviceAttributionDigest,
                string correlationId,
                DateTimeOffset startedAtUtc,
                long startedTimestamp)
            {
                SubjectResolution = subjectResolution;
                Operation = operation;
                Family = family;
                ActorUserId = actorUserId;
                ActorWasElevated = actorWasElevated;
                ClientAttributionDigest = clientAttributionDigest;
                DeviceAttributionDigest = deviceAttributionDigest;
                CorrelationId = correlationId;
                StartedAtUtc = startedAtUtc;
                StartedTimestamp = startedTimestamp;
            }

            internal PlatformAuditSubjectResolution SubjectResolution { get; }

            internal PlatformOperationId? Operation { get; }

            internal PlatformOperationFamily? Family { get; }

            internal Guid ActorUserId { get; }

            internal bool ActorWasElevated { get; }

            internal string? ClientAttributionDigest { get; }

            internal string? DeviceAttributionDigest { get; }

            internal string CorrelationId { get; }

            internal DateTimeOffset StartedAtUtc { get; }

            internal long StartedTimestamp { get; }
        }

        /// <summary>Initializes the production journal with a process-local attribution key.</summary>
        public PlatformAuditStore(ILogger<PlatformAuditStore> logger)
            : this(logger, TimeProvider.System, RandomNumberGenerator.GetBytes(AttributionKeyBytes))
        {
        }

        internal PlatformAuditStore(
            ILogger<PlatformAuditStore> logger,
            TimeProvider timeProvider,
            ReadOnlySpan<byte> attributionKey)
        {
            ArgumentNullException.ThrowIfNull(logger);
            ArgumentNullException.ThrowIfNull(timeProvider);
            if (attributionKey.Length != AttributionKeyBytes)
            {
                throw new ArgumentException($"The audit attribution key must contain {AttributionKeyBytes} bytes.", nameof(attributionKey));
            }

            _logger = logger;
            _timeProvider = timeProvider;
            _attributionKey = attributionKey.ToArray();
        }

        /// <summary>Begins an attempt for one definition from the code-owned vocabulary.</summary>
        internal IPlatformAuditAttempt Begin(PlatformActor actor, PlatformOperationDefinition operation)
        {
            try
            {
                ArgumentNullException.ThrowIfNull(actor);
                ArgumentNullException.ThrowIfNull(operation);
                var owned = PlatformOperationVocabulary.Find(operation.Id.Value);
                if (!ReferenceEquals(owned, operation))
                {
                    throw new ArgumentException("The audit subject must be a code-owned Platform operation.", nameof(operation));
                }

                return BeginCore(actor, PlatformAuditSubjectResolution.Resolved, operation.Id, operation.Family);
            }
            catch (Exception)
            {
                ReportFailure(PlatformAuditFailureStage.Begin, SafeCorrelation(actor?.CorrelationId), tryFallbackWarning: true);
                return AuditAttempt.Disabled;
            }
        }

        /// <summary>
        /// Begins an unresolved action attempt without accepting or retaining the
        /// caller-supplied operation spelling.
        /// </summary>
        internal IPlatformAuditAttempt BeginUnresolved(PlatformActor actor)
        {
            try
            {
                ArgumentNullException.ThrowIfNull(actor);
                return BeginCore(actor, PlatformAuditSubjectResolution.Unresolved, operation: null, family: null);
            }
            catch (Exception)
            {
                ReportFailure(PlatformAuditFailureStage.Begin, SafeCorrelation(actor?.CorrelationId), tryFallbackWarning: true);
                return AuditAttempt.Disabled;
            }
        }

        internal IReadOnlyList<PlatformAuditRecord> Snapshot()
        {
            lock (_gate)
            {
                var result = new List<PlatformAuditRecord>(_count);
                var first = _count == MaximumRecords ? _nextIndex : 0;
                for (var offset = 0; offset < _count; offset++)
                {
                    var record = _records[(first + offset) % MaximumRecords];
                    if (record is not null)
                    {
                        result.Add(record);
                    }
                }

                return result;
            }
        }

        internal PlatformAuditHealthSnapshot HealthSnapshot()
        {
            lock (_healthGate)
            {
                return new PlatformAuditHealthSnapshot(
                    _beginFailureCount,
                    _appendFailureCount,
                    _structuredLogFailureCount,
                    _lastBeginFailureAtUtc,
                    _lastAppendFailureAtUtc,
                    _lastStructuredLogFailureAtUtc,
                    _lastBeginFailureCorrelationId,
                    _lastAppendFailureCorrelationId,
                    _lastStructuredLogFailureCorrelationId);
            }
        }

        private void TryComplete(AuditPrefix prefix, PlatformAuditResultCode resultCode)
        {
            PlatformAuditRecord record;
            try
            {
                var completedAtUtc = _timeProvider.GetUtcNow().ToUniversalTime();
                if (completedAtUtc < prefix.StartedAtUtc)
                {
                    completedAtUtc = prefix.StartedAtUtc;
                }

                var elapsed = _timeProvider.GetElapsedTime(prefix.StartedTimestamp);
                var durationMilliseconds = Math.Max(0, elapsed.Ticks / TimeSpan.TicksPerMillisecond);
                record = new PlatformAuditRecord(
                    prefix.SubjectResolution,
                    prefix.Operation,
                    prefix.Family,
                    prefix.ActorUserId,
                    prefix.ActorWasElevated,
                    prefix.ClientAttributionDigest,
                    prefix.DeviceAttributionDigest,
                    DecisionFor(resultCode),
                    resultCode,
                    durationMilliseconds,
                    prefix.CorrelationId,
                    prefix.StartedAtUtc,
                    completedAtUtc);

                lock (_gate)
                {
                    _records[_nextIndex] = record;
                    _nextIndex = (_nextIndex + 1) % MaximumRecords;
                    if (_count < MaximumRecords)
                    {
                        _count++;
                    }
                }
            }
            catch (Exception)
            {
                ReportFailure(PlatformAuditFailureStage.Append, prefix.CorrelationId, tryFallbackWarning: true);
                return;
            }

            try
            {
                _logger.LogInformation(
                    "Platform action audit. Family={AuditFamily} Operation={AuditOperation} ActorUserId={AuditActorUserId} ActorElevated={AuditActorElevated} ClientAttribution={AuditClientAttribution} DeviceAttribution={AuditDeviceAttribution} Decision={AuditDecision} ResultCode={AuditResultCode} DurationMilliseconds={AuditDurationMilliseconds} CorrelationId={CorrelationId} StartedAtUtc={AuditStartedAtUtc} CompletedAtUtc={AuditCompletedAtUtc}",
                    FamilyToken(record.Family),
                    record.Operation?.Value ?? UnresolvedSubject,
                    record.ActorUserId,
                    record.ActorWasElevated,
                    record.ClientAttributionDigest ?? UnavailableAttribution,
                    record.DeviceAttributionDigest ?? UnavailableAttribution,
                    DecisionToken(record.Decision),
                    ResultToken(record.ResultCode),
                    record.DurationMilliseconds,
                    record.CorrelationId,
                    record.StartedAtUtc,
                    record.CompletedAtUtc);
            }
            catch (Exception)
            {
                ReportFailure(PlatformAuditFailureStage.StructuredLog, record.CorrelationId, tryFallbackWarning: false);
            }
        }

        private IPlatformAuditAttempt BeginCore(
            PlatformActor actor,
            PlatformAuditSubjectResolution subjectResolution,
            PlatformOperationId? operation,
            PlatformOperationFamily? family)
        {
            var startedAtUtc = _timeProvider.GetUtcNow().ToUniversalTime();
            var startedTimestamp = _timeProvider.GetTimestamp();
            var prefix = new AuditPrefix(
                subjectResolution,
                operation,
                family,
                actor.UserId,
                actor.IsElevated,
                DigestAttribution(actor.ClientName, "client", PlatformActorBoundaryFilter.MaxClientNameBytes),
                DigestAttribution(actor.DeviceId, "device", PlatformActorBoundaryFilter.MaxDeviceIdBytes),
                SafeCorrelation(actor.CorrelationId),
                startedAtUtc,
                startedTimestamp);

            return new AuditAttempt(this, prefix);
        }

        private string? DigestAttribution(string? value, string domain, int maximumUtf8Bytes)
        {
            if (string.IsNullOrWhiteSpace(value)
                || value.Any(character => char.IsControl(character) || character is '\u2028' or '\u2029'))
            {
                return null;
            }

            var byteCount = Encoding.UTF8.GetByteCount(value);
            if (byteCount > maximumUtf8Bytes)
            {
                return null;
            }

            var domainBytes = Encoding.UTF8.GetBytes(domain + "\0");
            var input = new byte[domainBytes.Length + byteCount];
            domainBytes.CopyTo(input, 0);
            Encoding.UTF8.GetBytes(value, input.AsSpan(domainBytes.Length));
            return Convert.ToHexString(HMACSHA256.HashData(_attributionKey, input)).ToLowerInvariant();
        }

        private void ReportFailure(PlatformAuditFailureStage stage, string correlationId, bool tryFallbackWarning)
        {
            var atUtc = SafeUtcNow();
            var emitWarning = false;
            lock (_healthGate)
            {
                switch (stage)
                {
                    case PlatformAuditFailureStage.Begin:
                        _beginFailureCount = SaturatingIncrement(_beginFailureCount);
                        _lastBeginFailureAtUtc = atUtc;
                        _lastBeginFailureCorrelationId = correlationId;
                        break;
                    case PlatformAuditFailureStage.Append:
                        _appendFailureCount = SaturatingIncrement(_appendFailureCount);
                        _lastAppendFailureAtUtc = atUtc;
                        _lastAppendFailureCorrelationId = correlationId;
                        break;
                    case PlatformAuditFailureStage.StructuredLog:
                        _structuredLogFailureCount = SaturatingIncrement(_structuredLogFailureCount);
                        _lastStructuredLogFailureAtUtc = atUtc;
                        _lastStructuredLogFailureCorrelationId = correlationId;
                        break;
                    default:
                        return;
                }

                if (tryFallbackWarning && !_failureWarningEmitted)
                {
                    _failureWarningEmitted = true;
                    emitWarning = true;
                }
            }

            if (!emitWarning)
            {
                return;
            }

            try
            {
                _logger.LogWarning(
                    "Platform audit failed internally. Stage={AuditFailureStage} CorrelationId={CorrelationId}",
                    FailureStageToken(stage),
                    correlationId);
            }
            catch (Exception)
            {
                ReportFailure(PlatformAuditFailureStage.StructuredLog, correlationId, tryFallbackWarning: false);
            }
        }

        private DateTimeOffset SafeUtcNow()
        {
            try
            {
                return _timeProvider.GetUtcNow().ToUniversalTime();
            }
            catch (Exception)
            {
                return DateTimeOffset.UtcNow;
            }
        }

        private static PlatformAuditDecision DecisionFor(PlatformAuditResultCode resultCode) => resultCode switch
        {
            PlatformAuditResultCode.AuthorityDenied
                or PlatformAuditResultCode.CapabilityInvalid
                or PlatformAuditResultCode.CapabilityReplayed
                or PlatformAuditResultCode.CapabilityExpired
                or PlatformAuditResultCode.UnknownOperation => PlatformAuditDecision.Denied,
            _ => PlatformAuditDecision.Allowed,
        };

        private static string SafeCorrelation(string? value)
        {
            if (value is null || value.Length != 32 || value.Any(character => character is not (>= '0' and <= '9') and not (>= 'a' and <= 'f')))
            {
                return UnavailableCorrelation;
            }

            return value;
        }

        private static long SaturatingIncrement(long value) => value == long.MaxValue ? value : value + 1;

        private static string FamilyToken(PlatformOperationFamily? family) => family switch
        {
            PlatformOperationFamily.SpoilerGuard => "spoiler_guard",
            PlatformOperationFamily.HiddenContent => "hidden_content",
            PlatformOperationFamily.Seerr => "seerr",
            _ => UnresolvedSubject,
        };

        private static string DecisionToken(PlatformAuditDecision decision) => decision switch
        {
            PlatformAuditDecision.Allowed => "allowed",
            PlatformAuditDecision.Denied => "denied",
            _ => "allowed",
        };

        private static string ResultToken(PlatformAuditResultCode resultCode) => resultCode switch
        {
            PlatformAuditResultCode.Succeeded => "succeeded",
            PlatformAuditResultCode.IdempotencyReplayed => "idempotency_replayed",
            PlatformAuditResultCode.AuthorityDenied => "authority_denied",
            PlatformAuditResultCode.CapabilityInvalid => "capability_invalid",
            PlatformAuditResultCode.CapabilityReplayed => "capability_replayed",
            PlatformAuditResultCode.CapabilityExpired => "capability_expired",
            PlatformAuditResultCode.UnknownOperation => "unknown_operation",
            PlatformAuditResultCode.InvalidInput => "invalid_input",
            PlatformAuditResultCode.Conflict => "conflict",
            PlatformAuditResultCode.RateLimited => "rate_limited",
            PlatformAuditResultCode.Indeterminate => "indeterminate",
            PlatformAuditResultCode.CallerCancelled => "caller_cancelled",
            PlatformAuditResultCode.DeadlineExceeded => "deadline_exceeded",
            PlatformAuditResultCode.OwnerFailed => "owner_failed",
            PlatformAuditResultCode.InternalFailure => "internal_failure",
            _ => "internal_failure",
        };

        private static string FailureStageToken(PlatformAuditFailureStage stage) => stage switch
        {
            PlatformAuditFailureStage.Begin => "begin",
            PlatformAuditFailureStage.Append => "append",
            PlatformAuditFailureStage.StructuredLog => "structured_log",
            _ => "append",
        };
    }
}
