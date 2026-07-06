using System;
using System.Buffers;
using System.Linq;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinEnhanced.Configuration
{
    /// <summary>
    /// The single System.Text.Json configuration for every JSON file the plugin
    /// persists to disk (per-user settings/shortcuts/bookmarks/elsewhere/
    /// hidden-content/watchlist files, the shared reviews.json, and
    /// maintenance-state.json).
    ///
    /// These options replicate the exact on-disk format and read tolerance of
    /// the original Newtonsoft.Json persistence path, so files written by any
    /// previous plugin version keep reading correctly and files written by this
    /// version stay readable by older plugin versions. The contract is pinned
    /// byte-for-byte by UserFileFormatGoldenTests and semantically by
    /// UserFileReadCompatTests — change anything here only with those tests.
    /// </summary>
    internal static class PersistedJson
    {
        /// <summary>
        /// Write options — Newtonsoft equivalent:
        /// <c>JsonConvert.SerializeObject(value, Formatting.Indented)</c> with default settings.
        /// </summary>
        internal static readonly JsonSerializerOptions WriteOptions = new JsonSerializerOptions
        {
            // Newtonsoft Formatting.Indented: 2-space indent (both stacks default to
            // 2 spaces and to Environment.NewLine line breaks on .NET 9+).
            WriteIndented = true,

            // Newtonsoft StringEscapeHandling.Default escapes only quotes, backslash
            // and control characters; STJ's default encoder would \uXXXX-escape all
            // non-ASCII, changing every existing accented/CJK value on disk. The
            // relaxed encoder keeps BMP text raw. (Known residual difference: astral
            // -plane chars (emoji) are still written as surrogate-pair escapes —
            // semantically identical JSON, pinned by EmojiLabel_RoundTripsByValue.)
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,

            // Newtonsoft NullValueHandling.Include (default) on the WRITE path:
            // null properties are written out, not omitted. STJ's default is the
            // same (DefaultIgnoreCondition = Never) — spelled out here because the
            // old read path's NullValueHandling.Ignore comment makes it easy to
            // assume nulls were skipped everywhere.
            DefaultIgnoreCondition = JsonIgnoreCondition.Never,

            // No PropertyNamingPolicy: property names serialize as-is (PascalCase),
            // exactly like Newtonsoft's default ContractResolver.
        };

        /// <summary>
        /// Read options — Newtonsoft equivalent: <c>JsonConvert.DeserializeObject&lt;T&gt;(json)</c>
        /// with default settings. Both read paths (lenient GET and strict RMW) apply
        /// <see cref="StripNullMembers"/> first (= NullValueHandling.Ignore on read), so a
        /// legacy JSON null on a now-non-nullable property is skipped rather than treated
        /// as corruption on either path.
        /// </summary>
        internal static readonly JsonSerializerOptions ReadOptions = new JsonSerializerOptions
        {
            // Newtonsoft matches member names case-insensitively by default. Files
            // written via the raw client-JSON pass-through have camelCase keys on disk.
            PropertyNameCaseInsensitive = true,

            // Newtonsoft's reader tolerates trailing commas and comments (relevant
            // for hand-edited user files).
            AllowTrailingCommas = true,
            ReadCommentHandling = JsonCommentHandling.Skip,

            // Newtonsoft coerces numeric strings to numbers ("7" -> 7). Legacy files
            // written from raw client payloads rely on this.
            NumberHandling = JsonNumberHandling.AllowReadingFromString,

            // Newtonsoft also coerces number/bool tokens to string properties and
            // string/number tokens to bool properties; see the converters.
            Converters = { new LenientStringConverter(), new LenientBooleanConverter() },

            // Unknown members are ignored by default in both stacks
            // (Newtonsoft MissingMemberHandling.Ignore).
        };

        /// <summary>
        /// Parse options matching the reader tolerance of <see cref="ReadOptions"/>
        /// for the JsonNode-based lenient pre-pass.
        /// </summary>
        internal static readonly JsonDocumentOptions ParseOptions = new JsonDocumentOptions
        {
            AllowTrailingCommas = true,
            CommentHandling = JsonCommentHandling.Skip,
        };

        /// <summary>
        /// Newtonsoft <c>NullValueHandling.Ignore</c> on DESERIALIZATION: a JSON null
        /// member is skipped entirely, so the target property keeps its constructor
        /// default instead of being set to null (or throwing for non-nullable types).
        /// STJ has no equivalent option, so the lenient read path removes null-valued
        /// object members before binding. Null ARRAY elements are kept (Newtonsoft's
        /// setting never applied to collection items). Null dictionary entries are
        /// removed — Newtonsoft materialized them as null values, which no caller can
        /// use; dropping them is the safe reading of the same file.
        /// </summary>
        internal static JsonNode? StripNullMembers(JsonNode? node)
        {
            switch (node)
            {
                case JsonObject obj:
                    foreach (var key in obj.Where(kv => kv.Value is null).Select(kv => kv.Key).ToList())
                    {
                        obj.Remove(key);
                    }

                    foreach (var kv in obj)
                    {
                        StripNullMembers(kv.Value);
                    }

                    break;

                case JsonArray arr:
                    foreach (var element in arr)
                    {
                        StripNullMembers(element);
                    }

                    break;
            }

            return node;
        }

        /// <summary>
        /// Newtonsoft coerced non-string primitives into string properties
        /// (e.g. a legacy client payload stored <c>"TmdbId": 27205</c> as a number;
        /// the DTO property is string). Numbers keep their raw JSON text; booleans
        /// become "True"/"False" (Convert.ToString parity with Newtonsoft).
        /// </summary>
        private sealed class LenientStringConverter : JsonConverter<string>
        {
            public override string? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
            {
                switch (reader.TokenType)
                {
                    case JsonTokenType.String:
                        return reader.GetString();
                    case JsonTokenType.Number:
                        return Encoding.UTF8.GetString(reader.HasValueSequence ? reader.ValueSequence.ToArray() : reader.ValueSpan);
                    case JsonTokenType.True:
                        return "True";
                    case JsonTokenType.False:
                        return "False";
                    default:
                        throw new JsonException($"Cannot convert {reader.TokenType} token to string.");
                }
            }

            public override void Write(Utf8JsonWriter writer, string value, JsonSerializerOptions options)
                => writer.WriteStringValue(value);
        }

        /// <summary>
        /// Newtonsoft coerced "true"/"false" strings and 0/1 numbers into bool
        /// properties. Same tolerance here; anything unparseable throws JsonException
        /// exactly like an incompatible token would.
        /// </summary>
        private sealed class LenientBooleanConverter : JsonConverter<bool>
        {
            public override bool Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
            {
                switch (reader.TokenType)
                {
                    case JsonTokenType.True:
                        return true;
                    case JsonTokenType.False:
                        return false;
                    case JsonTokenType.String:
                        var text = reader.GetString();
                        if (bool.TryParse(text, out var parsed))
                        {
                            return parsed;
                        }

                        throw new JsonException($"Cannot convert string '{text}' to bool.");
                    case JsonTokenType.Number:
                        // Convert.ToBoolean parity: any non-zero number is true.
                        return reader.GetDouble() != 0;
                    default:
                        throw new JsonException($"Cannot convert {reader.TokenType} token to bool.");
                }
            }

            public override void Write(Utf8JsonWriter writer, bool value, JsonSerializerOptions options)
                => writer.WriteBooleanValue(value);
        }
    }
}
