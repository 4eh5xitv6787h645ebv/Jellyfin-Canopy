using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Data.Events;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Tests.TestDoubles;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using MediaBrowser.Model.Users;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinEnhanced.Tests.Services.Jellyseerr
{
    /// <summary>
    /// Exercises the orchestration of the server-side Seerr parental filter:
    /// per-endpoint container shapes (results/parts/cast+crew, id vs tmdbId),
    /// adult drop, fail-closed on unverifiable items, block-unrated, and the
    /// feature-off / admin / no-limit fast paths. Rating logic itself is pinned
    /// separately in ParentalRatingDecisionTests.
    /// </summary>
    public class SeerrParentalFilterTests
    {
        private const string CallerGuid = "11111111-1111-1111-1111-111111111111";

        // Region-agnostic detail bodies for the fixture titles.
        private static string MovieDetail(string cert) =>
            $@"{{ ""releases"": {{ ""results"": [ {{ ""iso_3166_1"": ""US"", ""release_dates"": [ {{ ""type"": 3, ""certification"": ""{cert}"" }} ] }} ] }} }}";

        private static string MovieNoCert() =>
            @"{ ""releases"": { ""results"": [ { ""iso_3166_1"": ""US"", ""release_dates"": [ { ""type"": 3, ""certification"": """" } ] } ] } }";

        private static string TvDetail(string cert) =>
            $@"{{ ""contentRatings"": {{ ""results"": [ {{ ""iso_3166_1"": ""US"", ""rating"": ""{cert}"" }} ] }} }}";

        private static SeerrParentalFilter BuildFilter(
            int? maxScore,
            int? maxSub,
            UnratedItem[] block,
            bool featureEnabled,
            Action<RecordingHttpMessageHandler>? seed,
            bool seerrConfigured = true)
        {
            var handler = new RecordingHttpMessageHandler();
            // Fixture titles used across the cases.
            handler.AddResponse("/movie/100", MovieDetail("PG-13"));
            handler.AddResponse("/movie/200", MovieDetail("R"));
            handler.AddResponse("/tv/100", TvDetail("TV-PG"));
            handler.AddResponse("/tv/200", TvDetail("TV-MA"));
            handler.AddResponse("/movie/300", MovieNoCert());
            seed?.Invoke(handler);

            var provider = new FakePluginConfigProvider(new PluginConfiguration
            {
                JellyseerrEnabled = true,
                JellyseerrRespectParentalRatings = featureEnabled,
                JellyseerrUrls = seerrConfigured ? "http://seerr:5055" : string.Empty,
                JellyseerrApiKey = seerrConfigured ? "key" : string.Empty,
                DEFAULT_REGION = "US",
            });

            var user = new User("kid", "Prov", "PwProv")
            {
                MaxParentalRatingScore = maxScore,
                MaxParentalRatingSubScore = maxSub,
            };
            var policy = new UserPolicy { BlockUnratedItems = block };

            return new SeerrParentalFilter(
                new RecordingHttpClientFactory(handler),
                NullLogger<SeerrParentalFilter>.Instance,
                new StubUserManager(user, policy),
                new FakeLocalization(),
                new SeerrCache(provider),
                provider);
        }

        private static Task<SeerrParentalResult> ApplyAsync(
            string body,
            string apiPath,
            int? maxScore,
            int? maxSub,
            UnratedItem[] block,
            bool isAdmin = false,
            bool featureEnabled = true,
            Action<RecordingHttpMessageHandler>? seed = null)
        {
            var filter = BuildFilter(maxScore, maxSub, block, featureEnabled, seed);
            return filter.ApplyAsync(body, apiPath, new JellyseerrCaller(CallerGuid, isAdmin));
        }

        // Convenience for list cases: run ApplyAsync, assert not wholesale-blocked, return the parsed body.
        private static async Task<System.Text.Json.Nodes.JsonObject> RunAsync(
            string body,
            string apiPath,
            int? maxScore,
            int? maxSub,
            UnratedItem[] block,
            bool isAdmin = false,
            bool featureEnabled = true,
            Action<RecordingHttpMessageHandler>? seed = null)
        {
            var result = await ApplyAsync(body, apiPath, maxScore, maxSub, block, isAdmin, featureEnabled, seed);
            Assert.False(result.Block, "list endpoints are never wholesale-blocked");
            return (System.Text.Json.Nodes.JsonObject)System.Text.Json.Nodes.JsonNode.Parse(result.Body)!;
        }

        private static List<int> Ids(System.Text.Json.Nodes.JsonObject obj, string container, string field = "id")
            => ((System.Text.Json.Nodes.JsonArray)obj[container]!).Select(n => n![field]!.GetValue<int>()).ToList();

        [Fact]
        public async Task Search_DropsOverLimitMovie_KeepsAllowedMovieAndPerson()
        {
            const string body = @"{ ""results"": [
                { ""id"": 100, ""mediaType"": ""movie"" },
                { ""id"": 200, ""mediaType"": ""movie"" },
                { ""id"": 5, ""mediaType"": ""person"" } ] }";

            var result = await RunAsync(body, "/api/v1/search?query=x", maxScore: 13, maxSub: 0, block: Array.Empty<UnratedItem>());

            Assert.Equal(new[] { 100, 5 }, Ids(result, "results"));
        }

        [Fact]
        public async Task AdminCaller_IsNeverFiltered()
        {
            const string body = @"{ ""results"": [ { ""id"": 200, ""mediaType"": ""movie"" } ] }";
            var result = await RunAsync(body, "/api/v1/search?query=x", maxScore: 13, maxSub: 0, block: Array.Empty<UnratedItem>(), isAdmin: true);
            Assert.Equal(new[] { 200 }, Ids(result, "results"));
        }

        [Fact]
        public async Task FeatureDisabled_PassesThrough()
        {
            const string body = @"{ ""results"": [ { ""id"": 200, ""mediaType"": ""movie"" } ] }";
            var result = await RunAsync(body, "/api/v1/search?query=x", maxScore: 13, maxSub: 0, block: Array.Empty<UnratedItem>(), featureEnabled: false);
            Assert.Equal(new[] { 200 }, Ids(result, "results"));
        }

        [Fact]
        public async Task NoLimitAndNoBlockUnrated_PassesThrough()
        {
            const string body = @"{ ""results"": [ { ""id"": 200, ""mediaType"": ""movie"" } ] }";
            var result = await RunAsync(body, "/api/v1/search?query=x", maxScore: null, maxSub: null, block: Array.Empty<UnratedItem>());
            Assert.Equal(new[] { 200 }, Ids(result, "results"));
        }

        [Fact]
        public async Task Watchlist_UsesTmdbIdField()
        {
            const string body = @"{ ""results"": [
                { ""tmdbId"": 100, ""mediaType"": ""movie"" },
                { ""tmdbId"": 200, ""mediaType"": ""tv"" } ] }";

            var result = await RunAsync(body, "/api/v1/discover/watchlist?page=1", maxScore: 13, maxSub: 0, block: Array.Empty<UnratedItem>());

            // movie 100 = PG-13 (allowed); tv 200 = TV-MA (17,1) over limit (dropped).
            Assert.Equal(new[] { 100 }, Ids(result, "results", "tmdbId"));
        }

        [Fact]
        public async Task Collection_FiltersPartsAsMovies()
        {
            const string body = @"{ ""parts"": [ { ""id"": 100 }, { ""id"": 200 } ] }";
            var result = await RunAsync(body, "/api/v1/collection/9", maxScore: 13, maxSub: 0, block: Array.Empty<UnratedItem>());
            Assert.Equal(new[] { 100 }, Ids(result, "parts"));
        }

        [Fact]
        public async Task CombinedCredits_FiltersCastAndCrew()
        {
            const string body = @"{
                ""cast"": [ { ""id"": 100, ""mediaType"": ""movie"" }, { ""id"": 200, ""mediaType"": ""movie"" } ],
                ""crew"": [ { ""id"": 200, ""mediaType"": ""movie"" } ] }";

            var result = await RunAsync(body, "/api/v1/person/5/combined_credits", maxScore: 13, maxSub: 0, block: Array.Empty<UnratedItem>());

            Assert.Equal(new[] { 100 }, Ids(result, "cast"));
            Assert.Empty(Ids(result, "crew"));
        }

        [Fact]
        public async Task UnverifiableItem_FailsClosed()
        {
            // No detail response for id 400 -> fetch 404 -> cannot verify -> dropped.
            const string body = @"{ ""results"": [ { ""id"": 400, ""mediaType"": ""movie"" } ] }";
            var result = await RunAsync(body, "/api/v1/search?query=x", maxScore: 13, maxSub: 0, block: Array.Empty<UnratedItem>());
            Assert.Empty(Ids(result, "results"));
        }

        [Fact]
        public async Task AdultItem_IsDropped_EvenWhenRatingWouldAllow()
        {
            // 100 is PG-13 (would pass a 13 limit) but adult:true forces a drop.
            const string body = @"{ ""results"": [ { ""id"": 100, ""mediaType"": ""movie"", ""adult"": true } ] }";
            var result = await RunAsync(body, "/api/v1/search?query=x", maxScore: 13, maxSub: 0, block: Array.Empty<UnratedItem>());
            Assert.Empty(Ids(result, "results"));
        }

        [Fact]
        public async Task Uncertified_BlockedWhenBlockUnratedSet()
        {
            const string body = @"{ ""results"": [ { ""id"": 300, ""mediaType"": ""movie"" } ] }";
            var result = await RunAsync(body, "/api/v1/search?query=x", maxScore: null, maxSub: null, block: new[] { UnratedItem.Movie });
            Assert.Empty(Ids(result, "results"));
        }

        [Fact]
        public async Task Uncertified_AllowedWhenNotBlocked()
        {
            const string body = @"{ ""results"": [ { ""id"": 300, ""mediaType"": ""movie"" } ] }";
            var result = await RunAsync(body, "/api/v1/search?query=x", maxScore: 17, maxSub: 0, block: Array.Empty<UnratedItem>());
            Assert.Equal(new[] { 300 }, Ids(result, "results"));
        }

        [Fact]
        public async Task DetailEndpoint_BlocksOverLimitTitle()
        {
            // Direct fetch of a blocked title's detail body -> 403 (the body is the
            // cert source, so the rating is read from it in place).
            var blocked = await ApplyAsync(MovieDetail("R"), "/api/v1/movie/200", maxScore: 13, maxSub: 0, block: Array.Empty<UnratedItem>());
            Assert.True(blocked.Block);

            var allowed = await ApplyAsync(MovieDetail("PG-13"), "/api/v1/movie/100", maxScore: 13, maxSub: 0, block: Array.Empty<UnratedItem>());
            Assert.False(allowed.Block);
        }

        [Fact]
        public async Task DetailEndpoint_AdminNotBlocked()
        {
            var result = await ApplyAsync(MovieDetail("R"), "/api/v1/movie/200", maxScore: 13, maxSub: 0, block: Array.Empty<UnratedItem>(), isAdmin: true);
            Assert.False(result.Block);
        }

        [Fact]
        public async Task SeasonEndpoint_BlockedByParentShowRating()
        {
            // Season body carries no rating; gate by the parent show's certification (tv/200 = TV-MA).
            var seasonBody = @"{ ""episodes"": [ { ""id"": 1 } ] }";
            var blocked = await ApplyAsync(seasonBody, "/api/v1/tv/200/season/1", maxScore: 13, maxSub: 0, block: Array.Empty<UnratedItem>());
            Assert.True(blocked.Block);

            var allowed = await ApplyAsync(seasonBody, "/api/v1/tv/100/season/1", maxScore: 13, maxSub: 0, block: Array.Empty<UnratedItem>());
            Assert.False(allowed.Block);
        }

        [Fact]
        public async Task RatingsEndpoint_IsNotGated()
        {
            // /ratingscombined is not a detail body and must pass through untouched.
            const string body = @"{ ""rt"": 90 }";
            var result = await ApplyAsync(body, "/api/v1/movie/200/ratingscombined", maxScore: 13, maxSub: 0, block: Array.Empty<UnratedItem>());
            Assert.False(result.Block);
            Assert.Equal(body, result.Body);
        }

        [Fact]
        public async Task RequestList_FiltersRowsByNestedMedia()
        {
            // Requests carry the identifying fields under a nested `media` object.
            const string body = @"{ ""results"": [
                { ""id"": 1, ""media"": { ""tmdbId"": 100, ""mediaType"": ""movie"" } },
                { ""id"": 2, ""media"": { ""tmdbId"": 200, ""mediaType"": ""movie"" } },
                { ""id"": 3 } ] }";

            var result = await RunAsync(body, "/api/v1/request?take=100", maxScore: 13, maxSub: 0, block: Array.Empty<UnratedItem>());

            var rowIds = ((System.Text.Json.Nodes.JsonArray)result["results"]!)
                .Select(n => n!["id"]!.GetValue<int>()).ToList();
            // Row 2 (R-rated media) removed; row 1 (PG-13) and row 3 (no media) kept.
            Assert.Equal(new[] { 1, 3 }, rowIds);
        }

        [Fact]
        public async Task IsBlockedAsync_GatesRequestsByRating()
        {
            var filter = BuildFilter(maxScore: 13, maxSub: 0, block: Array.Empty<UnratedItem>(), featureEnabled: true, seed: null);
            var restricted = new JellyseerrCaller(CallerGuid, false);

            Assert.True(await filter.IsBlockedAsync("movie", 200, restricted));   // R -> blocked
            Assert.False(await filter.IsBlockedAsync("movie", 100, restricted));  // PG-13 -> allowed
            Assert.True(await filter.IsBlockedAsync("movie", 999, restricted));   // unverifiable -> fail closed
            Assert.True(await filter.IsBlockedAsync("movie", 0, restricted));     // unparseable id -> fail closed
        }

        [Fact]
        public async Task Gate_InactiveWhenSeerrNotConfigured()
        {
            // Without a Seerr URL/key the gate can't verify certs, so it stays inactive
            // rather than fail-closed-blocking everything (would break the TMDB passthrough).
            var filter = BuildFilter(maxScore: 13, maxSub: 0, block: Array.Empty<UnratedItem>(), featureEnabled: true, seed: null, seerrConfigured: false);
            var restricted = new JellyseerrCaller(CallerGuid, false);

            Assert.False(await filter.IsBlockedAsync("movie", 200, restricted));
            Assert.False(await filter.IsBlockedAsync("movie", 0, restricted));

            const string body = @"{ ""results"": [ { ""id"": 200, ""mediaType"": ""movie"" } ] }";
            var result = await filter.ApplyAsync(body, "/api/v1/search?query=x", restricted);
            Assert.False(result.Block);
            Assert.Equal(body, result.Body);
        }

        [Fact]
        public async Task Search_FiltersKnownForOnPersonResults()
        {
            // A person result is kept, but its nested knownFor films are filtered so a
            // restricted user can't recover R-rated titles from the response body.
            const string body = @"{ ""results"": [
                { ""id"": 5, ""mediaType"": ""person"", ""knownFor"": [
                    { ""id"": 100, ""mediaType"": ""movie"" },
                    { ""id"": 200, ""mediaType"": ""movie"" } ] } ] }";

            var result = await RunAsync(body, "/api/v1/search?query=actor", maxScore: 13, maxSub: 0, block: Array.Empty<UnratedItem>());

            var person = (System.Text.Json.Nodes.JsonObject)((System.Text.Json.Nodes.JsonArray)result["results"]!)[0]!;
            var knownFor = ((System.Text.Json.Nodes.JsonArray)person["knownFor"]!)
                .Select(n => n!["id"]!.GetValue<int>()).ToList();
            Assert.Equal(new[] { 100 }, knownFor); // R-rated 200 stripped from knownFor
        }

        [Fact]
        public async Task NonStringMediaType_DoesNotFailOpen()
        {
            // A malformed (numeric) mediaType must not throw and dump the whole
            // unfiltered list; the well-formed R-rated item is still removed.
            const string body = @"{ ""results"": [
                { ""id"": 5, ""mediaType"": 999 },
                { ""id"": 200, ""mediaType"": ""movie"" } ] }";

            var result = await RunAsync(body, "/api/v1/search?query=x", maxScore: 13, maxSub: 0, block: Array.Empty<UnratedItem>());

            // Unclassifiable item kept (like a person); R-rated movie 200 dropped.
            Assert.Equal(new[] { 5 }, Ids(result, "results"));
        }

        [Theory]
        [InlineData("/api/v1/discover/tv?page=1", "tv")]
        [InlineData("/api/v1/movie/500/recommendations?page=1", "movie")]
        [InlineData("/api/v1/tv/500/similar?page=1", "tv")]
        public async Task DiscoverAndRelated_UseMediaTypeHint(string apiPath, string mediaType)
        {
            // Items carry no per-item mediaType; the plan's hint drives classification.
            const string body = @"{ ""results"": [ { ""id"": 100 }, { ""id"": 200 } ] }";

            var result = await RunAsync(body, apiPath, maxScore: 13, maxSub: 0, block: Array.Empty<UnratedItem>());

            // 100 is PG-13/TV-PG (allowed at 13); 200 is R/TV-MA (removed).
            Assert.Equal(new[] { 100 }, Ids(result, "results"));
            Assert.Contains(mediaType, new[] { "movie", "tv" });
        }

        [Fact]
        public async Task IsBlockedAsync_AdminAndFeatureOff_NeverBlock()
        {
            var admin = new JellyseerrCaller(CallerGuid, true);
            var filterOn = BuildFilter(13, 0, Array.Empty<UnratedItem>(), featureEnabled: true, seed: null);
            Assert.False(await filterOn.IsBlockedAsync("movie", 200, admin));

            var filterOff = BuildFilter(13, 0, Array.Empty<UnratedItem>(), featureEnabled: false, seed: null);
            Assert.False(await filterOff.IsBlockedAsync("movie", 200, new JellyseerrCaller(CallerGuid, false)));
        }

        // ── Minimal fakes ────────────────────────────────────────────────────

        private sealed class FakeLocalization : ILocalizationManager
        {
            private static readonly Dictionary<string, ParentalRatingScore> Scores = new(StringComparer.OrdinalIgnoreCase)
            {
                ["G"] = new ParentalRatingScore(0, 0),
                ["PG"] = new ParentalRatingScore(10, 0),
                ["TV-PG"] = new ParentalRatingScore(10, 0),
                ["PG-13"] = new ParentalRatingScore(13, 0),
                ["TV-14"] = new ParentalRatingScore(14, 0),
                ["R"] = new ParentalRatingScore(17, 0),
                ["TV-MA"] = new ParentalRatingScore(17, 1),
                ["NC-17"] = new ParentalRatingScore(17, 1),
            };

            public ParentalRatingScore? GetRatingScore(string rating, string? countryCode = null)
                => Scores.TryGetValue(rating, out var score) ? score : null;

            public IEnumerable<CultureDto> GetCultures() => throw new NotImplementedException();

            public IReadOnlyList<CountryInfo> GetCountries() => throw new NotImplementedException();

            public IReadOnlyList<ParentalRating> GetParentalRatings() => throw new NotImplementedException();

            public string GetLocalizedString(string phrase, string culture) => throw new NotImplementedException();

            public string GetLocalizedString(string phrase) => throw new NotImplementedException();

            public string GetServerLocalizedString(string phrase) => throw new NotImplementedException();

            public IEnumerable<LocalizationOption> GetLocalizationOptions() => throw new NotImplementedException();

            public CultureDto? FindLanguageInfo(string language) => throw new NotImplementedException();

            public bool TryGetISO6392TFromB(string isoB, [System.Diagnostics.CodeAnalysis.NotNullWhen(true)] out string? isoT) => throw new NotImplementedException();
        }

        private sealed class StubUserManager : IUserManager
        {
            private readonly User _user;
            private readonly UserPolicy _policy;

            public StubUserManager(User user, UserPolicy policy)
            {
                _user = user;
                _policy = policy;
            }

            public event EventHandler<GenericEventArgs<User>> OnUserUpdated { add { } remove { } }

            public User? GetUserById(Guid id) => _user;

            public UserDto GetUserDto(User user, string? remoteEndPoint = null) => new() { Policy = _policy };

            public IEnumerable<User> GetUsers() => throw new NotImplementedException();

            public IEnumerable<Guid> GetUsersIds() => throw new NotImplementedException();

            public Task InitializeAsync() => throw new NotImplementedException();

            public User? GetFirstUser() => throw new NotImplementedException();

            public User? GetUserByName(string name) => throw new NotImplementedException();

            public Task RenameUser(Guid userId, string oldName, string newName) => throw new NotImplementedException();

            public Task UpdateUserAsync(User user) => throw new NotImplementedException();

            public Task<User> CreateUserAsync(string name) => throw new NotImplementedException();

            public Task DeleteUserAsync(Guid userId) => throw new NotImplementedException();

            public Task ResetPassword(Guid userId) => throw new NotImplementedException();

            public Task ChangePassword(Guid userId, string newPassword) => throw new NotImplementedException();

            public Task<User?> AuthenticateUser(string username, string password, string remoteEndPoint, bool isUserSession) => throw new NotImplementedException();

            public Task<ForgotPasswordResult> StartForgotPasswordProcess(string enteredUsername, bool isInNetwork) => throw new NotImplementedException();

            public Task<PinRedeemResult> RedeemPasswordResetPin(string pin) => throw new NotImplementedException();

            public NameIdPair[] GetAuthenticationProviders() => throw new NotImplementedException();

            public NameIdPair[] GetPasswordResetProviders() => throw new NotImplementedException();

            public Task UpdateConfigurationAsync(Guid userId, UserConfiguration config) => throw new NotImplementedException();

            public Task UpdatePolicyAsync(Guid userId, UserPolicy policy) => throw new NotImplementedException();

            public Task ClearProfileImageAsync(User user) => throw new NotImplementedException();
        }
    }
}
