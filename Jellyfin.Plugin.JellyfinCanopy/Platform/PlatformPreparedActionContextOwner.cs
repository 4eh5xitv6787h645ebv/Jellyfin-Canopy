using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>The bounded server-owned state attached to one prepared action.</summary>
    internal sealed class PlatformPreparedActionRequest
    {
        private readonly byte[] _privateState;

        internal PlatformPreparedActionRequest(
            PlatformOperationDefinition definition,
            HostAccessibleItem item,
            long configurationRevision,
            ReadOnlySpan<byte> privateState)
        {
            ArgumentNullException.ThrowIfNull(definition);
            if (!ReferenceEquals(PlatformOperationVocabulary.Find(definition.Id.Value), definition))
            {
                throw new ArgumentException("The prepared operation must come from the code-owned vocabulary.", nameof(definition));
            }

            if (item.Id == Guid.Empty || !definition.SupportedItemKinds.Contains(item.Kind))
            {
                throw new ArgumentException("A supported accessible item projection is required.", nameof(item));
            }

            if (configurationRevision < 0)
            {
                throw new ArgumentOutOfRangeException(nameof(configurationRevision));
            }

            if (privateState.Length > PlatformPreparedActionContextOwner.MaximumPrivateStateBytes)
            {
                throw new ArgumentException("Prepared private state exceeds its fixed byte bound.", nameof(privateState));
            }

            Definition = definition;
            Item = item;
            ConfigurationRevision = configurationRevision;
            _privateState = privateState.ToArray();
        }

        internal PlatformOperationDefinition Definition { get; }

        internal HostAccessibleItem Item { get; }

        internal long ConfigurationRevision { get; }

        internal ReadOnlyMemory<byte> PrivateState => _privateState.ToArray();
    }

    /// <summary>An immutable context released only after exact capability authentication.</summary>
    internal sealed class PlatformPreparedActionContext : IDisposable
    {
        private readonly byte[] _privateState;
        private readonly byte[] _digest;

        internal PlatformPreparedActionContext(
            PlatformPreparedActionRequest request,
            ReadOnlySpan<byte> digest)
        {
            Definition = request.Definition;
            Item = request.Item;
            ConfigurationRevision = request.ConfigurationRevision;
            _privateState = request.PrivateState.ToArray();
            _digest = digest.ToArray();
        }

        private PlatformPreparedActionContext(PlatformPreparedActionContext source)
        {
            Definition = source.Definition;
            Item = source.Item;
            ConfigurationRevision = source.ConfigurationRevision;
            _privateState = source._privateState.ToArray();
            _digest = source._digest.ToArray();
        }

        internal PlatformOperationDefinition Definition { get; }

        internal HostAccessibleItem Item { get; }

        internal long ConfigurationRevision { get; }

        internal ReadOnlyMemory<byte> PrivateState => _privateState.ToArray();

        internal ReadOnlyMemory<byte> Digest => _digest.ToArray();

        internal PlatformPreparedActionContext Detach() => new(this);

        /// <inheritdoc />
        public void Dispose()
        {
            CryptographicOperations.ZeroMemory(_privateState);
            CryptographicOperations.ZeroMemory(_digest);
        }
    }

    internal enum PlatformPreparedActionIssueKind
    {
        Issued,
        InvalidRequest,
        NotAuthorized,
        AtCapacity,
        EntropyUnavailable,
    }

    internal sealed class PlatformPreparedActionIssue
    {
        internal PlatformPreparedActionIssue(
            PlatformPreparedActionIssueKind kind,
            string? capability = null,
            DateTimeOffset? expiresAt = null)
        {
            Kind = kind;
            Capability = capability;
            ExpiresAt = expiresAt;
        }

        internal PlatformPreparedActionIssueKind Kind { get; }

        internal string? Capability { get; }

        internal DateTimeOffset? ExpiresAt { get; }
    }

    /// <summary>
    /// Process-local, fixed-cap owner joining opaque capabilities to server-private
    /// prepared preconditions. Tokens are never retained; a process-keyed digest is the
    /// lookup key, and every resolve also proves the exact authenticated inspection.
    /// </summary>
    public sealed class PlatformPreparedActionContextOwner : IDisposable
    {
        /// <summary>Maximum live prepared contexts retained process-wide.</summary>
        public const int MaximumEntries = 1024;

        /// <summary>Maximum server-private state attached to one prepared action.</summary>
        public const int MaximumPrivateStateBytes = 4096;

        private const int LookupKeyBytes = 32;

        private static readonly byte[] ContextDomain =
            Encoding.ASCII.GetBytes("jellyfin-canopy/platform-prepared-context/v1");

        private static readonly byte[] LookupDomain =
            Encoding.ASCII.GetBytes("jellyfin-canopy/platform-prepared-context/lookup/v1");

        private readonly object _gate = new();
        private readonly Dictionary<string, Entry> _entries = new(StringComparer.Ordinal);
        private readonly PlatformActionCapabilityService _capabilities;
        private readonly TimeProvider _timeProvider;
        private readonly byte[] _lookupKey;
        private bool _disposed;

        /// <summary>Initializes the process-local owner.</summary>
        public PlatformPreparedActionContextOwner(PlatformActionCapabilityService capabilities)
            : this(capabilities, TimeProvider.System, RandomNumberGenerator.GetBytes(LookupKeyBytes))
        {
        }

        internal PlatformPreparedActionContextOwner(
            PlatformActionCapabilityService capabilities,
            TimeProvider timeProvider,
            ReadOnlySpan<byte> lookupKey)
        {
            _capabilities = capabilities ?? throw new ArgumentNullException(nameof(capabilities));
            _timeProvider = timeProvider ?? throw new ArgumentNullException(nameof(timeProvider));
            if (lookupKey.Length != LookupKeyBytes)
            {
                throw new ArgumentException($"The prepared-context lookup key must contain {LookupKeyBytes} bytes.", nameof(lookupKey));
            }

            _lookupKey = lookupKey.ToArray();
        }

        internal PlatformPreparedActionIssue Issue(
            PlatformActor actor,
            PlatformPreparedActionRequest request,
            bool attenuateToCurrentDevice)
        {
            ArgumentNullException.ThrowIfNull(actor);
            ArgumentNullException.ThrowIfNull(request);
            var digest = CreateContextDigest(request);

            lock (_gate)
            {
                ThrowIfDisposed();
                RemoveExpired(_timeProvider.GetUtcNow());
                if (_entries.Count >= MaximumEntries)
                {
                    return new PlatformPreparedActionIssue(PlatformPreparedActionIssueKind.AtCapacity);
                }

                var minted = _capabilities.Mint(
                    actor,
                    request.Definition.Id.Value,
                    request.Item.Id,
                    request.Item.Kind,
                    digest,
                    attenuateToCurrentDevice);
                if (minted.Kind != PlatformCapabilityMintOutcomeKind.Issued
                    || minted.Capability is null
                    || minted.ExpiresAt is null)
                {
                    return new PlatformPreparedActionIssue(Map(minted.Kind));
                }

                var lookup = Lookup(minted.Capability);
                if (_entries.ContainsKey(lookup))
                {
                    // A keyed SHA-256 collision is treated as entropy failure. Never
                    // replace a live context with a different action.
                    return new PlatformPreparedActionIssue(PlatformPreparedActionIssueKind.EntropyUnavailable);
                }

                _entries.Add(
                    lookup,
                    new Entry(new PlatformPreparedActionContext(request, digest), minted.ExpiresAt.Value));
                return new PlatformPreparedActionIssue(
                    PlatformPreparedActionIssueKind.Issued,
                    minted.Capability,
                    minted.ExpiresAt);
            }
        }

        internal PlatformPreparedActionContext? Resolve(
            string? capability,
            PlatformCapabilityInspection? inspection)
        {
            if (!_capabilities.IsInspectionFor(inspection, capability) || capability is null)
            {
                return null;
            }

            lock (_gate)
            {
                ThrowIfDisposed();
                RemoveExpired(_timeProvider.GetUtcNow());
                // Never lend the owner-retained buffers outside the lock. A config
                // save may synchronously zero and clear every retained context while
                // an already-admitted invocation is still evaluating authority.
                return _entries.TryGetValue(Lookup(capability), out var entry)
                    ? entry.Context.Detach()
                    : null;
            }
        }

        internal void InvalidateOutstanding()
        {
            lock (_gate)
            {
                ThrowIfDisposed();
                _capabilities.InvalidateOutstandingCapabilities();
                ClearEntries();
            }
        }

        internal int EntryCount
        {
            get
            {
                lock (_gate)
                {
                    ThrowIfDisposed();
                    RemoveExpired(_timeProvider.GetUtcNow());
                    return _entries.Count;
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

                ClearEntries();
                CryptographicOperations.ZeroMemory(_lookupKey);
                _disposed = true;
            }
        }

        private static byte[] CreateContextDigest(PlatformPreparedActionRequest request)
        {
            using var stream = new MemoryStream();
            stream.Write(ContextDomain);
            WriteString(stream, request.Definition.Id.Value);
            WriteString(stream, request.Definition.InputSchemaId.Value);
            Span<byte> number = stackalloc byte[8];
            BinaryPrimitives.WriteInt64BigEndian(number, request.Definition.InvalidationGeneration);
            stream.Write(number);
            Span<byte> item = stackalloc byte[16];
            request.Item.Id.TryWriteBytes(item);
            stream.Write(item);
            stream.WriteByte((byte)request.Item.Kind);
            stream.WriteByte(request.Item.SeriesId.HasValue ? (byte)1 : (byte)0);
            if (request.Item.SeriesId is Guid seriesId)
            {
                seriesId.TryWriteBytes(item);
                stream.Write(item);
            }

            BinaryPrimitives.WriteInt64BigEndian(number, request.ConfigurationRevision);
            stream.Write(number);
            BinaryPrimitives.WriteInt32BigEndian(number[..4], request.PrivateState.Length);
            stream.Write(number[..4]);
            stream.Write(request.PrivateState.Span);
            return SHA256.HashData(stream.GetBuffer().AsSpan(0, checked((int)stream.Length)));
        }

        private string Lookup(string capability)
        {
            var token = Encoding.ASCII.GetBytes(capability);
            var input = new byte[LookupDomain.Length + token.Length];
            LookupDomain.CopyTo(input, 0);
            token.CopyTo(input, LookupDomain.Length);
            return Convert.ToHexString(HMACSHA256.HashData(_lookupKey, input));
        }

        private static void WriteString(Stream stream, string value)
        {
            var bytes = Encoding.UTF8.GetBytes(value);
            Span<byte> length = stackalloc byte[2];
            BinaryPrimitives.WriteUInt16BigEndian(length, checked((ushort)bytes.Length));
            stream.Write(length);
            stream.Write(bytes);
        }

        private void RemoveExpired(DateTimeOffset now)
        {
            List<string>? expired = null;
            foreach (var pair in _entries)
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
                    if (_entries.Remove(key, out var entry))
                    {
                        entry.Context.Dispose();
                    }
                }
            }
        }

        private void ClearEntries()
        {
            foreach (var entry in _entries.Values)
            {
                entry.Context.Dispose();
            }

            _entries.Clear();
        }

        private static PlatformPreparedActionIssueKind Map(PlatformCapabilityMintOutcomeKind kind) => kind switch
        {
            PlatformCapabilityMintOutcomeKind.InvalidRequest => PlatformPreparedActionIssueKind.InvalidRequest,
            PlatformCapabilityMintOutcomeKind.NotAuthorized => PlatformPreparedActionIssueKind.NotAuthorized,
            PlatformCapabilityMintOutcomeKind.AtCapacity => PlatformPreparedActionIssueKind.AtCapacity,
            PlatformCapabilityMintOutcomeKind.EntropyUnavailable => PlatformPreparedActionIssueKind.EntropyUnavailable,
            _ => PlatformPreparedActionIssueKind.EntropyUnavailable,
        };

        private void ThrowIfDisposed() => ObjectDisposedException.ThrowIf(_disposed, this);

        private sealed record Entry(PlatformPreparedActionContext Context, DateTimeOffset ExpiresAt);
    }
}
