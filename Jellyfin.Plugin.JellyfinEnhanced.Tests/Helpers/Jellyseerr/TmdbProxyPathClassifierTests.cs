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
        [InlineData("genres/movie")]
        [InlineData("genres/tv")]
        public void Neutral_ForRatingFreeShapes(string apiPath)
            => Assert.Equal(TmdbProxyGate.Neutral, TmdbProxyPathClassifier.Classify(apiPath).Gate);

        [Theory]
        [InlineData("discover/movie")]
        [InlineData("discover/tv")]
        [InlineData("search/multi")]
        // search/person returns results[].known_for[] full title objects
        // (name/overview/poster/adult) the raw passthrough cannot body-filter,
        // so a rating-limited caller must be denied it.
        [InlineData("search/person")]
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

        // A benign query on an otherwise-allowed detail keeps the DetailGate — only
        // append_to_response flips the decision, not any query string.
        [Fact]
        public void BenignQueryOnDetail_StaysDetailGate()
            => Assert.Equal(TmdbProxyGate.DetailGate, TmdbProxyPathClassifier.Classify("movie/550?language=en").Gate);

        // append_to_response=similar,recommendations rides on an allowed detail and
        // returns above-limit title lists the raw passthrough cannot body-filter, so
        // the whole request must be Restricted (403 for a rating-limited caller).
        [Theory]
        [InlineData("movie/550?append_to_response=similar,recommendations")]
        [InlineData("tv/1399?append_to_response=recommendations")]
        [InlineData("movie/550?language=en&append_to_response=similar")]
        [InlineData("movie/550?append_to_response=videos")]
        public void AppendToResponse_ForcesRestricted(string apiPath)
            => Assert.Equal(TmdbProxyGate.Restricted, TmdbProxyPathClassifier.Classify(apiPath).Gate);

        // Class guard: a future dev adding a raw-TMDB shape without classifying it must
        // get Restricted (blocked-by-default), never a silent passthrough.
        [Fact]
        public void UnknownPath_DefaultsToRestricted()
            => Assert.Equal(TmdbProxyGate.Restricted, TmdbProxyPathClassifier.Classify("any/new/tmdb/endpoint").Gate);

        // Defense-in-depth: a dot-segment (./..) or its percent-encoded form must be
        // rejected up front, so a Neutral first segment (e.g. genres) can never front a
        // path that the outbound Uri collapses onto a blocked title
        // (genres/../movie/{id} -> movie/{id}). The host normally normalizes these away
        // before the classifier sees them, but the gate must not depend on that.
        [Theory]
        [InlineData("genres/../movie/550")]
        [InlineData("genres/%2e%2e/movie/550")]
        [InlineData("genres/%2E%2E/movie/550")]
        [InlineData("genres/./movie")]
        [InlineData("movie/550/%2e/videos")]
        [InlineData("search/%2e%2e/movie/550")]
        public void DotSegmentPaths_AreRestricted(string apiPath)
            => Assert.Equal(TmdbProxyGate.Restricted, TmdbProxyPathClassifier.Classify(apiPath).Gate);
    }
}
