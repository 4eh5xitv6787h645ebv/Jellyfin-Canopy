using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

public sealed class PlatformProviderRegistryJsonStateStoreTests
{
    private static readonly Guid PluginId = new("11111111-2222-3333-4444-555555555555");
    private static readonly Guid AdminId = new("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

    [Fact]
    public void MissingStoreIsHealthyEmptyAndDoesNotCreateFiles()
    {
        using var scope = TempScope.Create();
        var path = scope.PathFor("registry.json");
        var store = new PlatformProviderRegistryJsonStateStore(path);

        var loaded = store.Load();

        Assert.Equal(PlatformProviderRegistryStoreHealth.Healthy, loaded.Health);
        Assert.Equal(0, loaded.State.Revision);
        Assert.Empty(loaded.State.Records);
        Assert.Empty(Directory.GetFiles(scope.DirectoryPath));
    }

    [Fact]
    public void ExactByteMaximumIsAcceptedAndMaxPlusOneIsQuarantined()
    {
        using var scope = TempScope.Create();
        const string empty = "{\"schemaVersion\":1,\"revision\":0,\"records\":[]}";
        var exactPath = scope.PathFor("exact.json");
        File.WriteAllText(
            exactPath,
            empty + new string(
                ' ',
                PlatformProviderRegistryJsonStateStore.MaximumDocumentBytes - empty.Length));

        var exact = new PlatformProviderRegistryJsonStateStore(exactPath).Load();

        Assert.Equal(PlatformProviderRegistryJsonStateStore.MaximumDocumentBytes, new FileInfo(exactPath).Length);
        Assert.Equal(PlatformProviderRegistryStoreHealth.Healthy, exact.Health);
        var overPath = scope.PathFor("over.json");
        File.WriteAllText(
            overPath,
            empty + new string(
                ' ',
                PlatformProviderRegistryJsonStateStore.MaximumDocumentBytes + 1 - empty.Length));
        Assert.Equal(
            PlatformProviderRegistryStoreHealth.Quarantined,
            new PlatformProviderRegistryJsonStateStore(overPath).Load().Health);
    }

    [Fact]
    public void ExactEntryMaximumRoundTripsAndMaxPlusOneIsRejectedBeforeWrite()
    {
        using var scope = TempScope.Create();
        var path = scope.PathFor("registry.json");
        var store = new PlatformProviderRegistryJsonStateStore(path);
        var records = Enumerable.Range(1, PlatformProviderRegistry.MaximumProviderCount)
            .Select(index => InertRecord(new Guid(index, 0, 0, new byte[8])))
            .ToImmutableArray();
        var exact = new PlatformProviderRegistryDurableState(1, records);

        store.Save(exact);

        var loaded = store.Load();
        Assert.Equal(PlatformProviderRegistryStoreHealth.Healthy, loaded.Health);
        Assert.Equal(PlatformProviderRegistry.MaximumProviderCount, loaded.State.Records.Length);
        var priorBytes = File.ReadAllBytes(path);
        var over = new PlatformProviderRegistryDurableState(
            1,
            records.Add(InertRecord(new Guid(int.MaxValue, 0, 0, new byte[8]))));
        Assert.Throws<InvalidOperationException>(() => store.Save(over));
        Assert.Equal(priorBytes, File.ReadAllBytes(path));
    }

    [Fact]
    public void LeftoverAtomicTempSiblingIsNeverPromoted()
    {
        using var scope = TempScope.Create();
        var path = scope.PathFor("registry.json");
        var tempPath = path + ".tmp.interrupted";
        File.WriteAllText(tempPath, "{");

        var loaded = new PlatformProviderRegistryJsonStateStore(path).Load();

        Assert.Equal(PlatformProviderRegistryStoreHealth.Healthy, loaded.Health);
        Assert.Equal(0, loaded.State.Revision);
        Assert.True(File.Exists(tempPath));
        Assert.False(File.Exists(path));
    }

    [Fact]
    public void EnabledRegistryRoundTripsDeterministicallyButRestartsDormant()
    {
        using var scope = TempScope.Create();
        var path = scope.PathFor("registry.json");
        var store = new PlatformProviderRegistryJsonStateStore(path);
        var registry = Registry(store);
        registry.Reconcile(Completed(Acquired()));
        var pending = Assert.Single(registry.Snapshot.Entries);
        var approved = registry.Apply(
            PlatformProviderAdminCommand.Approve(
                registry.Snapshot.Revision,
                PluginId,
                pending.Generation,
                pending.Fingerprint!,
                new[] { "jellyfin.canopy.items.lookup" },
                "Reviewed provider"),
            AdminAuthorization());
        Assert.Equal(PlatformProviderRegistryMutationStatus.Applied, approved.Status);
        Assert.Equal(PlatformProviderLifecycleState.Enabled, Assert.Single(registry.Snapshot.Entries).State);
        var firstBytes = File.ReadAllBytes(path);

        var loaded = store.Load();
        store.Save(loaded.State);
        var secondBytes = File.ReadAllBytes(path);
        var restarted = Registry(new PlatformProviderRegistryJsonStateStore(path));

        Assert.Equal(firstBytes, secondBytes);
        Assert.Equal(PlatformProviderRegistryStoreHealth.Healthy, loaded.Health);
        Assert.Equal(PlatformProviderLifecycleState.Absent, Assert.Single(restarted.Snapshot.Entries).State);
        Assert.Null(restarted.TryRelease(PluginId, pending.Fingerprint!, pending.Generation));

        restarted.Reconcile(Completed(Acquired()));
        Assert.Equal(PlatformProviderLifecycleState.Enabled, Assert.Single(restarted.Snapshot.Entries).State);
    }

    [Theory]
    [MemberData(nameof(InvalidDocuments))]
    public void InvalidStateQuarantinesWithoutChangingForensicBytes(string document)
    {
        using var scope = TempScope.Create();
        var path = scope.PathFor("registry.json");
        File.WriteAllText(path, document);
        var before = File.ReadAllBytes(path);
        var store = new PlatformProviderRegistryJsonStateStore(path);

        var first = store.Load();
        var second = store.Load();

        Assert.Equal(PlatformProviderRegistryStoreHealth.Quarantined, first.Health);
        Assert.Equal(PlatformProviderRegistryStoreHealth.Quarantined, second.Health);
        Assert.Empty(first.State.Records);
        Assert.Equal(before, File.ReadAllBytes(path));
        Assert.True(File.Exists(path + ".quarantine.json"));
    }

    [Fact]
    public void CapPlusOneDocumentQuarantinesBeforeUnboundedAllocation()
    {
        using var scope = TempScope.Create();
        var path = scope.PathFor("registry.json");
        File.WriteAllBytes(
            path,
            new byte[PlatformProviderRegistryJsonStateStore.MaximumDocumentBytes + 1]);

        var loaded = new PlatformProviderRegistryJsonStateStore(path).Load();

        Assert.Equal(PlatformProviderRegistryStoreHealth.Quarantined, loaded.Health);
        Assert.Equal(
            PlatformProviderRegistryJsonStateStore.MaximumDocumentBytes + 1,
            new FileInfo(path).Length);
    }

    [Fact]
    public void StickyQuarantineMarkerBlocksAReplacementThatLooksValid()
    {
        using var scope = TempScope.Create();
        var path = scope.PathFor("registry.json");
        File.WriteAllText(path, "{");
        var store = new PlatformProviderRegistryJsonStateStore(path);
        Assert.Equal(PlatformProviderRegistryStoreHealth.Quarantined, store.Load().Health);
        File.WriteAllText(path, "{\"schemaVersion\":1,\"revision\":0,\"records\":[]}");

        var afterReplacement = store.Load();

        Assert.Equal(PlatformProviderRegistryStoreHealth.Quarantined, afterReplacement.Health);
        Assert.Throws<InvalidOperationException>(
            () => store.Save(PlatformProviderRegistryDurableState.Empty));
    }

    [Fact]
    public void ExplicitRecoveryPreservesEveryQuarantinedEpochAndRestartsHealthy()
    {
        using var scope = TempScope.Create();
        var path = scope.PathFor("registry.json");
        File.WriteAllText(path, "{");
        var original = File.ReadAllBytes(path);
        var registry = Registry(new PlatformProviderRegistryJsonStateStore(path));
        Assert.Equal(PlatformProviderRegistryStoreHealth.Quarantined, registry.Snapshot.StoreHealth);

        var firstRecovery = registry.Recover(
            new PlatformProviderRegistryRecoveryCommand("Reset corrupt registry"),
            AdminAuthorization());

        Assert.Equal(PlatformProviderRegistryMutationStatus.Applied, firstRecovery.Status);
        Assert.Equal(PlatformProviderRegistryStoreHealth.Healthy, registry.Snapshot.StoreHealth);
        Assert.Equal(original, File.ReadAllBytes(path));
        Assert.True(File.Exists(path + ".recovered.0.evidence.json"));
        Assert.Equal(
            PlatformProviderRegistryStoreHealth.Healthy,
            Registry(new PlatformProviderRegistryJsonStateStore(path)).Snapshot.StoreHealth);

        var firstRecoveredPath = path + ".recovered.0.json";
        File.WriteAllText(firstRecoveredPath, "{");
        var corruptRecovered = File.ReadAllBytes(firstRecoveredPath);
        var firstEvidence = File.ReadAllBytes(path + ".recovered.0.evidence.json");
        var quarantinedAgain = Registry(new PlatformProviderRegistryJsonStateStore(path));
        Assert.Equal(
            PlatformProviderRegistryStoreHealth.Quarantined,
            quarantinedAgain.Snapshot.StoreHealth);

        var secondRecovery = quarantinedAgain.Recover(
            new PlatformProviderRegistryRecoveryCommand("Reset second corrupt epoch"),
            AdminAuthorization());

        Assert.Equal(PlatformProviderRegistryMutationStatus.Applied, secondRecovery.Status);
        Assert.Equal(corruptRecovered, File.ReadAllBytes(firstRecoveredPath));
        Assert.Equal(firstEvidence, File.ReadAllBytes(path + ".recovered.0.evidence.json"));
        Assert.True(File.Exists(path + ".recovered.1.json"));
        Assert.True(File.Exists(path + ".recovered.1.evidence.json"));
        Assert.Equal(
            PlatformProviderRegistryStoreHealth.Healthy,
            Registry(new PlatformProviderRegistryJsonStateStore(path)).Snapshot.StoreHealth);
    }

    [Fact]
    public void RecoveryResumesAValidPreparedEpochWithoutConsumingAnotherSlot()
    {
        using var scope = TempScope.Create();
        var path = scope.PathFor("registry.json");
        File.WriteAllText(path, "{");
        Assert.Equal(
            PlatformProviderRegistryStoreHealth.Quarantined,
            new PlatformProviderRegistryJsonStateStore(path).Load().Health);
        File.WriteAllText(
            path + ".recovered.0.json",
            "{\"schemaVersion\":1,\"revision\":0,\"records\":[]}");
        var registry = Registry(new PlatformProviderRegistryJsonStateStore(path));

        var result = registry.Recover(
            new PlatformProviderRegistryRecoveryCommand("Resume prepared recovery"),
            AdminAuthorization());

        Assert.Equal(PlatformProviderRegistryMutationStatus.Applied, result.Status);
        Assert.True(File.Exists(path + ".recovered.0.evidence.json"));
        Assert.False(File.Exists(path + ".recovered.1.json"));
        Assert.Equal(
            PlatformProviderRegistryStoreHealth.Healthy,
            Registry(new PlatformProviderRegistryJsonStateStore(path)).Snapshot.StoreHealth);
    }

    [Fact]
    public void MissingActiveRecoveredStateIsFencedAndCanBeRecoveredAgain()
    {
        using var scope = TempScope.Create();
        var path = scope.PathFor("registry.json");
        File.WriteAllText(path, "{");
        var first = Registry(new PlatformProviderRegistryJsonStateStore(path));
        Assert.Equal(
            PlatformProviderRegistryMutationStatus.Applied,
            first.Recover(
                new PlatformProviderRegistryRecoveryCommand("Initial recovery"),
                AdminAuthorization()).Status);
        File.Delete(path + ".recovered.0.json");

        var quarantined = Registry(new PlatformProviderRegistryJsonStateStore(path));

        Assert.Equal(PlatformProviderRegistryStoreHealth.Quarantined, quarantined.Snapshot.StoreHealth);
        Assert.True(File.Exists(path + ".recovered.0.fence.json"));
        Assert.Equal(
            PlatformProviderRegistryMutationStatus.Applied,
            quarantined.Recover(
                new PlatformProviderRegistryRecoveryCommand("Replace missing recovered state"),
                AdminAuthorization()).Status);
        Assert.True(File.Exists(path + ".recovered.1.evidence.json"));
        Assert.Equal(
            PlatformProviderRegistryStoreHealth.Healthy,
            Registry(new PlatformProviderRegistryJsonStateStore(path)).Snapshot.StoreHealth);
    }

    [Fact]
    public void RecoverySupersedesMalformedHigherEpochAndVerifiesCommittedSelection()
    {
        using var scope = TempScope.Create();
        var path = scope.PathFor("registry.json");
        File.WriteAllText(path, "{");
        Assert.Equal(
            PlatformProviderRegistryStoreHealth.Quarantined,
            new PlatformProviderRegistryJsonStateStore(path).Load().Health);
        File.WriteAllText(path + ".recovered.3.evidence.json", "{");
        var registry = Registry(new PlatformProviderRegistryJsonStateStore(path));

        var result = registry.Recover(
            new PlatformProviderRegistryRecoveryCommand("Supersede malformed recovery epoch"),
            AdminAuthorization());

        Assert.Equal(PlatformProviderRegistryMutationStatus.Applied, result.Status);
        Assert.True(File.Exists(path + ".recovered.4.json"));
        Assert.True(File.Exists(path + ".recovered.4.evidence.json"));
        Assert.Equal(
            PlatformProviderRegistryStoreHealth.Healthy,
            Registry(new PlatformProviderRegistryJsonStateStore(path)).Snapshot.StoreHealth);
    }

    [Fact]
    public void RecoveryRetriesAnAlreadyCommittedEmptyEpochIdempotently()
    {
        using var scope = TempScope.Create();
        var path = scope.PathFor("registry.json");
        File.WriteAllText(path, "{");
        var store = new PlatformProviderRegistryJsonStateStore(path);
        var registry = Registry(store);
        Assert.Equal(PlatformProviderRegistryStoreHealth.Quarantined, registry.Snapshot.StoreHealth);
        store.ResetQuarantined(
            AdminId,
            "Committed before ambiguous failure",
            new DateTimeOffset(2026, 8, 4, 2, 0, 0, TimeSpan.Zero));

        var result = registry.Recover(
            new PlatformProviderRegistryRecoveryCommand("Retry committed recovery"),
            AdminAuthorization());

        Assert.Equal(PlatformProviderRegistryMutationStatus.Applied, result.Status);
        Assert.False(File.Exists(path + ".recovered.1.json"));
        Assert.Equal(
            PlatformProviderRegistryStoreHealth.Healthy,
            Registry(new PlatformProviderRegistryJsonStateStore(path)).Snapshot.StoreHealth);
    }

    [Fact]
    public void RecoveryCanReplaceTransientlyMissingBaseQuarantineMarker()
    {
        using var scope = TempScope.Create();
        var path = scope.PathFor("registry.json");
        File.WriteAllText(path, "{");
        var registry = Registry(new PlatformProviderRegistryJsonStateStore(path));
        Assert.Equal(PlatformProviderRegistryStoreHealth.Quarantined, registry.Snapshot.StoreHealth);
        File.Delete(path + ".quarantine.json");

        var result = registry.Recover(
            new PlatformProviderRegistryRecoveryCommand("Retry missing quarantine evidence"),
            AdminAuthorization());

        Assert.Equal(PlatformProviderRegistryMutationStatus.Applied, result.Status);
        Assert.True(File.Exists(path + ".recovered.0.evidence.json"));
        Assert.Equal(
            PlatformProviderRegistryStoreHealth.Healthy,
            Registry(new PlatformProviderRegistryJsonStateStore(path)).Snapshot.StoreHealth);
    }

    [Fact]
    public void RecoveryFencesAnUnhealthyCommittedEpochBeforeAdvancing()
    {
        using var scope = TempScope.Create();
        var path = scope.PathFor("registry.json");
        File.WriteAllText(path, "{");
        var store = new PlatformProviderRegistryJsonStateStore(path);
        var registry = Registry(store);
        store.ResetQuarantined(
            AdminId,
            "Prepare recovered epoch",
            new DateTimeOffset(2026, 8, 4, 2, 0, 0, TimeSpan.Zero));
        File.WriteAllText(path + ".recovered.0.json", "{");

        var result = registry.Recover(
            new PlatformProviderRegistryRecoveryCommand("Fence failed recovered epoch"),
            AdminAuthorization());

        Assert.Equal(PlatformProviderRegistryMutationStatus.Applied, result.Status);
        Assert.True(File.Exists(path + ".recovered.0.fence.json"));
        Assert.True(File.Exists(path + ".recovered.1.evidence.json"));
        Assert.Equal(
            PlatformProviderRegistryStoreHealth.Healthy,
            Registry(new PlatformProviderRegistryJsonStateStore(path)).Snapshot.StoreHealth);
    }

    [Fact]
    public void RecoverySupersedesButNeverOverwritesOversizeQuarantineEvidence()
    {
        using var scope = TempScope.Create();
        var path = scope.PathFor("registry.json");
        File.WriteAllText(path, "{");
        var store = new PlatformProviderRegistryJsonStateStore(path);
        Assert.Equal(PlatformProviderRegistryStoreHealth.Quarantined, store.Load().Health);
        var quarantinePath = path + ".quarantine.json";
        File.WriteAllBytes(
            quarantinePath,
            new byte[PlatformProviderRegistryJsonStateStore.MaximumDocumentBytes + 1]);
        var forensicBytes = File.ReadAllBytes(quarantinePath);
        var registry = Registry(new PlatformProviderRegistryJsonStateStore(path));

        var result = registry.Recover(
            new PlatformProviderRegistryRecoveryCommand("Preserve oversize marker"),
            AdminAuthorization());

        Assert.Equal(PlatformProviderRegistryMutationStatus.Applied, result.Status);
        Assert.Equal(forensicBytes, File.ReadAllBytes(quarantinePath));
        Assert.Equal(
            PlatformProviderRegistryStoreHealth.Healthy,
            Registry(new PlatformProviderRegistryJsonStateStore(path)).Snapshot.StoreHealth);
    }

    [Fact]
    public void StrictRecordRelationshipsAndBoundsQuarantineWholeStore()
    {
        using var scope = TempScope.Create();
        var validPath = scope.PathFor("valid.json");
        var registry = Registry(new PlatformProviderRegistryJsonStateStore(validPath));
        registry.Reconcile(Completed(Acquired()));
        var pending = Assert.Single(registry.Snapshot.Entries);
        registry.Apply(
            PlatformProviderAdminCommand.Approve(
                registry.Snapshot.Revision,
                PluginId,
                pending.Generation,
                pending.Fingerprint!,
                new[] { "jellyfin.canopy.items.lookup" },
                "Reviewed provider"),
            AdminAuthorization());
        var valid = File.ReadAllText(validPath);
        var mutations = new[]
        {
            valid.Replace("\"generation\":2", "\"generation\":0", StringComparison.Ordinal),
            valid.Replace("\"generation\":2", "\"generation\":3", StringComparison.Ordinal),
            valid.Replace("\"disposition\":1", "\"disposition\":99", StringComparison.Ordinal),
            valid.Replace("\"lastHostStatus\":1", "\"lastHostStatus\":999", StringComparison.Ordinal),
            valid.Replace("\"lastHostVersion\":\"1.2.3.4\"", "\"lastHostVersion\":\"01.2\"", StringComparison.Ordinal),
            valid.Replace(
                "\"lastAssemblyIdentity\":\"Example.Provider\"",
                "\"lastAssemblyIdentity\":\"" + new string('a',
                    PlatformProviderRegistryJsonStateStore.MaximumAssemblyIdentityLength + 1) + "\"",
                StringComparison.Ordinal),
            valid.Replace(
                "\"jellyfin.canopy.items.lookup\",\"jellyfin.canopy.storage.read\"",
                "\"jellyfin.canopy.storage.read\",\"jellyfin.canopy.items.lookup\"",
                StringComparison.Ordinal),
            valid.Replace(
                "jellyfin.canopy.items.lookup",
                "jellyfin.canopy.administration.manage",
                StringComparison.Ordinal),
            valid.Replace(
                "\"jellyfin.canopy.items.lookup\",\"jellyfin.canopy.storage.read\"",
                string.Join(',', Enumerable.Repeat(
                    "\"jellyfin.canopy.items.lookup\"",
                    PlatformCapabilityVocabulary.MaximumCapabilityCount + 1)),
                StringComparison.Ordinal),
            valid.Replace(
                "\"reason\":\"Reviewed provider\"",
                "\"reason\":\"" + new string('r', PlatformProviderRegistry.MaximumReasonLength + 1) + "\"",
                StringComparison.Ordinal),
            valid.Replace("\"decidedAtRevision\":2", "\"decidedAtRevision\":null", StringComparison.Ordinal),
            valid.Replace("\"pluginId\":", "\"unknown\":true,\"pluginId\":", StringComparison.Ordinal),
        };

        for (var index = 0; index < mutations.Length; index++)
        {
            Assert.NotEqual(valid, mutations[index]);
            var path = scope.PathFor("invalid-" + index + ".json");
            File.WriteAllText(path, mutations[index]);
            Assert.Equal(
                PlatformProviderRegistryStoreHealth.Quarantined,
                new PlatformProviderRegistryJsonStateStore(path).Load().Health);
        }
    }

    public static TheoryData<string> InvalidDocuments => new()
    {
        "",
        "null",
        "{}",
        "{\"schemaVersion\":2,\"revision\":0,\"records\":[]}",
        "{\"schemaVersion\":1,\"schemaVersion\":1,\"revision\":0,\"records\":[]}",
        "{\"schemaVersion\":1,\"revision\":0,\"records\":[],\"unknown\":true}",
        "{\"schemaVersion\":1,\"revision\":-1,\"records\":[]}",
        "{\"schemaVersion\":1,\"revision\":0,\"records\":null}",
    };

    private static PlatformProviderRegistry Registry(IPlatformProviderRegistryStateStore store) =>
        new(store, new FixedTimeProvider(new DateTimeOffset(2026, 8, 4, 2, 0, 0, TimeSpan.Zero)));

    private static PlatformInstalledManifestSweep Completed(
        params PlatformInstalledManifestObservation[] observations) =>
        PlatformInstalledManifestSweep.EstablishCompleted(observations.ToImmutableArray());

    private static PlatformInstalledManifestObservation Acquired()
    {
        var snapshot = PlatformInstalledManifestBindingTests.Snapshot();
        return PlatformInstalledManifestBinder.Bind(
            snapshot,
            PlatformInstalledManifestBindingTests.Snapshot(),
            PlatformInstalledManifestReadResult.Acquired(
                PlatformInstalledManifestBindingTests.ManifestBytes(
                    capabilities: new[]
                    {
                        "jellyfin.canopy.items.lookup",
                        "jellyfin.canopy.storage.read",
                    }),
                "Example.Provider"));
    }

    private static PlatformProviderRegistryDurableRecord InertRecord(Guid pluginId) =>
        new(
            pluginId,
            1,
            null,
            null,
            null,
            (int)PlatformInstalledPluginHostStatus.Active,
            PlatformInstalledManifestOutcome.HostMetadataInvalid,
            null,
            ImmutableArray<string>.Empty,
            true,
            PlatformProviderDurableDisposition.None,
            null,
            ImmutableArray<string>.Empty,
            null,
            null,
            null,
            null);

    private static PlatformProviderAdminAuthorization AdminAuthorization()
    {
        var actor = PlatformActorTestFactory.Create(
            AdminId,
            true,
            "registry-store-test",
            "test-client",
            "test-device");
        return Assert.IsType<PlatformProviderAdminAuthorization>(
            PlatformProviderRegistryAdminBoundary.ReauthorizeElevatedAdministrator(
                actor,
                new ReauthorizationHost()));
    }

    private sealed class FixedTimeProvider : TimeProvider
    {
        private readonly DateTimeOffset _now;

        internal FixedTimeProvider(DateTimeOffset now) => _now = now;

        public override DateTimeOffset GetUtcNow() => _now;
    }

    private sealed class ReauthorizationHost : IPlatformHost, IHostUsers
    {
        public IHostUsers Users => this;

        public IHostLibrary Library => throw new NotSupportedException();

        public IHostSessions Sessions => throw new NotSupportedException();

        public IHostPlugins Plugins => throw new NotSupportedException();

        public HostUser? Find(Guid id) => id == AdminId
            ? new HostUser(AdminId, "Registry admin", true)
            : null;

        public IReadOnlyList<HostUser> All() => [];
    }

    private sealed class TempScope : IDisposable
    {
        private TempScope(string directoryPath) => DirectoryPath = directoryPath;

        internal string DirectoryPath { get; }

        internal static TempScope Create() => new(Directory.CreateTempSubdirectory("canopy-registry-").FullName);

        internal string PathFor(string fileName) => Path.Combine(DirectoryPath, fileName);

        public void Dispose()
        {
            try
            {
                Directory.Delete(DirectoryPath, recursive: true);
            }
            catch (IOException)
            {
                // Best-effort test cleanup.
            }
            catch (UnauthorizedAccessException)
            {
                // Best-effort test cleanup.
            }
        }
    }
}
