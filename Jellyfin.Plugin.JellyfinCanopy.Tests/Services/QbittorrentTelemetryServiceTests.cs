using System.Net;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Model.Qbittorrent;
using Jellyfin.Plugin.JellyfinCanopy.Services.Qbittorrent;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class QbittorrentTelemetryServiceTests
{
    [Fact]
    public async Task AuthorizedPathMatch_UsesOnlyLoginAndReadOnlyTorrentList_AndRedactsSecrets()
    {
        var secret = "passkey-do-not-disclose";
        var handler = Handler(
            "[{\"hash\":\"raw-info-hash\",\"name\":\"release-name\","
            + "\"content_path\":\"/downloads/movies/Example/movie.mkv\","
            + "\"save_path\":\"/downloads/movies\",\"state\":\"uploading\","
            + "\"progress\":1,\"ratio\":1.234,"
            + $"\"tracker\":\"https://announce.example.net/{secret}?token={secret}\","
            + "\"added_on\":1700000000,\"completion_on\":1700000100,"
            + "\"last_activity\":1700000200}]");
        var factory = new RecordingHttpClientFactory(handler);
        var service = new QbittorrentTelemetryService(factory, Provider(secret));

        var result = await service.GetForItemPathAsync(
            "/media/movies/Example/movie.mkv",
            CancellationToken.None);

        Assert.Equal(QbittorrentTelemetryResultKind.Success, result.Kind);
        Assert.Equal("seeding", result.Telemetry!.State);
        Assert.Equal(100, result.Telemetry.ProgressPercent);
        Assert.Equal(1.23, result.Telemetry.Ratio);
        Assert.Equal("…example.net", result.Telemetry.TrackerIdentity);
        var observable = JsonSerializer.Serialize(result.Telemetry, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.DoesNotContain(secret, observable, StringComparison.Ordinal);
        Assert.DoesNotContain("raw-info-hash", observable, StringComparison.Ordinal);
        Assert.DoesNotContain("release-name", observable, StringComparison.Ordinal);
        Assert.DoesNotContain("/downloads", observable, StringComparison.Ordinal);
        Assert.Equal(QbittorrentTelemetryService.HttpClientName, Assert.Single(factory.RequestedNames));
        Assert.Equal(
            [
                (HttpMethod.Post, "/api/v2/auth/login"),
                (HttpMethod.Get, "/api/v2/torrents/info"),
            ],
            handler.Sent.Select(request => (request.Method, request.Path)).ToArray());
        Assert.DoesNotContain(handler.Sent, request => request.Path.Contains(secret, StringComparison.Ordinal));
    }

    [Fact]
    public void Mapping_SelectsMostSpecificRootAndRejectsEqualStrengthAmbiguity()
    {
        var mappings = Assert.IsAssignableFrom<IReadOnlyList<QbittorrentTelemetryService.PathMapping>>(
            QbittorrentTelemetryService.ParseMappings(
                "/downloads|/media\n/downloads/tv|/library/shows"));
        Assert.Equal(
            "/library/shows/Series/Season 01",
            QbittorrentTelemetryService.MapTorrentPath(
                "/downloads/tv/Series/Season 01",
                mappings));

        var torrents = new[]
        {
            Torrent("/downloads/tv/Series/Season 01"),
            Torrent("/downloads/tv/Series/Season 01"),
        };
        var result = QbittorrentTelemetryService.Match(
            "/library/shows/Series/Season 01/episode.mkv",
            mappings,
            torrents);

        Assert.Equal(QbittorrentTelemetryResultKind.Ambiguous, result.Kind);
        Assert.Null(result.Telemetry);
    }

    [Fact]
    public void Mapping_RejectsTraversalRelativePathsAndConflictingDuplicateRoots()
    {
        Assert.Null(QbittorrentTelemetryService.ParseMappings("downloads|/media"));
        Assert.Null(QbittorrentTelemetryService.ParseMappings("/downloads/../secret|/media"));
        var mappings = Assert.IsAssignableFrom<IReadOnlyList<QbittorrentTelemetryService.PathMapping>>(
            QbittorrentTelemetryService.ParseMappings(
                "/downloads|/media-a\n/downloads|/media-b"));
        Assert.Null(QbittorrentTelemetryService.MapTorrentPath("/downloads/file.mkv", mappings));
    }

    [Theory]
    [InlineData("https://tracker.example.org/announce?passkey=secret", "…example.org")]
    [InlineData("udp://192.168.1.5:6969/secret", "private tracker")]
    [InlineData("not-a-url", null)]
    public void TrackerRedaction_NeverReturnsPathQueryCredentialsOrPrivateTopology(
        string tracker,
        string? expected)
    {
        var redacted = QbittorrentTelemetryService.RedactTracker(tracker);
        Assert.Equal(expected, redacted);
        Assert.DoesNotContain("passkey", redacted ?? string.Empty, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("192.168", redacted ?? string.Empty, StringComparison.Ordinal);
    }

    [Fact]
    public async Task SnapshotCache_IsProcessBoundedAndSharedAcrossItemLookups()
    {
        var handler = Handler(
            "[{\"content_path\":\"/downloads/a.mkv\",\"state\":\"downloading\","
            + "\"progress\":0.5,\"ratio\":0}]");
        var factory = new RecordingHttpClientFactory(handler);
        var service = new QbittorrentTelemetryService(factory, Provider("password"));

        var first = await service.GetForItemPathAsync("/media/a.mkv", CancellationToken.None);
        var second = await service.GetForItemPathAsync("/media/a.mkv", CancellationToken.None);

        Assert.Equal(QbittorrentTelemetryResultKind.Success, first.Kind);
        Assert.Equal(QbittorrentTelemetryResultKind.Success, second.Kind);
        Assert.Equal(2, handler.Sent.Count);
        Assert.Single(factory.RequestedNames);
    }

    [Fact]
    public async Task UnavailableLogin_IsSanitizedAndFailureCached()
    {
        var handler = new RecordingHttpMessageHandler
        {
            ResponseFactory = request => new HttpResponseMessage(HttpStatusCode.Unauthorized)
            {
                Content = new StringContent("upstream secret diagnostic", Encoding.UTF8),
            },
        };
        var factory = new RecordingHttpClientFactory(handler);
        var service = new QbittorrentTelemetryService(factory, Provider("password"));

        var first = await service.GetForItemPathAsync("/media/a.mkv", CancellationToken.None);
        var second = await service.GetForItemPathAsync("/media/a.mkv", CancellationToken.None);

        Assert.Equal(QbittorrentTelemetryResultKind.Unavailable, first.Kind);
        Assert.Equal(QbittorrentTelemetryResultKind.Unavailable, second.Kind);
        Assert.Single(handler.Sent);
    }

    [Fact]
    public void Parser_RejectsAnUnboundedTorrentEnvelope()
    {
        var json = "[" + string.Join(',', Enumerable.Repeat("{}", QbittorrentTelemetryService.MaximumTorrents + 1)) + "]";
        Assert.False(QbittorrentTelemetryService.TryParseTorrents(
            Encoding.UTF8.GetBytes(json),
            out _));
    }

    private static FakePluginConfigProvider Provider(string password)
        => new(new PluginConfiguration
        {
            QbittorrentTelemetryEnabled = true,
            QbittorrentUrl = "http://127.0.0.1:8080",
            QbittorrentUsername = "canopy",
            QbittorrentPassword = password,
            QbittorrentPathMappings = "/downloads|/media",
        });

    private static RecordingHttpMessageHandler Handler(string torrentJson)
        => new()
        {
            ResponseFactory = request =>
            {
                if (request.RequestUri!.AbsolutePath.EndsWith("/api/v2/auth/login", StringComparison.Ordinal))
                {
                    var response = new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = new StringContent("Ok.", Encoding.ASCII),
                    };
                    response.Headers.TryAddWithoutValidation("Set-Cookie", "SID=session-only; HttpOnly; path=/");
                    return response;
                }

                if (request.RequestUri.AbsolutePath.EndsWith("/api/v2/torrents/info", StringComparison.Ordinal))
                {
                    return new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = new StringContent(torrentJson, Encoding.UTF8, "application/json"),
                    };
                }

                return null;
            },
        };

    private static QbittorrentTelemetryService.TorrentSnapshot Torrent(string path)
        => new(path, "downloading", 0.5, 0, null, null, null, null);
}
