using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

public sealed class PlatformProviderJsonPayloadValidatorTests
{
    private const string CorrelationId = "01J00000000000000000000000";
    private const string ItemId = "01234567-89ab-cdef-0123-456789abcdef";

    [Fact]
    public void AlphaRequestBuildsTheFrozenEnvelopeAndReturnsOwnedJson()
    {
        using var schema = AlphaRequestSchema();
        using var input = JsonDocument.Parse("{\"name\":\"Canopy\"}");

        var result = PlatformProviderJsonPayloadValidator.BuildRequest(
            Values(input.RootElement),
            schema.RootElement);

        Assert.Equal(PlatformProviderRequestPayloadValidationStatus.Succeeded, result.Status);
        using var envelope = JsonDocument.Parse(Assert.IsType<string>(result.RequestJson));
        var root = envelope.RootElement;
        Assert.Equal(1, root.GetProperty("schemaVersion").GetInt32());
        Assert.Equal(CorrelationId, root.GetProperty("correlationId").GetString());
        Assert.Equal(1, root.GetProperty("protocol").GetInt32());
        Assert.Equal("jellyfin.canopy.items.lookup", root.GetProperty("grantedScopes")[0].GetString());
        Assert.Equal("user-1", root.GetProperty("attribution").GetProperty("user").GetString());
        Assert.Equal(ItemId, root.GetProperty("context").GetProperty("itemId").GetString());
        Assert.Equal("Canopy", root.GetProperty("input").GetProperty("name").GetString());
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"name\":1}")]
    [InlineData("{\"name\":\"Canopy\",\"extra\":true}")]
    public void AlphaRequestSchemaFailuresNeverExposePartialJson(string inputJson)
    {
        using var schema = AlphaRequestSchema();
        using var input = JsonDocument.Parse(inputJson);

        var result = PlatformProviderJsonPayloadValidator.BuildRequest(
            Values(input.RootElement),
            schema.RootElement);

        Assert.Equal(
            PlatformProviderRequestPayloadValidationStatus.RequestSchemaRejected,
            result.Status);
        Assert.Null(result.RequestJson);
    }

    [Theory]
    [InlineData("{\"token\":\"forbidden\"}")]
    [InlineData("{\"nested\":{\"AuThOrItY\":true}}")]
    [InlineData("{\"duplicate\":1,\"duplicate\":2}")]
    public void RequestStructuralFailuresAreInvalidRequest(string inputJson)
    {
        using var schema = PermissiveObjectSchema();
        using var input = JsonDocument.Parse(inputJson);

        var result = PlatformProviderJsonPayloadValidator.BuildRequest(
            Values(input.RootElement),
            schema.RootElement);

        Assert.Equal(PlatformProviderRequestPayloadValidationStatus.InvalidRequest, result.Status);
        Assert.Null(result.RequestJson);
    }

    [Fact]
    public void InvalidHostProjectionIsRejectedBeforeSerialization()
    {
        using var schema = AlphaRequestSchema();
        using var input = JsonDocument.Parse("{\"name\":\"Canopy\"}");
        var values = new PlatformProviderRequestEnvelopeValues(
            CorrelationId,
            1,
            new[] { "jellyfin.canopy.items.lookup" },
            "invalid user",
            "device-1",
            ItemId,
            "details",
            "en-AU",
            Array.Empty<string>(),
            2_500,
            input.RootElement);

        var result = PlatformProviderJsonPayloadValidator.BuildRequest(values, schema.RootElement);

        Assert.Equal(PlatformProviderRequestPayloadValidationStatus.InvalidRequest, result.Status);
    }

    [Theory]
    [InlineData("", false)]
    [InlineData("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", true)]
    [InlineData("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", false)]
    [InlineData("😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀", true)]
    [InlineData("😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀", false)]
    public void AlphaStringSchemaCountsRunesAndUtf8Bytes(string name, bool valid)
    {
        using var schema = AlphaRequestSchema();
        using var input = JsonDocument.Parse("{\"name\":" + JsonSerializer.Serialize(name) + "}");

        var result = PlatformProviderJsonPayloadValidator.BuildRequest(
            Values(input.RootElement),
            schema.RootElement);

        Assert.Equal(
            valid
                ? PlatformProviderRequestPayloadValidationStatus.Succeeded
                : PlatformProviderRequestPayloadValidationStatus.RequestSchemaRejected,
            result.Status);
    }

    [Fact]
    public void RequestDocumentByteLimitIsEnforcedByTheBoundedWriter()
    {
        using var schema = PermissiveObjectSchema();
        using var emptyInput = InputWithStringBytes(0);
        var baseline = PlatformProviderJsonPayloadValidator.BuildRequest(
            Values(emptyInput.RootElement),
            schema.RootElement);
        var baselineBytes = Encoding.UTF8.GetByteCount(Assert.IsType<string>(baseline.RequestJson));
        var fillerBytes = PlatformProviderAbiContract.MaximumRequestDocumentBytes - baselineBytes;
        using var exactInput = InputWithStringBytes(fillerBytes);
        using var oversizedInput = InputWithStringBytes(fillerBytes + 1);

        var exact = PlatformProviderJsonPayloadValidator.BuildRequest(
            Values(exactInput.RootElement),
            schema.RootElement);
        var oversized = PlatformProviderJsonPayloadValidator.BuildRequest(
            Values(oversizedInput.RootElement),
            schema.RootElement);

        Assert.Equal(PlatformProviderRequestPayloadValidationStatus.Succeeded, exact.Status);
        Assert.Equal(
            PlatformProviderAbiContract.MaximumRequestDocumentBytes,
            Encoding.UTF8.GetByteCount(Assert.IsType<string>(exact.RequestJson)));
        Assert.Equal(
            PlatformProviderRequestPayloadValidationStatus.InvalidRequest,
            oversized.Status);
        Assert.Null(oversized.RequestJson);
    }

    [Fact]
    public void AlphaResponseValidatesEchoAndReturnsAClone()
    {
        using var schema = AlphaResponseSchema();

        var result = PlatformProviderJsonPayloadValidator.ValidateResponse(
            AlphaResponse(),
            CorrelationId,
            1,
            schema.RootElement);

        Assert.Equal(PlatformProviderResponsePayloadValidationStatus.Succeeded, result.Status);
        Assert.Equal("Hello, Canopy.", result.Result!.Value.GetProperty("message").GetString());
    }

    [Theory]
    [InlineData(null, (int)PlatformProviderResponsePayloadValidationStatus.ResponseMissing)]
    [InlineData("", (int)PlatformProviderResponsePayloadValidationStatus.ResponseInvalidJson)]
    [InlineData("{} trailing", (int)PlatformProviderResponsePayloadValidationStatus.ResponseInvalidJson)]
    [InlineData("{\"schemaVersion\":1,\"schemaVersion\":1,\"correlationId\":\"01J00000000000000000000000\",\"protocol\":1,\"result\":{}}", (int)PlatformProviderResponsePayloadValidationStatus.ResponseInvalidJson)]
    public void MissingAndMalformedResponsesHaveStableOutcomes(
        string? response,
        int expectedValue)
    {
        using var schema = PermissiveObjectSchema();

        var result = PlatformProviderJsonPayloadValidator.ValidateResponse(
            response,
            CorrelationId,
            1,
            schema.RootElement);

        Assert.Equal((PlatformProviderResponsePayloadValidationStatus)expectedValue, result.Status);
        Assert.Null(result.Result);
    }

    [Theory]
    [InlineData("other-correlation", 1)]
    [InlineData("01J00000000000000000000000", 2)]
    public void ResponseEchoMismatchIsRejected(string correlationId, int protocol)
    {
        using var schema = PermissiveObjectSchema();
        var response = "{\"schemaVersion\":1,\"correlationId\":\""
            + correlationId
            + "\",\"protocol\":"
            + protocol
            + ",\"result\":{}}";

        var result = PlatformProviderJsonPayloadValidator.ValidateResponse(
            response,
            CorrelationId,
            1,
            schema.RootElement);

        Assert.Equal(
            PlatformProviderResponsePayloadValidationStatus.ResponseEnvelopeMismatch,
            result.Status);
        Assert.Null(result.Result);
    }

    [Theory]
    [MemberData(nameof(GlobalBoundResponses))]
    public void EveryGlobalBoundAcceptsMaxAndRejectsMaxPlusOne(string response, bool valid)
    {
        using var schema = PermissiveObjectSchema();

        var result = PlatformProviderJsonPayloadValidator.ValidateResponse(
            response,
            CorrelationId,
            1,
            schema.RootElement);

        Assert.Equal(
            valid
                ? PlatformProviderResponsePayloadValidationStatus.Succeeded
                : PlatformProviderResponsePayloadValidationStatus.ResponseEnvelopeMismatch,
            result.Status);
    }

    [Fact]
    public void ExactDocumentByteLimitIsAcceptedAndMaxPlusOneIsTooLarge()
    {
        using var schema = PermissiveObjectSchema();
        var response = ResponseWithResult("{}");
        var exact = response + new string(
            ' ',
            PlatformProviderAbiContract.MaximumResponseDocumentBytes
                - Encoding.UTF8.GetByteCount(response));

        var accepted = PlatformProviderJsonPayloadValidator.ValidateResponse(
            exact,
            CorrelationId,
            1,
            schema.RootElement);
        var rejected = PlatformProviderJsonPayloadValidator.ValidateResponse(
            exact + " ",
            CorrelationId,
            1,
            schema.RootElement);

        Assert.Equal(PlatformProviderResponsePayloadValidationStatus.Succeeded, accepted.Status);
        Assert.Equal(
            PlatformProviderResponsePayloadValidationStatus.ResponseTooLarge,
            rejected.Status);
    }

    [Fact]
    public void InvalidUtf16CannotCrossTheStrictUtf8Boundary()
    {
        using var schema = PermissiveObjectSchema();
        var response = ResponseWithResult("{\"value\":\"\ud800\"}");

        var result = PlatformProviderJsonPayloadValidator.ValidateResponse(
            response,
            CorrelationId,
            1,
            schema.RootElement);

        Assert.Equal(
            PlatformProviderResponsePayloadValidationStatus.ResponseInvalidJson,
            result.Status);
    }

    [Fact]
    public void EscapedUnpairedSurrogateCannotCrossTheJsonBoundary()
    {
        using var schema = PermissiveObjectSchema();
        var response = ResponseWithResult("""{"value":"\ud800"}""");

        var result = PlatformProviderJsonPayloadValidator.ValidateResponse(
            response,
            CorrelationId,
            1,
            schema.RootElement);

        Assert.Equal(
            PlatformProviderResponsePayloadValidationStatus.ResponseInvalidJson,
            result.Status);
        Assert.Null(result.Result);
    }

    [Theory]
    [InlineData("{\"message\":1}")]
    [InlineData("{\"message\":\"Hello, Canopy.\",\"extra\":true}")]
    public void AlphaResponseSchemaFailuresDiscardTheResult(string operationResult)
    {
        using var schema = AlphaResponseSchema();

        var result = PlatformProviderJsonPayloadValidator.ValidateResponse(
            ResponseWithResult(operationResult),
            CorrelationId,
            1,
            schema.RootElement);

        Assert.Equal(
            PlatformProviderResponsePayloadValidationStatus.ResponseSchemaRejected,
            result.Status);
        Assert.Null(result.Result);
    }

    [Theory]
    [InlineData("pattern", "\".*\"")]
    [InlineData("$ref", "\"#\"")]
    [InlineData("type", "\"number\"")]
    [InlineData("additionalProperties", "{}")]
    public void UnsupportedOrMalformedSchemaSemanticsFailClosed(string keyword, string value)
    {
        using var schema = JsonDocument.Parse($$"""
            {
              "$schema":"https://json-schema.org/draft/2020-12/schema",
              "$id":"urn:test:unsupported",
              "type":"object",
              "{{keyword}}":{{value}}
            }
            """);

        var result = PlatformProviderJsonPayloadValidator.ValidateResponse(
            ResponseWithResult("{}"),
            CorrelationId,
            1,
            schema.RootElement);

        Assert.Equal(
            PlatformProviderResponsePayloadValidationStatus.ResponseSchemaRejected,
            result.Status);
        Assert.Null(result.Result);
    }

    public static TheoryData<string, bool> GlobalBoundResponses()
    {
        var data = new TheoryData<string, bool>();
        data.Add(ResponseWithResult("{\"value\":\"" + new string('s', 4_096) + "\"}"), true);
        data.Add(ResponseWithResult("{\"value\":\"" + new string('s', 4_097) + "\"}"), false);
        data.Add(ResponseWithResult(ArrayProperty("items", 64)), true);
        data.Add(ResponseWithResult(ArrayProperty("items", 65)), false);
        data.Add(ResponseWithResult(ObjectWithProperties(64)), true);
        data.Add(ResponseWithResult(ObjectWithProperties(65)), false);
        data.Add(ResponseWithResult("{\"" + new string('p', 256) + "\":true}"), true);
        data.Add(ResponseWithResult("{\"" + new string('p', 257) + "\":true}"), false);
        data.Add(ResponseWithResult(NestedObject(10)), true);
        data.Add(ResponseWithResult(NestedObject(11)), false);
        data.Add(ResponseWithResult("{\"nested\":{\"SeCrEt\":true}}"), false);
        return data;
    }

    private static PlatformProviderRequestEnvelopeValues Values(JsonElement input) => new(
        CorrelationId,
        1,
        new[] { "jellyfin.canopy.items.lookup" },
        "user-1",
        "device-1",
        ItemId,
        "details",
        "en-AU",
        new[] { "reduced-motion" },
        2_500,
        input);

    private static JsonDocument AlphaRequestSchema() => JsonDocument.Parse("""
        {
          "$schema":"https://json-schema.org/draft/2020-12/schema",
          "$id":"urn:jellyfin-canopy:conformance:alpha:v1:hello-request",
          "title":"Alpha Hello request",
          "type":"object",
          "additionalProperties":false,
          "required":["name"],
          "properties":{"name":{"type":"string","minLength":1,"maxLength":64,"x-canopy-maximum-utf8-bytes":64}}
        }
        """);

    private static JsonDocument AlphaResponseSchema() => JsonDocument.Parse("""
        {
          "$schema":"https://json-schema.org/draft/2020-12/schema",
          "$id":"urn:jellyfin-canopy:conformance:alpha:v1:hello-response",
          "title":"Alpha Hello response",
          "type":"object",
          "additionalProperties":false,
          "required":["message"],
          "properties":{"message":{"type":"string","minLength":1,"maxLength":72,"x-canopy-maximum-utf8-bytes":72}}
        }
        """);

    private static JsonDocument PermissiveObjectSchema() => JsonDocument.Parse("""
        {
          "$schema":"https://json-schema.org/draft/2020-12/schema",
          "$id":"urn:test:permissive-object",
          "type":"object",
          "additionalProperties":true
        }
        """);

    private static JsonDocument InputWithStringBytes(int totalStringBytes)
    {
        const int propertyCount = 16;
        const int perStringMaximum = 4_096;
        if (totalStringBytes < 0 || totalStringBytes > propertyCount * perStringMaximum)
        {
            throw new ArgumentOutOfRangeException(nameof(totalStringBytes));
        }

        var remaining = totalStringBytes;
        var builder = new StringBuilder("{");
        for (var index = 0; index < propertyCount; index++)
        {
            if (index > 0)
            {
                builder.Append(',');
            }

            var count = Math.Min(remaining, perStringMaximum);
            remaining -= count;
            builder.Append('"').Append('p').Append(index).Append("\":\"");
            builder.Append('s', count).Append('"');
        }

        builder.Append('}');
        return JsonDocument.Parse(builder.ToString());
    }

    private static string AlphaResponse() => ResponseWithResult("{\"message\":\"Hello, Canopy.\"}");

    private static string ResponseWithResult(string result) =>
        "{\"schemaVersion\":1,\"correlationId\":\""
        + CorrelationId
        + "\",\"protocol\":1,\"result\":"
        + result
        + "}";

    private static string ArrayProperty(string name, int count) =>
        "{\"" + name + "\":[" + string.Join(',', Enumerable.Repeat("0", count)) + "]}";

    private static string ObjectWithProperties(int count) =>
        "{" + string.Join(',', Enumerable.Range(0, count).Select(index => $"\"p{index}\":0")) + "}";

    // The response/result wrappers consume two of the frozen twelve container levels.
    private static string NestedObject(int nestedLevels)
    {
        var builder = new StringBuilder();
        for (var index = 0; index < nestedLevels; index++)
        {
            builder.Append("{\"n\":");
        }

        builder.Append("{}");
        for (var index = 0; index < nestedLevels; index++)
        {
            builder.Append('}');
        }

        return builder.ToString();
    }
}
