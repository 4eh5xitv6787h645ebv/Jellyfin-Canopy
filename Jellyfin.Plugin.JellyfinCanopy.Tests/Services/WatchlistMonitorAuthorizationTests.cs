using System.Net;
using System.Text;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class WatchlistMonitorAuthorizationTests
{
    [Fact]
    public async Task ExactFreshSourceBinding_AddsLike()
    {
        var user = new User("bound-user", "provider", "password-provider");
        var handler = new MonitorHandler((request, _) => request.RequestUri!.AbsolutePath switch
        {
            "/api/v1/request" => Page(RequestRow(1, 7, user.Id, 101)),
            "/api/v1/user" => Page(UserRow(7, user.Id)),
            var path => throw new Xunit.Sdk.XunitException($"Unexpected path {path}."),
        });
        var data = new RecordingUserDataManager();
        var monitor = CreateMonitor(user, data, handler, new FakePluginConfigProvider(Config()));

        await monitor.ProcessItemForWatchlistForTestAsync(Movie(101));

        Assert.Equal(1, data.SaveCount);
        Assert.True(data.Data.Likes);
        Assert.Equal(2, handler.RequestPaths.Count(path => path == "/api/v1/request"));
        Assert.Equal(4, handler.RequestPaths.Count(path => path == "/api/v1/user"));
    }

    [Fact]
    public async Task InaccessibleEventEdition_UsesAccessibleAlternate()
    {
        var user = new User("alternate-user", "provider", "password-provider");
        var eventEdition = Movie(101);
        eventEdition.Id = Guid.Parse("00000000-0000-0000-0000-000000000011");
        var accessibleEdition = Movie(101);
        accessibleEdition.Id = Guid.Parse("00000000-0000-0000-0000-000000000012");
        var items = new BaseItem[] { eventEdition, accessibleEdition };
        var lookup = StubItemLookupService.FromItems(
            items,
            (ids, _) => ids.Where(id => id == accessibleEdition.Id).ToHashSet());
        var library = new CountingLibraryManager
        {
            GetItemListHook = _ => items,
        };
        var handler = new MonitorHandler((request, _) => request.RequestUri!.AbsolutePath switch
        {
            "/api/v1/request" => Page(RequestRow(1, 7, user.Id, 101)),
            "/api/v1/user" => Page(UserRow(7, user.Id)),
            var path => throw new Xunit.Sdk.XunitException($"Unexpected path {path}."),
        });
        var data = new RecordingUserDataManager();
        var monitor = CreateMonitor(
            user,
            data,
            handler,
            new FakePluginConfigProvider(Config()),
            library,
            lookup);

        await monitor.ProcessItemForWatchlistForTestAsync(eventEdition);

        Assert.Equal(1, data.SaveCount);
        Assert.Same(accessibleEdition, data.SavedItem);
        Assert.Equal(2, lookup.ProviderQueryCount);
        Assert.Equal(3, lookup.AccessQueryCount);
    }

    [Fact]
    public async Task AccessRevokedDuringOwnershipBarrier_WritesNothing()
    {
        var user = new User("revoked-user", "provider", "password-provider");
        var movie = Movie(101);
        var accessReads = 0;
        var lookup = StubItemLookupService.FromItems(
            new BaseItem[] { movie },
            (ids, _) => Interlocked.Increment(ref accessReads) == 1
                ? ids.ToHashSet()
                : new HashSet<Guid>());
        var handler = new MonitorHandler((request, _) => request.RequestUri!.AbsolutePath switch
        {
            "/api/v1/request" => Page(RequestRow(1, 7, user.Id, 101)),
            "/api/v1/user" => Page(UserRow(7, user.Id)),
            var path => throw new Xunit.Sdk.XunitException($"Unexpected path {path}."),
        });
        var data = new RecordingUserDataManager();
        var monitor = CreateMonitor(
            user,
            data,
            handler,
            new FakePluginConfigProvider(Config()),
            new CountingLibraryManager(),
            lookup);

        await monitor.ProcessItemForWatchlistForTestAsync(movie);

        Assert.Equal(2, accessReads);
        Assert.Equal(0, data.SaveCount);
        Assert.NotEqual(true, data.Data.Likes);
    }

    [Fact]
    public async Task FirstUsersSaveRevokesSecondUsersAccess_SecondUserIsNotMutated()
    {
        var firstUser = new User("first-requester", "provider", "password-provider");
        var secondUser = new User("second-requester", "provider", "password-provider");
        var movie = Movie(103);
        var secondUserRevoked = false;
        var lookup = StubItemLookupService.FromItems(
            new BaseItem[] { movie },
            (ids, user) => user.Id == secondUser.Id && secondUserRevoked
                ? new HashSet<Guid>()
                : ids.ToHashSet());
        var handler = new MonitorHandler((request, _) => request.RequestUri!.AbsolutePath switch
        {
            "/api/v1/request" => Page(
                RequestRow(1, 7, firstUser.Id, 103),
                RequestRow(2, 8, secondUser.Id, 103)),
            "/api/v1/user" => Page(
                UserRow(7, firstUser.Id),
                UserRow(8, secondUser.Id)),
            var path => throw new Xunit.Sdk.XunitException($"Unexpected path {path}."),
        });
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
        var monitor = new WatchlistMonitor(
            new CountingLibraryManager(),
            new StubUserManager(firstUser, secondUser),
            userData,
            new RecordingHttpClientFactory(handler),
            userConfigurationManager: null!,
            NullLogger<WatchlistMonitor>.Instance,
            new FakePluginConfigProvider(Config()),
            lookup);

        await monitor.ProcessItemForWatchlistForTestAsync(movie);

        Assert.Equal(new[] { firstUser.Id }, savedUsers);
        Assert.Equal(6, lookup.AccessQueryCount);
    }

    [Fact]
    public async Task AlreadyLikedAccessibleEdition_DoesNotLikeAnotherEdition()
    {
        var user = new User("liked-edition-user", "provider", "password-provider");
        var unlikedEdition = Movie(104);
        unlikedEdition.Id = Guid.Parse("00000000-0000-0000-0000-000000000013");
        var likedEdition = Movie(104);
        likedEdition.Id = Guid.Parse("00000000-0000-0000-0000-000000000014");
        var items = new BaseItem[] { unlikedEdition, likedEdition };
        var lookup = StubItemLookupService.FromItems(items);
        var handler = new MonitorHandler((request, _) => request.RequestUri!.AbsolutePath switch
        {
            "/api/v1/request" => Page(RequestRow(1, 7, user.Id, 104)),
            "/api/v1/user" => Page(UserRow(7, user.Id)),
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
        var monitor = new WatchlistMonitor(
            new CountingLibraryManager
            {
                GetItemListHook = _ => items,
            },
            new StubUserManager(user),
            userData,
            new RecordingHttpClientFactory(handler),
            userConfigurationManager: null!,
            NullLogger<WatchlistMonitor>.Instance,
            new FakePluginConfigProvider(Config()),
            lookup);

        await monitor.ProcessItemForWatchlistForTestAsync(unlikedEdition);

        Assert.Equal(0, saveCount);
        Assert.Equal(1, userData.GetUserDataBatchCallCount);
    }

    [Fact]
    public async Task UnlikeAtFinalAccessBarrier_SavesLikeBeforeProcessedMarker()
    {
        var baseDirectory = Path.Combine(
            Path.GetTempPath(),
            "jc-watchlist-monitor-live-data-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(baseDirectory);
        try
        {
            var user = new User("monitor-unlike-user", "provider", "password-provider");
            var movie = Movie(105);
            var handler = new MonitorHandler((request, _) => request.RequestUri!.AbsolutePath switch
            {
                "/api/v1/request" => Page(RequestRow(1, 7, user.Id, 105)),
                "/api/v1/user" => Page(UserRow(7, user.Id)),
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
            var config = Config();
            config.PreventWatchlistReAddition = true;
            var monitor = CreateMonitor(
                user,
                userData,
                handler,
                new FakePluginConfigProvider(config),
                new CountingLibraryManager(),
                lookup,
                userConfiguration);

            await monitor.ProcessItemForWatchlistForTestAsync(movie);

            Assert.True(unliked);
            Assert.Equal(1, saveCount);
            var marker = Assert.Single(
                userConfiguration.GetProcessedWatchlistItems(user.Id).Items);
            Assert.Equal("monitor", marker.Source);
            Assert.Equal(105, marker.TmdbId);
        }
        finally
        {
            Directory.Delete(baseDirectory, recursive: true);
        }
    }

    [Fact]
    public async Task ConfigurationChangeDuringFinalAccessQuery_SuppressesSave()
    {
        var user = new User("post-access-config-user", "provider", "password-provider");
        var movie = Movie(106);
        var handler = new MonitorHandler((request, _) => request.RequestUri!.AbsolutePath switch
        {
            "/api/v1/request" => Page(RequestRow(1, 7, user.Id, 106)),
            "/api/v1/user" => Page(UserRow(7, user.Id)),
            var path => throw new Xunit.Sdk.XunitException($"Unexpected path {path}."),
        });
        var provider = new FakePluginConfigProvider(Config());
        var lookup = StubItemLookupService.FromItems(new BaseItem[] { movie });
        lookup.BeforeAccessQuery = count =>
        {
            if (count == 3)
            {
                provider.Current = new PluginConfiguration();
            }
        };
        var saveCount = 0;
        var userData = new StubUserDataManager
        {
            GetUserDataHook = (_, item) => new UserItemData
            {
                Key = item.Id.ToString("N"),
                Likes = false,
            },
            SaveUserDataHook = (_, _, _, _, _) => saveCount++,
        };
        var monitor = CreateMonitor(
            user,
            userData,
            handler,
            provider,
            new CountingLibraryManager(),
            lookup);

        await monitor.ProcessItemForWatchlistForTestAsync(movie);

        Assert.Equal(3, lookup.AccessQueryCount);
        Assert.Equal(0, saveCount);
        Assert.Equal(0, userData.GetUserDataBatchCallCount);
    }

    [Fact]
    public async Task NoAccessibleEdition_DoesNotSaveOrCommitProcessedMarker()
    {
        var baseDirectory = Path.Combine(
            Path.GetTempPath(),
            "jc-watchlist-access-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(baseDirectory);
        try
        {
            var user = new User("no-access-user", "provider", "password-provider");
            var movie = Movie(101);
            var lookup = StubItemLookupService.FromItems(
                new BaseItem[] { movie },
                (_, _) => new HashSet<Guid>());
            var handler = new MonitorHandler((request, _) => request.RequestUri!.AbsolutePath switch
            {
                "/api/v1/request" => Page(RequestRow(1, 7, user.Id, 101)),
                "/api/v1/user" => Page(UserRow(7, user.Id)),
                var path => throw new Xunit.Sdk.XunitException($"Unexpected path {path}."),
            });
            var config = Config();
            config.PreventWatchlistReAddition = true;
            var userConfiguration = new UserConfigurationManager(
                new StubAppPaths(baseDirectory),
                NullLogger<UserConfigurationManager>.Instance);
            var data = new RecordingUserDataManager();
            var monitor = CreateMonitor(
                user,
                data,
                handler,
                new FakePluginConfigProvider(config),
                new CountingLibraryManager(),
                lookup,
                userConfiguration);

            await monitor.ProcessItemForWatchlistForTestAsync(movie);

            Assert.Equal(0, data.SaveCount);
            Assert.Empty(userConfiguration.GetProcessedWatchlistItems(user.Id).Items);
        }
        finally
        {
            Directory.Delete(baseDirectory, recursive: true);
        }
    }

    [Fact]
    public async Task RequestOwnerIdMustMatchSameSourceUserMap()
    {
        var user = new User("source-bound-user", "provider", "password-provider");
        var config = Config("http://source-a:5055,http://source-b:5055");
        var handler = new MonitorHandler((request, cancellationToken) =>
        {
            _ = cancellationToken;
            var uri = request.RequestUri!;
            if (uri.AbsolutePath == "/api/v1/request")
            {
                return uri.Host == "source-a"
                    ? Page(RequestRow(1, 7, user.Id, 101))
                    : Page(RequestRow(2, 7, user.Id, 999));
            }

            if (uri.AbsolutePath == "/api/v1/user")
            {
                // The same Jellyfin identity may be linked on both domains, but source-a's
                // request cannot borrow source-b's source-local Seerr id.
                return uri.Host == "source-a"
                    ? Page(UserRow(8, user.Id))
                    : Page(UserRow(7, user.Id));
            }

            throw new Xunit.Sdk.XunitException($"Unexpected URI {uri}.");
        });
        var data = new RecordingUserDataManager();
        var monitor = CreateMonitor(
            user,
            data,
            handler,
            new FakePluginConfigProvider(config));

        await monitor.ProcessItemForWatchlistForTestAsync(Movie(101));

        Assert.Equal(0, data.SaveCount);
        Assert.NotEqual(true, data.Data.Likes);
    }

    [Fact]
    public async Task OneInvalidMatchingOwnerSuppressesWholeLocalBatch()
    {
        var user = new User("all-or-nothing-user", "provider", "password-provider");
        var handler = new MonitorHandler((request, _) => request.RequestUri!.AbsolutePath switch
        {
            "/api/v1/request" => Page(
                RequestRow(1, 7, user.Id, 101),
                RequestRow(2, 8, user.Id, 101)),
            "/api/v1/user" => Page(UserRow(7, user.Id)),
            var path => throw new Xunit.Sdk.XunitException($"Unexpected path {path}."),
        });
        var data = new RecordingUserDataManager();
        var monitor = CreateMonitor(user, data, handler, new FakePluginConfigProvider(Config()));

        await monitor.ProcessItemForWatchlistForTestAsync(Movie(101));

        Assert.Equal(0, data.SaveCount);
        Assert.NotEqual(true, data.Data.Likes);
    }

    [Fact]
    public async Task OwnershipRebindBetweenPreparationAndDispatch_WritesNothing()
    {
        var user = new User("rebound-user", "provider", "password-provider");
        var userReads = 0;
        var handler = new MonitorHandler((request, _) => request.RequestUri!.AbsolutePath switch
        {
            "/api/v1/request" => Page(RequestRow(1, 7, user.Id, 101)),
            "/api/v1/user" => Page(UserRow(Interlocked.Increment(ref userReads) <= 2 ? 7 : 8, user.Id)),
            var path => throw new Xunit.Sdk.XunitException($"Unexpected path {path}."),
        });
        var data = new RecordingUserDataManager();
        var monitor = CreateMonitor(user, data, handler, new FakePluginConfigProvider(Config()));

        await monitor.ProcessItemForWatchlistForTestAsync(Movie(101));

        Assert.Equal(4, userReads);
        Assert.Equal(0, data.SaveCount);
        Assert.NotEqual(true, data.Data.Likes);
    }

    [Fact]
    public async Task AmbiguousUserMap_WritesNothing()
    {
        var user = new User("ambiguous-user", "provider", "password-provider");
        var handler = new MonitorHandler((request, _) => request.RequestUri!.AbsolutePath switch
        {
            "/api/v1/request" => Page(RequestRow(1, 7, user.Id, 101)),
            "/api/v1/user" => Page(UserRow(7, user.Id), UserRow(8, user.Id)),
            var path => throw new Xunit.Sdk.XunitException($"Unexpected path {path}."),
        });
        var data = new RecordingUserDataManager();
        var monitor = CreateMonitor(user, data, handler, new FakePluginConfigProvider(Config()));

        await monitor.ProcessItemForWatchlistForTestAsync(Movie(101));

        Assert.Equal(0, data.SaveCount);
        Assert.NotEqual(true, data.Data.Likes);
    }

    [Fact]
    public async Task ConfigurationAbaDuringDispatch_WritesNothing()
    {
        var user = new User("aba-user", "provider", "password-provider");
        var provider = new FakePluginConfigProvider(Config());
        var userReads = 0;
        var handler = new MonitorHandler((request, cancellationToken) =>
        {
            _ = cancellationToken;
            if (request.RequestUri!.AbsolutePath == "/api/v1/request")
            {
                return Page(RequestRow(1, 7, user.Id, 101));
            }

            if (request.RequestUri.AbsolutePath != "/api/v1/user")
            {
                throw new Xunit.Sdk.XunitException($"Unexpected URI {request.RequestUri}.");
            }

            if (Interlocked.Increment(ref userReads) == 4)
            {
                provider.Current = new PluginConfiguration();
                _ = provider.ConfigurationRevision;
                provider.Current = Config();
                _ = provider.ConfigurationRevision;
            }

            return Page(UserRow(7, user.Id));
        });
        var data = new RecordingUserDataManager();
        var monitor = CreateMonitor(user, data, handler, provider);

        await monitor.ProcessItemForWatchlistForTestAsync(Movie(101));

        Assert.Equal(4, userReads);
        Assert.Equal(0, data.SaveCount);
        Assert.NotEqual(true, data.Data.Likes);
    }

    [Fact]
    public void RequestCacheIdentityIncludesNormalizedDomainsCredentialAndRevision()
    {
        var canonical = WatchlistMonitor.BuildRequestsCacheKey(
            new[] { "http://seerr" },
            "secret-a",
            11);
        var urlAlias = WatchlistMonitor.BuildRequestsCacheKey(
            new[] { "HTTP://SEERR:80/" },
            "secret-a",
            11);

        Assert.Equal(canonical, urlAlias);
        Assert.NotEqual(
            canonical,
            WatchlistMonitor.BuildRequestsCacheKey(new[] { "http://other" }, "secret-a", 11));
        Assert.NotEqual(
            canonical,
            WatchlistMonitor.BuildRequestsCacheKey(new[] { "http://seerr" }, "secret-b", 11));
        Assert.NotEqual(
            canonical,
            WatchlistMonitor.BuildRequestsCacheKey(new[] { "http://seerr" }, "secret-a", 12));
        Assert.DoesNotContain("secret", canonical, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void RequestSnapshot_IndexesEachMediaIdentityOnceAndRetainsAllOwners()
    {
        var requests = Enumerable.Range(1, 10_000)
            .Select(tmdbId => new WatchlistMonitor.RequestItemWithUser
            {
                TmdbId = tmdbId,
                MediaType = "movie",
                SourceUrl = "http://seerr:5055",
                RequestedBySeerrUserId = tmdbId.ToString(System.Globalization.CultureInfo.InvariantCulture),
                RequestedByJellyfinUserId = Guid.NewGuid().ToString("N"),
            })
            .ToList();
        requests.Add(new WatchlistMonitor.RequestItemWithUser
        {
            TmdbId = 5_000,
            MediaType = "movie",
            SourceUrl = "http://seerr:5055",
            RequestedBySeerrUserId = "duplicate-owner",
            RequestedByJellyfinUserId = Guid.NewGuid().ToString("N"),
        });

        var snapshot = WatchlistMonitor.RequestSnapshot.Create(requests);

        Assert.Equal(10_001, snapshot.Count);
        Assert.Equal(20_001, snapshot.Weight); // 10,001 rows + 10,000 unique keys.
        Assert.True(snapshot.TryGet("movie", 5_000, out var owners));
        Assert.Equal(2, owners.Count);
        Assert.False(snapshot.TryGet("tv", 5_000, out var wrongMedia));
        Assert.Empty(wrongMedia);
    }

    private static WatchlistMonitor CreateMonitor(
        User user,
        IUserDataManager data,
        HttpMessageHandler handler,
        FakePluginConfigProvider provider,
        CountingLibraryManager? library = null,
        StubItemLookupService? itemLookup = null,
        UserConfigurationManager? userConfigurationManager = null)
        => new(
            library ?? new CountingLibraryManager(),
            new StubUserManager(user),
            data,
            new RecordingHttpClientFactory(handler),
            userConfigurationManager!,
            NullLogger<WatchlistMonitor>.Instance,
            provider,
            itemLookup ?? new StubItemLookupService());

    private static PluginConfiguration Config(string urls = "http://seerr:5055")
        => new()
        {
            AddRequestedMediaToWatchlist = true,
            SeerrEnabled = true,
            SeerrUrls = urls,
            SeerrApiKey = "secret-a",
            PreventWatchlistReAddition = false,
        };

    private static Movie Movie(int tmdbId)
    {
        var movie = new Movie
        {
            Id = Guid.NewGuid(),
            Name = $"Movie {tmdbId}",
        };
        movie.ProviderIds["Tmdb"] = tmdbId.ToString(System.Globalization.CultureInfo.InvariantCulture);
        return movie;
    }

    private static object RequestRow(int id, int seerrUserId, Guid jellyfinUserId, int tmdbId)
        => new
        {
            id,
            type = "movie",
            requestedBy = new
            {
                id = seerrUserId,
                jellyfinUserId = jellyfinUserId.ToString(),
            },
            media = new
            {
                tmdbId,
                mediaType = "movie",
            },
        };

    private static object UserRow(int seerrUserId, Guid jellyfinUserId)
        => new
        {
            id = seerrUserId,
            jellyfinUserId = jellyfinUserId.ToString(),
        };

    private static HttpResponseMessage Page(params object[] results)
        => new(HttpStatusCode.OK)
        {
            Content = new StringContent(
                JsonSerializer.Serialize(new
                {
                    page = 1,
                    totalPages = 1,
                    totalResults = results.Length,
                    pageInfo = new
                    {
                        page = 1,
                        pages = 1,
                        pageSize = results.Length,
                        results = results.Length,
                    },
                    results,
                }),
                Encoding.UTF8,
                "application/json"),
        };

    private sealed class MonitorHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, CancellationToken, HttpResponseMessage> _route;

        public MonitorHandler(
            Func<HttpRequestMessage, CancellationToken, HttpResponseMessage> route)
            => _route = route;

        public List<string> RequestPaths { get; } = new();

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            RequestPaths.Add(request.RequestUri!.AbsolutePath);
            return Task.FromResult(_route(request, cancellationToken));
        }
    }

    private sealed class RecordingUserDataManager : IUserDataManager
    {
        public UserItemData Data { get; } = new() { Key = "watchlist-monitor-test" };

        public int SaveCount { get; private set; }

        public BaseItem? SavedItem { get; private set; }

        public event EventHandler<UserDataSaveEventArgs>? UserDataSaved
        {
            add { }
            remove { }
        }

        public UserItemData? GetUserData(User user, BaseItem item) => Data;

        public void SaveUserData(
            User user,
            BaseItem item,
            UserItemData userData,
            UserDataSaveReason reason,
            CancellationToken cancellationToken)
        {
            SavedItem = item;
            SaveCount++;
        }

        public void SaveUserData(
            User user,
            BaseItem item,
            UpdateUserItemDataDto userDataDto,
            UserDataSaveReason reason)
            => throw new NotImplementedException();

        public UserItemDataDto? GetUserDataDto(BaseItem item, User user)
            => throw new NotImplementedException();

        public Dictionary<Guid, UserItemData> GetUserDataBatch(
            IReadOnlyList<BaseItem> items,
            User user)
            => items.ToDictionary(static item => item.Id, _ => Data);

        public UserItemDataDto? GetUserDataDto(
            BaseItem item,
            BaseItemDto? itemDto,
            User user,
            DtoOptions options)
            => throw new NotImplementedException();

        public bool UpdatePlayState(
            BaseItem item,
            UserItemData data,
            long? reportedPositionTicks)
            => throw new NotImplementedException();
    }
}
