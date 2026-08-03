using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    public sealed class PlatformPrepareHandleOwnerTests
    {
        private static readonly DateTimeOffset Epoch = new(2026, 8, 3, 0, 0, 0, TimeSpan.Zero);
        private static readonly Guid UserId = Guid.Parse("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        private static readonly Guid ItemId = Guid.Parse("11111111-2222-3333-4444-555555555555");

        [Fact]
        public void IssueOrReuse_NormalizesSetsAndProviderReferences_AndKeepsAbaHandleStable()
        {
            var clock = new ManualTimeProvider(Epoch);
            using var owner = Owner(clock);
            var first = owner.IssueOrReuse(Snapshot(
                contributionKinds: ["STATUS", "action", "status"],
                fieldKinds: ["boolean", "confirmation"],
                locale: "EN-au",
                stateRevisions:
                [
                    new PlatformPrepareStateRevision("z-owner", 2),
                    new PlatformPrepareStateRevision("a-owner", 1),
                ],
                providerReferences:
                [
                    new HostProviderReference("Tvdb", "22"),
                    new HostProviderReference("TMDB", "11"),
                    new HostProviderReference("tmdb", "11"),
                ]));
            var middle = owner.IssueOrReuse(Snapshot(privateState: [9]));
            var again = owner.IssueOrReuse(Snapshot(
                actor: Actor(correlationId: "different-request"),
                contributionKinds: ["action", "status"],
                fieldKinds: ["CONFIRMATION", "boolean", "boolean"],
                locale: "en-AU",
                stateRevisions:
                [
                    new PlatformPrepareStateRevision("a-owner", 1),
                    new PlatformPrepareStateRevision("z-owner", 2),
                    new PlatformPrepareStateRevision("A-OWNER", 1),
                ],
                providerReferences:
                [
                    new HostProviderReference("tmdb", "11"),
                    new HostProviderReference("tvdb", "22"),
                ]));

            Assert.Equal(PlatformPrepareHandleIssueKind.Issued, first.Kind);
            Assert.Equal(PlatformPrepareHandleIssueKind.Issued, middle.Kind);
            Assert.Equal(PlatformPrepareHandleIssueKind.Reused, again.Kind);
            Assert.Equal(first.Handle, again.Handle);
            Assert.Equal(first.ExpiresAt, again.ExpiresAt);
            Assert.NotEqual(first.Handle, middle.Handle);
            Assert.Equal(2, owner.EntryCount);

            var resolved = owner.Resolve(first.Handle, Actor());
            Assert.NotNull(resolved);
            Assert.Equal(new[] { "action", "status" }, resolved!.Client.ContributionKinds.ToArray());
            Assert.Equal(new[] { "boolean", "confirmation" }, resolved.Client.FieldKinds.ToArray());
            Assert.Equal("en-au", resolved.Client.Locale);
            Assert.Equal(
                [
                    new HostProviderReference("tmdb", "11"),
                    new HostProviderReference("tvdb", "22"),
                ],
                resolved.Item.ProviderReferences.ToArray());
        }

        [Fact]
        public void EverySemanticSnapshotDimensionChangesTheHandle()
        {
            var clock = new ManualTimeProvider(Epoch);
            using var owner = Owner(clock);
            var snapshots = new[]
            {
                Snapshot(),
                Snapshot(actor: Actor(userId: Guid.Parse("10000000-0000-0000-0000-000000000001"))),
                Snapshot(actor: Actor(elevated: true)),
                Snapshot(actor: Actor(clientName: "different-client")),
                Snapshot(actor: Actor(deviceId: "different-device")),
                Snapshot(attenuateToCurrentDevice: true),
                Snapshot(itemId: Guid.Parse("20000000-0000-0000-0000-000000000002")),
                Snapshot(itemKind: HostItemKind.Series),
                Snapshot(seriesId: Guid.Parse("30000000-0000-0000-0000-000000000003")),
                Snapshot(providerReferences: [new HostProviderReference("tmdb", "999")]),
                Snapshot(definition: PlatformOperationDefinition.SeerrRequestItem),
                Snapshot(contributionKinds: ["action"]),
                Snapshot(fieldKinds: ["confirmation"]),
                Snapshot(inputModes: ["touch"]),
                Snapshot(accessibility: []),
                Snapshot(locale: "fr-FR"),
                Snapshot(stateRevisions: [new PlatformPrepareStateRevision("owner", 9)]),
                Snapshot(configurationRevision: 8),
                Snapshot(catalogRevision: "sha256-different"),
                Snapshot(privateState: [1, 2, 4]),
            };

            var handles = snapshots
                .Select(snapshot => owner.IssueOrReuse(snapshot))
                .Select(issue => Assert.IsType<string>(issue.Handle))
                .ToArray();

            Assert.Equal(handles.Length, handles.Distinct(StringComparer.Ordinal).Count());
            Assert.All(handles, handle =>
            {
                Assert.Equal(PlatformPrepareHandleOwner.MaximumHandleCharacters, handle.Length);
                Assert.Matches("^[A-Za-z0-9_-]+$", handle);
            });
        }

        [Fact]
        public void ResolveAuthenticatesActorAndOptionalDeviceWithoutTurningAttributionIntoAuthority()
        {
            var clock = new ManualTimeProvider(Epoch);
            using var owner = Owner(clock);
            var bound = owner.IssueOrReuse(Snapshot(attenuateToCurrentDevice: true));
            var unbound = owner.IssueOrReuse(Snapshot(privateState: [8], attenuateToCurrentDevice: false));

            Assert.Null(owner.Resolve(bound.Handle, Actor(userId: Guid.NewGuid())));
            Assert.Null(owner.Resolve(bound.Handle, Actor(elevated: true)));
            Assert.Null(owner.Resolve(bound.Handle, Actor(deviceId: "another-device")));
            Assert.NotNull(owner.Resolve(bound.Handle, Actor(clientName: "renamed-client")));
            Assert.NotNull(owner.Resolve(unbound.Handle, Actor(deviceId: "another-device", clientName: "renamed-client")));
            Assert.Null(owner.Resolve(unbound.Handle + "x", Actor()));
            Assert.Null(owner.Resolve(new string('a', PlatformPrepareHandleOwner.MaximumHandleCharacters), Actor()));
            Assert.Null(owner.Resolve(null, Actor()));
        }

        [Fact]
        public void ExpiryAndRestartLoseStateAndNeverReconstructItFromAHandle()
        {
            var clock = new ManualTimeProvider(Epoch);
            var entropy = new SequentialEntropy();
            string expired;
            using (var owner = new PlatformPrepareHandleOwner(clock, entropy.GetBytes))
            {
                var issue = owner.IssueOrReuse(Snapshot());
                expired = issue.Handle!;
                Assert.Equal(Epoch + PlatformPrepareHandleOwner.HandleTimeToLive, issue.ExpiresAt);
                clock.Advance(PlatformPrepareHandleOwner.HandleTimeToLive);
                Assert.Null(owner.Resolve(expired, Actor()));
                Assert.Equal(0, owner.EntryCount);

                var replacement = owner.IssueOrReuse(Snapshot());
                Assert.Equal(PlatformPrepareHandleIssueKind.Issued, replacement.Kind);
                Assert.NotEqual(expired, replacement.Handle);
                Assert.Null(owner.Resolve(expired, Actor()));
            }

            using var restarted = new PlatformPrepareHandleOwner(clock, new SequentialEntropy().GetBytes);
            Assert.Null(restarted.Resolve(expired, Actor()));
            Assert.Equal(0, restarted.EntryCount);
        }

        [Fact]
        public void PerActorCapacityEvictsOnlyThatActorsOldestAndReuseDoesNotRefreshItsAge()
        {
            var clock = new ManualTimeProvider(Epoch);
            using var owner = Owner(clock);
            var first = owner.IssueOrReuse(Snapshot(privateState: [0]));
            Assert.Equal(PlatformPrepareHandleIssueKind.Reused, owner.IssueOrReuse(Snapshot(privateState: [0])).Kind);
            PlatformPrepareHandleIssue? second = null;
            for (var index = 1; index < PlatformPrepareHandleOwner.MaximumEntriesPerActor; index++)
            {
                var issue = owner.IssueOrReuse(Snapshot(privateState: BitConverter.GetBytes(index)));
                second ??= issue;
            }

            var otherActor = Actor(userId: Guid.Parse("bbbbbbbb-cccc-dddd-eeee-ffffffffffff"));
            var other = owner.IssueOrReuse(Snapshot(actor: otherActor));
            var replacement = owner.IssueOrReuse(Snapshot(privateState: [255]));

            Assert.Equal(PlatformPrepareHandleIssueKind.Issued, replacement.Kind);
            Assert.Equal(PlatformPrepareHandleOwner.MaximumEntriesPerActor + 1, owner.EntryCount);
            Assert.Null(owner.Resolve(first.Handle, Actor()));
            Assert.NotNull(owner.Resolve(second!.Handle, Actor()));
            Assert.NotNull(owner.Resolve(other.Handle, otherActor));
        }

        [Fact]
        public void GlobalCapacityRefusesANewActorWithoutEvictingAnotherActor()
        {
            var clock = new ManualTimeProvider(Epoch);
            using var owner = Owner(clock);
            PlatformPrepareHandleIssue? first = null;
            PlatformActor? firstActor = null;
            for (var index = 1; index <= PlatformPrepareHandleOwner.MaximumEntries; index++)
            {
                var actor = Actor(userId: User(index));
                var issue = owner.IssueOrReuse(Snapshot(actor: actor));
                Assert.Equal(PlatformPrepareHandleIssueKind.Issued, issue.Kind);
                first ??= issue;
                firstActor ??= actor;
            }

            var refused = owner.IssueOrReuse(Snapshot(actor: Actor(userId: User(2000))));

            Assert.Equal(PlatformPrepareHandleIssueKind.AtCapacity, refused.Kind);
            Assert.Null(refused.Handle);
            Assert.Equal(PlatformPrepareHandleOwner.MaximumEntries, owner.EntryCount);
            Assert.NotNull(owner.Resolve(first!.Handle, firstActor!));
        }

        [Fact]
        public void GlobalCapacityMayReplaceOnlyTheIssuingActorsOwnOldestEntry()
        {
            var clock = new ManualTimeProvider(Epoch);
            using var owner = Owner(clock);
            var actor = Actor();
            var own = new List<PlatformPrepareHandleIssue>();
            for (var index = 0; index < PlatformPrepareHandleOwner.MaximumEntriesPerActor; index++)
            {
                own.Add(owner.IssueOrReuse(Snapshot(privateState: BitConverter.GetBytes(index))));
            }

            for (var index = own.Count + 1; index <= PlatformPrepareHandleOwner.MaximumEntries; index++)
            {
                var other = Actor(userId: User(index));
                Assert.Equal(
                    PlatformPrepareHandleIssueKind.Issued,
                    owner.IssueOrReuse(Snapshot(actor: other)).Kind);
            }

            var replacement = owner.IssueOrReuse(Snapshot(privateState: [200, 201]));

            Assert.Equal(PlatformPrepareHandleIssueKind.Issued, replacement.Kind);
            Assert.Equal(PlatformPrepareHandleOwner.MaximumEntries, owner.EntryCount);
            Assert.Null(owner.Resolve(own[0].Handle, actor));
            Assert.NotNull(owner.Resolve(own[1].Handle, actor));
            Assert.NotNull(owner.Resolve(replacement.Handle, actor));
        }

        [Fact]
        public void CollisionAndEntropyFailuresFailClosedWithoutReplacingLiveState()
        {
            var clock = new ManualTimeProvider(Epoch);
            var collisions = new ConstantEntropy(7);
            using var owner = new PlatformPrepareHandleOwner(clock, collisions.GetBytes);
            var first = owner.IssueOrReuse(Snapshot());
            var callsAfterFirst = collisions.Calls;
            var reused = owner.IssueOrReuse(Snapshot());

            Assert.Equal(PlatformPrepareHandleIssueKind.Reused, reused.Kind);
            Assert.Equal(callsAfterFirst, collisions.Calls);
            var collision = owner.IssueOrReuse(Snapshot(privateState: [9]));
            Assert.Equal(PlatformPrepareHandleIssueKind.EntropyUnavailable, collision.Kind);
            Assert.Equal(callsAfterFirst + 8, collisions.Calls);
            Assert.NotNull(owner.Resolve(first.Handle, Actor()));
            Assert.Equal(1, owner.EntryCount);

            using var shortOwner = new PlatformPrepareHandleOwner(clock, _ => new byte[31]);
            Assert.Equal(
                PlatformPrepareHandleIssueKind.EntropyUnavailable,
                shortOwner.IssueOrReuse(Snapshot()).Kind);
            using var throwingOwner = new PlatformPrepareHandleOwner(
                clock,
                _ => throw new CryptographicException("entropy offline"));
            Assert.Equal(
                PlatformPrepareHandleIssueKind.EntropyUnavailable,
                throwingOwner.IssueOrReuse(Snapshot()).Kind);
        }

        [Fact]
        public async Task ConcurrentEquivalentIssuesPublishExactlyOneStableHandle()
        {
            var clock = new ManualTimeProvider(Epoch);
            var entropy = new SequentialEntropy();
            using var owner = new PlatformPrepareHandleOwner(clock, entropy.GetBytes);
            var issues = new ConcurrentBag<PlatformPrepareHandleIssue>();

            await Task.WhenAll(Enumerable.Range(0, 128).Select(_ => Task.Run(() =>
                issues.Add(owner.IssueOrReuse(Snapshot())))));

            Assert.Single(issues.Select(issue => issue.Handle).Distinct(StringComparer.Ordinal));
            Assert.Single(issues, issue => issue.Kind == PlatformPrepareHandleIssueKind.Issued);
            Assert.Equal(127, issues.Count(issue => issue.Kind == PlatformPrepareHandleIssueKind.Reused));
            Assert.Equal(1, entropy.Calls);
            Assert.Equal(1, owner.EntryCount);
        }

        [Fact]
        public void SnapshotAndResolveUseDefensiveCopies()
        {
            var clock = new ManualTimeProvider(Epoch);
            using var owner = Owner(clock);
            var source = new byte[] { 1, 2, 3 };
            var snapshot = Snapshot(privateState: source);
            source.AsSpan().Fill(9);
            var issue = owner.IssueOrReuse(snapshot);
            var first = owner.Resolve(issue.Handle, Actor());
            var released = first!.PrivateState;
            Assert.True(MemoryMarshal.TryGetArray(released, out var segment));
            segment.AsSpan().Fill(8);

            var second = owner.Resolve(issue.Handle, Actor());
            Assert.NotSame(first, second);
            Assert.Equal(new byte[] { 1, 2, 3 }, second!.PrivateState.ToArray());
            Assert.NotSame(first.Client, second.Client);
        }

        [Fact]
        public void SnapshotRejectsEveryBoundAndAmbiguousState()
        {
            Assert.Throws<ArgumentException>(() => Snapshot(
                contributionKinds: Enumerable.Range(0, PlatformPrepareSnapshot.MaximumCapabilityValues + 1)
                    .Select(index => $"value-{index}")));
            Assert.Throws<ArgumentException>(() => Snapshot(contributionKinds: [new string('a', 65)]));
            Assert.Throws<ArgumentException>(() => Snapshot(locale: "not_a_locale"));
            Assert.Throws<ArgumentException>(() => Snapshot(
                stateRevisions: Enumerable.Range(0, PlatformPrepareSnapshot.MaximumStateRevisions + 1)
                    .Select(index => new PlatformPrepareStateRevision($"owner-{index}", index))));
            Assert.Throws<ArgumentException>(() => Snapshot(stateRevisions:
            [
                new PlatformPrepareStateRevision("owner", 1),
                new PlatformPrepareStateRevision("OWNER", 2),
            ]));
            Assert.Throws<ArgumentException>(() => Snapshot(
                privateState: new byte[PlatformPrepareSnapshot.MaximumPrivateStateBytes + 1]));
            Assert.Throws<ArgumentException>(() => Snapshot(providerReferences:
            [
                new HostProviderReference("tmdb", "1"),
                new HostProviderReference("tvdb", "2"),
                new HostProviderReference("imdb", "3"),
                new HostProviderReference("tmdb", "4"),
            ]));
            Assert.Throws<ArgumentException>(() => Snapshot(
                providerReferences: [new HostProviderReference("unknown", "1")]));
            Assert.Throws<ArgumentException>(() => Snapshot(
                providerReferences: [new HostProviderReference("tmdb", new string('1', 129))]));
            Assert.Throws<ArgumentException>(() => Snapshot(
                providerReferences: [new HostProviderReference("tmdb", " 11 ")]));
            Assert.Throws<ArgumentException>(() => Snapshot(catalogRevision: new string('r', 129)));
            Assert.Throws<ArgumentOutOfRangeException>(() => Snapshot(configurationRevision: -1));
            Assert.Throws<ArgumentException>(() => Snapshot(
                actor: Actor(deviceId: null),
                attenuateToCurrentDevice: true));
            Assert.Throws<ArgumentException>(() => Snapshot(actor: Actor(clientName: new string('c', 65))));
            Assert.Throws<ArgumentException>(() => Snapshot(
                itemKind: HostItemKind.Episode,
                definition: PlatformOperationDefinition.SeerrRequestItem));
            Assert.Throws<ArgumentOutOfRangeException>(() => new PlatformPrepareStateRevision("owner", -1));
            Assert.Throws<ArgumentException>(() => new PlatformPrepareStateRevision("\u212A", 1));
        }

        [Fact]
        public void SnapshotStopsEnumeratingCapabilityAndRevisionInputsAtTheirFixedBounds()
        {
            var capabilities = new EnumerationSentinel<string>(
                "action",
                PlatformPrepareSnapshot.MaximumCapabilityValues + 1);
            Assert.Throws<ArgumentException>(() => Snapshot(contributionKinds: capabilities));
            Assert.Equal(PlatformPrepareSnapshot.MaximumCapabilityValues + 1, capabilities.MoveNextCalls);

            var revisions = new EnumerationSentinel<PlatformPrepareStateRevision>(
                new PlatformPrepareStateRevision("owner", 1),
                PlatformPrepareSnapshot.MaximumStateRevisions + 1);
            Assert.Throws<ArgumentException>(() => Snapshot(stateRevisions: revisions));
            Assert.Equal(PlatformPrepareSnapshot.MaximumStateRevisions + 1, revisions.MoveNextCalls);
        }

        [Fact]
        public void DisposeIsIdempotentAndAllStatefulOperationsRejectFurtherUse()
        {
            var clock = new ManualTimeProvider(Epoch);
            var owner = Owner(clock);
            var issue = owner.IssueOrReuse(Snapshot());

            owner.Dispose();
            owner.Dispose();

            Assert.Throws<ObjectDisposedException>(() => owner.IssueOrReuse(Snapshot()));
            Assert.Throws<ObjectDisposedException>(() => owner.Resolve(issue.Handle, Actor()));
            Assert.Throws<ObjectDisposedException>(() => owner.EntryCount);
        }

        private static PlatformPrepareHandleOwner Owner(ManualTimeProvider clock)
            => new(clock, new SequentialEntropy().GetBytes);

        private static PlatformPrepareSnapshot Snapshot(
            PlatformActor? actor = null,
            Guid? itemId = null,
            HostItemKind itemKind = HostItemKind.Movie,
            Guid? seriesId = null,
            ImmutableArray<HostProviderReference>? providerReferences = null,
            PlatformOperationDefinition? definition = null,
            IEnumerable<string>? contributionKinds = null,
            IEnumerable<string>? fieldKinds = null,
            IEnumerable<string>? inputModes = null,
            IEnumerable<string>? accessibility = null,
            string locale = "en-AU",
            IEnumerable<PlatformPrepareStateRevision>? stateRevisions = null,
            long configurationRevision = 7,
            string catalogRevision = "sha256-catalog",
            byte[]? privateState = null,
            bool attenuateToCurrentDevice = false)
        {
            var item = new HostAccessibleItem(
                itemId ?? ItemId,
                itemKind,
                seriesId,
                providerReferences ?? [new HostProviderReference("Tmdb", "11")]);
            return new PlatformPrepareSnapshot(
                actor ?? Actor(),
                item,
                definition ?? PlatformOperationDefinition.HiddenContentConfigureItem,
                new PlatformPrepareClientContext(
                    contributionKinds ?? ["action", "status"],
                    fieldKinds ?? ["confirmation", "boolean"],
                    inputModes ?? ["dpad"],
                    accessibility ?? ["screen_reader"],
                    locale),
                stateRevisions ?? [new PlatformPrepareStateRevision("owner", 3)],
                configurationRevision,
                catalogRevision,
                privateState ?? [1, 2, 3],
                attenuateToCurrentDevice);
        }

        private static PlatformActor Actor(
            Guid? userId = null,
            bool elevated = false,
            string correlationId = "correlation",
            string? clientName = "android-tv",
            string? deviceId = "device-a")
            => PlatformActorTestFactory.Create(
                userId ?? UserId,
                elevated,
                correlationId,
                clientName,
                deviceId);

        private static Guid User(int value)
        {
            Span<byte> bytes = stackalloc byte[16];
            BitConverter.TryWriteBytes(bytes, value);
            bytes[15] = 1;
            return new Guid(bytes);
        }

        private sealed class SequentialEntropy
        {
            private int _value;

            internal int Calls => _value;

            internal byte[] GetBytes(int length)
            {
                var value = System.Threading.Interlocked.Increment(ref _value);
                var bytes = new byte[length];
                BitConverter.GetBytes(value).CopyTo(bytes, 0);
                return bytes;
            }
        }

        private sealed class ConstantEntropy(byte value)
        {
            internal int Calls { get; private set; }

            internal byte[] GetBytes(int length)
            {
                Calls++;
                return Enumerable.Repeat(value, length).ToArray();
            }
        }

        private sealed class EnumerationSentinel<T>(T value, int allowedValues) : IEnumerable<T>
        {
            internal int MoveNextCalls { get; private set; }

            public IEnumerator<T> GetEnumerator() => Enumerate().GetEnumerator();

            System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();

            private IEnumerable<T> Enumerate()
            {
                for (var index = 0; index < allowedValues; index++)
                {
                    MoveNextCalls++;
                    yield return value;
                }

                MoveNextCalls++;
                throw new InvalidOperationException("The bounded consumer enumerated beyond its rejection point.");
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
