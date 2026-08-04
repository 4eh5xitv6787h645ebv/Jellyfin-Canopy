using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

public sealed class PlatformInstalledManifestDiscoveryTests
{
    [Fact]
    public async Task HostEnumerationOrderCannotChangeTheCanonicalObservationSet()
    {
        var high = Snapshot("ffffffff-2222-3333-4444-555555555555", "High");
        var low = Snapshot("11111111-2222-3333-4444-555555555555", "Low");
        var reader = new FakeReader(ReadFor);

        var forward = await Sweep(new[] { high, low }, reader);
        var reverse = await Sweep(new[] { low, high }, reader);

        var expected = new[] { low.PluginId, high.PluginId };
        Assert.Equal(expected, forward.Select(value => value.PluginId));
        Assert.Equal(expected, reverse.Select(value => value.PluginId));
        Assert.All(forward, value => Assert.Equal(PlatformInstalledManifestOutcome.Acquired, value.Outcome));
        Assert.All(reverse, value => Assert.Equal(PlatformInstalledManifestOutcome.Acquired, value.Outcome));
    }

    [Fact]
    public async Task DuplicateOrDefaultHostIdentityRejectsTheWholeInventoryBeforeAnyRead()
    {
        var duplicated = Snapshot("11111111-2222-3333-4444-555555555555", "First");
        var duplicate = Snapshot("11111111-2222-3333-4444-555555555555", "Second");
        var innocent = Snapshot("22222222-2222-3333-4444-555555555555", "Innocent");
        var reader = new FakeReader(ReadFor);

        var ambiguous = await Sweep(new[] { innocent, duplicated, duplicate }, reader);

        Assert.Equal(0, reader.CallCount);
        Assert.Equal(3, ambiguous.Length);
        Assert.Equal(2, ambiguous.Count(value =>
            value.Outcome == PlatformInstalledManifestOutcome.AmbiguousHostIdentity));
        Assert.All(ambiguous, value => Assert.Null(value.BoundManifest));

        reader = new FakeReader(ReadFor);
        var invalid = await Sweep(
            new[] { innocent, Snapshot(Guid.Empty.ToString(), "Invalid") },
            reader);
        Assert.Equal(0, reader.CallCount);
        Assert.Contains(invalid, value => value.Outcome == PlatformInstalledManifestOutcome.HostMetadataInvalid);
        Assert.All(invalid, value => Assert.Null(value.BoundManifest));
    }

    [Fact]
    public async Task EveryInvalidHostMetadataShapeRejectsAtomicallyBeforeAnyRead()
    {
        var valid = Snapshot("22222222-2222-3333-4444-555555555555", "Valid");
        var invalid = new[]
        {
            PlatformInstalledManifestBindingTests.Snapshot(
                pluginId: Guid.Parse("33333333-2222-3333-4444-555555555555"),
                name: string.Empty),
            PlatformInstalledManifestBindingTests.Snapshot(
                pluginId: Guid.Parse("44444444-2222-3333-4444-555555555555"),
                root: string.Empty),
        };

        foreach (var bad in invalid)
        {
            var reader = new FakeReader(ReadFor);
            var observations = await Sweep(new[] { valid, bad }, reader);
            Assert.Equal(0, reader.CallCount);
            Assert.All(observations, observation => Assert.Null(observation.BoundManifest));
            Assert.Contains(observations,
                observation => observation.Outcome == PlatformInstalledManifestOutcome.HostMetadataInvalid);
        }
    }

    [Fact]
    public async Task OneAbsentMalformedThrowingOrInactivePluginCannotSuppressLaterSuccess()
    {
        var absent = Snapshot("10000000-2222-3333-4444-555555555555", "Absent");
        var malformed = Snapshot("20000000-2222-3333-4444-555555555555", "Malformed");
        var throwing = Snapshot("30000000-2222-3333-4444-555555555555", "Throwing");
        var inactive = Snapshot(
            "40000000-2222-3333-4444-555555555555",
            "Restart",
            PlatformInstalledPluginHostStatus.Restart);
        var valid = Snapshot("50000000-2222-3333-4444-555555555555", "Valid");
        var reader = new FakeReader(snapshot =>
        {
            if (snapshot.PluginId == absent.PluginId)
            {
                return PlatformInstalledManifestReadResult.Rejected(
                    PlatformInstalledManifestOutcome.ManifestAbsent);
            }

            if (snapshot.PluginId == malformed.PluginId)
            {
                return PlatformInstalledManifestReadResult.Acquired(new byte[] { (byte)'{' }, "Example.Provider");
            }

            if (snapshot.PluginId == throwing.PluginId)
            {
                throw new InvalidOperationException("reader detail must not escape");
            }

            return ReadFor(snapshot);
        });

        var observations = await Sweep(
            new[] { valid, inactive, throwing, malformed, absent },
            reader);

        Assert.Equal(PlatformInstalledManifestOutcome.ManifestAbsent, Find(absent).Outcome);
        Assert.Equal(PlatformInstalledManifestOutcome.ManifestRejected, Find(malformed).Outcome);
        Assert.Equal(PlatformInstalledManifestOutcome.AcquisitionFailed, Find(throwing).Outcome);
        Assert.Equal(PlatformInstalledManifestOutcome.HostStatusNotActive, Find(inactive).Outcome);
        Assert.Equal(PlatformInstalledManifestOutcome.Acquired, Find(valid).Outcome);
        Assert.NotNull(Find(valid).BoundManifest);
        Assert.DoesNotContain(observations.Select(value => value.Outcome.ToString()), value =>
            value.Contains("reader detail", StringComparison.Ordinal));
        Assert.DoesNotContain(inactive.PluginId, reader.Calls);

        PlatformInstalledManifestObservation Find(PlatformInstalledPluginSnapshot snapshot) =>
            observations.Single(value => value.PluginId == snapshot.PluginId);
    }

    [Fact]
    public async Task ReobservationDisappearanceOrMutationFailsOnlyThatPluginClosed()
    {
        var disappeared = Snapshot("10000000-2222-3333-4444-555555555555", "Gone");
        var changed = Snapshot("20000000-2222-3333-4444-555555555555", "Changed");
        var valid = Snapshot("30000000-2222-3333-4444-555555555555", "Valid");
        var inventory = new[] { disappeared, changed, valid };
        var reader = new FakeReader(ReadFor);

        var observations = await PlatformInstalledManifestDiscovery.SweepAsync(
            inventory,
            reader,
            (id, _) => ValueTask.FromResult<PlatformInstalledPluginSnapshot?>(id == disappeared.PluginId
                ? null
                : id == changed.PluginId
                    ? PlatformInstalledManifestBindingTests.Snapshot(
                        pluginId: id,
                        root: "/plugins/changed")
                    : inventory.Single(value => value.PluginId == id)),
            CancellationToken.None);

        Assert.Equal(PlatformInstalledManifestOutcome.HostSnapshotChanged,
            observations.Single(value => value.PluginId == disappeared.PluginId).Outcome);
        Assert.Equal(PlatformInstalledManifestOutcome.HostSnapshotChanged,
            observations.Single(value => value.PluginId == changed.PluginId).Outcome);
        Assert.Equal(PlatformInstalledManifestOutcome.Acquired,
            observations.Single(value => value.PluginId == valid.PluginId).Outcome);
    }

    [Fact]
    public async Task CancellationBeforeAndBetweenPluginsPublishesNoPartialResult()
    {
        var first = Snapshot("10000000-2222-3333-4444-555555555555", "First");
        var second = Snapshot("20000000-2222-3333-4444-555555555555", "Second");
        using var alreadyCancelled = new CancellationTokenSource();
        alreadyCancelled.Cancel();
        var untouched = new FakeReader(ReadFor);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            await Sweep(new[] { first }, untouched, alreadyCancelled.Token));
        Assert.Equal(0, untouched.CallCount);

        using var between = new CancellationTokenSource();
        var cancellingReader = new FakeReader(snapshot =>
        {
            var result = ReadFor(snapshot);
            between.Cancel();
            return result;
        });
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            await Sweep(new[] { first, second }, cancellingReader, between.Token));
        Assert.Equal(1, cancellingReader.CallCount);
    }

    [Fact]
    public async Task HostOwnedBoundaryEnumeratesOnceAndPerformsFreshReobservation()
    {
        var first = Snapshot("10000000-2222-3333-4444-555555555555", "First");
        var second = Snapshot("20000000-2222-3333-4444-555555555555", "Second");
        var host = new FakeHostPlugins(new[] { second, first });
        var reader = new FakeReader(ReadFor);
        var acquisition = new PlatformInstalledManifestAcquisition(host, reader);

        var observations = await acquisition.SweepAsync(CancellationToken.None);

        Assert.Equal(1, host.InventoryReads);
        Assert.Equal(new[] { first.PluginId, second.PluginId }, host.ReobservedIds);
        Assert.Equal(new[] { first.PluginId, second.PluginId }, observations.Select(value => value.PluginId));
        Assert.All(observations, value =>
            Assert.Equal(PlatformInstalledManifestOutcome.Acquired, value.Outcome));
    }

    [Fact]
    public async Task HostOwnedBoundaryChecksCancellationBeforeEnumeration()
    {
        var host = new FakeHostPlugins(new[]
        {
            Snapshot("10000000-2222-3333-4444-555555555555", "First"),
        });
        var acquisition = new PlatformInstalledManifestAcquisition(
            host,
            new FakeReader(ReadFor));
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            await acquisition.SweepAsync(cancellation.Token));

        Assert.Equal(0, host.InventoryReads);
        Assert.Empty(host.ReobservedIds);
    }

    [Fact]
    public async Task CancellationDuringReadIsObservedAndReleasesTheReader()
    {
        var snapshot = PlatformInstalledManifestBindingTests.Snapshot();
        using var cancellation = new CancellationTokenSource();
        var reader = new CancellationAwareReader();

        var sweep = Sweep(new[] { snapshot }, reader, cancellation.Token).AsTask();
        await reader.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await sweep);
        Assert.True(await reader.Exited.Task.WaitAsync(TimeSpan.FromSeconds(5)));
    }

    [Fact]
    public async Task ConcurrentExplicitSweepsAreDeterministicAndIndependent()
    {
        var inventory = new[]
        {
            Snapshot("30000000-2222-3333-4444-555555555555", "Three"),
            Snapshot("10000000-2222-3333-4444-555555555555", "One"),
            Snapshot("20000000-2222-3333-4444-555555555555", "Two"),
        };

        var sweeps = await Task.WhenAll(Enumerable.Range(0, 64).Select(async _ =>
        {
            var reader = new FakeReader(ReadFor);
            var observations = await Sweep(inventory, reader);
            return observations.Select(value =>
                (value.PluginId, value.Outcome, value.BoundManifest!.Fingerprint.Value)).ToArray();
        }));

        Assert.All(sweeps, result => Assert.Equal(sweeps[0], result));
        Assert.Equal(3, sweeps[0].Length);
    }

    [Fact]
    public async Task SuccessfulObservationsOwnTheirStateAfterInputsMutate()
    {
        var bytes = PlatformInstalledManifestBindingTests.ManifestBytes();
        var snapshot = PlatformInstalledManifestBindingTests.Snapshot();
        var mutableInventory = new List<PlatformInstalledPluginSnapshot> { snapshot };
        var reader = new FakeReader(_ =>
            PlatformInstalledManifestReadResult.Acquired(bytes, "Example.Provider"));

        var observations = await Sweep(mutableInventory, reader);
        var bound = Assert.IsType<HostBoundInstalledManifest>(Assert.Single(observations).BoundManifest);
        var fingerprint = bound.Fingerprint.Value;
        bytes.AsSpan().Fill((byte)'x');
        mutableInventory.Clear();

        Assert.Equal(snapshot.PluginId, bound.PluginId);
        Assert.Equal(new Version(1, 2, 3, 4), bound.HostVersion);
        Assert.Equal(fingerprint, bound.Fingerprint.Value);
        Assert.Equal("org.example.provider", bound.Manifest.Id);
    }

    [Fact]
    public async Task PluginCountBoundaryIsAtomicAndConcurrencyRemainsPinned()
    {
        Assert.Equal(1024, PlatformInstalledManifestDiscovery.MaximumPluginCount);
        Assert.Equal(1, PlatformInstalledManifestDiscovery.MaximumConcurrentAcquisitions);

        var overBound = Enumerable.Range(1, PlatformInstalledManifestDiscovery.MaximumPluginCount + 1)
            .Select(index => PlatformInstalledManifestBindingTests.Snapshot(
                pluginId: Guid.Parse($"{index:x8}-2222-3333-4444-555555555555")))
            .ToArray();
        var reader = new FakeReader(ReadFor);

        var observations = await Sweep(overBound, reader);

        Assert.Equal(0, reader.CallCount);
        Assert.Equal(overBound.Length, observations.Length);
        Assert.All(observations, observation =>
        {
            Assert.Equal(PlatformInstalledManifestOutcome.HostMetadataInvalid, observation.Outcome);
            Assert.Null(observation.BoundManifest);
        });
    }

    private static PlatformInstalledPluginSnapshot Snapshot(
        string id,
        string name,
        PlatformInstalledPluginHostStatus status = PlatformInstalledPluginHostStatus.Active) =>
        PlatformInstalledManifestBindingTests.Snapshot(
            pluginId: Guid.Parse(id),
            name: name,
            status: status);

    private static PlatformInstalledManifestReadResult ReadFor(PlatformInstalledPluginSnapshot snapshot) =>
        PlatformInstalledManifestReadResult.Acquired(
            PlatformInstalledManifestBindingTests.ManifestBytes(
                pluginId: snapshot.PluginId.ToString("D"),
                version: snapshot.Version.ToString()),
            "sha256:test-assembly-set");

    private static ValueTask<ImmutableArray<PlatformInstalledManifestObservation>> Sweep(
        IReadOnlyList<PlatformInstalledPluginSnapshot> inventory,
        IPlatformInstalledManifestReader reader,
        CancellationToken cancellationToken = default) =>
        PlatformInstalledManifestDiscovery.SweepAsync(
            inventory,
            reader,
            (id, _) => ValueTask.FromResult<PlatformInstalledPluginSnapshot?>(
                inventory.SingleOrDefault(value => value.PluginId == id)),
            cancellationToken);

    private sealed class FakeReader : IPlatformInstalledManifestReader
    {
        private readonly Func<PlatformInstalledPluginSnapshot, PlatformInstalledManifestReadResult> _read;
        private readonly ConcurrentQueue<Guid> _calls = new();

        internal FakeReader(Func<PlatformInstalledPluginSnapshot, PlatformInstalledManifestReadResult> read) =>
            _read = read;

        internal int CallCount => _calls.Count;

        internal IReadOnlyCollection<Guid> Calls => _calls.ToArray();

        public ValueTask<PlatformInstalledManifestReadResult> ReadAsync(
            PlatformInstalledPluginSnapshot snapshot,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            _calls.Enqueue(snapshot.PluginId);
            return ValueTask.FromResult(_read(snapshot));
        }
    }

    private sealed class CancellationAwareReader : IPlatformInstalledManifestReader
    {
        internal TaskCompletionSource<bool> Entered { get; } = new(
            TaskCreationOptions.RunContinuationsAsynchronously);

        internal TaskCompletionSource<bool> Exited { get; } = new(
            TaskCreationOptions.RunContinuationsAsynchronously);

        public async ValueTask<PlatformInstalledManifestReadResult> ReadAsync(
            PlatformInstalledPluginSnapshot snapshot,
            CancellationToken cancellationToken)
        {
            Entered.TrySetResult(true);
            try
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                throw new InvalidOperationException("unreachable");
            }
            finally
            {
                Exited.TrySetResult(true);
            }
        }
    }

    private sealed class FakeHostPlugins : IHostPlugins
    {
        private readonly IReadOnlyList<PlatformInstalledPluginSnapshot> _inventory;
        private readonly ConcurrentQueue<Guid> _reobservedIds = new();

        internal FakeHostPlugins(IReadOnlyList<PlatformInstalledPluginSnapshot> inventory) =>
            _inventory = inventory;

        internal int InventoryReads { get; private set; }

        internal IReadOnlyList<Guid> ReobservedIds => _reobservedIds.ToArray();

        public IReadOnlyList<HostPlugin> Installed() => Array.Empty<HostPlugin>();

        public HostPlugin? Find(Guid id) => null;

        public IReadOnlyList<PlatformInstalledPluginSnapshot> InstalledSnapshots()
        {
            InventoryReads++;
            return _inventory;
        }

        public PlatformInstalledPluginSnapshot? FindSnapshot(Guid id)
        {
            _reobservedIds.Enqueue(id);
            return _inventory.SingleOrDefault(snapshot => snapshot.PluginId == id);
        }
    }
}
