using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Model.Arr;
using Jellyfin.Plugin.JellyfinCanopy.Services.Arr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class ArrQueuePaginationTests
{
    [Theory]
    [InlineData("sonarr", 4)]
    [InlineData("radarr", 5)]
    public async Task SharedPaginator_CollectsExactBoundaryAndPartialFinalPage(string service, int total)
    {
        var handler = new QueueHandler(total, id => $$"""{"id":{{id}}}""");
        var fetch = NewFetch(handler);

        var result = await fetch.FetchQueueCollectionAsync<string>(
            Instance(service),
            (page, size) => $"/api/v3/queue?service={service}&page={page}&pageSize={size}",
            pageSize: 2,
            identity: row => row["id"]?.ToJsonString(),
            projector: row => row["id"]!.ToJsonString(),
            requestTimeout: TimeSpan.FromSeconds(2),
            contextLabel: $"{service} queue",
            ct: CancellationToken.None);

        Assert.True(result.IsComplete);
        Assert.Null(result.Error);
        Assert.Equal(total, result.Items.Count);
        Assert.Equal((int)Math.Ceiling(total / 2d), handler.QueueRequests);
    }

    [Fact]
    public async Task DownloadsPageSize_IncludesSentinelAfterFirstThousandRows()
    {
        var handler = new QueueHandler(1_001, id => $$"""{"id":{{id}}}""");
        var fetch = NewFetch(handler);

        var result = await fetch.FetchQueueCollectionAsync<string>(
            Instance("sonarr"),
            (page, size) => $"/api/v3/queue?page={page}&pageSize={size}",
            pageSize: 1_000,
            identity: row => row["id"]?.ToJsonString(),
            projector: row => row["id"]!.ToJsonString(),
            requestTimeout: TimeSpan.FromSeconds(2),
            contextLabel: "download queue",
            ct: CancellationToken.None);

        Assert.True(result.IsComplete);
        Assert.Equal("1001", result.Items[^1]);
        Assert.Equal(2, handler.QueueRequests);
    }

    [Theory]
    [InlineData("sonarr", QueueFault.ChangingTotal, "totalRecords changed")]
    [InlineData("radarr", QueueFault.ChangingTotal, "totalRecords changed")]
    [InlineData("sonarr", QueueFault.DuplicateSecondPage, "did not advance")]
    [InlineData("radarr", QueueFault.DuplicateSecondPage, "did not advance")]
    [InlineData("sonarr", QueueFault.NonAdvancingPage, "non-advancing")]
    [InlineData("radarr", QueueFault.NonAdvancingPage, "non-advancing")]
    [InlineData("sonarr", QueueFault.LaterPageFailure, "HTTP 500")]
    [InlineData("radarr", QueueFault.LaterPageFailure, "HTTP 500")]
    public async Task InconsistentOrFailedLaterPage_IsExplicitlyIncomplete(string service, QueueFault fault, string reason)
    {
        var handler = new QueueHandler(4, id => $$"""{"id":{{id}}}""", fault);
        var fetch = NewFetch(handler);

        var result = await fetch.FetchQueueCollectionAsync<string>(
            Instance(service),
            (page, size) => $"/api/v3/queue?page={page}&pageSize={size}",
            pageSize: 2,
            identity: row => row["id"]?.ToJsonString(),
            projector: row => row["id"]!.ToJsonString(),
            requestTimeout: TimeSpan.FromSeconds(2),
            contextLabel: "Radarr queue",
            ct: CancellationToken.None);

        Assert.False(result.IsComplete);
        Assert.Contains(reason, result.Error, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(new[] { "1", "2" }, result.Items);
        Assert.Equal(2, handler.QueueRequests);
    }

    [Fact]
    public async Task AggregateRecordLimit_RejectsOversizedQueueBeforeRetainingRows()
    {
        var handler = new QueueHandler(ArrFetchService.MaxQueueRecords + 1, id => $$"""{"id":{{id}}}""");
        var fetch = NewFetch(handler);

        var result = await fetch.FetchQueueCollectionAsync<string>(
            Instance("sonarr"),
            (page, size) => $"/api/v3/queue?page={page}&pageSize={size}",
            pageSize: 1_000,
            identity: row => row["id"]?.ToJsonString(),
            projector: row => row["id"]!.ToJsonString(),
            requestTimeout: TimeSpan.FromSeconds(2),
            contextLabel: "Sonarr queue",
            ct: CancellationToken.None);

        Assert.False(result.IsComplete);
        Assert.Empty(result.Items);
        Assert.Contains("100000-record safety limit", result.Error, StringComparison.Ordinal);
        Assert.Equal(1, handler.QueueRequests);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task MalformedRecordOrProjection_IsExplicitlyIncomplete(bool scalarRecord)
    {
        var handler = new QueueHandler(
            1,
            _ => scalarRecord ? "42" : "{\"id\":1,\"size\":\"not-a-number\"}");
        var fetch = NewFetch(handler);

        var result = await fetch.FetchQueueCollectionAsync<string>(
            Instance("radarr"),
            (page, size) => $"/api/v3/queue?page={page}&pageSize={size}",
            pageSize: 100,
            identity: row => row["id"]?.ToJsonString(),
            projector: row => ((int?)row["size"]).ToString(),
            requestTimeout: TimeSpan.FromSeconds(2),
            contextLabel: "Radarr queue",
            ct: CancellationToken.None);

        Assert.False(result.IsComplete);
        Assert.Empty(result.Items);
        Assert.Equal("page 1: invalid response", result.Error);
        Assert.Equal(1, handler.QueueRequests);
    }

    [Theory]
    [InlineData("radarr", 100)]
    [InlineData("sonarr", 200)]
    public async Task ActionStatus_FindsTargetBeyondFormerSinglePage(string service, int pageSize)
    {
        const int targetArrId = 7;
        var total = pageSize + 1;
        var handler = new QueueHandler(
            total,
            id => service == "sonarr"
                ? $$"""{"id":{{id}},"seriesId":{{(id == total ? targetArrId : 99)}},"title":"row {{id}}","size":100,"sizeleft":50}"""
                : $$"""{"id":{{id}},"title":"row {{id}}","size":100,"sizeleft":50}""");
        handler.LookupService = service;
        var fetch = NewFetch(handler);
        var actions = new ArrActionService(fetch, new ArrTargetResolver(fetch), NullLogger<ArrActionService>.Instance);

        var status = await actions.GetQueueStatusAsync(
            service == "radarr" ? Movie() : Series(),
            service == "radarr" ? RadarrConfig() : SonarrConfig(),
            CancellationToken.None);

        Assert.True(status.IsComplete);
        Assert.Empty(status.Errors);
        if (service == "sonarr")
        {
            var target = Assert.Single(status.Items);
            Assert.Equal($"row {total}", target.Title);
        }
        else
        {
            Assert.Equal(total, status.Items.Count);
            Assert.Equal($"row {total}", status.Items[^1].Title);
        }
        Assert.Equal(2, handler.QueueRequests);
    }

    [Fact]
    public async Task ActionStatus_LaterPageFailure_IsNotReportedAsEmptySuccess()
    {
        var handler = new QueueHandler(101, id => $$"""{"id":{{id}},"title":"row {{id}}"}""", QueueFault.LaterPageFailure)
        {
            LookupService = "radarr",
        };
        var fetch = NewFetch(handler);
        var actions = new ArrActionService(fetch, new ArrTargetResolver(fetch), NullLogger<ArrActionService>.Instance);

        var status = await actions.GetQueueStatusAsync(Movie(), RadarrConfig(), CancellationToken.None);

        Assert.False(status.IsComplete);
        Assert.Empty(status.Items);
        Assert.Contains(status.Errors, error => error.Reason.Contains("page 2", StringComparison.Ordinal));
    }

    private static ArrFetchService NewFetch(HttpMessageHandler handler)
        => new(new RecordingHttpClientFactory(handler), NullLogger<ArrFetchService>.Instance);

    private static ArrInstance Instance(string service) => new()
    {
        Name = service,
        Url = "http://localhost:8989",
        ApiKey = "key",
        Enabled = true,
    };

    private static PluginConfiguration RadarrConfig() => new()
    {
        RadarrInstances = """[{"Name":"movies","Url":"http://localhost:7878","ApiKey":"rk","Enabled":true}]""",
    };

    private static PluginConfiguration SonarrConfig() => new()
    {
        SonarrInstances = """[{"Name":"tv","Url":"http://localhost:8989","ApiKey":"sk","Enabled":true}]""",
    };

    private static ArrResolvedItem Movie() => new() { Kind = ArrMediaKind.Movie, TmdbId = 27205, Name = "Movie" };

    private static ArrResolvedItem Series() => new() { Kind = ArrMediaKind.Series, SeriesTvdbId = 81189, Name = "Series" };

    public enum QueueFault
    {
        None,
        ChangingTotal,
        DuplicateSecondPage,
        NonAdvancingPage,
        LaterPageFailure,
    }

    private sealed class QueueHandler : HttpMessageHandler
    {
        private readonly int _total;
        private readonly Func<int, string> _record;
        private readonly QueueFault _fault;

        public QueueHandler(int total, Func<int, string> record, QueueFault fault = QueueFault.None)
        {
            _total = total;
            _record = record;
            _fault = fault;
        }

        public string? LookupService { get; set; }

        public int QueueRequests { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var uri = request.RequestUri!;
            if (uri.AbsolutePath.EndsWith("/api/v3/movie", StringComparison.Ordinal) && LookupService == "radarr")
                return Json("[{\"id\":7,\"monitored\":true,\"hasFile\":false}]");
            if (uri.AbsolutePath.EndsWith("/api/v3/series", StringComparison.Ordinal) && LookupService == "sonarr")
                return Json("[{\"id\":7,\"monitored\":true,\"statistics\":{\"episodeFileCount\":0}}]");

            if (!uri.AbsolutePath.EndsWith("/api/v3/queue", StringComparison.Ordinal))
                return Json("{}", HttpStatusCode.NotFound);

            QueueRequests++;
            var page = QueryInt(uri, "page");
            var pageSize = QueryInt(uri, "pageSize");
            if (_fault == QueueFault.LaterPageFailure && page == 2)
                return Json("{}", HttpStatusCode.InternalServerError);

            var reportedPage = _fault == QueueFault.NonAdvancingPage && page == 2 ? 1 : page;
            var reportedTotal = _fault == QueueFault.ChangingTotal && page == 2 ? _total + 1 : _total;
            var firstId = _fault == QueueFault.DuplicateSecondPage && page == 2
                ? 1
                : ((page - 1) * pageSize) + 1;
            var count = Math.Max(0, Math.Min(pageSize, _total - ((page - 1) * pageSize)));

            var body = new StringBuilder();
            body.Append("{\"page\":").Append(reportedPage)
                .Append(",\"pageSize\":").Append(pageSize)
                .Append(",\"totalRecords\":").Append(reportedTotal)
                .Append(",\"records\":[");
            for (var offset = 0; offset < count; offset++)
            {
                if (offset > 0) body.Append(',');
                body.Append(_record(firstId + offset));
            }
            body.Append("]}");
            return Json(body.ToString());
        }

        private static int QueryInt(Uri uri, string name)
        {
            foreach (var part in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
            {
                var pair = part.Split('=', 2);
                if (pair.Length == 2 && string.Equals(pair[0], name, StringComparison.Ordinal))
                    return int.Parse(pair[1], System.Globalization.CultureInfo.InvariantCulture);
            }
            return 0;
        }

        private static Task<HttpResponseMessage> Json(string body, HttpStatusCode status = HttpStatusCode.OK)
            => Task.FromResult(new HttpResponseMessage(status)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json"),
            });
    }
}
