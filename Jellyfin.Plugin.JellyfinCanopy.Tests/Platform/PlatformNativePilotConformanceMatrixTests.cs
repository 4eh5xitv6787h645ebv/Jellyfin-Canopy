using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Net;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Primitives;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    /// <summary>
    /// Blocking adversarial matrix over the real EP-02 pilot kernel.  The only HTTP
    /// surface and action owners in this fixture are test-owned: no provisional route,
    /// registry or production adapter is needed to prove the native-client contract.
    /// </summary>
    public sealed class PlatformNativePilotConformanceMatrixTests
    {
        private const string SecretCanary = "seerr-secret-do-not-disclose";

        [Fact]
        public async Task SameIpUsersAndForgedIdentitySourcesCannotCrossTheActorBoundary()
        {
            using var fixture = new Fixture();
            var preparedA = fixture.Prepare(Fixture.UserA);
            var preparedB = fixture.Prepare(Fixture.UserB);
            var sharedAddress = IPAddress.Parse("192.0.2.44");

            var requestA = fixture.Http(Fixture.UserA, sharedAddress, elevatedRole: false);
            ForgeEveryRequestIdentitySource(requestA, Fixture.UserB);
            var outcomeA = await fixture.InvokeThroughActorAsync(
                requestA,
                fixture.Request(preparedA.Capability!, "same-ip-key"));

            var requestB = fixture.Http(Fixture.UserB, sharedAddress, elevatedRole: true);
            ForgeEveryRequestIdentitySource(requestB, Fixture.UserA);
            var outcomeB = await fixture.InvokeThroughActorAsync(
                requestB,
                fixture.Request(preparedB.Capability!, "same-ip-key"));

            var stolen = await fixture.InvokeThroughActorAsync(
                fixture.Http(Fixture.UserB, sharedAddress, elevatedRole: true),
                fixture.Request(fixture.Prepare(Fixture.UserA).Capability!, "stolen-key"));

            Assert.Equal(200, outcomeA!.Result.StatusCode);
            Assert.Equal(200, outcomeB!.Result.StatusCode);
            Assert.Equal(404, stolen!.Result.StatusCode);
            Assert.Equal(new[] { Fixture.UserA, Fixture.UserB }, fixture.Port.OwnerActors);
            Assert.Equal(new[] { true, false }, fixture.Port.OwnerElevation);
            Assert.Equal(new[] { "android-tv", "android-tv" }, fixture.Port.OwnerClientNames);
            Assert.Equal(new[] { "living-room", "living-room" }, fixture.Port.OwnerDeviceIds);
            var observable = fixture.ObservableText(outcomeA, outcomeB, stolen);
            Assert.DoesNotContain(SecretCanary, observable, StringComparison.Ordinal);
        }

        [Fact]
        public void BodyCarrierAndStrictKnownFieldsRejectCompetingOrAmbiguousInput()
        {
            using var fixture = new Fixture();
            var prepared = fixture.Prepare(Fixture.UserA);
            var valid = fixture.Request(prepared.Capability!, "body-owned-key");

            Assert.True(PlatformActionIdempotencyCarrier.TryResolve(
                valid,
                StringValues.Empty,
                out var bodyKey));
            Assert.Equal("body-owned-key", bodyKey.Value);
            Assert.False(PlatformActionIdempotencyCarrier.TryResolve(
                valid,
                new StringValues("forged-header-key"),
                out _));

            var duplicateKnown = "{\"Capability\":\"x\",\"Capability\":\"y\",\"IdempotencyKey\":\"key\",\"Answers\":[]}";
            var duplicateAnswer = "{\"Capability\":\"x\",\"IdempotencyKey\":\"key\",\"Answers\":[{\"FieldId\":\"enabled\",\"BooleanValue\":true},{\"FieldId\":\"enabled\",\"BooleanValue\":false}]}";
            var bothCarriers = "{\"Capability\":\"x\",\"IdempotencyKey\":\"key\",\"Answers\":[{\"FieldId\":\"enabled\",\"BooleanValue\":true,\"OptionIds\":[\"x\"]}]}";
            var tooManyOptions = string.Join(",", Enumerable.Range(0, PlatformActionInvokeRequestConverter.MaximumOptionIds + 1)
                .Select(index => $"\"o{index}\""));
            Assert.Throws<JsonException>(() => fixture.Parse(duplicateKnown));
            Assert.Throws<JsonException>(() => fixture.Parse(duplicateAnswer));
            Assert.Throws<JsonException>(() => fixture.Parse(bothCarriers));
            Assert.Throws<JsonException>(() => fixture.Parse(
                $"{{\"Capability\":\"x\",\"IdempotencyKey\":\"key\",\"Answers\":[{{\"FieldId\":\"choice\",\"OptionIds\":[{tooManyOptions}]}}]}}"));
            Assert.Equal(0, fixture.Port.OwnerCalls);
        }

        [Fact]
        public async Task WrongStaleSwappedExpiredAndReplayedCapabilitiesFailClosed()
        {
            var clock = new ManualTimeProvider(DateTimeOffset.UtcNow);
            using var fixture = new Fixture(clock);
            var valid = fixture.Prepare(Fixture.UserA);
            var otherUser = fixture.Prepare(Fixture.UserB);
            var validInspection = fixture.Capabilities.Inspect(valid.Capability);
            var validContext = Assert.IsType<PlatformPreparedActionContext>(
                fixture.Contexts.Resolve(valid.Capability, validInspection));
            var wrongOperation = fixture.Capabilities.Mint(
                fixture.Actor(Fixture.UserA),
                PlatformOperationDefinition.HiddenContentConfigureItem.Id.Value,
                fixture.Host.Item.Id,
                fixture.Host.Item.Kind,
                validContext.Digest.Span,
                attenuateToCurrentDevice: false);
            Assert.Equal(PlatformCapabilityMintOutcomeKind.Issued, wrongOperation.Kind);
            var wrongInspection = fixture.Capabilities.Inspect(wrongOperation.Capability);
            Assert.Equal(PlatformCapabilityInspectionKind.Authentic, wrongInspection.Kind);
            Assert.Equal(
                PlatformCapabilityValidationKind.WrongOperation,
                fixture.Capabilities.ValidateCurrent(
                    wrongInspection,
                    fixture.Actor(Fixture.UserA),
                    PlatformOperationDefinition.SpoilerGuardConfigureItem.Id.Value,
                    fixture.Host.Item.Id,
                    fixture.Host.Item.Kind,
                    validContext.Digest.Span).Kind);
            var wrongOperationResult = await fixture.InvokeAsync(
                Fixture.UserA,
                fixture.Request(wrongOperation.Capability!, "wrong-operation"));
            fixture.Host.ReturnedItem = fixture.Host.OtherItem;
            var wrongItem = await fixture.InvokeAsync(Fixture.UserA, fixture.Request(valid.Capability!, "wrong-item"));
            fixture.Host.ReturnedItem = null;

            var swapped = await fixture.InvokeAsync(Fixture.UserA, fixture.Request(otherUser.Capability!, "swapped"));
            var first = await fixture.InvokeAsync(Fixture.UserA, fixture.Request(valid.Capability!, "valid-key"));
            var idempotent = await fixture.InvokeAsync(Fixture.UserA, fixture.Request(valid.Capability!, "valid-key"));
            var replay = await fixture.InvokeAsync(Fixture.UserA, fixture.Request(valid.Capability!, "different-key"));

            var stale = fixture.Prepare(Fixture.UserA);
            fixture.Capabilities.InvalidateOutstandingCapabilities();
            var invalidated = await fixture.InvokeAsync(Fixture.UserA, fixture.Request(stale.Capability!, "stale"));

            var expiring = fixture.Prepare(Fixture.UserA);
            clock.Advance(PlatformActionCapabilityService.CapabilityTimeToLive + TimeSpan.FromTicks(1));
            var expired = await fixture.InvokeAsync(Fixture.UserA, fixture.Request(expiring.Capability!, "expired"));

            Assert.Equal(404, wrongOperationResult.Result.StatusCode);
            Assert.Equal(404, wrongItem.Result.StatusCode);
            Assert.Equal(404, swapped.Result.StatusCode);
            Assert.Equal(200, first.Result.StatusCode);
            Assert.True(idempotent.Replayed);
            Assert.Equal(409, replay.Result.StatusCode);
            Assert.Equal(404, invalidated.Result.StatusCode);
            Assert.Equal(404, expired.Result.StatusCode);
            Assert.Equal(1, fixture.Port.OwnerCalls);
        }

        [Fact]
        public async Task ConcurrentDuplicateHasOneOwnerAndOneReplayedFollower()
        {
            using var fixture = new Fixture();
            fixture.Port.BlockOwner = true;
            var prepared = fixture.Prepare(Fixture.UserA);
            var request = fixture.Request(prepared.Capability!, "concurrent-key");

            var leader = fixture.InvokeAsync(Fixture.UserA, request);
            await fixture.Port.OwnerEntered.Task;
            var follower = fixture.InvokeAsync(Fixture.UserA, request);
            fixture.Port.ReleaseOwner.TrySetResult();
            var results = await Task.WhenAll(leader, follower);

            Assert.Equal(1, fixture.Port.OwnerCalls);
            Assert.All(results, result => Assert.Equal(200, result.Result.StatusCode));
            Assert.Single(results, result => result.Replayed);
            Assert.Single(results, result => !result.Replayed);
        }

        [Theory]
        [InlineData("user")]
        [InlineData("permission")]
        [InlineData("library")]
        [InlineData("parental")]
        [InlineData("item-delete")]
        [InlineData("item-move")]
        [InlineData("feature")]
        [InlineData("configuration")]
        public async Task CurrentAuthorityChangesBetweenPrepareAndInvokePreventMutation(string revocation)
        {
            using var fixture = new Fixture();
            var prepared = fixture.Prepare(Fixture.UserA);
            fixture.Revoke(revocation);

            var denied = await fixture.InvokeAsync(Fixture.UserA, fixture.Request(prepared.Capability!, "revoked-key"));

            Assert.Equal(404, denied.Result.StatusCode);
            Assert.Equal(0, fixture.Port.OwnerCalls);
        }

        [Fact]
        public async Task QueuedFollowerAndStoredReplayRecheckAuthorityBeforeRelease()
        {
            using var fixture = new Fixture();
            var queuedPrepared = fixture.Prepare(Fixture.UserA);
            var blocker = await fixture.Limiter.AcquireAsync(
                fixture.Actor(Fixture.UserA),
                PlatformOperationDefinition.SpoilerGuardConfigureItem,
                CancellationToken.None);
            var queuedRequest = fixture.Request(queuedPrepared.Capability!, "queued-key");
            var queued = fixture.InvokeAsync(Fixture.UserA, queuedRequest);
            await EventuallyAsync(() => fixture.Limiter.WaiterCount == 1);
            fixture.Host.ItemAccessible = false;
            blocker.Dispose();
            Assert.Equal(404, (await queued).Result.StatusCode);
            fixture.Host.ItemAccessible = true;
            Assert.Equal(200, (await fixture.InvokeAsync(Fixture.UserA, queuedRequest)).Result.StatusCode);

            fixture.Port.ResetBlocking();
            fixture.Port.BlockOwner = true;
            var followerPrepared = fixture.Prepare(Fixture.UserA);
            var followerRequest = fixture.Request(followerPrepared.Capability!, "follower-key");
            var leader = fixture.InvokeAsync(Fixture.UserA, followerRequest);
            await fixture.Port.OwnerEntered.Task;
            var follower = fixture.InvokeAsync(Fixture.UserA, followerRequest);
            fixture.Port.FeatureEnabled = false;
            fixture.Port.ReleaseOwner.TrySetResult();
            Assert.Equal(200, (await leader).Result.StatusCode);
            Assert.Equal(404, (await follower).Result.StatusCode);

            fixture.Port.FeatureEnabled = true;
            var replay = await fixture.InvokeAsync(Fixture.UserA, followerRequest);
            Assert.Equal(200, replay.Result.StatusCode);
            Assert.True(replay.Replayed);

            fixture.Host.UserAExists = false;
            Assert.Equal(404, (await fixture.InvokeAsync(Fixture.UserA, followerRequest)).Result.StatusCode);
            fixture.Host.UserAExists = true;
            Assert.True((await fixture.InvokeAsync(Fixture.UserA, followerRequest)).Replayed);
        }

        [Theory]
        [InlineData("caller", (int)PlatformAuditResultCode.CallerCancelled)]
        [InlineData("deadline", (int)PlatformAuditResultCode.DeadlineExceeded)]
        [InlineData("simultaneous", (int)PlatformAuditResultCode.CallerCancelled)]
        public async Task CancellationAndDeadlineRemainDistinct(
            string kind,
            int expectedAuditValue)
        {
            using var fixture = new Fixture();
            fixture.Port.BlockOwner = true;
            var prepared = fixture.Prepare(Fixture.UserA);
            using var caller = new CancellationTokenSource();
            using var deadline = new CancellationTokenSource();
            var invocation = fixture.InvokeThroughLifecycleAsync(
                fixture.Http(Fixture.UserA, IPAddress.Loopback, elevatedRole: false),
                fixture.Request(prepared.Capability!, "cancel-key"),
                caller.Token,
                deadline.Token);
            await fixture.Port.OwnerEntered.Task;

            if (kind is "caller" or "simultaneous")
            {
                caller.Cancel();
            }

            if (kind is "deadline" or "simultaneous")
            {
                deadline.Cancel();
            }

            fixture.Port.ReleaseOwner.TrySetResult();
            var lifecycle = await invocation;
            if (kind == "deadline")
            {
                var timeout = Assert.IsType<ObjectResult>(lifecycle.Result);
                Assert.Equal(504, timeout.StatusCode);
            }
            else
            {
                Assert.IsType<EmptyResult>(lifecycle.Result);
            }

            Assert.True(lifecycle.ExceptionHandled);
            Assert.IsAssignableFrom<OperationCanceledException>(lifecycle.Exception);
            Assert.Null(lifecycle.Outcome);
            Assert.Equal((PlatformAuditResultCode)expectedAuditValue, fixture.Audit.Snapshot()[^1].ResultCode);
            Assert.DoesNotContain(SecretCanary, fixture.ObservableText(), StringComparison.Ordinal);
        }

        [Fact]
        public async Task PayloadBoundsAndOwnerResultCapFailWithoutDisclosure()
        {
            using var fixture = new Fixture();
            var action = ActionContext(fixture.Http(Fixture.UserA, IPAddress.Loopback, false));
            var context = new ResourceExecutingContext(
                action,
                new List<IFilterMetadata>(),
                new List<Microsoft.AspNetCore.Mvc.ModelBinding.IValueProviderFactory>());
            action.HttpContext.Request.Body = new MemoryStream(new byte[PlatformRequestBounds.MaximumBytes + 1]);
            action.HttpContext.Request.ContentLength = PlatformRequestBounds.MaximumBytes + 1;
            var continued = false;
            await new PlatformBoundedBodyFilter().OnResourceExecutionAsync(context, () =>
            {
                continued = true;
                return Task.FromResult(new ResourceExecutedContext(context, new List<IFilterMetadata>()));
            });
            Assert.False(continued);
            var tooLarge = Assert.IsType<ObjectResult>(context.Result);
            Assert.Equal(413, tooLarge.StatusCode);

            var tooManyAnswers = string.Join(",", Enumerable.Range(0, PlatformActionInvokeRequestConverter.MaximumAnswers + 1)
                .Select(index => $"{{\"FieldId\":\"f{index}\",\"BooleanValue\":true}}"));
            Assert.Throws<JsonException>(() => fixture.Parse($"{{\"Capability\":\"x\",\"IdempotencyKey\":\"key\",\"Answers\":[{tooManyAnswers}]}}"));

            fixture.Port.OversizedResult = true;
            var prepared = fixture.Prepare(Fixture.UserA);
            var capped = await fixture.InvokeAsync(Fixture.UserA, fixture.Request(prepared.Capability!, "owner-cap"));
            Assert.Equal(409, capped.Result.StatusCode);
            Assert.DoesNotContain(SecretCanary, fixture.ObservableText(), StringComparison.Ordinal);
        }

        [Fact]
        public void RequestBodyScannerRejectsDepthStringArrayAndObjectCountIndependently()
        {
            var depth = new string('[', PlatformRequestBounds.MaximumDepth + 1)
                + new string(']', PlatformRequestBounds.MaximumDepth + 1);
            var longString = $"\"{new string('s', PlatformRequestBounds.MaximumStringBytes + 1)}\"";
            var array = "[" + string.Join(",", Enumerable.Repeat("0", PlatformRequestBounds.MaximumArrayElements + 1)) + "]";
            var objectBody = "{" + string.Join(",", Enumerable.Range(0, PlatformRequestBounds.MaximumObjectKeys + 1)
                .Select(index => $"\"k{index}\":0")) + "}";

            Assert.Equal("depth", Breach(depth).Axis);
            Assert.Equal("stringBytes", Breach(longString).Axis);
            Assert.Equal("arrayElements", Breach(array).Axis);
            Assert.Equal("objectKeys", Breach(objectBody).Axis);
        }

        [Theory]
        [InlineData(false, 401)]
        [InlineData(true, 403)]
        public async Task HostOwnedAuthenticationFailuresAreBareAndNeverReadTheBody(bool authenticated, int status)
        {
            using var fixture = new Fixture();
            var http = fixture.Http(Fixture.UserA, IPAddress.Loopback, false);
            http.User = authenticated
                ? new ClaimsPrincipal(new ClaimsIdentity(new[]
                {
                    new Claim("Jellyfin-UserId", Fixture.UserA.ToString()),
                    new Claim("Jellyfin-IsApiKey", bool.TrueString),
                }, "test"))
                : new ClaimsPrincipal(new ClaimsIdentity());
            http.Request.Body = new ThrowOnReadStream();
            var result = await fixture.RunActorBoundaryAsync(http, _ => Task.CompletedTask);
            Assert.NotNull(result);

            await ExecuteResultAsync(result!, http);
            Assert.Equal(status, http.Response.StatusCode);
            Assert.Equal(0, http.Response.Body.Length);
        }

        [Fact]
        public async Task BoundedOwnersHaveDirectClosedZeroDispatchNegativeCases()
        {
            using var fixture = new Fixture();
            Assert.Throws<ArgumentException>(() => new PlatformPreparedActionRequest(
                PlatformOperationDefinition.SpoilerGuardConfigureItem,
                fixture.Host.Item,
                1,
                new byte[PlatformPreparedActionContextOwner.MaximumPrivateStateBytes + 1]));
            Assert.Throws<ArgumentException>(() => PlatformActionPortAdmission.Admit(
                new FixedPort.BooleanInput(true),
                new byte[PlatformPreparedActionContextOwner.MaximumPrivateStateBytes + 1]));
            Assert.False(PlatformIdempotencyKey.TryParse(new string('k', PlatformIdempotencyKey.MaximumLength + 1), out _));

            var capabilityDigest = Enumerable.Repeat((byte)23, 32).ToArray();
            for (var index = 0; index < PlatformActionCapabilityService.MaximumLedgerEntries; index++)
            {
                Assert.Equal(
                    PlatformCapabilityMintOutcomeKind.Issued,
                    fixture.Capabilities.Mint(
                        fixture.Actor(Fixture.UserA),
                        PlatformOperationDefinition.SpoilerGuardConfigureItem.Id.Value,
                        fixture.Host.Item.Id,
                        fixture.Host.Item.Kind,
                        capabilityDigest,
                        attenuateToCurrentDevice: false).Kind);
            }

            Assert.Equal(
                PlatformCapabilityMintOutcomeKind.AtCapacity,
                fixture.Capabilities.Mint(
                    fixture.Actor(Fixture.UserA),
                    PlatformOperationDefinition.SpoilerGuardConfigureItem.Id.Value,
                    fixture.Host.Item.Id,
                    fixture.Host.Item.Kind,
                    capabilityDigest,
                    attenuateToCurrentDevice: false).Kind);
            fixture.Capabilities.InvalidateOutstandingCapabilities();

            for (var index = 0; index < PlatformPreparedActionContextOwner.MaximumEntries; index++)
            {
                Assert.Equal(PlatformPreparedActionIssueKind.Issued, fixture.Prepare(Fixture.UserA).Kind);
            }

            Assert.Equal(
                PlatformPreparedActionIssueKind.AtCapacity,
                fixture.Prepare(Fixture.UserA).Kind);
            Assert.Equal(PlatformPreparedActionContextOwner.MaximumEntries, fixture.Contexts.EntryCount);

            for (var index = 0; index <= PlatformAuditStore.MaximumRecords; index++)
            {
                using var attempt = fixture.Audit.Begin(
                    fixture.Actor(Fixture.UserA),
                    PlatformOperationDefinition.SpoilerGuardConfigureItem);
                attempt.Complete(PlatformAuditResultCode.Succeeded);
            }

            Assert.Equal(PlatformAuditStore.MaximumRecords, fixture.Audit.Snapshot().Count);

            var entryStore = new PlatformIdempotencyStore(fixture.Clock);
            for (var index = 0; index < PlatformIdempotencyStore.MaximumEntries; index++)
            {
                var outcome = await entryStore.ExecuteAsync(
                    IdempotencyRequest(index, maximumResultBytes: 64),
                    _ => Task.FromResult(SuccessResult()),
                    CancellationToken.None);
                Assert.Equal(PlatformIdempotencyOutcomeKind.Executed, outcome.Kind);
            }

            var entryOverflow = await entryStore.ExecuteAsync(
                IdempotencyRequest(PlatformIdempotencyStore.MaximumEntries, maximumResultBytes: 64),
                _ => throw new InvalidOperationException("An entry-cap refusal executed its owner."),
                CancellationToken.None);
            Assert.Equal(PlatformIdempotencyOutcomeKind.AtCapacity, entryOverflow.Kind);

            var followerStore = new PlatformIdempotencyStore(fixture.Clock);
            var followerRelease = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var followerEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var followerRequest = IdempotencyRequest(0, maximumResultBytes: 64);
            var followerLeader = followerStore.ExecuteAsync(
                followerRequest,
                async _ =>
                {
                    followerEntered.TrySetResult();
                    await followerRelease.Task;
                    return SuccessResult();
                },
                CancellationToken.None);
            await followerEntered.Task;
            var followers = Enumerable.Range(0, PlatformIdempotencyStore.MaximumFollowersPerEntry)
                .Select(_ => followerStore.ExecuteAsync(
                    followerRequest,
                    _ => throw new InvalidOperationException("A coalesced follower executed its owner."),
                    CancellationToken.None))
                .ToArray();
            await EventuallyAsync(() =>
                followerStore.FollowerCount == PlatformIdempotencyStore.MaximumFollowersPerEntry);
            var followerOverflow = await followerStore.ExecuteAsync(
                followerRequest,
                _ => throw new InvalidOperationException("A follower-cap refusal executed its owner."),
                CancellationToken.None);
            Assert.Equal(PlatformIdempotencyOutcomeKind.AtCapacity, followerOverflow.Kind);
            followerRelease.TrySetResult();
            await followerLeader;
            Assert.All(await Task.WhenAll(followers), outcome =>
                Assert.Equal(PlatformIdempotencyOutcomeKind.Replay, outcome.Kind));

            var byteStore = new PlatformIdempotencyStore(fixture.Clock);
            var byteRelease = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var byteLeaders = new List<Task<PlatformIdempotencyOutcome>>();
            var reservationCount =
                PlatformIdempotencyStore.MaximumStoredResultBytes / PlatformIdempotencyStore.MaximumResultBytes;
            for (var index = 0; index < reservationCount; index++)
            {
                byteLeaders.Add(byteStore.ExecuteAsync(
                    IdempotencyRequest(index, PlatformIdempotencyStore.MaximumResultBytes),
                    async _ =>
                    {
                        await byteRelease.Task;
                        return SuccessResult();
                    },
                    CancellationToken.None));
            }

            Assert.Equal(reservationCount, byteStore.EntryCount);
            var byteOverflow = await byteStore.ExecuteAsync(
                IdempotencyRequest(reservationCount, PlatformIdempotencyStore.MaximumResultBytes),
                _ => throw new InvalidOperationException("A byte-cap refusal executed its owner."),
                CancellationToken.None);
            Assert.Equal(PlatformIdempotencyOutcomeKind.AtCapacity, byteOverflow.Kind);
            byteRelease.TrySetResult();
            await Task.WhenAll(byteLeaders);

            await AssertAdmissionBoundsAsync();
            Assert.Equal(0, fixture.Port.OwnerCalls);
        }

        private static async Task AssertAdmissionBoundsAsync()
        {
            var keyLimiter = new PlatformActionAdmissionLimiter();
            var keyLeases = new List<PlatformActionAdmission>();
            for (var index = 0; index < PlatformActionAdmissionLimiter.MaximumKeys; index++)
            {
                keyLeases.Add(await keyLimiter.AcquireAsync(
                    BoundedActor(index),
                    PlatformOperationDefinition.SpoilerGuardConfigureItem,
                    CancellationToken.None));
            }

            Assert.All(keyLeases, lease => Assert.Equal(PlatformActionAdmissionKind.Acquired, lease.Kind));
            using (var keyOverflow = await keyLimiter.AcquireAsync(
                BoundedActor(PlatformActionAdmissionLimiter.MaximumKeys),
                PlatformOperationDefinition.SpoilerGuardConfigureItem,
                CancellationToken.None))
            {
                Assert.Equal(PlatformActionAdmissionKind.AtCapacity, keyOverflow.Kind);
            }

            foreach (var lease in keyLeases)
            {
                lease.Dispose();
            }

            Assert.Equal(0, keyLimiter.KeyCount);

            var waiterLimiter = new PlatformActionAdmissionLimiter();
            var actor = BoundedActor(0);
            using var blocker = await waiterLimiter.AcquireAsync(
                actor,
                PlatformOperationDefinition.SpoilerGuardConfigureItem,
                CancellationToken.None);
            var waiters = Enumerable.Range(0, PlatformActionAdmissionLimiter.MaximumWaitersPerKey)
                .Select(_ => waiterLimiter.AcquireAsync(
                    actor,
                    PlatformOperationDefinition.SpoilerGuardConfigureItem,
                    CancellationToken.None))
                .ToArray();
            await EventuallyAsync(() =>
                waiterLimiter.WaiterCount == PlatformActionAdmissionLimiter.MaximumWaitersPerKey);
            using (var waiterOverflow = await waiterLimiter.AcquireAsync(
                actor,
                PlatformOperationDefinition.SpoilerGuardConfigureItem,
                CancellationToken.None))
            {
                Assert.Equal(PlatformActionAdmissionKind.AtCapacity, waiterOverflow.Kind);
            }

            blocker.Dispose();
            foreach (var waiter in waiters)
            {
                (await waiter).Dispose();
            }

            var globalLimiter = new PlatformActionAdmissionLimiter();
            var globalBlockers = new List<PlatformActionAdmission>();
            var globalWaiterGroups = new List<List<Task<PlatformActionAdmission>>>();
            var keysForGlobalLimit =
                PlatformActionAdmissionLimiter.MaximumWaiters
                / PlatformActionAdmissionLimiter.MaximumWaitersPerKey
                + 1;
            for (var key = 0; key < keysForGlobalLimit; key++)
            {
                var keyActor = BoundedActor(key);
                globalBlockers.Add(await globalLimiter.AcquireAsync(
                    keyActor,
                    PlatformOperationDefinition.SpoilerGuardConfigureItem,
                    CancellationToken.None));
                var waiterLimit = key < keysForGlobalLimit - 2
                    ? PlatformActionAdmissionLimiter.MaximumWaitersPerKey
                    : key == keysForGlobalLimit - 2 ? 7 : 1;
                var group = new List<Task<PlatformActionAdmission>>();
                globalWaiterGroups.Add(group);
                for (var waiter = 0; waiter < waiterLimit; waiter++)
                {
                    group.Add(globalLimiter.AcquireAsync(
                        keyActor,
                        PlatformOperationDefinition.SpoilerGuardConfigureItem,
                        CancellationToken.None));
                }
            }

            await EventuallyAsync(() =>
                globalLimiter.WaiterCount == PlatformActionAdmissionLimiter.MaximumWaiters);
            using (var globalOverflow = await globalLimiter.AcquireAsync(
                BoundedActor(keysForGlobalLimit - 2),
                PlatformOperationDefinition.SpoilerGuardConfigureItem,
                CancellationToken.None))
            {
                Assert.Equal(PlatformActionAdmissionKind.AtCapacity, globalOverflow.Kind);
            }

            for (var key = 0; key < globalBlockers.Count; key++)
            {
                globalBlockers[key].Dispose();
                foreach (var waiter in globalWaiterGroups[key])
                {
                    (await waiter).Dispose();
                }
            }

            Assert.Equal(0, globalLimiter.KeyCount);
            Assert.Equal(0, globalLimiter.WaiterCount);
        }

        private static PlatformActor BoundedActor(int index)
        {
            Span<byte> bytes = stackalloc byte[16];
            BitConverter.TryWriteBytes(bytes, index + 1);
            return PlatformActorTestFactory.Create(new Guid(bytes), false, new string('b', 32), null, null);
        }

        private static PlatformIdempotencyRequest IdempotencyRequest(
            int index,
            int maximumResultBytes)
        {
            Assert.True(PlatformIdempotencyKey.TryParse($"matrix-{index}", out var key));
            var fingerprint = new byte[32];
            BitConverter.GetBytes(index).CopyTo(fingerprint, 0);
            return new PlatformIdempotencyRequest(
                Fixture.UserA,
                "matrix-operation",
                key,
                new PlatformSemanticFingerprint(fingerprint),
                maximumResultBytes);
        }

        private static PlatformIdempotencyResult SuccessResult()
        {
            using var document = JsonDocument.Parse("{}");
            return new PlatformIdempotencyResult(200, "succeeded", document.RootElement);
        }

        private static PlatformBoundBreach Breach(string json) =>
            Assert.IsType<PlatformBoundBreach>(
                PlatformRequestBounds.FirstBreach(Encoding.UTF8.GetBytes(json)));

        private static void ForgeEveryRequestIdentitySource(DefaultHttpContext http, Guid forged)
        {
            http.Request.Headers["Jellyfin-UserId"] = forged.ToString();
            http.Request.Headers["X-Jellyfin-User-Id"] = forged.ToString();
            http.Request.Headers["X-Emby-Authorization"] = $"MediaBrowser UserId=\"{forged}\", Client=\"{SecretCanary}\", DeviceId=\"{SecretCanary}\"";
            http.Request.Headers.Cookie = $"userId={forged}; role=admin; marker={SecretCanary}";
            http.Request.QueryString = new QueryString($"?userId={forged}&admin=true&marker={SecretCanary}");
            http.Request.RouteValues["userId"] = forged.ToString();
            http.Request.RouteValues["client"] = SecretCanary;
            http.Request.Body = new MemoryStream(Encoding.UTF8.GetBytes(
                $"{{\"UserId\":\"{forged}\",\"IsAdministrator\":true,\"DeviceId\":\"{SecretCanary}\",\"Marker\":\"{SecretCanary}\"}}"));
        }

        private static ActionContext ActionContext(HttpContext http) =>
            new(http, new RouteData(), new ActionDescriptor());

        private static async Task ExecuteResultAsync(IActionResult result, HttpContext http)
        {
            var services = new ServiceCollection();
            services.AddLogging();
            services.AddMvcCore();
            services.AddSingleton<IAuthenticationService>(new EmptyAuthenticationService());
            using var provider = services.BuildServiceProvider();
            http.RequestServices = provider;
            http.Response.Body = new MemoryStream();
            await result.ExecuteResultAsync(ActionContext(http));
        }

        private static async Task EventuallyAsync(Func<bool> predicate)
        {
            for (var index = 0; index < 10000 && !predicate(); index++)
            {
                await Task.Yield();
            }

            Assert.True(predicate(), "The bounded asynchronous condition was not reached.");
        }

        private sealed record LifecycleRun(
            IActionResult? Result,
            Exception? Exception,
            bool ExceptionHandled,
            PlatformActionInvocationOutcome? Outcome);

        private sealed class PilotController : PlatformControllerBase
        {
            private readonly PlatformActionInvocationCoordinator _coordinator;

            internal PilotController(PlatformActionInvocationCoordinator coordinator) => _coordinator = coordinator;

            internal Task<PlatformActionInvocationOutcome> InvokeAsync(PlatformActionInvokeRequest request)
            {
                if (!PlatformActionIdempotencyCarrier.TryResolve(
                    request,
                    Request.Headers[PlatformIdempotencyKey.HeaderName],
                    out _))
                {
                    throw new InvalidOperationException("The test harness supplied an ambiguous idempotency carrier.");
                }

                var cancellation = PlatformRequestLifecycleState.TryGet(HttpContext, out var lifecycle)
                    ? new PlatformInvocationCancellation(HttpContext.RequestAborted, lifecycle.CallerToken, lifecycle.DeadlineToken)
                    : new PlatformInvocationCancellation(HttpContext.RequestAborted, HttpContext.RequestAborted, CancellationToken.None);
                return _coordinator.InvokeAsync(Actor, request, cancellation);
            }
        }

        private sealed class Fixture : IDisposable
        {
            internal static readonly Guid UserA = Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
            internal static readonly Guid UserB = Guid.Parse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");

            internal Fixture(ManualTimeProvider? clock = null)
            {
                Clock = clock ?? new ManualTimeProvider(DateTimeOffset.UtcNow);
                Capabilities = new PlatformActionCapabilityService(
                    Clock,
                    Enumerable.Repeat((byte)17, 32).ToArray(),
                    new SequentialNonceSource().GetBytes);
                Contexts = new PlatformPreparedActionContextOwner(
                    Capabilities,
                    Clock,
                    Enumerable.Repeat((byte)18, 32).ToArray());
                Host = new FakeHost();
                Port = new FixedPort();
                Limiter = new PlatformActionAdmissionLimiter();
                Idempotency = new PlatformIdempotencyStore(Clock);
                Audit = new PlatformAuditStore(
                    Logger,
                    Clock,
                    Enumerable.Repeat((byte)19, 32).ToArray());
                Coordinator = new PlatformActionInvocationCoordinator(
                    Host,
                    Contexts,
                    Capabilities,
                    Idempotency,
                    Limiter,
                    new PlatformFirstPartyActionDispatcher(Port, new RejectingPort(), new RejectingPort()),
                    Audit);
            }

            internal ManualTimeProvider Clock { get; }
            internal PlatformActionCapabilityService Capabilities { get; }
            internal PlatformPreparedActionContextOwner Contexts { get; }
            internal FakeHost Host { get; }
            internal FixedPort Port { get; }
            internal PlatformActionAdmissionLimiter Limiter { get; }
            internal PlatformIdempotencyStore Idempotency { get; }
            internal PlatformAuditStore Audit { get; }
            internal PlatformActionInvocationCoordinator Coordinator { get; }
            internal RecordingLogger<PlatformAuditStore> Logger { get; } = new();

            internal PlatformActor Actor(Guid userId)
            {
                return PlatformActorTestFactory.Create(
                    userId,
                    userId == UserA,
                    new string('c', 32),
                    "android-tv",
                    "living-room");
            }

            internal PlatformPreparedActionIssue Prepare(
                Guid userId,
                PlatformOperationDefinition? definition = null)
                => Contexts.Issue(
                    Actor(userId),
                    new PlatformPreparedActionRequest(
                        definition ?? PlatformOperationDefinition.SpoilerGuardConfigureItem,
                        Host.Item,
                        Port.ConfigurationRevision,
                        new byte[] { 1 }),
                    attenuateToCurrentDevice: false);

            internal PlatformActionInvokeRequest Request(string capability, string key)
            {
                Assert.True(PlatformIdempotencyKey.TryParse(key, out var parsed));
                return new PlatformActionInvokeRequest(
                    capability,
                    parsed,
                    ImmutableArray.Create(new PlatformActionAnswer("enabled", true, null)));
            }

            internal PlatformActionInvokeRequest Parse(string json) =>
                JsonSerializer.Deserialize<PlatformActionInvokeRequest>(json, PlatformJson.SerializerOptions)!;

            internal Task<PlatformActionInvocationOutcome> InvokeAsync(Guid userId, PlatformActionInvokeRequest request) =>
                Coordinator.InvokeAsync(
                    Actor(userId),
                    request,
                    new PlatformInvocationCancellation(CancellationToken.None, CancellationToken.None, CancellationToken.None));

            internal DefaultHttpContext Http(Guid userId, IPAddress address, bool elevatedRole)
            {
                var claims = new List<Claim>
                {
                    new("Jellyfin-UserId", userId.ToString()),
                    new("Jellyfin-IsApiKey", bool.FalseString),
                    new("Jellyfin-Client", "android-tv"),
                    new("Jellyfin-DeviceId", "living-room"),
                };
                if (elevatedRole)
                {
                    claims.Add(new Claim(ClaimTypes.Role, "Administrator"));
                }

                var http = new DefaultHttpContext
                {
                    User = new ClaimsPrincipal(new ClaimsIdentity(claims, "test")),
                };
                http.Connection.RemoteIpAddress = address;
                return http;
            }

            internal async Task<PlatformActionInvocationOutcome?> InvokeThroughActorAsync(
                DefaultHttpContext http,
                PlatformActionInvokeRequest request)
            {
                PlatformActionInvocationOutcome? outcome = null;
                var result = await RunActorBoundaryAsync(http, async context =>
                {
                    var controller = new PilotController(Coordinator)
                    {
                        ControllerContext = new ControllerContext { HttpContext = context },
                    };
                    outcome = await controller.InvokeAsync(request);
                });
                Assert.Null(result);
                return outcome;
            }

            internal async Task<LifecycleRun> InvokeThroughLifecycleAsync(
                DefaultHttpContext http,
                PlatformActionInvokeRequest request,
                CancellationToken callerToken,
                CancellationToken deadlineToken)
            {
                using var linked = CancellationTokenSource.CreateLinkedTokenSource(callerToken, deadlineToken);
                http.RequestAborted = linked.Token;
                http.Items[PlatformRequestLifecycleState.ItemKey] =
                    new PlatformRequestLifecycleState(callerToken, deadlineToken);
                PlatformActionInvocationOutcome? outcome = null;
                ActionExecutedContext? terminal = null;
                var boundaryResult = await RunActorBoundaryAsync(http, async context =>
                {
                    var controller = new PilotController(Coordinator)
                    {
                        ControllerContext = new ControllerContext { HttpContext = context },
                    };
                    var action = ActionContext(context);
                    var filters = new List<IFilterMetadata>();
                    var executing = new ActionExecutingContext(
                        action,
                        filters,
                        new Dictionary<string, object?>(),
                        controller);
                    await new PlatformRequestLifecycleFilter().OnActionExecutionAsync(
                        executing,
                        async () =>
                        {
                            terminal = new ActionExecutedContext(action, filters, controller);
                            try
                            {
                                outcome = await controller.InvokeAsync(request);
                                terminal.Result = new ObjectResult(outcome);
                            }
                            catch (Exception exception)
                            {
                                terminal.Exception = exception;
                            }

                            return terminal;
                        });
                });

                Assert.Null(boundaryResult);
                Assert.NotNull(terminal);
                return new LifecycleRun(
                    terminal!.Result,
                    terminal.Exception,
                    terminal.ExceptionHandled,
                    outcome);
            }

            internal async Task<IActionResult?> RunActorBoundaryAsync(
                DefaultHttpContext http,
                Func<HttpContext, Task> continuation)
            {
                var resource = new ResourceExecutingContext(
                    ActionContext(http),
                    new List<IFilterMetadata>(),
                    new List<Microsoft.AspNetCore.Mvc.ModelBinding.IValueProviderFactory>());
                await new PlatformActorBoundaryFilter(Host).OnResourceExecutionAsync(resource, async () =>
                {
                    await continuation(http);
                    return new ResourceExecutedContext(resource, new List<IFilterMetadata>());
                });
                return resource.Result;
            }

            internal string ObservableText(params PlatformActionInvocationOutcome?[] outcomes)
            {
                var audit = string.Join("|", Audit.Snapshot().Select(record =>
                    $"{record.Operation}:{record.Family}:{record.ActorUserId}:{record.ActorWasElevated}:"
                    + $"{record.ResultCode}:{record.Decision}:{record.ClientAttributionDigest}:"
                    + $"{record.DeviceAttributionDigest}:{record.CorrelationId}"));
                var responses = string.Join("|", outcomes
                    .Where(outcome => outcome is not null)
                    .Select(outcome =>
                        $"{outcome!.Result.StatusCode}:{outcome.Result.OutcomeCode}:"
                        + $"{outcome.Result.Value.GetRawText()}:{outcome.Replayed}"));
                return string.Join(
                    "|",
                    audit,
                    responses,
                    string.Join("|", Logger.Messages),
                    string.Join("|", Port.OwnerActors),
                    string.Join("|", Port.OwnerElevation),
                    string.Join("|", Port.OwnerClientNames),
                    string.Join("|", Port.OwnerDeviceIds));
            }

            internal void Revoke(string kind)
            {
                switch (kind)
                {
                    case "user":
                        Host.UserAExists = false;
                        break;
                    case "permission":
                        Port.PermissionGranted = false;
                        break;
                    case "library":
                    case "parental":
                    case "item-delete":
                        Host.ItemAccessible = false;
                        break;
                    case "item-move":
                        Host.ReturnedItem = Host.OtherItem;
                        break;
                    case "feature":
                        Port.FeatureEnabled = false;
                        break;
                    case "configuration":
                        Port.ConfigurationRevision++;
                        break;
                    default:
                        throw new ArgumentOutOfRangeException(nameof(kind));
                }
            }

            public void Dispose()
            {
                Contexts.Dispose();
                Capabilities.Dispose();
            }
        }

        private sealed class FixedPort :
            ISpoilerGuardPlatformActionPort,
            IHiddenContentPlatformActionPort,
            ISeerrPlatformActionPort
        {
            internal bool FeatureEnabled { get; set; } = true;
            internal bool PermissionGranted { get; set; } = true;
            internal long ConfigurationRevision { get; set; } = 1;
            internal bool BlockOwner { get; set; }
            internal bool OversizedResult { get; set; }
            internal int OwnerCalls { get; private set; }
            internal List<Guid> OwnerActors { get; } = new();
            internal List<bool> OwnerElevation { get; } = new();
            internal List<string?> OwnerClientNames { get; } = new();
            internal List<string?> OwnerDeviceIds { get; } = new();
            internal TaskCompletionSource OwnerEntered { get; private set; } = NewSignal();
            internal TaskCompletionSource ReleaseOwner { get; private set; } = NewSignal();

            public PlatformActionPortAdmission ValidateCurrent(
                PlatformActor actor,
                HostAccessibleItem item,
                PlatformPreparedActionContext prepared,
                ImmutableArray<PlatformActionAnswer> answers)
            {
                if (!FeatureEnabled || !PermissionGranted || prepared.ConfigurationRevision != ConfigurationRevision)
                {
                    return PlatformActionPortAdmission.Refuse(PlatformActionPortDecision.AuthorityDenied);
                }

                if (answers.Length != 1 || answers[0].FieldId != "enabled" || answers[0].BooleanValue is not bool enabled || answers[0].OptionIds is not null)
                {
                    return PlatformActionPortAdmission.Refuse(PlatformActionPortDecision.InvalidInput);
                }

                return PlatformActionPortAdmission.Admit(new BooleanInput(enabled), new[] { enabled ? (byte)1 : (byte)0 });
            }

            public Task<PlatformActionPortAdmission> ValidateCurrentAsync(
                PlatformActor actor,
                HostAccessibleItem item,
                PlatformPreparedActionContext prepared,
                ImmutableArray<PlatformActionAnswer> answers,
                CancellationToken cancellationToken)
            {
                cancellationToken.ThrowIfCancellationRequested();
                return Task.FromResult(ValidateCurrent(actor, item, prepared, answers));
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
                OwnerActors.Add(actor.UserId);
                OwnerElevation.Add(actor.IsElevated);
                OwnerClientNames.Add(actor.ClientName);
                OwnerDeviceIds.Add(actor.DeviceId);
                OwnerEntered.TrySetResult();
                if (BlockOwner)
                {
                    await ReleaseOwner.Task.WaitAsync(cancellationToken);
                }

                if (OversizedResult)
                {
                    using var oversized = JsonDocument.Parse($"{{\"value\":\"{new string('x', PlatformActionInvocationCoordinator.MaximumSemanticResultBytes + 1)}\"}}");
                    return PlatformActionOwnerResult.Succeeded(oversized.RootElement);
                }

                using var document = JsonDocument.Parse("{\"outcome\":\"succeeded\"}");
                return PlatformActionOwnerResult.Succeeded(document.RootElement);
            }

            internal void ResetBlocking()
            {
                BlockOwner = false;
                OwnerEntered = NewSignal();
                ReleaseOwner = NewSignal();
            }

            internal sealed record BooleanInput(bool Enabled) : IPlatformValidatedActionInput;

            private static TaskCompletionSource NewSignal() => new(TaskCreationOptions.RunContinuationsAsynchronously);
        }

        private sealed class RejectingPort : IHiddenContentPlatformActionPort, ISeerrPlatformActionPort
        {
            public PlatformActionPortAdmission ValidateCurrent(
                PlatformActor actor,
                HostAccessibleItem item,
                PlatformPreparedActionContext prepared,
                ImmutableArray<PlatformActionAnswer> answers) =>
                PlatformActionPortAdmission.Refuse(PlatformActionPortDecision.InvalidInput);

            public Task<PlatformActionPortAdmission> ValidateCurrentAsync(
                PlatformActor actor,
                HostAccessibleItem item,
                PlatformPreparedActionContext prepared,
                ImmutableArray<PlatformActionAnswer> answers,
                CancellationToken cancellationToken)
            {
                cancellationToken.ThrowIfCancellationRequested();
                return Task.FromResult(ValidateCurrent(actor, item, prepared, answers));
            }

            public Task<PlatformActionOwnerResult> InvokeAsync(
                PlatformActor actor,
                HostAccessibleItem item,
                IPlatformValidatedActionInput input,
                PlatformIdempotencyKey idempotencyKey,
                CancellationToken cancellationToken) =>
                throw new InvalidOperationException("A wrong-operation capability reached an owner.");
        }

        private sealed class FakeHost : IPlatformHost, IHostUsers, IHostLibrary, IHostSessions, IHostPlugins
        {
            private static readonly Guid ItemId = Guid.Parse("11111111-1111-1111-1111-111111111111");
            internal FakeHost()
            {
                Item = new HostAccessibleItem(ItemId, HostItemKind.Movie, null, ImmutableArray<HostProviderReference>.Empty);
                OtherItem = new HostAccessibleItem(ItemId, HostItemKind.Episode, Guid.NewGuid(), ImmutableArray<HostProviderReference>.Empty);
            }

            public IHostUsers Users => this;
            public IHostLibrary Library => this;
            public IHostSessions Sessions => this;
            public IHostPlugins Plugins => this;
            internal bool UserAExists { get; set; } = true;
            internal bool ItemAccessible { get; set; } = true;
            internal HostAccessibleItem Item { get; }
            internal HostAccessibleItem OtherItem { get; }
            internal HostAccessibleItem? ReturnedItem { get; set; }

            internal HostUser? Find(Guid id) => ((IHostUsers)this).Find(id);
            HostUser? IHostUsers.Find(Guid id) => id switch
            {
                var value when value == Fixture.UserA && UserAExists => new HostUser(id, "a", true),
                var value when value == Fixture.UserB => new HostUser(id, "b", false),
                _ => null,
            };
            public IReadOnlyList<HostUser> All() => Array.Empty<HostUser>();
            HostItem? IHostLibrary.Find(Guid id) => null;
            public HostItemAccessResult FindAccessible(Guid userId, Guid itemId) =>
                ItemAccessible && itemId == Item.Id && Find(userId) is not null
                    ? HostItemAccessResult.Accessible(ReturnedItem ?? Item)
                    : HostItemAccessResult.NotAccessible;
            public IReadOnlyList<HostItem> ChildrenOf(Guid id) => Array.Empty<HostItem>();
            public IReadOnlyList<HostSession> Active() => Array.Empty<HostSession>();
            public IReadOnlyList<HostSession> ForUser(Guid userId) => Array.Empty<HostSession>();
            public IReadOnlyList<HostPlugin> Installed() => Array.Empty<HostPlugin>();
            HostPlugin? IHostPlugins.Find(Guid id) => null;
            IReadOnlyList<PlatformInstalledPluginSnapshot> IHostPlugins.InstalledSnapshots() =>
                Array.Empty<PlatformInstalledPluginSnapshot>();
            PlatformInstalledPluginSnapshot? IHostPlugins.FindSnapshot(Guid id) => null;
        }

        private sealed class EmptyAuthenticationService : IAuthenticationService
        {
            public Task<AuthenticateResult> AuthenticateAsync(HttpContext context, string? scheme) => Task.FromResult(AuthenticateResult.NoResult());
            public Task ChallengeAsync(HttpContext context, string? scheme, AuthenticationProperties? properties)
            {
                context.Response.StatusCode = StatusCodes.Status401Unauthorized;
                return Task.CompletedTask;
            }
            public Task ForbidAsync(HttpContext context, string? scheme, AuthenticationProperties? properties)
            {
                context.Response.StatusCode = StatusCodes.Status403Forbidden;
                return Task.CompletedTask;
            }
            public Task SignInAsync(HttpContext context, string? scheme, ClaimsPrincipal principal, AuthenticationProperties? properties) => throw new NotSupportedException();
            public Task SignOutAsync(HttpContext context, string? scheme, AuthenticationProperties? properties) => throw new NotSupportedException();
        }

        private sealed class RecordingLogger<T> : ILogger<T>
        {
            private readonly object _gate = new();
            private readonly List<string> _messages = new();

            internal IReadOnlyList<string> Messages
            {
                get
                {
                    lock (_gate)
                    {
                        return _messages.ToArray();
                    }
                }
            }

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
                var rendered = formatter(state, exception);
                if (exception is not null)
                {
                    rendered += $"|{exception.GetType().Name}:{exception.Message}";
                }

                lock (_gate)
                {
                    _messages.Add(rendered);
                }
            }

            private sealed class NullScope : IDisposable
            {
                internal static NullScope Instance { get; } = new();
                public void Dispose()
                {
                }
            }
        }

        private sealed class ThrowOnReadStream : Stream
        {
            public override bool CanRead => true;
            public override bool CanSeek => false;
            public override bool CanWrite => false;
            public override long Length => throw new NotSupportedException();
            public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
            public override int Read(byte[] buffer, int offset, int count) => throw new InvalidOperationException("Authentication failure read the body.");
            public override void Flush() { }
            public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
            public override void SetLength(long value) => throw new NotSupportedException();
            public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        }

        private sealed class SequentialNonceSource
        {
            private int _value;
            internal byte[] GetBytes(int length)
            {
                var bytes = new byte[length];
                BitConverter.GetBytes(++_value).CopyTo(bytes, 0);
                return bytes;
            }
        }

        private sealed class ManualTimeProvider(DateTimeOffset now) : TimeProvider
        {
            private DateTimeOffset _now = now;
            public override DateTimeOffset GetUtcNow() => _now;
            internal void Advance(TimeSpan amount) => _now += amount;
        }
    }
}
