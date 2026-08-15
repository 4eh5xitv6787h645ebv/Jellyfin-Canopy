using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Services.Awards;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers;

public sealed class AwardsControllerTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "jc-awards-controller-" + Guid.NewGuid().ToString("N"));

    [Fact]
    public async Task GetAwards_UsesUserScopedItemAndKeepsMovieSeriesProvidersIsolated()
    {
        var itemId = Guid.NewGuid();
        var seriesId = Guid.NewGuid();
        var user = new User("viewer", "provider", "password") { Id = Guid.NewGuid() };
        var library = new CountingLibraryManager
        {
            GetItemByIdUserHook = (id, scopedUser) => scopedUser?.Id != user.Id
                ? null
                : id == itemId
                    ? new Movie
                    {
                        Id = itemId,
                        ProviderIds = new Dictionary<string, string> { ["Tmdb"] = "42" },
                    }
                    : id == seriesId
                        ? new Series
                        {
                            Id = seriesId,
                            ProviderIds = new Dictionary<string, string> { ["Tmdb"] = "42" },
                        }
                        : null,
        };
        var service = await BuildIndexAsync(
            new AwardsSourceRecord("Q1", AwardsMediaKind.Movie, "tmdb", "42", "Movie Award", 2024, AwardOutcome.Win),
            new AwardsSourceRecord("Q2", AwardsMediaKind.Series, "tmdb", "42", "Series Award", 2023, AwardOutcome.Win));
        var controller = BuildController(user, library, service, enabled: true);

        var result = controller.GetAwards(itemId);

        var ok = Assert.IsType<OkObjectResult>(result.Result);
        var payload = Assert.IsType<AwardsResponse>(ok.Value);
        Assert.Equal([new AwardResponse("Movie Award", 2024)], payload.Wins);
        Assert.Empty(payload.Nominations);
        Assert.Equal(1, library.GetItemByIdUserCallCount);
        var json = JsonSerializer.Serialize(payload);
        Assert.Equal("{\"wins\":[{\"name\":\"Movie Award\",\"year\":2024}],\"nominations\":[]}", json);
        Assert.DoesNotContain("tmdb", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Q1", json, StringComparison.Ordinal);
        Assert.DoesNotContain(_root, json, StringComparison.Ordinal);

        var seriesOk = Assert.IsType<OkObjectResult>(controller.GetAwards(seriesId).Result);
        var seriesPayload = Assert.IsType<AwardsResponse>(seriesOk.Value);
        Assert.Equal([new AwardResponse("Series Award", 2023)], seriesPayload.Wins);
        Assert.DoesNotContain(seriesPayload.Wins, award => award.Name == "Movie Award");
        Assert.Equal(2, library.GetItemByIdUserCallCount);
    }

    [Fact]
    public async Task GetAwards_ReturnsNotFoundForDisabledMissingIdentityOrInaccessibleItem()
    {
        var itemId = Guid.NewGuid();
        var user = new User("viewer", "provider", "password") { Id = Guid.NewGuid() };
        var library = new CountingLibraryManager { GetItemByIdUserHook = (_, _) => null };
        var service = await BuildIndexAsync(
            new AwardsSourceRecord("Q1", AwardsMediaKind.Series, "tmdb", "42", "Series Award", 2024, AwardOutcome.Win));

        var disabled = BuildController(user, library, service, enabled: false);
        Assert.IsType<NotFoundResult>(disabled.GetAwards(itemId).Result);
        Assert.Equal(0, library.GetItemByIdUserCallCount);

        var noIdentity = BuildController(user, library, service, enabled: true, includeIdentity: false);
        Assert.IsType<NotFoundResult>(noIdentity.GetAwards(itemId).Result);
        Assert.Equal(0, library.GetItemByIdUserCallCount);

        var inaccessible = BuildController(user, library, service, enabled: true);
        Assert.IsType<NotFoundResult>(inaccessible.GetAwards(itemId).Result);
        Assert.Equal(1, library.GetItemByIdUserCallCount);
    }

    [Fact]
    public async Task GetAwards_RejectsUnsupportedItemTypesBeforeIndexLookup()
    {
        var itemId = Guid.NewGuid();
        var user = new User("viewer", "provider", "password") { Id = Guid.NewGuid() };
        var library = new CountingLibraryManager
        {
            GetItemByIdUserHook = (_, _) => new MediaBrowser.Controller.Entities.Folder { Id = itemId },
        };
        var service = await BuildIndexAsync();
        var controller = BuildController(user, library, service, enabled: true);

        Assert.IsType<NotFoundResult>(controller.GetAwards(itemId).Result);
    }

    private async Task<AwardsIndexService> BuildIndexAsync(params AwardsSourceRecord[] records)
    {
        var service = new AwardsIndexService(
            new FixedSource(records),
            NullLogger<AwardsIndexService>.Instance,
            Path.Combine(_root, Guid.NewGuid().ToString("N"), "index.json"));
        Assert.True(await service.RefreshAsync(CancellationToken.None));
        return service;
    }

    private static AwardsController BuildController(
        User user,
        CountingLibraryManager library,
        AwardsIndexService service,
        bool enabled,
        bool includeIdentity = true)
    {
        var controller = new AwardsController(
            new StubUserManager(user),
            library,
            new FakePluginConfigProvider(new PluginConfiguration { AwardsEnabled = enabled }),
            service);
        var claims = includeIdentity
            ? new[] { new Claim("Jellyfin-UserId", user.Id.ToString()) }
            : Array.Empty<Claim>();
        controller.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity(claims, "TestAuth")),
            },
        };
        return controller;
    }

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }

    private sealed class FixedSource(IReadOnlyList<AwardsSourceRecord> records) : IAwardsSourceClient
    {
        public Task<AwardsSourceSnapshot> FetchCompleteAsync(CancellationToken cancellationToken)
            => Task.FromResult(new AwardsSourceSnapshot(records));
    }
}
