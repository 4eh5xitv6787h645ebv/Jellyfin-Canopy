using System;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Microsoft.Extensions.Primitives;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    public class PlatformIdempotencyTests
    {
        [Theory]
        [InlineData("a")]
        [InlineData("Request_01.~-")]
        [InlineData("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~-")]
        public void KeyParserAcceptsOnlyThePinnedTransportNeutralAlphabet(string raw)
        {
            Assert.True(PlatformIdempotencyKey.TryParse(raw, out var parsed));
            Assert.Equal(raw, parsed.Value);
        }

        [Theory]
        [InlineData("")]
        [InlineData("space here")]
        [InlineData("comma,join")]
        [InlineData("slash/not-allowed")]
        [InlineData("unicode-é")]
        public void KeyParserRejectsInvalidValues(string raw)
        {
            Assert.False(PlatformIdempotencyKey.TryParse(raw, out _));
        }

        [Fact]
        public void HeaderRequiresExactlyOneValueAndTheSameParserCanServeABody()
        {
            Assert.True(PlatformIdempotencyKey.TryParseHeader(new StringValues("body-safe-key"), out var header));
            Assert.True(PlatformIdempotencyKey.TryParse(header.Value, out var body));
            Assert.Equal(header, body);

            Assert.False(PlatformIdempotencyKey.TryParseHeader(
                new StringValues(new[] { "one", "two" }),
                out _));
        }

        [Fact]
        public async Task SameTupleAndFingerprintReplaysWithoutExecutingTwice()
        {
            var store = new PlatformIdempotencyStore();
            var request = Request("key", "same-payload");
            var calls = 0;

            var first = await store.ExecuteAsync(request, _ =>
            {
                calls++;
                return Task.FromResult(Result(42));
            }, CancellationToken.None);
            var replay = await store.ExecuteAsync(request, _ =>
            {
                calls++;
                return Task.FromResult(Result(99));
            }, CancellationToken.None);

            Assert.Equal(PlatformIdempotencyOutcomeKind.Executed, first.Kind);
            Assert.Equal(PlatformIdempotencyOutcomeKind.Replay, replay.Kind);
            Assert.Equal(1, calls);
            Assert.Equal("ok", replay.Result!.OutcomeCode);
            Assert.Equal(42, replay.Result.Value.GetProperty("value").GetInt32());
        }

        [Fact]
        public async Task SameTupleWithDifferentFingerprintConflictsBeforeExecution()
        {
            var store = new PlatformIdempotencyStore();
            await store.ExecuteAsync(Request("key", "payload-a"), _ => Task.FromResult(Result(1)), CancellationToken.None);
            var called = false;

            var conflict = await store.ExecuteAsync(Request("key", "payload-b"), _ =>
            {
                called = true;
                return Task.FromResult(Result(2));
            }, CancellationToken.None);

            Assert.Equal(PlatformIdempotencyOutcomeKind.Conflict, conflict.Kind);
            Assert.False(called);
        }

        [Fact]
        public async Task TupleIncludesActingUserAndOperation()
        {
            var store = new PlatformIdempotencyStore();
            var userA = Guid.NewGuid();
            var userB = Guid.NewGuid();
            var calls = 0;

            foreach (var request in new[]
            {
                Request("shared", "payload", userA, "request.create"),
                Request("shared", "payload", userB, "request.create"),
                Request("shared", "payload", userA, "request.cancel"),
            })
            {
                var outcome = await store.ExecuteAsync(request, _ =>
                {
                    calls++;
                    return Task.FromResult(Result(calls));
                }, CancellationToken.None);
                Assert.Equal(PlatformIdempotencyOutcomeKind.Executed, outcome.Kind);
            }

            Assert.Equal(3, calls);
        }

        [Fact]
        public async Task FollowerCancellationNeverCancelsTheLeader()
        {
            var store = new PlatformIdempotencyStore();
            var request = Request("coalesce", "payload");
            var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var release = new TaskCompletionSource<PlatformIdempotencyResult>(TaskCreationOptions.RunContinuationsAsynchronously);
            using var leaderToken = new CancellationTokenSource();

            var leader = store.ExecuteAsync(request, async token =>
            {
                Assert.Equal(leaderToken.Token, token);
                entered.TrySetResult();
                return await release.Task;
            }, leaderToken.Token);
            await entered.Task;

            using var followerToken = new CancellationTokenSource();
            var follower = store.ExecuteAsync(
                request,
                _ => throw new Xunit.Sdk.XunitException("A follower must not become a leader."),
                followerToken.Token);
            followerToken.Cancel();

            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => follower);
            Assert.False(leader.IsCompleted);
            Assert.False(leaderToken.IsCancellationRequested);

            release.TrySetResult(Result(7));
            Assert.Equal(PlatformIdempotencyOutcomeKind.Executed, (await leader).Kind);
            Assert.Equal(
                PlatformIdempotencyOutcomeKind.Replay,
                (await store.ExecuteAsync(request, _ => Task.FromResult(Result(8)), CancellationToken.None)).Kind);
        }

        [Fact]
        public async Task FollowerBoundRejectsBeforeAttachingAndCanceledWaitersReleaseCapacity()
        {
            var store = new PlatformIdempotencyStore();
            var request = Request("bounded-followers", "payload");
            var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var release = new TaskCompletionSource<PlatformIdempotencyResult>(TaskCreationOptions.RunContinuationsAsynchronously);
            var leader = store.ExecuteAsync(request, _ =>
            {
                entered.TrySetResult();
                return release.Task;
            }, CancellationToken.None);
            await entered.Task;

            var cancellations = Enumerable.Range(0, PlatformIdempotencyStore.MaximumFollowersPerEntry)
                .Select(_ => new CancellationTokenSource())
                .ToArray();
            var followers = cancellations.Select(cancellation => store.ExecuteAsync(
                request,
                _ => throw new Xunit.Sdk.XunitException("A follower must not execute."),
                cancellation.Token)).ToArray();

            Assert.Equal(PlatformIdempotencyStore.MaximumFollowersPerEntry, store.FollowerCount);
            var called = false;
            var refused = await store.ExecuteAsync(request, _ =>
            {
                called = true;
                return Task.FromResult(Result(0));
            }, CancellationToken.None);
            Assert.Equal(PlatformIdempotencyOutcomeKind.AtCapacity, refused.Kind);
            Assert.False(called);

            foreach (var cancellation in cancellations)
            {
                cancellation.Cancel();
            }

            foreach (var follower in followers)
            {
                await Assert.ThrowsAnyAsync<OperationCanceledException>(() => follower);
            }

            Assert.Equal(0, store.FollowerCount);
            var replacement = store.ExecuteAsync(
                request,
                _ => throw new Xunit.Sdk.XunitException("A replacement follower must not execute."),
                CancellationToken.None);
            Assert.Equal(1, store.FollowerCount);

            release.TrySetResult(Result(1));
            Assert.Equal(PlatformIdempotencyOutcomeKind.Executed, (await leader).Kind);
            Assert.Equal(PlatformIdempotencyOutcomeKind.Replay, (await replacement).Kind);
            Assert.Equal(0, store.FollowerCount);

            foreach (var cancellation in cancellations)
            {
                cancellation.Dispose();
            }
        }

        [Fact]
        public async Task PreCanceledRequestCreatesNoEntryAndInvokesNoMutation()
        {
            var store = new PlatformIdempotencyStore();
            using var cancellation = new CancellationTokenSource();
            cancellation.Cancel();
            var called = false;

            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => store.ExecuteAsync(
                Request("pre-canceled", "payload"),
                _ =>
                {
                    called = true;
                    return Task.FromResult(Result(1));
                },
                cancellation.Token));

            Assert.False(called);
            Assert.Equal(0, store.EntryCount);
            Assert.Equal(0, store.FollowerCount);
        }

        [Fact]
        public async Task ProcessWideFollowerBoundRejectsTheExactNextWaiter()
        {
            var store = new PlatformIdempotencyStore();
            var release = new TaskCompletionSource<PlatformIdempotencyResult>(TaskCreationOptions.RunContinuationsAsynchronously);
            var requests = Enumerable.Range(0, 17)
                .Select(index => Request("global-followers-" + index, "payload"))
                .ToArray();
            var leaders = requests.Select(request => store.ExecuteAsync(
                request,
                _ => release.Task,
                CancellationToken.None)).ToArray();
            using var followersCancellation = new CancellationTokenSource();
            var followers = requests.Take(16)
                .SelectMany(request => Enumerable.Range(0, PlatformIdempotencyStore.MaximumFollowersPerEntry)
                    .Select(_ => store.ExecuteAsync(
                        request,
                        _ => throw new Xunit.Sdk.XunitException("A follower must not execute."),
                        followersCancellation.Token)))
                .ToArray();

            Assert.Equal(PlatformIdempotencyStore.MaximumFollowers, store.FollowerCount);
            var refused = await store.ExecuteAsync(
                requests[16],
                _ => throw new Xunit.Sdk.XunitException("An excess follower must not execute."),
                CancellationToken.None);
            Assert.Equal(PlatformIdempotencyOutcomeKind.AtCapacity, refused.Kind);

            followersCancellation.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Task.WhenAll(followers));
            Assert.Equal(0, store.FollowerCount);

            release.TrySetResult(Result(1));
            Assert.All(await Task.WhenAll(leaders), outcome =>
                Assert.Equal(PlatformIdempotencyOutcomeKind.Executed, outcome.Kind));
        }

        [Fact]
        public async Task CapacityIsRejectedBeforeExecutionAndNoLiveEntryIsEvicted()
        {
            var store = new PlatformIdempotencyStore();
            for (var index = 0; index < PlatformIdempotencyStore.MaximumEntries; index++)
            {
                var outcome = await store.ExecuteAsync(
                    Request("key-" + index, "payload"),
                    _ => Task.FromResult(Result(index)),
                    CancellationToken.None);
                Assert.Equal(PlatformIdempotencyOutcomeKind.Executed, outcome.Kind);
            }

            var called = false;
            var refused = await store.ExecuteAsync(Request("overflow", "payload"), _ =>
            {
                called = true;
                return Task.FromResult(Result(-1));
            }, CancellationToken.None);

            Assert.Equal(PlatformIdempotencyOutcomeKind.AtCapacity, refused.Kind);
            Assert.False(called);
            Assert.Equal(PlatformIdempotencyStore.MaximumEntries, store.EntryCount);
            Assert.Equal(
                PlatformIdempotencyOutcomeKind.Replay,
                (await store.ExecuteAsync(Request("key-0", "payload"), _ => Task.FromResult(Result(0)), CancellationToken.None)).Kind);
        }

        [Fact]
        public async Task TotalResultBytesAreReservedBeforeAnyMutationExecutes()
        {
            var store = new PlatformIdempotencyStore();
            var release = new TaskCompletionSource<PlatformIdempotencyResult>(TaskCreationOptions.RunContinuationsAsynchronously);
            var leaders = new Task<PlatformIdempotencyOutcome>[
                PlatformIdempotencyStore.MaximumStoredResultBytes / PlatformIdempotencyStore.MaximumResultBytes];

            for (var index = 0; index < leaders.Length; index++)
            {
                leaders[index] = store.ExecuteAsync(
                    Request(
                        "reservation-" + index,
                        "payload",
                        maximumResultBytes: PlatformIdempotencyStore.MaximumResultBytes),
                    _ => release.Task,
                    CancellationToken.None);
            }

            var called = false;
            var refused = await store.ExecuteAsync(
                Request(
                    "reservation-overflow",
                    "payload",
                    maximumResultBytes: PlatformIdempotencyStore.MaximumResultBytes),
                _ =>
                {
                    called = true;
                    return Task.FromResult(Result(0));
                },
                CancellationToken.None);

            Assert.Equal(PlatformIdempotencyOutcomeKind.AtCapacity, refused.Kind);
            Assert.False(called);

            release.TrySetResult(Result(1));
            Assert.All(await Task.WhenAll(leaders), outcome =>
                Assert.Equal(PlatformIdempotencyOutcomeKind.Executed, outcome.Kind));
        }

        [Fact]
        public async Task ExpiredTerminalEntryCanBeReused()
        {
            var clock = new ManualTimeProvider(new DateTimeOffset(2026, 8, 3, 0, 0, 0, TimeSpan.Zero));
            var store = new PlatformIdempotencyStore(clock);
            await store.ExecuteAsync(Request("expiry", "before"), _ => Task.FromResult(Result(1)), CancellationToken.None);

            clock.Advance(PlatformIdempotencyStore.EntryTimeToLive + TimeSpan.FromTicks(1));
            var after = await store.ExecuteAsync(
                Request("expiry", "after"),
                _ => Task.FromResult(Result(2)),
                CancellationToken.None);

            Assert.Equal(PlatformIdempotencyOutcomeKind.Executed, after.Kind);
            Assert.Equal(2, after.Result!.Value.GetProperty("value").GetInt32());
        }

        [Fact]
        public async Task FailedLeaderLeavesAnAmbiguousTombstone()
        {
            var store = new PlatformIdempotencyStore();
            var request = Request("ambiguous", "payload");

            await Assert.ThrowsAsync<InvalidOperationException>(() => store.ExecuteAsync(
                request,
                _ => throw new InvalidOperationException("provider outcome unknown"),
                CancellationToken.None));

            var called = false;
            var retry = await store.ExecuteAsync(request, _ =>
            {
                called = true;
                return Task.FromResult(Result(1));
            }, CancellationToken.None);

            Assert.Equal(PlatformIdempotencyOutcomeKind.Indeterminate, retry.Kind);
            Assert.False(called);
        }

        [Fact]
        public async Task CoordinatedLeaderCanceledBeforeSideEffectLetsFollowerRetryLeadership()
        {
            var store = new PlatformIdempotencyStore();
            var request = Request("safe-abandonment", "payload");
            var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            using var leaderCancellation = new CancellationTokenSource();

            var leader = store.ExecuteCoordinatedAsync(
                request,
                async (_, cancellationToken) =>
                {
                    entered.TrySetResult();
                    await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                    throw new Xunit.Sdk.XunitException("The canceled leader must not continue.");
                },
                leaderCancellation.Token);
            await entered.Task;

            var followerCalls = 0;
            var follower = store.ExecuteCoordinatedAsync(
                request,
                (execution, _) =>
                {
                    followerCalls++;
                    execution.MarkSideEffectStarted();
                    return Task.FromResult(Result(17));
                },
                CancellationToken.None);
            Assert.Equal(1, store.FollowerCount);

            leaderCancellation.Cancel();

            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => leader);
            var promoted = await follower;
            Assert.Equal(PlatformIdempotencyOutcomeKind.Executed, promoted.Kind);
            Assert.Equal(17, promoted.Result!.Value.GetProperty("value").GetInt32());
            Assert.Equal(1, followerCalls);
            Assert.Equal(0, store.FollowerCount);
            Assert.Equal(
                PlatformIdempotencyOutcomeKind.Replay,
                (await store.ExecuteAsync(request, _ => Task.FromResult(Result(99)), CancellationToken.None)).Kind);
        }

        [Fact]
        public async Task CoordinatedFailureAfterSideEffectBoundaryRemainsIndeterminate()
        {
            var store = new PlatformIdempotencyStore();
            var request = Request("marked-ambiguous", "payload");

            await Assert.ThrowsAsync<InvalidOperationException>(() => store.ExecuteCoordinatedAsync(
                request,
                (execution, _) =>
                {
                    execution.MarkSideEffectStarted();
                    throw new InvalidOperationException("owner outcome unknown");
                },
                CancellationToken.None));

            var called = false;
            var retry = await store.ExecuteCoordinatedAsync(
                request,
                (_, _) =>
                {
                    called = true;
                    return Task.FromResult(Result(1));
                },
                CancellationToken.None);

            Assert.Equal(PlatformIdempotencyOutcomeKind.Indeterminate, retry.Kind);
            Assert.False(called);
        }

        [Fact]
        public async Task CoordinatedPreMutationRefusalIsSharedWithFollowersButNotRetained()
        {
            var store = new PlatformIdempotencyStore();
            var request = Request("unstored-refusal", "payload");
            var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var leader = store.ExecuteCoordinatedAsync(
                request,
                async (execution, _) =>
                {
                    entered.TrySetResult();
                    await release.Task;
                    return execution.AbandonBeforeSideEffect(Result(17));
                },
                CancellationToken.None);
            await entered.Task;

            var followerCalls = 0;
            var follower = store.ExecuteCoordinatedAsync(
                request,
                (_, _) =>
                {
                    followerCalls++;
                    return Task.FromResult(Result(99));
                },
                CancellationToken.None);
            Assert.Equal(1, store.FollowerCount);
            release.TrySetResult();

            var leaderOutcome = await leader;
            var followerOutcome = await follower;
            Assert.Equal(17, leaderOutcome.Result!.Value.GetProperty("value").GetInt32());
            Assert.Equal(17, followerOutcome.Result!.Value.GetProperty("value").GetInt32());
            Assert.False(leaderOutcome.WasCoalescedUnstored);
            Assert.True(followerOutcome.WasCoalescedUnstored);
            Assert.Equal(0, followerCalls);
            Assert.Equal(0, store.EntryCount);

            var retry = await store.ExecuteCoordinatedAsync(
                request,
                (execution, _) =>
                {
                    execution.MarkSideEffectStarted();
                    return Task.FromResult(Result(99));
                },
                CancellationToken.None);
            Assert.Equal(PlatformIdempotencyOutcomeKind.Executed, retry.Kind);
            Assert.Equal(99, retry.Result!.Value.GetProperty("value").GetInt32());
        }

        [Fact]
        public async Task CoordinatedPreMutationRefusalCannotBypassItsResultReservation()
        {
            var store = new PlatformIdempotencyStore();
            var request = Request("bounded-refusal", "payload", maximumResultBytes: 8);

            var outcome = await store.ExecuteCoordinatedAsync(
                request,
                (execution, _) => Task.FromResult(
                    execution.AbandonBeforeSideEffect(Result(123))),
                CancellationToken.None);

            Assert.Equal(PlatformIdempotencyOutcomeKind.Indeterminate, outcome.Kind);
            Assert.Equal(
                PlatformIdempotencyOutcomeKind.Indeterminate,
                (await store.ExecuteCoordinatedAsync(
                    request,
                    (_, _) => Task.FromResult(Result(1)),
                    CancellationToken.None)).Kind);
        }

        [Fact]
        public async Task ResultLargerThanItsPreExecutionReservationBecomesIndeterminate()
        {
            var store = new PlatformIdempotencyStore();
            var request = Request("bounded-result", "payload", maximumResultBytes: 8);
            var outcome = await store.ExecuteAsync(request, _ => Task.FromResult(Result(123)), CancellationToken.None);

            Assert.Equal(PlatformIdempotencyOutcomeKind.Indeterminate, outcome.Kind);
            Assert.Equal(
                PlatformIdempotencyOutcomeKind.Indeterminate,
                (await store.ExecuteAsync(request, _ => Task.FromResult(Result(456)), CancellationToken.None)).Kind);
        }

        [Fact]
        public void SemanticResultAndFingerprintDefensivelyOwnTheirInputs()
        {
            var bytes = System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes("original"));
            var fingerprint = new PlatformSemanticFingerprint(bytes);
            Array.Fill<byte>(bytes, 0);

            using var document = JsonDocument.Parse("{\"value\":1}");
            var result = new PlatformIdempotencyResult(409, "already-exists", document.RootElement);
            document.Dispose();

            Assert.Equal(1, result.Value.GetProperty("value").GetInt32());
            Assert.True(fingerprint.Matches(new PlatformSemanticFingerprint(
                System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes("original")))));
        }

        [Fact]
        public void OversizedSemanticResultIsRejectedByTheBoundedWriter()
        {
            using var document = JsonDocument.Parse(
                "{\"value\":\"" + new string('x', PlatformIdempotencyStore.MaximumResultBytes) + "\"}");

            Assert.Throws<ArgumentException>(() => new PlatformIdempotencyResult(200, "ok", document.RootElement));
        }

        [Fact]
        public void SemanticResultAcceptsTheExactByteCeiling()
        {
            // Four status bytes + two outcome-code bytes + 12 bytes of JSON syntax.
            var payloadBytes = PlatformIdempotencyStore.MaximumResultBytes - sizeof(int) - 2 - 12;
            using var document = JsonDocument.Parse("{\"value\":\"" + new string('x', payloadBytes) + "\"}");

            var result = new PlatformIdempotencyResult(200, "ok", document.RootElement);

            Assert.Equal(PlatformIdempotencyStore.MaximumResultBytes, result.SerializedSizeBytes);
        }

        [Theory]
        [InlineData(PlatformIdempotencyOutcomeKind.Executed, null, null, null)]
        [InlineData(PlatformIdempotencyOutcomeKind.Replay, null, null, null)]
        [InlineData(PlatformIdempotencyOutcomeKind.Conflict, PlatformErrorCode.Conflict, 409, false)]
        [InlineData(PlatformIdempotencyOutcomeKind.AtCapacity, PlatformErrorCode.RateLimited, 429, true)]
        [InlineData(PlatformIdempotencyOutcomeKind.Indeterminate, PlatformErrorCode.Conflict, 409, false)]
        public void NonResultOutcomesPinExistingErrorSemantics(
            PlatformIdempotencyOutcomeKind kind,
            string? code,
            int? status,
            bool? retryable)
        {
            var outcome = new PlatformIdempotencyOutcome(kind);

            Assert.Equal(code, outcome.ErrorCode);
            if (code is not null)
            {
                Assert.Equal(status, PlatformErrorCode.StatusFor(code));
                Assert.Equal(retryable, PlatformErrorCode.IsRetryable(code));
            }
        }

        private static PlatformIdempotencyRequest Request(
            string key,
            string payload,
            Guid? user = null,
            string operation = "request.create",
            int maximumResultBytes = 1024)
        {
            Assert.True(PlatformIdempotencyKey.TryParse(key, out var parsed));
            return new PlatformIdempotencyRequest(
                user ?? Guid.Parse("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
                operation,
                parsed,
                new PlatformSemanticFingerprint(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(payload))),
                maximumResultBytes);
        }

        private static PlatformIdempotencyResult Result(int value)
        {
            using var document = JsonDocument.Parse($"{{\"value\":{value}}}");
            return new PlatformIdempotencyResult(200, "ok", document.RootElement);
        }

        private sealed class ManualTimeProvider(DateTimeOffset now) : TimeProvider
        {
            private DateTimeOffset _now = now;

            public override DateTimeOffset GetUtcNow() => _now;

            internal void Advance(TimeSpan amount) => _now += amount;
        }
    }
}
