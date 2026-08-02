using System.Reflection;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using MediaBrowser.Common.Api;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers;

public sealed class ServiceDiscoveryControllerContractTests
{
    [Fact]
    public void RouteAndAuthorization_ArePinnedToReviewedContract()
    {
        Assert.Equal(
            "JellyfinCanopy",
            typeof(ServiceDiscoveryController).GetCustomAttribute<RouteAttribute>()?.Template);

        var discover = typeof(ServiceDiscoveryController)
            .GetMethod(nameof(ServiceDiscoveryController.Discover))!;

        // POST (a scan performs network probes; never cacheable/prefetchable)
        // and admin-only with a bare 401/403 for everyone else.
        Assert.Equal("services/discover", discover.GetCustomAttribute<HttpPostAttribute>()?.Template);
        Assert.Equal(
            Policies.RequiresElevation,
            discover.GetCustomAttribute<AuthorizeAttribute>()?.Policy);
    }
}
