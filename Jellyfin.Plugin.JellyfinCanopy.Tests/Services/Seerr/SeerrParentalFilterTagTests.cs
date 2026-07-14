using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Model.Users;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services.Seerr
{
    /// <summary>
    /// Orchestration coverage for the TAG branch of the Seerr parental filter:
    /// keyword/genre blocking on lists and details, allow-list semantics,
    /// blocked-wins precedence, the kill-switch, and the cert-only-cache
    /// upgrade (a rating-only pass must not satisfy a tag-rule pass).
    /// Companion to SeerrParentalFilterTests (rating branches).
    /// </summary>
    public class SeerrParentalFilterTagTests
    {
        private const string CallerGuid = "22222222-2222-2222-2222-222222222222";

        // Seerr full-detail fixtures: certs + keywords + genres in one body,
        // exactly what the tag-rule resolution path fetches.
        // 400 = PG-13 zombie horror-comedy; 500 = G family animation.
        private static string ZombieMovieDetail() => @"{
            ""releases"": { ""results"": [ { ""iso_3166_1"": ""US"", ""release_dates"": [ { ""type"": 3, ""certification"": ""PG-13"" } ] } ] },
            ""keywords"": [ { ""id"": 12377, ""name"": ""zombie"" }, { ""id"": 6, ""name"": ""undead"" } ],
            ""genres"": [ { ""id"": 27, ""name"": ""Horror"" }, { ""id"": 35, ""name"": ""Comedy"" } ] }";

        private static string FamilyMovieDetail() => @"{
            ""releases"": { ""results"": [ { ""iso_3166_1"": ""US"", ""release_dates"": [ { ""type"": 3, ""certification"": ""G"" } ] } ] },
            ""keywords"": [ { ""id"": 7, ""name"": ""friendship"" } ],
            ""genres"": [ { ""id"": 16, ""name"": ""Animation"" }, { ""id"": 10751, ""name"": ""Family"" } ] }";

        private static string SciFiTvDetail() => @"{
            ""contentRatings"": { ""results"": [ { ""iso_3166_1"": ""US"", ""rating"": ""TV-PG"" } ] },
            ""keywords"": [ { ""id"": 8, ""name"": ""time travel"" } ],
            ""genres"": [ { ""id"": 10765, ""name"": ""Sci-Fi & Fantasy"" } ] }";

        private static SeerrParentalFilter BuildTagFilter(
            string[] blockedTags,
            string[] allowedTags,
            int? maxScore = null,
            bool tagsEnabled = true,
            string? tmdbKey = null,
            Action<RecordingHttpMessageHandler>? seed = null,
            RecordingHttpMessageHandler? handlerOut = null)
        {
            var handler = handlerOut ?? new RecordingHttpMessageHandler();
            handler.AddResponse("/movie/400", ZombieMovieDetail());
            handler.AddResponse("/movie/500", FamilyMovieDetail());
            handler.AddResponse("/tv/400", SciFiTvDetail());
            seed?.Invoke(handler);

            var provider = new FakePluginConfigProvider(new PluginConfiguration
            {
                SeerrEnabled = true,
                SeerrRespectParentalRatings = true,
                SeerrRespectBlockedTags = tagsEnabled,
                SeerrUrls = "http://seerr:5055",
                SeerrApiKey = "key",
                TMDB_API_KEY = tmdbKey ?? string.Empty,
                DEFAULT_REGION = "US",
            });

            var user = new User("tagkid", "Prov", "PwProv") { MaxParentalRatingScore = maxScore };
            var policy = new UserPolicy
            {
                BlockUnratedItems = Array.Empty<UnratedItem>(),
                BlockedTags = blockedTags,
                AllowedTags = allowedTags,
            };

            return new SeerrParentalFilter(
                new RecordingHttpClientFactory(handler),
                NullLogger<SeerrParentalFilter>.Instance,
                new StubPolicyUserManager(Guid.Parse(CallerGuid), user, policy),
                new FakeLocalization(),
                new SeerrCache(provider),
                provider);
        }

        private static async Task<List<int>> FilterListIds(SeerrParentalFilter filter, params int[] movieIds)
        {
            var rows = string.Join(",", movieIds.Select(id => $@"{{ ""id"": {id}, ""mediaType"": ""movie"" }}"));
            var result = await filter.ApplyAsync(
                $@"{{ ""results"": [ {rows} ] }}", "/api/v1/search?query=x", new SeerrCaller(CallerGuid, false));
            Assert.False(result.Block, "list endpoints are never wholesale-blocked");
            var obj = (System.Text.Json.Nodes.JsonObject)System.Text.Json.Nodes.JsonNode.Parse(result.Body)!;
            return ((System.Text.Json.Nodes.JsonArray)obj["results"]!).Select(n => n!["id"]!.GetValue<int>()).ToList();
        }

        [Fact]
        public async Task BlockedKeyword_DropsListRow_KeepsOthers()
        {
            var filter = BuildTagFilter(blockedTags: new[] { "zombie" }, allowedTags: Array.Empty<string>());
            Assert.Equal(new List<int> { 500 }, await FilterListIds(filter, 400, 500));
        }

        [Fact]
        public async Task BlockedGenre_DropsListRow()
        {
            // "horror" is a GENRE on the fixture, not a keyword — the documented
            // intent extension beyond native tags-only matching.
            var filter = BuildTagFilter(blockedTags: new[] { "horror" }, allowedTags: Array.Empty<string>());
            Assert.Equal(new List<int> { 500 }, await FilterListIds(filter, 400, 500));
        }

        [Fact]
        public async Task NormalizationParity_PunctuationAndCaseFold()
        {
            // Blocking "SCI-FI & FANTASY" must match genre "Sci-Fi & Fantasy"
            // through GetCleanValue on both sides.
            var filter = BuildTagFilter(blockedTags: new[] { "SCI-FI & FANTASY" }, allowedTags: Array.Empty<string>());
            var result = await filter.ApplyAsync(
                @"{ ""results"": [ { ""id"": 400, ""mediaType"": ""tv"" } ] }",
                "/api/v1/search?query=x",
                new SeerrCaller(CallerGuid, false));
            var obj = (System.Text.Json.Nodes.JsonObject)System.Text.Json.Nodes.JsonNode.Parse(result.Body)!;
            Assert.Empty((System.Text.Json.Nodes.JsonArray)obj["results"]!);
        }

        [Fact]
        public async Task AllowList_KeepsOnlyKeywordMatchingTitles()
        {
            var filter = BuildTagFilter(blockedTags: Array.Empty<string>(), allowedTags: new[] { "friendship" });
            Assert.Equal(new List<int> { 500 }, await FilterListIds(filter, 400, 500));
        }

        [Fact]
        public async Task AllowList_IsNotSatisfiedByGenres_NativeParity()
        {
            // 500's GENRES include Family but its keywords do not — natively
            // this title would be hidden under allow-list "family" (genres
            // never become item Tags), so it must be hidden here too.
            var filter = BuildTagFilter(blockedTags: Array.Empty<string>(), allowedTags: new[] { "family" });
            Assert.Equal(new List<int>(), await FilterListIds(filter, 400, 500));
        }

        [Fact]
        public async Task BlockedWins_OverAllowedMatch()
        {
            // "zombie" is a keyword on 400 — blocked and allowed both match;
            // blocked must win, exactly like core.
            var filter = BuildTagFilter(blockedTags: new[] { "zombie" }, allowedTags: new[] { "zombie" });
            Assert.Equal(new List<int>(), await FilterListIds(filter, 400));
        }

        [Fact]
        public async Task SeasonAndSubDetailSurfaces_AreTagGated()
        {
            var filter = BuildTagFilter(blockedTags: new[] { "time travel" }, allowedTags: Array.Empty<string>());
            var caller = new SeerrCaller(CallerGuid, false);

            // Season routes gate on the parent tv title's signature.
            var season = await filter.ApplyAsync(@"{ ""episodes"": [] }", "/api/v1/tv/400/season/1", caller);
            Assert.True(season.Block, "season of a tag-blocked series must be blocked");

            // Sub-detail routes gate on the parent title too.
            var sub = await filter.ApplyAsync(@"{ }", "/api/v1/tv/400/ratings", caller);
            Assert.True(sub.Block, "sub-detail of a tag-blocked series must be blocked");
        }

        [Fact]
        public async Task DetailBody_BlocksOnTagHit_EvenWhenRatingPasses()
        {
            // PG-13 passes a 13 limit, but the zombie keyword must 403 the detail.
            var filter = BuildTagFilter(blockedTags: new[] { "zombie" }, allowedTags: Array.Empty<string>(), maxScore: 13);
            var result = await filter.ApplyAsync(
                ZombieMovieDetail(), "/api/v1/movie/400", new SeerrCaller(CallerGuid, false));
            Assert.True(result.Block);
        }

        [Fact]
        public async Task KillSwitchOff_TagsIgnored()
        {
            var filter = BuildTagFilter(blockedTags: new[] { "zombie" }, allowedTags: Array.Empty<string>(), tagsEnabled: false);
            // No rating limit either -> gate fully inactive -> passthrough.
            Assert.Equal(new List<int> { 400, 500 }, await FilterListIds(filter, 400, 500));
        }

        [Fact]
        public async Task RequestPostGate_BlocksBlockedTagTitle()
        {
            var filter = BuildTagFilter(blockedTags: new[] { "zombie" }, allowedTags: Array.Empty<string>());
            Assert.True(await filter.IsBlockedAsync("movie", 400, new SeerrCaller(CallerGuid, false)));
            Assert.False(await filter.IsBlockedAsync("movie", 500, new SeerrCaller(CallerGuid, false)));
        }

        [Fact]
        public async Task ExpiredTags_AreNotResurrectedByLightRefresh()
        {
            // Codex-review scenario: an EXPIRED cache entry still carries old
            // tags ("family"); a rating-only user refreshes the title through
            // the light TMDB cert endpoint. The refresh must NOT re-stamp the
            // stale tags as fresh — a tag-restricted user checking afterwards
            // must re-resolve through the full detail (which now says
            // "horror") and block.
            var handler = new RecordingHttpMessageHandler();
            handler.AddResponse(
                "/movie/400/release_dates",
                @"{ ""results"": [ { ""iso_3166_1"": ""US"", ""release_dates"": [ { ""type"": 3, ""certification"": ""PG-13"" } ] } ] }");
            handler.AddResponse("/movie/400", ZombieMovieDetail()); // genres now include Horror

            var provider = new FakePluginConfigProvider(new PluginConfiguration
            {
                SeerrEnabled = true,
                SeerrRespectParentalRatings = true,
                SeerrRespectBlockedTags = true,
                SeerrUrls = "http://seerr:5055",
                SeerrApiKey = "key",
                TMDB_API_KEY = "tmdb-key",
                DEFAULT_REGION = "US",
            });
            var cache = new SeerrCache(provider);

            var ratingUserGuid = Guid.Parse("44444444-4444-4444-4444-444444444444");
            var registry = new Dictionary<Guid, (User, UserPolicy)>
            {
                [ratingUserGuid] = (new User("ratekid", "Prov", "PwProv") { MaxParentalRatingScore = 13 },
                    new UserPolicy { BlockUnratedItems = Array.Empty<UnratedItem>() }),
                [Guid.Parse(CallerGuid)] = (new User("tagkid", "Prov", "PwProv"), new UserPolicy
                {
                    BlockUnratedItems = Array.Empty<UnratedItem>(),
                    BlockedTags = new[] { "horror" },
                }),
            };

            var filter = new SeerrParentalFilter(
                new RecordingHttpClientFactory(handler),
                NullLogger<SeerrParentalFilter>.Instance,
                new StubPolicyUserManager(registry),
                new FakeLocalization(),
                cache,
                provider);

            // Establish this configuration generation's opaque cache key, then
            // replace its value with the expired/outdated tag set under test.
            Assert.True(await filter.IsBlockedAsync("movie", 400, new SeerrCaller(CallerGuid, false)));
            var generationCacheKey = Assert.Single(cache.CertScoreCache.Keys);
            cache.CertScoreCache[generationCacheKey] =
                (13, 0, new[] { "family" }, Array.Empty<string>(), DateTime.UtcNow.AddDays(-2));

            // Rating-only refresh through the light endpoint (entry was expired).
            Assert.False(await filter.IsBlockedAsync("movie", 400, new SeerrCaller(ratingUserGuid.ToString(), false)));
            // The refreshed entry must NOT carry the resurrected stale tags…
            Assert.Null(cache.CertScoreCache[generationCacheKey].Keywords);
            // …so the tag-restricted user re-resolves the full detail and blocks.
            Assert.True(await filter.IsBlockedAsync("movie", 400, new SeerrCaller(CallerGuid, false)));
        }

        [Fact]
        public async Task CertOnlyCacheEntry_DoesNotSatisfyTagPass()
        {
            // One shared cache: a rating-only user resolves movie 400 through the
            // LIGHT TMDB cert endpoint (Tags == null cached); a tag-rule user then
            // needs the same title and must NOT reuse the tag-less entry.
            var handler = new RecordingHttpMessageHandler();
            handler.AddResponse(
                "/movie/400/release_dates",
                @"{ ""results"": [ { ""iso_3166_1"": ""US"", ""release_dates"": [ { ""type"": 3, ""certification"": ""PG-13"" } ] } ] }");

            var provider = new FakePluginConfigProvider(new PluginConfiguration
            {
                SeerrEnabled = true,
                SeerrRespectParentalRatings = true,
                SeerrRespectBlockedTags = true,
                SeerrUrls = "http://seerr:5055",
                SeerrApiKey = "key",
                TMDB_API_KEY = "tmdb-key",
                DEFAULT_REGION = "US",
            });

            var ratingUserGuid = Guid.Parse("33333333-3333-3333-3333-333333333333");
            var ratingUser = new User("ratekid", "Prov", "PwProv") { MaxParentalRatingScore = 13 };
            var tagUser = new User("tagkid", "Prov", "PwProv");
            var registry = new Dictionary<Guid, (User, UserPolicy)>
            {
                [ratingUserGuid] = (ratingUser, new UserPolicy { BlockUnratedItems = Array.Empty<UnratedItem>() }),
                [Guid.Parse(CallerGuid)] = (tagUser, new UserPolicy
                {
                    BlockUnratedItems = Array.Empty<UnratedItem>(),
                    BlockedTags = new[] { "werewolf" }, // deliberately ABSENT from movie 400
                }),
            };

            handler.AddResponse("/movie/400", ZombieMovieDetail());
            var certCache = new SeerrCache(provider);
            var filter = new SeerrParentalFilter(
                new RecordingHttpClientFactory(handler),
                NullLogger<SeerrParentalFilter>.Instance,
                new StubPolicyUserManager(registry),
                new FakeLocalization(),
                certCache,
                provider);

            // Rating-only pass caches the light (tag-less) result: PG-13 <= 13 -> allowed.
            Assert.False(await filter.IsBlockedAsync("movie", 400, new SeerrCaller(ratingUserGuid.ToString(), false)));
            var generationCacheKey = Assert.Single(certCache.CertScoreCache.Keys);
            Assert.Null(certCache.CertScoreCache[generationCacheKey].Keywords);

            // DISCRIMINATING assertion (review finding): the tag user blocks a
            // tag ABSENT from movie 400 ("werewolf"). Correct behavior:
            // re-resolve through the tag-bearing Seerr detail -> no werewolf
            // keyword/genre -> ALLOWED. A regression that reuses the tag-less
            // cache entry would fail closed -> blocked -> this asserts False,
            // so deleting the Tags-null cache-miss guard fails this test.
            var blocked = await filter.IsBlockedAsync("movie", 400, new SeerrCaller(CallerGuid, false));
            // The re-resolution really happened via the Seerr full detail…
            Assert.Contains(handler.Requests, r => r.RequestUri!.AbsolutePath.EndsWith("/api/v1/movie/400", StringComparison.Ordinal));
            // The upgraded cache entry now carries the tag sets.
            Assert.NotNull(certCache.CertScoreCache[generationCacheKey].Keywords);
            // …and no werewolf keyword/genre exists on the title -> allowed.
            Assert.False(blocked);
        }
    }
}
