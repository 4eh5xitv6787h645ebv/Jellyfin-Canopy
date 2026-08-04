using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>
    /// Strict bounded durable JSON for provider registry facts. Invalid state is never salvaged;
    /// the original bytes remain forensic evidence and a fixed redaction-safe marker makes the
    /// quarantine sticky across restarts.
    /// </summary>
    internal sealed class PlatformProviderRegistryJsonStateStore : IPlatformProviderRegistryStateStore
    {
        internal const int SchemaVersion = 1;
        internal const int MaximumDocumentBytes = 1024 * 1024;
        internal const int MaximumAssemblyIdentityLength = 512;
        internal const int MaximumVersionLength = 64;
        internal const int MaximumRecoveryEpochs = 8;

        private const string QuarantineSuffix = ".quarantine.json";
        private const string QuarantineMarker =
            "{\"schemaVersion\":1,\"state\":\"quarantined\",\"reason\":\"invalid-durable-state\"}";

        private static readonly string[] DocumentProperties =
        {
            "schemaVersion", "revision", "records",
        };

        private static readonly string[] RecordProperties =
        {
            "pluginId", "generation", "lastFingerprint", "lastHostVersion",
            "lastAssemblyIdentity", "lastHostStatus", "lastOutcome", "lastCompatibility",
            "lastRequestedCapabilityIds", "wasAbsent", "disposition", "approvedFingerprint",
            "grantedCapabilityIds", "administratorId", "reason", "decidedAtUtc",
            "decidedAtRevision",
        };

        private static readonly JsonSerializerOptions SerializerOptions = new()
        {
            PropertyNameCaseInsensitive = false,
            UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
            WriteIndented = false,
            MaxDepth = 16,
        };

        private readonly string _statePath;
        private readonly string _quarantinePath;

        internal PlatformProviderRegistryJsonStateStore(string statePath)
        {
            ArgumentException.ThrowIfNullOrWhiteSpace(statePath);
            _statePath = statePath;
            _quarantinePath = statePath + QuarantineSuffix;
        }

        public PlatformProviderRegistryStoreLoadResult Load()
        {
            var marker = ProbeQuarantineMarker(out var recoverySlot);
            if (marker is QuarantineMarkerProbe.Quarantined or QuarantineMarkerProbe.Unverifiable)
            {
                return PlatformProviderRegistryStoreLoadResult.Quarantined();
            }

            var activePath = marker == QuarantineMarkerProbe.Recovered
                ? RecoveryStatePath(recoverySlot)
                : _statePath;

            try
            {
                var bytes = ReadBounded(activePath);
                if (!TryDeserialize(bytes, out var state))
                {
                    return Quarantine();
                }

                if (ProbeQuarantineMarker(out var confirmedSlot) != marker
                    || confirmedSlot != recoverySlot)
                {
                    return PlatformProviderRegistryStoreLoadResult.Quarantined();
                }

                return PlatformProviderRegistryStoreLoadResult.Healthy(state!);
            }
            catch (FileNotFoundException)
            {
                return marker == QuarantineMarkerProbe.Recovered
                    ? Quarantine()
                    : MissingOrRacedMarker();
            }
            catch (DirectoryNotFoundException)
            {
                return marker == QuarantineMarkerProbe.Recovered
                    ? Quarantine()
                    : MissingOrRacedMarker();
            }
            catch (Exception)
            {
                return Quarantine();
            }
        }

        public void Save(PlatformProviderRegistryDurableState state)
        {
            ArgumentNullException.ThrowIfNull(state);
            var marker = ProbeQuarantineMarker(out var recoverySlot);
            if (marker is QuarantineMarkerProbe.Quarantined or QuarantineMarkerProbe.Unverifiable
                || !TryValidateState(state))
            {
                throw new InvalidOperationException("The provider registry store is quarantined or invalid.");
            }

            var document = Project(state);
            var bytes = JsonSerializer.SerializeToUtf8Bytes(document, SerializerOptions);
            if (bytes.Length == 0 || bytes.Length > MaximumDocumentBytes)
            {
                throw new InvalidOperationException("The provider registry document exceeds its bound.");
            }

            AtomicFile.WriteAllBytes(
                marker == QuarantineMarkerProbe.Recovered
                    ? RecoveryStatePath(recoverySlot)
                    : _statePath,
                bytes);
        }

        public void ResetQuarantined(Guid administratorId, string reason, DateTimeOffset decidedAtUtc)
        {
            var markerStatus = ProbeQuarantineMarker(out var activeRecoverySlot);
            if (administratorId == Guid.Empty
                || !TryReason(reason)
                || decidedAtUtc.Offset != TimeSpan.Zero)
            {
                throw new InvalidOperationException("The registry quarantine cannot be reset.");
            }

            if (markerStatus == QuarantineMarkerProbe.Recovered)
            {
                if (IsHealthyEmptyRecoveryState(RecoveryStatePath(activeRecoverySlot)))
                {
                    return;
                }

                AtomicFile.WriteAllText(RecoveryFencePath(activeRecoverySlot), QuarantineMarker);
                markerStatus = ProbeQuarantineMarker(out _) == QuarantineMarkerProbe.Quarantined
                    ? QuarantineMarkerProbe.Quarantined
                    : QuarantineMarkerProbe.Unverifiable;
            }

            if (markerStatus == QuarantineMarkerProbe.Missing && IsInvalidBaseState())
            {
                markerStatus = QuarantineMarkerProbe.Quarantined;
            }

            if (markerStatus is not (
                QuarantineMarkerProbe.Quarantined
                or QuarantineMarkerProbe.Unverifiable))
            {
                throw new InvalidOperationException("The registry quarantine cannot be reset.");
            }

            var recoverySlot = FindUnusedRecoverySlot();
            if (recoverySlot < 0)
            {
                throw new InvalidOperationException("The bounded registry recovery ledger is full.");
            }

            var emptyBytes = JsonSerializer.SerializeToUtf8Bytes(
                Project(PlatformProviderRegistryDurableState.Empty),
                SerializerOptions);
            AtomicFile.WriteAllBytes(RecoveryStatePath(recoverySlot), emptyBytes);
            var marker = new RecoveryMarker
            {
                SchemaVersion = SchemaVersion,
                State = "recovered",
                AdministratorId = administratorId.ToString("D"),
                Reason = reason,
                DecidedAtUtc = decidedAtUtc.ToString("O", CultureInfo.InvariantCulture),
                Slot = recoverySlot,
            };
            var markerBytes = JsonSerializer.SerializeToUtf8Bytes(marker, SerializerOptions);
            AtomicFile.WriteAllBytes(RecoveryEvidencePath(recoverySlot), markerBytes);
            if (ProbeQuarantineMarker(out var committedSlot) != QuarantineMarkerProbe.Recovered
                || committedSlot != recoverySlot)
            {
                throw new IOException("The registry recovery epoch did not become authoritative.");
            }
        }

        public void FenceQuarantined()
        {
            _ = Quarantine();
            if (ProbeQuarantineMarker() is not (
                QuarantineMarkerProbe.Quarantined
                or QuarantineMarkerProbe.Unverifiable))
            {
                throw new IOException("The registry authority fence was not persisted.");
            }
        }

        private PlatformProviderRegistryStoreLoadResult MissingOrRacedMarker() =>
            ProbeQuarantineMarker(out _) is QuarantineMarkerProbe.Missing
                ? PlatformProviderRegistryStoreLoadResult.Healthy(PlatformProviderRegistryDurableState.Empty)
                : PlatformProviderRegistryStoreLoadResult.Quarantined();

        private QuarantineMarkerProbe ProbeQuarantineMarker() =>
            ProbeQuarantineMarker(out _);

        private QuarantineMarkerProbe ProbeQuarantineMarker(out int recoverySlot)
        {
            recoverySlot = -1;
            for (var slot = MaximumRecoveryEpochs - 1; slot >= 0; slot--)
            {
                byte[] evidence;
                try
                {
                    evidence = ReadBounded(RecoveryEvidencePath(slot));
                }
                catch (FileNotFoundException)
                {
                    continue;
                }
                catch (DirectoryNotFoundException)
                {
                    continue;
                }
                catch (Exception)
                {
                    return QuarantineMarkerProbe.Unverifiable;
                }

                if (!TryParseRecoveryMarker(evidence, out var recovered)
                    || recovered!.Slot != slot)
                {
                    return QuarantineMarkerProbe.Unverifiable;
                }

                recoverySlot = slot;
                return IsMissingPath(RecoveryFencePath(slot))
                    ? QuarantineMarkerProbe.Recovered
                    : QuarantineMarkerProbe.Quarantined;
            }

            return ProbeBaseQuarantineMarker();
        }

        private int FindUnusedRecoverySlot()
        {
            var highestOccupiedSlot = -1;
            for (var slot = MaximumRecoveryEpochs - 1; slot >= 0; slot--)
            {
                var stateMissing = IsMissingPath(RecoveryStatePath(slot));
                var evidenceMissing = IsMissingPath(RecoveryEvidencePath(slot));
                var fenceMissing = IsMissingPath(RecoveryFencePath(slot));
                if (!stateMissing || !evidenceMissing || !fenceMissing)
                {
                    highestOccupiedSlot = slot;
                    break;
                }
            }

            if (highestOccupiedSlot < 0)
            {
                return 0;
            }

            if (IsMissingPath(RecoveryEvidencePath(highestOccupiedSlot))
                && IsMissingPath(RecoveryFencePath(highestOccupiedSlot))
                && IsHealthyEmptyRecoveryState(RecoveryStatePath(highestOccupiedSlot)))
            {
                return highestOccupiedSlot;
            }

            return highestOccupiedSlot + 1 < MaximumRecoveryEpochs
                ? highestOccupiedSlot + 1
                : -1;
        }

        private static bool IsMissingPath(string path)
        {
            try
            {
                _ = ReadBounded(path);
                return false;
            }
            catch (FileNotFoundException)
            {
                return true;
            }
            catch (DirectoryNotFoundException)
            {
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }

        private string RecoveryStatePath(int slot) =>
            _statePath + ".recovered." + slot.ToString(CultureInfo.InvariantCulture) + ".json";

        private string RecoveryEvidencePath(int slot) =>
            _statePath + ".recovered." + slot.ToString(CultureInfo.InvariantCulture) + ".evidence.json";

        private string RecoveryFencePath(int slot) =>
            _statePath + ".recovered." + slot.ToString(CultureInfo.InvariantCulture) + ".fence.json";

        private static bool IsHealthyEmptyRecoveryState(string path)
        {
            try
            {
                return TryDeserialize(ReadBounded(path), out var state)
                    && state!.Revision == 0
                    && state.Records.IsEmpty;
            }
            catch (Exception)
            {
                return false;
            }
        }

        private bool IsInvalidBaseState()
        {
            try
            {
                return !TryDeserialize(ReadBounded(_statePath), out _);
            }
            catch (FileNotFoundException)
            {
                return false;
            }
            catch (DirectoryNotFoundException)
            {
                return false;
            }
            catch (Exception)
            {
                return true;
            }
        }

        private QuarantineMarkerProbe ProbeBaseQuarantineMarker()
        {
            try
            {
                var bytes = ReadBounded(_quarantinePath);
                return bytes.AsSpan().SequenceEqual(Encoding.UTF8.GetBytes(QuarantineMarker))
                    ? QuarantineMarkerProbe.Quarantined
                    : QuarantineMarkerProbe.Unverifiable;
            }
            catch (FileNotFoundException)
            {
                return QuarantineMarkerProbe.Missing;
            }
            catch (DirectoryNotFoundException)
            {
                return QuarantineMarkerProbe.Missing;
            }
            catch (Exception)
            {
                return QuarantineMarkerProbe.Unverifiable;
            }
        }

        private PlatformProviderRegistryStoreLoadResult Quarantine()
        {
            try
            {
                var status = ProbeQuarantineMarker(out var recoverySlot);
                if (status == QuarantineMarkerProbe.Recovered)
                {
                    AtomicFile.WriteAllText(RecoveryFencePath(recoverySlot), QuarantineMarker);
                }
                else if (status == QuarantineMarkerProbe.Missing)
                {
                    AtomicFile.WriteAllText(_quarantinePath, QuarantineMarker);
                }
            }
            catch (Exception)
            {
                // The in-memory result remains quarantined even when evidence cannot be persisted.
            }

            return PlatformProviderRegistryStoreLoadResult.Quarantined();
        }

        private static bool TryParseRecoveryMarker(byte[] bytes, out RecoveryMarker? recovered)
        {
            recovered = null;
            try
            {
                using var json = JsonDocument.Parse(bytes);
                var expected = new[]
                {
                    "schemaVersion", "state", "administratorId", "reason", "decidedAtUtc", "slot",
                };
                if (json.RootElement.ValueKind != JsonValueKind.Object
                    || HasDuplicateProperty(json.RootElement)
                    || !HasExactProperties(json.RootElement, expected))
                {
                    return false;
                }

                recovered = JsonSerializer.Deserialize<RecoveryMarker>(bytes, SerializerOptions);
                return recovered is not null
                    && recovered.SchemaVersion == SchemaVersion
                    && string.Equals(recovered.State, "recovered", StringComparison.Ordinal)
                    && recovered.Slot >= 0
                    && recovered.Slot < MaximumRecoveryEpochs
                    && TryOptionalGuid(recovered.AdministratorId, out var administratorId)
                    && administratorId.HasValue
                    && TryReason(recovered.Reason)
                    && TryTimestamp(recovered.DecidedAtUtc, out var decidedAtUtc)
                    && decidedAtUtc.HasValue;
            }
            catch (Exception)
            {
                recovered = null;
                return false;
            }
        }

        private static byte[] ReadBounded(string path)
        {
            using var stream = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                bufferSize: 4096,
                FileOptions.SequentialScan);
            var expectedLength = stream.Length;
            if (expectedLength <= 0 || expectedLength > MaximumDocumentBytes)
            {
                throw new InvalidDataException("The registry document length is invalid.");
            }

            var bytes = new byte[checked((int)Math.Min(
                expectedLength + 1,
                MaximumDocumentBytes + 1L))];
            var total = 0;
            while (total < bytes.Length)
            {
                var read = stream.Read(bytes, total, bytes.Length - total);
                if (read == 0)
                {
                    break;
                }

                total += read;
            }

            if (total != expectedLength || total > MaximumDocumentBytes || stream.ReadByte() != -1)
            {
                throw new InvalidDataException("The registry document changed or exceeded its bound.");
            }

            return bytes.AsSpan(0, total).ToArray();
        }

        private static bool TryDeserialize(
            byte[] bytes,
            out PlatformProviderRegistryDurableState? state)
        {
            state = null;
            try
            {
                using var json = JsonDocument.Parse(
                    bytes,
                    new JsonDocumentOptions
                    {
                        AllowTrailingCommas = false,
                        CommentHandling = JsonCommentHandling.Disallow,
                        MaxDepth = 16,
                    });
                if (json.RootElement.ValueKind != JsonValueKind.Object
                    || HasDuplicateProperty(json.RootElement)
                    || !HasExactProperties(json.RootElement, DocumentProperties)
                    || !json.RootElement.TryGetProperty("records", out var rawRecords)
                    || rawRecords.ValueKind != JsonValueKind.Array
                    || rawRecords.GetArrayLength() > PlatformProviderRegistry.MaximumProviderCount
                    || !HasPreflightRecordBounds(rawRecords)
                    || rawRecords.EnumerateArray().Any(record =>
                        record.ValueKind != JsonValueKind.Object
                        || !HasExactProperties(record, RecordProperties)))
                {
                    return false;
                }

                var document = JsonSerializer.Deserialize<PersistedDocument>(bytes, SerializerOptions);
                if (document is null
                    || document.SchemaVersion != SchemaVersion
                    || document.Revision < 0
                    || document.Records is null
                    || document.Records.Count > PlatformProviderRegistry.MaximumProviderCount)
                {
                    return false;
                }

                var records = ImmutableArray.CreateBuilder<PlatformProviderRegistryDurableRecord>(
                    document.Records.Count);
                Guid? previousId = null;
                foreach (var dto in document.Records)
                {
                    if (!TryParseRecord(dto, document.Revision, out var record)
                        || (previousId.HasValue && previousId.Value.CompareTo(record!.PluginId) >= 0))
                    {
                        return false;
                    }

                    previousId = record!.PluginId;
                    records.Add(record);
                }

                var candidate = new PlatformProviderRegistryDurableState(
                    document.Revision,
                    records.MoveToImmutable());
                if (!TryValidateState(candidate))
                {
                    return false;
                }

                state = candidate;
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static bool TryParseRecord(
            PersistedRecord? dto,
            long stateRevision,
            out PlatformProviderRegistryDurableRecord? record)
        {
            record = null;
            if (dto is null
                || !Guid.TryParseExact(dto.PluginId, "D", out var pluginId)
                || pluginId == Guid.Empty
                || !string.Equals(pluginId.ToString("D"), dto.PluginId, StringComparison.Ordinal)
                || dto.Generation <= 0
                || dto.Generation > stateRevision
                || !TryFingerprint(dto.LastFingerprint, required: false)
                || !TryFingerprint(dto.ApprovedFingerprint, required: false)
                || !TryCanonicalVersion(dto.LastHostVersion)
                || !TryBoundedIdentity(dto.LastAssemblyIdentity)
                || !Enum.IsDefined((PlatformInstalledManifestOutcome)dto.LastOutcome)
                || !TryCompatibility(dto.LastCompatibility)
                || !Enum.IsDefined((PlatformProviderDurableDisposition)dto.Disposition)
                || dto.LastRequestedCapabilityIds is null
                || dto.GrantedCapabilityIds is null
                || !TryCanonicalCapabilities(dto.LastRequestedCapabilityIds, requested: true, out var requested)
                || !TryCanonicalCapabilities(dto.GrantedCapabilityIds, requested: false, out var granted)
                || !TryOptionalGuid(dto.AdministratorId, out var administratorId)
                || !TryReason(dto.Reason)
                || !TryTimestamp(dto.DecidedAtUtc, out var decidedAtUtc))
            {
                return false;
            }

            var disposition = (PlatformProviderDurableDisposition)dto.Disposition;
            var outcome = (PlatformInstalledManifestOutcome)dto.LastOutcome;
            if ((outcome == PlatformInstalledManifestOutcome.Acquired
                    && (dto.LastHostStatus != (int)PlatformInstalledPluginHostStatus.Active
                        || dto.LastCompatibility is null
                        || dto.LastFingerprint is null
                        || dto.LastHostVersion is null
                        || dto.LastAssemblyIdentity is null))
                || (outcome != PlatformInstalledManifestOutcome.Acquired
                    && dto.LastCompatibility.HasValue)
                || (outcome == PlatformInstalledManifestOutcome.HostStatusNotActive
                    && dto.LastHostStatus == (int)PlatformInstalledPluginHostStatus.Active))
            {
                return false;
            }

            var hasApproval = disposition is (
                PlatformProviderDurableDisposition.Approved
                or PlatformProviderDurableDisposition.Disabled);
            var hasDecision = disposition != PlatformProviderDurableDisposition.None;
            var hasProvenance = administratorId.HasValue
                || dto.Reason is not null
                || decidedAtUtc.HasValue
                || dto.DecidedAtRevision.HasValue;
            if (hasApproval != (dto.ApprovedFingerprint is not null)
                || (hasDecision && (!administratorId.HasValue || decidedAtUtc is null || string.IsNullOrWhiteSpace(dto.Reason)))
                || (hasProvenance && (!administratorId.HasValue
                    || decidedAtUtc is null
                    || string.IsNullOrWhiteSpace(dto.Reason)
                    || !dto.DecidedAtRevision.HasValue))
                || (dto.DecidedAtRevision.HasValue
                    && (dto.DecidedAtRevision.Value <= 0 || dto.DecidedAtRevision.Value > stateRevision))
                || (!hasApproval && granted.Length != 0)
                || (hasApproval && !string.Equals(
                    dto.ApprovedFingerprint,
                    dto.LastFingerprint,
                    StringComparison.Ordinal))
                || granted.Any(value => !requested.Contains(value, StringComparer.Ordinal))
                || granted.Any(value =>
                    !PlatformCapabilityVocabulary.IsWithinInstalledProviderCeiling(value))
                || (dto.WasAbsent && disposition is not (
                    PlatformProviderDurableDisposition.None
                    or PlatformProviderDurableDisposition.Revoked)))
            {
                return false;
            }

            record = new PlatformProviderRegistryDurableRecord(
                pluginId,
                dto.Generation,
                dto.LastFingerprint,
                dto.LastHostVersion,
                dto.LastAssemblyIdentity,
                dto.LastHostStatus,
                outcome,
                dto.LastCompatibility.HasValue
                    ? (PlatformInstalledManifestCompatibility)dto.LastCompatibility.Value
                    : null,
                requested,
                dto.WasAbsent,
                disposition,
                dto.ApprovedFingerprint,
                granted,
                administratorId,
                dto.Reason,
                decidedAtUtc,
                dto.DecidedAtRevision);
            return true;
        }

        private static bool TryValidateState(PlatformProviderRegistryDurableState state)
        {
            if (state.Revision < 0
                || state.Records.IsDefault
                || state.Records.Length > PlatformProviderRegistry.MaximumProviderCount)
            {
                return false;
            }

            Guid? previousId = null;
            foreach (var record in state.Records)
            {
                if (record is null
                    || record.PluginId == Guid.Empty
                    || record.Generation <= 0
                    || record.Generation > state.Revision
                    || (previousId.HasValue && previousId.Value.CompareTo(record.PluginId) >= 0)
                    || !TryFingerprint(record.LastFingerprint, required: false)
                    || !TryFingerprint(record.ApprovedFingerprint, required: false)
                    || !TryParseRecord(Project(record), state.Revision, out _))
                {
                    return false;
                }

                previousId = record.PluginId;
            }

            return true;
        }

        private static bool TryFingerprint(string? value, bool required)
        {
            if (value is null)
            {
                return !required;
            }

            if (value.Length != 64)
            {
                return false;
            }

            foreach (var character in value)
            {
                if (character is not (>= '0' and <= '9') and not (>= 'a' and <= 'f'))
                {
                    return false;
                }
            }

            return true;
        }

        private static bool TryCanonicalVersion(string? value)
        {
            if (value is null)
            {
                return true;
            }

            return value.Length <= MaximumVersionLength
                && Version.TryParse(value, out var parsed)
                && string.Equals(parsed.ToString(), value, StringComparison.Ordinal);
        }

        private static bool TryBoundedIdentity(string? value) =>
            value is null || (value.Length > 0
                && value.Length <= MaximumAssemblyIdentityLength
                && !string.IsNullOrWhiteSpace(value)
                && value.All(character => !char.IsControl(character)
                    && character is not ('\u2028' or '\u2029')));

        private static bool TryCompatibility(int? value) =>
            !value.HasValue || Enum.IsDefined((PlatformInstalledManifestCompatibility)value.Value);

        private static bool TryCanonicalCapabilities(
            IReadOnlyList<string> values,
            bool requested,
            out ImmutableArray<string> canonical)
        {
            canonical = ImmutableArray<string>.Empty;
            if (requested)
            {
                if (!PlatformRequestedCapabilitySet.TryCreate(values, out var set))
                {
                    return false;
                }

                canonical = set.Capabilities.Select(value => value.Id.Value).ToImmutableArray();
            }
            else
            {
                if (!PlatformGrantedCapabilitySet.TryCreate(values, out var set))
                {
                    return false;
                }

                canonical = set.Capabilities.Select(value => value.Id.Value).ToImmutableArray();
            }

            return canonical.SequenceEqual(values, StringComparer.Ordinal);
        }

        private static bool TryOptionalGuid(string? raw, out Guid? value)
        {
            value = null;
            if (raw is null)
            {
                return true;
            }

            if (!Guid.TryParseExact(raw, "D", out var parsed)
                || parsed == Guid.Empty
                || !string.Equals(parsed.ToString("D"), raw, StringComparison.Ordinal))
            {
                return false;
            }

            value = parsed;
            return true;
        }

        private static bool TryReason(string? reason) =>
            reason is null || (reason.Length > 0
                && reason.Length <= PlatformProviderRegistry.MaximumReasonLength
                && !string.IsNullOrWhiteSpace(reason)
                && reason.All(character => !char.IsControl(character)
                    && character is not ('\u2028' or '\u2029')));

        private static bool TryTimestamp(string? raw, out DateTimeOffset? value)
        {
            value = null;
            if (raw is null)
            {
                return true;
            }

            if (!DateTimeOffset.TryParseExact(
                    raw,
                    "O",
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.None,
                    out var parsed)
                || parsed.Offset != TimeSpan.Zero
                || !string.Equals(parsed.ToString("O", CultureInfo.InvariantCulture), raw, StringComparison.Ordinal))
            {
                return false;
            }

            value = parsed;
            return true;
        }

        private static bool HasDuplicateProperty(JsonElement element)
        {
            if (element.ValueKind == JsonValueKind.Object)
            {
                var names = new HashSet<string>(StringComparer.Ordinal);
                foreach (var property in element.EnumerateObject())
                {
                    if (!names.Add(property.Name) || HasDuplicateProperty(property.Value))
                    {
                        return true;
                    }
                }
            }
            else if (element.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in element.EnumerateArray())
                {
                    if (HasDuplicateProperty(item))
                    {
                        return true;
                    }
                }
            }

            return false;
        }

        private static bool HasPreflightRecordBounds(JsonElement rawRecords)
        {
            foreach (var record in rawRecords.EnumerateArray())
            {
                if (record.ValueKind != JsonValueKind.Object
                    || !HasBoundedString(record, "pluginId", 36, optional: false)
                    || !HasBoundedString(record, "lastFingerprint", 64, optional: true)
                    || !HasBoundedString(record, "approvedFingerprint", 64, optional: true)
                    || !HasBoundedString(record, "lastHostVersion", MaximumVersionLength, optional: true)
                    || !HasBoundedString(
                        record,
                        "lastAssemblyIdentity",
                        MaximumAssemblyIdentityLength,
                        optional: true)
                    || !HasBoundedString(record, "administratorId", 36, optional: true)
                    || !HasBoundedString(
                        record,
                        "reason",
                        PlatformProviderRegistry.MaximumReasonLength,
                        optional: true)
                    || !HasBoundedString(record, "decidedAtUtc", 64, optional: true)
                    || !HasBoundedCapabilityArray(record, "lastRequestedCapabilityIds")
                    || !HasBoundedCapabilityArray(record, "grantedCapabilityIds"))
                {
                    return false;
                }
            }

            return true;
        }

        private static bool HasBoundedString(
            JsonElement record,
            string propertyName,
            int maximumLength,
            bool optional)
        {
            if (!record.TryGetProperty(propertyName, out var value))
            {
                return false;
            }

            if (value.ValueKind == JsonValueKind.Null)
            {
                return optional;
            }

            return value.ValueKind == JsonValueKind.String
                && value.GetString() is string decoded
                && decoded.Length <= maximumLength;
        }

        private static bool HasBoundedCapabilityArray(JsonElement record, string propertyName)
        {
            if (!record.TryGetProperty(propertyName, out var values)
                || values.ValueKind != JsonValueKind.Array
                || values.GetArrayLength() > PlatformCapabilityVocabulary.MaximumCapabilityCount)
            {
                return false;
            }

            return values.EnumerateArray().All(value =>
                value.ValueKind == JsonValueKind.String
                && value.GetString() is string decoded
                && decoded.Length <= PlatformCapabilityVocabulary.MaximumIdentifierLength);
        }

        private static bool HasExactProperties(JsonElement element, IReadOnlyList<string> expected)
        {
            var names = element.EnumerateObject()
                .Select(property => property.Name)
                .OrderBy(name => name, StringComparer.Ordinal)
                .ToArray();
            return names.SequenceEqual(expected.OrderBy(name => name, StringComparer.Ordinal), StringComparer.Ordinal);
        }

        private static PersistedDocument Project(PlatformProviderRegistryDurableState state) =>
            new()
            {
                SchemaVersion = SchemaVersion,
                Revision = state.Revision,
                Records = state.Records.Select(Project).ToList(),
            };

        private static PersistedRecord Project(PlatformProviderRegistryDurableRecord record) => new()
        {
            PluginId = record.PluginId.ToString("D"),
            Generation = record.Generation,
            LastFingerprint = record.LastFingerprint,
            LastHostVersion = record.LastHostVersion,
            LastAssemblyIdentity = record.LastAssemblyIdentity,
            LastHostStatus = record.LastHostStatus,
            LastOutcome = (int)record.LastOutcome,
            LastCompatibility = record.LastCompatibility.HasValue
                ? (int)record.LastCompatibility.Value
                : null,
            LastRequestedCapabilityIds = record.LastRequestedCapabilityIds.ToArray(),
            WasAbsent = record.WasAbsent,
            Disposition = (int)record.Disposition,
            ApprovedFingerprint = record.ApprovedFingerprint,
            GrantedCapabilityIds = record.GrantedCapabilityIds.ToArray(),
            AdministratorId = record.AdministratorId?.ToString("D"),
            Reason = record.Reason,
            DecidedAtUtc = record.DecidedAtUtc?.ToString("O", CultureInfo.InvariantCulture),
            DecidedAtRevision = record.DecidedAtRevision,
        };

        private sealed class PersistedDocument
        {
            [JsonPropertyName("schemaVersion")]
            public int SchemaVersion { get; set; }

            [JsonPropertyName("revision")]
            public long Revision { get; set; }

            [JsonPropertyName("records")]
            public List<PersistedRecord>? Records { get; set; }
        }

        private enum QuarantineMarkerProbe
        {
            Missing = 0,
            Quarantined = 1,
            Recovered = 2,
            Unverifiable = 3,
        }

        private sealed class RecoveryMarker
        {
            [JsonPropertyName("schemaVersion")]
            public int SchemaVersion { get; set; }

            [JsonPropertyName("state")]
            public string? State { get; set; }

            [JsonPropertyName("administratorId")]
            public string? AdministratorId { get; set; }

            [JsonPropertyName("reason")]
            public string? Reason { get; set; }

            [JsonPropertyName("decidedAtUtc")]
            public string? DecidedAtUtc { get; set; }

            [JsonPropertyName("slot")]
            public int Slot { get; set; }
        }

        private sealed class PersistedRecord
        {
            [JsonPropertyName("pluginId")]
            public string? PluginId { get; set; }

            [JsonPropertyName("generation")]
            public long Generation { get; set; }

            [JsonPropertyName("lastFingerprint")]
            public string? LastFingerprint { get; set; }

            [JsonPropertyName("lastHostVersion")]
            public string? LastHostVersion { get; set; }

            [JsonPropertyName("lastAssemblyIdentity")]
            public string? LastAssemblyIdentity { get; set; }

            [JsonPropertyName("lastHostStatus")]
            public int LastHostStatus { get; set; }

            [JsonPropertyName("lastOutcome")]
            public int LastOutcome { get; set; }

            [JsonPropertyName("lastCompatibility")]
            public int? LastCompatibility { get; set; }

            [JsonPropertyName("lastRequestedCapabilityIds")]
            public string[]? LastRequestedCapabilityIds { get; set; }

            [JsonPropertyName("wasAbsent")]
            public bool WasAbsent { get; set; }

            [JsonPropertyName("disposition")]
            public int Disposition { get; set; }

            [JsonPropertyName("approvedFingerprint")]
            public string? ApprovedFingerprint { get; set; }

            [JsonPropertyName("grantedCapabilityIds")]
            public string[]? GrantedCapabilityIds { get; set; }

            [JsonPropertyName("administratorId")]
            public string? AdministratorId { get; set; }

            [JsonPropertyName("reason")]
            public string? Reason { get; set; }

            [JsonPropertyName("decidedAtUtc")]
            public string? DecidedAtUtc { get; set; }

            [JsonPropertyName("decidedAtRevision")]
            public long? DecidedAtRevision { get; set; }
        }
    }
}
