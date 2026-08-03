using System.Security.Claims;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers;

public sealed class ControllerUserIdentityTests
{
    [Fact]
    public void CurrentUserId_UsesTheAuthenticatedJellyfin12Claim()
    {
        var jellyfinUserId = Guid.NewGuid();
        var legacyUserId = Guid.NewGuid();
        var controller = CreateController(
            new Claim("Jellyfin-UserId", jellyfinUserId.ToString()),
            new Claim(ClaimTypes.NameIdentifier, legacyUserId.ToString()));

        var caller = controller.ResolveSeerrCaller();

        Assert.Equal(jellyfinUserId.ToString(), caller.JellyfinUserId);
    }

    [Theory]
    [InlineData(ClaimTypes.NameIdentifier)]
    [InlineData("sub")]
    [InlineData("Sid")]
    public void CurrentUserId_RejectsLegacyClaimFallbacks(string claimType)
    {
        var expected = Guid.NewGuid();
        var controller = CreateController(new Claim(claimType, expected.ToString()));

        Assert.Null(controller.ResolveSeerrCaller().JellyfinUserId);
    }

    [Fact]
    public void CurrentUserId_RejectsAnUnauthenticatedJellyfinClaim()
    {
        var controller = CreateController(
            false,
            new Claim("Jellyfin-UserId", Guid.NewGuid().ToString()));

        Assert.Null(controller.ResolveSeerrCaller().JellyfinUserId);
    }

    [Fact]
    public void CurrentUserId_RejectsDuplicateJellyfinClaims()
    {
        var userId = Guid.NewGuid();
        var controller = CreateController(
            new Claim("Jellyfin-UserId", userId.ToString()),
            new Claim("jellyfin-userid", userId.ToString()));

        Assert.Null(controller.ResolveSeerrCaller().JellyfinUserId);
    }

    [Fact]
    public void AdminRoleRequiresACanonicalAuthenticatedActor()
    {
        var missingActor = CreateController(new Claim(ClaimTypes.Role, "Administrator"));
        var duplicateActor = CreateController(
            new Claim(ClaimTypes.Role, "Administrator"),
            new Claim("Jellyfin-UserId", Guid.NewGuid().ToString()),
            new Claim("jellyfin-userid", Guid.NewGuid().ToString()));
        var validActor = CreateController(
            new Claim(ClaimTypes.Role, "Administrator"),
            new Claim("Jellyfin-UserId", Guid.NewGuid().ToString()));

        Assert.False(missingActor.ResolveIsAdmin());
        Assert.False(duplicateActor.ResolveIsAdmin());
        Assert.True(validActor.ResolveIsAdmin());
    }

    [Fact]
    public void AdminRoleMustBelongToTheCanonicalIdentity()
    {
        var actorId = Guid.NewGuid();
        foreach (var secondary in new[]
        {
            new ClaimsIdentity(
                new[] { new Claim(ClaimTypes.Role, "Administrator") },
                "SecondaryAuth"),
            new ClaimsIdentity(new[] { new Claim(ClaimTypes.Role, "Administrator") }),
        })
        {
            var controller = CreateController(new ClaimsPrincipal(new[]
            {
                new ClaimsIdentity(
                    new[] { new Claim("Jellyfin-UserId", actorId.ToString()) },
                    "PrimaryAuth"),
                secondary,
            }));

            Assert.False(controller.ResolveIsAdmin());
            Assert.False(controller.ResolveSeerrCaller().IsAdmin);
        }
    }

    private static IdentityProbeController CreateController(params Claim[] claims)
        => CreateController(true, claims);

    private static IdentityProbeController CreateController(bool authenticated, params Claim[] claims)
        => CreateController(new ClaimsPrincipal(new ClaimsIdentity(
            claims,
            authenticated ? "TestAuth" : null)));

    private static IdentityProbeController CreateController(ClaimsPrincipal principal)
    {
        var controller = new IdentityProbeController
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext
                {
                    User = principal
                }
            }
        };
        return controller;
    }

    private sealed class IdentityProbeController : JellyfinCanopyControllerBase
    {
        public IdentityProbeController()
            : base(null!, NullLogger.Instance, null!, null!, null!)
        {
        }

        public SeerrCaller ResolveSeerrCaller() => SeerrCaller();

        public bool ResolveIsAdmin() => IsAdminUser();
    }
}
