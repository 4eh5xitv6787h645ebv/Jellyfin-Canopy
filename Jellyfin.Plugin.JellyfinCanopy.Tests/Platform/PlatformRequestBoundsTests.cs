using System;
using System.Linq;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    /// <summary>
    /// Boundary tests for the platform's request bounds.
    ///
    /// Every axis is checked at the limit and at the limit plus one, because a bound
    /// that is only ever tested far from its edge does not tell you where the edge is —
    /// an off-by-one here either rejects a legitimate request or admits the one the
    /// bound exists to stop.
    /// </summary>
    public class PlatformRequestBoundsTests
    {
        private static byte[] Json(string text) => Encoding.UTF8.GetBytes(text);

        private static PlatformBoundBreach? Scan(string text) => PlatformRequestBounds.FirstBreach(Json(text));

        private static string Nested(int depth)
        {
            // depth == the number of nested containers, so Nested(1) is a bare "[]".
            var builder = new StringBuilder();
            builder.Append('[', depth);
            builder.Append(']', depth);
            return builder.ToString();
        }

        [Fact]
        public void AnEmptyBodyIsNotABoundsProblem()
        {
            // Whether the endpoint required a body is the model binder's question.
            // Answering it here would turn "you sent nothing" into "you sent too much".
            Assert.Null(PlatformRequestBounds.FirstBreach(ReadOnlySpan<byte>.Empty));
        }

        [Fact]
        public void AnOrdinaryBodyPasses()
        {
            Assert.Null(Scan("""{"protocol":1,"items":[1,2,3],"name":"spoiler-guard"}"""));
        }

        [Fact]
        public void BytesAreBoundedAtTheLimitAndRejectedOneByteAbove()
        {
            // A string body padded to land exactly on, then one past, the byte bound.
            // A padded array of one-character strings, so the byte bound is reached
            // without any single string approaching its own bound.
            static string Padded(int totalBytes)
            {
                const string Prefix = "[\"";
                const string Suffix = "\"]";
                return Prefix + new string('x', totalBytes - Prefix.Length - Suffix.Length) + Suffix;
            }

            var atLimit = Padded(PlatformRequestBounds.MaximumBytes);
            Assert.Equal(PlatformRequestBounds.MaximumBytes, Json(atLimit).Length);

            // At the limit, the byte bound itself must not fire. The string inside is
            // longer than the string bound, so assert on the axis rather than on null.
            Assert.NotEqual("bytes", Scan(atLimit)?.Axis);

            var overLimit = Padded(PlatformRequestBounds.MaximumBytes + 1);
            Assert.Equal(PlatformRequestBounds.MaximumBytes + 1, Json(overLimit).Length);
            Assert.Equal("bytes", Scan(overLimit)?.Axis);
            Assert.Equal(PlatformRequestBounds.MaximumBytes, Scan(overLimit)?.Limit);
        }

        [Fact]
        public void DepthIsBoundedAtTheLimitAndRejectedOneLevelDeeper()
        {
            Assert.Null(Scan(Nested(PlatformRequestBounds.MaximumDepth)));

            var breach = Scan(Nested(PlatformRequestBounds.MaximumDepth + 1));
            Assert.Equal("depth", breach?.Axis);
            Assert.Equal(PlatformRequestBounds.MaximumDepth, breach?.Limit);
        }

        [Fact]
        public void ArrayElementsAreBoundedAtTheLimitAndRejectedOneElementAbove()
        {
            var atLimit = "[" + string.Join(',', Enumerable.Repeat('1', PlatformRequestBounds.MaximumArrayElements)) + "]";
            Assert.Null(Scan(atLimit));

            var overLimit = "[" + string.Join(',', Enumerable.Repeat('1', PlatformRequestBounds.MaximumArrayElements + 1)) + "]";
            var breach = Scan(overLimit);
            Assert.Equal("arrayElements", breach?.Axis);
            Assert.Equal(PlatformRequestBounds.MaximumArrayElements, breach?.Limit);
        }

        [Fact]
        public void ObjectKeysAreBoundedAtTheLimitAndRejectedOneKeyAbove()
        {
            static string Object(int keys) =>
                "{" + string.Join(',', Enumerable.Range(0, keys).Select(index => $"\"k{index}\":1")) + "}";

            Assert.Null(Scan(Object(PlatformRequestBounds.MaximumObjectKeys)));

            var breach = Scan(Object(PlatformRequestBounds.MaximumObjectKeys + 1));
            Assert.Equal("objectKeys", breach?.Axis);
            Assert.Equal(PlatformRequestBounds.MaximumObjectKeys, breach?.Limit);
        }

        [Fact]
        public void StringLengthIsBoundedAtTheLimitAndRejectedOneByteAbove()
        {
            Assert.Null(Scan("[\"" + new string('x', PlatformRequestBounds.MaximumStringBytes) + "\"]"));

            var breach = Scan("[\"" + new string('x', PlatformRequestBounds.MaximumStringBytes + 1) + "\"]");
            Assert.Equal("stringBytes", breach?.Axis);
            Assert.Equal(PlatformRequestBounds.MaximumStringBytes, breach?.Limit);
        }

        [Fact]
        public void StringLengthIsCountedInBytesNotCharacters()
        {
            // A multi-byte character costs what it costs on the wire. '€' is three UTF-8
            // bytes, so a string of this many characters is over the byte bound while
            // being comfortably under it by character count - counting characters would
            // let a body three times the intended size through.
            var characters = (PlatformRequestBounds.MaximumStringBytes / 3) + 1;
            Assert.True(characters < PlatformRequestBounds.MaximumStringBytes);

            Assert.Equal("stringBytes", Scan("[\"" + new string('€', characters) + "\"]")?.Axis);
        }

        [Fact]
        public void SiblingContainersDoNotShareACount()
        {
            // The bug this catches: counting per depth without resetting on entry, so two
            // legal arrays side by side add up and the second one is rejected.
            var half = PlatformRequestBounds.MaximumArrayElements;
            var element = "[" + string.Join(',', Enumerable.Repeat('1', half)) + "]";

            Assert.Null(Scan($"[{element},{element}]"));
        }

        [Fact]
        public void ANestedContainerIsChargedToItsParentNotToItself()
        {
            // Each inner array is one element of the outer one. Billing it to the inner
            // level instead would let an outer array of unlimited width through.
            var inner = string.Join(',', Enumerable.Repeat("[1]", PlatformRequestBounds.MaximumArrayElements + 1));

            Assert.Equal("arrayElements", Scan($"[{inner}]")?.Axis);
        }

        [Fact]
        public void PropertyValuesAreNotCountedAsArrayElements()
        {
            // The two axes must not double-charge the same member: a property name is
            // already counted as a key, so its value must not also count as an element.
            var keys = PlatformRequestBounds.MaximumObjectKeys;
            var body = "{" + string.Join(',', Enumerable.Range(0, keys).Select(index => $"\"k{index}\":1")) + "}";

            Assert.Null(Scan(body));
        }

        [Fact]
        public void MalformedJsonIsNotReportedAsABoundsBreach()
        {
            // Telling a consumer to send less when the real problem is that it sent
            // nonsense sends it looking in the wrong place. Model binding gives the
            // accurate answer a moment later.
            Assert.Null(Scan("{\"a\": "));
            Assert.Null(Scan("not json at all"));
        }

        [Fact]
        public void EveryPlatformBoundSitsWellBelowTheHostCeiling()
        {
            // The platform's answer has to be the one a consumer normally meets. A bound
            // at or near Kestrel's ceiling would let the host's opaque 500 win the race.
            Assert.True(
                PlatformRequestBounds.MaximumBytes < PlatformRequestBounds.HostCeilingBytes / 10,
                "The platform byte bound must stay far below the host ceiling so the structured 413 "
                + "is what consumers actually receive.");
        }

        [Fact]
        public void TheDepthBoundStaysBelowTheJsonParsersOwn()
        {
            // System.Text.Json rejects nesting past 64, but as a PARSE error - malformed
            // input, not "too large". Reaching our bound first is what turns that into a
            // structured 413 naming the depth.
            const int ParserDefaultMaxDepth = 64;

            Assert.True(PlatformRequestBounds.MaximumDepth < ParserDefaultMaxDepth);

            // And prove the parser really would have accepted what we reject, so the
            // bound is ours rather than inherited.
            var justOverOurs = Nested(PlatformRequestBounds.MaximumDepth + 1);
            var exception = Record.Exception(() => JsonDocument.Parse(justOverOurs).Dispose());

            Assert.Null(exception);
            Assert.Equal("depth", Scan(justOverOurs)?.Axis);
        }

        [Fact]
        public void TheHostCeilingGapIsDocumentedRatherThanPromisedAway()
        {
            // EP-00 (spike-evidence S11): a request at or above Kestrel's limit is
            // rejected by host middleware before any plugin code runs, so it still
            // surfaces as the host's opaque 500. The platform covers everything between
            // its own bound and that ceiling, and cannot cover the ceiling itself.
            //
            // Pinned as a constant so the gap stays visible to consumers instead of
            // being quietly forgotten and later re-discovered as a bug.
            Assert.Equal(30_000_000, PlatformRequestBounds.HostCeilingBytes);
        }
    }
}
