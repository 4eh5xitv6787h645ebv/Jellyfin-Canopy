using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.Ep00Host;

/// <summary>EP-00 throwaway spike: stands in for the Canopy-hosted platform kernel.</summary>
public class Ep00HostPlugin : BasePlugin<BasePluginConfiguration>
{
    public Ep00HostPlugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    public static Ep00HostPlugin? Instance { get; private set; }

    public override string Name => "EP-00 Spike Host";

    public override Guid Id => new("a0b1c2d3-e4f5-4061-8273-8495a6b7c8d9");

    public override string Description => "Throwaway EP-00 spike platform host.";
}
