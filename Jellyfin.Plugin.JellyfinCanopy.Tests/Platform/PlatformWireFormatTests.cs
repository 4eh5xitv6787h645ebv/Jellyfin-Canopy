using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using MediaBrowser.Controller;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.Formatters;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    public class PlatformWireFormatTests
    {
        private enum RequestMode
        {
            Standard,
        }

        private sealed class WireRequest
        {
            public Guid Id { get; set; }

            public DateTimeOffset At { get; set; }

            public RequestMode Mode { get; set; }
        }

        private sealed class TestController : PlatformControllerBase
        {
        }

        private sealed class LegacyController : ControllerBase
        {
        }

        public class ServerApplicationHostProxy : DispatchProxy
        {
            protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
            {
                if (targetMethod?.Name is "get_SystemId" or "get_ApplicationVersionString")
                {
                    return "platform-wire-format-test";
                }

                throw new NotSupportedException(targetMethod?.Name);
            }
        }

        [Theory]
        [InlineData("application/json")]
        [InlineData("application/json; charset=utf-8")]
        public async Task JsonMediaTypesReachThePipeline(string contentType)
        {
            var (context, continued) = await RunMediaTypeFilterAsync(contentType);

            Assert.True(continued);
            Assert.Null(context.Result);
        }

        [Theory]
        [InlineData(null)]
        [InlineData("text/plain")]
        [InlineData("application/xml")]
        [InlineData("application/problem+json")]
        public async Task BodyWithANonJsonMediaTypeGetsStructured415(string? contentType)
        {
            var (context, continued) = await RunMediaTypeFilterAsync(contentType);

            Assert.False(continued);
            var result = Assert.IsType<ObjectResult>(context.Result);
            var error = Assert.IsType<PlatformError>(result.Value);
            Assert.Equal(415, result.StatusCode);
            Assert.Equal(PlatformErrorCode.UnsupportedMediaType, error.Code);
            Assert.False(error.Retryable);
            Assert.Equal(error.CorrelationId, context.HttpContext.Response.Headers[PlatformCorrelation.HeaderName]);
        }

        [Fact]
        public void MediaTypeHandlingIsPostAuthorizationAndPreBodyBuffering()
        {
            Assert.IsAssignableFrom<IAsyncResourceFilter>(new PlatformJsonMediaTypeFilter());
            Assert.NotEmpty(typeof(PlatformControllerBase).GetCustomAttributes(typeof(AuthorizeAttribute), inherit: true));

            var filters = typeof(PlatformControllerBase)
                .GetCustomAttributes(typeof(TypeFilterAttribute), inherit: true)
                .Cast<TypeFilterAttribute>()
                .ToDictionary(attribute => attribute.ImplementationType, attribute => attribute.Order);

            Assert.True(filters[typeof(PlatformJsonMediaTypeFilter)] < filters[typeof(PlatformBoundedBodyFilter)]);
        }

        [Fact]
        public async Task UnknownRequestPropertiesAreIgnoredByThePlatformInputFormatter()
        {
            var result = await ReadAsync("""{"Id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","At":"2026-08-02T04:05:06Z","Mode":"standard","Future":true}""");

            Assert.True(result.HasError is false);
            var value = Assert.IsType<WireRequest>(result.Model);
            Assert.Equal(Guid.Parse("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"), value.Id);
            Assert.Equal(RequestMode.Standard, value.Mode);
            Assert.Equal(TimeSpan.Zero, value.At.Offset);
        }

        [Theory]
        [InlineData("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", "2026-08-02T04:05:06+00:00", "Id")]
        [InlineData("aaaaaaaabbbbccccddddeeeeeeeeeeee", "2026-08-02T04:05:06+00:00", "Id")]
        [InlineData("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "2026-08-02T12:05:06+08:00", "At")]
        [InlineData("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "2026-08-02T04:05:06", "At")]
        [InlineData("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "2026-08-02 04:05:06+00:00", "At")]
        public async Task NonCanonicalGuidOrNonUtcTimestampIsRejected(string id, string at, string field)
        {
            var http = PlatformHttp($"{{\"Id\":\"{id}\",\"At\":\"{at}\",\"Mode\":\"standard\"}}");
            var modelState = new ModelStateDictionary();

            var result = await ReadAsync(http, modelState);

            Assert.True(result.HasError);
            Assert.Contains(modelState, entry => entry.Key == field);
        }

        [Theory]
        [InlineData("7", "\"2026-08-02T04:05:06Z\"", "Id")]
        [InlineData("\"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\"", "{}", "At")]
        public async Task NonStringGuidOrTimestampBecomesSafeInvalidRequest(string id, string at, string field)
        {
            var http = PlatformHttp($"{{\"Id\":{id},\"At\":{at},\"Mode\":\"standard\"}}");
            var modelState = new ModelStateDictionary();
            var formatterResult = await ReadAsync(http, modelState);

            Assert.True(formatterResult.HasError);
            Assert.Contains(modelState, entry => entry.Key == field);

            var action = new ActionContext(http, new RouteData(), new ControllerActionDescriptor(), modelState);
            var context = new ActionExecutingContext(action, new List<IFilterMetadata>(), new Dictionary<string, object?>(), new object());
            var continued = false;

            await new PlatformRequestFilter(NullLogger<PlatformRequestFilter>.Instance).OnActionExecutionAsync(context, () =>
            {
                continued = true;
                return Task.FromResult(new ActionExecutedContext(action, new List<IFilterMetadata>(), new object()));
            });

            Assert.False(continued);
            var result = Assert.IsType<ObjectResult>(context.Result);
            var error = Assert.IsType<PlatformError>(result.Value);
            Assert.Equal(400, result.StatusCode);
            Assert.Equal(PlatformErrorCode.InvalidRequest, error.Code);
            Assert.Contains(field, error.Message, StringComparison.Ordinal);
            Assert.DoesNotContain(id, error.Message, StringComparison.Ordinal);
            Assert.DoesNotContain(at, error.Message, StringComparison.Ordinal);
        }

        [Fact]
        public async Task UnknownRequestEnumBecomesInvalidRequestNamingOnlyTheField()
        {
            var http = PlatformHttp("""{"Id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","At":"2026-08-02T04:05:06Z","Mode":"future"}""");
            var modelState = new ModelStateDictionary();
            var formatterResult = await ReadAsync(http, modelState);

            Assert.True(formatterResult.HasError);
            Assert.Contains(modelState, entry => entry.Key == nameof(WireRequest.Mode));

            var action = new ActionContext(http, new RouteData(), new ControllerActionDescriptor(), modelState);
            var context = new ActionExecutingContext(action, new List<IFilterMetadata>(), new Dictionary<string, object?>(), new object());
            var continued = false;

            await new PlatformRequestFilter(NullLogger<PlatformRequestFilter>.Instance).OnActionExecutionAsync(context, () =>
            {
                continued = true;
                return Task.FromResult(new ActionExecutedContext(action, new List<IFilterMetadata>(), new object()));
            });

            Assert.False(continued);
            var result = Assert.IsType<ObjectResult>(context.Result);
            var error = Assert.IsType<PlatformError>(result.Value);
            Assert.Equal(400, result.StatusCode);
            Assert.Equal(PlatformErrorCode.InvalidRequest, error.Code);
            Assert.Contains(nameof(WireRequest.Mode), error.Message, StringComparison.Ordinal);
            Assert.DoesNotContain("JsonException", error.Message, StringComparison.Ordinal);
            Assert.DoesNotContain("future", error.Message, StringComparison.Ordinal);
        }

        [Fact]
        public void OutputWireValuesAreCanonicalAndUtc()
        {
            var value = new WireRequest
            {
                Id = Guid.Parse("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"),
                At = new DateTimeOffset(2026, 8, 2, 12, 5, 6, TimeSpan.FromHours(8)),
                Mode = RequestMode.Standard,
            };

            using var json = JsonDocument.Parse(JsonSerializer.Serialize(value, PlatformJson.SerializerOptions));

            Assert.Equal("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", json.RootElement.GetProperty("Id").GetString());
            Assert.Equal("2026-08-02T04:05:06.0000000+00:00", json.RootElement.GetProperty("At").GetString());
            Assert.Equal("standard", json.RootElement.GetProperty("Mode").GetString());
        }

        [Fact]
        public void PlatformBasePinsBothInputAndOutputSerializerSeams()
        {
            var filters = typeof(PlatformControllerBase)
                .GetCustomAttributes(typeof(TypeFilterAttribute), inherit: true)
                .Cast<TypeFilterAttribute>()
                .Select(attribute => attribute.ImplementationType)
                .ToList();

            Assert.Contains(typeof(PlatformJsonMediaTypeFilter), filters);
            Assert.Contains(typeof(PlatformJsonResultFilter), filters);
            Assert.IsAssignableFrom<IAsyncAlwaysRunResultFilter>(new PlatformJsonResultFilter());
        }

        [Fact]
        public void PluginRegistrationInstallsPlatformFormatterFirstAndExcludesLegacyControllers()
        {
            var services = new ServiceCollection();
            var applicationHost = DispatchProxy.Create<IServerApplicationHost, ServerApplicationHostProxy>();
            new PluginServiceRegistrator().RegisterServices(services, applicationHost);

            using var provider = services.BuildServiceProvider();
            var options = provider.GetRequiredService<IOptions<MvcOptions>>().Value;
            var formatter = Assert.IsType<PlatformJsonInputFormatter>(options.InputFormatters[0]);

            var idempotencyRegistration = Assert.Single(
                services,
                descriptor => descriptor.ServiceType == typeof(PlatformIdempotencyStore));
            Assert.Equal(ServiceLifetime.Singleton, idempotencyRegistration.Lifetime);

            Assert.True(CanRead(formatter, typeof(TestController)));
            Assert.False(CanRead(formatter, typeof(LegacyController)));
        }

        [Fact]
        public async Task MvcOutputFilterUsesThePinnedSerializerAndPreservesStatus()
        {
            var http = new DefaultHttpContext();
            var action = new ActionContext(http, new RouteData(), new ActionDescriptor());
            var context = new ResultExecutingContext(
                action,
                new List<IFilterMetadata>(),
                new ObjectResult(new WireRequest
                {
                    Id = Guid.Parse("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"),
                    At = new DateTimeOffset(2026, 8, 2, 12, 5, 6, TimeSpan.FromHours(8)),
                    Mode = RequestMode.Standard,
                })
                {
                    StatusCode = 202,
                },
                new object());

            await new PlatformJsonResultFilter().OnResultExecutionAsync(context, () =>
                Task.FromResult(new ResultExecutedContext(action, new List<IFilterMetadata>(), context.Result, new object())));

            var result = Assert.IsType<PlatformJsonBodyResult>(context.Result);
            Assert.Equal(202, result.StatusCode);

            using var json = JsonDocument.Parse(result.Body);
            Assert.Equal(
                "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                json.RootElement.GetProperty("Id").GetString());
            Assert.Equal(
                "2026-08-02T04:05:06.0000000+00:00",
                json.RootElement.GetProperty("At").GetString());
        }

        [Fact]
        public async Task AlwaysRunJsonFilterKeepsAuthorizationResultsBare()
        {
            var http = new DefaultHttpContext();
            var action = new ActionContext(http, new RouteData(), new ActionDescriptor());
            var challenge = new ChallengeResult();
            var context = new ResultExecutingContext(
                action,
                new List<IFilterMetadata>(),
                challenge,
                new object());

            await new PlatformJsonResultFilter().OnResultExecutionAsync(context, () =>
                Task.FromResult(new ResultExecutedContext(action, new List<IFilterMetadata>(), context.Result, new object())));

            Assert.Same(challenge, context.Result);
        }

        private static async Task<(ResourceExecutingContext Context, bool Continued)> RunMediaTypeFilterAsync(string? contentType)
        {
            var http = new DefaultHttpContext();
            http.Request.Body = new MemoryStream(Encoding.UTF8.GetBytes("{}"));
            http.Request.ContentLength = 2;
            http.Request.ContentType = contentType;
            var context = new ResourceExecutingContext(
                new ActionContext(http, new RouteData(), new ControllerActionDescriptor()),
                new List<IFilterMetadata>(),
                new List<IValueProviderFactory>());
            var continued = false;

            await new PlatformJsonMediaTypeFilter().OnResourceExecutionAsync(context, () =>
            {
                continued = true;
                return Task.FromResult(new ResourceExecutedContext(context, new List<IFilterMetadata>()));
            });

            return (context, continued);
        }

        private static Task<InputFormatterResult> ReadAsync(string json)
        {
            var http = PlatformHttp(json);
            return ReadAsync(http, new ModelStateDictionary());
        }

        private static Task<InputFormatterResult> ReadAsync(HttpContext http, ModelStateDictionary modelState)
        {
            var metadata = new EmptyModelMetadataProvider().GetMetadataForType(typeof(WireRequest));
            var context = new InputFormatterContext(
                http,
                string.Empty,
                modelState,
                metadata,
                (stream, encoding) => new StreamReader(stream, encoding));
            var formatter = new PlatformJsonInputFormatter();

            Assert.True(formatter.CanRead(context));
            return formatter.ReadAsync(context);
        }

        private static bool CanRead(PlatformJsonInputFormatter formatter, Type controllerType)
        {
            var http = PlatformHttp("{}");
            http.SetEndpoint(new Endpoint(
                requestDelegate: null,
                new EndpointMetadataCollection(new ControllerActionDescriptor
                {
                    ControllerTypeInfo = controllerType.GetTypeInfo(),
                }),
                "formatter selection test"));
            var metadata = new EmptyModelMetadataProvider().GetMetadataForType(typeof(WireRequest));
            var context = new InputFormatterContext(
                http,
                string.Empty,
                new ModelStateDictionary(),
                metadata,
                (stream, encoding) => new StreamReader(stream, encoding));

            return formatter.CanRead(context);
        }

        private static HttpContext PlatformHttp(string json)
        {
            var http = new DefaultHttpContext();
            var body = Encoding.UTF8.GetBytes(json);
            http.Request.Body = new MemoryStream(body);
            http.Request.ContentLength = body.Length;
            http.Request.ContentType = "application/json";
            http.SetEndpoint(new Endpoint(
                requestDelegate: null,
                new EndpointMetadataCollection(new ControllerActionDescriptor
                {
                    ControllerTypeInfo = typeof(TestController).GetTypeInfo(),
                }),
                "Platform test"));
            return http;
        }
    }
}
