using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

public sealed class PlatformExtensionManifestTests
{
    private const string Items = "jellyfin.canopy.items.lookup";
    private const string UserData = "jellyfin.canopy.user-data.read";
    private const string Storage = "jellyfin.canopy.storage.read";
    private const string Ui = "jellyfin.canopy.ui.contribute";
    private const string Integrations = "jellyfin.canopy.integrations.invoke";
    private const string RequestSchemaSha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string ResponseSchemaSha256 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    private static readonly string[] ProviderCapabilities =
    [
        Items,
        UserData,
        Storage,
        Ui,
        Integrations,
    ];

    [Fact]
    public void GoldenManifestParsesIntoTheExactCanonicalImmutableModel()
    {
        var manifest = Parse(ManifestBytes(
            capabilities: ProviderCapabilities.Reverse().ToArray()));

        Assert.Equal(1, manifest.SchemaVersion);
        Assert.Equal("org.example.media-tools", manifest.Id);
        Assert.Equal(Guid.Parse("11111111-2222-3333-4444-555555555555"), manifest.PluginId);
        Assert.Equal(new Version(1, 2, 3, 4), manifest.Version);
        Assert.Equal(PlatformActorKind.InstalledProvider, manifest.Kind);
        Assert.Equal("Example Provider", manifest.DisplayName);
        Assert.Equal("A bounded installed-provider fixture.", manifest.Description);
        Assert.Equal(1, manifest.PlatformRange.Min);
        Assert.Equal(1, manifest.PlatformRange.Max);
        Assert.Equal(12, manifest.HostRange.MinMajor);
        Assert.Equal(12, manifest.HostRange.MaxMajor);
        Assert.Equal(
            ProviderCapabilities,
            manifest.RequestedCapabilities.Capabilities.Select(value => value.Id.Value));
        Assert.Matches("^[0-9a-f]{64}$", manifest.Fingerprint.Value);
        Assert.Equal("9095ca0868174f31ea74f435713e11fa14a64a8322395cff9a516e757f54695c",
            manifest.Fingerprint.Value);
        Assert.Equal(IndependentFingerprint(manifest), manifest.Fingerprint.Value);
    }

    [Fact]
    public void RuntimeBoundsPinTheReviewedV1Limits()
    {
        Assert.Equal(256 * 1024, PlatformExtensionManifestBounds.MaximumDocumentBytes);
        Assert.Equal(16, PlatformExtensionManifestBounds.MaximumJsonDepth);
        Assert.Equal(128, PlatformExtensionManifestBounds.MaximumIdBytes);
        Assert.Equal(64, PlatformExtensionManifestBounds.MaximumVersionBytes);
        Assert.Equal(96, PlatformExtensionManifestBounds.MaximumDisplayNameBytes);
        Assert.Equal(512, PlatformExtensionManifestBounds.MaximumDescriptionBytes);
        Assert.Equal(65535, PlatformExtensionManifestBounds.MaximumCompatibilityMajor);
        Assert.Equal(64, PlatformExtensionManifestParser.MaximumIdentifierSegmentLength);
        Assert.Equal("jellyfin-canopy-extension.json", PlatformExtensionManifestParser.ManifestFileName);
        Assert.Equal("urn:jellyfin-canopy:platform:v1:extension-manifest", PlatformExtensionManifestParser.SchemaId);
        Assert.Equal(1, PlatformExtensionManifestParser.SchemaVersion);
        Assert.Equal("sha-256", PlatformExtensionManifestParser.FingerprintAlgorithm);
        Assert.Equal("jellyfin-canopy-extension-manifest-v1", PlatformExtensionManifestParser.FingerprintDomain);
        Assert.Equal(
            PlatformCapabilityVocabulary.MaximumCapabilityCount,
            PlatformExtensionManifestBounds.MaximumRequestedCapabilities);
        Assert.Equal(16, PlatformExtensionManifestBounds.MaximumProviderOperations);
        Assert.Equal(128, PlatformExtensionManifestBounds.MaximumProviderOperationIdBytes);
        Assert.Equal(5, PlatformExtensionManifestBounds.MaximumProviderRequiredCapabilities);
        Assert.Equal(308, PlatformExtensionManifestBounds.MaximumProviderSchemaIdBytes);
        Assert.Equal(65535, PlatformExtensionManifestBounds.MaximumProviderSchemaMajor);
    }

    [Fact]
    public void ExactDocumentAndJsonDepthBoundsAreDistinguishedFromOverBoundInputs()
    {
        var ordinary = ManifestBytes();
        var exact = new byte[PlatformExtensionManifestBounds.MaximumDocumentBytes];
        ordinary.CopyTo(exact, 0);
        exact.AsSpan(ordinary.Length).Fill((byte)' ');

        Assert.NotNull(Parse(exact));
        Assert.NotEqual(
            default,
            Reject(exact.Concat(new byte[] { (byte)' ' }).ToArray()));

        var atDepth = Encoding.UTF8.GetBytes(
            new string('[', PlatformExtensionManifestBounds.MaximumJsonDepth)
            + "0"
            + new string(']', PlatformExtensionManifestBounds.MaximumJsonDepth));
        var overDepth = Encoding.UTF8.GetBytes(
            new string('[', PlatformExtensionManifestBounds.MaximumJsonDepth + 1)
            + "0"
            + new string(']', PlatformExtensionManifestBounds.MaximumJsonDepth + 1));

        var atDepthReason = Reject(atDepth);
        var overDepthReason = Reject(overDepth);
        Assert.Equal(PlatformExtensionManifestRejectionReason.InvalidPropertyType, atDepthReason);
        Assert.Equal(PlatformExtensionManifestRejectionReason.InvalidJson, overDepthReason);
    }

    [Fact]
    public void ExactStringAndRangeBoundariesParseAndEveryNextValueFails()
    {
        var exactId = new string('a', 31) + "." + new string('b', 32) + "." + new string('c', 63);
        var overlongId = new string('a', 32) + "." + new string('b', 32) + "." + new string('c', 63);
        Assert.Equal(128, Encoding.ASCII.GetByteCount(exactId));
        Assert.Equal(exactId, Parse(ManifestBytes(id: exactId)).Id);
        Assert.Equal(129, Encoding.ASCII.GetByteCount(overlongId));
        Reject(ManifestBytes(id: overlongId));

        var exactSegment = "a.b." + new string('c', PlatformExtensionManifestParser.MaximumIdentifierSegmentLength);
        Assert.Equal(exactSegment, Parse(ManifestBytes(id: exactSegment)).Id);
        Reject(ManifestBytes(id: exactSegment + "c"));

        var exactDisplayName = new string('\u00e9', 48);
        Assert.Equal(96, Encoding.UTF8.GetByteCount(exactDisplayName));
        Assert.Equal(exactDisplayName, Parse(ManifestBytes(displayName: exactDisplayName)).DisplayName);
        Reject(ManifestBytes(displayName: exactDisplayName + "a"));

        var exactDescription = new string('\u00e9', 256);
        Assert.Equal(512, Encoding.UTF8.GetByteCount(exactDescription));
        Assert.Equal(exactDescription, Parse(ManifestBytes(description: exactDescription)).Description);
        Reject(ManifestBytes(description: exactDescription + "a"));

        var maximumVersion = string.Join('.', Enumerable.Repeat(int.MaxValue.ToString(CultureInfo.InvariantCulture), 4));
        Assert.True(Encoding.ASCII.GetByteCount(maximumVersion) <= PlatformExtensionManifestBounds.MaximumVersionBytes);
        Assert.Equal(new Version(int.MaxValue, int.MaxValue, int.MaxValue, int.MaxValue),
            Parse(ManifestBytes(version: maximumVersion)).Version);
        Reject(ManifestBytes(version: new string('1', PlatformExtensionManifestBounds.MaximumVersionBytes + 1)));

        var maximum = PlatformExtensionManifestBounds.MaximumCompatibilityMajor;
        var ranges = Parse(ManifestBytes(platformMin: maximum, platformMax: maximum, hostMin: maximum, hostMax: maximum));
        Assert.Equal(maximum, ranges.PlatformRange.Max);
        Assert.Equal(maximum, ranges.HostRange.MaxMajor);
        Reject(ManifestBytes(platformMax: maximum + 1));
        Reject(ManifestBytes(hostMax: maximum + 1));
    }

    [Fact]
    public void DescriptionIsOptionalAndRequestedCapabilitiesMayBeEmptyOrAllProviderEligible()
    {
        var absentDescription = Parse(ManifestBytes(description: null));
        Assert.Null(absentDescription.Description);
        Assert.Empty(Parse(ManifestBytes(capabilities: Array.Empty<string>()))
            .RequestedCapabilities.Capabilities);
        Assert.Equal(
            ProviderCapabilities,
            Parse(ManifestBytes(capabilities: ProviderCapabilities)).RequestedCapabilities.Capabilities
                .Select(value => value.Id.Value));
    }

    [Fact]
    public void IdentityOnlyManifestsRemainValidNonCallableAndFingerprintCompatible()
    {
        var absent = Parse(ManifestBytes());
        var empty = Parse(ManifestBytes(providerOperationsJson: "[]"));

        Assert.Empty(absent.ProviderOperations);
        Assert.Empty(empty.ProviderOperations);
        Assert.Equal(IndependentFingerprint(absent), absent.Fingerprint.Value);
        Assert.Equal(absent.Fingerprint.Value, empty.Fingerprint.Value);
    }

    [Fact]
    public void ProviderOperationsParseIntoCanonicalImmutableDeclarations()
    {
        var first = "org.example.provider.alpha";
        var second = "org.example.provider.zeta";
        var manifest = Parse(ManifestBytes(
            platformMax: 2,
            capabilities: new[] { Storage, Items },
            providerOperationsJson: "["
                + OperationJson(second, 2, 2, new[] { Storage }) + ","
                + OperationJson(first, 1, 2, new[] { Items, Storage }) + "]"));

        Assert.Equal(new[] { first, second }, manifest.ProviderOperations.Select(operation => operation.Id));
        var alpha = manifest.ProviderOperations[0];
        Assert.Equal((1, 2), (alpha.ProtocolRange.Min, alpha.ProtocolRange.Max));
        Assert.Equal(
            new[] { Items, Storage },
            alpha.RequiredCapabilities.Capabilities.Select(capability => capability.Id.Value));
        Assert.Equal(OwnedSchemaId("org.example.media-tools", first, "request", 1), alpha.RequestSchemaId);
        Assert.Equal(RequestSchemaSha256, alpha.RequestSchemaSha256);
        Assert.Equal(OwnedSchemaId("org.example.media-tools", first, "response", 1), alpha.ResponseSchemaId);
        Assert.Equal(ResponseSchemaSha256, alpha.ResponseSchemaSha256);
        Assert.Equal(IndependentFingerprint(manifest), manifest.Fingerprint.Value);
    }

    [Fact]
    public void ProviderOperationCountIdentifierCapabilityAndSchemaBoundsFailClosedAtNextValue()
    {
        var exactOperations = Enumerable.Range(0, PlatformExtensionManifestBounds.MaximumProviderOperations)
            .Select(index => OperationJson("org.example.operation" + index, 1, 1, Array.Empty<string>()))
            .ToArray();
        Assert.Equal(
            PlatformExtensionManifestBounds.MaximumProviderOperations,
            Parse(ManifestBytes(providerOperationsJson: "[" + string.Join(',', exactOperations) + "]"))
                .ProviderOperations.Length);
        Assert.Equal(
            PlatformExtensionManifestRejectionReason.InvalidProviderOperations,
            Reject(ManifestBytes(providerOperationsJson: "["
                + string.Join(',', exactOperations.Append(OperationJson(
                    "org.example.operation-over",
                    1,
                    1,
                    Array.Empty<string>()))) + "]")));

        var exactExtensionId = new string('a', 31) + "." + new string('b', 32) + "." + new string('c', 63);
        var exactOperationId = "a.b." + new string('c', 124);
        var exact = Parse(ManifestBytes(
            id: exactExtensionId,
            capabilities: ProviderCapabilities,
            providerOperationsJson: "[" + OperationJson(
                exactOperationId,
                1,
                1,
                ProviderCapabilities,
                schemaMajor: PlatformExtensionManifestBounds.MaximumProviderSchemaMajor,
                extensionId: exactExtensionId) + "]"));
        Assert.Equal(PlatformExtensionManifestBounds.MaximumProviderOperationIdBytes,
            Encoding.ASCII.GetByteCount(exact.ProviderOperations[0].Id));
        Assert.Equal(PlatformExtensionManifestBounds.MaximumProviderSchemaIdBytes,
            Encoding.ASCII.GetByteCount(exact.ProviderOperations[0].ResponseSchemaId));

        Reject(ManifestBytes(providerOperationsJson: "[" + OperationJson(
            exactOperationId + "d",
            1,
            1,
            Array.Empty<string>()) + "]"));
        Assert.Equal(
            PlatformExtensionManifestRejectionReason.InvalidProviderOperationCapabilities,
            Reject(ManifestBytes(
                capabilities: ProviderCapabilities,
                providerOperationsJson: "[" + OperationJson(
                    "org.example.too-many-capabilities",
                    1,
                    1,
                    ProviderCapabilities.Append(Items).ToArray()) + "]")));
        Assert.Equal(
            PlatformExtensionManifestRejectionReason.InvalidProviderSchemaReference,
            Reject(ManifestBytes(
                id: exactExtensionId,
                providerOperationsJson: "[" + OperationJson(
                    exactOperationId,
                    1,
                    1,
                    Array.Empty<string>(),
                    PlatformExtensionManifestBounds.MaximumProviderSchemaMajor + 1,
                    exactExtensionId) + "]")));
    }

    [Fact]
    public void ProviderDeclarationsRejectDuplicatesUnknownsIncompatibleRangesAndOverCapability()
    {
        const string operationId = "org.example.provider.hello";
        var declaration = OperationJson(operationId, 1, 1, new[] { Items });
        Assert.Equal(
            PlatformExtensionManifestRejectionReason.DuplicateProviderOperation,
            Reject(ManifestBytes(
                capabilities: new[] { Items },
                providerOperationsJson: "[" + declaration + "," + declaration + "]")));
        Assert.Equal(
            PlatformExtensionManifestRejectionReason.IncompatibleProviderOperation,
            Reject(ManifestBytes(providerOperationsJson: "["
                + OperationJson(operationId, 2, 2, Array.Empty<string>()) + "]")));
        Assert.Equal(
            PlatformExtensionManifestRejectionReason.InvalidProviderOperationCapabilities,
            Reject(ManifestBytes(
                capabilities: Array.Empty<string>(),
                providerOperationsJson: "[" + declaration + "]")));
        Assert.Equal(
            PlatformExtensionManifestRejectionReason.InvalidProviderSchemaReference,
            Reject(ManifestBytes(providerOperationsJson: "[" + OperationJson(
                operationId,
                1,
                1,
                Array.Empty<string>(),
                requestSchemaId: "https://example.invalid/request.json") + "]")));
        Assert.Equal(
            PlatformExtensionManifestRejectionReason.InvalidProviderSchemaReference,
            Reject(ManifestBytes(providerOperationsJson: "[" + OperationJson(
                operationId,
                1,
                1,
                Array.Empty<string>(),
                requestSchemaSha256: RequestSchemaSha256.ToUpperInvariant()) + "]")));
        Assert.Equal(
            PlatformExtensionManifestRejectionReason.InvalidProviderSchemaReference,
            Reject(ManifestBytes(providerOperationsJson: "[" + OperationJson(
                operationId,
                1,
                1,
                Array.Empty<string>(),
                responseSchemaSha256: ResponseSchemaSha256[..^1]) + "]")));

        var unknown = JsonNode.Parse(declaration)!.AsObject();
        unknown["type"] = "Foreign.Entrypoint";
        Assert.Equal(
            PlatformExtensionManifestRejectionReason.UnknownProperty,
            Reject(ManifestBytes(providerOperationsJson: "[" + unknown.ToJsonString() + "]")));
    }

    [Fact]
    public void ProviderFingerprintIsOrderIndependentAndChangesForEverySemanticDeclarationField()
    {
        const string alpha = "org.example.provider.alpha";
        const string zeta = "org.example.provider.zeta";
        var baseline = Parse(ManifestBytes(
            platformMax: 2,
            capabilities: new[] { Items, Storage },
            providerOperationsJson: "["
                + OperationJson(zeta, 1, 2, new[] { Storage }) + ","
                + OperationJson(alpha, 1, 1, new[] { Storage, Items }) + "]"));
        var reordered = Parse(ManifestBytes(
            platformMax: 2,
            capabilities: new[] { Storage, Items },
            providerOperationsJson: "["
                + OperationJson(alpha, 1, 1, new[] { Items, Storage }) + ","
                + OperationJson(zeta, 1, 2, new[] { Storage }) + "]"));
        Assert.Equal(baseline.Fingerprint.Value, reordered.Fingerprint.Value);

        var mutations = new[]
        {
            OperationJson("org.example.provider.changed", 1, 1, new[] { Items, Storage }),
            OperationJson(alpha, 1, 2, new[] { Items, Storage }),
            OperationJson(alpha, 1, 1, new[] { Items }),
            OperationJson(alpha, 1, 1, new[] { Items, Storage }, schemaMajor: 2),
            OperationJson(alpha, 1, 1, new[] { Items, Storage }, responseSchemaMajor: 2),
            OperationJson(alpha, 1, 1, new[] { Items, Storage }, requestSchemaSha256: new string('c', 64)),
            OperationJson(alpha, 1, 1, new[] { Items, Storage }, responseSchemaSha256: new string('d', 64)),
        };
        Assert.All(mutations, operation => Assert.NotEqual(
            baseline.Fingerprint.Value,
            Parse(ManifestBytes(
                platformMax: 2,
                capabilities: new[] { Items, Storage },
                providerOperationsJson: "[" + operation + ","
                    + OperationJson(zeta, 1, 2, new[] { Storage }) + "]"))
                .Fingerprint.Value));
    }

    [Theory]
    [InlineData("ab")]
    [InlineData("A.b.c")]
    [InlineData("a.B.c")]
    [InlineData("a.b.1c")]
    [InlineData("a.b.-c")]
    [InlineData("a.b.c-")]
    [InlineData("a.b.c--d")]
    [InlineData("a.b.c_d")]
    [InlineData("a.b.c*d")]
    [InlineData("a.b.caf\u00e9")]
    public void NonCanonicalExtensionIdsFailClosed(string id) => Reject(ManifestBytes(id: id));

    [Theory]
    [InlineData("a.b")]
    [InlineData("vendor.extension2")]
    [InlineData("vendor-name.extension-name")]
    public void CanonicalTwoOrMoreSegmentExtensionIdsParse(string id) =>
        Assert.Equal(id, Parse(ManifestBytes(id: id)).Id);

    [Theory]
    [InlineData(" Example Provider")]
    [InlineData("Example Provider ")]
    [InlineData("Example\u0001Provider")]
    [InlineData("Example\u200bProvider")]
    public void NonCanonicalDisplayMetadataFailsClosed(string displayName) =>
        Reject(ManifestBytes(displayName: displayName));

    [Theory]
    [InlineData("11111111222233334444555555555555")]
    [InlineData("11111111-2222-3333-4444-55555555555A")]
    [InlineData("{11111111-2222-3333-4444-555555555555}")]
    [InlineData("00000000-0000-0000-0000-000000000000")]
    [InlineData("not-a-guid")]
    public void NonCanonicalOrEmptyPluginIdsFailClosed(string pluginId) =>
        Reject(ManifestBytes(pluginId: pluginId));

    [Theory]
    [InlineData("1")]
    [InlineData("1.2.3.4.5")]
    [InlineData("01.2")]
    [InlineData("1.02")]
    [InlineData("+1.2")]
    [InlineData("1.2-alpha")]
    [InlineData("1.2 ")]
    [InlineData("1.\u0662")]
    public void NonCanonicalSystemVersionsFailClosed(string version) => Reject(ManifestBytes(version: version));

    [Fact]
    public void SystemVersionComponentsAcceptInt32MaximumAndRejectTheNextValue()
    {
        Assert.Equal(
            new Version(int.MaxValue, int.MaxValue, int.MaxValue, int.MaxValue),
            Parse(ManifestBytes(version: "2147483647.2147483647.2147483647.2147483647")).Version);
        Reject(ManifestBytes(version: "2147483648.1"));
        Reject(ManifestBytes(version: "9999999999.1"));
    }

    [Theory]
    [InlineData(0, 1, 12, 12)]
    [InlineData(2, 1, 12, 12)]
    [InlineData(1, 1, 0, 12)]
    [InlineData(1, 1, 13, 12)]
    public void ZeroOrDescendingCompatibilityRangesFailClosed(
        int platformMin,
        int platformMax,
        int hostMin,
        int hostMax) => Reject(ManifestBytes(
            platformMin: platformMin,
            platformMax: platformMax,
            hostMin: hostMin,
            hostMax: hostMax));

    [Theory]
    [InlineData("jellyfin.canopy.discovery.read")]
    [InlineData("jellyfin.canopy.events.subscribe")]
    [InlineData("jellyfin.canopy.administration.manage")]
    [InlineData("jellyfin.canopy.diagnostics.read")]
    public void CapabilitiesOutsideTheInstalledProviderActorCeilingFailClosed(string capability) =>
        Reject(ManifestBytes(capabilities: new[] { capability }));

    [Theory]
    [InlineData("jellyfin.canopy.unknown.read")]
    [InlineData("JELLYFIN.CANOPY.ITEMS.LOOKUP")]
    [InlineData("jellyfin.canopy.items.*")]
    [InlineData("jellyfin.canopy.items")]
    [InlineData("jellyfin.canopy.items.lookup ")]
    public void UnknownCaseVariantWildcardAndMalformedCapabilitiesFailClosed(string capability) =>
        Reject(ManifestBytes(capabilities: new[] { capability }));

    [Fact]
    public void DuplicateAndOverBoundCapabilityArraysFailClosed()
    {
        Reject(ManifestBytes(capabilities: new[] { Items, Items }));
        Reject(ManifestBytes(capabilities: Enumerable.Repeat(
            Items,
            PlatformExtensionManifestBounds.MaximumRequestedCapabilities + 1).ToArray()));
    }

    [Theory]
    [InlineData("grantedCapabilities", "[]")]
    [InlineData("effectiveCapabilities", "[]")]
    [InlineData("approved", "true")]
    [InlineData("enabled", "true")]
    [InlineData("credential", "\"secret\"")]
    [InlineData("secret", "\"secret\"")]
    [InlineData("path", "\"provider.dll\"")]
    [InlineData("url", "\"https://example.invalid\"")]
    [InlineData("assembly", "\"Provider\"")]
    [InlineData("type", "\"Provider.Entry\"")]
    [InlineData("method", "\"Invoke\"")]
    [InlineData("script", "\"run()\"")]
    [InlineData("operations", "[]")]
    [InlineData("contributions", "[]")]
    [InlineData("assets", "[]")]
    public void UnknownAndAuthorityOrExecutionShapedPropertiesFailClosed(string property, string value) =>
        Reject(AddRootProperty(ManifestBytes(), property, value));

    [Fact]
    public void BomInvalidUtf8CommentsTrailingCommasAndTrailingDataFailClosed()
    {
        Reject(new byte[] { 0xEF, 0xBB, 0xBF }.Concat(ManifestBytes()).ToArray());
        Reject(new byte[] { (byte)'{', (byte)'"', 0xFF, (byte)'"', (byte)':', (byte)'1', (byte)'}' });
        Reject(Encoding.UTF8.GetBytes("/* comment */" + Encoding.UTF8.GetString(ManifestBytes())));
        Reject(Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(ManifestBytes()).Replace(
            "}",
            ",}",
            StringComparison.Ordinal)));
        Reject(ManifestBytes().Concat(Encoding.UTF8.GetBytes("{}")).ToArray());
    }

    [Fact]
    public void MissingNullWrongTypeCaseVariantAndDuplicatePropertiesFailClosed()
    {
        Reject(null);
        Reject(Array.Empty<byte>());
        Reject(Encoding.UTF8.GetBytes("null"));
        Reject(Encoding.UTF8.GetBytes("[]"));
        Reject(Encoding.UTF8.GetBytes("{}"));

        foreach (var property in new[]
        {
            "schemaVersion",
            "id",
            "pluginId",
            "version",
            "kind",
            "displayName",
            "platform",
            "host",
            "requestedCapabilities",
        })
        {
            Reject(RemoveRootProperty(ManifestBytes(), property));
        }

        foreach (var invalid in new[]
        {
            Replace(ManifestBytes(), "\"schemaVersion\":1", "\"schemaVersion\":\"1\""),
            Replace(ManifestBytes(), "\"id\":\"org.example.media-tools\"", "\"id\":null"),
            Replace(ManifestBytes(), "\"pluginId\":\"11111111-2222-3333-4444-555555555555\"", "\"pluginId\":1"),
            Replace(ManifestBytes(), "\"version\":\"1.2.3.4\"", "\"version\":false"),
            Replace(ManifestBytes(), "\"kind\":\"installed-provider\"", "\"kind\":\"InstalledProvider\""),
            Replace(ManifestBytes(), "\"kind\":\"installed-provider\"", "\"kind\":1"),
            Replace(ManifestBytes(), "\"displayName\":\"Example Provider\"", "\"displayName\":\"\""),
            Replace(ManifestBytes(), "\"displayName\":\"Example Provider\"", "\"displayName\":false"),
            Replace(ManifestBytes(), "\"description\":\"A bounded installed-provider fixture.\"", "\"description\":null"),
            Replace(ManifestBytes(), "\"platform\":{\"min\":1,\"max\":1}", "\"platform\":[]"),
            Replace(ManifestBytes(), "\"host\":{\"minMajor\":12,\"maxMajor\":12}", "\"host\":{}"),
            Replace(ManifestBytes(), "\"platform\":{\"min\":1,\"max\":1}", "\"platform\":{\"min\":1.0,\"max\":1}"),
            Replace(ManifestBytes(), "\"host\":{\"minMajor\":12,\"maxMajor\":12}", "\"host\":{\"minMajor\":\"12\",\"maxMajor\":12}"),
            Replace(ManifestBytes(), "\"requestedCapabilities\":[]", "\"requestedCapabilities\":null"),
            Replace(ManifestBytes(), "\"requestedCapabilities\":[]", "\"requestedCapabilities\":[null]"),
            Replace(ManifestBytes(), "\"schemaVersion\":1", "\"SchemaVersion\":1"),
            AddRootProperty(ManifestBytes(), "schemaVersion", "1"),
            AddNestedProperty(ManifestBytes(), "platform", "min", "1"),
            AddNestedProperty(ManifestBytes(), "platform", "future", "1"),
            AddNestedProperty(ManifestBytes(), "host", "future", "1"),
        })
        {
            Reject(invalid);
        }

        Reject(ManifestBytes(schemaVersion: 2));
        Reject(ManifestBytes(kind: "companion-service"));
    }

    [Fact]
    public void RepresentativeFailuresReturnStableClosedReasons()
    {
        Assert.Equal(PlatformExtensionManifestRejectionReason.MissingDocument, Reject(null));
        Assert.Equal(PlatformExtensionManifestRejectionReason.DocumentTooLarge, Reject(
            new byte[PlatformExtensionManifestBounds.MaximumDocumentBytes + 1]));
        Assert.Equal(PlatformExtensionManifestRejectionReason.InvalidUtf8, Reject(
            new byte[] { 0xEF, 0xBB, 0xBF }.Concat(ManifestBytes()).ToArray()));
        Assert.Equal(PlatformExtensionManifestRejectionReason.InvalidJson, Reject(
            Encoding.UTF8.GetBytes("{")));
        Assert.Equal(PlatformExtensionManifestRejectionReason.DuplicateProperty, Reject(
            AddRootProperty(ManifestBytes(), "schemaVersion", "1")));
        Assert.Equal(PlatformExtensionManifestRejectionReason.UnknownProperty, Reject(
            AddRootProperty(ManifestBytes(), "future", "true")));
        Assert.Equal(PlatformExtensionManifestRejectionReason.InvalidRequestedCapabilities, Reject(
            ManifestBytes(capabilities: new[] { "jellyfin.canopy.unknown.read" })));
        Assert.Equal(PlatformExtensionManifestRejectionReason.IncompatibleRequestedCapability, Reject(
            ManifestBytes(capabilities: new[] { "jellyfin.canopy.administration.manage" })));
    }

    [Fact]
    public void SemanticFingerprintIgnoresJsonAndCapabilityOrderingButNotValidatedMutations()
    {
        var baseline = Parse(ManifestBytes(capabilities: new[] { Items, Storage }));
        var reordered = Parse(Encoding.UTF8.GetBytes("""
            {
              "requestedCapabilities": ["jellyfin.canopy.storage.read", "jellyfin.canopy.items.lookup"],
              "host": { "maxMajor": 12, "minMajor": 12 },
              "description": "A bounded installed-provider fixture.",
              "displayName": "Example Provider",
              "kind": "installed-provider",
              "platform": { "max": 1, "min": 1 },
              "version": "1.2.3.4",
              "pluginId": "11111111-2222-3333-4444-555555555555",
              "id": "org.example.media-tools",
              "schemaVersion": 1
            }
            """));

        Assert.Equal(baseline.Fingerprint.Value, reordered.Fingerprint.Value);

        var mutations = new[]
        {
            ManifestBytes(schemaVersion: 1, id: "org.example.other-tools", capabilities: new[] { Items, Storage }),
            ManifestBytes(pluginId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", capabilities: new[] { Items, Storage }),
            ManifestBytes(version: "1.2.3.5", capabilities: new[] { Items, Storage }),
            ManifestBytes(displayName: "Other Provider", capabilities: new[] { Items, Storage }),
            ManifestBytes(description: "Other description.", capabilities: new[] { Items, Storage }),
            ManifestBytes(platformMax: 2, capabilities: new[] { Items, Storage }),
            ManifestBytes(hostMax: 13, capabilities: new[] { Items, Storage }),
            ManifestBytes(capabilities: new[] { Items }),
            ManifestBytes(capabilities: new[] { Items, Storage, Ui }),
        };

        Assert.All(mutations, bytes => Assert.NotEqual(
            baseline.Fingerprint.Value,
            Parse(bytes).Fingerprint.Value));

        Assert.NotEqual(
            Parse(ManifestBytes(description: null)).Fingerprint.Value,
            Parse(ManifestBytes(description: string.Empty)).Fingerprint.Value);
    }

    [Fact]
    public async Task FingerprintIsCultureIndependentAndConcurrentParsingIsDeterministic()
    {
        var bytes = ManifestBytes(
            displayName: "M\u00e9dia Provider",
            description: "D\u00e9terministic \u0131n every culture.",
            capabilities: ProviderCapabilities.Reverse().ToArray());
        var expected = Parse(bytes).Fingerprint.Value;
        var originalCulture = CultureInfo.CurrentCulture;
        var originalUiCulture = CultureInfo.CurrentUICulture;
        try
        {
            foreach (var cultureName in new[] { "tr-TR", "ar-SA", "fr-FR" })
            {
                CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo(cultureName);
                CultureInfo.CurrentUICulture = CultureInfo.GetCultureInfo(cultureName);
                Assert.Equal(expected, Parse(bytes).Fingerprint.Value);
            }
        }
        finally
        {
            CultureInfo.CurrentCulture = originalCulture;
            CultureInfo.CurrentUICulture = originalUiCulture;
        }

        var fingerprints = await Task.WhenAll(Enumerable.Range(0, 64).Select(_ => Task.Run(() =>
            Parse(bytes.ToArray()).Fingerprint.Value)));
        Assert.All(fingerprints, fingerprint => Assert.Equal(expected, fingerprint));
    }

    [Fact]
    public void ParsedManifestDefensivelyOwnsAllInputAndRetainsNoRawDocument()
    {
        var bytes = ManifestBytes(capabilities: ProviderCapabilities.Reverse().ToArray());
        var manifest = Parse(bytes);
        var fingerprint = manifest.Fingerprint.Value;
        var ids = manifest.RequestedCapabilities.Capabilities.Select(value => value.Id.Value).ToArray();

        bytes.AsSpan().Fill((byte)'x');

        Assert.Equal("org.example.media-tools", manifest.Id);
        Assert.Equal("Example Provider", manifest.DisplayName);
        Assert.Equal(fingerprint, manifest.Fingerprint.Value);
        Assert.Equal(ProviderCapabilities, ids);
        Assert.Equal(ProviderCapabilities,
            manifest.RequestedCapabilities.Capabilities.Select(value => value.Id.Value));
    }

    private static PlatformExtensionManifest Parse(byte[] bytes)
    {
        var parsed = PlatformExtensionManifestParser.TryParse(bytes, out var manifest, out var reason);
        Assert.True(parsed, reason.ToString());
        Assert.Equal(default, reason);
        return Assert.IsType<PlatformExtensionManifest>(manifest);
    }

    private static PlatformExtensionManifestRejectionReason Reject(byte[]? bytes)
    {
        var parsed = PlatformExtensionManifestParser.TryParse(bytes, out var manifest, out var reason);
        Assert.False(parsed);
        Assert.Null(manifest);
        Assert.True(Enum.IsDefined(reason));
        Assert.NotEqual(default, reason);
        return reason;
    }

    private static byte[] ManifestBytes(
        int schemaVersion = 1,
        string id = "org.example.media-tools",
        string pluginId = "11111111-2222-3333-4444-555555555555",
        string version = "1.2.3.4",
        string kind = "installed-provider",
        string displayName = "Example Provider",
        string? description = "A bounded installed-provider fixture.",
        int platformMin = 1,
        int platformMax = 1,
        int hostMin = 12,
        int hostMax = 12,
        IReadOnlyList<string>? capabilities = null,
        string? providerOperationsJson = null)
    {
        capabilities ??= Array.Empty<string>();
        var descriptionProperty = description is null
            ? string.Empty
            : ",\"description\":" + JsonSerializer.Serialize(description);
        var json = "{"
            + "\"schemaVersion\":" + schemaVersion.ToString(CultureInfo.InvariantCulture)
            + ",\"id\":" + JsonSerializer.Serialize(id)
            + ",\"pluginId\":" + JsonSerializer.Serialize(pluginId)
            + ",\"version\":" + JsonSerializer.Serialize(version)
            + ",\"kind\":" + JsonSerializer.Serialize(kind)
            + ",\"displayName\":" + JsonSerializer.Serialize(displayName)
            + descriptionProperty
            + ",\"platform\":{\"min\":" + platformMin.ToString(CultureInfo.InvariantCulture)
            + ",\"max\":" + platformMax.ToString(CultureInfo.InvariantCulture) + "}"
            + ",\"host\":{\"minMajor\":" + hostMin.ToString(CultureInfo.InvariantCulture)
            + ",\"maxMajor\":" + hostMax.ToString(CultureInfo.InvariantCulture) + "}"
            + ",\"requestedCapabilities\":["
            + string.Join(',', capabilities.Select(value => JsonSerializer.Serialize(value)))
            + "]"
            + (providerOperationsJson is null ? string.Empty : ",\"providerOperations\":" + providerOperationsJson)
            + "}";
        return Encoding.UTF8.GetBytes(json);
    }

    private static string OperationJson(
        string operationId,
        int protocolMin,
        int protocolMax,
        IReadOnlyList<string> requiredCapabilities,
        int schemaMajor = 1,
        string extensionId = "org.example.media-tools",
        int? responseSchemaMajor = null,
        string? requestSchemaId = null,
        string? responseSchemaId = null,
        string requestSchemaSha256 = RequestSchemaSha256,
        string responseSchemaSha256 = ResponseSchemaSha256) => JsonSerializer.Serialize(new
        {
            id = operationId,
            protocol = new { min = protocolMin, max = protocolMax },
            requiredCapabilities,
            requestSchemaId = requestSchemaId
                ?? OwnedSchemaId(extensionId, operationId, "request", schemaMajor),
            requestSchemaSha256,
            responseSchemaId = responseSchemaId
                ?? OwnedSchemaId(extensionId, operationId, "response", responseSchemaMajor ?? schemaMajor),
            responseSchemaSha256,
        });

    private static string OwnedSchemaId(
        string extensionId,
        string operationId,
        string direction,
        int schemaMajor) => string.Create(
            CultureInfo.InvariantCulture,
            $"urn:jellyfin-canopy:provider-schema:{extensionId}:{operationId}:{direction}:{schemaMajor}");

    private static byte[] AddRootProperty(byte[] source, string property, string value)
    {
        var json = Encoding.UTF8.GetString(source);
        return Encoding.UTF8.GetBytes(json[..^1] + "," + JsonSerializer.Serialize(property) + ":" + value + "}");
    }

    private static byte[] AddNestedProperty(byte[] source, string owner, string property, string value)
    {
        var json = Encoding.UTF8.GetString(source);
        var marker = "\"" + owner + "\":{";
        var start = json.IndexOf(marker, StringComparison.Ordinal);
        Assert.True(start >= 0);
        var objectEnd = json.IndexOf('}', start);
        return Encoding.UTF8.GetBytes(json.Insert(
            objectEnd,
            ",\"" + property + "\":" + value));
    }

    private static byte[] RemoveRootProperty(byte[] source, string property)
    {
        var root = JsonNode.Parse(source)!.AsObject();
        Assert.True(root.Remove(property));
        return Encoding.UTF8.GetBytes(root.ToJsonString());
    }

    private static string IndependentFingerprint(PlatformExtensionManifest manifest)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Append("jellyfin-canopy-extension-manifest-v1");
        Append(manifest.SchemaVersion.ToString(CultureInfo.InvariantCulture));
        Append(manifest.Id);
        Append(manifest.PluginId.ToString("D"));
        Append(manifest.Version.ToString());
        Append("installed-provider");
        Append(manifest.DisplayName);
        Append(manifest.Description is null ? "0" : "1");
        if (manifest.Description is not null)
        {
            Append(manifest.Description);
        }

        Append(manifest.PlatformRange.Min.ToString(CultureInfo.InvariantCulture));
        Append(manifest.PlatformRange.Max.ToString(CultureInfo.InvariantCulture));
        Append(manifest.HostRange.MinMajor.ToString(CultureInfo.InvariantCulture));
        Append(manifest.HostRange.MaxMajor.ToString(CultureInfo.InvariantCulture));
        Append(manifest.RequestedCapabilities.Capabilities.Length.ToString(CultureInfo.InvariantCulture));
        foreach (var capability in manifest.RequestedCapabilities.Capabilities)
        {
            Append(capability.Id.Value);
        }

        if (!manifest.ProviderOperations.IsEmpty)
        {
            Append("provider-operations-v1");
            Append(manifest.ProviderOperations.Length.ToString(CultureInfo.InvariantCulture));
            foreach (var operation in manifest.ProviderOperations)
            {
                Append(operation.Id);
                Append(operation.ProtocolRange.Min.ToString(CultureInfo.InvariantCulture));
                Append(operation.ProtocolRange.Max.ToString(CultureInfo.InvariantCulture));
                Append(operation.RequiredCapabilities.Capabilities.Length.ToString(CultureInfo.InvariantCulture));
                foreach (var capability in operation.RequiredCapabilities.Capabilities)
                {
                    Append(capability.Id.Value);
                }

                Append(operation.RequestSchemaId);
                Append(operation.RequestSchemaSha256);
                Append(operation.ResponseSchemaId);
                Append(operation.ResponseSchemaSha256);
            }
        }

        return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();

        void Append(string value)
        {
            var bytes = Encoding.UTF8.GetBytes(value);
            Span<byte> length = stackalloc byte[sizeof(int)];
            BinaryPrimitives.WriteInt32BigEndian(length, bytes.Length);
            hash.AppendData(length);
            hash.AppendData(bytes);
        }
    }

    private static byte[] Replace(byte[] source, string oldValue, string newValue) =>
        Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(source).Replace(
            oldValue,
            newValue,
            StringComparison.Ordinal));
}
