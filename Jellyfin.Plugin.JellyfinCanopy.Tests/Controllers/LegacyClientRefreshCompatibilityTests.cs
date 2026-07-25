using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers;

public sealed class LegacyClientRefreshCompatibilityTests
{
    [Fact]
    public void VersionEndpoint_ReturnsSuccessorOnlyForNumericLegacyHeartbeat()
    {
        var ordinaryController = CreateController();
        var ordinary = Assert.IsType<ContentResult>(ordinaryController.GetVersion()).Content;
        Assert.NotNull(ordinary);
        Assert.Matches(@"^\d+(?:\.\d+)+$", ordinary!);
        Assert.False(ordinaryController.Response.Headers.ContainsKey("Cache-Control"));

        var legacyController = CreateController("?_je=1720000000000");
        var legacy = Assert.IsType<ContentResult>(legacyController.GetVersion()).Content;
        Assert.Equal($"{ordinary}.1", legacy);
        Assert.Equal("no-store", legacyController.Response.Headers.CacheControl);

        var malformedController = CreateController("?_je=not-a-heartbeat");
        var malformed = Assert.IsType<ContentResult>(malformedController.GetVersion()).Content;
        Assert.Equal(ordinary, malformed);
        Assert.False(malformedController.Response.Headers.ContainsKey("Cache-Control"));
    }

    private static ConfigController CreateController(string? query = null)
    {
        var controller = new ConfigController(
            null!,
            NullLogger<ConfigController>.Instance,
            null!,
            null!,
            new FakePluginConfigProvider(new PluginConfiguration()),
            null!,
            new LocaleMissLogLimiter());
        var context = new DefaultHttpContext();
        if (query != null)
        {
            context.Request.QueryString = new QueryString(query);
        }

        controller.ControllerContext = new ControllerContext
        {
            HttpContext = context,
        };
        return controller;
    }
}
