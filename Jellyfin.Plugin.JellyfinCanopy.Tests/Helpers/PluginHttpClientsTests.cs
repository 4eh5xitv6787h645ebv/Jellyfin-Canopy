using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Helpers;

/// <summary>
/// Covers the named-client selection and per-request header construction in
/// <see cref="PluginHttpClients"/> — the arr/tmdb counterpart to the Seerr
/// client in SeerrHttpHelper.
/// </summary>
public class PluginHttpClientsTests
{
    private static RecordingHttpClientFactory NewFactory()
        => new RecordingHttpClientFactory(new RecordingHttpMessageHandler());

    [Fact]
    public void CreateArrClient_RequestsTheNamedArrClient()
    {
        var factory = NewFactory();

        var client = PluginHttpClients.CreateArrClient(factory);

        Assert.NotNull(client);
        Assert.Equal("JellyfinCanopyArr", Assert.Single(factory.RequestedNames));
    }

    [Fact]
    public void CreateTmdbClient_RequestsTheNamedTmdbClient()
    {
        var factory = NewFactory();

        var client = PluginHttpClients.CreateTmdbClient(factory);

        Assert.NotNull(client);
        Assert.Equal("JellyfinCanopyTmdb", Assert.Single(factory.RequestedNames));
    }

    [Fact]
    public void CreateClients_FallBackToDefaultClient_WhenNamedRegistrationIsUnavailable()
    {
        // Mirrors SeerrHttpHelper.CreateClient: a host without the named
        // registration must still get a working (unnamed) client.
        var factory = new NamedRegistrationsThrowFactory();

        var arr = PluginHttpClients.CreateArrClient(factory);
        var tmdb = PluginHttpClients.CreateTmdbClient(factory);

        Assert.NotNull(arr);
        Assert.NotNull(tmdb);
        Assert.Equal(
            new[] { "JellyfinCanopyArr", string.Empty, "JellyfinCanopyTmdb", string.Empty },
            factory.RequestedNames);
    }

    [Fact]
    public void BuildArrRequest_AttachesApiKeyToTheRequest_NotToAnyClient()
    {
        using var request = PluginHttpClients.BuildArrRequest(
            HttpMethod.Get, "http://localhost:8989/api/v3/system/status", "secret-key");

        Assert.Equal(HttpMethod.Get, request.Method);
        Assert.Equal("http://localhost:8989/api/v3/system/status", request.RequestUri!.ToString());
        Assert.Equal("secret-key", Assert.Single(request.Headers.GetValues("X-Api-Key")));
    }

    /// <summary>Factory whose named registrations throw; only the unnamed default works.</summary>
    private sealed class NamedRegistrationsThrowFactory : IHttpClientFactory
    {
        public List<string> RequestedNames { get; } = new();

        public HttpClient CreateClient(string name)
        {
            RequestedNames.Add(name);
            if (name.Length > 0)
            {
                throw new InvalidOperationException($"No client registered for '{name}'");
            }

            return new HttpClient(new RecordingHttpMessageHandler(), disposeHandler: false);
        }
    }
}
