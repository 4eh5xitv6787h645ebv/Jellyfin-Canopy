using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinCanopy.Model.Arr;
using Jellyfin.Plugin.JellyfinCanopy.Services.Arr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class ArrHistoryPaginationTests
{
    private static readonly DateTimeOffset Start = DateTimeOffset.Parse("2026-07-25T12:00:00Z");

    [Fact]
    public async Task HistoryPaginator_StopsAtRetentionCutoffWithoutReadingUnboundedHistory()
    {
        var handler = new HistoryHandler(total: 600);
        var result = await Fetch(handler, Start.AddMinutes(-250));

        Assert.True(result.IsWindowComplete);
        Assert.False(result.IsTruncated);
        Assert.Null(result.Error);
        Assert.Equal(251, result.Items.Count);
        Assert.Equal(2, handler.Requests);
    }

    [Fact]
    public async Task HistoryPaginator_LaterPageFailureDiscardsPartialPrefix()
    {
        var handler = new HistoryHandler(total: 400, failPage: 2);
        var result = await Fetch(handler, Start.AddDays(-1));

        Assert.False(result.IsWindowComplete);
        Assert.False(result.IsTruncated);
        Assert.Empty(result.Items);
        Assert.Contains("page 2", result.Error, StringComparison.Ordinal);
    }

    [Fact]
    public async Task HistoryPaginator_RecordCapIsExplicitlyTruncatedAndBounded()
    {
        var handler = new HistoryHandler(total: 1_200);
        var result = await Fetch(handler, Start.AddDays(-30));

        Assert.False(result.IsWindowComplete);
        Assert.True(result.IsTruncated);
        Assert.Null(result.Error);
        Assert.Equal(ArrFetchService.MaxHistoryRecords, result.Items.Count);
        Assert.Equal(5, handler.Requests);
    }

    [Fact]
    public async Task HistoryPaginator_MalformedTimestampFailsClosed()
    {
        var handler = new HistoryHandler(total: 1, malformedDateId: 1);
        var result = await Fetch(handler, Start.AddDays(-1));

        Assert.False(result.IsWindowComplete);
        Assert.Empty(result.Items);
        Assert.Contains("timestamp", result.Error, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task HistoryPaginator_ChangingTotalDiscardsMutableOffsetPrefix()
    {
        var handler = new HistoryHandler(total: 400, changedTotalOnPage: 2);
        var result = await Fetch(handler, Start.AddDays(-1));

        Assert.False(result.IsWindowComplete);
        Assert.False(result.IsTruncated);
        Assert.Empty(result.Items);
        Assert.Contains("totalRecords changed", result.Error, StringComparison.Ordinal);
        Assert.Equal(2, handler.Requests);
    }

    [Fact]
    public async Task HistoryPaginator_ExactFullPagesCompleteWhenEveryIdentityWasCollected()
    {
        var handler = new HistoryHandler(total: 400);
        var result = await Fetch(handler, Start.AddDays(-1));

        Assert.True(result.IsWindowComplete);
        Assert.False(result.IsTruncated);
        Assert.Null(result.Error);
        Assert.Equal(400, result.Items.Count);
        Assert.Equal(2, handler.Requests);
    }

    [Fact]
    public async Task HistoryPaginator_StableTotalWithBoundaryDuplicateDiscardsIncompletePrefix()
    {
        var handler = new HistoryHandler(total: 400, duplicateBoundaryOnPage: 2);
        var result = await Fetch(handler, Start.AddDays(-1));

        Assert.False(result.IsWindowComplete);
        Assert.False(result.IsTruncated);
        Assert.Empty(result.Items);
        Assert.Contains("all totalRecords identities", result.Error, StringComparison.Ordinal);
        Assert.Equal(2, handler.Requests);
    }

    private static Task<ArrHistoryCollection<string>> Fetch(
        HttpMessageHandler handler,
        DateTimeOffset cutoff)
    {
        var fetch = new ArrFetchService(
            new RecordingHttpClientFactory(handler),
            NullLogger<ArrFetchService>.Instance);
        return fetch.FetchHistoryCollectionAsync(
            new ArrInstance
            {
                Name = "history",
                Url = "http://localhost:8989",
                ApiKey = "secret",
            },
            (page, size) => $"/api/v3/history?page={page}&pageSize={size}&sortKey=date&sortDirection=descending",
            cutoff,
            identity: row => row["id"]?.ToJsonString(),
            timestamp: row => DateTimeOffset.TryParse(
                (string?)row["date"],
                out var value)
                    ? value
                    : null,
            projector: row => row["id"]!.ToJsonString(),
            requestTimeout: TimeSpan.FromSeconds(2),
            contextLabel: "history test",
            ct: CancellationToken.None);
    }

    private sealed class HistoryHandler : HttpMessageHandler
    {
        private readonly int _total;
        private readonly int? _failPage;
        private readonly int? _malformedDateId;
        private readonly int? _changedTotalOnPage;
        private readonly int? _duplicateBoundaryOnPage;

        public HistoryHandler(
            int total,
            int? failPage = null,
            int? malformedDateId = null,
            int? changedTotalOnPage = null,
            int? duplicateBoundaryOnPage = null)
        {
            _total = total;
            _failPage = failPage;
            _malformedDateId = malformedDateId;
            _changedTotalOnPage = changedTotalOnPage;
            _duplicateBoundaryOnPage = duplicateBoundaryOnPage;
        }

        public int Requests { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Requests++;
            var uri = request.RequestUri!;
            var page = QueryInt(uri, "page");
            var pageSize = QueryInt(uri, "pageSize");
            if (page == _failPage)
            {
                return Json("{}", HttpStatusCode.InternalServerError);
            }

            var firstId = ((page - 1) * pageSize) + 1;
            if (page == _duplicateBoundaryOnPage)
            {
                firstId--;
            }

            var count = Math.Max(0, Math.Min(pageSize, _total - firstId + 1));
            var body = new StringBuilder();
            body.Append("{\"page\":").Append(page)
                .Append(",\"pageSize\":").Append(pageSize)
                .Append(",\"totalRecords\":").Append(
                    page == _changedTotalOnPage ? _total - 1 : _total)
                .Append(",\"records\":[");
            for (var offset = 0; offset < count; offset++)
            {
                if (offset > 0)
                {
                    body.Append(',');
                }

                var id = firstId + offset;
                var date = id == _malformedDateId
                    ? "not-a-date"
                    : Start.AddMinutes(-(id - 1)).ToString("O");
                body.Append("{\"id\":").Append(id)
                    .Append(",\"date\":\"").Append(date).Append("\"}");
            }

            body.Append("]}");
            return Json(body.ToString());
        }

        private static int QueryInt(Uri uri, string name)
        {
            foreach (var part in uri.Query.TrimStart('?').Split(
                '&',
                StringSplitOptions.RemoveEmptyEntries))
            {
                var pair = part.Split('=', 2);
                if (pair.Length == 2 && string.Equals(pair[0], name, StringComparison.Ordinal))
                {
                    return int.Parse(pair[1], System.Globalization.CultureInfo.InvariantCulture);
                }
            }

            return 0;
        }

        private static Task<HttpResponseMessage> Json(
            string body,
            HttpStatusCode status = HttpStatusCode.OK)
            => Task.FromResult(new HttpResponseMessage(status)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json"),
            });
    }
}
