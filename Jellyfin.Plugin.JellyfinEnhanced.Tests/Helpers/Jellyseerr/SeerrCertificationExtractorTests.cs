using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using Xunit;

namespace Jellyfin.Plugin.JellyfinEnhanced.Tests.Helpers.Jellyseerr
{
    /// <summary>
    /// Verifies the C# certification extractor matches the client's
    /// <c>getContentRating</c> (more-info-modal-data.ts): region -> US -> first
    /// fallback, theatrical (type 3) preference for movies, and the ISO actually
    /// used is reported so scores resolve against the right country.
    /// </summary>
    public class SeerrCertificationExtractorTests
    {
        private static JsonElement Parse(string json) => JsonDocument.Parse(json).RootElement;

        private const string MovieUsGb = @"{
            ""releases"": { ""results"": [
                { ""iso_3166_1"": ""GB"", ""release_dates"": [ { ""type"": 3, ""certification"": ""15"" } ] },
                { ""iso_3166_1"": ""US"", ""release_dates"": [
                    { ""type"": 1, ""certification"": """" },
                    { ""type"": 3, ""certification"": ""PG-13"" }
                ] }
            ] }
        }";

        [Fact]
        public void Movie_PrefersRequestedRegion()
        {
            var result = SeerrCertificationExtractor.Extract(Parse(MovieUsGb), "movie", "GB");
            Assert.Equal("15", result.Certification);
            Assert.Equal("GB", result.Iso);
        }

        [Fact]
        public void Movie_FallsBackToUsWhenRegionMissing()
        {
            var result = SeerrCertificationExtractor.Extract(Parse(MovieUsGb), "movie", "FR");
            Assert.Equal("PG-13", result.Certification);
            Assert.Equal("US", result.Iso);
        }

        [Fact]
        public void Movie_PrefersTheatricalTypeThenAnyCertification()
        {
            // US entry has a blank type-1 cert then a type-3 "PG-13": type 3 wins.
            var result = SeerrCertificationExtractor.Extract(Parse(MovieUsGb), "movie", "US");
            Assert.Equal("PG-13", result.Certification);
        }

        [Fact]
        public void Movie_FallsBackToFirstCertifiedWhenNoTheatrical()
        {
            const string json = @"{ ""releases"": { ""results"": [
                { ""iso_3166_1"": ""US"", ""release_dates"": [ { ""type"": 1, ""certification"": ""R"" } ] } ] } }";
            var result = SeerrCertificationExtractor.Extract(Parse(json), "movie", "US");
            Assert.Equal("R", result.Certification);
        }

        [Fact]
        public void Movie_NoCertification_ReturnsNull()
        {
            const string json = @"{ ""releases"": { ""results"": [
                { ""iso_3166_1"": ""US"", ""release_dates"": [ { ""type"": 3, ""certification"": """" } ] } ] } }";
            var result = SeerrCertificationExtractor.Extract(Parse(json), "movie", "US");
            Assert.Null(result.Certification);
        }

        [Fact]
        public void Movie_NoReleases_ReturnsNull()
        {
            var result = SeerrCertificationExtractor.Extract(Parse(@"{ ""title"": ""x"" }"), "movie", "US");
            Assert.Null(result.Certification);
        }

        [Fact]
        public void Tv_ReadsContentRatings_WithRegionFallback()
        {
            const string json = @"{ ""contentRatings"": { ""results"": [
                { ""iso_3166_1"": ""US"", ""rating"": ""TV-14"" },
                { ""iso_3166_1"": ""DE"", ""rating"": ""16"" } ] } }";

            var us = SeerrCertificationExtractor.Extract(Parse(json), "tv", "US");
            Assert.Equal("TV-14", us.Certification);
            Assert.Equal("US", us.Iso);

            var de = SeerrCertificationExtractor.Extract(Parse(json), "tv", "DE");
            Assert.Equal("16", de.Certification);

            // Unknown region -> US fallback.
            var fallback = SeerrCertificationExtractor.Extract(Parse(json), "tv", "JP");
            Assert.Equal("TV-14", fallback.Certification);
            Assert.Equal("US", fallback.Iso);
        }

        [Fact]
        public void Tv_UsesFirstEntryWhenNoRegionAndNoUs()
        {
            const string json = @"{ ""contentRatings"": { ""results"": [
                { ""iso_3166_1"": ""FR"", ""rating"": ""12"" } ] } }";
            var result = SeerrCertificationExtractor.Extract(Parse(json), "tv", "GB");
            Assert.Equal("12", result.Certification);
            Assert.Equal("FR", result.Iso);
        }

        [Fact]
        public void Movie_ReadsTmdbNativeReleaseDatesShape()
        {
            // TMDB's /movie/{id}/release_dates returns { results: [...] } directly,
            // without Seerr's `releases` wrapper — the extractor must handle both.
            const string json = @"{ ""id"": 1, ""results"": [
                { ""iso_3166_1"": ""US"", ""release_dates"": [ { ""type"": 3, ""certification"": ""R"" } ] } ] }";
            var result = SeerrCertificationExtractor.Extract(Parse(json), "movie", "US");
            Assert.Equal("R", result.Certification);
            Assert.Equal("US", result.Iso);
        }

        [Fact]
        public void Tv_ReadsTmdbNativeContentRatingsShape()
        {
            // TMDB's /tv/{id}/content_ratings returns { results: [...] } directly.
            const string json = @"{ ""id"": 1, ""results"": [
                { ""iso_3166_1"": ""US"", ""rating"": ""TV-MA"" } ] }";
            var result = SeerrCertificationExtractor.Extract(Parse(json), "tv", "US");
            Assert.Equal("TV-MA", result.Certification);
            Assert.Equal("US", result.Iso);
        }

        [Fact]
        public void NonObject_ReturnsDefault()
        {
            var result = SeerrCertificationExtractor.Extract(Parse("[]"), "movie", "US");
            Assert.Null(result.Certification);
            Assert.Null(result.Iso);
        }
    }
}
