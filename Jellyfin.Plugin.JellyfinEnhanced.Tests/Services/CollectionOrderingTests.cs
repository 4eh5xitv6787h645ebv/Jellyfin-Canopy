using System.Linq;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Xunit;

namespace Jellyfin.Plugin.JellyfinEnhanced.Tests.Services
{
    /// <summary>
    /// ARR-7: "next in collection" must follow release order. The TMDB collection "parts"
    /// array is not guaranteed release-ordered, so picking parts[i+1] by raw index can request
    /// a prequel/spin-off. OrderPartsByReleaseDate sorts chronologically (missing dates last).
    /// </summary>
    public class CollectionOrderingTests
    {
        [Fact]
        public void OrderPartsByReleaseDate_SortsChronologically_MissingDatesLast()
        {
            using var doc = JsonDocument.Parse("""
                [
                  {"id":1,"title":"Sequel","releaseDate":"2015-01-01"},
                  {"id":2,"title":"Original","releaseDate":"2010-01-01"},
                  {"id":3,"title":"NoDate"}
                ]
                """);

            var ordered = AutoMovieRequestService.OrderPartsByReleaseDate(doc.RootElement);

            var ids = ordered.Select(p => p.GetProperty("id").GetInt32()).ToArray();
            Assert.Equal(new[] { 2, 1, 3 }, ids);
        }

        [Fact]
        public void OrderPartsByReleaseDate_NextAfterWatched_IsChronologicalSequel_NotRawIndex()
        {
            // Raw order lists the sequel BEFORE the film just watched, so parts[i+1] on the raw
            // array would pick the wrong movie.
            using var doc = JsonDocument.Parse("""
                [
                  {"id":10,"title":"Part 2","releaseDate":"2018-06-01"},
                  {"id":11,"title":"Part 1","releaseDate":"2016-06-01"},
                  {"id":12,"title":"Part 3","releaseDate":"2020-06-01"}
                ]
                """);

            var ordered = AutoMovieRequestService.OrderPartsByReleaseDate(doc.RootElement);

            // Just watched Part 1 (id 11); the chronological next pick must be Part 2 (id 10).
            var currentIndex = ordered.FindIndex(p => p.GetProperty("id").GetInt32() == 11);
            Assert.Equal(10, ordered[currentIndex + 1].GetProperty("id").GetInt32());
        }

        [Fact]
        public void OrderPartsByReleaseDate_NonArray_ReturnsEmpty()
        {
            using var doc = JsonDocument.Parse("""{"not":"an array"}""");
            Assert.Empty(AutoMovieRequestService.OrderPartsByReleaseDate(doc.RootElement));
        }
    }
}
