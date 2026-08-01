using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.AnimeFiller;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Common.Api;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers;

public sealed class AnimeFillerControllerContractTests
{
    [Fact]
    public void Classification_IsAuthenticated_AndDiagnosticsRequireElevation()
    {
        var classify = Method(nameof(AnimeFillerWarningsController.Classify));
        var diagnostics = Method(nameof(AnimeFillerWarningsController.Diagnostics));
        var search = Method(nameof(AnimeFillerWarningsController.Search));

        Assert.NotNull(classify.GetCustomAttribute<AuthorizeAttribute>());
        Assert.Equal(Policies.RequiresElevation, diagnostics.GetCustomAttribute<AuthorizeAttribute>()?.Policy);
        Assert.Equal(Policies.RequiresElevation, search.GetCustomAttribute<AuthorizeAttribute>()?.Policy);
    }

    [Fact]
    public void Classification_HasPostRoute_AndExplicitHundredIdBound()
    {
        var classify = Method(nameof(AnimeFillerWarningsController.Classify));
        Assert.Equal("classifications", classify.GetCustomAttribute<HttpPostAttribute>()?.Template);

        var source = File.ReadAllText(ControllerPath());
        Assert.Contains("uniqueIds.Length > 100", source, StringComparison.Ordinal);
        Assert.NotNull(classify.GetCustomAttribute<RequestSizeLimitAttribute>());
        Assert.Contains("[RequestSizeLimit(64 * 1024)]", source, StringComparison.Ordinal);
        Assert.Contains("UserAccessQuery.BuildItemIds(_libraryManager, user, itemIds)", source, StringComparison.Ordinal);
        Assert.Contains("SeriesEpisodePageSize = 256", source, StringComparison.Ordinal);
        Assert.Contains("StartIndex = startIndex", source, StringComparison.Ordinal);
        Assert.DoesNotContain("GetItemById<BaseItem>", source, StringComparison.Ordinal);
        Assert.DoesNotContain("episode.Series ??", source, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Classification_IsCallerScoped_PreservesOrder_AndUsesAbsoluteEpisodeNumber()
    {
        var user = new User("anime-user", "provider", "password-provider");
        var seriesId = Guid.NewGuid();
        var episodeId = Guid.NewGuid();
        var series = new Series
        {
            Id = seriesId,
            Name = "Naruto",
            ProductionYear = 2002,
            Genres = ["Anime"],
        };
        series.ProviderIds["MyAnimeList"] = "20";
        var episode = new Episode
        {
            Id = episodeId,
            SeriesId = seriesId,
            ParentIndexNumber = 2,
            IndexNumber = 1,
        };
        var library = new CountingLibraryManager
        {
            GetItemListHook = query =>
            {
                Assert.Equal(user.Id, query.User?.Id);
                if (query.ItemIds.Length > 0)
                {
                    return query.IncludeItemTypes.Contains(BaseItemKind.Episode)
                        ? [episode]
                        : [series];
                }

                Assert.Equal(seriesId, query.ParentId);
                return
                [
                    new Episode { SeriesId = seriesId, ParentIndexNumber = 1, IndexNumber = 12 },
                    episode,
                ];
            },
        };
        var provider = new FakeProvider
        {
            Episodes = AnimeProviderEpisodes.Create(20, new Dictionary<int, bool> { [13] = true }),
        };
        var config = EnabledConfig();
        config.AnimeFillerMappings = $"{seriesId}=20";
        var controller = BuildController(config, provider, library, user);
        var invalid = "not-a-guid";

        var result = await controller.Classify(new AnimeFillerBatchRequest([episodeId.ToString(), invalid, episodeId.ToString()]));

        var payload = Assert.IsType<AnimeFillerBatchResponse>(Assert.IsType<OkObjectResult>(result).Value);
        Assert.Equal(3, payload.Items.Count);
        Assert.Equal(new[] { episodeId.ToString(), invalid, episodeId.ToString() }, payload.Items.Select(item => item.ItemId));
        Assert.Equal("Filler", payload.Items[0].Classification);
        Assert.Equal("manual-series-mapping", payload.Items[0].Reason);
        Assert.Equal("Unknown", payload.Items[1].Classification);
        Assert.Equal("unavailable", payload.Items[1].Reason);
        Assert.Equal(0, library.GetItemByIdUserCallCount);
        Assert.Equal(3, library.GetItemListCallCount);
        Assert.Equal(1, provider.EpisodeCalls);
    }

    [Fact]
    public async Task Classification_BatchesMixedItems_ByDistinctCallerVisibleSeries()
    {
        var user = new User("anime-user", "provider", "password-provider");
        var topParentId = Guid.NewGuid();
        var seriesA = AnimeSeries("Series A", 20);
        var seriesB = AnimeSeries("Series B", 30);
        var inaccessibleSeries = AnimeSeries("Private series", 40);
        var episodeA1 = NumberedEpisode(seriesA.Id, 1, 1);
        var episodeA2 = NumberedEpisode(seriesA.Id, 2, 1);
        var episodeB1 = NumberedEpisode(seriesB.Id, 1, 1);
        var inaccessibleParent = NumberedEpisode(inaccessibleSeries.Id, 1, 1);
        var standalone = NumberedEpisode(Guid.Empty, 1, 1);
        var nonEpisode = new Series { Id = Guid.NewGuid(), Name = "Not an episode" };
        var missingId = Guid.NewGuid();
        var bulkQueries = 0;
        var recursiveQueries = new Dictionary<Guid, int>();
        var library = new CountingLibraryManager
        {
            ConfigureUserAccessHook = (query, resolvedUser) =>
            {
                Assert.Same(user, resolvedUser);
                Assert.Empty(query.ItemIds);
                query.TopParentIds = [topParentId];
            },
            GetItemListHook = query =>
            {
                Assert.Same(user, query.User);
                if (query.ItemIds.Length > 0)
                {
                    bulkQueries++;
                    Assert.Equal([topParentId], query.TopParentIds);
                    Assert.Equal(query.ItemIds.Length, query.Limit);
                    if (query.IncludeItemTypes.Contains(BaseItemKind.Episode))
                    {
                        Assert.Equal(7, query.ItemIds.Length);
                        return [episodeA1, episodeA2, episodeB1, inaccessibleParent, standalone, nonEpisode];
                    }

                    Assert.Equal(3, query.ItemIds.Length);
                    Assert.Contains(seriesA.Id, query.ItemIds);
                    Assert.Contains(seriesB.Id, query.ItemIds);
                    Assert.Contains(inaccessibleSeries.Id, query.ItemIds);
                    // The inaccessible parent is deliberately omitted by the caller-scoped seam.
                    return [seriesA, seriesB];
                }

                recursiveQueries[query.ParentId] = recursiveQueries.GetValueOrDefault(query.ParentId) + 1;
                Assert.Equal(0, query.StartIndex);
                Assert.Equal(256, query.Limit);
                return query.ParentId == seriesA.Id
                    ? [
                        new Episode { SeriesId = seriesA.Id, ParentIndexNumber = 1, IndexNumber = 1 },
                        new Episode { SeriesId = seriesA.Id, ParentIndexNumber = 1, IndexNumber = 2 },
                        episodeA2,
                    ]
                    : [episodeB1];
            },
        };
        var provider = new FakeProvider
        {
            EpisodesByMalId = new Dictionary<int, AnimeProviderEpisodes>
            {
                [20] = AnimeProviderEpisodes.Create(20, new Dictionary<int, bool> { [1] = false, [3] = true }),
                [30] = AnimeProviderEpisodes.Create(30, new Dictionary<int, bool> { [1] = true }),
            },
        };
        var controller = BuildController(EnabledConfig(), provider, library, user);
        var invalid = "not-a-guid";
        var alternateEpisodeA2 = "{" + episodeA2.Id.ToString().ToUpperInvariant() + "}";
        string[] requested =
        [
            episodeA2.Id.ToString(),
            invalid,
            episodeA1.Id.ToString(),
            episodeB1.Id.ToString(),
            alternateEpisodeA2,
            episodeA2.Id.ToString(),
            inaccessibleParent.Id.ToString(),
            standalone.Id.ToString(),
            nonEpisode.Id.ToString(),
            missingId.ToString(),
        ];

        var result = await controller.Classify(new AnimeFillerBatchRequest(requested));

        var payload = Assert.IsType<AnimeFillerBatchResponse>(Assert.IsType<OkObjectResult>(result).Value);
        Assert.Equal(requested, payload.Items.Select(item => item.ItemId));
        Assert.Equal(
            ["Filler", "Unknown", "Canon", "Filler", "Filler", "Filler", "Unknown", "Unknown", "Unknown", "Unknown"],
            payload.Items.Select(item => item.Classification));
        Assert.Equal("not-recognized-as-anime", payload.Items[6].Reason);
        Assert.Equal("not-recognized-as-anime", payload.Items[7].Reason);
        Assert.Equal("unavailable", payload.Items[8].Reason);
        Assert.Equal("unavailable", payload.Items[9].Reason);
        Assert.Equal(2, bulkQueries);
        Assert.Equal(1, recursiveQueries[seriesA.Id]);
        Assert.Equal(1, recursiveQueries[seriesB.Id]);
        Assert.Equal(2, recursiveQueries.Count);
        Assert.Equal(4, library.GetItemListCallCount);
        Assert.Equal(0, library.GetItemByIdUserCallCount);
        Assert.Equal(2, provider.EpisodeCalls);
    }

    [Fact]
    public async Task Classification_HundredEpisodeBatch_HasConstantBulkAndPerSeriesQueryCount()
    {
        var user = new User("anime-user", "provider", "password-provider");
        var series = AnimeSeries("Hundred episode series", 99);
        var episodes = Enumerable.Range(1, 100)
            .Select(index => NumberedEpisode(series.Id, 1, index))
            .ToArray();
        var library = new CountingLibraryManager
        {
            GetItemListHook = query =>
            {
                if (query.ItemIds.Length > 0)
                {
                    return query.IncludeItemTypes.Contains(BaseItemKind.Episode)
                        ? episodes
                        : [series];
                }

                Assert.Equal(series.Id, query.ParentId);
                Assert.Equal(256, query.Limit);
                return episodes;
            },
        };
        var provider = new FakeProvider
        {
            Episodes = AnimeProviderEpisodes.Create(
                99,
                Enumerable.Range(1, 100).ToDictionary(index => index, index => index % 2 == 0)),
        };
        var controller = BuildController(EnabledConfig(), provider, library, user);

        var result = await controller.Classify(new AnimeFillerBatchRequest(
            episodes.Select(episode => episode.Id.ToString()).ToArray()));

        var items = Assert.IsType<AnimeFillerBatchResponse>(Assert.IsType<OkObjectResult>(result).Value).Items;
        Assert.Equal(100, items.Count);
        Assert.Equal(50, items.Count(item => item.Classification == "Filler"));
        Assert.Equal(50, items.Count(item => item.Classification == "Canon"));
        Assert.Equal(3, library.GetItemListCallCount);
        Assert.Equal(0, library.GetItemByIdUserCallCount);
        Assert.Equal(1, provider.EpisodeCalls);
    }

    [Fact]
    public async Task Classification_PagesOneSeriesScan_AndReusesItsNumberingIndex()
    {
        var user = new User("anime-user", "provider", "password-provider");
        var series = AnimeSeries("Long series", 42);
        var requestedEpisode = NumberedEpisode(series.Id, 3, 1);
        var libraryEpisodes = Enumerable.Range(1, 255)
            .Select(index => NumberedEpisode(series.Id, 1, index))
            .Concat(Enumerable.Range(1, 2).Select(index => NumberedEpisode(series.Id, 2, index)))
            .Cast<BaseItem>()
            .ToArray();
        var pageStarts = new List<int>();
        var library = new CountingLibraryManager
        {
            GetItemListHook = query =>
            {
                if (query.ItemIds.Length > 0)
                {
                    return query.IncludeItemTypes.Contains(BaseItemKind.Episode)
                        ? [requestedEpisode]
                        : [series];
                }

                var startIndex = query.StartIndex ?? 0;
                var limit = query.Limit ?? int.MaxValue;
                pageStarts.Add(startIndex);
                Assert.Equal(256, limit);
                return libraryEpisodes.Skip(startIndex).Take(limit).ToArray();
            },
        };
        var provider = new FakeProvider
        {
            Episodes = AnimeProviderEpisodes.Create(42, new Dictionary<int, bool> { [258] = true }),
        };
        var controller = BuildController(EnabledConfig(), provider, library, user);

        var result = await controller.Classify(new AnimeFillerBatchRequest(
            [requestedEpisode.Id.ToString(), requestedEpisode.Id.ToString()]));

        var items = Assert.IsType<AnimeFillerBatchResponse>(Assert.IsType<OkObjectResult>(result).Value).Items;
        Assert.Equal(["Filler", "Filler"], items.Select(item => item.Classification));
        Assert.Equal([0, 256], pageStarts);
        Assert.Equal(4, library.GetItemListCallCount);
        Assert.Equal(1, provider.EpisodeCalls);
    }

    [Fact]
    public async Task Classification_CancellationStopsPagedSeriesWork_WithoutProviderDispatch()
    {
        using var cancellation = new CancellationTokenSource();
        var user = new User("anime-user", "provider", "password-provider");
        var series = AnimeSeries("Cancelled series", 52);
        var requestedEpisode = NumberedEpisode(series.Id, 2, 1);
        var recursiveCalls = 0;
        var library = new CountingLibraryManager
        {
            GetItemListHook = query =>
            {
                if (query.ItemIds.Length > 0)
                {
                    return query.IncludeItemTypes.Contains(BaseItemKind.Episode)
                        ? [requestedEpisode]
                        : [series];
                }

                recursiveCalls++;
                cancellation.Cancel();
                return Enumerable.Range(1, 256)
                    .Select(index => (BaseItem)NumberedEpisode(series.Id, 1, index))
                    .ToArray();
            },
        };
        var provider = new FakeProvider
        {
            Episodes = AnimeProviderEpisodes.Create(52, new Dictionary<int, bool> { [257] = true }),
        };
        var controller = BuildController(EnabledConfig(), provider, library, user, cancellation.Token);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => controller.Classify(
            new AnimeFillerBatchRequest([requestedEpisode.Id.ToString()])));

        Assert.Equal(1, recursiveCalls);
        Assert.Equal(0, provider.EpisodeCalls);
    }

    [Fact]
    public async Task Classification_BulkLookupFaultsKeepTheExistingUnknownResponseContract()
    {
        var user = new User("anime-user", "provider", "password-provider");
        var requestedId = Guid.NewGuid();
        var library = new CountingLibraryManager
        {
            GetItemListHook = _ => throw new IOException("library unavailable"),
        };
        var provider = new FakeProvider();
        var controller = BuildController(EnabledConfig(), provider, library, user);

        var result = await controller.Classify(new AnimeFillerBatchRequest([requestedId.ToString(), "invalid"]));

        var items = Assert.IsType<AnimeFillerBatchResponse>(Assert.IsType<OkObjectResult>(result).Value).Items;
        Assert.All(items, item => Assert.Equal("Unknown", item.Classification));
        Assert.All(items, item => Assert.Equal("unavailable", item.Reason));
        Assert.Equal(0, provider.EpisodeCalls);
    }

    [Fact]
    public async Task Classification_PartialLibrary_UsesUniqueExactProviderEpisodeTitle()
    {
        var user = new User("anime-user", "provider", "password-provider");
        var seriesId = Guid.NewGuid();
        var episodeId = Guid.NewGuid();
        var series = new Series
        {
            Id = seriesId,
            Name = "Naruto Shippuden",
            ProductionYear = 2007,
            Genres = ["Anime"],
        };
        series.ProviderIds["MyAnimeList"] = "1735";
        var episode = new Episode
        {
            Id = episodeId,
            SeriesId = seriesId,
            ParentIndexNumber = 9,
            IndexNumber = 1,
            Name = "Rookie Instructor Iruka",
        };
        var library = new CountingLibraryManager
        {
            GetItemListHook = query => query.ItemIds.Length > 0
                ? query.IncludeItemTypes.Contains(BaseItemKind.Episode) ? [episode] : [series]
                : [episode],
        };
        var provider = new FakeProvider
        {
            Episodes = AnimeProviderEpisodes.Create(
                1735,
                new Dictionary<int, bool> { [176] = true },
                new Dictionary<string, int> { ["rookie instructor iruka"] = 176 }),
        };
        var controller = BuildController(EnabledConfig(), provider, library, user);

        var result = await controller.Classify(new AnimeFillerBatchRequest([episodeId.ToString()]));

        var item = Assert.Single(Assert.IsType<AnimeFillerBatchResponse>(Assert.IsType<OkObjectResult>(result).Value).Items);
        Assert.Equal("Filler", item.Classification);
        Assert.Equal("mal-provider-id+episode-title-match", item.Reason);
        Assert.Equal(1, provider.EpisodeCalls);
    }

    [Fact]
    public async Task Classification_RejectsEmptyAndOverBoundPayloads_BeforeLibraryWork()
    {
        var user = new User("anime-user", "provider", "password-provider");
        var library = new CountingLibraryManager();
        var controller = BuildController(EnabledConfig(), new FakeProvider(), library, user);

        Assert.IsType<BadRequestObjectResult>(await controller.Classify(null));
        Assert.IsType<BadRequestObjectResult>(await controller.Classify(new AnimeFillerBatchRequest([])));
        Assert.IsType<BadRequestObjectResult>(await controller.Classify(
            new AnimeFillerBatchRequest(Enumerable.Range(0, 101).Select(_ => Guid.NewGuid().ToString()).ToArray())));
        Assert.Equal(0, library.GetItemByIdUserCallCount);
    }

    [Fact]
    public async Task Classification_WithoutResolvedCaller_FailsClosed()
    {
        var controller = BuildController(EnabledConfig(), new FakeProvider(), new CountingLibraryManager(), user: null);

        Assert.IsType<ForbidResult>(await controller.Classify(new AnimeFillerBatchRequest([Guid.NewGuid().ToString()])));
    }

    [Fact]
    public async Task Classification_ProviderIdOnly_RejectsMalformedProviderValuesWithoutSearch()
    {
        var user = new User("anime-user", "provider", "password-provider");
        var series = new Series { Id = Guid.NewGuid(), Name = "Private series title" };
        series.ProviderIds["MyAnimeList"] = "invalid";
        var episode = new Episode
        {
            Id = Guid.NewGuid(),
            SeriesId = series.Id,
            ParentIndexNumber = 1,
            IndexNumber = 1,
        };
        var library = new CountingLibraryManager
        {
            GetItemListHook = query => query.IncludeItemTypes.Contains(BaseItemKind.Episode) ? [episode] : [series],
        };
        var provider = new FakeProvider
        {
            Candidates = [new AnimeProviderCandidate(20, series.Name, 2003)],
        };
        var config = EnabledConfig();
        config.AnimeFillerDetectionMode = "ProviderIdOnly";
        var controller = BuildController(config, provider, library, user);

        var result = await controller.Classify(new AnimeFillerBatchRequest([episode.Id.ToString()]));

        var item = Assert.Single(Assert.IsType<AnimeFillerBatchResponse>(Assert.IsType<OkObjectResult>(result).Value).Items);
        Assert.Equal("Unknown", item.Classification);
        Assert.Equal("not-recognized-as-anime", item.Reason);
        Assert.Equal(0, provider.SearchCalls);
    }

    [Fact]
    public void Diagnostics_ReportsSanitizedConfiguration_AndUnavailableState()
    {
        var user = new User("anime-admin", "provider", "password-provider");
        var unavailable = BuildController(null, new FakeProvider(), new CountingLibraryManager(), user);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, Assert.IsType<StatusCodeResult>(unavailable.Diagnostics()).StatusCode);

        var config = EnabledConfig();
        config.AnimeFillerCacheHours = 999;
        config.AnimeFillerMappings = $"{Guid.NewGuid()}=20\ninvalid";
        var available = BuildController(config, new FakeProvider(), new CountingLibraryManager(), user);
        var json = JsonSerializer.Serialize(Assert.IsType<OkObjectResult>(available.Diagnostics()).Value);

        Assert.Contains("\"enabled\":true", json, StringComparison.Ordinal);
        Assert.Contains("\"cacheHours\":168", json, StringComparison.Ordinal);
        Assert.Contains("\"seriesMappings\":1", json, StringComparison.Ordinal);
        Assert.Contains("\"mappingErrors\":[", json, StringComparison.Ordinal);
        Assert.DoesNotContain("AnimeFillerMappings", json, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Search_ValidatesInput_BoundsResults_AndMapsProviderFailureTo503()
    {
        var user = new User("anime-admin", "provider", "password-provider");
        var provider = new FakeProvider
        {
            Candidates = Enumerable.Range(1, 12).Select(id => new AnimeProviderCandidate(id, $"Candidate {id}", 2000 + id)).ToArray(),
        };
        var controller = BuildController(EnabledConfig(), provider, new CountingLibraryManager(), user);

        Assert.IsType<BadRequestObjectResult>(await controller.Search(" "));
        Assert.IsType<BadRequestObjectResult>(await controller.Search(new string('x', 201)));
        var okJson = JsonSerializer.Serialize(Assert.IsType<OkObjectResult>(await controller.Search("Naruto")).Value);
        Assert.Contains("Candidate 10", okJson, StringComparison.Ordinal);
        Assert.DoesNotContain("Candidate 11", okJson, StringComparison.Ordinal);

        provider.SearchFailure = new HttpRequestException("offline");
        var failed = Assert.IsType<ObjectResult>(await controller.Search("Naruto"));
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, failed.StatusCode);
    }

    private static AnimeFillerWarningsController BuildController(
        PluginConfiguration? config,
        FakeProvider provider,
        CountingLibraryManager library,
        User? user,
        CancellationToken cancellationToken = default)
    {
        var configProvider = new FakePluginConfigProvider(config);
        var userManager = user is null ? new StubUserManager() : new StubUserManager(user);
        if (user is not null && library.ConfigureUserAccessHook is null)
        {
            library.ConfigureUserAccessHook = (_, resolvedUser) => Assert.Same(user, resolvedUser);
        }

        var service = new AnimeFillerService(provider, configProvider, NullLogger<AnimeFillerService>.Instance);
        var controller = new AnimeFillerWarningsController(
            new RecordingHttpClientFactory(new HttpClientHandler()),
            NullLogger<AnimeFillerWarningsController>.Instance,
            userManager,
            new SeerrCache(configProvider),
            configProvider,
            library,
            service,
            provider);
        var claims = user is null
            ? []
            : new[] { new Claim("Jellyfin-UserId", user.Id.ToString()) };
        controller.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity(claims, "TestAuth")),
                RequestAborted = cancellationToken,
            },
        };
        return controller;
    }

    private static PluginConfiguration EnabledConfig() => new()
    {
        AnimeFillerWarningsEnabled = true,
        AnimeFillerCacheHours = 24,
    };

    private static Series AnimeSeries(string name, int myAnimeListId)
    {
        var series = new Series
        {
            Id = Guid.NewGuid(),
            Name = name,
            Genres = ["Anime"],
        };
        series.ProviderIds["MyAnimeList"] = myAnimeListId.ToString(System.Globalization.CultureInfo.InvariantCulture);
        return series;
    }

    private static Episode NumberedEpisode(Guid seriesId, int season, int episode) => new()
    {
        Id = Guid.NewGuid(),
        SeriesId = seriesId,
        ParentIndexNumber = season,
        IndexNumber = episode,
    };

    private sealed class FakeProvider : IAnimeFillerProvider
    {
        public AnimeProviderEpisodes? Episodes { get; init; }

        public IReadOnlyDictionary<int, AnimeProviderEpisodes>? EpisodesByMalId { get; init; }

        public IReadOnlyList<AnimeProviderCandidate> Candidates { get; init; } = [];

        public Exception? SearchFailure { get; set; }

        public int EpisodeCalls { get; private set; }

        public int SearchCalls { get; private set; }

        public Task<int?> ResolveAniListIdAsync(int aniListId, CancellationToken cancellationToken)
            => Task.FromResult<int?>(null);

        public Task<IReadOnlyList<AnimeProviderCandidate>> SearchAsync(string title, CancellationToken cancellationToken)
        {
            SearchCalls++;
            return SearchFailure is null
                ? Task.FromResult(Candidates)
                : Task.FromException<IReadOnlyList<AnimeProviderCandidate>>(SearchFailure);
        }

        public Task<AnimeProviderEpisodes?> GetEpisodesAsync(int myAnimeListId, CancellationToken cancellationToken)
        {
            EpisodeCalls++;
            return Task.FromResult(
                EpisodesByMalId?.GetValueOrDefault(myAnimeListId)
                ?? Episodes);
        }
    }

    private static MethodInfo Method(string name) => typeof(AnimeFillerWarningsController).GetMethod(name)!;

    private static string ControllerPath([CallerFilePath] string sourceFile = "")
        => Path.GetFullPath(Path.Combine(
            Path.GetDirectoryName(sourceFile)!, "..", "..",
            "Jellyfin.Plugin.JellyfinCanopy", "Controllers", "AnimeFillerWarningsController.cs"));
}
