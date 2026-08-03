using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>The bounded result of preparing one opaque native action capability.</summary>
    internal enum PlatformCapabilityMintOutcomeKind
    {
        Issued,
        InvalidRequest,
        NotAuthorized,
        AtCapacity,
        EntropyUnavailable,
    }

    /// <summary>Intrinsic inspection outcomes that reveal no unauthenticated claim data.</summary>
    internal enum PlatformCapabilityInspectionKind
    {
        Authentic,
        Invalid,
        Expired,
    }

    /// <summary>Current-authority validation outcomes for an authentic capability.</summary>
    internal enum PlatformCapabilityValidationKind
    {
        InvalidCapability,
        Valid,
        Expired,
        WrongActor,
        WrongOperation,
        WrongItem,
        WrongInput,
        WrongDevice,
        StaleAuthority,
        NotAuthorized,
    }

    /// <summary>Atomic single-use decisions for a currently valid capability.</summary>
    internal enum PlatformCapabilityConsumeKind
    {
        Consumed,
        Replay,
        Invalid,
        Expired,
        StaleAuthority,
    }

    /// <summary>An opaque capability string, present only when minting succeeded.</summary>
    internal sealed class PlatformCapabilityMintOutcome
    {
        internal PlatformCapabilityMintOutcome(
            PlatformCapabilityMintOutcomeKind kind,
            string? capability = null,
            DateTimeOffset? expiresAt = null)
        {
            Kind = kind;
            Capability = capability;
            ExpiresAt = expiresAt;
        }

        internal PlatformCapabilityMintOutcomeKind Kind { get; }

        internal string? Capability { get; }

        internal DateTimeOffset? ExpiresAt { get; }
    }

    /// <summary>An authenticated decoded capability. Inspection never consumes it.</summary>
    internal sealed class PlatformCapabilityInspection
    {
        internal PlatformCapabilityInspection(
            PlatformCapabilityInspectionKind kind,
            PlatformActionCapabilityService? owner = null,
            object? claims = null,
            byte[]? tag = null,
            byte[]? capabilityDigest = null)
        {
            Kind = kind;
            Owner = owner;
            Claims = claims;
            Tag = tag;
            CapabilityDigest = capabilityDigest;
        }

        internal PlatformCapabilityInspectionKind Kind { get; }

        internal PlatformActionCapabilityService? Owner { get; }

        internal object? Claims { get; }

        internal byte[]? Tag { get; }

        internal byte[]? CapabilityDigest { get; }
    }

    /// <summary>
    /// Process-local HMAC authority for short-lived, single-use native action capabilities.
    /// This service is deliberately HTTP-free: a future coordinator owns request handling,
    /// current Jellyfin access checks, idempotency and audit around these primitives.
    /// </summary>
    public sealed class PlatformActionCapabilityService : IDisposable
    {
        /// <summary>
        /// A service-issued current-validation decision. Its private constructor prevents
        /// same-assembly code from upgrading an authentic inspection into valid evidence.
        /// </summary>
        internal sealed class PlatformCapabilityValidation
        {
            private readonly object? _seal;
            private readonly PlatformCapabilityInspection? _inspection;

            internal PlatformCapabilityValidation(
                PlatformCapabilityValidationKind kind,
                object? seal = null,
                PlatformCapabilityInspection? inspection = null)
            {
                Kind = kind;
                _seal = seal;
                _inspection = inspection;
            }

            internal PlatformCapabilityValidationKind Kind { get; }

            internal bool TryGetInspection(object seal, out PlatformCapabilityInspection? inspection)
            {
                inspection = null;
                if (!ReferenceEquals(_seal, seal))
                {
                    return false;
                }

                inspection = _inspection;
                return inspection is not null;
            }
        }

        /// <summary>Capabilities are valid for one short prepare/invoke round trip.</summary>
        public static readonly TimeSpan CapabilityTimeToLive = TimeSpan.FromSeconds(60);

        /// <summary>Maximum number of minted, unexpired nonces retained process-wide.</summary>
        public const int MaximumLedgerEntries = 1024;

        /// <summary>Exact SHA-256 prepared-input digest size.</summary>
        public const int InputDigestBytes = 32;

        internal const int AuthorityKeyBytes = 32;
        internal const int NonceBytes = 32;
        internal const int AuthenticationTagBytes = 32;
        internal const int MaximumDeviceIdBytes = 128;
        internal const int MaximumTokenCharacters = 604;

        private const byte FormatVersion = 1;
        private const int MaximumNonceAttempts = 8;
        private const ushort NullStringLength = ushort.MaxValue;
        private const int FixedPayloadBytes = 1 + 16 + 16 + 4 + 8 + 8 + 8 + 32 + 32;

        private static readonly byte[] HmacDomain =
            Encoding.ASCII.GetBytes("jellyfin-canopy/platform-action-capability/hmac-sha256/v1");

        private static readonly byte[] DeviceHmacDomain =
            Encoding.ASCII.GetBytes("jellyfin-canopy/platform-action-capability/device-attenuation/hmac-sha256/v1");

        private static readonly UTF8Encoding StrictUtf8 = new(false, true);

        private readonly object _gate = new();
        private readonly Dictionary<string, LedgerEntry> _ledger = new(StringComparer.Ordinal);
        private readonly TimeProvider _timeProvider;
        private readonly Func<int, byte[]> _randomBytes;
        private readonly byte[] _authorityKey;
        private readonly object _validationSeal = new();
        private long _authorityRevision = 1;
        private bool _disposed;

        /// <summary>Creates the process authority with a fresh 256-bit HMAC key.</summary>
        public PlatformActionCapabilityService()
            : this(TimeProvider.System, RandomNumberGenerator.GetBytes(AuthorityKeyBytes), RandomNumberGenerator.GetBytes)
        {
        }

        internal PlatformActionCapabilityService(
            TimeProvider timeProvider,
            byte[] authorityKey,
            Func<int, byte[]> randomBytes)
        {
            _timeProvider = timeProvider ?? throw new ArgumentNullException(nameof(timeProvider));
            ArgumentNullException.ThrowIfNull(authorityKey);
            _randomBytes = randomBytes ?? throw new ArgumentNullException(nameof(randomBytes));

            if (authorityKey.Length != AuthorityKeyBytes)
            {
                throw new ArgumentException("The action-capability HMAC key must be exactly 256 bits.", nameof(authorityKey));
            }

            _authorityKey = (byte[])authorityKey.Clone();
        }

        /// <summary>
        /// Mints and reserves one nonce. Caller data may select only a known operation;
        /// schema, authority and generation are derived from the closed vocabulary.
        /// </summary>
        internal PlatformCapabilityMintOutcome Mint(
            PlatformActor? actor,
            string? operationId,
            Guid itemId,
            HostItemKind itemKind,
            ReadOnlySpan<byte> preparedInputDigest,
            bool attenuateToCurrentDevice)
        {
            if (actor is null
                || itemId == Guid.Empty
                || preparedInputDigest.Length != InputDigestBytes
                || !Enum.IsDefined(itemKind))
            {
                return new PlatformCapabilityMintOutcome(PlatformCapabilityMintOutcomeKind.InvalidRequest);
            }

            var definition = PlatformOperationVocabulary.Find(operationId);
            if (definition is null || !definition.SupportedItemKinds.Contains(itemKind))
            {
                return new PlatformCapabilityMintOutcome(PlatformCapabilityMintOutcomeKind.InvalidRequest);
            }

            if (!definition.Allows(actor.Authority))
            {
                return new PlatformCapabilityMintOutcome(PlatformCapabilityMintOutcomeKind.NotAuthorized);
            }

            string? boundDeviceId = null;
            if (attenuateToCurrentDevice)
            {
                if (!IsBoundedDeviceAttribution(actor.DeviceId))
                {
                    return new PlatformCapabilityMintOutcome(PlatformCapabilityMintOutcomeKind.InvalidRequest);
                }

                boundDeviceId = actor.DeviceId;
            }

            lock (_gate)
            {
                ThrowIfDisposed();
                var now = _timeProvider.GetUtcNow();
                RemoveExpiredEntries(now);

                if (_ledger.Count >= MaximumLedgerEntries)
                {
                    return new PlatformCapabilityMintOutcome(PlatformCapabilityMintOutcomeKind.AtCapacity);
                }

                byte[]? nonce = null;
                string? nonceKey = null;
                for (var attempt = 0; attempt < MaximumNonceAttempts; attempt++)
                {
                    var candidate = _randomBytes(NonceBytes);
                    if (candidate is null || candidate.Length != NonceBytes)
                    {
                        return new PlatformCapabilityMintOutcome(PlatformCapabilityMintOutcomeKind.EntropyUnavailable);
                    }

                    var candidateKey = Convert.ToHexString(candidate);
                    if (!_ledger.ContainsKey(candidateKey))
                    {
                        nonce = (byte[])candidate.Clone();
                        nonceKey = candidateKey;
                        break;
                    }
                }

                if (nonce is null || nonceKey is null)
                {
                    return new PlatformCapabilityMintOutcome(PlatformCapabilityMintOutcomeKind.EntropyUnavailable);
                }

                var expiresAt = DateTimeOffset.FromUnixTimeMilliseconds(
                    (now + CapabilityTimeToLive).ToUnixTimeMilliseconds());
                var claims = new CapabilityClaims(
                    actor.UserId,
                    definition.Id.Value,
                    itemId,
                    itemKind,
                    definition.InputSchemaId.Value,
                    preparedInputDigest.ToArray(),
                    boundDeviceId is null ? null : DigestDevice(boundDeviceId),
                    definition.InvalidationGeneration,
                    _authorityRevision,
                    expiresAt,
                    nonce);
                var payload = EncodeClaims(claims);
                var tag = Sign(payload);
                var raw = new byte[payload.Length + AuthenticationTagBytes];
                payload.CopyTo(raw, 0);
                tag.CopyTo(raw, payload.Length);
                var capability = ToBase64Url(raw);

                _ledger.Add(nonceKey, new LedgerEntry(expiresAt, _authorityRevision, tag));
                return new PlatformCapabilityMintOutcome(
                    PlatformCapabilityMintOutcomeKind.Issued,
                    capability,
                    expiresAt);
            }
        }

        /// <summary>Authenticates and decodes without consuming or checking invocation context.</summary>
        internal PlatformCapabilityInspection Inspect(string? capability)
        {
            lock (_gate)
            {
                ThrowIfDisposed();
                var now = _timeProvider.GetUtcNow();
                RemoveExpiredEntries(now);

                if (!TryFromCanonicalBase64Url(capability, out var raw)
                    || raw.Length <= AuthenticationTagBytes)
                {
                    return new PlatformCapabilityInspection(PlatformCapabilityInspectionKind.Invalid);
                }

                var payloadLength = raw.Length - AuthenticationTagBytes;
                var payload = raw.AsSpan(0, payloadLength);
                var suppliedTag = raw.AsSpan(payloadLength, AuthenticationTagBytes);
                var expectedTag = Sign(payload);
                if (!CryptographicOperations.FixedTimeEquals(suppliedTag, expectedTag)
                    || !TryDecodeClaims(payload, out var claims))
                {
                    return new PlatformCapabilityInspection(PlatformCapabilityInspectionKind.Invalid);
                }

                if (claims.ExpiresAt <= now)
                {
                    return new PlatformCapabilityInspection(PlatformCapabilityInspectionKind.Expired);
                }

                return new PlatformCapabilityInspection(
                    PlatformCapabilityInspectionKind.Authentic,
                    this,
                    claims,
                    expectedTag,
                    SHA256.HashData(Encoding.ASCII.GetBytes(capability!)));
            }
        }

        /// <summary>
        /// Proves that an authentic inspection came from this service for the exact
        /// opaque spelling a prepared-context owner is about to resolve.
        /// </summary>
        internal bool IsInspectionFor(
            PlatformCapabilityInspection? inspection,
            string? capability)
        {
            lock (_gate)
            {
                ThrowIfDisposed();
                return inspection is not null
                    && inspection.Kind == PlatformCapabilityInspectionKind.Authentic
                    && ReferenceEquals(inspection.Owner, this)
                    && inspection.CapabilityDigest is { Length: 32 } expected
                    && capability is not null
                    && capability.Length <= MaximumTokenCharacters
                    && CryptographicOperations.FixedTimeEquals(
                        expected,
                        SHA256.HashData(Encoding.ASCII.GetBytes(capability)));
            }
        }

        /// <summary>
        /// Rechecks an inspected token against the current actor, closed vocabulary,
        /// invocation item and prepared-input digest. It deliberately does not consume.
        /// </summary>
        internal PlatformCapabilityValidation ValidateCurrent(
            PlatformCapabilityInspection? inspection,
            PlatformActor? actor,
            string? operationId,
            Guid itemId,
            HostItemKind itemKind,
            ReadOnlySpan<byte> preparedInputDigest)
        {
            lock (_gate)
            {
                ThrowIfDisposed();
                var now = _timeProvider.GetUtcNow();
                RemoveExpiredEntries(now);

                if (inspection is null
                    || inspection.Kind != PlatformCapabilityInspectionKind.Authentic
                    || !ReferenceEquals(inspection.Owner, this)
                    || inspection.Claims is not CapabilityClaims claims)
                {
                    return new PlatformCapabilityValidation(PlatformCapabilityValidationKind.InvalidCapability);
                }

                if (claims.ExpiresAt <= now)
                {
                    return new PlatformCapabilityValidation(PlatformCapabilityValidationKind.Expired);
                }

                if (claims.AuthorityRevision != _authorityRevision)
                {
                    return new PlatformCapabilityValidation(PlatformCapabilityValidationKind.StaleAuthority);
                }

                if (actor is null || claims.UserId != actor.UserId)
                {
                    return new PlatformCapabilityValidation(PlatformCapabilityValidationKind.WrongActor);
                }

                var definition = PlatformOperationVocabulary.Find(operationId);
                if (definition is null
                    || !string.Equals(claims.OperationId, operationId, StringComparison.Ordinal))
                {
                    return new PlatformCapabilityValidation(PlatformCapabilityValidationKind.WrongOperation);
                }

                if (claims.ItemId != itemId || claims.ItemKind != itemKind)
                {
                    return new PlatformCapabilityValidation(PlatformCapabilityValidationKind.WrongItem);
                }

                if (preparedInputDigest.Length != InputDigestBytes
                    || !CryptographicOperations.FixedTimeEquals(claims.InputDigest, preparedInputDigest))
                {
                    return new PlatformCapabilityValidation(PlatformCapabilityValidationKind.WrongInput);
                }

                if (claims.BoundDeviceDigest is not null
                    && (!IsBoundedDeviceAttribution(actor.DeviceId)
                        || !CryptographicOperations.FixedTimeEquals(
                            claims.BoundDeviceDigest,
                            DigestDevice(actor.DeviceId!))))
                {
                    return new PlatformCapabilityValidation(PlatformCapabilityValidationKind.WrongDevice);
                }

                if (claims.OperationGeneration != definition.InvalidationGeneration
                    || !string.Equals(claims.InputSchemaId, definition.InputSchemaId.Value, StringComparison.Ordinal)
                    || !definition.SupportedItemKinds.Contains(itemKind))
                {
                    return new PlatformCapabilityValidation(PlatformCapabilityValidationKind.StaleAuthority);
                }

                if (!definition.Allows(actor.Authority))
                {
                    return new PlatformCapabilityValidation(PlatformCapabilityValidationKind.NotAuthorized);
                }

                return new PlatformCapabilityValidation(
                    PlatformCapabilityValidationKind.Valid,
                    _validationSeal,
                    inspection);
            }
        }

        /// <summary>
        /// Atomically consumes a currently validated capability. A coordinator can first
        /// return a stored idempotent result and omit this call; a new execution must call
        /// it immediately before invoking an owner.
        /// </summary>
        internal PlatformCapabilityConsumeKind Consume(PlatformCapabilityValidation? validation)
        {
            lock (_gate)
            {
                ThrowIfDisposed();
                var now = _timeProvider.GetUtcNow();
                RemoveExpiredEntries(now);

                if (validation is null
                    || validation.Kind != PlatformCapabilityValidationKind.Valid
                    || !validation.TryGetInspection(_validationSeal, out var inspection)
                    || inspection?.Claims is not CapabilityClaims claims
                    || inspection.Tag is null)
                {
                    return PlatformCapabilityConsumeKind.Invalid;
                }

                if (claims.ExpiresAt <= now)
                {
                    return PlatformCapabilityConsumeKind.Expired;
                }

                if (claims.AuthorityRevision != _authorityRevision)
                {
                    return PlatformCapabilityConsumeKind.StaleAuthority;
                }

                var nonceKey = Convert.ToHexString(claims.Nonce);
                if (!_ledger.TryGetValue(nonceKey, out var entry)
                    || entry.AuthorityRevision != claims.AuthorityRevision
                    || entry.ExpiresAt != claims.ExpiresAt
                    || !CryptographicOperations.FixedTimeEquals(entry.Tag, inspection.Tag))
                {
                    return PlatformCapabilityConsumeKind.Invalid;
                }

                if (entry.Consumed)
                {
                    return PlatformCapabilityConsumeKind.Replay;
                }

                entry.Consumed = true;
                return PlatformCapabilityConsumeKind.Consumed;
            }
        }

        /// <summary>
        /// Invalidates every outstanding token after an authority or catalog change.
        /// Removed entries are no longer live; ordinary capacity cleanup never evicts a
        /// live entry.
        /// </summary>
        internal void InvalidateOutstandingCapabilities()
        {
            lock (_gate)
            {
                ThrowIfDisposed();
                _authorityRevision = checked(_authorityRevision + 1);
                ClearLedger();
            }
        }

        internal int LedgerEntryCount
        {
            get
            {
                lock (_gate)
                {
                    ThrowIfDisposed();
                    RemoveExpiredEntries(_timeProvider.GetUtcNow());
                    return _ledger.Count;
                }
            }
        }

        internal long CurrentAuthorityRevision
        {
            get
            {
                lock (_gate)
                {
                    ThrowIfDisposed();
                    return _authorityRevision;
                }
            }
        }

        /// <inheritdoc />
        public void Dispose()
        {
            lock (_gate)
            {
                if (_disposed)
                {
                    return;
                }

                CryptographicOperations.ZeroMemory(_authorityKey);
                ClearLedger();
                _disposed = true;
            }
        }

        private static bool IsBoundedDeviceAttribution(string? value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return false;
            }

            try
            {
                if (StrictUtf8.GetByteCount(value) > MaximumDeviceIdBytes)
                {
                    return false;
                }
            }
            catch (EncoderFallbackException)
            {
                return false;
            }

            return value.All(character => !char.IsControl(character)
                && character is not ('\u2028' or '\u2029'));
        }

        private byte[] Sign(ReadOnlySpan<byte> payload)
        {
            var signingInput = new byte[HmacDomain.Length + payload.Length];
            HmacDomain.CopyTo(signingInput, 0);
            payload.CopyTo(signingInput.AsSpan(HmacDomain.Length));
            return HMACSHA256.HashData(_authorityKey, signingInput);
        }

        private byte[] DigestDevice(string deviceId)
        {
            var device = StrictUtf8.GetBytes(deviceId);
            var signingInput = new byte[DeviceHmacDomain.Length + 2 + device.Length];
            DeviceHmacDomain.CopyTo(signingInput, 0);
            BinaryPrimitives.WriteUInt16BigEndian(signingInput.AsSpan(DeviceHmacDomain.Length, 2), (ushort)device.Length);
            device.CopyTo(signingInput, DeviceHmacDomain.Length + 2);
            return HMACSHA256.HashData(_authorityKey, signingInput);
        }

        private static byte[] EncodeClaims(CapabilityClaims claims)
        {
            var operation = StrictUtf8.GetBytes(claims.OperationId);
            var schema = StrictUtf8.GetBytes(claims.InputSchemaId);
            var device = claims.BoundDeviceDigest;
            using var stream = new MemoryStream(FixedPayloadBytes + operation.Length + schema.Length + (device?.Length ?? 0) + 6);

            stream.WriteByte(FormatVersion);
            WriteGuid(stream, claims.UserId);
            WriteGuid(stream, claims.ItemId);
            WriteInt32(stream, (int)claims.ItemKind);
            WriteInt64(stream, claims.OperationGeneration);
            WriteInt64(stream, claims.AuthorityRevision);
            WriteInt64(stream, claims.ExpiresAt.ToUnixTimeMilliseconds());
            stream.Write(claims.Nonce);
            stream.Write(claims.InputDigest);
            WriteBytes(stream, operation);
            WriteBytes(stream, schema);
            WriteNullableBytes(stream, device);
            return stream.ToArray();
        }

        private static bool TryDecodeClaims(ReadOnlySpan<byte> payload, out CapabilityClaims claims)
        {
            claims = null!;
            var offset = 0;
            if (!TryReadByte(payload, ref offset, out var version)
                || version != FormatVersion
                || !TryReadGuid(payload, ref offset, out var userId)
                || userId == Guid.Empty
                || !TryReadGuid(payload, ref offset, out var itemId)
                || itemId == Guid.Empty
                || !TryReadInt32(payload, ref offset, out var rawItemKind)
                || !Enum.IsDefined((HostItemKind)rawItemKind)
                || !TryReadInt64(payload, ref offset, out var operationGeneration)
                || operationGeneration <= 0
                || !TryReadInt64(payload, ref offset, out var authorityRevision)
                || authorityRevision <= 0
                || !TryReadInt64(payload, ref offset, out var expiresUnixMilliseconds)
                || !TryReadFixedBytes(payload, ref offset, NonceBytes, out var nonce)
                || !TryReadFixedBytes(payload, ref offset, InputDigestBytes, out var inputDigest)
                || !TryReadString(payload, ref offset, PlatformOperationVocabulary.MaximumIdentifierLength, out var operationId)
                || !TryReadString(payload, ref offset, PlatformOperationVocabulary.MaximumIdentifierLength, out var inputSchemaId)
                || !TryReadNullableFixedBytes(payload, ref offset, AuthenticationTagBytes, out var boundDeviceDigest)
                || offset != payload.Length
                || PlatformOperationVocabulary.Find(operationId) is null
                || !PlatformOperationVocabulary.IsValidIdentifier(inputSchemaId))
            {
                return false;
            }

            DateTimeOffset expiresAt;
            try
            {
                expiresAt = DateTimeOffset.FromUnixTimeMilliseconds(expiresUnixMilliseconds);
            }
            catch (ArgumentOutOfRangeException)
            {
                return false;
            }

            claims = new CapabilityClaims(
                userId,
                operationId,
                itemId,
                (HostItemKind)rawItemKind,
                inputSchemaId,
                inputDigest,
                boundDeviceDigest,
                operationGeneration,
                authorityRevision,
                expiresAt,
                nonce);
            return true;
        }

        private static void WriteGuid(Stream stream, Guid value)
        {
            Span<byte> bytes = stackalloc byte[16];
            if (!value.TryWriteBytes(bytes, bigEndian: true, out var bytesWritten) || bytesWritten != bytes.Length)
            {
                throw new InvalidOperationException("A Platform capability GUID could not be encoded.");
            }

            stream.Write(bytes);
        }

        private static void WriteInt32(Stream stream, int value)
        {
            Span<byte> bytes = stackalloc byte[4];
            BinaryPrimitives.WriteInt32BigEndian(bytes, value);
            stream.Write(bytes);
        }

        private static void WriteInt64(Stream stream, long value)
        {
            Span<byte> bytes = stackalloc byte[8];
            BinaryPrimitives.WriteInt64BigEndian(bytes, value);
            stream.Write(bytes);
        }

        private static void WriteBytes(Stream stream, byte[] value)
        {
            if (value.Length >= NullStringLength)
            {
                throw new InvalidOperationException("A Platform capability string exceeded its canonical length prefix.");
            }

            Span<byte> length = stackalloc byte[2];
            BinaryPrimitives.WriteUInt16BigEndian(length, (ushort)value.Length);
            stream.Write(length);
            stream.Write(value);
        }

        private static void WriteNullableBytes(Stream stream, byte[]? value)
        {
            if (value is null)
            {
                Span<byte> marker = stackalloc byte[2];
                BinaryPrimitives.WriteUInt16BigEndian(marker, NullStringLength);
                stream.Write(marker);
                return;
            }

            WriteBytes(stream, value);
        }

        private static bool TryReadByte(ReadOnlySpan<byte> source, ref int offset, out byte value)
        {
            value = 0;
            if (offset >= source.Length)
            {
                return false;
            }

            value = source[offset++];
            return true;
        }

        private static bool TryReadGuid(ReadOnlySpan<byte> source, ref int offset, out Guid value)
        {
            value = default;
            if (source.Length - offset < 16)
            {
                return false;
            }

            value = new Guid(source.Slice(offset, 16), bigEndian: true);
            offset += 16;
            return true;
        }

        private static bool TryReadInt32(ReadOnlySpan<byte> source, ref int offset, out int value)
        {
            value = 0;
            if (source.Length - offset < 4)
            {
                return false;
            }

            value = BinaryPrimitives.ReadInt32BigEndian(source.Slice(offset, 4));
            offset += 4;
            return true;
        }

        private static bool TryReadInt64(ReadOnlySpan<byte> source, ref int offset, out long value)
        {
            value = 0;
            if (source.Length - offset < 8)
            {
                return false;
            }

            value = BinaryPrimitives.ReadInt64BigEndian(source.Slice(offset, 8));
            offset += 8;
            return true;
        }

        private static bool TryReadFixedBytes(ReadOnlySpan<byte> source, ref int offset, int length, out byte[] value)
        {
            value = Array.Empty<byte>();
            if (source.Length - offset < length)
            {
                return false;
            }

            value = source.Slice(offset, length).ToArray();
            offset += length;
            return true;
        }

        private static bool TryReadString(
            ReadOnlySpan<byte> source,
            ref int offset,
            int maximumBytes,
            out string value)
        {
            value = string.Empty;
            if (!TryReadUInt16(source, ref offset, out var length)
                || length == NullStringLength
                || length == 0
                || length > maximumBytes
                || source.Length - offset < length)
            {
                return false;
            }

            try
            {
                value = StrictUtf8.GetString(source.Slice(offset, length));
            }
            catch (DecoderFallbackException)
            {
                return false;
            }

            offset += length;
            return true;
        }

        private static bool TryReadNullableFixedBytes(
            ReadOnlySpan<byte> source,
            ref int offset,
            int expectedLength,
            out byte[]? value)
        {
            value = null;
            if (!TryReadUInt16(source, ref offset, out var length))
            {
                return false;
            }

            if (length == NullStringLength)
            {
                return true;
            }

            if (length != expectedLength || source.Length - offset < length)
            {
                return false;
            }

            value = source.Slice(offset, length).ToArray();
            offset += length;
            return true;
        }

        private static bool TryReadUInt16(ReadOnlySpan<byte> source, ref int offset, out ushort value)
        {
            value = 0;
            if (source.Length - offset < 2)
            {
                return false;
            }

            value = BinaryPrimitives.ReadUInt16BigEndian(source.Slice(offset, 2));
            offset += 2;
            return true;
        }

        private static string ToBase64Url(ReadOnlySpan<byte> bytes) =>
            Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

        private static bool TryFromCanonicalBase64Url(string? value, out byte[] bytes)
        {
            bytes = Array.Empty<byte>();
            if (string.IsNullOrEmpty(value)
                || value.Length > MaximumTokenCharacters
                || value.Length % 4 == 1
                || value.Any(character => !IsBase64UrlCharacter(character)))
            {
                return false;
            }

            var padding = (4 - (value.Length % 4)) % 4;
            var canonicalBase64 = value.Replace('-', '+').Replace('_', '/') + new string('=', padding);
            try
            {
                bytes = Convert.FromBase64String(canonicalBase64);
            }
            catch (FormatException)
            {
                return false;
            }

            return string.Equals(ToBase64Url(bytes), value, StringComparison.Ordinal);
        }

        private static bool IsBase64UrlCharacter(char value) =>
            value is >= 'A' and <= 'Z'
            || value is >= 'a' and <= 'z'
            || value is >= '0' and <= '9'
            || value is '-' or '_';

        private void RemoveExpiredEntries(DateTimeOffset now)
        {
            List<string>? expired = null;
            foreach (var pair in _ledger)
            {
                if (pair.Value.ExpiresAt <= now)
                {
                    (expired ??= new List<string>()).Add(pair.Key);
                }
            }

            if (expired is not null)
            {
                foreach (var key in expired)
                {
                    if (_ledger.Remove(key, out var entry))
                    {
                        entry.ClearSensitiveState();
                    }
                }
            }
        }

        private void ClearLedger()
        {
            foreach (var entry in _ledger.Values)
            {
                entry.ClearSensitiveState();
            }

            _ledger.Clear();
        }

        private void ThrowIfDisposed()
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
        }

        private sealed class CapabilityClaims
        {
            internal CapabilityClaims(
                Guid userId,
                string operationId,
                Guid itemId,
                HostItemKind itemKind,
                string inputSchemaId,
                byte[] inputDigest,
                byte[]? boundDeviceDigest,
                long operationGeneration,
                long authorityRevision,
                DateTimeOffset expiresAt,
                byte[] nonce)
            {
                UserId = userId;
                OperationId = operationId;
                ItemId = itemId;
                ItemKind = itemKind;
                InputSchemaId = inputSchemaId;
                InputDigest = inputDigest;
                BoundDeviceDigest = boundDeviceDigest;
                OperationGeneration = operationGeneration;
                AuthorityRevision = authorityRevision;
                ExpiresAt = expiresAt;
                Nonce = nonce;
            }

            internal Guid UserId { get; }

            internal string OperationId { get; }

            internal Guid ItemId { get; }

            internal HostItemKind ItemKind { get; }

            internal string InputSchemaId { get; }

            internal byte[] InputDigest { get; }

            internal byte[]? BoundDeviceDigest { get; }

            internal long OperationGeneration { get; }

            internal long AuthorityRevision { get; }

            internal DateTimeOffset ExpiresAt { get; }

            internal byte[] Nonce { get; }
        }

        private sealed class LedgerEntry
        {
            internal LedgerEntry(DateTimeOffset expiresAt, long authorityRevision, byte[] tag)
            {
                ExpiresAt = expiresAt;
                AuthorityRevision = authorityRevision;
                Tag = tag;
            }

            internal DateTimeOffset ExpiresAt { get; }

            internal long AuthorityRevision { get; }

            internal byte[] Tag { get; }

            internal bool Consumed { get; set; }

            internal void ClearSensitiveState() => CryptographicOperations.ZeroMemory(Tag);
        }
    }
}
