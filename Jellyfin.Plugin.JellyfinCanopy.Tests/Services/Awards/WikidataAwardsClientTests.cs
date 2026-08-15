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
              {"cursor":{"value":"cursor-1"},"item":{"value":"http://www.wikidata.org/entity/Q42"},"kind":{"value":"Movie"},"outcome":{"value":"win"},"awardLabel":{"value":"Best Picture"},"date":{"value":"2024-02-10T00:00:00Z"},"imdb":{"value":"tt1234567"},"tmdbMovie":{"value":"123"},"tmdbSeries":{"value":"999"}},
              {"cursor":{"value":"cursor-2"},"item":{"value":"Q84"},"kind":{"value":"Series"},"outcome":{"value":"nomination"},"awardLabel":{"value":"Best Series"},"tmdbMovie":{"value":"111"},"tmdbSeries":{"value":"456"},"tvdb":{"value":"789"}}
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
            {"results":{"bindings":[{"cursor":{"value":"cursor-1"},"item":{"value":"Q42"},"kind":{"value":"Movie"},"outcome":{"value":"win"},"awardLabel":{"value":"Award"},"imdb":{"value":"javascript:1"}}]}}
            """)));

    [Fact]
    public void BuildQuery_IsPagedDeterministicallyAndUsesOfficialAwardProperties()
    {
        var query = WikidataAwardsClient.BuildQuery("cursor-5000");
        Assert.Contains("p:P166", query, StringComparison.Ordinal);
        Assert.Contains("p:P1411", query, StringComparison.Ordinal);
        Assert.Contains("ORDER BY ?cursor", query, StringComparison.Ordinal);
        Assert.Contains("LIMIT 5000", query, StringComparison.Ordinal);
        Assert.Contains("FILTER(?cursor > \"cursor-5000\")", query, StringComparison.Ordinal);
        Assert.DoesNotContain("OFFSET", query, StringComparison.Ordinal);
        Assert.Throws<ArgumentException>(() => WikidataAwardsClient.BuildQuery("cursor\"injection"));
    }

    [Fact]
    public void ParsePage_RejectsNonIncreasingContinuationRows()
    {
        var body = PageBody(2, 1).Replace("cursor-000000002", "cursor-000000001", StringComparison.Ordinal);
        Assert.Throws<InvalidDataException>(() =>
            WikidataAwardsClient.ParsePage(Encoding.UTF8.GetBytes(body)));
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
            Assert.Contains("JellyfinCanopy-AwardsBot/2.0", request.Headers.UserAgent.ToString(), StringComparison.Ordinal);
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
    public async Task FetchComplete_ServerErrorStopsWithoutImmediateRetry()
    {
        var calls = 0;
        var delays = new List<TimeSpan>();
        var client = CreateClient((_, _) =>
        {
            calls++;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.ServiceUnavailable));
        }, (delay, _) =>
        {
            delays.Add(delay);
            return Task.CompletedTask;
        });

        var failure = await Assert.ThrowsAsync<HttpRequestException>(() =>
            client.FetchCompleteAsync(CancellationToken.None));

        Assert.Equal(HttpStatusCode.ServiceUnavailable, failure.StatusCode);
        Assert.Equal(1, calls);
        Assert.Empty(delays);
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
    public async Task FetchComplete_RejectsStreamedOversizedResponseWithoutDeclaredLength()
    {
        var calls = 0;
        var client = CreateClient((_, _) =>
        {
            calls++;
            var bytes = new byte[WikidataAwardsClient.MaxResponseBytes + 1];
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StreamContent(new NonSeekableReadStream(bytes)),
            });
        }, (_, _) => Task.CompletedTask);

        await Assert.ThrowsAsync<InvalidDataException>(() => client.FetchCompleteAsync(CancellationToken.None));
        Assert.Equal(1, calls);
    }

    [Fact]
    public async Task FetchComplete_RejectsAFullFinalPageAsPartial()
    {
        var body = PageBody(WikidataAwardsClient.PageSize, 1);
        var client = CreateClient(
            (_, _) => Task.FromResult(JsonResponse(body)),
            (_, _) => Task.CompletedTask,
            maxPagesPerInvocation: 1,
            maxTotalPages: 1);

        await Assert.ThrowsAsync<InvalidDataException>(() => client.FetchCompleteAsync(CancellationToken.None));
    }

    [Fact]
    public async Task FetchComplete_AcceptsExactMaximumOnlyAfterEmptyTerminalProbe()
    {
        var root = Path.Combine(Path.GetTempPath(), "jc-awards-max-" + Guid.NewGuid().ToString("N"));
        var checkpointPath = Path.Combine(root, "checkpoint.json");
        var calls = 0;
        try
        {
            Task<HttpResponseMessage> Send(HttpRequestMessage _, CancellationToken __)
            {
                calls++;
                return Task.FromResult(JsonResponse(calls == 1
                    ? PageBody(WikidataAwardsClient.PageSize, 1)
                    : "{\"results\":{\"bindings\":[]}}"));
            }

            var first = CreateClient(Send, (_, _) => Task.CompletedTask, checkpointPath: checkpointPath, maxPagesPerInvocation: 1, maxTotalPages: 1);
            await Assert.ThrowsAsync<InvalidDataException>(() => first.FetchCompleteAsync(CancellationToken.None));
            var resumed = CreateClient(Send, (_, _) => Task.CompletedTask, checkpointPath: checkpointPath, maxPagesPerInvocation: 1, maxTotalPages: 1);

            var snapshot = await resumed.FetchCompleteAsync(CancellationToken.None);

            Assert.Equal(WikidataAwardsClient.PageSize, snapshot.Records.Count);
            Assert.Equal(2, calls);
            Assert.False(File.Exists(checkpointPath));
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task FetchComplete_RejectsMaximumPlusOneAndRetainsProgress()
    {
        var root = Path.Combine(Path.GetTempPath(), "jc-awards-max-plus-one-" + Guid.NewGuid().ToString("N"));
        var checkpointPath = Path.Combine(root, "checkpoint.json");
        var calls = 0;
        try
        {
            Task<HttpResponseMessage> Send(HttpRequestMessage _, CancellationToken __)
            {
                calls++;
                return Task.FromResult(JsonResponse(calls == 1
                    ? PageBody(WikidataAwardsClient.PageSize, 1)
                    : PageBody(1, WikidataAwardsClient.PageSize + 1)));
            }

            var first = CreateClient(Send, (_, _) => Task.CompletedTask, checkpointPath: checkpointPath, maxPagesPerInvocation: 1, maxTotalPages: 1);
            await Assert.ThrowsAsync<InvalidDataException>(() => first.FetchCompleteAsync(CancellationToken.None));
            var resumed = CreateClient(Send, (_, _) => Task.CompletedTask, checkpointPath: checkpointPath, maxPagesPerInvocation: 1, maxTotalPages: 1);

            await Assert.ThrowsAsync<InvalidDataException>(() => resumed.FetchCompleteAsync(CancellationToken.None));

            Assert.Equal(2, calls);
            Assert.True(File.Exists(checkpointPath));
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task FetchComplete_UsesBindingCountRatherThanExpandedProviderCountForCompletion()
    {
        var body = PageBody(WikidataAwardsClient.PageSize / 2, 1, includeImdb: true);
        var client = CreateClient(
            (_, _) => Task.FromResult(JsonResponse(body)),
            (_, _) => Task.CompletedTask,
            maxPagesPerInvocation: 1,
            maxTotalPages: 1);

        var snapshot = await client.FetchCompleteAsync(CancellationToken.None);

        Assert.Equal(WikidataAwardsClient.PageSize, snapshot.Records.Count);
    }

    [Fact]
    public async Task FetchComplete_TraversesCurrentProductionScaleBeyondFortyThousandBindings()
    {
        var calls = 0;
        var client = CreateClient(
            (_, _) =>
            {
                calls++;
                var count = calls <= 9 ? WikidataAwardsClient.PageSize : 153;
                return Task.FromResult(JsonResponse(PageBody(count, ((calls - 1) * WikidataAwardsClient.PageSize) + 1)));
            },
            (_, _) => Task.CompletedTask,
            maxPagesPerInvocation: 10,
            maxTotalPages: 10);

        var snapshot = await client.FetchCompleteAsync(CancellationToken.None);

        Assert.Equal(45_153, snapshot.Records.Count);
        Assert.Equal(10, calls);
    }

    [Fact]
    public async Task FetchComplete_ResumesAValidatedCheckpointWithoutRepeatingPriorPages()
    {
        var root = Path.Combine(Path.GetTempPath(), "jc-awards-source-" + Guid.NewGuid().ToString("N"));
        var checkpointPath = Path.Combine(root, "checkpoint.json");
        var calls = 0;
        var requestedQueries = new List<string>();
        try
        {
            Task<HttpResponseMessage> Send(HttpRequestMessage request, CancellationToken _)
            {
                calls++;
                requestedQueries.Add(Uri.UnescapeDataString(request.RequestUri!.Query));
                var count = calls <= 2 ? WikidataAwardsClient.PageSize : 1;
                return Task.FromResult(JsonResponse(PageBody(count, ((calls - 1) * WikidataAwardsClient.PageSize) + 1)));
            }

            var client = CreateClient(
                Send,
                (_, _) => Task.CompletedTask,
                checkpointPath: checkpointPath,
                maxPagesPerInvocation: 2,
                maxTotalPages: 4);

            await Assert.ThrowsAsync<InvalidDataException>(() => client.FetchCompleteAsync(CancellationToken.None));
            Assert.True(File.Exists(checkpointPath));

            var restartedClient = CreateClient(
                Send,
                (_, _) => Task.CompletedTask,
                checkpointPath: checkpointPath,
                maxPagesPerInvocation: 2,
                maxTotalPages: 4);
            var snapshot = await restartedClient.FetchCompleteAsync(CancellationToken.None);

            Assert.Equal(10_001, snapshot.Records.Count);
            Assert.Equal(3, calls);
            Assert.Contains("FILTER(?cursor >", requestedQueries[2], StringComparison.Ordinal);
            Assert.False(File.Exists(checkpointPath));
        }
        finally
        {
            if (Directory.Exists(root))
            {
                Directory.Delete(root, recursive: true);
            }
        }
    }

    [Fact]
    public async Task FetchComplete_CollapsesDuplicateLogicalRecordsAcrossCursors()
    {
        var calls = 0;
        var client = CreateClient(
            (_, _) =>
            {
                calls++;
                return Task.FromResult(JsonResponse(calls == 1
                    ? PageBody(WikidataAwardsClient.PageSize, 1)
                    : PageBody(1, WikidataAwardsClient.PageSize + 1, logicalStart: 1)));
            },
            (_, _) => Task.CompletedTask,
            maxPagesPerInvocation: 2,
            maxTotalPages: 2);

        var snapshot = await client.FetchCompleteAsync(CancellationToken.None);

        Assert.Equal(WikidataAwardsClient.PageSize, snapshot.Records.Count);
        Assert.Equal(2, calls);
    }

    [Fact]
    public async Task FetchComplete_DiscardsCorruptUnknownAndExpiredCheckpoints()
    {
        var invalidPayloads = new[]
        {
            "not-json",
            CheckpointJson(version: 999, DateTimeOffset.UtcNow),
            CheckpointJson(version: 1, DateTimeOffset.UtcNow.AddDays(-31)),
        };

        foreach (var payload in invalidPayloads)
        {
            var root = Path.Combine(Path.GetTempPath(), "jc-awards-invalid-checkpoint-" + Guid.NewGuid().ToString("N"));
            var checkpointPath = Path.Combine(root, "checkpoint.json");
            Directory.CreateDirectory(root);
            await File.WriteAllTextAsync(checkpointPath, payload);
            var queries = new List<string>();
            try
            {
                var client = CreateClient((request, _) =>
                {
                    queries.Add(Uri.UnescapeDataString(request.RequestUri!.Query));
                    return Task.FromResult(JsonResponse("{\"results\":{\"bindings\":[]}}"));
                }, (_, _) => Task.CompletedTask, checkpointPath: checkpointPath);

                var snapshot = await client.FetchCompleteAsync(CancellationToken.None);

                Assert.Empty(snapshot.Records);
                Assert.Single(queries);
                Assert.DoesNotContain("FILTER(?cursor >", queries[0], StringComparison.Ordinal);
                Assert.False(File.Exists(checkpointPath));
            }
            finally
            {
                if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
            }
        }
    }

    [Fact]
    public void ValidateCheckpoint_AcceptsMaximumAndRejectsMaximumPlusOne()
    {
        var maximum = new AwardsSourceCheckpoint
        {
            Version = 1,
            Complete = false,
            StartedAtUtc = DateTimeOffset.UtcNow,
            CompletedPages = WikidataAwardsClient.MaxTotalPages,
            BindingCount = WikidataAwardsClient.MaxTotalBindings,
            Cursor = "cursor-maximum",
            Records = [],
        };

        WikidataAwardsClient.ValidateCheckpoint(maximum);
        var plusOne = new AwardsSourceCheckpoint
        {
            Version = maximum.Version,
            Complete = maximum.Complete,
            StartedAtUtc = maximum.StartedAtUtc,
            CompletedPages = WikidataAwardsClient.MaxTotalPages + 1,
            BindingCount = WikidataAwardsClient.MaxTotalBindings + WikidataAwardsClient.PageSize,
            Cursor = maximum.Cursor,
            Records = [],
        };
        Assert.Throws<InvalidDataException>(() => WikidataAwardsClient.ValidateCheckpoint(plusOne));

        WikidataAwardsClient.ValidateCheckpointCapacity(
            WikidataAwardsClient.MaxTotalPages,
            WikidataAwardsClient.MaxTotalBindings,
            WikidataAwardsClient.MaxExpandedProviderRecords);
        Assert.Throws<InvalidDataException>(() => WikidataAwardsClient.ValidateCheckpointCapacity(
            WikidataAwardsClient.MaxTotalPages,
            WikidataAwardsClient.MaxTotalBindings,
            WikidataAwardsClient.MaxExpandedProviderRecords + 1));
        WikidataAwardsClient.ValidateCheckpointByteLength(WikidataAwardsClient.MaxCheckpointBytes);
        Assert.Throws<InvalidDataException>(() =>
            WikidataAwardsClient.ValidateCheckpointByteLength(WikidataAwardsClient.MaxCheckpointBytes + 1L));
    }

    [Fact]
    public async Task FetchComplete_DoesNotPublishWhenCompletedCheckpointCannotBeRemoved()
    {
        var root = Path.Combine(Path.GetTempPath(), "jc-awards-checkpoint-dir-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var client = CreateClient(
                (_, _) => Task.FromResult(JsonResponse("{\"results\":{\"bindings\":[]}}")),
                (_, _) => Task.CompletedTask,
                checkpointPath: root);

            await Assert.ThrowsAsync<IOException>(() => client.FetchCompleteAsync(CancellationToken.None));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static WikidataAwardsClient CreateClient(
        Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send,
        Func<TimeSpan, CancellationToken, Task> delay,
        TimeSpan? timeout = null,
        string checkpointPath = "",
        int maxPagesPerInvocation = WikidataAwardsClient.MaxPagesPerInvocation,
        int maxTotalPages = WikidataAwardsClient.MaxTotalPages)
        => new(
            new FixedHttpClientFactory(new CallbackHandler(send)),
            NullLogger<WikidataAwardsClient>.Instance,
            timeout ?? TimeSpan.FromSeconds(1),
            delay,
            checkpointPath,
            maxPagesPerInvocation,
            maxTotalPages);

    private static string PageBody(int count, int start, bool includeImdb = false, int? logicalStart = null)
    {
        var bindings = Enumerable.Range(start, count).Select((value, index) =>
        {
            var logicalValue = (logicalStart ?? start) + index;
            var imdb = includeImdb ? $"\"imdb\":{{\"value\":\"tt{logicalValue + 1_000_000:D7}\"}}," : string.Empty;
            return $"{{\"cursor\":{{\"value\":\"cursor-{value:D9}\"}},\"item\":{{\"value\":\"Q{logicalValue}\"}},\"kind\":{{\"value\":\"Movie\"}},\"outcome\":{{\"value\":\"win\"}},\"awardLabel\":{{\"value\":\"Award {logicalValue}\"}},{imdb}\"tmdbMovie\":{{\"value\":\"{logicalValue}\"}}}}";
        });
        return "{\"results\":{\"bindings\":[" + string.Join(',', bindings) + "]}}";
    }

    private static string CheckpointJson(int version, DateTimeOffset startedAtUtc)
        => $$"""
        {"version":{{version}},"complete":false,"startedAtUtc":"{{startedAtUtc:O}}","completedPages":1,"bindingCount":5000,"cursor":"cursor-000005000","records":[]}
        """;

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

    private sealed class NonSeekableReadStream(byte[] bytes) : MemoryStream(bytes, writable: false)
    {
        public override bool CanSeek => false;
        public override long Length => throw new NotSupportedException();
    }
}
