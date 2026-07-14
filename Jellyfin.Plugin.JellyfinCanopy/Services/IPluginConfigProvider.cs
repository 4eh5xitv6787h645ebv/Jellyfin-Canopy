using Jellyfin.Plugin.JellyfinCanopy.Configuration;

namespace Jellyfin.Plugin.JellyfinCanopy.Services
{
    /// <summary>
    /// Injectable seam over the plugin's live configuration, replacing scattered
    /// static <c>JellyfinCanopy.Instance?.Configuration</c> reads so consumers
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
        /// the plugin isn't loaded (mirrors <c>JellyfinCanopy.Instance?.Configuration</c>).
        /// </summary>
        PluginConfiguration? ConfigurationOrNull { get; }

        /// <summary>
        /// Monotonic process-local revision of the live configuration object.
        /// Every observed object replacement increments it, even if a later
        /// save restores byte-for-byte identical settings. Mutation pipelines
        /// use this to detect A→B→A changes across awaited preparation work.
        /// </summary>
        long ConfigurationRevision { get; }
    }
}
