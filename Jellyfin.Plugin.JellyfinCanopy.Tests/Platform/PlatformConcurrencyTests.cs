using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.ResponseCompression;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Primitives;
using Microsoft.Net.Http.Headers;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    public class PlatformConcurrencyTests
    {
        private sealed class UnmarkedController : PlatformControllerBase
        {
            public IActionResult Get() => new OkObjectResult(new { Value = 1 });
        }

        private sealed class ValidatedPostController : PlatformControllerBase
        {
            [PlatformValidatedRepresentation]
            public IActionResult Post() => new OkObjectResult(new { Value = 1 });
        }

        [Fact]
        public async Task CacheableSuccessUsesStrongSha256OfExactWireBytes()
        {
            var response = await RunDiscoveryAsync();
            var body = Assert.IsType<MemoryStream>(response.Body).ToArray();
            var expectedHash = Convert.ToHexString(SHA256.HashData(body)).ToLowerInvariant();

            Assert.Equal(StatusCodes.Status200OK, response.StatusCode);
            Assert.Equal($"\"sha256-{expectedHash}\"", response.Headers.ETag.ToString());
            Assert.False(EntityTagHeaderValue.Parse(new StringSegment(response.Headers.ETag.ToString())).IsWeak);
            Assert.Equal("application/json", response.ContentType);
            Assert.Equal(body.Length, response.ContentLength);

            using var json = JsonDocument.Parse(body);
            Assert.True(json.RootElement.GetProperty(nameof(PlatformDiscoveryResponse.Available)).GetBoolean());
        }

        [Theory]
        [InlineData(false)]
        [InlineData(true)]
        public async Task IfNoneMatchUsesWeakComparisonAndReturnsBodyless304(bool weak)
        {
            var first = await RunDiscoveryAsync();
            var tag = first.Headers.ETag.ToString();

            var response = await RunDiscoveryAsync(ifNoneMatch: weak ? "W/" + tag : tag);

            Assert.Equal(StatusCodes.Status304NotModified, response.StatusCode);
            Assert.Equal(tag, response.Headers.ETag.ToString());
            Assert.Empty(Assert.IsType<MemoryStream>(response.Body).ToArray());
            Assert.Null(response.ContentType);
            Assert.Null(response.ContentLength);
        }

        [Fact]
        public async Task IfNoneMatchMismatchReturnsCurrentRepresentation()
        {
            var response = await RunDiscoveryAsync(ifNoneMatch: "\"sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"");

            Assert.Equal(StatusCodes.Status200OK, response.StatusCode);
            Assert.NotEmpty(Assert.IsType<MemoryStream>(response.Body).ToArray());
        }

        [Fact]
        public async Task IfMatchUsesStrongComparison()
        {
            var first = await RunDiscoveryAsync();
            var tag = first.Headers.ETag.ToString();

            var strong = await RunDiscoveryAsync(ifMatch: tag);
            var weak = await RunDiscoveryAsync(ifMatch: "W/" + tag);

            Assert.Equal(StatusCodes.Status200OK, strong.StatusCode);
            Assert.Equal(StatusCodes.Status412PreconditionFailed, weak.StatusCode);
            Assert.Equal(tag, weak.Headers.ETag.ToString());
            AssertPlatformError(weak, PlatformErrorCode.PreconditionFailed);
        }

        [Fact]
        public async Task IfMatchMismatchWinsOverMatchingIfNoneMatch()
        {
            var first = await RunDiscoveryAsync();
            var response = await RunDiscoveryAsync(
                ifMatch: "\"different\"",
                ifNoneMatch: first.Headers.ETag.ToString());

            Assert.Equal(StatusCodes.Status412PreconditionFailed, response.StatusCode);
            AssertPlatformError(response, PlatformErrorCode.PreconditionFailed);
        }

        [Theory]
        [InlineData("not-an-entity-tag")]
        [InlineData("W/")]
        [InlineData("")]
        [InlineData("\"unterminated")]
        public async Task MalformedConditionalHeaderIsSafeInvalidRequest(string header)
        {
            var ifMatch = await RunDiscoveryAsync(ifMatch: header);
            var ifNoneMatch = await RunDiscoveryAsync(ifNoneMatch: header);

            Assert.Equal(StatusCodes.Status400BadRequest, ifMatch.StatusCode);
            AssertPlatformError(ifMatch, PlatformErrorCode.InvalidRequest);
            Assert.Empty(ifMatch.Headers.ETag.ToString());
            Assert.Equal(StatusCodes.Status400BadRequest, ifNoneMatch.StatusCode);
            AssertPlatformError(ifNoneMatch, PlatformErrorCode.InvalidRequest);
            Assert.Empty(ifNoneMatch.Headers.ETag.ToString());
        }

        [Fact]
        public async Task MultiValueListsAcceptAnyStrongIfMatchAndAnyWeakIfNoneMatch()
        {
            var first = await RunDiscoveryAsync();
            var tag = first.Headers.ETag.ToString();

            var ifMatch = await RunDiscoveryAsync(
                ifMatchValues: new[] { "W/" + tag, "\"different\"", tag });
            var ifNoneMatch = await RunDiscoveryAsync(
                ifNoneMatchValues: new[] { "\"different\"", "W/" + tag });

            Assert.Equal(StatusCodes.Status200OK, ifMatch.StatusCode);
            Assert.Equal(StatusCodes.Status304NotModified, ifNoneMatch.StatusCode);
        }

        [Fact]
        public async Task WildcardsFollowGetPreconditionSemantics()
        {
            var ifMatch = await RunDiscoveryAsync(ifMatch: "*");
            var ifNoneMatch = await RunDiscoveryAsync(ifNoneMatch: "*");

            Assert.Equal(StatusCodes.Status200OK, ifMatch.StatusCode);
            Assert.Equal(StatusCodes.Status304NotModified, ifNoneMatch.StatusCode);
        }

        [Fact]
        public async Task WildcardCannotBeCombinedWithEntityTags()
        {
            var ifMatch = await RunDiscoveryAsync(ifMatch: "*, \"stale\"");
            var ifNoneMatch = await RunDiscoveryAsync(ifNoneMatch: "*, \"stale\"");

            Assert.Equal(StatusCodes.Status400BadRequest, ifMatch.StatusCode);
            AssertPlatformError(ifMatch, PlatformErrorCode.InvalidRequest);
            Assert.Equal(StatusCodes.Status400BadRequest, ifNoneMatch.StatusCode);
            AssertPlatformError(ifNoneMatch, PlatformErrorCode.InvalidRequest);
        }

        [Fact]
        public void EntityTagCountBoundHasAnExactAcceptedBoundary()
        {
            var current = PlatformConcurrency.CreateStrongEntityTag(Encoding.UTF8.GetBytes("current"));
            var accepted = string.Join(",", Enumerable.Range(0, PlatformConcurrency.MaximumConditionalEntityTags)
                .Select(index => $"\"tag-{index}\""));
            var rejected = accepted + ",\"one-too-many\"";

            Assert.Equal(
                PlatformPreconditionDecision.Continue,
                PlatformConcurrency.EvaluateIfNoneMatch(accepted, current));
            Assert.Equal(
                PlatformPreconditionDecision.Invalid,
                PlatformConcurrency.EvaluateIfNoneMatch(rejected, current));
        }

        [Fact]
        public void HeaderCharacterBoundHasAnExactAcceptedBoundary()
        {
            var current = PlatformConcurrency.CreateStrongEntityTag(Encoding.UTF8.GetBytes("current"));
            var accepted = "\"" + new string('a', PlatformConcurrency.MaximumConditionalHeaderCharacters - 2) + "\"";
            var rejected = "\"" + new string('a', PlatformConcurrency.MaximumConditionalHeaderCharacters - 1) + "\"";

            Assert.Equal(
                PlatformPreconditionDecision.Continue,
                PlatformConcurrency.EvaluateIfNoneMatch(accepted, current));
            Assert.Equal(
                PlatformPreconditionDecision.Invalid,
                PlatformConcurrency.EvaluateIfNoneMatch(rejected, current));
        }

        [Fact]
        public void HeaderValueCountHasAnExactAcceptedBoundary()
        {
            var current = PlatformConcurrency.CreateStrongEntityTag(Encoding.UTF8.GetBytes("current"));
            var accepted = Enumerable.Range(0, PlatformConcurrency.MaximumConditionalHeaderValues)
                .Select(index => $"\"tag-{index}\"").ToArray();
            var rejected = accepted.Append("\"one-too-many\"").ToArray();

            Assert.Equal(
                PlatformPreconditionDecision.Continue,
                PlatformConcurrency.EvaluateIfNoneMatch(new StringValues(accepted), current));
            Assert.Equal(
                PlatformPreconditionDecision.Invalid,
                PlatformConcurrency.EvaluateIfNoneMatch(new StringValues(rejected), current));
        }

        [Fact]
        public async Task NegotiationValidatorChangesWithTheNegotiatedRepresentation()
        {
            var compatible = await RunNegotiationAsync(1, 1);
            var incompatible = await RunNegotiationAsync(9, 9);

            Assert.NotEqual(compatible.Headers.ETag.ToString(), incompatible.Headers.ETag.ToString());
        }

        [Fact]
        public async Task UnmarkedPlatformResultDoesNotGainAValidator()
        {
            var method = typeof(UnmarkedController).GetMethod(nameof(UnmarkedController.Get))!;
            var response = await RunAsync(method, new OkObjectResult(new { Value = 1 }));

            Assert.Equal(StatusCodes.Status200OK, response.StatusCode);
            Assert.Empty(response.Headers.ETag.ToString());
        }

        [Fact]
        public async Task ValidatedPostGetsExactEtagButNeverGetStyleConditionalSemantics()
        {
            var controller = new ValidatedPostController();
            var method = typeof(ValidatedPostController).GetMethod(nameof(ValidatedPostController.Post))!;
            var first = await RunAsync(method, controller.Post());
            var tag = first.Headers.ETag.ToString();

            var matching = await RunAsync(
                method,
                controller.Post(),
                ifMatch: "\"different\"",
                ifNoneMatch: tag);

            Assert.Equal(StatusCodes.Status200OK, first.StatusCode);
            Assert.Matches("^\"sha256-[0-9a-f]{64}\"$", tag);
            Assert.Equal(StatusCodes.Status200OK, matching.StatusCode);
            Assert.Equal(tag, matching.Headers.ETag.ToString());
            Assert.NotEmpty(Assert.IsType<MemoryStream>(matching.Body).ToArray());
        }

        [Fact]
        public async Task ErrorResultDoesNotGainAValidator()
        {
            var method = typeof(PlatformDiscoveryController).GetMethod(nameof(PlatformDiscoveryController.GetDiscovery))!;
            var response = await RunAsync(
                method,
                PlatformResults.Error(PlatformErrorCode.InvalidRequest, "Safe.", "0123456789abcdef0123456789abcdef"));

            Assert.Equal(StatusCodes.Status400BadRequest, response.StatusCode);
            Assert.Empty(response.Headers.ETag.ToString());
        }

        [Fact]
        public void ConcurrencyRunsAfterExactJsonSerializationAndLifecycleCleanup()
        {
            var filters = typeof(PlatformControllerBase)
                .GetCustomAttributes(typeof(TypeFilterAttribute), inherit: true)
                .Cast<TypeFilterAttribute>()
                .ToDictionary(attribute => attribute.ImplementationType, attribute => attribute.Order);

            Assert.True(filters[typeof(PlatformRequestLifecycleFilter)] < filters[typeof(PlatformJsonResultFilter)]);
            Assert.True(filters[typeof(PlatformJsonResultFilter)] < filters[typeof(PlatformConcurrency)]);
            Assert.IsAssignableFrom<IAsyncAlwaysRunResultFilter>(new PlatformJsonResultFilter());
            Assert.IsAssignableFrom<IAsyncResultFilter>(new PlatformConcurrency());
        }

        [Fact]
        public async Task HostCompressionCannotChangeTheBytesNamedByTheStrongValidator()
        {
            var services = new ServiceCollection();
            services.AddLogging();
            services.AddResponseCompression(options =>
            {
                options.Providers.Clear();
                options.Providers.Add<GzipCompressionProvider>();
                options.MimeTypes = new[] { "application/json" };
            });
            using var provider = services.BuildServiceProvider();
            var app = new ApplicationBuilder(provider);
            app.UseResponseCompression();
            app.Run(async http =>
            {
                var controller = new PlatformDiscoveryController();
                var result = Assert.IsType<OkObjectResult>(controller.GetDiscovery().Result);
                var method = typeof(PlatformDiscoveryController)
                    .GetMethod(nameof(PlatformDiscoveryController.GetDiscovery))!;
                await ExecuteAsync(http, method, result);
            });

            var http = new DefaultHttpContext();
            http.Request.Headers.AcceptEncoding = "gzip";
            http.Response.Body = new MemoryStream();
            await app.Build()(http);

            var body = Assert.IsType<MemoryStream>(http.Response.Body).ToArray();
            var expectedHash = Convert.ToHexString(SHA256.HashData(body)).ToLowerInvariant();
            Assert.Equal("identity", http.Response.Headers.ContentEncoding.ToString());
            Assert.Equal($"\"sha256-{expectedHash}\"", http.Response.Headers.ETag.ToString());
            Assert.Equal(body.Length, http.Response.ContentLength);
        }

        private static async Task<HttpResponse> RunDiscoveryAsync(
            string? ifMatch = null,
            string? ifNoneMatch = null,
            string[]? ifMatchValues = null,
            string[]? ifNoneMatchValues = null)
        {
            var controller = new PlatformDiscoveryController();
            var action = Assert.IsType<OkObjectResult>(controller.GetDiscovery().Result);
            var method = typeof(PlatformDiscoveryController).GetMethod(nameof(PlatformDiscoveryController.GetDiscovery))!;
            return await RunAsync(method, action, ifMatch, ifNoneMatch, ifMatchValues, ifNoneMatchValues);
        }

        private static async Task<HttpResponse> RunNegotiationAsync(int minimum, int maximum)
        {
            var controller = new PlatformDiscoveryController();
            var action = Assert.IsType<OkObjectResult>(controller.Negotiate(minimum, maximum).Result);
            var method = typeof(PlatformDiscoveryController).GetMethod(nameof(PlatformDiscoveryController.Negotiate))!;
            return await RunAsync(method, action);
        }

        private static async Task<HttpResponse> RunAsync(
            MethodInfo method,
            IActionResult result,
            string? ifMatch = null,
            string? ifNoneMatch = null,
            string[]? ifMatchValues = null,
            string[]? ifNoneMatchValues = null)
        {
            var http = new DefaultHttpContext();
            http.Response.Body = new MemoryStream();
            if (ifMatch is not null)
            {
                http.Request.Headers.IfMatch = ifMatch;
            }

            if (ifNoneMatch is not null)
            {
                http.Request.Headers.IfNoneMatch = ifNoneMatch;
            }

            if (ifMatchValues is not null)
            {
                http.Request.Headers.IfMatch = new StringValues(ifMatchValues);
            }

            if (ifNoneMatchValues is not null)
            {
                http.Request.Headers.IfNoneMatch = new StringValues(ifNoneMatchValues);
            }

            await ExecuteAsync(http, method, result);

            http.Response.Body.Position = 0;
            return http.Response;
        }

        private static async Task ExecuteAsync(HttpContext http, MethodInfo method, IActionResult result)
        {
            var descriptor = new ControllerActionDescriptor { MethodInfo = method };
            var action = new ActionContext(http, new RouteData(), descriptor);
            var outer = new ResultExecutingContext(action, new List<IFilterMetadata>(), result, new object());

            await new PlatformJsonResultFilter().OnResultExecutionAsync(outer, async () =>
            {
                var inner = new ResultExecutingContext(action, new List<IFilterMetadata>(), outer.Result, new object());
                await new PlatformConcurrency().OnResultExecutionAsync(inner, async () =>
                {
                    await inner.Result.ExecuteResultAsync(action);
                    return new ResultExecutedContext(action, new List<IFilterMetadata>(), inner.Result, new object());
                });

                return new ResultExecutedContext(action, new List<IFilterMetadata>(), inner.Result, new object());
            });
        }

        private static void AssertPlatformError(HttpResponse response, string expectedCode)
        {
            response.Body.Position = 0;
            var error = JsonSerializer.Deserialize<PlatformError>(response.Body, PlatformJson.SerializerOptions);
            Assert.NotNull(error);
            Assert.Equal(expectedCode, error.Code);
            Assert.Equal(response.StatusCode, PlatformErrorCode.StatusFor(error.Code));
            response.Body.Position = 0;
        }
    }
}
