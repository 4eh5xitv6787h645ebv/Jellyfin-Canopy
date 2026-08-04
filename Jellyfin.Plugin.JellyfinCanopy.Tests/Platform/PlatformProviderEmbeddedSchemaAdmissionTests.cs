using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

public sealed class PlatformProviderEmbeddedSchemaAdmissionTests
{
    private const string RequestId =
        "urn:jellyfin-canopy:provider-schema:org.example:hello:request:1";
    private const string ResponseId =
        "urn:jellyfin-canopy:provider-schema:org.example:hello:response:1";

    [Fact]
    public void StatusBoundsAndImmutablePublishedShapesAreExact()
    {
        Assert.Equal(
            new[]
            {
                "Admitted", "InvalidInput", "SchemaMissing", "SchemaResourceAmbiguous",
                "SchemaReadFailed", "SchemaTooLarge", "SchemaHashMismatch",
                "SchemaInvalidUtf8", "SchemaInvalidJson", "SchemaBoundsExceeded",
                "SchemaIdentityMismatch", "SchemaDialectUnsupported",
                "SchemaExternalReference", "SchemaVocabularyUnsupported",
            },
            Enum.GetNames<PlatformProviderEmbeddedSchemaAdmissionStatus>());
        Assert.Equal(
            Enumerable.Range(0, 14),
            Enum.GetValues<PlatformProviderEmbeddedSchemaAdmissionStatus>()
                .Select(value => (int)value));

        Assert.Equal(64 * 1024, PlatformProviderEmbeddedSchemaAdmission.MaximumDocumentBytes);
        Assert.Equal(12, PlatformProviderEmbeddedSchemaAdmission.MaximumJsonDepth);
        Assert.Equal(64, PlatformProviderEmbeddedSchemaAdmission.MaximumObjectProperties);
        Assert.Equal(64, PlatformProviderEmbeddedSchemaAdmission.MaximumArrayItems);
        Assert.Equal(256, PlatformProviderEmbeddedSchemaAdmission.MaximumPropertyNameBytes);
        Assert.Equal(4 * 1024, PlatformProviderEmbeddedSchemaAdmission.MaximumStringBytes);
        Assert.Equal(1024, PlatformProviderEmbeddedSchemaAdmission.MaximumResourceCount);
        Assert.Equal(512, PlatformProviderEmbeddedSchemaAdmission.MaximumResourceNameBytes);
        Assert.Equal(
            "https://json-schema.org/draft/2020-12/schema",
            PlatformProviderEmbeddedSchemaAdmission.JsonSchemaDialect);

        AssertImmutable(
            typeof(PlatformProviderEmbeddedSchemaAdmissionResult),
            new[] { "Schemas", "Status" });
        AssertImmutable(
            typeof(PlatformProviderEmbeddedSchemaPair),
            new[] { "RequestSchema", "ResponseSchema" });
        Assert.DoesNotContain(
            typeof(PlatformProviderEmbeddedSchemaAdmissionResult)
                .GetProperties(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic),
            property => new[]
            {
                "Bytes", "Assembly", "Resource", "Path", "Url", "Exception", "Detail",
            }.Any(token => property.Name.Contains(token, StringComparison.OrdinalIgnoreCase)));

        var admit = typeof(PlatformProviderEmbeddedSchemaAdmission).GetMethod(
            "Admit",
            BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(admit);
        Assert.Equal(
            new[]
            {
                typeof(Assembly), typeof(string), typeof(string), typeof(string), typeof(string),
            },
            admit!.GetParameters().Select(parameter => parameter.ParameterType));
    }

    [Fact]
    public void ExactPairIsAdmittedAtomicallyAndSurvivesSourceMutation()
    {
        var requestBytes = Schema(RequestId);
        var responseBytes = Schema(ResponseId);
        var assembly = ResourceAssembly.WithSchemas(requestBytes, responseBytes);

        var result = Admit(assembly, RequestId, requestBytes, ResponseId, responseBytes);

        Assert.Equal(PlatformProviderEmbeddedSchemaAdmissionStatus.Admitted, result.Status);
        var pair = Assert.IsType<PlatformProviderEmbeddedSchemaPair>(result.Schemas);
        Array.Fill(requestBytes, (byte)'x');
        Array.Fill(responseBytes, (byte)'y');
        Assert.Equal(RequestId, pair.RequestSchema.GetProperty("$id").GetString());
        Assert.Equal(ResponseId, pair.ResponseSchema.GetProperty("$id").GetString());
        Assert.Equal(JsonValueKind.Object, pair.RequestSchema.ValueKind);
        Assert.Equal(JsonValueKind.Object, pair.ResponseSchema.ValueKind);
        Assert.Equal(2, assembly.OpenCount);
    }

    [Fact]
    public void IndependentAlphaAssemblyAdmitsItsExactSchemasFromACollectibleLoadContext()
    {
        var root = RepositoryRoot();
        var fixtureRoot = Path.Combine(
            root,
            "conformance",
            "platform-providers",
            "Jellyfin.Plugin.CanopyConformance.Alpha");
        using var manifest = JsonDocument.Parse(File.ReadAllBytes(
            Path.Combine(fixtureRoot, "jellyfin-canopy-extension.json")));
        var operation = Assert.Single(
            manifest.RootElement.GetProperty("providerOperations").EnumerateArray());
        var assemblyPath = Path.Combine(
            fixtureRoot,
            "bin",
            "Release",
            "net10.0",
            "Jellyfin.Plugin.CanopyConformance.Alpha.dll");
        var loadContext = new AssemblyLoadContext(
            "provider-schema-admission-alpha",
            isCollectible: true);
        try
        {
            var assembly = loadContext.LoadFromAssemblyPath(assemblyPath);
            Assert.NotSame(
                AssemblyLoadContext.GetLoadContext(typeof(PlatformProviderEmbeddedSchemaAdmission).Assembly),
                AssemblyLoadContext.GetLoadContext(assembly));

            var result = PlatformProviderEmbeddedSchemaAdmission.Admit(
                assembly,
                operation.GetProperty("requestSchemaId").GetString()!,
                operation.GetProperty("requestSchemaSha256").GetString()!,
                operation.GetProperty("responseSchemaId").GetString()!,
                operation.GetProperty("responseSchemaSha256").GetString()!);

            Assert.Equal(PlatformProviderEmbeddedSchemaAdmissionStatus.Admitted, result.Status);
            var pair = Assert.IsType<PlatformProviderEmbeddedSchemaPair>(result.Schemas);
            Assert.Equal(
                operation.GetProperty("requestSchemaId").GetString(),
                pair.RequestSchema.GetProperty("$id").GetString());
            Assert.Equal(
                operation.GetProperty("responseSchemaId").GetString(),
                pair.ResponseSchema.GetProperty("$id").GetString());
        }
        finally
        {
            loadContext.Unload();
        }
    }

    [Fact]
    public void SameDigestIsOpenedAndParsedOnceButStillChecksBothExpectedIds()
    {
        var bytes = Schema(RequestId);
        var digest = Digest(bytes);
        var assembly = ResourceAssembly.WithResource(ResourceName(digest), bytes);

        var admitted = PlatformProviderEmbeddedSchemaAdmission.Admit(
            assembly,
            RequestId,
            digest,
            RequestId,
            digest);
        var mismatched = PlatformProviderEmbeddedSchemaAdmission.Admit(
            assembly,
            RequestId,
            digest,
            ResponseId,
            digest);

        Assert.Equal(PlatformProviderEmbeddedSchemaAdmissionStatus.Admitted, admitted.Status);
        Assert.Equal(
            PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaIdentityMismatch,
            mismatched.Status);
        Assert.Null(mismatched.Schemas);
        Assert.Equal(2, assembly.OpenCount);
    }

    [Fact]
    public void InvalidInputsFailBeforeAssemblyEnumerationOrResourceRead()
    {
        var bytes = Schema(RequestId);
        var digest = Digest(bytes);
        var assembly = ResourceAssembly.WithResource(ResourceName(digest), bytes);

        foreach (var result in new[]
        {
            PlatformProviderEmbeddedSchemaAdmission.Admit(
                assembly, string.Empty, digest, RequestId, digest),
            PlatformProviderEmbeddedSchemaAdmission.Admit(
                assembly, RequestId, digest.ToUpperInvariant(), RequestId, digest),
            PlatformProviderEmbeddedSchemaAdmission.Admit(
                assembly, RequestId, digest[..^1], RequestId, digest),
            PlatformProviderEmbeddedSchemaAdmission.Admit(
                assembly, "urn:invalid:\uD800", digest, RequestId, digest),
            PlatformProviderEmbeddedSchemaAdmission.Admit(
                null!, RequestId, digest, RequestId, digest),
        })
        {
            Assert.Equal(PlatformProviderEmbeddedSchemaAdmissionStatus.InvalidInput, result.Status);
            Assert.Null(result.Schemas);
        }

        Assert.Equal(0, assembly.InventoryCount);
        Assert.Equal(0, assembly.OpenCount);
    }

    [Fact]
    public void MissingAmbiguousInventoryAndReadFailuresAreClosedAndRedacted()
    {
        var bytes = Schema(RequestId);
        var digest = Digest(bytes);
        var name = ResourceName(digest);

        AssertRejected(
            ResourceAssembly.Empty,
            RequestId,
            digest,
            PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaMissing);
        AssertRejected(
            new ResourceAssembly(new[] { name, name }, _ => new MemoryStream(bytes)),
            RequestId,
            digest,
            PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaResourceAmbiguous);
        AssertRejected(
            new ResourceAssembly(new[] { name }, _ => null),
            RequestId,
            digest,
            PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaMissing);
        AssertRejected(
            new ResourceAssembly(new[] { name }, _ => new ThrowingReadStream()),
            RequestId,
            digest,
            PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaReadFailed);
        AssertRejected(
            ResourceAssembly.ThrowingInventory(),
            RequestId,
            digest,
            PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaReadFailed);
        AssertRejected(
            ResourceAssembly.NullInventory(),
            RequestId,
            digest,
            PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaReadFailed);
    }

    [Fact]
    public void ResourceInventoryCountAndNameBytesHaveExactNegativeBoundaries()
    {
        var bytes = Schema(RequestId);
        var digest = Digest(bytes);
        var resourceName = ResourceName(digest);
        var exactNames = Enumerable.Range(
                0,
                PlatformProviderEmbeddedSchemaAdmission.MaximumResourceCount - 1)
            .Select(index => "Fixture.Decoy." + index)
            .Append(resourceName)
            .ToArray();
        var exact = new ResourceAssembly(
            exactNames,
            requested => string.Equals(requested, resourceName, StringComparison.Ordinal)
                ? new MemoryStream(bytes, writable: false)
                : null);
        var over = new ResourceAssembly(
            exactNames.Append("Fixture.Decoy.Over").ToArray(),
            _ => throw new InvalidOperationException("must not open"));

        Assert.Equal(
            PlatformProviderEmbeddedSchemaAdmissionStatus.Admitted,
            AdmitSame(exact, RequestId, digest).Status);
        AssertRejected(
            over,
            RequestId,
            digest,
            PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaBoundsExceeded);
        Assert.Equal(0, over.OpenCount);

        var exactName = new string(
            'n',
            PlatformProviderEmbeddedSchemaAdmission.MaximumResourceNameBytes);
        var longName = exactName + "n";
        AssertRejected(
            new ResourceAssembly(new[] { exactName }, _ => null),
            RequestId,
            digest,
            PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaMissing);
        AssertRejected(
            new ResourceAssembly(new[] { longName }, _ => throw new InvalidOperationException("must not open")),
            RequestId,
            digest,
            PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaBoundsExceeded);
    }

    [Fact]
    public void ReaderAcceptsExactMaximumAndRejectsMaximumPlusOneUsingCapPlusOne()
    {
        var exact = PadWithJsonWhitespace(
            Schema(RequestId),
            PlatformProviderEmbeddedSchemaAdmission.MaximumDocumentBytes);
        var over = PadWithJsonWhitespace(
            Schema(RequestId),
            PlatformProviderEmbeddedSchemaAdmission.MaximumDocumentBytes + 1);
        var exactAssembly = ResourceAssembly.WithResource(
            ResourceName(Digest(exact)),
            exact,
            bytesPerRead: 7);
        var overAssembly = ResourceAssembly.WithResource(
            ResourceName(Digest(over)),
            over,
            bytesPerRead: 7);

        Assert.Equal(
            PlatformProviderEmbeddedSchemaAdmissionStatus.Admitted,
            AdmitSame(exactAssembly, RequestId, Digest(exact)).Status);
        Assert.Equal(
            PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaTooLarge,
            AdmitSame(overAssembly, RequestId, Digest(over)).Status);
        Assert.Equal(
            PlatformProviderEmbeddedSchemaAdmission.MaximumDocumentBytes + 1,
            overAssembly.BytesRead);
    }

    [Fact]
    public void ExactHashIsVerifiedBeforeUtf8AndJsonAdmission()
    {
        var valid = Schema(RequestId);
        var digest = Digest(valid);
        var different = Schema(RequestId, root => root["title"] = "different");
        AssertRejected(
            ResourceAssembly.WithResource(ResourceName(digest), different),
            RequestId,
            digest,
            PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaHashMismatch);

        var invalidUtf8 = valid.Concat(new byte[] { 0xFF }).ToArray();
        AssertRejected(
            ResourceAssembly.WithResource(ResourceName(Digest(invalidUtf8)), invalidUtf8),
            RequestId,
            Digest(invalidUtf8),
            PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaInvalidUtf8);

        var bom = new byte[] { 0xEF, 0xBB, 0xBF }.Concat(valid).ToArray();
        AssertRejected(
            ResourceAssembly.WithResource(ResourceName(Digest(bom)), bom),
            RequestId,
            Digest(bom),
            PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaInvalidUtf8);
    }

    [Fact]
    public void MalformedDuplicateTrailingAndNonObjectJsonAreRejected()
    {
        AssertContentRejected(
            RequestId,
            Encoding.UTF8.GetBytes("{\"$schema\":"),
            PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaInvalidJson);
        AssertContentRejected(
            RequestId,
            Encoding.UTF8.GetBytes(
                "{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\","
                + "\"$id\":\"" + RequestId + "\",\"type\":\"object\",\"type\":\"object\"}"),
            PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaInvalidJson);
        AssertContentRejected(
            RequestId,
            Schema(RequestId).Concat(Encoding.UTF8.GetBytes(" true")).ToArray(),
            PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaInvalidJson);
        AssertContentRejected(
            RequestId,
            Encoding.UTF8.GetBytes("true"),
            PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaInvalidJson);
    }

    [Fact]
    public void IdentityAndDialectMustBeExactAndPairFailurePublishesNothing()
    {
        var request = Schema(RequestId);
        var wrongId = Schema("urn:wrong");
        var wrongDialect = Schema(ResponseId, root =>
            root["$schema"] = "https://json-schema.org/draft/2019-09/schema");

        AssertContentRejected(
            RequestId,
            wrongId,
            PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaIdentityMismatch);
        AssertContentRejected(
            ResponseId,
            wrongDialect,
            PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaDialectUnsupported);

        var assembly = ResourceAssembly.WithSchemas(request, wrongDialect);
        var result = Admit(assembly, RequestId, request, ResponseId, wrongDialect);
        Assert.Equal(
            PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaDialectUnsupported,
            result.Status);
        Assert.Null(result.Schemas);
    }

    [Fact]
    public void DepthPropertyArrayPropertyNameAndStringBoundsHaveExactNegativeBoundaries()
    {
        AssertAdmitted(NestedSchema(RequestId, 11));
        AssertBoundsRejected(NestedSchema(RequestId, 12));

        AssertAdmitted(ObjectPropertySchema(RequestId, 61));
        AssertBoundsRejected(ObjectPropertySchema(RequestId, 62));

        AssertAdmitted(ArrayItemSchema(RequestId, 64));
        AssertBoundsRejected(ArrayItemSchema(RequestId, 65));

        AssertAdmitted(PropertyNameSchema(
            RequestId,
            new string('p', PlatformProviderEmbeddedSchemaAdmission.MaximumPropertyNameBytes)));
        AssertBoundsRejected(PropertyNameSchema(
            RequestId,
            new string('p', PlatformProviderEmbeddedSchemaAdmission.MaximumPropertyNameBytes + 1)));

        AssertAdmitted(StringSchema(
            RequestId,
            new string('s', PlatformProviderEmbeddedSchemaAdmission.MaximumStringBytes)));
        AssertBoundsRejected(StringSchema(
            RequestId,
            new string('s', PlatformProviderEmbeddedSchemaAdmission.MaximumStringBytes + 1)));
    }

    [Fact]
    public void OnlyLocalStaticAndDynamicReferencesAreAdmitted()
    {
        AssertAdmitted(Schema(RequestId, root => root["$ref"] = "#/$defs/local"));
        AssertAdmitted(Schema(RequestId, root => root["$dynamicRef"] = "#node"));
        AssertExternalReference(Schema(RequestId, root => root["$ref"] = "other.json"));
        AssertExternalReference(Schema(RequestId, root => root["$ref"] = "https://example.test/schema"));
        AssertExternalReference(Schema(RequestId, root => root["$dynamicRef"] = "urn:remote"));
        AssertExternalReference(Schema(RequestId, root => root["$ref"] = 1));
    }

    [Fact]
    public void RequiredVocabularyIsClosedAndRecursiveKeywordsAreUnsupported()
    {
        AssertAdmitted(Schema(RequestId, root => root["$vocabulary"] = new JsonObject
        {
            ["https://json-schema.org/draft/2020-12/vocab/core"] = true,
            ["urn:optional-custom"] = false,
        }));
        AssertVocabularyRejected(Schema(RequestId, root => root["$vocabulary"] = new JsonObject
        {
            ["urn:required-custom"] = true,
        }));
        AssertVocabularyRejected(Schema(RequestId, root => root["$vocabulary"] = "invalid"));
        AssertVocabularyRejected(Schema(RequestId, root => root["$recursiveRef"] = "#"));
        AssertVocabularyRejected(Schema(RequestId, root => root["$recursiveAnchor"] = true));
    }

    [Fact]
    public void ProductionOwnerHasNoInvocationPathNetworkFilesystemCacheOrLoggingSurface()
    {
        var source = File.ReadAllText(ProductionSourcePath());
        var code = PlatformHostSeamTests.CodeOnly(source);

        Assert.Contains("GetManifestResourceStream(resourceName)", code, StringComparison.Ordinal);
        Assert.Contains("SHA256.HashData(bytes)", code, StringComparison.Ordinal);
        Assert.Contains("root.Clone()", code, StringComparison.Ordinal);
        foreach (var forbidden in new[]
        {
            "MethodInfo.Invoke", ".Invoke(instance", "InvokeAsync(", "Assembly.Load",
            "LoadFromAssemblyPath", "Activator", "System.Net", "HttpClient", "File.",
            "Directory.", "Path.", "IPluginManager", "LocalPlugin", "IServiceProvider",
            "Controller", "Route(", "IHostedService", "BackgroundService", "Timer",
            "ConcurrentDictionary", "MemoryCache", "ILogger", "Android",
        })
        {
            Assert.DoesNotContain(forbidden, code, StringComparison.OrdinalIgnoreCase);
        }
    }

    private static PlatformProviderEmbeddedSchemaAdmissionResult Admit(
        ResourceAssembly assembly,
        string requestId,
        byte[] request,
        string responseId,
        byte[] response) => PlatformProviderEmbeddedSchemaAdmission.Admit(
            assembly,
            requestId,
            Digest(request),
            responseId,
            Digest(response));

    private static PlatformProviderEmbeddedSchemaAdmissionResult AdmitSame(
        ResourceAssembly assembly,
        string id,
        string digest) => PlatformProviderEmbeddedSchemaAdmission.Admit(
            assembly,
            id,
            digest,
            id,
            digest);

    private static void AssertRejected(
        ResourceAssembly assembly,
        string id,
        string digest,
        PlatformProviderEmbeddedSchemaAdmissionStatus expected)
    {
        var result = AdmitSame(assembly, id, digest);
        Assert.Equal(expected, result.Status);
        Assert.Null(result.Schemas);
    }

    private static void AssertContentRejected(
        string id,
        byte[] bytes,
        PlatformProviderEmbeddedSchemaAdmissionStatus expected) => AssertRejected(
            ResourceAssembly.WithResource(ResourceName(Digest(bytes)), bytes),
            id,
            Digest(bytes),
            expected);

    private static void AssertAdmitted(byte[] bytes) => Assert.Equal(
        PlatformProviderEmbeddedSchemaAdmissionStatus.Admitted,
        AdmitSame(
            ResourceAssembly.WithResource(ResourceName(Digest(bytes)), bytes),
            RequestId,
            Digest(bytes)).Status);

    private static void AssertBoundsRejected(byte[] bytes) => AssertContentRejected(
        RequestId,
        bytes,
        PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaBoundsExceeded);

    private static void AssertExternalReference(byte[] bytes) => AssertContentRejected(
        RequestId,
        bytes,
        PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaExternalReference);

    private static void AssertVocabularyRejected(byte[] bytes) => AssertContentRejected(
        RequestId,
        bytes,
        PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaVocabularyUnsupported);

    private static byte[] Schema(string id, Action<JsonObject>? mutate = null)
    {
        var root = new JsonObject
        {
            ["$schema"] = PlatformProviderEmbeddedSchemaAdmission.JsonSchemaDialect,
            ["$id"] = id,
            ["type"] = "object",
        };
        mutate?.Invoke(root);
        return JsonSerializer.SerializeToUtf8Bytes(root);
    }

    private static byte[] NestedSchema(string id, int nestedObjects) => Schema(id, root =>
    {
        JsonObject current = root;
        for (var index = 0; index < nestedObjects; index++)
        {
            var child = new JsonObject();
            current["x"] = child;
            current = child;
        }
    });

    private static byte[] ObjectPropertySchema(string id, int customProperties) => Schema(id, root =>
    {
        for (var index = 0; index < customProperties; index++)
        {
            root["x" + index] = true;
        }
    });

    private static byte[] ArrayItemSchema(string id, int items) => Schema(id, root =>
        root["x"] = new JsonArray(Enumerable.Range(0, items)
            .Select(index => JsonValue.Create(index))
            .ToArray()));

    private static byte[] PropertyNameSchema(string id, string propertyName) => Schema(id, root =>
        root[propertyName] = true);

    private static byte[] StringSchema(string id, string value) => Schema(id, root =>
        root["x"] = value);

    private static byte[] PadWithJsonWhitespace(byte[] source, int length)
    {
        Assert.True(source.Length <= length);
        var result = new byte[length];
        source.CopyTo(result, 0);
        result.AsSpan(source.Length).Fill((byte)' ');
        return result;
    }

    private static string Digest(byte[] bytes) =>
        Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static string ResourceName(string digest) =>
        PlatformProviderAbiContract.ProviderSchemaResourcePrefix
        + digest
        + PlatformProviderAbiContract.ProviderSchemaResourceSuffix;

    private static void AssertImmutable(Type type, IReadOnlyList<string> properties)
    {
        Assert.True(type.IsSealed);
        Assert.Empty(type.GetConstructors(BindingFlags.Instance | BindingFlags.Public));
        var actual = type.GetProperties(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
            .OrderBy(property => property.Name, StringComparer.Ordinal)
            .ToArray();
        Assert.Equal(properties, actual.Select(property => property.Name));
        Assert.All(actual, property => Assert.False(property.CanWrite));
    }

    private static string ProductionSourcePath([CallerFilePath] string sourceFile = "") =>
        Path.GetFullPath(Path.Combine(
            Path.GetDirectoryName(sourceFile)!,
            "..",
            "..",
            "Jellyfin.Plugin.JellyfinCanopy",
            "Platform",
            "PlatformProviderEmbeddedSchemaAdmission.cs"));

    private static string RepositoryRoot([CallerFilePath] string sourceFile = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(sourceFile)!, "..", ".."));

    private sealed class ResourceAssembly : Assembly
    {
        private readonly string[] _names;
        private readonly Func<string, Stream?> _open;
        private readonly bool _throwInventory;
        private readonly bool _returnNullInventory;

        internal ResourceAssembly(
            string[] names,
            Func<string, Stream?> open,
            bool throwInventory = false,
            bool returnNullInventory = false)
        {
            _names = names;
            _open = open;
            _throwInventory = throwInventory;
            _returnNullInventory = returnNullInventory;
        }

        internal static ResourceAssembly Empty { get; } = new([], _ => null);

        internal int InventoryCount { get; private set; }

        internal int OpenCount { get; private set; }

        internal int BytesRead { get; private set; }

        public override string[] GetManifestResourceNames()
        {
            InventoryCount++;
            if (_throwInventory)
            {
                throw new InvalidOperationException("sensitive inventory failure");
            }

            if (_returnNullInventory)
            {
                return null!;
            }

            return _names.ToArray();
        }

        public override Stream? GetManifestResourceStream(string name)
        {
            OpenCount++;
            return _open(name);
        }

        internal static ResourceAssembly WithSchemas(byte[] request, byte[] response) =>
            WithResources(new Dictionary<string, byte[]>(StringComparer.Ordinal)
            {
                [ResourceName(Digest(request))] = request,
                [ResourceName(Digest(response))] = response,
            });

        internal static ResourceAssembly WithResource(
            string name,
            byte[] bytes,
            int bytesPerRead = int.MaxValue)
        {
            ResourceAssembly? assembly = null;
            assembly = new ResourceAssembly(
                new[] { name },
                requested => string.Equals(requested, name, StringComparison.Ordinal)
                    ? new TrackingReadStream(
                        bytes,
                        bytesPerRead,
                        count => assembly!.BytesRead += count)
                    : null);
            return assembly;
        }

        internal static ResourceAssembly ThrowingInventory() =>
            new([], _ => null, throwInventory: true);

        internal static ResourceAssembly NullInventory() =>
            new([], _ => null, returnNullInventory: true);

        private static ResourceAssembly WithResources(IReadOnlyDictionary<string, byte[]> resources) =>
            new(
                resources.Keys.ToArray(),
                name => resources.TryGetValue(name, out var bytes)
                    ? new MemoryStream(bytes, writable: false)
                    : null);

    }

    private sealed class TrackingReadStream : MemoryStream
    {
        private readonly int _bytesPerRead;
        private readonly Action<int> _record;

        internal TrackingReadStream(byte[] bytes, int bytesPerRead, Action<int> record)
            : base(bytes, writable: false)
        {
            _bytesPerRead = bytesPerRead;
            _record = record;
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            var read = base.Read(buffer, offset, Math.Min(count, _bytesPerRead));
            _record(read);
            return read;
        }
    }

    private sealed class ThrowingReadStream : MemoryStream
    {
        public override int Read(byte[] buffer, int offset, int count) =>
            throw new IOException("sensitive read failure");
    }
}
