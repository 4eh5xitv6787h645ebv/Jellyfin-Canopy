using System.Net;
using System.Text;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.ScheduledTasks;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.ScheduledTasks;

public sealed class SeerrScheduledTaskPaginationTests
{
    [Fact]
    public async Task BothWatchlistTasks_ProcessBindingFoundOnlyOnLaterIdentityDomain()
    {
        const string firstUserId = "11111111-1111-1111-1111-111111111111";
        const string secondUserId = "22222222-2222-2222-2222-222222222222";
        var readers = new Func<HttpClient, CancellationToken, Task<SeerrMultiSourceCollectionResult>>[]
        {
            static (client, token) => SeerrWatchlistSyncTask.FetchSeerrUserMapSnapshotsAsync(
                client,
                new[] { "http://first", "http://second" },
                "key",
                SeerrDispatchFenceTestFactory.Create(),
                token),
            static (client, token) => JellyfinToSeerrWatchlistSyncTask.FetchSeerrUserMapSnapshotsAsync(
                client,
                new[] { "http://first", "http://second" },
                "key",
                SeerrDispatchFenceTestFactory.Create(),
                token),
        };

        foreach (var read in readers)
        {
            var handler = new RoutingHandler(uri => Json(new
            {
                results = uri.Host == "first"
                    ? new[] { new { id = 1, jellyfinUserId = firstUserId } }
                    : new[] { new { id = 27, jellyfinUserId = $"  {{{secondUserId}}}  " } },
                pageInfo = new { page = 1, pages = 1, results = 1 },
            }));
            using var client = new HttpClient(handler);

            var result = await read(client, CancellationToken.None);

            Assert.True(result.IsComplete, result.FailureReason);
            Assert.True(SeerrUserIdentityDomains.TryParse(result, out var domains));
            var bindings = SeerrUserIdentityDomains.FindBindings(
                domains,
                secondUserId.Replace("-", string.Empty, StringComparison.Ordinal).ToUpperInvariant());
            var binding = Assert.Single(bindings);
            Assert.Equal("http://second", binding.SourceUrl);
            Assert.Equal("27", binding.SeerrUserId);
            Assert.Equal(
                new[] { "first", "first", "second", "second" },
                handler.Requests.Select(static uri => uri.Host));
        }
    }

    [Fact]
    public async Task UserIdentityDomains_RejectNonGuidLinkedIdentity()
    {
        var handler = new RoutingHandler(_ => Json(new
        {
            results = new[] { new { id = 1, jellyfinUserId = "not-a-guid" } },
            pageInfo = new { page = 1, pages = 1, results = 1 },
        }));
        using var client = new HttpClient(handler);

        var snapshots = await SeerrWatchlistSyncTask.FetchSeerrUserMapSnapshotsAsync(
            client,
            new[] { "http://first" },
            "key",
            SeerrDispatchFenceTestFactory.Create(),
            CancellationToken.None);

        Assert.True(snapshots.IsComplete, snapshots.FailureReason);
        Assert.False(SeerrUserIdentityDomains.TryParse(snapshots, out _));
    }

    [Fact]
    public async Task BothWatchlistTasks_LaterIdentityDomainFailureExposesNoEarlierUserMap()
    {
        var readers = new Func<HttpClient, CancellationToken, Task<SeerrMultiSourceCollectionResult>>[]
        {
            static (client, token) => SeerrWatchlistSyncTask.FetchSeerrUserMapSnapshotsAsync(
                client,
                new[] { "http://first", "http://second" },
                "key",
                SeerrDispatchFenceTestFactory.Create(),
                token),
            static (client, token) => JellyfinToSeerrWatchlistSyncTask.FetchSeerrUserMapSnapshotsAsync(
                client,
                new[] { "http://first", "http://second" },
                "key",
                SeerrDispatchFenceTestFactory.Create(),
                token),
        };

        foreach (var read in readers)
        {
            var handler = new RoutingHandler(uri => uri.Host == "second"
                ? Json(new { error = true }, HttpStatusCode.BadGateway)
                : Json(new
                {
                    results = new[] { new { id = 1, jellyfinUserId = "abcd-1234" } },
                    pageInfo = new { page = 1, pages = 1, results = 1 },
                }));
            using var client = new HttpClient(handler);

            var result = await read(client, CancellationToken.None);

            Assert.False(result.IsComplete);
            Assert.Empty(result.Sources);
            Assert.Equal("http://second", result.FailedSourceUrl);
            Assert.Equal(
                new[] { "first", "first", "second" },
                handler.Requests.Select(static uri => uri.Host));
        }
    }

    [Fact]
    public async Task JellyfinToSeerrTask_LaterUsersSourceFailureSendsNoEarlierMutation()
    {
        var firstUser = new User("first-user", "provider", "password-provider");
        var secondUser = new User("second-user", "provider", "password-provider");
        var movie = new Movie
        {
            Name = "Staged movie",
            ProviderIds = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["Tmdb"] = "101",
            },
        };
        var handler = new RequestRoutingHandler(request =>
        {
            var uri = request.RequestUri!;
            if (request.Method == HttpMethod.Get && uri.AbsolutePath == "/api/v1/user")
            {
                var user = uri.Host == "first"
                    ? new { id = 1, jellyfinUserId = firstUser.Id.ToString() }
                    : new { id = 2, jellyfinUserId = secondUser.Id.ToString() };
                return Json(new
                {
                    results = new[] { user },
                    pageInfo = new { page = 1, pages = 1, results = 1 },
                });
            }

            if (request.Method == HttpMethod.Get && uri.AbsolutePath.EndsWith("/watchlist", StringComparison.Ordinal))
            {
                return uri.Host == "second"
                    ? Json(new { error = true }, HttpStatusCode.BadGateway)
                    : Json(new
                    {
                        page = 1,
                        totalPages = 1,
                        totalResults = 0,
                        results = Array.Empty<object>(),
                    });
            }

            if (request.Method == HttpMethod.Post)
            {
                return Json(new { id = 1 });
            }

            throw new Xunit.Sdk.XunitException($"Unexpected request {request.Method} {uri}.");
        });
        var libraryManager = new CountingLibraryManager
        {
            GetItemListHook = query => query.IncludeItemTypes.Contains(Jellyfin.Data.Enums.BaseItemKind.Movie)
                ? new BaseItem[] { movie }
                : Array.Empty<BaseItem>(),
        };
        var userDataManager = new StubUserDataManager
        {
            GetUserDataHook = (_, item) => new UserItemData { Key = item.Id.ToString("N"), Likes = true },
        };
        var configProvider = new FakePluginConfigProvider(new PluginConfiguration
        {
            SeerrEnabled = true,
            SyncJellyfinWatchlistToSeerr = true,
            SeerrUrls = "http://first,http://second",
            SeerrApiKey = "key",
        });
        var task = new JellyfinToSeerrWatchlistSyncTask(
            libraryManager,
            new StubUserManager(firstUser, secondUser),
            userDataManager,
            new RecordingHttpClientFactory(handler),
            userConfigurationManager: null!,
            NullLogger<JellyfinToSeerrWatchlistSyncTask>.Instance,
            configProvider);

        await task.ExecuteAsync(new Progress<double>(), CancellationToken.None);

        Assert.DoesNotContain(handler.Requests, request => request.Method == HttpMethod.Post);
        Assert.Equal(
            new[] { "first", "first", "second", "second", "first", "first", "second" },
            handler.Requests.Select(request => request.Uri.Host));
    }

    [Fact]
    public async Task JellyfinToSeerrTask_DisabledDuringFirstWatchlistSend_DoesNotDispatchLaterTraffic()
    {
        var user = new User("generation-user", "provider", "password-provider");
        var provider = new FakePluginConfigProvider(OutboundConfig());
        var watchlistStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseWatchlist = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var handler = new AsyncRequestRoutingHandler(async (request, cancellationToken) =>
        {
            var uri = request.RequestUri!;
            if (uri.AbsolutePath == "/api/v1/user")
            {
                return UserMap(user, 7);
            }

            if (uri.AbsolutePath == "/api/v1/user/7/watchlist")
            {
                watchlistStarted.TrySetResult();
                await releaseWatchlist.Task.WaitAsync(cancellationToken);
                return EmptyWatchlist();
            }

            if (request.Method == HttpMethod.Post)
            {
                return Json(new { id = 1 });
            }

            throw new Xunit.Sdk.XunitException($"Unexpected request {request.Method} {uri}.");
        });
        var task = CreateOutboundTask(
            user,
            new[] { MovieWithTmdbId("Generation movie", "101") },
            handler,
            provider);

        var executeTask = task.ExecuteAsync(new Progress<double>(), CancellationToken.None);
        await watchlistStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));

        provider.Current!.SeerrEnabled = false;
        releaseWatchlist.TrySetResult();

        await executeTask.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Single(handler.Requests, request =>
            request.Uri.AbsolutePath == "/api/v1/user/7/watchlist");
        Assert.DoesNotContain(handler.Requests, request => request.Method == HttpMethod.Post);
    }

    [Fact]
    public async Task SeerrToJellyfinTask_DisabledDuringFirstWatchlistSend_DoesNotDispatchRequestCollection()
    {
        var user = new User("generation-user", "provider", "password-provider");
        var provider = new FakePluginConfigProvider(new PluginConfiguration
        {
            SeerrEnabled = true,
            SyncSeerrWatchlist = true,
            AddRequestedMediaToWatchlist = true,
            SeerrUrls = "http://only",
            SeerrApiKey = "key",
        });
        var watchlistStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseWatchlist = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var handler = new AsyncRequestRoutingHandler(async (request, cancellationToken) =>
        {
            var uri = request.RequestUri!;
            if (uri.AbsolutePath == "/api/v1/user")
            {
                return UserMap(user, 7);
            }

            if (uri.AbsolutePath == "/api/v1/user/7/watchlist")
            {
                watchlistStarted.TrySetResult();
                await releaseWatchlist.Task.WaitAsync(cancellationToken);
                return EmptyWatchlist();
            }

            if (uri.AbsolutePath == "/api/v1/request")
            {
                return Json(new
                {
                    results = Array.Empty<object>(),
                    pageInfo = new { page = 1, pages = 1, results = 0 },
                });
            }

            throw new Xunit.Sdk.XunitException($"Unexpected request {request.Method} {uri}.");
        });
        var task = new SeerrWatchlistSyncTask(
            new CountingLibraryManager(),
            new StubUserManager(user),
            new StubUserDataManager(),
            new RecordingHttpClientFactory(handler),
            userConfigurationManager: null!,
            NullLogger<SeerrWatchlistSyncTask>.Instance,
            provider);

        var executeTask = task.ExecuteAsync(new Progress<double>(), CancellationToken.None);
        await watchlistStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));

        provider.Current!.SeerrEnabled = false;
        releaseWatchlist.TrySetResult();

        await executeTask.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Single(handler.Requests, request =>
            request.Uri.AbsolutePath == "/api/v1/user/7/watchlist");
        Assert.DoesNotContain(handler.Requests, request =>
            request.Uri.AbsolutePath == "/api/v1/request");
    }

    [Fact]
    public async Task SeerrToJellyfinTask_DisabledByFirstLocalSave_StopsRemainingItemMutations()
    {
        var user = new User("commit-generation-user", "provider", "password-provider");
        var firstMovie = MovieWithTmdbId("First commit movie", "601");
        var secondMovie = MovieWithTmdbId("Second commit movie", "602");
        var handler = new RequestRoutingHandler(request =>
        {
            var uri = request.RequestUri!;
            if (uri.AbsolutePath == "/api/v1/user")
            {
                return UserMap(user, 7);
            }

            if (uri.AbsolutePath == "/api/v1/user/7/watchlist")
            {
                return Json(new
                {
                    page = 1,
                    totalPages = 1,
                    totalResults = 2,
                    results = new[]
                    {
                        new { tmdbId = 601, mediaType = "movie", title = "First commit movie" },
                        new { tmdbId = 602, mediaType = "movie", title = "Second commit movie" },
                    },
                });
            }

            throw new Xunit.Sdk.XunitException($"Unexpected request {request.Method} {uri}.");
        });
        var provider = new FakePluginConfigProvider(new PluginConfiguration
        {
            SeerrEnabled = true,
            SyncSeerrWatchlist = true,
            AddRequestedMediaToWatchlist = false,
            PreventWatchlistReAddition = false,
            SeerrUrls = "http://only",
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
        var task = new SeerrWatchlistSyncTask(
            library,
            new StubUserManager(user),
            userData,
            new RecordingHttpClientFactory(handler),
            userConfigurationManager: null!,
            NullLogger<SeerrWatchlistSyncTask>.Instance,
            provider);

        await task.ExecuteAsync(new Progress<double>(), CancellationToken.None);

        Assert.Equal(1, Volatile.Read(ref saveCalls));
    }

    [Theory]
    [InlineData("not-a-number")]
    [InlineData("2147483648")]
    [InlineData("0")]
    [InlineData("-1")]
    public async Task JellyfinToSeerrTask_ValidFirstInvalidLaterTmdbIdSendsNoMutation(
        string invalidTmdbId)
    {
        var user = new User("linked-user", "provider", "password-provider");
        var validMovie = new Movie
        {
            Name = "Valid first movie",
            ProviderIds = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["Tmdb"] = "101",
            },
        };
        var invalidMovie = new Movie
        {
            Name = "Invalid later movie",
            ProviderIds = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["Tmdb"] = invalidTmdbId,
            },
        };
        var handler = new RequestRoutingHandler(request =>
        {
            var uri = request.RequestUri!;
            if (request.Method == HttpMethod.Get && uri.AbsolutePath == "/api/v1/user")
            {
                return Json(new
                {
                    results = new[] { new { id = 1, jellyfinUserId = user.Id.ToString() } },
                    pageInfo = new { page = 1, pages = 1, results = 1 },
                });
            }

            if (request.Method == HttpMethod.Get
                && uri.AbsolutePath.EndsWith("/watchlist", StringComparison.Ordinal))
            {
                return Json(new
                {
                    page = 1,
                    totalPages = 1,
                    totalResults = 0,
                    results = Array.Empty<object>(),
                });
            }

            if (request.Method == HttpMethod.Post)
            {
                return Json(new { id = 1 });
            }

            throw new Xunit.Sdk.XunitException($"Unexpected request {request.Method} {uri}.");
        });
        var libraryManager = new CountingLibraryManager
        {
            GetItemListHook = query => query.IncludeItemTypes.Contains(Jellyfin.Data.Enums.BaseItemKind.Movie)
                ? new BaseItem[] { validMovie, invalidMovie }
                : Array.Empty<BaseItem>(),
        };
        var userDataManager = new StubUserDataManager
        {
            GetUserDataHook = (_, item) => new UserItemData { Key = item.Id.ToString("N"), Likes = true },
        };
        var configProvider = new FakePluginConfigProvider(new PluginConfiguration
        {
            SeerrEnabled = true,
            SyncJellyfinWatchlistToSeerr = true,
            SeerrUrls = "http://only",
            SeerrApiKey = "key",
        });
        var task = new JellyfinToSeerrWatchlistSyncTask(
            libraryManager,
            new StubUserManager(user),
            userDataManager,
            new RecordingHttpClientFactory(handler),
            userConfigurationManager: null!,
            NullLogger<JellyfinToSeerrWatchlistSyncTask>.Instance,
            configProvider);

        await task.ExecuteAsync(new Progress<double>(), CancellationToken.None);

        Assert.DoesNotContain(handler.Requests, request => request.Method == HttpMethod.Post);
    }

    [Fact]
    public async Task JellyfinToSeerrTask_SameSourceRebindBeforePostSendsNoMutation()
    {
        var user = new User("linked-user", "provider", "password-provider");
        var reboundUserId = Guid.NewGuid();
        var movie = MovieWithTmdbId("Staged movie", "101");
        var handler = new RequestRoutingHandler(request =>
        {
            var uri = request.RequestUri!;
            if (request.Method == HttpMethod.Get && uri.AbsolutePath == "/api/v1/user")
            {
                return UserMap(user, 7);
            }

            if (request.Method == HttpMethod.Get && uri.AbsolutePath == "/api/v1/user/7/watchlist")
            {
                return EmptyWatchlist();
            }

            if (request.Method == HttpMethod.Get && uri.AbsolutePath == "/api/v1/user/7")
            {
                return Json(new { id = 7, jellyfinUserId = reboundUserId });
            }

            if (request.Method == HttpMethod.Post)
            {
                return Json(new { id = 1 });
            }

            throw new Xunit.Sdk.XunitException($"Unexpected request {request.Method} {uri}.");
        });
        var configProvider = new FakePluginConfigProvider(OutboundConfig());
        var task = CreateOutboundTask(user, new[] { movie }, handler, configProvider);

        await task.ExecuteAsync(new Progress<double>(), CancellationToken.None);

        Assert.DoesNotContain(handler.Requests, request => request.Method == HttpMethod.Post);
        Assert.Single(handler.Requests, request => request.Uri.AbsolutePath == "/api/v1/user/7");
    }

    [Theory]
    [InlineData("replacement")]
    [InlineData("disabled")]
    [InlineData("key-change")]
    public async Task JellyfinToSeerrTask_ConfigChangeDuringFreshValidationSendsNoMutation(
        string change)
    {
        var user = new User("linked-user", "provider", "password-provider");
        var movie = MovieWithTmdbId("Staged movie", "101");
        var configProvider = new FakePluginConfigProvider(OutboundConfig());
        var handler = new RequestRoutingHandler(request =>
        {
            var uri = request.RequestUri!;
            if (request.Method == HttpMethod.Get && uri.AbsolutePath == "/api/v1/user")
            {
                return UserMap(user, 7);
            }

            if (request.Method == HttpMethod.Get && uri.AbsolutePath == "/api/v1/user/7/watchlist")
            {
                return EmptyWatchlist();
            }

            if (request.Method == HttpMethod.Get && uri.AbsolutePath == "/api/v1/user/7")
            {
                configProvider.Current = change switch
                {
                    "replacement" => OutboundConfig(),
                    "disabled" => OutboundConfig(enabled: false),
                    "key-change" => OutboundConfig(apiKey: "rotated-key"),
                    _ => throw new InvalidOperationException($"Unknown test change {change}."),
                };
                return Json(new { id = 7, jellyfinUserId = user.Id });
            }

            if (request.Method == HttpMethod.Post)
            {
                return Json(new { id = 1 });
            }

            throw new Xunit.Sdk.XunitException($"Unexpected request {request.Method} {uri}.");
        });
        var task = CreateOutboundTask(user, new[] { movie }, handler, configProvider);

        await task.ExecuteAsync(new Progress<double>(), CancellationToken.None);

        Assert.DoesNotContain(handler.Requests, request => request.Method == HttpMethod.Post);
        Assert.Single(handler.Requests, request => request.Uri.AbsolutePath == "/api/v1/user/7");
    }

    [Fact]
    public async Task JellyfinToSeerrTask_DuplicateLocalTmdbRowsAfterAmbiguousFailureSendsOnce()
    {
        var user = new User("linked-user", "provider", "password-provider");
        var firstMovie = MovieWithTmdbId("First local copy", "101");
        var duplicateMovie = MovieWithTmdbId("Duplicate local copy", "101");
        var handler = new RequestRoutingHandler(request =>
        {
            var uri = request.RequestUri!;
            if (request.Method == HttpMethod.Get && uri.AbsolutePath == "/api/v1/user")
            {
                return UserMap(user, 7);
            }

            if (request.Method == HttpMethod.Get && uri.AbsolutePath == "/api/v1/user/7/watchlist")
            {
                return EmptyWatchlist();
            }

            if (request.Method == HttpMethod.Get && uri.AbsolutePath == "/api/v1/user/7")
            {
                return Json(new { id = 7, jellyfinUserId = user.Id });
            }

            if (request.Method == HttpMethod.Post)
            {
                throw new HttpRequestException("The connection dropped after dispatch.");
            }

            throw new Xunit.Sdk.XunitException($"Unexpected request {request.Method} {uri}.");
        });
        var configProvider = new FakePluginConfigProvider(OutboundConfig());
        var task = CreateOutboundTask(
            user,
            new[] { firstMovie, duplicateMovie },
            handler,
            configProvider);

        await task.ExecuteAsync(new Progress<double>(), CancellationToken.None);

        Assert.Single(handler.Requests, request => request.Method == HttpMethod.Post);
        Assert.Single(handler.Requests, request => request.Uri.AbsolutePath == "/api/v1/user/7");
    }

    [Fact]
    public async Task SeerrToJellyfinTask_LaterUsersSourceFailureStartsNoEarlierLocalApply()
    {
        var firstUser = new User("first-user", "provider", "password-provider");
        var secondUser = new User("second-user", "provider", "password-provider");
        var handler = new RequestRoutingHandler(request =>
        {
            var uri = request.RequestUri!;
            if (uri.AbsolutePath == "/api/v1/user")
            {
                var user = uri.Host == "first"
                    ? new { id = 1, jellyfinUserId = firstUser.Id.ToString() }
                    : new { id = 2, jellyfinUserId = secondUser.Id.ToString() };
                return Json(new
                {
                    results = new[] { user },
                    pageInfo = new { page = 1, pages = 1, results = 1 },
                });
            }

            if (uri.AbsolutePath.EndsWith("/watchlist", StringComparison.Ordinal))
            {
                return uri.Host == "second"
                    ? Json(new { error = true }, HttpStatusCode.BadGateway)
                    : Json(new
                    {
                        page = 1,
                        totalPages = 1,
                        totalResults = 1,
                        results = new[] { new { tmdbId = 101, mediaType = "movie", title = "Staged movie" } },
                    });
            }

            throw new Xunit.Sdk.XunitException($"Unexpected request {request.Method} {uri}.");
        });
        var libraryQueries = 0;
        var libraryManager = new CountingLibraryManager
        {
            GetItemListHook = _ =>
            {
                libraryQueries++;
                return Array.Empty<BaseItem>();
            },
        };
        var configProvider = new FakePluginConfigProvider(new PluginConfiguration
        {
            SeerrEnabled = true,
            SyncSeerrWatchlist = true,
            AddRequestedMediaToWatchlist = false,
            PreventWatchlistReAddition = false,
            SeerrUrls = "http://first,http://second",
            SeerrApiKey = "key",
        });
        var task = new SeerrWatchlistSyncTask(
            libraryManager,
            new StubUserManager(firstUser, secondUser),
            new StubUserDataManager(),
            new RecordingHttpClientFactory(handler),
            userConfigurationManager: null!,
            NullLogger<SeerrWatchlistSyncTask>.Instance,
            configProvider);

        await task.ExecuteAsync(new Progress<double>(), CancellationToken.None);

        Assert.Equal(0, libraryQueries);
        Assert.Equal(
            new[] { "first", "first", "second", "second", "first", "first", "second" },
            handler.Requests.Select(request => request.Uri.Host));
    }

    [Fact]
    public async Task BothWatchlistTasks_RejectBoundaryOverlapWithoutPublishingRows()
    {
        var readers = new Func<HttpClient, CancellationToken, Task<SeerrPagedCollectionResult>>[]
        {
            static (client, token) => SeerrWatchlistSyncTask.FetchSeerrWatchlistSnapshotAsync(
                client,
                "http://seerr",
                "7",
                "key",
                SeerrDispatchFenceTestFactory.Create(),
                token),
            static (client, token) => JellyfinToSeerrWatchlistSyncTask.FetchSeerrWatchlistSnapshotAsync(
                client,
                "http://seerr",
                "7",
                "key",
                SeerrDispatchFenceTestFactory.Create(),
                token),
        };

        foreach (var read in readers)
        {
            var handler = new RoutingHandler(uri =>
            {
                var page = QueryInt(uri, "page");
                var rows = page == 1
                    ? Enumerable.Range(1, 20).Select(static id => new { tmdbId = id, mediaType = "movie" }).ToArray()
                    : new[]
                    {
                        new { tmdbId = 20, mediaType = "movie" },
                        new { tmdbId = 21, mediaType = "movie" },
                    };
                return Json(new { page, totalPages = 2, totalResults = 22, results = rows });
            });
            using var client = new HttpClient(handler);

            var result = await read(client, CancellationToken.None);

            Assert.False(result.IsComplete);
            Assert.Empty(result.Items);
            Assert.Contains("repeated", result.FailureReason, StringComparison.OrdinalIgnoreCase);
            Assert.Equal(new[] { 1, 2 }, handler.Requests.Select(uri => QueryInt(uri, "page")));
        }
    }

    [Fact]
    public async Task SeerrToJellyfinRequests_FollowsMetadataBeyondOldFiveHundredRowCap()
    {
        var handler = new RoutingHandler(uri =>
        {
            var skip = QueryInt(uri, "skip");
            var rows = skip == 0
                ? Enumerable.Range(1, 500).Select(static id => new { id }).ToArray()
                : new[] { new { id = 501 } };
            return Json(new
            {
                results = rows,
                pageInfo = new { page = skip == 0 ? 1 : 2, pages = 2, results = 501 },
            });
        });
        using var client = new HttpClient(handler);

        var result = await SeerrWatchlistSyncTask.FetchSeerrRequestSnapshotAsync(
            client,
            "http://seerr",
            "7",
            "key",
            SeerrDispatchFenceTestFactory.Create(),
            CancellationToken.None);

        Assert.True(result.IsComplete, result.FailureReason);
        Assert.Equal(501, result.Items.Count);
        Assert.Equal(501, result.Items[^1].GetProperty("id").GetInt32());
        Assert.Equal(new[] { 0, 500, 0, 500 }, handler.Requests.Select(uri => QueryInt(uri, "skip")));
        Assert.All(handler.Requests, uri => Assert.Equal("7", QueryValue(uri, "requestedBy")));
    }

    [Fact]
    public async Task OutboundUserMap_FailoverRestartsSnapshotAndReportsWinningSource()
    {
        var handler = new RoutingHandler(uri =>
        {
            var skip = QueryInt(uri, "skip");
            if (uri.Host == "first" && skip > 0)
            {
                return Json(new { error = true }, HttpStatusCode.BadGateway);
            }

            var idBase = uri.Host == "first" ? 100 : 200;
            var prefix = uri.Host == "first" ? "a" : "b";
            var page = skip + 1;
            return Json(new
            {
                results = new[] { new { id = idBase + page, jellyfinUserId = $"{prefix}-jf-{page}" } },
                pageInfo = new { page, pages = 2, results = 2 },
            });
        });
        using var client = new HttpClient(handler);

        var result = await JellyfinToSeerrWatchlistSyncTask.FetchSeerrUserMapSnapshotAsync(
            client,
            new[] { "http://first", "http://second" },
            "key",
            SeerrDispatchFenceTestFactory.Create(),
            CancellationToken.None);

        Assert.True(result.IsComplete, result.FailureReason);
        Assert.Equal("http://second", result.SourceUrl);
        Assert.Equal(new[] { 201, 202 }, result.Items.Select(item => item.GetProperty("id").GetInt32()));
        Assert.Equal(
            new[] { "first:0", "first:1", "second:0", "second:1", "second:0", "second:1" },
            handler.Requests.Select(uri => $"{uri.Host}:{QueryInt(uri, "skip")}"));
    }

    [Fact]
    public async Task ScheduledTaskReaders_PropagateCancellationBeforeSending()
    {
        var handler = new RoutingHandler(_ => throw new InvalidOperationException("No request expected."));
        using var client = new HttpClient(handler);
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            SeerrWatchlistSyncTask.FetchSeerrWatchlistSnapshotAsync(
                client,
                "http://seerr",
                "7",
                "key",
                SeerrDispatchFenceTestFactory.Create(),
                cts.Token));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            JellyfinToSeerrWatchlistSyncTask.FetchSeerrWatchlistSnapshotAsync(
                client,
                "http://seerr",
                "7",
                "key",
                SeerrDispatchFenceTestFactory.Create(),
                cts.Token));
        Assert.Empty(handler.Requests);
    }

    [Theory]
    [InlineData("""{ "id": 1, "requestedBy": { "id": "garbage" }, "type": "movie", "media": { "tmdbId": 10, "mediaType": "movie" } }""")]
    [InlineData("""{ "id": 1, "requestedBy": { "id": 7 }, "type": "movie", "media": { "tmdbId": -10, "mediaType": "movie" } }""")]
    [InlineData("""{ "id": 1, "requestedBy": { "id": 7 }, "type": "movie", "tmdbId": 11, "media": { "tmdbId": 10, "mediaType": "movie" } }""")]
    [InlineData("""{ "id": 1, "requestedBy": { "id": 7 }, "type": "movie", "mediaId": 10 }""")]
    public void SeerrToJellyfinRequestProjection_RejectsMalformedOwnerOrTmdbId(string rowJson)
    {
        using var document = JsonDocument.Parse($"{{\"results\":[{rowJson}]}}");
        var rows = document.RootElement.GetProperty("results").EnumerateArray().ToArray();

        Assert.False(SeerrWatchlistSyncTask.HasCompleteValidRequestProjection(rows, "7"));
    }

    [Fact]
    public void SeerrToJellyfinRequestProjection_AcceptsPositiveNumericStringOwnerAndTmdbId()
    {
        using var document = JsonDocument.Parse(
            """{ "results": [{ "id": 1, "requestedBy": { "id": "7" }, "type": "movie", "media": { "tmdbId": "10", "mediaType": "movie" } }] }""");
        var rows = document.RootElement.GetProperty("results").EnumerateArray().ToArray();

        Assert.True(SeerrWatchlistSyncTask.HasCompleteValidRequestProjection(rows, "7"));
    }

    [Fact]
    public void SeerrToJellyfinRequestProjection_DropsWellFormedForeignRowsLocally()
    {
        using var document = JsonDocument.Parse(
            """
            { "results": [
                { "id": 1, "requestedBy": { "id": 7 }, "type": "movie", "media": { "tmdbId": 10, "mediaType": "movie" } },
                { "id": 2, "requestedBy": { "id": 99 }, "type": "movie", "media": { "tmdbId": 11, "mediaType": "movie" } }
            ] }
            """);
        var rows = document.RootElement.GetProperty("results").EnumerateArray().ToArray();

        Assert.Equal(1, SeerrWatchlistSyncTask.CountCompleteValidRequestProjection(rows, "7"));
    }

    private static int QueryInt(Uri uri, string name)
    {
        foreach (var pair in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = pair.Split('=', 2);
            if (parts.Length == 2 && string.Equals(parts[0], name, StringComparison.Ordinal))
            {
                return int.Parse(parts[1], System.Globalization.CultureInfo.InvariantCulture);
            }
        }

        throw new InvalidOperationException($"Query parameter '{name}' was missing from {uri}.");
    }

    private static string? QueryValue(Uri uri, string name)
    {
        foreach (var pair in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = pair.Split('=', 2);
            if (parts.Length == 2 && string.Equals(parts[0], name, StringComparison.Ordinal))
            {
                return Uri.UnescapeDataString(parts[1]);
            }
        }

        return null;
    }

    private static PluginConfiguration OutboundConfig(
        bool enabled = true,
        string apiKey = "key")
        => new()
        {
            SeerrEnabled = enabled,
            SyncJellyfinWatchlistToSeerr = true,
            SeerrUrls = "http://only",
            SeerrApiKey = apiKey,
        };

    private static Movie MovieWithTmdbId(string name, string tmdbId)
        => new()
        {
            Name = name,
            ProviderIds = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["Tmdb"] = tmdbId,
            },
        };

    private static HttpResponseMessage UserMap(User user, int seerrUserId)
        => Json(new
        {
            results = new[] { new { id = seerrUserId, jellyfinUserId = user.Id } },
            pageInfo = new { page = 1, pages = 1, results = 1 },
        });

    private static HttpResponseMessage EmptyWatchlist()
        => Json(new
        {
            page = 1,
            totalPages = 1,
            totalResults = 0,
            results = Array.Empty<object>(),
        });

    private static JellyfinToSeerrWatchlistSyncTask CreateOutboundTask(
        User user,
        IReadOnlyList<Movie> movies,
        HttpMessageHandler handler,
        FakePluginConfigProvider configProvider)
    {
        var libraryManager = new CountingLibraryManager
        {
            GetItemListHook = query => query.IncludeItemTypes.Contains(Jellyfin.Data.Enums.BaseItemKind.Movie)
                ? movies.Cast<BaseItem>().ToArray()
                : Array.Empty<BaseItem>(),
        };
        var userDataManager = new StubUserDataManager
        {
            GetUserDataHook = (_, item) => new UserItemData
            {
                Key = item.Id.ToString("N"),
                Likes = true,
            },
        };

        return new JellyfinToSeerrWatchlistSyncTask(
            libraryManager,
            new StubUserManager(user),
            userDataManager,
            new RecordingHttpClientFactory(handler),
            userConfigurationManager: null!,
            NullLogger<JellyfinToSeerrWatchlistSyncTask>.Instance,
            configProvider);
    }

    private static HttpResponseMessage Json(object body, HttpStatusCode status = HttpStatusCode.OK)
        => new(status)
        {
            Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json"),
        };

    private sealed class RoutingHandler : HttpMessageHandler
    {
        private readonly Func<Uri, HttpResponseMessage> _route;

        public RoutingHandler(Func<Uri, HttpResponseMessage> route) => _route = route;

        public List<Uri> Requests { get; } = new();

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Requests.Add(request.RequestUri!);
            return Task.FromResult(_route(request.RequestUri!));
        }
    }

    private sealed record CapturedRequest(HttpMethod Method, Uri Uri);

    private sealed class RequestRoutingHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, HttpResponseMessage> _route;

        public RequestRoutingHandler(Func<HttpRequestMessage, HttpResponseMessage> route) => _route = route;

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

    private sealed class AsyncRequestRoutingHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> _route;

        public AsyncRequestRoutingHandler(
            Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> route)
            => _route = route;

        public List<CapturedRequest> Requests { get; } = new();

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Requests.Add(new CapturedRequest(request.Method, request.RequestUri!));
            return _route(request, cancellationToken);
        }
    }
}
