using Jellyfin.Plugin.JellyfinCanopy.Services;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;

internal sealed class StubTagCacheLifecycle : ITagCacheLifecycle
{
    public bool IsReady { get; set; } = true;

    public int ConfigurationChangeCount { get; private set; }

    public void NotifyConfigurationChanged()
        => ConfigurationChangeCount++;
}
