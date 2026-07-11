using System;
using System.IO;
using System.Net.Http;
using System.Security.Claims;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinElevate.Configuration;
using Jellyfin.Plugin.JellyfinElevate.Controllers;
using Jellyfin.Plugin.JellyfinElevate.Model.Awards;
using Jellyfin.Plugin.JellyfinElevate.Services.Awards;
using Jellyfin.Plugin.JellyfinElevate.Services.Jellyseerr;
using Jellyfin.Plugin.JellyfinElevate.Tests.TestDoubles;
using MediaBrowser.Controller.Entities.Movies;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.Controllers
{
    /// <summary>
    /// HTTP-surface coverage for AwardsController: the admin enable gate, caller-scoped item
    /// resolution (CSCTRL-4 — a non-admin can't confirm existence of items outside their
    /// libraries), and the "empty, not an error" contract for disabled/unknown/awardless items.
    /// </summary>
    public sealed class AwardsControllerTests : IDisposable
    {
        private readonly string _dir;

        public AwardsControllerTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "je-awards-ctrl-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_dir);
        }

        public void Dispose()
        {
            try { Directory.Delete(_dir, recursive: true); } catch { /* best-effort */ }
        }

        private sealed class Harness
        {
            public required AwardsController Controller { get; init; }
            public required CountingLibraryManager Lib { get; init; }
            public required AwardsCacheService Cache { get; init; }
        }

        private Harness Build(bool enabled, bool authenticated = true)
        {
            var cfg = new PluginConfiguration { ShowAwards = enabled };
            var provider = new FakePluginConfigProvider(cfg);
            var user = new User("awards", "Prov", "PwProv");
            var userManager = new StubUserManager(user);
            var lib = new CountingLibraryManager();
            var cache = new AwardsCacheService(new StubAppPaths(_dir), NullLogger<AwardsCacheService>.Instance);

            var controller = new AwardsController(
                new RecordingHttpClientFactory(new HttpClientHandler()),
                NullLogger<AwardsController>.Instance,
                userManager,
                new SeerrCache(provider),
                provider,
                lib,
                cache);

            var identity = authenticated
                ? new ClaimsIdentity(new[] { new Claim("Jellyfin-UserId", user.Id.ToString()) }, "TestAuth")
                : new ClaimsIdentity();
            controller.ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(identity) },
            };

            return new Harness { Controller = controller, Lib = lib, Cache = cache };
        }

        private static ItemAwardsResponse Unwrap(ActionResult<ItemAwardsResponse> result)
        {
            Assert.NotNull(result.Value);
            return result.Value!;
        }

        [Fact]
        public void Disabled_ReturnsNotEnabled_AndNeverTouchesLibrary()
        {
            var h = Build(enabled: false);
            var libTouched = false;
            h.Lib.GetItemByIdUserHook = (_, _) => { libTouched = true; return null; };

            var response = Unwrap(h.Controller.GetItemAwards(Guid.NewGuid()));

            Assert.False(response.Enabled);
            Assert.Empty(response.Awards);
            Assert.False(libTouched); // disabled short-circuits before any lookup
        }

        [Fact]
        public void Enabled_ItemWithAwards_ReturnsThem_ScopedToCaller()
        {
            var h = Build(enabled: true);
            h.Cache.ReplaceFrom(new[]
            {
                new AwardRow { Ceremony = "Academy Awards", Category = "Best Picture", Won = true, Year = 2024, ImdbId = "tt1" },
            });
            var itemId = Guid.NewGuid();
            User? scopedUser = null;
            h.Lib.GetItemByIdUserHook = (id, user) =>
            {
                scopedUser = user; // prove the user-scoped overload was used
                if (id != itemId) return null;
                var m = new Movie { Id = itemId };
                m.ProviderIds["Imdb"] = "tt1";
                return m;
            };

            var response = Unwrap(h.Controller.GetItemAwards(itemId));

            Assert.True(response.Enabled);
            var award = Assert.Single(response.Awards);
            Assert.Equal("Best Picture", award.Category);
            Assert.NotNull(scopedUser); // the lookup was scoped, not global
        }

        [Fact]
        public void Enabled_UnknownItem_ReturnsEmpty()
        {
            var h = Build(enabled: true);
            h.Cache.ReplaceFrom(new[]
            {
                new AwardRow { Ceremony = "Academy Awards", Category = "Best Picture", Won = true, Year = 2024, ImdbId = "tt1" },
            });
            h.Lib.GetItemByIdUserHook = (_, _) => null; // not visible to this caller / doesn't exist

            var response = Unwrap(h.Controller.GetItemAwards(Guid.NewGuid()));

            Assert.True(response.Enabled);
            Assert.Empty(response.Awards);
        }

        [Fact]
        public void Enabled_NoUser_FailsClosed_AndNeverTouchesLibrary()
        {
            var h = Build(enabled: true, authenticated: false);
            var libTouched = false;
            h.Lib.GetItemByIdUserHook = (_, _) => { libTouched = true; return null; };

            var response = Unwrap(h.Controller.GetItemAwards(Guid.NewGuid()));

            Assert.True(response.Enabled);
            Assert.Empty(response.Awards);
            Assert.False(libTouched); // no resolvable user id → no lookup
        }

        [Fact]
        public void Enabled_EmptyItemId_ReturnsEmpty_WithoutLookup()
        {
            var h = Build(enabled: true);
            var libTouched = false;
            h.Lib.GetItemByIdUserHook = (_, _) => { libTouched = true; return null; };

            var response = Unwrap(h.Controller.GetItemAwards(Guid.Empty));

            Assert.True(response.Enabled);
            Assert.Empty(response.Awards);
            Assert.False(libTouched);
        }
    }
}
