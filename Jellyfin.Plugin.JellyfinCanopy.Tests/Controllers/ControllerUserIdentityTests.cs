using System.Security.Claims;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers;

public sealed class ControllerUserIdentityTests
{
    [Fact]
    public void CurrentUserId_PrefersTheJellyfin12Claim()
    {
        var jellyfinUserId = Guid.NewGuid();
        var legacyUserId = Guid.NewGuid();
        var controller = CreateController(
            new Claim("Jellyfin-UserId", jellyfinUserId.ToString()),
            new Claim(ClaimTypes.NameIdentifier, legacyUserId.ToString()));

        Assert.Equal(jellyfinUserId, controller.ResolveCurrentUserId());
    }

    [Theory]
    [InlineData(ClaimTypes.NameIdentifier)]
    [InlineData("sub")]
    [InlineData("Sid")]
    public void CurrentUserId_KeepsLegacyClaimFallbacks(string claimType)
    {
        var expected = Guid.NewGuid();
        var controller = CreateController(new Claim(claimType, expected.ToString()));

        Assert.Equal(expected, controller.ResolveCurrentUserId());
    }

    private static IdentityProbeController CreateController(params Claim[] claims)
    {
        var controller = new IdentityProbeController
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext
                {
                    User = new ClaimsPrincipal(new ClaimsIdentity(claims, "TestAuth"))
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

        public Guid ResolveCurrentUserId() => GetCurrentUserId();
    }
}
