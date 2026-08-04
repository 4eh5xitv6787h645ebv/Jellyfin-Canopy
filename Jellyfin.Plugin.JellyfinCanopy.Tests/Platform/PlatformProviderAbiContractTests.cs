using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

public sealed class PlatformProviderAbiContractTests
{
    private static readonly JsonDocument RequestSchema = ReadSchema("provider-request-envelope.schema.json");
    private static readonly JsonDocument ResponseSchema = ReadSchema("provider-response-envelope.schema.json");
    private static readonly JsonDocument Frozen = ReadSchema("frozen.json");

    [Fact]
    public void AbiConventionIsOneExactLoadContextSafeShape()
    {
        Assert.Equal("JellyfinCanopy.ExtensionProviderEntrypoint", PlatformProviderAbiContract.EntrypointTypeName);
        Assert.Equal("InvokeAsync", PlatformProviderAbiContract.InvocationMethodName);
        Assert.Equal(
            "Task<string> InvokeAsync(string operationId, string requestJson, CancellationToken cancellationToken)",
            PlatformProviderAbiContract.InvocationSignature);
        Assert.Equal("JellyfinCanopy.ProviderSchemas.", PlatformProviderAbiContract.ProviderSchemaResourcePrefix);
        Assert.Equal(".json", PlatformProviderAbiContract.ProviderSchemaResourceSuffix);
        Assert.Equal(64, PlatformProviderAbiContract.ProviderSchemaSha256Characters);

        var frozen = Frozen.RootElement.GetProperty("providerAbi");
        Assert.Equal(
            PlatformProviderAbiContract.ProviderSchemaResourcePrefix,
            frozen.GetProperty("providerSchemaResourcePrefix").GetString());
        Assert.Equal(
            PlatformProviderAbiContract.ProviderSchemaResourceSuffix,
            frozen.GetProperty("providerSchemaResourceSuffix").GetString());
        Assert.Equal(
            PlatformProviderAbiContract.ProviderSchemaSha256Characters,
            frozen.GetProperty("providerSchemaSha256Characters").GetInt32());

        Assert.DoesNotContain("Jellyfin.Plugin.JellyfinCanopy", PlatformProviderAbiContract.InvocationSignature, StringComparison.Ordinal);
        Assert.DoesNotContain("IExtension", PlatformProviderAbiContract.InvocationSignature, StringComparison.Ordinal);
        Assert.DoesNotContain("delegate", PlatformProviderAbiContract.InvocationSignature, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void FrozenInventoryPinsTheCompleteProviderSchemasAndGoldenEnvelopes()
    {
        var requestSchema = ContractBytes("provider-request-envelope.schema.json");
        var responseSchema = ContractBytes("provider-response-envelope.schema.json");
        var requestGolden = ContractBytes(Path.Combine("fixtures", "provider-request.valid.json"));
        var responseGolden = ContractBytes(Path.Combine("fixtures", "provider-response.valid.json"));

        Assert.Empty(ProviderAbiContractDrift(requestSchema, responseSchema, requestGolden, responseGolden));

        var loosenedRequest = JsonNode.Parse(requestSchema)!.AsObject();
        loosenedRequest["required"]!.AsArray().Remove("attribution");
        Assert.Contains(
            "request envelope schema changed",
            ProviderAbiContractDrift(
                Utf8(loosenedRequest), responseSchema, requestGolden, responseGolden));

        var loosenedCorrelation = JsonNode.Parse(requestSchema)!.AsObject();
        loosenedCorrelation["properties"]!["correlationId"]!["pattern"] = ".*";
        Assert.Contains(
            "request envelope schema changed",
            ProviderAbiContractDrift(
                Utf8(loosenedCorrelation), responseSchema, requestGolden, responseGolden));

        var loosenedResponse = JsonNode.Parse(responseSchema)!.AsObject();
        loosenedResponse["properties"]!["result"]!["additionalProperties"] = false;
        Assert.Contains(
            "response envelope schema changed",
            ProviderAbiContractDrift(
                requestSchema, Utf8(loosenedResponse), requestGolden, responseGolden));
    }

    [Theory]
    [InlineData("provider-request-envelope.schema.json", true)]
    [InlineData("provider-response-envelope.schema.json", false)]
    public void AuthoredSchemasPinEveryGlobalBoundAndStayClosed(string schemaName, bool request)
    {
        using var schema = ReadSchema(schemaName);
        var root = schema.RootElement;

        Assert.Equal(
            request ? PlatformProviderAbiContract.RequestEnvelopeSchemaId : PlatformProviderAbiContract.ResponseEnvelopeSchemaId,
            root.GetProperty("$id").GetString());
        Assert.Equal("object", root.GetProperty("type").GetString());
        Assert.False(root.GetProperty("additionalProperties").GetBoolean());
        Assert.Equal("reject", root.GetProperty("x-canopy-unknown-properties").GetString());
        Assert.Equal("ordinal-ignore-case", root.GetProperty("x-canopy-forbidden-property-name-comparison").GetString());
        Assert.Equal(
            request
                ? PlatformProviderAbiContract.MaximumRequestDocumentBytes
                : PlatformProviderAbiContract.MaximumResponseDocumentBytes,
            root.GetProperty("x-canopy-maximum-document-bytes").GetInt32());
        Assert.Equal(
            PlatformProviderAbiContract.MaximumJsonDepth,
            root.GetProperty("x-canopy-maximum-json-depth").GetInt32());
        Assert.Equal(
            PlatformProviderAbiContract.MaximumCollectionItems,
            root.GetProperty("x-canopy-maximum-collection-items").GetInt32());
        Assert.Equal(
            PlatformProviderAbiContract.MaximumObjectProperties,
            root.GetProperty("x-canopy-maximum-object-properties").GetInt32());
        Assert.Equal(
            PlatformProviderAbiContract.MaximumPropertyNameBytes,
            root.GetProperty("x-canopy-maximum-property-name-utf8-bytes").GetInt32());
        Assert.Equal(
            PlatformProviderAbiContract.MaximumIdentifierBytes,
            root.GetProperty("x-canopy-maximum-identifier-utf8-bytes").GetInt32());
        Assert.Equal(
            PlatformProviderAbiContract.MaximumStringBytes,
            root.GetProperty("x-canopy-maximum-string-utf8-bytes").GetInt32());

        var properties = root.GetProperty("properties");
        Assert.Equal(
            PlatformProviderAbiContract.EnvelopeSchemaVersion,
            properties.GetProperty("schemaVersion").GetProperty("const").GetInt32());
        Assert.Equal(
            PlatformConstants.ProtocolMinimum,
            properties.GetProperty("protocol").GetProperty("const").GetInt32());
        Assert.Equal(PlatformConstants.ProtocolMinimum, PlatformConstants.ProtocolMaximum);

        var payload = properties.GetProperty(request ? "input" : "result");
        Assert.Equal("object", payload.GetProperty("type").GetString());
        Assert.Equal(
            PlatformProviderAbiContract.MaximumObjectProperties,
            payload.GetProperty("maxProperties").GetInt32());
        Assert.True(payload.GetProperty("additionalProperties").GetBoolean());

        var correlationId = properties.GetProperty("correlationId");
        Assert.Equal(
            PlatformProviderAbiContract.MaximumIdentifierBytes,
            correlationId.GetProperty("maxLength").GetInt32());
        Assert.Equal(
            PlatformProviderAbiContract.MaximumIdentifierBytes,
            correlationId.GetProperty("x-canopy-maximum-utf8-bytes").GetInt32());

        if (request)
        {
            AssertRequestSpecificBounds(properties);
        }
    }

    [Theory]
    [InlineData("provider-request-envelope.schema.json", "provider-request.valid.json")]
    [InlineData("provider-response-envelope.schema.json", "provider-response.valid.json")]
    public void GoldenEnvelopesValidateAgainstTheirAuthoredSchemas(string schemaName, string fixtureName)
    {
        using var schema = ReadSchema(schemaName);
        var fixture = File.ReadAllBytes(ContractPath(Path.Combine("fixtures", fixtureName)));

        Assert.True(EnvelopeSchemaValidator.IsValid(schema.RootElement, fixture, out var failure), failure);
    }

    [Fact]
    public void ResponseCorrelationAndProtocolMustEqualTheExactRequest()
    {
        var responseProperties = ResponseSchema.RootElement.GetProperty("properties");
        Assert.Equal(
            "$.correlationId",
            responseProperties.GetProperty("correlationId")
                .GetProperty("x-canopy-equals-request-path").GetString());
        Assert.Equal(
            "$.protocol",
            responseProperties.GetProperty("protocol")
                .GetProperty("x-canopy-equals-request-path").GetString());

        var request = ContractBytes(Path.Combine("fixtures", "provider-request.valid.json"));
        var response = ContractBytes(Path.Combine("fixtures", "provider-response.valid.json"));
        Assert.True(ResponseMatchesRequest(request, response));

        var mismatched = GoldenObject("provider-response.valid.json");
        mismatched["correlationId"] = "different-correlation";
        Assert.True(EnvelopeSchemaValidator.IsValid(
            ResponseSchema.RootElement, Utf8(mismatched), out var failure), failure);
        Assert.False(ResponseMatchesRequest(request, Utf8(mismatched)));
    }

    [Fact]
    public void FixedEnvelopeObjectsRejectUnknownDuplicateMissingAndMalformedProperties()
    {
        AssertInvalid(RequestSchema, MutateGolden("provider-request.valid.json", root => root["unexpected"] = true));
        AssertInvalid(RequestSchema, MutateGolden("provider-request.valid.json", root => root["hints"]!["unexpected"] = true));
        AssertInvalid(RequestSchema, MutateGolden("provider-request.valid.json", root => root.Remove("protocol")));
        AssertInvalid(ResponseSchema, MutateGolden("provider-response.valid.json", root => root["unexpected"] = true));
        AssertInvalid(ResponseSchema, MutateGolden("provider-response.valid.json", root => root.Remove("result")));

        AssertInvalid(RequestSchema, Encoding.UTF8.GetBytes(
            "{\"schemaVersion\":1,\"schemaVersion\":1}"));
        AssertInvalid(ResponseSchema, Encoding.UTF8.GetBytes(
            "{\"schemaVersion\":1,\"correlationId\":\"c\",\"protocol\":1,\"result\":{\"a\":1,\"a\":2}}"));
        AssertInvalid(RequestSchema, Encoding.UTF8.GetBytes("{\"schemaVersion\":"));
        AssertInvalid(ResponseSchema, Encoding.UTF8.GetBytes("{} trailing"));
    }

    [Fact]
    public void DocumentByteBoundsAcceptMaxAndRejectMaxPlusOne()
    {
        AssertExactDocumentBoundary(RequestSchema, "provider-request.valid.json", PlatformProviderAbiContract.MaximumRequestDocumentBytes);
        AssertExactDocumentBoundary(ResponseSchema, "provider-response.valid.json", PlatformProviderAbiContract.MaximumResponseDocumentBytes);
    }

    [Fact]
    public void DepthCollectionPropertyAndStringBoundsHaveExactNegativeBoundaries()
    {
        var response = GoldenObject("provider-response.valid.json");
        response["result"] = NestedObject(PlatformProviderAbiContract.MaximumJsonDepth - 1);
        AssertValid(ResponseSchema, Utf8(response));
        response["result"] = NestedObject(PlatformProviderAbiContract.MaximumJsonDepth);
        AssertInvalid(ResponseSchema, Utf8(response));

        response = GoldenObject("provider-response.valid.json");
        response["result"]!["values"] = new JsonArray(
            Enumerable.Range(0, PlatformProviderAbiContract.MaximumCollectionItems)
                .Select(index => JsonValue.Create(index))
                .ToArray());
        AssertValid(ResponseSchema, Utf8(response));
        response["result"]!["values"]!.AsArray().Add(PlatformProviderAbiContract.MaximumCollectionItems);
        AssertInvalid(ResponseSchema, Utf8(response));

        response = GoldenObject("provider-response.valid.json");
        response["result"] = ObjectWithProperties(PlatformProviderAbiContract.MaximumObjectProperties);
        AssertValid(ResponseSchema, Utf8(response));
        response["result"]!["extra"] = true;
        AssertInvalid(ResponseSchema, Utf8(response));

        response = GoldenObject("provider-response.valid.json");
        response["result"]!["message"] = new string('a', PlatformProviderAbiContract.MaximumStringBytes);
        AssertValid(ResponseSchema, Utf8(response));
        response["result"]!["message"] = new string('a', PlatformProviderAbiContract.MaximumStringBytes + 1);
        AssertInvalid(ResponseSchema, Utf8(response));

        response = GoldenObject("provider-response.valid.json");
        response["result"] = new JsonObject
        {
            [new string('p', PlatformProviderAbiContract.MaximumPropertyNameBytes)] = true,
        };
        AssertValid(ResponseSchema, Utf8(response));
        response["result"] = new JsonObject
        {
            [new string('p', PlatformProviderAbiContract.MaximumPropertyNameBytes + 1)] = true,
        };
        AssertInvalid(ResponseSchema, Utf8(response));
    }

    [Fact]
    public void RequestSpecificBoundsHaveExactNegativeBoundaries()
    {
        var request = GoldenObject("provider-request.valid.json");
        request["correlationId"] = "a" + new string('b', PlatformProviderAbiContract.MaximumIdentifierBytes - 1);
        AssertValid(RequestSchema, Utf8(request));
        request["correlationId"] = "a" + new string('b', PlatformProviderAbiContract.MaximumIdentifierBytes);
        AssertInvalid(RequestSchema, Utf8(request));

        request = GoldenObject("provider-request.valid.json");
        request["remainingDeadlineMilliseconds"] = PlatformProviderAbiContract.MaximumRemainingDeadlineMilliseconds;
        AssertValid(RequestSchema, Utf8(request));
        request["remainingDeadlineMilliseconds"] = PlatformProviderAbiContract.MaximumRemainingDeadlineMilliseconds + 1;
        AssertInvalid(RequestSchema, Utf8(request));

        request = GoldenObject("provider-request.valid.json");
        request["grantedScopes"] = new JsonArray(
            "jellyfin.canopy.items.lookup",
            "jellyfin.canopy.user-data.read",
            "jellyfin.canopy.storage.read",
            "jellyfin.canopy.ui.contribute",
            "jellyfin.canopy.integrations.invoke");
        AssertValid(RequestSchema, Utf8(request));
        request["grantedScopes"]!.AsArray().Add("org.example.invented");
        AssertInvalid(RequestSchema, Utf8(request));

        request = GoldenObject("provider-request.valid.json");
        request["grantedScopes"] = new JsonArray("org.example.invented");
        AssertInvalid(RequestSchema, Utf8(request));

        request = GoldenObject("provider-request.valid.json");
        request["hints"]!["accessibility"] = IdentifierArray("hint", PlatformProviderAbiContract.MaximumAccessibilityHints);
        AssertValid(RequestSchema, Utf8(request));
        request["hints"]!["accessibility"]!.AsArray().Add("hint8");
        AssertInvalid(RequestSchema, Utf8(request));
    }

    [Fact]
    public void GrantedScopesAreTheExactInstalledProviderCeilingAndRequireRuntimeIntersection()
    {
        var grantedScopes = RequestSchema.RootElement.GetProperty("properties")
            .GetProperty("grantedScopes");
        var providerEligible = PlatformCapabilityVocabulary.All
            .Where(definition => definition.AllowedActorKinds.Contains(PlatformActorKind.InstalledProvider))
            .Select(definition => definition.Id.Value)
            .ToArray();

        Assert.Equal(PlatformProviderAbiContract.MaximumGrantedScopes, providerEligible.Length);
        Assert.Equal(PlatformProviderAbiContract.MaximumGrantedScopes, grantedScopes.GetProperty("maxItems").GetInt32());
        Assert.Equal(
            providerEligible,
            grantedScopes.GetProperty("items").GetProperty("enum")
                .EnumerateArray()
                .Select(value => value.GetString()));
        Assert.Equal(
            "selected-operation.requiredCapabilities ∩ current-effective-grant",
            grantedScopes.GetProperty("x-canopy-subset-of").GetString());
    }

    [Theory]
    [InlineData("token")]
    [InlineData("BearerToken")]
    [InlineData("password")]
    [InlineData("AccessToken")]
    [InlineData("claimsPrincipal")]
    [InlineData("HttpContext")]
    [InlineData("serviceProvider")]
    [InlineData("IServiceProvider")]
    [InlineData("requestServices")]
    [InlineData("dbContext")]
    [InlineData("databaseHandle")]
    [InlineData("hostHandle")]
    [InlineData("path")]
    [InlineData("absolutePath")]
    [InlineData("credential")]
    [InlineData("exception")]
    [InlineData("rawException")]
    [InlineData("connectionString")]
    [InlineData("environment")]
    [InlineData("authority")]
    public void AuthorityBearingFieldsRejectAtEveryPayloadDepth(string forbiddenName)
    {
        var request = GoldenObject("provider-request.valid.json");
        request["input"]!["nested"] = new JsonObject
        {
            [forbiddenName] = "must-not-cross",
        };
        AssertInvalid(RequestSchema, Utf8(request));

        var response = GoldenObject("provider-response.valid.json");
        response["result"]!["nested"] = new JsonObject
        {
            [forbiddenName] = "must-not-cross",
        };
        AssertInvalid(ResponseSchema, Utf8(response));
    }

    [Fact]
    public void RequestContextAndHintsAreValidatedValuesRatherThanAuthorityObjects()
    {
        AssertInvalid(RequestSchema, MutateGolden("provider-request.valid.json", root =>
            root["context"]!["itemId"] = "not-a-guid"));
        AssertInvalid(RequestSchema, MutateGolden("provider-request.valid.json", root =>
            root["context"]!["surface"] = "/Items/123"));
        AssertInvalid(RequestSchema, MutateGolden("provider-request.valid.json", root =>
            root["hints"]!["locale"] = "../../etc"));
        AssertInvalid(RequestSchema, MutateGolden("provider-request.valid.json", root =>
            root["attribution"]!["user"] = "bearer token"));
    }

    private static void AssertExactDocumentBoundary(JsonDocument schema, string fixtureName, int maximumBytes)
    {
        var fixture = File.ReadAllBytes(ContractPath(Path.Combine("fixtures", fixtureName)));
        Assert.True(fixture.Length < maximumBytes);
        var exact = new byte[maximumBytes];
        fixture.CopyTo(exact, 0);
        Array.Fill(exact, (byte)' ', fixture.Length, exact.Length - fixture.Length);

        AssertValid(schema, exact);
        AssertInvalid(schema, exact.Append((byte)' ').ToArray());
    }

    private static void AssertRequestSpecificBounds(JsonElement properties)
    {
        Assert.Equal(
            PlatformProviderAbiContract.MaximumGrantedScopes,
            properties.GetProperty("grantedScopes").GetProperty("maxItems").GetInt32());

        var attribution = properties.GetProperty("attribution").GetProperty("properties");
        Assert.Equal(
            PlatformProviderAbiContract.MaximumIdentifierBytes,
            attribution.GetProperty("user").GetProperty("x-canopy-maximum-utf8-bytes").GetInt32());
        Assert.Equal(
            PlatformProviderAbiContract.MaximumIdentifierBytes,
            attribution.GetProperty("device").GetProperty("x-canopy-maximum-utf8-bytes").GetInt32());

        var hints = properties.GetProperty("hints").GetProperty("properties");
        Assert.Equal(
            PlatformProviderAbiContract.MaximumLocaleBytes,
            hints.GetProperty("locale").GetProperty("x-canopy-maximum-utf8-bytes").GetInt32());
        Assert.Equal(
            PlatformProviderAbiContract.MaximumAccessibilityHints,
            hints.GetProperty("accessibility").GetProperty("maxItems").GetInt32());
        Assert.Equal(
            PlatformProviderAbiContract.MaximumRemainingDeadlineMilliseconds,
            properties.GetProperty("remainingDeadlineMilliseconds").GetProperty("maximum").GetInt32());
    }

    private static JsonObject NestedObject(int nestedContainerCount)
    {
        var root = new JsonObject();
        var current = root;
        for (var index = 1; index < nestedContainerCount; index++)
        {
            var child = new JsonObject();
            current["child"] = child;
            current = child;
        }

        current["value"] = true;
        return root;
    }

    private static JsonObject ObjectWithProperties(int count)
    {
        var result = new JsonObject();
        for (var index = 0; index < count; index++)
        {
            result[$"property{index}"] = index;
        }

        return result;
    }

    private static JsonArray IdentifierArray(string prefix, int count)
        => new(Enumerable.Range(0, count).Select(index => JsonValue.Create($"{prefix}{index}")).ToArray());

    private static byte[] MutateGolden(string fixtureName, Action<JsonObject> mutation)
    {
        var root = GoldenObject(fixtureName);
        mutation(root);
        return Utf8(root);
    }

    private static JsonObject GoldenObject(string fixtureName)
        => JsonNode.Parse(File.ReadAllText(ContractPath(Path.Combine("fixtures", fixtureName))))!.AsObject();

    private static byte[] Utf8(JsonNode node) => Encoding.UTF8.GetBytes(node.ToJsonString());

    private static void AssertValid(JsonDocument schema, byte[] json)
        => Assert.True(EnvelopeSchemaValidator.IsValid(schema.RootElement, json, out var failure), failure);

    private static void AssertInvalid(JsonDocument schema, byte[] json)
        => Assert.False(EnvelopeSchemaValidator.IsValid(schema.RootElement, json, out _));

    private static JsonDocument ReadSchema(string name)
        => JsonDocument.Parse(File.ReadAllText(ContractPath(name)));

    private static byte[] ContractBytes(string name) => File.ReadAllBytes(ContractPath(name));

    private static IReadOnlyList<string> ProviderAbiContractDrift(
        byte[] requestSchema,
        byte[] responseSchema,
        byte[] requestGolden,
        byte[] responseGolden)
    {
        var frozen = Frozen.RootElement.GetProperty("providerAbi");
        var drift = new List<string>();
        AddIf(
            frozen.GetProperty("entrypointTypeName").GetString()
                != PlatformProviderAbiContract.EntrypointTypeName
            || frozen.GetProperty("invocationMethodName").GetString()
                != PlatformProviderAbiContract.InvocationMethodName
            || frozen.GetProperty("invocationSignature").GetString()
                != PlatformProviderAbiContract.InvocationSignature,
            "provider ABI convention changed");
        AddIf(
            frozen.GetProperty("requestEnvelopeSchemaId").GetString()
                != PlatformProviderAbiContract.RequestEnvelopeSchemaId,
            "request envelope schema id changed");
        AddIf(
            frozen.GetProperty("responseEnvelopeSchemaId").GetString()
                != PlatformProviderAbiContract.ResponseEnvelopeSchemaId,
            "response envelope schema id changed");
        AddIf(
            frozen.GetProperty("requestEnvelopeSchemaSha256").GetString() != Hash(requestSchema),
            "request envelope schema changed");
        AddIf(
            frozen.GetProperty("responseEnvelopeSchemaSha256").GetString() != Hash(responseSchema),
            "response envelope schema changed");
        AddIf(
            frozen.GetProperty("requestGoldenSha256").GetString() != Hash(requestGolden),
            "request envelope golden changed");
        AddIf(
            frozen.GetProperty("responseGoldenSha256").GetString() != Hash(responseGolden),
            "response envelope golden changed");
        return drift;

        void AddIf(bool condition, string value)
        {
            if (condition)
            {
                drift.Add(value);
            }
        }

        static string Hash(byte[] value) => Convert.ToHexString(SHA256.HashData(value)).ToLowerInvariant();
    }

    private static bool ResponseMatchesRequest(byte[] requestJson, byte[] responseJson)
    {
        using var request = JsonDocument.Parse(requestJson);
        using var response = JsonDocument.Parse(responseJson);
        return string.Equals(
                request.RootElement.GetProperty("correlationId").GetString(),
                response.RootElement.GetProperty("correlationId").GetString(),
                StringComparison.Ordinal)
            && request.RootElement.GetProperty("protocol").GetInt32()
                == response.RootElement.GetProperty("protocol").GetInt32();
    }

    private static string ContractPath(string relativePath)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            var candidate = Path.Combine(directory.FullName, "contracts", "platform", "v1", relativePath);
            if (File.Exists(candidate))
            {
                return candidate;
            }

            directory = directory.Parent;
        }

        throw new DirectoryNotFoundException("Could not find contracts/platform/v1 from the test output.");
    }

    /// <summary>
    /// Executes the deliberately small JSON-Schema subset used by these two authored
    /// envelopes, including Canopy's global byte/depth/cardinality and forbidden-name
    /// extensions. The production invocation validator is a later EP-04 slice.
    /// </summary>
    private static class EnvelopeSchemaValidator
    {
        internal static bool IsValid(JsonElement schema, byte[] utf8Json, out string failure)
        {
            failure = string.Empty;
            var maximumBytes = schema.GetProperty("x-canopy-maximum-document-bytes").GetInt32();
            if (utf8Json.Length == 0 || utf8Json.Length > maximumBytes)
            {
                failure = "document bytes";
                return false;
            }

            JsonDocument document;
            try
            {
                document = JsonDocument.Parse(
                    utf8Json,
                    new JsonDocumentOptions
                    {
                        AllowTrailingCommas = false,
                        CommentHandling = JsonCommentHandling.Disallow,
                        MaxDepth = schema.GetProperty("x-canopy-maximum-json-depth").GetInt32(),
                    });
            }
            catch (JsonException exception)
            {
                failure = exception.Message;
                return false;
            }

            using (document)
            {
                var limits = Limits.FromSchema(schema);
                return Validate(document.RootElement, schema, limits, "$", out failure);
            }
        }

        private static bool Validate(
            JsonElement value,
            JsonElement? schema,
            Limits limits,
            string path,
            out string failure)
        {
            failure = string.Empty;
            if (!ValidateGlobal(value, limits, path, out failure))
            {
                return false;
            }

            if (schema is null)
            {
                return ValidateChildrenWithoutSchema(value, limits, path, out failure);
            }

            var expectedType = schema.Value.TryGetProperty("type", out var type)
                ? type.GetString()
                : null;
            if (!TypeMatches(value, expectedType))
            {
                failure = $"{path} type";
                return false;
            }

            if (schema.Value.TryGetProperty("const", out var expected)
                && !JsonElement.DeepEquals(value, expected))
            {
                failure = $"{path} const";
                return false;
            }

            if (schema.Value.TryGetProperty("enum", out var allowed)
                && !allowed.EnumerateArray().Any(candidate => JsonElement.DeepEquals(value, candidate)))
            {
                failure = $"{path} enum";
                return false;
            }

            if (schema.Value.TryGetProperty("not", out var notSchema)
                && notSchema.TryGetProperty("const", out var forbidden)
                && JsonElement.DeepEquals(value, forbidden))
            {
                failure = $"{path} forbidden const";
                return false;
            }

            return value.ValueKind switch
            {
                JsonValueKind.Object => ValidateObject(value, schema.Value, limits, path, out failure),
                JsonValueKind.Array => ValidateArray(value, schema.Value, limits, path, out failure),
                JsonValueKind.String => ValidateString(value.GetString()!, schema.Value, path, out failure),
                JsonValueKind.Number => ValidateInteger(value, schema.Value, path, out failure),
                _ => true,
            };
        }

        private static bool ValidateGlobal(JsonElement value, Limits limits, string path, out string failure)
        {
            failure = string.Empty;
            if (value.ValueKind == JsonValueKind.String
                && Encoding.UTF8.GetByteCount(value.GetString()!) > limits.MaximumStringBytes)
            {
                failure = $"{path} global string bytes";
                return false;
            }

            if (value.ValueKind == JsonValueKind.Array
                && value.GetArrayLength() > limits.MaximumCollectionItems)
            {
                failure = $"{path} global collection items";
                return false;
            }

            if (value.ValueKind != JsonValueKind.Object)
            {
                return true;
            }

            var names = new HashSet<string>(StringComparer.Ordinal);
            var propertyCount = 0;
            foreach (var property in value.EnumerateObject())
            {
                propertyCount++;
                if (!names.Add(property.Name))
                {
                    failure = $"{path} duplicate property {property.Name}";
                    return false;
                }

                if (Encoding.UTF8.GetByteCount(property.Name) > limits.MaximumPropertyNameBytes)
                {
                    failure = $"{path} property name bytes";
                    return false;
                }

                if (limits.ForbiddenPropertyNames.Contains(property.Name))
                {
                    failure = $"{path} forbidden property {property.Name}";
                    return false;
                }
            }

            if (propertyCount > limits.MaximumObjectProperties)
            {
                failure = $"{path} global object properties";
                return false;
            }

            return true;
        }

        private static bool ValidateChildrenWithoutSchema(
            JsonElement value,
            Limits limits,
            string path,
            out string failure)
        {
            if (value.ValueKind == JsonValueKind.Object)
            {
                foreach (var property in value.EnumerateObject())
                {
                    if (!Validate(property.Value, null, limits, $"{path}.{property.Name}", out failure))
                    {
                        return false;
                    }
                }
            }
            else if (value.ValueKind == JsonValueKind.Array)
            {
                var index = 0;
                foreach (var item in value.EnumerateArray())
                {
                    if (!Validate(item, null, limits, $"{path}[{index}]", out failure))
                    {
                        return false;
                    }

                    index++;
                }
            }

            failure = string.Empty;
            return true;
        }

        private static bool ValidateObject(
            JsonElement value,
            JsonElement schema,
            Limits limits,
            string path,
            out string failure)
        {
            if (schema.TryGetProperty("maxProperties", out var maximum)
                && value.EnumerateObject().Count() > maximum.GetInt32())
            {
                failure = $"{path} maxProperties";
                return false;
            }

            if (schema.TryGetProperty("required", out var required))
            {
                foreach (var property in required.EnumerateArray())
                {
                    if (!value.TryGetProperty(property.GetString()!, out _))
                    {
                        failure = $"{path} missing {property.GetString()}";
                        return false;
                    }
                }
            }

            var hasProperties = schema.TryGetProperty("properties", out var properties);
            var allowAdditional = !schema.TryGetProperty("additionalProperties", out var additional)
                || additional.GetBoolean();
            foreach (var property in value.EnumerateObject())
            {
                JsonElement? propertySchema = null;
                if (hasProperties && properties.TryGetProperty(property.Name, out var declared))
                {
                    propertySchema = declared;
                }
                else if (!allowAdditional)
                {
                    failure = $"{path} unknown {property.Name}";
                    return false;
                }

                if (!Validate(property.Value, propertySchema, limits, $"{path}.{property.Name}", out failure))
                {
                    return false;
                }
            }

            failure = string.Empty;
            return true;
        }

        private static bool ValidateArray(
            JsonElement value,
            JsonElement schema,
            Limits limits,
            string path,
            out string failure)
        {
            var length = value.GetArrayLength();
            if ((schema.TryGetProperty("minItems", out var minimum) && length < minimum.GetInt32())
                || (schema.TryGetProperty("maxItems", out var maximum) && length > maximum.GetInt32()))
            {
                failure = $"{path} array length";
                return false;
            }

            if (schema.TryGetProperty("uniqueItems", out var unique) && unique.GetBoolean())
            {
                var seen = new HashSet<string>(StringComparer.Ordinal);
                foreach (var item in value.EnumerateArray())
                {
                    if (!seen.Add(item.GetRawText()))
                    {
                        failure = $"{path} duplicate item";
                        return false;
                    }
                }
            }

            JsonElement? itemSchema = schema.TryGetProperty("items", out var items) ? items : null;
            var index = 0;
            foreach (var item in value.EnumerateArray())
            {
                if (!Validate(item, itemSchema, limits, $"{path}[{index}]", out failure))
                {
                    return false;
                }

                index++;
            }

            failure = string.Empty;
            return true;
        }

        private static bool ValidateString(string value, JsonElement schema, string path, out string failure)
        {
            var characterCount = value.EnumerateRunes().Count();
            if ((schema.TryGetProperty("minLength", out var minimum) && characterCount < minimum.GetInt32())
                || (schema.TryGetProperty("maxLength", out var maximum) && characterCount > maximum.GetInt32())
                || (schema.TryGetProperty("x-canopy-maximum-utf8-bytes", out var byteMaximum)
                    && Encoding.UTF8.GetByteCount(value) > byteMaximum.GetInt32()))
            {
                failure = $"{path} string length";
                return false;
            }

            if (schema.TryGetProperty("pattern", out var pattern)
                && !Regex.IsMatch(value, pattern.GetString()!, RegexOptions.CultureInvariant))
            {
                failure = $"{path} pattern";
                return false;
            }

            failure = string.Empty;
            return true;
        }

        private static bool ValidateInteger(JsonElement value, JsonElement schema, string path, out string failure)
        {
            if (!value.TryGetInt64(out var integer)
                || (schema.TryGetProperty("minimum", out var minimum) && integer < minimum.GetInt64())
                || (schema.TryGetProperty("maximum", out var maximum) && integer > maximum.GetInt64()))
            {
                failure = $"{path} integer bound";
                return false;
            }

            failure = string.Empty;
            return true;
        }

        private static bool TypeMatches(JsonElement value, string? expectedType)
            => expectedType switch
            {
                null => true,
                "object" => value.ValueKind == JsonValueKind.Object,
                "array" => value.ValueKind == JsonValueKind.Array,
                "string" => value.ValueKind == JsonValueKind.String,
                "integer" => value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out _),
                "boolean" => value.ValueKind is JsonValueKind.True or JsonValueKind.False,
                _ => false,
            };

        private sealed record Limits(
            int MaximumCollectionItems,
            int MaximumObjectProperties,
            int MaximumPropertyNameBytes,
            int MaximumStringBytes,
            HashSet<string> ForbiddenPropertyNames)
        {
            internal static Limits FromSchema(JsonElement schema)
                => new(
                    schema.GetProperty("x-canopy-maximum-collection-items").GetInt32(),
                    schema.GetProperty("x-canopy-maximum-object-properties").GetInt32(),
                    schema.GetProperty("x-canopy-maximum-property-name-utf8-bytes").GetInt32(),
                    schema.GetProperty("x-canopy-maximum-string-utf8-bytes").GetInt32(),
                    schema.GetProperty("x-canopy-forbidden-property-names")
                        .EnumerateArray()
                        .Select(value => value.GetString()!)
                        .ToHashSet(StringComparer.OrdinalIgnoreCase));
        }
    }
}
