using System.Net;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Tests.TestDoubles;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinEnhanced.Tests.Services;

/// <summary>
/// Covers the merged Sonarr/Radarr tag-fetch logic in <see cref="ArrTagService"/>:
/// the SSRF guard must reject bad instance URLs BEFORE any outbound request, the
/// tag-mapping logic must key results by the right provider id per *arr type, and
/// the HTTP plumbing must use the named arr client with per-request auth headers.
/// </summary>
public class ArrTagServiceTests
{
    private readonly ILogger _logger = NullLogger.Instance;

    private static ArrTagService CreateService(RecordingHttpMessageHandler handler, ILogger logger)
        => new ArrTagService(new RecordingHttpClientFactory(handler), logger);

    // ─── SSRF guard ──────────────────────────────────────────────────────────

    [Theory]
    [InlineData("http://169.254.169.254:7878")]          // AWS/GCP metadata IP
    [InlineData("http://169.254.170.2")]                  // ECS task metadata
    [InlineData("http://[::ffff:169.254.169.254]:8989")]  // IPv6-mapped metadata IP
    [InlineData("http://metadata.google.internal")]       // GCP metadata hostname
    [InlineData("ftp://radarr.example.com")]              // non-http(s) scheme
    [InlineData("not a url")]
    [InlineData("")]
    public async Task GetMovieTags_BlockedUrl_ReturnsEmptyWithoutAnyRequest(string url)
    {
        var handler = new RecordingHttpMessageHandler();
        var service = CreateService(handler, _logger);

        var result = await service.GetMovieTagsByTmdbId(url, "key");

        Assert.Empty(result);
        Assert.Empty(handler.Requests); // guard must fire BEFORE any outbound call
    }

    [Fact]
    public async Task GetSeriesTags_BlockedUrl_ReturnsEmptyWithoutAnyRequest()
    {
        var handler = new RecordingHttpMessageHandler();
        var service = CreateService(handler, _logger);

        var result = await service.GetSeriesTagsAsync("http://169.254.169.254:8989", "key");

        Assert.Empty(result.ByTvdbId);
        Assert.Empty(result.ByImdbId);
        Assert.Empty(handler.Requests);
    }

    // ─── Endpoint + mapping behavior ─────────────────────────────────────────

    [Fact]
    public async Task GetMovieTags_MapsLabelsByTmdbId_AndSkipsUnkeyedOrUntaggedItems()
    {
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse("/api/v3/tag", """[{"id":1,"label":"alice"},{"id":2,"label":"bob"}]""");
        handler.AddResponse("/api/v3/movie", """
            [
              {"id":10,"title":"Keyed",     "tmdbId":100, "tags":[1,2]},
              {"id":11,"title":"NoTmdb",    "tmdbId":0,   "tags":[1]},
              {"id":12,"title":"NoTags",    "tmdbId":200, "tags":[]},
              {"id":13,"title":"UnknownTag","tmdbId":300, "tags":[99]}
            ]
            """);
        var service = CreateService(handler, _logger);

        var result = await service.GetMovieTagsByTmdbId("http://localhost:7878/", "api-key");

        var only = Assert.Single(result);
        Assert.Equal(100, only.Key);
        Assert.Equal(new[] { "alice", "bob" }, only.Value);

        Assert.Equal(2, handler.Requests.Count);
        Assert.Equal("http://localhost:7878/api/v3/tag", handler.Requests[0].RequestUri!.ToString());
        Assert.Equal("http://localhost:7878/api/v3/movie", handler.Requests[1].RequestUri!.ToString());
        Assert.Equal("api-key", Assert.Single(handler.ApiKeyHeaders.Distinct()));
    }

    [Fact]
    public async Task GetSeriesTags_MapsLabelsByTvdbId_AndImdbFallback()
    {
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse("/api/v3/tag", """[{"id":1,"label":"alice"}]""");
        handler.AddResponse("/api/v3/series", """
            [
              {"id":20,"title":"Keyed",  "tvdbId":5000,"imdbId":"tt0000001","tags":[1]},
              {"id":21,"title":"NoImdb", "tvdbId":5001,"imdbId":null,       "tags":[1]}
            ]
            """);
        var service = CreateService(handler, _logger);

        var result = await service.GetSeriesTagsAsync("http://localhost:8989", "api-key");

        // TVDB is the canonical key: BOTH series map by TVDB, including the IMDb-less one
        // that the former IMDb-only keying silently dropped.
        Assert.Equal(2, result.ByTvdbId.Count);
        Assert.Equal(new[] { "alice" }, result.ByTvdbId[5000]);
        Assert.Equal(new[] { "alice" }, result.ByTvdbId[5001]);

        // The IMDb fallback map carries only the series that has an IMDb id.
        var imdb = Assert.Single(result.ByImdbId);
        Assert.Equal("tt0000001", imdb.Key);
        Assert.Equal(new[] { "alice" }, imdb.Value);

        Assert.Equal("http://localhost:8989/api/v3/series", handler.Requests[1].RequestUri!.ToString());
    }

    [Fact]
    public async Task GetMovieTags_TagEndpointFails_ReturnsEmptyAndSkipsMediaFetch()
    {
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse("/api/v3/tag", "boom", HttpStatusCode.InternalServerError);
        var service = CreateService(handler, _logger);

        var result = await service.GetMovieTagsByTmdbId("http://localhost:7878", "key");

        Assert.Empty(result);
        Assert.Single(handler.Requests); // never reached /api/v3/movie
    }

    [Fact]
    public async Task GetMovieTags_InvalidJson_ReturnsEmptyInsteadOfThrowing()
    {
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse("/api/v3/tag", "<html>not json</html>");
        var service = CreateService(handler, _logger);

        var result = await service.GetMovieTagsByTmdbId("http://localhost:7878", "key");

        Assert.Empty(result);
    }

    // ─── HTTP plumbing hygiene ───────────────────────────────────────────────

    [Fact]
    public async Task GetMovieTags_UsesNamedArrClient_WithPerRequestApiKey_AndNoDefaultHeaders()
    {
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse("/api/v3/tag", """[{"id":1,"label":"alice"}]""");
        handler.AddResponse("/api/v3/movie", """[{"id":10,"title":"Keyed","tmdbId":100,"tags":[1]}]""");
        var factory = new RecordingHttpClientFactory(handler);
        var service = new ArrTagService(factory, _logger);

        await service.GetMovieTagsByTmdbId("http://localhost:7878", "api-key");

        // The service must ask for the named arr client, not the unnamed default.
        Assert.Equal(PluginHttpClients.ArrClient, Assert.Single(factory.RequestedNames.Distinct()));

        // The API key must land on each request at send time...
        Assert.Equal(new[] { "api-key", "api-key" }, handler.ApiKeyHeaders);

        // ...and NEVER on the factory client's DefaultRequestHeaders.
        Assert.All(factory.CreatedClients, c => Assert.Empty(c.DefaultRequestHeaders));

        // Timeout deviation check: this service relies on the named client's
        // default (100s) rather than setting a shorter ad-hoc value.
        Assert.All(factory.CreatedClients, c => Assert.Equal(TimeSpan.FromSeconds(100), c.Timeout));
    }
}
