using System.Net;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Model.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Services.Arr;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers;

public sealed class ArrRequestsGenerationFenceTests
{
    private const string JellyfinUserId = "66666666-6666-6666-6666-666666666666";
    private const string SourceA = "http://source-a:5055";
    private const string SourceB = "http://source-b:5055";

    [Fact]
    public async Task GetRequests_ConfigChangesDuringEnrichment_RejectsOutputAndStaleCachePublication()
    {
        var provider = new FakePluginConfigProvider(Configuration(SourceA, "key-a"));
        var cache = new SeerrCache(provider);
        var handler = new RequestHandler(RequestList(), blockDetail: true);
        var controller = BuildController(
            handler,
            provider,
            cache,
            new FixedSeerrClient(User()),
            new PassthroughParentalFilter());

        var readTask = controller.GetRequests();
        await handler.DetailStarted.WaitAsync(TimeSpan.FromSeconds(5));

        provider.Current = Configuration(SourceB, "key-b");
        handler.ReleaseDetail();

        var conflict = Assert.IsType<ObjectResult>(await readTask);
        Assert.Equal(409, conflict.StatusCode);
        Assert.Equal("read_configuration_changed", Code(conflict));
        Assert.Empty(cache.TmdbEnrichmentCache);
        var detail = Assert.Single(
            handler.Requests,
            request => request.Path == "/api/v1/movie/101");
        Assert.Equal("source-a", detail.Host);
        Assert.Equal("key-a", detail.ApiKey);
    }

    [Fact]
    public async Task GetRequestSnapshot_ConfigChangesDuringParentalProjection_ReturnsConflict()
    {
        var provider = new FakePluginConfigProvider(Configuration(SourceA, "key-a"));
        var cache = new SeerrCache(provider);
        var handler = new RequestHandler(EmptyRequestList(), blockDetail: false);
        var controller = BuildController(
            handler,
            provider,
            cache,
            new FixedSeerrClient(User()),
            new SwitchingParentalFilter(
                provider,
                Configuration(SourceB, "key-b")));

        var conflict = Assert.IsType<ObjectResult>(
            await controller.GetCompleteUserRequestSnapshot());

        Assert.Equal(409, conflict.StatusCode);
        Assert.Equal("read_configuration_changed", Code(conflict));
        Assert.All(handler.Requests, request => Assert.Equal("key-a", request.ApiKey));
    }

    [Fact]
    public async Task GetDownloadQueue_ConfigChangesDuringPinnedUserRequestRead_ReturnsConflict()
    {
        var initial = Configuration(SourceA, "key-a");
        initial.DownloadsFilterByUserRequests = true;
        var replacement = Configuration(SourceB, "key-b");
        replacement.DownloadsFilterByUserRequests = true;
        var provider = new FakePluginConfigProvider(initial);
        var cache = new SeerrCache(provider);
        var seerr = new SwitchingRequestsClient(User(), provider, replacement);
        var handler = new RequestHandler(EmptyRequestList(), blockDetail: false);
        var controller = BuildController(
            handler,
            provider,
            cache,
            seerr,
            new PassthroughParentalFilter());

        var conflict = Assert.IsType<ObjectResult>(await controller.GetDownloadQueue());

        Assert.Equal(409, conflict.StatusCode);
        Assert.Equal("read_configuration_changed", Code(conflict));
        Assert.True(seerr.RequestReadCalled);
        Assert.Empty(handler.Requests);
    }

    private static ArrRequestsController BuildController(
        HttpMessageHandler handler,
        FakePluginConfigProvider provider,
        SeerrCache cache,
        ISeerrClient seerr,
        ISeerrParentalFilter parentalFilter)
    {
        var factory = new RecordingHttpClientFactory(handler);
        var controller = new ArrRequestsController(
            factory,
            NullLogger<ArrRequestsController>.Instance,
            new StubUserManager(),
            cache,
            provider,
            seerr,
            new ArrFetchService(factory, NullLogger<ArrFetchService>.Instance),
            parentalFilter);
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

    private static PluginConfiguration Configuration(string source, string apiKey) => new()
    {
        SeerrEnabled = true,
        SeerrUrls = source,
        SeerrApiKey = apiKey,
    };

    private static SeerrUser User() => new()
    {
        Id = 7,
        JellyfinUserId = JellyfinUserId,
        SourceUrl = SourceA,
        Permissions = SeerrPermission.REQUEST_VIEW,
    };

    private static string Code(ObjectResult result)
        => (string)result.Value!.GetType().GetProperty("code")!.GetValue(result.Value)!;

    private static object EmptyRequestList() => new
    {
        results = Array.Empty<object>(),
        pageInfo = new { page = 1, pages = 1, pageSize = 0, results = 0 },
    };

    private static object RequestList() => new
    {
        results = new[]
        {
            new
            {
                id = 1,
                type = "movie",
                status = 2,
                is4k = false,
                requestedBy = new { id = 7, username = "caller" },
                media = new
                {
                    tmdbId = 101,
                    mediaType = "movie",
                    status = 3,
                    downloadStatus = Array.Empty<object>(),
                },
            },
        },
        pageInfo = new { page = 1, pages = 1, pageSize = 1, results = 1 },
    };

    private sealed class RequestHandler : HttpMessageHandler
    {
        private readonly object _requestList;
        private readonly bool _blockDetail;
        private readonly TaskCompletionSource<bool> _detailStarted = new(
            TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource<bool> _releaseDetail = new(
            TaskCreationOptions.RunContinuationsAsynchronously);

        public RequestHandler(object requestList, bool blockDetail)
        {
            _requestList = requestList;
            _blockDetail = blockDetail;
        }

        public Task DetailStarted => _detailStarted.Task;

        public List<CapturedRequest> Requests { get; } = new();

        public void ReleaseDetail() => _releaseDetail.TrySetResult(true);

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var apiKey = request.Headers.TryGetValues("X-Api-Key", out var values)
                ? values.SingleOrDefault()
                : null;
            Requests.Add(new CapturedRequest(
                request.RequestUri!.Host,
                request.RequestUri.AbsolutePath,
                apiKey));

            if (request.RequestUri.AbsolutePath == "/api/v1/request")
            {
                return Json(_requestList);
            }

            if (request.RequestUri.AbsolutePath == "/api/v1/movie/101")
            {
                _detailStarted.TrySetResult(true);
                if (_blockDetail)
                {
                    await _releaseDetail.Task.WaitAsync(cancellationToken);
                }

                return Json(new
                {
                    title = "Old generation title",
                    releaseDate = "2026-01-01",
                    posterPath = "/old.jpg",
                });
            }

            return new HttpResponseMessage(HttpStatusCode.NotFound)
            {
                Content = new StringContent("{}", Encoding.UTF8, "application/json"),
            };
        }

        private static HttpResponseMessage Json(object body)
            => new(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    JsonSerializer.Serialize(body),
                    Encoding.UTF8,
                    "application/json"),
            };
    }

    private sealed record CapturedRequest(string Host, string Path, string? ApiKey);

    private class FixedSeerrClient : ISeerrClient
    {
        private readonly SeerrUser _user;

        public FixedSeerrClient(SeerrUser user)
        {
            _user = user;
        }

        public virtual Task<SeerrUserResolution> ResolveSeerrUser(
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

        public virtual Task<List<WatchlistItem>?> GetRequestsForUser(string seerrUserId)
            => throw new NotImplementedException();
    }

    private sealed class SwitchingRequestsClient : FixedSeerrClient
    {
        private readonly FakePluginConfigProvider _provider;
        private readonly PluginConfiguration _replacement;

        public SwitchingRequestsClient(
            SeerrUser user,
            FakePluginConfigProvider provider,
            PluginConfiguration replacement)
            : base(user)
        {
            _provider = provider;
            _replacement = replacement;
        }

        public bool RequestReadCalled { get; private set; }

        public override Task<List<WatchlistItem>?> GetRequestsForUser(string seerrUserId)
        {
            RequestReadCalled = true;
            _provider.Current = _replacement;
            return Task.FromResult<List<WatchlistItem>?>(new List<WatchlistItem>());
        }
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

    private sealed class SwitchingParentalFilter : ISeerrParentalFilter
    {
        private readonly FakePluginConfigProvider _provider;
        private readonly PluginConfiguration _replacement;

        public SwitchingParentalFilter(
            FakePluginConfigProvider provider,
            PluginConfiguration replacement)
        {
            _provider = provider;
            _replacement = replacement;
        }

        public Task<SeerrParentalResult> ApplyAsync(string json, string apiPath, SeerrCaller caller)
        {
            _provider.Current = _replacement;
            return Task.FromResult(new SeerrParentalResult(false, json));
        }

        public Task<bool> IsBlockedAsync(string mediaType, int tmdbId, SeerrCaller caller)
            => Task.FromResult(false);

        public Task<bool> IsTmdbProxyPathBlockedAsync(string tmdbApiPath, SeerrCaller caller)
            => Task.FromResult(false);
    }
}
