using System.Net;
using System.Text;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Model.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers;

public sealed class SeerrUserManualWatchlistSyncTests
{
    [Fact]
    public async Task SameJellyfinUserOnTwoDomains_AggregatesLaterDomainAndDeduplicatesMediaKeys()
    {
        var user = new User("multi-source-user", "provider", "password-provider");
        var firstMovie = MovieWithTmdbId(101);
        var secondMovie = MovieWithTmdbId(202);
        var handler = new RoutingHandler(request =>
        {
            var uri = request.RequestUri!;
            if (uri.AbsolutePath == "/api/v1/user")
            {
                var seerrUserId = uri.Host == "source-a" ? 11 : 22;
                return Page(new { id = seerrUserId, jellyfinUserId = user.Id.ToString() });
            }

            if (uri.AbsolutePath.EndsWith("/watchlist", StringComparison.Ordinal))
            {
                return uri.Host == "source-a"
                    ? Page(new { tmdbId = 101, mediaType = "movie" })
                    : Page(new { tmdbId = 202, mediaType = "movie" });
            }

            if (uri.AbsolutePath == "/api/v1/request")
            {
                return uri.Host == "source-a"
                    ? Page(new
                    {
                        id = 301,
                        requestedBy = new { id = 11 },
                        media = new { tmdbId = 101, mediaType = "movie" },
                    })
                    : Page();
            }

            throw new Xunit.Sdk.XunitException($"Unexpected request {request.Method} {uri}.");
        });
        var libraryQueries = 0;
        var library = new CountingLibraryManager
        {
            GetItemListHook = _ =>
            {
                libraryQueries++;
                return new BaseItem[] { firstMovie, secondMovie };
            },
        };
        var projectedTmdbIds = new List<string>();
        var userData = new StubUserDataManager
        {
            GetUserDataHook = (_, item) =>
            {
                projectedTmdbIds.Add(item.ProviderIds["Tmdb"]);
                return new UserItemData { Key = item.Id.ToString("N"), Likes = true };
            },
        };
        var controller = BuildController(
            user,
            handler,
            library,
            userData,
            "http://source-a,http://source-b",
            addRequests: true);

        var result = await controller.SyncSeerrWatchlist();

        var ok = Assert.IsType<OkObjectResult>(result);
        var body = JsonSerializer.SerializeToElement(ok.Value);
        Assert.Equal(2, body.GetProperty("itemsProcessed").GetInt32());
        Assert.Equal(0, body.GetProperty("itemsAdded").GetInt32());
        Assert.Equal(2, libraryQueries);
        Assert.Equal(new[] { "101", "202" }, projectedTmdbIds.OrderBy(static id => id));
        Assert.Contains(handler.Requests, request =>
            request.Uri.Host == "source-b"
            && request.Uri.AbsolutePath.EndsWith("/watchlist", StringComparison.Ordinal));
    }

    [Fact]
    public async Task LaterDomainCollectionFailure_PerformsNoEarlierLocalLookupOrSave()
    {
        var user = new User("fail-closed-user", "provider", "password-provider");
        var handler = new RoutingHandler(request =>
        {
            var uri = request.RequestUri!;
            if (uri.AbsolutePath == "/api/v1/user")
            {
                var seerrUserId = uri.Host == "source-a" ? 11 : 22;
                return Page(new { id = seerrUserId, jellyfinUserId = user.Id.ToString() });
            }

            if (uri.AbsolutePath.EndsWith("/watchlist", StringComparison.Ordinal))
            {
                return uri.Host == "source-a"
                    ? Page(new { tmdbId = 101, mediaType = "movie" })
                    : Json(new { error = true }, HttpStatusCode.BadGateway);
            }

            if (uri.AbsolutePath == "/api/v1/request")
            {
                return Page(new
                {
                    id = 301,
                    requestedBy = new { id = 11 },
                    media = new { tmdbId = 101, mediaType = "movie" },
                });
            }

            throw new Xunit.Sdk.XunitException($"Unexpected request {request.Method} {uri}.");
        });
        var libraryQueries = 0;
        var library = new CountingLibraryManager
        {
            GetItemListHook = _ =>
            {
                libraryQueries++;
                return Array.Empty<BaseItem>();
            },
        };
        var controller = BuildController(
            user,
            handler,
            library,
            new StubUserDataManager(),
            "http://source-a,http://source-b",
            addRequests: true);

        var result = await controller.SyncSeerrWatchlist();

        var failure = Assert.IsType<ObjectResult>(result);
        Assert.Equal(502, failure.StatusCode);
        Assert.Equal(0, libraryQueries);
        Assert.Contains(handler.Requests, request =>
            request.Uri.Host == "source-a" && request.Uri.AbsolutePath == "/api/v1/request");
        Assert.Contains(handler.Requests, request =>
            request.Uri.Host == "source-b"
            && request.Uri.AbsolutePath.EndsWith("/watchlist", StringComparison.Ordinal));
    }

    [Fact]
    public async Task CanonicalConfiguredAliases_AreReadAsOneIdentityDomain()
    {
        var user = new User("alias-user", "provider", "password-provider");
        var handler = new RoutingHandler(request =>
        {
            var uri = request.RequestUri!;
            if (uri.AbsolutePath == "/api/v1/user")
            {
                return Page(new { id = 44, jellyfinUserId = user.Id.ToString() });
            }

            if (uri.AbsolutePath.EndsWith("/watchlist", StringComparison.Ordinal))
            {
                return Page(new { tmdbId = 404, mediaType = "movie" });
            }

            throw new Xunit.Sdk.XunitException($"Unexpected request {request.Method} {uri}.");
        });
        var libraryQueries = 0;
        var library = new CountingLibraryManager
        {
            GetItemListHook = _ =>
            {
                libraryQueries++;
                return Array.Empty<BaseItem>();
            },
        };
        var controller = BuildController(
            user,
            handler,
            library,
            new StubUserDataManager(),
            "HTTP://SEERR:80/, http://seerr/",
            addRequests: false);

        var result = await controller.SyncSeerrWatchlist();

        Assert.IsType<OkObjectResult>(result);
        Assert.Equal(1, libraryQueries);
        Assert.Equal(4, handler.Requests.Count(request => request.Uri.AbsolutePath == "/api/v1/user"));
        Assert.Equal(2, handler.Requests.Count(request =>
            request.Uri.AbsolutePath.EndsWith("/watchlist", StringComparison.Ordinal)));
        Assert.All(handler.Requests, request => Assert.Equal("seerr", request.Uri.Host));
    }

    [Fact]
    public async Task ConfigurationDisabledDuringWatchlistAwait_DoesNotStartRequestCollection()
    {
        var user = new User("generation-user", "provider", "password-provider");
        var handler = new RoutingHandler(request =>
        {
            if (request.RequestUri!.AbsolutePath == "/api/v1/user")
            {
                return Page(new { id = 44, jellyfinUserId = user.Id.ToString() });
            }

            throw new Xunit.Sdk.XunitException(
                $"Unexpected direct request {request.Method} {request.RequestUri}.");
        });
        var provider = new FakePluginConfigProvider(new PluginConfiguration
        {
            SeerrEnabled = true,
            SyncSeerrWatchlist = true,
            AddRequestedMediaToWatchlist = true,
            SeerrUrls = "http://seerr",
            SeerrApiKey = "key",
        });
        var seerr = new BlockingWatchlistClient();
        var controller = BuildController(
            user,
            handler,
            new CountingLibraryManager(),
            new StubUserDataManager(),
            "http://seerr",
            addRequests: true,
            provider,
            seerr);

        var syncTask = controller.SyncSeerrWatchlist();
        await seerr.WatchlistStarted.WaitAsync(TimeSpan.FromSeconds(5));

        provider.Current!.SeerrEnabled = false;
        seerr.ReleaseWatchlist();

        var conflict = Assert.IsType<ConflictObjectResult>(
            await syncTask.WaitAsync(TimeSpan.FromSeconds(5)));
        var body = JsonSerializer.SerializeToElement(conflict.Value);
        Assert.Equal("sync_configuration_changed", body.GetProperty("code").GetString());
        Assert.Equal(0, seerr.RequestCalls);
    }

    [Fact]
    public async Task ConfigurationDisabledByFirstLocalSave_StopsRemainingItemMutations()
    {
        var user = new User("commit-generation-user", "provider", "password-provider");
        var firstMovie = MovieWithTmdbId(501);
        var secondMovie = MovieWithTmdbId(502);
        var handler = new RoutingHandler(request =>
        {
            var uri = request.RequestUri!;
            if (uri.AbsolutePath == "/api/v1/user")
            {
                return Page(new { id = 44, jellyfinUserId = user.Id.ToString() });
            }

            if (uri.AbsolutePath == "/api/v1/user/44/watchlist")
            {
                return Page(
                    new { tmdbId = 501, mediaType = "movie" },
                    new { tmdbId = 502, mediaType = "movie" });
            }

            throw new Xunit.Sdk.XunitException($"Unexpected request {request.Method} {uri}.");
        });
        var provider = new FakePluginConfigProvider(new PluginConfiguration
        {
            SeerrEnabled = true,
            SyncSeerrWatchlist = true,
            AddRequestedMediaToWatchlist = false,
            SeerrUrls = "http://seerr",
            SeerrApiKey = "key",
        });
        var saveCalls = 0;
        var userData = new StubUserDataManager
        {
            GetUserDataHook = (_, item) => new UserItemData
            {
                Key = item.Id.ToString("N"),
                Likes = false,
            },
            SaveUserDataHook = (_, _, _, _, _) =>
            {
                if (Interlocked.Increment(ref saveCalls) == 1)
                {
                    provider.Current!.SeerrEnabled = false;
                }
            },
        };
        var library = new CountingLibraryManager
        {
            GetItemListHook = _ => new BaseItem[] { firstMovie, secondMovie },
        };
        var controller = BuildController(
            user,
            handler,
            library,
            userData,
            "http://seerr",
            addRequests: false,
            provider);

        var conflict = Assert.IsType<ConflictObjectResult>(
            await controller.SyncSeerrWatchlist());

        Assert.Equal(1, Volatile.Read(ref saveCalls));
        var body = JsonSerializer.SerializeToElement(conflict.Value);
        Assert.Equal("sync_configuration_changed", body.GetProperty("code").GetString());
    }

    private static SeerrUserController BuildController(
        User user,
        RoutingHandler handler,
        CountingLibraryManager library,
        StubUserDataManager userData,
        string seerrUrls,
        bool addRequests,
        FakePluginConfigProvider? provider = null,
        ISeerrClient? seerrOverride = null)
    {
        var config = provider?.ConfigurationOrNull ?? new PluginConfiguration
        {
            SeerrEnabled = true,
            SyncSeerrWatchlist = true,
            AddRequestedMediaToWatchlist = addRequests,
            SeerrUrls = seerrUrls,
            SeerrApiKey = "key",
        };
        provider ??= new FakePluginConfigProvider(config);
        var users = new StubUserManager(user);
        var factory = new RecordingHttpClientFactory(handler);
        var cache = new SeerrCache(provider);
        var seerr = seerrOverride ?? new SeerrClient(
            factory,
            NullLogger<SeerrClient>.Instance,
            users,
            cache,
            provider,
            parentalFilter: null!);
        var controller = new SeerrUserController(
            factory,
            NullLogger<SeerrUserController>.Instance,
            users,
            cache,
            provider,
            userData,
            library,
            seerr)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext(),
            },
        };
        return controller;
    }

    private static Movie MovieWithTmdbId(int tmdbId)
        => new()
        {
            Name = $"Movie {tmdbId}",
            ProviderIds = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["Tmdb"] = tmdbId.ToString(System.Globalization.CultureInfo.InvariantCulture),
            },
        };

    private static HttpResponseMessage Page(params object[] rows)
        => Json(new
        {
            results = rows,
            pageInfo = new { page = 1, pages = 1, results = rows.Length },
        });

    private static HttpResponseMessage Json(object body, HttpStatusCode status = HttpStatusCode.OK)
        => new(status)
        {
            Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json"),
        };

    private sealed record CapturedRequest(HttpMethod Method, Uri Uri);

    private sealed class RoutingHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, HttpResponseMessage> _route;

        public RoutingHandler(Func<HttpRequestMessage, HttpResponseMessage> route)
            => _route = route;

        public List<CapturedRequest> Requests { get; } = new();

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Requests.Add(new CapturedRequest(request.Method, request.RequestUri!));
            return Task.FromResult(_route(request));
        }
    }

    private sealed class BlockingWatchlistClient : ISeerrClient
    {
        private readonly TaskCompletionSource _watchlistStarted =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _releaseWatchlist =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Task WatchlistStarted => _watchlistStarted.Task;

        public int RequestCalls { get; private set; }

        public void ReleaseWatchlist() => _releaseWatchlist.TrySetResult();

        public Task<SeerrUser?> GetSeerrUser(
            string jellyfinUserId,
            bool bypassCache = false,
            bool allowAutoImport = true)
            => throw new NotImplementedException();

        public Task<string?> GetSeerrUserId(string jellyfinUserId, bool allowAutoImport = true)
            => throw new NotImplementedException();

        public bool IsImportBlocked(string jellyfinUserId, PluginConfiguration config) => false;

        public Task<bool> GetStatusActiveAsync() => throw new NotImplementedException();

        public Task<Seerr4kCapability> GetSeerr4kCapabilityAsync(
            string jellyfinUserId,
            bool isAdmin = false)
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

        public async Task<List<WatchlistItem>?> GetWatchlistForUser(string seerrUserId)
        {
            _watchlistStarted.TrySetResult();
            await _releaseWatchlist.Task;
            return new List<WatchlistItem>();
        }

        public Task<List<WatchlistItem>?> GetRequestsForUser(string seerrUserId)
        {
            RequestCalls++;
            return Task.FromResult<List<WatchlistItem>?>(new List<WatchlistItem>());
        }
    }
}
