using System.Net;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

/// <summary>
/// The administrator-scoped Seerr settings read that powers "Import from
/// Seerr". It must reach the fixed settings paths with the configured API key
/// alone — never a resolved or impersonated Seerr user — because server
/// configuration must remain importable by an administrator who has no linked
/// Seerr account.
/// </summary>
public sealed class SeerrAdminSettingsReadTests
{
    private const string SonarrSettings = """[{"name":"TV","hostname":"sonarr","port":8989,"apiKey":"arr-key"}]""";

    private static PluginConfiguration Config(bool enabled = true, string urls = "http://seerr:5055") => new()
    {
        SeerrEnabled = enabled,
        SeerrUrls = urls,
        SeerrApiKey = "seerr-key",
    };

    private static (SeerrClient Client, RecordingHttpMessageHandler Handler) NewClient(PluginConfiguration config)
    {
        var handler = new RecordingHttpMessageHandler();
        var provider = new FakePluginConfigProvider(config);
        var client = new SeerrClient(
            new RecordingHttpClientFactory(handler),
            NullLogger<SeerrClient>.Instance,
            userManager: null!,
            new SeerrCache(provider),
            provider,
            parentalFilter: null!,
            spoilerPendingService: null!);
        return (client, handler);
    }

    [Theory]
    [InlineData(SeerrAdminSettings.Sonarr, "/api/v1/settings/sonarr")]
    [InlineData(SeerrAdminSettings.Radarr, "/api/v1/settings/radarr")]
    public async Task ReadsTheFixedSettingsPathWithTheApiKeyAndNoUserHeader(
        SeerrAdminSettings settings, string expectedPath)
    {
        var (client, handler) = NewClient(Config());
        handler.AddResponse(expectedPath, SonarrSettings);

        var json = await client.GetAdminSettingsJsonAsync(settings);

        Assert.Equal(SonarrSettings, json);
        var request = Assert.Single(handler.Requests);
        Assert.Equal(expectedPath, request.RequestUri!.AbsolutePath);
        Assert.Contains("seerr-key", handler.ApiKeyHeaders);
        // No Seerr user is resolved or impersonated for server configuration.
        Assert.False(request.Headers.Contains("X-Api-User"));
        Assert.DoesNotContain(handler.Requests, r => r.RequestUri!.AbsolutePath == "/api/v1/user");
    }

    [Fact]
    public async Task ReturnsNullWithoutAnyRequestWhenTheIntegrationIsDisabled()
    {
        var (client, handler) = NewClient(Config(enabled: false));

        Assert.Null(await client.GetAdminSettingsJsonAsync(SeerrAdminSettings.Sonarr));
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task FailsOverToTheNextConfiguredUrlAfterAnUpstreamError()
    {
        var (client, handler) = NewClient(Config(urls: "http://seerr-a:5055\nhttp://seerr-b:5055"));
        handler.ResponseFactory = request =>
            string.Equals(request.RequestUri!.Host, "seerr-a", StringComparison.OrdinalIgnoreCase)
                ? new HttpResponseMessage(HttpStatusCode.InternalServerError)
                {
                    Content = new StringContent("{}", System.Text.Encoding.UTF8, "application/json"),
                }
                : new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(SonarrSettings, System.Text.Encoding.UTF8, "application/json"),
                };

        var json = await client.GetAdminSettingsJsonAsync(SeerrAdminSettings.Sonarr);

        Assert.Equal(SonarrSettings, json);
        Assert.Equal(2, handler.Requests.Count);
        Assert.Equal("seerr-a", handler.Requests[0].RequestUri!.Host);
        Assert.Equal("seerr-b", handler.Requests[1].RequestUri!.Host);
    }

    [Fact]
    public async Task ReturnsNullWhenEveryConfiguredUrlFails()
    {
        var (client, handler) = NewClient(Config(urls: "http://seerr-a:5055\nhttp://seerr-b:5055"));
        handler.ResponseFactory = _ => throw new HttpRequestException("unreachable");

        Assert.Null(await client.GetAdminSettingsJsonAsync(SeerrAdminSettings.Sonarr));
        Assert.Equal(2, handler.Requests.Count);
    }
}
