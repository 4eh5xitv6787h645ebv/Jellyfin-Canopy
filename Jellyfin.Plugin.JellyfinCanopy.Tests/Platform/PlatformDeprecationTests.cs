using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Routing;
using Microsoft.Net.Http.Headers;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    public class PlatformDeprecationTests
    {
        private const string DiscoveryPath = "/JellyfinCanopy/Platform/v1/discovery";

        [Fact]
        public void ShippedRegistryIsEmptyAndItsShapeIsPinned()
        {
            var raw = File.ReadAllText(ContractPath("deprecations.json"));
            using var json = JsonDocument.Parse(raw);

            Assert.Equal(
                new[] { "operations", "schemaVersion" },
                json.RootElement.EnumerateObject().Select(property => property.Name).OrderBy(name => name, StringComparer.Ordinal));
            Assert.Equal(PlatformDeprecationRegistry.SchemaVersion, json.RootElement.GetProperty("schemaVersion").GetInt32());
            Assert.Equal(JsonValueKind.Array, json.RootElement.GetProperty("operations").ValueKind);
            Assert.Empty(json.RootElement.GetProperty("operations").EnumerateArray());
            Assert.Empty(PlatformDeprecationRegistry.Parse(raw).Operations);
            Assert.Empty(PlatformDeprecationRegistry.Shipped.Operations);
            using var resource = typeof(PlatformDeprecationRegistry).Assembly.GetManifestResourceStream(
                PlatformDeprecationRegistry.ResourceName);
            Assert.NotNull(resource);
        }

        [Fact]
        public async Task FixtureDeprecatedOperationStillAnswersAndEmitsBothHeaders()
        {
            var registry = PlatformDeprecationRegistry.Parse(RegistryWith(
                sunsetAtUtc: "2026-11-02T00:00:00Z",
                removalNotBeforeCanopyVersion: "2.5.0.0"));
            var http = new DefaultHttpContext();
            http.Response.Body = new MemoryStream();
            http.Request.Method = "GET";
            http.Request.Path = DiscoveryPath;
            var descriptor = new ControllerActionDescriptor
            {
                MethodInfo = typeof(PlatformDiscoveryController).GetMethod(nameof(PlatformDiscoveryController.GetDiscovery))!,
            };
            var action = new ActionContext(http, new RouteData(), descriptor);
            var result = new ContentResult
            {
                Content = "still answers",
                ContentType = "text/plain",
                StatusCode = StatusCodes.Status200OK,
            };
            var context = new ResultExecutingContext(
                action,
                new List<IFilterMetadata>(),
                result,
                new object());

            await new PlatformDeprecationFilter(registry).OnResultExecutionAsync(context, async () =>
            {
                http.Response.StatusCode = StatusCodes.Status200OK;
                http.Response.ContentType = "text/plain";
                await http.Response.WriteAsync("still answers");
                return new ResultExecutedContext(
                    action,
                    new List<IFilterMetadata>(),
                    context.Result,
                    new object());
            });

            http.Response.Body.Position = 0;
            using var reader = new StreamReader(http.Response.Body);
            Assert.Equal(StatusCodes.Status200OK, http.Response.StatusCode);
            Assert.Equal("still answers", await reader.ReadToEndAsync());
            Assert.Equal("@1785801600", http.Response.Headers["Deprecation"].ToString());
            Assert.Equal("Mon, 02 Nov 2026 00:00:00 GMT", http.Response.Headers["Sunset"].ToString());
        }

        [Fact]
        public async Task EmptyOrUnlistedRegistryEmitsNoLifecycleHeaders()
        {
            var registry = PlatformDeprecationRegistry.Parse("""{"schemaVersion":1,"operations":[]}""");
            var http = new DefaultHttpContext();
            http.Request.Method = "GET";
            var descriptor = new ControllerActionDescriptor
            {
                MethodInfo = typeof(PlatformDiscoveryController).GetMethod(nameof(PlatformDiscoveryController.GetDiscovery))!,
            };
            var action = new ActionContext(http, new RouteData(), descriptor);
            var context = new ResultExecutingContext(
                action,
                new List<IFilterMetadata>(),
                new OkResult(),
                new object());

            await new PlatformDeprecationFilter(registry).OnResultExecutionAsync(context, () => Task.FromResult(
                new ResultExecutedContext(action, new List<IFilterMetadata>(), context.Result, new object())));

            Assert.False(http.Response.Headers.ContainsKey("Deprecation"));
            Assert.False(http.Response.Headers.ContainsKey("Sunset"));
        }

        [Fact]
        public async Task DeprecationHeadersSurviveAConditional304Transformation()
        {
            var registry = PlatformDeprecationRegistry.Parse(RegistryWith(
                sunsetAtUtc: "2026-11-02T00:00:00Z",
                removalNotBeforeCanopyVersion: "2.5.0.0"));
            var http = new DefaultHttpContext();
            http.Response.Body = new MemoryStream();
            http.Request.Method = "GET";
            var descriptor = new ControllerActionDescriptor
            {
                MethodInfo = typeof(PlatformDiscoveryController).GetMethod(nameof(PlatformDiscoveryController.GetDiscovery))!,
            };
            var action = new ActionContext(http, new RouteData(), descriptor);
            var result = PlatformJsonBodyResult.Create(
                new PlatformDiscoveryResponse { Available = true, ProtocolMinimum = 1, ProtocolMaximum = 1 },
                StatusCodes.Status200OK);
            http.Request.Headers.IfNoneMatch = PlatformConcurrency.CreateStrongEntityTag(result.Body).ToString();
            var outer = new ResultExecutingContext(
                action,
                new List<IFilterMetadata>(),
                result,
                new object());

            await new PlatformDeprecationFilter(registry).OnResultExecutionAsync(outer, async () =>
            {
                var inner = new ResultExecutingContext(
                    action,
                    new List<IFilterMetadata>(),
                    outer.Result,
                    new object());
                await new PlatformConcurrency().OnResultExecutionAsync(inner, async () =>
                {
                    await inner.Result.ExecuteResultAsync(action);
                    return new ResultExecutedContext(action, new List<IFilterMetadata>(), inner.Result, new object());
                });
                return new ResultExecutedContext(action, new List<IFilterMetadata>(), inner.Result, new object());
            });

            Assert.Equal(StatusCodes.Status304NotModified, http.Response.StatusCode);
            Assert.Equal("@1785801600", http.Response.Headers["Deprecation"].ToString());
            Assert.Equal("Mon, 02 Nov 2026 00:00:00 GMT", http.Response.Headers["Sunset"].ToString());
            Assert.NotNull(EntityTagHeaderValue.Parse(http.Response.Headers.ETag.ToString()));
            Assert.Empty(Assert.IsType<MemoryStream>(http.Response.Body).ToArray());
        }

        [Fact]
        public void DriftGateRejectsTooShortSunsetByOperationName()
        {
            var error = Assert.Throws<InvalidDataException>(() => PlatformDeprecationRegistry.Parse(RegistryWith(
                sunsetAtUtc: "2026-11-01T23:59:59Z",
                removalNotBeforeCanopyVersion: "2.5.0.0")));

            Assert.Contains("GET " + DiscoveryPath, error.Message, StringComparison.Ordinal);
            Assert.Contains("at least 90 days", error.Message, StringComparison.Ordinal);
        }

        [Fact]
        public void DriftGateRejectsLessThanOneMinorByOperationName()
        {
            var error = Assert.Throws<InvalidDataException>(() => PlatformDeprecationRegistry.Parse(RegistryWith(
                sunsetAtUtc: "2026-11-02T00:00:00Z",
                removalNotBeforeCanopyVersion: "2.4.1.0")));

            Assert.Contains("GET " + DiscoveryPath, error.Message, StringComparison.Ordinal);
            Assert.Contains("at least one Canopy minor", error.Message, StringComparison.Ordinal);
        }

        [Fact]
        public void RegistryLookupIsMethodAndPathExactWithoutARequestTimeScan()
        {
            var registry = PlatformDeprecationRegistry.Parse(RegistryWith(
                sunsetAtUtc: "2026-11-02T00:00:00Z",
                removalNotBeforeCanopyVersion: "2.5.0.0"));

            Assert.True(registry.TryGet("GET", DiscoveryPath, out _));
            Assert.False(registry.TryGet("POST", DiscoveryPath, out _));
            Assert.False(registry.TryGet("GET", DiscoveryPath + "/child", out _));
        }

        [Fact]
        public void MalformedUnknownAndDuplicateRegistryEntriesFailClosed()
        {
            Assert.Throws<InvalidDataException>(() => PlatformDeprecationRegistry.Parse(
                """{"schemaVersion":1,"operations":[],"surprise":true}"""));
            Assert.Throws<InvalidDataException>(() => PlatformDeprecationRegistry.Parse(
                RegistryWithEntries(
                    RegistryEntry("2026-11-02T00:00:00Z", "2.5.0.0"),
                    RegistryEntry("2026-11-02T00:00:00Z", "2.5.0.0"))));
        }

        private static string RegistryWith(string sunsetAtUtc, string removalNotBeforeCanopyVersion) =>
            RegistryWithEntries(RegistryEntry(sunsetAtUtc, removalNotBeforeCanopyVersion));

        private static string RegistryWithEntries(params string[] entries) =>
            "{\"schemaVersion\":1,\"operations\":[" + string.Join(',', entries) + "]}";

        private static string RegistryEntry(string sunsetAtUtc, string removalNotBeforeCanopyVersion) => $$"""
                {
                  "method": "GET",
                  "path": "{{DiscoveryPath}}",
                  "deprecatedAtUtc": "2026-08-04T00:00:00Z",
                  "sunsetAtUtc": "{{sunsetAtUtc}}",
                  "deprecatedInCanopyVersion": "2.4.0.0",
                  "removalNotBeforeCanopyVersion": "{{removalNotBeforeCanopyVersion}}"
                }
            """;

        private static string ContractPath(string name, [CallerFilePath] string sourceFile = "")
            => Path.GetFullPath(Path.Combine(
                Path.GetDirectoryName(sourceFile)!, "..", "..", "contracts", "platform", "v1", name));
    }
}
