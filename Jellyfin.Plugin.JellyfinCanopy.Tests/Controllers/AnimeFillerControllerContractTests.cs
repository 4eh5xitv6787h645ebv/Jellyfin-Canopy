using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Claims;
using System.Text.Json;
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
        Assert.Contains("GetItemById<BaseItem>(itemId, user)", source, StringComparison.Ordinal);
        Assert.Contains("GetItemById<BaseItem>(episode.SeriesId, user)", source, StringComparison.Ordinal);
        Assert.DoesNotContain("GetItemById<BaseItem>(itemId)", source, StringComparison.Ordinal);
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
            GetItemByIdUserHook = (id, resolvedUser) =>
            {
                Assert.Equal(user.Id, resolvedUser?.Id);
                return id == episodeId ? episode : id == seriesId ? series : null;
            },
            GetItemListHook = _ =>
            [
                new Episode { SeriesId = seriesId, ParentIndexNumber = 1, IndexNumber = 12 },
                episode,
            ],
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
        Assert.Equal(2, library.GetItemByIdUserCallCount);
        Assert.Equal(1, library.GetItemListCallCount);
        Assert.Equal(1, provider.EpisodeCalls);
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
            GetItemByIdUserHook = (id, _) => id == episodeId ? episode : id == seriesId ? series : null,
            GetItemListHook = _ => [episode],
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
            GetItemByIdUserHook = (id, _) => id == episode.Id ? episode : id == series.Id ? series : null,
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
        User? user)
    {
        var configProvider = new FakePluginConfigProvider(config);
        var userManager = user is null ? new StubUserManager() : new StubUserManager(user);
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
            },
        };
        return controller;
    }

    private static PluginConfiguration EnabledConfig() => new()
    {
        AnimeFillerWarningsEnabled = true,
        AnimeFillerCacheHours = 24,
    };

    private sealed class FakeProvider : IAnimeFillerProvider
    {
        public AnimeProviderEpisodes? Episodes { get; init; }

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
            return Task.FromResult(Episodes);
        }
    }

    private static MethodInfo Method(string name) => typeof(AnimeFillerWarningsController).GetMethod(name)!;

    private static string ControllerPath([CallerFilePath] string sourceFile = "")
        => Path.GetFullPath(Path.Combine(
            Path.GetDirectoryName(sourceFile)!, "..", "..",
            "Jellyfin.Plugin.JellyfinCanopy", "Controllers", "AnimeFillerWarningsController.cs"));
}
