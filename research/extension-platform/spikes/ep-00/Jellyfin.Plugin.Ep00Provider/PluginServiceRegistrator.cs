using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.Ep00Provider;

public class PluginServiceRegistrator : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        // Registered by CONCRETE type only. An EP-04 host resolves this type by name
        // from the provider's own assembly; it never asks for a host-owned interface.
        serviceCollection.AddSingleton<Ep00ProviderEntrypoint>();
    }
}
