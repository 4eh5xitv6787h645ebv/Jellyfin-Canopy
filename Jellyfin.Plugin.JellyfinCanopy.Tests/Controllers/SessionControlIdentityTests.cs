using System.Security.Claims;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers;

public sealed class SessionControlIdentityTests
{
    [Fact]
    public async Task ActiveStreamsMessageUsesCanonicalCallerSession()
    {
        var actorId = Guid.NewGuid();
        var sessions = RecordingSessions(actorId);
        var controller = CreateActiveStreamsController(
            sessions,
            Principal(new Claim("Jellyfin-UserId", actorId.ToString())));

        var result = await controller.MessageSession(
            "target-session",
            new BroadcastMessageRequest { Text = "hello" });

        Assert.IsType<OkObjectResult>(result);
        Assert.Single(sessions.MessageCommands);
        Assert.Equal("actor-session", sessions.MessageCommands[0].ControllingSessionId);
    }

    [Theory]
    [InlineData(ClaimTypes.NameIdentifier)]
    [InlineData("sub")]
    [InlineData("Sid")]
    public async Task ActiveStreamsMessageRejectsLegacyControllingIdentity(string legacyClaimType)
    {
        var legacyId = Guid.NewGuid();
        var sessions = RecordingSessions(legacyId, includeEmptyUserSession: true);
        var controller = CreateActiveStreamsController(
            sessions,
            Principal(
                new Claim(ClaimTypes.Role, "Administrator"),
                new Claim(legacyClaimType, legacyId.ToString())));

        var result = await controller.MessageSession(
            "target-session",
            new BroadcastMessageRequest { Text = "hello" });

        Assert.IsType<OkObjectResult>(result);
        Assert.Single(sessions.MessageCommands);
        Assert.Equal(string.Empty, sessions.MessageCommands[0].ControllingSessionId);
    }

    [Fact]
    public async Task MaintenanceBroadcastUsesCanonicalCallerSession()
    {
        var actorId = Guid.NewGuid();
        var sessions = RecordingSessions(actorId);
        var controller = CreateMaintenanceController(
            sessions,
            Principal(new Claim("Jellyfin-UserId", actorId.ToString())));

        var result = await controller.BroadcastMaintenanceMessage(
            new MaintenanceModeController.MaintenanceBroadcastRequest { Text = "maintenance" });

        Assert.IsType<OkObjectResult>(result);
        Assert.NotEmpty(sessions.MessageCommands);
        Assert.All(
            sessions.MessageCommands,
            command => Assert.Equal("actor-session", command.ControllingSessionId));
    }

    [Theory]
    [InlineData(ClaimTypes.NameIdentifier)]
    [InlineData("sub")]
    [InlineData("Sid")]
    public async Task MaintenanceBroadcastRejectsLegacyControllingIdentity(string legacyClaimType)
    {
        var legacyId = Guid.NewGuid();
        var sessions = RecordingSessions(legacyId, includeEmptyUserSession: true);
        var controller = CreateMaintenanceController(
            sessions,
            Principal(
                new Claim(ClaimTypes.Role, "Administrator"),
                new Claim(legacyClaimType, legacyId.ToString())));

        var result = await controller.BroadcastMaintenanceMessage(
            new MaintenanceModeController.MaintenanceBroadcastRequest { Text = "maintenance" });

        Assert.IsType<OkObjectResult>(result);
        Assert.NotEmpty(sessions.MessageCommands);
        Assert.All(
            sessions.MessageCommands,
            command => Assert.Equal(string.Empty, command.ControllingSessionId));
    }

    private static CountingSessionManager RecordingSessions(
        Guid actorId,
        bool includeEmptyUserSession = false)
    {
        var sessions = new List<SessionInfo>
        {
            new(null!, NullLogger.Instance) { Id = "actor-session", UserId = actorId, UserName = "actor" },
            new(null!, NullLogger.Instance) { Id = "target-session", UserId = Guid.NewGuid(), UserName = "target" },
        };
        if (includeEmptyUserSession)
        {
            sessions.Add(new SessionInfo(null!, NullLogger.Instance)
            {
                Id = "empty-user-session",
                UserId = Guid.Empty,
                UserName = "empty",
            });
        }

        var manager = new CountingSessionManager { RecordMessageCommands = true };
        manager.SetSessions(sessions.ToArray());
        return manager;
    }

    private static ActiveStreamsController CreateActiveStreamsController(
        CountingSessionManager sessions,
        ClaimsPrincipal principal)
    {
        var controller = new ActiveStreamsController(
            null!,
            NullLogger<ActiveStreamsController>.Instance,
            new StubUserManager(),
            null!,
            new FakePluginConfigProvider(new PluginConfiguration { ActiveStreamsEnabled = true }),
            sessions);
        SetPrincipal(controller, principal);
        return controller;
    }

    private static MaintenanceModeController CreateMaintenanceController(
        CountingSessionManager sessions,
        ClaimsPrincipal principal)
    {
        var controller = new MaintenanceModeController(
            null!,
            NullLogger<MaintenanceModeController>.Instance,
            new StubUserManager(),
            null!,
            new FakePluginConfigProvider(),
            sessions,
            null!);
        SetPrincipal(controller, principal);
        return controller;
    }

    private static ClaimsPrincipal Principal(params Claim[] claims)
        => new(new ClaimsIdentity(claims, "TestAuth"));

    private static void SetPrincipal(ControllerBase controller, ClaimsPrincipal principal)
        => controller.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext { User = principal },
        };
}
