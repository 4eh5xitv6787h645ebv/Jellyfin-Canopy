using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    public class PlatformActionInvocationCoordinatorTests
    {
        [Fact]
        public async Task ConcurrentDuplicateInvokesOneOwnerThenReplaysAfterCapabilityConsumption()
        {
            using var fixture = new Fixture();
            fixture.Port.BlockOwner = true;
            var prepared = fixture.Prepare();
            var request = fixture.Request(prepared.Capability!, "same-key", enabled: true);

            var first = fixture.Coordinator.InvokeAsync(fixture.BoundaryActor, request, NoCancellation());
            await fixture.Port.OwnerEntered.Task;
            var duplicate = fixture.Coordinator.InvokeAsync(fixture.BoundaryActor, request, NoCancellation());
            fixture.Port.ReleaseOwner.TrySetResult();

            var outcomes = await Task.WhenAll(first, duplicate);
            Assert.Equal(1, fixture.Port.OwnerCalls);
            Assert.Contains(outcomes, outcome => !outcome.Replayed);
            Assert.Contains(outcomes, outcome => outcome.Replayed);
            Assert.All(outcomes, outcome => Assert.Equal(200, outcome.Result.StatusCode));
            Assert.Equal(
                new[] { PlatformAuditResultCode.Succeeded, PlatformAuditResultCode.IdempotencyReplayed }.OrderBy(value => value),
                fixture.Audit.Snapshot().Select(record => record.ResultCode).OrderBy(value => value));

            var newKey = await fixture.Coordinator.InvokeAsync(
                fixture.BoundaryActor,
                fixture.Request(prepared.Capability!, "new-key", enabled: true),
                NoCancellation());
            Assert.Equal(409, newKey.Result.StatusCode);
            Assert.Equal(PlatformErrorCode.Conflict, newKey.Result.OutcomeCode);
            Assert.Equal(1, fixture.Port.OwnerCalls);
            Assert.Equal(PlatformAuditResultCode.CapabilityReplayed, fixture.Audit.Snapshot()[^1].ResultCode);
        }

        [Fact]
        public async Task SameTupleWithDifferentTypedInputConflictsBeforeSecondOwnerCall()
        {
            using var fixture = new Fixture();
            var prepared = fixture.Prepare();
            var enabled = await fixture.Coordinator.InvokeAsync(
                fixture.BoundaryActor,
                fixture.Request(prepared.Capability!, "same-key", enabled: true),
                NoCancellation());
            Assert.Equal(200, enabled.Result.StatusCode);

            // A freshly prepared capability is required because the first was spent;
            // idempotency must still conflict before this new capability is consumed.
            var secondPrepared = fixture.Prepare();
            var conflict = await fixture.Coordinator.InvokeAsync(
                fixture.BoundaryActor,
                fixture.Request(secondPrepared.Capability!, "same-key", enabled: false),
                NoCancellation());

            Assert.Equal(409, conflict.Result.StatusCode);
            Assert.Equal(PlatformErrorCode.Conflict, conflict.Result.OutcomeCode);
            Assert.Equal(1, fixture.Port.OwnerCalls);
            Assert.Equal(PlatformAuditResultCode.Conflict, fixture.Audit.Snapshot()[^1].ResultCode);
        }

        [Fact]
        public async Task QueuedLeaderReauthorizesItemBeforeCapabilitySpendAndCanRetrySafely()
        {
            using var fixture = new Fixture();
            var prepared = fixture.Prepare();
            var blocker = await fixture.Limiter.AcquireAsync(
                fixture.BoundaryActor,
                PlatformOperationDefinition.SpoilerGuardConfigureItem,
                CancellationToken.None);
            var request = fixture.Request(prepared.Capability!, "queued-key", enabled: true);
            var invocation = fixture.Coordinator.InvokeAsync(fixture.BoundaryActor, request, NoCancellation());
            await EventuallyAsync(() => fixture.Limiter.WaiterCount == 1);

            fixture.Host.ItemAccessible = false;
            blocker.Dispose();
            var denied = await invocation;
            Assert.Equal(404, denied.Result.StatusCode);
            Assert.Equal(0, fixture.Port.OwnerCalls);

            fixture.Host.ItemAccessible = true;
            var retry = await fixture.Coordinator.InvokeAsync(
                fixture.BoundaryActor,
                request,
                NoCancellation());
            Assert.Equal(200, retry.Result.StatusCode);
            Assert.Equal(1, fixture.Port.OwnerCalls);
        }

        [Fact]
        public async Task AdmissionPressureIsRetryableWithTheSameKeyAndCapability()
        {
            using var fixture = new Fixture();
            var blocker = await fixture.Limiter.AcquireAsync(
                fixture.BoundaryActor,
                PlatformOperationDefinition.SpoilerGuardConfigureItem,
                CancellationToken.None);
            var cancellations = new List<CancellationTokenSource>();
            var waiters = new List<Task<PlatformActionAdmission>>();
            for (var index = 0; index < PlatformActionAdmissionLimiter.MaximumWaitersPerKey; index++)
            {
                var cancellation = new CancellationTokenSource();
                cancellations.Add(cancellation);
                waiters.Add(fixture.Limiter.AcquireAsync(
                    fixture.BoundaryActor,
                    PlatformOperationDefinition.SpoilerGuardConfigureItem,
                    cancellation.Token));
            }

            await EventuallyAsync(() => fixture.Limiter.WaiterCount == PlatformActionAdmissionLimiter.MaximumWaitersPerKey);
            var prepared = fixture.Prepare();
            var request = fixture.Request(prepared.Capability!, "capacity-retry", enabled: true);
            var refused = await fixture.Coordinator.InvokeAsync(
                fixture.BoundaryActor,
                request,
                NoCancellation());
            Assert.Equal(429, refused.Result.StatusCode);
            Assert.Equal(0, fixture.Idempotency.EntryCount);
            Assert.Equal(0, fixture.Port.OwnerCalls);

            foreach (var cancellation in cancellations)
            {
                cancellation.Cancel();
            }

            foreach (var waiter in waiters)
            {
                await Assert.ThrowsAnyAsync<OperationCanceledException>(() => waiter);
            }

            foreach (var cancellation in cancellations)
            {
                cancellation.Dispose();
            }

            blocker.Dispose();
            var retry = await fixture.Coordinator.InvokeAsync(
                fixture.BoundaryActor,
                request,
                NoCancellation());
            Assert.Equal(200, retry.Result.StatusCode);
            Assert.Equal(1, fixture.Port.OwnerCalls);
        }

        [Fact]
        public async Task CancellationWhileQueuedDoesNotPoisonIdempotencyOrConsumeCapability()
        {
            using var fixture = new Fixture();
            var prepared = fixture.Prepare();
            var blocker = await fixture.Limiter.AcquireAsync(
                fixture.BoundaryActor,
                PlatformOperationDefinition.SpoilerGuardConfigureItem,
                CancellationToken.None);
            using var caller = new CancellationTokenSource();
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(caller.Token);
            var request = fixture.Request(prepared.Capability!, "cancel-key", enabled: true);
            var canceled = fixture.Coordinator.InvokeAsync(
                fixture.BoundaryActor,
                request,
                new PlatformInvocationCancellation(linked.Token, caller.Token, CancellationToken.None));
            await EventuallyAsync(() => fixture.Limiter.WaiterCount == 1);
            caller.Cancel();

            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => canceled);
            blocker.Dispose();
            Assert.Equal(PlatformAuditResultCode.CallerCancelled, fixture.Audit.Snapshot()[^1].ResultCode);

            var retry = await fixture.Coordinator.InvokeAsync(
                fixture.BoundaryActor,
                request,
                NoCancellation());
            Assert.Equal(200, retry.Result.StatusCode);
            Assert.Equal(1, fixture.Port.OwnerCalls);
        }

        [Theory]
        [InlineData("caller", (int)PlatformAuditResultCode.CallerCancelled)]
        [InlineData("deadline", (int)PlatformAuditResultCode.DeadlineExceeded)]
        [InlineData("simultaneous", (int)PlatformAuditResultCode.CallerCancelled)]
        public async Task CancellationIgnoringOwnerStoresResultButCurrentRequestAuditsCancellation(
            string cancellationKind,
            int expectedAuditValue)
        {
            var expectedAudit = (PlatformAuditResultCode)expectedAuditValue;
            using var fixture = new Fixture();
            fixture.Port.BlockOwner = true;
            fixture.Port.IgnoreCancellation = true;
            var prepared = fixture.Prepare();
            var request = fixture.Request(prepared.Capability!, "ignored-cancellation", enabled: true);
            using var caller = new CancellationTokenSource();
            using var deadline = new CancellationTokenSource();
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(caller.Token, deadline.Token);
            var invocation = fixture.Coordinator.InvokeAsync(
                fixture.BoundaryActor,
                request,
                new PlatformInvocationCancellation(linked.Token, caller.Token, deadline.Token));
            await fixture.Port.OwnerEntered.Task;

            if (cancellationKind is "caller" or "simultaneous")
            {
                caller.Cancel();
            }

            if (cancellationKind is "deadline" or "simultaneous")
            {
                deadline.Cancel();
            }

            fixture.Port.ReleaseOwner.TrySetResult();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => invocation);

            Assert.Equal(1, fixture.Port.OwnerCalls);
            Assert.Equal(expectedAudit, fixture.Audit.Snapshot()[^1].ResultCode);

            var replay = await fixture.Coordinator.InvokeAsync(
                fixture.BoundaryActor,
                request,
                NoCancellation());
            Assert.True(replay.Replayed);
            Assert.Equal(200, replay.Result.StatusCode);
            Assert.Equal(1, fixture.Port.OwnerCalls);
            Assert.Equal(PlatformAuditResultCode.IdempotencyReplayed, fixture.Audit.Snapshot()[^1].ResultCode);
        }

        [Theory]
        [InlineData("caller", (int)PlatformAuditResultCode.CallerCancelled)]
        [InlineData("deadline", (int)PlatformAuditResultCode.DeadlineExceeded)]
        [InlineData("simultaneous", (int)PlatformAuditResultCode.CallerCancelled)]
        public async Task PreCanceledInvalidCapabilityUsesCancellationPrecedence(
            string cancellationKind,
            int expectedAuditValue)
        {
            var expectedAudit = (PlatformAuditResultCode)expectedAuditValue;
            using var fixture = new Fixture();
            using var caller = new CancellationTokenSource();
            using var deadline = new CancellationTokenSource();
            if (cancellationKind is "caller" or "simultaneous")
            {
                caller.Cancel();
            }

            if (cancellationKind is "deadline" or "simultaneous")
            {
                deadline.Cancel();
            }

            using var linked = CancellationTokenSource.CreateLinkedTokenSource(caller.Token, deadline.Token);
            var invocation = fixture.Coordinator.InvokeAsync(
                fixture.BoundaryActor,
                fixture.Request("forged", "pre-canceled", true),
                new PlatformInvocationCancellation(linked.Token, caller.Token, deadline.Token));

            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => invocation);
            var record = Assert.Single(fixture.Audit.Snapshot());
            Assert.Equal(expectedAudit, record.ResultCode);
            Assert.Equal(PlatformAuditSubjectResolution.Unresolved, record.SubjectResolution);
            Assert.Equal(0, fixture.Port.OwnerCalls);
        }

        [Theory]
        [InlineData("user-deletion")]
        [InlineData("library-removal")]
        [InlineData("parental-policy-change")]
        [InlineData("item-deletion")]
        [InlineData("item-move")]
        [InlineData("feature-disable")]
        [InlineData("configuration-revision")]
        [InlineData("authority-revision")]
        public async Task CoalescedFollowerReauthorizesBeforeStoredReplayIsReleased(string revocation)
        {
            using var fixture = new Fixture();
            fixture.Port.BlockOwner = true;
            if (revocation == "item-move")
            {
                fixture.Host.UseEpisode();
            }

            var prepared = fixture.Prepare(
                revocation == "item-move"
                    ? PlatformOperationDefinition.HiddenContentConfigureItem
                    : PlatformOperationDefinition.SpoilerGuardConfigureItem);
            var request = fixture.Request(prepared.Capability!, "follower-reauth", enabled: true);
            var leader = fixture.Coordinator.InvokeAsync(fixture.BoundaryActor, request, NoCancellation());
            await fixture.Port.OwnerEntered.Task;
            var follower = fixture.Coordinator.InvokeAsync(fixture.BoundaryActor, request, NoCancellation());
            await EventuallyAsync(() => fixture.Idempotency.FollowerCount == 1);

            fixture.Revoke(revocation);
            fixture.Port.ReleaseOwner.TrySetResult();
            var leaderResult = await leader;
            var followerResult = await follower;

            Assert.Equal(200, leaderResult.Result.StatusCode);
            Assert.Equal(404, followerResult.Result.StatusCode);
            Assert.False(followerResult.Replayed);
            Assert.Equal(1, fixture.Port.OwnerCalls);
            Assert.Contains(
                fixture.Audit.Snapshot(),
                record => record.ResultCode == PlatformAuditResultCode.AuthorityDenied);

            fixture.RestoreCurrentAuthority();
            var later = await fixture.Coordinator.InvokeAsync(
                fixture.BoundaryActor,
                request,
                NoCancellation());
            if (revocation == "authority-revision")
            {
                Assert.Equal(404, later.Result.StatusCode);
            }
            else
            {
                Assert.True(later.Replayed);
                Assert.Equal(200, later.Result.StatusCode);
                Assert.Equal(PlatformAuditResultCode.IdempotencyReplayed, fixture.Audit.Snapshot()[^1].ResultCode);
            }

            Assert.Equal(1, fixture.Port.OwnerCalls);
        }

        [Fact]
        public async Task CurrentUserItemFeatureInputAndAuthorityChangesAllFailBeforeOwner()
        {
            using var fixture = new Fixture();

            var deletedUser = fixture.Prepare();
            fixture.Host.UserExists = false;
            Assert.Equal(404, (await fixture.Coordinator.InvokeAsync(
                fixture.BoundaryActor,
                fixture.Request(deletedUser.Capability!, "deleted-user", true),
                NoCancellation())).Result.StatusCode);
            fixture.Host.UserExists = true;

            var inaccessible = fixture.Prepare();
            fixture.Host.ItemAccessible = false;
            Assert.Equal(404, (await fixture.Coordinator.InvokeAsync(
                fixture.BoundaryActor,
                fixture.Request(inaccessible.Capability!, "inaccessible", true),
                NoCancellation())).Result.StatusCode);
            fixture.Host.ItemAccessible = true;

            var disabled = fixture.Prepare();
            fixture.Port.FeatureEnabled = false;
            Assert.Equal(404, (await fixture.Coordinator.InvokeAsync(
                fixture.BoundaryActor,
                fixture.Request(disabled.Capability!, "disabled", true),
                NoCancellation())).Result.StatusCode);
            fixture.Port.FeatureEnabled = true;

            var revised = fixture.Prepare();
            fixture.Port.ConfigurationRevision++;
            Assert.Equal(404, (await fixture.Coordinator.InvokeAsync(
                fixture.BoundaryActor,
                fixture.Request(revised.Capability!, "feature-revision", true),
                NoCancellation())).Result.StatusCode);

            var invalidInput = fixture.Prepare();
            Assert.Equal(400, (await fixture.Coordinator.InvokeAsync(
                fixture.BoundaryActor,
                new PlatformActionInvokeRequest(
                    invalidInput.Capability!,
                    Key("bad-input"),
                    ImmutableArray<PlatformActionAnswer>.Empty),
                NoCancellation())).Result.StatusCode);

            var stale = fixture.Prepare();
            fixture.Capabilities.InvalidateOutstandingCapabilities();
            Assert.Equal(404, (await fixture.Coordinator.InvokeAsync(
                fixture.BoundaryActor,
                fixture.Request(stale.Capability!, "stale", true),
                NoCancellation())).Result.StatusCode);

            Assert.Equal(0, fixture.Port.OwnerCalls);
            Assert.Equal(
                new[]
                {
                    PlatformAuditResultCode.AuthorityDenied,
                    PlatformAuditResultCode.AuthorityDenied,
                    PlatformAuditResultCode.AuthorityDenied,
                    PlatformAuditResultCode.AuthorityDenied,
                    PlatformAuditResultCode.InvalidInput,
                    PlatformAuditResultCode.AuthorityDenied,
                },
                fixture.Audit.Snapshot().Select(record => record.ResultCode));
        }

        [Theory]
        [InlineData("library-removal")]
        [InlineData("parental-policy-change")]
        [InlineData("item-deletion")]
        [InlineData("item-move")]
        public async Task CurrentItemPolicyRevocationsFailBeforeOwner(string revocation)
        {
            using var fixture = new Fixture();
            if (revocation == "item-move")
            {
                fixture.Host.UseEpisode();
            }

            var prepared = fixture.Prepare(
                revocation == "item-move"
                    ? PlatformOperationDefinition.HiddenContentConfigureItem
                    : PlatformOperationDefinition.SpoilerGuardConfigureItem);
            if (revocation == "item-move")
            {
                fixture.Host.ReturnedItem = new HostAccessibleItem(
                    fixture.Host.Item.Id,
                    HostItemKind.Episode,
                    Guid.Parse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
                    ImmutableArray<HostProviderReference>.Empty);
            }
            else
            {
                // Library membership, parental policy, and deletion are deliberately
                // indistinguishable at the user-scoped host seam.
                fixture.Host.ItemAccessible = false;
            }

            var result = await fixture.Coordinator.InvokeAsync(
                fixture.BoundaryActor,
                fixture.Request(prepared.Capability!, $"revoked-{revocation}", true),
                NoCancellation());

            Assert.Equal(404, result.Result.StatusCode);
            Assert.Equal(0, fixture.Port.OwnerCalls);
            Assert.Equal(PlatformAuditResultCode.AuthorityDenied, fixture.Audit.Snapshot()[^1].ResultCode);
        }

        [Theory]
        [InlineData("caller", (int)PlatformAuditResultCode.CallerCancelled)]
        [InlineData("deadline", (int)PlatformAuditResultCode.DeadlineExceeded)]
        public async Task CancellationDuringSynchronousCurrentAccessWinsOverDenial(
            string cancellationKind,
            int expectedAuditValue)
        {
            using var fixture = new Fixture();
            var prepared = fixture.Prepare();
            fixture.Host.BlockAccessibleLookup = true;
            fixture.Host.ItemAccessible = false;
            using var caller = new CancellationTokenSource();
            using var deadline = new CancellationTokenSource();
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(caller.Token, deadline.Token);
            var invocation = Task.Run(() => fixture.Coordinator.InvokeAsync(
                fixture.BoundaryActor,
                fixture.Request(prepared.Capability!, "blocked-access", true),
                new PlatformInvocationCancellation(linked.Token, caller.Token, deadline.Token)));
            Assert.True(fixture.Host.AccessibleLookupEntered.Wait(TimeSpan.FromSeconds(5)));

            if (cancellationKind == "caller")
            {
                caller.Cancel();
            }
            else
            {
                deadline.Cancel();
            }

            fixture.Host.ReleaseAccessibleLookup.Set();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => invocation);
            var record = Assert.Single(fixture.Audit.Snapshot());
            Assert.Equal((PlatformAuditResultCode)expectedAuditValue, record.ResultCode);
            Assert.Equal(0, fixture.Port.OwnerCalls);
        }

        [Fact]
        public async Task CurrentElevationIsDowngradedBeforeTheNamedPortWithoutPromotingAuthority()
        {
            using var fixture = new Fixture(boundaryElevated: true);
            fixture.Host.IsAdministrator = false;
            var prepared = fixture.Prepare();

            var result = await fixture.Coordinator.InvokeAsync(
                fixture.BoundaryActor,
                fixture.Request(prepared.Capability!, "downgrade", true),
                NoCancellation());

            Assert.Equal(200, result.Result.StatusCode);
            Assert.False(fixture.Port.LastActorWasElevated);
        }

        [Fact]
        public async Task ForgedExpiredAndContextlessCapabilitiesAreUnresolvedAndNeverDispatch()
        {
            var clock = new ManualTimeProvider(new DateTimeOffset(2026, 8, 3, 0, 0, 0, TimeSpan.Zero));
            using var fixture = new Fixture(clock: clock);
            var forged = await fixture.Coordinator.InvokeAsync(
                fixture.BoundaryActor,
                fixture.Request("forged", "forged-key", true),
                NoCancellation());
            Assert.Equal(404, forged.Result.StatusCode);

            var prepared = fixture.Prepare();
            clock.Advance(PlatformActionCapabilityService.CapabilityTimeToLive);
            var expired = await fixture.Coordinator.InvokeAsync(
                fixture.BoundaryActor,
                fixture.Request(prepared.Capability!, "expired-key", true),
                NoCancellation());
            Assert.Equal(404, expired.Result.StatusCode);
            Assert.Equal(0, fixture.Port.OwnerCalls);
            Assert.All(fixture.Audit.Snapshot(), record =>
                Assert.Equal(PlatformAuditSubjectResolution.Unresolved, record.SubjectResolution));
            Assert.Equal(PlatformAuditResultCode.CapabilityInvalid, fixture.Audit.Snapshot()[0].ResultCode);
            Assert.Equal(PlatformAuditResultCode.CapabilityExpired, fixture.Audit.Snapshot()[1].ResultCode);
        }

        private static async Task EventuallyAsync(Func<bool> predicate)
        {
            for (var attempt = 0; attempt < 1000; attempt++)
            {
                if (predicate())
                {
                    return;
                }

                await Task.Yield();
            }

            Assert.True(predicate(), "The bounded asynchronous condition was not reached.");
        }

        private static PlatformInvocationCancellation NoCancellation()
            => new(CancellationToken.None, CancellationToken.None, CancellationToken.None);

        private static PlatformIdempotencyKey Key(string value)
        {
            Assert.True(PlatformIdempotencyKey.TryParse(value, out var key));
            return key;
        }

        private sealed class Fixture : IDisposable
        {
            internal Fixture(bool boundaryElevated = false, ManualTimeProvider? clock = null)
            {
                Clock = clock ?? new ManualTimeProvider(DateTimeOffset.UtcNow);
                Capabilities = new PlatformActionCapabilityService(
                    Clock,
                    Enumerable.Repeat((byte)7, 32).ToArray(),
                    new SequentialNonceSource().GetBytes);
                Contexts = new PlatformPreparedActionContextOwner(
                    Capabilities,
                    Clock,
                    Enumerable.Repeat((byte)8, 32).ToArray());
                Host = new FakeHost();
                Port = new FakePort();
                Limiter = new PlatformActionAdmissionLimiter();
                Audit = new PlatformAuditStore(
                    NullLogger<PlatformAuditStore>.Instance,
                    Clock,
                    Enumerable.Repeat((byte)9, 32).ToArray());
                BoundaryActor = new PlatformActor(
                    FakeHost.UserId,
                    boundaryElevated,
                    new string('a', 32),
                    "android-tv",
                    "device-a");
                Idempotency = new PlatformIdempotencyStore(Clock);
                Coordinator = new PlatformActionInvocationCoordinator(
                    Host,
                    Contexts,
                    Capabilities,
                    Idempotency,
                    Limiter,
                    new PlatformFirstPartyActionDispatcher(Port, Port, Port),
                    Audit);
            }

            internal ManualTimeProvider Clock { get; }

            internal PlatformActionCapabilityService Capabilities { get; }

            internal PlatformPreparedActionContextOwner Contexts { get; }

            internal FakeHost Host { get; }

            internal FakePort Port { get; }

            internal PlatformActionAdmissionLimiter Limiter { get; }

            internal PlatformIdempotencyStore Idempotency { get; }

            internal PlatformAuditStore Audit { get; }

            internal PlatformActor BoundaryActor { get; }

            internal PlatformActionInvocationCoordinator Coordinator { get; }

            internal PlatformPreparedActionIssue Prepare(PlatformOperationDefinition? definition = null)
                => Contexts.Issue(
                    BoundaryActor,
                    new PlatformPreparedActionRequest(
                        definition ?? PlatformOperationDefinition.SpoilerGuardConfigureItem,
                        Host.Item,
                        Port.ConfigurationRevision,
                        new byte[] { 1, 0, 0, 0 }),
                    attenuateToCurrentDevice: false);

            internal PlatformActionInvokeRequest Request(string capability, string key, bool enabled)
                => new(
                    capability,
                    Key(key),
                    ImmutableArray.Create(new PlatformActionAnswer(
                        "enabled",
                        enabled,
                        optionIds: null)));

            internal void Revoke(string revocation)
            {
                switch (revocation)
                {
                    case "user-deletion":
                        Host.UserExists = false;
                        break;
                    case "library-removal":
                    case "parental-policy-change":
                    case "item-deletion":
                        Host.ItemAccessible = false;
                        break;
                    case "item-move":
                        Host.ReturnedItem = new HostAccessibleItem(
                            Host.Item.Id,
                            HostItemKind.Episode,
                            Guid.Parse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
                            ImmutableArray<HostProviderReference>.Empty);
                        break;
                    case "feature-disable":
                        Port.FeatureEnabled = false;
                        break;
                    case "configuration-revision":
                        Port.ConfigurationRevision++;
                        break;
                    case "authority-revision":
                        Capabilities.InvalidateOutstandingCapabilities();
                        break;
                    default:
                        throw new ArgumentOutOfRangeException(nameof(revocation));
                }
            }

            internal void RestoreCurrentAuthority()
            {
                Host.UserExists = true;
                Host.ItemAccessible = true;
                Host.ReturnedItem = null;
                Port.FeatureEnabled = true;
                Port.ConfigurationRevision = 1;
            }

            public void Dispose()
            {
                Contexts.Dispose();
                Capabilities.Dispose();
            }
        }

        private sealed class FakePort :
            ISpoilerGuardPlatformActionPort,
            IHiddenContentPlatformActionPort,
            ISeerrPlatformActionPort
        {
            internal bool FeatureEnabled { get; set; } = true;

            internal long ConfigurationRevision { get; set; } = 1;

            internal bool BlockOwner { get; set; }

            internal bool IgnoreCancellation { get; set; }

            internal int OwnerCalls { get; private set; }

            internal bool? LastActorWasElevated { get; private set; }

            internal TaskCompletionSource OwnerEntered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

            internal TaskCompletionSource ReleaseOwner { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

            public PlatformActionPortAdmission ValidateCurrent(
                PlatformActor actor,
                HostAccessibleItem item,
                PlatformPreparedActionContext prepared,
                ImmutableArray<PlatformActionAnswer> answers)
            {
                LastActorWasElevated = actor.IsElevated;
                if (!FeatureEnabled || prepared.ConfigurationRevision != ConfigurationRevision)
                {
                    return PlatformActionPortAdmission.Refuse(PlatformActionPortDecision.AuthorityDenied);
                }

                if (answers.Length != 1
                    || answers[0].FieldId != "enabled"
                    || answers[0].BooleanValue is not bool enabled
                    || answers[0].OptionIds is not null)
                {
                    return PlatformActionPortAdmission.Refuse(PlatformActionPortDecision.InvalidInput);
                }

                return PlatformActionPortAdmission.Admit(
                    new BooleanInput(enabled),
                    new[] { enabled ? (byte)1 : (byte)0 });
            }

            public async Task<PlatformActionOwnerResult> InvokeAsync(
                PlatformActor actor,
                HostAccessibleItem item,
                IPlatformValidatedActionInput input,
                PlatformIdempotencyKey idempotencyKey,
                CancellationToken cancellationToken)
            {
                Assert.IsType<BooleanInput>(input);
                OwnerCalls++;
                OwnerEntered.TrySetResult();
                if (BlockOwner)
                {
                    if (IgnoreCancellation)
                    {
                        await ReleaseOwner.Task;
                    }
                    else
                    {
                        await ReleaseOwner.Task.WaitAsync(cancellationToken);
                    }
                }

                using var document = JsonDocument.Parse("{\"Outcome\":\"succeeded\"}");
                return PlatformActionOwnerResult.Succeeded(document.RootElement);
            }

            private sealed record BooleanInput(bool Enabled) : IPlatformValidatedActionInput;
        }

        private sealed class FakeHost : IPlatformHost, IHostUsers, IHostLibrary, IHostSessions, IHostPlugins
        {
            internal static readonly Guid UserId = Guid.Parse("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
            private static readonly Guid ItemId = Guid.Parse("11111111-2222-3333-4444-555555555555");

            internal FakeHost()
            {
                Item = new HostAccessibleItem(
                    ItemId,
                    HostItemKind.Movie,
                    seriesId: null,
                    ImmutableArray<HostProviderReference>.Empty);
            }

            public IHostUsers Users => this;

            public IHostLibrary Library => this;

            public IHostSessions Sessions => this;

            public IHostPlugins Plugins => this;

            internal bool UserExists { get; set; } = true;

            internal bool IsAdministrator { get; set; }

            internal bool ItemAccessible { get; set; } = true;

            internal HostAccessibleItem Item { get; private set; }

            internal HostAccessibleItem? ReturnedItem { get; set; }

            internal bool BlockAccessibleLookup { get; set; }

            internal ManualResetEventSlim AccessibleLookupEntered { get; } = new(initialState: false);

            internal ManualResetEventSlim ReleaseAccessibleLookup { get; } = new(initialState: false);

            internal void UseEpisode()
                => Item = new HostAccessibleItem(
                    Item.Id,
                    HostItemKind.Episode,
                    Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
                    ImmutableArray<HostProviderReference>.Empty);

            public HostUser? Find(Guid id)
                => UserExists && id == UserId ? new HostUser(UserId, "user", IsAdministrator) : null;

            HostItem? IHostLibrary.Find(Guid id) => null;

            public HostItemAccessResult FindAccessible(Guid userId, Guid itemId)
            {
                if (BlockAccessibleLookup)
                {
                    AccessibleLookupEntered.Set();
                    ReleaseAccessibleLookup.Wait();
                }

                return ItemAccessible && UserExists && userId == UserId && itemId == Item.Id
                    ? HostItemAccessResult.Accessible(ReturnedItem ?? Item)
                    : HostItemAccessResult.NotAccessible;
            }

            public IReadOnlyList<HostUser> All() => Array.Empty<HostUser>();

            public IReadOnlyList<HostItem> ChildrenOf(Guid id) => Array.Empty<HostItem>();

            public IReadOnlyList<HostSession> Active() => Array.Empty<HostSession>();

            public IReadOnlyList<HostSession> ForUser(Guid userId) => Array.Empty<HostSession>();

            public IReadOnlyList<HostPlugin> Installed() => Array.Empty<HostPlugin>();

            HostPlugin? IHostPlugins.Find(Guid id) => null;
        }

        private sealed class SequentialNonceSource
        {
            private int _value;

            internal byte[] GetBytes(int length)
            {
                var result = new byte[length];
                BitConverter.GetBytes(++_value).CopyTo(result, 0);
                return result;
            }
        }

        internal sealed class ManualTimeProvider(DateTimeOffset now) : TimeProvider
        {
            private DateTimeOffset _now = now;

            public override DateTimeOffset GetUtcNow() => _now;

            internal void Advance(TimeSpan amount) => _now += amount;
        }
    }
}
