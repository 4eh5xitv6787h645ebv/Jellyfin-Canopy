using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

public sealed class PlatformAvailabilityFilterTests
{
    [Fact]
    public async Task DisabledAuthenticatedRouteFailsBeforeTheNextResourceFilterWithoutReadingBody()
    {
        var body = new ThrowingBodyStream();
        var http = new DefaultHttpContext();
        http.Request.Body = body;
        http.Request.ContentLength = 4096;
        var context = Context(http);
        var continued = false;

        await Filter(new PluginConfiguration { PlatformEnabled = false })
            .OnResourceExecutionAsync(context, Next(context, () => continued = true));

        Assert.False(continued);
        Assert.Equal(0, body.ReadCalls);
        var result = Assert.IsType<ObjectResult>(context.Result);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, result.StatusCode);
        var error = Assert.IsType<PlatformError>(result.Value);
        Assert.Equal(PlatformErrorCode.Unavailable, error.Code);
        Assert.True(error.Retryable);
        Assert.Matches("^[0-9a-f]{32}$", error.CorrelationId);
        Assert.Equal(error.CorrelationId, http.Response.Headers[PlatformCorrelation.HeaderName]);
        Assert.Equal("no-store", http.Response.Headers.CacheControl);
    }

    [Fact]
    public async Task DisabledShortCircuitSerializesThroughTheAlwaysRunPlatformJsonBoundary()
    {
        var http = new DefaultHttpContext();
        http.Response.Body = new MemoryStream();
        var resource = Context(http);
        await Filter(new PluginConfiguration { PlatformEnabled = false })
            .OnResourceExecutionAsync(resource, Next(resource));
        var filters = new List<IFilterMetadata>();
        var action = new ActionContext(http, resource.RouteData, resource.ActionDescriptor);
        var result = new ResultExecutingContext(action, filters, resource.Result!, new object());

        await new PlatformJsonResultFilter().OnResultExecutionAsync(result, async () =>
        {
            await result.Result.ExecuteResultAsync(action);
            return new ResultExecutedContext(action, filters, result.Result, new object());
        });

        Assert.Equal(StatusCodes.Status503ServiceUnavailable, http.Response.StatusCode);
        Assert.Equal("application/json", http.Response.ContentType);
        using var payload = JsonDocument.Parse(Assert.IsType<MemoryStream>(http.Response.Body).ToArray());
        Assert.Equal(
            new[] { "Code", "CorrelationId", "Error", "Message", "Retryable" },
            payload.RootElement.EnumerateObject().Select(property => property.Name).Order(StringComparer.Ordinal));
        Assert.Equal(PlatformErrorCode.Unavailable, payload.RootElement.GetProperty("Code").GetString());
        Assert.True(payload.RootElement.GetProperty("Retryable").GetBoolean());
        Assert.Equal(
            http.Response.Headers[PlatformCorrelation.HeaderName].ToString(),
            payload.RootElement.GetProperty("CorrelationId").GetString());
    }

    [Fact]
    public async Task DiscoveryProbePublishesOneRequestScopedDecisionAndContinuesWhenDisabled()
    {
        var http = new DefaultHttpContext();
        var context = Context(http, new PlatformDiscoveryProbeAttribute());
        var observed = true;

        await Filter(new PluginConfiguration { PlatformEnabled = false })
            .OnResourceExecutionAsync(context, Next(context, () =>
            {
                observed = PlatformAvailabilityFilter.IsEnabled(http);
            }));

        Assert.False(observed);
        Assert.Null(context.Result);
        Assert.Equal("no-store", http.Response.Headers.CacheControl);
    }

    [Fact]
    public async Task LiveConfigurationIsReadExactlyOncePerRequestAndReenableAllowsOnlyNewRequests()
    {
        var configuration = new CountingProvider(new PluginConfiguration { PlatformEnabled = false });
        var first = Context(new DefaultHttpContext());
        await Filter(configuration).OnResourceExecutionAsync(first, Next(first));

        configuration.Current = new PluginConfiguration { PlatformEnabled = true };
        var second = Context(new DefaultHttpContext());
        var continued = false;
        await Filter(configuration).OnResourceExecutionAsync(second, Next(second, () => continued = true));

        Assert.IsType<ObjectResult>(first.Result);
        Assert.True(continued);
        Assert.Null(second.Result);
        Assert.Equal(2, configuration.Reads);
    }

    [Fact]
    public async Task MissingOrThrowingConfigurationFailsClosedWithoutEscapingTheResourceBoundary()
    {
        foreach (var provider in new IPluginConfigProvider[]
        {
            new FakePluginConfigProvider(null),
            new ThrowingProvider(),
        })
        {
            var context = Context(new DefaultHttpContext());
            await Filter(provider).OnResourceExecutionAsync(context, Next(context));
            Assert.Equal(StatusCodes.Status503ServiceUnavailable, Assert.IsType<ObjectResult>(context.Result).StatusCode);
        }
    }

    [Fact]
    public void DiscoveryMarkerIsDedicatedAndPresentOnlyOnTheAnonymousProbe()
    {
        var marked = typeof(PlatformDiscoveryController).GetMethod(nameof(PlatformDiscoveryController.GetDiscovery))!;
        var negotiate = typeof(PlatformDiscoveryController).GetMethod(nameof(PlatformDiscoveryController.Negotiate))!;

        Assert.NotNull(marked.GetCustomAttributes(typeof(PlatformDiscoveryProbeAttribute), inherit: true).SingleOrDefault());
        Assert.Empty(negotiate.GetCustomAttributes(typeof(PlatformDiscoveryProbeAttribute), inherit: true));
    }

    private static PlatformAvailabilityFilter Filter(PluginConfiguration configuration)
        => Filter(new FakePluginConfigProvider(configuration));

    private static PlatformAvailabilityFilter Filter(IPluginConfigProvider configuration)
        => new(configuration, NullLogger<PlatformAvailabilityFilter>.Instance);

    private static ResourceExecutingContext Context(HttpContext http, params object[] metadata)
    {
        var descriptor = new ActionDescriptor { EndpointMetadata = metadata.ToList() };
        var action = new ActionContext(http, new RouteData(), descriptor, new ModelStateDictionary());
        return new ResourceExecutingContext(action, new List<IFilterMetadata>(), new List<IValueProviderFactory>());
    }

    private static ResourceExecutionDelegate Next(ResourceExecutingContext context, Action? action = null)
        => () =>
        {
            action?.Invoke();
            return Task.FromResult(new ResourceExecutedContext(context, new List<IFilterMetadata>()));
        };

    private sealed class CountingProvider(PluginConfiguration current) : IPluginConfigProvider
    {
        internal PluginConfiguration Current { get; set; } = current;
        internal int Reads { get; private set; }
        public PluginConfiguration Configuration => Current;
        public PluginConfiguration? ConfigurationOrNull => Current;
        public long ConfigurationRevision => Reads;
        public PluginConfigurationSnapshot GetSnapshot()
        {
            Reads++;
            return new PluginConfigurationSnapshot(Current, Reads);
        }
    }

    private sealed class ThrowingProvider : IPluginConfigProvider
    {
        public PluginConfiguration Configuration => throw new InvalidOperationException();
        public PluginConfiguration? ConfigurationOrNull => throw new InvalidOperationException();
        public long ConfigurationRevision => throw new InvalidOperationException();
        public PluginConfigurationSnapshot GetSnapshot() => throw new InvalidOperationException("secret provider detail");
    }

    private sealed class ThrowingBodyStream : Stream
    {
        internal int ReadCalls { get; private set; }
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() => throw new NotSupportedException();
        public override int Read(byte[] buffer, int offset, int count) { ReadCalls++; throw new InvalidOperationException("body read"); }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
