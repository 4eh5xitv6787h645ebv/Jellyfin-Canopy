using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>Closed, redaction-safe outcomes for one atomic embedded-schema admission.</summary>
    internal enum PlatformProviderEmbeddedSchemaAdmissionStatus
    {
        Admitted = 0,
        InvalidInput = 1,
        SchemaMissing = 2,
        SchemaResourceAmbiguous = 3,
        SchemaReadFailed = 4,
        SchemaTooLarge = 5,
        SchemaHashMismatch = 6,
        SchemaInvalidUtf8 = 7,
        SchemaInvalidJson = 8,
        SchemaBoundsExceeded = 9,
        SchemaIdentityMismatch = 10,
        SchemaDialectUnsupported = 11,
        SchemaExternalReference = 12,
        SchemaVocabularyUnsupported = 13,
    }

    /// <summary>
    /// One immutable admitted request/response schema pair. Elements are cloned at
    /// publication and on access, so no source document or caller owns their lifetime.
    /// </summary>
    internal sealed class PlatformProviderEmbeddedSchemaPair
    {
        private readonly JsonElement _requestSchema;
        private readonly JsonElement _responseSchema;

        private PlatformProviderEmbeddedSchemaPair(
            JsonElement requestSchema,
            JsonElement responseSchema)
        {
            _requestSchema = requestSchema.Clone();
            _responseSchema = responseSchema.Clone();
        }

        internal JsonElement RequestSchema => _requestSchema.Clone();

        internal JsonElement ResponseSchema => _responseSchema.Clone();

        internal static PlatformProviderEmbeddedSchemaPair EstablishAdmitted(
            JsonElement requestSchema,
            JsonElement responseSchema) => new(requestSchema, responseSchema);
    }

    /// <summary>One atomic admission result. Failed results never publish half a pair.</summary>
    internal sealed class PlatformProviderEmbeddedSchemaAdmissionResult
    {
        private PlatformProviderEmbeddedSchemaAdmissionResult(
            PlatformProviderEmbeddedSchemaAdmissionStatus status,
            PlatformProviderEmbeddedSchemaPair? schemas)
        {
            Status = status;
            Schemas = schemas;
        }

        internal PlatformProviderEmbeddedSchemaAdmissionStatus Status { get; }

        internal PlatformProviderEmbeddedSchemaPair? Schemas { get; }

        internal static PlatformProviderEmbeddedSchemaAdmissionResult Admitted(
            PlatformProviderEmbeddedSchemaPair schemas)
        {
            ArgumentNullException.ThrowIfNull(schemas);
            return new PlatformProviderEmbeddedSchemaAdmissionResult(
                PlatformProviderEmbeddedSchemaAdmissionStatus.Admitted,
                schemas);
        }

        internal static PlatformProviderEmbeddedSchemaAdmissionResult Rejected(
            PlatformProviderEmbeddedSchemaAdmissionStatus status)
        {
            if (status == PlatformProviderEmbeddedSchemaAdmissionStatus.Admitted)
            {
                throw new ArgumentOutOfRangeException(nameof(status));
            }

            return new PlatformProviderEmbeddedSchemaAdmissionResult(status, null);
        }
    }

    /// <summary>
    /// Admits only fixed, content-addressed schemas embedded in one already-loaded
    /// foreign assembly. This owner performs no provider invocation, path lookup,
    /// external resolution, caching, logging, or authority decision.
    /// </summary>
    internal static class PlatformProviderEmbeddedSchemaAdmission
    {
        internal const int MaximumDocumentBytes = 64 * 1024;
        internal const int MaximumJsonDepth = 12;
        internal const int MaximumObjectProperties = 64;
        internal const int MaximumArrayItems = 64;
        internal const int MaximumPropertyNameBytes = 256;
        internal const int MaximumStringBytes = 4 * 1024;
        internal const int MaximumResourceCount = 1024;
        internal const int MaximumResourceNameBytes = 512;

        internal const string JsonSchemaDialect =
            "https://json-schema.org/draft/2020-12/schema";

        private static readonly UTF8Encoding StrictUtf8 = new(false, true);

        private static readonly ImmutableHashSet<string> SupportedRequiredVocabularies =
            ImmutableHashSet.Create(
                StringComparer.Ordinal,
                "https://json-schema.org/draft/2020-12/vocab/core",
                "https://json-schema.org/draft/2020-12/vocab/applicator",
                "https://json-schema.org/draft/2020-12/vocab/unevaluated",
                "https://json-schema.org/draft/2020-12/vocab/validation",
                "https://json-schema.org/draft/2020-12/vocab/meta-data",
                "https://json-schema.org/draft/2020-12/vocab/format-annotation",
                "https://json-schema.org/draft/2020-12/vocab/content");

        internal static PlatformProviderEmbeddedSchemaAdmissionResult Admit(
            Assembly foreignAssembly,
            string requestSchemaId,
            string requestSchemaSha256,
            string responseSchemaId,
            string responseSchemaSha256)
        {
            if (foreignAssembly is null
                || !IsValidSchemaId(requestSchemaId)
                || !IsValidSha256(requestSchemaSha256)
                || !IsValidSchemaId(responseSchemaId)
                || !IsValidSha256(responseSchemaSha256))
            {
                return Rejected(PlatformProviderEmbeddedSchemaAdmissionStatus.InvalidInput);
            }

            string[] resourceNames;
            try
            {
                resourceNames = foreignAssembly.GetManifestResourceNames();
            }
            catch (Exception)
            {
                return Rejected(PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaReadFailed);
            }

            if (resourceNames is null)
            {
                return Rejected(PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaReadFailed);
            }

            if (resourceNames.Length > MaximumResourceCount
                || resourceNames.Any(name => !IsBoundedResourceName(name)))
            {
                return Rejected(PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaBoundsExceeded);
            }

            var admittedByDigest = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
            var request = AdmitOne(
                foreignAssembly,
                resourceNames,
                requestSchemaId,
                requestSchemaSha256,
                admittedByDigest);
            if (request.Status != PlatformProviderEmbeddedSchemaAdmissionStatus.Admitted)
            {
                return Rejected(request.Status);
            }

            var response = AdmitOne(
                foreignAssembly,
                resourceNames,
                responseSchemaId,
                responseSchemaSha256,
                admittedByDigest);
            if (response.Status != PlatformProviderEmbeddedSchemaAdmissionStatus.Admitted)
            {
                return Rejected(response.Status);
            }

            return PlatformProviderEmbeddedSchemaAdmissionResult.Admitted(
                PlatformProviderEmbeddedSchemaPair.EstablishAdmitted(
                    request.Schema,
                    response.Schema));
        }

        private static SingleSchemaAdmission AdmitOne(
            Assembly assembly,
            IReadOnlyList<string> resourceNames,
            string expectedSchemaId,
            string expectedSha256,
            IDictionary<string, JsonElement> admittedByDigest)
        {
            if (admittedByDigest.TryGetValue(expectedSha256, out var admitted))
            {
                return HasExpectedIdentity(admitted, expectedSchemaId)
                    ? SingleSchemaAdmission.Admitted(admitted)
                    : SingleSchemaAdmission.Rejected(
                        PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaIdentityMismatch);
            }

            var resourceName = PlatformProviderAbiContract.ProviderSchemaResourcePrefix
                + expectedSha256
                + PlatformProviderAbiContract.ProviderSchemaResourceSuffix;
            var matches = resourceNames.Count(name =>
                string.Equals(name, resourceName, StringComparison.Ordinal));
            if (matches == 0)
            {
                return SingleSchemaAdmission.Rejected(
                    PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaMissing);
            }

            if (matches != 1)
            {
                return SingleSchemaAdmission.Rejected(
                    PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaResourceAmbiguous);
            }

            byte[] bytes;
            try
            {
                using var stream = assembly.GetManifestResourceStream(resourceName);
                if (stream is null)
                {
                    return SingleSchemaAdmission.Rejected(
                        PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaMissing);
                }

                var read = ReadBounded(stream);
                if (read.Status != PlatformProviderEmbeddedSchemaAdmissionStatus.Admitted)
                {
                    return SingleSchemaAdmission.Rejected(read.Status);
                }

                bytes = read.Bytes;
            }
            catch (Exception)
            {
                return SingleSchemaAdmission.Rejected(
                    PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaReadFailed);
            }

            var actualSha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
            if (!string.Equals(actualSha256, expectedSha256, StringComparison.Ordinal))
            {
                return SingleSchemaAdmission.Rejected(
                    PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaHashMismatch);
            }

            if (bytes.Length >= 3
                && bytes[0] == 0xEF
                && bytes[1] == 0xBB
                && bytes[2] == 0xBF)
            {
                return SingleSchemaAdmission.Rejected(
                    PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaInvalidUtf8);
            }

            try
            {
                _ = StrictUtf8.GetString(bytes);
            }
            catch (DecoderFallbackException)
            {
                return SingleSchemaAdmission.Rejected(
                    PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaInvalidUtf8);
            }

            var structure = ValidateStructure(bytes);
            if (structure != PlatformProviderEmbeddedSchemaAdmissionStatus.Admitted)
            {
                return SingleSchemaAdmission.Rejected(structure);
            }

            JsonDocument document;
            try
            {
                document = JsonDocument.Parse(
                    bytes,
                    new JsonDocumentOptions
                    {
                        AllowTrailingCommas = false,
                        CommentHandling = JsonCommentHandling.Disallow,
                        MaxDepth = MaximumJsonDepth,
                    });
            }
            catch (JsonException)
            {
                return SingleSchemaAdmission.Rejected(
                    PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaInvalidJson);
            }

            using (document)
            {
                var root = document.RootElement;
                if (root.ValueKind != JsonValueKind.Object)
                {
                    return SingleSchemaAdmission.Rejected(
                        PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaInvalidJson);
                }

                if (!root.TryGetProperty("$schema", out var dialect)
                    || dialect.ValueKind != JsonValueKind.String
                    || !string.Equals(
                        dialect.GetString(),
                        JsonSchemaDialect,
                        StringComparison.Ordinal))
                {
                    return SingleSchemaAdmission.Rejected(
                        PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaDialectUnsupported);
                }

                if (!HasExpectedIdentity(root, expectedSchemaId))
                {
                    return SingleSchemaAdmission.Rejected(
                        PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaIdentityMismatch);
                }

                var semanticStatus = ValidateSchemaSemantics(root);
                if (semanticStatus != PlatformProviderEmbeddedSchemaAdmissionStatus.Admitted)
                {
                    return SingleSchemaAdmission.Rejected(semanticStatus);
                }

                var schema = root.Clone();
                admittedByDigest.Add(expectedSha256, schema);
                return SingleSchemaAdmission.Admitted(schema);
            }
        }

        private static BoundedRead ReadBounded(Stream stream)
        {
            var buffer = new byte[MaximumDocumentBytes + 1];
            var total = 0;
            while (total < buffer.Length)
            {
                var count = stream.Read(buffer, total, buffer.Length - total);
                if (count == 0)
                {
                    break;
                }

                total += count;
            }

            if (total > MaximumDocumentBytes)
            {
                return BoundedRead.Rejected(
                    PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaTooLarge);
            }

            return BoundedRead.Admitted(buffer.AsSpan(0, total).ToArray());
        }

        private static PlatformProviderEmbeddedSchemaAdmissionStatus ValidateStructure(
            ReadOnlySpan<byte> bytes)
        {
            var stack = new List<ContainerState>(MaximumJsonDepth);
            var reader = new Utf8JsonReader(
                bytes,
                new JsonReaderOptions
                {
                    AllowTrailingCommas = false,
                    CommentHandling = JsonCommentHandling.Disallow,
                    MaxDepth = 64,
                });

            try
            {
                while (reader.Read())
                {
                    switch (reader.TokenType)
                    {
                        case JsonTokenType.StartObject:
                            if (!TryCountArrayValue(stack)
                                || stack.Count >= MaximumJsonDepth)
                            {
                                return PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaBoundsExceeded;
                            }

                            stack.Add(ContainerState.Object());
                            break;

                        case JsonTokenType.StartArray:
                            if (!TryCountArrayValue(stack)
                                || stack.Count >= MaximumJsonDepth)
                            {
                                return PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaBoundsExceeded;
                            }

                            stack.Add(ContainerState.Array());
                            break;

                        case JsonTokenType.EndObject:
                        case JsonTokenType.EndArray:
                            if (stack.Count == 0)
                            {
                                return PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaInvalidJson;
                            }

                            stack.RemoveAt(stack.Count - 1);
                            break;

                        case JsonTokenType.PropertyName:
                            if (stack.Count == 0 || stack[^1].IsArray)
                            {
                                return PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaInvalidJson;
                            }

                            var propertyName = reader.GetString();
                            if (propertyName is null
                                || StrictUtf8.GetByteCount(propertyName) > MaximumPropertyNameBytes)
                            {
                                return PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaBoundsExceeded;
                            }

                            var propertyStatus = stack[^1].TryAddProperty(
                                propertyName,
                                MaximumObjectProperties);
                            if (propertyStatus == PropertyAddStatus.Duplicate)
                            {
                                return PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaInvalidJson;
                            }

                            if (propertyStatus == PropertyAddStatus.TooMany)
                            {
                                return PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaBoundsExceeded;
                            }

                            break;

                        case JsonTokenType.String:
                            var value = reader.GetString();
                            if (value is null
                                || StrictUtf8.GetByteCount(value) > MaximumStringBytes)
                            {
                                return PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaBoundsExceeded;
                            }

                            if (!TryCountArrayValue(stack))
                            {
                                return PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaBoundsExceeded;
                            }

                            break;

                        case JsonTokenType.Number:
                        case JsonTokenType.True:
                        case JsonTokenType.False:
                        case JsonTokenType.Null:
                            if (!TryCountArrayValue(stack))
                            {
                                return PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaBoundsExceeded;
                            }

                            break;
                    }
                }
            }
            catch (JsonException)
            {
                return PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaInvalidJson;
            }
            catch (DecoderFallbackException)
            {
                return PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaInvalidUtf8;
            }

            return stack.Count == 0
                ? PlatformProviderEmbeddedSchemaAdmissionStatus.Admitted
                : PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaInvalidJson;
        }

        private static bool TryCountArrayValue(IReadOnlyList<ContainerState> stack)
        {
            if (stack.Count == 0 || !stack[^1].IsArray)
            {
                return true;
            }

            return stack[^1].TryAddArrayItem(MaximumArrayItems);
        }

        private static PlatformProviderEmbeddedSchemaAdmissionStatus ValidateSchemaSemantics(
            JsonElement element)
        {
            switch (element.ValueKind)
            {
                case JsonValueKind.Object:
                    foreach (var property in element.EnumerateObject())
                    {
                        if (property.Name is "$recursiveRef" or "$recursiveAnchor")
                        {
                            return PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaVocabularyUnsupported;
                        }

                        if (property.Name == "$schema"
                            && (property.Value.ValueKind != JsonValueKind.String
                                || !string.Equals(
                                    property.Value.GetString(),
                                    JsonSchemaDialect,
                                    StringComparison.Ordinal)))
                        {
                            return PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaDialectUnsupported;
                        }

                        if (property.Name is "$ref" or "$dynamicRef")
                        {
                            if (property.Value.ValueKind != JsonValueKind.String
                                || property.Value.GetString() is not { } reference
                                || reference.Length == 0
                                || reference[0] != '#')
                            {
                                return PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaExternalReference;
                            }
                        }

                        if (property.Name == "$vocabulary")
                        {
                            var vocabularyStatus = ValidateVocabulary(property.Value);
                            if (vocabularyStatus != PlatformProviderEmbeddedSchemaAdmissionStatus.Admitted)
                            {
                                return vocabularyStatus;
                            }
                        }

                        var childStatus = ValidateSchemaSemantics(property.Value);
                        if (childStatus != PlatformProviderEmbeddedSchemaAdmissionStatus.Admitted)
                        {
                            return childStatus;
                        }
                    }

                    break;

                case JsonValueKind.Array:
                    foreach (var item in element.EnumerateArray())
                    {
                        var childStatus = ValidateSchemaSemantics(item);
                        if (childStatus != PlatformProviderEmbeddedSchemaAdmissionStatus.Admitted)
                        {
                            return childStatus;
                        }
                    }

                    break;
            }

            return PlatformProviderEmbeddedSchemaAdmissionStatus.Admitted;
        }

        private static PlatformProviderEmbeddedSchemaAdmissionStatus ValidateVocabulary(
            JsonElement vocabulary)
        {
            if (vocabulary.ValueKind != JsonValueKind.Object)
            {
                return PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaVocabularyUnsupported;
            }

            foreach (var declaration in vocabulary.EnumerateObject())
            {
                if (declaration.Value.ValueKind is not (
                        JsonValueKind.True or JsonValueKind.False))
                {
                    return PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaVocabularyUnsupported;
                }

                if (declaration.Value.GetBoolean()
                    && !SupportedRequiredVocabularies.Contains(declaration.Name))
                {
                    return PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaVocabularyUnsupported;
                }
            }

            return PlatformProviderEmbeddedSchemaAdmissionStatus.Admitted;
        }

        private static bool HasExpectedIdentity(JsonElement schema, string expectedSchemaId) =>
            schema.ValueKind == JsonValueKind.Object
            && schema.TryGetProperty("$id", out var id)
            && id.ValueKind == JsonValueKind.String
            && string.Equals(id.GetString(), expectedSchemaId, StringComparison.Ordinal);

        private static bool IsValidSchemaId(string? value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return false;
            }

            try
            {
                return StrictUtf8.GetByteCount(value)
                    <= PlatformExtensionManifestBounds.MaximumProviderSchemaIdBytes;
            }
            catch (EncoderFallbackException)
            {
                return false;
            }
        }

        private static bool IsValidSha256(string? value) =>
            value is { Length: PlatformProviderAbiContract.ProviderSchemaSha256Characters }
            && value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

        private static bool IsBoundedResourceName(string? value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return false;
            }

            try
            {
                return StrictUtf8.GetByteCount(value) <= MaximumResourceNameBytes;
            }
            catch (EncoderFallbackException)
            {
                return false;
            }
        }

        private static PlatformProviderEmbeddedSchemaAdmissionResult Rejected(
            PlatformProviderEmbeddedSchemaAdmissionStatus status) =>
            PlatformProviderEmbeddedSchemaAdmissionResult.Rejected(status);

        private sealed class ContainerState
        {
            private readonly HashSet<string>? _propertyNames;
            private int _count;

            private ContainerState(bool isArray)
            {
                IsArray = isArray;
                _propertyNames = isArray ? null : new HashSet<string>(StringComparer.Ordinal);
            }

            internal bool IsArray { get; }

            internal static ContainerState Object() => new(false);

            internal static ContainerState Array() => new(true);

            internal PropertyAddStatus TryAddProperty(string name, int maximum)
            {
                if (_propertyNames is null || !_propertyNames.Add(name))
                {
                    return PropertyAddStatus.Duplicate;
                }

                _count++;
                return _count <= maximum
                    ? PropertyAddStatus.Added
                    : PropertyAddStatus.TooMany;
            }

            internal bool TryAddArrayItem(int maximum)
            {
                _count++;
                return _count <= maximum;
            }
        }

        private enum PropertyAddStatus
        {
            Added = 0,
            Duplicate = 1,
            TooMany = 2,
        }

        private readonly record struct SingleSchemaAdmission(
            PlatformProviderEmbeddedSchemaAdmissionStatus Status,
            JsonElement Schema)
        {
            internal static SingleSchemaAdmission Admitted(JsonElement schema) =>
                new(PlatformProviderEmbeddedSchemaAdmissionStatus.Admitted, schema.Clone());

            internal static SingleSchemaAdmission Rejected(
                PlatformProviderEmbeddedSchemaAdmissionStatus status) => new(status, default);
        }

        private readonly record struct BoundedRead(
            PlatformProviderEmbeddedSchemaAdmissionStatus Status,
            byte[] Bytes)
        {
            internal static BoundedRead Admitted(byte[] bytes) =>
                new(PlatformProviderEmbeddedSchemaAdmissionStatus.Admitted, bytes);

            internal static BoundedRead Rejected(
                PlatformProviderEmbeddedSchemaAdmissionStatus status) => new(status, Array.Empty<byte>());
        }
    }
}
