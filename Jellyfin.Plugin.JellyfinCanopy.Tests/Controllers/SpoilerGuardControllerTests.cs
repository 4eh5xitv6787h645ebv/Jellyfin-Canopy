using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers
{
    /// <summary>
    /// HTTP-surface coverage for the Spoiler Guard controller + its shared pending
    /// service: the display-name sanitizer, the per-dict entry cap (413) and pending
    /// cap (429) decisions, promoter-gate reconciliation on the full-state save,
    /// promote-vs-pending outcomes with a stubbed library lookup, and the
    /// health-endpoint's non-admin own-events-only visibility.
    /// </summary>
    public class SpoilerGuardControllerTests
    {
        private const string SpoilerFile = "spoilerblur.json";

        private sealed class Harness : IDisposable
        {
            public required string Dir { get; init; }
            public required UserConfigurationManager Mgr { get; init; }
            public required CountingLibraryManager Lib { get; init; }
            public required SpoilerPendingService Pending { get; init; }
            public required SpoilerGuardController Controller { get; init; }
            public required StubUserDataManager UserData { get; init; }
            public required User User { get; init; }

            public void Dispose()
            {
                try { Directory.Delete(Dir, recursive: true); } catch { /* best-effort */ }
            }
        }

        private static Harness Build(PluginConfiguration? cfg = null, bool includeUserInManager = true)
        {
            var dir = Path.Combine(Path.GetTempPath(), "jc-sg-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);

            var mgr = new UserConfigurationManager(new StubAppPaths(dir), NullLogger<UserConfigurationManager>.Instance);
            var lib = new CountingLibraryManager();
            var user = new User("sg", "Prov", "PwProv");
            var userManager = includeUserInManager ? new StubUserManager(user) : new StubUserManager();
            var provider = new FakePluginConfigProvider(cfg);
            var pending = new SpoilerPendingService(mgr, lib, userManager, NullLogger<SpoilerPendingService>.Instance);
            var sessions = new CountingSessionManager();
            var requestIdentity = new RequestIdentityService(
                sessions,
                userManager,
                new SpoilerIdentityService(userManager, NullLogger<SpoilerIdentityService>.Instance),
                NullLogger<RequestIdentityService>.Instance);
            var resolver = new SpoilerUserResolver(mgr, lib, NullLogger<SpoilerUserResolver>.Instance, requestIdentity);
            var userData = new StubUserDataManager();

            var controller = new SpoilerGuardController(
                new RecordingHttpClientFactory(new HttpClientHandler()),
                NullLogger<SpoilerGuardController>.Instance,
                userManager,
                new SeerrCache(provider),
                provider,
                mgr,
                lib,
                pending,
                resolver,
                userData);

            var identity = new ClaimsIdentity(new[] { new Claim("Jellyfin-UserId", user.Id.ToString()) }, "TestAuth");
            controller.ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(identity) },
            };

            return new Harness { Dir = dir, Mgr = mgr, Lib = lib, Pending = pending, Controller = controller, UserData = userData, User = user };
        }

        // ─── Display-name sanitizer ───────────────────────────────────────────────

        [Fact]
        public void Sanitize_NullOrEmpty_ReturnsEmpty()
        {
            Assert.Equal(string.Empty, SpoilerPendingService.SanitizePendingDisplayName(null));
            Assert.Equal(string.Empty, SpoilerPendingService.SanitizePendingDisplayName(string.Empty));
        }

        [Fact]
        public void Sanitize_StripsControlAndFormatChars_IncludingRtlOverride()
        {
            // U+0000 (Control) is removed; U+202E RIGHT-TO-LEFT OVERRIDE (Format) is removed.
            Assert.Equal("ab", SpoilerPendingService.SanitizePendingDisplayName("a\u0000b"));
            Assert.Equal("evil.exe", SpoilerPendingService.SanitizePendingDisplayName("\u202Eevil.exe"));
        }

        [Fact]
        public void Sanitize_NewlinesAndTabsBecomeSpaces()
        {
            Assert.Equal("a b c", SpoilerPendingService.SanitizePendingDisplayName("a\nb\tc"));
        }

        [Fact]
        public void Sanitize_CapsAt200_SurrogateSafe()
        {
            // 250 plain chars → capped to 200.
            Assert.Equal(200, SpoilerPendingService.SanitizePendingDisplayName(new string('a', 250)).Length);

            // 199 plain chars + a surrogate pair straddling the 200th slot: the cap
            // must back off to 199 rather than emit a lone high surrogate.
            var raw = new string('a', 199) + "😀"; // 199 + emoji (2 UTF-16 units)
            var result = SpoilerPendingService.SanitizePendingDisplayName(raw);
            Assert.Equal(new string('a', 199), result);
        }

        // ─── Full-state save: per-dict cap (413) + gate reconciliation ────────────

        [Fact]
        public void SaveUserSpoilerBlur_OverCap_Returns413()
        {
            using var h = Build();
            var payload = new UserSpoilerBlur();
            for (var i = 0; i < 1001; i++)
            {
                var k = Guid.NewGuid().ToString("N");
                payload.Series[k] = new SpoilerBlurSeriesEntry { SeriesId = k };
            }

            var result = h.Controller.SaveUserSpoilerBlur(h.User.Id.ToString(), payload);

            var obj = Assert.IsType<ObjectResult>(result);
            Assert.Equal(413, obj.StatusCode);
        }

        [Fact]
        public void SaveUserSpoilerBlur_ReconcilesPromoterGate_RegisterThenUnregister()
        {
            using var h = Build();
            var userId = h.User.Id;
            var keyA = "tv:" + Guid.NewGuid().ToString("N").Substring(0, 8) + "01";
            var keyB = "movie:" + Guid.NewGuid().ToString("N").Substring(0, 8) + "02";

            // First save registers both pending keys in the promoter's static gate.
            var first = new UserSpoilerBlur();
            first.PendingTmdb[keyA] = new SpoilerBlurPendingEntry { MediaType = "tv", TmdbId = "1" };
            first.PendingTmdb[keyB] = new SpoilerBlurPendingEntry { MediaType = "movie", TmdbId = "2" };
            var r1 = h.Controller.SaveUserSpoilerBlur(userId.ToString(), first);
            Assert.IsType<OkObjectResult>(r1);
            Assert.True(SpoilerSeerrPendingPromoter.IsKeyRegisteredForTest(keyA));
            Assert.True(SpoilerSeerrPendingPromoter.IsKeyRegisteredForTest(keyB));

            // Second save drops keyB → it is unregistered; keyA survives.
            var second = new UserSpoilerBlur();
            second.PendingTmdb[keyA] = new SpoilerBlurPendingEntry { MediaType = "tv", TmdbId = "1" };
            var r2 = h.Controller.SaveUserSpoilerBlur(userId.ToString(), second);
            Assert.IsType<OkObjectResult>(r2);
            Assert.True(SpoilerSeerrPendingPromoter.IsKeyRegisteredForTest(keyA));
            Assert.False(SpoilerSeerrPendingPromoter.IsKeyRegisteredForTest(keyB));

            // Cleanup so the static gate doesn't leak into other tests.
            SpoilerSeerrPendingPromoter.UnregisterPending(keyA, userId);
        }

        // ─── Pending cap (429) via the HTTP endpoint ──────────────────────────────

        [Fact]
        public void EnableSpoilerBlurPending_AtCap_Returns429()
        {
            using var h = Build(new PluginConfiguration { SpoilerBlurEnabled = true });
            h.Lib.GetItemListHook = _ => Array.Empty<BaseItem>(); // nothing resolves in library

            // Pre-seed the store at the cap so a NEW tmdb is rejected.
            var state = new UserSpoilerBlur();
            for (var i = 0; i < SpoilerPendingService.MaxPendingTmdbPerUser; i++)
            {
                var key = $"tv:{100000 + i}";
                state.PendingTmdb[key] = new SpoilerBlurPendingEntry { MediaType = "tv", TmdbId = (100000 + i).ToString() };
            }
            h.Mgr.SaveUserConfiguration(h.User.Id.ToString("N"), SpoilerFile, state);

            var result = h.Controller.EnableSpoilerBlurPending("tv", "999999");

            var obj = Assert.IsType<ObjectResult>(result);
            Assert.Equal(429, obj.StatusCode);
            var json = JsonSerializer.Serialize(obj.Value);
            Assert.Contains("pending_cap_exceeded", json);
        }

        [Fact]
        public void EnableSpoilerBlurPending_MasterSwitchOff_Returns503()
        {
            using var h = Build(new PluginConfiguration { SpoilerBlurEnabled = false });
            var result = h.Controller.EnableSpoilerBlurPending("tv", "123");
            var obj = Assert.IsType<ObjectResult>(result);
            Assert.Equal(503, obj.StatusCode);
        }

        [Fact]
        public void EnableSpoilerBlurPending_BadMediaType_Returns400()
        {
            using var h = Build(new PluginConfiguration { SpoilerBlurEnabled = true });
            var result = h.Controller.EnableSpoilerBlurPending("book", "123");
            Assert.IsType<BadRequestObjectResult>(result);
        }

        // ─── AddPending promote-vs-pending outcomes (stubbed lookup) ──────────────

        [Fact]
        public void AddPending_ResolvesToSeries_PromotesToSeries()
        {
            using var h = Build();
            var seriesId = Guid.NewGuid();
            h.Lib.GetItemListHook = _ => new List<BaseItem> { new Series { Id = seriesId, Name = "Some Show" } };

            var res = h.Pending.AddPending(h.User.Id, h.User, "tv", "555", null);

            Assert.Equal("series", res.Promoted);
            Assert.Equal(seriesId.ToString("N"), res.JellyfinId);

            var stored = h.Mgr.GetUserConfiguration<UserSpoilerBlur>(h.User.Id.ToString("N"), SpoilerFile);
            Assert.True(stored.Series.ContainsKey(seriesId.ToString("N")));
            Assert.Empty(stored.PendingTmdb);
        }

        [Fact]
        public void AddPending_ResolvesToMovie_PromotesToMovie()
        {
            using var h = Build();
            var movieId = Guid.NewGuid();
            h.Lib.GetItemListHook = _ => new List<BaseItem> { new Movie { Id = movieId, Name = "Some Film" } };

            var res = h.Pending.AddPending(h.User.Id, h.User, "movie", "777", null);

            Assert.Equal("movie", res.Promoted);
            Assert.Equal(movieId.ToString("N"), res.JellyfinId);
        }

        [Fact]
        public void AddPending_NotInLibrary_RecordsPending()
        {
            using var h = Build();
            h.Lib.GetItemListHook = _ => Array.Empty<BaseItem>();

            var res = h.Pending.AddPending(h.User.Id, h.User, "tv", "888", "My Show");

            Assert.Equal("pending", res.Promoted);
            Assert.Null(res.JellyfinId);

            var stored = h.Mgr.GetUserConfiguration<UserSpoilerBlur>(h.User.Id.ToString("N"), SpoilerFile);
            Assert.True(stored.PendingTmdb.ContainsKey("tv:888"));
            Assert.Equal("My Show", stored.PendingTmdb["tv:888"].DisplayName);

            // The recorded pending key primes the promoter gate; clean it up.
            SpoilerSeerrPendingPromoter.UnregisterPending("tv:888", h.User.Id);
        }

        [Fact]
        public void AddPending_PendingOnlyPath_InvalidatesCachedEnforcementState()
        {
            // BI-SEC-010 FINAL-F4: a successful pending-only RMW proves spoilerblur.json
            // is readable/valid again, so it must invalidate any cached FailClosed/stale
            // enforcement state (parity with the promotion branches), not leave it
            // lingering for up to the cache TTL.
            using var h = Build();
            h.Lib.GetItemListHook = _ => Array.Empty<BaseItem>();
            var userKey = h.User.Id.ToString("N");

            SpoilerUserResolver.SeedUserStateCacheForTest(userKey);
            Assert.True(SpoilerUserResolver.IsUserStateCachedForTest(userKey));

            var res = h.Pending.AddPending(h.User.Id, h.User, "tv", "999", "My Show");
            Assert.Equal("pending", res.Promoted);

            Assert.False(SpoilerUserResolver.IsUserStateCachedForTest(userKey));

            SpoilerSeerrPendingPromoter.UnregisterPending("tv:999", h.User.Id);
        }

        // ─── Health endpoint: non-admin sees only own corruption events ───────────

        [Fact]
        public void GetSpoilerBlurHealth_NonAdmin_SeesOnlyOwnEvents()
        {
            // includeUserInManager: false ⇒ IsAdminUser() falls through to false.
            using var h = Build(includeUserInManager: false);

            var meKey = h.User.Id.ToString("N");
            var otherKey = Guid.NewGuid().ToString("N");
            SpoilerUserResolver.RecordCorruption(meKey, "me", "mine");
            SpoilerUserResolver.RecordCorruption(otherKey, "other", "theirs");

            try
            {
                var ok = Assert.IsType<OkObjectResult>(h.Controller.GetSpoilerBlurHealth());
                var json = JsonSerializer.Serialize(ok.Value);
                Assert.Contains(meKey, json);
                Assert.DoesNotContain(otherKey, json);
                Assert.Contains("\"healthy\":false", json);
            }
            finally
            {
                SpoilerUserResolver.ClearCorruption(meKey);
                SpoilerUserResolver.ClearCorruption(otherKey);
            }
        }

        // ─── F4: movie scope probe endpoint ───────────────────────────────────────

        [Fact]
        public void GetMovieSpoilerScope_BadGuid_Returns400()
        {
            using var h = Build();
            Assert.IsType<BadRequestObjectResult>(h.Controller.GetMovieSpoilerScope("not-a-guid"));
        }

        [Fact]
        public void GetMovieSpoilerScope_NotInScope_ReturnsInScopeFalse()
        {
            using var h = Build();
            var ok = Assert.IsType<OkObjectResult>(h.Controller.GetMovieSpoilerScope(Guid.NewGuid().ToString()));
            var json = JsonSerializer.Serialize(ok.Value);
            Assert.Contains("\"inScope\":false", json);
            Assert.Contains("\"played\":false", json);
        }

        [Fact]
        public void GetMovieSpoilerScope_DirectlyOptedIn_ReturnsInScopeTrue_WithPlayedState()
        {
            using var h = Build();
            var movieId = Guid.NewGuid();

            // Opt the movie in directly so IsMovieInSpoilerScope is true without a
            // library collection walk.
            var state = new UserSpoilerBlur();
            state.Movies[movieId.ToString("N")] = new SpoilerBlurMovieEntry { MovieId = movieId.ToString("N") };
            h.Mgr.SaveUserConfiguration(h.User.Id.ToString("N"), SpoilerFile, state);

            var movie = new Movie { Id = movieId, Name = "Film" };
            h.Lib.GetItemByIdUserHook = (_, _) => movie;
            h.UserData.GetUserDataHook = (_, _) => new UserItemData { Key = "k", Played = true };

            var ok = Assert.IsType<OkObjectResult>(h.Controller.GetMovieSpoilerScope(movieId.ToString()));
            var json = JsonSerializer.Serialize(ok.Value);
            Assert.Contains("\"inScope\":true", json);
            Assert.Contains("\"played\":true", json);
        }

        // ─── F5: promoter promotes an accessible TMDB duplicate ───────────────────

        [Fact]
        public void PromoteForUser_EventItemInaccessible_PromotesAccessibleTmdbDuplicate()
        {
            using var h = Build();
            var userManager = new StubUserManager(h.User);
            var promoter = new SpoilerSeerrPendingPromoter(
                h.Lib, userManager, h.Mgr, new FakePluginConfigProvider(null), h.Pending,
                NullLogger<SpoilerSeerrPendingPromoter>.Instance);

            const string pendingKey = "tv:555";
            var state = new UserSpoilerBlur();
            state.PendingTmdb[pendingKey] = new SpoilerBlurPendingEntry { MediaType = "tv", TmdbId = "555" };
            h.Mgr.SaveUserConfiguration(h.User.Id.ToString("N"), SpoilerFile, state);

            var eventItemId = Guid.NewGuid();   // library duplicate the user can't access
            var dupId = Guid.NewGuid();         // accessible duplicate (same TMDB id)
            h.Lib.GetItemByIdUserHook = (_, _) => null;                                    // event item not visible
            h.Lib.GetItemListHook = _ => new List<BaseItem> { new Series { Id = dupId, Name = "Dup Show" } };

            var outcome = promoter.PromoteForUser(h.User.Id, eventItemId, pendingKey, "Orig", isSeries: true);

            Assert.Equal(SpoilerSeerrPendingPromoter.PromotionOutcome.Promoted, outcome);
            var stored = h.Mgr.GetUserConfiguration<UserSpoilerBlur>(h.User.Id.ToString("N"), SpoilerFile);
            Assert.True(stored.Series.ContainsKey(dupId.ToString("N")));            // promoted the ACCESSIBLE dup
            Assert.False(stored.Series.ContainsKey(eventItemId.ToString("N")));
            Assert.Empty(stored.PendingTmdb);
        }

        // ─── F7: controller writes invalidate the cross-request state cache ───────

        [Fact]
        public void EnableSpoilerBlurForSeries_InvalidatesUserStateCache()
        {
            using var h = Build();
            var seriesId = Guid.NewGuid();
            h.Lib.GetItemByIdUserHook = (_, _) => new Series { Id = seriesId, Name = "Show" };
            var userKey = h.User.Id.ToString("N");

            SpoilerUserResolver.SeedUserStateCacheForTest(userKey);
            Assert.True(SpoilerUserResolver.IsUserStateCachedForTest(userKey));

            Assert.IsType<OkObjectResult>(h.Controller.EnableSpoilerBlurForSeries(seriesId.ToString()));
            Assert.False(SpoilerUserResolver.IsUserStateCachedForTest(userKey));
        }
    }
}
