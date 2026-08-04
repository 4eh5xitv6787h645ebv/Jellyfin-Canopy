using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Threading;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>
    /// The authoritative installed-provider registry. Durable records remain dormant facts;
    /// authority is released only from a current exact enabled observation under this lock.
    /// </summary>
    internal sealed class PlatformProviderRegistry
    {
        internal const int MaximumProviderCount = PlatformInstalledManifestDiscovery.MaximumPluginCount;
        internal const int MaximumReasonLength = 256;

        private readonly object _gate = new();
        private readonly IPlatformProviderRegistryStateStore _store;
        private readonly TimeProvider _timeProvider;
        private PlatformProviderRegistryDurableState _durable;
        private ImmutableDictionary<Guid, PlatformInstalledManifestObservation> _current;
        private PlatformProviderRegistrySnapshot _snapshot;
        private bool _authorityReleaseFenced;

        internal PlatformProviderRegistry(
            IPlatformProviderRegistryStateStore store,
            TimeProvider timeProvider)
        {
            ArgumentNullException.ThrowIfNull(store);
            ArgumentNullException.ThrowIfNull(timeProvider);
            _store = store;
            _timeProvider = timeProvider;

            PlatformProviderRegistryStoreLoadResult loaded;
            try
            {
                loaded = store.Load();
            }
            catch (Exception)
            {
                loaded = PlatformProviderRegistryStoreLoadResult.Quarantined();
            }

            if (loaded.Health != PlatformProviderRegistryStoreHealth.Healthy
                || !IsValidDurableState(loaded.State))
            {
                _durable = PlatformProviderRegistryDurableState.Empty;
                _current = ImmutableDictionary<Guid, PlatformInstalledManifestObservation>.Empty;
                _snapshot = new PlatformProviderRegistrySnapshot(
                    0,
                    PlatformProviderRegistryStoreHealth.Quarantined,
                    ImmutableArray<PlatformProviderRegistryEntry>.Empty);
                return;
            }

            _durable = loaded.State;
            _current = ImmutableDictionary<Guid, PlatformInstalledManifestObservation>.Empty;
            _snapshot = BuildSnapshot(
                _durable,
                _current,
                PlatformProviderRegistryStoreHealth.Healthy);
        }

        internal PlatformProviderRegistrySnapshot Snapshot => Volatile.Read(ref _snapshot);

        internal PlatformProviderRegistryMutationResult Reconcile(
            PlatformInstalledManifestSweep sweep)
        {
            ArgumentNullException.ThrowIfNull(sweep);
            var observations = sweep.Observations;

            lock (_gate)
            {
                if (_snapshot.StoreHealth != PlatformProviderRegistryStoreHealth.Healthy)
                {
                    return Result(PlatformProviderRegistryMutationStatus.StoreQuarantined);
                }

                if (observations.IsDefault
                    || observations.Length > MaximumProviderCount
                    || observations.Any(value => value is null || value.PluginId == Guid.Empty)
                    || observations.GroupBy(value => value.PluginId).Any(group => group.Count() != 1))
                {
                    _authorityReleaseFenced = true;
                    return Result(PlatformProviderRegistryMutationStatus.InvalidSweep);
                }

                var copied = observations
                    .OrderBy(value => value.PluginId)
                    .ToImmutableArray();

                var oldById = _durable.Records.ToDictionary(value => value.PluginId);
                var nextById = new Dictionary<Guid, PlatformProviderRegistryDurableRecord>(oldById);
                var currentBuilder = ImmutableDictionary.CreateBuilder<Guid, PlatformInstalledManifestObservation>();

                try
                {
                    foreach (var observation in copied)
                    {
                        currentBuilder.Add(observation.PluginId, observation);
                        oldById.TryGetValue(observation.PluginId, out var existing);
                        nextById[observation.PluginId] = ReconcileObservation(existing, observation);
                    }

                    var observedIds = copied.Select(value => value.PluginId).ToHashSet();
                    foreach (var existing in oldById.Values)
                    {
                        if (observedIds.Contains(existing.PluginId))
                        {
                            continue;
                        }

                        nextById[existing.PluginId] = existing.WasAbsent
                            ? existing
                            : existing.MarkAbsent(CheckedIncrement(existing.Generation));
                    }

                    var boundedRecords = BoundRecords(nextById.Values, observedIds);
                    if (boundedRecords.IsDefault)
                    {
                        return FenceStoreAndPublishQuarantine();
                    }

                    var nextDurable = new PlatformProviderRegistryDurableState(
                        CheckedIncrement(_durable.Revision),
                        boundedRecords);
                    var nextCurrent = currentBuilder.ToImmutable();
                    var nextSnapshot = BuildSnapshot(
                        nextDurable,
                        nextCurrent,
                        PlatformProviderRegistryStoreHealth.Healthy);
                    if (!TrySave(nextDurable))
                    {
                        _authorityReleaseFenced = true;
                        return Result(PlatformProviderRegistryMutationStatus.PersistenceFailed);
                    }

                    _durable = nextDurable;
                    _current = nextCurrent;
                    _authorityReleaseFenced = false;
                    Volatile.Write(ref _snapshot, nextSnapshot);
                    return Result(PlatformProviderRegistryMutationStatus.Applied);
                }
                catch (InvalidOperationException)
                {
                    _authorityReleaseFenced = true;
                    return Result(PlatformProviderRegistryMutationStatus.PersistenceFailed);
                }
            }
        }

        internal PlatformProviderRegistryMutationResult Apply(
            PlatformProviderAdminCommand command,
            PlatformProviderAdminAuthorization? authorization)
        {
            ArgumentNullException.ThrowIfNull(command);

            if (!IsValidCommandShape(command))
            {
                return Result(PlatformProviderRegistryMutationStatus.InvalidCommand);
            }

            lock (_gate)
            {
                if (authorization is null || !authorization.TryConsume(out var administratorId))
                {
                    return Result(PlatformProviderRegistryMutationStatus.ElevationRequired);
                }

                if (_snapshot.StoreHealth != PlatformProviderRegistryStoreHealth.Healthy)
                {
                    return Result(PlatformProviderRegistryMutationStatus.StoreQuarantined);
                }

                if (_authorityReleaseFenced)
                {
                    return Result(PlatformProviderRegistryMutationStatus.StaleProvider);
                }

                if (command.ExpectedRevision != _durable.Revision)
                {
                    return Result(PlatformProviderRegistryMutationStatus.StaleRevision);
                }

                var index = -1;
                for (var candidateIndex = 0; candidateIndex < _durable.Records.Length; candidateIndex++)
                {
                    if (_durable.Records[candidateIndex].PluginId == command.PluginId)
                    {
                        index = candidateIndex;
                        break;
                    }
                }
                if (index < 0)
                {
                    return Result(PlatformProviderRegistryMutationStatus.ProviderNotFound);
                }

                var record = _durable.Records[index];
                _current.TryGetValue(command.PluginId, out var observation);
                var currentManifest = observation?.BoundManifest;
                var isCurrentActive = observation?.Outcome == PlatformInstalledManifestOutcome.Acquired
                    && currentManifest is not null
                    && observation.Compatibility == PlatformInstalledManifestCompatibility.Compatible
                    && observation.HostStatus == PlatformInstalledPluginHostStatus.Active
                    && string.Equals(
                        currentManifest.Fingerprint.Value,
                        command.ExpectedFingerprint,
                        StringComparison.Ordinal);
                var revocationFingerprint = record.ApprovedFingerprint ?? record.LastFingerprint;
                if (record.Generation != command.ExpectedGeneration
                    || (command.Operation == PlatformProviderAdminOperation.Revoke
                        ? string.IsNullOrEmpty(revocationFingerprint)
                            || !string.Equals(
                                revocationFingerprint,
                                command.ExpectedFingerprint,
                                StringComparison.Ordinal)
                        : !isCurrentActive))
                {
                    return Result(PlatformProviderRegistryMutationStatus.StaleProvider);
                }

                var grantIds = record.GrantedCapabilityIds;
                var approvedFingerprint = record.ApprovedFingerprint;
                var disposition = record.Disposition;
                switch (command.Operation)
                {
                    case PlatformProviderAdminOperation.Approve:
                        if (record.Disposition == PlatformProviderDurableDisposition.Revoked
                            || !TryValidateGrant(currentManifest!, command.GrantedCapabilityIds, out grantIds))
                        {
                            return Result(PlatformProviderRegistryMutationStatus.InvalidGrant);
                        }

                        disposition = PlatformProviderDurableDisposition.Approved;
                        approvedFingerprint = command.ExpectedFingerprint;
                        break;

                    case PlatformProviderAdminOperation.ReplaceGrant:
                        if (record.Disposition is not (
                                PlatformProviderDurableDisposition.Approved
                                or PlatformProviderDurableDisposition.Disabled)
                            || !string.Equals(
                                record.ApprovedFingerprint,
                                command.ExpectedFingerprint,
                                StringComparison.Ordinal)
                            || !TryValidateGrant(currentManifest!, command.GrantedCapabilityIds, out grantIds))
                        {
                            return Result(PlatformProviderRegistryMutationStatus.InvalidGrant);
                        }

                        break;

                    case PlatformProviderAdminOperation.Disable:
                        if (record.Disposition != PlatformProviderDurableDisposition.Approved)
                        {
                            return Result(PlatformProviderRegistryMutationStatus.InvalidCommand);
                        }

                        disposition = PlatformProviderDurableDisposition.Disabled;
                        break;

                    case PlatformProviderAdminOperation.Enable:
                        if (record.Disposition != PlatformProviderDurableDisposition.Disabled
                            || !string.Equals(
                                record.ApprovedFingerprint,
                                command.ExpectedFingerprint,
                                StringComparison.Ordinal))
                        {
                            return Result(PlatformProviderRegistryMutationStatus.InvalidCommand);
                        }

                        disposition = PlatformProviderDurableDisposition.Approved;
                        break;

                    case PlatformProviderAdminOperation.Revoke:
                        if (record.Disposition == PlatformProviderDurableDisposition.Revoked)
                        {
                            return Result(PlatformProviderRegistryMutationStatus.InvalidCommand);
                        }

                        disposition = PlatformProviderDurableDisposition.Revoked;
                        approvedFingerprint = null;
                        grantIds = ImmutableArray<string>.Empty;
                        break;

                    default:
                        return Result(PlatformProviderRegistryMutationStatus.InvalidCommand);
                }

                if (_durable.Revision == long.MaxValue || record.Generation == long.MaxValue)
                {
                    return Result(PlatformProviderRegistryMutationStatus.PersistenceFailed);
                }

                var nextRevision = CheckedIncrement(_durable.Revision);
                var decided = record.WithDecision(
                    CheckedIncrement(record.Generation),
                    disposition,
                    approvedFingerprint,
                    grantIds,
                    administratorId,
                    command.Reason,
                    _timeProvider.GetUtcNow(),
                    nextRevision);
                var records = _durable.Records.SetItem(index, decided);
                var nextDurable = new PlatformProviderRegistryDurableState(
                    nextRevision,
                    records);
                var nextSnapshot = BuildSnapshot(
                    nextDurable,
                    _current,
                    PlatformProviderRegistryStoreHealth.Healthy);
                if (!TrySave(nextDurable))
                {
                    return Result(PlatformProviderRegistryMutationStatus.PersistenceFailed);
                }

                _durable = nextDurable;
                Volatile.Write(ref _snapshot, nextSnapshot);
                return Result(PlatformProviderRegistryMutationStatus.Applied);
            }
        }

        internal PlatformProviderRegistryMutationResult Recover(
            PlatformProviderRegistryRecoveryCommand command,
            PlatformProviderAdminAuthorization? authorization)
        {
            ArgumentNullException.ThrowIfNull(command);
            if (!IsValidReason(command.Reason))
            {
                return Result(PlatformProviderRegistryMutationStatus.InvalidCommand);
            }

            lock (_gate)
            {
                if (authorization is null || !authorization.TryConsume(out var administratorId))
                {
                    return Result(PlatformProviderRegistryMutationStatus.ElevationRequired);
                }

                if (_snapshot.StoreHealth != PlatformProviderRegistryStoreHealth.Quarantined)
                {
                    return Result(PlatformProviderRegistryMutationStatus.InvalidCommand);
                }

                try
                {
                    _store.ResetQuarantined(
                        administratorId,
                        command.Reason,
                        _timeProvider.GetUtcNow());
                }
                catch (Exception)
                {
                    return Result(PlatformProviderRegistryMutationStatus.PersistenceFailed);
                }

                _durable = PlatformProviderRegistryDurableState.Empty;
                _current = ImmutableDictionary<Guid, PlatformInstalledManifestObservation>.Empty;
                _authorityReleaseFenced = false;
                Volatile.Write(
                    ref _snapshot,
                    new PlatformProviderRegistrySnapshot(
                        0,
                        PlatformProviderRegistryStoreHealth.Healthy,
                        ImmutableArray<PlatformProviderRegistryEntry>.Empty));
                return Result(PlatformProviderRegistryMutationStatus.Applied);
            }
        }

        internal PlatformProviderAuthorityRelease? TryRelease(
            Guid pluginId,
            string fingerprint,
            long generation)
        {
            if (pluginId == Guid.Empty
                || generation <= 0
                || string.IsNullOrEmpty(fingerprint))
            {
                return null;
            }

            lock (_gate)
            {
                if (_snapshot.StoreHealth != PlatformProviderRegistryStoreHealth.Healthy)
                {
                    return null;
                }

                if (_authorityReleaseFenced)
                {
                    return null;
                }

                var entry = _snapshot.Entries.FirstOrDefault(value => value.PluginId == pluginId);
                if (entry is null
                    || entry.State != PlatformProviderLifecycleState.Enabled
                    || entry.Generation != generation
                    || !string.Equals(entry.Fingerprint, fingerprint, StringComparison.Ordinal))
                {
                    return null;
                }

                var record = _durable.Records.First(value => value.PluginId == pluginId);
                if (record.Disposition != PlatformProviderDurableDisposition.Approved
                    || !string.Equals(record.ApprovedFingerprint, fingerprint, StringComparison.Ordinal)
                    || !_current.TryGetValue(pluginId, out var observation)
                    || observation.BoundManifest is null
                    || !TryValidateGrant(
                        observation.BoundManifest,
                        record.GrantedCapabilityIds,
                        out var currentGrant)
                    || !currentGrant.SequenceEqual(record.GrantedCapabilityIds, StringComparer.Ordinal))
                {
                    return null;
                }

                return new PlatformProviderAuthorityRelease(
                    PlatformApprovedProviderIdentity.EstablishCurrentRegistryApproval(
                        pluginId,
                        fingerprint,
                        generation),
                    record.GrantedCapabilityIds,
                    generation);
            }
        }

        private static PlatformProviderRegistryDurableRecord ReconcileObservation(
            PlatformProviderRegistryDurableRecord? existing,
            PlatformInstalledManifestObservation observation)
        {
            if (existing is null)
            {
                return new PlatformProviderRegistryDurableRecord(
                    observation.PluginId,
                    1,
                    observation.BoundManifest?.Fingerprint.Value,
                    observation.BoundManifest?.HostVersion.ToString(),
                    observation.BoundManifest?.AssemblyIdentity,
                    (int)observation.HostStatus,
                    observation.Outcome,
                    observation.Compatibility,
                    RequestedIds(observation),
                    false,
                    PlatformProviderDurableDisposition.None,
                    null,
                    ImmutableArray<string>.Empty,
                    null,
                    null,
                    null,
                    null);
            }

            var changed = existing.WasAbsent || !SameObservation(existing, observation);
            var generation = changed ? CheckedIncrement(existing.Generation) : existing.Generation;
            var disposition = existing.Disposition;
            var approvedFingerprint = existing.ApprovedFingerprint;
            var grantIds = existing.GrantedCapabilityIds;

            if (changed
                && disposition != PlatformProviderDurableDisposition.Revoked
                && !CanRetainDormantApproval(existing, observation))
            {
                disposition = PlatformProviderDurableDisposition.None;
                approvedFingerprint = null;
                grantIds = ImmutableArray<string>.Empty;
            }

            return existing.WithObservation(
                generation,
                observation,
                false,
                disposition,
                approvedFingerprint,
                grantIds);
        }

        private static bool SameObservation(
            PlatformProviderRegistryDurableRecord existing,
            PlatformInstalledManifestObservation observation) =>
            existing.LastHostStatus == (int)observation.HostStatus
            && existing.LastOutcome == observation.Outcome
            && existing.LastCompatibility == observation.Compatibility
            && string.Equals(
                existing.LastFingerprint,
                observation.BoundManifest?.Fingerprint.Value ?? existing.LastFingerprint,
                StringComparison.Ordinal)
            && string.Equals(
                existing.LastHostVersion,
                observation.BoundManifest?.HostVersion.ToString() ?? existing.LastHostVersion,
                StringComparison.Ordinal)
            && string.Equals(
                existing.LastAssemblyIdentity,
                observation.BoundManifest?.AssemblyIdentity ?? existing.LastAssemblyIdentity,
                StringComparison.Ordinal)
            && existing.LastRequestedCapabilityIds.SequenceEqual(
                observation.BoundManifest is null
                    ? existing.LastRequestedCapabilityIds
                    : RequestedIds(observation),
                StringComparer.Ordinal);

        private static bool CanRetainDormantApproval(
            PlatformProviderRegistryDurableRecord existing,
            PlatformInstalledManifestObservation observation)
        {
            if (existing.Disposition is not (
                    PlatformProviderDurableDisposition.Approved
                    or PlatformProviderDurableDisposition.Disabled)
                || string.IsNullOrEmpty(existing.ApprovedFingerprint))
            {
                return false;
            }

            if (observation.Outcome == PlatformInstalledManifestOutcome.HostStatusNotActive
                && observation.HostStatus is (
                    PlatformInstalledPluginHostStatus.Restart
                    or PlatformInstalledPluginHostStatus.Disabled))
            {
                return true;
            }

            return existing.LastOutcome == PlatformInstalledManifestOutcome.HostStatusNotActive
                && existing.LastHostStatus is (
                    (int)PlatformInstalledPluginHostStatus.Restart
                    or (int)PlatformInstalledPluginHostStatus.Disabled)
                && observation.Outcome == PlatformInstalledManifestOutcome.Acquired
                && string.Equals(
                    existing.ApprovedFingerprint,
                    observation.BoundManifest?.Fingerprint.Value,
                    StringComparison.Ordinal)
                && string.Equals(
                    existing.LastHostVersion,
                    observation.BoundManifest?.HostVersion.ToString(),
                    StringComparison.Ordinal)
                && string.Equals(
                    existing.LastAssemblyIdentity,
                    observation.BoundManifest?.AssemblyIdentity,
                    StringComparison.Ordinal)
                && existing.LastRequestedCapabilityIds.SequenceEqual(
                    RequestedIds(observation),
                    StringComparer.Ordinal);
        }

        private static ImmutableArray<string> RequestedIds(
            PlatformInstalledManifestObservation observation) =>
            observation.BoundManifest?.Manifest.RequestedCapabilities.Capabilities
                .Select(value => value.Id.Value)
                .ToImmutableArray() ?? ImmutableArray<string>.Empty;

        private static ImmutableArray<PlatformProviderRegistryDurableRecord> BoundRecords(
            IEnumerable<PlatformProviderRegistryDurableRecord> records,
            ISet<Guid> observedIds)
        {
            var materialized = records.ToArray();
            var required = materialized
                .Where(record => observedIds.Contains(record.PluginId)
                    || record.Disposition == PlatformProviderDurableDisposition.Revoked)
                .ToArray();
            if (required.Length > MaximumProviderCount)
            {
                return default;
            }

            var remaining = MaximumProviderCount - required.Length;
            return required
                .Concat(materialized
                    .Where(record => !observedIds.Contains(record.PluginId)
                        && record.Disposition != PlatformProviderDurableDisposition.Revoked)
                    .OrderByDescending(record => record.Generation)
                    .ThenBy(record => record.PluginId)
                    .Take(remaining))
                .OrderBy(record => record.PluginId)
                .ToImmutableArray();
        }

        private static bool TryValidateGrant(
            HostBoundInstalledManifest manifest,
            ImmutableArray<string> supplied,
            out ImmutableArray<string> canonical)
        {
            canonical = ImmutableArray<string>.Empty;
            if (supplied.IsDefault
                || !PlatformGrantedCapabilitySet.TryCreate(supplied, out var granted))
            {
                return false;
            }

            var requestedIds = manifest.Manifest.RequestedCapabilities.Capabilities
                .Select(value => value.Id.Value)
                .ToHashSet(StringComparer.Ordinal);
            if (granted.Capabilities.Any(definition =>
                    !requestedIds.Contains(definition.Id.Value)
                    || !PlatformCapabilityVocabulary.IsWithinInstalledProviderCeiling(
                        definition.Id.Value)))
            {
                return false;
            }

            canonical = granted.Capabilities.Select(value => value.Id.Value).ToImmutableArray();
            return true;
        }

        private bool TrySave(PlatformProviderRegistryDurableState state)
        {
            try
            {
                _store.Save(state);
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }

        private PlatformProviderRegistryMutationResult FenceStoreAndPublishQuarantine()
        {
            try
            {
                _store.FenceQuarantined();
            }
            catch (Exception)
            {
                _authorityReleaseFenced = true;
                return Result(PlatformProviderRegistryMutationStatus.PersistenceFailed);
            }

            _durable = PlatformProviderRegistryDurableState.Empty;
            _current = ImmutableDictionary<Guid, PlatformInstalledManifestObservation>.Empty;
            _authorityReleaseFenced = true;
            Volatile.Write(
                ref _snapshot,
                new PlatformProviderRegistrySnapshot(
                    0,
                    PlatformProviderRegistryStoreHealth.Quarantined,
                    ImmutableArray<PlatformProviderRegistryEntry>.Empty));
            return Result(PlatformProviderRegistryMutationStatus.StoreQuarantined);
        }

        private static PlatformProviderRegistrySnapshot BuildSnapshot(
            PlatformProviderRegistryDurableState durable,
            ImmutableDictionary<Guid, PlatformInstalledManifestObservation> current,
            PlatformProviderRegistryStoreHealth health)
        {
            var entries = durable.Records
                .OrderBy(value => value.PluginId)
                .Select(record =>
                {
                    current.TryGetValue(record.PluginId, out var observation);
                    return new PlatformProviderRegistryEntry(
                        record.PluginId,
                        record.Generation,
                        DeriveState(record, observation),
                        observation?.BoundManifest?.Fingerprint.Value,
                        observation is null ? ImmutableArray<string>.Empty : RequestedIds(observation),
                        record.ApprovedFingerprint,
                        record.GrantedCapabilityIds);
                })
                .ToImmutableArray();
            return new PlatformProviderRegistrySnapshot(durable.Revision, health, entries);
        }

        private static PlatformProviderLifecycleState DeriveState(
            PlatformProviderRegistryDurableRecord record,
            PlatformInstalledManifestObservation? observation)
        {
            if (record.Disposition == PlatformProviderDurableDisposition.Revoked)
            {
                return PlatformProviderLifecycleState.Revoked;
            }

            if (observation is null)
            {
                return PlatformProviderLifecycleState.Absent;
            }

            if (observation.Outcome == PlatformInstalledManifestOutcome.Acquired)
            {
                if (observation.Compatibility != PlatformInstalledManifestCompatibility.Compatible)
                {
                    return PlatformProviderLifecycleState.Incompatible;
                }

                if (record.Disposition == PlatformProviderDurableDisposition.Disabled)
                {
                    return PlatformProviderLifecycleState.Disabled;
                }

                return record.Disposition == PlatformProviderDurableDisposition.Approved
                    && string.Equals(
                        record.ApprovedFingerprint,
                        observation.BoundManifest?.Fingerprint.Value,
                        StringComparison.Ordinal)
                        ? PlatformProviderLifecycleState.Enabled
                        : PlatformProviderLifecycleState.Pending;
            }

            if (observation.Outcome == PlatformInstalledManifestOutcome.HostStatusNotActive)
            {
                return observation.HostStatus switch
                {
                    PlatformInstalledPluginHostStatus.Restart => PlatformProviderLifecycleState.RestartPending,
                    PlatformInstalledPluginHostStatus.Disabled => PlatformProviderLifecycleState.Disabled,
                    PlatformInstalledPluginHostStatus.NotSupported => PlatformProviderLifecycleState.Incompatible,
                    PlatformInstalledPluginHostStatus.Deleted => PlatformProviderLifecycleState.Absent,
                    _ => PlatformProviderLifecycleState.Quarantined,
                };
            }

            return PlatformProviderLifecycleState.Quarantined;
        }

        private static bool IsValidCommandShape(PlatformProviderAdminCommand command) =>
            Enum.IsDefined(command.Operation)
            && command.ExpectedRevision >= 0
            && command.PluginId != Guid.Empty
            && command.ExpectedGeneration > 0
            && !string.IsNullOrEmpty(command.ExpectedFingerprint)
            && command.ExpectedFingerprint.Length == 64
            && command.ExpectedFingerprint.All(character =>
                character is (>= '0' and <= '9') or (>= 'a' and <= 'f'))
            && (command.Operation is (
                    PlatformProviderAdminOperation.Approve
                    or PlatformProviderAdminOperation.ReplaceGrant)
                ? command.HasGrantedCapabilityIds
                : !command.HasGrantedCapabilityIds)
            && command.IsGrantedCapabilityInputBounded
            && IsValidReason(command.Reason);

        private static bool IsValidReason(string? reason) =>
            !string.IsNullOrWhiteSpace(reason)
            && reason.Length <= MaximumReasonLength
            && reason.All(character => !char.IsControl(character)
                && character is not ('\u2028' or '\u2029'));

        private static bool IsValidDurableState(PlatformProviderRegistryDurableState state)
        {
            if (state is null
                || state.Revision < 0
                || state.Records.IsDefault
                || state.Records.Length > MaximumProviderCount
                || state.Records.Any(record => record is null
                    || record.PluginId == Guid.Empty
                    || record.Generation <= 0
                    || record.Generation > state.Revision)
                || state.Records.GroupBy(record => record.PluginId).Any(group => group.Count() != 1))
            {
                return false;
            }

            return true;
        }

        private static long CheckedIncrement(long value) => value == long.MaxValue
            ? throw new InvalidOperationException("Registry revision or generation is exhausted.")
            : value + 1;

        private static PlatformProviderRegistryMutationResult Result(
            PlatformProviderRegistryMutationStatus status) =>
            PlatformProviderRegistryMutationResult.From(status);
    }
}
