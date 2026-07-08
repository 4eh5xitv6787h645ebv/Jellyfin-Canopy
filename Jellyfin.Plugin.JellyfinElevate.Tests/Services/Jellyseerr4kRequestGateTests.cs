using System.Net;
using System.Net.Http;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinElevate.Configuration;
using Jellyfin.Plugin.JellyfinElevate.Services.Jellyseerr;
using Jellyfin.Plugin.JellyfinElevate.Tests.TestDoubles;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.Services;

/// <summary>
/// Pins that the proxy-side request gate in <see cref="JellyseerrClient.ProxyRequestAsync"/>
/// decouples the 4K permission bits from the base request bits, matching Seerr's
/// own rule (server/entity/MediaRequest.ts): a user holding only REQUEST_4K_MOVIE
/// may submit a 4K request with no base REQUEST / REQUEST_MOVIE / REQUEST_TV bit,
/// and a 4K request from a user with no 4K bit is rejected up front with
/// <c>no_4k_request_permission</c>.
/// </summary>
public class Jellyseerr4kRequestGateTests
{
    private const string UserId = "3f2504e04f8941d39a0c0305e82c3301";

    private static PluginConfiguration Config() => new()
    {
        JellyseerrEnabled = true,
        JellyseerrUrls = "http://seerr:5055",
        JellyseerrApiKey = "test-key",
        // 4K master switch on so the request reaches the permission gate under test.
        JellyseerrEnable4KRequests = true,
        JellyseerrEnable4KTvRequests = true,
    };

    private static (JellyseerrClient client, RecordingHttpMessageHandler handler) NewClient()
    {
        var handler = new RecordingHttpMessageHandler();
        var provider = new FakePluginConfigProvider(Config());
        var client = new JellyseerrClient(
            new RecordingHttpClientFactory(handler),
            NullLogger<JellyseerrClient>.Instance,
            null!,
            new SeerrCache(provider),
            provider,
            new PassthroughParentalFilter());
        return (client, handler);
    }

    private static void SeedUser(RecordingHttpMessageHandler handler, long permissions)
        => handler.AddResponse("/api/v1/user", $"{{\"results\":[{{\"id\":42,\"jellyfinUserId\":\"{UserId}\",\"permissions\":{permissions}}}]}}");

    private static string? GetCode(object? value)
        => value?.GetType().GetProperty("code")?.GetValue(value) as string;

    [Fact]
    public async Task Only4kMoviePermission_NoBaseBit_4kRequestPassesGate()
    {
        var (client, handler) = NewClient();
        // 2048 == REQUEST_4K_MOVIE only. NO base REQUEST / REQUEST_MOVIE / REQUEST_TV bit.
        SeedUser(handler, 2048);
        handler.AddResponse("/api/v1/request", "{\"id\":1}", HttpStatusCode.Created);

        var result = await client.ProxyRequestAsync(
            "/api/v1/request", HttpMethod.Post,
            "{\"mediaType\":\"movie\",\"mediaId\":123,\"is4k\":true}",
            new JellyseerrCaller(UserId, false));

        // The gate did NOT 403 on the missing base bit — the request proxied through.
        Assert.IsType<ContentResult>(result);
    }

    [Fact]
    public async Task No4kBit_4kRequest_Returns403No4kRequestPermission()
    {
        var (client, handler) = NewClient();
        // 262144 == REQUEST_MOVIE (base only) — has the base bit but NO 4K bit.
        SeedUser(handler, 262144);

        var result = await client.ProxyRequestAsync(
            "/api/v1/request", HttpMethod.Post,
            "{\"mediaType\":\"movie\",\"mediaId\":123,\"is4k\":true}",
            new JellyseerrCaller(UserId, false));

        var obj = Assert.IsType<ObjectResult>(result);
        Assert.Equal(403, obj.StatusCode);
        Assert.Equal("no_4k_request_permission", GetCode(obj.Value));
    }

    private sealed class PassthroughParentalFilter : ISeerrParentalFilter
    {
        public Task<SeerrParentalResult> ApplyAsync(string json, string apiPath, JellyseerrCaller caller)
            => Task.FromResult(new SeerrParentalResult(false, json));

        public Task<bool> IsBlockedAsync(string mediaType, int tmdbId, JellyseerrCaller caller)
            => Task.FromResult(false);

        public Task<bool> IsTmdbProxyPathBlockedAsync(string tmdbApiPath, JellyseerrCaller caller)
            => Task.FromResult(false);
    }
}
