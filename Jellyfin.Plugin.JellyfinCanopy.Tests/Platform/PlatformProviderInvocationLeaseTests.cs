using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

public sealed class PlatformProviderInvocationLeaseTests
{
    private const string OperationId = "org.example.provider.hello";
    private const string AssemblyIdentity = "Example.Provider, Version=1.2.3.4";
    private const string ItemLookup = "jellyfin.canopy.items.lookup";
    private const string StorageRead = "jellyfin.canopy.storage.read";
    private static readonly Guid PluginId = new("11111111-2222-3333-4444-555555555555");
    private static readonly Guid PeerPluginId = new("66666666-7777-4888-8999-aaaaaaaaaaaa");
    private static readonly Guid AdminId = new("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    private static readonly DateTimeOffset Now = new(2026, 8, 4, 0, 0, 0, TimeSpan.Zero);

    [Fact]
    public void LeaseShapesAndAdmissionStatusesAreClosedAndBounded()
    {
        Assert.Equal(
            new[] { "Acquired", "AuthorityUnavailable", "ProviderBusy" },
            Enum.GetNames<PlatformProviderInvocationLeaseStatus>());
        Assert.Equal(2, PlatformProviderRegistry.MaximumConcurrentInvocationsPerProvider);
        Assert.True(typeof(PlatformProviderInvocationLease).IsSealed);
        Assert.True(typeof(PlatformProviderResultReleaseLease).IsSealed);
        Assert.Empty(typeof(PlatformProviderInvocationLease).GetConstructors());
        Assert.Empty(typeof(PlatformProviderResultReleaseLease).GetConstructors());

        var registry = EnabledRegistry(new RecordingStore());
        var claim = Claim(registry);
        using var first = Acquire(registry, claim);
        using var second = Acquire(registry, claim);

        var busy = registry.TryAcquireInvocationLease(claim);
        Assert.Equal(PlatformProviderInvocationLeaseStatus.ProviderBusy, busy.Status);
        Assert.Null(busy.Lease);
    }

    [Fact]
    public void ResultReleaseHandoffIsOneUseAndRetainsProviderSlotUntilDisposed()
    {
        var registry = EnabledRegistry(new RecordingStore());
        var claim = Claim(registry);
        var first = Acquire(registry, claim);
        using var second = Acquire(registry, claim);

        var release = Assert.IsType<PlatformProviderResultReleaseLease>(
            registry.TryAcquireResultReleaseLease(first, CancellationToken.None, CancellationToken.None));
        Assert.Null(registry.TryAcquireResultReleaseLease(
            first,
            CancellationToken.None,
            CancellationToken.None));
        first.Dispose();
        Assert.Equal(
            PlatformProviderInvocationLeaseStatus.ProviderBusy,
            registry.TryAcquireInvocationLease(claim).Status);

        release.Dispose();
        release.Dispose();
        using var replacement = Acquire(registry, claim);
    }

    [Fact]
    public void ReconciliationCancelsOldGenerationAndSameFactsCannotReviveItsLeaseOrSlot()
    {
        var registry = EnabledRegistry(new RecordingStore());
        var oldClaim = Claim(registry);
        var first = Acquire(registry, oldClaim);
        var second = Acquire(registry, oldClaim);

        var reconciliation = registry.BeginReconciliation();
        Assert.True(first.GenerationCancellation.IsCancellationRequested);
        Assert.True(second.GenerationCancellation.IsCancellationRequested);
        Assert.Equal(
            PlatformProviderRegistryMutationStatus.Applied,
            registry.Reconcile(reconciliation, Completed(AcquiredObservation())).Status);

        Assert.Null(registry.TryAcquireResultReleaseLease(
            first,
            CancellationToken.None,
            CancellationToken.None));
        Assert.Null(registry.TryAcquireResultReleaseLease(
            second,
            CancellationToken.None,
            CancellationToken.None));
        var newClaim = Claim(registry);
        Assert.Equal(
            PlatformProviderInvocationLeaseStatus.ProviderBusy,
            registry.TryAcquireInvocationLease(newClaim).Status);

        first.Dispose();
        using var replacement = Acquire(registry, newClaim);
        second.Dispose();
    }

    [Fact]
    public async Task ResultReleaseLinearizesBeforeReconciliationAndCancellationRunsOutsideRegistryGate()
    {
        var registry = EnabledRegistry(new RecordingStore());
        var claim = Claim(registry);
        var invocation = Acquire(registry, claim);
        var release = Assert.IsType<PlatformProviderResultReleaseLease>(
            registry.TryAcquireResultReleaseLease(
                invocation,
                CancellationToken.None,
                CancellationToken.None));
        invocation.Dispose();

        var callbackCouldEnterRegistry = false;
        using var callbackCompleted = new ManualResetEventSlim(false);
        using var registration = invocation.GenerationCancellation.Register(() =>
        {
            var reentrant = Task.Run(() => registry.ClaimOperationBinding(PluginId, OperationId, 1));
            callbackCouldEnterRegistry = reentrant.Wait(TimeSpan.FromSeconds(5));
            callbackCompleted.Set();
        });

        var transition = Task.Run(registry.BeginReconciliation);
        Assert.True(
            SpinWait.SpinUntil(
                () => invocation.GenerationCancellation.IsCancellationRequested,
                TimeSpan.FromSeconds(5)));
        Assert.True(callbackCompleted.Wait(TimeSpan.FromSeconds(5)));
        Assert.True(callbackCouldEnterRegistry);
        Assert.False(transition.IsCompleted);

        release.Dispose();
        release.Dispose();
        _ = await transition.WaitAsync(TimeSpan.FromSeconds(5));
    }

    [Fact]
    public async Task CancellationCallbackCanReenterAuthorityTransitionWithoutDeadlock()
    {
        var registry = EnabledRegistry(new RecordingStore());
        using var invocation = Acquire(registry, Claim(registry));
        IPlatformProviderRegistryReconciliationEpoch? reentrantEpoch = null;
        using var callbackCompleted = new ManualResetEventSlim(false);
        using var registration = invocation.GenerationCancellation.Register(() =>
        {
            reentrantEpoch = registry.BeginReconciliation();
            callbackCompleted.Set();
        });

        var firstEpoch = await Task.Run(registry.BeginReconciliation)
            .WaitAsync(TimeSpan.FromSeconds(5));

        Assert.True(callbackCompleted.Wait(TimeSpan.FromSeconds(5)));
        Assert.NotNull(reentrantEpoch);
        Assert.Equal(
            PlatformProviderRegistryMutationStatus.StaleReconciliation,
            registry.Reconcile(firstEpoch, Completed(AcquiredObservation())).Status);
        Assert.Equal(
            PlatformProviderRegistryMutationStatus.Applied,
            registry.Reconcile(reentrantEpoch!, Completed(AcquiredObservation())).Status);
    }

    [Fact]
    public async Task BlockingCancellationCallbackCannotBlockAuthorityTransition()
    {
        var registry = EnabledRegistry(new RecordingStore());
        using var invocation = Acquire(registry, Claim(registry));
        using var callbackEntered = new ManualResetEventSlim(false);
        using var releaseCallback = new ManualResetEventSlim(false);
        using var registration = invocation.GenerationCancellation.Register(() =>
        {
            callbackEntered.Set();
            releaseCallback.Wait();
        });

        var transition = Task.Run(registry.BeginReconciliation);

        _ = await transition.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(callbackEntered.Wait(TimeSpan.FromSeconds(5)));
        releaseCallback.Set();
    }

    [Fact]
    public void CallerAndDeadlineCancellationFenceTheResultReleaseLinearization()
    {
        var registry = EnabledRegistry(new RecordingStore());
        var claim = Claim(registry);
        using var callerInvocation = Acquire(registry, claim);
        using var caller = new CancellationTokenSource();
        caller.Cancel();
        Assert.Null(registry.TryAcquireResultReleaseLease(
            callerInvocation,
            caller.Token,
            CancellationToken.None));

        using var deadlineInvocation = Acquire(registry, claim);
        using var deadline = new CancellationTokenSource();
        deadline.Cancel();
        Assert.Null(registry.TryAcquireResultReleaseLease(
            deadlineInvocation,
            CancellationToken.None,
            deadline.Token));
    }

    [Fact]
    public void FailedDurableMutationReopensSameGenerationWithoutCancellingIt()
    {
        var store = new RecordingStore();
        var registry = EnabledRegistry(store);
        var claim = Claim(registry);
        var invocation = Acquire(registry, claim);
        var entry = Assert.Single(registry.Snapshot.Entries);
        store.ThrowOnSave = true;

        var result = registry.Apply(
            PlatformProviderAdminCommand.Disable(
                registry.Snapshot.Revision,
                PluginId,
                entry.Generation,
                entry.Fingerprint!,
                "Persistence failure must not cancel current invocation"),
            AdminAuthorization());

        Assert.Equal(PlatformProviderRegistryMutationStatus.PersistenceFailed, result.Status);
        Assert.False(invocation.GenerationCancellation.IsCancellationRequested);
        Assert.True(registry.RevalidateOperationBindingClaim(claim));
        using var release = Assert.IsType<PlatformProviderResultReleaseLease>(
            registry.TryAcquireResultReleaseLease(
                invocation,
                CancellationToken.None,
                CancellationToken.None));
        invocation.Dispose();
    }

    [Fact]
    public void ForeignRegistryCannotAcquireOrReleaseOtherwiseMatchingAuthority()
    {
        var first = EnabledRegistry(new RecordingStore());
        var second = EnabledRegistry(new RecordingStore());
        var firstClaim = Claim(first);
        var invocation = Acquire(first, firstClaim);

        var foreignAdmission = second.TryAcquireInvocationLease(firstClaim);
        Assert.Equal(
            PlatformProviderInvocationLeaseStatus.AuthorityUnavailable,
            foreignAdmission.Status);
        Assert.Null(foreignAdmission.Lease);
        Assert.Null(second.TryAcquireResultReleaseLease(
            invocation,
            CancellationToken.None,
            CancellationToken.None));
        invocation.Dispose();
    }

    [Fact]
    public void SaturatedProviderCannotStarveAnHonestPeerProvider()
    {
        var registry = new PlatformProviderRegistry(new RecordingStore(), new FixedTimeProvider(Now));
        Assert.Equal(
            PlatformProviderRegistryMutationStatus.Applied,
            registry.Reconcile(
                registry.BeginReconciliation(),
                Completed(AcquiredObservation(PluginId), AcquiredObservation(PeerPluginId))).Status);
        foreach (var pluginId in new[] { PluginId, PeerPluginId })
        {
            var entry = Assert.Single(registry.Snapshot.Entries, value => value.PluginId == pluginId);
            Assert.Equal(
                PlatformProviderRegistryMutationStatus.Applied,
                registry.Apply(
                    PlatformProviderAdminCommand.Approve(
                        registry.Snapshot.Revision,
                        pluginId,
                        entry.Generation,
                        entry.Fingerprint!,
                        new[] { ItemLookup, StorageRead },
                        "Approve isolated provider bulkhead test"),
                    AdminAuthorization()).Status);
        }

        var firstClaim = Claim(registry);
        using var first = Acquire(registry, firstClaim);
        using var second = Acquire(registry, firstClaim);
        Assert.Equal(
            PlatformProviderInvocationLeaseStatus.ProviderBusy,
            registry.TryAcquireInvocationLease(firstClaim).Status);

        var peerClaim = Assert.IsType<PlatformProviderOperationBindingClaim>(
            registry.ClaimOperationBinding(PeerPluginId, OperationId, 1).Claim);
        using var peer = Acquire(registry, peerClaim);
    }

    private static PlatformProviderRegistry EnabledRegistry(RecordingStore store)
    {
        var registry = new PlatformProviderRegistry(store, new FixedTimeProvider(Now));
        Assert.Equal(
            PlatformProviderRegistryMutationStatus.Applied,
            registry.Reconcile(
                registry.BeginReconciliation(),
                Completed(AcquiredObservation())).Status);
        var entry = Assert.Single(registry.Snapshot.Entries);
        Assert.Equal(
            PlatformProviderRegistryMutationStatus.Applied,
            registry.Apply(
                PlatformProviderAdminCommand.Approve(
                    registry.Snapshot.Revision,
                    PluginId,
                    entry.Generation,
                    entry.Fingerprint!,
                    new[] { ItemLookup, StorageRead },
                    "Approve provider invocation lease test"),
                AdminAuthorization()).Status);
        return registry;
    }

    private static PlatformProviderOperationBindingClaim Claim(PlatformProviderRegistry registry)
    {
        var result = registry.ClaimOperationBinding(PluginId, OperationId, 1);
        Assert.Equal(PlatformProviderOperationBindingClaimStatus.Claimed, result.Status);
        return Assert.IsType<PlatformProviderOperationBindingClaim>(result.Claim);
    }

    private static PlatformProviderInvocationLease Acquire(
        PlatformProviderRegistry registry,
        PlatformProviderOperationBindingClaim claim)
    {
        var result = registry.TryAcquireInvocationLease(claim);
        Assert.Equal(PlatformProviderInvocationLeaseStatus.Acquired, result.Status);
        return Assert.IsType<PlatformProviderInvocationLease>(result.Lease);
    }

    private static PlatformInstalledManifestSweep Completed(
        params PlatformInstalledManifestObservation[] observations) =>
        PlatformInstalledManifestSweep.EstablishCompleted(observations.ToImmutableArray());

    private static PlatformInstalledManifestObservation AcquiredObservation(Guid? pluginId = null)
    {
        var exactPluginId = pluginId ?? PluginId;
        var snapshot = PlatformInstalledManifestBindingTests.Snapshot(
            pluginId: exactPluginId,
            version: new Version(1, 2, 3, 4));
        return PlatformInstalledManifestBinder.Bind(
            snapshot,
            PlatformInstalledManifestBindingTests.Snapshot(
                pluginId: exactPluginId,
                version: new Version(1, 2, 3, 4)),
            PlatformInstalledManifestReadResult.Acquired(
                ManifestBytes(exactPluginId),
                AssemblyIdentity));
    }

    private static byte[] ManifestBytes(Guid? pluginId = null) => Encoding.UTF8.GetBytes("{"
        + "\"schemaVersion\":1"
        + ",\"id\":\"org.example.provider\""
        + ",\"pluginId\":\"" + (pluginId ?? PluginId).ToString("D") + "\""
        + ",\"version\":\"1.2.3.4\""
        + ",\"kind\":\"installed-provider\""
        + ",\"displayName\":\"Example Provider\""
        + ",\"platform\":{\"min\":1,\"max\":1}"
        + ",\"host\":{\"minMajor\":12,\"maxMajor\":12}"
        + ",\"requestedCapabilities\":[\"" + ItemLookup + "\",\"" + StorageRead + "\"]"
        + ",\"providerOperations\":[{"
        + "\"id\":\"" + OperationId + "\""
        + ",\"protocol\":{\"min\":1,\"max\":1}"
        + ",\"requiredCapabilities\":[\"" + ItemLookup + "\"]"
        + ",\"requestSchemaId\":\"urn:jellyfin-canopy:provider-schema:org.example.provider:"
        + OperationId + ":request:1\""
        + ",\"requestSchemaSha256\":\"" + new string('a', 64) + "\""
        + ",\"responseSchemaId\":\"urn:jellyfin-canopy:provider-schema:org.example.provider:"
        + OperationId + ":response:1\""
        + ",\"responseSchemaSha256\":\"" + new string('b', 64) + "\"}]}");

    private static PlatformProviderAdminAuthorization AdminAuthorization()
    {
        var actor = PlatformActorTestFactory.Create(
            AdminId,
            isElevated: true,
            "provider-invocation-lease-test",
            "test-client",
            "test-device");
        return Assert.IsType<PlatformProviderAdminAuthorization>(
            PlatformProviderRegistryAdminBoundary.ReauthorizeElevatedAdministrator(
                actor,
                new ReauthorizationHost()));
    }

    private sealed class RecordingStore : IPlatformProviderRegistryStateStore
    {
        private PlatformProviderRegistryDurableState _state = PlatformProviderRegistryDurableState.Empty;

        internal bool ThrowOnSave { get; set; }

        public PlatformProviderRegistryStoreLoadResult Load() =>
            PlatformProviderRegistryStoreLoadResult.Healthy(_state);

        public void Save(PlatformProviderRegistryDurableState state)
        {
            if (ThrowOnSave)
            {
                throw new InvalidOperationException("Injected save failure.");
            }

            _state = state;
        }

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
