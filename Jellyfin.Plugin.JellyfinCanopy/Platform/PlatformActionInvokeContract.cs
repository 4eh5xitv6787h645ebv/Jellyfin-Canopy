using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Primitives;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>One bounded generic answer submitted to a prepared native action.</summary>
    internal sealed class PlatformActionAnswer
    {
        internal PlatformActionAnswer(
            string fieldId,
            bool? booleanValue,
            ImmutableArray<string>? optionIds)
        {
            FieldId = fieldId;
            BooleanValue = booleanValue;
            OptionIds = optionIds;
        }

        internal string FieldId { get; }

        internal bool? BooleanValue { get; }

        internal ImmutableArray<string>? OptionIds { get; }
    }

    /// <summary>The exact Android-compatible Platform v1 invoke body.</summary>
    [JsonConverter(typeof(PlatformActionInvokeRequestConverter))]
    public sealed class PlatformActionInvokeRequest
    {
        internal PlatformActionInvokeRequest(
            string capability,
            PlatformIdempotencyKey idempotencyKey,
            ImmutableArray<PlatformActionAnswer> answers)
        {
            Capability = capability;
            IdempotencyKey = idempotencyKey;
            Answers = answers;
        }

        internal string Capability { get; }

        internal PlatformIdempotencyKey IdempotencyKey { get; }

        internal ImmutableArray<PlatformActionAnswer> Answers { get; }
    }

    /// <summary>Enforces the invoke route's single body-carrier decision.</summary>
    internal static class PlatformActionIdempotencyCarrier
    {
        internal static bool TryResolve(
            PlatformActionInvokeRequest? request,
            StringValues headerValues,
            out PlatformIdempotencyKey key)
        {
            if (request is not null
                && headerValues.Count == 0
                && !string.IsNullOrEmpty(request.IdempotencyKey.Value)
                && PlatformIdempotencyKey.TryParse(request.IdempotencyKey.Value, out key))
            {
                return true;
            }

            key = default;
            return false;
        }
    }

    /// <summary>
    /// Strict known-field reader for the invoke body. Unknown optional fields remain
    /// additive, while duplicate or missing known fields never acquire ambiguous
    /// last-value-wins semantics.
    /// </summary>
    internal sealed class PlatformActionInvokeRequestConverter : JsonConverter<PlatformActionInvokeRequest>
    {
        internal const int MaximumAnswers = 8;
        internal const int MaximumOptionIds = 32;
        internal const int MaximumFieldIdCharacters = 128;

        public override PlatformActionInvokeRequest Read(
            ref Utf8JsonReader reader,
            Type typeToConvert,
            JsonSerializerOptions options)
        {
            if (reader.TokenType != JsonTokenType.StartObject)
            {
                throw new JsonException("The action invocation must be an object.");
            }

            string? capability = null;
            PlatformIdempotencyKey idempotencyKey = default;
            ImmutableArray<PlatformActionAnswer> answers = default;
            var capabilitySeen = false;
            var idempotencySeen = false;
            var answersSeen = false;

            while (reader.Read() && reader.TokenType != JsonTokenType.EndObject)
            {
                if (reader.TokenType != JsonTokenType.PropertyName)
                {
                    throw new JsonException("The action invocation contains invalid JSON members.");
                }

                var property = reader.GetString();
                if (!reader.Read())
                {
                    throw new JsonException("The action invocation ended before a property value.");
                }

                switch (property)
                {
                    case "Capability":
                        RequireFirst(ref capabilitySeen, property);
                        capability = ReadBoundedString(ref reader, PlatformActionCapabilityService.MaximumTokenCharacters, property);
                        break;
                    case "IdempotencyKey":
                        RequireFirst(ref idempotencySeen, property);
                        var rawKey = ReadBoundedString(ref reader, PlatformIdempotencyKey.MaximumLength, property);
                        if (!PlatformIdempotencyKey.TryParse(rawKey, out idempotencyKey))
                        {
                            throw new JsonException("IdempotencyKey is malformed.");
                        }

                        break;
                    case "Answers":
                        RequireFirst(ref answersSeen, property);
                        answers = ReadAnswers(ref reader);
                        break;
                    default:
                        reader.Skip();
                        break;
                }
            }

            if (reader.TokenType != JsonTokenType.EndObject
                || !capabilitySeen
                || !idempotencySeen
                || !answersSeen)
            {
                throw new JsonException("Capability, IdempotencyKey and Answers are required exactly once.");
            }

            return new PlatformActionInvokeRequest(capability!, idempotencyKey, answers);
        }

        public override void Write(
            Utf8JsonWriter writer,
            PlatformActionInvokeRequest value,
            JsonSerializerOptions options)
        {
            ArgumentNullException.ThrowIfNull(writer);
            ArgumentNullException.ThrowIfNull(value);
            writer.WriteStartObject();
            writer.WriteString("Capability", value.Capability);
            writer.WriteString("IdempotencyKey", value.IdempotencyKey.Value);
            writer.WritePropertyName("Answers");
            writer.WriteStartArray();
            foreach (var answer in value.Answers)
            {
                writer.WriteStartObject();
                writer.WriteString("FieldId", answer.FieldId);
                if (answer.BooleanValue is bool booleanValue)
                {
                    writer.WriteBoolean("BooleanValue", booleanValue);
                }
                else
                {
                    writer.WritePropertyName("OptionIds");
                    writer.WriteStartArray();
                    foreach (var optionId in answer.OptionIds!.Value)
                    {
                        writer.WriteStringValue(optionId);
                    }

                    writer.WriteEndArray();
                }

                writer.WriteEndObject();
            }

            writer.WriteEndArray();
            writer.WriteEndObject();
        }

        private static ImmutableArray<PlatformActionAnswer> ReadAnswers(ref Utf8JsonReader reader)
        {
            if (reader.TokenType != JsonTokenType.StartArray)
            {
                throw new JsonException("Answers must be an array.");
            }

            var result = ImmutableArray.CreateBuilder<PlatformActionAnswer>();
            var fieldIds = new HashSet<string>(StringComparer.Ordinal);
            while (reader.Read() && reader.TokenType != JsonTokenType.EndArray)
            {
                if (result.Count >= MaximumAnswers)
                {
                    throw new JsonException("Answers exceeds its fixed element bound.");
                }

                var answer = ReadAnswer(ref reader);
                if (!fieldIds.Add(answer.FieldId))
                {
                    throw new JsonException("Answer field ids must be unique.");
                }

                result.Add(answer);
            }

            if (reader.TokenType != JsonTokenType.EndArray)
            {
                throw new JsonException("Answers is incomplete.");
            }

            return result.ToImmutable();
        }

        private static PlatformActionAnswer ReadAnswer(ref Utf8JsonReader reader)
        {
            if (reader.TokenType != JsonTokenType.StartObject)
            {
                throw new JsonException("Each answer must be an object.");
            }

            string? fieldId = null;
            bool? booleanValue = null;
            ImmutableArray<string>? optionIds = null;
            var fieldSeen = false;
            var booleanSeen = false;
            var optionsSeen = false;

            while (reader.Read() && reader.TokenType != JsonTokenType.EndObject)
            {
                if (reader.TokenType != JsonTokenType.PropertyName)
                {
                    throw new JsonException("An answer contains invalid JSON members.");
                }

                var property = reader.GetString();
                if (!reader.Read())
                {
                    throw new JsonException("An answer ended before a property value.");
                }

                switch (property)
                {
                    case "FieldId":
                        RequireFirst(ref fieldSeen, property);
                        fieldId = ReadBoundedString(ref reader, MaximumFieldIdCharacters, property);
                        if (!PlatformIdempotencyKey.TryParse(fieldId, out _))
                        {
                            throw new JsonException("FieldId is malformed.");
                        }

                        break;
                    case "BooleanValue":
                        RequireFirst(ref booleanSeen, property);
                        if (reader.TokenType is not (JsonTokenType.True or JsonTokenType.False))
                        {
                            throw new JsonException("BooleanValue must be a boolean.");
                        }

                        booleanValue = reader.GetBoolean();
                        break;
                    case "OptionIds":
                        RequireFirst(ref optionsSeen, property);
                        optionIds = ReadOptionIds(ref reader);
                        break;
                    default:
                        reader.Skip();
                        break;
                }
            }

            if (reader.TokenType != JsonTokenType.EndObject
                || !fieldSeen
                || booleanSeen == optionsSeen)
            {
                throw new JsonException("Each answer requires FieldId and exactly one value carrier.");
            }

            return new PlatformActionAnswer(fieldId!, booleanValue, optionIds);
        }

        private static ImmutableArray<string> ReadOptionIds(ref Utf8JsonReader reader)
        {
            if (reader.TokenType != JsonTokenType.StartArray)
            {
                throw new JsonException("OptionIds must be an array.");
            }

            var result = ImmutableArray.CreateBuilder<string>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            while (reader.Read() && reader.TokenType != JsonTokenType.EndArray)
            {
                if (result.Count >= MaximumOptionIds)
                {
                    throw new JsonException("OptionIds exceeds its fixed element bound.");
                }

                var optionId = ReadBoundedString(ref reader, MaximumFieldIdCharacters, "OptionIds");
                if (!PlatformIdempotencyKey.TryParse(optionId, out _) || !seen.Add(optionId))
                {
                    throw new JsonException("OptionIds must contain unique bounded identifiers.");
                }

                result.Add(optionId);
            }

            if (reader.TokenType != JsonTokenType.EndArray)
            {
                throw new JsonException("OptionIds is incomplete.");
            }

            return result.ToImmutable();
        }

        private static string ReadBoundedString(ref Utf8JsonReader reader, int maximumCharacters, string field)
        {
            if (reader.TokenType != JsonTokenType.String)
            {
                throw new JsonException($"{field} must be a string.");
            }

            var value = reader.GetString();
            if (string.IsNullOrEmpty(value) || value.Length > maximumCharacters)
            {
                throw new JsonException($"{field} is outside its fixed bound.");
            }

            return value;
        }

        private static void RequireFirst(ref bool seen, string? property)
        {
            if (seen)
            {
                throw new JsonException($"{property} must not be duplicated.");
            }

            seen = true;
        }
    }
}
