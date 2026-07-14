using System.Net.Http;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

/// <summary>
/// Pins that a crafted truthy <c>is4k</c> value (a nonzero number or the strings
/// "true"/"1") is recognised as a 4K request, so it can't dodge the JC admin 4K
/// master switch by slipping past a strict <c>== true</c> check and falling
/// through to Seerr. Master switch off + truthy is4k must be blocked with
/// <c>4k_requests_disabled</c>.
/// </summary>
public class Seerr4kMasterSwitchTests
{
    private const string UserId = "3f2504e04f8941d39a0c0305e82c3301";

    private static PluginConfiguration ConfigMasterOff() => new()
    {
        SeerrEnabled = true,
        SeerrUrls = "http://seerr:5055",
        SeerrApiKey = "test-key",
        SeerrEnable4KRequests = false,
        SeerrEnable4KTvRequests = false,
    };

    private static (SeerrClient client, RecordingHttpMessageHandler handler) NewClient()
    {
        var handler = new RecordingHttpMessageHandler();
        var provider = new FakePluginConfigProvider(ConfigMasterOff());
        var client = new SeerrClient(
            new RecordingHttpClientFactory(handler),
            NullLogger<SeerrClient>.Instance,
            null!,
            new SeerrCache(provider),
            provider,
            new PassthroughParentalFilter());
        // A resolvable user so the gate is reached; permissions are irrelevant here.
        handler.AddResponse("/api/v1/user", $"{{\"results\":[{{\"id\":42,\"jellyfinUserId\":\"{UserId}\",\"permissions\":2048}}],\"pageInfo\":{{\"page\":1,\"pages\":1,\"results\":1}}}}");
        return (client, handler);
    }

    private static string? GetCode(object? value)
        => value?.GetType().GetProperty("code")?.GetValue(value) as string;

    [Theory]
    [InlineData("{\"mediaType\":\"movie\",\"mediaId\":123,\"is4k\":1}")]        // nonzero number
    [InlineData("{\"mediaType\":\"movie\",\"mediaId\":123,\"is4k\":\"true\"}")] // string "true"
    [InlineData("{\"mediaType\":\"movie\",\"mediaId\":123,\"is4k\":\"1\"}")]    // string "1"
    public async Task CraftedTruthyIs4k_WithMasterSwitchOff_IsBlocked(string body)
    {
        var (client, _) = NewClient();

        var result = await client.ProxyRequestAsync(
            "/api/v1/request", HttpMethod.Post, body,
            new SeerrCaller(UserId, false));

        var obj = Assert.IsType<ObjectResult>(result);
        Assert.Equal(403, obj.StatusCode);
        Assert.Equal("4k_requests_disabled", GetCode(obj.Value));
    }

    private sealed class PassthroughParentalFilter : ISeerrParentalFilter
    {
        public Task<SeerrParentalResult> ApplyAsync(string json, string apiPath, SeerrCaller caller)
            => Task.FromResult(new SeerrParentalResult(false, json));

        public Task<bool> IsBlockedAsync(string mediaType, int tmdbId, SeerrCaller caller)
            => Task.FromResult(false);

        public Task<bool> IsTmdbProxyPathBlockedAsync(string tmdbApiPath, SeerrCaller caller)
            => Task.FromResult(false);
    }
}
