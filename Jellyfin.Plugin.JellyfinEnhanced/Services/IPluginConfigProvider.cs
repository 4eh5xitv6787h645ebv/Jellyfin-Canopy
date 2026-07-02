using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Injectable seam over the plugin's live configuration, replacing scattered
    /// static <c>JellyfinEnhanced.Instance?.Configuration</c> reads so consumers
    /// can be unit-tested with a fake provider.
    ///
    /// Both accessors read the CURRENT configuration on every access (no
    /// snapshotting/caching): admin saves must be picked up instantly, exactly
    /// like the static reads they replace.
    /// </summary>
    public interface IPluginConfigProvider
    {
        /// <summary>
        /// The live plugin configuration. Throws if the plugin instance is not
        /// loaded yet — only use on paths that cannot run before plugin init.
        /// </summary>
        PluginConfiguration Configuration { get; }

        /// <summary>
        /// Null-tolerant accessor for early-startup paths that skip work when
        /// the plugin isn't loaded (mirrors <c>JellyfinEnhanced.Instance?.Configuration</c>).
        /// </summary>
        PluginConfiguration? ConfigurationOrNull { get; }
    }
}
