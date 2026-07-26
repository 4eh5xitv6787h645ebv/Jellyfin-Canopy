using System;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.ResponseCompression;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services
{
    /// <summary>
    /// Pins the transformed index.html HTTP contract: Jellyfin owns content
    /// negotiation and source validators; the middleware maps those validators to
    /// a bounded cache of injected representations without serving a pre-injection
    /// shell from a browser cache.
    /// </summary>
    public class ScriptInjectionConditionalHeaderTests
    {
        private const string IndexHtml = "<html><head></head><body></body></html>";
        private const string InjectedTags = "<script data-test=\"canopy\"></script>";
        private const string SourceETag = "\"source-v1\"";
        private const string LastModified = "Wed, 21 Oct 2015 07:28:00 GMT";

        private static ScriptInjectionStartupFilter BuildFilter(Func<string>? scriptTagProvider = null)
        {
            var provider = new FakePluginConfigProvider(new PluginConfiguration
            {
                DisableScriptInjectionMiddleware = false,
            });
            return new ScriptInjectionStartupFilter(
                NullLogger<ScriptInjectionStartupFilter>.Instance,
                provider,
                scriptTagProvider ?? (() => InjectedTags));
        }

        // Drives the middleware exactly as it is registered in production (through
        // the public IStartupFilter.Configure seam) with a fake static-file handler.
        private static async Task<(HttpContext Context, byte[] Body)> RunAsync(
            ScriptInjectionStartupFilter filter,
            RequestDelegate staticHandler,
            string? acceptEncoding = null,
            string? ifNoneMatch = null,
            string? ifModifiedSince = null)
        {
            using var services = new ServiceCollection().BuildServiceProvider();
            var appBuilder = new ApplicationBuilder(services);
            filter.Configure(app => app.Run(staticHandler))(appBuilder);
            var pipeline = appBuilder.Build();

            var context = new DefaultHttpContext();
            context.Request.Method = "GET";
            context.Request.Path = "/web/index.html";
            if (acceptEncoding != null)
            {
                context.Request.Headers["Accept-Encoding"] = acceptEncoding;
            }

            if (ifNoneMatch != null)
            {
                context.Request.Headers["If-None-Match"] = ifNoneMatch;
            }

            if (ifModifiedSince != null)
            {
                context.Request.Headers["If-Modified-Since"] = ifModifiedSince;
            }

            using var responseBody = new MemoryStream();
            context.Response.Body = responseBody;
            await pipeline(context);
            return (context, responseBody.ToArray());
        }

        [Fact]
        public async Task InvokeAsync_PreservesAcceptEncoding_ForHostCompression()
        {
            var filter = BuildFilter();
            string? downstreamAcceptEncoding = null;

            await RunAsync(
                filter,
                async context =>
                {
                    downstreamAcceptEncoding = context.Request.Headers["Accept-Encoding"].ToString();
                    await WriteSourceAsync(context, IndexHtml, SourceETag);
                },
                acceptEncoding: "br, gzip");

            Assert.Equal("br, gzip", downstreamAcceptEncoding);
        }

        [Fact]
        public async Task Configure_PreservesRealResponseCompressionMiddlewareOrdering()
        {
            var filter = BuildFilter();
            var services = new ServiceCollection();
            services.AddLogging();
            services.AddResponseCompression(options =>
            {
                options.Providers.Clear();
                options.Providers.Add<GzipCompressionProvider>();
            });
            using var serviceProvider = services.BuildServiceProvider();
            var appBuilder = new ApplicationBuilder(serviceProvider);
            filter.Configure(app =>
            {
                app.UseResponseCompression();
                app.Run(context => WriteSourceAsync(context, IndexHtml, SourceETag));
            })(appBuilder);
            var pipeline = appBuilder.Build();

            var context = new DefaultHttpContext();
            context.Request.Method = "GET";
            context.Request.Path = "/web/index.html";
            context.Request.Headers["Accept-Encoding"] = "gzip";
            using var responseBody = new MemoryStream();
            context.Response.Body = responseBody;

            await pipeline(context);

            Assert.Equal("gzip", context.Response.Headers["Content-Encoding"].ToString());
            Assert.Contains(
                InjectedTags,
                Encoding.UTF8.GetString(Decompress(responseBody.ToArray(), "gzip")),
                StringComparison.Ordinal);
        }

        [Theory]
        [InlineData("gzip")]
        [InlineData("br")]
        public async Task InvokeAsync_CompressedSource_StaysCompressedAndGetsRepresentationValidator(string encoding)
        {
            var filter = BuildFilter();

            var (context, body) = await RunAsync(
                filter,
                async responseContext =>
                {
                    responseContext.Response.StatusCode = StatusCodes.Status200OK;
                    responseContext.Response.ContentType = "text/html; charset=utf-8";
                    responseContext.Response.Headers["Content-Encoding"] = encoding;
                    responseContext.Response.Headers["Cache-Control"] = "no-cache";
                    responseContext.Response.Headers["ETag"] = SourceETag;
                    responseContext.Response.Headers["Last-Modified"] = LastModified;
                    responseContext.Response.Headers["Vary"] = "Accept-Encoding";
                    var compressed = Compress(Encoding.UTF8.GetBytes(IndexHtml), encoding);
                    await responseContext.Response.Body.WriteAsync(compressed);
                },
                acceptEncoding: encoding);

            Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
            Assert.Equal(encoding, context.Response.Headers["Content-Encoding"].ToString());
            Assert.Equal("Accept-Encoding", context.Response.Headers["Vary"].ToString());
            Assert.Equal("no-cache", context.Response.Headers["Cache-Control"].ToString());
            Assert.Equal(LastModified, context.Response.Headers["Last-Modified"].ToString());
            Assert.StartsWith("\"jc-", context.Response.Headers["ETag"].ToString(), StringComparison.Ordinal);
            Assert.NotEqual(SourceETag, context.Response.Headers["ETag"].ToString());
            Assert.Contains(InjectedTags, Encoding.UTF8.GetString(Decompress(body, encoding)), StringComparison.Ordinal);
        }

        [Fact]
        public async Task InvokeAsync_WarmCache_RevalidatesSourceWithoutRebufferingAndHonorsClientETag()
        {
            var filter = BuildFilter();
            var fullBodyWrites = 0;
            var downstreamCalls = 0;
            var downstreamSawSourceValidator = 0;

            async Task StaticHandler(HttpContext context)
            {
                downstreamCalls++;
                if (context.Request.Headers["If-None-Match"].ToString() == SourceETag)
                {
                    downstreamSawSourceValidator++;
                    context.Response.StatusCode = StatusCodes.Status304NotModified;
                    context.Response.Headers["ETag"] = SourceETag;
                    context.Response.Headers["Last-Modified"] = LastModified;
                    return;
                }

                fullBodyWrites++;
                await WriteSourceAsync(context, IndexHtml, SourceETag);
            }

            var first = await RunAsync(filter, StaticHandler, acceptEncoding: "gzip");
            var transformedETag = first.Context.Response.Headers["ETag"].ToString();
            var second = await RunAsync(filter, StaticHandler, acceptEncoding: "gzip");
            var third = await RunAsync(
                filter,
                StaticHandler,
                acceptEncoding: "gzip",
                ifNoneMatch: transformedETag);
            var fourth = await RunAsync(
                filter,
                StaticHandler,
                acceptEncoding: "gzip",
                ifModifiedSince: LastModified);

            Assert.Equal(4, downstreamCalls);
            Assert.Equal(1, fullBodyWrites);
            Assert.Equal(3, downstreamSawSourceValidator);
            Assert.Equal(StatusCodes.Status200OK, second.Context.Response.StatusCode);
            Assert.Equal(first.Body, second.Body);
            Assert.Equal(StatusCodes.Status304NotModified, third.Context.Response.StatusCode);
            Assert.Empty(third.Body);
            Assert.Equal(transformedETag, third.Context.Response.Headers["ETag"].ToString());
            Assert.Equal(StatusCodes.Status304NotModified, fourth.Context.Response.StatusCode);
            Assert.Empty(fourth.Body);
        }

        [Fact]
        public async Task InvokeAsync_ColdConditionalRequest_ForcesInjectableSourceBodyThenCanReturn304()
        {
            var filter = BuildFilter();
            bool downstreamSawClientValidator = true;

            var (context, body) = await RunAsync(
                filter,
                async responseContext =>
                {
                    downstreamSawClientValidator =
                        responseContext.Request.Headers.ContainsKey("If-None-Match")
                        || responseContext.Request.Headers.ContainsKey("If-Modified-Since");
                    await WriteSourceAsync(responseContext, IndexHtml, SourceETag);
                },
                ifNoneMatch: "\"jc-stale-client-value\"",
                ifModifiedSince: LastModified);

            Assert.False(downstreamSawClientValidator);
            Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
            Assert.Contains(InjectedTags, Encoding.UTF8.GetString(body), StringComparison.Ordinal);
        }

        [Fact]
        public async Task InvokeAsync_ScriptGenerationChange_InvalidatesCachedRepresentation()
        {
            var currentTags = "<script data-generation=\"one\"></script>";
            var filter = BuildFilter(() => currentTags);
            var fullBodyWrites = 0;

            async Task StaticHandler(HttpContext context)
            {
                if (context.Request.Headers["If-None-Match"].ToString() == SourceETag)
                {
                    context.Response.StatusCode = StatusCodes.Status304NotModified;
                    context.Response.Headers["ETag"] = SourceETag;
                    context.Response.Headers["Last-Modified"] = LastModified;
                    return;
                }

                fullBodyWrites++;
                await WriteSourceAsync(context, IndexHtml, SourceETag);
            }

            var first = await RunAsync(filter, StaticHandler);
            currentTags = "<script data-generation=\"two\"></script>";
            var second = await RunAsync(
                filter,
                StaticHandler,
                ifModifiedSince: LastModified);

            Assert.Equal(2, fullBodyWrites);
            Assert.NotEqual(
                first.Context.Response.Headers["ETag"].ToString(),
                second.Context.Response.Headers["ETag"].ToString());
            Assert.Contains("data-generation=\"two\"", Encoding.UTF8.GetString(second.Body), StringComparison.Ordinal);
        }

        [Fact]
        public void ReplaceOwnedScriptTags_UpgradesAnIncompleteLegacyLoaderAtomically()
        {
            const string legacy =
                "<script plugin=\"Jellyfin Canopy\" version=\"old\" src=\"../JellyfinCanopy/script?v=old\" defer></script>";
            const string other =
                "<script plugin=\"Some Other Plugin\" src=\"other.js\"></script>";
            var current = JellyfinCanopy.BuildScriptTags(
                "Jellyfin Canopy",
                "2.0.0.0-current",
                devMode: false);
            var html = $"<html><body>{legacy}{other}</body></html>";

            var rewritten = ScriptInjectionStartupFilter.ReplaceOwnedScriptTags(
                html,
                current);

            Assert.DoesNotContain("version=\"old\"", rewritten, StringComparison.Ordinal);
            Assert.Contains(other, rewritten, StringComparison.Ordinal);
            Assert.Equal(
                2,
                System.Text.RegularExpressions.Regex.Matches(
                    rewritten,
                    "plugin=\"Jellyfin Canopy\"").Count);
            Assert.True(
                rewritten.IndexOf(
                    "/client-refresh-bootstrap.js",
                    StringComparison.Ordinal)
                < rewritten.IndexOf(
                    "/JellyfinCanopy/script",
                    StringComparison.Ordinal));
        }

        private static async Task WriteSourceAsync(HttpContext context, string html, string etag)
        {
            context.Response.StatusCode = StatusCodes.Status200OK;
            context.Response.ContentType = "text/html; charset=utf-8";
            context.Response.Headers["Cache-Control"] = "no-cache";
            context.Response.Headers["ETag"] = etag;
            context.Response.Headers["Last-Modified"] = LastModified;
            await context.Response.WriteAsync(html);
        }

        private static byte[] Compress(byte[] source, string encoding)
        {
            using var output = new MemoryStream();
            using (Stream compressor = encoding == "gzip"
                ? new GZipStream(output, CompressionLevel.Fastest, leaveOpen: true)
                : new BrotliStream(output, CompressionLevel.Fastest, leaveOpen: true))
            {
                compressor.Write(source);
            }

            return output.ToArray();
        }

        private static byte[] Decompress(byte[] source, string encoding)
        {
            using var input = new MemoryStream(source);
            using Stream decompressor = encoding == "gzip"
                ? new GZipStream(input, CompressionMode.Decompress)
                : new BrotliStream(input, CompressionMode.Decompress);
            using var output = new MemoryStream();
            decompressor.CopyTo(output);
            return output.ToArray();
        }
    }
}
