using System;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>The pinned Platform v1 JSON wire format.</summary>
    internal static class PlatformJson
    {
        internal static JsonSerializerOptions SerializerOptions { get; } = CreateOptions();

        private static JsonSerializerOptions CreateOptions()
        {
            var options = new JsonSerializerOptions
            {
                PropertyNamingPolicy = null,
                PropertyNameCaseInsensitive = false,
                UnmappedMemberHandling = JsonUnmappedMemberHandling.Skip,
            };

            options.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase, allowIntegerValues: false));
            options.Converters.Add(new PlatformDateTimeConverter());
            options.Converters.Add(new PlatformDateTimeOffsetConverter());
            options.Converters.Add(new PlatformGuidConverter());
            return options;
        }

        private static DateTimeOffset ReadUtc(ref Utf8JsonReader reader)
        {
            if (reader.TokenType != JsonTokenType.String)
            {
                throw new JsonException("Expected an RFC 3339 timestamp string with an explicit UTC offset.");
            }

            var raw = reader.GetString();
            var zulu = raw is not null && raw.EndsWith('Z');
            var explicitZero = raw is not null && raw.EndsWith("+00:00", StringComparison.Ordinal);
            var value = default(DateTimeOffset);
            var valid = zulu
                ? DateTimeOffset.TryParseExact(
                    raw,
                    new[] { "yyyy-MM-dd'T'HH:mm:ss'Z'", "yyyy-MM-dd'T'HH:mm:ss.FFFFFFF'Z'" },
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                    out value)
                : explicitZero && DateTimeOffset.TryParseExact(
                    raw,
                    new[] { "yyyy-MM-dd'T'HH:mm:sszzz", "yyyy-MM-dd'T'HH:mm:ss.FFFFFFFzzz" },
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.None,
                    out value);

            if (!valid || value.Offset != TimeSpan.Zero)
            {
                throw new JsonException("Expected an RFC 3339 timestamp with an explicit UTC offset.");
            }

            return value.ToUniversalTime();
        }

        private sealed class PlatformDateTimeConverter : JsonConverter<DateTime>
        {
            public override DateTime Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
                => ReadUtc(ref reader).UtcDateTime;

            public override void Write(Utf8JsonWriter writer, DateTime value, JsonSerializerOptions options)
            {
                var utc = value.Kind == DateTimeKind.Unspecified
                    ? DateTime.SpecifyKind(value, DateTimeKind.Utc)
                    : value.ToUniversalTime();
                writer.WriteStringValue(new DateTimeOffset(utc).ToString("O", CultureInfo.InvariantCulture));
            }
        }

        private sealed class PlatformDateTimeOffsetConverter : JsonConverter<DateTimeOffset>
        {
            public override DateTimeOffset Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
                => ReadUtc(ref reader);

            public override void Write(Utf8JsonWriter writer, DateTimeOffset value, JsonSerializerOptions options)
                => writer.WriteStringValue(value.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture));
        }

        private sealed class PlatformGuidConverter : JsonConverter<Guid>
        {
            public override Guid Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
            {
                if (reader.TokenType != JsonTokenType.String)
                {
                    throw new JsonException("Expected a lowercase canonical GUID string.");
                }

                var raw = reader.GetString();
                if (!Guid.TryParseExact(raw, "D", out var value)
                    || !string.Equals(raw, value.ToString("D", CultureInfo.InvariantCulture), StringComparison.Ordinal))
                {
                    throw new JsonException("Expected a lowercase canonical GUID.");
                }

                return value;
            }

            public override void Write(Utf8JsonWriter writer, Guid value, JsonSerializerOptions options)
                => writer.WriteStringValue(value.ToString("D", CultureInfo.InvariantCulture).ToLowerInvariant());
        }
    }
}
