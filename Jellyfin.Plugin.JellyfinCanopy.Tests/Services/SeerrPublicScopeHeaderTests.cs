using System.Net.Http;
using System.Linq;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Model.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.AspNetCore.Mvc;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

/// <summary>
/// SEERR-4: a body cached under the shared <c>public:{apiPath}</c> key must not be
/// user-scoped, so the fetch that produces it must NOT carry the per-user
/// <c>X-Api-User</c> header (the same invariant the certification cache already
/// honours). Per-user endpoints keep sending it.
/// </summary>
public class SeerrPublicScopeHeaderTests
{
    private const string UserId = "3f2504e04f8941d39a0c0305e82c3301";

    private static PluginConfiguration Config() => new()
    {
        SeerrEnabled = true,
        SeerrUrls = "http://seerr:5055",
        SeerrApiKey = "test-key",
    };

    private static (SeerrClient client, RecordingHttpMessageHandler handler) NewClient()
    {
        var handler = new RecordingHttpMessageHandler();
        // GetSeerrUser resolves the caller to Seerr user id 42.
        handler.AddResponse("/api/v1/user", $"{{\"results\":[{{\"id\":42,\"jellyfinUserId\":\"{UserId}\"}}],\"pageInfo\":{{\"page\":1,\"pages\":1,\"results\":1}}}}");
        handler.AddResponse("/api/v1/genres/movie", "{}"); // public scope
        handler.AddResponse("/api/v1/movie/123", "{}");    // per-user scope

        var provider = new FakePluginConfigProvider(Config());
        var client = new SeerrClient(
            new RecordingHttpClientFactory(handler),
            NullLogger<SeerrClient>.Instance,
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

        await client.ProxyRequestAsync("/api/v1/genres/movie", HttpMethod.Get, null, new SeerrCaller(UserId, IsAdmin: true));

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

        await client.ProxyRequestAsync("/api/v1/movie/123", HttpMethod.Get, null, new SeerrCaller(UserId, IsAdmin: true));

        var movieRequest = RequestFor(handler, "/api/v1/movie/123");
        Assert.True(movieRequest.Headers.TryGetValues("X-Api-User", out var values));
        Assert.Equal("42", Assert.Single(values!));
    }

    [Fact]
    public async Task FreshTvDetail_BypassesCacheReadAndDoesNotPublishItsResponse()
    {
        var (client, handler) = NewClient();
        handler.AddResponse("/api/v1/tv/123", "{\"version\":1}");
        var caller = new SeerrCaller(UserId, IsAdmin: true);

        var first = Assert.IsType<ContentResult>(await client.ProxyRequestAsync(
            "/api/v1/tv/123",
            HttpMethod.Get,
            null,
            caller));
        handler.AddResponse("/api/v1/tv/123", "{\"version\":2}");

        var cached = Assert.IsType<ContentResult>(await client.ProxyRequestAsync(
            "/api/v1/tv/123",
            HttpMethod.Get,
            null,
            caller));
        var fresh = Assert.IsType<ContentResult>(await client.ProxyFreshTvDetailAsync(123, caller));
        var cachedAgain = Assert.IsType<ContentResult>(await client.ProxyRequestAsync(
            "/api/v1/tv/123",
            HttpMethod.Get,
            null,
            caller));

        Assert.Contains("\"version\":1", first.Content);
        Assert.Contains("\"version\":1", cached.Content);
        Assert.Contains("\"version\":2", fresh.Content);
        Assert.Contains("\"version\":1", cachedAgain.Content);
        Assert.Equal(
            2,
            handler.Requests.Count(request => request.RequestUri!.AbsolutePath == "/api/v1/tv/123"));
    }

    [Fact]
    public async Task PersonCombinedCredits_RemainsUserScopedAndCarriesXApiUser()
    {
        var (client, handler) = NewClient();
        handler.AddResponse("/api/v1/person/123/combined_credits", "{}");

        await client.ProxyRequestAsync(
            "/api/v1/person/123/combined_credits",
            HttpMethod.Get,
            null,
            new SeerrCaller(UserId, IsAdmin: true));

        var request = RequestFor(handler, "/api/v1/person/123/combined_credits");
        Assert.True(request.Headers.TryGetValues("X-Api-User", out var values));
        Assert.Equal("42", Assert.Single(values!));
    }

    [Fact]
    public async Task BarePersonDetail_RemainsPublicAndCarriesNoXApiUser()
    {
        var (client, handler) = NewClient();
        handler.AddResponse("/api/v1/person/123", "{}");

        await client.ProxyRequestAsync(
            "/api/v1/person/123?language=en",
            HttpMethod.Get,
            null,
            new SeerrCaller(UserId, IsAdmin: true));

        var request = RequestFor(handler, "/api/v1/person/123");
        Assert.False(request.Headers.Contains("X-Api-User"));
    }

    [Fact]
    public async Task PerUserCache_IsPartitionedByExactResolvedSource()
    {
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse(
            "/api/v1/user/42",
            $"{{\"id\":42,\"jellyfinUserId\":\"{UserId}\",\"permissions\":0}}");
        handler.AddResponse("/api/v1/movie/123", "{}");
        var config = Config();
        config.SeerrUrls = "http://source-a:5055,http://source-b:5055";
        var provider = new FakePluginConfigProvider(config);
        var client = new SeerrClient(
            new RecordingHttpClientFactory(handler),
            NullLogger<SeerrClient>.Instance,
            null!,
            new SeerrCache(provider),
            provider,
            new PassthroughParentalFilter());
        var caller = new SeerrCaller(UserId, IsAdmin: true);

        await client.ProxyRequestAsync(
            "/api/v1/movie/123",
            HttpMethod.Get,
            null,
            caller,
            new SeerrUser { Id = 42, SourceUrl = "http://source-a:5055" });
        await client.ProxyRequestAsync(
            "/api/v1/movie/123",
            HttpMethod.Get,
            null,
            caller,
            new SeerrUser { Id = 42, SourceUrl = "http://source-b:5055" });

        Assert.Equal(
            new[] { "source-a", "source-b" },
            handler.Requests
                .Where(request => request.RequestUri!.AbsolutePath == "/api/v1/movie/123")
                .Select(request => request.RequestUri!.Host));
    }

    [Fact]
    public async Task PerUserCache_IsPartitionedByInstanceLocalUserIdAfterSameSourceRebind()
    {
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse(
            "/api/v1/user/7",
            $"{{\"id\":7,\"jellyfinUserId\":\"{UserId}\",\"permissions\":0}}");
        handler.AddResponse(
            "/api/v1/user/9",
            $"{{\"id\":9,\"jellyfinUserId\":\"{UserId}\",\"permissions\":0}}");
        handler.AddResponse("/api/v1/movie/123", "{}");
        var config = Config();
        config.SeerrUrls = "http://source-a:5055";
        var provider = new FakePluginConfigProvider(config);
        var client = new SeerrClient(
            new RecordingHttpClientFactory(handler),
            NullLogger<SeerrClient>.Instance,
            null!,
            new SeerrCache(provider),
            provider,
            new PassthroughParentalFilter());
        var caller = new SeerrCaller(UserId, IsAdmin: true);

        await client.ProxyRequestAsync(
            "/api/v1/movie/123",
            HttpMethod.Get,
            null,
            caller,
            new SeerrUser { Id = 7, SourceUrl = "http://source-a:5055" });
        await client.ProxyRequestAsync(
            "/api/v1/movie/123",
            HttpMethod.Get,
            null,
            caller,
            new SeerrUser { Id = 9, SourceUrl = "http://source-a:5055" });

        var requests = handler.Requests
            .Where(request => request.RequestUri!.AbsolutePath == "/api/v1/movie/123")
            .ToList();
        Assert.Equal(2, requests.Count);
        Assert.Equal(
            new[] { "7", "9" },
            requests.Select(request => request.Headers.GetValues("X-Api-User").Single()));
    }

    [Fact]
    public async Task Mutation_SameSourceRebindAfterCachedResolutionFailsBeforePost()
    {
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse(
            "/api/v1/user",
            $"{{\"results\":[{{\"id\":9,\"jellyfinUserId\":\"{UserId}\",\"permissions\":2}}],\"pageInfo\":{{\"page\":1,\"pages\":1,\"results\":1}}}}");
        handler.AddResponse("/api/v1/issue", "{}");
        var config = Config();
        config.SeerrUrls = "http://source-a:5055";
        var provider = new FakePluginConfigProvider(config);
        var cache = new SeerrCache(provider);
        cache.UserCache[SeerrClient.NormalizeUserId(UserId)] = (
            new SeerrUser
            {
                Id = 7,
                JellyfinUserId = UserId,
                Permissions = (SeerrPermission)2,
                SourceUrl = "http://source-a:5055",
            },
            DateTime.UtcNow,
            provider.ConfigurationRevision,
            SeerrClient.BuildConfigurationIdentity(config));
        var client = new SeerrClient(
            new RecordingHttpClientFactory(handler),
            NullLogger<SeerrClient>.Instance,
            null!,
            cache,
            provider,
            new PassthroughParentalFilter());

        var result = Assert.IsType<ObjectResult>(await client.ProxyRequestAsync(
            "/api/v1/issue",
            HttpMethod.Post,
            "{}",
            new SeerrCaller(UserId, IsAdmin: true)));

        Assert.Equal(409, result.StatusCode);
        Assert.Equal(
            2,
            handler.Requests.Count(request => request.RequestUri!.AbsolutePath == "/api/v1/user"));
        Assert.DoesNotContain(
            handler.Sent,
            request => request.Method == HttpMethod.Post && request.Path == "/api/v1/issue");
        Assert.False(cache.UserCache.ContainsKey(SeerrClient.NormalizeUserId(UserId)));
    }

    private sealed class PassthroughParentalFilter : ISeerrParentalFilter
    {
        public System.Threading.Tasks.Task<SeerrParentalResult> ApplyAsync(string json, string apiPath, SeerrCaller caller)
            => System.Threading.Tasks.Task.FromResult(new SeerrParentalResult(false, json));

        public System.Threading.Tasks.Task<bool> IsBlockedAsync(string mediaType, int tmdbId, SeerrCaller caller)
            => System.Threading.Tasks.Task.FromResult(false);

        public System.Threading.Tasks.Task<bool> IsTmdbProxyPathBlockedAsync(string tmdbApiPath, SeerrCaller caller)
            => System.Threading.Tasks.Task.FromResult(false);
    }
}
