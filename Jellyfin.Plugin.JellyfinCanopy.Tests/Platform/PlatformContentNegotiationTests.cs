using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Primitives;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    public class PlatformContentNegotiationTests
    {
        [Theory]
        [InlineData(null)]
        [InlineData("application/json")]
        [InlineData("APPLICATION/JSON")]
        [InlineData("application/*")]
        [InlineData("*/*")]
        [InlineData("text/plain;q=1, application/json;q=0.2")]
        [InlineData("*/*;q=0, application/json;q=0.5")]
        [InlineData("application/*;profile=unused;q=1, */*;q=0.5")]
        [InlineData("application/json;q=1;profile=accept-extension")]
        public async Task JsonCompatibleAcceptHeadersReachThePipeline(string? accept)
        {
            var (context, continued) = await RunAcceptFilterAsync(accept);

            Assert.True(continued);
            Assert.Null(context.Result);
        }

        [Theory]
        [InlineData("")]
        [InlineData("text/plain")]
        [InlineData("application/xml")]
        [InlineData("application/json;q=0")]
        [InlineData("application/json;q=0, */*;q=1")]
        [InlineData("application/json;q=0, application/*;q=1")]
        [InlineData("application/json;profile=foo;q=1, application/json;q=0")]
        [InlineData("application/json;profile=foo;q=1, application/*;q=0")]
        [InlineData("application/json;q=bogus")]
        [InlineData("not a media type")]
        public async Task UnsupportedOrMalformedAcceptGetsStructured406(string accept)
        {
            var (context, continued) = await RunAcceptFilterAsync(accept);

            Assert.False(continued);
            var result = Assert.IsType<ObjectResult>(context.Result);
            var error = Assert.IsType<PlatformError>(result.Value);
            Assert.Equal(StatusCodes.Status406NotAcceptable, result.StatusCode);
            Assert.Equal(PlatformErrorCode.NotAcceptable, error.Code);
            Assert.False(error.Retryable);
            Assert.Equal(error.CorrelationId, context.HttpContext.Response.Headers[PlatformCorrelation.HeaderName]);
        }

        [Fact]
        public async Task NotAcceptableUsesTheCanonicalPlatformJsonWireFormat()
        {
            var (resource, continued) = await RunAcceptFilterAsync("text/plain");
            Assert.False(continued);

            var resultContext = new ResultExecutingContext(
                resource,
                new List<IFilterMetadata>(),
                resource.Result!,
                new object());
            await new PlatformJsonResultFilter().OnResultExecutionAsync(resultContext, () =>
                Task.FromResult(new ResultExecutedContext(
                    resource,
                    new List<IFilterMetadata>(),
                    resultContext.Result,
                    new object())));

            var result = Assert.IsType<PlatformJsonBodyResult>(resultContext.Result);
            await result.ExecuteResultAsync(resource);

            var response = resource.HttpContext.Response;
            Assert.Equal(StatusCodes.Status406NotAcceptable, response.StatusCode);
            Assert.Equal("application/json", response.ContentType);
            Assert.Equal("identity", response.Headers.ContentEncoding);
            response.Body.Position = 0;
            using var json = await JsonDocument.ParseAsync(response.Body);
            Assert.Equal(
                PlatformErrorCode.NotAcceptable,
                json.RootElement.GetProperty(nameof(PlatformError.Code)).GetString());
            Assert.False(json.RootElement.GetProperty(nameof(PlatformError.Retryable)).GetBoolean());
            Assert.Equal(
                response.Headers[PlatformCorrelation.HeaderName],
                json.RootElement.GetProperty(nameof(PlatformError.CorrelationId)).GetString());
        }

        [Fact]
        public void AcceptParsingPinsEveryBoundAtItsEdge()
        {
            var maximumHeaderValues = Enumerable
                .Repeat("application/json", PlatformAcceptMediaTypeFilter.MaximumAcceptHeaderValues)
                .ToArray();
            Assert.True(PlatformAcceptMediaTypeFilter.AcceptsJson(new StringValues(maximumHeaderValues)));
            Assert.False(PlatformAcceptMediaTypeFilter.AcceptsJson(new StringValues(
                maximumHeaderValues.Append("application/json").ToArray())));

            var maximumRanges = string.Join(
                ',',
                Enumerable.Repeat("application/json", PlatformAcceptMediaTypeFilter.MaximumAcceptMediaRanges));
            Assert.True(PlatformAcceptMediaTypeFilter.AcceptsJson(maximumRanges));
            Assert.False(PlatformAcceptMediaTypeFilter.AcceptsJson(maximumRanges + ",application/json"));

            const string parameterPrefix = "application/json;q=1;x=\"";
            var maximumCharacters = parameterPrefix
                + new string(
                    'a',
                    PlatformAcceptMediaTypeFilter.MaximumAcceptHeaderCharacters - parameterPrefix.Length - 1)
                + '"';
            Assert.Equal(PlatformAcceptMediaTypeFilter.MaximumAcceptHeaderCharacters, maximumCharacters.Length);
            Assert.True(PlatformAcceptMediaTypeFilter.AcceptsJson(maximumCharacters));
            Assert.False(PlatformAcceptMediaTypeFilter.AcceptsJson(maximumCharacters + " "));
        }

        [Fact]
        public void AcceptNegotiationRunsPostAuthorizationAndBeforeRequestBodyInspection()
        {
            Assert.NotEmpty(typeof(PlatformControllerBase).GetCustomAttributes(typeof(AuthorizeAttribute), inherit: true));
            Assert.IsAssignableFrom<IAsyncResourceFilter>(new PlatformAcceptMediaTypeFilter());
            Assert.False(typeof(IAsyncAuthorizationFilter).IsAssignableFrom(typeof(PlatformAcceptMediaTypeFilter)));

            var filters = typeof(PlatformControllerBase)
                .GetCustomAttributes(typeof(TypeFilterAttribute), inherit: true)
                .Cast<TypeFilterAttribute>()
                .ToDictionary(attribute => attribute.ImplementationType, attribute => attribute.Order);

            Assert.True(filters[typeof(PlatformAvailabilityFilter)] < filters[typeof(PlatformAcceptMediaTypeFilter)]);
            Assert.True(filters[typeof(PlatformAcceptMediaTypeFilter)] < filters[typeof(PlatformJsonMediaTypeFilter)]);
            Assert.True(filters[typeof(PlatformAcceptMediaTypeFilter)] < filters[typeof(PlatformBoundedBodyFilter)]);
        }

        private static async Task<(ResourceExecutingContext Context, bool Continued)> RunAcceptFilterAsync(string? accept)
        {
            var http = new DefaultHttpContext();
            http.Response.Body = new MemoryStream();
            if (accept is not null)
            {
                http.Request.Headers.Accept = accept;
            }

            var context = new ResourceExecutingContext(
                new ActionContext(http, new RouteData(), new ControllerActionDescriptor(), new ModelStateDictionary()),
                new List<IFilterMetadata>(),
                new List<IValueProviderFactory>());
            var continued = false;

            await new PlatformAcceptMediaTypeFilter().OnResourceExecutionAsync(context, () =>
            {
                continued = true;
                return Task.FromResult(new ResourceExecutedContext(context, new List<IFilterMetadata>()));
            });

            return (context, continued);
        }
    }
}
