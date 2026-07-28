using System;
using System.Security.Cryptography;
using System.Text;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>
    /// Encodes and verifies Platform v1 pagination cursors.
    ///
    /// <para>
    /// <b>Why cursors at all.</b> The existing surface speaks three incompatible
    /// pagination dialects across sibling endpoints — <c>take</c>/<c>skip</c>,
    /// <c>page</c>/<c>pageSize</c>/<c>size</c>, and opaque cursors — so a client author
    /// has to learn which one each endpoint speaks. Cursors are the only one of the three
    /// that survives a change of underlying store, and offset paging silently skips or
    /// repeats rows when the collection changes underneath a walk.
    /// </para>
    /// <para>
    /// <b>Why signed and scoped rather than plain base64.</b> The legacy cursors are
    /// base64url of the position, which is decodable, forgeable, and carries no record of
    /// which listing produced it. A cursor from one query therefore "works" on another and
    /// silently yields nonsense. Here the token is bound to its scope and carries a MAC,
    /// so a tampered, foreign, or stale cursor is <i>detected</i> and refused rather than
    /// quietly restarting the walk from the beginning — the failure this issue exists to
    /// prevent.
    /// </para>
    /// <para>
    /// The version prefix is what makes the format genuinely changeable: the encoding is
    /// not a contract, and a cursor issued under an older layout is rejected cleanly
    /// instead of being misread.
    /// </para>
    /// </summary>
    public sealed class PlatformCursorCodec
    {
        /// <summary>
        /// Current cursor layout. Bumping this invalidates every previously issued
        /// cursor, which is the point: the encoding may change and old tokens must fail
        /// loudly rather than be reinterpreted.
        /// </summary>
        private const byte Version = 1;

        private const int TagBytes = 16;

        private readonly byte[] _key;

        /// <summary>Initializes a new instance of the <see cref="PlatformCursorCodec"/> class.</summary>
        /// <param name="key">Signing key. Process-scoped is sufficient — cursors are short-lived.</param>
        public PlatformCursorCodec(byte[] key)
        {
            ArgumentNullException.ThrowIfNull(key);

            if (key.Length < 32)
            {
                throw new ArgumentException("A cursor signing key must be at least 32 bytes.", nameof(key));
            }

            _key = (byte[])key.Clone();
        }

        /// <summary>A codec with a freshly generated random key.</summary>
        /// <returns>A codec whose cursors are valid for this process only.</returns>
        public static PlatformCursorCodec CreateWithRandomKey() => new(RandomNumberGenerator.GetBytes(32));

        /// <summary>
        /// An opaque token encoding <paramref name="position"/> within
        /// <paramref name="scope"/>.
        /// </summary>
        /// <param name="scope">Identifies the listing. A cursor is only valid for the scope that issued it.</param>
        /// <param name="position">The last key returned, which the next page starts after.</param>
        /// <returns>A base64url token carrying no format a caller may depend on.</returns>
        public string Encode(string scope, string position)
        {
            ArgumentNullException.ThrowIfNull(scope);
            ArgumentNullException.ThrowIfNull(position);

            var payload = Encoding.UTF8.GetBytes(position);
            var token = new byte[1 + TagBytes + payload.Length];

            token[0] = Version;
            Sign(scope, payload).AsSpan(0, TagBytes).CopyTo(token.AsSpan(1));
            payload.CopyTo(token.AsSpan(1 + TagBytes));

            return Base64Url(token);
        }

        /// <summary>
        /// Verifies <paramref name="token"/> and recovers its position.
        ///
        /// Returns <c>false</c> for anything that is not a cursor this codec issued for
        /// this exact scope — malformed, truncated, tampered with, from another listing,
        /// or from an older layout. The caller turns that into a structured error; it
        /// must never be treated as "start from the beginning", because silently
        /// restarting a walk is indistinguishable from success to the client and produces
        /// duplicates without ever reporting a fault.
        /// </summary>
        /// <param name="scope">The listing the cursor must belong to.</param>
        /// <param name="token">The token supplied by the caller.</param>
        /// <param name="position">The recovered position when verification succeeds.</param>
        /// <returns><c>true</c> when the token is authentic for this scope.</returns>
        public bool TryDecode(string scope, string token, out string position)
        {
            position = string.Empty;

            if (scope is null || string.IsNullOrEmpty(token))
            {
                return false;
            }

            if (!TryFromBase64Url(token, out var raw) || raw.Length < 1 + TagBytes || raw[0] != Version)
            {
                return false;
            }

            var payload = raw.AsSpan(1 + TagBytes).ToArray();
            var expected = Sign(scope, payload).AsSpan(0, TagBytes);

            // Fixed-time comparison. A cursor tag is not a credential, but comparing it
            // byte-by-byte with early exit is a habit worth not forming in a codebase
            // where the next thing to use this pattern might be one.
            if (!CryptographicOperations.FixedTimeEquals(raw.AsSpan(1, TagBytes), expected))
            {
                return false;
            }

            position = Encoding.UTF8.GetString(payload);
            return true;
        }

        private byte[] Sign(string scope, byte[] payload)
        {
            using var mac = new HMACSHA256(_key);

            // The scope is length-prefixed so that ("ab", "c") and ("a", "bc") cannot
            // produce the same signed message and let a cursor cross between listings.
            var scopeBytes = Encoding.UTF8.GetBytes(scope);
            var message = new byte[4 + scopeBytes.Length + payload.Length];

            BitConverter.TryWriteBytes(message.AsSpan(0, 4), scopeBytes.Length);
            scopeBytes.CopyTo(message.AsSpan(4));
            payload.CopyTo(message.AsSpan(4 + scopeBytes.Length));

            return mac.ComputeHash(message);
        }

        private static string Base64Url(byte[] value) => Convert.ToBase64String(value)
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');

        private static bool TryFromBase64Url(string value, out byte[] decoded)
        {
            decoded = Array.Empty<byte>();

            var base64 = value.Replace('-', '+').Replace('_', '/');
            base64 = base64.PadRight(base64.Length + ((4 - (base64.Length % 4)) % 4), '=');

            Span<byte> buffer = new byte[base64.Length];
            if (!Convert.TryFromBase64String(base64, buffer, out var written))
            {
                return false;
            }

            decoded = buffer[..written].ToArray();
            return true;
        }
    }
}
