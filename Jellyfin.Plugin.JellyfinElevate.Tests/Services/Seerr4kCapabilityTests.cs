using System.Net.Http;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinElevate.Configuration;
using Jellyfin.Plugin.JellyfinElevate.Services.Jellyseerr;
using Jellyfin.Plugin.JellyfinElevate.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.Services;

/// <summary>
/// Pins <see cref="JellyseerrClient.GetSeerr4kCapabilityAsync"/>: the server 4K
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
        JellyseerrEnabled = true,
        JellyseerrUrls = "http://seerr:5055",
        JellyseerrApiKey = "test-key",
    };

    private static (JellyseerrClient client, RecordingHttpMessageHandler handler) NewClient()
    {
        var handler = new RecordingHttpMessageHandler();
        var provider = new FakePluginConfigProvider(Config());
        var client = new JellyseerrClient(
            new RecordingHttpClientFactory(handler),
            NullLogger<JellyseerrClient>.Instance,
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

    private sealed class PassthroughParentalFilter : ISeerrParentalFilter
    {
        public Task<SeerrParentalResult> ApplyAsync(string json, string apiPath, JellyseerrCaller caller)
            => Task.FromResult(new SeerrParentalResult(false, json));

        public Task<bool> IsBlockedAsync(string mediaType, int tmdbId, JellyseerrCaller caller)
            => Task.FromResult(false);

        public Task<bool> IsTmdbProxyPathBlockedAsync(string tmdbApiPath, JellyseerrCaller caller)
            => Task.FromResult(false);
    }
}
