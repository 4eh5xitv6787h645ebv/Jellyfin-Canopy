using System.Net.Http;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinElevate.Configuration;
using Jellyfin.Plugin.JellyfinElevate.Model.Arr;
using Jellyfin.Plugin.JellyfinElevate.Services.Arr;
using Jellyfin.Plugin.JellyfinElevate.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.Services;

/// <summary>
/// Exercises the Search orchestration against a mocked Sonarr/Radarr, asserting the exact request
/// shapes the arr APIs require (command name/payload, grab body, monitor editors, add body). These
/// are the parts most likely to be silently wrong, and can't be covered by pure mapping tests.
/// </summary>
public class ArrActionServiceTests
{
    private static (ArrActionService Service, RecordingHttpMessageHandler Handler) NewService()
    {
        var handler = new RecordingHttpMessageHandler();
        var factory = new RecordingHttpClientFactory(handler);
        var fetch = new ArrFetchService(factory, NullLogger<ArrFetchService>.Instance);
        var resolver = new ArrTargetResolver(fetch);
        var service = new ArrActionService(fetch, resolver, NullLogger<ArrActionService>.Instance);
        return (service, handler);
    }

    private static PluginConfiguration RadarrConfig() => new()
    {
        RadarrInstances = """[{"Name":"movies","Url":"http://localhost:7878","ApiKey":"rk","Enabled":true}]""",
    };

    private static PluginConfiguration SonarrConfig() => new()
    {
        SonarrInstances = """[{"Name":"tv","Url":"http://localhost:8989","ApiKey":"sk","Enabled":true}]""",
    };

    private static ArrResolvedItem Movie() => new() { Kind = ArrMediaKind.Movie, TmdbId = 27205, Name = "Inception" };
    private static ArrResolvedItem Series() => new() { Kind = ArrMediaKind.Series, SeriesTvdbId = 81189, Name = "Breaking Bad" };
    private static ArrResolvedItem Episode() => new() { Kind = ArrMediaKind.Episode, SeriesTvdbId = 81189, SeasonNumber = 1, EpisodeNumber = 2, Name = "Cat's in the Bag" };

    private static JsonNode BodyOf(RecordingHttpMessageHandler h, HttpMethod method, string pathSuffix)
    {
        var sent = h.Sent.First(r => r.Method == method && r.Path.EndsWith(pathSuffix, StringComparison.Ordinal));
        return JsonNode.Parse(sent.Body)!;
    }

    // ── automatic search ─────────────────────────────────────────────────────

    [Fact]
    public async Task DispatchAutoSearch_Movie_PostsMoviesSearchCommand()
    {
        var (service, handler) = NewService();
        handler.AddResponse("/api/v3/movie", """[{"id":42,"monitored":true,"hasFile":false}]""");
        handler.AddResponse("/api/v3/command", """{"id":999,"status":"queued"}""");

        var result = await service.DispatchAutoSearchAsync(Movie(), RadarrConfig(), null, CancellationToken.None);

        var dispatched = Assert.Single(result.Dispatched);
        Assert.Equal("movies", dispatched.InstanceName);
        Assert.Equal(999, dispatched.CommandId);
        Assert.Equal("MoviesSearch", dispatched.CommandName);
        Assert.Empty(result.Errors);

        var body = BodyOf(handler, HttpMethod.Post, "/api/v3/command");
        Assert.Equal("MoviesSearch", (string?)body["name"]);
        Assert.Equal(42, (int?)body["movieIds"]!.AsArray()[0]);
    }

    [Fact]
    public async Task DispatchAutoSearch_MovieNotInInstance_ReportsNotTracked()
    {
        var (service, handler) = NewService();
        handler.AddResponse("/api/v3/movie", "[]"); // Radarr returns empty array when not found

        var result = await service.DispatchAutoSearchAsync(Movie(), RadarrConfig(), null, CancellationToken.None);

        Assert.Empty(result.Dispatched);
        Assert.Contains(result.Errors, e => e.Reason.Contains("not tracked"));
        // Never fires a search command when the item isn't present.
        Assert.DoesNotContain(handler.Sent, r => r.Path.EndsWith("/api/v3/command", StringComparison.Ordinal));
    }

    [Fact]
    public async Task DispatchAutoSearch_Episode_ResolvesEpisodeIdThenEpisodeSearch()
    {
        var (service, handler) = NewService();
        handler.AddResponse("/api/v3/series", """[{"id":7,"monitored":true,"seasons":[],"statistics":{"episodeFileCount":0}}]""");
        handler.AddResponse("/api/v3/episode", """[{"id":701,"seasonNumber":1,"episodeNumber":2,"monitored":true,"hasFile":false}]""");
        handler.AddResponse("/api/v3/command", """{"id":5}""");

        var result = await service.DispatchAutoSearchAsync(Episode(), SonarrConfig(), null, CancellationToken.None);

        Assert.Single(result.Dispatched);
        var body = BodyOf(handler, HttpMethod.Post, "/api/v3/command");
        Assert.Equal("EpisodeSearch", (string?)body["name"]);
        Assert.Equal(701, (int?)body["episodeIds"]!.AsArray()[0]);
    }

    // ── interactive search + grab ────────────────────────────────────────────

    [Fact]
    public async Task ListReleases_Movie_ReturnsNormalizedReleases()
    {
        var (service, handler) = NewService();
        handler.AddResponse("/api/v3/movie", """[{"id":42}]""");
        handler.AddResponse("/api/v3/release", """[{"guid":"g1","indexerId":4,"indexer":"NZBgeek","title":"Inception.2160p","quality":{"quality":{"name":"Bluray-2160p"}},"size":123,"protocol":"usenet","rejections":[]}]""");

        var list = await service.ListReleasesAsync(Movie(), RadarrConfig(), "movies", CancellationToken.None);

        Assert.Null(list.Error);
        var release = Assert.Single(list.Releases);
        Assert.Equal("g1", release.Guid);
        Assert.Equal("Bluray-2160p", release.Quality);
    }

    [Fact]
    public async Task Grab_PostsGuidAndIndexerId()
    {
        var (service, handler) = NewService();
        handler.AddResponse("/api/v3/release", "{}");

        var (ok, error) = await service.GrabAsync(RadarrConfig(), "radarr", "movies", "guid-xyz", 4, CancellationToken.None);

        Assert.True(ok);
        Assert.Null(error);
        var body = BodyOf(handler, HttpMethod.Post, "/api/v3/release");
        Assert.Equal("guid-xyz", (string?)body["guid"]);
        Assert.Equal(4, (int?)body["indexerId"]);
    }

    [Fact]
    public async Task Grab_UnknownInstance_FailsWithoutRequest()
    {
        var (service, handler) = NewService();
        var (ok, error) = await service.GrabAsync(RadarrConfig(), "radarr", "does-not-exist", "g", 1, CancellationToken.None);
        Assert.False(ok);
        Assert.Equal("instance not found", error);
        Assert.Empty(handler.Sent);
    }

    // ── monitor toggle ───────────────────────────────────────────────────────

    [Fact]
    public async Task SetMonitored_Movie_PutsMovieEditor()
    {
        var (service, handler) = NewService();
        handler.AddResponse("/api/v3/movie", """[{"id":42,"monitored":true}]""");
        handler.AddResponse("/api/v3/movie/editor", "{}");

        var result = await service.SetMonitoredAsync(Movie(), RadarrConfig(), monitored: false, null, CancellationToken.None);

        Assert.Single(result.Dispatched);
        var body = BodyOf(handler, HttpMethod.Put, "/api/v3/movie/editor");
        Assert.Equal(42, (int?)body["movieIds"]!.AsArray()[0]);
        Assert.False((bool?)body["monitored"]);
    }

    [Fact]
    public async Task SetMonitored_Episode_PutsEpisodeMonitor()
    {
        var (service, handler) = NewService();
        handler.AddResponse("/api/v3/series", """[{"id":7,"monitored":true}]""");
        handler.AddResponse("/api/v3/episode/monitor", "{}");
        handler.AddResponse("/api/v3/episode", """[{"id":701,"seasonNumber":1,"episodeNumber":2,"monitored":false}]""");

        var result = await service.SetMonitoredAsync(Episode(), SonarrConfig(), monitored: true, null, CancellationToken.None);

        Assert.Single(result.Dispatched);
        var body = BodyOf(handler, HttpMethod.Put, "/api/v3/episode/monitor");
        Assert.Equal(701, (int?)body["episodeIds"]!.AsArray()[0]);
        Assert.True((bool?)body["monitored"]);
    }

    // ── add ──────────────────────────────────────────────────────────────────

    [Fact]
    public async Task Add_Movie_LooksUpThenPostsWithChosenOptions()
    {
        var (service, handler) = NewService();
        handler.AddResponse("/api/v3/movie/lookup", """[{"tmdbId":27205,"title":"Inception","year":2010}]""");
        handler.AddResponse("/api/v3/movie", """{"id":88}""");

        var request = new ArrAddRequest("movies", QualityProfileId: 4, RootFolderPath: "/movies", Monitored: true, SearchOnAdd: true, Monitor: null, MinimumAvailability: "released");
        var (ok, error, arrId) = await service.AddAsync(Movie(), RadarrConfig(), request, CancellationToken.None);

        Assert.True(ok);
        Assert.Null(error);
        Assert.Equal(88, arrId);

        var body = BodyOf(handler, HttpMethod.Post, "/api/v3/movie");
        Assert.Equal(27205, (int?)body["tmdbId"]);
        Assert.Equal(4, (int?)body["qualityProfileId"]);
        Assert.Equal("/movies", (string?)body["rootFolderPath"]);
        Assert.Equal("released", (string?)body["minimumAvailability"]);
        Assert.True((bool?)body["addOptions"]!["searchForMovie"]);
    }

    [Fact]
    public async Task Add_RejectsMissingProfileOrRoot()
    {
        var (service, _) = NewService();
        var request = new ArrAddRequest("movies", QualityProfileId: 0, RootFolderPath: "", Monitored: true, SearchOnAdd: true, Monitor: null, MinimumAvailability: null);
        var (ok, error, _) = await service.AddAsync(Movie(), RadarrConfig(), request, CancellationToken.None);
        Assert.False(ok);
        Assert.Contains("required", error);
    }

    // ── context ──────────────────────────────────────────────────────────────

    [Fact]
    public async Task BuildContext_Movie_ReportsTargetAndNoAddable()
    {
        var (service, handler) = NewService();
        handler.AddResponse("/api/v3/movie", """[{"id":42,"monitored":true,"hasFile":true}]""");

        var ctx = await service.BuildContextAsync(Movie(), RadarrConfig(), CancellationToken.None);

        Assert.Equal("movie", ctx.Kind);
        Assert.Equal("radarr", ctx.Service);
        Assert.True(ctx.SupportsInteractive);
        var target = Assert.Single(ctx.Targets);
        Assert.Equal("movies", target.InstanceName);
        Assert.Equal(42, target.ArrId);
        Assert.True(target.HasFile);
        Assert.Empty(ctx.AddableInstances); // already present → not addable
    }

    [Fact]
    public async Task BuildContext_MovieNotPresent_ListsAddableInstance()
    {
        var (service, handler) = NewService();
        handler.AddResponse("/api/v3/movie", "[]");

        var ctx = await service.BuildContextAsync(Movie(), RadarrConfig(), CancellationToken.None);

        Assert.Empty(ctx.Targets);
        Assert.Equal(new[] { "movies" }, ctx.AddableInstances);
    }

    [Fact]
    public async Task BuildContext_Series_DoesNotSupportInteractive()
    {
        var (service, handler) = NewService();
        handler.AddResponse("/api/v3/series", """[{"id":7,"monitored":true,"statistics":{"episodeFileCount":10}}]""");

        var ctx = await service.BuildContextAsync(Series(), SonarrConfig(), CancellationToken.None);

        Assert.Equal("series", ctx.Kind);
        Assert.False(ctx.SupportsInteractive);
        Assert.Single(ctx.Targets);
    }
}
