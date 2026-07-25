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

        public PluginConfiguration Configuration =>
            GetSnapshot().Configuration
            ?? throw new InvalidOperationException("Plugin configuration is not available.");

        public PluginConfiguration? ConfigurationOrNull => GetSnapshot().Configuration;

        public long ConfigurationRevision => GetSnapshot().Revision;

        public PluginConfigurationSnapshot GetSnapshot()
        {
            lock (_revisionLock)
            {
                var configuration = JellyfinCanopy.Instance?.Configuration;
                if (!_hasObservedConfiguration
                    || !ReferenceEquals(_lastObservedConfiguration, configuration))
                {
                    _lastObservedConfiguration = configuration;
                    _hasObservedConfiguration = true;
                    _configurationRevision++;
                }

                return new PluginConfigurationSnapshot(
                    configuration,
                    _configurationRevision);
            }
        }
    }
}
