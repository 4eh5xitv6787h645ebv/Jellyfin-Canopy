using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using Xunit;

namespace Jellyfin.Plugin.JellyfinEnhanced.Tests.Helpers.Jellyseerr
{
    /// <summary>
    /// Pins SEERR-2's deny-by-default classifier for the raw <c>/tmdb/{**apiPath}</c>
    /// passthrough: only rating-free shapes are Neutral, movie/tv detail and non-list
    /// sub-resources are DetailGate (parent-gated), and every enumerating or
    /// future/unknown shape is Restricted. The class guard fails if a new leaky shape
    /// is ever added without a conscious classification.
    /// </summary>
    public class TmdbProxyPathClassifierTests
    {
        [Theory]
        [InlineData("search/keyword")]
        [InlineData("search/company")]
        [InlineData("search/person")]
        [InlineData("genres/movie")]
        [InlineData("genres/tv")]
        public void Neutral_ForRatingFreeShapes(string apiPath)
            => Assert.Equal(TmdbProxyGate.Neutral, TmdbProxyPathClassifier.Classify(apiPath).Gate);

        [Theory]
        [InlineData("discover/movie")]
        [InlineData("discover/tv")]
        [InlineData("search/multi")]
        [InlineData("trending/all")]
        [InlineData("movie/550/similar")]
        [InlineData("tv/1399/recommendations")]
        [InlineData("person/287/combined_credits")]
        [InlineData("collection/10")]
        [InlineData("some/unknown/path")]
        [InlineData("movie/0")]
        [InlineData("movie")]
        [InlineData("")]
        public void Restricted_ForEnumeratingOrUnknownShapes(string apiPath)
            => Assert.Equal(TmdbProxyGate.Restricted, TmdbProxyPathClassifier.Classify(apiPath).Gate);

        [Theory]
        [InlineData("movie/550", "movie", 550)]
        [InlineData("tv/1399", "tv", 1399)]
        [InlineData("tv/1399/season/1", "tv", 1399)]
        [InlineData("movie/550/watch/providers", "movie", 550)]
        [InlineData("movie/550/reviews", "movie", 550)]
        public void DetailGate_CarriesParentTitle(string apiPath, string mediaType, int tmdbId)
        {
            var decision = TmdbProxyPathClassifier.Classify(apiPath);
            Assert.Equal(TmdbProxyGate.DetailGate, decision.Gate);
            Assert.Equal(mediaType, decision.MediaType);
            Assert.Equal(tmdbId, decision.TmdbId);
        }

        [Fact]
        public void QueryStringIsIgnored()
            => Assert.Equal(TmdbProxyGate.Neutral, TmdbProxyPathClassifier.Classify("genres/movie?language=en").Gate);

        // Class guard: a future dev adding a raw-TMDB shape without classifying it must
        // get Restricted (blocked-by-default), never a silent passthrough.
        [Fact]
        public void UnknownPath_DefaultsToRestricted()
            => Assert.Equal(TmdbProxyGate.Restricted, TmdbProxyPathClassifier.Classify("any/new/tmdb/endpoint").Gate);
    }
}
