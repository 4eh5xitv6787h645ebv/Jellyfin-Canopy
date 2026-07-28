using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.Ep00Provider;

/// <summary>EP-00 throwaway spike: a second, independently packaged Jellyfin 12 plugin.</summary>
public class Ep00ProviderPlugin : BasePlugin<BasePluginConfiguration>
{
    public Ep00ProviderPlugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    public static Ep00ProviderPlugin? Instance { get; private set; }

    public override string Name => "EP-00 Spike Provider";

    public override Guid Id => new("b1a7c3d2-4e5f-4a6b-8c9d-0e1f2a3b4c5d");

    public override string Description => "Throwaway EP-00 spike provider plugin.";
}
