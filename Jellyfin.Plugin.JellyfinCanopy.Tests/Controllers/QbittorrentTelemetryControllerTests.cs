using System.Reflection;
using System.Security.Claims;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Model.Qbittorrent;
using Jellyfin.Plugin.JellyfinCanopy.Services.Qbittorrent;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Common.Api;
using MediaBrowser.Controller.Entities.Movies;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers;

public sealed class QbittorrentTelemetryControllerTests
{
    [Fact]
    public void RoutesAndAuthorization_PinReadOnlyContract()
    {
        Assert.Equal(
            "JellyfinCanopy/qbittorrent",
            typeof(QbittorrentTelemetryController).GetCustomAttribute<RouteAttribute>()?.Template);
        var telemetry = Method(nameof(QbittorrentTelemetryController.GetTelemetry));
        var test = Method(nameof(QbittorrentTelemetryController.TestConnection));
        var connection = Method(nameof(QbittorrentTelemetryController.SaveConnection));
        Assert.Equal("telemetry/{itemId}", telemetry.GetCustomAttribute<HttpGetAttribute>()?.Template);
        Assert.Null(telemetry.GetCustomAttribute<AuthorizeAttribute>()?.Policy);
        Assert.Equal("test", test.GetCustomAttribute<HttpGetAttribute>()?.Template);
        Assert.Equal(Policies.RequiresElevation, test.GetCustomAttribute<AuthorizeAttribute>()?.Policy);
        Assert.Equal("connection", connection.GetCustomAttribute<HttpPostAttribute>()?.Template);
        Assert.Equal(Policies.RequiresElevation, connection.GetCustomAttribute<AuthorizeAttribute>()?.Policy);
        Assert.NotNull(connection.GetCustomAttribute<RequestSizeLimitAttribute>());
        Assert.DoesNotContain(typeof(QbittorrentTelemetryController).GetMethods(), method =>
            method.GetCustomAttribute<HttpPutAttribute>() != null
            || method.GetCustomAttribute<HttpDeleteAttribute>() != null
            || method.GetCustomAttribute<HttpPatchAttribute>() != null);
    }

    [Fact]
    public void PluginConfigurationJson_NeverSerializesQbittorrentConnectionOrTopology()
    {
        const string secret = "browser-payload-secret";
        var json = System.Text.Json.JsonSerializer.Serialize(new PluginConfiguration
        {
            QbittorrentUrl = secret,
            QbittorrentUsername = secret,
            QbittorrentPassword = secret,
            QbittorrentPathMappings = secret,
        });

        Assert.DoesNotContain(secret, json, StringComparison.Ordinal);
        Assert.DoesNotContain("QbittorrentUrl", json, StringComparison.Ordinal);
        Assert.DoesNotContain("QbittorrentUsername", json, StringComparison.Ordinal);
        Assert.DoesNotContain("QbittorrentPassword", json, StringComparison.Ordinal);
        Assert.DoesNotContain("QbittorrentPathMappings", json, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("update", "", null, null, null)]
    [InlineData("update", null, "", null, null)]
    [InlineData("update", null, null, "", null)]
    [InlineData("update", null, null, null, "")]
    [InlineData("clear", "unexpected", null, null, null)]
    [InlineData("replace", null, null, "secret", null)]
    public void SaveConnection_RejectsInvalidWriteOnlyRequests(
        string action,
        string? url,
        string? username,
        string? password,
        string? pathMappings)
    {
        var controller = Create(
            new User("admin", "provider", "password-provider"),
            new RecordingTelemetry(),
            new CountingLibraryManager(),
            regularUsers: false);

        var result = controller.SaveConnection(new QbittorrentConnectionRequest
        {
            Action = action,
            Url = url,
            Username = username,
            Password = password,
            PathMappings = pathMappings,
        });

        Assert.IsType<BadRequestObjectResult>(result);
    }

    [Fact]
    public async Task InaccessibleItem_DoesNotReachTelemetryService()
    {
        var user = new User("regular", "provider", "password-provider");
        var telemetry = new RecordingTelemetry();
        var library = new CountingLibraryManager { GetItemByIdUserHook = (_, _) => null };
        var controller = Create(user, telemetry, library, regularUsers: true);

        var result = await controller.GetTelemetry(Guid.NewGuid().ToString("N"), CancellationToken.None);

        Assert.IsType<NotFoundResult>(result);
        Assert.Equal(1, library.GetItemByIdUserCallCount);
        Assert.Equal(0, telemetry.CallCount);
    }

    [Fact]
    public async Task ForgedAdministratorRole_DoesNotBypassLiveRegularUserPolicy()
    {
        var user = new User("regular", "provider", "password-provider");
        var telemetry = new RecordingTelemetry();
        var library = new CountingLibraryManager
        {
            GetItemByIdUserHook = (_, _) => throw new InvalidOperationException("must not query"),
        };
        var controller = Create(user, telemetry, library, regularUsers: false, forgedAdminRole: true);

        var result = await controller.GetTelemetry(Guid.NewGuid().ToString("N"), CancellationToken.None);

        Assert.IsType<ForbidResult>(result);
        Assert.Equal(0, library.GetItemByIdUserCallCount);
        Assert.Equal(0, telemetry.CallCount);
    }

    [Fact]
    public async Task AuthorizedMovie_PassesOnlyServerPathAndReturnsClosedProjection()
    {
        var user = new User("regular", "provider", "password-provider");
        var id = Guid.NewGuid();
        var movie = new Movie { Id = id, Path = "/private/media/movie.mkv" };
        var telemetry = new RecordingTelemetry
        {
            Result = new QbittorrentTelemetryResult(
                QbittorrentTelemetryResultKind.Success,
                new QbittorrentTelemetryResponse { State = "seeding", Ratio = 2.5 }),
        };
        var library = new CountingLibraryManager
        {
            GetItemByIdUserHook = (candidate, scopedUser) =>
                candidate == id && ReferenceEquals(scopedUser, user) ? movie : null,
        };
        var controller = Create(user, telemetry, library, regularUsers: true);

        var result = await controller.GetTelemetry(id.ToString("N"), CancellationToken.None);

        var response = Assert.IsType<QbittorrentTelemetryResponse>(Assert.IsType<OkObjectResult>(result).Value);
        Assert.Equal("seeding", response.State);
        Assert.Equal("/private/media/movie.mkv", telemetry.LastPath);
        Assert.Equal(1, telemetry.CallCount);
    }

    private static MethodInfo Method(string name)
        => typeof(QbittorrentTelemetryController).GetMethod(name)
            ?? throw new InvalidOperationException($"Missing action {name}.");

    private static QbittorrentTelemetryController Create(
        User user,
        RecordingTelemetry telemetry,
        CountingLibraryManager library,
        bool regularUsers,
        bool forgedAdminRole = false)
    {
        var provider = new FakePluginConfigProvider(new PluginConfiguration
        {
            QbittorrentTelemetryEnabled = true,
            QbittorrentTelemetryForRegularUsers = regularUsers,
        });
        var claims = new List<Claim> { new("Jellyfin-UserId", user.Id.ToString()) };
        if (forgedAdminRole) claims.Add(new Claim(ClaimTypes.Role, "Administrator"));
        var controller = new QbittorrentTelemetryController(
            new RecordingHttpClientFactory(new RecordingHttpMessageHandler()),
            NullLogger<QbittorrentTelemetryController>.Instance,
            new StubUserManager(user),
            new SeerrCache(provider),
            provider,
            telemetry,
            library)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext
                {
                    User = new ClaimsPrincipal(new ClaimsIdentity(claims, "TestAuth")),
                },
            },
        };
        return controller;
    }

    private sealed class RecordingTelemetry : IQbittorrentTelemetryService
    {
        public void InvalidateCachedState()
        {
        }

        public int CallCount { get; private set; }
        public string? LastPath { get; private set; }
        public QbittorrentTelemetryResult Result { get; set; }
            = new(QbittorrentTelemetryResultKind.NoMatch);

        public Task<QbittorrentTelemetryResult> GetForItemPathAsync(
            string itemPath,
            CancellationToken cancellationToken)
        {
            CallCount++;
            LastPath = itemPath;
            return Task.FromResult(Result);
        }

        public Task<QbittorrentTelemetryResultKind> TestConnectionAsync(
            CancellationToken cancellationToken)
            => Task.FromResult(QbittorrentTelemetryResultKind.Success);
    }
}
