using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.CanopyConformance.Alpha;

/// <summary>Registers the fixture entrypoint by its foreign concrete type only.</summary>
public sealed class AlphaPluginServiceRegistrator : IPluginServiceRegistrator
{
    /// <inheritdoc />
    public void RegisterServices(
        IServiceCollection serviceCollection,
        IServerApplicationHost applicationHost)
    {
        ArgumentNullException.ThrowIfNull(serviceCollection);
        ArgumentNullException.ThrowIfNull(applicationHost);
        serviceCollection.AddSingleton<global::JellyfinCanopy.ExtensionProviderEntrypoint>();
    }
}
