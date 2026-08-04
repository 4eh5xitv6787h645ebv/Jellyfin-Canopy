using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Threading;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>The closed current lifecycle derived by the installed-provider registry.</summary>
    internal enum PlatformProviderLifecycleState
    {
        Pending = 1,
        Enabled = 2,
        Disabled = 3,
        RestartPending = 4,
        Incompatible = 5,
        Quarantined = 6,
        Revoked = 7,
        Absent = 8,
    }

    /// <summary>The fail-closed health of the durable authority store.</summary>
    internal enum PlatformProviderRegistryStoreHealth
    {
        Healthy = 1,
        Quarantined = 2,
    }

    /// <summary>Closed results for registry reconciliation and administrator commands.</summary>
    internal enum PlatformProviderRegistryMutationStatus
    {
        Applied = 1,
        ElevationRequired = 2,
        StaleRevision = 3,
        ProviderNotFound = 4,
        StaleProvider = 5,
        InvalidGrant = 6,
        InvalidCommand = 7,
        PersistenceFailed = 8,
        StoreQuarantined = 9,
        InvalidSweep = 10,
        StaleReconciliation = 11,
    }

    /// <summary>Durable administrator disposition; it is never current authority.</summary>
    internal enum PlatformProviderDurableDisposition
    {
        None = 0,
        Approved = 1,
        Disabled = 2,
        Revoked = 3,
    }

    /// <summary>One immutable result from a registry mutation attempt.</summary>
    internal readonly record struct PlatformProviderRegistryMutationResult
    {
        private PlatformProviderRegistryMutationResult(PlatformProviderRegistryMutationStatus status)
        {
            if (!Enum.IsDefined(status))
            {
                throw new ArgumentOutOfRangeException(nameof(status));
            }

            Status = status;
        }

        internal PlatformProviderRegistryMutationStatus Status { get; }

        internal static PlatformProviderRegistryMutationResult From(
            PlatformProviderRegistryMutationStatus status) => new(status);
    }

    /// <summary>The closed internal administrator operations over provider authority.</summary>
    internal enum PlatformProviderAdminOperation
    {
        Approve = 1,
        ReplaceGrant = 2,
        Disable = 3,
        Enable = 4,
        Revoke = 5,
    }

    /// <summary>
    /// Opaque one-use proof that re-reads the same Jellyfin user and current elevation when
    /// consumed. It retains only the typed boundary inputs needed for that check and carries
    /// no principal, token or grant.
    /// </summary>
    internal sealed class PlatformProviderAdminAuthorization
    {
        private readonly PlatformActor _boundaryActor;
        private readonly Hosting.IPlatformHost _host;
        private int _consumed;

        private PlatformProviderAdminAuthorization(
            Guid administratorId,
            PlatformActor boundaryActor,
            Hosting.IPlatformHost host)
        {
            if (administratorId == Guid.Empty)
            {
                throw new ArgumentException("A registry administrator cannot be empty.", nameof(administratorId));
            }

            AdministratorId = administratorId;
            _boundaryActor = boundaryActor;
            _host = host;
        }

        internal Guid AdministratorId { get; }

        internal bool TryConsume(out Guid administratorId)
        {
            administratorId = Guid.Empty;
            if (Interlocked.Exchange(ref _consumed, 1) != 0)
            {
                return false;
            }

            var current = PlatformActorBoundaryFilter.ReauthorizeUserActor(_boundaryActor, _host);
            if (current is not { IsElevated: true }
                || current.UserId != AdministratorId)
            {
                return false;
            }

            administratorId = AdministratorId;
            return true;
        }

        internal static PlatformProviderAdminAuthorization EstablishFreshElevatedBoundary(
            PlatformActor boundaryActor,
            Hosting.IPlatformHost host)
        {
            ArgumentNullException.ThrowIfNull(boundaryActor);
            ArgumentNullException.ThrowIfNull(host);
            var reauthorizedActor = PlatformActorBoundaryFilter.ReauthorizeUserActor(boundaryActor, host);
            if (reauthorizedActor is null
                || reauthorizedActor.Kind != PlatformActorKind.JellyfinUserClient
                || !reauthorizedActor.IsElevated
                || reauthorizedActor.UserId == Guid.Empty)
            {
                throw new ArgumentException(
                    "The registry boundary requires a freshly elevated Jellyfin user.",
                    nameof(reauthorizedActor));
            }

            return new PlatformProviderAdminAuthorization(
                reauthorizedActor.UserId,
                boundaryActor,
                host);
        }
    }

    /// <summary>
    /// A typed optimistic-concurrency command. It contains expected facts only and carries no
    /// administrator authority; the current actor is checked separately at execution time.
    /// </summary>
    internal sealed class PlatformProviderAdminCommand
    {
        private PlatformProviderAdminCommand(
            PlatformProviderAdminOperation operation,
            long expectedRevision,
            Guid pluginId,
            long expectedGeneration,
            string expectedFingerprint,
            IReadOnlyList<string>? grantedCapabilityIds,
            string reason)
        {
            Operation = operation;
            ExpectedRevision = expectedRevision;
            PluginId = pluginId;
            ExpectedGeneration = expectedGeneration;
            ExpectedFingerprint = expectedFingerprint;
            HasGrantedCapabilityIds = grantedCapabilityIds is not null;
            IsGrantedCapabilityInputBounded = grantedCapabilityIds is null
                || grantedCapabilityIds.Count <= PlatformCapabilityVocabulary.MaximumCapabilityCount;
            GrantedCapabilityIds = grantedCapabilityIds is null || !IsGrantedCapabilityInputBounded
                ? ImmutableArray<string>.Empty
                : ImmutableArray.CreateRange(grantedCapabilityIds);
            Reason = reason;
        }

        internal PlatformProviderAdminOperation Operation { get; }

        internal long ExpectedRevision { get; }

        internal Guid PluginId { get; }

        internal long ExpectedGeneration { get; }

        internal string ExpectedFingerprint { get; }

        internal ImmutableArray<string> GrantedCapabilityIds { get; }

        internal bool HasGrantedCapabilityIds { get; }

        internal bool IsGrantedCapabilityInputBounded { get; }

        internal string Reason { get; }

        internal static PlatformProviderAdminCommand Approve(
            long expectedRevision,
            Guid pluginId,
            long expectedGeneration,
            string expectedFingerprint,
            IReadOnlyList<string> grantedCapabilityIds,
            string reason) =>
            new(
                PlatformProviderAdminOperation.Approve,
                expectedRevision,
                pluginId,
                expectedGeneration,
                expectedFingerprint,
                grantedCapabilityIds,
                reason);

        internal static PlatformProviderAdminCommand ReplaceGrant(
            long expectedRevision,
            Guid pluginId,
            long expectedGeneration,
            string expectedFingerprint,
            IReadOnlyList<string> grantedCapabilityIds,
            string reason) =>
            new(
                PlatformProviderAdminOperation.ReplaceGrant,
                expectedRevision,
                pluginId,
                expectedGeneration,
                expectedFingerprint,
                grantedCapabilityIds,
                reason);

        internal static PlatformProviderAdminCommand Disable(
            long expectedRevision,
            Guid pluginId,
            long expectedGeneration,
            string expectedFingerprint,
            string reason) =>
            new(
                PlatformProviderAdminOperation.Disable,
                expectedRevision,
                pluginId,
                expectedGeneration,
                expectedFingerprint,
                null,
                reason);

        internal static PlatformProviderAdminCommand Enable(
            long expectedRevision,
            Guid pluginId,
            long expectedGeneration,
            string expectedFingerprint,
            string reason) =>
            new(
                PlatformProviderAdminOperation.Enable,
                expectedRevision,
                pluginId,
                expectedGeneration,
                expectedFingerprint,
                null,
                reason);

        internal static PlatformProviderAdminCommand Revoke(
            long expectedRevision,
            Guid pluginId,
            long expectedGeneration,
            string expectedFingerprint,
            string reason) =>
            new(
                PlatformProviderAdminOperation.Revoke,
                expectedRevision,
                pluginId,
                expectedGeneration,
                expectedFingerprint,
                null,
                reason);
    }

    /// <summary>A typed explicit request to discard quarantined authority state.</summary>
    internal sealed class PlatformProviderRegistryRecoveryCommand
    {
        internal PlatformProviderRegistryRecoveryCommand(string reason) => Reason = reason;

        internal string Reason { get; }
    }

    /// <summary>One immutable registry entry safe to retain across later mutations.</summary>
    internal sealed class PlatformProviderRegistryEntry
    {
        internal PlatformProviderRegistryEntry(
            Guid pluginId,
            long generation,
            PlatformProviderLifecycleState state,
            string? fingerprint,
            ImmutableArray<string> requestedCapabilityIds,
            string? approvedFingerprint,
            ImmutableArray<string> grantedCapabilityIds)
        {
            PluginId = pluginId;
            Generation = generation;
            State = state;
            Fingerprint = fingerprint;
            RequestedCapabilityIds = requestedCapabilityIds;
            ApprovedFingerprint = approvedFingerprint;
            GrantedCapabilityIds = grantedCapabilityIds;
        }

        internal Guid PluginId { get; }

        internal long Generation { get; }

        internal PlatformProviderLifecycleState State { get; }

        internal string? Fingerprint { get; }

        internal ImmutableArray<string> RequestedCapabilityIds { get; }

        internal string? ApprovedFingerprint { get; }

        internal ImmutableArray<string> GrantedCapabilityIds { get; }
    }

    /// <summary>An immutable whole-registry publication.</summary>
    internal sealed class PlatformProviderRegistrySnapshot
    {
        internal PlatformProviderRegistrySnapshot(
            long revision,
            PlatformProviderRegistryStoreHealth storeHealth,
            ImmutableArray<PlatformProviderRegistryEntry> entries)
        {
            Revision = revision;
            StoreHealth = storeHealth;
            Entries = entries;
        }

        internal long Revision { get; }

        internal PlatformProviderRegistryStoreHealth StoreHealth { get; }

        internal ImmutableArray<PlatformProviderRegistryEntry> Entries { get; }
    }

    /// <summary>
    /// Ephemeral authority released only from an exact current enabled registry generation.
    /// </summary>
    internal sealed class PlatformProviderAuthorityRelease
    {
        internal PlatformProviderAuthorityRelease(
            PlatformApprovedProviderIdentity identity,
            ImmutableArray<string> grantedCapabilityIds,
            long generation)
        {
            Identity = identity;
            GrantedCapabilityIds = grantedCapabilityIds;
            Generation = generation;
        }

        internal PlatformApprovedProviderIdentity Identity { get; }

        internal ImmutableArray<string> GrantedCapabilityIds { get; }

        internal long Generation { get; }
    }

    /// <summary>Closed outcomes for exact provider-operation binding admission.</summary>
    internal enum PlatformProviderOperationBindingClaimStatus
    {
        Claimed = 1,
        AuthorityUnavailable = 2,
        OperationUnavailable = 3,
        ProtocolUnsupported = 4,
        GrantInsufficient = 5,
    }

    /// <summary>
    /// One immutable, inert description of an exact current provider operation. A claim
    /// carries no provider object or reusable authority: the registry must revalidate it
    /// after foreign binding before anything may be published.
    /// </summary>
    internal sealed class PlatformProviderOperationBindingClaim
    {
        private readonly object _registryOwner;
        private readonly object _claimEpoch;

        private PlatformProviderOperationBindingClaim(
            object registryOwner,
            object claimEpoch,
            Guid pluginId,
            string fingerprint,
            long generation,
            Version hostVersion,
            string assemblyIdentity,
            int negotiatedProtocol,
            PlatformProviderOperationDeclaration operation,
            ImmutableArray<string> grantedCapabilityIds)
        {
            _registryOwner = registryOwner;
            _claimEpoch = claimEpoch;
            PluginId = pluginId;
            Fingerprint = fingerprint;
            Generation = generation;
            HostVersion = hostVersion;
            AssemblyIdentity = assemblyIdentity;
            NegotiatedProtocol = negotiatedProtocol;
            Operation = operation;
            GrantedCapabilityIds = ImmutableArray.CreateRange(grantedCapabilityIds);
        }

        internal Guid PluginId { get; }

        internal string Fingerprint { get; }

        internal long Generation { get; }

        internal Version HostVersion { get; }

        internal string AssemblyIdentity { get; }

        internal int NegotiatedProtocol { get; }

        internal PlatformProviderOperationDeclaration Operation { get; }

        internal ImmutableArray<string> GrantedCapabilityIds { get; }

        internal bool IsOwnedBy(object registryOwner, object claimEpoch) =>
            ReferenceEquals(_registryOwner, registryOwner)
            && ReferenceEquals(_claimEpoch, claimEpoch);

        internal static PlatformProviderOperationBindingClaim EstablishCurrentRegistryClaim(
            object registryOwner,
            object claimEpoch,
            Guid pluginId,
            string fingerprint,
            long generation,
            Version hostVersion,
            string assemblyIdentity,
            int negotiatedProtocol,
            PlatformProviderOperationDeclaration operation,
            ImmutableArray<string> grantedCapabilityIds)
        {
            ArgumentNullException.ThrowIfNull(registryOwner);
            ArgumentNullException.ThrowIfNull(claimEpoch);
            ArgumentNullException.ThrowIfNull(hostVersion);
            ArgumentNullException.ThrowIfNull(operation);
            if (pluginId == Guid.Empty
                || generation <= 0
                || string.IsNullOrEmpty(fingerprint)
                || string.IsNullOrWhiteSpace(assemblyIdentity)
                || negotiatedProtocol <= 0
                || grantedCapabilityIds.IsDefault)
            {
                throw new ArgumentException("A binding claim requires exact bounded current facts.");
            }

            return new PlatformProviderOperationBindingClaim(
                registryOwner,
                claimEpoch,
                pluginId,
                fingerprint,
                generation,
                hostVersion,
                assemblyIdentity,
                negotiatedProtocol,
                operation,
                grantedCapabilityIds);
        }
    }

    /// <summary>One closed result from a registry-owned operation-binding claim attempt.</summary>
    internal readonly record struct PlatformProviderOperationBindingClaimResult
    {
        private PlatformProviderOperationBindingClaimResult(
            PlatformProviderOperationBindingClaimStatus status,
            PlatformProviderOperationBindingClaim? claim)
        {
            if (!Enum.IsDefined(status)
                || (status == PlatformProviderOperationBindingClaimStatus.Claimed) != (claim is not null))
            {
                throw new ArgumentOutOfRangeException(nameof(status));
            }

            Status = status;
            Claim = claim;
        }

        internal PlatformProviderOperationBindingClaimStatus Status { get; }

        internal PlatformProviderOperationBindingClaim? Claim { get; }

        internal static PlatformProviderOperationBindingClaimResult Claimed(
            PlatformProviderOperationBindingClaim claim)
        {
            ArgumentNullException.ThrowIfNull(claim);
            return new PlatformProviderOperationBindingClaimResult(
                PlatformProviderOperationBindingClaimStatus.Claimed,
                claim);
        }

        internal static PlatformProviderOperationBindingClaimResult Refused(
            PlatformProviderOperationBindingClaimStatus status) =>
            new(status, null);
    }

    /// <summary>One immutable persisted provider record with no reusable authority proof.</summary>
    internal sealed class PlatformProviderRegistryDurableRecord
    {
        internal PlatformProviderRegistryDurableRecord(
            Guid pluginId,
            long generation,
            string? lastFingerprint,
            string? lastHostVersion,
            string? lastAssemblyIdentity,
            int lastHostStatus,
            PlatformInstalledManifestOutcome lastOutcome,
            PlatformInstalledManifestCompatibility? lastCompatibility,
            ImmutableArray<string> lastRequestedCapabilityIds,
            bool wasAbsent,
            PlatformProviderDurableDisposition disposition,
            string? approvedFingerprint,
            ImmutableArray<string> grantedCapabilityIds,
            Guid? administratorId,
            string? reason,
            DateTimeOffset? decidedAtUtc,
            long? decidedAtRevision)
        {
            PluginId = pluginId;
            Generation = generation;
            LastFingerprint = lastFingerprint;
            LastHostVersion = lastHostVersion;
            LastAssemblyIdentity = lastAssemblyIdentity;
            LastHostStatus = lastHostStatus;
            LastOutcome = lastOutcome;
            LastCompatibility = lastCompatibility;
            LastRequestedCapabilityIds = lastRequestedCapabilityIds;
            WasAbsent = wasAbsent;
            Disposition = disposition;
            ApprovedFingerprint = approvedFingerprint;
            GrantedCapabilityIds = grantedCapabilityIds;
            AdministratorId = administratorId;
            Reason = reason;
            DecidedAtUtc = decidedAtUtc;
            DecidedAtRevision = decidedAtRevision;
        }

        internal Guid PluginId { get; }

        internal long Generation { get; }

        internal string? LastFingerprint { get; }

        internal string? LastHostVersion { get; }

        internal string? LastAssemblyIdentity { get; }

        internal int LastHostStatus { get; }

        internal PlatformInstalledManifestOutcome LastOutcome { get; }

        internal PlatformInstalledManifestCompatibility? LastCompatibility { get; }

        internal ImmutableArray<string> LastRequestedCapabilityIds { get; }

        internal bool WasAbsent { get; }

        internal PlatformProviderDurableDisposition Disposition { get; }

        internal string? ApprovedFingerprint { get; }

        internal ImmutableArray<string> GrantedCapabilityIds { get; }

        internal Guid? AdministratorId { get; }

        internal string? Reason { get; }

        internal DateTimeOffset? DecidedAtUtc { get; }

        internal long? DecidedAtRevision { get; }

        internal PlatformProviderRegistryDurableRecord WithObservation(
            long generation,
            PlatformInstalledManifestObservation observation,
            bool wasAbsent,
            PlatformProviderDurableDisposition disposition,
            string? approvedFingerprint,
            ImmutableArray<string> grantedCapabilityIds) =>
            new(
                PluginId,
                generation,
                observation.BoundManifest?.Fingerprint.Value ?? LastFingerprint,
                observation.BoundManifest?.HostVersion.ToString() ?? LastHostVersion,
                observation.BoundManifest?.AssemblyIdentity ?? LastAssemblyIdentity,
                (int)observation.HostStatus,
                observation.Outcome,
                observation.Compatibility,
                observation.BoundManifest?.Manifest.RequestedCapabilities.Capabilities
                    .Select(value => value.Id.Value)
                    .ToImmutableArray() ?? LastRequestedCapabilityIds,
                wasAbsent,
                disposition,
                approvedFingerprint,
                grantedCapabilityIds,
                AdministratorId,
                Reason,
                DecidedAtUtc,
                DecidedAtRevision);

        internal PlatformProviderRegistryDurableRecord WithDecision(
            long generation,
            PlatformProviderDurableDisposition disposition,
            string? approvedFingerprint,
            ImmutableArray<string> grantedCapabilityIds,
            Guid administratorId,
            string reason,
            DateTimeOffset decidedAtUtc,
            long decidedAtRevision) =>
            new(
                PluginId,
                generation,
                LastFingerprint,
                LastHostVersion,
                LastAssemblyIdentity,
                LastHostStatus,
                LastOutcome,
                LastCompatibility,
                LastRequestedCapabilityIds,
                WasAbsent,
                disposition,
                approvedFingerprint,
                grantedCapabilityIds,
                administratorId,
                reason,
                decidedAtUtc,
                decidedAtRevision);

        internal PlatformProviderRegistryDurableRecord MarkAbsent(long generation) =>
            new(
                PluginId,
                generation,
                LastFingerprint,
                LastHostVersion,
                LastAssemblyIdentity,
                LastHostStatus,
                LastOutcome,
                LastCompatibility,
                LastRequestedCapabilityIds,
                true,
                Disposition == PlatformProviderDurableDisposition.Revoked
                    ? PlatformProviderDurableDisposition.Revoked
                    : PlatformProviderDurableDisposition.None,
                null,
                ImmutableArray<string>.Empty,
                AdministratorId,
                Reason,
                DecidedAtUtc,
                DecidedAtRevision);
    }

    /// <summary>The immutable versioned state passed to the persistence owner.</summary>
    internal sealed class PlatformProviderRegistryDurableState
    {
        internal static PlatformProviderRegistryDurableState Empty { get; } =
            new(0, ImmutableArray<PlatformProviderRegistryDurableRecord>.Empty);

        internal PlatformProviderRegistryDurableState(
            long revision,
            ImmutableArray<PlatformProviderRegistryDurableRecord> records)
        {
            Revision = revision;
            Records = records;
        }

        internal long Revision { get; }

        internal ImmutableArray<PlatformProviderRegistryDurableRecord> Records { get; }
    }

    /// <summary>Closed store hydration result; quarantined state never exposes records.</summary>
    internal sealed class PlatformProviderRegistryStoreLoadResult
    {
        private PlatformProviderRegistryStoreLoadResult(
            PlatformProviderRegistryStoreHealth health,
            PlatformProviderRegistryDurableState state)
        {
            Health = health;
            State = state;
        }

        internal PlatformProviderRegistryStoreHealth Health { get; }

        internal PlatformProviderRegistryDurableState State { get; }

        internal static PlatformProviderRegistryStoreLoadResult Healthy(
            PlatformProviderRegistryDurableState state)
        {
            ArgumentNullException.ThrowIfNull(state);
            return new PlatformProviderRegistryStoreLoadResult(
                PlatformProviderRegistryStoreHealth.Healthy,
                state);
        }

        internal static PlatformProviderRegistryStoreLoadResult Quarantined() =>
            new(
                PlatformProviderRegistryStoreHealth.Quarantined,
                PlatformProviderRegistryDurableState.Empty);
    }

    /// <summary>The narrow persistence seam used by the registry owner.</summary>
    internal interface IPlatformProviderRegistryStateStore
    {
        PlatformProviderRegistryStoreLoadResult Load();

        void Save(PlatformProviderRegistryDurableState state);

        void ResetQuarantined(Guid administratorId, string reason, DateTimeOffset decidedAtUtc);

        void FenceQuarantined();
    }
}
