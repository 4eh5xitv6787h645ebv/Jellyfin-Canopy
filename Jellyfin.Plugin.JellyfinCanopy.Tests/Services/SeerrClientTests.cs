using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

/// <summary>
/// Covers the pure helpers on <see cref="SeerrClient"/> (formerly
/// SeerrUserResolver, now folded into the one Seerr client).
/// NormalizeUserId decides cache-key identity for the process-wide Seerr
/// user caches, and GetConfiguredUrls decides which base URLs the plugin fans
/// requests out to — both must be stable across refactors.
/// </summary>
public class SeerrClientTests
{
    // ─── NormalizeUserId ─────────────────────────────────────────────────────

    [Theory]
    [InlineData("ABCDEF12-3456-7890-ABCD-EF1234567890", "abcdef1234567890abcdef1234567890")] // hyphenated uppercase GUID
    [InlineData("abcdef12-3456-7890-abcd-ef1234567890", "abcdef1234567890abcdef1234567890")] // hyphenated lowercase GUID
    [InlineData("abcdef1234567890abcdef1234567890", "abcdef1234567890abcdef1234567890")]     // already canonical
    [InlineData("ABCDEF1234567890ABCDEF1234567890", "abcdef1234567890abcdef1234567890")]     // 32-hex uppercase
    [InlineData("", "")]
    public void NormalizeUserId_StripsDashesAndLowercases(string input, string expected)
    {
        Assert.Equal(expected, SeerrClient.NormalizeUserId(input));
    }

    [Fact]
    public void NormalizeUserId_AllGuidRenderings_ProduceTheSameKey()
    {
        // The three call patterns that historically produced distinct keys must collapse to one.
        var guid = Guid.Parse("abcdef12-3456-7890-abcd-ef1234567890");

        var canonical = SeerrClient.NormalizeUserId(guid.ToString("N"));
        var hyphenated = SeerrClient.NormalizeUserId(guid.ToString());
        var uppercased = SeerrClient.NormalizeUserId(guid.ToString().ToUpperInvariant());

        Assert.Equal(canonical, hyphenated);
        Assert.Equal(canonical, uppercased);
    }

    // ─── GetConfiguredUrls ───────────────────────────────────────────────────

    [Fact]
    public void GetConfiguredUrls_Null_ReturnsEmpty()
    {
        Assert.Empty(SeerrClient.GetConfiguredUrls(null));
    }

    [Fact]
    public void GetConfiguredUrls_BlankAndWhitespaceEntries_AreDropped()
    {
        Assert.Empty(SeerrClient.GetConfiguredUrls("  \n , ,\r\n  "));
    }

    [Fact]
    public void GetConfiguredUrls_SplitsOnNewlinesAndCommas_TrimsAndStripsTrailingSlash()
    {
        var urls = SeerrClient.GetConfiguredUrls(
            " http://seerr-a:5055/ \r\nhttp://seerr-b:5055,  https://seerr-c/base/ \n");

        Assert.Equal(
            new[] { "http://seerr-a:5055", "http://seerr-b:5055", "https://seerr-c/base" },
            urls);
    }

    [Fact]
    public void GetConfiguredUrls_EntryOfOnlySlashes_IsDropped()
    {
        // "/" trims to empty after TrimEnd('/') and must not survive as an empty base URL.
        var urls = SeerrClient.GetConfiguredUrls("/,http://seerr:5055");

        Assert.Equal(new[] { "http://seerr:5055" }, urls);
    }

    // ─── IPluginConfigProvider seam ──────────────────────────────────────────

    private static SeerrClient NewClient(FakePluginConfigProvider provider)
        => new(new ThrowingHttpClientFactory(), NullLogger<SeerrClient>.Instance, null!, new SeerrCache(provider), provider, null!);

    [Fact]
    public async Task GetSeerrUserId_ReadsConfigThroughInjectedProvider_AndSkipsWorkWhenUnconfigured()
    {
        // Plugin not loaded (provider returns null): resolver must bail out
        // before any HTTP call — the throwing factory proves no request is made.
        var provider = new FakePluginConfigProvider(config: null);
        var client = NewClient(provider);
        Assert.Null(await client.GetSeerrUserId("abcdef1234567890abcdef1234567890"));

        // Live provider re-read: same client, config appears but without
        // URL/API key — the config-gate still short-circuits before HTTP.
        provider.Current = new PluginConfiguration { SeerrUrls = "", SeerrApiKey = "" };
        Assert.Null(await client.GetSeerrUserId("abcdef1234567890abcdef1234567890"));
    }

    [Fact]
    public async Task ResolveSeerrUser_MasterDisabledWithRetainedCredentials_DoesNotCallUpstream()
    {
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse(
            "/api/v1/user",
            """{"results":[{"id":42,"jellyfinUserId":"abcdef1234567890abcdef1234567890"}],"pageInfo":{"page":1,"pages":1,"results":1}}""");
        var provider = new FakePluginConfigProvider(new PluginConfiguration
        {
            SeerrEnabled = false,
            SeerrUrls = "http://seerr:5055",
            SeerrApiKey = "retained-key",
        });
        var client = new SeerrClient(
            new RecordingHttpClientFactory(handler),
            NullLogger<SeerrClient>.Instance,
            null!,
            new SeerrCache(provider),
            provider,
            null!);

        var resolution = await client.ResolveSeerrUser(
            "abcdef1234567890abcdef1234567890",
            allowAutoImport: false);

        Assert.Equal(SeerrUserResolutionStatus.Unavailable, resolution.Status);
        Assert.Empty(handler.Sent);
    }

    [Fact]
    public async Task UserCollections_MasterDisabledWithRetainedCredentials_DoNotCallUpstream()
    {
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse("/api/v1/user/42/watchlist", """{"results":[],"pageInfo":{"page":1,"pages":1,"results":0}}""");
        handler.AddResponse("/api/v1/request", """{"results":[],"pageInfo":{"page":1,"pages":1,"results":0}}""");
        var provider = new FakePluginConfigProvider(new PluginConfiguration
        {
            SeerrEnabled = false,
            SeerrUrls = "http://seerr:5055",
            SeerrApiKey = "retained-key",
        });
        var client = new SeerrClient(
            new RecordingHttpClientFactory(handler),
            NullLogger<SeerrClient>.Instance,
            null!,
            new SeerrCache(provider),
            provider,
            null!);

        Assert.Null(await client.GetWatchlistForUser("42"));
        Assert.Null(await client.GetRequestsForUser("42"));
        Assert.Empty(handler.Sent);
    }

    [Fact]
    public async Task StatusResponse_DisabledDuringRequest_DoesNotPublishActiveCapability()
    {
        var provider = new FakePluginConfigProvider(new PluginConfiguration
        {
            SeerrEnabled = true,
            SeerrUrls = "http://seerr:5055",
            SeerrApiKey = "key",
        });
        var handler = new CallbackHandler(() => provider.Current!.SeerrEnabled = false);
        var client = new SeerrClient(
            new RecordingHttpClientFactory(handler),
            NullLogger<SeerrClient>.Instance,
            null!,
            new SeerrCache(provider),
            provider,
            null!);

        Assert.False(await client.GetStatusActiveAsync());
        Assert.Equal(1, handler.Calls);
    }

    [Fact]
    public async Task StatusFailover_DisabledWhileFirstProbeIsInFlight_DoesNotSendSecondProbe()
    {
        var provider = new FakePluginConfigProvider(new PluginConfiguration
        {
            SeerrEnabled = true,
            SeerrUrls = "http://seerr-one:5055,http://seerr-two:5055",
            SeerrApiKey = "key",
        });
        var handler = new BlockingFailedProbeHandler();
        var client = new SeerrClient(
            new RecordingHttpClientFactory(handler),
            NullLogger<SeerrClient>.Instance,
            null!,
            new SeerrCache(provider),
            provider,
            null!);

        var statusTask = client.GetStatusActiveAsync();
        await handler.FirstProbeStarted.WaitAsync(TimeSpan.FromSeconds(5));

        provider.Current!.SeerrEnabled = false;
        handler.ReleaseFirstProbe();

        Assert.False(await statusTask.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.Equal(1, handler.Calls);
    }

    private sealed class ThrowingHttpClientFactory : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) =>
            throw new InvalidOperationException("Unexpected outbound HTTP call: the config gate should have short-circuited.");
    }

    private sealed class CallbackHandler(Action callback) : HttpMessageHandler
    {
        private int _calls;

        public int Calls => Volatile.Read(ref _calls);

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            _ = request;
            cancellationToken.ThrowIfCancellationRequested();
            Interlocked.Increment(ref _calls);
            callback();
            return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.OK)
            {
                Content = new StringContent("{}", System.Text.Encoding.UTF8, "application/json"),
            });
        }
    }

    private sealed class BlockingFailedProbeHandler : HttpMessageHandler
    {
        private readonly TaskCompletionSource _firstProbeStarted =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _releaseFirstProbe =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _calls;

        public Task FirstProbeStarted => _firstProbeStarted.Task;

        public int Calls => Volatile.Read(ref _calls);

        public void ReleaseFirstProbe() => _releaseFirstProbe.TrySetResult();

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            _ = request;
            var call = Interlocked.Increment(ref _calls);
            if (call == 1)
            {
                _firstProbeStarted.TrySetResult();
                await _releaseFirstProbe.Task.WaitAsync(cancellationToken);
            }

            return new HttpResponseMessage(System.Net.HttpStatusCode.ServiceUnavailable)
            {
                Content = new StringContent(
                    "{\"message\":\"unavailable\"}",
                    System.Text.Encoding.UTF8,
                    "application/json"),
            };
        }
    }
}
