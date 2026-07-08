using System.Net;
using System.Text;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.TestDoubles;

/// <summary>
/// <see cref="IHttpClientFactory"/> double that records which named client each
/// consumer asks for and keeps every created <see cref="HttpClient"/>, so tests
/// can assert the HTTP hygiene rules: services request their upstream's named
/// client, and never mutate <c>DefaultRequestHeaders</c> on a factory client.
/// </summary>
public sealed class RecordingHttpClientFactory : IHttpClientFactory
{
    private readonly HttpMessageHandler _handler;

    public RecordingHttpClientFactory(HttpMessageHandler handler) => _handler = handler;

    public List<string> RequestedNames { get; } = new();

    public List<HttpClient> CreatedClients { get; } = new();

    public HttpClient CreateClient(string name)
    {
        RequestedNames.Add(name);
        var client = new HttpClient(_handler, disposeHandler: false);
        CreatedClients.Add(client);
        return client;
    }
}

/// <summary>
/// Handler that records every outbound request (including the headers present on
/// the request itself, captured at send time — i.e. per-request headers, not
/// client defaults merged in later) and answers by URL-path suffix.
/// </summary>
public sealed class RecordingHttpMessageHandler : HttpMessageHandler
{
    private readonly Dictionary<string, (string Body, HttpStatusCode Status)> _responses = new();

    public List<HttpRequestMessage> Requests { get; } = new();

    /// <summary>X-Api-Key values as they appeared on each request at send time.</summary>
    public List<string> ApiKeyHeaders { get; } = new();

    /// <summary>Each request's method, path and body captured at send time (the request/content is
    /// disposed by the caller's <c>using</c> once SendAsync returns, so the body must be read here).</summary>
    public List<CapturedRequest> Sent { get; } = new();

    public sealed record CapturedRequest(HttpMethod Method, string Path, string Body);

    public void AddResponse(string pathSuffix, string body, HttpStatusCode status = HttpStatusCode.OK)
        => _responses[pathSuffix] = (body, status);

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Requests.Add(request);
        if (request.Headers.TryGetValues("X-Api-Key", out var values))
        {
            ApiKeyHeaders.AddRange(values);
        }

        // StringContent buffers, so ReadAsStringAsync completes synchronously — safe to block here.
        var body = request.Content != null
            ? request.Content.ReadAsStringAsync(cancellationToken).GetAwaiter().GetResult()
            : string.Empty;
        Sent.Add(new CapturedRequest(request.Method, request.RequestUri!.AbsolutePath, body));

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
