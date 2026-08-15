using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Model.Qbittorrent;
using Jellyfin.Plugin.JellyfinCanopy.Services.Qbittorrent;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class QbittorrentTelemetryServiceTests
{
    [Fact]
    public async Task AuthorizedPathMatch_UsesOnlyLoginAndReadOnlyTorrentList_AndRedactsSecrets()
    {
        var secret = "passkey-do-not-disclose";
        var cookies = new List<string>();
        var handler = Handler(
            "[{\"hash\":\"raw-info-hash\",\"name\":\"release-name\","
            + "\"content_path\":\"/downloads/movies/Example/movie.mkv\","
            + "\"save_path\":\"/downloads/movies\",\"state\":\"uploading\","
            + "\"progress\":1,\"ratio\":1.234,"
            + $"\"tracker\":\"https://announce.example.net/{secret}?token={secret}\","
            + "\"added_on\":1700000000,\"completion_on\":1700000100,"
            + "\"last_activity\":1700000200}]",
            cookies);
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
                (HttpMethod.Post, "/api/v2/auth/logout"),
            ],
            handler.Sent.Select(request => (request.Method, request.Path)).ToArray());
        Assert.Equal(
            ["QBT_SID_8080=session-only", "QBT_SID_8080=session-only"],
            cookies);
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
    [InlineData("/|/", "/series/show/episode.mkv", "/series/show/episode.mkv")]
    [InlineData("/downloads|/", "/downloads/show/episode.mkv", "/show/episode.mkv")]
    [InlineData("/|/library", "/show/episode.mkv", "/library/show/episode.mkv")]
    public void Mapping_JoinsUnixRootsWithoutDoubleSeparators(
        string configured,
        string torrentPath,
        string expected)
    {
        var mappings = Assert.IsAssignableFrom<IReadOnlyList<QbittorrentTelemetryService.PathMapping>>(
            QbittorrentTelemetryService.ParseMappings(configured));

        Assert.Equal(expected, QbittorrentTelemetryService.MapTorrentPath(torrentPath, mappings));
    }

    [Theory]
    [InlineData("https://tracker.example.org/announce?passkey=secret", "…example.org")]
    [InlineData("udp://192.168.1.5:6969/secret", "private tracker")]
    [InlineData("udp://169.254.170.2:6969/secret", "private tracker")]
    [InlineData("udp://100.64.0.1:6969/secret", "private tracker")]
    [InlineData("udp://198.51.100.4:6969/secret", "private tracker")]
    [InlineData("udp://224.0.0.1:6969/secret", "private tracker")]
    [InlineData("udp://0.0.0.0:6969/secret", "private tracker")]
    [InlineData("udp://[2001:db8::4]:6969/secret", "private tracker")]
    [InlineData("udp://[fd00::4]:6969/secret", "private tracker")]
    [InlineData("udp://[ff02::1]:6969/secret", "private tracker")]
    [InlineData("udp://[::ffff:169.254.170.2]:6969/secret", "private tracker")]
    [InlineData("udp://8.8.8.8:6969/announce", "tracker")]
    [InlineData("not-a-url", null)]
    public void TrackerRedaction_NeverReturnsPathQueryCredentialsOrPrivateTopology(
        string tracker,
        string? expected)
    {
        var redacted = QbittorrentTelemetryService.RedactTracker(tracker);
        Assert.Equal(expected, redacted);
        Assert.DoesNotContain("passkey", redacted ?? string.Empty, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotMatch(@"(?:\d{1,3}\.){3}\d{1,3}|[0-9a-f]{0,4}:[0-9a-f:]", redacted ?? string.Empty);
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
        Assert.Equal(3, handler.Sent.Count);
        Assert.Single(factory.RequestedNames);
    }

    [Fact]
    public async Task SnapshotRawPaths_AreActivelyDiscardedAtTheTtlWithoutAnotherCaller()
    {
        var clock = new ManualTimeProvider(new DateTimeOffset(2026, 8, 15, 0, 0, 0, TimeSpan.Zero));
        var handler = Handler(
            "[{\"content_path\":\"/downloads/ttl-secret-path.mkv\",\"state\":\"downloading\"}]");
        var factory = new RecordingHttpClientFactory(handler);
        using var service = new QbittorrentTelemetryService(factory, Provider("password"), clock);

        var first = await service.GetForItemPathAsync("/media/ttl-secret-path.mkv", CancellationToken.None);
        clock.Advance(QbittorrentTelemetryService.SnapshotTtl);
        var second = await service.GetForItemPathAsync("/media/ttl-secret-path.mkv", CancellationToken.None);

        Assert.Equal(QbittorrentTelemetryResultKind.Success, first.Kind);
        Assert.Equal(QbittorrentTelemetryResultKind.Success, second.Kind);
        Assert.Equal(6, handler.Sent.Count);
        Assert.Equal(2, factory.RequestedNames.Count);
    }

    [Fact]
    public async Task ExplicitConfigInvalidation_DropsAStillFreshSnapshotImmediately()
    {
        var handler = Handler("[{\"content_path\":\"/downloads/a.mkv\",\"state\":\"downloading\"}]");
        var factory = new RecordingHttpClientFactory(handler);
        using var service = new QbittorrentTelemetryService(factory, Provider("password"));
        Assert.Equal(
            QbittorrentTelemetryResultKind.Success,
            (await service.GetForItemPathAsync("/media/a.mkv", CancellationToken.None)).Kind);

        service.InvalidateCachedState();
        var afterSave = await service.GetForItemPathAsync("/media/a.mkv", CancellationToken.None);

        Assert.Equal(QbittorrentTelemetryResultKind.Success, afterSave.Kind);
        Assert.Equal(6, handler.Sent.Count);
    }

    [Fact]
    public async Task ConcurrentItemCallers_CoalesceOneCompleteSessionLifecycle()
    {
        var handler = new DelayedQbittorrentHandler(
            "[{\"content_path\":\"/downloads/a.mkv\",\"state\":\"downloading\"}]");
        using var service = new QbittorrentTelemetryService(
            new RecordingHttpClientFactory(handler),
            Provider("password"));

        var first = service.GetForItemPathAsync("/media/a.mkv", CancellationToken.None);
        await handler.ListStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var second = service.GetForItemPathAsync("/media/a.mkv", CancellationToken.None);
        handler.ReleaseList.TrySetResult();
        var results = await Task.WhenAll(first, second);

        Assert.All(results, result => Assert.Equal(QbittorrentTelemetryResultKind.Success, result.Kind));
        Assert.Equal(3, handler.Sent.Count);
    }

    [Fact]
    public async Task CallerCancellation_DoesNotCancelOrDuplicateTheSharedSnapshotFlight()
    {
        var handler = new DelayedQbittorrentHandler(
            "[{\"content_path\":\"/downloads/a.mkv\",\"state\":\"downloading\"}]");
        using var service = new QbittorrentTelemetryService(
            new RecordingHttpClientFactory(handler),
            Provider("password"));
        using var caller = new CancellationTokenSource();

        var canceled = service.GetForItemPathAsync("/media/a.mkv", caller.Token);
        await handler.ListStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        caller.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => canceled);
        var survivor = service.GetForItemPathAsync("/media/a.mkv", CancellationToken.None);
        handler.ReleaseList.TrySetResult();

        Assert.Equal(QbittorrentTelemetryResultKind.Success, (await survivor).Kind);
        Assert.Equal(3, handler.Sent.Count);
    }

    [Fact]
    public async Task ConfigInvalidation_PreventsAnOlderFlightFromRepublishingRawPaths()
    {
        var handler = new DelayedQbittorrentHandler(
            "[{\"content_path\":\"/downloads/pre-save-secret.mkv\",\"state\":\"downloading\"}]");
        using var service = new QbittorrentTelemetryService(
            new RecordingHttpClientFactory(handler),
            Provider("password"));

        var oldFlight = service.GetForItemPathAsync(
            "/media/pre-save-secret.mkv",
            CancellationToken.None);
        await handler.ListStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        service.InvalidateCachedState();
        handler.ReleaseList.TrySetResult();
        Assert.Equal(QbittorrentTelemetryResultKind.Success, (await oldFlight).Kind);
        var afterSave = await service.GetForItemPathAsync(
            "/media/pre-save-secret.mkv",
            CancellationToken.None);

        Assert.Equal(QbittorrentTelemetryResultKind.Success, afterSave.Kind);
        Assert.Equal(6, handler.Sent.Count);
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
    public async Task InvalidSession_IsLoggedOutFailureCachedThenReauthenticatedAfterBackoff()
    {
        var clock = new ManualTimeProvider(new DateTimeOffset(2026, 8, 15, 0, 0, 0, TimeSpan.Zero));
        var listAttempts = 0;
        var handler = Handler("[]");
        var ordinary = handler.ResponseFactory!;
        handler.ResponseFactory = request => request.RequestUri!.AbsolutePath
            .EndsWith("/api/v2/torrents/info", StringComparison.Ordinal)
                && Interlocked.Increment(ref listAttempts) == 1
                    ? new HttpResponseMessage(HttpStatusCode.Forbidden)
                    : ordinary(request);
        using var service = new QbittorrentTelemetryService(
            new RecordingHttpClientFactory(handler),
            Provider("password"),
            clock);

        var failed = await service.GetForItemPathAsync("/media/a.mkv", CancellationToken.None);
        var cached = await service.GetForItemPathAsync("/media/a.mkv", CancellationToken.None);
        clock.Advance(QbittorrentTelemetryService.FailureTtl);
        var recovered = await service.GetForItemPathAsync("/media/a.mkv", CancellationToken.None);

        Assert.Equal(QbittorrentTelemetryResultKind.Unavailable, failed.Kind);
        Assert.Equal(QbittorrentTelemetryResultKind.Unavailable, cached.Kind);
        Assert.Equal(QbittorrentTelemetryResultKind.NoMatch, recovered.Kind);
        Assert.Equal(6, handler.Sent.Count);
        Assert.Equal(2, listAttempts);
    }

    [Fact]
    public async Task FailedReplacement_DoesNotRetainExpiredRawSnapshotAndIsBackedOff()
    {
        var clock = new ManualTimeProvider(new DateTimeOffset(2026, 8, 15, 0, 0, 0, TimeSpan.Zero));
        var listAttempts = 0;
        var handler = Handler(
            "[{\"content_path\":\"/downloads/retained-secret.mkv\",\"state\":\"downloading\"}]");
        var ordinary = handler.ResponseFactory!;
        handler.ResponseFactory = request => request.RequestUri!.AbsolutePath
            .EndsWith("/api/v2/torrents/info", StringComparison.Ordinal)
                && Interlocked.Increment(ref listAttempts) > 1
                    ? new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)
                    : ordinary(request);
        using var service = new QbittorrentTelemetryService(
            new RecordingHttpClientFactory(handler),
            Provider("password"),
            clock);

        var success = await service.GetForItemPathAsync(
            "/media/retained-secret.mkv",
            CancellationToken.None);
        clock.Advance(QbittorrentTelemetryService.SnapshotTtl);
        var failed = await service.GetForItemPathAsync(
            "/media/retained-secret.mkv",
            CancellationToken.None);
        var backedOff = await service.GetForItemPathAsync(
            "/media/retained-secret.mkv",
            CancellationToken.None);

        Assert.Equal(QbittorrentTelemetryResultKind.Success, success.Kind);
        Assert.Equal(QbittorrentTelemetryResultKind.Unavailable, failed.Kind);
        Assert.Equal(QbittorrentTelemetryResultKind.Unavailable, backedOff.Kind);
        Assert.Equal(6, handler.Sent.Count);
    }

    [Fact]
    public void Parser_RejectsAnUnboundedTorrentEnvelope()
    {
        var json = "[" + string.Join(',', Enumerable.Repeat("{}", QbittorrentTelemetryService.MaximumTorrents + 1)) + "]";
        Assert.False(QbittorrentTelemetryService.TryParseTorrents(
            Encoding.UTF8.GetBytes(json),
            out _));
    }

    [Fact]
    public async Task CurrentPortSpecificCookie_IsRequiredOnReadAndBoundedLogout()
    {
        var cookies = new List<string>();
        var handler = Handler("[]", cookies);
        var service = new QbittorrentTelemetryService(
            new RecordingHttpClientFactory(handler),
            Provider("password"));

        var result = await service.TestConnectionAsync(CancellationToken.None);

        Assert.Equal(QbittorrentTelemetryResultKind.Success, result);
        Assert.Equal(
            ["QBT_SID_8080=session-only", "QBT_SID_8080=session-only"],
            cookies);
        Assert.Equal("/api/v2/auth/logout", handler.Sent[^1].Path);
    }

    [Fact]
    public async Task LegacySidCookie_RemainsSupported()
    {
        var cookies = new List<string>();
        var handler = Handler("[]", cookies, "SID=legacy-session; HttpOnly; path=/");
        var service = new QbittorrentTelemetryService(
            new RecordingHttpClientFactory(handler),
            Provider("password"));

        var result = await service.TestConnectionAsync(CancellationToken.None);

        Assert.Equal(QbittorrentTelemetryResultKind.Success, result);
        Assert.Equal(["SID=legacy-session", "SID=legacy-session"], cookies);
    }

    [Theory]
    [InlineData("unowned=value; Path=/")]
    [InlineData("QBT_SID_0=value; Path=/")]
    [InlineData("QBT_SID_70000=value; Path=/")]
    [InlineData("QBT_SID_8080=bad,value; Path=/")]
    public async Task Login_FailsClosedForUnownedOrMalformedCookies(string setCookie)
    {
        var handler = Handler("[]", [], setCookie);
        var service = new QbittorrentTelemetryService(
            new RecordingHttpClientFactory(handler),
            Provider("password"));

        var result = await service.TestConnectionAsync(CancellationToken.None);

        Assert.Equal(QbittorrentTelemetryResultKind.Unavailable, result);
        Assert.Single(handler.Sent);
    }

    [Theory]
    [InlineData("not-ok")]
    [InlineData("oversized")]
    public async Task LegacyLoginInvalidBody_LogsOutTheAlreadyOwnedSession(string bodyKind)
    {
        var cookies = new List<string>();
        var handler = LegacyLoginBodyHandler(
            () => new StringContent(
                bodyKind == "oversized" ? new string('x', 65) : "Nope.",
                Encoding.ASCII),
            cookies);
        var service = new QbittorrentTelemetryService(
            new RecordingHttpClientFactory(handler),
            Provider("password"));

        var result = await service.TestConnectionAsync(CancellationToken.None);

        Assert.Equal(QbittorrentTelemetryResultKind.Unavailable, result);
        Assert.Equal(
            [
                (HttpMethod.Post, "/api/v2/auth/login"),
                (HttpMethod.Post, "/api/v2/auth/logout"),
            ],
            handler.Sent.Select(request => (request.Method, request.Path)).ToArray());
        Assert.Equal(["SID=legacy-cleanup-session"], cookies);
    }

    [Fact]
    public async Task LegacyLoginThrowingBody_LogsOutWithSameCookieAndPreservesGenericFailure()
    {
        var cookies = new List<string>();
        var handler = LegacyLoginBodyHandler(() => new ThrowingContent(), cookies);
        var service = new QbittorrentTelemetryService(
            new RecordingHttpClientFactory(handler),
            Provider("password"));

        var result = await service.TestConnectionAsync(CancellationToken.None);

        Assert.Equal(QbittorrentTelemetryResultKind.Unavailable, result);
        Assert.Equal(
            [
                (HttpMethod.Post, "/api/v2/auth/login"),
                (HttpMethod.Post, "/api/v2/auth/logout"),
            ],
            handler.Sent.Select(request => (request.Method, request.Path)).ToArray());
        Assert.Equal(["SID=legacy-cleanup-session"], cookies);
    }

    [Fact]
    public async Task MalformedTorrentPayload_StillLogsOutTheOwnedSession()
    {
        var handler = Handler("not-json");
        var service = new QbittorrentTelemetryService(
            new RecordingHttpClientFactory(handler),
            Provider("password"));

        var result = await service.TestConnectionAsync(CancellationToken.None);

        Assert.Equal(QbittorrentTelemetryResultKind.Unavailable, result);
        Assert.Equal("/api/v2/auth/logout", handler.Sent[^1].Path);
    }

    [Fact]
    public async Task ResponseStreamIoFault_IsSanitizedLoggedOutAndFailureCached()
    {
        var normal = Handler("[]");
        var normalFactory = normal.ResponseFactory!;
        normal.ResponseFactory = request => request.RequestUri!.AbsolutePath
            .EndsWith("/api/v2/torrents/info", StringComparison.Ordinal)
                ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new ThrowingContent() }
                : normalFactory(request);
        var service = new QbittorrentTelemetryService(
            new RecordingHttpClientFactory(normal),
            Provider("password"));

        var first = await service.GetForItemPathAsync("/media/a.mkv", CancellationToken.None);
        var second = await service.GetForItemPathAsync("/media/a.mkv", CancellationToken.None);

        Assert.Equal(QbittorrentTelemetryResultKind.Unavailable, first.Kind);
        Assert.Equal(QbittorrentTelemetryResultKind.Unavailable, second.Kind);
        Assert.Equal("/api/v2/auth/logout", normal.Sent[^1].Path);
        Assert.Equal(3, normal.Sent.Count);
    }

    [Fact]
    public async Task ProductionNamedHandler_UsesCurrentCookieAcrossRealTcpProtocolLifecycle()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var endpoint = Assert.IsType<IPEndPoint>(listener.LocalEndpoint);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(8));
        var server = ServeProtocolAsync(listener, endpoint.Port, deadline.Token);
        var provider = Provider("wire-secret", $"http://127.0.0.1:{endpoint.Port}");
        var services = new ServiceCollection();
        PluginServiceRegistrator.RegisterQbittorrentHttpClient(services);
        using var serviceProvider = services.BuildServiceProvider();
        using var service = new QbittorrentTelemetryService(
            serviceProvider.GetRequiredService<IHttpClientFactory>(),
            provider);

        var result = await service.GetForItemPathAsync("/media/wire.mkv", deadline.Token);
        var requests = await server;

        Assert.Equal(QbittorrentTelemetryResultKind.Success, result.Kind);
        Assert.Collection(
            requests,
            login =>
            {
                Assert.StartsWith("POST /api/v2/auth/login HTTP/1.1", login, StringComparison.Ordinal);
                Assert.Contains("username=canopy&password=wire-secret", login, StringComparison.Ordinal);
                Assert.DoesNotContain("\r\nCookie:", login, StringComparison.OrdinalIgnoreCase);
            },
            list =>
            {
                Assert.StartsWith("GET /api/v2/torrents/info HTTP/1.1", list, StringComparison.Ordinal);
                Assert.Contains($"\r\nCookie: QBT_SID_{endpoint.Port}=wire-session\r\n", list, StringComparison.Ordinal);
            },
            logout =>
            {
                Assert.StartsWith("POST /api/v2/auth/logout HTTP/1.1", logout, StringComparison.Ordinal);
                Assert.Contains($"\r\nCookie: QBT_SID_{endpoint.Port}=wire-session\r\n", logout, StringComparison.Ordinal);
            });
    }

    private static FakePluginConfigProvider Provider(
        string password,
        string url = "http://127.0.0.1:8080")
        => new(new PluginConfiguration
        {
            QbittorrentTelemetryEnabled = true,
            QbittorrentUrl = url,
            QbittorrentUsername = "canopy",
            QbittorrentPassword = password,
            QbittorrentPathMappings = "/downloads|/media",
        });

    private static RecordingHttpMessageHandler Handler(
        string torrentJson,
        List<string>? cookies = null,
        string setCookie = "QBT_SID_8080=session-only; HttpOnly; SameSite=Strict; path=/")
        => new()
        {
            ResponseFactory = request =>
            {
                if (request.RequestUri!.AbsolutePath.EndsWith("/api/v2/auth/login", StringComparison.Ordinal))
                {
                    var legacy = setCookie.StartsWith("SID=", StringComparison.Ordinal);
                    var response = new HttpResponseMessage(
                        legacy ? HttpStatusCode.OK : HttpStatusCode.NoContent)
                    {
                        Content = new StringContent(legacy ? "Ok." : string.Empty, Encoding.ASCII),
                    };
                    response.Headers.TryAddWithoutValidation("Set-Cookie", setCookie);
                    return response;
                }

                if (request.RequestUri.AbsolutePath.EndsWith("/api/v2/torrents/info", StringComparison.Ordinal))
                {
                    cookies?.Add(Assert.Single(request.Headers.GetValues("Cookie")));
                    return new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = new StringContent(torrentJson, Encoding.UTF8, "application/json"),
                    };
                }

                if (request.RequestUri.AbsolutePath.EndsWith("/api/v2/auth/logout", StringComparison.Ordinal))
                {
                    cookies?.Add(Assert.Single(request.Headers.GetValues("Cookie")));
                    return new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = new StringContent(string.Empty, Encoding.ASCII),
                    };
                }

                return null;
            },
        };

    private static RecordingHttpMessageHandler LegacyLoginBodyHandler(
        Func<HttpContent> content,
        List<string> cookies)
        => new()
        {
            ResponseFactory = request =>
            {
                if (request.RequestUri!.AbsolutePath.EndsWith("/api/v2/auth/login", StringComparison.Ordinal))
                {
                    var response = new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = content(),
                    };
                    response.Headers.TryAddWithoutValidation(
                        "Set-Cookie",
                        "SID=legacy-cleanup-session; HttpOnly; SameSite=Strict; path=/");
                    return response;
                }

                if (request.RequestUri.AbsolutePath.EndsWith("/api/v2/auth/logout", StringComparison.Ordinal))
                {
                    cookies.Add(Assert.Single(request.Headers.GetValues("Cookie")));
                    return new HttpResponseMessage(HttpStatusCode.OK);
                }

                return null;
            },
        };

    private static async Task<IReadOnlyList<string>> ServeProtocolAsync(
        TcpListener listener,
        int port,
        CancellationToken cancellationToken)
    {
        var requests = new List<string>(3);
        for (var index = 0; index < 3; index++)
        {
            using var connection = await listener.AcceptTcpClientAsync(cancellationToken);
            await using var stream = connection.GetStream();
            requests.Add(await ReadHttpRequestAsync(stream, cancellationToken));
            var body = index == 1
                ? "[{\"content_path\":\"/downloads/wire.mkv\",\"state\":\"uploading\",\"progress\":1}]"
                : string.Empty;
            var cookie = index == 0
                ? $"Set-Cookie: QBT_SID_{port}=wire-session; HttpOnly; SameSite=Strict; path=/\r\n"
                : string.Empty;
            var response = Encoding.ASCII.GetBytes(
                (index == 0 ? "HTTP/1.1 204 No Content\r\n" : "HTTP/1.1 200 OK\r\n")
                + "Content-Type: text/plain\r\n"
                + $"Content-Length: {Encoding.ASCII.GetByteCount(body)}\r\n"
                + cookie
                + "Connection: close\r\n\r\n"
                + body);
            await stream.WriteAsync(response, cancellationToken);
        }

        return requests;
    }

    private static async Task<string> ReadHttpRequestAsync(
        NetworkStream stream,
        CancellationToken cancellationToken)
    {
        const int maximumRequestBytes = 32 * 1024;
        var buffer = new byte[1024];
        using var request = new MemoryStream();
        while (request.Length < maximumRequestBytes)
        {
            var read = await stream.ReadAsync(buffer, cancellationToken);
            if (read == 0) break;
            request.Write(buffer, 0, read);
            var text = Encoding.ASCII.GetString(request.GetBuffer(), 0, checked((int)request.Length));
            var headerEnd = text.IndexOf("\r\n\r\n", StringComparison.Ordinal);
            if (headerEnd < 0) continue;
            var contentLength = 0;
            foreach (var line in text[..headerEnd].Split("\r\n", StringSplitOptions.None))
            {
                if (line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase))
                {
                    Assert.True(int.TryParse(line[15..].Trim(), out contentLength));
                }
            }

            if (request.Length >= headerEnd + 4 + contentLength) return text;
        }

        throw new InvalidDataException("HTTP request exceeded the bounded qBittorrent fixture.");
    }

    private static QbittorrentTelemetryService.TorrentSnapshot Torrent(string path)
        => new(path, "downloading", 0.5, 0, null, null, null, null);

    private sealed class ManualTimeProvider(DateTimeOffset now) : TimeProvider
    {
        private readonly List<ManualTimer> _timers = new();
        private DateTimeOffset _now = now;

        public override DateTimeOffset GetUtcNow() => _now;

        public override ITimer CreateTimer(
            TimerCallback callback,
            object? state,
            TimeSpan dueTime,
            TimeSpan period)
        {
            var timer = new ManualTimer(callback, state, () => _now, _now + dueTime, period);
            _timers.Add(timer);
            return timer;
        }

        public void Advance(TimeSpan value)
        {
            _now += value;
            foreach (var timer in _timers.ToArray()) timer.FireIfDue(_now);
        }

        private sealed class ManualTimer(
            TimerCallback callback,
            object? state,
            Func<DateTimeOffset> getNow,
            DateTimeOffset dueAt,
            TimeSpan period) : ITimer
        {
            private DateTimeOffset _dueAt = dueAt;
            private TimeSpan _period = period;
            private bool _disposed;

            public bool Change(TimeSpan dueTime, TimeSpan newPeriod)
            {
                if (_disposed) return false;
                _dueAt = getNow() + dueTime;
                _period = newPeriod;
                return true;
            }

            public void FireIfDue(DateTimeOffset now)
            {
                if (_disposed || now < _dueAt) return;
                if (_period == Timeout.InfiniteTimeSpan) _disposed = true;
                else _dueAt = now + _period;
                callback(state);
            }

            public void Dispose() => _disposed = true;

            public ValueTask DisposeAsync()
            {
                Dispose();
                return ValueTask.CompletedTask;
            }
        }
    }

    private sealed class ThrowingContent : HttpContent
    {
        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context)
            => Task.FromException(new IOException("upstream stream secret"));

        protected override bool TryComputeLength(out long length)
        {
            length = 0;
            return false;
        }

        protected override Task<Stream> CreateContentReadStreamAsync()
            => Task.FromResult<Stream>(new ThrowingStream());
    }

    private sealed class ThrowingStream : MemoryStream
    {
        public override ValueTask<int> ReadAsync(
            Memory<byte> buffer,
            CancellationToken cancellationToken = default)
            => ValueTask.FromException<int>(new IOException("upstream stream secret"));
    }

    private sealed class DelayedQbittorrentHandler(string torrentJson) : HttpMessageHandler
    {
        private int _listCount;

        public TaskCompletionSource ListStarted { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource ReleaseList { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public List<string> Sent { get; } = new();

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            Sent.Add(path);
            if (path.EndsWith("/api/v2/auth/login", StringComparison.Ordinal))
            {
                var login = new HttpResponseMessage(HttpStatusCode.NoContent)
                {
                    Content = new StringContent(string.Empty, Encoding.ASCII),
                };
                login.Headers.TryAddWithoutValidation(
                    "Set-Cookie",
                    "QBT_SID_8080=delayed-session; HttpOnly; path=/");
                return login;
            }

            if (path.EndsWith("/api/v2/torrents/info", StringComparison.Ordinal))
            {
                if (Interlocked.Increment(ref _listCount) == 1)
                {
                    ListStarted.TrySetResult();
                    await ReleaseList.Task.WaitAsync(cancellationToken);
                }

                return new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(torrentJson, Encoding.UTF8, "application/json"),
                };
            }

            Assert.EndsWith("/api/v2/auth/logout", path, StringComparison.Ordinal);
            return new HttpResponseMessage(HttpStatusCode.OK);
        }
    }

}
