using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinEnhanced.Tests.Controllers;

/// <summary>
/// Covers the shared Sonarr/Radarr fetch plumbing in
/// <see cref="JellyfinEnhancedControllerBase"/>.FetchAndMapAsync: it must use the
/// named arr client, attach the API key per-request (never on the client's
/// DefaultRequestHeaders), and honor the caller's per-endpoint timeout.
/// </summary>
public class ArrHttpPlumbingTests
{
    private sealed class ProbeController : JellyfinEnhancedControllerBase
    {
        public ProbeController(IHttpClientFactory httpClientFactory)
            : base(httpClientFactory, NullLogger.Instance, null!, null!, null!)
        {
        }

        public Task<(string Result, string? Error)> Probe(ArrInstance instance, TimeSpan timeout)
            => FetchAndMapAsync(
                instance,
                "/api/v3/queue",
                node => node?.ToJsonString() ?? "null",
                emptyResult: "empty",
                timeout,
                contextLabel: "test queue",
                CancellationToken.None);
    }

    private static ArrInstance Instance(string url) => new ArrInstance
    {
        Name = "test",
        Url = url,
        ApiKey = "arr-secret",
    };

    [Fact]
    public async Task FetchAndMapAsync_UsesNamedArrClient_WithPerRequestApiKey()
    {
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse("/api/v3/queue", """{"records":[]}""");
        var factory = new RecordingHttpClientFactory(handler);
        var controller = new ProbeController(factory);

        var (result, error) = await controller.Probe(Instance("http://localhost:8989"), TimeSpan.FromSeconds(10));

        Assert.Null(error);
        Assert.Equal("""{"records":[]}""", result);

        // Named arr client, not the unnamed default.
        Assert.Equal(PluginHttpClients.ArrClient, Assert.Single(factory.RequestedNames));

        // API key present on the request at send time...
        Assert.Equal("arr-secret", Assert.Single(handler.ApiKeyHeaders));

        // ...and never on the factory client's DefaultRequestHeaders.
        var client = Assert.Single(factory.CreatedClients);
        Assert.Empty(client.DefaultRequestHeaders);
    }

    [Fact]
    public async Task FetchAndMapAsync_AppliesCallerTimeout_ToItsOwnClientInstance()
    {
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse("/api/v3/queue", "[]");
        var factory = new RecordingHttpClientFactory(handler);
        var controller = new ProbeController(factory);

        await controller.Probe(Instance("http://localhost:8989"), TimeSpan.FromSeconds(15));

        // The historical per-endpoint deadline (10s links/requests, 15s calendar)
        // is preserved on the instance the factory handed out for this call.
        var client = Assert.Single(factory.CreatedClients);
        Assert.Equal(TimeSpan.FromSeconds(15), client.Timeout);
    }

    [Fact]
    public async Task FetchAndMapAsync_BlockedUrl_ReturnsEmptyWithoutAnyRequest()
    {
        var handler = new RecordingHttpMessageHandler();
        var factory = new RecordingHttpClientFactory(handler);
        var controller = new ProbeController(factory);

        var (result, error) = await controller.Probe(Instance("http://169.254.169.254:8989"), TimeSpan.FromSeconds(10));

        Assert.Equal("empty", result);
        Assert.Equal("URL rejected by SSRF guard", error);
        Assert.Empty(handler.Requests);
        Assert.Empty(factory.CreatedClients);
    }
}
