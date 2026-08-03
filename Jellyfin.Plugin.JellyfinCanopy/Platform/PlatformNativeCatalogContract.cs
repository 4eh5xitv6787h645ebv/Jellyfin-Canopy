using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>Wire and collection bounds shared by the native item-detail pilot.</summary>
    internal static class PlatformNativeCatalogBounds
    {
        internal const int MaximumContributions = 12;
        internal const int MaximumFields = 8;
        internal const int MaximumOptions = 32;
        internal const int MaximumCapabilityValues = 16;
        internal const int MaximumIdentifierBytes = 128;
        internal const int MaximumCapabilityValueBytes = 32;
        internal const int MaximumLabelBytes = 96;
        internal const int MaximumTextBytes = 512;
        internal const int MaximumOpaqueBytes = 4096;
        internal const int MaximumLocaleBytes = 64;
    }

    /// <summary>Normalized, bounded capabilities used to compose one response.</summary>
    internal sealed class PlatformNativeClientCapabilities
    {
        internal PlatformNativeClientCapabilities(
            IEnumerable<string> contributionKinds,
            IEnumerable<string> fieldKinds,
            IEnumerable<string> inputModes,
            IEnumerable<string> accessibility,
            string locale)
        {
            ContributionKinds = Normalize(contributionKinds, KnownContributionKinds);
            FieldKinds = Normalize(fieldKinds, KnownFieldKinds);
            InputModes = Normalize(inputModes, KnownInputModes);
            Accessibility = Normalize(accessibility, KnownAccessibility);
            Locale = NormalizeLocale(locale);
        }

        internal ImmutableArray<string> ContributionKinds { get; }

        internal ImmutableArray<string> FieldKinds { get; }

        internal ImmutableArray<string> InputModes { get; }

        internal ImmutableArray<string> Accessibility { get; }

        internal string Locale { get; }

        internal bool SupportsContribution(string kind) => ContributionKinds.Contains(kind, StringComparer.Ordinal);

        internal bool SupportsField(string kind) => FieldKinds.Contains(kind, StringComparer.Ordinal);

        internal bool SupportsDpad => InputModes.Contains("dpad", StringComparer.Ordinal);

        private static readonly ImmutableHashSet<string> KnownContributionKinds =
            ImmutableHashSet.Create(StringComparer.Ordinal, "action", "status");

        private static readonly ImmutableHashSet<string> KnownFieldKinds =
            ImmutableHashSet.Create(StringComparer.Ordinal, "confirmation", "boolean", "single_select", "multi_select");

        private static readonly ImmutableHashSet<string> KnownInputModes =
            ImmutableHashSet.Create(StringComparer.Ordinal, "dpad");

        private static readonly ImmutableHashSet<string> KnownAccessibility =
            ImmutableHashSet.Create(StringComparer.Ordinal, "screen_reader");

        private static ImmutableArray<string> Normalize(
            IEnumerable<string> values,
            ImmutableHashSet<string> allowlist)
        {
            ArgumentNullException.ThrowIfNull(values);
            return values
                .Where(allowlist.Contains)
                .Distinct(StringComparer.Ordinal)
                .Order(StringComparer.Ordinal)
                .ToImmutableArray();
        }

        private static string NormalizeLocale(string locale)
        {
            if (!PlatformNativeContractText.IsBoundedAsciiToken(
                    locale,
                    PlatformNativeCatalogBounds.MaximumLocaleBytes,
                    allowHyphen: true)
                || locale.Any(character => character is not (>= 'a' and <= 'z'
                    or >= 'A' and <= 'Z'
                    or >= '0' and <= '9'
                    or '-')))
            {
                throw new ArgumentException("The client locale is invalid.", nameof(locale));
            }

            try
            {
                var normalized = CultureInfo.GetCultureInfo(locale).Name.ToLowerInvariant();
                if (normalized.Length == 0
                    || Encoding.UTF8.GetByteCount(normalized) > PlatformNativeCatalogBounds.MaximumLocaleBytes)
                {
                    throw new ArgumentException("The client locale is invalid.", nameof(locale));
                }

                return normalized;
            }
            catch (CultureNotFoundException exception)
            {
                throw new ArgumentException("The client locale is not recognized.", nameof(locale), exception);
            }
        }
    }

    /// <summary>Strict Android-compatible item-detail resolve request.</summary>
    [JsonConverter(typeof(PlatformItemDetailResolveRequestConverter))]
    public sealed class PlatformItemDetailResolveRequest
    {
        internal PlatformItemDetailResolveRequest(
            int protocol,
            int surfaceSchema,
            Guid itemId,
            PlatformNativeClientCapabilities client)
        {
            Protocol = protocol;
            SurfaceSchema = surfaceSchema;
            ItemId = itemId;
            Client = client ?? throw new ArgumentNullException(nameof(client));
        }

        internal int Protocol { get; }

        internal int SurfaceSchema { get; }

        internal Guid ItemId { get; }

        internal PlatformNativeClientCapabilities Client { get; }
    }

    /// <summary>Strict Android-compatible prepare request.</summary>
    [JsonConverter(typeof(PlatformActionPrepareRequestConverter))]
    public sealed class PlatformActionPrepareRequest
    {
        internal PlatformActionPrepareRequest(string prepareHandle)
        {
            if (!PlatformNativeContractText.IsBoundedOpaque(prepareHandle))
            {
                throw new ArgumentException("The prepare handle is invalid.", nameof(prepareHandle));
            }

            PrepareHandle = prepareHandle;
        }

        internal string PrepareHandle { get; }
    }

    public sealed class PlatformItemDetailResolveResponse
    {
        internal PlatformItemDetailResolveResponse(
            string catalogRevision,
            ImmutableArray<PlatformNativeContribution> contributions)
        {
            PlatformNativeContractText.RequireIdentifier(catalogRevision, nameof(catalogRevision));
            if (contributions.IsDefault || contributions.Length > PlatformNativeCatalogBounds.MaximumContributions)
            {
                throw new ArgumentException("The contribution collection is invalid.", nameof(contributions));
            }

            CatalogRevision = catalogRevision;
            Contributions = contributions;
        }

        public string CatalogRevision { get; }

        public ImmutableArray<PlatformNativeContribution> Contributions { get; }
    }

    public sealed class PlatformNativeContribution
    {
        private PlatformNativeContribution(
            string id,
            string kind,
            string label,
            string? description,
            string? semanticIcon,
            bool? enabled,
            string? prepareHandle,
            string? tone)
        {
            PlatformNativeContractText.RequireIdentifier(id, nameof(id));
            PlatformNativeContractText.RequireLabel(label, nameof(label));
            PlatformNativeContractText.RequireOptionalText(description, nameof(description));
            Id = id;
            Kind = kind;
            Label = label;
            Description = description;
            SemanticIcon = semanticIcon;
            Enabled = enabled;
            PrepareHandle = prepareHandle;
            Tone = tone;
        }

        public string Id { get; }

        public string Kind { get; }

        public string Label { get; }

        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? Description { get; }

        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? SemanticIcon { get; }

        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public bool? Enabled { get; }

        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? PrepareHandle { get; }

        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? Tone { get; }

        internal static PlatformNativeContribution Action(
            string id,
            string label,
            string? description,
            string semanticIcon,
            bool enabled,
            string? prepareHandle)
        {
            if (!KnownIcons.Contains(semanticIcon)
                || (enabled && !PlatformNativeContractText.IsBoundedOpaque(prepareHandle))
                || (!enabled && prepareHandle is not null))
            {
                throw new ArgumentException("The action contribution is invalid.", nameof(prepareHandle));
            }

            return new(id, "action", label, description, semanticIcon, enabled, prepareHandle, tone: null);
        }

        internal static PlatformNativeContribution Status(string id, string label, string tone)
        {
            if (!KnownTones.Contains(tone))
            {
                throw new ArgumentException("The status tone is invalid.", nameof(tone));
            }

            return new(id, "status", label, description: null, semanticIcon: null, enabled: null, prepareHandle: null, tone);
        }

        private static readonly ImmutableHashSet<string> KnownIcons =
            ImmutableHashSet.Create(StringComparer.Ordinal, "shield", "visibility_off", "add", "check", "settings");

        private static readonly ImmutableHashSet<string> KnownTones =
            ImmutableHashSet.Create(StringComparer.Ordinal, "neutral", "positive", "warning", "negative");
    }

    public sealed class PlatformActionPrepareResponse
    {
        internal PlatformActionPrepareResponse(
            string capability,
            DateTimeOffset expiresAtUtc,
            string title,
            string submitLabel,
            string cancelLabel,
            ImmutableArray<PlatformNativeField> fields)
        {
            if (!PlatformNativeContractText.IsBoundedOpaque(capability)
                || fields.IsDefault
                || fields.Length > PlatformNativeCatalogBounds.MaximumFields)
            {
                throw new ArgumentException("The prepared action response is invalid.", nameof(capability));
            }

            PlatformNativeContractText.RequireLabel(title, nameof(title));
            PlatformNativeContractText.RequireLabel(submitLabel, nameof(submitLabel));
            PlatformNativeContractText.RequireLabel(cancelLabel, nameof(cancelLabel));
            Capability = capability;
            ExpiresAtUtc = expiresAtUtc.ToUniversalTime();
            Title = title;
            SubmitLabel = submitLabel;
            CancelLabel = cancelLabel;
            Fields = fields;
        }

        public string Capability { get; }

        public DateTimeOffset ExpiresAtUtc { get; }

        public string Title { get; }

        public string SubmitLabel { get; }

        public string CancelLabel { get; }

        public ImmutableArray<PlatformNativeField> Fields { get; }
    }

    public sealed class PlatformNativeField
    {
        private PlatformNativeField(
            string id,
            string kind,
            string label,
            string? description,
            bool required,
            bool? defaultChecked,
            ImmutableArray<PlatformNativeOption> options,
            ImmutableArray<string> defaultOptionIds,
            int? minimumSelections,
            int? maximumSelections)
        {
            PlatformNativeContractText.RequireIdentifier(id, nameof(id));
            PlatformNativeContractText.RequireLabel(label, nameof(label));
            PlatformNativeContractText.RequireOptionalText(description, nameof(description));
            Id = id;
            Kind = kind;
            Label = label;
            Description = description;
            Required = required;
            DefaultChecked = defaultChecked;
            Options = options;
            DefaultOptionIds = defaultOptionIds;
            MinimumSelections = minimumSelections;
            MaximumSelections = maximumSelections;
        }

        public string Id { get; }

        public string Kind { get; }

        public string Label { get; }

        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? Description { get; }

        public bool Required { get; }

        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public bool? DefaultChecked { get; }

        public ImmutableArray<PlatformNativeOption> Options { get; }

        public ImmutableArray<string> DefaultOptionIds { get; }

        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public int? MinimumSelections { get; }

        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public int? MaximumSelections { get; }

        internal static PlatformNativeField Boolean(
            string id,
            string label,
            string? description,
            bool required,
            bool defaultChecked)
            => new(
                id,
                "boolean",
                label,
                description,
                required,
                defaultChecked,
                ImmutableArray<PlatformNativeOption>.Empty,
                ImmutableArray<string>.Empty,
                null,
                null);

        internal static PlatformNativeField Confirmation(
            string id,
            string label,
            string? description,
            bool required,
            bool defaultChecked)
            => new(
                id,
                "confirmation",
                label,
                description,
                required,
                defaultChecked,
                ImmutableArray<PlatformNativeOption>.Empty,
                ImmutableArray<string>.Empty,
                null,
                null);

        internal static PlatformNativeField SingleSelect(
            string id,
            string label,
            string? description,
            bool required,
            ImmutableArray<PlatformNativeOption> options,
            string? defaultOptionId)
        {
            if (options.IsDefaultOrEmpty
                || options.Length > PlatformNativeCatalogBounds.MaximumOptions
                || options.Select(option => option.Id).Distinct(StringComparer.Ordinal).Count() != options.Length
                || (defaultOptionId is not null && !options.Any(option => option.Id == defaultOptionId && !option.Disabled)))
            {
                throw new ArgumentException("The single-select options are invalid.", nameof(options));
            }

            return new(
                id,
                "single_select",
                label,
                description,
                required,
                null,
                options,
                defaultOptionId is null ? ImmutableArray<string>.Empty : [defaultOptionId],
                null,
                null);
        }

        internal static PlatformNativeField MultiSelect(
            string id,
            string label,
            string? description,
            bool required,
            ImmutableArray<PlatformNativeOption> options,
            ImmutableArray<string> defaultOptionIds,
            int minimumSelections,
            int maximumSelections)
        {
            if (options.IsDefaultOrEmpty
                || options.Length > PlatformNativeCatalogBounds.MaximumOptions
                || defaultOptionIds.IsDefault
                || options.Select(option => option.Id).Distinct(StringComparer.Ordinal).Count() != options.Length
                || defaultOptionIds.Distinct(StringComparer.Ordinal).Count() != defaultOptionIds.Length
                || defaultOptionIds.Any(id => !options.Any(option => option.Id == id && !option.Disabled))
                || minimumSelections < 0
                || maximumSelections < minimumSelections
                || maximumSelections > options.Count(option => !option.Disabled)
                || defaultOptionIds.Length < minimumSelections
                || defaultOptionIds.Length > maximumSelections)
            {
                throw new ArgumentException("The multi-select options are invalid.", nameof(options));
            }

            return new(
                id,
                "multi_select",
                label,
                description,
                required,
                null,
                options,
                defaultOptionIds,
                minimumSelections,
                maximumSelections);
        }
    }

    public sealed class PlatformNativeOption
    {
        internal PlatformNativeOption(string id, string label, string? description = null, bool disabled = false)
        {
            PlatformNativeContractText.RequireIdentifier(id, nameof(id));
            PlatformNativeContractText.RequireLabel(label, nameof(label));
            PlatformNativeContractText.RequireOptionalText(description, nameof(description));
            Id = id;
            Label = label;
            Description = description;
            Disabled = disabled;
        }

        public string Id { get; }

        public string Label { get; }

        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? Description { get; }

        public bool Disabled { get; }
    }

    internal static class PlatformNativeContractText
    {
        internal static void RequireIdentifier(string value, string parameterName)
        {
            if (!IsBoundedAsciiToken(value, PlatformNativeCatalogBounds.MaximumIdentifierBytes, allowHyphen: true))
            {
                throw new ArgumentException("The identifier is invalid.", parameterName);
            }
        }

        internal static void RequireLabel(string value, string parameterName)
        {
            if (string.IsNullOrWhiteSpace(value)
                || Encoding.UTF8.GetByteCount(value) > PlatformNativeCatalogBounds.MaximumLabelBytes)
            {
                throw new ArgumentException("The label is invalid.", parameterName);
            }
        }

        internal static void RequireOptionalText(string? value, string parameterName)
        {
            if (value is not null
                && (string.IsNullOrWhiteSpace(value)
                    || Encoding.UTF8.GetByteCount(value) > PlatformNativeCatalogBounds.MaximumTextBytes))
            {
                throw new ArgumentException("The text is invalid.", parameterName);
            }
        }

        internal static bool IsBoundedOpaque(string? value)
            => !string.IsNullOrWhiteSpace(value)
                && Encoding.UTF8.GetByteCount(value) <= PlatformNativeCatalogBounds.MaximumOpaqueBytes
                && value.All(character => character is >= '!' and <= '~');

        internal static bool IsBoundedAsciiToken(string? value, int maximumBytes, bool allowHyphen)
        {
            if (string.IsNullOrWhiteSpace(value) || value.Length > maximumBytes)
            {
                return false;
            }

            return value.All(character =>
                character is >= 'a' and <= 'z'
                || character is >= 'A' and <= 'Z'
                || character is >= '0' and <= '9'
                || character is '_' or '.'
                || (allowHyphen && character == '-'));
        }
    }

    internal sealed class PlatformItemDetailResolveRequestConverter : JsonConverter<PlatformItemDetailResolveRequest>
    {
        public override PlatformItemDetailResolveRequest Read(
            ref Utf8JsonReader reader,
            Type typeToConvert,
            JsonSerializerOptions options)
        {
            Require(ref reader, JsonTokenType.StartObject);
            int? protocol = null;
            int? surfaceSchema = null;
            Guid? itemId = null;
            PlatformNativeClientCapabilities? client = null;
            var seen = new HashSet<string>(StringComparer.Ordinal);
            while (reader.Read() && reader.TokenType != JsonTokenType.EndObject)
            {
                Require(ref reader, JsonTokenType.PropertyName);
                var property = reader.GetString()!;
                reader.Read();
                switch (property)
                {
                    case "Protocol":
                        Mark(seen, property);
                        protocol = ReadInt(ref reader, property);
                        break;
                    case "SurfaceSchema":
                        Mark(seen, property);
                        surfaceSchema = ReadInt(ref reader, property);
                        break;
                    case "Item":
                        Mark(seen, property);
                        itemId = ReadItem(ref reader);
                        break;
                    case "Client":
                        Mark(seen, property);
                        client = ReadClient(ref reader);
                        break;
                    default:
                        reader.Skip();
                        break;
                }
            }

            if (reader.TokenType != JsonTokenType.EndObject
                || protocol is null
                || surfaceSchema is null
                || itemId is null
                || itemId == Guid.Empty
                || client is null)
            {
                throw new JsonException("The item-detail resolve request is incomplete.");
            }

            return new PlatformItemDetailResolveRequest(protocol.Value, surfaceSchema.Value, itemId.Value, client);
        }

        public override void Write(
            Utf8JsonWriter writer,
            PlatformItemDetailResolveRequest value,
            JsonSerializerOptions options)
            => throw new NotSupportedException();

        private static Guid ReadItem(ref Utf8JsonReader reader)
        {
            Require(ref reader, JsonTokenType.StartObject);
            Guid? id = null;
            var seen = false;
            while (reader.Read() && reader.TokenType != JsonTokenType.EndObject)
            {
                Require(ref reader, JsonTokenType.PropertyName);
                var property = reader.GetString();
                reader.Read();
                if (property == "Id")
                {
                    if (seen)
                    {
                        throw new JsonException("Duplicate Item.Id.");
                    }

                    seen = true;
                    id = JsonSerializer.Deserialize<Guid>(ref reader, PlatformJson.SerializerOptions);
                }
                else
                {
                    reader.Skip();
                }
            }

            return reader.TokenType == JsonTokenType.EndObject && id is { } value && value != Guid.Empty
                ? value
                : throw new JsonException("A canonical Item.Id is required.");
        }

        private static PlatformNativeClientCapabilities ReadClient(ref Utf8JsonReader reader)
        {
            Require(ref reader, JsonTokenType.StartObject);
            ImmutableArray<string>? contributions = null;
            ImmutableArray<string>? fields = null;
            ImmutableArray<string>? inputModes = null;
            ImmutableArray<string>? accessibility = null;
            string? locale = null;
            var seen = new HashSet<string>(StringComparer.Ordinal);
            while (reader.Read() && reader.TokenType != JsonTokenType.EndObject)
            {
                Require(ref reader, JsonTokenType.PropertyName);
                var property = reader.GetString()!;
                reader.Read();
                switch (property)
                {
                    case "ContributionKinds":
                        Mark(seen, property);
                        contributions = ReadTokens(ref reader, property);
                        break;
                    case "FieldKinds":
                        Mark(seen, property);
                        fields = ReadTokens(ref reader, property);
                        break;
                    case "InputModes":
                        Mark(seen, property);
                        inputModes = ReadTokens(ref reader, property);
                        break;
                    case "Accessibility":
                        Mark(seen, property);
                        accessibility = ReadTokens(ref reader, property);
                        break;
                    case "Locale":
                        Mark(seen, property);
                        locale = ReadString(ref reader, PlatformNativeCatalogBounds.MaximumLocaleBytes, property, allowHyphen: true);
                        break;
                    default:
                        reader.Skip();
                        break;
                }
            }

            if (reader.TokenType != JsonTokenType.EndObject
                || contributions is null
                || fields is null
                || inputModes is null
                || accessibility is null
                || locale is null)
            {
                throw new JsonException("The client capability object is incomplete.");
            }

            try
            {
                return new PlatformNativeClientCapabilities(
                    contributions.Value,
                    fields.Value,
                    inputModes.Value,
                    accessibility.Value,
                    locale);
            }
            catch (ArgumentException exception)
            {
                throw new JsonException("The client capability object is invalid.", exception);
            }
        }

        private static ImmutableArray<string> ReadTokens(ref Utf8JsonReader reader, string property)
        {
            Require(ref reader, JsonTokenType.StartArray);
            var values = ImmutableArray.CreateBuilder<string>();
            while (reader.Read() && reader.TokenType != JsonTokenType.EndArray)
            {
                if (values.Count >= PlatformNativeCatalogBounds.MaximumCapabilityValues)
                {
                    throw new JsonException($"{property} exceeds its element bound.");
                }

                values.Add(ReadString(
                    ref reader,
                    PlatformNativeCatalogBounds.MaximumCapabilityValueBytes,
                    property,
                    allowHyphen: false));
            }

            if (reader.TokenType != JsonTokenType.EndArray)
            {
                throw new JsonException($"{property} is invalid.");
            }

            return values.ToImmutable();
        }

        private static int ReadInt(ref Utf8JsonReader reader, string property)
        {
            if (reader.TokenType != JsonTokenType.Number || !reader.TryGetInt32(out var value))
            {
                throw new JsonException($"{property} must be an integer.");
            }

            return value;
        }

        private static string ReadString(
            ref Utf8JsonReader reader,
            int maximumBytes,
            string property,
            bool allowHyphen)
        {
            if (reader.TokenType != JsonTokenType.String)
            {
                throw new JsonException($"{property} must be a string.");
            }

            var value = reader.GetString();
            if (!PlatformNativeContractText.IsBoundedAsciiToken(value, maximumBytes, allowHyphen))
            {
                throw new JsonException($"{property} is invalid.");
            }

            return value!;
        }

        private static void Mark(HashSet<string> seen, string property)
        {
            if (!seen.Add(property))
            {
                throw new JsonException($"Duplicate {property}.");
            }
        }

        private static void Require(ref Utf8JsonReader reader, JsonTokenType type)
        {
            if (reader.TokenType != type)
            {
                throw new JsonException($"Expected {type}.");
            }
        }
    }

    internal sealed class PlatformActionPrepareRequestConverter : JsonConverter<PlatformActionPrepareRequest>
    {
        public override PlatformActionPrepareRequest Read(
            ref Utf8JsonReader reader,
            Type typeToConvert,
            JsonSerializerOptions options)
        {
            if (reader.TokenType != JsonTokenType.StartObject)
            {
                throw new JsonException("Expected an object.");
            }

            string? handle = null;
            var seen = false;
            while (reader.Read() && reader.TokenType != JsonTokenType.EndObject)
            {
                if (reader.TokenType != JsonTokenType.PropertyName)
                {
                    throw new JsonException("Expected a property.");
                }

                var property = reader.GetString();
                reader.Read();
                if (property == "PrepareHandle")
                {
                    if (seen || reader.TokenType != JsonTokenType.String)
                    {
                        throw new JsonException("PrepareHandle is duplicated or invalid.");
                    }

                    seen = true;
                    handle = reader.GetString();
                    if (!PlatformNativeContractText.IsBoundedOpaque(handle))
                    {
                        throw new JsonException("PrepareHandle is invalid.");
                    }
                }
                else
                {
                    reader.Skip();
                }
            }

            return reader.TokenType == JsonTokenType.EndObject && handle is not null
                ? new PlatformActionPrepareRequest(handle)
                : throw new JsonException("PrepareHandle is required.");
        }

        public override void Write(
            Utf8JsonWriter writer,
            PlatformActionPrepareRequest value,
            JsonSerializerOptions options)
            => throw new NotSupportedException();
    }
}
