using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Services;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;

/// <summary>
/// Test double for <see cref="IPluginConfigProvider"/>. The Current property is
/// mutable so tests can prove consumers re-read configuration live per access
/// (the seam's core contract) instead of snapshotting it.
/// </summary>
public sealed class FakePluginConfigProvider : IPluginConfigProvider
{
    private readonly object _revisionLock = new();
    private PluginConfiguration? _current;
    private PluginConfiguration? _lastObserved;
    private long _revision;
    private bool _hasObserved;

    public FakePluginConfigProvider(PluginConfiguration? config = null)
    {
        _current = config;
    }

    /// <summary>The configuration returned on every access; null simulates "plugin not loaded".</summary>
    public PluginConfiguration? Current
    {
        get => _current;
        set => _current = value;
    }

    public PluginConfiguration Configuration =>
        Observe(_current) ?? throw new InvalidOperationException("Plugin configuration not available (simulated unloaded plugin).");

    public PluginConfiguration? ConfigurationOrNull => Observe(_current);

    public long ConfigurationRevision
    {
        get
        {
            Observe(_current);
            lock (_revisionLock)
            {
                return _revision;
            }
        }
    }

    private PluginConfiguration? Observe(PluginConfiguration? configuration)
    {
        lock (_revisionLock)
        {
            if (!_hasObserved || !ReferenceEquals(_lastObserved, configuration))
            {
                _lastObserved = configuration;
                _hasObserved = true;
                _revision++;
            }

            return configuration;
        }
    }
}
