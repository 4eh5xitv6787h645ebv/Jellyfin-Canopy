using System;
using System.Buffers;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Text;
using System.Text.Json;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>Closed request-payload outcomes exposed to the invocation owner.</summary>
    internal enum PlatformProviderRequestPayloadValidationStatus
    {
        Succeeded = 0,
        InvalidRequest = 1,
        RequestSchemaRejected = 2,
    }

    /// <summary>Closed response-payload outcomes exposed to the invocation owner.</summary>
    internal enum PlatformProviderResponsePayloadValidationStatus
    {
        Succeeded = 0,
        ResponseMissing = 1,
        ResponseTooLarge = 2,
        ResponseInvalidJson = 3,
        ResponseEnvelopeMismatch = 4,
        ResponseSchemaRejected = 5,
    }

    /// <summary>
    /// Minimal host-owned values from which the provider request envelope is built.
    /// The operation input is cloned so its source document cannot change its lifetime.
    /// </summary>
    internal sealed class PlatformProviderRequestEnvelopeValues
    {
        internal PlatformProviderRequestEnvelopeValues(
            string correlationId,
            int protocol,
            IEnumerable<string> grantedScopes,
            string userAttribution,
            string deviceAttribution,
            string? itemId,
            string? surface,
            string locale,
            IEnumerable<string> accessibilityHints,
            int remainingDeadlineMilliseconds,
            JsonElement input)
        {
            ArgumentNullException.ThrowIfNull(correlationId);
            ArgumentNullException.ThrowIfNull(grantedScopes);
            ArgumentNullException.ThrowIfNull(userAttribution);
            ArgumentNullException.ThrowIfNull(deviceAttribution);
            ArgumentNullException.ThrowIfNull(locale);
            ArgumentNullException.ThrowIfNull(accessibilityHints);

            CorrelationId = correlationId;
            Protocol = protocol;
            GrantedScopes = ImmutableArray.CreateRange(grantedScopes);
            UserAttribution = userAttribution;
            DeviceAttribution = deviceAttribution;
            ItemId = itemId;
            Surface = surface;
            Locale = locale;
            AccessibilityHints = ImmutableArray.CreateRange(accessibilityHints);
            RemainingDeadlineMilliseconds = remainingDeadlineMilliseconds;
            Input = input.Clone();
        }

        internal string CorrelationId { get; }

        internal int Protocol { get; }

        internal ImmutableArray<string> GrantedScopes { get; }

        internal string UserAttribution { get; }

        internal string DeviceAttribution { get; }

        internal string? ItemId { get; }

        internal string? Surface { get; }

        internal string Locale { get; }

        internal ImmutableArray<string> AccessibilityHints { get; }

        internal int RemainingDeadlineMilliseconds { get; }

        internal JsonElement Input { get; }
    }

    /// <summary>One request result; failed results never expose partial JSON.</summary>
    internal readonly record struct PlatformProviderRequestPayloadValidationResult
    {
        private PlatformProviderRequestPayloadValidationResult(
            PlatformProviderRequestPayloadValidationStatus status,
            string? requestJson)
        {
            if (!Enum.IsDefined(status)
                || (status == PlatformProviderRequestPayloadValidationStatus.Succeeded)
                != (requestJson is not null))
            {
                throw new ArgumentOutOfRangeException(nameof(status));
            }

            Status = status;
            RequestJson = requestJson;
        }

        internal PlatformProviderRequestPayloadValidationStatus Status { get; }

        internal string? RequestJson { get; }

        internal static PlatformProviderRequestPayloadValidationResult Success(string requestJson) =>
            new(PlatformProviderRequestPayloadValidationStatus.Succeeded, requestJson);

        internal static PlatformProviderRequestPayloadValidationResult Rejected(
            PlatformProviderRequestPayloadValidationStatus status) => new(status, null);
    }

    /// <summary>One response result; only success exposes a cloned operation result.</summary>
    internal readonly record struct PlatformProviderResponsePayloadValidationResult
    {
        private PlatformProviderResponsePayloadValidationResult(
            PlatformProviderResponsePayloadValidationStatus status,
            JsonElement? result)
        {
            if (!Enum.IsDefined(status)
                || (status == PlatformProviderResponsePayloadValidationStatus.Succeeded)
                != result.HasValue)
            {
                throw new ArgumentOutOfRangeException(nameof(status));
            }

            Status = status;
            Result = result?.Clone();
        }

        internal PlatformProviderResponsePayloadValidationStatus Status { get; }

        internal JsonElement? Result { get; }

        internal static PlatformProviderResponsePayloadValidationResult Success(JsonElement result) =>
            new(PlatformProviderResponsePayloadValidationStatus.Succeeded, result);

        internal static PlatformProviderResponsePayloadValidationResult Rejected(
            PlatformProviderResponsePayloadValidationStatus status) => new(status, null);
    }

    /// <summary>
    /// Builds and validates the frozen provider envelopes and a deliberately small,
    /// fail-closed Draft 2020-12 operation-schema profile. It performs no resource,
    /// filesystem, network, reflection, resolver, registry, cache, or logging work.
    /// </summary>
    internal static class PlatformProviderJsonPayloadValidator
    {
        internal const int MaximumSchemaWorkUnits = 131_072;

        private const string JsonSchemaDialect =
            "https://json-schema.org/draft/2020-12/schema";

        private static readonly UTF8Encoding StrictUtf8 = new(false, true);

        private static readonly ImmutableHashSet<string> GrantedScopeVocabulary =
            ImmutableHashSet.Create(
                StringComparer.Ordinal,
                "jellyfin.canopy.items.lookup",
                "jellyfin.canopy.user-data.read",
                "jellyfin.canopy.storage.read",
                "jellyfin.canopy.ui.contribute",
                "jellyfin.canopy.integrations.invoke");

        private static readonly ImmutableHashSet<string> ForbiddenPropertyNames =
            ImmutableHashSet.Create(
                StringComparer.OrdinalIgnoreCase,
                "token", "rawToken", "bearerToken", "accessToken", "apiKey", "password",
                "secret", "cookie", "authorization", "claimsPrincipal", "httpContext",
                "serviceProvider", "iServiceProvider", "requestServices", "unrestrictedService",
                "database", "dbContext", "dbHandle", "databaseHandle", "hostHandle",
                "hostService", "services", "path", "filePath", "directoryPath", "absolutePath",
                "pluginPath", "credential", "credentials", "exception", "rawException",
                "stackTrace", "connectionString", "environment", "authority");

        private static readonly ImmutableHashSet<string> SupportedOperationSchemaKeywords =
            ImmutableHashSet.Create(
                StringComparer.Ordinal,
                "$schema", "$id", "title", "description", "type", "properties", "required",
                "additionalProperties", "minLength", "maxLength",
                "x-canopy-maximum-utf8-bytes");

        /// <summary>
        /// Establishes the request projection's owned input only after the same fixed
        /// structural and byte caps used at the provider boundary have succeeded.
        /// </summary>
        internal static JsonElement OwnBoundedOperationInput(JsonElement input)
        {
            if (input.ValueKind != JsonValueKind.Object)
            {
                return default;
            }

            try
            {
                var buffer = new BoundedBufferWriter(
                    PlatformProviderAbiContract.MaximumRequestDocumentBytes);
                using (var writer = new Utf8JsonWriter(buffer))
                {
                    input.WriteTo(writer);
                }

                var bytes = buffer.WrittenSpan.ToArray();
                if (ValidateStructure(bytes) != JsonStructureStatus.Valid)
                {
                    return default;
                }

                using var document = ParseDocument(bytes);
                return document?.RootElement.Clone() ?? default;
            }
            catch (Exception exception) when (exception is
                ArgumentException or InvalidOperationException or JsonException)
            {
                return default;
            }
        }

        internal static PlatformProviderRequestPayloadValidationResult BuildRequest(
            PlatformProviderRequestEnvelopeValues values,
            JsonElement operationSchema)
        {
            ArgumentNullException.ThrowIfNull(values);
            if (!AreValidRequestValues(values))
            {
                return RequestRejected(PlatformProviderRequestPayloadValidationStatus.InvalidRequest);
            }

            byte[] bytes;
            try
            {
                var buffer = new BoundedBufferWriter(PlatformProviderAbiContract.MaximumRequestDocumentBytes);
                using (var writer = new Utf8JsonWriter(buffer))
                {
                    writer.WriteStartObject();
                    writer.WriteNumber("schemaVersion", PlatformProviderAbiContract.EnvelopeSchemaVersion);
                    writer.WriteString("correlationId", values.CorrelationId);
                    writer.WriteNumber("protocol", values.Protocol);
                    writer.WriteStartArray("grantedScopes");
                    foreach (var scope in values.GrantedScopes)
                    {
                        writer.WriteStringValue(scope);
                    }

                    writer.WriteEndArray();
                    writer.WriteStartObject("attribution");
                    writer.WriteString("user", values.UserAttribution);
                    writer.WriteString("device", values.DeviceAttribution);
                    writer.WriteEndObject();
                    writer.WriteStartObject("context");
                    if (values.ItemId is not null)
                    {
                        writer.WriteString("itemId", values.ItemId);
                    }

                    if (values.Surface is not null)
                    {
                        writer.WriteString("surface", values.Surface);
                    }

                    writer.WriteEndObject();
                    writer.WriteStartObject("hints");
                    writer.WriteString("locale", values.Locale);
                    writer.WriteStartArray("accessibility");
                    foreach (var hint in values.AccessibilityHints)
                    {
                        writer.WriteStringValue(hint);
                    }

                    writer.WriteEndArray();
                    writer.WriteEndObject();
                    writer.WriteNumber(
                        "remainingDeadlineMilliseconds",
                        values.RemainingDeadlineMilliseconds);
                    writer.WritePropertyName("input");
                    values.Input.WriteTo(writer);
                    writer.WriteEndObject();
                }

                bytes = buffer.WrittenSpan.ToArray();
            }
            catch (Exception exception) when (exception is JsonException or InvalidOperationException)
            {
                return RequestRejected(PlatformProviderRequestPayloadValidationStatus.InvalidRequest);
            }

            if (bytes.Length > PlatformProviderAbiContract.MaximumRequestDocumentBytes
                || ValidateStructure(bytes) != JsonStructureStatus.Valid)
            {
                return RequestRejected(PlatformProviderRequestPayloadValidationStatus.InvalidRequest);
            }

            using var document = ParseDocument(bytes);
            if (document is null || !ValidateRequestEnvelope(document.RootElement, values))
            {
                return RequestRejected(PlatformProviderRequestPayloadValidationStatus.InvalidRequest);
            }

            if (!OperationSchemaEvaluator.IsValid(values.Input, operationSchema))
            {
                return RequestRejected(
                    PlatformProviderRequestPayloadValidationStatus.RequestSchemaRejected);
            }

            return PlatformProviderRequestPayloadValidationResult.Success(StrictUtf8.GetString(bytes));
        }

        internal static PlatformProviderResponsePayloadValidationResult ValidateResponse(
            string? responseJson,
            string expectedCorrelationId,
            int expectedProtocol,
            JsonElement operationSchema)
        {
            ArgumentNullException.ThrowIfNull(expectedCorrelationId);
            if (responseJson is null)
            {
                return ResponseRejected(
                    PlatformProviderResponsePayloadValidationStatus.ResponseMissing);
            }

            byte[] bytes;
            try
            {
                if (StrictUtf8.GetByteCount(responseJson)
                    > PlatformProviderAbiContract.MaximumResponseDocumentBytes)
                {
                    return ResponseRejected(
                        PlatformProviderResponsePayloadValidationStatus.ResponseTooLarge);
                }

                bytes = StrictUtf8.GetBytes(responseJson);
            }
            catch (EncoderFallbackException)
            {
                return ResponseRejected(
                    PlatformProviderResponsePayloadValidationStatus.ResponseInvalidJson);
            }

            var structure = ValidateStructure(bytes);
            if (structure == JsonStructureStatus.InvalidJson)
            {
                return ResponseRejected(
                    PlatformProviderResponsePayloadValidationStatus.ResponseInvalidJson);
            }

            if (structure == JsonStructureStatus.BoundsExceeded)
            {
                return ResponseRejected(
                    PlatformProviderResponsePayloadValidationStatus.ResponseEnvelopeMismatch);
            }

            using var document = ParseDocument(bytes);
            if (document is null)
            {
                return ResponseRejected(
                    PlatformProviderResponsePayloadValidationStatus.ResponseInvalidJson);
            }

            if (!ValidateResponseEnvelope(
                    document.RootElement,
                    expectedCorrelationId,
                    expectedProtocol,
                    out var result))
            {
                return ResponseRejected(
                    PlatformProviderResponsePayloadValidationStatus.ResponseEnvelopeMismatch);
            }

            if (!OperationSchemaEvaluator.IsValid(result, operationSchema))
            {
                return ResponseRejected(
                    PlatformProviderResponsePayloadValidationStatus.ResponseSchemaRejected);
            }

            return PlatformProviderResponsePayloadValidationResult.Success(result);
        }

        private static PlatformProviderRequestPayloadValidationResult RequestRejected(
            PlatformProviderRequestPayloadValidationStatus status) =>
            PlatformProviderRequestPayloadValidationResult.Rejected(status);

        private static PlatformProviderResponsePayloadValidationResult ResponseRejected(
            PlatformProviderResponsePayloadValidationStatus status) =>
            PlatformProviderResponsePayloadValidationResult.Rejected(status);

        private static bool AreValidRequestValues(PlatformProviderRequestEnvelopeValues values)
        {
            if (!IsIdentifier(values.CorrelationId)
                || values.Protocol != PlatformProviderAbiContract.EnvelopeSchemaVersion
                || values.GrantedScopes.IsDefault
                || values.GrantedScopes.Length > PlatformProviderAbiContract.MaximumGrantedScopes
                || values.GrantedScopes.Any(scope => !GrantedScopeVocabulary.Contains(scope))
                || values.GrantedScopes.Distinct(StringComparer.Ordinal).Count()
                    != values.GrantedScopes.Length
                || !IsIdentifier(values.UserAttribution)
                || !IsIdentifier(values.DeviceAttribution)
                || (values.ItemId is not null && !IsCanonicalItemId(values.ItemId))
                || (values.Surface is not null && !IsLogicalIdentifier(values.Surface, 64))
                || !IsLocale(values.Locale)
                || values.AccessibilityHints.IsDefault
                || values.AccessibilityHints.Length
                    > PlatformProviderAbiContract.MaximumAccessibilityHints
                || values.AccessibilityHints.Any(hint => !IsLogicalIdentifier(hint, 64))
                || values.AccessibilityHints.Distinct(StringComparer.Ordinal).Count()
                    != values.AccessibilityHints.Length
                || values.RemainingDeadlineMilliseconds < 1
                || values.RemainingDeadlineMilliseconds
                    > PlatformProviderAbiContract.MaximumRemainingDeadlineMilliseconds
                || values.Input.ValueKind != JsonValueKind.Object)
            {
                return false;
            }

            return true;
        }

        private static bool ValidateRequestEnvelope(
            JsonElement root,
            PlatformProviderRequestEnvelopeValues expected)
        {
            if (root.ValueKind != JsonValueKind.Object
                || !HasExactProperties(
                    root,
                    "schemaVersion", "correlationId", "protocol", "grantedScopes",
                    "attribution", "context", "hints", "remainingDeadlineMilliseconds", "input")
                || !IsExactInteger(root, "schemaVersion", PlatformProviderAbiContract.EnvelopeSchemaVersion)
                || !IsExactString(root, "correlationId", expected.CorrelationId)
                || !IsExactInteger(root, "protocol", expected.Protocol)
                || !root.TryGetProperty("grantedScopes", out var scopes)
                || scopes.ValueKind != JsonValueKind.Array
                || !scopes.EnumerateArray().Select(value => value.GetString())
                    .SequenceEqual(expected.GrantedScopes, StringComparer.Ordinal)
                || !root.TryGetProperty("attribution", out var attribution)
                || attribution.ValueKind != JsonValueKind.Object
                || !HasExactProperties(attribution, "user", "device")
                || !IsExactString(attribution, "user", expected.UserAttribution)
                || !IsExactString(attribution, "device", expected.DeviceAttribution)
                || !root.TryGetProperty("context", out var context)
                || !ValidateContext(context, expected)
                || !root.TryGetProperty("hints", out var hints)
                || !ValidateHints(hints, expected)
                || !IsExactInteger(
                    root,
                    "remainingDeadlineMilliseconds",
                    expected.RemainingDeadlineMilliseconds)
                || !root.TryGetProperty("input", out var input)
                || input.ValueKind != JsonValueKind.Object
                || !JsonElement.DeepEquals(input, expected.Input))
            {
                return false;
            }

            return true;
        }

        private static bool ValidateResponseEnvelope(
            JsonElement root,
            string expectedCorrelationId,
            int expectedProtocol,
            out JsonElement result)
        {
            result = default;
            if (root.ValueKind != JsonValueKind.Object
                || !HasExactProperties(root, "schemaVersion", "correlationId", "protocol", "result")
                || !IsExactInteger(root, "schemaVersion", PlatformProviderAbiContract.EnvelopeSchemaVersion)
                || !root.TryGetProperty("correlationId", out var correlation)
                || correlation.ValueKind != JsonValueKind.String
                || !IsIdentifier(correlation.GetString()!)
                || !string.Equals(correlation.GetString(), expectedCorrelationId, StringComparison.Ordinal)
                || !IsExactInteger(root, "protocol", PlatformProviderAbiContract.EnvelopeSchemaVersion)
                || expectedProtocol != PlatformProviderAbiContract.EnvelopeSchemaVersion
                || !root.TryGetProperty("result", out result)
                || result.ValueKind != JsonValueKind.Object)
            {
                result = default;
                return false;
            }

            return true;
        }

        private static bool ValidateContext(
            JsonElement context,
            PlatformProviderRequestEnvelopeValues expected)
        {
            if (context.ValueKind != JsonValueKind.Object)
            {
                return false;
            }

            var expectedCount = (expected.ItemId is null ? 0 : 1) + (expected.Surface is null ? 0 : 1);
            if (context.EnumerateObject().Count() != expectedCount)
            {
                return false;
            }

            return (expected.ItemId is null
                    ? !context.TryGetProperty("itemId", out _)
                    : IsExactString(context, "itemId", expected.ItemId))
                && (expected.Surface is null
                    ? !context.TryGetProperty("surface", out _)
                    : IsExactString(context, "surface", expected.Surface));
        }

        private static bool ValidateHints(
            JsonElement hints,
            PlatformProviderRequestEnvelopeValues expected) =>
            hints.ValueKind == JsonValueKind.Object
            && HasExactProperties(hints, "locale", "accessibility")
            && IsExactString(hints, "locale", expected.Locale)
            && hints.TryGetProperty("accessibility", out var accessibility)
            && accessibility.ValueKind == JsonValueKind.Array
            && accessibility.EnumerateArray().Select(value => value.GetString())
                .SequenceEqual(expected.AccessibilityHints, StringComparer.Ordinal);

        private static bool HasExactProperties(JsonElement value, params string[] names)
        {
            if (value.ValueKind != JsonValueKind.Object
                || value.EnumerateObject().Count() != names.Length)
            {
                return false;
            }

            return names.All(name => value.TryGetProperty(name, out _));
        }

        private static bool IsExactString(JsonElement owner, string name, string expected) =>
            owner.TryGetProperty(name, out var value)
            && value.ValueKind == JsonValueKind.String
            && string.Equals(value.GetString(), expected, StringComparison.Ordinal);

        private static bool IsExactInteger(JsonElement owner, string name, int expected) =>
            owner.TryGetProperty(name, out var value)
            && value.ValueKind == JsonValueKind.Number
            && value.TryGetInt32(out var actual)
            && actual == expected;

        private static JsonDocument? ParseDocument(byte[] bytes)
        {
            try
            {
                return JsonDocument.Parse(
                    bytes,
                    new JsonDocumentOptions
                    {
                        AllowTrailingCommas = false,
                        CommentHandling = JsonCommentHandling.Disallow,
                        MaxDepth = PlatformProviderAbiContract.MaximumJsonDepth,
                    });
            }
            catch (JsonException)
            {
                return null;
            }
        }

        private static JsonStructureStatus ValidateStructure(ReadOnlySpan<byte> bytes)
        {
            if (bytes.Length == 0)
            {
                return JsonStructureStatus.InvalidJson;
            }

            var containers = new List<ContainerState>(PlatformProviderAbiContract.MaximumJsonDepth);
            try
            {
                var reader = new Utf8JsonReader(
                    bytes,
                    new JsonReaderOptions
                    {
                        AllowTrailingCommas = false,
                        CommentHandling = JsonCommentHandling.Disallow,
                        MaxDepth = PlatformProviderAbiContract.MaximumJsonDepth + 1,
                    });

                while (reader.Read())
                {
                    var token = reader.TokenType;
                    if (token is JsonTokenType.StartObject or JsonTokenType.StartArray)
                    {
                        if (!TryCountArrayItem(containers)
                            || containers.Count >= PlatformProviderAbiContract.MaximumJsonDepth)
                        {
                            return JsonStructureStatus.BoundsExceeded;
                        }

                        containers.Add(new ContainerState(token == JsonTokenType.StartArray));
                        continue;
                    }

                    if (token is JsonTokenType.EndObject or JsonTokenType.EndArray)
                    {
                        if (containers.Count == 0
                            || containers[^1].IsArray != (token == JsonTokenType.EndArray))
                        {
                            return JsonStructureStatus.InvalidJson;
                        }

                        containers.RemoveAt(containers.Count - 1);
                        continue;
                    }

                    if (token == JsonTokenType.PropertyName)
                    {
                        if (containers.Count == 0 || containers[^1].IsArray)
                        {
                            return JsonStructureStatus.InvalidJson;
                        }

                        var name = reader.GetString()!;
                        var propertyStatus = containers[^1].TryAddProperty(name);
                        if (propertyStatus == PropertyStructureStatus.Duplicate)
                        {
                            return JsonStructureStatus.InvalidJson;
                        }

                        if (propertyStatus == PropertyStructureStatus.BoundsExceeded
                            || StrictUtf8.GetByteCount(name)
                                > PlatformProviderAbiContract.MaximumPropertyNameBytes
                            || ForbiddenPropertyNames.Contains(name))
                        {
                            return JsonStructureStatus.BoundsExceeded;
                        }

                        continue;
                    }

                    if (!TryCountArrayItem(containers))
                    {
                        return JsonStructureStatus.BoundsExceeded;
                    }

                    if (token == JsonTokenType.String
                        && StrictUtf8.GetByteCount(reader.GetString()!)
                            > PlatformProviderAbiContract.MaximumStringBytes)
                    {
                        return JsonStructureStatus.BoundsExceeded;
                    }
                }

                return containers.Count == 0
                    ? JsonStructureStatus.Valid
                    : JsonStructureStatus.InvalidJson;
            }
            catch (Exception exception) when (exception is
                JsonException or EncoderFallbackException or InvalidOperationException)
            {
                return JsonStructureStatus.InvalidJson;
            }
        }

        private static bool TryCountArrayItem(IReadOnlyList<ContainerState> containers) =>
            containers.Count == 0
            || !containers[^1].IsArray
            || containers[^1].TryAddArrayItem();

        private static bool IsIdentifier(string value)
        {
            if (value.Length == 0
                || !IsWithinUtf8Bytes(value, PlatformProviderAbiContract.MaximumIdentifierBytes)
                || !IsAsciiLetterOrDigit(value[0]))
            {
                return false;
            }

            return value.AsSpan(1).IndexOfAnyExcept(
                "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-") < 0;
        }

        private static bool IsCanonicalItemId(string value)
        {
            if (value.Length != 36
                || string.Equals(value, "00000000-0000-0000-0000-000000000000", StringComparison.Ordinal))
            {
                return false;
            }

            for (var index = 0; index < value.Length; index++)
            {
                if (index is 8 or 13 or 18 or 23)
                {
                    if (value[index] != '-')
                    {
                        return false;
                    }
                }
                else if (!IsLowerHex(value[index]))
                {
                    return false;
                }
            }

            return true;
        }

        private static bool IsLogicalIdentifier(string value, int maximumBytes)
        {
            if (value.Length == 0
                || !IsWithinUtf8Bytes(value, maximumBytes)
                || value[0] is < 'a' or > 'z')
            {
                return false;
            }

            var previousHyphen = false;
            foreach (var character in value)
            {
                if (character == '-')
                {
                    if (previousHyphen)
                    {
                        return false;
                    }

                    previousHyphen = true;
                    continue;
                }

                if (!IsAsciiLowerLetterOrDigit(character))
                {
                    return false;
                }

                previousHyphen = false;
            }

            return !previousHyphen;
        }

        private static bool IsLocale(string value)
        {
            if (!TryGetUtf8ByteCount(value, out var byteCount)
                || byteCount is < 2 or > PlatformProviderAbiContract.MaximumLocaleBytes)
            {
                return false;
            }

            var parts = value.Split('-');
            if (parts[0].Length is < 2 or > 8 || parts[0].Any(character => !IsAsciiLetter(character)))
            {
                return false;
            }

            return parts.Skip(1).All(part =>
                part.Length is >= 1 and <= 8
                && part.All(IsAsciiLetterOrDigit));
        }

        private static bool IsAsciiLetter(char value) =>
            value is >= 'A' and <= 'Z' or >= 'a' and <= 'z';

        private static bool IsAsciiLetterOrDigit(char value) =>
            IsAsciiLetter(value) || value is >= '0' and <= '9';

        private static bool IsAsciiLowerLetterOrDigit(char value) =>
            value is >= 'a' and <= 'z' or >= '0' and <= '9';

        private static bool IsLowerHex(char value) =>
            value is >= '0' and <= '9' or >= 'a' and <= 'f';

        private static bool IsWithinUtf8Bytes(string value, int maximumBytes) =>
            TryGetUtf8ByteCount(value, out var byteCount) && byteCount <= maximumBytes;

        private static bool TryGetUtf8ByteCount(string value, out int byteCount)
        {
            try
            {
                byteCount = StrictUtf8.GetByteCount(value);
                return true;
            }
            catch (EncoderFallbackException)
            {
                byteCount = 0;
                return false;
            }
        }

        private enum JsonStructureStatus
        {
            Valid = 0,
            InvalidJson = 1,
            BoundsExceeded = 2,
        }

        private enum PropertyStructureStatus
        {
            Added = 0,
            Duplicate = 1,
            BoundsExceeded = 2,
        }

        private sealed class ContainerState(bool isArray)
        {
            private readonly HashSet<string> _propertyNames = new(StringComparer.Ordinal);
            private int _count;

            internal bool IsArray { get; } = isArray;

            internal PropertyStructureStatus TryAddProperty(string name)
            {
                if (!_propertyNames.Add(name))
                {
                    return PropertyStructureStatus.Duplicate;
                }

                _count++;
                return _count <= PlatformProviderAbiContract.MaximumObjectProperties
                    ? PropertyStructureStatus.Added
                    : PropertyStructureStatus.BoundsExceeded;
            }

            internal bool TryAddArrayItem() =>
                ++_count <= PlatformProviderAbiContract.MaximumCollectionItems;
        }

        private sealed class BoundedBufferWriter : IBufferWriter<byte>
        {
            private readonly byte[] _buffer;
            private readonly int _maximumWrittenBytes;
            private int _written;

            internal BoundedBufferWriter(int maximumWrittenBytes)
            {
                _maximumWrittenBytes = maximumWrittenBytes;
                _buffer = new byte[checked(maximumWrittenBytes * 2)];
            }

            internal ReadOnlySpan<byte> WrittenSpan => _buffer.AsSpan(0, _written);

            public void Advance(int count)
            {
                if (count < 0 || _written > _maximumWrittenBytes - count)
                {
                    throw new InvalidOperationException("The bounded JSON document is too large.");
                }

                _written += count;
            }

            public Memory<byte> GetMemory(int sizeHint = 0)
            {
                sizeHint = Math.Max(sizeHint, 1);
                if (sizeHint > _buffer.Length - _written)
                {
                    throw new InvalidOperationException("The bounded JSON write request is too large.");
                }

                return _buffer.AsMemory(_written);
            }

            public Span<byte> GetSpan(int sizeHint = 0) => GetMemory(sizeHint).Span;
        }

        private static class OperationSchemaEvaluator
        {
            internal static bool IsValid(JsonElement instance, JsonElement schema)
            {
                try
                {
                    var work = new WorkBudget(MaximumSchemaWorkUnits);
                    return ValidateSchemaShape(schema, true, 0, work)
                        && Evaluate(instance, schema, 0, work);
                }
                catch (Exception exception) when (exception is
                    JsonException or EncoderFallbackException or InvalidOperationException)
                {
                    return false;
                }
            }

            private static bool ValidateSchemaShape(
                JsonElement schema,
                bool isRoot,
                int depth,
                WorkBudget work)
            {
                if (!work.TrySpend()
                    || depth >= PlatformProviderAbiContract.MaximumJsonDepth
                    || schema.ValueKind != JsonValueKind.Object)
                {
                    return false;
                }

                foreach (var keyword in schema.EnumerateObject())
                {
                    if (!work.TrySpend() || !SupportedOperationSchemaKeywords.Contains(keyword.Name))
                    {
                        return false;
                    }

                    switch (keyword.Name)
                    {
                        case "$schema":
                            if (!isRoot
                                || keyword.Value.ValueKind != JsonValueKind.String
                                || !string.Equals(
                                    keyword.Value.GetString(),
                                    JsonSchemaDialect,
                                    StringComparison.Ordinal))
                            {
                                return false;
                            }

                            break;
                        case "$id":
                            if (!isRoot
                                || keyword.Value.ValueKind != JsonValueKind.String
                                || string.IsNullOrEmpty(keyword.Value.GetString()))
                            {
                                return false;
                            }

                            break;
                        case "title":
                        case "description":
                            if (keyword.Value.ValueKind != JsonValueKind.String)
                            {
                                return false;
                            }

                            break;
                        case "type":
                            if (keyword.Value.ValueKind != JsonValueKind.String
                                || keyword.Value.GetString() is not ("object" or "string"))
                            {
                                return false;
                            }

                            break;
                        case "properties":
                            if (keyword.Value.ValueKind != JsonValueKind.Object)
                            {
                                return false;
                            }

                            foreach (var property in keyword.Value.EnumerateObject())
                            {
                                if (!work.TrySpend()
                                    || StrictUtf8.GetByteCount(property.Name)
                                        > PlatformProviderAbiContract.MaximumPropertyNameBytes
                                    || !ValidateSchemaShape(property.Value, false, depth + 1, work))
                                {
                                    return false;
                                }
                            }

                            break;
                        case "required":
                            if (!IsValidRequired(keyword.Value, work))
                            {
                                return false;
                            }

                            break;
                        case "additionalProperties":
                            if (keyword.Value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                            {
                                return false;
                            }

                            break;
                        case "minLength":
                        case "maxLength":
                        case "x-canopy-maximum-utf8-bytes":
                            if (!keyword.Value.TryGetInt32(out var limit) || limit < 0)
                            {
                                return false;
                            }

                            break;
                    }
                }

                if (isRoot
                    && (!schema.TryGetProperty("$schema", out _)
                        || !schema.TryGetProperty("$id", out _)))
                {
                    return false;
                }

                return !schema.TryGetProperty("minLength", out var minimum)
                    || !schema.TryGetProperty("maxLength", out var maximum)
                    || minimum.GetInt32() <= maximum.GetInt32();
            }

            private static bool IsValidRequired(JsonElement value, WorkBudget work)
            {
                if (value.ValueKind != JsonValueKind.Array
                    || value.GetArrayLength() > PlatformProviderAbiContract.MaximumObjectProperties)
                {
                    return false;
                }

                var names = new HashSet<string>(StringComparer.Ordinal);
                foreach (var item in value.EnumerateArray())
                {
                    if (!work.TrySpend()
                        || item.ValueKind != JsonValueKind.String
                        || item.GetString() is not { Length: > 0 } name
                        || StrictUtf8.GetByteCount(name)
                            > PlatformProviderAbiContract.MaximumPropertyNameBytes
                        || !names.Add(name))
                    {
                        return false;
                    }
                }

                return true;
            }

            private static bool Evaluate(
                JsonElement instance,
                JsonElement schema,
                int depth,
                WorkBudget work)
            {
                if (!work.TrySpend() || depth >= PlatformProviderAbiContract.MaximumJsonDepth)
                {
                    return false;
                }

                if (schema.TryGetProperty("type", out var type)
                    && !TypeMatches(instance, type.GetString()!))
                {
                    return false;
                }

                if (instance.ValueKind == JsonValueKind.String)
                {
                    return EvaluateString(instance.GetString()!, schema, work);
                }

                if (instance.ValueKind != JsonValueKind.Object)
                {
                    return true;
                }

                if (schema.TryGetProperty("required", out var required))
                {
                    foreach (var item in required.EnumerateArray())
                    {
                        if (!work.TrySpend() || !instance.TryGetProperty(item.GetString()!, out _))
                        {
                            return false;
                        }
                    }
                }

                var hasProperties = schema.TryGetProperty("properties", out var properties);
                var allowAdditional = !schema.TryGetProperty("additionalProperties", out var additional)
                    || additional.GetBoolean();
                foreach (var property in instance.EnumerateObject())
                {
                    if (!work.TrySpend())
                    {
                        return false;
                    }

                    if (hasProperties && properties.TryGetProperty(property.Name, out var propertySchema))
                    {
                        if (!Evaluate(property.Value, propertySchema, depth + 1, work))
                        {
                            return false;
                        }
                    }
                    else if (!allowAdditional)
                    {
                        return false;
                    }
                }

                return true;
            }

            private static bool EvaluateString(string value, JsonElement schema, WorkBudget work)
            {
                var runeCount = 0;
                foreach (var rune in value.EnumerateRunes())
                {
                    _ = rune;
                    if (!work.TrySpend())
                    {
                        return false;
                    }

                    runeCount++;
                }

                return (!schema.TryGetProperty("minLength", out var minimum)
                        || runeCount >= minimum.GetInt32())
                    && (!schema.TryGetProperty("maxLength", out var maximum)
                        || runeCount <= maximum.GetInt32())
                    && (!schema.TryGetProperty("x-canopy-maximum-utf8-bytes", out var byteMaximum)
                        || StrictUtf8.GetByteCount(value) <= byteMaximum.GetInt32());
            }

            private static bool TypeMatches(JsonElement instance, string type) => type switch
            {
                "object" => instance.ValueKind == JsonValueKind.Object,
                "string" => instance.ValueKind == JsonValueKind.String,
                _ => false,
            };

            private sealed class WorkBudget(int remaining)
            {
                private int _remaining = remaining;

                internal bool TrySpend() => _remaining-- > 0;
            }
        }
    }
}
