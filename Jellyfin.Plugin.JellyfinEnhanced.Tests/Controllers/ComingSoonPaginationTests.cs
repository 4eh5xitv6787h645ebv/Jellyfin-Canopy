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

        [Fact]
        public async Task AggregateComingSoonPages_WalksEveryPageAndFilter_DedupedById()
        {
            // Future-dated requests span multiple pages; `approved` carries one too. A single
            // page of `processing` (the old behavior) would miss ids 3,4,5,6 and 100.
            Task<JsonArray?> Fetch(string filter, int skip, int take)
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
                return Task.FromResult<JsonArray?>(page);
            }

            var combined = await ArrRequestsController.AggregateComingSoonPagesAsync(
                Fetch, new[] { "processing", "approved" }, pageSize: 2, maxItems: 500);

            var ids = combined.Select(o => (int)o["id"]!).ToArray();
            Assert.Equal(new[] { 1, 2, 3, 4, 5, 6, 100 }, ids); // page-2+ items + approved, id 4 deduped
        }

        [Fact]
        public async Task AggregateComingSoonPages_RespectsMaxItemsCap()
        {
            // A Seerr that never returns a short page must not drive unbounded upstream calls.
            Task<JsonArray?> Fetch(string filter, int skip, int take)
                => Task.FromResult<JsonArray?>(filter == "processing" ? Page(skip, skip + 1) : new JsonArray());

            var combined = await ArrRequestsController.AggregateComingSoonPagesAsync(
                Fetch, new[] { "processing" }, pageSize: 2, maxItems: 6);

            Assert.Equal(6, combined.Count);
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
