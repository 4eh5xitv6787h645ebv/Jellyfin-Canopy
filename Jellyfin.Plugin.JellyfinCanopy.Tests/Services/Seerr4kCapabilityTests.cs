using System.Net.Http;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

/// <summary>
/// Pins <see cref="SeerrClient.GetSeerr4kCapabilityAsync"/>: the server 4K
/// capability comes from Seerr's user-neutral <c>/api/v1/settings/public</c>
/// (fetched with NO per-user header so it is safe to share-cache) combined with
/// the caller's own Seerr 4K permissions, and short-circuits without a user
/// lookup when the server has no 4K at all.
/// </summary>
public class Seerr4kCapabilityTests
{
    private const string UserId = "3f2504e04f8941d39a0c0305e82c3301";

    private static PluginConfiguration Config() => new()
    {
        SeerrEnabled = true,
        SeerrUrls = "http://seerr:5055",
        SeerrApiKey = "test-key",
    };

    private static (SeerrClient client, RecordingHttpMessageHandler handler) NewClient()
        => NewClient(Config());

    private static (SeerrClient client, RecordingHttpMessageHandler handler) NewClient(PluginConfiguration config)
    {
        var handler = new RecordingHttpMessageHandler();
        var provider = new FakePluginConfigProvider(config);
        var client = new SeerrClient(
            new RecordingHttpClientFactory(handler),
            NullLogger<SeerrClient>.Instance,
            null!,
            new SeerrCache(provider),
            provider,
            new PassthroughParentalFilter());
        return (client, handler);
    }

    [Fact]
    public async Task Capability_CombinesPublicSettingsWithUserPermissions()
    {
        var (client, handler) = NewClient();
        handler.AddResponse("/api/v1/settings/public", "{\"movie4kEnabled\":true,\"series4kEnabled\":false}");
        // permissions 1024 == REQUEST_4K (global 4K grant, covers movie + TV).
        handler.AddResponse("/api/v1/user", $"{{\"results\":[{{\"id\":42,\"jellyfinUserId\":\"{UserId}\",\"permissions\":1024}}]}}");

        var cap = await client.GetSeerr4kCapabilityAsync(UserId);

        Assert.True(cap.Movie4kEnabled);
        Assert.False(cap.Series4kEnabled);
        // Movie 4K available (server enabled + REQUEST_4K); TV hidden (server off).
        Assert.True(cap.CanRequest4kMovie);
        Assert.False(cap.CanRequest4kTv);
    }

    [Fact]
    public async Task PublicSettingsFetch_CarriesNoXApiUser()
    {
        var (client, handler) = NewClient();
        handler.AddResponse("/api/v1/settings/public", "{\"movie4kEnabled\":true,\"series4kEnabled\":true}");
        handler.AddResponse("/api/v1/user", $"{{\"results\":[{{\"id\":42,\"jellyfinUserId\":\"{UserId}\",\"permissions\":1024}}]}}");

        await client.GetSeerr4kCapabilityAsync(UserId);

        var settingsRequest = Assert.Single(handler.Requests.FindAll(r => r.RequestUri!.AbsolutePath == "/api/v1/settings/public"));
        Assert.False(
            settingsRequest.Headers.Contains("X-Api-User"),
            "settings/public is user-neutral and share-cached — it must not carry the per-user X-Api-User header");
    }

    [Fact]
    public async Task NoServer4k_ShortCircuits_WithoutUserLookup()
    {
        var (client, handler) = NewClient();
        handler.AddResponse("/api/v1/settings/public", "{\"movie4kEnabled\":false,\"series4kEnabled\":false}");

        var cap = await client.GetSeerr4kCapabilityAsync(UserId);

        Assert.False(cap.Movie4kEnabled);
        Assert.False(cap.Series4kEnabled);
        Assert.False(cap.CanRequest4kMovie);
        Assert.False(cap.CanRequest4kTv);
        // With no server 4K there is nothing to request — the user lookup is skipped.
        Assert.Empty(handler.Requests.FindAll(r => r.RequestUri!.AbsolutePath == "/api/v1/user"));
    }

    [Fact]
    public async Task NoUserPermission_HidesEvenWhenServerEnabled()
    {
        var (client, handler) = NewClient();
        handler.AddResponse("/api/v1/settings/public", "{\"movie4kEnabled\":true,\"series4kEnabled\":true}");
        // permissions 262144 == REQUEST_MOVIE only (base request, no 4K bits).
        handler.AddResponse("/api/v1/user", $"{{\"results\":[{{\"id\":42,\"jellyfinUserId\":\"{UserId}\",\"permissions\":262144}}]}}");

        var cap = await client.GetSeerr4kCapabilityAsync(UserId);

        Assert.True(cap.Movie4kEnabled);
        Assert.True(cap.Series4kEnabled);
        Assert.False(cap.CanRequest4kMovie);
        Assert.False(cap.CanRequest4kTv);
    }

    [Fact]
    public async Task AdminCaller_ProjectsServer4kAndMasterSwitch_IgnoringUserPermission()
    {
        // A Jellyfin admin bypasses the Seerr per-user 4K gate in the proxy, so the
        // capability projection must report server-4K-enabled (AND the JC master
        // switch) even though the linked Seerr user holds no 4K bits.
        var config = Config();
        config.SeerrEnable4KRequests = true;
        config.SeerrEnable4KTvRequests = true;
        var (client, handler) = NewClient(config);
        handler.AddResponse("/api/v1/settings/public", "{\"movie4kEnabled\":true,\"series4kEnabled\":true}");
        // 262144 == REQUEST_MOVIE (base only, no 4K bits) — irrelevant for an admin.
        handler.AddResponse("/api/v1/user", $"{{\"results\":[{{\"id\":42,\"jellyfinUserId\":\"{UserId}\",\"permissions\":262144}}]}}");

        var cap = await client.GetSeerr4kCapabilityAsync(UserId, isAdmin: true);

        Assert.True(cap.CanRequest4kMovie);
        Assert.True(cap.CanRequest4kTv);
    }

    [Fact]
    public async Task AdminCaller_MasterSwitchOff_HidesEvenThoughServerEnabled()
    {
        // The JC 4K master switch applies to admins too (consistent with the gate
        // order): with it off, an admin gets no 4K capability despite server 4K.
        var (client, handler) = NewClient(Config()); // master switches default false
        handler.AddResponse("/api/v1/settings/public", "{\"movie4kEnabled\":true,\"series4kEnabled\":true}");

        var cap = await client.GetSeerr4kCapabilityAsync(UserId, isAdmin: true);

        Assert.True(cap.Movie4kEnabled);
        Assert.True(cap.Series4kEnabled);
        Assert.False(cap.CanRequest4kMovie);
        Assert.False(cap.CanRequest4kTv);
    }

    private sealed class PassthroughParentalFilter : ISeerrParentalFilter
    {
        public Task<SeerrParentalResult> ApplyAsync(string json, string apiPath, SeerrCaller caller)
            => Task.FromResult(new SeerrParentalResult(false, json));

        public Task<bool> IsBlockedAsync(string mediaType, int tmdbId, SeerrCaller caller)
            => Task.FromResult(false);

        public Task<bool> IsTmdbProxyPathBlockedAsync(string tmdbApiPath, SeerrCaller caller)
            => Task.FromResult(false);
    }
}
