using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Xunit;
using Xunit.Abstractions;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers;

[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class SeerrQuotaPaginationCollection
{
    public const string Name = "Seerr quota pagination";
}

[Collection(SeerrQuotaPaginationCollection.Name)]
public class SeerrQuotaPaginationTests
{
    private const int HeavyUserRequestRows = 10_000;
    private const int HeavyUserPageSize = 100;
    private const int HeavyUserPageCount = HeavyUserRequestRows / HeavyUserPageSize;
    private const int HeavyUserExpectedHttpRequests = HeavyUserPageCount * 2;

    // This is a regression guard, not a throughput target. The exact HTTP count
    // pins the two complete scans. The process-wide ceilings leave roughly
    // 25 KiB of allocation per source row and five seconds of CI headroom while
    // still catching an unbounded page loop or a material per-row blow-up.
    private const long HeavyUserMaximumAllocatedBytes = 256L * 1024 * 1024;
    private const long HeavyUserMaximumElapsedMilliseconds = 5_000;

    private static readonly DateTime StableNow = new(2026, 1, 15, 12, 0, 0, DateTimeKind.Utc);
    private readonly ITestOutputHelper _output;

    public SeerrQuotaPaginationTests(ITestOutputHelper output) => _output = output;

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
            SeerrDispatchFenceTestFactory.Create(),
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
            SeerrDispatchFenceTestFactory.Create(),
            CancellationToken.None);

        Assert.False(result.IsComplete);
        Assert.Empty(result.Items);
        Assert.Equal(2, handler.Requests.Count);
    }

    [Fact]
    public async Task RequestHistory_ReportedPagesBeyondMaximum_TerminatesAfterFirstRequest()
    {
        var handler = new RoutingHandler(_ => Page(1, 3, 3, 1));
        using var client = new HttpClient(handler);

        var result = await SeerrProxyController.FetchQuotaRequestHistoryAsync(
            client,
            "http://seerr",
            "key",
            "7",
            SeerrDispatchFenceTestFactory.Create(),
            CancellationToken.None,
            pageSize: 1,
            maximumPages: 2,
            maximumItems: 10);

        Assert.False(result.IsComplete);
        Assert.Empty(result.Items);
        Assert.Equal("Pagination exceeded the 2 page safety bound.", result.FailureReason);
        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task RequestHistory_ReportedItemsBeyondMaximum_TerminatesAfterFirstRequest()
    {
        var handler = new RoutingHandler(_ => Page(1, 1, 3, 1));
        using var client = new HttpClient(handler);

        var result = await SeerrProxyController.FetchQuotaRequestHistoryAsync(
            client,
            "http://seerr",
            "key",
            "7",
            SeerrDispatchFenceTestFactory.Create(),
            CancellationToken.None,
            pageSize: 1,
            maximumPages: 10,
            maximumItems: 2);

        Assert.False(result.IsComplete);
        Assert.Empty(result.Items);
        Assert.Equal("Pagination exceeded the 2 item safety bound.", result.FailureReason);
        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task RequestHistory_TenThousandRequestProfile_StaysWithinRequestAllocationAndTimeBudgets()
    {
        // Warm JIT, HttpClient and JSON parsing outside the measured interval.
        var warmHandler = new RoutingHandler(_ => Page(1, 1, 1, 1));
        using (var warmClient = new HttpClient(warmHandler))
        {
            var warmResult = await SeerrProxyController.FetchQuotaRequestHistoryAsync(
                warmClient,
                "http://seerr",
                "key",
                "7",
                SeerrDispatchFenceTestFactory.Create(),
                CancellationToken.None);
            Assert.True(warmResult.IsComplete, warmResult.FailureReason);
        }

        // Serialize deterministic source pages before measuring. The measured
        // interval includes every HTTP response object/body, parse, clone,
        // identity/fingerprint check and the second stable-snapshot scan.
        var pagePayloads = Enumerable.Range(0, HeavyUserPageCount)
            .Select(pageIndex => JsonSerializer.Serialize(new
            {
                results = Enumerable.Range((pageIndex * HeavyUserPageSize) + 1, HeavyUserPageSize)
                    .Select(id => new
                    {
                        id,
                        type = "movie",
                        status = 2,
                        createdAt = StableNow.AddMinutes(id).ToString("O", CultureInfo.InvariantCulture),
                        requestedBy = new { id = 7 },
                        media = new { mediaType = "movie" },
                    })
                    .ToArray(),
                pageInfo = new
                {
                    page = pageIndex + 1,
                    pages = HeavyUserPageCount,
                    results = HeavyUserRequestRows,
                },
            }))
            .ToArray();
        var handler = new RoutingHandler(uri =>
        {
            var skip = QueryInt(uri, "skip");
            if (skip < 0 || skip % HeavyUserPageSize != 0 || skip >= HeavyUserRequestRows)
            {
                throw new InvalidOperationException($"Unexpected skip {skip}.");
            }

            return JsonText(pagePayloads[skip / HeavyUserPageSize]);
        });
        using var client = new HttpClient(handler);

        var allocatedBefore = GC.GetTotalAllocatedBytes(precise: true);
        var stopwatch = Stopwatch.StartNew();
        var result = await SeerrProxyController.FetchQuotaRequestHistoryAsync(
            client,
            "http://seerr",
            "key",
            "7",
            SeerrDispatchFenceTestFactory.Create(),
            CancellationToken.None,
            pageSize: HeavyUserPageSize);
        stopwatch.Stop();
        var allocatedBytes = GC.GetTotalAllocatedBytes(precise: true) - allocatedBefore;

        _output.WriteLine(
            "rows={0} pageSize={1} pagesPerScan={2} httpRequests={3} allocatedBytes={4} elapsedMs={5:F3}",
            HeavyUserRequestRows,
            HeavyUserPageSize,
            HeavyUserPageCount,
            handler.Requests.Count,
            allocatedBytes,
            stopwatch.Elapsed.TotalMilliseconds);

        Assert.True(result.IsComplete, result.FailureReason);
        Assert.Equal(HeavyUserRequestRows, result.Items.Count);
        Assert.Equal(1, result.Items[0].GetProperty("id").GetInt32());
        Assert.Equal(HeavyUserRequestRows, result.Items[^1].GetProperty("id").GetInt32());
        Assert.Equal(HeavyUserExpectedHttpRequests, handler.Requests.Count);
        Assert.True(
            allocatedBytes <= HeavyUserMaximumAllocatedBytes,
            $"{HeavyUserRequestRows} request rows allocated {allocatedBytes} bytes; budget is {HeavyUserMaximumAllocatedBytes} bytes.");
        Assert.True(
            stopwatch.ElapsedMilliseconds <= HeavyUserMaximumElapsedMilliseconds,
            $"{HeavyUserRequestRows} request rows took {stopwatch.Elapsed}; budget is {HeavyUserMaximumElapsedMilliseconds} ms.");
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

    private static HttpResponseMessage JsonText(string body)
        => new(HttpStatusCode.OK)
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
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
