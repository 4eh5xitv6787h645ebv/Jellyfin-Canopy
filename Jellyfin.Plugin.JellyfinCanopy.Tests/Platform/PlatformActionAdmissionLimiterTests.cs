using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    public class PlatformActionAdmissionLimiterTests
    {
        [Fact]
        public async Task SameActorAndOperationAreSerializedInFifoOrderAndIdleKeyIsRemoved()
        {
            var limiter = new PlatformActionAdmissionLimiter();
            var actor = Actor(1);
            var first = await limiter.AcquireAsync(
                actor,
                PlatformOperationDefinition.SpoilerGuardConfigureItem,
                CancellationToken.None);
            var second = limiter.AcquireAsync(actor, PlatformOperationDefinition.SpoilerGuardConfigureItem, CancellationToken.None);
            var third = limiter.AcquireAsync(actor, PlatformOperationDefinition.SpoilerGuardConfigureItem, CancellationToken.None);

            Assert.Equal(PlatformActionAdmissionKind.Acquired, first.Kind);
            Assert.False(second.IsCompleted);
            Assert.False(third.IsCompleted);
            Assert.Equal(2, limiter.WaiterCount);

            first.Dispose();
            var secondLease = await second;
            Assert.False(third.IsCompleted);
            secondLease.Dispose();
            var thirdLease = await third;
            thirdLease.Dispose();

            Assert.Equal(0, limiter.WaiterCount);
            Assert.Equal(0, limiter.KeyCount);
        }

        [Fact]
        public async Task CanceledWaiterLeavesNoCapacityAndNeverConsumesTheLease()
        {
            var limiter = new PlatformActionAdmissionLimiter();
            var actor = Actor(2);
            using var active = await limiter.AcquireAsync(
                actor,
                PlatformOperationDefinition.HiddenContentConfigureItem,
                CancellationToken.None);
            using var cancellation = new CancellationTokenSource();
            var canceled = limiter.AcquireAsync(
                actor,
                PlatformOperationDefinition.HiddenContentConfigureItem,
                cancellation.Token);
            var next = limiter.AcquireAsync(
                actor,
                PlatformOperationDefinition.HiddenContentConfigureItem,
                CancellationToken.None);
            cancellation.Cancel();

            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => canceled);
            Assert.Equal(1, limiter.WaiterCount);
            active.Dispose();
            using var promoted = await next;
            Assert.Equal(PlatformActionAdmissionKind.Acquired, promoted.Kind);
        }

        [Fact]
        public async Task PerKeyWaiterBoundRejectsTheExactNextAttempt()
        {
            var limiter = new PlatformActionAdmissionLimiter();
            var actor = Actor(3);
            var active = await limiter.AcquireAsync(actor, PlatformOperationDefinition.SeerrRequestItem, CancellationToken.None);
            using var cancellation = new CancellationTokenSource();
            var waiters = Enumerable.Range(0, PlatformActionAdmissionLimiter.MaximumWaitersPerKey)
                .Select(_ => limiter.AcquireAsync(actor, PlatformOperationDefinition.SeerrRequestItem, cancellation.Token))
                .ToArray();

            var refused = await limiter.AcquireAsync(actor, PlatformOperationDefinition.SeerrRequestItem, CancellationToken.None);
            Assert.Equal(PlatformActionAdmissionKind.AtCapacity, refused.Kind);
            Assert.Equal(PlatformActionAdmissionLimiter.MaximumWaitersPerKey, limiter.WaiterCount);

            cancellation.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Task.WhenAll(waiters));
            active.Dispose();
            Assert.Equal(0, limiter.KeyCount);
        }

        [Fact]
        public async Task KeyBoundNeverEvictsActiveWorkAndDifferentOperationsRemainIndependent()
        {
            var limiter = new PlatformActionAdmissionLimiter();
            var leases = new PlatformActionAdmission[PlatformActionAdmissionLimiter.MaximumKeys];
            for (var index = 0; index < leases.Length; index++)
            {
                leases[index] = await limiter.AcquireAsync(
                    Actor(index + 10),
                    PlatformOperationDefinition.SpoilerGuardConfigureItem,
                    CancellationToken.None);
                Assert.Equal(PlatformActionAdmissionKind.Acquired, leases[index].Kind);
            }

            var refused = await limiter.AcquireAsync(
                Actor(5000),
                PlatformOperationDefinition.SpoilerGuardConfigureItem,
                CancellationToken.None);
            Assert.Equal(PlatformActionAdmissionKind.AtCapacity, refused.Kind);
            Assert.Equal(PlatformActionAdmissionLimiter.MaximumKeys, limiter.KeyCount);

            foreach (var lease in leases)
            {
                lease.Dispose();
            }

            var sameActor = Actor(9000);
            using var spoiler = await limiter.AcquireAsync(
                sameActor,
                PlatformOperationDefinition.SpoilerGuardConfigureItem,
                CancellationToken.None);
            using var hidden = await limiter.AcquireAsync(
                sameActor,
                PlatformOperationDefinition.HiddenContentConfigureItem,
                CancellationToken.None);
            Assert.Equal(PlatformActionAdmissionKind.Acquired, spoiler.Kind);
            Assert.Equal(PlatformActionAdmissionKind.Acquired, hidden.Kind);
        }

        [Fact]
        public async Task PreCanceledAdmissionRetainsNoKey()
        {
            var limiter = new PlatformActionAdmissionLimiter();
            using var cancellation = new CancellationTokenSource();
            cancellation.Cancel();

            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => limiter.AcquireAsync(
                Actor(4),
                PlatformOperationDefinition.SpoilerGuardConfigureItem,
                cancellation.Token));
            Assert.Equal(0, limiter.KeyCount);
        }

        private static PlatformActor Actor(int suffix)
        {
            Span<byte> bytes = stackalloc byte[16];
            BitConverter.TryWriteBytes(bytes, suffix);
            return new PlatformActor(new Guid(bytes), false, new string('a', 32), null, null);
        }
    }
}
