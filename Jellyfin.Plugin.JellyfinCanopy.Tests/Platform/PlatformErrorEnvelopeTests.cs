using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Microsoft.AspNetCore.Mvc;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    /// <summary>
    /// Pins the one Platform v1 error envelope and the enumerated code set.
    ///
    /// The legacy surface returns at least four shapes for a failure. The value of this
    /// envelope is entirely in its being singular and stable, so these tests are
    /// deliberately strict about both.
    /// </summary>
    public class PlatformErrorEnvelopeTests
    {
        [Fact]
        public void EnvelopeSerializesToExactlyTheDocumentedShape()
        {
            // Golden test. A consumer parses this; adding, removing or renaming a field is
            // a protocol change, so it has to be made here deliberately.
            var json = JsonSerializer.Serialize(new PlatformError
            {
                Code = PlatformErrorCode.NotFound,
                Message = "No such extension.",
                Retryable = false,
                CorrelationId = "0123456789abcdef0123456789abcdef",
            });

            Assert.Equal(
                "{\"Error\":true,"
                + "\"Code\":\"not_found\","
                + "\"Message\":\"No such extension.\","
                + "\"Retryable\":false,"
                + "\"CorrelationId\":\"0123456789abcdef0123456789abcdef\"}",
                json);
        }

        [Fact]
        public void EnvelopeHasNoFieldsBeyondTheDocumentedFive()
        {
            // The complement of the golden test: it would still pass if a property were
            // added that happened to serialize last, or that carried [JsonIgnore].
            var properties = typeof(PlatformError).GetProperties().Select(p => p.Name).OrderBy(n => n, StringComparer.Ordinal);

            Assert.Equal(
                new[] { "Code", "CorrelationId", "Error", "Message", "Retryable" },
                properties);
        }

        [Fact]
        public void EveryCodeIsEnumeratedWithExactlyOneStatus()
        {
            // "Machine codes are an enumerated, documented set - not free-form strings."
            // This is the test that keeps that true.
            Assert.Equal(
                new[]
                {
                    "conflict",
                    "internal_error",
                    "invalid_request",
                    "not_found",
                    "payload_too_large",
                    "precondition_failed",
                    "rate_limited",
                    "timeout",
                    "unavailable",
                    "unsupported_media_type",
                    "unsupported_protocol",
                },
                PlatformErrorCode.All.OrderBy(code => code, StringComparer.Ordinal));
        }

        [Theory]
        [InlineData(PlatformErrorCode.InvalidRequest, 400, false)]
        [InlineData(PlatformErrorCode.UnsupportedMediaType, 415, false)]
        [InlineData(PlatformErrorCode.UnsupportedProtocol, 400, false)]
        [InlineData(PlatformErrorCode.NotFound, 404, false)]
        [InlineData(PlatformErrorCode.Conflict, 409, false)]
        [InlineData(PlatformErrorCode.PreconditionFailed, 412, false)]
        [InlineData(PlatformErrorCode.PayloadTooLarge, 413, false)]
        [InlineData(PlatformErrorCode.RateLimited, 429, true)]
        [InlineData(PlatformErrorCode.InternalError, 500, true)]
        [InlineData(PlatformErrorCode.Unavailable, 503, true)]
        [InlineData(PlatformErrorCode.Timeout, 504, true)]
        public void EachCodeMapsToItsDocumentedStatusAndRetryability(string code, int status, bool retryable)
        {
            Assert.Equal(status, PlatformErrorCode.StatusFor(code));
            Assert.Equal(retryable, PlatformErrorCode.IsRetryable(code));
        }

        [Fact]
        public void RetryabilityIsAPropertyOfTheCodeAndNotOfTheCallSite()
        {
            // Two endpoints returning the same code cannot disagree about whether it is
            // worth retrying, because no overload lets either of them say.
            var first = Assert.IsType<PlatformError>(
                PlatformResults.Error(PlatformErrorCode.Unavailable, "Seerr is unreachable.", "a").Value);
            var second = Assert.IsType<PlatformError>(
                PlatformResults.Error(PlatformErrorCode.Unavailable, "Sonarr is unreachable.", "b").Value);

            Assert.True(first.Retryable);
            Assert.Equal(first.Retryable, second.Retryable);
        }

        [Fact]
        public void AnInventedCodeIsRefusedRatherThanServed()
        {
            // The failure mode this whole type exists to prevent: a free-form string
            // reaching the wire and becoming something a consumer starts depending on.
            var thrown = Assert.Throws<ArgumentOutOfRangeException>(
                () => PlatformResults.Error("seerr_exploded", "...", "correlation"));

            Assert.Contains("enumerated set", thrown.Message, StringComparison.Ordinal);
            Assert.False(PlatformErrorCode.IsKnown("seerr_exploded"));
        }

        [Fact]
        public void ErrorResultCarriesTheCodesStatusRatherThanTheCallSitesChoice()
        {
            var result = PlatformResults.Error(PlatformErrorCode.Conflict, "Revision is stale.", "abc");

            Assert.Equal(409, result.StatusCode);

            var payload = Assert.IsType<PlatformError>(result.Value);
            Assert.True(payload.Error);
            Assert.Equal(PlatformErrorCode.Conflict, payload.Code);
            Assert.Equal("Revision is stale.", payload.Message);
            Assert.Equal("abc", payload.CorrelationId);
        }

        [Fact]
        public void TheEnvelopeIsASupersetOfTheRichestLegacyShape()
        {
            // Legacy endpoints are explicitly NOT retrofitted. That is only tolerable if
            // an adapter can degrade a platform failure to the legacy shape by dropping
            // fields, never by inventing or translating them.
            var platformFields = typeof(PlatformError).GetProperties().Select(p => p.Name).ToHashSet(StringComparer.Ordinal);

            // { error = true, code = "...", message = "..." } - the richest of the four
            // shapes the legacy surface currently returns.
            foreach (var legacyField in new[] { "Error", "Code", "Message" })
            {
                Assert.Contains(legacyField, platformFields);
            }
        }
    }
}
