using System.Net;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Model.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers;

public sealed class SeerrPartialRequestsGenerationFenceTests
{
    private const string JellyfinUserId = "55555555-5555-5555-5555-555555555555";
    private const string SourceA = "http://source-a:5055";
    private const string SourceB = "http://source-b:5055";

    [Fact]
    public async Task PartialSettings_UpstreamFailure_ServesOnlyTheExactLastKnownGeneration()
    {
        var provider = new FakePluginConfigProvider(Configuration(SourceA, "key-a"));
        var handler = new SequentialSettingsHandler();
        var cache = new SeerrCache(provider);
        var controller = CreateController(provider, handler, cache, SourceA);

        var fresh = Assert.IsType<OkObjectResult>(await controller.GetSeerrPartialRequestsSetting());
        Assert.True(Property<bool>(fresh.Value, "partialRequestsEnabled"));
        Assert.False(Property<bool>(fresh.Value, "enableSpecialEpisodes"));
        Assert.False(Property<bool>(fresh.Value, "stale"));

        handler.Fail = true;
        var fallback = Assert.IsType<OkObjectResult>(await controller.GetSeerrPartialRequestsSetting());
        Assert.True(Property<bool>(fallback.Value, "partialRequestsEnabled"));
        Assert.False(Property<bool>(fallback.Value, "enableSpecialEpisodes"));
        Assert.True(Property<bool>(fallback.Value, "stale"));

        provider.Current = Configuration(SourceA, "key-b");
        var changed = Assert.IsType<ObjectResult>(await controller.GetSeerrPartialRequestsSetting());
        Assert.Equal(503, changed.StatusCode);
        Assert.Equal("unreachable", Property<string>(changed.Value, "code"));
    }

    [Fact]
    public async Task PartialSettings_ConfigChangesWhileReadIsInFlight_UsesCapturedPairAndRejectsStaleReturn()
    {
        var initial = Configuration($"{SourceA}\n{SourceB}", "key-a");
        var provider = new FakePluginConfigProvider(initial);
        var handler = new BlockingSettingsHandler();
        var factory = new RecordingHttpClientFactory(handler);
        var seerr = new FixedSeerrClient(new SeerrUser
        {
            Id = 7,
            JellyfinUserId = JellyfinUserId,
            SourceUrl = SourceB,
        });
        var controller = new SeerrProxyController(
            factory,
            NullLogger<SeerrProxyController>.Instance,
            new StubUserManager(),
            new SeerrCache(provider),
            provider,
            seerr,
            parentalFilter: null!,
            spoilerPending: null!);
        controller.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity(
                    new[] { new Claim("Jellyfin-UserId", JellyfinUserId) },
                    "TestAuth")),
            },
        };

        var readTask = controller.GetSeerrPartialRequestsSetting();
        await handler.RequestStarted.WaitAsync(TimeSpan.FromSeconds(5));

        provider.Current = Configuration(SourceA, "key-b");
        handler.Release();

        var conflict = Assert.IsType<ObjectResult>(await readTask);
        Assert.Equal(409, conflict.StatusCode);
        Assert.Equal(
            "read_configuration_changed",
            conflict.Value?.GetType().GetProperty("code")?.GetValue(conflict.Value));
        var request = Assert.Single(handler.Requests);
        Assert.Equal("source-b", request.Host);
        Assert.Equal("key-a", request.ApiKey);
    }

    private static PluginConfiguration Configuration(string urls, string key) => new()
    {
        SeerrEnabled = true,
        SeerrUrls = urls,
        SeerrApiKey = key,
    };

    private static SeerrProxyController CreateController(
        FakePluginConfigProvider provider,
        HttpMessageHandler handler,
        SeerrCache cache,
        string sourceUrl)
    {
        var controller = new SeerrProxyController(
            new RecordingHttpClientFactory(handler),
            NullLogger<SeerrProxyController>.Instance,
            new StubUserManager(),
            cache,
            provider,
            new FixedSeerrClient(new SeerrUser
            {
                Id = 7,
                JellyfinUserId = JellyfinUserId,
                SourceUrl = sourceUrl,
            }),
            parentalFilter: null!,
            spoilerPending: null!);
        controller.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity(
                    new[] { new Claim("Jellyfin-UserId", JellyfinUserId) },
                    "TestAuth")),
            },
        };
        return controller;
    }

    private static T Property<T>(object? value, string name)
    {
        Assert.NotNull(value);
        return Assert.IsType<T>(value.GetType().GetProperty(name)!.GetValue(value));
    }

    private sealed class SequentialSettingsHandler : HttpMessageHandler
    {
        public bool Fail { get; set; }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
            => Task.FromResult(Fail
                ? new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)
                {
                    Content = new StringContent("{}", Encoding.UTF8, "application/json"),
                }
                : new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(
                        """{"partialRequestsEnabled":true,"enableSpecialEpisodes":false}""",
                        Encoding.UTF8,
                        "application/json"),
                });
    }

    private sealed class BlockingSettingsHandler : HttpMessageHandler
    {
        private readonly TaskCompletionSource<bool> _started = new(
            TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource<bool> _release = new(
            TaskCreationOptions.RunContinuationsAsynchronously);

        public Task RequestStarted => _started.Task;

        public List<CapturedRequest> Requests { get; } = new();

        public void Release() => _release.TrySetResult(true);

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var apiKey = request.Headers.TryGetValues("X-Api-Key", out var values)
                ? values.SingleOrDefault()
                : null;
            Requests.Add(new CapturedRequest(request.RequestUri!.Host, apiKey));
            _started.TrySetResult(true);
            await _release.Task.WaitAsync(cancellationToken);
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    JsonSerializer.Serialize(new
                    {
                        partialRequestsEnabled = true,
                        enableSpecialEpisodes = false,
                    }),
                    Encoding.UTF8,
                    "application/json"),
            };
        }
    }

    private sealed record CapturedRequest(string Host, string? ApiKey);

    private sealed class FixedSeerrClient : ISeerrClient
    {
        private readonly SeerrUser _user;

        public FixedSeerrClient(SeerrUser user)
        {
            _user = user;
        }

        public Task<SeerrUserResolution> ResolveSeerrUser(
            string jellyfinUserId,
            bool bypassCache = false,
            bool allowAutoImport = true,
            CancellationToken cancellationToken = default)
            => Task.FromResult(SeerrUserResolution.Found(_user));

        public Task<SeerrUser?> GetSeerrUser(
            string jellyfinUserId,
            bool bypassCache = false,
            bool allowAutoImport = true)
            => Task.FromResult<SeerrUser?>(_user);

        public Task<string?> GetSeerrUserId(string jellyfinUserId, bool allowAutoImport = true)
            => throw new NotImplementedException();

        public bool IsImportBlocked(string jellyfinUserId, PluginConfiguration config)
            => throw new NotImplementedException();

        public Task<bool> GetStatusActiveAsync() => throw new NotImplementedException();

        public Task<Seerr4kCapability> GetSeerr4kCapabilityAsync(string jellyfinUserId, bool isAdmin = false)
            => throw new NotImplementedException();

        public void EvictMediaDetailCache(int tmdbId, string mediaType)
        {
        }

        public Task<IActionResult> ProxyRequestAsync(
            string apiPath,
            HttpMethod method,
            string? content,
            SeerrCaller caller)
            => throw new NotImplementedException();

        public Task<List<WatchlistItem>?> GetWatchlistForUser(string seerrUserId)
            => throw new NotImplementedException();

        public Task<List<WatchlistItem>?> GetRequestsForUser(string seerrUserId)
            => throw new NotImplementedException();
    }
}
