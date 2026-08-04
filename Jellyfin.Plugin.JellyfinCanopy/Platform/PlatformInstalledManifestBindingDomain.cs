using System;
using System.Collections.Generic;
using System.Collections;
using System.Collections.Immutable;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>Hard acquisition limits applied before native resources are allocated.</summary>
    internal static class PlatformInstalledManifestLimits
    {
        internal const int MaximumDllFileCount = 128;
    }

    /// <summary>Closed one-shot outcomes for installed manifest acquisition and binding.</summary>
    internal enum PlatformInstalledManifestOutcome
    {
        Acquired = 0,
        ManifestAbsent = 1,
        HostMetadataInvalid = 2,
        AmbiguousHostIdentity = 3,
        HostStatusNotActive = 4,
        UnsafeOrUnverifiableRoot = 5,
        UnsafeTarget = 6,
        OpenTimedOut = 7,
        NotRegularFile = 8,
        DescriptorUnverifiable = 9,
        DocumentTooLarge = 10,
        ReadChanged = 11,
        ReadFailed = 12,
        ManifestRejected = 13,
        PluginIdMismatch = 14,
        PluginVersionMismatch = 15,
        AssemblyUnavailable = 16,
        AssemblyMismatch = 17,
        HostSnapshotChanged = 18,
        AcquisitionFailed = 19,
    }

    /// <summary>Compatibility is an observation, never an acquisition or approval outcome.</summary>
    internal enum PlatformInstalledManifestCompatibility
    {
        Compatible = 0,
        PlatformIncompatible = 1,
        HostIncompatible = 2,
    }

    /// <summary>Owned result returned by the fixed-name descriptor-safe reader.</summary>
    internal sealed class PlatformInstalledManifestReadResult
    {
        private PlatformInstalledManifestReadResult(
            PlatformInstalledManifestOutcome outcome,
            ImmutableArray<byte> bytes,
            string? assemblyIdentity)
        {
            Outcome = outcome;
            Bytes = bytes;
            AssemblyIdentity = assemblyIdentity;
        }

        internal PlatformInstalledManifestOutcome Outcome { get; }

        internal ImmutableArray<byte> Bytes { get; }

        internal string? AssemblyIdentity { get; }

        internal static PlatformInstalledManifestReadResult Acquired(
            byte[] bytes,
            string? assemblyIdentity)
        {
            ArgumentNullException.ThrowIfNull(bytes);
            return new PlatformInstalledManifestReadResult(
                PlatformInstalledManifestOutcome.Acquired,
                ImmutableArray.CreateRange(bytes),
                assemblyIdentity);
        }

        internal static PlatformInstalledManifestReadResult Rejected(
            PlatformInstalledManifestOutcome outcome)
        {
            if (outcome == PlatformInstalledManifestOutcome.Acquired)
            {
                throw new ArgumentOutOfRangeException(nameof(outcome));
            }

            return new PlatformInstalledManifestReadResult(outcome, ImmutableArray<byte>.Empty, null);
        }
    }

    /// <summary>Reads only the fixed extension manifest for a host-issued plugin snapshot.</summary>
    internal interface IPlatformInstalledManifestReader
    {
        ValueTask<PlatformInstalledManifestReadResult> ReadAsync(
            PlatformInstalledPluginSnapshot snapshot,
            CancellationToken cancellationToken);
    }

    /// <summary>
    /// Immutable host-bound manifest facts. This remains unapproved and carries no authority.
    /// </summary>
    internal sealed class HostBoundInstalledManifest
    {
        private HostBoundInstalledManifest(
            Guid pluginId,
            string hostName,
            Version hostVersion,
            PlatformInstalledPluginHostStatus hostStatus,
            string assemblyIdentity,
            PlatformExtensionManifest manifest,
            PlatformInstalledManifestCompatibility compatibility)
        {
            PluginId = pluginId;
            HostName = hostName;
            HostVersion = hostVersion;
            HostStatus = hostStatus;
            AssemblyIdentity = assemblyIdentity;
            Manifest = manifest;
            Compatibility = compatibility;
        }

        internal Guid PluginId { get; }

        internal string HostName { get; }

        internal Version HostVersion { get; }

        internal PlatformInstalledPluginHostStatus HostStatus { get; }

        internal string AssemblyIdentity { get; }

        internal PlatformExtensionManifest Manifest { get; }

        internal PlatformManifestFingerprint Fingerprint => Manifest.Fingerprint;

        internal PlatformInstalledManifestCompatibility Compatibility { get; }

        internal static HostBoundInstalledManifest EstablishBoundManifest(
            PlatformInstalledPluginSnapshot snapshot,
            string assemblyIdentity,
            PlatformExtensionManifest manifest,
            PlatformInstalledManifestCompatibility compatibility) => new(
                snapshot.PluginId,
                snapshot.Name,
                snapshot.Version,
                snapshot.Status,
                assemblyIdentity,
                manifest,
                compatibility);
    }

    /// <summary>One immutable redaction-safe observation from an explicit sweep.</summary>
    internal sealed class PlatformInstalledManifestObservation
    {
        private PlatformInstalledManifestObservation(
            Guid pluginId,
            PlatformInstalledPluginHostStatus hostStatus,
            PlatformInstalledManifestOutcome outcome,
            PlatformInstalledManifestCompatibility? compatibility,
            HostBoundInstalledManifest? boundManifest,
            PlatformExtensionManifestRejectionReason? manifestRejectionReason)
        {
            PluginId = pluginId;
            HostStatus = hostStatus;
            Outcome = outcome;
            Compatibility = compatibility;
            BoundManifest = boundManifest;
            ManifestRejectionReason = manifestRejectionReason;
        }

        internal Guid PluginId { get; }

        internal PlatformInstalledPluginHostStatus HostStatus { get; }

        internal PlatformInstalledManifestOutcome Outcome { get; }

        internal PlatformInstalledManifestCompatibility? Compatibility { get; }

        internal HostBoundInstalledManifest? BoundManifest { get; }

        internal PlatformExtensionManifestRejectionReason? ManifestRejectionReason { get; }

        internal static PlatformInstalledManifestObservation Rejected(
            PlatformInstalledPluginSnapshot snapshot,
            PlatformInstalledManifestOutcome outcome,
            PlatformExtensionManifestRejectionReason? manifestRejectionReason = null)
        {
            ArgumentNullException.ThrowIfNull(snapshot);
            if (outcome == PlatformInstalledManifestOutcome.Acquired)
            {
                throw new ArgumentOutOfRangeException(nameof(outcome));
            }

            return new PlatformInstalledManifestObservation(
                snapshot.PluginId,
                snapshot.Status,
                outcome,
                null,
                null,
                manifestRejectionReason);
        }

        internal static PlatformInstalledManifestObservation Acquired(
            PlatformInstalledPluginSnapshot snapshot,
            HostBoundInstalledManifest manifest) => new(
                snapshot.PluginId,
                snapshot.Status,
                PlatformInstalledManifestOutcome.Acquired,
                manifest.Compatibility,
                manifest,
                null);
    }

    /// <summary>
    /// A fully materialized sweep completion token. Cancellation and acquisition failure paths
    /// cannot mint this value, so an omission can only mean absence after this exact boundary.
    /// </summary>
    internal sealed class PlatformInstalledManifestSweep : IReadOnlyList<PlatformInstalledManifestObservation>
    {
        private readonly ImmutableArray<PlatformInstalledManifestObservation> _observations;

        private PlatformInstalledManifestSweep(
            ImmutableArray<PlatformInstalledManifestObservation> observations) =>
            _observations = observations;

        internal int Length => _observations.Length;

        public int Count => _observations.Length;

        public PlatformInstalledManifestObservation this[int index] => _observations[index];

        internal ImmutableArray<PlatformInstalledManifestObservation> Observations => _observations;

        public IEnumerator<PlatformInstalledManifestObservation> GetEnumerator() =>
            ((IEnumerable<PlatformInstalledManifestObservation>)_observations).GetEnumerator();

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();

        internal static PlatformInstalledManifestSweep EstablishCompleted(
            ImmutableArray<PlatformInstalledManifestObservation> observations)
        {
            if (observations.IsDefault)
            {
                throw new ArgumentException("A completed sweep cannot contain a default array.", nameof(observations));
            }

            return new PlatformInstalledManifestSweep(observations);
        }
    }

    /// <summary>Pure parser handoff, host binding and compatibility observation.</summary>
    internal static class PlatformInstalledManifestBinder
    {
        internal const int PlatformMajor = 1;
        internal const int JellyfinHostMajor = 12;

        internal static PlatformInstalledManifestObservation Bind(
            PlatformInstalledPluginSnapshot before,
            PlatformInstalledPluginSnapshot? after,
            PlatformInstalledManifestReadResult readResult)
        {
            ArgumentNullException.ThrowIfNull(before);
            ArgumentNullException.ThrowIfNull(readResult);

            if (!HasValidHostMetadata(before))
            {
                return PlatformInstalledManifestObservation.Rejected(
                    before,
                    PlatformInstalledManifestOutcome.HostMetadataInvalid);
            }

            if (before.Status != PlatformInstalledPluginHostStatus.Active)
            {
                return PlatformInstalledManifestObservation.Rejected(
                    before,
                    PlatformInstalledManifestOutcome.HostStatusNotActive);
            }

            if (after is null || !SameSnapshot(before, after))
            {
                return PlatformInstalledManifestObservation.Rejected(
                    before,
                    PlatformInstalledManifestOutcome.HostSnapshotChanged);
            }

            if (readResult.Outcome != PlatformInstalledManifestOutcome.Acquired)
            {
                return PlatformInstalledManifestObservation.Rejected(before, readResult.Outcome);
            }

            if (string.IsNullOrWhiteSpace(readResult.AssemblyIdentity))
            {
                return PlatformInstalledManifestObservation.Rejected(
                    before,
                    PlatformInstalledManifestOutcome.AssemblyUnavailable);
            }

            if (!PlatformExtensionManifestParser.TryParse(
                    readResult.Bytes.ToArray(),
                    out var manifest,
                    out var rejectionReason))
            {
                return PlatformInstalledManifestObservation.Rejected(
                    before,
                    PlatformInstalledManifestOutcome.ManifestRejected,
                    rejectionReason);
            }

            if (manifest!.PluginId != before.PluginId)
            {
                return PlatformInstalledManifestObservation.Rejected(
                    before,
                    PlatformInstalledManifestOutcome.PluginIdMismatch);
            }

            if (!manifest.Version.Equals(before.Version))
            {
                return PlatformInstalledManifestObservation.Rejected(
                    before,
                    PlatformInstalledManifestOutcome.PluginVersionMismatch);
            }

            var compatibility = ObserveCompatibility(manifest);
            var bound = HostBoundInstalledManifest.EstablishBoundManifest(
                before,
                readResult.AssemblyIdentity!,
                manifest,
                compatibility);
            return PlatformInstalledManifestObservation.Acquired(before, bound);
        }

        internal static bool HasValidHostMetadata(PlatformInstalledPluginSnapshot snapshot) =>
            snapshot.PluginId != Guid.Empty
            && !string.IsNullOrWhiteSpace(snapshot.Name)
            && snapshot.Version is not null
            && snapshot.Version.Major >= 0
            && snapshot.Version.Minor >= 0
            && !string.IsNullOrWhiteSpace(snapshot.ReportedRoot)
            && snapshot.DllFiles.Length <= PlatformInstalledManifestLimits.MaximumDllFileCount;

        private static bool SameSnapshot(
            PlatformInstalledPluginSnapshot left,
            PlatformInstalledPluginSnapshot right) =>
            left.PluginId == right.PluginId
            && left.Version.Equals(right.Version)
            && left.Status == right.Status
            && string.Equals(left.ReportedRoot, right.ReportedRoot, StringComparison.Ordinal)
            && left.DllFiles.SequenceEqual(right.DllFiles, StringComparer.Ordinal);

        private static PlatformInstalledManifestCompatibility ObserveCompatibility(
            PlatformExtensionManifest manifest)
        {
            if (PlatformMajor < manifest.PlatformRange.Min || PlatformMajor > manifest.PlatformRange.Max)
            {
                return PlatformInstalledManifestCompatibility.PlatformIncompatible;
            }

            return JellyfinHostMajor < manifest.HostRange.MinMajor
                || JellyfinHostMajor > manifest.HostRange.MaxMajor
                    ? PlatformInstalledManifestCompatibility.HostIncompatible
                    : PlatformInstalledManifestCompatibility.Compatible;
        }
    }

    /// <summary>One explicit, side-effect-free and fully materialized installed-plugin sweep.</summary>
    internal static class PlatformInstalledManifestDiscovery
    {
        internal const int MaximumPluginCount = 1024;
        internal const int MaximumConcurrentAcquisitions = 1;

        internal static async ValueTask<PlatformInstalledManifestSweep> SweepAsync(
            IReadOnlyList<PlatformInstalledPluginSnapshot> inventory,
            IPlatformInstalledManifestReader reader,
            Func<Guid, CancellationToken, ValueTask<PlatformInstalledPluginSnapshot?>> reobserve,
            CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(inventory);
            ArgumentNullException.ThrowIfNull(reader);
            ArgumentNullException.ThrowIfNull(reobserve);
            cancellationToken.ThrowIfCancellationRequested();

            var snapshots = inventory.ToArray();
            if (snapshots.Length > MaximumPluginCount)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var rejected = snapshots
                    .OrderBy(snapshot => snapshot.PluginId)
                    .Select(snapshot => PlatformInstalledManifestObservation.Rejected(
                        snapshot,
                        PlatformInstalledManifestOutcome.HostMetadataInvalid))
                    .ToImmutableArray();
                cancellationToken.ThrowIfCancellationRequested();
                return PlatformInstalledManifestSweep.EstablishCompleted(rejected);
            }

            var hasInvalidMetadata = snapshots.Any(
                snapshot => !PlatformInstalledManifestBinder.HasValidHostMetadata(snapshot));
            var duplicateIds = snapshots
                .Where(snapshot => snapshot.PluginId != Guid.Empty)
                .GroupBy(snapshot => snapshot.PluginId)
                .Where(group => group.Count() > 1)
                .Select(group => group.Key)
                .ToHashSet();
            var invalidInventory = hasInvalidMetadata || duplicateIds.Count > 0;
            if (invalidInventory)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var rejected = snapshots
                    .OrderBy(snapshot => snapshot.PluginId)
                    .Select(snapshot => PlatformInstalledManifestObservation.Rejected(
                        snapshot,
                        duplicateIds.Contains(snapshot.PluginId)
                            ? PlatformInstalledManifestOutcome.AmbiguousHostIdentity
                            : PlatformInstalledManifestOutcome.HostMetadataInvalid))
                    .ToImmutableArray();
                cancellationToken.ThrowIfCancellationRequested();
                return PlatformInstalledManifestSweep.EstablishCompleted(rejected);
            }

            var observations = ImmutableArray.CreateBuilder<PlatformInstalledManifestObservation>(
                snapshots.Length);
            foreach (var snapshot in snapshots.OrderBy(value => value.PluginId))
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (snapshot.Status != PlatformInstalledPluginHostStatus.Active)
                {
                    observations.Add(PlatformInstalledManifestObservation.Rejected(
                        snapshot,
                        PlatformInstalledManifestOutcome.HostStatusNotActive));
                    continue;
                }

                try
                {
                    var readResult = await reader.ReadAsync(snapshot, cancellationToken).ConfigureAwait(false);
                    cancellationToken.ThrowIfCancellationRequested();
                    var current = await reobserve(snapshot.PluginId, cancellationToken).ConfigureAwait(false);
                    cancellationToken.ThrowIfCancellationRequested();
                    observations.Add(PlatformInstalledManifestBinder.Bind(snapshot, current, readResult));
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception)
                {
                    observations.Add(PlatformInstalledManifestObservation.Rejected(
                        snapshot,
                        PlatformInstalledManifestOutcome.AcquisitionFailed));
                }
            }

            cancellationToken.ThrowIfCancellationRequested();
            return PlatformInstalledManifestSweep.EstablishCompleted(observations.MoveToImmutable());
        }
    }
}
