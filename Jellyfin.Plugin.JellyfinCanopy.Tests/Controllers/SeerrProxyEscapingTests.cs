using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers
{
    /// <summary>
    /// CSCTRL-3: the Seerr requests proxy must URL-escape the caller-supplied <c>filter</c> value
    /// before interpolating it into the upstream path, so a crafted filter cannot smuggle extra
    /// query parameters (e.g. <c>all&amp;requestedBy=&lt;id&gt;</c>) into the Seerr request — matching
    /// the sibling issues route.
    /// </summary>
    public class SeerrProxyEscapingTests
    {
        [Fact]
        public void BuildRequestsProxyPath_EscapesFilter_PreventingQueryParamSmuggling()
        {
            var path = JellyseerrProxyController.BuildRequestsProxyPath(500, 0, "all&requestedBy=x");

            // The & and = inside the filter value are percent-encoded, so they stay part of the
            // filter value instead of becoming new upstream query parameters.
            Assert.Equal("/api/v1/request?take=500&skip=0&filter=all%26requestedBy%3Dx", path);
            Assert.DoesNotContain("&requestedBy=x", path);
        }

        [Fact]
        public void BuildRequestsProxyPath_PassesThroughOrdinaryFilter()
        {
            var path = JellyseerrProxyController.BuildRequestsProxyPath(20, 40, "all");

            Assert.Equal("/api/v1/request?take=20&skip=40&filter=all", path);
        }
    }
}
