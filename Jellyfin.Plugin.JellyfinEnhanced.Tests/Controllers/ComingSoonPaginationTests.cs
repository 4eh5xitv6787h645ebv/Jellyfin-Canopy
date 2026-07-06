using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Xunit;

namespace Jellyfin.Plugin.JellyfinEnhanced.Tests.Controllers
{
    /// <summary>
    /// ARR-5: "Coming Soon" must aggregate ALL upstream pages of both `processing` and
    /// `approved` (the single-page path only ever saw page 1 of processing) and paginate the
    /// full future-dated set locally so paging is correct and the totals are honest.
    /// </summary>
    public class ComingSoonPaginationTests
    {
        private static JsonArray Page(params int[] ids)
        {
            var arr = new JsonArray();
            foreach (var id in ids)
            {
                arr.Add(new JsonObject { ["id"] = id });
            }

            return arr;
        }

        // Raw==filtered fetcher: the aggregate walk sees the whole page (no parental removals).
        private static Task<(int RawCount, JsonArray? Filtered)> Unfiltered(JsonArray? page)
            => Task.FromResult<(int, JsonArray?)>((page?.Count ?? 0, page));

        [Fact]
        public async Task AggregateComingSoonPages_WalksEveryPageAndFilter_DedupedById()
        {
            // Future-dated requests span multiple pages; `approved` carries one too. A single
            // page of `processing` (the old behavior) would miss ids 3,4,5,6 and 100.
            Task<(int, JsonArray?)> Fetch(string filter, int skip, int take)
            {
                JsonArray? page = (filter, skip) switch
                {
                    ("processing", 0) => Page(1, 2),  // full page → keep paging
                    ("processing", 2) => Page(3, 4),  // page 2 → reachable now
                    ("processing", 4) => Page(4, 5),  // id 4 duplicate + full page → keep paging
                    ("processing", 6) => Page(6),     // short page → stop processing
                    ("approved", 0)   => Page(100),   // `approved` set → previously never fetched
                    _ => new JsonArray()
                };
                return Unfiltered(page);
            }

            var combined = await ArrRequestsController.AggregateComingSoonPagesAsync(
                Fetch, new[] { "processing", "approved" }, pageSize: 2, maxItems: 500);

            var ids = combined.Select(o => (int)o["id"]!).ToArray();
            Assert.Equal(new[] { 1, 2, 3, 4, 5, 6, 100 }, ids); // page-2+ items + approved, id 4 deduped
        }

        [Fact]
        public async Task AggregateComingSoonPages_PaginatesByRawLength_NotFilteredCount()
        {
            // SEC-SEERR-3: the parental filter shrinks each full upstream page (2 rows) below
            // pageSize. Terminating on the FILTERED count would stop after page 0 and hide the
            // future-dated id 3; the walk must continue while the RAW upstream page is full.
            Task<(int, JsonArray?)> Fetch(string filter, int skip, int take)
            {
                (int RawCount, JsonArray? Filtered) page = (filter, skip) switch
                {
                    ("processing", 0) => (2, Page(1)), // raw full (2), one row filtered out
                    ("processing", 2) => (1, Page(3)), // raw short (1) → last page, id 3 survives
                    _ => (0, new JsonArray())
                };
                return Task.FromResult(page);
            }

            var combined = await ArrRequestsController.AggregateComingSoonPagesAsync(
                Fetch, new[] { "processing" }, pageSize: 2, maxItems: 500);

            var ids = combined.Select(o => (int)o["id"]!).ToArray();
            Assert.Equal(new[] { 1, 3 }, ids); // id 3 reached only when paginating by raw length
        }

        [Fact]
        public async Task AggregateComingSoonPages_RespectsMaxItemsCap()
        {
            // A Seerr that never returns a short page must not drive unbounded upstream calls.
            Task<(int, JsonArray?)> Fetch(string filter, int skip, int take)
                => Unfiltered(filter == "processing" ? Page(skip, skip + 1) : new JsonArray());

            var combined = await ArrRequestsController.AggregateComingSoonPagesAsync(
                Fetch, new[] { "processing" }, pageSize: 2, maxItems: 6);

            Assert.Equal(6, combined.Count);
        }

        [Fact]
        public async Task AggregateComingSoonPages_AllFilteredFullPages_TerminatesAtPageCap()
        {
            // A pathological upstream: every page is FULL (raw == pageSize) but every row is
            // filtered out, so combined.Count never advances and the raw-length/maxItems guards can
            // never fire. Without the page cap this loops forever; the guard below fails the test
            // fast (instead of hanging) if it ever runs past the cap.
            var calls = 0;
            Task<(int, JsonArray?)> Fetch(string filter, int skip, int take)
            {
                calls++;
                if (calls > 1000)
                {
                    throw new InvalidOperationException("coming-soon aggregation looped past the page cap");
                }

                return Task.FromResult<(int, JsonArray?)>((take, new JsonArray())); // full raw page, zero survivors
            }

            var combined = await ArrRequestsController.AggregateComingSoonPagesAsync(
                Fetch, new[] { "processing" }, pageSize: 2, maxItems: 500, maxPagesPerFilter: 5);

            Assert.Empty(combined);   // nothing survived the filter
            Assert.Equal(5, calls);   // stopped exactly at the page cap, not looping forever
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
    }
}
