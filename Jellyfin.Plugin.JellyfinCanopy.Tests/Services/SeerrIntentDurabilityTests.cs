using System.Net;
using System.Net.Http.Headers;
using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class SeerrIntentDurabilityTests : IDisposable
{
    private const string Source = "http://seerr:5055";
    private readonly string _directory = Path.Combine(
        Path.GetTempPath(),
        "jc-seerr-intent-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        try
        {
            Directory.Delete(_directory, recursive: true);
        }
        catch
        {
            // Best-effort test cleanup.
        }
    }

    [Fact]
    public async Task SuccessfulRequest_ReturnsOnlyAfterSpoilerIntentIsDurable()
    {
        var user = new User("intent-user", "provider", "password-provider");
        var userId = user.Id.ToString("N");
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse(
            "/api/v1/user",
            $"{{\"results\":[{{\"id\":42,\"jellyfinUserId\":\"{userId}\",\"permissions\":2}}],\"pageInfo\":{{\"page\":1,\"pages\":1,\"results\":1}}}}");
        handler.AddResponse("/api/v1/request", "{\"id\":1}", HttpStatusCode.Created);

        var config = new PluginConfiguration
        {
            SeerrEnabled = true,
            SeerrUrls = Source,
            SeerrApiKey = "test-key",
            SpoilerBlurEnabled = true,
            SpoilerAutoEnableOnSeerrRequest = true,
        };
        var provider = new FakePluginConfigProvider(config);
        var manager = new UserConfigurationManager(
            new StubAppPaths(_directory),
            NullLogger<UserConfigurationManager>.Instance);
        var library = new CountingLibraryManager
        {
            GetItemListHook = _ => Array.Empty<BaseItem>(),
        };
        var users = new StubUserManager(user);
        var pending = new SpoilerPendingService(
            manager,
            library,
            users,
            NullLogger<SpoilerPendingService>.Instance);
        var client = new SeerrClient(
            new RecordingHttpClientFactory(handler),
            NullLogger<SeerrClient>.Instance,
            users,
            new SeerrCache(provider),
            provider,
            new PassthroughParentalFilter(),
            pending);

        var result = await client.ProxyRequestAsync(
            "/api/v1/request",
            HttpMethod.Post,
            "{\"mediaType\":\"tv\",\"mediaId\":123,\"seasons\":[2]}",
            new SeerrCaller(userId, IsAdmin: true));

        Assert.IsType<ContentResult>(result);
        var state = manager.GetUserConfiguration<UserSpoilerBlur>(
            userId,
            "spoilerblur.json");
        Assert.True(state.PendingTmdb.ContainsKey("tv:123"));
    }

    [Fact]
    public async Task TvSeasonsRoute_CannotBypassSharedDurableSuccessBoundary()
    {
        var setup = CreateClientHarness();
        var controller = new SeerrUserController(
            new RecordingHttpClientFactory(setup.Handler),
            NullLogger<SeerrUserController>.Instance,
            setup.Users,
            new SeerrCache(setup.Provider),
            setup.Provider,
            null!,
            setup.Library,
            setup.Client)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext
                {
                    User = new ClaimsPrincipal(new ClaimsIdentity(
                        new[] { new Claim("Jellyfin-UserId", setup.User.Id.ToString()) },
                        "TestAuth")),
                },
            },
        };
        using var document = JsonDocument.Parse(
            "{\"mediaType\":\"tv\",\"mediaId\":321,\"seasons\":[3]}");

        var result = await controller.RequestTvSeasons(321, document.RootElement);

        Assert.IsType<ContentResult>(result);
        Assert.True(ReadState(setup).PendingTmdb.ContainsKey("tv:321"));
    }

    [Fact]
    public async Task UpstreamSuccess_WithUnresolvedFullPendingStore_ReturnsExplicitPartialSuccess()
    {
        var setup = CreateClientHarness();
        SeedPendingCap(setup);

        var result = Assert.IsType<ObjectResult>(await setup.Client.ProxyRequestAsync(
            "/api/v1/request",
            HttpMethod.Post,
            "{\"mediaType\":\"movie\",\"mediaId\":999}",
            new SeerrCaller(setup.User.Id.ToString("N"), IsAdmin: true)));

        Assert.Equal(500, result.StatusCode);
        Assert.Equal("seerr_accepted_spoiler_intent_failed", ReadProperty<string>(result.Value, "code"));
        Assert.True(ReadProperty<bool>(result.Value, "seerrAccepted"));
        Assert.False(ReadProperty<bool>(result.Value, "spoilerIntentRecorded"));
        Assert.Equal("pending_cap_exceeded", ReadProperty<string>(result.Value, "reason"));
        Assert.Equal(SpoilerPendingService.MaxPendingTmdbPerUser, ReadState(setup).PendingTmdb.Count);
    }

    [Fact]
    public async Task UpstreamAcceptedUnsupportedMediaType_ReturnsTruthfulPartialSuccess()
    {
        var setup = CreateClientHarness();

        var result = Assert.IsType<ObjectResult>(await setup.Client.ProxyRequestAsync(
            "/api/v1/request",
            HttpMethod.Post,
            "{\"mediaType\":\"music\",\"mediaId\":999}",
            new SeerrCaller(setup.User.Id.ToString("N"), IsAdmin: true)));

        Assert.Equal(500, result.StatusCode);
        Assert.Equal("seerr_accepted_spoiler_intent_failed", ReadProperty<string>(result.Value, "code"));
        Assert.Equal("unsupported_request_target", ReadProperty<string>(result.Value, "reason"));
        Assert.True(ReadProperty<bool>(result.Value, "seerrAccepted"));
        Assert.False(ReadProperty<bool>(result.Value, "spoilerIntentRecorded"));
        Assert.Contains("Do not retry", ReadProperty<string>(result.Value, "message"));
        Assert.Contains("movie/tv", ReadProperty<string>(result.Value, "message"));
        Assert.Contains("verify", ReadProperty<string>(result.Value, "message"));
        Assert.Empty(ReadState(setup).PendingTmdb);
    }

    [Fact]
    public async Task CapacityOpeningBeforeFallback_ReportsNewPendingRowAsDurable()
    {
        var setup = CreateClientHarness();
        SeedPendingCap(setup);
        const string removedKey = "movie:100000";
        setup.Pending.BeforeCapFallbackForTest = () =>
        {
            setup.Manager.RmwUserConfiguration<UserSpoilerBlur>(
                setup.User.Id.ToString("N"),
                "spoilerblur.json",
                state => state.PendingTmdb.Remove(removedKey) ? 1 : 0);
        };

        var result = await setup.Client.ProxyRequestAsync(
            "/api/v1/request",
            HttpMethod.Post,
            "{\"mediaType\":\"movie\",\"mediaId\":999}",
            new SeerrCaller(setup.User.Id.ToString("N"), IsAdmin: true));

        Assert.IsType<ContentResult>(result);
        var state = ReadState(setup);
        Assert.False(state.PendingTmdb.ContainsKey(removedKey));
        Assert.True(state.PendingTmdb.ContainsKey("movie:999"));
        Assert.Equal(SpoilerPendingService.MaxPendingTmdbPerUser, state.PendingTmdb.Count);
    }

    [Fact]
    public async Task UpstreamSuccess_AtPendingCapWithAccessibleSeries_DurablyPromotes()
    {
        var setup = CreateClientHarness();
        SeedPendingCap(setup);
        var series = new Series { Id = Guid.NewGuid(), Name = "Already Here" };
        series.ProviderIds["Tmdb"] = "999";
        setup.Library.GetItemListHook = _ => new BaseItem[] { series };

        var result = await setup.Client.ProxyRequestAsync(
            "/api/v1/request",
            HttpMethod.Post,
            "{\"mediaType\":\"tv\",\"mediaId\":999}",
            new SeerrCaller(setup.User.Id.ToString("N"), IsAdmin: true));

        Assert.IsType<ContentResult>(result);
        var state = ReadState(setup);
        Assert.Equal(SpoilerPendingService.MaxPendingTmdbPerUser, state.PendingTmdb.Count);
        Assert.True(state.Series.ContainsKey(series.Id.ToString("N")));
    }

    [Fact]
    public async Task RequestSubresourceMutation_IsNotMisclassifiedAsNewMediaIntent()
    {
        var setup = CreateClientHarness();
        setup.Handler.AddResponse("/api/v1/request/7/approve", "{\"id\":7}");

        var result = await setup.Client.ProxyRequestAsync(
            "/api/v1/request/7/approve",
            HttpMethod.Post,
            "{\"mediaType\":\"tv\",\"mediaId\":777}",
            new SeerrCaller(setup.User.Id.ToString("N"), IsAdmin: true));

        Assert.IsType<ContentResult>(result);
        Assert.Empty(ReadState(setup).PendingTmdb);
    }

    [Fact]
    public async Task UpstreamSuccess_WithCorruptIntentStore_ReturnsExplicitPartialSuccess()
    {
        var setup = CreateClientHarness();
        setup.Manager.SaveUserConfiguration(
            setup.User.Id.ToString("N"),
            "spoilerblur.json",
            new UserSpoilerBlur());
        var path = Path.Combine(
            _directory,
            "configurations",
            "Jellyfin.Plugin.JellyfinCanopy",
            setup.User.Id.ToString("N"),
            "spoilerblur.json");
        File.WriteAllText(path, "{{{ corrupt intent store");

        var result = Assert.IsType<ObjectResult>(await setup.Client.ProxyRequestAsync(
            "/api/v1/request",
            HttpMethod.Post,
            "{\"mediaType\":\"movie\",\"mediaId\":654}",
            new SeerrCaller(setup.User.Id.ToString("N"), IsAdmin: true)));

        Assert.Equal(500, result.StatusCode);
        Assert.Equal("seerr_accepted_spoiler_intent_failed", ReadProperty<string>(result.Value, "code"));
        Assert.Equal("intent_store_unavailable", ReadProperty<string>(result.Value, "reason"));
        Assert.True(ReadProperty<bool>(result.Value, "seerrAccepted"));
    }

    [Fact]
    public async Task RequestCancellationAfterUpstreamSuccess_CannotAbandonDurableIntent()
    {
        using var cancellation = new CancellationTokenSource();
        var setup = CreateClientHarness(new CancelDuringResponseFilter(cancellation));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => setup.Client.ProxyRequestAsync(
            "/api/v1/request",
            HttpMethod.Post,
            "{\"mediaType\":\"tv\",\"mediaId\":876}",
            new SeerrCaller(setup.User.Id.ToString("N"), IsAdmin: true),
            cancellation.Token));

        Assert.True(ReadState(setup).PendingTmdb.ContainsKey("tv:876"));
    }

    [Fact]
    public async Task RequestCancellationAfterSuccessHeadersBeforeJsonCompletion_CannotAbandonIntent()
    {
        using var cancellation = new CancellationTokenSource();
        var setup = CreateClientHarness();
        var body = new BlockingResponseStream();
        setup.Handler.ResponseFactory = request =>
        {
            if (request.RequestUri!.AbsolutePath != "/api/v1/request")
            {
                return null;
            }

            var content = new StreamContent(body);
            content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
            return new HttpResponseMessage(HttpStatusCode.Created) { Content = content };
        };

        var requestTask = setup.Client.ProxyRequestAsync(
            "/api/v1/request",
            HttpMethod.Post,
            "{\"mediaType\":\"tv\",\"mediaId\":877}",
            new SeerrCaller(setup.User.Id.ToString("N"), IsAdmin: true),
            cancellation.Token);
        await body.ReadStarted.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.True(ReadState(setup).PendingTmdb.ContainsKey("tv:877"));
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => requestTask);
        Assert.True(body.CancellationObserved);
    }

    [Fact]
    public async Task AutoEnableDecision_IsFrozenBeforeDispatchDespiteInPlaceDisableAfterAcceptance()
    {
        var setup = CreateClientHarness();
        setup.Handler.BeforeResponse = request =>
        {
            if (request.RequestUri!.AbsolutePath == "/api/v1/request")
            {
                setup.Provider.Current!.SpoilerAutoEnableOnSeerrRequest = false;
            }
        };

        var result = await setup.Client.ProxyRequestAsync(
            "/api/v1/request",
            HttpMethod.Post,
            "{\"mediaType\":\"movie\",\"mediaId\":878}",
            new SeerrCaller(setup.User.Id.ToString("N"), IsAdmin: true));

        Assert.IsType<ContentResult>(result);
        Assert.False(setup.Provider.Current!.SpoilerAutoEnableOnSeerrRequest);
        Assert.True(ReadState(setup).PendingTmdb.ContainsKey("movie:878"));
    }

    private ClientHarness CreateClientHarness(ISeerrParentalFilter? parentalFilter = null)
    {
        var user = new User("intent-harness", "provider", "password-provider");
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse(
            "/api/v1/user",
            $"{{\"results\":[{{\"id\":42,\"jellyfinUserId\":\"{user.Id:N}\",\"permissions\":2}}],\"pageInfo\":{{\"page\":1,\"pages\":1,\"results\":1}}}}");
        handler.AddResponse("/api/v1/request", "{\"id\":1}", HttpStatusCode.Created);
        var provider = new FakePluginConfigProvider(new PluginConfiguration
        {
            SeerrEnabled = true,
            SeerrUrls = Source,
            SeerrApiKey = "test-key",
            SpoilerBlurEnabled = true,
            SpoilerAutoEnableOnSeerrRequest = true,
        });
        var manager = new UserConfigurationManager(
            new StubAppPaths(_directory),
            NullLogger<UserConfigurationManager>.Instance);
        var library = new CountingLibraryManager
        {
            GetItemListHook = _ => Array.Empty<BaseItem>(),
        };
        var users = new StubUserManager(user);
        var pending = new SpoilerPendingService(
            manager,
            library,
            users,
            NullLogger<SpoilerPendingService>.Instance);
        var client = new SeerrClient(
            new RecordingHttpClientFactory(handler),
            NullLogger<SeerrClient>.Instance,
            users,
            new SeerrCache(provider),
            provider,
            parentalFilter ?? new PassthroughParentalFilter(),
            pending);
        return new ClientHarness(user, users, handler, provider, manager, library, pending, client);
    }

    private static void SeedPendingCap(ClientHarness setup)
    {
        var state = new UserSpoilerBlur();
        for (var i = 0; i < SpoilerPendingService.MaxPendingTmdbPerUser; i++)
        {
            var key = $"movie:{100_000 + i}";
            state.PendingTmdb[key] = new SpoilerBlurPendingEntry
            {
                MediaType = "movie",
                TmdbId = (100_000 + i).ToString(System.Globalization.CultureInfo.InvariantCulture),
            };
        }

        setup.Manager.SaveUserConfiguration(setup.User.Id.ToString("N"), "spoilerblur.json", state);
    }

    private static UserSpoilerBlur ReadState(ClientHarness setup)
        => setup.Manager.GetUserConfiguration<UserSpoilerBlur>(
            setup.User.Id.ToString("N"),
            "spoilerblur.json");

    private static T ReadProperty<T>(object? value, string name)
        => Assert.IsType<T>(value?.GetType().GetProperty(name)?.GetValue(value));

    private sealed record ClientHarness(
        User User,
        StubUserManager Users,
        RecordingHttpMessageHandler Handler,
        FakePluginConfigProvider Provider,
        UserConfigurationManager Manager,
        CountingLibraryManager Library,
        SpoilerPendingService Pending,
        SeerrClient Client);

    private sealed class PassthroughParentalFilter : ISeerrParentalFilter
    {
        public Task<SeerrParentalResult> ApplyAsync(string json, string apiPath, SeerrCaller caller)
            => Task.FromResult(new SeerrParentalResult(false, json));

        public Task<bool> IsBlockedAsync(string mediaType, int tmdbId, SeerrCaller caller)
            => Task.FromResult(false);

        public Task<bool> IsTmdbProxyPathBlockedAsync(string tmdbApiPath, SeerrCaller caller)
            => Task.FromResult(false);
    }

    private sealed class CancelDuringResponseFilter : ISeerrParentalFilter
    {
        private readonly CancellationTokenSource _cancellation;

        public CancelDuringResponseFilter(CancellationTokenSource cancellation)
            => _cancellation = cancellation;

        public Task<SeerrParentalResult> ApplyAsync(string json, string apiPath, SeerrCaller caller)
        {
            _cancellation.Cancel();
            return Task.FromResult(new SeerrParentalResult(false, json));
        }

        public Task<bool> IsBlockedAsync(string mediaType, int tmdbId, SeerrCaller caller)
            => Task.FromResult(false);

        public Task<bool> IsTmdbProxyPathBlockedAsync(string tmdbApiPath, SeerrCaller caller)
            => Task.FromResult(false);
    }

    private sealed class BlockingResponseStream : Stream
    {
        private readonly TaskCompletionSource _readStarted = new(
            TaskCreationOptions.RunContinuationsAsynchronously);

        public Task ReadStarted => _readStarted.Task;

        public bool CancellationObserved { get; private set; }

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => throw new NotSupportedException();

        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override int Read(byte[] buffer, int offset, int count)
            => throw new NotSupportedException();

        public override async ValueTask<int> ReadAsync(
            Memory<byte> buffer,
            CancellationToken cancellationToken = default)
        {
            _readStarted.TrySetResult();
            try
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                throw new InvalidOperationException("The blocked response unexpectedly resumed.");
            }
            catch (OperationCanceledException)
            {
                CancellationObserved = true;
                throw;
            }
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override void Flush() => throw new NotSupportedException();
    }
}
