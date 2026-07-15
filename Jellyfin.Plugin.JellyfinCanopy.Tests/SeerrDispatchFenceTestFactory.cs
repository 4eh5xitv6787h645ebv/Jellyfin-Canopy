using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests;

internal static class SeerrDispatchFenceTestFactory
{
    private const string DefaultTestUrls =
        "http://seerr,http://seerr:5055,http://first,http://first:5055," +
        "http://second,http://second:5055,http://only,http://removed:5055," +
        "http://source-a:5055,http://source-b:5055";

    public static SeerrDispatchFence Create(Func<bool>? restriction = null)
    {
        var provider = new FakePluginConfigProvider(new PluginConfiguration
        {
            SeerrEnabled = true,
            SeerrUrls = DefaultTestUrls,
            SeerrApiKey = "key",
        });
        var integration = SeerrIntegrationPolicy.Capture(provider);
        var fence = integration.CreateDispatchFence(provider);
        return restriction == null ? fence : fence.Restrict(restriction);
    }
}
