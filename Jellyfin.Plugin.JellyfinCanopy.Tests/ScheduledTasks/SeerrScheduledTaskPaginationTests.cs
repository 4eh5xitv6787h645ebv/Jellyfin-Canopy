using System.Net;
using System.Text;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.ScheduledTasks;
using Jellyfin.Plugin.JellyfinCanopy.Services;
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
            Id = Guid.NewGuid(),
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
            configProvider,
            new StubItemLookupService());

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
            provider,
            new StubItemLookupService());

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
            provider,
            StubItemLookupService.FromItems(new BaseItem[] { firstMovie, secondMovie }));

        await task.ExecuteAsync(new Progress<double>(), CancellationToken.None);

        Assert.Equal(1, Volatile.Read(ref saveCalls));
    }

    [Fact]
    public async Task SeerrToJellyfinTask_InaccessibleFirstUsesAccessibleAlternate()
    {
        var user = new User("alternate-sync-user", "provider", "password-provider");
        var inaccessible = MovieWithTmdbId("Restricted cut", "701");
        inaccessible.Id = Guid.Parse("00000000-0000-0000-0000-000000000021");
        var accessible = MovieWithTmdbId("Accessible cut", "701");
        accessible.Id = Guid.Parse("00000000-0000-0000-0000-000000000022");
        var items = new BaseItem[] { inaccessible, accessible };
        var handler = new RequestRoutingHandler(request => request.RequestUri!.AbsolutePath switch
        {
            "/api/v1/user" => UserMap(user, 7),
            "/api/v1/user/7/watchlist" => Json(new
            {
                page = 1,
                totalPages = 1,
                totalResults = 1,
                results = new[]
                {
                    new { tmdbId = 701, mediaType = "movie", title = "Alternate cut" },
                },
            }),
            var path => throw new Xunit.Sdk.XunitException($"Unexpected path {path}."),
        });
        BaseItem? savedItem = null;
        var userData = new StubUserDataManager
        {
            GetUserDataHook = (_, item) => new UserItemData
            {
                Key = item.Id.ToString("N"),
                Likes = false,
            },
            SaveUserDataHook = (_, item, _, _, _) => savedItem = item,
        };
        var library = new CountingLibraryManager
        {
            GetItemListHook = _ => items,
        };
        var lookup = StubItemLookupService.FromItems(
            items,
            (ids, _) => ids.Where(id => id == accessible.Id).ToHashSet());
        var task = new SeerrWatchlistSyncTask(
            library,
            new StubUserManager(user),
            userData,
            new RecordingHttpClientFactory(handler),
            userConfigurationManager: null!,
            NullLogger<SeerrWatchlistSyncTask>.Instance,
            new FakePluginConfigProvider(new PluginConfiguration
            {
                SeerrEnabled = true,
                SyncSeerrWatchlist = true,
                AddRequestedMediaToWatchlist = false,
                PreventWatchlistReAddition = false,
                SeerrUrls = "http://only",
                SeerrApiKey = "key",
            }),
            lookup);

        await task.ExecuteAsync(new Progress<double>(), CancellationToken.None);

        Assert.Equal(2, lookup.ProviderQueryCount);
        Assert.Equal(3, lookup.AccessQueryCount);
        Assert.Equal(1, userData.GetUserDataBatchCallCount);
        Assert.Equal(0, userData.GetUserDataCallCount);
        Assert.Same(accessible, savedItem);
    }

    [Fact]
    public async Task SeerrToJellyfinTask_AccessRevokedDuringOwnershipProofDoesNotSave()
    {
        var user = new User("revoked-sync-user", "provider", "password-provider");
        var movie = MovieWithTmdbId("Revoked movie", "702");
        var handler = new RequestRoutingHandler(request => request.RequestUri!.AbsolutePath switch
        {
            "/api/v1/user" => UserMap(user, 7),
            "/api/v1/user/7/watchlist" => Json(new
            {
                page = 1,
                totalPages = 1,
                totalResults = 1,
                results = new[]
                {
                    new { tmdbId = 702, mediaType = "movie", title = "Revoked movie" },
                },
            }),
            var path => throw new Xunit.Sdk.XunitException($"Unexpected path {path}."),
        });
        var accessReads = 0;
        var lookup = StubItemLookupService.FromItems(
            new BaseItem[] { movie },
            (ids, _) => Interlocked.Increment(ref accessReads) == 1
                ? ids.ToHashSet()
                : new HashSet<Guid>());
        var saveCalls = 0;
        var task = new SeerrWatchlistSyncTask(
            new CountingLibraryManager
            {
                GetItemListHook = _ => new BaseItem[] { movie },
            },
            new StubUserManager(user),
            new StubUserDataManager
            {
                GetUserDataHook = (_, item) => new UserItemData
                {
                    Key = item.Id.ToString("N"),
                    Likes = false,
                },
                SaveUserDataHook = (_, _, _, _, _) => Interlocked.Increment(ref saveCalls),
            },
            new RecordingHttpClientFactory(handler),
            userConfigurationManager: null!,
            NullLogger<SeerrWatchlistSyncTask>.Instance,
            new FakePluginConfigProvider(new PluginConfiguration
            {
                SeerrEnabled = true,
                SyncSeerrWatchlist = true,
                AddRequestedMediaToWatchlist = false,
                PreventWatchlistReAddition = false,
                SeerrUrls = "http://only",
                SeerrApiKey = "key",
            }),
            lookup);

        await task.ExecuteAsync(new Progress<double>(), CancellationToken.None);

        Assert.Equal(2, accessReads);
        Assert.Equal(0, saveCalls);
    }

    [Fact]
    public async Task SeerrToJellyfinTask_FirstUsersSaveRevokesSecondUsersAccess()
    {
        var firstUser = new User("first-revocation-user", "provider", "password-provider");
        var secondUser = new User("second-revocation-user", "provider", "password-provider");
        var movie = MovieWithTmdbId("Shared movie", "703");
        var handler = new RequestRoutingHandler(request => request.RequestUri!.AbsolutePath switch
        {
            "/api/v1/user" => Json(new
            {
                results = new[]
                {
                    new { id = 7, jellyfinUserId = firstUser.Id },
                    new { id = 8, jellyfinUserId = secondUser.Id },
                },
                pageInfo = new { page = 1, pages = 1, results = 2 },
            }),
            "/api/v1/user/7/watchlist" or "/api/v1/user/8/watchlist" => Json(new
            {
                page = 1,
                totalPages = 1,
                totalResults = 1,
                results = new[]
                {
                    new { tmdbId = 703, mediaType = "movie", title = "Shared movie" },
                },
            }),
            var path => throw new Xunit.Sdk.XunitException($"Unexpected path {path}."),
        });
        var secondUserRevoked = false;
        var lookup = StubItemLookupService.FromItems(
            new BaseItem[] { movie },
            (ids, user) => user.Id == secondUser.Id && secondUserRevoked
                ? new HashSet<Guid>()
                : ids.ToHashSet());
        var savedUsers = new List<Guid>();
        var userData = new StubUserDataManager
        {
            GetUserDataHook = (_, item) => new UserItemData
            {
                Key = item.Id.ToString("N"),
                Likes = false,
            },
            SaveUserDataHook = (user, _, _, _, _) =>
            {
                savedUsers.Add(user.Id);
                secondUserRevoked = true;
            },
        };
        var task = new SeerrWatchlistSyncTask(
            new CountingLibraryManager
            {
                GetItemListHook = _ => new BaseItem[] { movie },
            },
            new StubUserManager(firstUser, secondUser),
            userData,
            new RecordingHttpClientFactory(handler),
            userConfigurationManager: null!,
            NullLogger<SeerrWatchlistSyncTask>.Instance,
            new FakePluginConfigProvider(new PluginConfiguration
            {
                SeerrEnabled = true,
                SyncSeerrWatchlist = true,
                AddRequestedMediaToWatchlist = false,
                PreventWatchlistReAddition = false,
                SeerrUrls = "http://only",
                SeerrApiKey = "key",
            }),
            lookup);

        await task.ExecuteAsync(new Progress<double>(), CancellationToken.None);

        Assert.Equal(new[] { firstUser.Id }, savedUsers);
        Assert.Equal(2, lookup.ProviderQueryCount);
        Assert.Equal(6, lookup.AccessQueryCount);
    }

    [Fact]
    public async Task SeerrToJellyfinTask_AlreadyLikedEditionDoesNotLikeAnotherCut()
    {
        var user = new User("existing-cut-user", "provider", "password-provider");
        var unlikedEdition = MovieWithTmdbId("Unliked cut", "704");
        unlikedEdition.Id = Guid.Parse("00000000-0000-0000-0000-000000000023");
        var likedEdition = MovieWithTmdbId("Liked cut", "704");
        likedEdition.Id = Guid.Parse("00000000-0000-0000-0000-000000000024");
        var items = new BaseItem[] { unlikedEdition, likedEdition };
        var handler = new RequestRoutingHandler(request => request.RequestUri!.AbsolutePath switch
        {
            "/api/v1/user" => UserMap(user, 7),
            "/api/v1/user/7/watchlist" => Json(new
            {
                page = 1,
                totalPages = 1,
                totalResults = 1,
                results = new[]
                {
                    new { tmdbId = 704, mediaType = "movie", title = "Existing cut" },
                },
            }),
            var path => throw new Xunit.Sdk.XunitException($"Unexpected path {path}."),
        });
        var saveCount = 0;
        var userData = new StubUserDataManager
        {
            GetUserDataBatchHook = (accessibleItems, _) => accessibleItems.ToDictionary(
                static item => item.Id,
                item => new UserItemData
                {
                    Key = item.Id.ToString("N"),
                    Likes = item.Id == likedEdition.Id,
                }),
            SaveUserDataHook = (_, _, _, _, _) => saveCount++,
        };
        var lookup = StubItemLookupService.FromItems(items);
        var task = new SeerrWatchlistSyncTask(
            new CountingLibraryManager
            {
                GetItemListHook = _ => items,
            },
            new StubUserManager(user),
            userData,
            new RecordingHttpClientFactory(handler),
            userConfigurationManager: null!,
            NullLogger<SeerrWatchlistSyncTask>.Instance,
            new FakePluginConfigProvider(new PluginConfiguration
            {
                SeerrEnabled = true,
                SyncSeerrWatchlist = true,
                AddRequestedMediaToWatchlist = false,
                PreventWatchlistReAddition = false,
                SeerrUrls = "http://only",
                SeerrApiKey = "key",
            }),
            lookup);

        await task.ExecuteAsync(new Progress<double>(), CancellationToken.None);

        Assert.Equal(0, saveCount);
        Assert.Equal(1, userData.GetUserDataBatchCallCount);
        Assert.Equal(3, lookup.AccessQueryCount);
    }

    [Fact]
    public async Task SeerrToJellyfinTask_UnlikeAtFinalAccessBarrierSavesBeforeMarker()
    {
        var baseDirectory = Path.Combine(
            Path.GetTempPath(),
            "jc-watchlist-scheduled-live-data-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(baseDirectory);
        try
        {
            var user = new User("scheduled-unlike-user", "provider", "password-provider");
            var movie = MovieWithTmdbId("Scheduled unlike", "705");
            var handler = new RequestRoutingHandler(request => request.RequestUri!.AbsolutePath switch
            {
                "/api/v1/user" => UserMap(user, 7),
                "/api/v1/user/7/watchlist" => Json(new
                {
                    page = 1,
                    totalPages = 1,
                    totalResults = 1,
                    results = new[]
                    {
                        new { tmdbId = 705, mediaType = "movie", title = "Scheduled unlike" },
                    },
                }),
                var path => throw new Xunit.Sdk.XunitException($"Unexpected path {path}."),
            });
            var unliked = false;
            var lookup = StubItemLookupService.FromItems(new BaseItem[] { movie });
            lookup.BeforeAccessQuery = count =>
            {
                if (count == 3)
                {
                    unliked = true;
                }
            };
            var saveCount = 0;
            var userData = new StubUserDataManager
            {
                GetUserDataBatchHook = (items, _) => items.ToDictionary(
                    static item => item.Id,
                    item => new UserItemData
                    {
                        Key = item.Id.ToString("N"),
                        Likes = !unliked,
                    }),
                SaveUserDataHook = (_, _, data, _, _) =>
                {
                    Assert.True(data.Likes);
                    saveCount++;
                },
            };
            var userConfiguration = new UserConfigurationManager(
                new StubAppPaths(baseDirectory),
                NullLogger<UserConfigurationManager>.Instance);
            var task = new SeerrWatchlistSyncTask(
                new CountingLibraryManager
                {
                    GetItemListHook = _ => new BaseItem[] { movie },
                },
                new StubUserManager(user),
                userData,
                new RecordingHttpClientFactory(handler),
                userConfiguration,
                NullLogger<SeerrWatchlistSyncTask>.Instance,
                new FakePluginConfigProvider(new PluginConfiguration
                {
                    SeerrEnabled = true,
                    SyncSeerrWatchlist = true,
                    AddRequestedMediaToWatchlist = false,
                    PreventWatchlistReAddition = true,
                    SeerrUrls = "http://only",
                    SeerrApiKey = "key",
                }),
                lookup);

            await task.ExecuteAsync(new Progress<double>(), CancellationToken.None);

            Assert.True(unliked);
            Assert.Equal(1, saveCount);
            var marker = Assert.Single(
                userConfiguration.GetProcessedWatchlistItems(user.Id).Items);
            Assert.Equal("sync", marker.Source);
            Assert.Equal(705, marker.TmdbId);
        }
        finally
        {
            Directory.Delete(baseDirectory, recursive: true);
        }
    }

    [Fact]
    public async Task JellyfinToSeerrTask_ExportsOnlyEachUsersAccessibleLikes()
    {
        var firstUser = new User("first-scope", "provider", "password-provider");
        var secondUser = new User("second-scope", "provider", "password-provider");
        var firstMovie = MovieWithTmdbId("First scope movie", "801");
        firstMovie.Id = Guid.Parse("00000000-0000-0000-0000-000000000031");
        var firstUsersSecondMovie = MovieWithTmdbId("First scope sequel", "803");
        firstUsersSecondMovie.Id = Guid.Parse("00000000-0000-0000-0000-000000000033");
        var secondMovie = MovieWithTmdbId("Second scope movie", "802");
        secondMovie.Id = Guid.Parse("00000000-0000-0000-0000-000000000032");
        var secondUsersSecondMovie = MovieWithTmdbId("Second scope sequel", "804");
        secondUsersSecondMovie.Id = Guid.Parse("00000000-0000-0000-0000-000000000034");
        var movies = new[]
        {
            firstMovie,
            firstUsersSecondMovie,
            secondMovie,
            secondUsersSecondMovie,
        };
        var posts = new List<(string UserId, int TmdbId)>();
        var handler = new RequestRoutingHandler(request =>
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path == "/api/v1/user")
            {
                return Json(new
                {
                    results = new[]
                    {
                        new { id = 7, jellyfinUserId = firstUser.Id },
                        new { id = 8, jellyfinUserId = secondUser.Id },
                    },
                    pageInfo = new { page = 1, pages = 1, results = 2 },
                });
            }

            if (path is "/api/v1/user/7/watchlist" or "/api/v1/user/8/watchlist")
            {
                return EmptyWatchlist();
            }

            if (path == "/api/v1/user/7")
            {
                return Json(new { id = 7, jellyfinUserId = firstUser.Id });
            }

            if (path == "/api/v1/user/8")
            {
                return Json(new { id = 8, jellyfinUserId = secondUser.Id });
            }

            if (request.Method == HttpMethod.Post && path == "/api/v1/watchlist")
            {
                var apiUser = Assert.Single(request.Headers.GetValues("X-Api-User"));
                using var body = JsonDocument.Parse(
                    request.Content!.ReadAsStringAsync().GetAwaiter().GetResult());
                posts.Add((apiUser, body.RootElement.GetProperty("tmdbId").GetInt32()));
                return Json(new { id = 1 });
            }

            throw new Xunit.Sdk.XunitException($"Unexpected request {request.Method} {request.RequestUri}.");
        });
        var lookup = StubItemLookupService.FromItems(
            movies,
            (ids, user) => ids.Where(id => user.Id == firstUser.Id
                    ? id == firstMovie.Id || id == firstUsersSecondMovie.Id
                    : id == secondMovie.Id || id == secondUsersSecondMovie.Id)
                .ToHashSet());
        var library = new CountingLibraryManager
        {
            GetItemListHook = query => query.IncludeItemTypes.Contains(Jellyfin.Data.Enums.BaseItemKind.Movie)
                ? movies.Cast<BaseItem>().ToArray()
                : Array.Empty<BaseItem>(),
        };
        var userData = new StubUserDataManager
        {
            GetUserDataHook = (_, item) => new UserItemData
            {
                Key = item.Id.ToString("N"),
                Likes = true,
            },
        };
        var task = new JellyfinToSeerrWatchlistSyncTask(
            library,
            new StubUserManager(firstUser, secondUser),
            userData,
            new RecordingHttpClientFactory(handler),
            userConfigurationManager: null!,
            NullLogger<JellyfinToSeerrWatchlistSyncTask>.Instance,
            new FakePluginConfigProvider(OutboundConfig()),
            lookup);

        await task.ExecuteAsync(new Progress<double>(), CancellationToken.None);

        Assert.Equal(
            new[] { ("7", 801), ("7", 803), ("8", 802), ("8", 804) },
            posts);
        Assert.Equal(1, lookup.ProviderQueryCount);
        Assert.Equal(8, lookup.AccessQueryCount);
        Assert.Equal(8, userData.GetUserDataBatchCallCount);
        Assert.Equal(0, userData.GetUserDataCallCount);
    }

    [Theory]
    [InlineData("access")]
    [InlineData("like")]
    public async Task JellyfinToSeerrTask_FirstPostRevocationSuppressesSecondPost(
        string revocation)
    {
        var user = new User("late-revocation-user", "provider", "password-provider");
        var firstMovie = MovieWithTmdbId("First late movie", "805");
        firstMovie.Id = Guid.Parse("00000000-0000-0000-0000-000000000035");
        var secondMovie = MovieWithTmdbId("Second late movie", "806");
        secondMovie.Id = Guid.Parse("00000000-0000-0000-0000-000000000036");
        var movies = new[] { firstMovie, secondMovie };
        var revoked = false;
        var posts = new List<int>();
        var handler = new RequestRoutingHandler(request =>
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path == "/api/v1/user") return UserMap(user, 7);
            if (path == "/api/v1/user/7/watchlist") return EmptyWatchlist();
            if (path == "/api/v1/user/7")
            {
                return Json(new { id = 7, jellyfinUserId = user.Id });
            }

            if (request.Method == HttpMethod.Post && path == "/api/v1/watchlist")
            {
                using var body = JsonDocument.Parse(
                    request.Content!.ReadAsStringAsync().GetAwaiter().GetResult());
                posts.Add(body.RootElement.GetProperty("tmdbId").GetInt32());
                revoked = true;
                return Json(new { id = 1 });
            }

            throw new Xunit.Sdk.XunitException($"Unexpected request {request.Method} {request.RequestUri}.");
        });
        var lookup = StubItemLookupService.FromItems(
            movies,
            (ids, _) => ids.Where(id => !(revoked
                    && revocation == "access"
                    && id == secondMovie.Id))
                .ToHashSet());
        var userData = new StubUserDataManager
        {
            GetUserDataHook = (_, item) => new UserItemData
            {
                Key = item.Id.ToString("N"),
                Likes = !(revoked
                    && revocation == "like"
                    && item.Id == secondMovie.Id),
            },
        };
        var task = new JellyfinToSeerrWatchlistSyncTask(
            new CountingLibraryManager
            {
                GetItemListHook = query => query.IncludeItemTypes.Contains(
                        Jellyfin.Data.Enums.BaseItemKind.Movie)
                    ? movies.Cast<BaseItem>().ToArray()
                    : Array.Empty<BaseItem>(),
            },
            new StubUserManager(user),
            userData,
            new RecordingHttpClientFactory(handler),
            userConfigurationManager: null!,
            NullLogger<JellyfinToSeerrWatchlistSyncTask>.Instance,
            new FakePluginConfigProvider(OutboundConfig()),
            lookup);

        await task.ExecuteAsync(new Progress<double>(), CancellationToken.None);

        Assert.Equal(new[] { 805 }, posts);
        Assert.Equal(1, lookup.ProviderQueryCount);
        Assert.Equal(4, lookup.AccessQueryCount);
        Assert.Equal(
            revocation == "access" ? 3 : 4,
            userData.GetUserDataBatchCallCount);
    }

    [Fact]
    public async Task JellyfinToSeerrTask_FirstPostRebindSuppressesSecondPost()
    {
        var user = new User("late-rebind-user", "provider", "password-provider");
        var reboundUserId = Guid.NewGuid();
        var firstMovie = MovieWithTmdbId("First rebind movie", "807");
        firstMovie.Id = Guid.Parse("00000000-0000-0000-0000-000000000037");
        var secondMovie = MovieWithTmdbId("Second rebind movie", "808");
        secondMovie.Id = Guid.Parse("00000000-0000-0000-0000-000000000038");
        var movies = new[] { firstMovie, secondMovie };
        var bindingReads = 0;
        var rebound = false;
        var posts = new List<int>();
        var handler = new RequestRoutingHandler(request =>
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path == "/api/v1/user") return UserMap(user, 7);
            if (path == "/api/v1/user/7/watchlist") return EmptyWatchlist();
            if (path == "/api/v1/user/7")
            {
                bindingReads++;
                return Json(new
                {
                    id = 7,
                    jellyfinUserId = rebound ? reboundUserId : user.Id,
                });
            }

            if (request.Method == HttpMethod.Post && path == "/api/v1/watchlist")
            {
                using var body = JsonDocument.Parse(
                    request.Content!.ReadAsStringAsync().GetAwaiter().GetResult());
                posts.Add(body.RootElement.GetProperty("tmdbId").GetInt32());
                rebound = true;
                return Json(new { id = 1 });
            }

            throw new Xunit.Sdk.XunitException($"Unexpected request {request.Method} {request.RequestUri}.");
        });
        var lookup = StubItemLookupService.FromItems(movies);
        var userData = new StubUserDataManager
        {
            GetUserDataHook = (_, item) => new UserItemData
            {
                Key = item.Id.ToString("N"),
                Likes = true,
            },
        };
        var task = new JellyfinToSeerrWatchlistSyncTask(
            new CountingLibraryManager
            {
                GetItemListHook = query => query.IncludeItemTypes.Contains(
                        Jellyfin.Data.Enums.BaseItemKind.Movie)
                    ? movies.Cast<BaseItem>().ToArray()
                    : Array.Empty<BaseItem>(),
            },
            new StubUserManager(user),
            userData,
            new RecordingHttpClientFactory(handler),
            userConfigurationManager: null!,
            NullLogger<JellyfinToSeerrWatchlistSyncTask>.Instance,
            new FakePluginConfigProvider(OutboundConfig()),
            lookup);

        await task.ExecuteAsync(new Progress<double>(), CancellationToken.None);

        Assert.Equal(new[] { 807 }, posts);
        Assert.Equal(3, bindingReads);
        Assert.Equal(1, lookup.ProviderQueryCount);
        Assert.Equal(3, lookup.AccessQueryCount);
        Assert.Equal(3, userData.GetUserDataBatchCallCount);
        Assert.Equal(0, userData.GetUserDataCallCount);
    }

    [Fact]
    public void JellyfinToSeerrTask_LateAuthorizationBudgetCountsPreflightAndMutationReads()
    {
        Assert.Equal(
            3,
            JellyfinToSeerrWatchlistSyncTask.LateAuthorizationQueriesPerMutation);

        const int exactPreflightBindings = 2;
        var exactMutations = JellyfinToSeerrWatchlistSyncTask.MaximumLateMutationAuthorizations;
        Assert.Equal(
            JellyfinToSeerrWatchlistSyncTask.MaximumLateAuthorizationQueries,
            (exactMutations
                * JellyfinToSeerrWatchlistSyncTask.LateAuthorizationQueriesPerMutation)
                + exactPreflightBindings);
        Assert.True(
            JellyfinToSeerrWatchlistSyncTask.LateAuthorizationBudget.CanFit(
                exactMutations,
                exactPreflightBindings));
        Assert.False(
            JellyfinToSeerrWatchlistSyncTask.LateAuthorizationBudget.CanFit(
                exactMutations,
                exactPreflightBindings + 1));

        var budget = new JellyfinToSeerrWatchlistSyncTask.LateAuthorizationBudget();
        Assert.True(budget.TryReservePreflightBinding());
        Assert.True(budget.TryReservePreflightBinding());
        for (var index = 0; index < exactMutations; index++)
        {
            Assert.True(budget.TryReserveMutation());
        }

        Assert.Equal(
            JellyfinToSeerrWatchlistSyncTask.MaximumLateAuthorizationQueries,
            budget.ReservedQueries);
        Assert.False(budget.TryReservePreflightBinding());
        Assert.False(budget.TryReserveMutation());
    }

    [Theory]
    [InlineData(WatchlistLibraryResolver.MaximumCandidates, true)]
    [InlineData(WatchlistLibraryResolver.MaximumCandidates + 1, false)]
    public async Task JellyfinToSeerrTask_LibrarySnapshotUsesBoundedPagesAtExactLimit(
        int itemCount,
        bool expectedComplete)
    {
        var movie = MovieWithTmdbId("Paged movie", "900");
        var queries = new List<(int Start, int Limit)>();
        var library = new CountingLibraryManager
        {
            GetItemListHook = query =>
            {
                Assert.InRange(
                    query.Limit ?? 0,
                    1,
                    JellyfinToSeerrWatchlistSyncTask.LibraryEnumerationPageSize);
                var start = query.StartIndex ?? 0;
                queries.Add((start, query.Limit!.Value));
                if (!query.IncludeItemTypes.Contains(Jellyfin.Data.Enums.BaseItemKind.Movie)
                    || start >= itemCount)
                {
                    return Array.Empty<BaseItem>();
                }

                var count = Math.Min(query.Limit.Value, itemCount - start);
                return Enumerable.Repeat<BaseItem>(movie, count).ToArray();
            },
        };
        var destination = new List<(BaseItem item, string mediaType)>();

        var complete = await JellyfinToSeerrWatchlistSyncTask.TryCollectLibraryItemsBoundedAsync(
            library,
            destination,
            CancellationToken.None);

        Assert.Equal(expectedComplete, complete);
        Assert.Equal(itemCount, destination.Count);
        Assert.All(
            queries,
            query => Assert.InRange(
                query.Limit,
                1,
                JellyfinToSeerrWatchlistSyncTask.LibraryEnumerationPageSize));
    }

    [Fact]
    public async Task JellyfinToSeerrTask_LibrarySnapshotObservesCancellationBetweenPages()
    {
        using var cancellation = new CancellationTokenSource();
        var movie = MovieWithTmdbId("Cancellation page", "901");
        var library = new CountingLibraryManager
        {
            GetItemListHook = query =>
            {
                cancellation.Cancel();
                return Enumerable.Repeat<BaseItem>(movie, query.Limit!.Value).ToArray();
            },
        };

        await Assert.ThrowsAsync<OperationCanceledException>(() =>
            JellyfinToSeerrWatchlistSyncTask.TryCollectLibraryItemsBoundedAsync(
                library,
                new List<(BaseItem item, string mediaType)>(),
                cancellation.Token));
        Assert.Equal(1, library.GetItemListCallCount);
    }

    [Fact]
    public async Task JellyfinToSeerrTask_AccessRevokedDuringFreshBindingDoesNotExport()
    {
        var user = new User("revoked-export-user", "provider", "password-provider");
        var movie = MovieWithTmdbId("Revoked export", "803");
        var accessReads = 0;
        var lookup = StubItemLookupService.FromItems(
            new[] { movie },
            (ids, _) => Interlocked.Increment(ref accessReads) == 1
                ? ids.ToHashSet()
                : new HashSet<Guid>());
        var handler = new RequestRoutingHandler(request =>
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path == "/api/v1/user") return UserMap(user, 7);
            if (path == "/api/v1/user/7/watchlist") return EmptyWatchlist();
            if (path == "/api/v1/user/7")
            {
                return Json(new { id = 7, jellyfinUserId = user.Id });
            }

            if (request.Method == HttpMethod.Post) return Json(new { id = 1 });
            throw new Xunit.Sdk.XunitException($"Unexpected request {request.Method} {request.RequestUri}.");
        });
        var task = CreateOutboundTask(user, new[] { movie }, handler, new FakePluginConfigProvider(OutboundConfig()), lookup);

        await task.ExecuteAsync(new Progress<double>(), CancellationToken.None);

        Assert.Equal(2, accessReads);
        Assert.DoesNotContain(handler.Requests, request => request.Method == HttpMethod.Post);
    }

    [Theory]
    [InlineData("access")]
    [InlineData("like")]
    public async Task JellyfinToSeerrTask_FinalBindingReadRevocationSuppressesPost(
        string revokedAuthority)
    {
        var user = new User("binding-window-user", "provider", "password-provider");
        var movie = MovieWithTmdbId("Binding window movie", "809");
        var revoked = false;
        var bindingReads = 0;
        var handler = new RequestRoutingHandler(request =>
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path == "/api/v1/user") return UserMap(user, 7);
            if (path == "/api/v1/user/7/watchlist") return EmptyWatchlist();
            if (path == "/api/v1/user/7")
            {
                if (Interlocked.Increment(ref bindingReads) == 2)
                {
                    revoked = true;
                }

                return Json(new { id = 7, jellyfinUserId = user.Id });
            }

            if (request.Method == HttpMethod.Post) return Json(new { id = 1 });
            throw new Xunit.Sdk.XunitException(
                $"Unexpected request {request.Method} {request.RequestUri}.");
        });
        var lookup = StubItemLookupService.FromItems(
            new BaseItem[] { movie },
            (ids, _) => revoked && revokedAuthority == "access"
                ? new HashSet<Guid>()
                : ids.ToHashSet());
        var userData = new StubUserDataManager
        {
            GetUserDataHook = (_, item) => new UserItemData
            {
                Key = item.Id.ToString("N"),
                Likes = !(revoked && revokedAuthority == "like"),
            },
        };
        var task = new JellyfinToSeerrWatchlistSyncTask(
            new CountingLibraryManager
            {
                GetItemListHook = query => query.IncludeItemTypes.Contains(
                        Jellyfin.Data.Enums.BaseItemKind.Movie)
                    ? new BaseItem[] { movie }
                    : Array.Empty<BaseItem>(),
            },
            new StubUserManager(user),
            userData,
            new RecordingHttpClientFactory(handler),
            userConfigurationManager: null!,
            NullLogger<JellyfinToSeerrWatchlistSyncTask>.Instance,
            new FakePluginConfigProvider(OutboundConfig()),
            lookup);

        await task.ExecuteAsync(new Progress<double>(), CancellationToken.None);

        Assert.Equal(2, bindingReads);
        Assert.DoesNotContain(handler.Requests, request => request.Method == HttpMethod.Post);
        Assert.Equal(3, lookup.AccessQueryCount);
        Assert.Equal(
            revokedAuthority == "access" ? 2 : 3,
            userData.GetUserDataBatchCallCount);
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
            Id = Guid.NewGuid(),
            Name = "Valid first movie",
            ProviderIds = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["Tmdb"] = "101",
            },
        };
        var invalidMovie = new Movie
        {
            Id = Guid.NewGuid(),
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
            configProvider,
            new StubItemLookupService());

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
        Assert.Equal(
            2,
            handler.Requests.Count(request => request.Uri.AbsolutePath == "/api/v1/user/7"));
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
            configProvider,
            new StubItemLookupService());

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
            Id = Guid.NewGuid(),
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
        FakePluginConfigProvider configProvider,
        StubItemLookupService? itemLookup = null)
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
            configProvider,
            itemLookup ?? new StubItemLookupService());
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
