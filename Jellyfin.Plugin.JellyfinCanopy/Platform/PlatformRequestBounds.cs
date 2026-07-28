using System;
using System.Text.Json;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>
    /// The bounds Platform v1 enforces on a request body, and the scanner that checks
    /// them.
    ///
    /// <para>
    /// <b>Why the platform owns these at all.</b> EP-00 measured that the only limit a
    /// plugin gets for free is Kestrel's 30,000,000 bytes, and that exceeding it surfaces
    /// as an <b>opaque 500</b> rather than a 413 (spike-evidence S11). A consumer cannot
    /// tell "you sent too much" from "the server broke", which are entirely different
    /// things to a client author: one is worth fixing in the request, the other is worth
    /// reporting as an outage.
    /// </para>
    /// <para>
    /// <b>Why several axes rather than one.</b> Byte size alone does not bound cost. A
    /// small body can carry pathological nesting, a hundred thousand array elements, or
    /// one enormous string, and each of those costs something different downstream.
    /// <c>System.Text.Json</c> does reject nesting past 64 levels, but as a <i>parse
    /// error</i> — a malformed-input failure, not a "your request was too large" one,
    /// which lands the consumer back in the same ambiguity. So each axis is bounded
    /// independently and reports which one it was.
    /// </para>
    /// </summary>
    public static class PlatformRequestBounds
    {
        /// <summary>
        /// Largest accepted request body.
        ///
        /// Deliberately far below Kestrel's ceiling — see <see cref="HostCeilingBytes"/>
        /// — so the platform's own answer is the one a consumer normally meets.
        /// </summary>
        public const int MaximumBytes = 1_048_576;

        /// <summary>
        /// Deepest accepted nesting.
        ///
        /// Below <c>System.Text.Json</c>'s own limit of 64 on purpose: reaching the
        /// platform's bound produces a structured 413 naming the depth, whereas reaching
        /// the parser's produces a parse error that says only that the JSON was invalid.
        /// </summary>
        public const int MaximumDepth = 32;

        /// <summary>Most elements accepted in any single array.</summary>
        public const int MaximumArrayElements = 10_000;

        /// <summary>Most properties accepted on any single object.</summary>
        public const int MaximumObjectKeys = 1_000;

        /// <summary>Longest accepted single string value, in UTF-8 bytes.</summary>
        public const int MaximumStringBytes = 65_536;

        /// <summary>
        /// Kestrel's own limit, recorded rather than enforced.
        ///
        /// A request at or above this is rejected by host middleware before any plugin
        /// code runs, so it still surfaces as the host's opaque 500 and the platform
        /// cannot improve it. Documented so the gap is visible to consumers instead of
        /// surprising them; <see cref="MaximumBytes"/> covers everything below it.
        /// </summary>
        public const int HostCeilingBytes = 30_000_000;

        /// <summary>Scans <paramref name="body"/> and reports the first bound it breaches.</summary>
        /// <param name="body">The raw request body.</param>
        /// <returns>The breach, or <c>null</c> when every bound holds.</returns>
        public static PlatformBoundBreach? FirstBreach(ReadOnlySpan<byte> body)
        {
            if (body.Length > MaximumBytes)
            {
                return new PlatformBoundBreach("bytes", MaximumBytes);
            }

            // An empty body is not a bounds problem. Whether the endpoint required one is
            // the model binder's question, and answering it here would turn a missing
            // body into a "too large" error.
            if (body.IsEmpty)
            {
                return null;
            }

            // Read with the platform's own depth limit so the reader stops at OUR bound
            // rather than running on to the parser's 64 and reporting malformed JSON.
            // The +1 lets the scanner observe the first offending level and name it,
            // instead of the reader throwing before the check below can run.
            var options = new JsonReaderOptions { MaxDepth = MaximumDepth + 1 };
            var reader = new Utf8JsonReader(body, options);

            // One counter per container level, plus a note of what kind of container
            // sits at each level. Arrays and objects are counted separately because
            // their bounds are independent: a 1,000-key object and a 10,000-element
            // array are both reasonable, and neither implies the other.
            //
            // The kind has to be tracked explicitly. Utf8JsonReader does not expose the
            // enclosing container, and depth alone cannot answer it - a property value
            // and an array element sit at exactly the same depth.
            var slots = MaximumDepth + 2;
            Span<int> counts = stackalloc int[slots];
            Span<bool> insideArray = stackalloc bool[slots];
            counts.Clear();
            insideArray.Clear();

            try
            {
                while (reader.Read())
                {
                    // CurrentDepth counts ENCLOSING containers, so the outermost
                    // container reports 0. A body nested MaximumDepth levels therefore
                    // tops out at MaximumDepth - 1, and anything reaching MaximumDepth is
                    // one level too deep.
                    var depth = reader.CurrentDepth;
                    if (depth >= MaximumDepth)
                    {
                        return new PlatformBoundBreach("depth", MaximumDepth);
                    }

                    if (reader.TokenType == JsonTokenType.PropertyName)
                    {
                        if (++counts[depth] > MaximumObjectKeys)
                        {
                            return new PlatformBoundBreach("objectKeys", MaximumObjectKeys);
                        }

                        continue;
                    }

                    if (reader.TokenType is JsonTokenType.EndArray or JsonTokenType.EndObject)
                    {
                        continue;
                    }

                    // Count first, THEN descend. A nested container is itself an element
                    // of its parent, and charging it after the descent would bill it to
                    // the wrong level.
                    if (insideArray[depth] && ++counts[depth] > MaximumArrayElements)
                    {
                        return new PlatformBoundBreach("arrayElements", MaximumArrayElements);
                    }

                    if (reader.TokenType == JsonTokenType.String)
                    {
                        var stringBytes = reader.HasValueSequence
                            ? reader.ValueSequence.Length
                            : reader.ValueSpan.Length;

                        if (stringBytes > MaximumStringBytes)
                        {
                            return new PlatformBoundBreach("stringBytes", MaximumStringBytes);
                        }
                    }

                    if (reader.TokenType is JsonTokenType.StartArray or JsonTokenType.StartObject)
                    {
                        // Children live one level down. Reset on entry so a sibling
                        // container cannot inherit the count of the one before it.
                        insideArray[depth + 1] = reader.TokenType == JsonTokenType.StartArray;
                        counts[depth + 1] = 0;
                    }
                }
            }
            catch (JsonException)
            {
                // Malformed JSON is not a bounds breach. Reporting it as one would tell a
                // consumer to send less when the real problem is that it sent nonsense;
                // model binding gives the accurate answer a moment later.
                return null;
            }

            return null;
        }
    }

    /// <summary>
    /// A breached bound: which axis, and what its limit is.
    ///
    /// The axis is named so a consumer can act. "Too large" without saying which
    /// dimension leaves a client author guessing whether to send fewer items, shorter
    /// strings, or a flatter shape.
    /// </summary>
    /// <param name="Axis">The bound that was exceeded, for example <c>bytes</c> or <c>depth</c>.</param>
    /// <param name="Limit">The value of that bound.</param>
    public readonly record struct PlatformBoundBreach(string Axis, int Limit);
}
