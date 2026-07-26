using System;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.ResponseCompression;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging;
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

        private static ScriptInjectionStartupFilter BuildFilter(
            Func<string>? scriptTagProvider = null,
            ILogger<ScriptInjectionStartupFilter>? logger = null)
        {
            var provider = new FakePluginConfigProvider(new PluginConfiguration
            {
                DisableScriptInjectionMiddleware = false,
            });
            return new ScriptInjectionStartupFilter(
                logger ?? NullLogger<ScriptInjectionStartupFilter>.Instance,
                provider,
                scriptTagProvider ?? (() => InjectedTags));
        }

        // Drives the middleware exactly as it is registered in production (through
        // the public IStartupFilter.Configure seam) with a fake static-file handler.
        private static async Task<(HttpContext Context, byte[] Body)> RunAsync(
            ScriptInjectionStartupFilter filter,
            RequestDelegate staticHandler,
            string? acceptEncoding = null,
            string? method = null,
            string? ifMatch = null,
            string? ifNoneMatch = null,
            string? ifUnmodifiedSince = null,
            string? ifModifiedSince = null,
            CancellationToken requestAborted = default,
            string? range = null,
            string? ifRange = null)
        {
            using var services = new ServiceCollection().BuildServiceProvider();
            var appBuilder = new ApplicationBuilder(services);
            filter.Configure(app => app.Run(staticHandler))(appBuilder);
            var pipeline = appBuilder.Build();

            var context = new DefaultHttpContext();
            context.Request.Method = method ?? "GET";
            context.Request.Path = "/web/index.html";
            context.RequestAborted = requestAborted;
            if (acceptEncoding != null)
            {
                context.Request.Headers["Accept-Encoding"] = acceptEncoding;
            }

            if (ifMatch != null)
            {
                context.Request.Headers["If-Match"] = ifMatch;
            }

            if (ifNoneMatch != null)
            {
                context.Request.Headers["If-None-Match"] = ifNoneMatch;
            }

            if (ifModifiedSince != null)
            {
                context.Request.Headers["If-Modified-Since"] = ifModifiedSince;
            }

            if (ifUnmodifiedSince != null)
            {
                context.Request.Headers["If-Unmodified-Since"] = ifUnmodifiedSince;
            }

            if (range != null)
            {
                context.Request.Headers["Range"] = range;
            }

            if (ifRange != null)
            {
                context.Request.Headers["If-Range"] = ifRange;
            }

            using var responseBody = new MemoryStream();
            context.Response.Body = responseBody;
            await pipeline(context);
            return (context, responseBody.ToArray());
        }

        private static async Task<(HttpContext Context, byte[] Body)> RunWithRealStaticFilesAsync(
            ScriptInjectionStartupFilter filter,
            string source,
            string? method = null,
            string? range = null,
            string? ifRange = null)
        {
            var root = Path.Combine(
                Path.GetTempPath(),
                "canopy-static-range-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            try
            {
                await File.WriteAllTextAsync(
                    Path.Combine(root, "index.html"),
                    source,
                    new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
                using var fileProvider = new PhysicalFileProvider(root);
                using var services = new ServiceCollection()
                    .AddLogging()
                    .AddSingleton<IWebHostEnvironment>(
                        new StaticFileHostEnvironment(root, fileProvider))
                    .BuildServiceProvider();
                var appBuilder = new ApplicationBuilder(services);
                filter.Configure(app => app.UseStaticFiles(new StaticFileOptions
                {
                    FileProvider = fileProvider,
                    RequestPath = "/web",
                }))(appBuilder);
                var pipeline = appBuilder.Build();

                var context = new DefaultHttpContext();
                context.Request.Method = method ?? HttpMethods.Get;
                context.Request.Path = "/web/index.html";
                if (range != null)
                {
                    context.Request.Headers["Range"] = range;
                }

                if (ifRange != null)
                {
                    context.Request.Headers["If-Range"] = ifRange;
                }

                using var responseBody = new MemoryStream();
                context.Response.Body = responseBody;
                await pipeline(context);
                return (context, responseBody.ToArray());
            }
            finally
            {
                Directory.Delete(root, recursive: true);
            }
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

        [Fact]
        public async Task Configure_OversizedDecodedBody_UsesOneRealResponseCompressionPass()
        {
            var filter = BuildFilter();
            var source = "<html><body>"
                + new string('x', ScriptInjectionStartupFilter.MaxTransformBodyBytes)
                + "</body></html>";
            var downstreamCalls = 0;
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
                app.Run(async context =>
                {
                    downstreamCalls++;
                    await WriteSourceAsync(context, source, SourceETag);
                });
            })(appBuilder);
            var pipeline = appBuilder.Build();

            var context = new DefaultHttpContext();
            context.Request.Method = "GET";
            context.Request.Path = "/web/index.html";
            context.Request.Headers["Accept-Encoding"] = "gzip";
            using var responseBody = new MemoryStream();
            context.Response.Body = responseBody;

            await pipeline(context);

            Assert.Equal(1, downstreamCalls);
            Assert.Equal("gzip", context.Response.Headers["Content-Encoding"].ToString());
            Assert.Equal(
                source,
                Encoding.UTF8.GetString(Decompress(responseBody.ToArray(), "gzip")));
        }

        [Fact]
        public async Task Configure_OversizedBody_DoesNotRepeatExceptionOrCallbackMiddleware()
        {
            var filter = BuildFilter();
            var source = "<html><body>"
                + new string('x', ScriptInjectionStartupFilter.MaxTransformBodyBytes)
                + "</body></html>";
            var terminalCalls = 0;
            var falseErrorResponses = 0;
            var callbackRegistrations = 0;
            using var services = new ServiceCollection().BuildServiceProvider();
            var appBuilder = new ApplicationBuilder(services);
            filter.Configure(app =>
            {
                app.Use(async (context, next) =>
                {
                    try
                    {
                        await next();
                    }
                    catch
                    {
                        falseErrorResponses++;
                        context.Response.StatusCode = StatusCodes.Status500InternalServerError;
                    }
                });
                app.Use(async (context, next) =>
                {
                    callbackRegistrations++;
                    context.Response.OnStarting(() => Task.CompletedTask);
                    await next();
                });
                app.Run(async context =>
                {
                    terminalCalls++;
                    await WriteSourceAsync(context, source, SourceETag);
                });
            })(appBuilder);
            var pipeline = appBuilder.Build();

            var context = new DefaultHttpContext();
            context.Request.Method = "GET";
            context.Request.Path = "/web/index.html";
            using var responseBody = new MemoryStream();
            context.Response.Body = responseBody;

            await pipeline(context);

            Assert.Equal(1, terminalCalls);
            Assert.Equal(0, falseErrorResponses);
            Assert.Equal(1, callbackRegistrations);
            Assert.Equal(source, Encoding.UTF8.GetString(responseBody.ToArray()));
        }

        [Fact]
        public async Task InvokeAsync_PassthroughSupportsHostStreamWriteSurfacesWithoutReplay()
        {
            var filter = BuildFilter();
            var prefix = new byte[ScriptInjectionStartupFilter.MaxTransformBodyBytes];
            var downstreamCalls = 0;

            var synchronous = await RunAsync(
                filter,
                context =>
                {
                    downstreamCalls++;
                    context.Response.StatusCode = StatusCodes.Status200OK;
                    context.Response.ContentType = "text/html; charset=utf-8";
                    context.Response.Headers["ETag"] = SourceETag;
                    context.Response.Body.Write(prefix.AsSpan());
                    context.Response.Body.WriteByte((byte)'a');
                    context.Response.Body.Write(new byte[] { (byte)'b' }, 0, 1);
                    context.Response.Body.Flush();
                    return context.Response.Body.FlushAsync();
                });

            var asynchronous = await RunAsync(
                filter,
                async context =>
                {
                    downstreamCalls++;
                    context.Response.StatusCode = StatusCodes.Status200OK;
                    context.Response.ContentType = "text/html; charset=utf-8";
                    context.Response.Headers["ETag"] = SourceETag;
                    await context.Response.Body.WriteAsync(
                        prefix,
                        0,
                        prefix.Length,
                        CancellationToken.None);
                    await context.Response.Body.WriteAsync(
                        new byte[] { (byte)'c' },
                        0,
                        1,
                        CancellationToken.None);
                    await context.Response.Body.WriteAsync(
                        new byte[] { (byte)'d' }.AsMemory(),
                        CancellationToken.None);
                    await context.Response.Body.FlushAsync(CancellationToken.None);
                });

            Assert.Equal(2, downstreamCalls);
            Assert.Equal(prefix.Length + 2, synchronous.Body.Length);
            Assert.Equal((byte)'a', synchronous.Body[^2]);
            Assert.Equal((byte)'b', synchronous.Body[^1]);
            Assert.Equal(prefix.Length + 2, asynchronous.Body.Length);
            Assert.Equal((byte)'c', asynchronous.Body[^2]);
            Assert.Equal((byte)'d', asynchronous.Body[^1]);
        }

        [Fact]
        public async Task Configure_RealCompressionDuplicateAndWildcardOrdering_CannotCrossReuse()
        {
            var filter = BuildFilter();
            var fullBodyWrites = 0;
            var services = new ServiceCollection();
            services.AddLogging();
            services.AddResponseCompression();
            using var serviceProvider = services.BuildServiceProvider();
            var appBuilder = new ApplicationBuilder(serviceProvider);
            filter.Configure(app =>
            {
                app.UseResponseCompression();
                app.Run(async context =>
                {
                    fullBodyWrites++;
                    await WriteSourceAsync(context, IndexHtml, SourceETag);
                });
            })(appBuilder);
            var pipeline = appBuilder.Build();

            async Task<(string Encoding, byte[] Body)> SendAsync(string acceptEncoding)
            {
                var context = new DefaultHttpContext();
                context.Request.Method = "GET";
                context.Request.Path = "/web/index.html";
                context.Request.Headers["Accept-Encoding"] = acceptEncoding;
                using var responseBody = new MemoryStream();
                context.Response.Body = responseBody;
                await pipeline(context);
                return (context.Response.Headers["Content-Encoding"].ToString(), responseBody.ToArray());
            }

            var gzip = await SendAsync("gzip;q=0,br;q=0.5,*;q=1");
            var brotli = await SendAsync("*;q=1,gzip;q=0,br;q=0.5");

            Assert.Equal("gzip", gzip.Encoding);
            Assert.Equal("br", brotli.Encoding);
            Assert.Contains(
                InjectedTags,
                Encoding.UTF8.GetString(Decompress(gzip.Body, gzip.Encoding)),
                StringComparison.Ordinal);
            Assert.Contains(
                InjectedTags,
                Encoding.UTF8.GetString(Decompress(brotli.Body, brotli.Encoding)),
                StringComparison.Ordinal);
            Assert.Equal(2, fullBodyWrites);
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
            Assert.False(context.Response.Headers.ContainsKey("Last-Modified"));
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
            Assert.Equal(StatusCodes.Status200OK, fourth.Context.Response.StatusCode);
            Assert.Equal(first.Body, fourth.Body);
            Assert.False(fourth.Context.Response.Headers.ContainsKey("Last-Modified"));
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
            var third = await RunAsync(
                filter,
                StaticHandler,
                ifModifiedSince: LastModified);

            Assert.Equal(2, fullBodyWrites);
            Assert.NotEqual(
                first.Context.Response.Headers["ETag"].ToString(),
                second.Context.Response.Headers["ETag"].ToString());
            Assert.Contains("data-generation=\"two\"", Encoding.UTF8.GetString(second.Body), StringComparison.Ordinal);
            Assert.Equal(StatusCodes.Status200OK, third.Context.Response.StatusCode);
            Assert.Contains("data-generation=\"two\"", Encoding.UTF8.GetString(third.Body), StringComparison.Ordinal);
            Assert.False(third.Context.Response.Headers.ContainsKey("Last-Modified"));
        }

        [Fact]
        public async Task InvokeAsync_CanceledPartialSource_IsNeverCached()
        {
            var filter = BuildFilter();
            using var canceledRequest = new CancellationTokenSource();
            var downstreamCalls = 0;
            var secondCallSawSourceValidator = false;

            async Task StaticHandler(HttpContext context)
            {
                downstreamCalls++;
                if (downstreamCalls == 1)
                {
                    context.Response.StatusCode = StatusCodes.Status200OK;
                    context.Response.ContentType = "text/html; charset=utf-8";
                    context.Response.Headers["ETag"] = SourceETag;
                    await context.Response.WriteAsync("<html><body>");
                    canceledRequest.Cancel();
                    return;
                }

                secondCallSawSourceValidator =
                    context.Request.Headers["If-None-Match"].ToString() == SourceETag;
                await WriteSourceAsync(context, IndexHtml, SourceETag);
            }

            var canceled = await RunAsync(
                filter,
                StaticHandler,
                requestAborted: canceledRequest.Token);
            var retry = await RunAsync(filter, StaticHandler);

            Assert.Empty(canceled.Body);
            Assert.False(secondCallSawSourceValidator);
            Assert.Equal(2, downstreamCalls);
            Assert.Contains(InjectedTags, Encoding.UTF8.GetString(retry.Body), StringComparison.Ordinal);
        }

        [Fact]
        public async Task InvokeAsync_CancellationDuringTransformFailure_DoesNotCommitFallback()
        {
            using var canceledRequest = new CancellationTokenSource();
            var logger = new CancelOnWarningLogger(canceledRequest);
            var filter = BuildFilter(logger: logger);
            var downstreamCalls = 0;

            var canceled = await RunAsync(
                filter,
                async context =>
                {
                    downstreamCalls++;
                    context.Response.StatusCode = StatusCodes.Status200OK;
                    context.Response.ContentType = "text/html; charset=utf-8";
                    context.Response.Headers["Content-Encoding"] = "gzip";
                    context.Response.Headers["ETag"] = SourceETag;
                    await context.Response.Body.WriteAsync(
                        Encoding.UTF8.GetBytes("definitely-not-a-gzip-stream"));
                },
                acceptEncoding: "gzip",
                requestAborted: canceledRequest.Token);

            Assert.True(canceledRequest.IsCancellationRequested);
            Assert.Equal(1, logger.WarningCount);
            Assert.Equal(1, downstreamCalls);
            Assert.Empty(canceled.Body);
        }

        [Fact]
        public async Task InvokeAsync_EncodedBodyAboveLimit_StreamsOriginalAndDoesNotCache()
        {
            var filter = BuildFilter();
            var source = "<html><body>"
                + new string('x', ScriptInjectionStartupFilter.MaxTransformBodyBytes)
                + "</body></html>";
            var downstreamCalls = 0;
            var sourceRevalidations = 0;

            async Task StaticHandler(HttpContext context)
            {
                downstreamCalls++;
                if (context.Request.Headers["If-None-Match"].ToString() == SourceETag)
                {
                    sourceRevalidations++;
                }

                await WriteSourceAsync(context, source, SourceETag);
            }

            var first = await RunAsync(filter, StaticHandler);
            var second = await RunAsync(filter, StaticHandler);

            Assert.Equal(source, Encoding.UTF8.GetString(first.Body));
            Assert.Equal(source, Encoding.UTF8.GetString(second.Body));
            Assert.Equal(2, downstreamCalls);
            Assert.Equal(0, sourceRevalidations);
        }

        [Fact]
        public async Task InvokeAsync_DecodedBodyAboveLimit_PreservesCompressedSourceAndDoesNotCache()
        {
            var filter = BuildFilter();
            var source = Encoding.UTF8.GetBytes(
                "<html><body>"
                + new string('x', ScriptInjectionStartupFilter.MaxTransformBodyBytes)
                + "</body></html>");
            var compressed = Compress(source, "gzip");
            var downstreamCalls = 0;
            var sourceRevalidations = 0;

            async Task StaticHandler(HttpContext context)
            {
                downstreamCalls++;
                if (context.Request.Headers["If-None-Match"].ToString() == SourceETag)
                {
                    sourceRevalidations++;
                }

                context.Response.StatusCode = StatusCodes.Status200OK;
                context.Response.ContentType = "text/html; charset=utf-8";
                context.Response.Headers["Content-Encoding"] = "gzip";
                context.Response.Headers["ETag"] = SourceETag;
                context.Response.Headers["Last-Modified"] = LastModified;
                await context.Response.Body.WriteAsync(compressed);
            }

            var first = await RunAsync(filter, StaticHandler, acceptEncoding: "gzip");
            var second = await RunAsync(filter, StaticHandler, acceptEncoding: "gzip");

            Assert.Equal(compressed, first.Body);
            Assert.Equal(compressed, second.Body);
            Assert.Equal(2, downstreamCalls);
            Assert.Equal(0, sourceRevalidations);
        }

        [Fact]
        public async Task InvokeAsync_OversizedFallback_PreservesConditionalSemanticsInOnePass()
        {
            var filter = BuildFilter();
            var source = "<html><body>"
                + new string('x', ScriptInjectionStartupFilter.MaxTransformBodyBytes)
                + "</body></html>";
            var downstreamCalls = 0;

            async Task StaticHandler(HttpContext context)
            {
                downstreamCalls++;
                var ifMatch = context.Request.Headers["If-Match"].ToString();
                if (ifMatch.Length > 0 && ifMatch != "*" && ifMatch != SourceETag)
                {
                    context.Response.StatusCode = StatusCodes.Status412PreconditionFailed;
                    context.Response.Headers["ETag"] = SourceETag;
                    return;
                }

                var ifNoneMatch = context.Request.Headers["If-None-Match"].ToString();
                if (ifNoneMatch == "*" || ifNoneMatch == SourceETag)
                {
                    context.Response.StatusCode = StatusCodes.Status304NotModified;
                    context.Response.Headers["ETag"] = SourceETag;
                    return;
                }

                await WriteSourceAsync(context, source, SourceETag);
            }

            var first = await RunAsync(filter, StaticHandler);
            var notModified = await RunAsync(filter, StaticHandler, ifNoneMatch: SourceETag);
            var failed = await RunAsync(filter, StaticHandler, ifMatch: "\"jc-stale\"");

            Assert.Equal(source, Encoding.UTF8.GetString(first.Body));
            Assert.Equal(StatusCodes.Status304NotModified, notModified.Context.Response.StatusCode);
            Assert.Empty(notModified.Body);
            Assert.Equal(StatusCodes.Status412PreconditionFailed, failed.Context.Response.StatusCode);
            Assert.Empty(failed.Body);
            Assert.Equal(3, downstreamCalls);
        }

        [Fact]
        public async Task InvokeAsync_OversizedFallback_MatchesStaticFilePreconditionStates()
        {
            var filter = BuildFilter();
            var source = "<html><body>"
                + new string('x', ScriptInjectionStartupFilter.MaxTransformBodyBytes)
                + "</body></html>";
            var downstreamCalls = 0;

            async Task StaticHandler(HttpContext context)
            {
                downstreamCalls++;
                await WriteSourceAsync(context, source, SourceETag);
            }

            var notModified = await RunAsync(
                filter,
                StaticHandler,
                ifModifiedSince: LastModified);
            var failed = await RunAsync(
                filter,
                StaticHandler,
                ifUnmodifiedSince: "Tue, 20 Oct 2015 07:28:00 GMT");
            var ifNoneMatchTakesPrecedence = await RunAsync(
                filter,
                StaticHandler,
                ifNoneMatch: "\"different\"",
                ifModifiedSince: LastModified);
            var conflictingIfMatchAndDate = await RunAsync(
                filter,
                StaticHandler,
                ifMatch: SourceETag,
                ifUnmodifiedSince: "Tue, 20 Oct 2015 07:28:00 GMT");
            var malformedIfMatch = await RunAsync(
                filter,
                StaticHandler,
                ifMatch: "garbage");
            var futureIfModifiedSince = await RunAsync(
                filter,
                StaticHandler,
                ifModifiedSince: "Wed, 21 Oct 2099 07:28:00 GMT");
            var weakIfNoneMatch = await RunAsync(
                filter,
                StaticHandler,
                ifNoneMatch: "W/" + SourceETag);

            Assert.Equal(StatusCodes.Status304NotModified, notModified.Context.Response.StatusCode);
            Assert.Empty(notModified.Body);
            Assert.Equal("text/html; charset=utf-8", notModified.Context.Response.ContentType);
            Assert.Equal(SourceETag, notModified.Context.Response.Headers["ETag"].ToString());
            Assert.Equal(LastModified, notModified.Context.Response.Headers["Last-Modified"].ToString());
            Assert.Equal("bytes", notModified.Context.Response.Headers["Accept-Ranges"].ToString());
            Assert.False(notModified.Context.Response.Headers.ContainsKey("Content-Encoding"));
            Assert.False(notModified.Context.Response.Headers.ContainsKey("Vary"));
            Assert.Null(notModified.Context.Response.ContentLength);
            Assert.Equal(StatusCodes.Status412PreconditionFailed, failed.Context.Response.StatusCode);
            Assert.Empty(failed.Body);
            Assert.Null(failed.Context.Response.ContentType);
            Assert.False(failed.Context.Response.Headers.ContainsKey("ETag"));
            Assert.False(failed.Context.Response.Headers.ContainsKey("Last-Modified"));
            Assert.False(failed.Context.Response.Headers.ContainsKey("Accept-Ranges"));
            Assert.Equal(StatusCodes.Status200OK, ifNoneMatchTakesPrecedence.Context.Response.StatusCode);
            Assert.Equal(source, Encoding.UTF8.GetString(ifNoneMatchTakesPrecedence.Body));
            Assert.Equal(StatusCodes.Status412PreconditionFailed, conflictingIfMatchAndDate.Context.Response.StatusCode);
            Assert.Empty(conflictingIfMatchAndDate.Body);
            Assert.Equal(StatusCodes.Status200OK, malformedIfMatch.Context.Response.StatusCode);
            Assert.Equal(source, Encoding.UTF8.GetString(malformedIfMatch.Body));
            Assert.Equal(StatusCodes.Status200OK, futureIfModifiedSince.Context.Response.StatusCode);
            Assert.Equal(source, Encoding.UTF8.GetString(futureIfModifiedSince.Body));
            Assert.Equal(StatusCodes.Status200OK, weakIfNoneMatch.Context.Response.StatusCode);
            Assert.Equal(source, Encoding.UTF8.GetString(weakIfNoneMatch.Body));
            Assert.Equal(7, downstreamCalls);
        }

        [Fact]
        public async Task InvokeAsync_SemanticallyEquivalentAcceptEncodingValues_ShareOneRepresentation()
        {
            var filter = BuildFilter();
            var fullBodyWrites = 0;
            var sourceRevalidations = 0;

            async Task StaticHandler(HttpContext context)
            {
                if (context.Request.Headers["If-None-Match"].ToString() == SourceETag)
                {
                    sourceRevalidations++;
                    context.Response.StatusCode = StatusCodes.Status304NotModified;
                    context.Response.Headers["ETag"] = SourceETag;
                    return;
                }

                fullBodyWrites++;
                await WriteSourceAsync(context, IndexHtml, SourceETag);
            }

            var first = await RunAsync(
                filter,
                StaticHandler,
                acceptEncoding: "GZIP ; q=1.0, BR;q=0.500");
            var second = await RunAsync(
                filter,
                StaticHandler,
                acceptEncoding: "br; q=0.1, gzip;q=0.9");

            Assert.Equal(1, fullBodyWrites);
            Assert.Equal(1, sourceRevalidations);
            Assert.Equal(first.Body, second.Body);
        }

        [Fact]
        public async Task InvokeAsync_RealStaticFile_SingleRangePassesThrough()
        {
            var filter = BuildFilter();
            var response = await RunWithRealStaticFilesAsync(
                filter,
                IndexHtml,
                range: "bytes=0-3");

            Assert.Equal(StatusCodes.Status206PartialContent, response.Context.Response.StatusCode);
            Assert.Equal(
                $"bytes 0-3/{Encoding.UTF8.GetByteCount(IndexHtml)}",
                response.Context.Response.Headers["Content-Range"].ToString());
            Assert.Equal("<htm", Encoding.UTF8.GetString(response.Body));
            Assert.DoesNotContain(InjectedTags, Encoding.UTF8.GetString(response.Body), StringComparison.Ordinal);
        }

        [Fact]
        public async Task InvokeAsync_RealStaticFile_UnsatisfiableRangePassesThrough()
        {
            var response = await RunWithRealStaticFilesAsync(
                BuildFilter(),
                IndexHtml,
                range: "bytes=999999-");

            Assert.Equal(StatusCodes.Status416RangeNotSatisfiable, response.Context.Response.StatusCode);
            Assert.Equal(
                $"bytes */{Encoding.UTF8.GetByteCount(IndexHtml)}",
                response.Context.Response.Headers["Content-Range"].ToString());
            Assert.Empty(response.Body);
        }

        [Fact]
        public async Task InvokeAsync_RealStaticFile_StaleIfRangeTransformsFullResponse()
        {
            var response = await RunWithRealStaticFilesAsync(
                BuildFilter(),
                IndexHtml,
                range: "bytes=0-3",
                ifRange: "\"stale-source\"");

            Assert.Equal(StatusCodes.Status200OK, response.Context.Response.StatusCode);
            Assert.Contains(InjectedTags, Encoding.UTF8.GetString(response.Body), StringComparison.Ordinal);
            Assert.False(response.Context.Response.Headers.ContainsKey("Content-Range"));
            Assert.False(response.Context.Response.Headers.ContainsKey("Accept-Ranges"));
        }

        [Fact]
        public async Task InvokeAsync_RealStaticFile_IgnoredMultiRangeStillTransforms()
        {
            var response = await RunWithRealStaticFilesAsync(
                BuildFilter(),
                IndexHtml,
                range: "bytes=0-1,3-4");

            Assert.Equal(StatusCodes.Status200OK, response.Context.Response.StatusCode);
            Assert.Contains(InjectedTags, Encoding.UTF8.GetString(response.Body), StringComparison.Ordinal);
            Assert.False(response.Context.Response.Headers.ContainsKey("Content-Range"));
        }

        [Fact]
        public async Task InvokeAsync_RealStaticFile_HeadRangeStaysBodylessAndHidesSourceMetadata()
        {
            var response = await RunWithRealStaticFilesAsync(
                BuildFilter(),
                IndexHtml,
                method: HttpMethods.Head,
                range: "bytes=0-3");

            Assert.Equal(StatusCodes.Status200OK, response.Context.Response.StatusCode);
            Assert.Empty(response.Body);
            Assert.False(response.Context.Response.Headers.ContainsKey("ETag"));
            Assert.False(response.Context.Response.Headers.ContainsKey("Last-Modified"));
            Assert.False(response.Context.Response.Headers.ContainsKey("Accept-Ranges"));
            Assert.Null(response.Context.Response.ContentLength);
        }

        [Fact]
        public async Task InvokeAsync_UnsupportedAcceptEncodingTokens_CannotCreateCacheVariants()
        {
            var filter = BuildFilter();
            var fullBodyWrites = 0;
            var sourceRevalidations = 0;

            async Task StaticHandler(HttpContext context)
            {
                if (context.Request.Headers["If-None-Match"].ToString() == SourceETag)
                {
                    sourceRevalidations++;
                    context.Response.StatusCode = StatusCodes.Status304NotModified;
                    context.Response.Headers["ETag"] = SourceETag;
                    return;
                }

                fullBodyWrites++;
                await WriteSourceAsync(context, IndexHtml, SourceETag);
            }

            var first = await RunAsync(filter, StaticHandler, acceptEncoding: "gzip");
            var second = await RunAsync(
                filter,
                StaticHandler,
                acceptEncoding: "gzip, arbitrary-one;q=0, arbitrary-two;q=0");

            Assert.Equal(1, fullBodyWrites);
            Assert.Equal(1, sourceRevalidations);
            Assert.Equal(first.Body, second.Body);
        }

        [Fact]
        public async Task InvokeAsync_ConcurrentColdRequests_CoalesceBeforeTransform()
        {
            var filter = BuildFilter();
            var firstEntered = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            var releaseFirst = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            var fullBodyWrites = 0;
            var sourceRevalidations = 0;

            async Task StaticHandler(HttpContext context)
            {
                if (context.Request.Headers["If-None-Match"].ToString() == SourceETag)
                {
                    sourceRevalidations++;
                    context.Response.StatusCode = StatusCodes.Status304NotModified;
                    context.Response.Headers["ETag"] = SourceETag;
                    return;
                }

                fullBodyWrites++;
                firstEntered.TrySetResult(true);
                await releaseFirst.Task;
                await WriteSourceAsync(context, IndexHtml, SourceETag);
            }

            var first = RunAsync(filter, StaticHandler, acceptEncoding: "gzip, br");
            await firstEntered.Task;
            var second = RunAsync(filter, StaticHandler, acceptEncoding: "br,gzip");
            releaseFirst.SetResult(true);
            var responses = await Task.WhenAll(first, second);

            Assert.Equal(1, fullBodyWrites);
            Assert.Equal(1, sourceRevalidations);
            Assert.Equal(responses[0].Body, responses[1].Body);
        }

        [Fact]
        public async Task InvokeAsync_ConcurrentSourceInvalidation_SingleFlightsTheNewGeneration()
        {
            var currentETag = "\"source-v1\"";
            var currentHtml = "<html><body>one</body></html>";
            var filter = BuildFilter();
            var changedSourceEntered = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            var releaseChangedSource = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            var fullBodyWrites = 0;
            var sourceRevalidations = 0;

            async Task StaticHandler(HttpContext context)
            {
                if (context.Request.Headers["If-None-Match"].ToString() == currentETag)
                {
                    sourceRevalidations++;
                    context.Response.StatusCode = StatusCodes.Status304NotModified;
                    context.Response.Headers["ETag"] = currentETag;
                    return;
                }

                fullBodyWrites++;
                if (currentETag == "\"source-v2\"")
                {
                    changedSourceEntered.TrySetResult(true);
                    await releaseChangedSource.Task;
                }

                await WriteSourceAsync(context, currentHtml, currentETag);
            }

            await RunAsync(filter, StaticHandler);
            currentETag = "\"source-v2\"";
            currentHtml = "<html><body>two</body></html>";
            var firstChanged = RunAsync(filter, StaticHandler);
            await changedSourceEntered.Task;
            var secondChanged = RunAsync(filter, StaticHandler);
            releaseChangedSource.SetResult(true);
            var responses = await Task.WhenAll(firstChanged, secondChanged);

            Assert.Equal(2, fullBodyWrites);
            Assert.Equal(1, sourceRevalidations);
            Assert.All(
                responses,
                response => Assert.Contains(
                    "<body>two",
                    Encoding.UTF8.GetString(response.Body),
                    StringComparison.Ordinal));
        }

        [Fact]
        public async Task InvokeAsync_HeadUsesTransformedGetMetadataWithoutWritingBody()
        {
            var filter = BuildFilter();
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

            var get = await RunAsync(filter, StaticHandler);
            var transformedETag = get.Context.Response.Headers["ETag"].ToString();
            var head = await RunAsync(filter, StaticHandler, method: "HEAD");
            var conditionalHead = await RunAsync(
                filter,
                StaticHandler,
                method: "HEAD",
                ifNoneMatch: transformedETag);

            Assert.Equal(1, fullBodyWrites);
            Assert.Equal(StatusCodes.Status200OK, head.Context.Response.StatusCode);
            Assert.Equal(transformedETag, head.Context.Response.Headers["ETag"].ToString());
            Assert.Equal(get.Body.Length, head.Context.Response.ContentLength);
            Assert.Equal("HEAD", head.Context.Request.Method);
            Assert.Empty(head.Body);
            Assert.Equal(StatusCodes.Status304NotModified, conditionalHead.Context.Response.StatusCode);
            Assert.Equal(transformedETag, conditionalHead.Context.Response.Headers["ETag"].ToString());
            Assert.Empty(conditionalHead.Body);
        }

        [Fact]
        public async Task InvokeAsync_ColdHead_DoesNotDownloadOrPublishSourceEntityMetadata()
        {
            var filter = BuildFilter();
            var downstreamMethods = new System.Collections.Generic.List<string>();

            Task StaticHandler(HttpContext context)
            {
                downstreamMethods.Add(context.Request.Method);
                context.Response.StatusCode = StatusCodes.Status200OK;
                context.Response.ContentType = "text/html; charset=utf-8";
                context.Response.Headers["ETag"] = SourceETag;
                context.Response.Headers["Last-Modified"] = LastModified;
                context.Response.Headers["Accept-Ranges"] = "bytes";
                context.Response.ContentLength = ScriptInjectionStartupFilter.MaxTransformBodyBytes * 8L;
                return Task.CompletedTask;
            }

            var head = await RunAsync(filter, StaticHandler, method: "HEAD");

            Assert.Equal(new[] { "HEAD" }, downstreamMethods);
            Assert.Equal(StatusCodes.Status200OK, head.Context.Response.StatusCode);
            Assert.Empty(head.Body);
            Assert.False(head.Context.Response.Headers.ContainsKey("ETag"));
            Assert.False(head.Context.Response.Headers.ContainsKey("Last-Modified"));
            Assert.False(head.Context.Response.Headers.ContainsKey("Accept-Ranges"));
            Assert.Null(head.Context.Response.ContentLength);
        }

        [Fact]
        public async Task InvokeAsync_ChangedSourceHead_EvictsStaleMetadataWithoutDownloadingBody()
        {
            var currentETag = "\"source-v1\"";
            var currentHtml = "<html><body>one</body></html>";
            var filter = BuildFilter();
            var fullBodyWrites = 0;
            var headCalls = 0;

            async Task StaticHandler(HttpContext context)
            {
                if (context.Request.Headers["If-None-Match"].ToString() == currentETag)
                {
                    context.Response.StatusCode = StatusCodes.Status304NotModified;
                    context.Response.Headers["ETag"] = currentETag;
                    return;
                }

                context.Response.StatusCode = StatusCodes.Status200OK;
                context.Response.ContentType = "text/html; charset=utf-8";
                context.Response.Headers["ETag"] = currentETag;
                context.Response.Headers["Last-Modified"] = LastModified;
                if (HttpMethods.IsHead(context.Request.Method))
                {
                    headCalls++;
                    context.Response.ContentLength = Encoding.UTF8.GetByteCount(currentHtml);
                    return;
                }

                fullBodyWrites++;
                await context.Response.WriteAsync(currentHtml);
            }

            await RunAsync(filter, StaticHandler);
            currentETag = "\"source-v2\"";
            currentHtml = "<html><body>two</body></html>";
            var changedHead = await RunAsync(filter, StaticHandler, method: "HEAD");
            var refreshed = await RunAsync(filter, StaticHandler);

            Assert.Equal(1, headCalls);
            Assert.Equal(2, fullBodyWrites);
            Assert.Empty(changedHead.Body);
            Assert.False(changedHead.Context.Response.Headers.ContainsKey("ETag"));
            Assert.Null(changedHead.Context.Response.ContentLength);
            Assert.Contains(
                "<body>two",
                Encoding.UTF8.GetString(refreshed.Body),
                StringComparison.Ordinal);
        }

        [Fact]
        public async Task InvokeAsync_IfMatchEvaluatesTheTransformedRepresentation()
        {
            var filter = BuildFilter();

            async Task StaticHandler(HttpContext context)
            {
                if (context.Request.Headers["If-None-Match"].ToString() == SourceETag)
                {
                    context.Response.StatusCode = StatusCodes.Status304NotModified;
                    context.Response.Headers["ETag"] = SourceETag;
                    return;
                }

                await WriteSourceAsync(context, IndexHtml, SourceETag);
            }

            var first = await RunAsync(filter, StaticHandler);
            var transformedETag = first.Context.Response.Headers["ETag"].ToString();
            var matching = await RunAsync(filter, StaticHandler, ifMatch: transformedETag);
            var stale = await RunAsync(filter, StaticHandler, ifMatch: "\"jc-stale\"");

            Assert.Equal(StatusCodes.Status200OK, matching.Context.Response.StatusCode);
            Assert.Equal(first.Body, matching.Body);
            Assert.Equal(StatusCodes.Status412PreconditionFailed, stale.Context.Response.StatusCode);
            Assert.Empty(stale.Body);
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
            context.Response.Headers["Accept-Ranges"] = "bytes";
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

        private sealed class CancelOnWarningLogger : ILogger<ScriptInjectionStartupFilter>
        {
            private readonly CancellationTokenSource _cancellation;

            public CancelOnWarningLogger(CancellationTokenSource cancellation)
            {
                _cancellation = cancellation;
            }

            public int WarningCount { get; private set; }

            public IDisposable? BeginScope<TState>(TState state)
                where TState : notnull
                => null;

            public bool IsEnabled(LogLevel logLevel) => true;

            public void Log<TState>(
                LogLevel logLevel,
                EventId eventId,
                TState state,
                Exception? exception,
                Func<TState, Exception?, string> formatter)
            {
                if (logLevel == LogLevel.Warning)
                {
                    WarningCount++;
                    _cancellation.Cancel();
                }
            }
        }

        private sealed class StaticFileHostEnvironment : IWebHostEnvironment
        {
            public StaticFileHostEnvironment(string root, IFileProvider fileProvider)
            {
                ContentRootPath = root;
                ContentRootFileProvider = fileProvider;
                WebRootPath = root;
                WebRootFileProvider = fileProvider;
            }

            public string ApplicationName { get; set; } =
                typeof(ScriptInjectionConditionalHeaderTests).Assembly.FullName!;

            public string EnvironmentName { get; set; } = "Test";

            public string ContentRootPath { get; set; }

            public IFileProvider ContentRootFileProvider { get; set; }

            public string WebRootPath { get; set; }

            public IFileProvider WebRootFileProvider { get; set; }
        }
    }
}
