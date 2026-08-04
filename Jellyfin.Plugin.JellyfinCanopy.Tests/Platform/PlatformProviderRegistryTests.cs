using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

public sealed class PlatformProviderRegistryTests
{
    private static readonly Guid PluginId = new("11111111-2222-3333-4444-555555555555");
    private static readonly Guid AdminId = new("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    private static readonly DateTimeOffset Now = new(2026, 8, 4, 2, 0, 0, TimeSpan.Zero);
    private static readonly string[] Requested =
    {
        "jellyfin.canopy.items.lookup",
        "jellyfin.canopy.storage.read",
    };

    [Fact]
    public void DiscoveryIsInertUntilExactElevatedApprovalCommits()
    {
        var store = new RecordingStore();
        var registry = Registry(store);

        var reconcile = registry.Reconcile(Completed(Acquired()));

        Assert.Equal(PlatformProviderRegistryMutationStatus.Applied, reconcile.Status);
        var pending = AssertEntry(registry, PlatformProviderLifecycleState.Pending);
        Assert.Equal(1, pending.Generation);
        Assert.Equal(Requested, pending.RequestedCapabilityIds);
        Assert.Null(registry.TryRelease(PluginId, pending.Fingerprint!, pending.Generation));

        var approval = registry.Apply(
            PlatformProviderAdminCommand.Approve(
                expectedRevision: registry.Snapshot.Revision,
                pluginId: PluginId,
                expectedGeneration: pending.Generation,
                expectedFingerprint: pending.Fingerprint!,
                grantedCapabilityIds: new[] { "jellyfin.canopy.items.lookup" },
                reason: "Reviewed provider manifest"),
            AdminAuthorization(currentlyElevated: true));

        Assert.Equal(PlatformProviderRegistryMutationStatus.Applied, approval.Status);
        var enabled = AssertEntry(registry, PlatformProviderLifecycleState.Enabled);
        var release = Assert.IsType<PlatformProviderAuthorityRelease>(
            registry.TryRelease(PluginId, enabled.Fingerprint!, enabled.Generation));
        Assert.Equal(PluginId, release.Identity.InstalledPluginId.Value);
        Assert.Equal(enabled.Fingerprint, release.Identity.ManifestFingerprint.Value);
        Assert.Equal(enabled.Generation, release.Identity.ProviderGeneration.Value);
        Assert.Equal(new[] { "jellyfin.canopy.items.lookup" }, release.GrantedCapabilityIds);
        Assert.Equal(2, store.SaveCount);
    }

    [Fact]
    public void CompleteMixedSweepPublishesEveryPeerInCanonicalOrder()
    {
        var lower = new Guid("01111111-2222-3333-4444-555555555555");
        var rejected = new Guid("21111111-2222-3333-4444-555555555555");
        var registry = Registry(new RecordingStore());

        var result = registry.Reconcile(Completed(
            Rejected(
                PlatformInstalledPluginHostStatus.Active,
                PlatformInstalledManifestOutcome.ManifestRejected,
                rejected),
            Acquired(),
            Acquired(pluginId: lower)));

        Assert.Equal(PlatformProviderRegistryMutationStatus.Applied, result.Status);
        Assert.Equal(
            new[] { lower, PluginId, rejected },
            registry.Snapshot.Entries.Select(entry => entry.PluginId));
        Assert.Equal(
            new[]
            {
                PlatformProviderLifecycleState.Pending,
                PlatformProviderLifecycleState.Pending,
                PlatformProviderLifecycleState.Quarantined,
            },
            registry.Snapshot.Entries.Select(entry => entry.State));
        Assert.All(registry.Snapshot.Entries, entry =>
            Assert.Null(registry.TryRelease(
                entry.PluginId,
                entry.Fingerprint ?? new string('0', 64),
                entry.Generation)));
    }

    [Fact]
    public void CapacityConflictWithStickyRevocationsQuarantinesAllOldAuthority()
    {
        var store = new RecordingStore();
        var secondOldId = new Guid("31111111-2222-3333-4444-555555555555");
        var oldA = Acquired();
        var oldB = Acquired(pluginId: secondOldId);
        var records = ImmutableArray.CreateBuilder<PlatformProviderRegistryDurableRecord>(
            PlatformProviderRegistry.MaximumProviderCount);
        for (var index = 1; index <= PlatformProviderRegistry.MaximumProviderCount - 2; index++)
        {
            records.Add(RevokedTombstone(new Guid(index, 0, 0, new byte[8])));
        }

        records.Add(ApprovedRecord(oldA));
        records.Add(ApprovedRecord(oldB));
        store.Seed(new PlatformProviderRegistryDurableState(1, records.ToImmutable()));
        var registry = Registry(store);
        registry.Reconcile(Completed(oldA, oldB));
        var enabledA = registry.Snapshot.Entries.Single(entry => entry.PluginId == PluginId);
        var enabledB = registry.Snapshot.Entries.Single(entry => entry.PluginId == secondOldId);
        Assert.NotNull(registry.TryRelease(PluginId, enabledA.Fingerprint!, enabledA.Generation));
        Assert.NotNull(registry.TryRelease(secondOldId, enabledB.Fingerprint!, enabledB.Generation));

        var result = registry.Reconcile(Completed(
            Acquired(pluginId: new Guid("41111111-2222-3333-4444-555555555555")),
            Acquired(pluginId: new Guid("51111111-2222-3333-4444-555555555555")),
            Acquired(pluginId: new Guid("61111111-2222-3333-4444-555555555555"))));

        Assert.Equal(PlatformProviderRegistryMutationStatus.StoreQuarantined, result.Status);
        Assert.True(store.WasFenced);
        Assert.Equal(PlatformProviderRegistryStoreHealth.Quarantined, registry.Snapshot.StoreHealth);
        Assert.Empty(registry.Snapshot.Entries);
        Assert.Null(registry.TryRelease(PluginId, enabledA.Fingerprint!, enabledA.Generation));
        Assert.Null(registry.TryRelease(secondOldId, enabledB.Fingerprint!, enabledB.Generation));
    }

    [Fact]
    public void FailedCapacityFencePreservesPublishedSnapshotButDeniesLiveAuthority()
    {
        var store = new RecordingStore();
        var old = Acquired();
        var records = ImmutableArray.CreateBuilder<PlatformProviderRegistryDurableRecord>(
            PlatformProviderRegistry.MaximumProviderCount);
        for (var index = 1; index < PlatformProviderRegistry.MaximumProviderCount; index++)
        {
            records.Add(RevokedTombstone(new Guid(index, 0, 0, new byte[8])));
        }

        records.Add(ApprovedRecord(old));
        store.Seed(new PlatformProviderRegistryDurableState(1, records.ToImmutable()));
        var registry = Registry(store);
        registry.Reconcile(Completed(old));
        var before = registry.Snapshot;
        var enabled = before.Entries.Single(entry => entry.PluginId == PluginId);
        Assert.NotNull(registry.TryRelease(PluginId, enabled.Fingerprint!, enabled.Generation));
        store.ThrowOnSave = true;

        var result = registry.Reconcile(Completed(
            Acquired(pluginId: new Guid("41111111-2222-3333-4444-555555555555")),
            Acquired(pluginId: new Guid("51111111-2222-3333-4444-555555555555"))));

        Assert.Equal(PlatformProviderRegistryMutationStatus.PersistenceFailed, result.Status);
        Assert.Same(before, registry.Snapshot);
        Assert.False(store.WasFenced);
        Assert.Null(registry.TryRelease(PluginId, enabled.Fingerprint!, enabled.Generation));
    }

    [Fact]
    public void InvalidCompletedInventoryPreservesSnapshotButFencesAuthorityUntilValidReconcile()
    {
        var registry = Registry(new RecordingStore());
        var acquired = Acquired();
        registry.Reconcile(Completed(acquired));
        ApproveCurrent(registry);
        var before = registry.Snapshot;
        var enabled = Assert.Single(before.Entries);
        Assert.NotNull(registry.TryRelease(PluginId, enabled.Fingerprint!, enabled.Generation));

        var invalid = registry.Reconcile(Completed(acquired, acquired));

        Assert.Equal(PlatformProviderRegistryMutationStatus.InvalidSweep, invalid.Status);
        Assert.Same(before, registry.Snapshot);
        Assert.Null(registry.TryRelease(PluginId, enabled.Fingerprint!, enabled.Generation));

        Assert.Equal(
            PlatformProviderRegistryMutationStatus.Applied,
            registry.Reconcile(Completed(acquired)).Status);
        var restored = Assert.Single(registry.Snapshot.Entries);
        Assert.NotNull(registry.TryRelease(PluginId, restored.Fingerprint!, restored.Generation));
    }

    [Fact]
    public void NonElevatedAndStaleCommandsHaveNoMemoryOrDiskEffect()
    {
        var store = new RecordingStore();
        var registry = Registry(store);
        registry.Reconcile(Completed(Acquired()));
        var before = registry.Snapshot;
        var entry = Assert.Single(before.Entries);
        var durableBefore = store.LastSaved;

        var nonAdmin = registry.Apply(
            PlatformProviderAdminCommand.Approve(
                before.Revision,
                PluginId,
                entry.Generation,
                entry.Fingerprint!,
                new[] { "jellyfin.canopy.items.lookup" },
                "No authority"),
            AdminAuthorization(currentlyElevated: false));
        var stale = registry.Apply(
            PlatformProviderAdminCommand.Approve(
                before.Revision - 1,
                PluginId,
                entry.Generation,
                entry.Fingerprint!,
                new[] { "jellyfin.canopy.items.lookup" },
                "Stale authority"),
            AdminAuthorization(currentlyElevated: true));

        Assert.Equal(PlatformProviderRegistryMutationStatus.ElevationRequired, nonAdmin.Status);
        Assert.Equal(PlatformProviderRegistryMutationStatus.StaleRevision, stale.Status);
        Assert.Same(before, registry.Snapshot);
        Assert.Same(durableBefore, store.LastSaved);
        Assert.Equal(1, store.SaveCount);
    }

    [Fact]
    public void StaleFingerprintGenerationAndInvalidReasonHaveNoMemoryOrDiskEffect()
    {
        var store = new RecordingStore();
        var registry = Registry(store);
        registry.Reconcile(Completed(Acquired()));
        var before = registry.Snapshot;
        var entry = Assert.Single(before.Entries);
        var durableBefore = store.LastSaved;

        var staleFingerprint = registry.Apply(
            PlatformProviderAdminCommand.Approve(
                before.Revision,
                PluginId,
                entry.Generation,
                new string('a', 64),
                new[] { "jellyfin.canopy.items.lookup" },
                "Stale fingerprint"),
            AdminAuthorization(currentlyElevated: true));
        var staleGeneration = registry.Apply(
            PlatformProviderAdminCommand.Approve(
                before.Revision,
                PluginId,
                entry.Generation + 1,
                entry.Fingerprint!,
                new[] { "jellyfin.canopy.items.lookup" },
                "Stale generation"),
            AdminAuthorization(currentlyElevated: true));
        var invalidReason = registry.Apply(
            PlatformProviderAdminCommand.Approve(
                before.Revision,
                PluginId,
                entry.Generation,
                entry.Fingerprint!,
                new[] { "jellyfin.canopy.items.lookup" },
                " "),
            AdminAuthorization(currentlyElevated: true));

        Assert.Equal(PlatformProviderRegistryMutationStatus.StaleProvider, staleFingerprint.Status);
        Assert.Equal(PlatformProviderRegistryMutationStatus.StaleProvider, staleGeneration.Status);
        Assert.Equal(PlatformProviderRegistryMutationStatus.InvalidCommand, invalidReason.Status);
        Assert.Same(before, registry.Snapshot);
        Assert.Same(durableBefore, store.LastSaved);
        Assert.Equal(1, store.SaveCount);
    }

    [Theory]
    [MemberData(nameof(InvalidGrantCases))]
    public void InvalidGrantSetsFailClosedWithoutPublishing(
        IReadOnlyList<string> grants,
        int expectedValue)
    {
        var store = new RecordingStore();
        var registry = Registry(store);
        registry.Reconcile(Completed(Acquired()));
        var before = registry.Snapshot;
        var entry = Assert.Single(before.Entries);

        var result = registry.Apply(
            PlatformProviderAdminCommand.Approve(
                before.Revision,
                PluginId,
                entry.Generation,
                entry.Fingerprint!,
                grants,
                "Invalid grant"),
            AdminAuthorization(currentlyElevated: true));

        Assert.Equal((PlatformProviderRegistryMutationStatus)expectedValue, result.Status);
        Assert.Same(before, registry.Snapshot);
        Assert.Equal(1, store.SaveCount);
    }

    [Fact]
    public void FingerprintDriftAndReversionAdvanceGenerationAndRetireAuthority()
    {
        var store = new RecordingStore();
        var registry = Registry(store);
        registry.Reconcile(Completed(Acquired()));
        ApproveCurrent(registry);
        var approved = AssertEntry(registry, PlatformProviderLifecycleState.Enabled);

        registry.Reconcile(Completed(Acquired(
            version: "1.2.3.5",
            hostVersion: new Version(1, 2, 3, 5))));

        var changed = AssertEntry(registry, PlatformProviderLifecycleState.Pending);
        Assert.Equal(approved.Generation + 1, changed.Generation);
        Assert.Null(changed.ApprovedFingerprint);
        Assert.Empty(changed.GrantedCapabilityIds);
        Assert.Null(registry.TryRelease(PluginId, approved.Fingerprint!, approved.Generation));

        registry.Reconcile(Completed(Acquired()));

        var reverted = AssertEntry(registry, PlatformProviderLifecycleState.Pending);
        Assert.Equal(changed.Generation + 1, reverted.Generation);
        Assert.Equal(approved.Fingerprint, reverted.Fingerprint);
        Assert.Null(registry.TryRelease(PluginId, reverted.Fingerprint!, reverted.Generation));
    }

    [Fact]
    public void CompleteAbsenceAndSameFingerprintReinstallNeverAutoApprove()
    {
        var store = new RecordingStore();
        var registry = Registry(store);
        registry.Reconcile(Completed(Acquired()));
        ApproveCurrent(registry);
        var enabled = AssertEntry(registry, PlatformProviderLifecycleState.Enabled);

        registry.Reconcile(Completed());

        var absent = AssertEntry(registry, PlatformProviderLifecycleState.Absent);
        Assert.Equal(enabled.Generation + 1, absent.Generation);
        Assert.Null(absent.ApprovedFingerprint);
        Assert.Empty(absent.GrantedCapabilityIds);

        registry.Reconcile(Completed(Acquired()));

        var reinstalled = AssertEntry(registry, PlatformProviderLifecycleState.Pending);
        Assert.Equal(absent.Generation + 1, reinstalled.Generation);
        Assert.Null(registry.TryRelease(PluginId, reinstalled.Fingerprint!, reinstalled.Generation));
    }

    [Fact]
    public void RevocationIsStickyAcrossAbsenceAndReinstall()
    {
        var store = new RecordingStore();
        var registry = Registry(store);
        registry.Reconcile(Completed(Acquired()));
        ApproveCurrent(registry);
        var enabled = AssertEntry(registry, PlatformProviderLifecycleState.Enabled);

        var revoked = registry.Apply(
            PlatformProviderAdminCommand.Revoke(
                registry.Snapshot.Revision,
                PluginId,
                enabled.Generation,
                enabled.Fingerprint!,
                "Security revocation"),
            AdminAuthorization(currentlyElevated: true));
        Assert.Equal(PlatformProviderRegistryMutationStatus.Applied, revoked.Status);
        AssertEntry(registry, PlatformProviderLifecycleState.Revoked);

        registry.Reconcile(Completed());
        registry.Reconcile(Completed(Acquired()));

        var reinstalled = AssertEntry(registry, PlatformProviderLifecycleState.Revoked);
        Assert.Null(registry.TryRelease(PluginId, reinstalled.Fingerprint!, reinstalled.Generation));
    }

    [Fact]
    public void FailedDurableWriteLeavesPublishedSnapshotAndAuthorityUnchanged()
    {
        var store = new RecordingStore();
        var registry = Registry(store);
        registry.Reconcile(Completed(Acquired()));
        var before = registry.Snapshot;
        var entry = Assert.Single(before.Entries);
        store.ThrowOnSave = true;

        var result = registry.Apply(
            PlatformProviderAdminCommand.Approve(
                before.Revision,
                PluginId,
                entry.Generation,
                entry.Fingerprint!,
                new[] { "jellyfin.canopy.items.lookup" },
                "Write must fail"),
            AdminAuthorization(currentlyElevated: true));

        Assert.Equal(PlatformProviderRegistryMutationStatus.PersistenceFailed, result.Status);
        Assert.Same(before, registry.Snapshot);
        Assert.Null(registry.TryRelease(PluginId, entry.Fingerprint!, entry.Generation));
    }

    [Fact]
    public void FailedReconcileWriteKeepsPriorSnapshotButFencesLiveAuthority()
    {
        var store = new RecordingStore();
        var registry = Registry(store);
        registry.Reconcile(Completed(Acquired()));
        ApproveCurrent(registry);
        var before = registry.Snapshot;
        var enabled = Assert.Single(before.Entries);
        var durableBefore = store.LastSaved;
        store.ThrowOnSave = true;

        var result = registry.Reconcile(Completed(Acquired(
            version: "1.2.3.5",
            hostVersion: new Version(1, 2, 3, 5))));

        Assert.Equal(PlatformProviderRegistryMutationStatus.PersistenceFailed, result.Status);
        Assert.Same(before, registry.Snapshot);
        Assert.Same(durableBefore, store.LastSaved);
        Assert.Null(registry.TryRelease(PluginId, enabled.Fingerprint!, enabled.Generation));
    }

    [Fact]
    public void PublishedSnapshotsRemainImmutableAcrossLaterMutations()
    {
        var registry = Registry(new RecordingStore());
        registry.Reconcile(Completed(Acquired()));
        var oldSnapshot = registry.Snapshot;
        var oldEntry = Assert.Single(oldSnapshot.Entries);

        ApproveCurrent(registry);
        registry.Reconcile(Completed(Acquired(version: "1.2.3.5", hostVersion: new Version(1, 2, 3, 5))));

        Assert.Equal(1, oldSnapshot.Revision);
        Assert.Same(oldEntry, Assert.Single(oldSnapshot.Entries));
        Assert.Equal(PlatformProviderLifecycleState.Pending, oldEntry.State);
        Assert.Equal(1, oldEntry.Generation);
        Assert.Null(oldEntry.ApprovedFingerprint);
        Assert.Empty(oldEntry.GrantedCapabilityIds);
    }

    [Fact]
    public void RestartHydratesDormantAndRequiresFreshExactObservation()
    {
        var store = new RecordingStore();
        var first = Registry(store);
        first.Reconcile(Completed(Acquired()));
        ApproveCurrent(first);
        var enabled = AssertEntry(first, PlatformProviderLifecycleState.Enabled);

        var restarted = Registry(store);

        var dormant = AssertEntry(restarted, PlatformProviderLifecycleState.Absent);
        Assert.Equal(enabled.Generation, dormant.Generation);
        Assert.Null(restarted.TryRelease(PluginId, enabled.Fingerprint!, enabled.Generation));

        restarted.Reconcile(Completed(Acquired()));

        var restored = AssertEntry(restarted, PlatformProviderLifecycleState.Enabled);
        Assert.Equal(enabled.Generation, restored.Generation);
        Assert.NotNull(restarted.TryRelease(PluginId, restored.Fingerprint!, restored.Generation));
    }

    [Theory]
    [InlineData((int)PlatformInstalledPluginHostStatus.Restart, (int)PlatformProviderLifecycleState.RestartPending)]
    [InlineData((int)PlatformInstalledPluginHostStatus.Disabled, (int)PlatformProviderLifecycleState.Disabled)]
    [InlineData((int)PlatformInstalledPluginHostStatus.NotSupported, (int)PlatformProviderLifecycleState.Incompatible)]
    [InlineData((int)PlatformInstalledPluginHostStatus.Malfunctioned, (int)PlatformProviderLifecycleState.Quarantined)]
    [InlineData((int)PlatformInstalledPluginHostStatus.Superseded, (int)PlatformProviderLifecycleState.Quarantined)]
    [InlineData((int)PlatformInstalledPluginHostStatus.Deleted, (int)PlatformProviderLifecycleState.Absent)]
    [InlineData(999, (int)PlatformProviderLifecycleState.Quarantined)]
    public void HostStatusesRemainClosedAndNeverReleaseAuthority(int hostStatusValue, int stateValue)
    {
        var registry = Registry(new RecordingStore());

        registry.Reconcile(Completed(Rejected(
            (PlatformInstalledPluginHostStatus)hostStatusValue,
            PlatformInstalledManifestOutcome.HostStatusNotActive)));

        var entry = AssertEntry(registry, (PlatformProviderLifecycleState)stateValue);
        Assert.Null(registry.TryRelease(PluginId, entry.Fingerprint ?? new string('0', 64), entry.Generation));
    }

    [Theory]
    [InlineData((int)PlatformInstalledManifestCompatibility.PlatformIncompatible)]
    [InlineData((int)PlatformInstalledManifestCompatibility.HostIncompatible)]
    public void EveryIncompatibleBoundObservationIsInert(int compatibilityValue)
    {
        var registry = Registry(new RecordingStore());
        var compatibility = (PlatformInstalledManifestCompatibility)compatibilityValue;
        var observation = compatibility == PlatformInstalledManifestCompatibility.PlatformIncompatible
            ? Acquired(platformMin: 2, platformMax: 2)
            : Acquired(hostMin: 13, hostMax: 13);

        registry.Reconcile(Completed(observation));

        var entry = AssertEntry(registry, PlatformProviderLifecycleState.Incompatible);
        Assert.Null(registry.TryRelease(PluginId, entry.Fingerprint!, entry.Generation));
    }

    [Theory]
    [InlineData((int)PlatformInstalledManifestOutcome.ManifestAbsent)]
    [InlineData((int)PlatformInstalledManifestOutcome.HostMetadataInvalid)]
    [InlineData((int)PlatformInstalledManifestOutcome.AmbiguousHostIdentity)]
    [InlineData((int)PlatformInstalledManifestOutcome.HostStatusNotActive)]
    [InlineData((int)PlatformInstalledManifestOutcome.UnsafeOrUnverifiableRoot)]
    [InlineData((int)PlatformInstalledManifestOutcome.UnsafeTarget)]
    [InlineData((int)PlatformInstalledManifestOutcome.OpenTimedOut)]
    [InlineData((int)PlatformInstalledManifestOutcome.NotRegularFile)]
    [InlineData((int)PlatformInstalledManifestOutcome.DescriptorUnverifiable)]
    [InlineData((int)PlatformInstalledManifestOutcome.DocumentTooLarge)]
    [InlineData((int)PlatformInstalledManifestOutcome.ReadChanged)]
    [InlineData((int)PlatformInstalledManifestOutcome.ReadFailed)]
    [InlineData((int)PlatformInstalledManifestOutcome.ManifestRejected)]
    [InlineData((int)PlatformInstalledManifestOutcome.PluginIdMismatch)]
    [InlineData((int)PlatformInstalledManifestOutcome.PluginVersionMismatch)]
    [InlineData((int)PlatformInstalledManifestOutcome.AssemblyUnavailable)]
    [InlineData((int)PlatformInstalledManifestOutcome.AssemblyMismatch)]
    [InlineData((int)PlatformInstalledManifestOutcome.HostSnapshotChanged)]
    [InlineData((int)PlatformInstalledManifestOutcome.AcquisitionFailed)]
    public void EveryRejectedActiveObservationIsQuarantinedAndInert(int outcomeValue)
    {
        var registry = Registry(new RecordingStore());

        registry.Reconcile(Completed(Rejected(
            PlatformInstalledPluginHostStatus.Active,
            (PlatformInstalledManifestOutcome)outcomeValue)));

        var entry = AssertEntry(registry, PlatformProviderLifecycleState.Quarantined);
        Assert.Null(entry.Fingerprint);
        Assert.Null(registry.TryRelease(PluginId, new string('0', 64), entry.Generation));
    }

    [Fact]
    public void CanonicalCapabilityReorderingPreservesFingerprintGenerationAndApproval()
    {
        var registry = Registry(new RecordingStore());
        registry.Reconcile(Completed(Acquired(capabilities: Requested)));
        ApproveCurrent(registry);
        var before = AssertEntry(registry, PlatformProviderLifecycleState.Enabled);

        registry.Reconcile(Completed(Acquired(capabilities: Requested.Reverse().ToArray())));

        var after = AssertEntry(registry, PlatformProviderLifecycleState.Enabled);
        Assert.Equal(before.Fingerprint, after.Fingerprint);
        Assert.Equal(before.Generation, after.Generation);
        Assert.NotNull(registry.TryRelease(PluginId, after.Fingerprint!, after.Generation));
    }

    [Fact]
    public void GrantReplacementDisableAndEnableAreDurableExactTransitions()
    {
        var registry = Registry(new RecordingStore());
        registry.Reconcile(Completed(Acquired()));
        ApproveCurrent(registry);
        var enabled = AssertEntry(registry, PlatformProviderLifecycleState.Enabled);

        Assert.Equal(
            PlatformProviderRegistryMutationStatus.Applied,
            registry.Apply(
                PlatformProviderAdminCommand.ReplaceGrant(
                    registry.Snapshot.Revision,
                    PluginId,
                    enabled.Generation,
                    enabled.Fingerprint!,
                    Array.Empty<string>(),
                    "Remove current grants"),
                AdminAuthorization(currentlyElevated: true)).Status);
        var emptyGrant = Assert.IsType<PlatformProviderAuthorityRelease>(
            registry.TryRelease(
                PluginId,
                enabled.Fingerprint!,
                AssertEntry(registry, PlatformProviderLifecycleState.Enabled).Generation));
        Assert.Empty(emptyGrant.GrantedCapabilityIds);

        var grantReplaced = AssertEntry(registry, PlatformProviderLifecycleState.Enabled);
        Assert.Equal(enabled.Generation + 1, grantReplaced.Generation);

        Assert.Equal(
            PlatformProviderRegistryMutationStatus.Applied,
            registry.Apply(
                PlatformProviderAdminCommand.Disable(
                    registry.Snapshot.Revision,
                    PluginId,
                    grantReplaced.Generation,
                    enabled.Fingerprint!,
                    "Administrative disable"),
                AdminAuthorization(currentlyElevated: true)).Status);
        AssertEntry(registry, PlatformProviderLifecycleState.Disabled);
        var disabled = AssertEntry(registry, PlatformProviderLifecycleState.Disabled);
        Assert.Equal(grantReplaced.Generation + 1, disabled.Generation);
        Assert.Null(registry.TryRelease(PluginId, enabled.Fingerprint!, grantReplaced.Generation));

        Assert.Equal(
            PlatformProviderRegistryMutationStatus.Applied,
            registry.Apply(
                PlatformProviderAdminCommand.Enable(
                    registry.Snapshot.Revision,
                    PluginId,
                    disabled.Generation,
                    enabled.Fingerprint!,
                    "Administrative enable"),
                AdminAuthorization(currentlyElevated: true)).Status);
        var reenabled = AssertEntry(registry, PlatformProviderLifecycleState.Enabled);
        Assert.Equal(disabled.Generation + 1, reenabled.Generation);
    }

    [Theory]
    [InlineData((int)PlatformInstalledPluginHostStatus.Restart)]
    [InlineData((int)PlatformInstalledPluginHostStatus.Disabled)]
    public void DormantHostStateCannotRestoreApprovalAcrossAssemblyDrift(int hostStatusValue)
    {
        var registry = Registry(new RecordingStore());
        registry.Reconcile(Completed(Acquired(assemblyIdentity: "Example.Provider, Hash=A")));
        ApproveCurrent(registry);
        var approved = AssertEntry(registry, PlatformProviderLifecycleState.Enabled);

        registry.Reconcile(Completed(Rejected(
            (PlatformInstalledPluginHostStatus)hostStatusValue,
            PlatformInstalledManifestOutcome.HostStatusNotActive)));
        var dormant = Assert.Single(registry.Snapshot.Entries);
        Assert.Contains(
            dormant.State,
            new[] { PlatformProviderLifecycleState.RestartPending, PlatformProviderLifecycleState.Disabled });

        registry.Reconcile(Completed(Acquired(assemblyIdentity: "Example.Provider, Hash=B")));

        var changed = AssertEntry(registry, PlatformProviderLifecycleState.Pending);
        Assert.True(changed.Generation > approved.Generation);
        Assert.Null(changed.ApprovedFingerprint);
        Assert.Empty(changed.GrantedCapabilityIds);
        Assert.Null(registry.TryRelease(PluginId, changed.Fingerprint!, changed.Generation));
    }

    [Theory]
    [InlineData((int)PlatformInstalledPluginHostStatus.Restart)]
    [InlineData((int)PlatformInstalledPluginHostStatus.Disabled)]
    public void DormantApprovedProviderCanBeExplicitlyRevoked(int hostStatusValue)
    {
        var registry = Registry(new RecordingStore());
        registry.Reconcile(Completed(Acquired()));
        ApproveCurrent(registry);
        registry.Reconcile(Completed(Rejected(
            (PlatformInstalledPluginHostStatus)hostStatusValue,
            PlatformInstalledManifestOutcome.HostStatusNotActive)));
        var dormant = Assert.Single(registry.Snapshot.Entries);

        var result = registry.Apply(
            PlatformProviderAdminCommand.Revoke(
                registry.Snapshot.Revision,
                PluginId,
                dormant.Generation,
                dormant.ApprovedFingerprint!,
                "Revoke while host is inactive"),
            AdminAuthorization(currentlyElevated: true));

        Assert.Equal(PlatformProviderRegistryMutationStatus.Applied, result.Status);
        var revoked = AssertEntry(registry, PlatformProviderLifecycleState.Revoked);
        Assert.Equal(dormant.Generation + 1, revoked.Generation);
        Assert.Null(registry.TryRelease(PluginId, dormant.ApprovedFingerprint!, revoked.Generation));
    }

    [Fact]
    public void DeletedOrDemotedCurrentAdministratorCannotUseStaleElevatedActor()
    {
        var boundaryActor = PlatformActorTestFactory.Create(
            AdminId,
            isElevated: true,
            "registry-test",
            "test-client",
            "test-device");
        var deleted = new ReauthorizationHost { Current = null };
        var demoted = new ReauthorizationHost
        {
            Current = new HostUser(AdminId, "Registry admin", false),
        };

        Assert.Null(PlatformProviderRegistryAdminBoundary.ReauthorizeElevatedAdministrator(boundaryActor, deleted));
        Assert.Null(PlatformProviderRegistryAdminBoundary.ReauthorizeElevatedAdministrator(boundaryActor, demoted));
    }

    [Fact]
    public void FreshAdministratorAuthorizationIsSingleUse()
    {
        var registry = Registry(new RecordingStore());
        registry.Reconcile(Completed(Acquired()));
        var before = registry.Snapshot;
        var entry = Assert.Single(before.Entries);
        var authorization = AdminAuthorization(currentlyElevated: true);

        var first = registry.Apply(
            PlatformProviderAdminCommand.Approve(
                before.Revision,
                PluginId,
                entry.Generation,
                entry.Fingerprint!,
                new[] { "jellyfin.canopy.items.lookup" },
                "Fresh approval"),
            authorization);
        var second = registry.Apply(
            PlatformProviderAdminCommand.Disable(
                registry.Snapshot.Revision,
                PluginId,
                entry.Generation,
                entry.Fingerprint!,
                "Reused proof"),
            authorization);

        Assert.Equal(PlatformProviderRegistryMutationStatus.Applied, first.Status);
        Assert.Equal(PlatformProviderRegistryMutationStatus.ElevationRequired, second.Status);
        Assert.Equal(entry.Generation + 1, AssertEntry(registry, PlatformProviderLifecycleState.Enabled).Generation);
    }

    [Fact]
    public void AdministratorDemotedAfterAuthorizationMintCannotUseItOnce()
    {
        var registry = Registry(new RecordingStore());
        registry.Reconcile(Completed(Acquired()));
        var before = registry.Snapshot;
        var entry = Assert.Single(before.Entries);
        var boundaryActor = PlatformActorTestFactory.Create(
            AdminId,
            isElevated: true,
            "registry-test",
            "test-client",
            "test-device");
        var host = new ReauthorizationHost
        {
            Current = new HostUser(AdminId, "Registry admin", true),
        };
        var authorization = PlatformProviderRegistryAdminBoundary.ReauthorizeElevatedAdministrator(
            boundaryActor,
            host);
        host.Current = new HostUser(AdminId, "Registry admin", false);

        var result = registry.Apply(
            PlatformProviderAdminCommand.Approve(
                before.Revision,
                PluginId,
                entry.Generation,
                entry.Fingerprint!,
                new[] { "jellyfin.canopy.items.lookup" },
                "Must recheck elevation"),
            authorization);

        Assert.Equal(PlatformProviderRegistryMutationStatus.ElevationRequired, result.Status);
        Assert.Same(before, registry.Snapshot);
    }

    [Fact]
    public async Task AdministratorWaitingForRegistryLockIsRecheckedAfterDemotion()
    {
        var store = new RecordingStore();
        var registry = Registry(store);
        var acquired = Acquired();
        registry.Reconcile(Completed(acquired));
        var before = registry.Snapshot;
        var entry = Assert.Single(before.Entries);
        using var saveEntered = new ManualResetEventSlim(false);
        using var continueSave = new ManualResetEventSlim(false);
        store.SaveEntered = saveEntered;
        store.ContinueSave = continueSave;
        var holdingMutation = Task.Run(() => registry.Reconcile(Completed(acquired)));
        Assert.True(saveEntered.Wait(TimeSpan.FromSeconds(5)));

        var boundaryActor = PlatformActorTestFactory.Create(
            AdminId,
            isElevated: true,
            "registry-test",
            "test-client",
            "test-device");
        var host = new ReauthorizationHost
        {
            Current = new HostUser(AdminId, "Registry admin", true),
        };
        var authorization = PlatformProviderRegistryAdminBoundary.ReauthorizeElevatedAdministrator(
            boundaryActor,
            host);
        var waitingMutation = Task.Run(() => registry.Apply(
            PlatformProviderAdminCommand.Approve(
                before.Revision,
                PluginId,
                entry.Generation,
                entry.Fingerprint!,
                new[] { "jellyfin.canopy.items.lookup" },
                "Recheck after lock wait"),
            authorization));
        host.Current = new HostUser(AdminId, "Registry admin", false);
        continueSave.Set();

        Assert.Equal(
            PlatformProviderRegistryMutationStatus.Applied,
            (await holdingMutation).Status);
        Assert.Equal(
            PlatformProviderRegistryMutationStatus.ElevationRequired,
            (await waitingMutation).Status);
    }

    [Fact]
    public void ConcurrentExpectedRevisionApprovalsHaveExactlyOneDurableWinner()
    {
        var store = new RecordingStore();
        var registry = Registry(store);
        registry.Reconcile(Completed(Acquired()));
        var before = registry.Snapshot;
        var entry = Assert.Single(before.Entries);
        var results = new ConcurrentBag<PlatformProviderRegistryMutationStatus>();

        Parallel.For(0, 64, index =>
        {
            var result = registry.Apply(
                PlatformProviderAdminCommand.Approve(
                    before.Revision,
                    PluginId,
                    entry.Generation,
                    entry.Fingerprint!,
                    new[] { "jellyfin.canopy.items.lookup" },
                    "Concurrent approval " + index),
                AdminAuthorization(currentlyElevated: true));
            results.Add(result.Status);
        });

        Assert.Equal(1, results.Count(value => value == PlatformProviderRegistryMutationStatus.Applied));
        Assert.Equal(63, results.Count(value => value == PlatformProviderRegistryMutationStatus.StaleRevision));
        Assert.Equal(before.Revision + 1, registry.Snapshot.Revision);
        Assert.Equal(2, store.SaveCount);
        Assert.Equal(
            entry.Generation + 1,
            AssertEntry(registry, PlatformProviderLifecycleState.Enabled).Generation);
    }

    [Fact]
    public async Task ApproveRevokeAndReconcileRacesLinearizeAndFenceStaleAuthority()
    {
        for (var iteration = 0; iteration < 32; iteration++)
        {
            var registry = Registry(new RecordingStore());
            var acquired = Acquired();
            registry.Reconcile(Completed(acquired));
            var before = registry.Snapshot;
            var entry = Assert.Single(before.Entries);
            using var start = new ManualResetEventSlim(false);
            var commands = new[]
            {
                PlatformProviderAdminCommand.Approve(
                    before.Revision,
                    PluginId,
                    entry.Generation,
                    entry.Fingerprint!,
                    new[] { "jellyfin.canopy.items.lookup" },
                    "Concurrent approval"),
                PlatformProviderAdminCommand.Revoke(
                    before.Revision,
                    PluginId,
                    entry.Generation,
                    entry.Fingerprint!,
                    "Concurrent revocation"),
            };
            var adminTasks = commands.Select(command => Task.Run(() =>
            {
                start.Wait();
                return registry.Apply(command, AdminAuthorization(currentlyElevated: true));
            })).ToArray();
            var reconcileTask = Task.Run(() =>
            {
                start.Wait();
                return registry.Reconcile(Completed(acquired));
            });

            start.Set();
            var adminResults = await Task.WhenAll(adminTasks);
            var reconcileResult = await reconcileTask;

            var winners = adminResults.Count(result =>
                result.Status == PlatformProviderRegistryMutationStatus.Applied);
            Assert.InRange(winners, 0, 1);
            Assert.All(
                adminResults.Where(result => result.Status != PlatformProviderRegistryMutationStatus.Applied),
                result => Assert.Equal(PlatformProviderRegistryMutationStatus.StaleRevision, result.Status));
            Assert.Equal(PlatformProviderRegistryMutationStatus.Applied, reconcileResult.Status);
            Assert.Equal(before.Revision + 1 + winners, registry.Snapshot.Revision);
            Assert.Null(registry.TryRelease(PluginId, entry.Fingerprint!, entry.Generation));
            var final = Assert.Single(registry.Snapshot.Entries);
            Assert.Contains(
                final.State,
                new[]
                {
                    PlatformProviderLifecycleState.Pending,
                    PlatformProviderLifecycleState.Enabled,
                    PlatformProviderLifecycleState.Revoked,
                });
        }
    }

    [Fact]
    public async Task GrantReplacementRevokeAndReconcileRacesPublishOneWholeRevision()
    {
        for (var iteration = 0; iteration < 32; iteration++)
        {
            var registry = Registry(new RecordingStore());
            var acquired = Acquired();
            registry.Reconcile(Completed(acquired));
            ApproveCurrent(registry);
            var before = registry.Snapshot;
            var entry = Assert.Single(before.Entries);
            using var start = new ManualResetEventSlim(false);
            var commands = new[]
            {
                PlatformProviderAdminCommand.ReplaceGrant(
                    before.Revision,
                    PluginId,
                    entry.Generation,
                    entry.Fingerprint!,
                    new[] { "jellyfin.canopy.storage.read" },
                    "Concurrent grant replacement"),
                PlatformProviderAdminCommand.Disable(
                    before.Revision,
                    PluginId,
                    entry.Generation,
                    entry.Fingerprint!,
                    "Concurrent disable"),
                PlatformProviderAdminCommand.Revoke(
                    before.Revision,
                    PluginId,
                    entry.Generation,
                    entry.Fingerprint!,
                    "Concurrent revocation"),
            };
            var adminTasks = commands.Select(command => Task.Run(() =>
            {
                start.Wait();
                return registry.Apply(command, AdminAuthorization(currentlyElevated: true));
            })).ToArray();
            var reconcileTask = Task.Run(() =>
            {
                start.Wait();
                return registry.Reconcile(Completed(acquired));
            });

            start.Set();
            var adminResults = await Task.WhenAll(adminTasks);
            var reconcileResult = await reconcileTask;

            var winners = adminResults.Count(result =>
                result.Status == PlatformProviderRegistryMutationStatus.Applied);
            Assert.InRange(winners, 0, 1);
            Assert.All(
                adminResults.Where(result => result.Status != PlatformProviderRegistryMutationStatus.Applied),
                result => Assert.Equal(PlatformProviderRegistryMutationStatus.StaleRevision, result.Status));
            Assert.Equal(PlatformProviderRegistryMutationStatus.Applied, reconcileResult.Status);
            Assert.Equal(before.Revision + 1 + winners, registry.Snapshot.Revision);
            if (winners == 0)
            {
                Assert.NotNull(registry.TryRelease(PluginId, entry.Fingerprint!, entry.Generation));
            }
            else
            {
                Assert.Null(registry.TryRelease(PluginId, entry.Fingerprint!, entry.Generation));
            }
            var final = Assert.Single(registry.Snapshot.Entries);
            Assert.True(final.Generation == entry.Generation + winners);
            Assert.Contains(
                final.State,
                new[]
                {
                    PlatformProviderLifecycleState.Enabled,
                    PlatformProviderLifecycleState.Disabled,
                    PlatformProviderLifecycleState.Revoked,
                });
        }
    }

    [Fact]
    public async Task ParallelReadersObserveOnlyWholeEnabledOrDisabledSnapshots()
    {
        var registry = Registry(new RecordingStore());
        registry.Reconcile(Completed(Acquired()));
        ApproveCurrent(registry);
        var baseline = AssertEntry(registry, PlatformProviderLifecycleState.Enabled);
        using var start = new ManualResetEventSlim(false);

        var readers = Enumerable.Range(0, 8).Select(_ => Task.Run(() =>
        {
            start.Wait();
            for (var iteration = 0; iteration < 10_000; iteration++)
            {
                var snapshot = registry.Snapshot;
                var observed = Assert.Single(snapshot.Entries);
                Assert.True(snapshot.Revision >= 2);
                Assert.True(observed.Generation >= baseline.Generation);
                Assert.Equal(snapshot.Revision, observed.Generation);
                Assert.Equal(baseline.Fingerprint, observed.Fingerprint);
                Assert.Equal(new[] { "jellyfin.canopy.items.lookup" }, observed.GrantedCapabilityIds);
                Assert.Contains(
                    observed.State,
                    new[] { PlatformProviderLifecycleState.Enabled, PlatformProviderLifecycleState.Disabled });
            }
        })).ToArray();

        var writer = Task.Run(() =>
        {
            start.Wait();
            for (var iteration = 0; iteration < 200; iteration++)
            {
                var snapshot = registry.Snapshot;
                var observed = Assert.Single(snapshot.Entries);
                var command = observed.State == PlatformProviderLifecycleState.Enabled
                    ? PlatformProviderAdminCommand.Disable(
                        snapshot.Revision,
                        PluginId,
                        observed.Generation,
                        observed.Fingerprint!,
                        "Concurrent disable")
                    : PlatformProviderAdminCommand.Enable(
                        snapshot.Revision,
                        PluginId,
                        observed.Generation,
                        observed.Fingerprint!,
                        "Concurrent enable");
                Assert.Equal(
                    PlatformProviderRegistryMutationStatus.Applied,
                    registry.Apply(command, AdminAuthorization(currentlyElevated: true)).Status);
            }
        });

        start.Set();
        await Task.WhenAll(readers.Append(writer));
    }

    public static TheoryData<IReadOnlyList<string>, int> InvalidGrantCases => new()
    {
        { null!, (int)PlatformProviderRegistryMutationStatus.InvalidCommand },
        { Enumerable.Repeat(
            "jellyfin.canopy.items.lookup",
            PlatformCapabilityVocabulary.MaximumCapabilityCount + 1).ToArray(),
            (int)PlatformProviderRegistryMutationStatus.InvalidCommand },
        { new[] { "jellyfin.canopy.items.lookup", "jellyfin.canopy.items.lookup" }, (int)PlatformProviderRegistryMutationStatus.InvalidGrant },
        { new[] { "unknown.capability" }, (int)PlatformProviderRegistryMutationStatus.InvalidGrant },
        { new[] { "jellyfin.canopy.admin.read" }, (int)PlatformProviderRegistryMutationStatus.InvalidGrant },
    };

    private static PlatformProviderRegistry Registry(RecordingStore store) =>
        new(store, new FixedTimeProvider(Now));

    private static PlatformInstalledManifestSweep Completed(
        params PlatformInstalledManifestObservation[] observations) =>
        PlatformInstalledManifestSweep.EstablishCompleted(observations.ToImmutableArray());

    private static PlatformProviderRegistryEntry AssertEntry(
        PlatformProviderRegistry registry,
        PlatformProviderLifecycleState state)
    {
        var entry = Assert.Single(registry.Snapshot.Entries);
        Assert.Equal(state, entry.State);
        return entry;
    }

    private static void ApproveCurrent(PlatformProviderRegistry registry)
    {
        var entry = Assert.Single(registry.Snapshot.Entries);
        var result = registry.Apply(
            PlatformProviderAdminCommand.Approve(
                registry.Snapshot.Revision,
                PluginId,
                entry.Generation,
                entry.Fingerprint!,
                new[] { "jellyfin.canopy.items.lookup" },
                "Approved in test"),
            AdminAuthorization(currentlyElevated: true));
        Assert.Equal(PlatformProviderRegistryMutationStatus.Applied, result.Status);
    }

    private static PlatformProviderAdminAuthorization? AdminAuthorization(bool currentlyElevated)
    {
        var boundaryActor = PlatformActorTestFactory.Create(
            AdminId,
            isElevated: true,
            "registry-test",
            "test-client",
            "test-device");
        var host = new ReauthorizationHost
        {
            Current = new HostUser(AdminId, "Registry admin", currentlyElevated),
        };
        return PlatformProviderRegistryAdminBoundary.ReauthorizeElevatedAdministrator(boundaryActor, host);
    }

    private static PlatformInstalledManifestObservation Acquired(
        string version = "1.2.3.4",
        Version? hostVersion = null,
        IReadOnlyList<string>? capabilities = null,
        int platformMin = 1,
        int platformMax = 1,
        int hostMin = 12,
        int hostMax = 12,
        string assemblyIdentity = "Example.Provider",
        Guid? pluginId = null)
    {
        var effectivePluginId = pluginId ?? PluginId;
        var snapshot = PlatformInstalledManifestBindingTests.Snapshot(
            pluginId: effectivePluginId,
            version: hostVersion);
        return PlatformInstalledManifestBinder.Bind(
            snapshot,
            PlatformInstalledManifestBindingTests.Snapshot(
                pluginId: effectivePluginId,
                version: hostVersion),
            PlatformInstalledManifestReadResult.Acquired(
                PlatformInstalledManifestBindingTests.ManifestBytes(
                    pluginId: effectivePluginId.ToString("D"),
                    version: version,
                    platformMin: platformMin,
                    platformMax: platformMax,
                    hostMin: hostMin,
                    hostMax: hostMax,
                    capabilities: capabilities ?? Requested),
                assemblyIdentity));
    }

    private static PlatformInstalledManifestObservation Rejected(
        PlatformInstalledPluginHostStatus status,
        PlatformInstalledManifestOutcome outcome,
        Guid? pluginId = null) =>
        PlatformInstalledManifestObservation.Rejected(
            PlatformInstalledManifestBindingTests.Snapshot(pluginId: pluginId, status: status),
            outcome);

    private static PlatformProviderRegistryDurableRecord ApprovedRecord(
        PlatformInstalledManifestObservation observation)
    {
        var manifest = Assert.IsType<HostBoundInstalledManifest>(observation.BoundManifest);
        return new PlatformProviderRegistryDurableRecord(
            observation.PluginId,
            1,
            manifest.Fingerprint.Value,
            manifest.HostVersion.ToString(),
            manifest.AssemblyIdentity,
            (int)observation.HostStatus,
            observation.Outcome,
            observation.Compatibility,
            manifest.Manifest.RequestedCapabilities.Capabilities
                .Select(capability => capability.Id.Value)
                .ToImmutableArray(),
            false,
            PlatformProviderDurableDisposition.Approved,
            manifest.Fingerprint.Value,
            ImmutableArray.Create("jellyfin.canopy.items.lookup"),
            AdminId,
            "Seeded approval",
            Now,
            1);
    }

    private static PlatformProviderRegistryDurableRecord RevokedTombstone(Guid pluginId) =>
        new(
            pluginId,
            1,
            new string('a', 64),
            "1.2.3.4",
            "Retired.Provider",
            (int)PlatformInstalledPluginHostStatus.Active,
            PlatformInstalledManifestOutcome.Acquired,
            PlatformInstalledManifestCompatibility.Compatible,
            ImmutableArray<string>.Empty,
            true,
            PlatformProviderDurableDisposition.Revoked,
            null,
            ImmutableArray<string>.Empty,
            AdminId,
            "Seeded revocation",
            Now,
            1);

    private sealed class RecordingStore : IPlatformProviderRegistryStateStore
    {
        internal bool ThrowOnSave { get; set; }

        internal ManualResetEventSlim? SaveEntered { get; set; }

        internal ManualResetEventSlim? ContinueSave { get; set; }

        internal int SaveCount { get; private set; }

        internal PlatformProviderRegistryDurableState? LastSaved { get; private set; }

        internal bool WasFenced { get; private set; }

        internal void Seed(PlatformProviderRegistryDurableState state) => LastSaved = state;

        public PlatformProviderRegistryStoreLoadResult Load() => LastSaved is null
            ? PlatformProviderRegistryStoreLoadResult.Healthy(PlatformProviderRegistryDurableState.Empty)
            : PlatformProviderRegistryStoreLoadResult.Healthy(LastSaved);

        public void Save(PlatformProviderRegistryDurableState state)
        {
            if (ThrowOnSave)
            {
                throw new InvalidOperationException("Injected persistence failure.");
            }

            SaveEntered?.Set();
            ContinueSave?.Wait();

            SaveCount++;
            LastSaved = state;
        }

        public void ResetQuarantined(Guid administratorId, string reason, DateTimeOffset decidedAtUtc)
        {
            if (ThrowOnSave)
            {
                throw new InvalidOperationException("Injected recovery failure.");
            }

            LastSaved = PlatformProviderRegistryDurableState.Empty;
            WasFenced = false;
        }

        public void FenceQuarantined()
        {
            if (ThrowOnSave)
            {
                throw new InvalidOperationException("Injected quarantine failure.");
            }

            WasFenced = true;
        }
    }

    private sealed class FixedTimeProvider : TimeProvider
    {
        private readonly DateTimeOffset _now;

        internal FixedTimeProvider(DateTimeOffset now) => _now = now;

        public override DateTimeOffset GetUtcNow() => _now;
    }

    private sealed class ReauthorizationHost : IPlatformHost, IHostUsers
    {
        internal HostUser? Current { get; set; }

        public IHostUsers Users => this;

        public IHostLibrary Library => throw new NotSupportedException();

        public IHostSessions Sessions => throw new NotSupportedException();

        public IHostPlugins Plugins => throw new NotSupportedException();

        public HostUser? Find(Guid id) => id == AdminId ? Current : null;

        public IReadOnlyList<HostUser> All() => [];
    }
}
