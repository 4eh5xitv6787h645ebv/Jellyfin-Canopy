using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
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
    public void CreateMaintainerrClient_FailsClosedWhenNamedRegistrationIsUnavailable()
    {
        var factory = new NamedRegistrationsThrowFactory();

        Assert.Throws<InvalidOperationException>(
            () => PluginHttpClients.CreateMaintainerrClient(factory));
        Assert.Equal(new[] { PluginHttpClients.MaintainerrClient }, factory.RequestedNames);
    }

    [Fact]
    public void MaintainerrHandler_DisablesProxyDelegation()
    {
        using var handler = PluginHttpClients.CreateMaintainerrHandler();

        Assert.False(handler.UseProxy);
    }

    [Fact]
    public void QbittorrentHandler_OwnsNoAmbientCredentialsRedirectsCookiesOrProxy()
    {
        using var handler = PluginHttpClients.CreateQbittorrentHandler();

        Assert.False(handler.AllowAutoRedirect);
        Assert.False(handler.UseCookies);
        Assert.False(handler.UseProxy);
        Assert.Null(handler.Credentials);
    }

    [Fact]
    public async Task MaintainerrHandler_DoesNotReplayAnUpstreamResponseCookie()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var endpoint = Assert.IsType<IPEndPoint>(listener.LocalEndpoint);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var capturedRequests = CaptureRequestsAsync(listener, 2, deadline.Token);

        using var handler = PluginHttpClients.CreateMaintainerrHandler();
        using var client = new HttpClient(handler);
        var target = new Uri(
            $"http://127.0.0.1:{endpoint.Port}/api/health/ready",
            UriKind.Absolute);
        using var first = await client.GetAsync(target, deadline.Token);
        using var second = await client.GetAsync(target, deadline.Token);
        var requests = await capturedRequests;

        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        Assert.All(
            requests,
            request => Assert.DoesNotContain(
                "\r\nCookie:",
                request,
                StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task QbittorrentHandler_DoesNotReplayAnUpstreamResponseCookie()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var endpoint = Assert.IsType<IPEndPoint>(listener.LocalEndpoint);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var capturedRequests = CaptureRequestsAsync(listener, 2, deadline.Token);

        using var handler = PluginHttpClients.CreateQbittorrentHandler();
        using var client = new HttpClient(handler);
        var target = new Uri($"http://127.0.0.1:{endpoint.Port}/api/v2/app/version", UriKind.Absolute);
        using var first = await client.GetAsync(target, deadline.Token);
        using var second = await client.GetAsync(target, deadline.Token);
        var requests = await capturedRequests;

        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        Assert.All(
            requests,
            request => Assert.DoesNotContain("\r\nCookie:", request, StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task MaintainerrNamedClient_DoesNotLogItsRawUpstreamUri()
    {
        const string controlMarker = "http-client-control-marker";
        const string privateHostMarker = "maintainerr-private-host-marker.invalid";
        const string itemPathMarker = "maintainerr-item-path-marker";
        var logs = new CapturingLoggerProvider();
        var services = new ServiceCollection();
        services.AddLogging(builder =>
        {
            builder.SetMinimumLevel(LogLevel.Trace);
            builder.AddProvider(logs);
        });
        services.AddHttpClient("logging-control")
            .ConfigurePrimaryHttpMessageHandler(() => new RecordingHttpMessageHandler());
        PluginServiceRegistrator.RegisterMaintainerrHttpClient(services);

        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        using var serviceProvider = services.BuildServiceProvider();
        var factory = serviceProvider.GetRequiredService<IHttpClientFactory>();
        using (var control = factory.CreateClient("logging-control"))
        using (var response = await control.GetAsync(
                   $"http://control.invalid/{controlMarker}",
                   deadline.Token))
        {
            Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        }

        using (var maintainerr = factory.CreateClient(PluginHttpClients.MaintainerrClient))
        {
            maintainerr.Timeout = TimeSpan.FromSeconds(2);
            await Assert.ThrowsAsync<HttpRequestException>(
                () => maintainerr.GetAsync(
                    $"http://{privateHostMarker}/{itemPathMarker}",
                    deadline.Token));
        }

        Assert.Contains(
            logs.Messages,
            message => message.Contains(controlMarker, StringComparison.Ordinal));
        Assert.DoesNotContain(
            logs.Messages,
            message => message.Contains(privateHostMarker, StringComparison.Ordinal)
                || message.Contains(itemPathMarker, StringComparison.Ordinal));
    }

    [Fact]
    public async Task QbittorrentNamedClient_DoesNotLogPrivateTopologyOrApiPaths()
    {
        const string privateHostMarker = "qbittorrent-private-host-marker.invalid";
        const string apiPathMarker = "qbittorrent-api-path-marker";
        var logs = new CapturingLoggerProvider();
        var services = new ServiceCollection();
        services.AddLogging(builder =>
        {
            builder.SetMinimumLevel(LogLevel.Trace);
            builder.AddProvider(logs);
        });
        PluginServiceRegistrator.RegisterQbittorrentHttpClient(services);

        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        using var serviceProvider = services.BuildServiceProvider();
        using var client = serviceProvider.GetRequiredService<IHttpClientFactory>()
            .CreateClient(PluginHttpClients.QbittorrentClient);
        client.Timeout = TimeSpan.FromSeconds(2);
        await Assert.ThrowsAsync<HttpRequestException>(
            () => client.GetAsync($"http://{privateHostMarker}/{apiPathMarker}", deadline.Token));

        Assert.DoesNotContain(
            logs.Messages,
            message => message.Contains(privateHostMarker, StringComparison.Ordinal)
                || message.Contains(apiPathMarker, StringComparison.Ordinal));
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

    private static async Task<IReadOnlyList<string>> CaptureRequestsAsync(
        TcpListener listener,
        int count,
        CancellationToken cancellationToken)
    {
        var requests = new List<string>(count);
        for (var index = 0; index < count; index++)
        {
            using var connection = await listener.AcceptTcpClientAsync(cancellationToken);
            await using var stream = connection.GetStream();
            requests.Add(await ReadRequestHeadersAsync(stream, cancellationToken));

            var setCookie = index == 0
                ? "Set-Cookie: maintainerr-session=must-not-return; Path=/\r\n"
                : string.Empty;
            var response = Encoding.ASCII.GetBytes(
                "HTTP/1.1 200 OK\r\n"
                + "Content-Type: application/json\r\n"
                + "Content-Length: 2\r\n"
                + setCookie
                + "Connection: close\r\n"
                + "\r\n{}");
            await stream.WriteAsync(response, cancellationToken);
        }

        return requests;
    }

    private static async Task<string> ReadRequestHeadersAsync(
        NetworkStream stream,
        CancellationToken cancellationToken)
    {
        const int maximumHeaderBytes = 16 * 1024;
        var buffer = new byte[1024];
        using var request = new MemoryStream();
        while (request.Length < maximumHeaderBytes)
        {
            var read = await stream.ReadAsync(buffer, cancellationToken);
            if (read == 0)
            {
                break;
            }

            request.Write(buffer, 0, read);
            var text = Encoding.ASCII.GetString(request.GetBuffer(), 0, checked((int)request.Length));
            if (text.Contains("\r\n\r\n", StringComparison.Ordinal))
            {
                return text;
            }
        }

        throw new InvalidDataException("HTTP request headers exceeded the bounded test fixture.");
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

    private sealed class CapturingLoggerProvider : ILoggerProvider
    {
        public ConcurrentQueue<string> Messages { get; } = new();

        public ILogger CreateLogger(string categoryName) => new CapturingLogger(Messages);

        public void Dispose()
        {
        }

        private sealed class CapturingLogger : ILogger
        {
            private readonly ConcurrentQueue<string> _messages;

            public CapturingLogger(ConcurrentQueue<string> messages) => _messages = messages;

            public IDisposable? BeginScope<TState>(TState state)
                where TState : notnull
                => null;

            public bool IsEnabled(LogLevel logLevel) => logLevel != LogLevel.None;

            public void Log<TState>(
                LogLevel logLevel,
                EventId eventId,
                TState state,
                Exception? exception,
                Func<TState, Exception?, string> formatter)
                => _messages.Enqueue(formatter(state, exception));
        }
    }
}
