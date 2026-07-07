using Jellyfin.Plugin.JellyfinElevate.Configuration;
using Jellyfin.Plugin.JellyfinElevate.Services;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.TestDoubles;

/// <summary>
/// Test double for <see cref="IPluginConfigProvider"/>. The Current property is
/// mutable so tests can prove consumers re-read configuration live per access
/// (the seam's core contract) instead of snapshotting it.
/// </summary>
public sealed class FakePluginConfigProvider : IPluginConfigProvider
{
    public FakePluginConfigProvider(PluginConfiguration? config = null)
    {
        Current = config;
    }

    /// <summary>The configuration returned on every access; null simulates "plugin not loaded".</summary>
    public PluginConfiguration? Current { get; set; }

    public PluginConfiguration Configuration =>
        Current ?? throw new InvalidOperationException("Plugin configuration not available (simulated unloaded plugin).");

    public PluginConfiguration? ConfigurationOrNull => Current;
}
