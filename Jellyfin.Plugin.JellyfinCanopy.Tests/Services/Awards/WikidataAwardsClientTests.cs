using System.Text;
using System.Net.Http.Headers;
using System.Net;
using Microsoft.Extensions.Logging.Abstractions;
using Jellyfin.Plugin.JellyfinCanopy.Services.Awards;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services.Awards;

public sealed class WikidataAwardsClientTests
{
    [Fact]
    public void ParsePage_ValidatesAndIsolatesProviderNamespaces()
    {
        var records = WikidataAwardsClient.ParsePage(Encoding.UTF8.GetBytes("""
            {"results":{"bindings":[
              {"item":{"value":"http://www.wikidata.org/entity/Q42"},"kind":{"value":"Movie"},"outcome":{"value":"win"},"awardLabel":{"value":"Best Picture"},"date":{"value":"2024-02-10T00:00:00Z"},"imdb":{"value":"tt1234567"},"tmdbMovie":{"value":"123"},"tmdbSeries":{"value":"999"}},
              {"item":{"value":"Q84"},"kind":{"value":"Series"},"outcome":{"value":"nomination"},"awardLabel":{"value":"Best Series"},"tmdbMovie":{"value":"111"},"tmdbSeries":{"value":"456"},"tvdb":{"value":"789"}}
            ]}}
            """));

        Assert.Equal(4, records.Count);
        Assert.Contains(records, record => record.MediaKind == AwardsMediaKind.Movie && record.Provider == "tmdb" && record.ProviderId == "123");
        Assert.DoesNotContain(records, record => record.MediaKind == AwardsMediaKind.Movie && record.ProviderId == "999");
        Assert.Contains(records, record => record.MediaKind == AwardsMediaKind.Series && record.Provider == "tvdb" && record.ProviderId == "789");
        Assert.DoesNotContain(records, record => record.MediaKind == AwardsMediaKind.Series && record.ProviderId == "111");
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"results\":{\"bindings\":{}}}")]
    [InlineData("{\"results\":{\"bindings\":[{\"item\":{\"value\":\"Q0\"}}]}}")]
    public void ParsePage_RejectsMalformedPayload(string json)
        => Assert.Throws<InvalidDataException>(() =>
            WikidataAwardsClient.ParsePage(Encoding.UTF8.GetBytes(json)));

    [Fact]
    public void ParsePage_RejectsInvalidProviderIdentifier()
        => Assert.Throws<InvalidDataException>(() => WikidataAwardsClient.ParsePage(Encoding.UTF8.GetBytes("""
            {"results":{"bindings":[{"item":{"value":"Q42"},"kind":{"value":"Movie"},"outcome":{"value":"win"},"awardLabel":{"value":"Award"},"imdb":{"value":"javascript:1"}}]}}
            """)));

    [Fact]
    public void BuildQuery_IsPagedDeterministicallyAndUsesOfficialAwardProperties()
    {
        var query = WikidataAwardsClient.BuildQuery(5000);
        Assert.Contains("p:P166", query, StringComparison.Ordinal);
        Assert.Contains("p:P1411", query, StringComparison.Ordinal);
        Assert.Contains("ORDER BY", query, StringComparison.Ordinal);
        Assert.Contains("LIMIT 5000", query, StringComparison.Ordinal);
        Assert.Contains("OFFSET 5000", query, StringComparison.Ordinal);
    }

    [Fact]
    public void RetryDelay_RefusesToViolateLongRetryAfter()
    {
        var retryAfter = new RetryConditionHeaderValue(TimeSpan.FromMinutes(2));
        Assert.Throws<InvalidOperationException>(() => WikidataAwardsClient.RetryDelay(retryAfter, 1));
    }

    [Fact]
    public async Task FetchComplete_RetriesThrottleWithRetryAfterAndUsesDescriptiveUserAgent()
    {
        var calls = 0;
        var delays = new List<TimeSpan>();
        var client = CreateClient(async (request, cancellationToken) =>
        {
            await Task.Yield();
            calls++;
            Assert.Contains("JellyfinCanopy-Awards/2.0", request.Headers.UserAgent.ToString(), StringComparison.Ordinal);
            if (calls == 1)
            {
                var throttled = new HttpResponseMessage(HttpStatusCode.TooManyRequests);
                throttled.Headers.RetryAfter = new RetryConditionHeaderValue(TimeSpan.FromSeconds(7));
                return throttled;
            }

            return JsonResponse("{\"results\":{\"bindings\":[]}}");
        }, (delay, _) =>
        {
            delays.Add(delay);
            return Task.CompletedTask;
        });

        var snapshot = await client.FetchCompleteAsync(CancellationToken.None);

        Assert.Empty(snapshot.Records);
        Assert.Equal(2, calls);
        Assert.Equal([TimeSpan.FromSeconds(7)], delays);
    }

    [Fact]
    public async Task FetchComplete_RetriesBoundedTimeoutThenFails()
    {
        var calls = 0;
        var client = CreateClient(async (_, cancellationToken) =>
        {
            calls++;
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            throw new InvalidOperationException("unreachable");
        }, (_, _) => Task.CompletedTask, TimeSpan.FromMilliseconds(5));

        await Assert.ThrowsAsync<TimeoutException>(() => client.FetchCompleteAsync(CancellationToken.None));
        Assert.Equal(3, calls);
    }

    [Fact]
    public async Task FetchComplete_RejectsDeclaredOversizedResponseWithoutRetrying()
    {
        var calls = 0;
        var client = CreateClient((_, _) =>
        {
            calls++;
            var response = JsonResponse("{}");
            response.Content.Headers.ContentLength = WikidataAwardsClient.MaxResponseBytes + 1L;
            return Task.FromResult(response);
        }, (_, _) => Task.CompletedTask);

        await Assert.ThrowsAsync<InvalidDataException>(() => client.FetchCompleteAsync(CancellationToken.None));
        Assert.Equal(1, calls);
    }

    [Fact]
    public async Task FetchComplete_RejectsAFullFinalPageAsPartial()
    {
        const string binding = "{\"item\":{\"value\":\"Q42\"},\"kind\":{\"value\":\"Movie\"},\"outcome\":{\"value\":\"win\"},\"awardLabel\":{\"value\":\"Award\"},\"tmdbMovie\":{\"value\":\"42\"}}";
        var body = "{\"results\":{\"bindings\":[" + string.Join(',', Enumerable.Repeat(binding, WikidataAwardsClient.PageSize)) + "]}}";
        var client = CreateClient(
            (_, _) => Task.FromResult(JsonResponse(body)),
            (_, _) => Task.CompletedTask,
            maxPages: 1);

        await Assert.ThrowsAsync<InvalidDataException>(() => client.FetchCompleteAsync(CancellationToken.None));
    }

    [Fact]
    public async Task FetchComplete_UsesBindingCountRatherThanExpandedProviderCountForCompletion()
    {
        const string binding = "{\"item\":{\"value\":\"Q42\"},\"kind\":{\"value\":\"Movie\"},\"outcome\":{\"value\":\"win\"},\"awardLabel\":{\"value\":\"Award\"},\"imdb\":{\"value\":\"tt1234567\"},\"tmdbMovie\":{\"value\":\"42\"}}";
        var body = "{\"results\":{\"bindings\":[" + string.Join(',', Enumerable.Repeat(binding, WikidataAwardsClient.PageSize / 2)) + "]}}";
        var client = CreateClient(
            (_, _) => Task.FromResult(JsonResponse(body)),
            (_, _) => Task.CompletedTask,
            maxPages: 1);

        var snapshot = await client.FetchCompleteAsync(CancellationToken.None);

        Assert.Equal(WikidataAwardsClient.PageSize, snapshot.Records.Count);
    }

    private static WikidataAwardsClient CreateClient(
        Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send,
        Func<TimeSpan, CancellationToken, Task> delay,
        TimeSpan? timeout = null,
        int maxPages = WikidataAwardsClient.MaxPages)
        => new(
            new FixedHttpClientFactory(new CallbackHandler(send)),
            NullLogger<WikidataAwardsClient>.Instance,
            timeout ?? TimeSpan.FromSeconds(1),
            delay,
            maxPages);

    private static HttpResponseMessage JsonResponse(string json)
        => new(HttpStatusCode.OK)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/sparql-results+json"),
        };

    private sealed class FixedHttpClientFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name)
            => new(handler, disposeHandler: false) { BaseAddress = new Uri("https://query.wikidata.org/") };
    }

    private sealed class CallbackHandler(
        Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
            => send(request, cancellationToken);
    }
}
