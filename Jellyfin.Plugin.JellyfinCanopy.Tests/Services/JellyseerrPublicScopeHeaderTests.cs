using System.Net.Http;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Services.Jellyseerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

/// <summary>
/// SEERR-4: a body cached under the shared <c>public:{apiPath}</c> key must not be
/// user-scoped, so the fetch that produces it must NOT carry the per-user
/// <c>X-Api-User</c> header (the same invariant the certification cache already
/// honours). Per-user endpoints keep sending it.
/// </summary>
public class JellyseerrPublicScopeHeaderTests
{
    private const string UserId = "3f2504e04f8941d39a0c0305e82c3301";

    private static PluginConfiguration Config() => new()
    {
        JellyseerrEnabled = true,
        JellyseerrUrls = "http://seerr:5055",
        JellyseerrApiKey = "test-key",
    };

    private static (JellyseerrClient client, RecordingHttpMessageHandler handler) NewClient()
    {
        var handler = new RecordingHttpMessageHandler();
        // GetJellyseerrUser resolves the caller to Seerr user id 42.
        handler.AddResponse("/api/v1/user", $"{{\"results\":[{{\"id\":42,\"jellyfinUserId\":\"{UserId}\"}}]}}");
        handler.AddResponse("/api/v1/genres/movie", "{}"); // public scope
        handler.AddResponse("/api/v1/movie/123", "{}");    // per-user scope

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

    private static HttpRequestMessage RequestFor(RecordingHttpMessageHandler handler, string absolutePath)
        => Assert.Single(handler.Requests.FindAll(r => r.RequestUri!.AbsolutePath == absolutePath));

    [Fact]
    public async Task PublicScopeFetch_CarriesNoXApiUser()
    {
        var (client, handler) = NewClient();

        await client.ProxyRequestAsync("/api/v1/genres/movie", HttpMethod.Get, null, new JellyseerrCaller(UserId, IsAdmin: true));

        var genresRequest = RequestFor(handler, "/api/v1/genres/movie");
        Assert.False(
            genresRequest.Headers.Contains("X-Api-User"),
            "a public-scope (shared-cache) fetch must not carry the per-user X-Api-User header");
    }

    [Fact]
    public async Task PerUserFetch_StillCarriesXApiUser()
    {
        // Control: a per-user endpoint keeps sending X-Api-User so the proxy can
        // still filter requestedBy etc. — the fix is scoped to public paths only.
        var (client, handler) = NewClient();

        await client.ProxyRequestAsync("/api/v1/movie/123", HttpMethod.Get, null, new JellyseerrCaller(UserId, IsAdmin: true));

        var movieRequest = RequestFor(handler, "/api/v1/movie/123");
        Assert.True(movieRequest.Headers.TryGetValues("X-Api-User", out var values));
        Assert.Equal("42", Assert.Single(values!));
    }

    private sealed class PassthroughParentalFilter : ISeerrParentalFilter
    {
        public System.Threading.Tasks.Task<SeerrParentalResult> ApplyAsync(string json, string apiPath, JellyseerrCaller caller)
            => System.Threading.Tasks.Task.FromResult(new SeerrParentalResult(false, json));

        public System.Threading.Tasks.Task<bool> IsBlockedAsync(string mediaType, int tmdbId, JellyseerrCaller caller)
            => System.Threading.Tasks.Task.FromResult(false);

        public System.Threading.Tasks.Task<bool> IsTmdbProxyPathBlockedAsync(string tmdbApiPath, JellyseerrCaller caller)
            => System.Threading.Tasks.Task.FromResult(false);
    }
}
