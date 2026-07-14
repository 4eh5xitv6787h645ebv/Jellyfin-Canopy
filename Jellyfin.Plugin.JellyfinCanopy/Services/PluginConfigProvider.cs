using Jellyfin.Plugin.JellyfinCanopy.Configuration;

namespace Jellyfin.Plugin.JellyfinCanopy.Services
{
    /// <summary>
    /// Default <see cref="IPluginConfigProvider"/> backed by the plugin
    /// singleton. Reads <c>JellyfinCanopy.Instance</c> live on every access —
    /// deliberately NOT cached, so configuration saved from the admin dashboard
    /// (which replaces the plugin's Configuration object) is visible immediately.
    /// </summary>
    public sealed class PluginConfigProvider : IPluginConfigProvider
    {
        private readonly object _revisionLock = new();
        private PluginConfiguration? _lastObservedConfiguration;
        private long _configurationRevision;
        private bool _hasObservedConfiguration;

        public PluginConfiguration Configuration => Observe(JellyfinCanopy.Instance!.Configuration)!;

        public PluginConfiguration? ConfigurationOrNull => Observe(JellyfinCanopy.Instance?.Configuration);

        public long ConfigurationRevision
        {
            get
            {
                Observe(JellyfinCanopy.Instance?.Configuration);
                lock (_revisionLock)
                {
                    return _configurationRevision;
                }
            }
        }

        private PluginConfiguration? Observe(PluginConfiguration? configuration)
        {
            lock (_revisionLock)
            {
                if (!_hasObservedConfiguration
                    || !ReferenceEquals(_lastObservedConfiguration, configuration))
                {
                    _lastObservedConfiguration = configuration;
                    _hasObservedConfiguration = true;
                    _configurationRevision++;
                }

                return configuration;
            }
        }
    }
}
