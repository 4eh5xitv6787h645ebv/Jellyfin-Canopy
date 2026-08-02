using System;
using System.Collections.Immutable;
using System.Linq;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    public sealed class PlatformNativeCatalogContractTests
    {
        [Fact]
        public void ExactAndroidResolveBodyParsesAndNormalizesOnlyKnownCapabilities()
        {
            var request = ParseResolve("""
                {
                  "Protocol": 1,
                  "SurfaceSchema": 1,
                  "Item": { "Id": "11111111-2222-3333-4444-555555555555", "Future": true },
                  "Client": {
                    "ContributionKinds": ["status", "future", "action", "status"],
                    "FieldKinds": ["multi_select", "confirmation", "boolean", "single_select", "future"],
                    "InputModes": ["future", "dpad"],
                    "Accessibility": ["screen_reader", "future"],
                    "Locale": "en-AU",
                    "Future": { "Ignored": true }
                  },
                  "Future": "ignored"
                }
                """);

            Assert.Equal(1, request.Protocol);
            Assert.Equal(1, request.SurfaceSchema);
            Assert.Equal(Guid.Parse("11111111-2222-3333-4444-555555555555"), request.ItemId);
            Assert.Equal(new[] { "action", "status" }, request.Client.ContributionKinds);
            Assert.Equal(
                new[] { "boolean", "confirmation", "multi_select", "single_select" },
                request.Client.FieldKinds);
            Assert.Equal(new[] { "dpad" }, request.Client.InputModes);
            Assert.Equal(new[] { "screen_reader" }, request.Client.Accessibility);
            Assert.Equal("en-au", request.Client.Locale);
        }

        [Theory]
        [InlineData("\"Protocol\":1,\"Protocol\":1,\"SurfaceSchema\":1,\"Item\":{\"Id\":\"11111111-2222-3333-4444-555555555555\"},\"Client\":CLIENT")]
        [InlineData("\"Protocol\":1,\"SurfaceSchema\":1,\"Item\":{\"Id\":\"11111111-2222-3333-4444-555555555555\",\"Id\":\"11111111-2222-3333-4444-555555555555\"},\"Client\":CLIENT")]
        [InlineData("\"Protocol\":1,\"SurfaceSchema\":1,\"Item\":{\"Id\":\"11111111-2222-3333-4444-555555555555\"},\"Client\":{\"ContributionKinds\":[],\"ContributionKinds\":[],\"FieldKinds\":[],\"InputModes\":[],\"Accessibility\":[],\"Locale\":\"en\"}")]
        public void DuplicateKnownPropertiesFailClosed(string properties)
        {
            var client = "{\"ContributionKinds\":[],\"FieldKinds\":[],\"InputModes\":[],\"Accessibility\":[],\"Locale\":\"en\"}";
            Assert.Throws<JsonException>(() => ParseResolve("{" + properties.Replace("CLIENT", client, StringComparison.Ordinal) + "}"));
        }

        [Theory]
        [InlineData("{}")]
        [InlineData("{\"Protocol\":1,\"SurfaceSchema\":1,\"Item\":{\"Id\":\"11111111-2222-3333-4444-555555555555\"},\"Client\":{}}")]
        [InlineData("{\"Protocol\":1,\"SurfaceSchema\":1,\"Item\":{\"Id\":\"11111111-2222-3333-4444-555555555555\"},\"Client\":{\"ContributionKinds\":[],\"FieldKinds\":[],\"InputModes\":[],\"Accessibility\":[],\"Locale\":\"../../bad\"}}")]
        [InlineData("{\"Protocol\":1,\"SurfaceSchema\":1,\"Item\":{\"Id\":\"11111111-2222-3333-4444-555555555555\"},\"Client\":{\"ContributionKinds\":[null],\"FieldKinds\":[],\"InputModes\":[],\"Accessibility\":[],\"Locale\":\"en\"}}")]
        [InlineData("{\"Protocol\":1,\"SurfaceSchema\":1,\"Item\":{\"Id\":\"11111111-2222-3333-4444-555555555555\"},\"Client\":{\"ContributionKinds\":[],\"FieldKinds\":[],\"InputModes\":[],\"Accessibility\":[],\"Locale\":\"en\"}} trailing")]
        public void MalformedOrIncompleteResolveBodiesFailClosed(string json)
            => Assert.ThrowsAny<JsonException>(() => ParseResolve(json));

        [Fact]
        public void CapabilityArrayBoundHasAnExactNegativeBoundary()
        {
            var values = string.Join(',', Enumerable.Repeat("\"action\"", PlatformNativeCatalogBounds.MaximumCapabilityValues + 1));
            var json = $$"""
                {
                  "Protocol":1,
                  "SurfaceSchema":1,
                  "Item":{"Id":"11111111-2222-3333-4444-555555555555"},
                  "Client":{"ContributionKinds":[{{values}}],"FieldKinds":[],"InputModes":[],"Accessibility":[],"Locale":"en"}
                }
                """;

            Assert.Throws<JsonException>(() => ParseResolve(json));
        }

        [Fact]
        public void PrepareBodyAcceptsUnknownAdditionsButRejectsDuplicateAndOversizedHandles()
        {
            var parsed = ParsePrepare("{\"PrepareHandle\":\"opaque-handle\",\"Future\":true}");
            Assert.Equal("opaque-handle", parsed.PrepareHandle);

            Assert.Throws<JsonException>(() => ParsePrepare(
                "{\"PrepareHandle\":\"one\",\"PrepareHandle\":\"two\"}"));
            Assert.Throws<JsonException>(() => ParsePrepare(
                "{\"PrepareHandle\":\"" + new string('a', PlatformNativeCatalogBounds.MaximumOpaqueBytes + 1) + "\"}"));
            Assert.Throws<JsonException>(() => ParsePrepare("{\"prepareHandle\":\"wrong-case\"}"));
        }

        [Fact]
        public void ResolveResponseMatchesAndroidShapeAndOmitsInapplicableProperties()
        {
            var response = new PlatformItemDetailResolveResponse(
                "revision-7",
                [
                    PlatformNativeContribution.Action(
                        "action-1",
                        "Apply choice",
                        "A generic action",
                        "settings",
                        enabled: true,
                        "opaque-prepare-handle"),
                    PlatformNativeContribution.Status("status-1", "Ready", "positive"),
                ]);

            using var document = JsonDocument.Parse(JsonSerializer.SerializeToUtf8Bytes(
                response,
                PlatformJson.SerializerOptions));
            var root = document.RootElement;
            Assert.Equal("revision-7", root.GetProperty("CatalogRevision").GetString());
            var contributions = root.GetProperty("Contributions");
            Assert.Equal(2, contributions.GetArrayLength());
            var action = contributions[0];
            Assert.Equal("action", action.GetProperty("Kind").GetString());
            Assert.Equal("opaque-prepare-handle", action.GetProperty("PrepareHandle").GetString());
            Assert.False(action.TryGetProperty("Tone", out _));
            var status = contributions[1];
            Assert.Equal("status", status.GetProperty("Kind").GetString());
            Assert.Equal("positive", status.GetProperty("Tone").GetString());
            Assert.False(status.TryGetProperty("PrepareHandle", out _));
            Assert.False(status.TryGetProperty("Enabled", out _));
        }

        [Fact]
        public void PrepareResponseMatchesAllAndroidFieldDefaults()
        {
            var response = new PlatformActionPrepareResponse(
                "opaque-invoke-capability",
                DateTimeOffset.Parse("2026-08-03T00:00:00Z"),
                "Apply settings",
                "Apply",
                "Cancel",
                [
                    PlatformNativeField.Confirmation("confirm", "Continue?", null, true, false),
                    PlatformNativeField.Boolean("enabled", "Enabled", null, true, true),
                    PlatformNativeField.SingleSelect(
                        "scope",
                        "Scope",
                        null,
                        true,
                        [new PlatformNativeOption("global", "Everywhere")],
                        "global"),
                ]);

            using var document = JsonDocument.Parse(JsonSerializer.SerializeToUtf8Bytes(
                response,
                PlatformJson.SerializerOptions));
            var root = document.RootElement;
            Assert.Equal("opaque-invoke-capability", root.GetProperty("Capability").GetString());
            Assert.Equal("2026-08-03T00:00:00.0000000+00:00", root.GetProperty("ExpiresAtUtc").GetString());
            var fields = root.GetProperty("Fields");
            Assert.Equal(3, fields.GetArrayLength());
            Assert.Equal("confirmation", fields[0].GetProperty("Kind").GetString());
            Assert.Equal("boolean", fields[1].GetProperty("Kind").GetString());
            Assert.Equal("single_select", fields[2].GetProperty("Kind").GetString());
            Assert.Equal("global", fields[2].GetProperty("DefaultOptionIds")[0].GetString());
            Assert.False(fields[2].TryGetProperty("DefaultChecked", out _));
        }

        private static PlatformItemDetailResolveRequest ParseResolve(string json)
            => JsonSerializer.Deserialize<PlatformItemDetailResolveRequest>(json, PlatformJson.SerializerOptions)!;

        private static PlatformActionPrepareRequest ParsePrepare(string json)
            => JsonSerializer.Deserialize<PlatformActionPrepareRequest>(json, PlatformJson.SerializerOptions)!;
    }
}
