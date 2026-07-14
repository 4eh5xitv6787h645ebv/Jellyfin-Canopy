using System.Net;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Model.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Services.Arr;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers;

/// <summary>
/// Regression coverage for the bounded, coalesced detail lookups used to
/// enrich complete coming-soon request snapshots.
/// </summary>
public sealed class ArrRequestsEnrichmentConcurrencyTests
{
    private const string CallerGuid = "44444444-4444-4444-4444-444444444444";

    [Fact]
    public async Task GetRequests_ComingSoon_PrefiltersCompleteProcessingSnapshotBeforeEnrichment()
    {
        var handler = new MixedProcessingSnapshotHandler();
        var factory = new RecordingHttpClientFactory(handler);
        var provider = Provider("http://seerr");
        var controller = BuildController(
            factory,
            provider,
            new SeerrCache(provider),
            "http://seerr",
            seerrUserId: 7);

        var ok = Assert.IsType<OkObjectResult>(
            await controller.GetRequests(filter: "comingsoon"));
        var response = JsonNode.Parse(JsonSerializer.Serialize(ok.Value))!.AsObject();
        var requests = Assert.IsType<JsonArray>(response["requests"]);

        Assert.Equal(new int?[] { 1, 4, 8 }, requests.Select(row => (int?)row?["id"]).ToArray());
        Assert.Equal("Approved", (string?)requests.Single(row => (int?)row?["id"] == 1)!["mediaStatus"]);
        Assert.Equal("Approved", (string?)requests.Single(row => (int?)row?["id"] == 8)!["mediaStatus"]);
        Assert.Equal(new[] { 101, 104, 108 }, handler.DetailTmdbIds.OrderBy(static id => id));
        Assert.Equal(2, handler.CollectionRequests.Count);
        Assert.All(
            handler.CollectionRequests,
            collectionUri => Assert.Equal("processing", QueryValue(collectionUri, "filter")));
    }

    [Fact]
    public async Task GetRequests_ComingSoon_OneDetailFailureDiscardsEveryProjectedRow()
    {
        var handler = new MixedProcessingSnapshotHandler(failingDetailTmdbId: 104);
        var factory = new RecordingHttpClientFactory(handler);
        var provider = Provider("http://seerr");
        var controller = BuildController(
            factory,
            provider,
            new SeerrCache(provider),
            "http://seerr",
            seerrUserId: 7);

        var result = Assert.IsType<ObjectResult>(
            await controller.GetRequests(filter: "comingsoon"));
        var response = JsonNode.Parse(JsonSerializer.Serialize(result.Value))!.AsObject();

        Assert.Equal(502, result.StatusCode);
        Assert.Equal("upstream_enrichment_incomplete", (string?)response["code"]);
        Assert.Empty(Assert.IsType<JsonArray>(response["requests"]));
        Assert.Equal(0, (int?)response["totalPages"]);
        Assert.Equal(0, (int?)response["totalResults"]);
        Assert.Equal(new[] { 101, 104, 108 }, handler.DetailTmdbIds.OrderBy(static id => id));
    }

    [Fact]
    public async Task GetRequests_NormalFilter_ParentalFiltersCompleteSnapshotThenPagesLocally()
    {
        var handler = new NormalPagedRequestHandler();
        var factory = new RecordingHttpClientFactory(handler);
        var provider = Provider("http://seerr");
        var parentalFilter = new DropFirstUpstreamPageParentalFilter();
        var controller = BuildController(
            factory,
            provider,
            new SeerrCache(provider),
            "http://seerr",
            seerrUserId: 7,
            parentalFilter: parentalFilter);

        var ok = Assert.IsType<OkObjectResult>(
            await controller.GetRequests(take: 2, skip: 0));
        var response = JsonNode.Parse(JsonSerializer.Serialize(ok.Value))!.AsObject();
        var requests = Assert.IsType<JsonArray>(response["requests"]);

        Assert.Equal(new int?[] { 103, 104 }, requests.Select(row => (int?)row?["tmdbId"]));
        Assert.Equal(2, (int?)response["totalResults"]);
        Assert.Equal(1, (int?)response["totalPages"]);
        Assert.Equal(new[] { 4 }, parentalFilter.ObservedCollectionSizes);
        Assert.Equal(
            new[] { 0, 2, 0, 2 },
            handler.CollectionRequests.Select(uri => int.Parse(
                QueryValue(uri, "skip")!,
                System.Globalization.CultureInfo.InvariantCulture)));
        Assert.All(handler.CollectionRequests, uri => Assert.Equal("all", QueryValue(uri, "filter")));
        Assert.Equal(new[] { 103, 104 }, handler.DetailTmdbIds.OrderBy(static id => id));
    }

    [Fact]
    public async Task GetRequests_NormalFilter_LaterPageFailurePublishesNoPrefix()
    {
        var handler = new NormalPagedRequestHandler(failSecondPage: true);
        var factory = new RecordingHttpClientFactory(handler);
        var provider = Provider("http://seerr");
        var controller = BuildController(
            factory,
            provider,
            new SeerrCache(provider),
            "http://seerr",
            seerrUserId: 7);

        var result = Assert.IsType<ObjectResult>(await controller.GetRequests(take: 2));
        var response = JsonNode.Parse(JsonSerializer.Serialize(result.Value))!.AsObject();

        Assert.Equal(502, result.StatusCode);
        Assert.Equal("upstream_collection_incomplete", (string?)response["code"]);
        Assert.Empty(Assert.IsType<JsonArray>(response["requests"]));
        Assert.Empty(handler.DetailTmdbIds);
    }

    [Fact]
    public async Task GetRequests_ConcurrentCallers_NeverExceedGlobalEnrichmentLimit()
    {
        var handler = new BlockingEnrichmentHandler(new Dictionary<string, int[]>
        {
            ["seerr-a"] = Enumerable.Range(1, 13).ToArray(),
            ["seerr-b"] = Enumerable.Range(101, 13).ToArray(),
        });
        var factory = new RecordingHttpClientFactory(handler);
        var provider = Provider("http://seerr-a,http://seerr-b");
        var cache = new SeerrCache(provider);
        var first = BuildController(factory, provider, cache, "http://seerr-a", seerrUserId: 7);
        var second = BuildController(factory, provider, cache, "http://seerr-b", seerrUserId: 8);

        Task<IActionResult> firstRequest;
        Task<IActionResult> secondRequest;
        try
        {
            firstRequest = first.GetRequests(filter: "comingsoon");
            await WaitUntilAsync(
                () => handler.DetailRequestCount >= ArrRequestsController.MaxConcurrentRequestEnrichments,
                "the first caller to fill the enrichment gate");
            Assert.Equal(ArrRequestsController.MaxConcurrentRequestEnrichments, handler.DetailRequestCount);

            secondRequest = second.GetRequests(filter: "comingsoon");
            await WaitUntilAsync(
                () => handler.RequestPageCount("seerr-b") >= 1,
                "the second caller to read its request snapshot");
            await Task.Delay(100);

            Assert.Equal(ArrRequestsController.MaxConcurrentRequestEnrichments, handler.DetailRequestCount);
            Assert.Equal(ArrRequestsController.MaxConcurrentRequestEnrichments, handler.MaxConcurrentDetailRequests);
        }
        finally
        {
            handler.ReleaseDetails();
        }

        Assert.IsType<OkObjectResult>(await firstRequest);
        Assert.IsType<OkObjectResult>(await secondRequest);
        Assert.Equal(26, handler.DetailRequestCount);
        Assert.True(
            handler.MaxConcurrentDetailRequests <= ArrRequestsController.MaxConcurrentRequestEnrichments,
            $"Observed {handler.MaxConcurrentDetailRequests} simultaneous detail requests.");
    }

    [Fact]
    public async Task GetRequests_CancelledCaller_DoesNotCancelSharedEnrichmentForOtherCaller()
    {
        var handler = new BlockingEnrichmentHandler(new Dictionary<string, int[]>
        {
            ["seerr"] = new[] { 501 },
        });
        var factory = new RecordingHttpClientFactory(handler);
        var provider = Provider("http://seerr");
        var cache = new SeerrCache(provider);
        using var firstCancellation = new CancellationTokenSource();
        using var secondCancellation = new CancellationTokenSource();
        var first = BuildController(
            factory,
            provider,
            cache,
            "http://seerr",
            seerrUserId: 7,
            firstCancellation.Token);
        var second = BuildController(
            factory,
            provider,
            cache,
            "http://seerr",
            seerrUserId: 7,
            secondCancellation.Token);

        var firstRequest = first.GetRequests(filter: "comingsoon");
        await WaitUntilAsync(() => handler.DetailRequestCount >= 1, "the shared detail fetch to start");
        Assert.Equal(1, handler.DetailRequestCount);

        // A second controller shares the singleton cache and therefore joins
        // the first controller's in-flight lookup for the same media key.
        var secondRequest = second.GetRequests(filter: "comingsoon");
        await WaitUntilAsync(
            () => handler.RequestPageCount("seerr") >= 2,
            "both callers to read their request snapshots");
        await Task.Delay(50);
        Assert.Equal(1, handler.DetailRequestCount);
        Assert.False(secondRequest.IsCompleted);

        firstCancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => firstRequest);

        Assert.False(secondRequest.IsCompleted);
        Assert.False(secondCancellation.IsCancellationRequested);
        Assert.Equal(1, handler.DetailRequestCount);

        handler.ReleaseDetails();
        var ok = Assert.IsType<OkObjectResult>(await secondRequest);
        var response = JsonNode.Parse(JsonSerializer.Serialize(ok.Value))!.AsObject();
        var row = Assert.Single(Assert.IsType<JsonArray>(response["requests"]));
        Assert.Equal("Movie 501", (string?)row!["title"]);
        Assert.Equal(1, handler.DetailRequestCount);
    }

    [Fact]
    public async Task GetRequests_CancelledWaitersDoNotReleaseCapacityHeldBySharedFetches()
    {
        var handler = new BlockingEnrichmentHandler(new Dictionary<string, int[]>
        {
            ["seerr-a"] = Enumerable.Range(1, ArrRequestsController.MaxConcurrentRequestEnrichments).ToArray(),
            ["seerr-b"] = Enumerable.Range(101, ArrRequestsController.MaxConcurrentRequestEnrichments).ToArray(),
        });
        var factory = new RecordingHttpClientFactory(handler);
        var provider = Provider("http://seerr-a,http://seerr-b");
        var cache = new SeerrCache(provider);
        using var firstCancellation = new CancellationTokenSource();
        var first = BuildController(
            factory,
            provider,
            cache,
            "http://seerr-a",
            seerrUserId: 7,
            firstCancellation.Token);
        var second = BuildController(
            factory,
            provider,
            cache,
            "http://seerr-b",
            seerrUserId: 8);

        Task<IActionResult>? secondRequest = null;
        try
        {
            var firstRequest = first.GetRequests(filter: "comingsoon");
            await WaitUntilAsync(
                () => handler.DetailRequestCount == ArrRequestsController.MaxConcurrentRequestEnrichments,
                "the first caller to fill the enrichment gate");

            firstCancellation.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => firstRequest);

            secondRequest = second.GetRequests(filter: "comingsoon");
            await WaitUntilAsync(
                () => handler.RequestPageCount("seerr-b") >= 1,
                "the second caller to read its request snapshot");
            await Task.Delay(100);

            // The first caller no longer awaits these shared operations, but the
            // operations still own all twelve leases until their HTTP work ends.
            Assert.Equal(
                ArrRequestsController.MaxConcurrentRequestEnrichments,
                handler.DetailRequestCount);
            Assert.Equal(
                ArrRequestsController.MaxConcurrentRequestEnrichments,
                handler.CurrentConcurrentDetailRequests);
            Assert.Equal(
                ArrRequestsController.MaxConcurrentRequestEnrichments,
                handler.MaxConcurrentDetailRequests);
        }
        finally
        {
            handler.ReleaseDetails();
        }

        Assert.NotNull(secondRequest);
        Assert.IsType<OkObjectResult>(await secondRequest);
        Assert.Equal(ArrRequestsController.MaxConcurrentRequestEnrichments * 2, handler.DetailRequestCount);
        Assert.True(
            handler.MaxConcurrentDetailRequests <= ArrRequestsController.MaxConcurrentRequestEnrichments,
            $"Observed {handler.MaxConcurrentDetailRequests} simultaneous detail requests.");
    }

    [Fact]
    public async Task GetRequests_ComingSoon_UserOnlyBackstopDropsForeignRowsBeforeEnrichment()
    {
        var handler = new OwnerScopeSnapshotHandler(malformedOwner: false);
        var factory = new RecordingHttpClientFactory(handler);
        var provider = Provider("http://seerr");
        var controller = BuildController(
            factory,
            provider,
            new SeerrCache(provider),
            "http://seerr",
            seerrUserId: 7);

        var ok = Assert.IsType<OkObjectResult>(
            await controller.GetRequests(filter: "comingsoon", userOnly: true));
        var body = JsonNode.Parse(JsonSerializer.Serialize(ok.Value))!.AsObject();
        var row = Assert.Single(Assert.IsType<JsonArray>(body["requests"]));

        Assert.Equal(1, (int?)row!["id"]);
        Assert.Equal(1, (int?)body["totalResults"]);
        Assert.Equal(new[] { 101 }, handler.DetailTmdbIds);
        Assert.Equal(2, handler.CollectionRequests.Count);
        Assert.All(
            handler.CollectionRequests,
            uri => Assert.Equal("7", QueryValue(uri, "requestedBy")));
    }

    [Fact]
    public async Task GetRequests_ComingSoon_MalformedOwnerReturns502BeforeAnyEnrichment()
    {
        var handler = new OwnerScopeSnapshotHandler(malformedOwner: true);
        var factory = new RecordingHttpClientFactory(handler);
        var provider = Provider("http://seerr");
        var controller = BuildController(
            factory,
            provider,
            new SeerrCache(provider),
            "http://seerr",
            seerrUserId: 7);

        var result = Assert.IsType<ObjectResult>(
            await controller.GetRequests(filter: "comingsoon", userOnly: true));
        var body = JsonNode.Parse(JsonSerializer.Serialize(result.Value))!.AsObject();

        Assert.Equal(502, result.StatusCode);
        Assert.Equal("upstream_collection_invalid", (string?)body["code"]);
        Assert.Empty(Assert.IsType<JsonArray>(body["requests"]));
        Assert.Empty(handler.DetailTmdbIds);
    }

    private static async Task WaitUntilAsync(Func<bool> condition, string description)
    {
        var timeoutAt = DateTime.UtcNow.AddSeconds(5);
        while (!condition() && DateTime.UtcNow < timeoutAt)
        {
            await Task.Delay(10);
        }

        Assert.True(condition(), $"Timed out waiting for {description}.");
    }

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

    private static FakePluginConfigProvider Provider(string seerrUrls)
        => new(new PluginConfiguration
        {
            SeerrEnabled = true,
            SeerrUrls = seerrUrls,
            SeerrApiKey = "key",
            SeerrDisableCache = false,
        });

    private static ArrRequestsController BuildController(
        IHttpClientFactory factory,
        FakePluginConfigProvider provider,
        ISeerrCache cache,
        string sourceUrl,
        int seerrUserId,
        CancellationToken cancellationToken = default,
        ISeerrParentalFilter? parentalFilter = null)
    {
        var controller = new ArrRequestsController(
            factory,
            NullLogger<ArrRequestsController>.Instance,
            new StubUserManager(),
            cache,
            provider,
            new FixedSeerrClient(new SeerrUser
            {
                Id = seerrUserId,
                SourceUrl = sourceUrl,
                Permissions = SeerrPermission.REQUEST_VIEW,
            }),
            new ArrFetchService(factory, NullLogger<ArrFetchService>.Instance),
            parentalFilter ?? new PassthroughParentalFilter());

        controller.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity(
                    new[] { new Claim("Jellyfin-UserId", CallerGuid) },
                    "TestAuth")),
                RequestAborted = cancellationToken,
            },
        };
        return controller;
    }

    private sealed class BlockingEnrichmentHandler : HttpMessageHandler
    {
        private readonly IReadOnlyDictionary<string, int[]> _idsByHost;
        private readonly TaskCompletionSource _detailsReleased = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly System.Collections.Concurrent.ConcurrentDictionary<string, int> _requestPageCounts = new(StringComparer.Ordinal);
        private int _currentDetailRequests;
        private int _detailRequestCount;
        private int _maxConcurrentDetailRequests;

        public BlockingEnrichmentHandler(IReadOnlyDictionary<string, int[]> idsByHost)
        {
            _idsByHost = idsByHost;
        }

        public int DetailRequestCount => Volatile.Read(ref _detailRequestCount);

        public int CurrentConcurrentDetailRequests => Volatile.Read(ref _currentDetailRequests);

        public int MaxConcurrentDetailRequests => Volatile.Read(ref _maxConcurrentDetailRequests);

        public int RequestPageCount(string host)
            => _requestPageCounts.TryGetValue(host, out var count) ? count : 0;

        public void ReleaseDetails() => _detailsReleased.TrySetResult();

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var uri = request.RequestUri!;
            if (string.Equals(uri.AbsolutePath, "/api/v1/request", StringComparison.Ordinal))
            {
                _requestPageCounts.AddOrUpdate(uri.Host, 1, static (_, count) => count + 1);
                return Json(RequestPage(_idsByHost[uri.Host]));
            }

            if (!uri.AbsolutePath.StartsWith("/api/v1/movie/", StringComparison.Ordinal))
            {
                return Json(new { }, HttpStatusCode.NotFound);
            }

            Interlocked.Increment(ref _detailRequestCount);
            var current = Interlocked.Increment(ref _currentDetailRequests);
            RecordMaximum(current);
            try
            {
                await _detailsReleased.Task.WaitAsync(cancellationToken);
            }
            finally
            {
                Interlocked.Decrement(ref _currentDetailRequests);
            }

            var tmdbId = int.Parse(
                uri.Segments[^1].Trim('/'),
                System.Globalization.CultureInfo.InvariantCulture);
            return Json(new
            {
                title = $"Movie {tmdbId}",
                releaseDate = DateTime.UtcNow.AddDays(30).ToString(
                    "yyyy-MM-dd",
                    System.Globalization.CultureInfo.InvariantCulture),
                posterPath = $"/{tmdbId}.jpg",
            });

            void RecordMaximum(int candidate)
            {
                var observed = Volatile.Read(ref _maxConcurrentDetailRequests);
                while (candidate > observed)
                {
                    var prior = Interlocked.CompareExchange(
                        ref _maxConcurrentDetailRequests,
                        candidate,
                        observed);
                    if (prior == observed)
                    {
                        return;
                    }

                    observed = prior;
                }
            }
        }

        private static object RequestPage(int[] ids)
            => new
            {
                results = ids.Select(static id => new
                {
                    id,
                    type = "movie",
                    status = 2,
                    is4k = false,
                    requestedBy = new { id = 7 },
                    media = new
                    {
                        tmdbId = id,
                        mediaType = "movie",
                        status = 3,
                        downloadStatus = Array.Empty<object>(),
                    },
                }).ToArray(),
                pageInfo = new
                {
                    page = 1,
                    pages = 1,
                    pageSize = ids.Length,
                    results = ids.Length,
                },
            };

        private static HttpResponseMessage Json(object body, HttpStatusCode status = HttpStatusCode.OK)
            => new(status)
            {
                Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json"),
            };
    }

    private sealed class NormalPagedRequestHandler : HttpMessageHandler
    {
        private readonly bool _failSecondPage;

        public NormalPagedRequestHandler(bool failSecondPage = false)
        {
            _failSecondPage = failSecondPage;
        }

        public List<Uri> CollectionRequests { get; } = new();

        public System.Collections.Concurrent.ConcurrentBag<int> DetailTmdbIds { get; } = new();

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var uri = request.RequestUri!;
            if (string.Equals(uri.AbsolutePath, "/api/v1/request", StringComparison.Ordinal))
            {
                CollectionRequests.Add(uri);
                var skip = int.Parse(
                    QueryValue(uri, "skip")!,
                    System.Globalization.CultureInfo.InvariantCulture);
                if (skip == 2 && _failSecondPage)
                {
                    return Task.FromResult(Json(
                        new { error = "temporary page failure" },
                        HttpStatusCode.BadGateway));
                }

                return Task.FromResult(skip switch
                {
                    0 => Json(Page(page: 1, Request(1, 101), Request(2, 102))),
                    2 => Json(Page(page: 2, Request(3, 103), Request(4, 104))),
                    _ => throw new Xunit.Sdk.XunitException($"Unexpected request-list skip {skip}."),
                });
            }

            var tmdbId = int.Parse(
                uri.Segments[^1].Trim('/'),
                System.Globalization.CultureInfo.InvariantCulture);
            DetailTmdbIds.Add(tmdbId);
            return Task.FromResult(Json(new
            {
                title = $"Movie {tmdbId}",
                releaseDate = "2030-01-01",
            }));
        }

        private static object Page(int page, params object[] rows)
            => new
            {
                results = rows,
                pageInfo = new
                {
                    page,
                    pages = 2,
                    pageSize = rows.Length,
                    results = 4,
                },
            };

        private static object Request(int id, int tmdbId)
            => new
            {
                id,
                type = "movie",
                status = 2,
                is4k = false,
                requestedBy = new { id = 7 },
                media = new
                {
                    tmdbId,
                    mediaType = "movie",
                    status = 3,
                    downloadStatus = Array.Empty<object>(),
                },
            };

        private static HttpResponseMessage Json(
            object body,
            HttpStatusCode status = HttpStatusCode.OK)
            => new(status)
            {
                Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json"),
            };
    }

    private sealed class MixedProcessingSnapshotHandler : HttpMessageHandler
    {
        private readonly int? _failingDetailTmdbId;
        private readonly object[] _rows =
        {
            // A non-4K request must ignore the available 4K status and active
            // 4K download when classifying its normal-quality request.
            Request(
                id: 1,
                tmdbId: 101,
                type: "movie",
                requestStatus: 2,
                mediaStatus: 3,
                mediaStatus4k: 5,
                has4kDownload: true),
            // Processing-filter rows with partially available movies are valid,
            // but the Coming Soon projection excludes them locally.
            Request(id: 2, tmdbId: 102, type: "movie", requestStatus: 2, mediaStatus: 4),
            Request(id: 3, tmdbId: 103, type: "movie", requestStatus: 2, mediaStatus: 4),
            Request(id: 4, tmdbId: 104, type: "tv", requestStatus: 2, mediaStatus: 4),
            Request(id: 5, tmdbId: 105, type: "movie", requestStatus: 2, mediaStatus: 4),
            Request(id: 6, tmdbId: 106, type: "movie", requestStatus: 2, mediaStatus: 4),
            Request(id: 7, tmdbId: 107, type: "movie", requestStatus: 2, mediaStatus: 4),
            // The normal copy is already available, but this 4K request is
            // approved and queued. It must survive prefiltering and retain the
            // 4K-derived display status after enrichment.
            Request(
                id: 8,
                tmdbId: 108,
                type: "movie",
                requestStatus: 2,
                mediaStatus: 5,
                is4k: true,
                mediaStatus4k: 3,
                hasNormalDownload: true),
        };

        public MixedProcessingSnapshotHandler(int? failingDetailTmdbId = null)
        {
            _failingDetailTmdbId = failingDetailTmdbId;
        }

        public List<Uri> CollectionRequests { get; } = new();

        public System.Collections.Concurrent.ConcurrentBag<int> DetailTmdbIds { get; } = new();

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var uri = request.RequestUri!;
            if (string.Equals(uri.AbsolutePath, "/api/v1/request", StringComparison.Ordinal))
            {
                CollectionRequests.Add(uri);
                return Task.FromResult(Json(new
                {
                    results = _rows,
                    pageInfo = new
                    {
                        page = 1,
                        pages = 1,
                        pageSize = _rows.Length,
                        results = _rows.Length,
                    },
                }));
            }

            var tmdbId = int.Parse(
                uri.Segments[^1].Trim('/'),
                System.Globalization.CultureInfo.InvariantCulture);
            DetailTmdbIds.Add(tmdbId);
            if (tmdbId == _failingDetailTmdbId)
            {
                return Task.FromResult(Json(
                    new { error = "temporary detail failure" },
                    HttpStatusCode.BadGateway));
            }

            var futureDate = DateTime.UtcNow.AddDays(tmdbId == 101 ? 30 : 40).ToString(
                "yyyy-MM-dd",
                System.Globalization.CultureInfo.InvariantCulture);
            return Task.FromResult(uri.AbsolutePath.StartsWith("/api/v1/movie/", StringComparison.Ordinal)
                ? Json(new
                {
                    title = $"Movie {tmdbId}",
                    releaseDate = futureDate,
                })
                : Json(new
                {
                    name = $"Series {tmdbId}",
                    firstAirDate = "2020-01-01",
                    nextEpisodeToAir = new { airDate = futureDate },
                }));
        }

        private static object Request(
            int id,
            int tmdbId,
            string type,
            int requestStatus,
            int mediaStatus,
            bool is4k = false,
            int? mediaStatus4k = null,
            bool hasNormalDownload = false,
            bool has4kDownload = false)
            => new
            {
                id,
                type,
                status = requestStatus,
                is4k,
                requestedBy = new { id = 7 },
                media = new
                {
                    tmdbId,
                    mediaType = type,
                    status = mediaStatus,
                    status4k = mediaStatus4k,
                    downloadStatus = hasNormalDownload ? new[] { new { id = 1 } } : Array.Empty<object>(),
                    downloadStatus4k = has4kDownload ? new[] { new { id = 2 } } : Array.Empty<object>(),
                },
            };

        private static HttpResponseMessage Json(object body, HttpStatusCode status = HttpStatusCode.OK)
            => new(status)
            {
                Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json"),
            };
    }

    private sealed class OwnerScopeSnapshotHandler : HttpMessageHandler
    {
        private readonly bool _malformedOwner;

        public OwnerScopeSnapshotHandler(bool malformedOwner)
        {
            _malformedOwner = malformedOwner;
        }

        public List<Uri> CollectionRequests { get; } = new();

        public List<int> DetailTmdbIds { get; } = new();

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var uri = request.RequestUri!;
            if (string.Equals(uri.AbsolutePath, "/api/v1/request", StringComparison.Ordinal))
            {
                CollectionRequests.Add(uri);
                object? owner = _malformedOwner ? new { id = "garbage" } : new { id = 7 };
                var rows = _malformedOwner
                    ? new[] { Request(1, 101, owner) }
                    : new[] { Request(1, 101, owner), Request(2, 102, new { id = 99 }) };
                return Task.FromResult(Json(new
                {
                    results = rows,
                    pageInfo = new { page = 1, pages = 1, pageSize = rows.Length, results = rows.Length },
                }));
            }

            var tmdbId = int.Parse(
                uri.Segments[^1].Trim('/'),
                System.Globalization.CultureInfo.InvariantCulture);
            DetailTmdbIds.Add(tmdbId);
            return Task.FromResult(Json(new
            {
                title = $"Movie {tmdbId}",
                releaseDate = DateTime.UtcNow.AddDays(30).ToString(
                    "yyyy-MM-dd",
                    System.Globalization.CultureInfo.InvariantCulture),
            }));
        }

        private static object Request(int id, int tmdbId, object? requestedBy)
            => new
            {
                id,
                type = "movie",
                status = 2,
                is4k = false,
                requestedBy,
                media = new
                {
                    tmdbId,
                    mediaType = "movie",
                    status = 3,
                    downloadStatus = Array.Empty<object>(),
                },
            };

        private static HttpResponseMessage Json(object body)
            => new(HttpStatusCode.OK)
            {
                Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json"),
            };
    }

    private sealed class FixedSeerrClient : ISeerrClient
    {
        private readonly SeerrUser _user;

        public FixedSeerrClient(SeerrUser user)
        {
            _user = user;
        }

        public Task<SeerrUser?> GetSeerrUser(
            string jellyfinUserId,
            bool bypassCache = false,
            bool allowAutoImport = true)
            => Task.FromResult<SeerrUser?>(_user);

        public Task<string?> GetSeerrUserId(string jellyfinUserId, bool allowAutoImport = true)
            => throw new NotImplementedException();

        public bool IsImportBlocked(string jellyfinUserId, PluginConfiguration config)
            => throw new NotImplementedException();

        public Task<bool> GetStatusActiveAsync() => throw new NotImplementedException();

        public Task<Seerr4kCapability> GetSeerr4kCapabilityAsync(string jellyfinUserId, bool isAdmin = false)
            => throw new NotImplementedException();

        public void EvictMediaDetailCache(int tmdbId, string mediaType)
        {
        }

        public Task<IActionResult> ProxyRequestAsync(
            string apiPath,
            HttpMethod method,
            string? content,
            SeerrCaller caller)
            => throw new NotImplementedException();

        public Task<List<WatchlistItem>?> GetWatchlistForUser(string seerrUserId)
            => throw new NotImplementedException();

        public Task<List<WatchlistItem>?> GetRequestsForUser(string seerrUserId)
            => throw new NotImplementedException();
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

    private sealed class DropFirstUpstreamPageParentalFilter : ISeerrParentalFilter
    {
        public List<int> ObservedCollectionSizes { get; } = new();

        public Task<SeerrParentalResult> ApplyAsync(
            string json,
            string apiPath,
            SeerrCaller caller)
        {
            var root = JsonNode.Parse(json)!.AsObject();
            var results = root["results"]!.AsArray();
            ObservedCollectionSizes.Add(results.Count);
            for (var i = results.Count - 1; i >= 0; i--)
            {
                if ((int?)results[i]?["media"]?["tmdbId"] <= 102)
                {
                    results.RemoveAt(i);
                }
            }

            return Task.FromResult(new SeerrParentalResult(false, root.ToJsonString()));
        }

        public Task<bool> IsBlockedAsync(string mediaType, int tmdbId, SeerrCaller caller)
            => Task.FromResult(false);

        public Task<bool> IsTmdbProxyPathBlockedAsync(string tmdbApiPath, SeerrCaller caller)
            => Task.FromResult(false);
    }
}
