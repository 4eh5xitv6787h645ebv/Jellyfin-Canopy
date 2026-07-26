using System.Reflection;
using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Model.Maintainerr;
using Jellyfin.Plugin.JellyfinCanopy.Services.Maintainerr;
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

public sealed class MaintainerrControllerContractTests
{
    [Fact]
    public void RoutesAndAuthorization_ArePinnedToReviewedContract()
    {
        Assert.Equal(
            "JellyfinCanopy/maintainerr",
            typeof(MaintainerrController).GetCustomAttribute<RouteAttribute>()?.Template);

        var test = Method(nameof(MaintainerrController.Test));
        var dashboard = Method(nameof(MaintainerrController.Dashboard));
        var content = Method(nameof(MaintainerrController.CollectionContent));
        var item = Method(nameof(MaintainerrController.ItemStatus));

        Assert.Equal("test", test.GetCustomAttribute<HttpPostAttribute>()?.Template);
        Assert.Equal("dashboard", dashboard.GetCustomAttribute<HttpGetAttribute>()?.Template);
        Assert.Equal(
            "collections/{id:int}/content",
            content.GetCustomAttribute<HttpGetAttribute>()?.Template);
        Assert.Equal(
            "item-status/{itemId}",
            item.GetCustomAttribute<HttpGetAttribute>()?.Template);
        Assert.Equal(
            Policies.RequiresElevation,
            test.GetCustomAttribute<AuthorizeAttribute>()?.Policy);
        Assert.Equal(
            Policies.RequiresElevation,
            dashboard.GetCustomAttribute<AuthorizeAttribute>()?.Policy);
        Assert.Equal(
            Policies.RequiresElevation,
            content.GetCustomAttribute<AuthorizeAttribute>()?.Policy);
        Assert.NotNull(item.GetCustomAttribute<AuthorizeAttribute>());
        Assert.Null(item.GetCustomAttribute<AuthorizeAttribute>()?.Policy);
        Assert.NotNull(test.GetCustomAttribute<RequestSizeLimitAttribute>());
    }

    [Fact]
    public void Dashboard_ExposesBoundedBooleanRefreshQuery()
    {
        var refresh = Method(nameof(MaintainerrController.Dashboard))
            .GetParameters()
            .Single(parameter => parameter.Name == "refresh");

        Assert.Equal(typeof(bool), refresh.ParameterType);
        Assert.Equal(false, refresh.DefaultValue);
        Assert.NotNull(refresh.GetCustomAttribute<FromQueryAttribute>());
    }

    [Fact]
    public void ItemStatusServiceContract_RequiresExplicitCallerRole()
    {
        var parameters = typeof(IMaintainerrClient)
            .GetMethod(nameof(IMaintainerrClient.GetItemStatusAsync))!
            .GetParameters();

        Assert.Contains(
            parameters,
            parameter => parameter.ParameterType == typeof(MaintainerrCallerRole));
    }

    [Fact]
    public void RegularItemStatus_SerializesExactlyTwoBooleans()
    {
        var json = JsonSerializer.Serialize(new MaintainerrUserItemStatusResponse
        {
            ProtectedFromCleanup = true,
            ManuallyManaged = false,
        });
        using var document = JsonDocument.Parse(json);

        Assert.Equal(
            new[] { "manuallyManaged", "protectedFromCleanup" },
            document.RootElement.EnumerateObject()
                .Select(property => property.Name)
                .Order(StringComparer.Ordinal)
                .ToArray());
    }

    [Fact]
    public void AdminItemStatus_UsesSeparateBoundedLinkArrays()
    {
        var json = JsonSerializer.Serialize(new MaintainerrAdminItemStatusResponse
        {
            ProtectedFromCleanup = true,
            ManuallyManaged = true,
            ExcludedFrom =
            [
                new MaintainerrItemStatusLink
                {
                    Label = "Protected",
                    Href = "https://maintainerr.example/collections/1/exclusions",
                },
            ],
            ManuallyAddedTo = [],
        });
        using var document = JsonDocument.Parse(json);

        Assert.Equal(JsonValueKind.Array, document.RootElement.GetProperty("excludedFrom").ValueKind);
        Assert.Equal(JsonValueKind.Array, document.RootElement.GetProperty("manuallyAddedTo").ValueKind);
        Assert.Equal(
            "Protected",
            document.RootElement.GetProperty("excludedFrom")[0].GetProperty("label").GetString());
    }

    [Fact]
    public async Task ItemStatus_UsesCurrentUserPermissionWhenPrincipalHasConflictingAdminRole()
    {
        var user = new User("demoted-user", "provider", "password-provider");
        var itemId = Guid.NewGuid();
        var library = new CountingLibraryManager
        {
            GetItemByIdUserHook = (id, scopedUser) =>
                id == itemId && ReferenceEquals(scopedUser, user)
                    ? new Movie { Id = itemId }
                    : null,
        };
        var configuration = new PluginConfiguration
        {
            MaintainerrEnabled = true,
            MaintainerrUrl = "http://127.0.0.1:6246",
            MaintainerrItemStatusEnabled = true,
            MaintainerrItemStatusForUsers = true,
        };
        var configProvider = new FakePluginConfigProvider(configuration);
        var maintainerr = new RecordingMaintainerrClient();
        var controller = new MaintainerrController(
            new RecordingHttpClientFactory(new RecordingHttpMessageHandler()),
            NullLogger<MaintainerrController>.Instance,
            new StubUserManager(user),
            new SeerrCache(configProvider),
            configProvider,
            maintainerr,
            library);
        controller.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity(
                [
                    new Claim("Jellyfin-UserId", user.Id.ToString()),
                    new Claim(ClaimTypes.Role, "Administrator"),
                ],
                "TestAuth",
                ClaimTypes.Name,
                ClaimTypes.Role)),
            },
        };

        var result = await controller.ItemStatus(itemId.ToString("N"), CancellationToken.None);

        var dto = Assert.IsType<MaintainerrUserItemStatusResponse>(
            Assert.IsType<OkObjectResult>(result).Value);
        Assert.True(dto.ProtectedFromCleanup);
        Assert.False(dto.ManuallyManaged);
        Assert.Equal(MaintainerrCallerRole.RegularUser, maintainerr.LastRole);
        Assert.Null(maintainerr.LastCurrentJellyfinUrl);
        Assert.Equal(1, library.GetItemByIdUserCallCount);
    }

    [Fact]
    public async Task ItemStatus_RegularUserOptInOff_DeniesBeforeLibraryOrUpstream()
    {
        var user = new User("regular-user", "provider", "password-provider");
        var library = new CountingLibraryManager
        {
            GetItemByIdUserHook = (_, _) =>
                throw new InvalidOperationException("library must not be queried"),
        };
        var maintainerr = new RecordingMaintainerrClient();
        var controller = CreateController(
            user,
            new PluginConfiguration
            {
                MaintainerrEnabled = true,
                MaintainerrUrl = "http://127.0.0.1:6246",
                MaintainerrItemStatusEnabled = true,
                MaintainerrItemStatusForUsers = false,
            },
            maintainerr,
            library);

        var result = await controller.ItemStatus(Guid.NewGuid().ToString("N"), CancellationToken.None);

        Assert.IsType<ForbidResult>(result);
        Assert.Equal(0, library.GetItemByIdUserCallCount);
        Assert.Equal(0, maintainerr.ItemStatusCallCount);
    }

    [Theory]
    [InlineData("malformed")]
    [InlineData("inaccessible")]
    [InlineData("unsupported")]
    public async Task ItemStatus_RegularUserInvalidOrInaccessibleItem_IsIndistinguishableNotFound(
        string scenario)
    {
        var user = new User("regular-user", "provider", "password-provider");
        var itemId = Guid.NewGuid();
        var library = new CountingLibraryManager
        {
            GetItemByIdUserHook = (_, _) => scenario switch
            {
                "unsupported" => new BoxSet { Id = itemId },
                _ => null,
            },
        };
        var maintainerr = new RecordingMaintainerrClient();
        var controller = CreateRegularUserController(user, maintainerr, library);
        var routeValue = scenario == "malformed"
            ? "not-a-jellyfin-item-id"
            : itemId.ToString("N");

        var result = await controller.ItemStatus(routeValue, CancellationToken.None);

        Assert.IsType<NotFoundResult>(result);
        Assert.Equal(scenario == "malformed" ? 0 : 1, library.GetItemByIdUserCallCount);
        Assert.Equal(0, maintainerr.ItemStatusCallCount);
    }

    [Theory]
    [InlineData(MaintainerrErrorCode.Disabled)]
    [InlineData(MaintainerrErrorCode.InvalidConfiguration)]
    [InlineData(MaintainerrErrorCode.BlockedTarget)]
    [InlineData(MaintainerrErrorCode.Timeout)]
    [InlineData(MaintainerrErrorCode.Canceled)]
    [InlineData(MaintainerrErrorCode.Redirect)]
    [InlineData(MaintainerrErrorCode.WrongService)]
    [InlineData(MaintainerrErrorCode.NotReady)]
    [InlineData(MaintainerrErrorCode.Throttled)]
    [InlineData(MaintainerrErrorCode.MalformedResponse)]
    [InlineData(MaintainerrErrorCode.ResponseTooLarge)]
    [InlineData(MaintainerrErrorCode.TooLarge)]
    [InlineData(MaintainerrErrorCode.Unsupported)]
    [InlineData(MaintainerrErrorCode.UpstreamError)]
    [InlineData(MaintainerrErrorCode.IdentityMismatch)]
    [InlineData(MaintainerrErrorCode.ConfigurationChanged)]
    public async Task ItemStatus_RegularUserFailure_CollapsesToExactUnavailableEnvelope(
        MaintainerrErrorCode error)
    {
        var user = new User("regular-user", "provider", "password-provider");
        var itemId = Guid.NewGuid();
        var library = new CountingLibraryManager
        {
            GetItemByIdUserHook = (id, scopedUser) =>
                id == itemId && ReferenceEquals(scopedUser, user)
                    ? new Movie { Id = itemId }
                    : null,
        };
        var maintainerr = new RecordingMaintainerrClient
        {
            ItemStatusResult =
                MaintainerrClientResult<MaintainerrAdminItemStatusResponse>.Failure(error, 418),
        };
        var controller = CreateRegularUserController(user, maintainerr, library);

        var result = await controller.ItemStatus(itemId.ToString("N"), CancellationToken.None);

        var objectResult = Assert.IsType<ObjectResult>(result);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, objectResult.StatusCode);
        var envelope = Assert.IsType<MaintainerrErrorResponse>(objectResult.Value);
        Assert.Equal("unavailable", envelope.Error);
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(envelope));
        Assert.Equal(
            new[] { "error" },
            document.RootElement.EnumerateObject()
                .Select(property => property.Name)
                .ToArray());
        Assert.Equal(1, maintainerr.ItemStatusCallCount);
        Assert.Equal(MaintainerrCallerRole.RegularUser, maintainerr.LastRole);
        Assert.Null(maintainerr.LastCurrentJellyfinUrl);
    }

    [Fact]
    public async Task ItemStatus_AdminSuccess_RetainsAdminDtoAndResolvedJellyfinUrl()
    {
        var user = new User("admin-user", "provider", "password-provider");
        user.SetPermission(PermissionKind.IsAdministrator, true);
        var itemId = Guid.NewGuid();
        var library = new CountingLibraryManager
        {
            GetItemByIdUserHook = (id, scopedUser) =>
                id == itemId && ReferenceEquals(scopedUser, user)
                    ? new Movie { Id = itemId }
                    : null,
        };
        var expected = new MaintainerrAdminItemStatusResponse
        {
            ProtectedFromCleanup = true,
            ManuallyManaged = true,
            ExcludedFrom =
            [
                new MaintainerrItemStatusLink
                {
                    Label = "Admin collection",
                    Href = "https://maintainerr.example/collections/7",
                },
            ],
            ManuallyAddedTo =
            [
                new MaintainerrItemStatusLink
                {
                    Label = "Manual collection",
                    Href = "https://maintainerr.example/collections/9",
                },
            ],
        };
        var maintainerr = new RecordingMaintainerrClient
        {
            ItemStatusResult =
                MaintainerrClientResult<MaintainerrAdminItemStatusResponse>.Success(expected),
        };
        var controller = CreateController(
            user,
            new PluginConfiguration
            {
                MaintainerrItemStatusForUsers = false,
            },
            maintainerr,
            library);
        controller.Request.Scheme = Uri.UriSchemeHttps;
        controller.Request.Host = new HostString("jellyfin.example", 8920);
        controller.Request.PathBase = "/jellyfin";

        var result = await controller.ItemStatus(itemId.ToString("N"), CancellationToken.None);

        var actual = Assert.IsType<MaintainerrAdminItemStatusResponse>(
            Assert.IsType<OkObjectResult>(result).Value);
        Assert.Same(expected, actual);
        Assert.Equal("Admin collection", Assert.Single(actual.ExcludedFrom).Label);
        Assert.Equal("Manual collection", Assert.Single(actual.ManuallyAddedTo).Label);
        Assert.Equal(1, maintainerr.ItemStatusCallCount);
        Assert.Equal(MaintainerrCallerRole.Administrator, maintainerr.LastRole);
        Assert.Equal("https://jellyfin.example:8920/jellyfin", maintainerr.LastCurrentJellyfinUrl);
    }

    [Fact]
    public async Task Dashboard_AdmissionOverflowUsesBoundedRetryTaxonomy()
    {
        var maintainerr = new RecordingMaintainerrClient
        {
            DashboardResult =
                MaintainerrClientResult<MaintainerrDashboardResponse>.Failure(
                    MaintainerrErrorCode.Throttled),
        };
        var controller = CreateController(
            new User("admin-user", "provider", "password-provider"),
            new PluginConfiguration(),
            maintainerr,
            new CountingLibraryManager());

        var result = await controller.Dashboard(
            refresh: false,
            cancellationToken: CancellationToken.None);

        var objectResult = Assert.IsType<ObjectResult>(result);
        Assert.Equal(StatusCodes.Status429TooManyRequests, objectResult.StatusCode);
        Assert.Equal(
            "throttled",
            Assert.IsType<MaintainerrErrorResponse>(objectResult.Value).Error);
        Assert.Equal("2", controller.Response.Headers.RetryAfter);
    }

    private static MethodInfo Method(string name)
        => typeof(MaintainerrController).GetMethod(name)
            ?? throw new InvalidOperationException($"Missing Maintainerr controller action {name}.");

    private static MaintainerrController CreateRegularUserController(
        User user,
        RecordingMaintainerrClient maintainerr,
        CountingLibraryManager library)
        => CreateController(
            user,
            new PluginConfiguration
            {
                MaintainerrEnabled = true,
                MaintainerrUrl = "http://127.0.0.1:6246",
                MaintainerrItemStatusEnabled = true,
                MaintainerrItemStatusForUsers = true,
            },
            maintainerr,
            library);

    private static MaintainerrController CreateController(
        User user,
        PluginConfiguration configuration,
        RecordingMaintainerrClient maintainerr,
        CountingLibraryManager library)
    {
        var configProvider = new FakePluginConfigProvider(configuration);
        var controller = new MaintainerrController(
            new RecordingHttpClientFactory(new RecordingHttpMessageHandler()),
            NullLogger<MaintainerrController>.Instance,
            new StubUserManager(user),
            new SeerrCache(configProvider),
            configProvider,
            maintainerr,
            library);
        controller.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity(
                [
                    new Claim("Jellyfin-UserId", user.Id.ToString()),
                ],
                "TestAuth")),
            },
        };
        return controller;
    }

    private sealed class RecordingMaintainerrClient : IMaintainerrClient
    {
        public int ItemStatusCallCount { get; private set; }

        public MaintainerrCallerRole? LastRole { get; private set; }

        public string? LastCurrentJellyfinUrl { get; private set; }

        public MaintainerrClientResult<MaintainerrAdminItemStatusResponse> ItemStatusResult { get; set; }
            = MaintainerrClientResult<MaintainerrAdminItemStatusResponse>.Success(
                new MaintainerrAdminItemStatusResponse
                {
                    ProtectedFromCleanup = true,
                    ManuallyManaged = false,
                    ExcludedFrom =
                    [
                        new MaintainerrItemStatusLink
                        {
                            Label = "admin-only-label",
                            Href = "https://maintainerr.example/collections/1",
                        },
                    ],
                });

        public MaintainerrClientResult<MaintainerrDashboardResponse> DashboardResult { get; set; }
            = MaintainerrClientResult<MaintainerrDashboardResponse>.Failure(
                MaintainerrErrorCode.Disabled);

        public Task<MaintainerrClientResult<MaintainerrAdminItemStatusResponse>> GetItemStatusAsync(
            string jellyfinItemId,
            MaintainerrCallerRole callerRole,
            string? currentJellyfinUrl,
            CancellationToken cancellationToken)
        {
            ItemStatusCallCount++;
            LastRole = callerRole;
            LastCurrentJellyfinUrl = currentJellyfinUrl;
            return Task.FromResult(ItemStatusResult);
        }

        public Task<MaintainerrClientResult<MaintainerrTestResponse>> TestAsync(
            string candidateUrl,
            CancellationToken cancellationToken)
            => throw new NotImplementedException();

        public Task<MaintainerrClientResult<MaintainerrDashboardResponse>> GetDashboardAsync(
            string? currentJellyfinUrl,
            bool forceRefresh,
            CancellationToken cancellationToken)
            => Task.FromResult(DashboardResult);

        public Task<MaintainerrClientResult<MaintainerrCollectionContentResponse>> GetCollectionContentAsync(
            int collectionId,
            int page,
            int size,
            string sort,
            string sortOrder,
            CancellationToken cancellationToken)
            => throw new NotImplementedException();
    }
}
