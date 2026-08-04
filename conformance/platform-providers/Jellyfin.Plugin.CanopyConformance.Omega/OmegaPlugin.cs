using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.CanopyConformance.Omega;

/// <summary>A no-op independently packaged Jellyfin 12 provider conformance fixture.</summary>
public sealed class OmegaPlugin : BasePlugin<BasePluginConfiguration>
{
    /// <summary>Initializes the fixture through Jellyfin's ordinary plugin constructor.</summary>
    public OmegaPlugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
    }

    /// <inheritdoc />
    public override string Name => "ZZZ Canopy Conformance Omega";

    /// <inheritdoc />
    public override Guid Id => new("0b220000-1111-4222-8333-444455556777");

    /// <inheritdoc />
    public override string Description => "Independent no-op Canopy provider fixture Omega.";
}
