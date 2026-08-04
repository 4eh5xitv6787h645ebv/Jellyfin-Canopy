using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

public sealed class PlatformProviderFixtureAcquisitionTests
{
    private static readonly Guid AlphaId = new("0a110000-1111-4222-8333-444455556666");
    private static readonly Guid OmegaId = new("0b220000-1111-4222-8333-444455556777");
    private static readonly Guid AdminId = new("0c330000-1111-4222-8333-444455556788");

    [Fact]
    public async Task IndependentPackagesAcquireAndBindTheirExactOwnIdentities()
    {
        var alpha = await AcquireAsync(
            AlphaId,
            "AAA Canopy Conformance Alpha",
            "Jellyfin.Plugin.CanopyConformance.Alpha");
        var omega = await AcquireAsync(
            OmegaId,
            "ZZZ Canopy Conformance Omega",
            "Jellyfin.Plugin.CanopyConformance.Omega");

        Assert.Equal(PlatformInstalledManifestOutcome.Acquired, alpha.Outcome);
        Assert.Equal(PlatformInstalledManifestOutcome.Acquired, omega.Outcome);
        Assert.Equal(AlphaId, alpha.BoundManifest!.PluginId);
        Assert.Equal(OmegaId, omega.BoundManifest!.PluginId);
        Assert.NotEqual(alpha.BoundManifest.Fingerprint.Value, omega.BoundManifest.Fingerprint.Value);
        Assert.Equal(
            new[]
            {
                "jellyfin.canopy.items.lookup",
                "jellyfin.canopy.storage.read",
            },
            alpha.BoundManifest.Manifest.RequestedCapabilities.Capabilities.Select(value => value.Id.Value));
        Assert.Equal(
            new[]
            {
                "jellyfin.canopy.user-data.read",
                "jellyfin.canopy.ui.contribute",
                "jellyfin.canopy.integrations.invoke",
            },
            omega.BoundManifest.Manifest.RequestedCapabilities.Capabilities.Select(value => value.Id.Value));
    }

    [Fact]
    public async Task ReversedFixtureOrderProducesTheSameCanonicalPendingRegistry()
    {
        var alpha = await AcquireAsync(
            AlphaId,
            "AAA Canopy Conformance Alpha",
            "Jellyfin.Plugin.CanopyConformance.Alpha");
        var omega = await AcquireAsync(
            OmegaId,
            "ZZZ Canopy Conformance Omega",
            "Jellyfin.Plugin.CanopyConformance.Omega");
        var forward = Registry();
        var reverse = Registry();

        Assert.Equal(
            PlatformProviderRegistryMutationStatus.Applied,
            forward.Reconcile(
                forward.BeginReconciliation(),
                Completed(alpha, omega)).Status);
        Assert.Equal(
            PlatformProviderRegistryMutationStatus.Applied,
            reverse.Reconcile(
                reverse.BeginReconciliation(),
                Completed(omega, alpha)).Status);

        Assert.Equal(
            new[] { AlphaId, OmegaId },
            forward.Snapshot.Entries.Select(value => value.PluginId));
        Assert.Equal(
            forward.Snapshot.Entries.Select(Project),
            reverse.Snapshot.Entries.Select(Project));
        Assert.All(forward.Snapshot.Entries, entry =>
            Assert.Equal(PlatformProviderLifecycleState.Pending, entry.State));
    }

    [Fact]
    public async Task CrossSubstitutedAndMalformedManifestCannotSuppressHonestPeer()
    {
        var temporaryRoot = Path.Combine(
            Path.GetTempPath(),
            "jc-provider-fixture-rejection-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(temporaryRoot);
        try
        {
            var alphaRoot = CopyPackage("Jellyfin.Plugin.CanopyConformance.Alpha", temporaryRoot);
            var omegaRoot = PackageRoot("Jellyfin.Plugin.CanopyConformance.Omega");
            File.Copy(
                Path.Combine(omegaRoot, "jellyfin-canopy-extension.json"),
                Path.Combine(alphaRoot, "jellyfin-canopy-extension.json"),
                overwrite: true);
            var substituted = await AcquireAsync(
                AlphaId,
                "AAA Canopy Conformance Alpha",
                "Jellyfin.Plugin.CanopyConformance.Alpha",
                alphaRoot);
            Assert.Equal(PlatformInstalledManifestOutcome.PluginIdMismatch, substituted.Outcome);

            File.WriteAllText(
                Path.Combine(alphaRoot, "jellyfin-canopy-extension.json"),
                "{not-json",
                new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            var malformed = await AcquireAsync(
                AlphaId,
                "AAA Canopy Conformance Alpha",
                "Jellyfin.Plugin.CanopyConformance.Alpha",
                alphaRoot);
            var honest = await AcquireAsync(
                OmegaId,
                "ZZZ Canopy Conformance Omega",
                "Jellyfin.Plugin.CanopyConformance.Omega");
            var registry = Registry();

            Assert.Equal(PlatformInstalledManifestOutcome.ManifestRejected, malformed.Outcome);
            Assert.Equal(
                PlatformProviderRegistryMutationStatus.Applied,
                registry.Reconcile(
                    registry.BeginReconciliation(),
                    Completed(malformed, honest)).Status);
            Assert.Equal(PlatformProviderLifecycleState.Quarantined, registry.Snapshot.Entries[0].State);
            Assert.Equal(PlatformProviderLifecycleState.Pending, registry.Snapshot.Entries[1].State);
        }
        finally
        {
            Directory.Delete(temporaryRoot, recursive: true);
        }
    }

    [Fact]
    public async Task ProductionAcquisitionAndOrchestratorAreCanonicalForBothFixtureOrders()
    {
        var forward = await RunProductionOrderAsync(reverse: false);
        var reverse = await RunProductionOrderAsync(reverse: true);

        Assert.Equal(1, forward.Host.InventoryReads);
        Assert.Equal(1, reverse.Host.InventoryReads);
        Assert.Equal(2, forward.Host.ReobservationReads);
        Assert.Equal(2, reverse.Host.ReobservationReads);
        Assert.Equal(1, forward.Registry.Snapshot.Revision);
        Assert.Equal(1, reverse.Registry.Snapshot.Revision);
        Assert.Equal(
            new[] { AlphaId, OmegaId },
            forward.Registry.Snapshot.Entries.Select(value => value.PluginId));
        Assert.Equal(
            forward.Registry.Snapshot.Entries.Select(Project),
            reverse.Registry.Snapshot.Entries.Select(Project));
        Assert.All(forward.Registry.Snapshot.Entries, entry =>
            Assert.Equal(PlatformProviderLifecycleState.Pending, entry.State));
    }

    [Fact]
    public async Task RealPackageVariantsProduceDistinctBoundFingerprintsAndScopes()
    {
        var temporaryRoot = Path.Combine(
            Path.GetTempPath(),
            "jc-provider-fixture-variants-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(temporaryRoot);
        try
        {
            var scopeRoot = CopyPackage(
                "Jellyfin.Plugin.CanopyConformance.Alpha",
                temporaryRoot);
            File.Copy(
                Path.Combine(
                    RepositoryRoot(),
                    "conformance",
                    "platform-providers",
                    "variants",
                    "alpha-scope-drift",
                    "jellyfin-canopy-extension.json"),
                Path.Combine(scopeRoot, "jellyfin-canopy-extension.json"),
                overwrite: true);
            var baseline = await AcquireAlphaAsync(
                PackageRoot("Jellyfin.Plugin.CanopyConformance.Alpha"),
                new Version(1, 0, 0, 0));
            var upgrade = await AcquireAlphaAsync(
                PackageRoot("Jellyfin.Plugin.CanopyConformance.Alpha.Upgrade"),
                new Version(1, 1, 0, 0));
            var downgrade = await AcquireAlphaAsync(
                PackageRoot("Jellyfin.Plugin.CanopyConformance.Alpha.Downgrade"),
                new Version(0, 9, 0, 0));
            var assemblyDrift = await AcquireAlphaAsync(
                PackageRoot("Jellyfin.Plugin.CanopyConformance.Alpha.AssemblyDrift"),
                new Version(1, 0, 0, 0));
            var scopeDrift = await AcquireAlphaAsync(scopeRoot, new Version(1, 0, 0, 0));

            Assert.All(
                new[] { baseline, upgrade, downgrade, assemblyDrift, scopeDrift },
                value => Assert.Equal(PlatformInstalledManifestOutcome.Acquired, value.Outcome));
            var fingerprints = new[] { baseline, upgrade, downgrade, scopeDrift }
                .Select(value => value.BoundManifest!.Fingerprint.Value)
                .ToArray();
            Assert.Equal(fingerprints.Length, fingerprints.Distinct(StringComparer.Ordinal).Count());
            Assert.Equal(
                baseline.BoundManifest!.Fingerprint.Value,
                assemblyDrift.BoundManifest!.Fingerprint.Value);
            Assert.NotEqual(
                baseline.BoundManifest.AssemblyIdentity,
                assemblyDrift.BoundManifest.AssemblyIdentity);
            Assert.Equal(
                new[]
                {
                    "jellyfin.canopy.items.lookup",
                    "jellyfin.canopy.user-data.read",
                    "jellyfin.canopy.storage.read",
                },
                scopeDrift.BoundManifest!.Manifest.RequestedCapabilities.Capabilities
                    .Select(value => value.Id.Value));
        }
        finally
        {
            Directory.Delete(temporaryRoot, recursive: true);
        }
    }

    [Fact]
    public async Task FixtureLifecycleDriftDisableRemovalAndReinstallNeverAutoApprove()
    {
        var temporaryRoot = Path.Combine(
            Path.GetTempPath(),
            "jc-provider-fixture-lifecycle-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(temporaryRoot);
        try
        {
            var scopeRoot = CopyPackage(
                "Jellyfin.Plugin.CanopyConformance.Alpha",
                temporaryRoot);
            File.Copy(
                Path.Combine(
                    RepositoryRoot(),
                    "conformance",
                    "platform-providers",
                    "variants",
                    "alpha-scope-drift",
                    "jellyfin-canopy-extension.json"),
                Path.Combine(scopeRoot, "jellyfin-canopy-extension.json"),
                overwrite: true);
            var reinstallRoot = Path.Combine(temporaryRoot, "reinstalled-alpha");
            Directory.CreateDirectory(reinstallRoot);
            foreach (var file in Directory.EnumerateFiles(
                         PackageRoot("Jellyfin.Plugin.CanopyConformance.Alpha")))
            {
                File.Copy(file, Path.Combine(reinstallRoot, Path.GetFileName(file)));
            }

            var baseline = await AcquireAlphaAsync(
                PackageRoot("Jellyfin.Plugin.CanopyConformance.Alpha"),
                new Version(1, 0, 0, 0));
            var upgrade = await AcquireAlphaAsync(
                PackageRoot("Jellyfin.Plugin.CanopyConformance.Alpha.Upgrade"),
                new Version(1, 1, 0, 0));
            var downgrade = await AcquireAlphaAsync(
                PackageRoot("Jellyfin.Plugin.CanopyConformance.Alpha.Downgrade"),
                new Version(0, 9, 0, 0));
            var assemblyDrift = await AcquireAlphaAsync(
                PackageRoot("Jellyfin.Plugin.CanopyConformance.Alpha.AssemblyDrift"),
                new Version(1, 0, 0, 0));
            var scopeDrift = await AcquireAlphaAsync(scopeRoot, new Version(1, 0, 0, 0));
            var registry = Registry();

            Assert.Equal(
                PlatformProviderRegistryMutationStatus.Applied,
                registry.Reconcile(registry.BeginReconciliation(), Completed(baseline)).Status);
            var pending = Assert.Single(registry.Snapshot.Entries);
            Assert.Equal(PlatformProviderLifecycleState.Pending, pending.State);
            Assert.Equal(
                PlatformProviderRegistryMutationStatus.Applied,
                registry.Apply(
                    PlatformProviderAdminCommand.Approve(
                        registry.Snapshot.Revision,
                        AlphaId,
                        pending.Generation,
                        pending.Fingerprint!,
                        new[] { "jellyfin.canopy.items.lookup" },
                        "Approve exact Alpha baseline"),
                    AdminAuthorization()).Status);
            var enabled = Assert.Single(registry.Snapshot.Entries);
            Assert.NotNull(registry.TryRelease(AlphaId, enabled.Fingerprint!, enabled.Generation));

            var priorGeneration = enabled.Generation;
            foreach (var drift in new[] { upgrade, downgrade, assemblyDrift, scopeDrift, baseline })
            {
                Assert.Equal(
                    PlatformProviderRegistryMutationStatus.Applied,
                    registry.Reconcile(registry.BeginReconciliation(), Completed(drift)).Status);
                var changed = Assert.Single(registry.Snapshot.Entries);
                Assert.Equal(PlatformProviderLifecycleState.Pending, changed.State);
                Assert.True(changed.Generation > priorGeneration);
                Assert.Null(registry.TryRelease(AlphaId, changed.Fingerprint!, changed.Generation));
                priorGeneration = changed.Generation;
            }

            var disabled = await AcquireAlphaAsync(
                PackageRoot("Jellyfin.Plugin.CanopyConformance.Alpha"),
                new Version(1, 0, 0, 0),
                PlatformInstalledPluginHostStatus.Disabled);
            Assert.Equal(
                PlatformProviderRegistryMutationStatus.Applied,
                registry.Reconcile(registry.BeginReconciliation(), Completed(disabled)).Status);
            Assert.Equal(
                PlatformProviderLifecycleState.Disabled,
                Assert.Single(registry.Snapshot.Entries).State);

            var restartPending = await AcquireAlphaAsync(
                PackageRoot("Jellyfin.Plugin.CanopyConformance.Alpha"),
                new Version(1, 0, 0, 0),
                PlatformInstalledPluginHostStatus.Restart);
            Assert.Equal(
                PlatformProviderRegistryMutationStatus.Applied,
                registry.Reconcile(registry.BeginReconciliation(), Completed(restartPending)).Status);
            Assert.Equal(
                PlatformProviderLifecycleState.RestartPending,
                Assert.Single(registry.Snapshot.Entries).State);

            Assert.Equal(
                PlatformProviderRegistryMutationStatus.Applied,
                registry.Reconcile(registry.BeginReconciliation(), Completed()).Status);
            Assert.Equal(
                PlatformProviderLifecycleState.Absent,
                Assert.Single(registry.Snapshot.Entries).State);

            var reinstall = await AcquireAlphaAsync(reinstallRoot, new Version(1, 0, 0, 0));
            Assert.Equal(
                PlatformProviderRegistryMutationStatus.Applied,
                registry.Reconcile(registry.BeginReconciliation(), Completed(reinstall)).Status);
            var reinstalled = Assert.Single(registry.Snapshot.Entries);
            Assert.Equal(PlatformProviderLifecycleState.Pending, reinstalled.State);
            Assert.Null(registry.TryRelease(AlphaId, reinstalled.Fingerprint!, reinstalled.Generation));
        }
        finally
        {
            Directory.Delete(temporaryRoot, recursive: true);
        }
    }

    [Fact]
    public async Task ExactFixtureApprovalCannotAuthorizeIndependentPeer()
    {
        var alpha = await AcquireAlphaAsync(
            PackageRoot("Jellyfin.Plugin.CanopyConformance.Alpha"),
            new Version(1, 0, 0, 0));
        var omega = await AcquireAsync(
            OmegaId,
            "ZZZ Canopy Conformance Omega",
            "Jellyfin.Plugin.CanopyConformance.Omega");
        var registry = Registry();
        Assert.Equal(
            PlatformProviderRegistryMutationStatus.Applied,
            registry.Reconcile(registry.BeginReconciliation(), Completed(alpha, omega)).Status);
        var alphaEntry = registry.Snapshot.Entries.Single(value => value.PluginId == AlphaId);
        var omegaEntry = registry.Snapshot.Entries.Single(value => value.PluginId == OmegaId);

        Assert.Equal(
            PlatformProviderRegistryMutationStatus.Applied,
            registry.Apply(
                PlatformProviderAdminCommand.Approve(
                    registry.Snapshot.Revision,
                    AlphaId,
                    alphaEntry.Generation,
                    alphaEntry.Fingerprint!,
                    new[] { "jellyfin.canopy.items.lookup" },
                    "Approve exact independent Alpha fixture"),
                AdminAuthorization()).Status);

        alphaEntry = registry.Snapshot.Entries.Single(value => value.PluginId == AlphaId);
        Assert.NotNull(registry.TryRelease(AlphaId, alphaEntry.Fingerprint!, alphaEntry.Generation));
        Assert.Null(registry.TryRelease(OmegaId, alphaEntry.Fingerprint!, alphaEntry.Generation));
        Assert.Null(registry.TryRelease(AlphaId, omegaEntry.Fingerprint!, omegaEntry.Generation));
        Assert.Null(registry.TryRelease(OmegaId, omegaEntry.Fingerprint!, omegaEntry.Generation));
    }

    private static async Task<PlatformInstalledManifestObservation> AcquireAsync(
        Guid pluginId,
        string name,
        string assembly,
        string? root = null,
        Version? version = null,
        PlatformInstalledPluginHostStatus status = PlatformInstalledPluginHostStatus.Active)
    {
        root ??= PackageRoot(assembly);
        var snapshot = PlatformInstalledManifestBindingTests.Snapshot(
            pluginId: pluginId,
            name: name,
            version: version ?? new Version(1, 0, 0, 0),
            status: status,
            root: root,
            dllFiles: new[] { Path.Combine(root, assembly + ".dll") });
        var read = await new PlatformInstalledManifestFileReader().ReadAsync(
            snapshot,
            CancellationToken.None);
        return PlatformInstalledManifestBinder.Bind(snapshot, snapshot, read);
    }

    private static Task<PlatformInstalledManifestObservation> AcquireAlphaAsync(
        string root,
        Version version,
        PlatformInstalledPluginHostStatus status = PlatformInstalledPluginHostStatus.Active) =>
        AcquireAsync(
            AlphaId,
            "AAA Canopy Conformance Alpha",
            "Jellyfin.Plugin.CanopyConformance.Alpha",
            root,
            version,
            status);

    private static PlatformProviderRegistry Registry() =>
        new(new MemoryStore(), TimeProvider.System);

    private static async Task<ProductionOrderResult> RunProductionOrderAsync(bool reverse)
    {
        var alphaRoot = PackageRoot("Jellyfin.Plugin.CanopyConformance.Alpha");
        var omegaRoot = PackageRoot("Jellyfin.Plugin.CanopyConformance.Omega");
        var snapshots = new[]
        {
            PlatformInstalledManifestBindingTests.Snapshot(
                pluginId: AlphaId,
                name: "AAA Canopy Conformance Alpha",
                version: new Version(1, 0, 0, 0),
                root: alphaRoot,
                dllFiles: new[]
                {
                    Path.Combine(alphaRoot, "Jellyfin.Plugin.CanopyConformance.Alpha.dll"),
                }),
            PlatformInstalledManifestBindingTests.Snapshot(
                pluginId: OmegaId,
                name: "ZZZ Canopy Conformance Omega",
                version: new Version(1, 0, 0, 0),
                root: omegaRoot,
                dllFiles: new[]
                {
                    Path.Combine(omegaRoot, "Jellyfin.Plugin.CanopyConformance.Omega.dll"),
                }),
        };
        if (reverse)
        {
            Array.Reverse(snapshots);
        }

        var host = new FixtureHost(snapshots);
        var acquisition = new PlatformInstalledManifestAcquisition(
            host,
            new PlatformInstalledManifestFileReader());
        var registry = Registry();
        var orchestrator = new PlatformProviderRegistryOrchestrator(acquisition, registry);
        var result = await orchestrator.ReconcileAsync(CancellationToken.None);
        Assert.Equal(PlatformProviderRegistryOrchestrationStatus.Applied, result.Status);
        return new ProductionOrderResult(host, registry);
    }

    private static PlatformInstalledManifestSweep Completed(
        params PlatformInstalledManifestObservation[] observations) =>
        PlatformInstalledManifestSweep.EstablishCompleted(observations.ToImmutableArray());

    private static string Project(PlatformProviderRegistryEntry entry) =>
        $"{entry.PluginId:D}|{entry.Generation}|{entry.State}|{entry.Fingerprint}";

    private static string CopyPackage(string assembly, string destinationRoot)
    {
        var destination = Path.Combine(destinationRoot, assembly);
        Directory.CreateDirectory(destination);
        foreach (var file in Directory.EnumerateFiles(PackageRoot(assembly)))
        {
            File.Copy(file, Path.Combine(destination, Path.GetFileName(file)));
        }

        return destination;
    }

    private static string PackageRoot(string assembly) =>
        Path.Combine(
            RepositoryRoot(),
            "conformance",
            "platform-providers",
            assembly,
            "bin",
            "Release",
            "net10.0",
            "package");

    private static PlatformProviderAdminAuthorization AdminAuthorization()
    {
        var actor = PlatformActorTestFactory.Create(
            AdminId,
            isElevated: true,
            "fixture-registry-test",
            "test-client",
            "test-device");
        return Assert.IsType<PlatformProviderAdminAuthorization>(
            PlatformProviderRegistryAdminBoundary.ReauthorizeElevatedAdministrator(
                actor,
                new AdminHost()));
    }

    private static string RepositoryRoot([CallerFilePath] string sourceFile = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(sourceFile)!, "..", ".."));

    private sealed class MemoryStore : IPlatformProviderRegistryStateStore
    {
        private PlatformProviderRegistryDurableState _state = PlatformProviderRegistryDurableState.Empty;

        public PlatformProviderRegistryStoreLoadResult Load() =>
            PlatformProviderRegistryStoreLoadResult.Healthy(_state);

        public void Save(PlatformProviderRegistryDurableState state) => _state = state;

        public void ResetQuarantined(Guid administratorId, string reason, DateTimeOffset decidedAtUtc) =>
            _state = PlatformProviderRegistryDurableState.Empty;

        public void FenceQuarantined()
        {
        }
    }

    private sealed class FixtureHost : IHostPlugins
    {
        private readonly IReadOnlyList<PlatformInstalledPluginSnapshot> _snapshots;

        internal FixtureHost(IReadOnlyList<PlatformInstalledPluginSnapshot> snapshots) =>
            _snapshots = snapshots;

        internal int InventoryReads { get; private set; }

        internal int ReobservationReads { get; private set; }

        public IReadOnlyList<HostPlugin> Installed() => [];

        public HostPlugin? Find(Guid id) => null;

        IReadOnlyList<PlatformInstalledPluginSnapshot> IHostPlugins.InstalledSnapshots()
        {
            InventoryReads++;
            return _snapshots;
        }

        PlatformInstalledPluginSnapshot? IHostPlugins.FindSnapshot(Guid id)
        {
            ReobservationReads++;
            return _snapshots.SingleOrDefault(value => value.PluginId == id);
        }
    }

    private sealed record ProductionOrderResult(
        FixtureHost Host,
        PlatformProviderRegistry Registry);

    private sealed class AdminHost : IPlatformHost, IHostUsers
    {
        public IHostUsers Users => this;

        public IHostLibrary Library => throw new NotSupportedException();

        public IHostSessions Sessions => throw new NotSupportedException();

        public IHostPlugins Plugins => throw new NotSupportedException();

        public HostUser? Find(Guid id) => id == AdminId
            ? new HostUser(AdminId, "Fixture registry administrator", true)
            : null;

        public IReadOnlyList<HostUser> All() => [];
    }
}
