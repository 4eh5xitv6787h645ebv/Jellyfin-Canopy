using System.Text.Json;
using Jellyfin.Plugin.JellyfinElevate.Helpers.Jellyseerr;
using Xunit;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.Helpers.Jellyseerr
{
    /// <summary>
    /// Pins the tag-signature extractor over every body shape the resolution
    /// pipeline can hand it: Seerr full detail (flat keyword/genre arrays),
    /// raw TMDB movie/tv keyword wrappers, and malformed/missing containers.
    /// </summary>
    public class SeerrTagSignatureExtractorTests
    {
        private static JsonElement Parse(string json)
        {
            using var doc = JsonDocument.Parse(json);
            return doc.RootElement.Clone();
        }

        [Fact]
        public void SeerrDetail_ExtractsKeywordsAndGenres_Cleaned()
        {
            var detail = Parse(@"{
                ""keywords"": [ { ""id"": 12377, ""name"": ""zombie"" }, { ""id"": 1, ""name"": ""Graphic-Violence"" } ],
                ""genres"": [ { ""id"": 27, ""name"": ""Horror"" }, { ""id"": 35, ""name"": ""Comedy"" } ]
            }");

            var (keywords, genres) = SeerrTagSignatureExtractor.Extract(detail);

            Assert.Contains("zombie", keywords);
            Assert.Contains("graphic violence", keywords); // cleaned like core
            Assert.Contains("horror", genres);
            Assert.Contains("comedy", genres);
            Assert.Equal(2, keywords.Count);
            Assert.Equal(2, genres.Count);
        }

        [Fact]
        public void RawTmdbMovieWrapper_IsUnwrapped()
        {
            var detail = Parse(@"{ ""keywords"": { ""keywords"": [ { ""id"": 1, ""name"": ""heist"" } ] } }");
            Assert.Contains("heist", SeerrTagSignatureExtractor.Extract(detail).Keywords);
        }

        [Fact]
        public void RawTmdbTvWrapper_IsUnwrapped()
        {
            var detail = Parse(@"{ ""keywords"": { ""results"": [ { ""id"": 2, ""name"": ""time travel"" } ] } }");
            Assert.Contains("time travel", SeerrTagSignatureExtractor.Extract(detail).Keywords);
        }

        [Theory]
        [InlineData(@"{}")]
        [InlineData(@"{ ""keywords"": null, ""genres"": null }")]
        [InlineData(@"{ ""keywords"": ""oops"", ""genres"": 42 }")]
        [InlineData(@"{ ""keywords"": [ { ""id"": 1 } ], ""genres"": [ ""bare-string"" ] }")]
        [InlineData(@"[1,2,3]")]
        public void MissingOrMalformedContainers_YieldEmptySets_NoThrow(string json)
        {
            var (keywords, genres) = SeerrTagSignatureExtractor.Extract(Parse(json));
            Assert.Empty(keywords);
            Assert.Empty(genres);
        }
    }
}
