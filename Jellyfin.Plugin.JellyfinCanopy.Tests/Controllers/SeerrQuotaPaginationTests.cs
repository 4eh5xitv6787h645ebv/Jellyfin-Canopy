using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers;

public class SeerrQuotaPaginationTests
{
    private static readonly DateTime StableNow = DateTime.UtcNow;

    [Fact]
    public async Task RequestHistory_ReadsOldestSentinelBeyondFirstHundredRows()
    {
        var handler = new RoutingHandler(uri => QueryInt(uri, "skip") switch
        {
            0 => Page(1, 2, 101, Enumerable.Range(1, 100).ToArray()),
            100 => Page(2, 2, 101, 101),
            var skip => throw new InvalidOperationException($"Unexpected skip {skip}."),
        });
        using var client = new HttpClient(handler);

        var result = await SeerrProxyController.FetchQuotaRequestHistoryAsync(
            client,
            "http://seerr",
            "key",
            "7",
            CancellationToken.None);

        Assert.True(result.IsComplete, result.FailureReason);
        Assert.Equal(101, result.Items.Count);
        Assert.Equal(101, result.Items[^1].GetProperty("id").GetInt32());
        Assert.Equal(new[] { 0, 100, 0, 100 }, handler.Requests.Select(uri => QueryInt(uri, "skip")));
        Assert.All(handler.Requests, uri => Assert.Equal("/api/v1/user/7/requests", uri.AbsolutePath));
        Assert.All(handler.Requests, uri => Assert.Null(QueryValue(uri, "requestedBy")));
        Assert.All(handler.Requests, uri => Assert.Null(QueryValue(uri, "mediaType")));
    }

    [Fact]
    public async Task RequestHistory_LaterPageFailure_IsIncompleteWithoutPrefix()
    {
        var handler = new RoutingHandler(uri => QueryInt(uri, "skip") switch
        {
            0 => Page(1, 2, 101, Enumerable.Range(1, 100).ToArray()),
            100 => Json(new { error = "temporary" }, HttpStatusCode.BadGateway),
            var skip => throw new InvalidOperationException($"Unexpected skip {skip}."),
        });
        using var client = new HttpClient(handler);

        var result = await SeerrProxyController.FetchQuotaRequestHistoryAsync(
            client,
            "http://seerr",
            "key",
            "7",
            CancellationToken.None);

        Assert.False(result.IsComplete);
        Assert.Empty(result.Items);
        Assert.Equal(2, handler.Requests.Count);
    }

    private static HttpResponseMessage Page(int page, int pages, int totalResults, params int[] ids)
        => Json(new
        {
            results = ids.Select(id => new
            {
                id,
                status = 2,
                createdAt = StableNow.AddMinutes(id).ToString("O", CultureInfo.InvariantCulture),
            }).ToArray(),
            pageInfo = new { page, pages, results = totalResults },
        });

    private static HttpResponseMessage Json(object body, HttpStatusCode status = HttpStatusCode.OK)
        => new(status)
        {
            Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json"),
        };

    private static int QueryInt(Uri uri, string name)
        => int.Parse(
            QueryValue(uri, name)
                ?? throw new InvalidOperationException($"Missing query parameter '{name}' from {uri}."),
            CultureInfo.InvariantCulture);

    private static string? QueryValue(Uri uri, string name)
    {
        foreach (var pair in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = pair.Split('=', 2);
            if (parts.Length == 2 && string.Equals(parts[0], name, StringComparison.Ordinal))
            {
                return Uri.UnescapeDataString(parts[1]);
            }
        }

        return null;
    }

    private sealed class RoutingHandler : HttpMessageHandler
    {
        private readonly Func<Uri, HttpResponseMessage> _route;

        public RoutingHandler(Func<Uri, HttpResponseMessage> route) => _route = route;

        public List<Uri> Requests { get; } = new();

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Requests.Add(request.RequestUri!);
            return Task.FromResult(_route(request.RequestUri!));
        }
    }
}
