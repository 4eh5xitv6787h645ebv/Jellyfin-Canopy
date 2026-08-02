using System;
using System.Buffers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Primitives;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>A validated, transport-neutral Platform idempotency key.</summary>
    public readonly record struct PlatformIdempotencyKey
    {
        /// <summary>The HTTP spelling of this value.</summary>
        public const string HeaderName = "Idempotency-Key";

        /// <summary>Maximum key length accepted by every transport.</summary>
        public const int MaximumLength = 128;

        private PlatformIdempotencyKey(string value)
        {
            Value = value;
        }

        /// <summary>The validated, case-sensitive value.</summary>
        public string Value { get; }

        /// <summary>Validates a key from an HTTP header or a future request body.</summary>
        public static bool TryParse(string? value, out PlatformIdempotencyKey key)
        {
            if (value is not null && value.Length is >= 1 and <= MaximumLength)
            {
                foreach (var character in value)
                {
                    if (!IsAllowed(character))
                    {
                        key = default;
                        return false;
                    }
                }

                key = new PlatformIdempotencyKey(value);
                return true;
            }

            key = default;
            return false;
        }

        /// <summary>Reads exactly one header value and applies the shared parser.</summary>
        public static bool TryParseHeader(StringValues values, out PlatformIdempotencyKey key)
        {
            if (values.Count == 1)
            {
                return TryParse(values[0], out key);
            }

            key = default;
            return false;
        }

        /// <inheritdoc />
        public override string ToString() => Value ?? string.Empty;

        private static bool IsAllowed(char value) =>
            (value >= 'A' && value <= 'Z')
            || (value >= 'a' && value <= 'z')
            || (value >= '0' && value <= '9')
            || value is '.' or '_' or '~' or '-';
    }

    /// <summary>An exact SHA-256 digest of a mutation's caller-defined semantics.</summary>
    public sealed class PlatformSemanticFingerprint
    {
        private const int Sha256Length = 32;
        private readonly byte[] _bytes;

        /// <summary>Initializes a fingerprint from exactly 32 caller-computed bytes.</summary>
        public PlatformSemanticFingerprint(ReadOnlySpan<byte> bytes)
        {
            if (bytes.Length != Sha256Length)
            {
                throw new ArgumentException("A semantic SHA-256 fingerprint must contain exactly 32 bytes.", nameof(bytes));
            }

            _bytes = bytes.ToArray();
        }

        internal bool Matches(PlatformSemanticFingerprint other) =>
            CryptographicOperations.FixedTimeEquals(_bytes, other._bytes);
    }

    /// <summary>The bounded declaration used to admit an idempotent mutation.</summary>
    public sealed class PlatformIdempotencyRequest
    {
        /// <summary>Initializes one mutation identity and its result-size reservation.</summary>
        public PlatformIdempotencyRequest(
            Guid actingUserId,
            string operation,
            PlatformIdempotencyKey key,
            PlatformSemanticFingerprint fingerprint,
            int maximumResultBytes)
        {
            if (actingUserId == Guid.Empty)
            {
                throw new ArgumentException("An acting user is required.", nameof(actingUserId));
            }

            if (!IsValidOperation(operation))
            {
                throw new ArgumentException("The operation must be 1-128 ASCII letters, digits, '.', '_', '~', or '-'.", nameof(operation));
            }

            if (string.IsNullOrEmpty(key.Value))
            {
                throw new ArgumentException("A parsed idempotency key is required.", nameof(key));
            }

            ArgumentNullException.ThrowIfNull(fingerprint);
            if (maximumResultBytes is < 1 or > PlatformIdempotencyStore.MaximumResultBytes)
            {
                throw new ArgumentOutOfRangeException(nameof(maximumResultBytes));
            }

            ActingUserId = actingUserId;
            Operation = operation;
            Key = key;
            Fingerprint = fingerprint;
            MaximumResultBytes = maximumResultBytes;
        }

        /// <summary>The authenticated principal; never a request payload field.</summary>
        public Guid ActingUserId { get; }

        /// <summary>A code-owned stable mutation name.</summary>
        public string Operation { get; }

        /// <summary>The caller's validated retry key.</summary>
        public PlatformIdempotencyKey Key { get; }

        /// <summary>The caller-defined hash of fields that change mutation semantics.</summary>
        public PlatformSemanticFingerprint Fingerprint { get; }

        /// <summary>Bytes reserved before execution for the immutable semantic result.</summary>
        public int MaximumResultBytes { get; }

        private static bool IsValidOperation(string? operation)
        {
            if (operation is null || operation.Length is < 1 or > 128)
            {
                return false;
            }

            return PlatformIdempotencyKey.TryParse(operation, out _);
        }
    }

    /// <summary>
    /// Immutable semantic mutation output. It deliberately contains neither an MVC
    /// result nor request-specific metadata such as a correlation id.
    /// </summary>
    public sealed class PlatformIdempotencyResult
    {
        private readonly JsonElement _value;

        /// <summary>Initializes semantic output suitable for a fresh response envelope.</summary>
        public PlatformIdempotencyResult(int statusCode, string outcomeCode, JsonElement value)
        {
            if (statusCode is < 200 or > 599)
            {
                throw new ArgumentOutOfRangeException(nameof(statusCode));
            }

            if (string.IsNullOrEmpty(outcomeCode) || outcomeCode.Length > 128
                || !PlatformIdempotencyKey.TryParse(outcomeCode, out _))
            {
                throw new ArgumentException("The outcome code must use the bounded Platform token alphabet.", nameof(outcomeCode));
            }

            if (value.ValueKind == JsonValueKind.Undefined)
            {
                throw new ArgumentException("A defined semantic JSON value is required.", nameof(value));
            }

            var fixedSize = sizeof(int) + Encoding.UTF8.GetByteCount(outcomeCode);
            var counter = new BoundedCountingBufferWriter(PlatformIdempotencyStore.MaximumResultBytes - fixedSize);
            try
            {
                using var writer = new Utf8JsonWriter(counter);
                JsonSerializer.Serialize(writer, value, PlatformJson.SerializerOptions);
                writer.Flush();
            }
            catch (InvalidOperationException exception)
            {
                throw new ArgumentException(
                    $"The semantic result must not exceed {PlatformIdempotencyStore.MaximumResultBytes} bytes.",
                    nameof(value),
                    exception);
            }

            StatusCode = statusCode;
            OutcomeCode = outcomeCode;
            SerializedSizeBytes = fixedSize + counter.BytesWritten;
            _value = value.Clone();
        }

        /// <summary>The completed HTTP status a caller may reconstruct.</summary>
        public int StatusCode { get; }

        /// <summary>A stable semantic outcome code.</summary>
        public string OutcomeCode { get; }

        /// <summary>A defensive clone of the semantic value.</summary>
        public JsonElement Value => _value.Clone();

        internal int SerializedSizeBytes { get; }

        private sealed class BoundedCountingBufferWriter : IBufferWriter<byte>
        {
            private readonly int _maximumBytes;
            private byte[] _buffer;

            internal BoundedCountingBufferWriter(int maximumBytes)
            {
                _maximumBytes = maximumBytes;
                _buffer = new byte[Math.Min(maximumBytes, 4096)];
            }

            internal int BytesWritten { get; private set; }

            public void Advance(int count)
            {
                if (count < 0 || count > _buffer.Length || BytesWritten + count > _maximumBytes)
                {
                    throw new InvalidOperationException("The bounded semantic result writer exceeded its limit.");
                }

                BytesWritten += count;
            }

            public Memory<byte> GetMemory(int sizeHint = 0)
            {
                EnsureCapacity(sizeHint);
                return _buffer;
            }

            public Span<byte> GetSpan(int sizeHint = 0)
            {
                EnsureCapacity(sizeHint);
                return _buffer;
            }

            private void EnsureCapacity(int sizeHint)
            {
                var required = Math.Max(sizeHint, 1);
                // The IBufferWriter contract requires at least sizeHint bytes even when
                // the writer will advance by far less. Bound the temporary segment by
                // the per-result ceiling, then enforce the exact cumulative limit in
                // Advance so a result near the boundary is not rejected on a size hint.
                if (required > _maximumBytes)
                {
                    throw new InvalidOperationException("The bounded semantic result writer exceeded its limit.");
                }

                if (_buffer.Length < required)
                {
                    _buffer = new byte[required];
                }
            }
        }
    }

    /// <summary>The non-exceptional decision returned by the idempotency kernel.</summary>
    public enum PlatformIdempotencyOutcomeKind
    {
        /// <summary>This caller was admitted and executed the mutation.</summary>
        Executed,

        /// <summary>A prior or coalesced execution supplied the same semantic result.</summary>
        Replay,

        /// <summary>The tuple was already used with a different semantic fingerprint.</summary>
        Conflict,

        /// <summary>The bounded process-local store could not admit new work.</summary>
        AtCapacity,

        /// <summary>An earlier execution may have mutated state but did not publish a result.</summary>
        Indeterminate,
    }

    /// <summary>An idempotency decision and optional immutable semantic result.</summary>
    public sealed class PlatformIdempotencyOutcome
    {
        internal PlatformIdempotencyOutcome(PlatformIdempotencyOutcomeKind kind, PlatformIdempotencyResult? result = null)
        {
            Kind = kind;
            Result = result;
        }

        /// <summary>The decision.</summary>
        public PlatformIdempotencyOutcomeKind Kind { get; }

        /// <summary>Present only for executed or replayed work.</summary>
        public PlatformIdempotencyResult? Result { get; }

        /// <summary>
        /// Existing Platform error code a future mutation route must use for this
        /// non-result outcome. Capacity is retryable; conflicts and ambiguous prior
        /// execution are deliberately not automatic-retry signals.
        /// </summary>
        public string? ErrorCode => Kind switch
        {
            PlatformIdempotencyOutcomeKind.Conflict => PlatformErrorCode.Conflict,
            PlatformIdempotencyOutcomeKind.AtCapacity => PlatformErrorCode.RateLimited,
            PlatformIdempotencyOutcomeKind.Indeterminate => PlatformErrorCode.Conflict,
            _ => null,
        };
    }
}
