using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Tests.TestDoubles;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinEnhanced.Tests.Controllers;

/// <summary>
/// Covers the shared Sonarr/Radarr fetch plumbing in
/// <see cref="ArrFetchService"/>.FetchAndMapAsync (extracted from the former
/// controller-base helper): it must use the named arr client, attach the API
/// key per-request (never on the client's DefaultRequestHeaders), and honor
/// the caller's per-endpoint timeout.
/// </summary>
public class ArrHttpPlumbingTests
{
    private static ArrFetchService NewService(IHttpClientFactory httpClientFactory)
        => new(httpClientFactory, NullLogger<ArrFetchService>.Instance);

    private static Task<(string Result, string? Error)> Probe(ArrFetchService service, ArrInstance instance, TimeSpan timeout)
        => service.FetchAndMapAsync(
            instance,
            "/api/v3/queue",
            node => node?.ToJsonString() ?? "null",
            emptyResult: "empty",
            timeout,
            contextLabel: "test queue",
            CancellationToken.None);

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
        var service = NewService(factory);

        var (result, error) = await Probe(service, Instance("http://localhost:8989"), TimeSpan.FromSeconds(10));

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
        var service = NewService(factory);

        await Probe(service, Instance("http://localhost:8989"), TimeSpan.FromSeconds(15));

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
        var service = NewService(factory);

        var (result, error) = await Probe(service, Instance("http://169.254.169.254:8989"), TimeSpan.FromSeconds(10));

        Assert.Equal("empty", result);
        Assert.Equal("URL rejected by SSRF guard", error);
        Assert.Empty(handler.Requests);
        Assert.Empty(factory.CreatedClients);
    }
}
