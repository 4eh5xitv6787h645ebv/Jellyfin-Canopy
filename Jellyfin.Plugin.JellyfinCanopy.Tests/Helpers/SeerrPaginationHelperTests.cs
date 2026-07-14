using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Helpers
{
    public class SeerrPaginationHelperTests
    {
        [Fact]
        public async Task Watchlist_ServerIgnoresTake_FollowsReportedSecondPage()
        {
            var handler = new RoutingHandler(uri =>
            {
                var page = QueryInt(uri, "page");
                var rows = page == 1
                    ? Enumerable.Range(1, 20).Select(static id => new { id }).ToArray()
                    : new[] { new { id = 21 } };
                return Json(new { page, totalPages = 2, totalResults = 21, results = rows });
            });
            using var client = new HttpClient(handler);

            var result = await SeerrPaginationHelper.FetchAllAsync(
                client,
                new[] { "http://seerr" },
                static (url, page, _) => $"{url}/api/v1/user/7/watchlist?take=100&page={page}",
                "key",
                "7",
                requestedPageSize: 100,
                Id);

            Assert.True(result.IsComplete, result.FailureReason);
            Assert.Equal(21, result.Items.Count);
            Assert.Contains(result.Items, item => item.GetProperty("id").GetInt32() == 21);
            Assert.Equal(new[] { 1, 2, 1, 2 }, handler.Requests.Select(uri => QueryInt(uri, "page")));
        }

        [Fact]
        public async Task SkipPaginator_UsesActualReturnedCount_NotRequestedTake()
        {
            var handler = new RoutingHandler(uri =>
            {
                var skip = QueryInt(uri, "skip");
                var rows = skip == 0
                    ? Enumerable.Range(1, 20).Select(static id => new { id }).ToArray()
                    : new[] { new { id = 21 } };
                return Json(new
                {
                    results = rows,
                    pageInfo = new { page = skip == 0 ? 1 : 2, pages = 2, pageSize = 20, results = 21 },
                });
            });
            using var client = new HttpClient(handler);

            var result = await SeerrPaginationHelper.FetchAllAsync(
                client,
                new[] { "http://seerr" },
                static (url, _, skip) => $"{url}/api/v1/request?take=500&skip={skip}",
                "key",
                apiUserId: null,
                requestedPageSize: 500,
                Id);

            Assert.True(result.IsComplete, result.FailureReason);
            Assert.Equal(21, result.Items.Count);
            Assert.Equal(new[] { 0, 20, 0, 20 }, handler.Requests.Select(uri => QueryInt(uri, "skip")));
        }

        [Fact]
        public async Task PageFailure_DiscardsPartialRows_AndRestartsAtNextBaseUrl()
        {
            var handler = new RoutingHandler(uri =>
            {
                var page = QueryInt(uri, "page");
                if (uri.Host == "first" && page == 2)
                {
                    return Json(new { error = true }, HttpStatusCode.BadGateway);
                }

                var prefix = uri.Host == "first" ? "a" : "b";
                return Json(new
                {
                    page,
                    totalPages = 2,
                    totalResults = 2,
                    results = new[] { new { id = $"{prefix}{page}" } },
                });
            });
            using var client = new HttpClient(handler);

            var result = await SeerrPaginationHelper.FetchAllAsync(
                client,
                new[] { "http://first", "http://second" },
                static (url, page, _) => $"{url}/items?page={page}",
                "key",
                apiUserId: null,
                requestedPageSize: 20,
                Id);

            Assert.True(result.IsComplete, result.FailureReason);
            Assert.Equal("http://second", result.SourceUrl);
            Assert.Equal(new[] { "b1", "b2" }, result.Items.Select(item => item.GetProperty("id").GetString()));
            Assert.Equal(
                new[] { "first:1", "first:2", "second:1", "second:2", "second:1", "second:2" },
                handler.Requests.Select(uri => $"{uri.Host}:{QueryInt(uri, "page")}"));
        }

        [Fact]
        public async Task DuplicateBoundaryRows_AreIncompleteBecauseOffsetMayHaveShifted()
        {
            var handler = new RoutingHandler(uri =>
            {
                var page = QueryInt(uri, "page");
                var rows = page == 1
                    ? new[] { new { id = 1 }, new { id = 2 } }
                    : new[] { new { id = 2 }, new { id = 3 } };
                return Json(new { page, totalPages = 2, totalResults = 4, results = rows });
            });
            using var client = new HttpClient(handler);

            var result = await SeerrPaginationHelper.FetchAllAsync(
                client,
                new[] { "http://seerr" },
                static (url, page, _) => $"{url}/items?page={page}",
                "key",
                apiUserId: null,
                requestedPageSize: 2,
                Id);

            Assert.False(result.IsComplete);
            Assert.Empty(result.Items);
            Assert.Contains("identity '2'", result.FailureReason, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public async Task ShiftLeftChurnWithStableTotal_IsIncompleteWhenConfirmationScanDiffers()
        {
            var scan = 0;
            var handler = new RoutingHandler(uri =>
            {
                var page = QueryInt(uri, "page");
                if (page == 1) scan++;
                var rows = (scan, page) switch
                {
                    (1, 1) => new[] { new { id = 1 }, new { id = 2 } },
                    (1, 2) => new[] { new { id = 4 }, new { id = 5 } },
                    (2, 1) => new[] { new { id = 2 }, new { id = 3 } },
                    (2, 2) => new[] { new { id = 4 }, new { id = 5 } },
                    _ => throw new InvalidOperationException($"Unexpected scan/page {scan}/{page}."),
                };
                return Json(new { page, totalPages = 2, totalResults = 4, results = rows });
            });
            using var client = new HttpClient(handler);

            var result = await SeerrPaginationHelper.FetchAllAsync(
                client,
                new[] { "http://seerr" },
                static (url, page, _) => $"{url}/items?page={page}",
                "key",
                apiUserId: null,
                requestedPageSize: 2,
                Id);

            Assert.False(result.IsComplete);
            Assert.Empty(result.Items);
            Assert.Contains("consecutive", result.FailureReason, StringComparison.OrdinalIgnoreCase);
            Assert.Equal(new[] { 1, 2, 1, 2 }, handler.Requests.Select(uri => QueryInt(uri, "page")));
        }

        [Fact]
        public async Task DuplicateRowsWithinOneResponse_AreIncomplete()
        {
            var handler = new RoutingHandler(_ => Json(new
            {
                page = 1,
                totalPages = 1,
                totalResults = 3,
                results = new[] { new { id = 1 }, new { id = 1 }, new { id = 2 } },
            }));
            using var client = new HttpClient(handler);

            var result = await SeerrPaginationHelper.FetchAllAsync(
                client,
                new[] { "http://seerr" },
                static (url, page, _) => $"{url}/items?page={page}",
                "key",
                apiUserId: null,
                requestedPageSize: 3,
                Id);

            Assert.False(result.IsComplete);
            Assert.Empty(result.Items);
            Assert.Contains("repeated", result.FailureReason, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public async Task NumericStringIdentityAliases_AreCanonicalDuplicatesAndInvalidateSnapshot()
        {
            var handler = new RoutingHandler(_ => Json(new
            {
                page = 1,
                totalPages = 1,
                totalResults = 2,
                results = new[] { new { id = "1" }, new { id = "01" } },
            }));
            using var client = new HttpClient(handler);

            var result = await SeerrPaginationHelper.FetchAllAsync(
                client,
                new[] { "http://seerr" },
                static (url, page, _) => $"{url}/items?page={page}",
                "key",
                apiUserId: null,
                requestedPageSize: 2,
                static row => SeerrPaginationHelper.CanonicalPositiveIntegerPropertyIdentity(row, "id"));

            Assert.False(result.IsComplete);
            Assert.Empty(result.Items);
            Assert.Contains("identity '1'", result.FailureReason, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("conflicting", result.FailureReason, StringComparison.OrdinalIgnoreCase);
        }

        [Theory]
        [InlineData("0")]
        [InlineData("-1")]
        [InlineData("not-an-id")]
        public async Task InvalidIntegerBackedIdentity_IsIncomplete(string id)
        {
            var handler = new RoutingHandler(_ => Json(new
            {
                page = 1,
                totalPages = 1,
                totalResults = 1,
                results = new[] { new { id } },
            }));
            using var client = new HttpClient(handler);

            var result = await SeerrPaginationHelper.FetchAllAsync(
                client,
                new[] { "http://seerr" },
                static (url, page, _) => $"{url}/items?page={page}",
                "key",
                apiUserId: null,
                requestedPageSize: 1,
                static row => SeerrPaginationHelper.CanonicalPositiveIntegerPropertyIdentity(row, "id"));

            Assert.False(result.IsComplete);
            Assert.Empty(result.Items);
            Assert.Contains("identity was missing or empty", result.FailureReason, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public async Task MissingSourceIdentity_IsIncompleteInsteadOfUsingRowFingerprint()
        {
            var handler = new RoutingHandler(_ => Json(new
            {
                page = 1,
                totalPages = 1,
                totalResults = 1,
                results = new[] { new { value = "row-without-id" } },
            }));
            using var client = new HttpClient(handler);

            var result = await SeerrPaginationHelper.FetchAllAsync(
                client,
                new[] { "http://seerr" },
                static (url, page, _) => $"{url}/items?page={page}",
                "key",
                apiUserId: null,
                requestedPageSize: 1,
                Id);

            Assert.False(result.IsComplete);
            Assert.Empty(result.Items);
            Assert.Contains("identity was missing or empty", result.FailureReason, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public async Task EmptySourceIdentity_IsIncompleteInsteadOfUsingRowFingerprint()
        {
            var handler = new RoutingHandler(_ => Json(new
            {
                page = 1,
                totalPages = 1,
                totalResults = 1,
                results = new[] { new { id = "" } },
            }));
            using var client = new HttpClient(handler);

            var result = await SeerrPaginationHelper.FetchAllAsync(
                client,
                new[] { "http://seerr" },
                static (url, page, _) => $"{url}/items?page={page}",
                "key",
                apiUserId: null,
                requestedPageSize: 1,
                Id);

            Assert.False(result.IsComplete);
            Assert.Empty(result.Items);
            Assert.Contains("identity was missing or empty", result.FailureReason, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public async Task DuplicateIdentityWithConflictingRows_IsIncomplete()
        {
            var handler = new RoutingHandler(uri =>
            {
                var page = QueryInt(uri, "page");
                var rows = page == 1
                    ? new[] { new { id = 1, state = "approved" } }
                    : new[] { new { id = 1, state = "processing" } };
                return Json(new { page, totalPages = 2, totalResults = 2, results = rows });
            });
            using var client = new HttpClient(handler);

            var result = await SeerrPaginationHelper.FetchAllAsync(
                client,
                new[] { "http://seerr" },
                static (url, page, _) => $"{url}/items?page={page}",
                "key",
                apiUserId: null,
                requestedPageSize: 1,
                Id);

            Assert.False(result.IsComplete);
            Assert.Empty(result.Items);
            Assert.Contains("conflicting rows", result.FailureReason, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public async Task ContinuationPageWithOnlyKnownIdentities_IsIncomplete()
        {
            var handler = new RoutingHandler(uri =>
            {
                var page = QueryInt(uri, "page");
                var rows = page == 1
                    ? new[] { new { id = 1 }, new { id = 2 } }
                    : new[] { new { id = 2 }, new { id = 1 } };
                return Json(new { page, totalPages = 2, totalResults = 4, results = rows });
            });
            using var client = new HttpClient(handler);

            var result = await SeerrPaginationHelper.FetchAllAsync(
                client,
                new[] { "http://seerr" },
                static (url, page, _) => $"{url}/items?page={page}",
                "key",
                apiUserId: null,
                requestedPageSize: 2,
                Id);

            Assert.False(result.IsComplete);
            Assert.Empty(result.Items);
            Assert.Contains("repeated", result.FailureReason, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public async Task RepeatedPage_IsBoundedAndNeverPublishesPartialRows()
        {
            var handler = new RoutingHandler(_ => Json(new
            {
                page = 1,
                totalPages = 3,
                totalResults = 3,
                results = new[] { new { id = 1 } },
            }));
            using var client = new HttpClient(handler);

            var result = await SeerrPaginationHelper.FetchAllAsync(
                client,
                new[] { "http://seerr" },
                static (url, page, _) => $"{url}/items?page={page}",
                "key",
                apiUserId: null,
                requestedPageSize: 1,
                Id);

            Assert.False(result.IsComplete);
            Assert.Empty(result.Items);
            Assert.Equal(2, handler.Requests.Count);
            Assert.Contains("page", result.FailureReason, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public async Task MissingCompletionMetadata_IsIncomplete_NotOnePageSuccess()
        {
            var handler = new RoutingHandler(_ => Json(new { results = new[] { new { id = 1 } } }));
            using var client = new HttpClient(handler);

            var result = await SeerrPaginationHelper.FetchAllAsync(
                client,
                new[] { "http://seerr" },
                static (url, page, _) => $"{url}/items?page={page}",
                "key",
                apiUserId: null,
                requestedPageSize: 1000,
                Id);

            Assert.False(result.IsComplete);
            Assert.Empty(result.Items);
            Assert.Contains("metadata", result.FailureReason, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public async Task ConflictingCompletionMetadata_DoesNotTruncateAtFirstPage()
        {
            var handler = new RoutingHandler(uri =>
            {
                var page = QueryInt(uri, "page");
                return Json(new
                {
                    page,
                    totalPages = 1,
                    totalResults = 2,
                    results = new[] { new { id = page } },
                });
            });
            using var client = new HttpClient(handler);

            var result = await SeerrPaginationHelper.FetchAllAsync(
                client,
                new[] { "http://seerr" },
                static (url, page, _) => $"{url}/items?page={page}",
                "key",
                apiUserId: null,
                requestedPageSize: 1,
                Id);

            Assert.False(result.IsComplete);
            Assert.Empty(result.Items);
            Assert.Equal(2, handler.Requests.Count);
        }

        [Fact]
        public async Task MalformedMetadata_IsIncompleteEvenWhenAnotherTotalExists()
        {
            var handler = new RoutingHandler(_ => Json(new
            {
                totalPages = "one",
                totalResults = 1,
                results = new[] { new { id = 1 } },
            }));
            using var client = new HttpClient(handler);

            var result = await SeerrPaginationHelper.FetchAllAsync(
                client,
                new[] { "http://seerr" },
                static (url, page, _) => $"{url}/items?page={page}",
                "key",
                apiUserId: null,
                requestedPageSize: 1,
                Id);

            Assert.False(result.IsComplete);
            Assert.Empty(result.Items);
            Assert.Contains("non-negative integer", result.FailureReason, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public async Task MoreRowsThanReportedTotal_IsIncomplete()
        {
            var handler = new RoutingHandler(_ => Json(new
            {
                page = 1,
                totalPages = 1,
                totalResults = 1,
                results = new[] { new { id = 1 }, new { id = 2 } },
            }));
            using var client = new HttpClient(handler);

            var result = await SeerrPaginationHelper.FetchAllAsync(
                client,
                new[] { "http://seerr" },
                static (url, page, _) => $"{url}/items?page={page}",
                "key",
                apiUserId: null,
                requestedPageSize: 2,
                Id);

            Assert.False(result.IsComplete);
            Assert.Empty(result.Items);
            Assert.Contains("more rows", result.FailureReason, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public async Task EmptyAdvertisedFinalPage_IsIncompleteWithoutPublishingPrefix()
        {
            var handler = new RoutingHandler(uri =>
            {
                var page = QueryInt(uri, "page");
                var rows = page == 1
                    ? new[] { new { id = 1 } }
                    : Array.Empty<object>();
                return Json(new { page, totalPages = 2, results = rows });
            });
            using var client = new HttpClient(handler);

            var result = await SeerrPaginationHelper.FetchAllAsync(
                client,
                new[] { "http://seerr" },
                static (url, page, _) => $"{url}/items?page={page}",
                "key",
                apiUserId: null,
                requestedPageSize: 1,
                Id);

            Assert.False(result.IsComplete);
            Assert.Empty(result.Items);
            Assert.Contains("empty page", result.FailureReason, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public async Task CancellationDuringFinalPageProjection_Propagates()
        {
            using var cancellation = new CancellationTokenSource();
            var handler = new RoutingHandler(_ => Json(new
            {
                page = 1,
                totalPages = 1,
                totalResults = 1,
                results = new[] { new { id = 1 } },
            }));
            using var client = new HttpClient(handler);

            await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
                SeerrPaginationHelper.FetchAllAsync(
                    client,
                    new[] { "http://seerr" },
                    static (url, page, _) => $"{url}/items?page={page}",
                    "key",
                    apiUserId: null,
                    requestedPageSize: 1,
                    item =>
                    {
                        cancellation.Cancel();
                        return Id(item);
                    },
                    cancellation.Token));
        }

        [Fact]
        public async Task NonObjectJson_IsExplicitlyIncomplete()
        {
            var handler = new RoutingHandler(_ => Json(new[] { new { id = 1 } }));
            using var client = new HttpClient(handler);

            var result = await SeerrPaginationHelper.FetchAllAsync(
                client,
                new[] { "http://seerr" },
                static (url, page, _) => $"{url}/items?page={page}",
                "key",
                apiUserId: null,
                requestedPageSize: 1,
                Id);

            Assert.False(result.IsComplete);
            Assert.Empty(result.Items);
            Assert.Contains("root", result.FailureReason, StringComparison.OrdinalIgnoreCase);
        }

        private static string? Id(JsonElement item)
            => item.TryGetProperty("id", out var id) ? id.ToString() : null;

        private static int QueryInt(Uri uri, string name)
        {
            foreach (var pair in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
            {
                var parts = pair.Split('=', 2);
                if (parts.Length == 2 && string.Equals(parts[0], name, StringComparison.Ordinal))
                {
                    return int.Parse(parts[1], System.Globalization.CultureInfo.InvariantCulture);
                }
            }

            throw new InvalidOperationException($"Query parameter '{name}' was missing from {uri}.");
        }

        private static HttpResponseMessage Json(object body, HttpStatusCode status = HttpStatusCode.OK)
            => new(status)
            {
                Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json"),
            };

        private sealed class RoutingHandler : HttpMessageHandler
        {
            private readonly Func<Uri, HttpResponseMessage> _route;

            public RoutingHandler(Func<Uri, HttpResponseMessage> route) => _route = route;

            public List<Uri> Requests { get; } = new();

            protected override Task<HttpResponseMessage> SendAsync(
                HttpRequestMessage request,
                CancellationToken cancellationToken)
            {
                Requests.Add(request.RequestUri!);
                return Task.FromResult(_route(request.RequestUri!));
            }
        }
    }
}
