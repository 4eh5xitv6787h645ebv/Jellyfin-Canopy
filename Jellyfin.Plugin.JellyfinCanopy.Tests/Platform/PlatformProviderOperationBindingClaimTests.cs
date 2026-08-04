using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Text;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

public sealed class PlatformProviderOperationBindingClaimTests
{
    private const string OperationId = "org.example.provider.hello";
    private const string AssemblyIdentity = "Example.Provider, Version=1.2.3.4";
    private const string ItemLookup = "jellyfin.canopy.items.lookup";
    private const string StorageRead = "jellyfin.canopy.storage.read";
    private static readonly Guid PluginId = new("11111111-2222-3333-4444-555555555555");
    private static readonly Guid AdminId = new("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    private static readonly DateTimeOffset Now = new(2026, 8, 4, 10, 0, 0, TimeSpan.Zero);

    [Fact]
    public void ExactCurrentEnabledOperationProducesImmutableBindingFacts()
    {
        var registry = EnabledRegistry(new[] { StorageRead, ItemLookup });
        var entry = Assert.Single(registry.Snapshot.Entries);

        var result = registry.ClaimOperationBinding(PluginId, OperationId, negotiatedProtocol: 1);

        Assert.Equal(PlatformProviderOperationBindingClaimStatus.Claimed, result.Status);
        var claim = Assert.IsType<PlatformProviderOperationBindingClaim>(result.Claim);
        Assert.Equal(PluginId, claim.PluginId);
        Assert.Equal(entry.Fingerprint, claim.Fingerprint);
        Assert.Equal(entry.Generation, claim.Generation);
        Assert.Equal(new Version(1, 2, 3, 4), claim.HostVersion);
        Assert.Equal(AssemblyIdentity, claim.AssemblyIdentity);
        Assert.Equal(1, claim.NegotiatedProtocol);
        Assert.Equal(OperationId, claim.Operation.Id);
        Assert.Equal(1, claim.Operation.ProtocolRange.Min);
        Assert.Equal(1, claim.Operation.ProtocolRange.Max);
        Assert.Equal(new[] { ItemLookup }, CapabilityIds(claim.Operation));
        Assert.Equal(new[] { ItemLookup, StorageRead }, claim.GrantedCapabilityIds);
        Assert.Equal(
            "urn:jellyfin-canopy:provider-schema:org.example.provider:org.example.provider.hello:request:1",
            claim.Operation.RequestSchemaId);
        Assert.Equal(new string('a', 64), claim.Operation.RequestSchemaSha256);
        Assert.Equal(
            "urn:jellyfin-canopy:provider-schema:org.example.provider:org.example.provider.hello:response:1",
            claim.Operation.ResponseSchemaId);
        Assert.Equal(new string('b', 64), claim.Operation.ResponseSchemaSha256);
        Assert.True(registry.RevalidateOperationBindingClaim(claim));

        var copy = claim.GrantedCapabilityIds;
        copy = copy.SetItem(0, StorageRead);
        Assert.Equal(new[] { ItemLookup, StorageRead }, claim.GrantedCapabilityIds);
    }

    [Fact]
    public void ClaimAndResultShapesAreClosedAndNonPubliclyConstructible()
    {
        Assert.True(typeof(PlatformProviderOperationBindingClaim).IsSealed);
        Assert.Empty(typeof(PlatformProviderOperationBindingClaim).GetConstructors());
        Assert.True(typeof(PlatformProviderOperationBindingClaimResult).IsValueType);
        Assert.Equal(
            new[]
            {
                PlatformProviderOperationBindingClaimStatus.Claimed,
                PlatformProviderOperationBindingClaimStatus.AuthorityUnavailable,
                PlatformProviderOperationBindingClaimStatus.OperationUnavailable,
                PlatformProviderOperationBindingClaimStatus.ProtocolUnsupported,
                PlatformProviderOperationBindingClaimStatus.GrantInsufficient,
            },
            Enum.GetValues<PlatformProviderOperationBindingClaimStatus>());
    }

    [Fact]
    public void NonCurrentAndIdentityOnlyProvidersAreNotCallable()
    {
        var pending = Registry(new RecordingStore());
        Reconcile(pending, Acquired(hasOperation: true));
        AssertRefused(
            pending.ClaimOperationBinding(PluginId, OperationId, 1),
            PlatformProviderOperationBindingClaimStatus.AuthorityUnavailable);

        var identityOnly = EnabledRegistry(new[] { ItemLookup }, hasOperation: false);
        AssertRefused(
            identityOnly.ClaimOperationBinding(PluginId, OperationId, 1),
            PlatformProviderOperationBindingClaimStatus.OperationUnavailable);
        AssertRefused(
            identityOnly.ClaimOperationBinding(PluginId, "", 1),
            PlatformProviderOperationBindingClaimStatus.OperationUnavailable);
        AssertRefused(
            identityOnly.ClaimOperationBinding(Guid.Empty, OperationId, 1),
            PlatformProviderOperationBindingClaimStatus.AuthorityUnavailable);
    }

    [Fact]
    public void OperationProtocolAndGrantAreEvaluatedIndependently()
    {
        var fullGrant = EnabledRegistry(new[] { ItemLookup, StorageRead });
        AssertRefused(
            fullGrant.ClaimOperationBinding(PluginId, "org.example.provider.unknown", 1),
            PlatformProviderOperationBindingClaimStatus.OperationUnavailable);
        AssertRefused(
            fullGrant.ClaimOperationBinding(PluginId, OperationId, 2),
            PlatformProviderOperationBindingClaimStatus.ProtocolUnsupported);
        AssertRefused(
            fullGrant.ClaimOperationBinding(PluginId, OperationId, 0),
            PlatformProviderOperationBindingClaimStatus.ProtocolUnsupported);

        var insufficientGrant = EnabledRegistry(new[] { StorageRead });
        AssertRefused(
            insufficientGrant.ClaimOperationBinding(PluginId, OperationId, 1),
            PlatformProviderOperationBindingClaimStatus.GrantInsufficient);
    }

    [Fact]
    public void ClaimCannotCrossRegistryEvenWhenEveryVisibleFactMatches()
    {
        var first = EnabledRegistry(new[] { ItemLookup, StorageRead });
        var second = EnabledRegistry(new[] { ItemLookup, StorageRead });
        var claim = AssertClaimed(first);
        var secondClaim = AssertClaimed(second);

        Assert.False(second.RevalidateOperationBindingClaim(claim));
        Assert.False(first.RevalidateOperationBindingClaim(secondClaim));
        Assert.True(first.RevalidateOperationBindingClaim(claim));
        Assert.True(second.RevalidateOperationBindingClaim(secondClaim));
    }

    [Fact]
    public void ReconciliationFencePermanentlyInvalidatesEarlierClaimEvenWhenFactsAreUnchanged()
    {
        var registry = EnabledRegistry(new[] { ItemLookup, StorageRead });
        var claim = AssertClaimed(registry);

        var epoch = registry.BeginReconciliation();
        Assert.False(registry.RevalidateOperationBindingClaim(claim));
        AssertRefused(
            registry.ClaimOperationBinding(PluginId, OperationId, 1),
            PlatformProviderOperationBindingClaimStatus.AuthorityUnavailable);

        Assert.Equal(
            PlatformProviderRegistryMutationStatus.Applied,
            registry.Reconcile(epoch, Completed(Acquired(hasOperation: true))).Status);
        Assert.False(registry.RevalidateOperationBindingClaim(claim));

        var replacement = AssertClaimed(registry);
        Assert.True(registry.RevalidateOperationBindingClaim(replacement));
    }

    [Theory]
    [InlineData((int)PlatformProviderAdminOperation.ReplaceGrant)]
    [InlineData((int)PlatformProviderAdminOperation.Disable)]
    [InlineData((int)PlatformProviderAdminOperation.Revoke)]
    public void EverySuccessfulAdministratorMutationInvalidatesEarlierClaim(
        int operationValue)
    {
        var operation = (PlatformProviderAdminOperation)operationValue;
        var registry = EnabledRegistry(new[] { ItemLookup, StorageRead });
        var claim = AssertClaimed(registry);
        var entry = Assert.Single(registry.Snapshot.Entries);
        var command = operation switch
        {
            PlatformProviderAdminOperation.ReplaceGrant => PlatformProviderAdminCommand.ReplaceGrant(
                registry.Snapshot.Revision,
                PluginId,
                entry.Generation,
                entry.Fingerprint!,
                new[] { ItemLookup },
                "Replace grant in claim test"),
            PlatformProviderAdminOperation.Disable => PlatformProviderAdminCommand.Disable(
                registry.Snapshot.Revision,
                PluginId,
                entry.Generation,
                entry.Fingerprint!,
                "Disable in claim test"),
            PlatformProviderAdminOperation.Revoke => PlatformProviderAdminCommand.Revoke(
                registry.Snapshot.Revision,
                PluginId,
                entry.Generation,
                entry.Fingerprint!,
                "Revoke in claim test"),
            _ => throw new ArgumentOutOfRangeException(nameof(operation)),
        };

        Assert.Equal(
            PlatformProviderRegistryMutationStatus.Applied,
            registry.Apply(command, AdminAuthorization()).Status);
        Assert.False(registry.RevalidateOperationBindingClaim(claim));
    }

    [Fact]
    public void FailedAdministratorAttemptDoesNotInvalidateUnchangedAuthority()
    {
        var registry = EnabledRegistry(new[] { ItemLookup, StorageRead });
        var claim = AssertClaimed(registry);
        var entry = Assert.Single(registry.Snapshot.Entries);
        var stale = PlatformProviderAdminCommand.Disable(
            registry.Snapshot.Revision + 1,
            PluginId,
            entry.Generation,
            entry.Fingerprint!,
            "Stale claim test command");

        Assert.Equal(
            PlatformProviderRegistryMutationStatus.StaleRevision,
            registry.Apply(stale, AdminAuthorization()).Status);
        Assert.True(registry.RevalidateOperationBindingClaim(claim));
    }

    [Fact]
    public void AbandonedAndFailedReconciliationsKeepClaimsInvalid()
    {
        var registry = EnabledRegistry(new[] { ItemLookup, StorageRead });
        var abandonedClaim = AssertClaimed(registry);
        var abandonedEpoch = registry.BeginReconciliation();
        registry.AbandonReconciliation(abandonedEpoch);

        Assert.False(registry.RevalidateOperationBindingClaim(abandonedClaim));
        Assert.Equal(
            PlatformProviderRegistryMutationStatus.StaleReconciliation,
            registry.Reconcile(abandonedEpoch, Completed(Acquired(hasOperation: true))).Status);

        var restoredEpoch = registry.BeginReconciliation();
        Assert.Equal(
            PlatformProviderRegistryMutationStatus.Applied,
            registry.Reconcile(restoredEpoch, Completed(Acquired(hasOperation: true))).Status);
        var failedClaim = AssertClaimed(registry);
        var failedEpoch = registry.BeginReconciliation();
        Assert.Equal(
            PlatformProviderRegistryMutationStatus.InvalidSweep,
            registry.Reconcile(
                failedEpoch,
                Completed(Acquired(hasOperation: true), Acquired(hasOperation: true))).Status);
        Assert.False(registry.RevalidateOperationBindingClaim(failedClaim));
    }

    private static PlatformProviderRegistry EnabledRegistry(
        IReadOnlyList<string> grantedCapabilities,
        bool hasOperation = true)
    {
        var registry = Registry(new RecordingStore());
        Reconcile(registry, Acquired(hasOperation));
        var entry = Assert.Single(registry.Snapshot.Entries);
        var result = registry.Apply(
            PlatformProviderAdminCommand.Approve(
                registry.Snapshot.Revision,
                PluginId,
                entry.Generation,
                entry.Fingerprint!,
                grantedCapabilities,
                "Approve provider binding claim test"),
            AdminAuthorization());
        Assert.Equal(PlatformProviderRegistryMutationStatus.Applied, result.Status);
        Assert.Equal(
            PlatformProviderLifecycleState.Enabled,
            Assert.Single(registry.Snapshot.Entries).State);
        return registry;
    }

    private static PlatformProviderOperationBindingClaim AssertClaimed(
        PlatformProviderRegistry registry)
    {
        var result = registry.ClaimOperationBinding(PluginId, OperationId, 1);
        Assert.Equal(PlatformProviderOperationBindingClaimStatus.Claimed, result.Status);
        return Assert.IsType<PlatformProviderOperationBindingClaim>(result.Claim);
    }

    private static void AssertRefused(
        PlatformProviderOperationBindingClaimResult result,
        PlatformProviderOperationBindingClaimStatus expected)
    {
        Assert.Equal(expected, result.Status);
        Assert.Null(result.Claim);
    }

    private static string[] CapabilityIds(PlatformProviderOperationDeclaration operation) =>
        operation.RequiredCapabilities.Capabilities.Select(value => value.Id.Value).ToArray();

    private static PlatformProviderRegistry Registry(RecordingStore store) =>
        new(store, new FixedTimeProvider(Now));

    private static void Reconcile(
        PlatformProviderRegistry registry,
        PlatformInstalledManifestObservation observation)
    {
        Assert.Equal(
            PlatformProviderRegistryMutationStatus.Applied,
            registry.Reconcile(registry.BeginReconciliation(), Completed(observation)).Status);
    }

    private static PlatformInstalledManifestSweep Completed(
        params PlatformInstalledManifestObservation[] observations) =>
        PlatformInstalledManifestSweep.EstablishCompleted(observations.ToImmutableArray());

    private static PlatformInstalledManifestObservation Acquired(bool hasOperation)
    {
        var snapshot = PlatformInstalledManifestBindingTests.Snapshot(
            pluginId: PluginId,
            version: new Version(1, 2, 3, 4));
        return PlatformInstalledManifestBinder.Bind(
            snapshot,
            PlatformInstalledManifestBindingTests.Snapshot(
                pluginId: PluginId,
                version: new Version(1, 2, 3, 4)),
            PlatformInstalledManifestReadResult.Acquired(
                ManifestBytes(hasOperation),
                AssemblyIdentity));
    }

    private static byte[] ManifestBytes(bool hasOperation)
    {
        var providerOperations = hasOperation
            ? ",\"providerOperations\":[{"
                + "\"id\":\"" + OperationId + "\""
                + ",\"protocol\":{\"min\":1,\"max\":1}"
                + ",\"requiredCapabilities\":[\"" + ItemLookup + "\"]"
                + ",\"requestSchemaId\":\"urn:jellyfin-canopy:provider-schema:org.example.provider:"
                + OperationId + ":request:1\""
                + ",\"requestSchemaSha256\":\"" + new string('a', 64) + "\""
                + ",\"responseSchemaId\":\"urn:jellyfin-canopy:provider-schema:org.example.provider:"
                + OperationId + ":response:1\""
                + ",\"responseSchemaSha256\":\"" + new string('b', 64) + "\"}]"
            : string.Empty;
        return Encoding.UTF8.GetBytes("{"
            + "\"schemaVersion\":1"
            + ",\"id\":\"org.example.provider\""
            + ",\"pluginId\":\"" + PluginId.ToString("D") + "\""
            + ",\"version\":\"1.2.3.4\""
            + ",\"kind\":\"installed-provider\""
            + ",\"displayName\":\"Example Provider\""
            + ",\"platform\":{\"min\":1,\"max\":1}"
            + ",\"host\":{\"minMajor\":12,\"maxMajor\":12}"
            + ",\"requestedCapabilities\":[\"" + ItemLookup + "\",\"" + StorageRead + "\"]"
            + providerOperations
            + "}");
    }

    private static PlatformProviderAdminAuthorization AdminAuthorization()
    {
        var boundaryActor = PlatformActorTestFactory.Create(
            AdminId,
            isElevated: true,
            "provider-binding-claim-test",
            "test-client",
            "test-device");
        return Assert.IsType<PlatformProviderAdminAuthorization>(
            PlatformProviderRegistryAdminBoundary.ReauthorizeElevatedAdministrator(
                boundaryActor,
                new ReauthorizationHost()));
    }

    private sealed class RecordingStore : IPlatformProviderRegistryStateStore
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
}
