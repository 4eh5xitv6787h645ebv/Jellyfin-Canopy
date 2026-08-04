using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.CanopyConformance.Alpha;

/// <summary>An independently packaged Jellyfin 12 Hello provider conformance fixture.</summary>
public sealed class AlphaPlugin : BasePlugin<BasePluginConfiguration>
{
    /// <summary>Initializes the fixture through Jellyfin's ordinary plugin constructor.</summary>
    public AlphaPlugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
    }

    /// <inheritdoc />
    public override string Name => "AAA Canopy Conformance Alpha";

    /// <inheritdoc />
    public override Guid Id => new("0a110000-1111-4222-8333-444455556666");

    /// <inheritdoc />
    public override string Description => "Independent deterministic Hello provider fixture Alpha.";
}
