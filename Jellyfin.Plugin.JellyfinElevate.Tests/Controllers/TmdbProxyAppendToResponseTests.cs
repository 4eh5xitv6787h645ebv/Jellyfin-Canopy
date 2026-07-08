using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Security.Claims;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinElevate.Services;
using Jellyfin.Data.Enums;
using Jellyfin.Data.Events;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinElevate.Configuration;
using Jellyfin.Plugin.JellyfinElevate.Controllers;
using Jellyfin.Plugin.JellyfinElevate.Model.Jellyseerr;
using Jellyfin.Plugin.JellyfinElevate.Services.Jellyseerr;
using Jellyfin.Plugin.JellyfinElevate.Tests.TestDoubles;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using MediaBrowser.Model.Users;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.Controllers
{
    /// <summary>
    /// Pins SEERR-2: the raw <c>/tmdb/{**apiPath}</c> passthrough forwards the
    /// caller's FULL query to TMDB, so an <c>append_to_response=similar,recommendations</c>
    /// on an otherwise-allowed movie/tv detail would return above-limit title lists that
    /// the raw passthrough cannot body-filter. A rating-limited caller must be denied
    /// (bare 403) when append_to_response is present; the wiring must hand the query to
    /// the gate (not just the path).
    /// </summary>
    public class TmdbProxyAppendToResponseTests
    {
        private const string CallerGuid = "11111111-1111-1111-1111-111111111111";

        // TMDB /movie/{id}/release_dates unwrapped shape (accepted by the extractor):
        // resolves tmdb 100 as PG-13 so the detail itself is within the caller's limit.
        private const string Movie100ReleaseDates =
            @"{ ""results"": [ { ""iso_3166_1"": ""US"", ""release_dates"": [ { ""type"": 3, ""certification"": ""PG-13"" } ] } ] }";

        private static JellyseerrProxyController BuildController(bool ratingLimited, string queryString)
        {
            var handler = new RecordingHttpMessageHandler();
            // Cert lookup for the allowed parent title (so the gate would otherwise pass it).
            handler.AddResponse("/movie/100/release_dates", Movie100ReleaseDates);
            // Bare passthrough answer — reached only if the gate lets the request through.
            handler.AddResponse("/movie/100", @"{ ""id"": 100 }");
            var factory = new RecordingHttpClientFactory(handler);

            var provider = new FakePluginConfigProvider(new PluginConfiguration
            {
                JellyseerrEnabled = true,
                JellyseerrRespectParentalRatings = true,
                JellyseerrUrls = "http://seerr:5055",
                JellyseerrApiKey = "key",
                DEFAULT_REGION = "US",
                TMDB_API_KEY = "tmdbkey", // required, else ProxyTmdbRequest short-circuits 503
            });

            var user = new User("kid", "Prov", "PwProv")
            {
                MaxParentalRatingScore = ratingLimited ? 13 : (int?)null,
                MaxParentalRatingSubScore = 0,
            };
            var userManager = new SingleUserManager(user);
            var seerrCache = new SeerrCache(provider);
            var parentalFilter = new SeerrParentalFilter(
                factory, NullLogger<SeerrParentalFilter>.Instance, userManager, new ScoreLocalization(), seerrCache, provider);

            var spoilerPending = new SpoilerPendingService(
                new UserConfigurationManager(
                    new StubAppPaths(Path.Combine(Path.GetTempPath(), "je-tmdb-" + Guid.NewGuid().ToString("N"))),
                    NullLogger<UserConfigurationManager>.Instance),
                new CountingLibraryManager(),
                userManager,
                NullLogger<SpoilerPendingService>.Instance);

            var controller = new JellyseerrProxyController(
                factory,
                NullLogger<JellyseerrProxyController>.Instance,
                userManager,
                seerrCache,
                provider,
                new UnusedJellyseerrClient(),
                parentalFilter,
                spoilerPending);

            var identity = new ClaimsIdentity(new[] { new Claim("Jellyfin-UserId", CallerGuid) }, "TestAuth");
            var httpContext = new DefaultHttpContext { User = new ClaimsPrincipal(identity) };
            httpContext.Request.QueryString = new QueryString(queryString);
            controller.ControllerContext = new ControllerContext { HttpContext = httpContext };
            return controller;
        }

        [Fact]
        public async Task ProxyTmdb_RatingLimitedCaller_WithAppendToResponse_Returns403()
        {
            var controller = BuildController(ratingLimited: true, queryString: "?append_to_response=similar,recommendations");

            var result = await controller.ProxyTmdbRequest("movie/100");

            var status = Assert.IsType<StatusCodeResult>(result);
            Assert.Equal(403, status.StatusCode);
        }

        [Fact]
        public async Task ProxyTmdb_RatingLimitedCaller_AllowedDetailWithoutAppend_IsNotDenied()
        {
            // The same allowed (PG-13) detail without append_to_response passes the gate,
            // proving the 403 is caused by the append and not a blanket denial.
            var controller = BuildController(ratingLimited: true, queryString: string.Empty);

            var result = await controller.ProxyTmdbRequest("movie/100");

            Assert.IsNotType<StatusCodeResult>(result); // reaches the passthrough (ContentResult)
        }

        // ── Minimal fakes ────────────────────────────────────────────────────

        private sealed class UnusedJellyseerrClient : IJellyseerrClient
        {
            public Task<JellyseerrUser?> GetJellyseerrUser(string jellyfinUserId, bool bypassCache = false, bool allowAutoImport = true) => throw new NotImplementedException();

            public Task<string?> GetJellyseerrUserId(string jellyfinUserId, bool allowAutoImport = true) => throw new NotImplementedException();

            public bool IsImportBlocked(string jellyfinUserId, PluginConfiguration config) => throw new NotImplementedException();

            public Task<bool> GetStatusActiveAsync() => throw new NotImplementedException();

            public Task<Seerr4kCapability> GetSeerr4kCapabilityAsync(string jellyfinUserId) => throw new NotImplementedException();

            public Task<IActionResult> ProxyRequestAsync(string apiPath, HttpMethod method, string? content, JellyseerrCaller caller) => throw new NotImplementedException();

            public Task<List<WatchlistItem>?> GetWatchlistForUser(string jellyseerrUserId) => throw new NotImplementedException();

            public Task<List<WatchlistItem>?> GetRequestsForUser(string jellyseerrUserId) => throw new NotImplementedException();
        }

        private sealed class ScoreLocalization : ILocalizationManager
        {
            private static readonly Dictionary<string, ParentalRatingScore> Scores = new(StringComparer.OrdinalIgnoreCase)
            {
                ["G"] = new ParentalRatingScore(0, 0),
                ["PG"] = new ParentalRatingScore(10, 0),
                ["PG-13"] = new ParentalRatingScore(13, 0),
                ["R"] = new ParentalRatingScore(17, 0),
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

        private sealed class SingleUserManager : IUserManager
        {
            private readonly User _user;

            public SingleUserManager(User user) => _user = user;

            public event EventHandler<GenericEventArgs<User>> OnUserUpdated { add { } remove { } }

            public User? GetUserById(Guid id) => _user;

            public UserDto GetUserDto(User user, string? remoteEndPoint = null) => new() { Policy = new UserPolicy { BlockUnratedItems = Array.Empty<UnratedItem>() } };

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
