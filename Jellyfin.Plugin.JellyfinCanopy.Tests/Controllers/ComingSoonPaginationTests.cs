using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers
{
    /// <summary>
    /// ARR-5: "Coming Soon" must read every page of one `processing` snapshot, then
    /// classify and paginate the full future-dated set locally so state changes
    /// cannot fall between separate status-filtered reads.
    /// </summary>
    public class ComingSoonPaginationTests
    {
        [Fact]
        public async Task FetchComingSoonCollection_RejectsBoundaryOverlapWithoutPublishingRows()
        {
            var handler = new RoutingHandler(uri => QueryInt(uri, "skip") switch
            {
                0 => Page(page: 1, pages: 2, totalResults: 4, 1, 2),
                2 => Page(page: 2, pages: 2, totalResults: 4, 2, 3),
                var skip => throw new InvalidOperationException($"Unexpected skip {skip}."),
            });
            using var client = new HttpClient(handler);

            var result = await ArrRequestsController.FetchComingSoonCollectionAsync(
                client,
                "http://seerr",
                "key",
                "&requestedBy=7",
                SeerrDispatchFenceTestFactory.Create(),
                CancellationToken.None,
                pageSize: 100);

            Assert.False(result.IsComplete);
            Assert.Empty(result.Items);
            Assert.Contains("repeated", result.FailureReason, StringComparison.OrdinalIgnoreCase);
            Assert.Equal(new[] { 0, 2 }, handler.Requests.Select(uri => QueryInt(uri, "skip")));
            Assert.All(handler.Requests, uri => Assert.Equal("processing", QueryValue(uri, "filter")));
            Assert.All(handler.Requests, uri => Assert.Equal("7", QueryValue(uri, "requestedBy")));
        }

        [Fact]
        public async Task FetchComingSoonCollection_AdvancesSkipByActualRowsWhenTakeIsIgnored()
        {
            var handler = new RoutingHandler(uri => QueryInt(uri, "skip") switch
            {
                0 => Page(page: 1, pages: 2, totalResults: 3, 1, 2),
                2 => Page(page: 2, pages: 2, totalResults: 3, 3),
                var skip => throw new InvalidOperationException($"Unexpected skip {skip}."),
            });
            using var client = new HttpClient(handler);

            var result = await ArrRequestsController.FetchComingSoonCollectionAsync(
                client,
                "http://seerr",
                "key",
                string.Empty,
                SeerrDispatchFenceTestFactory.Create(),
                CancellationToken.None,
                pageSize: 100);

            Assert.True(result.IsComplete, result.FailureReason);
            Assert.Equal(new[] { 0, 2, 0, 2 }, handler.Requests.Select(uri => QueryInt(uri, "skip")));
        }

        [Fact]
        public async Task FetchComingSoonCollection_ItemBoundIsIncompleteWithoutPartialRows()
        {
            var handler = new RoutingHandler(uri => QueryInt(uri, "skip") switch
            {
                0 => Page(page: 1, pages: 2, totalResults: 4, 1, 2),
                2 => Page(page: 2, pages: 2, totalResults: 4, 3, 4),
                var skip => throw new InvalidOperationException($"Unexpected skip {skip}."),
            });
            using var client = new HttpClient(handler);

            var result = await ArrRequestsController.FetchComingSoonCollectionAsync(
                client,
                "http://seerr",
                "key",
                string.Empty,
                SeerrDispatchFenceTestFactory.Create(),
                CancellationToken.None,
                pageSize: 2,
                maxItems: 3);

            Assert.False(result.IsComplete);
            Assert.Empty(result.Items);
            Assert.Single(handler.Requests);
        }

        [Fact]
        public async Task FetchComingSoonCollection_PageBoundIsIncompleteWithoutPartialRows()
        {
            var handler = new RoutingHandler(uri =>
            {
                var skip = QueryInt(uri, "skip");
                return Page(page: skip + 1, pages: 10, totalResults: 10, skip + 1);
            });
            using var client = new HttpClient(handler);

            var result = await ArrRequestsController.FetchComingSoonCollectionAsync(
                client,
                "http://seerr",
                "key",
                string.Empty,
                SeerrDispatchFenceTestFactory.Create(),
                CancellationToken.None,
                pageSize: 1,
                maxPages: 2);

            Assert.False(result.IsComplete);
            Assert.Empty(result.Items);
            Assert.Single(handler.Requests);
        }

        [Fact]
        public async Task FetchComingSoonCollection_LaterPageHttpFailure_DiscardsPrefix()
        {
            var handler = new RoutingHandler(uri => QueryInt(uri, "skip") switch
            {
                0 => Page(page: 1, pages: 2, totalResults: 3, 1, 2),
                2 => Json(new { error = "temporary" }, HttpStatusCode.BadGateway),
                var skip => throw new InvalidOperationException($"Unexpected skip {skip}."),
            });
            using var client = new HttpClient(handler);

            var result = await ArrRequestsController.FetchComingSoonCollectionAsync(
                client,
                "http://seerr",
                "key",
                string.Empty,
                SeerrDispatchFenceTestFactory.Create(),
                CancellationToken.None);

            Assert.False(result.IsComplete);
            Assert.Empty(result.Items);
            Assert.Equal(2, handler.Requests.Count);
        }

        [Fact]
        public async Task FetchUserRequestSnapshot_ReturnsSentinelBeyondOldFiveHundredRowCutoff()
        {
            var handler = new RoutingHandler(uri => QueryInt(uri, "skip") switch
            {
                0 => Page(page: 1, pages: 2, totalResults: 501, Enumerable.Range(1, 500).ToArray()),
                500 => Page(page: 2, pages: 2, totalResults: 501, 501),
                var skip => throw new InvalidOperationException($"Unexpected skip {skip}."),
            });
            using var client = new HttpClient(handler);

            var result = await ArrRequestsController.FetchUserRequestSnapshotAsync(
                client,
                new[] { "http://seerr" },
                "key",
                "7",
                SeerrDispatchFenceTestFactory.Create(),
                CancellationToken.None,
                pageSize: 500);

            Assert.True(result.IsComplete, result.FailureReason);
            Assert.Equal(501, result.Items.Count);
            Assert.Equal(501, result.Items[^1].GetProperty("id").GetInt32());
            Assert.Equal(new[] { 0, 500, 0, 500 }, handler.Requests.Select(uri => QueryInt(uri, "skip")));
            Assert.All(handler.Requests, uri => Assert.Equal("7", QueryValue(uri, "requestedBy")));
        }

        [Fact]
        public void PaginateFiltered_WindowsFullSet_WithHonestTotals()
        {
            var items = Enumerable.Range(1, 25).ToList();

            var (page, total, pages) = ArrRequestsController.PaginateFiltered(items, skip: 20, take: 20);

            Assert.Equal(new[] { 21, 22, 23, 24, 25 }, page); // the real second-page window
            Assert.Equal(25, total);                          // full future count, not the page size
            Assert.Equal(2, pages);                           // ceil(25 / 20)
        }

        [Fact]
        public void PaginateFiltered_FirstPage_ReturnsWindowAndFullTotal()
        {
            var items = Enumerable.Range(1, 25).ToList();

            var (page, total, pages) = ArrRequestsController.PaginateFiltered(items, skip: 0, take: 20);

            Assert.Equal(20, page.Count);
            Assert.Equal(25, total);
            Assert.Equal(2, pages);
        }

        [Fact]
        public void TryApplySelfScope_DropsForeignRowsAndKeepsHonestRemovalCount()
        {
            var rows = JsonNode.Parse(
                """[{ "id": 1, "requestedBy": { "id": 7 } }, { "id": 2, "requestedBy": { "id": 99 } }]""")!
                .AsArray();

            var valid = ArrRequestsController.TryApplySelfScope(rows, 7, out var removed);

            Assert.True(valid);
            Assert.Equal(1, removed);
            var row = Assert.IsType<JsonObject>(Assert.Single(rows));
            Assert.Equal(1, (int?)row["id"]);
        }

        [Theory]
        [InlineData("""[{ "id": 1 }]""")]
        [InlineData("""[{ "id": 1, "requestedBy": null }]""")]
        [InlineData("""[{ "id": 1, "requestedBy": { "id": "garbage" } }]""")]
        public void TryApplySelfScope_RejectsMalformedOwnersWithoutPublishingAPrefix(string json)
        {
            var rows = JsonNode.Parse(json)!.AsArray();
            var original = rows.ToJsonString();

            var valid = ArrRequestsController.TryApplySelfScope(rows, 7, out var removed);

            Assert.False(valid);
            Assert.Equal(0, removed);
            Assert.Equal(original, rows.ToJsonString());
        }

        [Fact]
        public void TryClassifyComingSoonCandidate_DistinguishesValidExcludeFromInvalidRows()
        {
            using var included = JsonDocument.Parse(ComingSoonRow(mediaStatus: 3));
            using var excluded = JsonDocument.Parse(ComingSoonRow(mediaStatus: 2));

            Assert.True(ArrRequestsController.TryClassifyComingSoonCandidate(included.RootElement, out var include));
            Assert.True(include);
            Assert.True(ArrRequestsController.TryClassifyComingSoonCandidate(excluded.RootElement, out include));
            Assert.False(include);
        }

        [Theory]
        [InlineData("id", "null")]
        [InlineData("id", "0")]
        [InlineData("status", "1")]
        [InlineData("type", "\"music\"")]
        [InlineData("is4k", "null")]
        [InlineData("requestedBy", "null")]
        [InlineData("media", "null")]
        public void TryClassifyComingSoonCandidate_RejectsMalformedRequiredShapes(
            string property,
            string replacementJson)
        {
            var row = JsonNode.Parse(ComingSoonRow(mediaStatus: 3))!.AsObject();
            row[property] = JsonNode.Parse(replacementJson);
            using var document = JsonDocument.Parse(row.ToJsonString());

            Assert.False(ArrRequestsController.TryClassifyComingSoonCandidate(document.RootElement, out _));
        }

        [Theory]
        [InlineData("tmdbId", "0")]
        [InlineData("mediaType", "\"music\"")]
        [InlineData("status", "null")]
        [InlineData("downloadStatus", "null")]
        public void TryClassifyComingSoonCandidate_RejectsMalformedMediaShapes(
            string property,
            string replacementJson)
        {
            var row = JsonNode.Parse(ComingSoonRow(mediaStatus: 3))!.AsObject();
            var media = row["media"]!.AsObject();
            media[property] = JsonNode.Parse(replacementJson);
            using var document = JsonDocument.Parse(row.ToJsonString());

            Assert.False(ArrRequestsController.TryClassifyComingSoonCandidate(document.RootElement, out _));
        }

        private static string ComingSoonRow(int mediaStatus)
            => $$"""
                {
                  "id": 1,
                  "status": 2,
                  "type": "movie",
                  "is4k": false,
                  "requestedBy": { "id": 7 },
                  "media": {
                    "tmdbId": 42,
                    "mediaType": "movie",
                    "status": {{mediaStatus}},
                    "downloadStatus": []
                  }
                }
                """;

        private static HttpResponseMessage Page(int page, int pages, int totalResults, params int[] ids)
            => Json(new
            {
                results = ids.Select(static id => new { id }).ToArray(),
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
                System.Globalization.CultureInfo.InvariantCulture);

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
}
