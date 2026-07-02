using System.Net;
using System.Text;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinEnhanced.Tests.Services;

/// <summary>
/// Covers the merged Sonarr/Radarr tag-fetch logic in <see cref="ArrTagService"/>:
/// the SSRF guard must reject bad instance URLs BEFORE any outbound request, and
/// the tag-mapping logic must key results by the right provider id per *arr type.
/// </summary>
public class ArrTagServiceTests : IDisposable
{
    private readonly string _tempDir;
    private readonly Logger _logger;

    public ArrTagServiceTests()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), "je-arrtag-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_tempDir);
        _logger = new Logger(new StubAppPaths(_tempDir), NullLoggerFactory.Instance);
    }

    public void Dispose()
    {
        try { Directory.Delete(_tempDir, recursive: true); } catch { /* best effort */ }
    }

    private static ArrTagService CreateService(RecordingHandler handler, Logger logger)
        => new ArrTagService(new StubHttpClientFactory(handler), logger);

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
        var handler = new RecordingHandler();
        var service = CreateService(handler, _logger);

        var result = await service.GetMovieTagsByTmdbId(url, "key");

        Assert.Empty(result);
        Assert.Empty(handler.Requests); // guard must fire BEFORE any outbound call
    }

    [Fact]
    public async Task GetSeriesTags_BlockedUrl_ReturnsEmptyWithoutAnyRequest()
    {
        var handler = new RecordingHandler();
        var service = CreateService(handler, _logger);

        var result = await service.GetSeriesTagsByTvdbId("http://169.254.169.254:8989", "key");

        Assert.Empty(result);
        Assert.Empty(handler.Requests);
    }

    // ─── Endpoint + mapping behavior ─────────────────────────────────────────

    [Fact]
    public async Task GetMovieTags_MapsLabelsByTmdbId_AndSkipsUnkeyedOrUntaggedItems()
    {
        var handler = new RecordingHandler();
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
    public async Task GetSeriesTags_MapsLabelsByImdbId_UsingSeriesEndpoint()
    {
        var handler = new RecordingHandler();
        handler.AddResponse("/api/v3/tag", """[{"id":1,"label":"alice"}]""");
        handler.AddResponse("/api/v3/series", """
            [
              {"id":20,"title":"Keyed",  "tvdbId":5000,"imdbId":"tt0000001","tags":[1]},
              {"id":21,"title":"NoImdb", "tvdbId":5001,"imdbId":null,       "tags":[1]}
            ]
            """);
        var service = CreateService(handler, _logger);

        var result = await service.GetSeriesTagsByTvdbId("http://localhost:8989", "api-key");

        var only = Assert.Single(result);
        Assert.Equal("tt0000001", only.Key);
        Assert.Equal(new[] { "alice" }, only.Value);
        Assert.Equal("http://localhost:8989/api/v3/series", handler.Requests[1].RequestUri!.ToString());
    }

    [Fact]
    public async Task GetMovieTags_TagEndpointFails_ReturnsEmptyAndSkipsMediaFetch()
    {
        var handler = new RecordingHandler();
        handler.AddResponse("/api/v3/tag", "boom", HttpStatusCode.InternalServerError);
        var service = CreateService(handler, _logger);

        var result = await service.GetMovieTagsByTmdbId("http://localhost:7878", "key");

        Assert.Empty(result);
        Assert.Single(handler.Requests); // never reached /api/v3/movie
    }

    [Fact]
    public async Task GetMovieTags_InvalidJson_ReturnsEmptyInsteadOfThrowing()
    {
        var handler = new RecordingHandler();
        handler.AddResponse("/api/v3/tag", "<html>not json</html>");
        var service = CreateService(handler, _logger);

        var result = await service.GetMovieTagsByTmdbId("http://localhost:7878", "key");

        Assert.Empty(result);
    }

    // ─── Test doubles ────────────────────────────────────────────────────────

    private sealed class RecordingHandler : HttpMessageHandler
    {
        private readonly Dictionary<string, (string Body, HttpStatusCode Status)> _responses = new();

        public List<HttpRequestMessage> Requests { get; } = new();
        public List<string> ApiKeyHeaders { get; } = new();

        public void AddResponse(string pathSuffix, string body, HttpStatusCode status = HttpStatusCode.OK)
            => _responses[pathSuffix] = (body, status);

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add(request);
            if (request.Headers.TryGetValues("X-Api-Key", out var values))
            {
                ApiKeyHeaders.AddRange(values);
            }

            var path = request.RequestUri!.AbsolutePath;
            foreach (var (suffix, response) in _responses)
            {
                if (path.EndsWith(suffix, StringComparison.Ordinal))
                {
                    return Task.FromResult(new HttpResponseMessage(response.Status)
                    {
                        Content = new StringContent(response.Body, Encoding.UTF8, "application/json"),
                    });
                }
            }

            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound)
            {
                Content = new StringContent("{}", Encoding.UTF8, "application/json"),
            });
        }
    }

    private sealed class StubHttpClientFactory : IHttpClientFactory
    {
        private readonly HttpMessageHandler _handler;

        public StubHttpClientFactory(HttpMessageHandler handler) => _handler = handler;

        public HttpClient CreateClient(string name) => new HttpClient(_handler, disposeHandler: false);
    }

    /// <summary>Minimal IApplicationPaths so the plugin's file Logger can be constructed in tests.</summary>
    private sealed class StubAppPaths : IApplicationPaths
    {
        private readonly string _baseDir;

        public StubAppPaths(string baseDir) => _baseDir = baseDir;

        public string ProgramDataPath => _baseDir;
        public string WebPath => _baseDir;
        public string ProgramSystemPath => _baseDir;
        public string DataPath => _baseDir;
        public string ImageCachePath => _baseDir;
        public string PluginsPath => _baseDir;
        public string PluginConfigurationsPath => _baseDir;
        public string LogDirectoryPath => _baseDir;
        public string ConfigurationDirectoryPath => _baseDir;
        public string SystemConfigurationFilePath => Path.Combine(_baseDir, "system.xml");
        public string CachePath => _baseDir;
        public string TempDirectory => _baseDir;
        public string VirtualDataPath => _baseDir;
        public string TrickplayPath => _baseDir;
        public string BackupPath => _baseDir;

        public void MakeSanityCheckOrThrow()
        {
        }

        public void CreateAndCheckMarker(string path, string markerName, bool recursive = false)
        {
        }
    }
}
