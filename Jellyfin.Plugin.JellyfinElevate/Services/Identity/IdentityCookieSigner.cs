using System;
using System.Security.Cryptography;
using System.Text;

namespace Jellyfin.Plugin.JellyfinElevate.Services
{
    /// <summary>
    /// Mints and verifies the signed identity cookie (issue 13). Payload is
    /// <c>{userIdN}.{issuedAtUnix}</c>; the cookie value is
    /// <c>{payloadB64Url}.{hmacB64Url}</c> where the HMAC is SHA-256 over the
    /// payload with a server-only secret. Because the signature proves the value
    /// was minted inside that user's real authenticated session, the resolver can
    /// trust the named user WITHOUT the session-on-IP cross-check the legacy raw
    /// <c>je-spoiler-uid</c> cookie needs — it works even when no session is
    /// currently active on the request IP (e.g. a browser quietly scrolling long
    /// after last activity, or fetching a CSS-background image that carries no
    /// marker).
    ///
    /// Trust model unchanged from the marker/cookie tiers: this is a
    /// DISAMBIGUATION signal, not authentication. It cannot be forged without the
    /// secret, and a genuine-but-stale value only ever opts an anonymous viewer
    /// into that user's OWN stricter/looser content view — never grants access.
    /// Pure and static so it unit-tests without any Jellyfin host.
    /// </summary>
    public static class IdentityCookieSigner
    {
        /// <summary>Signed identity cookie name (distinct from the legacy raw je-spoiler-uid).</summary>
        public const string CookieName = "je-uid";

        // Reject a signature older than this. Long enough that a browser tab left
        // open for days still resolves, short enough that a leaked cookie ages
        // out. The value only disambiguates, so the window is generous.
        private static readonly TimeSpan MaxAge = TimeSpan.FromDays(30);

        /// <summary>
        /// Builds the cookie value for a user at <paramref name="issuedAtUtc"/>.
        /// Returns null when the secret is unusable (too short) or the user id is
        /// empty — the caller then simply does not set the cookie.
        /// </summary>
        public static string? Sign(Guid userId, string secret, DateTime issuedAtUtc)
        {
            if (userId == Guid.Empty) return null;
            var key = DeriveKey(secret);
            if (key == null) return null;

            var issuedUnix = ToUnixSeconds(issuedAtUtc);
            var payload = userId.ToString("N") + "." + issuedUnix.ToString(System.Globalization.CultureInfo.InvariantCulture);
            var sig = ComputeSignature(payload, key);
            return Base64Url(Encoding.ASCII.GetBytes(payload)) + "." + Base64Url(sig);
        }

        /// <summary>
        /// Verifies a cookie value against the secret and (optionally) the
        /// freshness window. Returns the named user on success, else null.
        /// Constant-time signature comparison; malformed input is rejected, never
        /// throws.
        /// </summary>
        public static Guid? Verify(string? cookieValue, string secret, DateTime nowUtc)
        {
            if (string.IsNullOrEmpty(cookieValue)) return null;
            var key = DeriveKey(secret);
            if (key == null) return null;

            var dot = cookieValue.IndexOf('.');
            if (dot <= 0 || dot >= cookieValue.Length - 1) return null;
            var payloadB64 = cookieValue.Substring(0, dot);
            var sigB64 = cookieValue.Substring(dot + 1);

            byte[] payloadBytes;
            byte[] providedSig;
            try
            {
                payloadBytes = FromBase64Url(payloadB64);
                providedSig = FromBase64Url(sigB64);
            }
            catch (FormatException)
            {
                return null;
            }
            if (payloadBytes.Length == 0 || providedSig.Length == 0) return null;

            var payload = Encoding.ASCII.GetString(payloadBytes);
            var expectedSig = ComputeSignature(payload, key);
            if (!CryptographicOperations.FixedTimeEquals(providedSig, expectedSig)) return null;

            // Signature valid — now parse and range-check the payload.
            var sep = payload.IndexOf('.');
            if (sep <= 0 || sep >= payload.Length - 1) return null;
            var uidPart = payload.Substring(0, sep);
            var tsPart = payload.Substring(sep + 1);
            if (!Guid.TryParseExact(uidPart, "N", out var userId) || userId == Guid.Empty) return null;
            if (!long.TryParse(tsPart, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var issuedUnix)) return null;

            var issuedAt = FromUnixSeconds(issuedUnix);
            var age = nowUtc - issuedAt;
            // Reject far-future timestamps (clock skew tolerance) and anything
            // past the max age.
            if (age > MaxAge) return null;
            if (age < TimeSpan.FromDays(-1)) return null;

            return userId;
        }

        /// <summary>Generates a fresh, high-entropy secret (base64url of 32 random bytes).</summary>
        public static string GenerateSecret()
        {
            var bytes = RandomNumberGenerator.GetBytes(32);
            return Base64Url(bytes);
        }

        // A usable key requires a non-trivial secret. We hash the secret string
        // to a fixed 32-byte key so any admin-entered length works, but reject
        // an empty/blank secret so an unconfigured deployment can't mint
        // trivially-forgeable cookies.
        private static byte[]? DeriveKey(string secret)
        {
            if (string.IsNullOrWhiteSpace(secret) || secret.Trim().Length < 16) return null;
            return SHA256.HashData(Encoding.UTF8.GetBytes(secret));
        }

        private static byte[] ComputeSignature(string payload, byte[] key)
        {
            using var hmac = new HMACSHA256(key);
            return hmac.ComputeHash(Encoding.ASCII.GetBytes(payload));
        }

        private static long ToUnixSeconds(DateTime utc)
            => (long)(DateTime.SpecifyKind(utc, DateTimeKind.Utc) - DateTime.UnixEpoch).TotalSeconds;

        private static DateTime FromUnixSeconds(long seconds)
            => DateTime.UnixEpoch.AddSeconds(seconds);

        private static string Base64Url(byte[] bytes)
            => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

        private static byte[] FromBase64Url(string value)
        {
            var s = value.Replace('-', '+').Replace('_', '/');
            switch (s.Length % 4)
            {
                case 2: s += "=="; break;
                case 3: s += "="; break;
                case 1: throw new FormatException("invalid base64url length");
            }
            return Convert.FromBase64String(s);
        }
    }
}
