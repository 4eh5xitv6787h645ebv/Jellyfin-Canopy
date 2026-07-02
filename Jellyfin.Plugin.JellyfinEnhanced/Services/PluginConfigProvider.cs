using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Default <see cref="IPluginConfigProvider"/> backed by the plugin
    /// singleton. Reads <c>JellyfinEnhanced.Instance</c> live on every access —
    /// deliberately NOT cached, so configuration saved from the admin dashboard
    /// (which replaces the plugin's Configuration object) is visible immediately.
    /// </summary>
    public sealed class PluginConfigProvider : IPluginConfigProvider
    {
        public PluginConfiguration Configuration => JellyfinEnhanced.Instance!.Configuration;

        public PluginConfiguration? ConfigurationOrNull => JellyfinEnhanced.Instance?.Configuration;
    }
}
