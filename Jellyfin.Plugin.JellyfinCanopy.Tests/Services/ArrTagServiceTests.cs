using System.Net;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Jellyfin.Plugin.JellyfinCanopy.Services.Arr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

/// <summary>
/// Covers the merged Sonarr/Radarr tag-fetch logic in <see cref="ArrTagService"/>:
/// the SSRF guard must reject bad instance URLs BEFORE any outbound request, the
/// tag-mapping logic must key results by the right provider id per *arr type, and
/// the HTTP plumbing must use the named arr client with per-request auth headers.
/// </summary>
public class ArrTagServiceTests
{
    private readonly ILogger _logger = NullLogger.Instance;

    private static ArrTagService CreateService(HttpMessageHandler handler, ILogger logger)
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
    public async Task GetMovieTags_BlockedUrl_ReturnsFailedWithoutAnyRequest(string url)
    {
        var handler = new RecordingHttpMessageHandler();
        var service = CreateService(handler, _logger);

        var result = await service.GetMovieTagsByTmdbId(url, "key");

        Assert.False(result.IsComplete);
        Assert.Empty(result.Value);
        Assert.Equal("Radarr URL was rejected by the SSRF guard.", result.FailureReason);
        if (!string.IsNullOrEmpty(url))
        {
            Assert.DoesNotContain(url, result.FailureReason, StringComparison.Ordinal);
        }

        Assert.DoesNotContain("key", result.FailureReason, StringComparison.Ordinal);
        Assert.Empty(handler.Requests); // guard must fire BEFORE any outbound call
    }

    [Fact]
    public async Task GetSeriesTags_BlockedUrl_ReturnsFailedWithoutAnyRequest()
    {
        var handler = new RecordingHttpMessageHandler();
        var service = CreateService(handler, _logger);

        var result = await service.GetSeriesTagsAsync("http://169.254.169.254:8989", "key");

        Assert.False(result.IsComplete);
        Assert.Empty(result.Value.ByTvdbId);
        Assert.Empty(result.Value.ByImdbId);
        Assert.Equal("Sonarr URL was rejected by the SSRF guard.", result.FailureReason);
        Assert.Empty(handler.Requests);
    }

    // ─── Endpoint + mapping behavior ─────────────────────────────────────────

    [Fact]
    public async Task GetMovieTags_MapsLabelsByTmdbId_AndSkipsUntaggedItems()
    {
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse("/api/v3/tag", """[{"id":1,"label":"alice"},{"id":2,"label":"bob"}]""");
        handler.AddResponse("/api/v3/movie", """
            [
              {"id":10,"title":"Keyed",     "tmdbId":100, "tags":[1,2]},
              {"id":11,"title":"NoTags",    "tmdbId":200, "tags":[]}
            ]
            """);
        var service = CreateService(handler, _logger);

        var result = await service.GetMovieTagsByTmdbId("http://localhost:7878/", "api-key");

        Assert.True(result.IsComplete);
        Assert.Null(result.FailureReason);
        var only = Assert.Single(result.Value);
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

        Assert.True(result.IsComplete);
        Assert.Null(result.FailureReason);

        // TVDB is the canonical key: BOTH series map by TVDB, including the IMDb-less one
        // that the former IMDb-only keying silently dropped.
        Assert.Equal(2, result.Value.ByTvdbId.Count);
        Assert.Equal(new[] { "alice" }, result.Value.ByTvdbId[5000]);
        Assert.Equal(new[] { "alice" }, result.Value.ByTvdbId[5001]);

        // The IMDb fallback map carries only the series that has an IMDb id.
        var imdb = Assert.Single(result.Value.ByImdbId);
        Assert.Equal("tt0000001", imdb.Key);
        Assert.Equal(new[] { "alice" }, imdb.Value);

        Assert.Equal("http://localhost:8989/api/v3/series", handler.Requests[1].RequestUri!.ToString());
    }

    [Fact]
    public async Task GetMovieTags_DuplicateProviderIdentity_UnionsLabelsWithoutDroppingEitherEntry()
    {
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse("/api/v3/tag", """[{"id":1,"label":"one"},{"id":2,"label":"two"}]""");
        handler.AddResponse("/api/v3/movie", """
            [
              {"id":10,"tmdbId":100,"tags":[1]},
              {"id":11,"tmdbId":100,"tags":[2]}
            ]
            """);
        var service = CreateService(handler, _logger);

        var result = await service.GetMovieTagsByTmdbId("http://localhost:7878", "key");

        Assert.True(result.IsComplete);
        Assert.Equal(new[] { "one", "two" }, Assert.Single(result.Value).Value);
    }

    [Fact]
    public async Task GetSeriesTags_DuplicateProviderIdentity_UnionsLabelsInBothMaps()
    {
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse("/api/v3/tag", """[{"id":1,"label":"one"},{"id":2,"label":"two"}]""");
        handler.AddResponse("/api/v3/series", """
            [
              {"id":10,"tvdbId":500,"imdbId":"tt500","tags":[1]},
              {"id":11,"tvdbId":500,"imdbId":"tt500","tags":[2]}
            ]
            """);
        var service = CreateService(handler, _logger);

        var result = await service.GetSeriesTagsAsync("http://localhost:8989", "key");

        Assert.True(result.IsComplete);
        Assert.Equal(new[] { "one", "two" }, result.Value.ByTvdbId[500]);
        Assert.Equal(new[] { "one", "two" }, result.Value.ByImdbId["tt500"]);
    }

    [Fact]
    public async Task GetMovieTags_TagEndpointReturns500_ReturnsFailedAndSkipsMediaFetch()
    {
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse("/api/v3/tag", "boom", HttpStatusCode.InternalServerError);
        var service = CreateService(handler, _logger);

        var result = await service.GetMovieTagsByTmdbId("http://localhost:7878", "key");

        Assert.False(result.IsComplete);
        Assert.Empty(result.Value);
        Assert.Equal("Radarr tag request returned HTTP 500.", result.FailureReason);
        Assert.Single(handler.Requests); // never reached /api/v3/movie
    }

    [Fact]
    public async Task GetMovieTags_TagEndpointReturnsPartialContent_ReturnsFailedAndSkipsMediaFetch()
    {
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse("/api/v3/tag", "[]", HttpStatusCode.PartialContent);
        var service = CreateService(handler, _logger);

        var result = await service.GetMovieTagsByTmdbId("http://localhost:7878", "key");

        Assert.False(result.IsComplete);
        Assert.Empty(result.Value);
        Assert.Equal("Radarr tag request returned HTTP 206.", result.FailureReason);
        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task GetMovieTags_InvalidJson_ReturnsFailedInsteadOfThrowing()
    {
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse("/api/v3/tag", "<html>not json</html>");
        var service = CreateService(handler, _logger);

        var result = await service.GetMovieTagsByTmdbId("http://localhost:7878", "key");

        Assert.False(result.IsComplete);
        Assert.Empty(result.Value);
        Assert.Equal("Radarr returned malformed JSON.", result.FailureReason);
    }

    [Fact]
    public async Task GetMovieTags_ValidEmptyCollections_ReturnsCompleteEmptySnapshot()
    {
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse("/api/v3/tag", "[]");
        handler.AddResponse("/api/v3/movie", "[]");
        var service = CreateService(handler, _logger);

        var result = await service.GetMovieTagsByTmdbId("http://localhost:7878", "key");

        Assert.True(result.IsComplete);
        Assert.Empty(result.Value);
        Assert.Null(result.FailureReason);
        Assert.Equal(2, handler.Requests.Count);
    }

    [Fact]
    public async Task GetSeriesTags_ValidEmptyCollections_ReturnsCompleteEmptySnapshot()
    {
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse("/api/v3/tag", "[]");
        handler.AddResponse("/api/v3/series", "[]");
        var service = CreateService(handler, _logger);

        var result = await service.GetSeriesTagsAsync("http://localhost:8989", "key");

        Assert.True(result.IsComplete);
        Assert.Empty(result.Value.ByTvdbId);
        Assert.Empty(result.Value.ByImdbId);
        Assert.Null(result.FailureReason);
        Assert.Equal(2, handler.Requests.Count);
    }

    [Fact]
    public async Task GetSeriesTags_MediaEndpointReturns500_ReturnsFailedEmptySnapshot()
    {
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse("/api/v3/tag", "[]");
        handler.AddResponse("/api/v3/series", "boom", HttpStatusCode.InternalServerError);
        var service = CreateService(handler, _logger);

        var result = await service.GetSeriesTagsAsync("http://localhost:8989", "key");

        Assert.False(result.IsComplete);
        Assert.Empty(result.Value.ByTvdbId);
        Assert.Empty(result.Value.ByImdbId);
        Assert.Equal("Sonarr series request returned HTTP 500.", result.FailureReason);
        Assert.Equal(2, handler.Requests.Count);
    }

    [Fact]
    public async Task GetSeriesTags_MediaEndpointReturnsPartialContent_ReturnsFailedEmptySnapshot()
    {
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse("/api/v3/tag", "[]");
        handler.AddResponse("/api/v3/series", "[]", HttpStatusCode.PartialContent);
        var service = CreateService(handler, _logger);

        var result = await service.GetSeriesTagsAsync("http://localhost:8989", "key");

        Assert.False(result.IsComplete);
        Assert.Empty(result.Value.ByTvdbId);
        Assert.Empty(result.Value.ByImdbId);
        Assert.Equal("Sonarr series request returned HTTP 206.", result.FailureReason);
        Assert.Equal(2, handler.Requests.Count);
    }

    [Theory]
    [InlineData("null")]
    [InlineData("[null]")]
    [InlineData("{}")]
    public async Task GetMovieTags_NonCollectionJson_ReturnsFailedEmptySnapshot(string json)
    {
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse("/api/v3/tag", json);
        var service = CreateService(handler, _logger);

        var result = await service.GetMovieTagsByTmdbId("http://localhost:7878", "key");

        Assert.False(result.IsComplete);
        Assert.Empty(result.Value);
        Assert.Equal("Radarr returned malformed JSON.", result.FailureReason);
        Assert.Single(handler.Requests);
    }

    [Theory]
    [InlineData("[{\"id\":1}]", "Radarr returned malformed JSON.")]
    [InlineData("[{\"id\":1,\"label\":null}]", "Radarr snapshot was inconsistent: tag entries require unique positive ids and non-blank labels.")]
    [InlineData("[{\"id\":1,\"label\":\"\"}]", "Radarr snapshot was inconsistent: tag entries require unique positive ids and non-blank labels.")]
    [InlineData("[{\"id\":1,\"label\":\"   \"}]", "Radarr snapshot was inconsistent: tag entries require unique positive ids and non-blank labels.")]
    [InlineData("[{\"label\":\"missing-id\"}]", "Radarr returned malformed JSON.")]
    [InlineData("[{\"id\":0,\"label\":\"invalid-id\"}]", "Radarr snapshot was inconsistent: tag entries require unique positive ids and non-blank labels.")]
    public async Task GetMovieTags_InvalidTagEntry_ReturnsFailedEmptySnapshot(
        string tagsJson,
        string expectedFailureReason)
    {
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse("/api/v3/tag", tagsJson);
        var service = CreateService(handler, _logger);

        var result = await service.GetMovieTagsByTmdbId("http://localhost:7878", "key");

        Assert.False(result.IsComplete);
        Assert.Empty(result.Value);
        Assert.Equal(expectedFailureReason, result.FailureReason);
        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task GetMovieTags_DuplicateTagId_ReturnsInconsistentSnapshot()
    {
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse("/api/v3/tag",
            """[{"id":1,"label":"one"},{"id":1,"label":"duplicate"}]""");
        var service = CreateService(handler, _logger);

        var result = await service.GetMovieTagsByTmdbId("http://localhost:7878", "key");

        Assert.False(result.IsComplete);
        Assert.Empty(result.Value);
        Assert.Equal(
            "Radarr snapshot was inconsistent: tag entries require unique positive ids and non-blank labels.",
            result.FailureReason);
        Assert.Single(handler.Requests);
    }

    [Theory]
    [InlineData("[{\"id\":10,\"tmdbId\":100}]", "Radarr returned malformed JSON.")]
    [InlineData("[{\"id\":10,\"tmdbId\":100,\"tags\":null}]", "Radarr snapshot was inconsistent: media entries require a non-null tags collection.")]
    public async Task GetMovieTags_InvalidMediaTags_ReturnsFailedEmptySnapshot(
        string mediaJson,
        string expectedFailureReason)
    {
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse("/api/v3/tag", "[]");
        handler.AddResponse("/api/v3/movie", mediaJson);
        var service = CreateService(handler, _logger);

        var result = await service.GetMovieTagsByTmdbId("http://localhost:7878", "key");

        Assert.False(result.IsComplete);
        Assert.Empty(result.Value);
        Assert.Equal(expectedFailureReason, result.FailureReason);
        Assert.Equal(2, handler.Requests.Count);
    }

    [Fact]
    public async Task GetMovieTags_UnknownTagReference_ReturnsFailedEmptySnapshot()
    {
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse("/api/v3/tag", """[{"id":1,"label":"known"}]""");
        handler.AddResponse("/api/v3/movie", """[{"id":10,"tmdbId":100,"tags":[1,99]}]""");
        var service = CreateService(handler, _logger);

        var result = await service.GetMovieTagsByTmdbId("http://localhost:7878", "key");

        Assert.False(result.IsComplete);
        Assert.Empty(result.Value);
        Assert.Equal(
            "Radarr snapshot was inconsistent: media entries referenced an unknown tag id.",
            result.FailureReason);
        Assert.Equal(2, handler.Requests.Count);
    }

    [Theory]
    [InlineData("[{\"id\":10,\"tmdbId\":0,\"tags\":[1]}]")]
    [InlineData("[{\"id\":10,\"tags\":[1]}]")]
    [InlineData("[{\"id\":10,\"tmdbId\":0,\"tags\":[]}]")]
    [InlineData("[{\"id\":10,\"tags\":[]}]")]
    public async Task GetMovieTags_MovieWithoutTmdbId_ReturnsFailedEmptySnapshot(string mediaJson)
    {
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse("/api/v3/tag", """[{"id":1,"label":"known"}]""");
        handler.AddResponse("/api/v3/movie", mediaJson);
        var service = CreateService(handler, _logger);

        var result = await service.GetMovieTagsByTmdbId("http://localhost:7878", "key");

        Assert.False(result.IsComplete);
        Assert.Empty(result.Value);
        Assert.Equal(
            "Radarr snapshot was inconsistent: movie entries require a positive TMDB id.",
            result.FailureReason);
    }

    [Theory]
    [InlineData("[{\"id\":10,\"tvdbId\":0,\"imdbId\":null,\"tags\":[1]}]")]
    [InlineData("[{\"id\":10,\"tvdbId\":0,\"imdbId\":\"tt0000010\",\"tags\":[1]}]")]
    [InlineData("[{\"id\":10,\"tags\":[1]}]")]
    [InlineData("[{\"id\":10,\"tvdbId\":0,\"imdbId\":\"tt0000010\",\"tags\":[]}]")]
    [InlineData("[{\"id\":10,\"tags\":[]}]")]
    public async Task GetSeriesTags_SeriesWithoutTvdbId_ReturnsFailedEmptySnapshot(string mediaJson)
    {
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse("/api/v3/tag", """[{"id":1,"label":"known"}]""");
        handler.AddResponse("/api/v3/series", mediaJson);
        var service = CreateService(handler, _logger);

        var result = await service.GetSeriesTagsAsync("http://localhost:8989", "key");

        Assert.False(result.IsComplete);
        Assert.Empty(result.Value.ByTvdbId);
        Assert.Empty(result.Value.ByImdbId);
        Assert.Equal(
            "Sonarr snapshot was inconsistent: series entries require a positive TVDB id.",
            result.FailureReason);
    }

    [Fact]
    public async Task GetMovieTags_NetworkFailure_ReturnsFailedWithSafeReason()
    {
        var handler = new ExceptionHttpMessageHandler(new HttpRequestException("secret network detail"));
        var service = CreateService(handler, _logger);

        var result = await service.GetMovieTagsByTmdbId("http://localhost:7878", "api-secret");

        Assert.False(result.IsComplete);
        Assert.Empty(result.Value);
        Assert.Equal("Radarr request failed.", result.FailureReason);
        Assert.DoesNotContain("secret", result.FailureReason, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task GetMovieTags_Timeout_ReturnsFailedWithSafeReason()
    {
        var handler = new ExceptionHttpMessageHandler(new TaskCanceledException("secret timeout detail"));
        var service = CreateService(handler, _logger);

        var result = await service.GetMovieTagsByTmdbId("http://localhost:7878", "api-secret");

        Assert.False(result.IsComplete);
        Assert.Empty(result.Value);
        Assert.Equal("Radarr request timed out.", result.FailureReason);
        Assert.DoesNotContain("secret", result.FailureReason, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task GetMovieTags_UnexpectedFailure_ReturnsFailedWithSafeReason()
    {
        var handler = new ExceptionHttpMessageHandler(new InvalidOperationException("secret internal detail"));
        var service = CreateService(handler, _logger);

        var result = await service.GetMovieTagsByTmdbId("http://localhost:7878", "api-secret");

        Assert.False(result.IsComplete);
        Assert.Empty(result.Value);
        Assert.Equal("Unexpected error while fetching Radarr tag snapshot.", result.FailureReason);
        Assert.DoesNotContain("secret", result.FailureReason, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task GetMovieTags_CallerCancellation_StillThrows()
    {
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        var service = CreateService(new CancellationAwareHttpMessageHandler(), _logger);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => service.GetMovieTagsByTmdbId("http://localhost:7878", "key", cts.Token));
    }

    [Fact]
    public async Task GetMovieTags_PreCancelledToken_StopsBeforeUrlPreflightOrRequest()
    {
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        var handler = new RecordingHttpMessageHandler();
        var service = CreateService(handler, _logger);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => service.GetMovieTagsByTmdbId("http://arr.example.test:7878", "key", cts.Token));

        Assert.Empty(handler.Requests);
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

    private sealed class ExceptionHttpMessageHandler : HttpMessageHandler
    {
        private readonly Exception _exception;

        public ExceptionHttpMessageHandler(Exception exception)
        {
            _exception = exception;
        }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
            => Task.FromException<HttpResponseMessage>(_exception);
    }

    private sealed class CancellationAwareHttpMessageHandler : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            return new HttpResponseMessage(HttpStatusCode.OK);
        }
    }
}
