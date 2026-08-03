using System;
using System.Collections.Immutable;
using System.Linq;
using System.Runtime.InteropServices;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    public class PlatformPreparedActionContextOwnerTests
    {
        private static readonly DateTimeOffset Epoch = new(2026, 8, 3, 0, 0, 0, TimeSpan.Zero);

        [Fact]
        public void IssuedCapabilityResolvesOnlyItsExactAuthenticatedServerOwnedContext()
        {
            var clock = new ManualTimeProvider(Epoch);
            using var capabilities = Capabilities(clock);
            using var owner = Owner(capabilities, clock);
            var state = new byte[] { 1, 2, 3 };
            var issued = owner.Issue(Actor(), Request(state), attenuateToCurrentDevice: false);
            state.AsSpan().Fill(9);

            Assert.Equal(PlatformPreparedActionIssueKind.Issued, issued.Kind);
            Assert.Equal(Epoch + PlatformActionCapabilityService.CapabilityTimeToLive, issued.ExpiresAt);
            var inspection = capabilities.Inspect(issued.Capability);
            using var context = owner.Resolve(issued.Capability, inspection);

            Assert.NotNull(context);
            Assert.Same(PlatformOperationDefinition.HiddenContentConfigureItem, context!.Definition);
            Assert.Equal(ItemId, context.Item.Id);
            Assert.Equal(HostItemKind.Episode, context.Item.Kind);
            Assert.Equal(7, context.ConfigurationRevision);
            Assert.Equal(new byte[] { 1, 2, 3 }, context.PrivateState.ToArray());
            Assert.Equal(32, context.Digest.Length);
            var releasedState = context.PrivateState;
            var releasedDigest = context.Digest;
            var expectedDigest = releasedDigest.ToArray();
            Assert.True(MemoryMarshal.TryGetArray(releasedState, out var stateArray));
            Assert.True(MemoryMarshal.TryGetArray(releasedDigest, out var digestArray));
            stateArray.AsSpan().Fill(8);
            digestArray.AsSpan().Fill(8);
            Assert.Equal(new byte[] { 1, 2, 3 }, context.PrivateState.ToArray());
            Assert.Equal(expectedDigest, context.Digest.ToArray());
            Assert.Equal(1, owner.EntryCount);
        }

        [Fact]
        public void TokenInspectionSwapForgeryRestartExpiryAndInvalidationFailClosed()
        {
            var clock = new ManualTimeProvider(Epoch);
            using var capabilities = Capabilities(clock);
            using var owner = Owner(capabilities, clock);
            var first = owner.Issue(Actor(), Request(new byte[] { 1 }), false);
            var second = owner.Issue(Actor(), Request(new byte[] { 2 }), false);
            var firstInspection = capabilities.Inspect(first.Capability);
            var secondInspection = capabilities.Inspect(second.Capability);

            Assert.Null(owner.Resolve(first.Capability, secondInspection));
            Assert.Null(owner.Resolve(second.Capability, firstInspection));
            Assert.Null(owner.Resolve(first.Capability + "x", firstInspection));
            Assert.Null(owner.Resolve("forged", capabilities.Inspect("forged")));

            using var restartedCapabilities = Capabilities(clock, keyByte: 8);
            using var restarted = Owner(restartedCapabilities, clock, lookupByte: 9);
            Assert.Null(restarted.Resolve(first.Capability, restartedCapabilities.Inspect(first.Capability)));

            owner.InvalidateOutstanding();
            Assert.Equal(0, owner.EntryCount);
            Assert.Null(owner.Resolve(first.Capability, capabilities.Inspect(first.Capability)));

            var afterInvalidation = owner.Issue(Actor(), Request(new byte[] { 3 }), false);
            clock.Advance(PlatformActionCapabilityService.CapabilityTimeToLive);
            Assert.Equal(PlatformCapabilityInspectionKind.Expired, capabilities.Inspect(afterInvalidation.Capability).Kind);
            Assert.Equal(0, owner.EntryCount);
        }

        [Fact]
        public void CapacityNeverEvictsALivePreparedContext()
        {
            var clock = new ManualTimeProvider(Epoch);
            var nonces = new SequentialNonceSource();
            using var capabilities = new PlatformActionCapabilityService(
                clock,
                Enumerable.Repeat((byte)4, 32).ToArray(),
                nonces.GetBytes);
            using var owner = Owner(capabilities, clock);
            PlatformPreparedActionIssue? first = null;

            for (var index = 0; index < PlatformPreparedActionContextOwner.MaximumEntries; index++)
            {
                var issued = owner.Issue(Actor(), Request(BitConverter.GetBytes(index)), false);
                Assert.Equal(PlatformPreparedActionIssueKind.Issued, issued.Kind);
                first ??= issued;
            }

            var refused = owner.Issue(Actor(), Request(new byte[] { 99 }), false);
            Assert.Equal(PlatformPreparedActionIssueKind.AtCapacity, refused.Kind);
            Assert.Equal(PlatformPreparedActionContextOwner.MaximumEntries, owner.EntryCount);
            Assert.NotNull(owner.Resolve(first!.Capability, capabilities.Inspect(first.Capability)));
        }

        [Fact]
        public void RequestRejectsUnknownDefinitionsKindsRevisionsAndOversizedPrivateState()
        {
            var unsupported = new HostAccessibleItem(
                ItemId,
                HostItemKind.Other,
                seriesId: null,
                ImmutableArray<HostProviderReference>.Empty);
            Assert.Throws<ArgumentException>(() => new PlatformPreparedActionRequest(
                PlatformOperationDefinition.HiddenContentConfigureItem,
                unsupported,
                0,
                ReadOnlySpan<byte>.Empty));
            Assert.Throws<ArgumentOutOfRangeException>(() => new PlatformPreparedActionRequest(
                PlatformOperationDefinition.HiddenContentConfigureItem,
                Item(),
                -1,
                ReadOnlySpan<byte>.Empty));
            Assert.Throws<ArgumentException>(() => new PlatformPreparedActionRequest(
                PlatformOperationDefinition.HiddenContentConfigureItem,
                Item(),
                0,
                new byte[PlatformPreparedActionContextOwner.MaximumPrivateStateBytes + 1]));
        }

        private static readonly Guid ItemId = Guid.Parse("11111111-2222-3333-4444-555555555555");

        private static PlatformPreparedActionRequest Request(byte[] state)
            => new(PlatformOperationDefinition.HiddenContentConfigureItem, Item(), 7, state);

        private static HostAccessibleItem Item()
            => new(
                ItemId,
                HostItemKind.Episode,
                Guid.Parse("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
                ImmutableArray<HostProviderReference>.Empty);

        private static PlatformActor Actor()
            => PlatformActorTestFactory.Create(
                Guid.Parse("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
                false,
                new string('a', 32),
                "android-tv",
                "device-a");

        private static PlatformActionCapabilityService Capabilities(ManualTimeProvider clock, byte keyByte = 3)
            => new(clock, Enumerable.Repeat(keyByte, 32).ToArray(), new SequentialNonceSource().GetBytes);

        private static PlatformPreparedActionContextOwner Owner(
            PlatformActionCapabilityService capabilities,
            ManualTimeProvider clock,
            byte lookupByte = 5)
            => new(capabilities, clock, Enumerable.Repeat(lookupByte, 32).ToArray());

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

        private sealed class ManualTimeProvider(DateTimeOffset now) : TimeProvider
        {
            private DateTimeOffset _now = now;

            public override DateTimeOffset GetUtcNow() => _now;

            internal void Advance(TimeSpan amount) => _now += amount;
        }
    }
}
