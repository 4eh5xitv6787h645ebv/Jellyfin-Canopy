using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

public sealed class PlatformExtensionManifestContractTests
{
    private static readonly JsonDocument Schema = JsonDocument.Parse(
        File.ReadAllText(ContractPath("extension-manifest.schema.json")));
    private static readonly JsonDocument Frozen = JsonDocument.Parse(
        File.ReadAllText(ContractPath("frozen.json")));

    private static readonly string[] RequiredProperties =
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
    };

    private static readonly string[] ProviderCapabilities = PlatformCapabilityVocabulary.All
        .Where(definition => definition.AllowedActorKinds.Contains(PlatformActorKind.InstalledProvider))
        .Select(definition => definition.Id.Value)
        .ToArray();

    [Fact]
    public void RuntimeSchemaFrozenAndGoldenFixtureAreExact()
    {
        Assert.Empty(ManifestContractDrift(Schema.RootElement, Frozen.RootElement));

        var fixture = File.ReadAllBytes(ContractPath(Path.Combine(
            "fixtures",
            "extension-manifest.valid.json")));
        Assert.True(PlatformExtensionManifestParser.TryParse(fixture, out var manifest, out var reason));
        Assert.Equal(PlatformExtensionManifestRejectionReason.None, reason);
        Assert.NotNull(manifest);
        Assert.Equal(1, manifest.SchemaVersion);
        Assert.Equal("org.example.provider", manifest.Id);
        Assert.Equal(Guid.Parse("12345678-9abc-4def-8123-456789abcdef"), manifest.PluginId);
        Assert.Equal(new Version(1, 2, 3, 4), manifest.Version);
        Assert.Equal(PlatformActorKind.InstalledProvider, manifest.Kind);
        Assert.Equal("Example Provider", manifest.DisplayName);
        Assert.Equal("A bounded installed-provider fixture.", manifest.Description);
        Assert.Equal((1, 1), (manifest.PlatformRange.Min, manifest.PlatformRange.Max));
        Assert.Equal((12, 12), (manifest.HostRange.MinMajor, manifest.HostRange.MaxMajor));
        Assert.Equal(
            ProviderCapabilities,
            manifest.RequestedCapabilities.Capabilities.Select(value => value.Id.Value));
        Assert.Equal(
            Frozen.RootElement.GetProperty("extensionManifest").GetProperty("goldenFingerprint").GetString(),
            manifest.Fingerprint.Value);
    }

    [Fact]
    public void VersionSchemaPinsTheExactSystemVersionComponentCeiling()
    {
        var pattern = Schema.RootElement.GetProperty("properties")
            .GetProperty("version").GetProperty("pattern").GetString()!;
        var regex = new Regex(pattern, RegexOptions.CultureInvariant);

        Assert.Matches(regex, "0.0");
        Assert.Matches(regex, "2147483647.2147483647.2147483647.2147483647");
        Assert.DoesNotMatch(regex, "2147483648.1");
        Assert.DoesNotMatch(regex, "9999999999.1");
        Assert.DoesNotMatch(regex, "01.1");
    }

    [Fact]
    public void DriftGateNamesSchemaFrozenBoundsFieldsAndCapabilities()
    {
        var frozen = JsonNode.Parse(Frozen.RootElement.GetRawText())!.AsObject();
        frozen["extensionManifest"]!["maximumJsonDepth"] = 17;
        using var changedBound = JsonDocument.Parse(frozen.ToJsonString());
        Assert.Contains(
            "maximumJsonDepth changed",
            ManifestContractDrift(Schema.RootElement, changedBound.RootElement));

        frozen = JsonNode.Parse(Frozen.RootElement.GetRawText())!.AsObject();
        frozen["extensionManifest"]!["providerEligibleCapabilities"]!.AsArray().RemoveAt(0);
        using var removedCapability = JsonDocument.Parse(frozen.ToJsonString());
        Assert.Contains(
            "providerEligibleCapabilities changed",
            ManifestContractDrift(Schema.RootElement, removedCapability.RootElement));

        var schema = JsonNode.Parse(Schema.RootElement.GetRawText())!.AsObject();
        schema["properties"]!.AsObject().Remove("displayName");
        using var removedProperty = JsonDocument.Parse(schema.ToJsonString());
        Assert.Contains(
            "schema properties changed",
            ManifestContractDrift(removedProperty.RootElement, Frozen.RootElement));

        schema = JsonNode.Parse(Schema.RootElement.GetRawText())!.AsObject();
        schema["required"]!.AsArray().RemoveAt(0);
        using var removedRequired = JsonDocument.Parse(schema.ToJsonString());
        Assert.Contains(
            "requiredProperties changed",
            ManifestContractDrift(removedRequired.RootElement, Frozen.RootElement));
    }

    [Fact]
    public void DriftGateNamesEveryFieldLevelManifestContract()
    {
        AssertSchemaDrift("root type changed", schema => schema["type"] = "array");
        AssertSchemaDrift("schemaVersion changed", schema =>
            schema["properties"]!["schemaVersion"]!["const"] = 2);
        AssertSchemaDrift("id changed", schema =>
            schema["properties"]!["id"]!["x-canopy-maximum-segment-length"] = 63);
        AssertSchemaDrift("pluginId changed", schema =>
            schema["properties"]!["pluginId"]!["pattern"] = "changed");
        AssertSchemaDrift("version changed", schema =>
            schema["properties"]!["version"]!["pattern"] = "changed");
        AssertSchemaDrift("kind changed", schema =>
            schema["properties"]!["kind"]!["const"] = "companion-service");
        AssertSchemaDrift("displayName changed", schema =>
            schema["properties"]!["displayName"]!["maxLength"] = 95);
        AssertSchemaDrift("description changed", schema =>
            schema["properties"]!["description"]!["x-canopy-text-policy"] = "changed");
        AssertSchemaDrift("platform changed", schema =>
            schema["properties"]!["platform"]!["properties"]!["max"]!["maximum"] = 65534);
        AssertSchemaDrift("host changed", schema =>
            schema["properties"]!["host"]!["required"]!.AsArray().RemoveAt(0));
        AssertSchemaDrift("maximumRequestedCapabilities changed", schema =>
            schema["properties"]!["requestedCapabilities"]!["maxItems"] = 8);
        AssertSchemaDrift("requestedCapabilities changed", schema =>
            schema["properties"]!["requestedCapabilities"]!["minItems"] = 1);
        AssertSchemaDrift("requestedCapabilities changed", schema =>
            schema["properties"]!["requestedCapabilities"]!["items"]!["type"] = "number");
    }

    private static IReadOnlyList<string> ManifestContractDrift(JsonElement schema, JsonElement frozenRoot)
    {
        var drift = new List<string>();
        var frozen = frozenRoot.GetProperty("extensionManifest");
        var properties = schema.GetProperty("properties");
        AddIf(!schema.TryGetProperty("type", out var rootType)
            || rootType.GetString() != "object", "root type changed");
        var expectedProperties = RequiredProperties.Append("description").Order(StringComparer.Ordinal).ToArray();
        var schemaProperties = properties.EnumerateObject()
            .Select(property => property.Name)
            .Order(StringComparer.Ordinal)
            .ToArray();
        AddIf(!schemaProperties.SequenceEqual(expectedProperties, StringComparer.Ordinal), "schema properties changed");

        var schemaRequired = schema.GetProperty("required").EnumerateArray()
            .Select(value => value.GetString()!)
            .ToArray();
        var frozenRequired = frozen.GetProperty("requiredProperties").EnumerateArray()
            .Select(value => value.GetString()!)
            .ToArray();
        AddIf(!schemaRequired.SequenceEqual(RequiredProperties, StringComparer.Ordinal)
            || !frozenRequired.SequenceEqual(RequiredProperties, StringComparer.Ordinal), "requiredProperties changed");
        AddIf(!frozen.GetProperty("optionalProperties").EnumerateArray()
            .Select(value => value.GetString())
            .SequenceEqual(new[] { "description" }, StringComparer.Ordinal), "optionalProperties changed");

        CompareText("fileName", PlatformExtensionManifestParser.ManifestFileName);
        CompareText("schemaId", PlatformExtensionManifestParser.SchemaId);
        CompareText("kind", PlatformActorKindVocabulary.TokenFor(PlatformActorKind.InstalledProvider)!);
        CompareText("fingerprintAlgorithm", PlatformExtensionManifestParser.FingerprintAlgorithm);
        CompareText("fingerprintDomain", PlatformExtensionManifestParser.FingerprintDomain);
        CompareText("unknownProperties", "reject");
        CompareNumber("schemaVersion", PlatformExtensionManifestParser.SchemaVersion);
        CompareNumber("maximumDocumentBytes", PlatformExtensionManifestBounds.MaximumDocumentBytes);
        CompareNumber("maximumJsonDepth", PlatformExtensionManifestBounds.MaximumJsonDepth);
        CompareNumber("maximumIdBytes", PlatformExtensionManifestBounds.MaximumIdBytes);
        CompareNumber("maximumIdentifierSegmentLength", PlatformExtensionManifestParser.MaximumIdentifierSegmentLength);
        CompareNumber("maximumVersionBytes", PlatformExtensionManifestBounds.MaximumVersionBytes);
        CompareNumber("maximumDisplayNameBytes", PlatformExtensionManifestBounds.MaximumDisplayNameBytes);
        CompareNumber("maximumDescriptionBytes", PlatformExtensionManifestBounds.MaximumDescriptionBytes);
        CompareNumber("maximumCompatibilityMajor", PlatformExtensionManifestBounds.MaximumCompatibilityMajor);
        CompareNumber("maximumRequestedCapabilities", PlatformExtensionManifestBounds.MaximumRequestedCapabilities);

        AddIf(schema.GetProperty("$id").GetString() != PlatformExtensionManifestParser.SchemaId, "schemaId changed");
        AddIf(schema.GetProperty("additionalProperties").GetBoolean(), "unknownProperties changed");
        AddIf(schema.GetProperty("x-canopy-unknown-properties").GetString() != "reject", "unknownProperties changed");
        AddIf(schema.GetProperty("x-canopy-maximum-document-bytes").GetInt32()
            != PlatformExtensionManifestBounds.MaximumDocumentBytes, "maximumDocumentBytes changed");
        AddIf(schema.GetProperty("x-canopy-maximum-json-depth").GetInt32()
            != PlatformExtensionManifestBounds.MaximumJsonDepth, "maximumJsonDepth changed");
        AddIf(schema.GetProperty("x-canopy-fingerprint-algorithm").GetString()
            != PlatformExtensionManifestParser.FingerprintAlgorithm, "fingerprintAlgorithm changed");
        AddIf(schema.GetProperty("x-canopy-fingerprint-domain").GetString()
            != PlatformExtensionManifestParser.FingerprintDomain, "fingerprintDomain changed");

        if (!properties.TryGetProperty("schemaVersion", out var schemaVersion))
        {
            AddIf(true, "schemaVersion changed");
        }
        else
        {
            AddIf(schemaVersion.GetProperty("type").GetString() != "integer"
                || schemaVersion.GetProperty("const").GetInt32() != PlatformExtensionManifestParser.SchemaVersion,
                "schemaVersion changed");
        }

        if (!properties.TryGetProperty("id", out var identifier))
        {
            AddIf(true, "id changed");
        }
        else
        {
            AddIf(identifier.GetProperty("type").GetString() != "string"
                || identifier.GetProperty("minLength").GetInt32() != 3
                || identifier.GetProperty("maxLength").GetInt32() != PlatformExtensionManifestBounds.MaximumIdBytes
                || identifier.GetProperty("x-canopy-maximum-segment-length").GetInt32()
                    != PlatformExtensionManifestParser.MaximumIdentifierSegmentLength
                || identifier.GetProperty("pattern").GetString()
                    != frozen.GetProperty("identifierPattern").GetString(),
                "id changed");
        }

        if (!properties.TryGetProperty("pluginId", out var pluginId))
        {
            AddIf(true, "pluginId changed");
        }
        else
        {
            AddIf(pluginId.GetProperty("type").GetString() != "string"
                || pluginId.GetProperty("minLength").GetInt32() != 36
                || pluginId.GetProperty("maxLength").GetInt32() != 36
                || pluginId.GetProperty("pattern").GetString()
                    != frozen.GetProperty("pluginIdPattern").GetString()
                || pluginId.GetProperty("not").GetProperty("const").GetString()
                    != "00000000-0000-0000-0000-000000000000",
                "pluginId changed");
        }

        if (!properties.TryGetProperty("version", out var version))
        {
            AddIf(true, "version changed");
        }
        else
        {
            AddIf(version.GetProperty("type").GetString() != "string"
                || version.GetProperty("minLength").GetInt32() != 3
                || version.GetProperty("maxLength").GetInt32()
                    != PlatformExtensionManifestBounds.MaximumVersionBytes
                || version.GetProperty("pattern").GetString()
                    != frozen.GetProperty("versionPattern").GetString(),
                "version changed");
        }

        if (!properties.TryGetProperty("kind", out var kind))
        {
            AddIf(true, "kind changed");
        }
        else
        {
            AddIf(kind.GetProperty("type").GetString() != "string"
                || kind.GetProperty("const").GetString()
                    != PlatformActorKindVocabulary.TokenFor(PlatformActorKind.InstalledProvider),
                "kind changed");
        }

        CompareTextField("displayName", 1, PlatformExtensionManifestBounds.MaximumDisplayNameBytes);
        CompareTextField("description", 0, PlatformExtensionManifestBounds.MaximumDescriptionBytes);
        CompareRange(
            "platform",
            new[] { "min", "max" },
            "min<=max");
        CompareRange(
            "host",
            new[] { "minMajor", "maxMajor" },
            "minMajor<=maxMajor");

        var frozenCapabilities = frozen.GetProperty("providerEligibleCapabilities").EnumerateArray()
            .Select(value => value.GetString()!)
            .ToArray();
        AddIf(!frozenCapabilities.SequenceEqual(ProviderCapabilities, StringComparer.Ordinal),
            "providerEligibleCapabilities changed");
        if (!properties.TryGetProperty("requestedCapabilities", out var requestedCapabilities))
        {
            AddIf(true, "requestedCapabilities changed");
        }
        else
        {
            var items = requestedCapabilities.GetProperty("items");
            var schemaCapabilities = items.GetProperty("enum").EnumerateArray()
                .Select(value => value.GetString()!)
                .ToArray();
            AddIf(!schemaCapabilities.SequenceEqual(ProviderCapabilities, StringComparer.Ordinal),
                "providerEligibleCapabilities changed");
            AddIf(requestedCapabilities.GetProperty("type").GetString() != "array"
                || requestedCapabilities.GetProperty("minItems").GetInt32() != 0
                || items.GetProperty("type").GetString() != "string",
                "requestedCapabilities changed");
            AddIf(requestedCapabilities.GetProperty("maxItems").GetInt32()
                != PlatformExtensionManifestBounds.MaximumRequestedCapabilities,
                "maximumRequestedCapabilities changed");
            AddIf(!requestedCapabilities.GetProperty("uniqueItems").GetBoolean(),
                "requestedCapabilities uniqueness changed");
        }

        return drift.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();

        void CompareText(string name, string expected) =>
            AddIf(frozen.GetProperty(name).GetString() != expected, $"{name} changed");

        void CompareNumber(string name, int expected) =>
            AddIf(frozen.GetProperty(name).GetInt32() != expected, $"{name} changed");

        void CompareTextField(string name, int minimum, int maximum)
        {
            if (!properties.TryGetProperty(name, out var field))
            {
                AddIf(true, $"{name} changed");
                return;
            }

            AddIf(field.GetProperty("type").GetString() != "string"
                || field.GetProperty("minLength").GetInt32() != minimum
                || field.GetProperty("maxLength").GetInt32() != maximum
                || field.GetProperty("x-canopy-maximum-utf8-bytes").GetInt32() != maximum
                || field.GetProperty("x-canopy-text-policy").GetString()
                    != frozen.GetProperty("textPolicy").GetString(),
                $"{name} changed");
        }

        void CompareRange(string name, IReadOnlyList<string> required, string order)
        {
            if (!properties.TryGetProperty(name, out var range))
            {
                AddIf(true, $"{name} changed");
                return;
            }

            var actualRequired = range.GetProperty("required").EnumerateArray()
                .Select(value => value.GetString()!)
                .ToArray();
            var members = range.GetProperty("properties");
            var memberNames = members.EnumerateObject().Select(member => member.Name).ToArray();
            var invalidMember = members.EnumerateObject().Any(member =>
                member.Value.GetProperty("type").GetString() != "integer"
                || member.Value.GetProperty("minimum").GetInt32() != 1
                || member.Value.GetProperty("maximum").GetInt32()
                    != PlatformExtensionManifestBounds.MaximumCompatibilityMajor);
            AddIf(range.GetProperty("type").GetString() != "object"
                || range.GetProperty("additionalProperties").GetBoolean()
                || !actualRequired.SequenceEqual(required, StringComparer.Ordinal)
                || !memberNames.SequenceEqual(required, StringComparer.Ordinal)
                || invalidMember
                || range.GetProperty("x-canopy-range-order").GetString() != order,
                $"{name} changed");
        }

        void AddIf(bool changed, string message)
        {
            if (changed)
            {
                drift.Add(message);
            }
        }
    }

    private static void AssertSchemaDrift(string expected, Action<JsonObject> mutation)
    {
        var schema = JsonNode.Parse(Schema.RootElement.GetRawText())!.AsObject();
        mutation(schema);
        using var changed = JsonDocument.Parse(schema.ToJsonString());
        Assert.Contains(expected, ManifestContractDrift(changed.RootElement, Frozen.RootElement));
    }

    private static string ContractPath(string name, [CallerFilePath] string sourceFile = "") =>
        Path.GetFullPath(Path.Combine(
            Path.GetDirectoryName(sourceFile)!,
            "..",
            "..",
            "contracts",
            "platform",
            "v1",
            name));
}
