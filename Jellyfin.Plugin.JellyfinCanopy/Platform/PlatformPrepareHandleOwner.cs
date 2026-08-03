using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>One named owner revision bound into a native prepare handle.</summary>
    internal readonly record struct PlatformPrepareStateRevision
    {
        internal PlatformPrepareStateRevision(string name, long revision)
        {
            Name = PlatformPrepareSnapshot.NormalizeToken(
                name,
                PlatformPrepareSnapshot.MaximumRevisionNameBytes,
                nameof(name));
            if (revision < 0)
            {
                throw new ArgumentOutOfRangeException(nameof(revision));
            }

            Revision = revision;
        }

        internal string Name { get; }

        internal long Revision { get; }
    }

    /// <summary>The normalized client presentation context used to resolve a catalog.</summary>
    internal sealed class PlatformPrepareClientContext
    {
        internal PlatformPrepareClientContext(
            IEnumerable<string> contributionKinds,
            IEnumerable<string> fieldKinds,
            IEnumerable<string> inputModes,
            IEnumerable<string> accessibility,
            string locale)
        {
            ContributionKinds = PlatformPrepareSnapshot.NormalizeSet(contributionKinds, nameof(contributionKinds));
            FieldKinds = PlatformPrepareSnapshot.NormalizeSet(fieldKinds, nameof(fieldKinds));
            InputModes = PlatformPrepareSnapshot.NormalizeSet(inputModes, nameof(inputModes));
            Accessibility = PlatformPrepareSnapshot.NormalizeSet(accessibility, nameof(accessibility));
            Locale = NormalizeLocale(locale);
        }

        internal ImmutableArray<string> ContributionKinds { get; }

        internal ImmutableArray<string> FieldKinds { get; }

        internal ImmutableArray<string> InputModes { get; }

        internal ImmutableArray<string> Accessibility { get; }

        internal string Locale { get; }

        internal PlatformPrepareClientContext Clone() => new(
            ContributionKinds,
            FieldKinds,
            InputModes,
            Accessibility,
            Locale);

        private static string NormalizeLocale(string value)
        {
            ArgumentException.ThrowIfNullOrWhiteSpace(value);
            var candidate = value.Trim();
            if (Encoding.UTF8.GetByteCount(candidate) > PlatformPrepareSnapshot.MaximumLocaleBytes
                || candidate.Any(character => !(character is >= 'a' and <= 'z'
                    or >= 'A' and <= 'Z'
                    or >= '0' and <= '9'
                    or '-')))
            {
                throw new ArgumentException("The prepared locale is not a bounded language tag.", nameof(value));
            }

            try
            {
                var normalized = CultureInfo.GetCultureInfo(candidate).Name.ToLowerInvariant();
                if (normalized.Length == 0
                    || Encoding.UTF8.GetByteCount(normalized) > PlatformPrepareSnapshot.MaximumLocaleBytes)
                {
                    throw new ArgumentException("The prepared locale is not a bounded language tag.", nameof(value));
                }

                return normalized;
            }
            catch (CultureNotFoundException exception)
            {
                throw new ArgumentException("The prepared locale is not a recognized language tag.", nameof(value), exception);
            }
        }
    }

    /// <summary>
    /// Immutable copy of the exact fields released by the host's positive access
    /// projection. This type cannot mint <see cref="HostAccessibleItem"/>; prepare must
    /// obtain a fresh positive projection from the host and compare every field.
    /// </summary>
    internal sealed class PlatformPrepareItemSnapshot
    {
        internal PlatformPrepareItemSnapshot(HostAccessibleItem item)
        {
            Id = item.Id;
            Kind = item.Kind;
            SeriesId = item.SeriesId;
            ProviderReferences = NormalizeProviderReferences(item.ProviderReferences);
        }

        internal Guid Id { get; }

        internal HostItemKind Kind { get; }

        internal Guid? SeriesId { get; }

        internal ImmutableArray<HostProviderReference> ProviderReferences { get; }

        internal PlatformPrepareItemSnapshot Clone() => (PlatformPrepareItemSnapshot)MemberwiseClone();

        private static ImmutableArray<HostProviderReference> NormalizeProviderReferences(
            ImmutableArray<HostProviderReference> providerReferences)
        {
            if (providerReferences.IsDefault
                || providerReferences.Length > PlatformPrepareSnapshot.MaximumProviderReferences)
            {
                throw new ArgumentException("The accessible item provider set exceeds its fixed bound.", nameof(providerReferences));
            }

            return providerReferences
                .Select(reference => new HostProviderReference(
                    NormalizeProvider(reference.Provider),
                    NormalizeProviderValue(reference.Value)))
                .Distinct()
                .OrderBy(reference => reference.Provider, StringComparer.Ordinal)
                .ThenBy(reference => reference.Value, StringComparer.Ordinal)
                .ToImmutableArray();
        }

        private static string NormalizeProvider(string value)
        {
            var normalized = PlatformPrepareSnapshot.NormalizeToken(value, 16, nameof(value));
            if (normalized is not ("tmdb" or "tvdb" or "imdb"))
            {
                throw new ArgumentException("The accessible item contains an unknown provider reference.", nameof(value));
            }

            return normalized;
        }

        private static string NormalizeProviderValue(string value)
        {
            ArgumentException.ThrowIfNullOrWhiteSpace(value);
            var normalized = value;
            if (Encoding.UTF8.GetByteCount(normalized) > PlatformPrepareSnapshot.MaximumProviderValueBytes
                || normalized.Any(character => char.IsControl(character)
                    || char.IsWhiteSpace(character)
                    || char.IsSurrogate(character)))
            {
                throw new ArgumentException("The provider value is outside its fixed string bound.", nameof(value));
            }

            return normalized;
        }
    }

    /// <summary>
    /// Complete immutable server-derived state behind one item-detail prepare handle.
    /// Every member is retained so the later prepare service can re-authorize it rather
    /// than trusting the handle or the caller to restate authority.
    /// </summary>
    internal sealed class PlatformPrepareSnapshot
    {
        internal const int MaximumCapabilityValues = 16;
        internal const int MaximumCapabilityValueBytes = 64;
        internal const int MaximumLocaleBytes = 64;
        internal const int MaximumCatalogRevisionBytes = 128;
        internal const int MaximumStateRevisions = 16;
        internal const int MaximumRevisionNameBytes = 64;
        internal const int MaximumPrivateStateBytes = 4096;
        internal const int MaximumProviderReferences = 3;
        internal const int MaximumProviderValueBytes = 128;

        private readonly byte[] _privateState;

        internal PlatformPrepareSnapshot(
            PlatformActor actor,
            HostAccessibleItem item,
            PlatformOperationDefinition definition,
            PlatformPrepareClientContext client,
            IEnumerable<PlatformPrepareStateRevision> stateRevisions,
            long configurationRevision,
            string catalogRevision,
            ReadOnlySpan<byte> privateState,
            bool attenuateToCurrentDevice)
        {
            ArgumentNullException.ThrowIfNull(actor);
            ArgumentNullException.ThrowIfNull(definition);
            ArgumentNullException.ThrowIfNull(client);
            if (!ReferenceEquals(PlatformOperationVocabulary.Find(definition.Id.Value), definition))
            {
                throw new ArgumentException("The prepared operation must come from the code-owned vocabulary.", nameof(definition));
            }

            if (item.Id == Guid.Empty
                || item.Kind == HostItemKind.Other
                || !definition.SupportedItemKinds.Contains(item.Kind))
            {
                throw new ArgumentException("A supported accessible item projection is required.", nameof(item));
            }

            if (configurationRevision < 0)
            {
                throw new ArgumentOutOfRangeException(nameof(configurationRevision));
            }

            if (privateState.Length > MaximumPrivateStateBytes)
            {
                throw new ArgumentException("Prepared private state exceeds its fixed byte bound.", nameof(privateState));
            }

            UserId = actor.UserId;
            IsElevated = actor.IsElevated;
            ClientName = NormalizeAttribution(
                actor.ClientName,
                PlatformActorBoundaryFilter.MaxClientNameBytes,
                nameof(actor));
            DeviceId = NormalizeAttribution(
                actor.DeviceId,
                PlatformActorBoundaryFilter.MaxDeviceIdBytes,
                nameof(actor));
            if (attenuateToCurrentDevice && DeviceId is null)
            {
                throw new ArgumentException("Device attenuation requires bounded current-device attribution.", nameof(attenuateToCurrentDevice));
            }

            AttenuateToCurrentDevice = attenuateToCurrentDevice;
            Item = new PlatformPrepareItemSnapshot(item);
            Definition = definition;
            Client = client.Clone();
            StateRevisions = NormalizeRevisions(stateRevisions);
            ConfigurationRevision = configurationRevision;
            CatalogRevision = NormalizeCatalogRevision(catalogRevision);
            _privateState = privateState.ToArray();
        }

        internal Guid UserId { get; }

        internal bool IsElevated { get; }

        internal string? ClientName { get; }

        internal string? DeviceId { get; }

        internal bool AttenuateToCurrentDevice { get; }

        internal PlatformPrepareItemSnapshot Item { get; }

        internal PlatformOperationDefinition Definition { get; }

        internal PlatformPrepareClientContext Client { get; }

        internal ImmutableArray<PlatformPrepareStateRevision> StateRevisions { get; }

        internal long ConfigurationRevision { get; }

        internal string CatalogRevision { get; }

        internal ReadOnlyMemory<byte> PrivateState => _privateState.ToArray();

        internal bool IsFor(PlatformActor actor)
        {
            ArgumentNullException.ThrowIfNull(actor);
            return actor.UserId == UserId
                && actor.IsElevated == IsElevated
                && (!AttenuateToCurrentDevice
                    || string.Equals(actor.DeviceId, DeviceId, StringComparison.Ordinal));
        }

        private PlatformPrepareSnapshot(PlatformPrepareSnapshot source)
        {
            UserId = source.UserId;
            IsElevated = source.IsElevated;
            ClientName = source.ClientName;
            DeviceId = source.DeviceId;
            AttenuateToCurrentDevice = source.AttenuateToCurrentDevice;
            Item = source.Item.Clone();
            Definition = source.Definition;
            Client = source.Client.Clone();
            StateRevisions = source.StateRevisions;
            ConfigurationRevision = source.ConfigurationRevision;
            CatalogRevision = source.CatalogRevision;
            _privateState = source._privateState.ToArray();
        }

        internal PlatformPrepareSnapshot Clone() => new(this);

        internal byte[] CanonicalSemanticKey()
        {
            using var stream = new MemoryStream();
            WriteString(stream, "jellyfin-canopy/platform-prepare-snapshot/v1");
            WriteGuid(stream, UserId);
            stream.WriteByte(IsElevated ? (byte)1 : (byte)0);
            WriteOptionalString(stream, ClientName);
            WriteOptionalString(stream, DeviceId);
            stream.WriteByte(AttenuateToCurrentDevice ? (byte)1 : (byte)0);

            WriteGuid(stream, Item.Id);
            stream.WriteByte((byte)Item.Kind);
            if (Item.SeriesId is Guid seriesId)
            {
                stream.WriteByte(1);
                WriteGuid(stream, seriesId);
            }
            else
            {
                stream.WriteByte(0);
            }

            WriteInt32(stream, Item.ProviderReferences.Length);
            foreach (var providerReference in Item.ProviderReferences)
            {
                WriteString(stream, providerReference.Provider);
                WriteString(stream, providerReference.Value);
            }

            WriteString(stream, Definition.Id.Value);
            stream.WriteByte((byte)Definition.Family);
            stream.WriteByte((byte)Definition.Authority);
            stream.WriteByte((byte)Definition.ItemScope);
            stream.WriteByte(Definition.IsMutation ? (byte)1 : (byte)0);
            WriteString(stream, Definition.InputSchemaId.Value);
            WriteInt64(stream, Definition.InvalidationGeneration);
            WriteInt32(stream, Definition.SupportedItemKinds.Length);
            foreach (var itemKind in Definition.SupportedItemKinds.OrderBy(kind => kind))
            {
                stream.WriteByte((byte)itemKind);
            }

            WriteStrings(stream, Client.ContributionKinds);
            WriteStrings(stream, Client.FieldKinds);
            WriteStrings(stream, Client.InputModes);
            WriteStrings(stream, Client.Accessibility);
            WriteString(stream, Client.Locale);

            WriteInt32(stream, StateRevisions.Length);
            foreach (var revision in StateRevisions)
            {
                WriteString(stream, revision.Name);
                WriteInt64(stream, revision.Revision);
            }

            WriteInt64(stream, ConfigurationRevision);
            WriteString(stream, CatalogRevision);
            WriteInt32(stream, _privateState.Length);
            stream.Write(_privateState);
            return stream.ToArray();
        }

        internal void ClearPrivateState() => CryptographicOperations.ZeroMemory(_privateState);

        internal static ImmutableArray<string> NormalizeSet(IEnumerable<string> values, string parameterName)
        {
            ArgumentNullException.ThrowIfNull(values, parameterName);
            var normalized = new HashSet<string>(StringComparer.Ordinal);
            var inputCount = 0;
            foreach (var value in values)
            {
                inputCount++;
                if (inputCount > MaximumCapabilityValues)
                {
                    throw new ArgumentException("The client capability set exceeds its fixed entry bound.", parameterName);
                }

                normalized.Add(NormalizeToken(value, MaximumCapabilityValueBytes, parameterName));
            }

            return normalized
                .OrderBy(value => value, StringComparer.Ordinal)
                .ToImmutableArray();
        }

        internal static string NormalizeToken(string value, int maximumUtf8Bytes, string parameterName)
        {
            ArgumentException.ThrowIfNullOrWhiteSpace(value, parameterName);
            var candidate = value.Trim();
            if (Encoding.UTF8.GetByteCount(candidate) > maximumUtf8Bytes
                || candidate.Any(character => !(character is >= 'a' and <= 'z'
                    or >= 'A' and <= 'Z'
                    or >= '0' and <= '9'
                    or '_' or '-')))
            {
                throw new ArgumentException("The prepared identifier is outside its bounded token grammar.", parameterName);
            }

            return string.Create(candidate.Length, candidate, static (destination, source) =>
            {
                for (var index = 0; index < source.Length; index++)
                {
                    var character = source[index];
                    destination[index] = character is >= 'A' and <= 'Z'
                        ? (char)(character + ('a' - 'A'))
                        : character;
                }
            });
        }

        private static string NormalizeCatalogRevision(string value)
        {
            ArgumentException.ThrowIfNullOrWhiteSpace(value);
            var normalized = value.Trim();
            if (Encoding.UTF8.GetByteCount(normalized) > MaximumCatalogRevisionBytes
                || normalized.Any(character => char.IsControl(character) || char.IsWhiteSpace(character)))
            {
                throw new ArgumentException("The catalog revision is outside its fixed string bound.", nameof(value));
            }

            return normalized;
        }

        private static string? NormalizeAttribution(string? value, int maximumUtf8Bytes, string parameterName)
        {
            if (value is null)
            {
                return null;
            }

            var normalized = value.Trim();
            if (normalized.Length == 0
                || Encoding.UTF8.GetByteCount(normalized) > maximumUtf8Bytes
                || normalized.Any(character => char.IsControl(character)
                    || character is '\u2028' or '\u2029'))
            {
                throw new ArgumentException("Actor attribution is outside its fixed string bound.", parameterName);
            }

            return normalized;
        }

        private static ImmutableArray<PlatformPrepareStateRevision> NormalizeRevisions(
            IEnumerable<PlatformPrepareStateRevision> revisions)
        {
            ArgumentNullException.ThrowIfNull(revisions);
            var source = ImmutableArray.CreateBuilder<PlatformPrepareStateRevision>(MaximumStateRevisions);
            foreach (var revision in revisions)
            {
                if (source.Count == MaximumStateRevisions)
                {
                    throw new ArgumentException("The prepared state revision set exceeds its fixed entry bound.", nameof(revisions));
                }

                source.Add(revision);
            }

            var normalized = source
                .Distinct()
                .OrderBy(revision => revision.Name, StringComparer.Ordinal)
                .ToImmutableArray();
            if (normalized.GroupBy(revision => revision.Name, StringComparer.Ordinal).Any(group => group.Count() != 1))
            {
                throw new ArgumentException("A prepared state revision name must have one exact value.", nameof(revisions));
            }

            return normalized;
        }

        private static void WriteStrings(Stream stream, ImmutableArray<string> values)
        {
            WriteInt32(stream, values.Length);
            foreach (var value in values)
            {
                WriteString(stream, value);
            }
        }

        private static void WriteOptionalString(Stream stream, string? value)
        {
            stream.WriteByte(value is null ? (byte)0 : (byte)1);
            if (value is not null)
            {
                WriteString(stream, value);
            }
        }

        private static void WriteString(Stream stream, string value)
        {
            var bytes = Encoding.UTF8.GetBytes(value);
            WriteInt32(stream, bytes.Length);
            stream.Write(bytes);
        }

        private static void WriteGuid(Stream stream, Guid value)
        {
            Span<byte> buffer = stackalloc byte[16];
            value.TryWriteBytes(buffer, bigEndian: true, out _);
            stream.Write(buffer);
        }

        private static void WriteInt32(Stream stream, int value)
        {
            Span<byte> buffer = stackalloc byte[4];
            BinaryPrimitives.WriteInt32BigEndian(buffer, value);
            stream.Write(buffer);
        }

        private static void WriteInt64(Stream stream, long value)
        {
            Span<byte> buffer = stackalloc byte[8];
            BinaryPrimitives.WriteInt64BigEndian(buffer, value);
            stream.Write(buffer);
        }
    }

    internal enum PlatformPrepareHandleIssueKind
    {
        Issued,
        Reused,
        AtCapacity,
        EntropyUnavailable,
    }

    /// <summary>A bounded result that never includes snapshot state.</summary>
    internal sealed class PlatformPrepareHandleIssue
    {
        internal PlatformPrepareHandleIssue(
            PlatformPrepareHandleIssueKind kind,
            string? handle = null,
            DateTimeOffset? expiresAt = null)
        {
            Kind = kind;
            Handle = handle;
            ExpiresAt = expiresAt;
        }

        internal PlatformPrepareHandleIssueKind Kind { get; }

        internal string? Handle { get; }

        internal DateTimeOffset? ExpiresAt { get; }
    }

    /// <summary>
    /// Process-local owner of random, short-lived handles emitted by item-detail resolve.
    /// Handles contain no claims and have no meaning without an exact live dictionary
    /// entry. This is deliberately separate from one-shot invoke capabilities.
    /// </summary>
    /// <remarks>
    /// Retention is capped at 1,024 snapshots independent of users and library size,
    /// with a second 24-entry cap per user. Every retained string, collection and byte
    /// payload is separately bounded by <see cref="PlatformPrepareSnapshot"/>.
    /// </remarks>
    public sealed class PlatformPrepareHandleOwner : IDisposable
    {
        public const int MaximumEntries = 1024;
        public const int MaximumEntriesPerActor = 24;
        public const int HandleEntropyBytes = 32;
        public const int MaximumHandleCharacters = 43;
        public static readonly TimeSpan HandleTimeToLive = TimeSpan.FromMinutes(5);

        private const int MaximumEntropyAttempts = 8;

        private readonly object _gate = new();
        private readonly Dictionary<string, Entry> _byHandle = new(StringComparer.Ordinal);
        private readonly Dictionary<SemanticKey, Entry> _bySemantic = new();
        private readonly Dictionary<Guid, LinkedList<Entry>> _byActor = new();
        private readonly TimeProvider _timeProvider;
        private readonly Func<int, byte[]> _randomBytes;
        private bool _disposed;

        /// <summary>Creates one process-local owner using operating-system entropy.</summary>
        public PlatformPrepareHandleOwner()
            : this(TimeProvider.System, RandomNumberGenerator.GetBytes)
        {
        }

        internal PlatformPrepareHandleOwner(TimeProvider timeProvider, Func<int, byte[]> randomBytes)
        {
            _timeProvider = timeProvider ?? throw new ArgumentNullException(nameof(timeProvider));
            _randomBytes = randomBytes ?? throw new ArgumentNullException(nameof(randomBytes));
        }

        internal PlatformPrepareHandleIssue IssueOrReuse(PlatformPrepareSnapshot snapshot)
        {
            ArgumentNullException.ThrowIfNull(snapshot);
            lock (_gate)
            {
                ThrowIfDisposed();
                var now = _timeProvider.GetUtcNow();
                RemoveExpired(now);
                var candidateKey = new SemanticKey(snapshot.CanonicalSemanticKey());
                var keyTransferred = false;
                try
                {
                    if (_bySemantic.TryGetValue(candidateKey, out var reused))
                    {
                        return new PlatformPrepareHandleIssue(
                            PlatformPrepareHandleIssueKind.Reused,
                            reused.Handle,
                            reused.ExpiresAt);
                    }

                    _byActor.TryGetValue(snapshot.UserId, out var actorEntries);
                    var mayReplaceOwnOldest = actorEntries?.Count >= MaximumEntriesPerActor;
                    if (_byHandle.Count >= MaximumEntries && !mayReplaceOwnOldest)
                    {
                        return new PlatformPrepareHandleIssue(PlatformPrepareHandleIssueKind.AtCapacity);
                    }

                    if (!TryCreateHandle(out var handle))
                    {
                        return new PlatformPrepareHandleIssue(PlatformPrepareHandleIssueKind.EntropyUnavailable);
                    }

                    // Finish every operation that could validate or allocate the new
                    // snapshot before removing this actor's oldest live entry.
                    var retainedSnapshot = snapshot.Clone();
                    var expiresAt = now + HandleTimeToLive;
                    var entry = new Entry(handle, candidateKey, retainedSnapshot, expiresAt);
                    if (mayReplaceOwnOldest)
                    {
                        Remove(actorEntries!.First!.Value);
                    }

                    if (!_byActor.TryGetValue(snapshot.UserId, out actorEntries))
                    {
                        actorEntries = new LinkedList<Entry>();
                        _byActor.Add(snapshot.UserId, actorEntries);
                    }

                    entry.ActorNode = actorEntries.AddLast(entry);
                    _byHandle.Add(handle, entry);
                    _bySemantic.Add(candidateKey, entry);
                    keyTransferred = true;
                    return new PlatformPrepareHandleIssue(
                        PlatformPrepareHandleIssueKind.Issued,
                        handle,
                        expiresAt);
                }
                finally
                {
                    if (!keyTransferred)
                    {
                        candidateKey.Dispose();
                    }
                }
            }
        }

        internal PlatformPrepareSnapshot? Resolve(string? handle, PlatformActor actor)
        {
            ArgumentNullException.ThrowIfNull(actor);
            lock (_gate)
            {
                ThrowIfDisposed();
                RemoveExpired(_timeProvider.GetUtcNow());
                if (!IsCanonicalHandle(handle)
                    || !_byHandle.TryGetValue(handle!, out var entry)
                    || !entry.Snapshot.IsFor(actor))
                {
                    return null;
                }

                return entry.Snapshot.Clone();
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
                    return _byHandle.Count;
                }
            }
        }

        /// <summary>
        /// Invalidates and zeroes every outstanding server-private prepare snapshot.
        /// A later enable starts from an empty generation and cannot revive a handle.
        /// </summary>
        internal void InvalidateOutstanding()
        {
            lock (_gate)
            {
                ThrowIfDisposed();
                ClearEntries();
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
                _disposed = true;
            }
        }

        private void ClearEntries()
        {
            foreach (var entry in _byHandle.Values)
            {
                entry.Dispose();
            }

            _byHandle.Clear();
            _bySemantic.Clear();
            _byActor.Clear();
        }

        private bool TryCreateHandle(out string handle)
        {
            handle = string.Empty;
            for (var attempt = 0; attempt < MaximumEntropyAttempts; attempt++)
            {
                byte[] candidate;
                try
                {
                    candidate = _randomBytes(HandleEntropyBytes);
                }
                catch (CryptographicException)
                {
                    return false;
                }

                if (candidate is null || candidate.Length != HandleEntropyBytes)
                {
                    return false;
                }

                try
                {
                    var encoded = Convert.ToBase64String(candidate)
                        .TrimEnd('=')
                        .Replace('+', '-')
                        .Replace('/', '_');
                    if (!_byHandle.ContainsKey(encoded))
                    {
                        handle = encoded;
                        return true;
                    }
                }
                finally
                {
                    CryptographicOperations.ZeroMemory(candidate);
                }
            }

            return false;
        }

        private static bool IsCanonicalHandle(string? handle)
            => handle is not null
                && handle.Length == MaximumHandleCharacters
                && handle.All(character => character is >= 'a' and <= 'z'
                    or >= 'A' and <= 'Z'
                    or >= '0' and <= '9'
                    or '-' or '_');

        private void RemoveExpired(DateTimeOffset now)
        {
            List<Entry>? expired = null;
            foreach (var entry in _byHandle.Values)
            {
                if (entry.ExpiresAt <= now)
                {
                    (expired ??= new List<Entry>()).Add(entry);
                }
            }

            if (expired is not null)
            {
                foreach (var entry in expired)
                {
                    Remove(entry);
                }
            }
        }

        private void Remove(Entry entry)
        {
            _byHandle.Remove(entry.Handle);
            _bySemantic.Remove(entry.Key);
            if (entry.ActorNode?.List is LinkedList<Entry> actorEntries)
            {
                actorEntries.Remove(entry.ActorNode);
                if (actorEntries.Count == 0)
                {
                    _byActor.Remove(entry.Snapshot.UserId);
                }
            }

            entry.Dispose();
        }

        private void ThrowIfDisposed() => ObjectDisposedException.ThrowIf(_disposed, this);

        private sealed class Entry : IDisposable
        {
            internal Entry(
                string handle,
                SemanticKey key,
                PlatformPrepareSnapshot snapshot,
                DateTimeOffset expiresAt)
            {
                Handle = handle;
                Key = key;
                Snapshot = snapshot;
                ExpiresAt = expiresAt;
            }

            internal string Handle { get; }

            internal SemanticKey Key { get; }

            internal PlatformPrepareSnapshot Snapshot { get; }

            internal DateTimeOffset ExpiresAt { get; }

            internal LinkedListNode<Entry>? ActorNode { get; set; }

            public void Dispose()
            {
                Snapshot.ClearPrivateState();
                Key.Dispose();
                ActorNode = null;
            }
        }

        private sealed class SemanticKey : IEquatable<SemanticKey>, IDisposable
        {
            private readonly byte[] _bytes;
            private readonly int _hashCode;

            internal SemanticKey(byte[] bytes)
            {
                ArgumentNullException.ThrowIfNull(bytes);
                _bytes = (byte[])bytes.Clone();
                CryptographicOperations.ZeroMemory(bytes);
                var hash = new HashCode();
                foreach (var value in _bytes)
                {
                    hash.Add(value);
                }

                _hashCode = hash.ToHashCode();
            }

            public bool Equals(SemanticKey? other)
                => other is not null && _bytes.AsSpan().SequenceEqual(other._bytes);

            public override bool Equals(object? obj) => Equals(obj as SemanticKey);

            public override int GetHashCode() => _hashCode;

            public void Dispose() => CryptographicOperations.ZeroMemory(_bytes);
        }
    }
}
