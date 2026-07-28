using System;
using System.Collections.Generic;
using System.Security.Claims;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Routing;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    /// <summary>
    /// Identity resolution is the hinge every later authorization decision hangs on,
    /// so it is tested against claims directly rather than trusted to inspection.
    ///
    /// EP-00 established the fact these tests encode: with a non-admin token, injected
    /// <c>Jellyfin-UserId</c> / <c>X-Jellyfin-User-Id</c> / <c>X-Emby-Authorization</c>
    /// headers and a <c>jellyfin-userid</c> cookie all still resolved to the caller's
    /// own id (spike-evidence S14). The base therefore reads the CLAIM and nothing
    /// else, and these tests fail if it ever starts reading anything else.
    /// </summary>
    public class PlatformControllerBaseTests
    {
        /// <summary>Minimal concrete controller; the base is abstract and has no behaviour of its own to host.</summary>
        private sealed class TestController : PlatformControllerBase
        {
            public Guid? ExposedUserId => ActingUserId;

            public string? ExposedDeviceId => ActingDeviceId;
        }

        private static TestController WithClaims(params Claim[] claims) => new()
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext
                {
                    User = new ClaimsPrincipal(new ClaimsIdentity(claims, "Test")),
                },

                // Not populated by default, and the forgery tests below write route values.
                RouteData = new RouteData(),
            },
        };

        [Fact]
        public void ActingUserId_ComesFromTheJellyfinUserIdClaim()
        {
            var id = Guid.NewGuid();

            Assert.Equal(id, WithClaims(new Claim("Jellyfin-UserId", id.ToString())).ExposedUserId);
        }

        [Fact]
        public void ActingUserId_MatchesTheClaimNameCaseInsensitively()
        {
            // Claim type casing is not something a plugin controls, and a casing change
            // in the host must not silently turn every caller anonymous.
            var id = Guid.NewGuid();

            Assert.Equal(id, WithClaims(new Claim("jellyfin-userid", id.ToString())).ExposedUserId);
        }

        [Theory]
        // Nothing to read.
        [InlineData(null)]
        // Present but unusable. Treated as "no identity" rather than throwing: an
        // unparseable claim is the host's problem, not a 500 for the caller.
        [InlineData("not-a-guid")]
        [InlineData("")]
        // The empty GUID is a real value that means "nobody". Accepting it would let a
        // caller with no identity look like a user whose id happens to be all zeroes.
        [InlineData("00000000-0000-0000-0000-000000000000")]
        public void ActingUserId_IsNullWhenTheClaimIsAbsentOrUnusable(string? raw)
        {
            var controller = raw is null
                ? WithClaims()
                : WithClaims(new Claim("Jellyfin-UserId", raw));

            Assert.Null(controller.ExposedUserId);
        }

        [Fact]
        public void ActingDeviceId_IsReadForAttributionAndIsAllowedToBeAbsent()
        {
            Assert.Equal("living-room-tv", WithClaims(new Claim("Jellyfin-DeviceId", "living-room-tv")).ExposedDeviceId);

            // Absent is normal, not an error: a device id is attribution only and never
            // authority, so nothing may refuse to serve a caller that has none (ADR-0011).
            Assert.Null(WithClaims().ExposedDeviceId);
        }

        [Fact]
        public void ActingUserId_IgnoresHeadersCookiesAndRouteValuesEntirely()
        {
            // The forgery attempt EP-00 actually ran, reproduced as a unit test so a
            // future refactor toward "just read the header, it is simpler" fails loudly.
            var real = Guid.NewGuid();
            var forged = Guid.NewGuid();

            var controller = WithClaims(new Claim("Jellyfin-UserId", real.ToString()));
            var context = controller.ControllerContext.HttpContext;

            context.Request.Headers["Jellyfin-UserId"] = forged.ToString();
            context.Request.Headers["X-Jellyfin-User-Id"] = forged.ToString();
            context.Request.Headers["X-Emby-Authorization"] = $"MediaBrowser UserId=\"{forged}\"";
            context.Request.Headers["Cookie"] = $"jellyfin-userid={forged}";
            controller.ControllerContext.RouteData.Values["userId"] = forged.ToString();

            Assert.Equal(real, controller.ExposedUserId);
        }

        [Fact]
        public void ActingUserId_PrefersNothingWhenOnlyAForgedSourceIsPresent()
        {
            // The dangerous half of the previous test: with NO claim, every caller-supplied
            // source saying "I am this user" must still resolve to no identity at all.
            var forged = Guid.NewGuid();

            var controller = WithClaims();
            controller.ControllerContext.HttpContext.Request.Headers["Jellyfin-UserId"] = forged.ToString();
            controller.ControllerContext.RouteData.Values["userId"] = forged.ToString();

            Assert.Null(controller.ExposedUserId);
        }
    }
}
