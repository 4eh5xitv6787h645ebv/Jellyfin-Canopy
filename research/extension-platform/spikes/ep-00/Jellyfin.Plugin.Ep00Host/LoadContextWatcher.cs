using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.Ep00Host;

/// <summary>
/// EP-00.4 probe. Answers one question the original spike could not: when a plugin
/// is disabled or uninstalled on a *running* server, does anything actually go away?
///
/// The contexts report <c>IsCollectible = true</c>, but collectible only means the
/// runtime *may* unload one — it does so when the context is explicitly unloaded and
/// nothing references it any more. Whether Jellyfin ever does that is what this
/// measures, by keeping a weak reference and forcing collection on demand.
/// </summary>
public sealed class LoadContextWatcher
{
    private static readonly Guid ProviderPluginId = new("b1a7c3d2-4e5f-4a6b-8c9d-0e1f2a3b4c5d");

    private readonly IPluginManager _pluginManager;
    private readonly IServiceProvider _serviceProvider;
    private readonly object _gate = new();

    private WeakReference<AssemblyLoadContext>? _providerContext;
    private string? _providerContextIdentity;

    public LoadContextWatcher(IPluginManager pluginManager, IServiceProvider serviceProvider)
    {
        _pluginManager = pluginManager;
        _serviceProvider = serviceProvider;
    }

    /// <summary>
    /// Snapshots what the host can see right now. Call it before a transition, then
    /// again after, without restarting.
    /// </summary>
    /// <param name="collect">Force a blocking collection first, to give a collectible context every chance to go away.</param>
    public Dictionary<string, object?> Snapshot(bool collect)
    {
        if (collect)
        {
            // Two passes with finalizers in between: an unloading context is not
            // reclaimed until its finalizable objects are gone.
            for (var i = 0; i < 3; i++)
            {
                GC.Collect(GC.MaxGeneration, GCCollectionMode.Forced, blocking: true);
                GC.WaitForPendingFinalizers();
            }
        }

        var result = new Dictionary<string, object?>
        {
            ["forcedCollection"] = collect,
            ["totalLoadContexts"] = AssemblyLoadContext.All.Count(),
            ["collectibleLoadContexts"] = AssemblyLoadContext.All.Count(c => c.IsCollectible),
        };

        var provider = _pluginManager.Plugins.FirstOrDefault(p => p.Id == ProviderPluginId);
        result["pluginPresent"] = provider is not null;
        result["pluginStatus"] = provider?.Manifest.Status.ToString();
        result["pluginHasInstance"] = provider?.Instance is not null;

        var assembly = provider?.Instance?.GetType().Assembly;
        result["assemblyLoaded"] = assembly is not null;

        var context = assembly is null ? null : AssemblyLoadContext.GetLoadContext(assembly);
        if (context is not null)
        {
            lock (_gate)
            {
                _providerContext ??= new WeakReference<AssemblyLoadContext>(context);
                _providerContextIdentity ??= Identify(context);
            }

            result["currentProviderContext"] = Identify(context);
        }

        lock (_gate)
        {
            result["firstSeenProviderContext"] = _providerContextIdentity;
            if (_providerContext is null)
            {
                result["firstSeenContextStillAlive"] = null;
            }
            else
            {
                result["firstSeenContextStillAlive"] = _providerContext.TryGetTarget(out var alive);
                result["firstSeenContextAssemblies"] = alive is null ? null : CountAssemblies(alive);
            }
        }

        // The load-bearing question for the platform: can the kernel still resolve and
        // call the provider after the transition, without a restart?
        object? resolved = null;
        if (assembly is not null)
        {
            var type = assembly.GetType("Jellyfin.Plugin.Ep00Provider.Ep00ProviderEntrypoint");
            if (type is not null)
            {
                try
                {
                    resolved = _serviceProvider.GetService(type);
                }
                catch (Exception ex)
                {
                    result["diResolveError"] = ex.GetType().Name;
                }
            }
        }

        result["diStillResolves"] = resolved is not null;
        return result;
    }

    private static int? CountAssemblies(AssemblyLoadContext context)
    {
        try
        {
            return context.Assemblies.Count();
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static string Identify(AssemblyLoadContext context) =>
        RuntimeHelpers.GetHashCode(context).ToString(System.Globalization.CultureInfo.InvariantCulture)
        + " name=" + (context.Name ?? "<null>")
        + " collectible=" + context.IsCollectible.ToString();
}
