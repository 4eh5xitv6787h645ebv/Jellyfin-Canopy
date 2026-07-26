using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Helpers
{
    public class ServiceUrlResolverTests
    {
        [Theory]
        [InlineData("http://sonarr:8989", true)]
        [InlineData("https://sonarr.example.com", true)]
        [InlineData("https://example.com/sonarr", true)]        // base-url/subpath
        [InlineData("  https://example.com/seerr  ", true)]     // trimmed
        [InlineData("http://[2001:db8::1]:5055", true)]         // IPv6 literal
        [InlineData("https://user:pass@example.com", false)]    // credentials would leak to every client
        [InlineData("https://user@example.com", false)]         // bare username userinfo too
        [InlineData("https://example.com/seerr?x=1", false)]    // query breaks path concatenation
        [InlineData("https://example.com/seerr#frag", false)]   // fragment breaks path concatenation
        [InlineData("", false)]
        [InlineData("   ", false)]
        [InlineData("sonarr.example.com", false)]               // no scheme
        [InlineData("ftp://example.com", false)]
        [InlineData("javascript:alert(1)", false)]
        [InlineData("file:///etc/passwd", false)]
        public void IsWellFormedHttpUrl_ClassifiesCorrectly(string? url, bool expected)
            => Assert.Equal(expected, ServiceUrlResolver.IsWellFormedHttpUrl(url));

        // Shared drift-guard matrix — the SAME accept/reject rows that
        // src/test/url-safe-cases.ts (LINK_BASE_CASES) runs against the two
        // client copies (isSafeLinkBase and config-page.js's jcIsHttpUrl). All
        // three validators must agree; if this server copy drifts, these rows
        // fail. Keep in lockstep with url-safe-cases.ts.
        [Theory]
        [InlineData("http://sonarr:8989", true)]            // plain http host:port
        [InlineData("https://sonarr.example.com", true)]    // plain https host
        [InlineData("https://example.com/sonarr", true)]    // subpath base
        [InlineData("http://[2001:db8::1]:5055", true)]     // IPv6 bracket literal
        [InlineData("HTTP://example.com", true)]            // uppercase scheme (normalized)
        [InlineData("https://example.com/", true)]          // trailing slash
        [InlineData("seerr.local:5055", false)]             // scheme-less host:port
        [InlineData("//example.com", false)]                // protocol-relative //host
        [InlineData("javascript:alert(1)", false)]          // javascript: scheme
        [InlineData("data:text/html,hi", false)]            // data: scheme
        [InlineData("file:///etc/passwd", false)]           // file: scheme
        [InlineData("ftp://example.com", false)]            // ftp: scheme
        [InlineData("https://user:pass@example.com", false)] // embedded credentials
        [InlineData("https://example.com/x?y=1", false)]    // query string
        [InlineData("https://example.com/x#frag", false)]   // fragment
        [InlineData("   ", false)]                          // whitespace-only
        public void IsWellFormedHttpUrl_SharedDriftMatrix(string? url, bool expected)
            => Assert.Equal(expected, ServiceUrlResolver.IsWellFormedHttpUrl(url));

        [Fact]
        public void ResolvePublicUrl_UsesExternalWhenWellFormed()
            => Assert.Equal("https://seerr.example.com",
                ServiceUrlResolver.ResolvePublicUrl("http://seerr:5055", "https://seerr.example.com"));

        [Fact]
        public void ResolvePublicUrl_TrimsExternal()
            => Assert.Equal("https://seerr.example.com",
                ServiceUrlResolver.ResolvePublicUrl("http://seerr:5055", "  https://seerr.example.com  "));

        [Theory]
        [InlineData(null)]
        [InlineData("")]
        [InlineData("   ")]
        [InlineData("not-a-url")]
        public void ResolvePublicUrl_FallsBackToInternalWhenExternalMissingOrMalformed(string? external)
            => Assert.Equal("http://seerr:5055",
                ServiceUrlResolver.ResolvePublicUrl("http://seerr:5055", external));

        [Fact]
        public void ResolvePublicUrl_PreservesInternalSubpath()
            => Assert.Equal("http://host/seerr",
                ServiceUrlResolver.ResolvePublicUrl("http://host/seerr", ""));

        [Theory]
        [InlineData("https://seerr.example.com", "https://seerr.example.com")]
        [InlineData("  https://seerr.example.com  ", "https://seerr.example.com")]
        [InlineData("garbage", "")]
        [InlineData("seerr.local:5055", "")]
        [InlineData("https://u:p@seerr.example.com", "")]
        [InlineData("https://seerr.example.com?x=1", "")]
        [InlineData("", "")]
        [InlineData(null, "")]
        public void SanitizeExternalUrl_KeepsWellFormedBlanksTheRest(string? input, string expected)
            => Assert.Equal(expected, ServiceUrlResolver.SanitizeExternalUrl(input));

        [Fact]
        public void SanitizeInstanceExternalUrlsJson_BlanksMalformedPerInstanceExternalUrls()
        {
            var json = """
                [
                  {"Name":"ok","Url":"http://sonarr:8989","ExternalUrl":"https://sonarr.example.com","ApiKey":"k","UrlMappings":"","Enabled":true},
                  {"Name":"bad","Url":"http://sonarr2:8989","ExternalUrl":"javascript:alert(1)","ApiKey":"k2","UrlMappings":"","Enabled":true}
                ]
                """;

            var dropped = new List<(string Name, string Value)>();
            var result = ServiceUrlResolver.SanitizeInstanceExternalUrlsJson(json, (n, v) => dropped.Add((n, v)));

            var instances = System.Text.Json.JsonSerializer
                .Deserialize<List<Jellyfin.Plugin.JellyfinCanopy.Model.Arr.ArrInstance>>(result)!;
            Assert.Equal("https://sonarr.example.com", instances[0].ExternalUrl);
            Assert.Equal(string.Empty, instances[1].ExternalUrl);
            // Api keys and every other field survive the rewrite.
            Assert.Equal("k2", instances[1].ApiKey);
            Assert.True(instances[1].Enabled);
            Assert.Equal(new[] { ("bad", "javascript:alert(1)") }, dropped.ToArray());
        }

        [Fact]
        public void SanitizeInstanceExternalUrlsJson_LeavesCleanJsonByteIdentical()
        {
            var json = """[{"Name":"ok","Url":"http://sonarr:8989","ExternalUrl":"","ApiKey":"k","UrlMappings":"","Enabled":true}]""";
            Assert.Same(json, ServiceUrlResolver.SanitizeInstanceExternalUrlsJson(json));
        }

        [Theory]
        [InlineData("")]
        [InlineData("   ")]
        [InlineData("[]junk-not-json")]
        public void SanitizeInstanceExternalUrlsJson_LeavesEmptyOrCorruptJsonUntouched(string json)
            => Assert.Equal(json, ServiceUrlResolver.SanitizeInstanceExternalUrlsJson(json));

        [Theory]
        [InlineData("HTTP://Example.COM:80/base/", "http://example.com/base")]
        [InlineData("https://example.com:443/maintainerr", "https://example.com/maintainerr")]
        [InlineData("http://[2001:db8::1]:6246/base/", "http://[2001:db8::1]:6246/base")]
        public void TryNormalizeHttpBaseUrl_CanonicalizesAuthorityAndPreservesBasePath(
            string input,
            string expected)
        {
            Assert.True(ServiceUrlResolver.TryNormalizeHttpBaseUrl(input, out var normalized));
            Assert.Equal(expected, normalized);
        }

        [Theory]
        [InlineData("http://example.com/base/../admin")]
        [InlineData("http://example.com/base/%2e%2e/admin")]
        [InlineData("http://example.com/base/%252e%252e/admin")]
        [InlineData("http://example.com/base/%2fadmin")]
        [InlineData("http://example.com/base/%252fadmin")]
        [InlineData("http://example.com/base/%5cadmin")]
        [InlineData("http://example.com/base/%255cadmin")]
        [InlineData("http://example.com/base/%")]
        [InlineData("http://user@example.com/base")]
        [InlineData("http://example.com/base?next=/admin")]
        [InlineData("http://example.com/base#admin")]
        public void TryNormalizeHttpBaseUrl_RejectsTraversalAndAmbiguousEscapes(string input)
            => Assert.False(ServiceUrlResolver.TryNormalizeHttpBaseUrl(input, out _));

        [Theory]
        [InlineData("/overview", "https://example.com/maintainerr/overview")]
        [InlineData("/collections/42/exclusions", "https://example.com/maintainerr/collections/42/exclusions")]
        public void JoinRelativePath_PreservesConfiguredBasePath(string path, string expected)
            => Assert.Equal(
                expected,
                ServiceUrlResolver.JoinRelativePath("https://example.com/maintainerr", path));

        [Theory]
        [InlineData("/collections/../admin")]
        [InlineData("/collections/%2e%2e/admin")]
        [InlineData("/collections/%252e%252e/admin")]
        [InlineData("/collections/%2fadmin")]
        [InlineData("/collections/%252fadmin")]
        [InlineData("/collections/%5cadmin")]
        [InlineData("/collections/%255cadmin")]
        [InlineData("//evil.example/overview")]
        public void JoinRelativePath_RejectsTraversalAtEveryEncodingLayer(string path)
            => Assert.Null(ServiceUrlResolver.JoinRelativePath("https://example.com/maintainerr", path));

        [Fact]
        public void JoinRelativePath_AcceptsNormalizedMaxAndRejectsJoinedMaxPlusOne()
        {
            const string prefix = "https://example.com/";
            const string relative = "/overview";
            var exactBase = prefix + new string(
                'a',
                ServiceUrlResolver.MaximumHttpUrlLength - prefix.Length - relative.Length);

            var exact = ServiceUrlResolver.JoinRelativePath(exactBase, relative);

            Assert.NotNull(exact);
            Assert.Equal(ServiceUrlResolver.MaximumHttpUrlLength, exact.Length);
            Assert.Null(ServiceUrlResolver.JoinRelativePath(exactBase + "a", relative));
        }

        [Fact]
        public void ResolveMappedPublicUrl_UsesExactCurrentJellyfinMappingBeforeFallbacks()
        {
            const string mappings = """
                https://jellyfin.example/base|https://maintainerr.example/public
                https://other.example|https://other-maintainerr.example
                """;

            Assert.Equal(
                "https://maintainerr.example/public",
                ServiceUrlResolver.ResolveMappedPublicUrl(
                    "http://127.0.0.1:6246/internal",
                    "https://maintainerr.example/fallback",
                    mappings,
                    "https://jellyfin.example/base/"));
        }

        [Fact]
        public void MaintainerrUrlAndMappingBounds_AcceptMaxAndRejectMaxPlusOne()
        {
            const string prefix = "https://example.com/";
            var maximumUrl = prefix + new string(
                'a',
                ServiceUrlResolver.MaximumHttpUrlLength - prefix.Length);
            Assert.True(ServiceUrlResolver.TryNormalizeHttpBaseUrl(maximumUrl, out _));
            Assert.False(ServiceUrlResolver.TryNormalizeHttpBaseUrl(maximumUrl + "a", out _));

            const string mapping = "https://jellyfin.example|https://maintainerr.example";
            var maximumMappings = mapping + new string(
                '\n',
                ServiceUrlResolver.MaximumUrlMappingsLength - mapping.Length);
            Assert.Equal(mapping, ServiceUrlResolver.SanitizeUrlMappings(maximumMappings));
            Assert.Equal(
                string.Empty,
                ServiceUrlResolver.SanitizeUrlMappings(maximumMappings + "x"));
        }

        [Fact]
        public void MaintainerrNormalizedUrlBound_AcceptsMaxAndRejectsUnicodeExpansionMaxPlusOne()
        {
            const string prefix = "https://example.com/";
            var maximumUrl = prefix + new string('\u00E9', 338);
            var maximumPlusOne = maximumUrl + "a";

            Assert.True(ServiceUrlResolver.TryNormalizeHttpBaseUrl(maximumUrl, out var normalized));
            Assert.Equal(ServiceUrlResolver.MaximumHttpUrlLength, normalized.Length);
            Assert.True(maximumUrl.Length < ServiceUrlResolver.MaximumHttpUrlLength);

            Assert.False(ServiceUrlResolver.TryNormalizeHttpBaseUrl(maximumPlusOne, out var rejected));
            Assert.Equal(string.Empty, rejected);
            Assert.True(maximumPlusOne.Length < ServiceUrlResolver.MaximumHttpUrlLength);
        }

        [Fact]
        public void MaintainerrNormalizedMappingBound_AcceptsMaxAndRejectsUnicodeExpansionMaxPlusOne()
        {
            const string targetPrefix = "https://m.example/";
            var fullTarget = targetPrefix + new string('\u00E9', 338) + "aa";
            var rows = Enumerable.Range(0, 31)
                .Select(index => $"https://j{index:D2}.example|{fullTarget}")
                .ToList();
            rows.Add(
                "https://j31.example|"
                + targetPrefix
                + new string('\u00E9', 226)
                + "aaa");
            var maximumMappings = string.Join('\n', rows);

            var normalized = ServiceUrlResolver.SanitizeUrlMappings(maximumMappings);

            Assert.True(maximumMappings.Length < ServiceUrlResolver.MaximumUrlMappingsLength);
            Assert.Equal(ServiceUrlResolver.MaximumUrlMappingsLength, normalized.Length);

            rows[^1] += "a";
            var maximumPlusOne = string.Join('\n', rows);
            Assert.True(maximumPlusOne.Length < ServiceUrlResolver.MaximumUrlMappingsLength);
            Assert.Equal(string.Empty, ServiceUrlResolver.SanitizeUrlMappings(maximumPlusOne));
        }
    }
}
