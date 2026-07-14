using System;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Helpers
{
    public class SeerrSourceTokenTests
    {
        private const string ApiKey = "secret-api-key";
        private const string Caller = "22222222-2222-2222-2222-222222222222";
        private const string Source = "http://seerr-b:5055/Tenant";
        private static readonly DateTimeOffset Now = DateTimeOffset.FromUnixTimeSeconds(1_800_000_000);

        [Fact]
        public void RoundTrip_NormalizesCallerAndSource_AndAuthenticatesClaims()
        {
            var token = SeerrSourceToken.Create(
                ApiKey,
                SeerrSourceToken.RequestActionPurpose,
                Caller,
                $"  {Source}/ ",
                "91",
                Now,
                binding: "007");

            Assert.NotNull(token);
            Assert.True(SeerrSourceToken.TryValidate(
                token,
                ApiKey,
                SeerrSourceToken.RequestActionPurpose,
                Caller.Replace("-", string.Empty, StringComparison.Ordinal).ToUpperInvariant(),
                "91",
                out var claims,
                Now.AddMinutes(10)));
            Assert.True(SeerrSourceToken.MatchesSource(claims!.SourceKey, ApiKey, Source));
            Assert.False(SeerrSourceToken.MatchesSource(claims.SourceKey, ApiKey, "http://seerr-a:5055"));
            Assert.Equal("22222222222222222222222222222222", claims.CallerId);
            Assert.Equal("91", claims.Resource);
            Assert.Equal("7", claims.Binding);
        }

        [Fact]
        public void TokenPayload_ContainsOpaqueSourceKey_NotInternalUrl()
        {
            var token = SeerrSourceToken.Create(
                ApiKey,
                SeerrSourceToken.AvatarPurpose,
                Caller,
                Source,
                "/avatar/user.png",
                Now)!;
            var encodedPayload = token.Split('.')[0]
                .Replace("-", "+", StringComparison.Ordinal)
                .Replace("_", "/", StringComparison.Ordinal);
            encodedPayload += new string('=', (4 - (encodedPayload.Length % 4)) % 4);
            var payloadJson = Encoding.UTF8.GetString(Convert.FromBase64String(encodedPayload));
            using var payload = JsonDocument.Parse(payloadJson);

            Assert.DoesNotContain(Source, payloadJson, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("seerr-b", payloadJson, StringComparison.OrdinalIgnoreCase);
            var sourceKey = payload.RootElement.GetProperty("s").GetString();
            Assert.NotNull(sourceKey);
            Assert.True(SeerrSourceToken.MatchesSource(sourceKey, ApiKey, Source));
        }

        [Theory]
        [InlineData("wrong-key", SeerrSourceToken.RequestActionPurpose, Caller, "91")]
        [InlineData(ApiKey, "avatar", Caller, "91")]
        [InlineData(ApiKey, SeerrSourceToken.RequestActionPurpose, "33333333-3333-3333-3333-333333333333", "91")]
        [InlineData(ApiKey, SeerrSourceToken.RequestActionPurpose, Caller, "92")]
        public void Validation_RejectsWrongKeyPurposeCallerOrResource(
            string key,
            string purpose,
            string caller,
            string resource)
        {
            var token = SeerrSourceToken.Create(
                ApiKey,
                SeerrSourceToken.RequestActionPurpose,
                Caller,
                Source,
                "91",
                Now,
                binding: "7");

            Assert.False(SeerrSourceToken.TryValidate(
                token,
                key,
                purpose,
                caller,
                resource,
                out _,
                Now));
        }

        [Fact]
        public void Validation_RejectsTamperingExpiryAndExcessiveFutureTimestamp()
        {
            var token = SeerrSourceToken.Create(
                ApiKey,
                SeerrSourceToken.AvatarPurpose,
                Caller,
                Source,
                "/avatar/user.png",
                Now)!;
            var tampered = $"{(token[0] == 'A' ? 'B' : 'A')}{token[1..]}";

            Assert.False(SeerrSourceToken.TryValidate(
                tampered,
                ApiKey,
                SeerrSourceToken.AvatarPurpose,
                Caller,
                "/avatar/user.png",
                out _,
                Now));
            Assert.False(SeerrSourceToken.TryValidate(
                token,
                ApiKey,
                SeerrSourceToken.AvatarPurpose,
                Caller,
                "/avatar/user.png",
                out _,
                Now.AddMinutes(31)));

            var futureToken = SeerrSourceToken.Create(
                ApiKey,
                SeerrSourceToken.AvatarPurpose,
                Caller,
                Source,
                "/avatar/user.png",
                Now.AddMinutes(3));
            Assert.False(SeerrSourceToken.TryValidate(
                futureToken,
                ApiKey,
                SeerrSourceToken.AvatarPurpose,
                Caller,
                "/avatar/user.png",
                out _,
                Now));
        }

        [Theory]
        [InlineData("avatar/user.png?v=1", "/avatar/user.png")]
        [InlineData("/avatarproxy/user.jpg#fragment", "/avatarproxy/user.jpg")]
        [InlineData("/api/v1/avatar/user.webp", "/api/v1/avatar/user.webp")]
        public void AvatarPath_NormalizesAllowedPrefixes(string input, string expected)
        {
            Assert.True(SeerrSourceToken.TryNormalizeAvatarPath(input, out var normalized));
            Assert.Equal(expected, normalized);
        }

        [Theory]
        [InlineData("/api/v1/status")]
        [InlineData("/avatar/../settings")]
        [InlineData("/avatar/%2e%2e/settings")]
        [InlineData("/avatar\\..\\settings")]
        public void AvatarPath_RejectsUnsafeOrUnapprovedPaths(string input)
            => Assert.False(SeerrSourceToken.TryNormalizeAvatarPath(input, out _));
    }
}
