using Jellyfin.Plugin.JellyfinElevate.Configuration;

namespace Jellyfin.Plugin.JellyfinElevate.Services
{
    /// <summary>
    /// Default <see cref="IPluginConfigProvider"/> backed by the plugin
    /// singleton. Reads <c>JellyfinElevate.Instance</c> live on every access —
    /// deliberately NOT cached, so configuration saved from the admin dashboard
    /// (which replaces the plugin's Configuration object) is visible immediately.
    /// </summary>
    public sealed class PluginConfigProvider : IPluginConfigProvider
    {
        public PluginConfiguration Configuration => JellyfinElevate.Instance!.Configuration;

        public PluginConfiguration? ConfigurationOrNull => JellyfinElevate.Instance?.Configuration;
    }
}
