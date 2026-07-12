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
        public PluginConfiguration Configuration => JellyfinCanopy.Instance!.Configuration;

        public PluginConfiguration? ConfigurationOrNull => JellyfinCanopy.Instance?.Configuration;
    }
}
