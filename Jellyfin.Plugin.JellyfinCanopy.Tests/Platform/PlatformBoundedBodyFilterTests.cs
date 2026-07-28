using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Microsoft.AspNetCore.Routing;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    /// <summary>
    /// The filter that turns a breached bound into a structured <c>413</c>.
    ///
    /// EP-00 measured that the only limit a plugin gets for free is Kestrel's, and that
    /// exceeding it produces an opaque <c>500</c> — indistinguishable from the server
    /// breaking. These tests are about the response a consumer can actually act on.
    /// </summary>
    public class PlatformBoundedBodyFilterTests
    {
        /// <summary>A body that reports no length, the way a chunked request does.</summary>
        private sealed class UnlengthedStream : Stream
        {
            private readonly MemoryStream _inner;

            public UnlengthedStream(byte[] content) => _inner = new MemoryStream(content);

            public override bool CanRead => true;

            public override bool CanSeek => false;

            public override bool CanWrite => false;

            public override long Length => throw new NotSupportedException();

            public override long Position
            {
                get => throw new NotSupportedException();
                set => throw new NotSupportedException();
            }

            public override int Read(byte[] buffer, int offset, int count) => _inner.Read(buffer, offset, count);

            public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
                => _inner.ReadAsync(buffer, cancellationToken);

            public override void Flush()
            {
            }

            public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

            public override void SetLength(long value) => throw new NotSupportedException();

            public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        }

        private static ResourceExecutingContext Context(HttpContext http) => new(
            new ActionContext(http, new RouteData(), new ControllerActionDescriptor()),
            new List<IFilterMetadata>(),
            new List<IValueProviderFactory>());

        private static async Task<(ResourceExecutingContext Context, bool Continued)> RunAsync(HttpContext http)
        {
            var context = Context(http);
            var continued = false;

            await new PlatformBoundedBodyFilter().OnResourceExecutionAsync(context, () =>
            {
                continued = true;
                return Task.FromResult(new ResourceExecutedContext(context, new List<IFilterMetadata>()));
            });

            return (context, continued);
        }

        private static HttpContext Request(byte[] body, bool declareLength = true)
        {
            var http = new DefaultHttpContext();
            http.Request.Body = declareLength ? new MemoryStream(body) : new UnlengthedStream(body);

            if (declareLength)
            {
                http.Request.ContentLength = body.Length;
            }

            return http;
        }

        private static byte[] Body(string json) => Encoding.UTF8.GetBytes(json);

        [Fact]
        public async Task AWellFormedBodyIsPassedThroughUnchanged()
        {
            var body = Body("""{"protocol":1,"items":[1,2,3]}""");
            var http = Request(body);

            var (context, continued) = await RunAsync(http);

            Assert.True(continued);
            Assert.Null(context.Result);
        }

        [Fact]
        public async Task ABodyOverTheDeclaredLengthIsRefusedBeforeAnyByteIsRead()
        {
            // Content-Length lets an oversized request be refused without reading it,
            // which is the cheapest possible outcome and the point of checking it first.
            var http = new DefaultHttpContext();
            http.Request.ContentLength = PlatformRequestBounds.MaximumBytes + 1;
            http.Request.Body = new MemoryStream(Array.Empty<byte>());

            var (context, continued) = await RunAsync(http);

            Assert.False(continued);

            var result = Assert.IsType<ObjectResult>(context.Result);
            Assert.Equal(413, result.StatusCode);
        }

        [Fact]
        public async Task ABodyThatLiesAboutItsLengthIsStillRefused()
        {
            // A chunked request declares no length at all, and a declared length can
            // simply be wrong. Trusting the header alone would leave the actual limit
            // unenforced for exactly the requests most likely to be hostile.
            var oversized = Body("[\"" + new string('x', PlatformRequestBounds.MaximumBytes) + "\"]");
            var http = Request(oversized, declareLength: false);

            var (context, continued) = await RunAsync(http);

            Assert.False(continued);

            var result = Assert.IsType<ObjectResult>(context.Result);
            Assert.Equal(413, result.StatusCode);
        }

        [Fact]
        public async Task ARefusalUsesTheOnePlatformEnvelopeAndNamesTheAxis()
        {
            var tooDeep = Body(new string('[', PlatformRequestBounds.MaximumDepth + 1)
                + new string(']', PlatformRequestBounds.MaximumDepth + 1));

            var (context, _) = await RunAsync(Request(tooDeep));

            var result = Assert.IsType<ObjectResult>(context.Result);
            var payload = Assert.IsType<PlatformError>(result.Value);

            Assert.Equal(413, result.StatusCode);
            Assert.Equal(PlatformErrorCode.PayloadTooLarge, payload.Code);

            // Not retryable: sending the identical body again cannot succeed, and telling
            // a client otherwise invites a pointless retry loop.
            Assert.False(payload.Retryable);

            // Naming the axis is what makes the error actionable - "too large" alone
            // leaves a client author guessing between fewer items, shorter strings and a
            // flatter shape.
            Assert.Contains("depth", payload.Message, StringComparison.Ordinal);
        }

        [Fact]
        public async Task ARefusalCarriesACorrelationIdInBothTheBodyAndTheHeader()
        {
            // This rejection happens BEFORE the action filter that normally assigns the
            // id. Without doing it here, the one response a consumer most needs to report
            // would be the only one with nothing to quote.
            var http = Request(Body("[\"" + new string('x', PlatformRequestBounds.MaximumStringBytes + 1) + "\"]"));

            var (context, _) = await RunAsync(http);

            var payload = Assert.IsType<PlatformError>(Assert.IsType<ObjectResult>(context.Result).Value);

            Assert.False(string.IsNullOrEmpty(payload.CorrelationId));
            Assert.Equal(payload.CorrelationId, http.Response.Headers[PlatformCorrelation.HeaderName].ToString());

            // And it is the same id the rest of the request would have used, not a
            // second one invented for the error path.
            Assert.Equal(PlatformCorrelation.For(http), payload.CorrelationId);
        }

        [Fact]
        public async Task ThePipelineStillSeesTheBodyAfterItHasBeenBuffered()
        {
            // The filter has to read the body to bound it, which consumes the stream.
            // Failing to hand a replayable copy onward would leave model binding looking
            // at an empty request - a bug that only shows up on valid input.
            var body = Body("""{"name":"spoiler-guard"}""");
            var http = Request(body);
            var context = Context(http);
            var seen = string.Empty;

            await new PlatformBoundedBodyFilter().OnResourceExecutionAsync(context, async () =>
            {
                using var reader = new StreamReader(http.Request.Body);
                seen = await reader.ReadToEndAsync();
                return new ResourceExecutedContext(context, new List<IFilterMetadata>());
            });

            Assert.Equal("""{"name":"spoiler-guard"}""", seen);
        }

        [Fact]
        public void TheFilterRunsBeforeModelBindingAndAfterAuthorization()
        {
            // Resource filters sit in exactly that window, which is the only place a body
            // can be refused without first deserializing it - deserializing to discover
            // it was too big to deserialize is the cost this exists to avoid. Being after
            // authorization also keeps 401/403 bare (ADR-0002).
            var filter = new PlatformBoundedBodyFilter();

            Assert.IsAssignableFrom<IAsyncResourceFilter>(filter);
            Assert.Equal(int.MinValue, filter.Order);
        }

        [Fact]
        public void EveryPlatformControllerInheritsTheBoundsFilter()
        {
            // Declared on the base, so a new endpoint is bounded without opting in - the
            // same fail-closed shape as authorization and the error envelope.
            var declared = typeof(PlatformControllerBase)
                .GetCustomAttributes(typeof(TypeFilterAttribute), inherit: true)
                .Cast<TypeFilterAttribute>()
                .Any(attribute => attribute.ImplementationType == typeof(PlatformBoundedBodyFilter));

            Assert.True(declared);

            var derived = typeof(PlatformControllerBase).Assembly
                .GetTypes()
                .Where(type => !type.IsAbstract && typeof(PlatformControllerBase).IsAssignableFrom(type));

            Assert.All(derived, type => Assert.Contains(
                type.GetCustomAttributes(typeof(TypeFilterAttribute), inherit: true).Cast<TypeFilterAttribute>(),
                attribute => attribute.ImplementationType == typeof(PlatformBoundedBodyFilter)));
        }
    }
}
