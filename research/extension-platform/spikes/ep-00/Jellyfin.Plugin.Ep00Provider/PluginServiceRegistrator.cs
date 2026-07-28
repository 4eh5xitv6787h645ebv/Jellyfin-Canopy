using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.Ep00Provider;

public class PluginServiceRegistrator : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        // Registered by CONCRETE type. An EP-04 host resolves this type by name from
        // the provider's own assembly; it never asks for a host-owned interface.
        serviceCollection.AddSingleton<Ep00ProviderEntrypoint>();

        // ALSO registered against the provider's OWN copy of the "shared" contract
        // interface. This is what an author would write if they believed the
        // contract assembly were shared. The host asking for ITS copy of the same
        // interface must then be shown to get null, silently.
        serviceCollection.AddSingleton<Ep00.Contracts.IExtensionProvider>(
            sp => sp.GetRequiredService<Ep00ProviderEntrypoint>());
    }
}
