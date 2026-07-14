using System;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr
{
    /// <summary>
    /// Creates short-lived, caller-bound tokens for resources whose numeric or
    /// relative-path identity is local to one Seerr instance. The browser treats
    /// the token as opaque; the server authenticates it before selecting an
    /// upstream instance.
    /// </summary>
    internal static class SeerrSourceToken
    {
        internal const string RequestActionPurpose = "request-action";
        internal const string AvatarPurpose = "avatar";

        private const int Version = 3;
        private const int SignatureLength = 32;
        private const int SourceKeyLength = 32;
        private const int MaximumTokenLength = 8192;
        private const string SourceKeyDomain = "JellyfinCanopy:seerr-source:v1\0";
        private static readonly TimeSpan MaximumAge = TimeSpan.FromMinutes(30);
        private static readonly TimeSpan MaximumFutureSkew = TimeSpan.FromMinutes(2);
        private static readonly JsonSerializerOptions SerializerOptions = new()
        {
            DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        };

        internal sealed record Claims(
            string Purpose,
            string CallerId,
            string SourceKey,
            string Resource,
            string? Binding,
            DateTimeOffset IssuedAt);

        private sealed record Payload(
            [property: JsonPropertyName("v")] int Version,
            [property: JsonPropertyName("iat")] long IssuedAt,
            [property: JsonPropertyName("p")] string Purpose,
            [property: JsonPropertyName("u")] string CallerId,
            [property: JsonPropertyName("s")] string SourceKey,
            [property: JsonPropertyName("r")] string Resource,
            [property: JsonPropertyName("b")] string? Binding);

        public static string? Create(
            string? apiKey,
            string purpose,
            string callerId,
            string sourceUrl,
            string resource,
            DateTimeOffset? issuedAt = null,
            string? binding = null)
        {
            var normalizedCaller = NormalizeCallerId(callerId);
            var normalizedSource = NormalizeSourceUrl(sourceUrl);
            var normalizedBinding = string.Equals(
                purpose,
                RequestActionPurpose,
                StringComparison.Ordinal)
                ? NormalizePositiveInteger(binding)
                : null;
            if (string.IsNullOrWhiteSpace(apiKey)
                || string.IsNullOrWhiteSpace(purpose)
                || normalizedCaller == null
                || normalizedSource == null
                || string.IsNullOrEmpty(resource)
                || (string.Equals(purpose, RequestActionPurpose, StringComparison.Ordinal)
                    && normalizedBinding == null))
            {
                return null;
            }

            // Do not disclose an internal Seerr URL to the browser. The source
            // selector is an opaque, API-keyed fingerprint which remains stable
            // when the configured URL order changes and can only be matched
            // against a currently configured identity domain by the server.
            var sourceKey = ComputeSourceKey(apiKey, normalizedSource);

            var payload = new Payload(
                Version,
                (issuedAt ?? DateTimeOffset.UtcNow).ToUnixTimeSeconds(),
                purpose,
                normalizedCaller,
                sourceKey,
                resource,
                normalizedBinding);
            var payloadBytes = JsonSerializer.SerializeToUtf8Bytes(payload, SerializerOptions);
            var signature = Sign(payloadBytes, apiKey);
            return $"{Base64UrlEncode(payloadBytes)}.{Base64UrlEncode(signature)}";
        }

        public static bool TryValidate(
            string? token,
            string? apiKey,
            string expectedPurpose,
            string expectedCallerId,
            string expectedResource,
            out Claims? claims,
            DateTimeOffset? now = null)
        {
            claims = null;
            if (string.IsNullOrWhiteSpace(token)
                || token.Length > MaximumTokenLength
                || string.IsNullOrWhiteSpace(apiKey)
                || string.IsNullOrWhiteSpace(expectedPurpose)
                || string.IsNullOrEmpty(expectedResource))
            {
                return false;
            }

            var separator = token.IndexOf('.');
            if (separator <= 0
                || separator != token.LastIndexOf('.')
                || separator == token.Length - 1
                || !TryBase64UrlDecode(token[..separator], out var payloadBytes)
                || !TryBase64UrlDecode(token[(separator + 1)..], out var suppliedSignature)
                || suppliedSignature.Length != SignatureLength)
            {
                return false;
            }

            var expectedSignature = Sign(payloadBytes, apiKey);
            if (!CryptographicOperations.FixedTimeEquals(expectedSignature, suppliedSignature))
            {
                return false;
            }

            Payload? payload;
            try
            {
                payload = JsonSerializer.Deserialize<Payload>(payloadBytes, SerializerOptions);
            }
            catch (JsonException)
            {
                return false;
            }

            var normalizedCaller = NormalizeCallerId(expectedCallerId);
            var validSourceKey = TryDecodeSourceKey(payload?.SourceKey, out _);
            var normalizedBinding = string.Equals(
                payload?.Purpose,
                RequestActionPurpose,
                StringComparison.Ordinal)
                ? NormalizePositiveInteger(payload?.Binding)
                : null;
            if (payload == null
                || payload.Version != Version
                || normalizedCaller == null
                || !validSourceKey
                || !string.Equals(payload.Purpose, expectedPurpose, StringComparison.Ordinal)
                || !string.Equals(payload.CallerId, normalizedCaller, StringComparison.Ordinal)
                || !string.Equals(payload.Resource, expectedResource, StringComparison.Ordinal)
                || (string.Equals(payload.Purpose, RequestActionPurpose, StringComparison.Ordinal)
                    && (normalizedBinding == null
                        || !string.Equals(payload.Binding, normalizedBinding, StringComparison.Ordinal)))
                || (string.Equals(payload.Purpose, AvatarPurpose, StringComparison.Ordinal)
                    && payload.Binding != null))
            {
                return false;
            }

            DateTimeOffset issuedAt;
            try
            {
                issuedAt = DateTimeOffset.FromUnixTimeSeconds(payload.IssuedAt);
            }
            catch (ArgumentOutOfRangeException)
            {
                return false;
            }

            var validationTime = now ?? DateTimeOffset.UtcNow;
            if (issuedAt > validationTime + MaximumFutureSkew
                || validationTime - issuedAt > MaximumAge)
            {
                return false;
            }

            claims = new Claims(
                payload.Purpose,
                payload.CallerId,
                payload.SourceKey,
                payload.Resource,
                normalizedBinding,
                issuedAt);
            return true;
        }

        public static string? NormalizeSourceUrl(string? sourceUrl)
            => SeerrUrlIdentity.Normalize(sourceUrl);

        /// <summary>
        /// Matches an opaque token source selector against one currently
        /// configured Seerr identity domain without exposing that URL in the
        /// token itself.
        /// </summary>
        public static bool MatchesSource(string? sourceKey, string? apiKey, string? sourceUrl)
        {
            var normalizedSource = NormalizeSourceUrl(sourceUrl);
            if (string.IsNullOrWhiteSpace(apiKey)
                || normalizedSource == null
                || !TryDecodeSourceKey(sourceKey, out var suppliedKey))
            {
                return false;
            }

            var expectedKey = ComputeSourceKeyBytes(apiKey, normalizedSource);
            return CryptographicOperations.FixedTimeEquals(expectedKey, suppliedKey);
        }

        public static bool TryNormalizeAvatarPath(string? path, out string normalizedPath)
        {
            normalizedPath = string.Empty;
            if (string.IsNullOrWhiteSpace(path)) return false;

            var candidate = path.Trim();
            var query = candidate.IndexOf('?');
            var fragment = candidate.IndexOf('#');
            var suffix = query < 0 ? fragment : fragment < 0 ? query : Math.Min(query, fragment);
            if (suffix >= 0) candidate = candidate[..suffix];
            if (!candidate.StartsWith('/')) candidate = $"/{candidate}";

            string decoded;
            try
            {
                decoded = Uri.UnescapeDataString(candidate);
            }
            catch (UriFormatException)
            {
                return false;
            }

            if (candidate.Length > 2048
                || candidate.Contains("..", StringComparison.Ordinal)
                || decoded.Contains("..", StringComparison.Ordinal)
                || candidate.Contains("://", StringComparison.Ordinal)
                || candidate.Contains('@')
                || candidate.Contains('\\')
                || decoded.Contains('\\')
                || candidate.Contains('\r')
                || candidate.Contains('\n')
                || candidate.Contains('\0')
                || decoded.Contains('\r')
                || decoded.Contains('\n')
                || decoded.Contains('\0'))
            {
                return false;
            }

            if (!candidate.StartsWith("/avatar/", StringComparison.OrdinalIgnoreCase)
                && !candidate.StartsWith("/avatarproxy/", StringComparison.OrdinalIgnoreCase)
                && !candidate.StartsWith("/api/v1/avatar/", StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            normalizedPath = candidate;
            return true;
        }

        private static string? NormalizeCallerId(string? callerId)
        {
            if (string.IsNullOrWhiteSpace(callerId)) return null;
            return Guid.TryParse(callerId, out var parsed)
                ? parsed.ToString("N")
                : callerId.Trim().Replace("-", string.Empty, StringComparison.Ordinal).ToLowerInvariant();
        }

        private static string? NormalizePositiveInteger(string? value)
            => int.TryParse(
                    value,
                    System.Globalization.NumberStyles.None,
                    System.Globalization.CultureInfo.InvariantCulture,
                    out var parsed)
                && parsed > 0
                    ? parsed.ToString(System.Globalization.CultureInfo.InvariantCulture)
                    : null;

        private static byte[] Sign(byte[] payload, string apiKey)
        {
            using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(apiKey));
            return hmac.ComputeHash(payload);
        }

        private static string ComputeSourceKey(string apiKey, string normalizedSource)
            => Base64UrlEncode(ComputeSourceKeyBytes(apiKey, normalizedSource));

        private static byte[] ComputeSourceKeyBytes(string apiKey, string normalizedSource)
        {
            using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(apiKey));
            return hmac.ComputeHash(Encoding.UTF8.GetBytes(SourceKeyDomain + normalizedSource));
        }

        private static bool TryDecodeSourceKey(string? sourceKey, out byte[] decoded)
        {
            decoded = Array.Empty<byte>();
            return !string.IsNullOrEmpty(sourceKey)
                && TryBase64UrlDecode(sourceKey, out decoded)
                && decoded.Length == SourceKeyLength
                && string.Equals(Base64UrlEncode(decoded), sourceKey, StringComparison.Ordinal);
        }

        private static string Base64UrlEncode(byte[] value)
            => Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');

        private static bool TryBase64UrlDecode(string value, out byte[] decoded)
        {
            decoded = Array.Empty<byte>();
            if (string.IsNullOrEmpty(value)) return false;
            var padded = value.Replace('-', '+').Replace('_', '/');
            padded += (padded.Length % 4) switch
            {
                0 => string.Empty,
                2 => "==",
                3 => "=",
                _ => "!",
            };

            try
            {
                decoded = Convert.FromBase64String(padded);
                return true;
            }
            catch (FormatException)
            {
                return false;
            }
        }
    }
}
