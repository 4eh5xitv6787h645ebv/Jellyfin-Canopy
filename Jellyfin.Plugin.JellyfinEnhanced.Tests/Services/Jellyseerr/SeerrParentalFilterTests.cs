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
                JellyseerrUrls = "http://seerr:5055",
                JellyseerrApiKey = "key",
                DEFAULT_REGION = "US",
            });

            var user = new User("kid", "Prov", "PwProv")
            {
                MaxParentalRatingScore = maxScore,
                MaxParentalRatingSubScore = maxSub,
            };
            var policy = new UserPolicy { BlockUnratedItems = block };

            var filter = new SeerrParentalFilter(
                new RecordingHttpClientFactory(handler),
                NullLogger<SeerrParentalFilter>.Instance,
                new StubUserManager(user, policy),
                new FakeLocalization(),
                new SeerrCache(provider),
                provider);

            var result = await filter.FilterListBodyAsync(body, apiPath, new JellyseerrCaller(CallerGuid, isAdmin));
            return (System.Text.Json.Nodes.JsonObject)System.Text.Json.Nodes.JsonNode.Parse(result)!;
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
        public async Task NonListEndpoint_PassesThrough()
        {
            // A movie detail body is the certification source, never a filtered list.
            const string body = @"{ ""id"": 200, ""mediaType"": ""movie"", ""title"": ""x"" }";
            var result = await RunAsync(body, "/api/v1/movie/200", maxScore: 13, maxSub: 0, block: Array.Empty<UnratedItem>());
            Assert.Equal(200, result["id"]!.GetValue<int>());
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
