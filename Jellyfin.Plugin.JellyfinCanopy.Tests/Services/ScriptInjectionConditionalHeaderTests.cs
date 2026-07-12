using System;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services
{
    /// <summary>
    /// Pins SRV-1: the script-injection middleware must strip the conditional
    /// request validators (If-None-Match / If-Modified-Since) on the way in, the
    /// exact analog of the existing Range / Accept-Encoding / If-Range strip.
    /// If it does not, a warm-cache conditional GET lets the static-file handler
    /// short-circuit to a bodyless 304 Not Modified, which falls through the
    /// middleware's !isHtml passthrough untouched — so the browser renders its
    /// cached, pre-injection index.html and the Jellyfin Canopy script silently
    /// never loads until a hard refresh.
    /// </summary>
    public class ScriptInjectionConditionalHeaderTests
    {
        private const string IndexHtml = "<html><head></head><body></body></html>";

        private static ScriptInjectionStartupFilter BuildFilter()
        {
            var provider = new FakePluginConfigProvider(new PluginConfiguration
            {
                DisableScriptInjectionMiddleware = false,
            });
            return new ScriptInjectionStartupFilter(NullLogger<ScriptInjectionStartupFilter>.Instance, provider);
        }

        // Drives the middleware exactly as it is registered in production (through
        // the public IStartupFilter.Configure seam) with a fake static-file handler
        // as the terminal, then returns the final buffered response body.
        private static async Task<(HttpContext Context, string Body)> RunAsync(
            ScriptInjectionStartupFilter filter,
            RequestDelegate staticHandler)
        {
            using var services = new ServiceCollection().BuildServiceProvider();
            var appBuilder = new ApplicationBuilder(services);
            filter.Configure(app => app.Run(staticHandler))(appBuilder);
            var pipeline = appBuilder.Build();

            var context = new DefaultHttpContext();
            context.Request.Method = "GET";
            context.Request.Path = "/web/index.html";
            context.Request.Headers["If-None-Match"] = "\"cached-etag\"";
            context.Request.Headers["If-Modified-Since"] = "Wed, 21 Oct 2015 07:28:00 GMT";

            using var responseBody = new MemoryStream();
            context.Response.Body = responseBody;

            await pipeline(context);

            return (context, Encoding.UTF8.GetString(responseBody.ToArray()));
        }

        [Fact]
        public async Task InvokeAsync_StripsConditionalValidators_BeforeStaticHandlerRuns()
        {
            var filter = BuildFilter();

            bool downstreamSawIfNoneMatch = true;
            bool downstreamSawIfModifiedSince = true;

            var (context, body) = await RunAsync(filter, async ctx =>
            {
                // Record what the static-file handler actually receives downstream.
                downstreamSawIfNoneMatch = ctx.Request.Headers.ContainsKey("If-None-Match");
                downstreamSawIfModifiedSince = ctx.Request.Headers.ContainsKey("If-Modified-Since");

                ctx.Response.StatusCode = 200;
                ctx.Response.ContentType = "text/html; charset=utf-8";
                await ctx.Response.WriteAsync(IndexHtml);
            });

            // Load-bearing: the validators must be gone before the static handler
            // sees them, so it can never answer a 304. Pre-fix both are forwarded.
            Assert.False(downstreamSawIfNoneMatch, "If-None-Match must be stripped before the static handler runs");
            Assert.False(downstreamSawIfModifiedSince, "If-Modified-Since must be stripped before the static handler runs");

            // The complete 200 body is served (and rewritten in place).
            Assert.Equal(200, context.Response.StatusCode);
            Assert.Contains("<body>", body, StringComparison.Ordinal);
        }

        [Fact]
        public async Task InvokeAsync_ConditionalGet_DoesNotShortCircuitToBodylessNotModified()
        {
            var filter = BuildFilter();

            // Mimics the real static-file handler: it answers 304 (empty body) only
            // while it still sees a conditional validator; otherwise a full 200 body.
            var (context, body) = await RunAsync(filter, async ctx =>
            {
                if (ctx.Request.Headers.ContainsKey("If-None-Match")
                    || ctx.Request.Headers.ContainsKey("If-Modified-Since"))
                {
                    ctx.Response.StatusCode = 304;
                    return;
                }

                ctx.Response.StatusCode = 200;
                ctx.Response.ContentType = "text/html; charset=utf-8";
                await ctx.Response.WriteAsync(IndexHtml);
            });

            // Pre-fix the retained validator produces a bodyless 304 that passes
            // straight through the middleware un-injected; post-fix the strip forces
            // a full 200 the middleware can rewrite.
            Assert.Equal(200, context.Response.StatusCode);
            Assert.Contains("<body>", body, StringComparison.Ordinal);
        }
    }
}
