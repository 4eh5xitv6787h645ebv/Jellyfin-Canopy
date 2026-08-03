using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Microsoft.Extensions.Logging;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    /// <summary>Behavior, bounds, redaction, concurrency and failure isolation for action audit.</summary>
    public class PlatformAuditStoreTests
    {
        private static readonly DateTimeOffset Start = new(2026, 8, 3, 1, 2, 3, TimeSpan.Zero);

        [Fact]
        public void KnownTerminalRecordContainsOnlyTypedRedactedFieldsAndSafeStructuredLogState()
        {
            const string clientCanary = "bearer-canary-must-never-appear";
            const string deviceCanary = "capability-canary-must-never-appear";
            var logger = new RecordingLogger();
            var clock = new ManualTimeProvider(Start);
            var store = Store(logger, clock);
            var actor = Actor(1, clientCanary, deviceCanary);
            var operation = Operation(PlatformOperationFamily.Seerr);

            using var attempt = store.Begin(actor, operation);
            clock.Advance(TimeSpan.FromMilliseconds(1234));

            Assert.True(attempt.Complete(PlatformAuditResultCode.Succeeded));
            var record = Assert.Single(store.Snapshot());

            Assert.Equal(PlatformAuditSubjectResolution.Resolved, record.SubjectResolution);
            Assert.Equal(operation.Id, record.Operation);
            Assert.Equal(operation.Family, record.Family);
            Assert.Equal(actor.UserId, record.ActorUserId);
            Assert.Equal(actor.IsElevated, record.ActorWasElevated);
            AssertDigest(record.ClientAttributionDigest);
            AssertDigest(record.DeviceAttributionDigest);
            Assert.NotEqual(record.ClientAttributionDigest, record.DeviceAttributionDigest);
            Assert.Equal(PlatformAuditDecision.Allowed, record.Decision);
            Assert.Equal(PlatformAuditResultCode.Succeeded, record.ResultCode);
            Assert.Equal(1234, record.DurationMilliseconds);
            Assert.Equal(actor.CorrelationId, record.CorrelationId);
            Assert.Equal(Start, record.StartedAtUtc);
            Assert.Equal(Start.AddMilliseconds(1234), record.CompletedAtUtc);

            var entry = Assert.Single(logger.Entries);
            Assert.Equal(LogLevel.Information, entry.Level);
            Assert.DoesNotContain(clientCanary, entry.Rendered, StringComparison.Ordinal);
            Assert.DoesNotContain(deviceCanary, entry.Rendered, StringComparison.Ordinal);
            Assert.DoesNotContain(clientCanary, string.Join('|', entry.State.Values), StringComparison.Ordinal);
            Assert.DoesNotContain(deviceCanary, string.Join('|', entry.State.Values), StringComparison.Ordinal);
            Assert.Equal("seerr", entry.State["AuditFamily"]);
            Assert.Equal(operation.Id.Value, entry.State["AuditOperation"]);
            Assert.Equal(actor.CorrelationId, entry.State["CorrelationId"]);
            Assert.Equal("succeeded", entry.State["AuditResultCode"]);
            Assert.Null(entry.Exception);
        }

        [Theory]
        [InlineData("bearer-token-canary")]
        [InlineData("capability-string-canary")]
        [InlineData("request-body-canary")]
        [InlineData("library-title-canary")]
        [InlineData("seerr-api-key-canary")]
        [InlineData("https://seerr.example.invalid/canary")]
        [InlineData("upstream-response-canary")]
        public void EverySensitiveCanaryIsIrreversiblyReducedAtTheOnlyRawAttributionInputs(string canary)
        {
            var logger = new RecordingLogger();
            var store = Store(logger);

            using var attempt = store.Begin(Actor(3, canary, canary), Operation(PlatformOperationFamily.Seerr));
            Assert.True(attempt.Complete(PlatformAuditResultCode.OwnerFailed));

            var record = Assert.Single(store.Snapshot());
            AssertDigest(record.ClientAttributionDigest);
            AssertDigest(record.DeviceAttributionDigest);
            Assert.DoesNotContain(canary, record.ClientAttributionDigest!, StringComparison.Ordinal);
            Assert.DoesNotContain(canary, record.DeviceAttributionDigest!, StringComparison.Ordinal);

            var entry = Assert.Single(logger.Entries);
            Assert.DoesNotContain(canary, entry.Rendered, StringComparison.Ordinal);
            Assert.DoesNotContain(canary, string.Join('|', entry.State.Values), StringComparison.Ordinal);
        }

        [Fact]
        public void UnresolvedAttemptRetainsOnlyTheFixedSentinel()
        {
            const string rejectedCallerText = "jellyfin.canopy.attacker.bearer-canary";
            var logger = new RecordingLogger();
            var store = Store(logger);

            using var attempt = store.BeginUnresolved(Actor(2));
            Assert.True(attempt.Complete(PlatformAuditResultCode.UnknownOperation));

            var record = Assert.Single(store.Snapshot());
            Assert.Equal(PlatformAuditSubjectResolution.Unresolved, record.SubjectResolution);
            Assert.Null(record.Operation);
            Assert.Null(record.Family);
            Assert.Equal(PlatformAuditDecision.Denied, record.Decision);
            Assert.DoesNotContain(rejectedCallerText, logger.Entries.Single().Rendered, StringComparison.Ordinal);
            Assert.Equal("unresolved", logger.Entries.Single().State["AuditFamily"]);
            Assert.Equal("unresolved", logger.Entries.Single().State["AuditOperation"]);
        }

        [Fact]
        public void EveryClosedResultHasOneStableAuthorityDecision()
        {
            var denied = new HashSet<PlatformAuditResultCode>
            {
                PlatformAuditResultCode.AuthorityDenied,
                PlatformAuditResultCode.CapabilityInvalid,
                PlatformAuditResultCode.CapabilityReplayed,
                PlatformAuditResultCode.CapabilityExpired,
                PlatformAuditResultCode.UnknownOperation,
            };

            foreach (var resultCode in Enum.GetValues<PlatformAuditResultCode>())
            {
                var store = Store();
                using var attempt = store.Begin(Actor((int)resultCode + 10), Operation(PlatformOperationFamily.SpoilerGuard));

                Assert.True(attempt.Complete(resultCode));

                Assert.Equal(
                    denied.Contains(resultCode) ? PlatformAuditDecision.Denied : PlatformAuditDecision.Allowed,
                    Assert.Single(store.Snapshot()).Decision);
            }
        }

        [Fact]
        public void CompletionAndExceptionalDisposalEachAppendExactlyOnce()
        {
            var store = Store();
            var completed = store.Begin(Actor(30), Operation(PlatformOperationFamily.HiddenContent));

            Assert.True(completed.Complete(PlatformAuditResultCode.IdempotencyReplayed));
            Assert.False(completed.Complete(PlatformAuditResultCode.OwnerFailed));
            completed.Dispose();

            var abandoned = store.Begin(Actor(31), Operation(PlatformOperationFamily.HiddenContent));
            abandoned.Dispose();
            abandoned.Dispose();

            var records = store.Snapshot();
            Assert.Equal(2, records.Count);
            Assert.Equal(PlatformAuditResultCode.IdempotencyReplayed, records[0].ResultCode);
            Assert.Equal(PlatformAuditResultCode.InternalFailure, records[1].ResultCode);
        }

        [Fact]
        public void InvalidInternalEnumCannotCreateAnUnclassifiedRecord()
        {
            var store = Store();
            using var attempt = store.Begin(Actor(32), Operation(PlatformOperationFamily.Seerr));

            Assert.True(attempt.Complete((PlatformAuditResultCode)int.MaxValue));

            Assert.Equal(PlatformAuditResultCode.InternalFailure, Assert.Single(store.Snapshot()).ResultCode);
        }

        [Fact]
        public void FullRingEvictsExactlyTheOldestTerminalRecord()
        {
            var store = Store();
            for (var index = 1; index <= PlatformAuditStore.MaximumRecords + 2; index++)
            {
                using var attempt = store.Begin(Actor(index), Operation(PlatformOperationFamily.SpoilerGuard));
                Assert.True(attempt.Complete(PlatformAuditResultCode.Succeeded));
            }

            var records = store.Snapshot();
            Assert.Equal(PlatformAuditStore.MaximumRecords, records.Count);
            Assert.Equal(Correlation(3), records[0].CorrelationId);
            Assert.Equal(Correlation(PlatformAuditStore.MaximumRecords + 2), records[^1].CorrelationId);
            Assert.DoesNotContain(records, record => record.CorrelationId == Correlation(1));
            Assert.DoesNotContain(records, record => record.CorrelationId == Correlation(2));
        }

        [Fact]
        public void ParallelWritersRemainBoundedAndUncorrupted()
        {
            const int writes = 10_000;
            var store = Store();

            Parallel.For(1, writes + 1, index =>
            {
                using var attempt = store.Begin(Actor(index), Operation(PlatformOperationFamily.Seerr));
                Assert.True(attempt.Complete(PlatformAuditResultCode.Succeeded));
            });

            var records = store.Snapshot();
            Assert.Equal(PlatformAuditStore.MaximumRecords, records.Count);
            Assert.Equal(records.Count, records.Select(record => record.CorrelationId).Distinct(StringComparer.Ordinal).Count());
            Assert.All(records, record =>
            {
                Assert.Equal(PlatformAuditResultCode.Succeeded, record.ResultCode);
                Assert.Equal(PlatformOperationFamily.Seerr, record.Family);
            });
            AssertHealthy(store);
        }

        [Fact]
        public void ConcurrentCompletionOfOneAttemptHasOneWinnerAndOneRecord()
        {
            var store = Store();
            using var attempt = store.Begin(Actor(40), Operation(PlatformOperationFamily.Seerr));

            var winners = Enumerable.Range(0, 256)
                .AsParallel()
                .Count(_ => attempt.Complete(PlatformAuditResultCode.Succeeded));

            Assert.Equal(1, winners);
            Assert.Single(store.Snapshot());
        }

        [Fact]
        public void StructuredLogFailureKeepsRecordPreservesOutcomeAndDoesNotRetry()
        {
            var logger = new RecordingLogger { ThrowInformation = true };
            var store = Store(logger);
            using var attempt = store.Begin(Actor(50), Operation(PlatformOperationFamily.Seerr));
            var selectedActionOutcome = "success";

            var exception = Record.Exception(() => Assert.True(attempt.Complete(PlatformAuditResultCode.Succeeded)));
            Assert.Null(exception);
            Assert.Equal("success", selectedActionOutcome);
            Assert.Single(store.Snapshot());
            Assert.False(attempt.Complete(PlatformAuditResultCode.Succeeded));

            var health = store.HealthSnapshot();
            Assert.Equal(0, health.AppendFailureCount);
            Assert.Equal(1, health.StructuredLogFailureCount);
            Assert.Equal(Correlation(50), health.LastStructuredLogFailureCorrelationId);
            Assert.Equal(1, logger.InformationAttempts);
        }

        [Fact]
        public void AppendFailureIsVisibleBoundedAndNeverRetriedAcrossTheActionBoundary()
        {
            var logger = new RecordingLogger();
            var clock = new ThrowOnSecondUtcReadTimeProvider(Start);
            var store = Store(logger, clock);
            using var attempt = store.Begin(Actor(51), Operation(PlatformOperationFamily.Seerr));
            var selectedActionOutcome = "success";

            var exception = Record.Exception(() => Assert.True(attempt.Complete(PlatformAuditResultCode.Succeeded)));
            Assert.Null(exception);
            Assert.Equal("success", selectedActionOutcome);
            Assert.Empty(store.Snapshot());
            Assert.False(attempt.Complete(PlatformAuditResultCode.Succeeded));

            var health = store.HealthSnapshot();
            Assert.Equal(1, health.AppendFailureCount);
            Assert.Equal(Correlation(51), health.LastAppendFailureCorrelationId);
            Assert.Equal(1, logger.WarningAttempts);
            Assert.Equal(0, logger.InformationAttempts);
            Assert.DoesNotContain(logger.Entries, entry => entry.Exception is not null);
        }

        [Fact]
        public void BeginFailureReturnsDisabledAttemptAndCoalescesFallbackWarnings()
        {
            var logger = new RecordingLogger();
            var clock = new AlwaysThrowingTimeProvider();
            var store = Store(logger, clock);

            using var first = store.Begin(Actor(52), Operation(PlatformOperationFamily.Seerr));
            using var second = store.BeginUnresolved(Actor(53));

            Assert.False(first.Complete(PlatformAuditResultCode.Succeeded));
            Assert.False(second.Complete(PlatformAuditResultCode.UnknownOperation));
            Assert.Empty(store.Snapshot());
            Assert.Equal(2, store.HealthSnapshot().BeginFailureCount);
            Assert.Equal(1, logger.WarningAttempts);
        }

        [Fact]
        public void FailingFallbackLoggerCannotEscapeOrRecurse()
        {
            var logger = new RecordingLogger { ThrowWarning = true };
            var store = Store(logger, new AlwaysThrowingTimeProvider());

            var exception = Record.Exception(() => store.Begin(Actor(54), Operation(PlatformOperationFamily.Seerr)));

            Assert.Null(exception);
            var health = store.HealthSnapshot();
            Assert.Equal(1, health.BeginFailureCount);
            Assert.Equal(1, health.StructuredLogFailureCount);
            Assert.Equal(1, logger.WarningAttempts);
        }

        [Fact]
        public void InvalidAttributionAndCorrelationAreDiscardedRatherThanLogged()
        {
            var actualOversized = "bearer-" + new string('x', PlatformActorBoundaryFilter.MaxClientNameBytes);
            var logger = new RecordingLogger();
            var store = Store(logger);
            var actor = PlatformActorTestFactory.Create(Guid.NewGuid(), false, "canary-correlation", actualOversized, "device\ncanary");

            using var attempt = store.Begin(actor, Operation(PlatformOperationFamily.Seerr));
            Assert.True(attempt.Complete(PlatformAuditResultCode.AuthorityDenied));

            var record = Assert.Single(store.Snapshot());
            Assert.Null(record.ClientAttributionDigest);
            Assert.Null(record.DeviceAttributionDigest);
            Assert.Equal("unavailable", record.CorrelationId);
            var rendered = logger.Entries.Single().Rendered;
            Assert.DoesNotContain(actualOversized, rendered, StringComparison.Ordinal);
            Assert.DoesNotContain("device\ncanary", rendered, StringComparison.Ordinal);
            Assert.DoesNotContain("canary-correlation", rendered, StringComparison.Ordinal);
        }

        private static PlatformAuditStore Store(
            RecordingLogger? logger = null,
            TimeProvider? timeProvider = null,
            byte keyByte = 0x5a) => new(
                logger ?? new RecordingLogger(),
                timeProvider ?? new ManualTimeProvider(Start),
                Enumerable.Repeat(keyByte, 32).Select(value => (byte)value).ToArray());

        private static PlatformActor Actor(int value, string? client = "Android TV", string? device = "living-room") => PlatformActorTestFactory.Create(
            Guid.Parse("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
            value % 2 == 0,
            Correlation(value),
            client,
            device);

        private static PlatformOperationDefinition Operation(PlatformOperationFamily family) =>
            PlatformOperationVocabulary.All.Single(definition => definition.Family == family);

        private static string Correlation(int value) => value.ToString("x32", System.Globalization.CultureInfo.InvariantCulture);

        private static void AssertDigest(string? digest)
        {
            Assert.NotNull(digest);
            Assert.Equal(PlatformAuditStore.AttributionDigestCharacters, digest!.Length);
            Assert.All(digest, character => Assert.Contains(character, "0123456789abcdef"));
        }

        private static void AssertHealthy(PlatformAuditStore store)
        {
            var health = store.HealthSnapshot();
            Assert.Equal(0, health.BeginFailureCount);
            Assert.Equal(0, health.AppendFailureCount);
            Assert.Equal(0, health.StructuredLogFailureCount);
        }

        private sealed class RecordingLogger : ILogger<PlatformAuditStore>
        {
            internal bool ThrowInformation { get; init; }

            internal bool ThrowWarning { get; init; }

            internal int InformationAttempts { get; private set; }

            internal int WarningAttempts { get; private set; }

            internal List<LogEntry> Entries { get; } = new();

            public IDisposable? BeginScope<TState>(TState state)
                where TState : notnull => NullScope.Instance;

            public bool IsEnabled(LogLevel logLevel) => true;

            public void Log<TState>(
                LogLevel logLevel,
                EventId eventId,
                TState state,
                Exception? exception,
                Func<TState, Exception?, string> formatter)
            {
                if (logLevel == LogLevel.Information)
                {
                    InformationAttempts++;
                    if (ThrowInformation)
                    {
                        throw new InvalidOperationException("injected logger failure");
                    }
                }

                if (logLevel == LogLevel.Warning)
                {
                    WarningAttempts++;
                    if (ThrowWarning)
                    {
                        throw new InvalidOperationException("injected logger failure");
                    }
                }

                var values = state is IEnumerable<KeyValuePair<string, object?>> pairs
                    ? pairs.Where(pair => pair.Key != "{OriginalFormat}")
                        .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal)
                    : new Dictionary<string, object?>();
                Entries.Add(new LogEntry(logLevel, formatter(state, exception), values, exception));
            }
        }

        private sealed record LogEntry(
            LogLevel Level,
            string Rendered,
            IReadOnlyDictionary<string, object?> State,
            Exception? Exception);

        private sealed class NullScope : IDisposable
        {
            internal static NullScope Instance { get; } = new();

            public void Dispose()
            {
            }
        }

        private class ManualTimeProvider(DateTimeOffset now) : TimeProvider
        {
            private DateTimeOffset _now = now;
            private long _timestamp;

            public override long TimestampFrequency => TimeSpan.TicksPerSecond;

            public override DateTimeOffset GetUtcNow() => _now;

            public override long GetTimestamp() => _timestamp;

            internal void Advance(TimeSpan duration)
            {
                _now += duration;
                _timestamp += duration.Ticks;
            }
        }

        private sealed class ThrowOnSecondUtcReadTimeProvider(DateTimeOffset now) : ManualTimeProvider(now)
        {
            private int _reads;

            public override DateTimeOffset GetUtcNow()
            {
                if (++_reads == 2)
                {
                    throw new InvalidOperationException("injected append-time failure");
                }

                return base.GetUtcNow();
            }
        }

        private sealed class AlwaysThrowingTimeProvider : TimeProvider
        {
            public override DateTimeOffset GetUtcNow() => throw new InvalidOperationException("injected begin-time failure");
        }
    }
}
