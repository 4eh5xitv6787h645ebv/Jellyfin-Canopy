using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;
using Ep00.Contracts;
using MediaBrowser.Common.Plugins;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Ep00Host;

/// <summary>
/// The EP-00 spike of the EP-04 binding strategy: find the provider plugin through
/// Jellyfin's own plugin manager, resolve its concrete entrypoint Type out of its own
/// AssemblyLoadContext, pull the instance from Jellyfin DI, and invoke it reflectively
/// with strings only.
/// </summary>
public sealed class ProviderBinder
{
    private const string ProviderTypeName = "Jellyfin.Plugin.Ep00Provider.Ep00ProviderEntrypoint";

    private static readonly Guid ProviderPluginId = new("b1a7c3d2-4e5f-4a6b-8c9d-0e1f2a3b4c5d");

    /// <summary>How long a provider gets to observe cancellation before it is declared runaway.</summary>
    private const int GraceAfterDeadlineMs = 250;

    private readonly IPluginManager _pluginManager;
    private readonly IServiceProvider _serviceProvider;
    private readonly ILogger<ProviderBinder> _logger;

    public ProviderBinder(IPluginManager pluginManager, IServiceProvider serviceProvider, ILogger<ProviderBinder> logger)
    {
        _pluginManager = pluginManager;
        _serviceProvider = serviceProvider;
        _logger = logger;
    }

    /// <summary>Enumerates every plugin Jellyfin knows about, with the fields a registry could bind to.</summary>
    public IReadOnlyList<Dictionary<string, object?>> EnumeratePlugins()
    {
        var results = new List<Dictionary<string, object?>>();
        foreach (var plugin in _pluginManager.Plugins)
        {
            var assembly = plugin.Instance?.GetType().Assembly;
            results.Add(new Dictionary<string, object?>
            {
                ["name"] = plugin.Name,
                ["id"] = plugin.Id.ToString("N"),
                ["version"] = plugin.Version?.ToString(),
                ["status"] = plugin.Manifest.Status.ToString(),
                ["path"] = plugin.Path,
                ["dllFiles"] = plugin.DllFiles,
                ["hasInstance"] = plugin.Instance is not null,
                ["assembly"] = assembly?.FullName,
                ["assemblyLocation"] = assembly?.Location,
                ["loadContext"] = assembly is null ? null : AssemblyLoadContext.GetLoadContext(assembly)?.Name,
                ["loadContextIsCollectible"] = assembly is null ? null : AssemblyLoadContext.GetLoadContext(assembly)?.IsCollectible,
                ["loadContextIdentity"] = assembly is null ? null : Describe(AssemblyLoadContext.GetLoadContext(assembly)),
            });
        }

        return results;
    }

    /// <summary>Everything the host can learn about its own load context, for comparison.</summary>
    public Dictionary<string, object?> DescribeSelf()
    {
        var hostAssembly = typeof(ProviderBinder).Assembly;
        var contractsAssembly = typeof(IExtensionProvider).Assembly;
        return new Dictionary<string, object?>
        {
            ["hostAssembly"] = hostAssembly.FullName,
            ["hostLoadContext"] = AssemblyLoadContext.GetLoadContext(hostAssembly)?.Name,
            ["hostLoadContextCollectible"] = AssemblyLoadContext.GetLoadContext(hostAssembly)?.IsCollectible,
            ["contractsAssembly"] = contractsAssembly.FullName,
            ["contractsLocation"] = contractsAssembly.Location,
            ["contractsLoadContext"] = AssemblyLoadContext.GetLoadContext(contractsAssembly)?.Name,
            ["defaultContextName"] = AssemblyLoadContext.Default.Name,
            ["hostLoadContextIdentity"] = Describe(AssemblyLoadContext.GetLoadContext(hostAssembly)),
            ["contractsLoadContextIdentity"] = Describe(AssemblyLoadContext.GetLoadContext(contractsAssembly)),
            ["allLoadContexts"] = AssemblyLoadContext.All.Select(Describe).ToArray(),
        };
    }

    /// <summary>
    /// The type-identity experiment. Locates the provider's own IExtensionProvider type
    /// and reports whether it is reference-equal / assignable to the host's copy.
    /// </summary>
    public Dictionary<string, object?> ProbeTypeIdentity()
    {
        var result = new Dictionary<string, object?>();
        var providerAssembly = FindProviderAssembly(out var diagnostic);
        result["providerAssemblyFound"] = providerAssembly is not null;
        result["diagnostic"] = diagnostic;
        if (providerAssembly is null)
        {
            return result;
        }

        result["providerAssembly"] = providerAssembly.FullName;
        result["providerLoadContext"] = AssemblyLoadContext.GetLoadContext(providerAssembly)?.Name;
        result["providerLoadContextIdentity"] = Describe(AssemblyLoadContext.GetLoadContext(providerAssembly));
        result["hostLoadContextIdentity"] = Describe(AssemblyLoadContext.GetLoadContext(typeof(ProviderBinder).Assembly));
        result["sameLoadContext"] = ReferenceEquals(
            AssemblyLoadContext.GetLoadContext(providerAssembly),
            AssemblyLoadContext.GetLoadContext(typeof(ProviderBinder).Assembly));

        var providerEntryType = providerAssembly.GetType(ProviderTypeName);
        result["providerEntrypointResolved"] = providerEntryType is not null;
        if (providerEntryType is null)
        {
            return result;
        }

        // The provider's copy of the "shared" contract interface.
        var providerContractType = providerEntryType.GetInterfaces()
            .FirstOrDefault(i => i.FullName == typeof(IExtensionProvider).FullName);
        var hostContractType = typeof(IExtensionProvider);

        // H-1 probe: the provider registers itself against ITS copy of the shared
        // interface. Ask DI for OUR copy of the same interface and record what
        // happens — this is the failure mode the whole ABI decision rests on.
        try
        {
            var byHostInterface = _serviceProvider.GetService(typeof(IExtensionProvider));
            result["resolveByHostOwnedInterface"] = byHostInterface is null ? "null" : byHostInterface.GetType().FullName;
            result["resolveByHostOwnedInterfaceThrew"] = false;
        }
        catch (Exception ex)
        {
            result["resolveByHostOwnedInterfaceThrew"] = true;
            result["resolveByHostOwnedInterfaceError"] = ex.GetType().Name + ": " + ex.Message;
        }

        result["hostContractAssembly"] = hostContractType.Assembly.FullName;
        result["providerContractAssembly"] = providerContractType?.Assembly.FullName;
        result["sameFullName"] = providerContractType?.FullName == hostContractType.FullName;
        result["referenceEqualTypes"] = ReferenceEquals(providerContractType, hostContractType);
        result["hostTypeIsAssignableFromProviderType"] = hostContractType.IsAssignableFrom(providerEntryType);

        // Resolve the instance from Jellyfin's shared DI container by foreign Type.
        object? instance = null;
        try
        {
            instance = _serviceProvider.GetService(providerEntryType);
        }
        catch (Exception ex)
        {
            result["diResolveError"] = ex.GetType().Name + ": " + ex.Message;
        }

        result["diResolvedInstance"] = instance is not null;
        if (instance is null)
        {
            return result;
        }

        // 1. The unsafe path: cast to the host's own copy of the interface.
        try
        {
            var castVictim = (IExtensionProvider)instance;
            result["directCastSucceeded"] = true;
            result["directCastProviderId"] = castVictim.ProviderId;
        }
        catch (InvalidCastException ex)
        {
            result["directCastSucceeded"] = false;
            result["directCastError"] = ex.Message;
        }

        // 2. The safe path: reflection over a string-in/string-out method.
        try
        {
            var invoke = providerEntryType.GetMethod("Invoke", BindingFlags.Public | BindingFlags.Instance, [typeof(string), typeof(string)]);
            result["reflectiveInvokeFound"] = invoke is not null;
            if (invoke is not null)
            {
                var payload = invoke.Invoke(instance, ["ping", "{\"from\":\"ep00-host\"}"]) as string;
                result["reflectiveInvokeResult"] = payload;
            }
        }
        catch (Exception ex)
        {
            result["reflectiveInvokeError"] = ex.GetType().Name + ": " + ex.Message;
        }

        return result;
    }

    /// <summary>Invokes a provider operation over the string ABI with a host-owned deadline.</summary>
    public async Task<Dictionary<string, object?>> InvokeAsync(string operationId, string requestJson, int deadlineMs, CancellationToken cancellationToken)
    {
        var result = new Dictionary<string, object?> { ["operationId"] = operationId, ["deadlineMs"] = deadlineMs };
        var providerAssembly = FindProviderAssembly(out var diagnostic);
        if (providerAssembly is null)
        {
            result["ok"] = false;
            result["error"] = "provider_absent";
            result["diagnostic"] = diagnostic;
            return result;
        }

        var providerEntryType = providerAssembly.GetType(ProviderTypeName);
        var instance = providerEntryType is null ? null : _serviceProvider.GetService(providerEntryType);
        if (instance is null || providerEntryType is null)
        {
            result["ok"] = false;
            result["error"] = "provider_unresolved";
            return result;
        }

        var method = providerEntryType.GetMethod(
            "InvokeAsync",
            BindingFlags.Public | BindingFlags.Instance,
            [typeof(string), typeof(string), typeof(CancellationToken)]);
        if (method is null)
        {
            result["ok"] = false;
            result["error"] = "provider_entrypoint_missing";
            return result;
        }

        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(deadlineMs);

        var started = System.Diagnostics.Stopwatch.StartNew();
        Task? task = null;
        try
        {
            // Task<string> from a foreign load context is still a Task<string>:
            // System.Private.CoreLib is shared, so the awaitable itself is
            // load-context safe.
            var returned = method.Invoke(instance, [operationId, requestJson, deadline.Token]);
            task = returned as Task;
            if (task is null)
            {
                result["ok"] = false;
                result["error"] = "provider_returned_non_task";
                return result;
            }

            // Wait for the provider's own task. Do NOT race a second timer against
            // it: the linked source already cancels at the deadline, so racing a
            // Task.Delay of the same duration collapses "provider cooperated" and
            // "provider ran away" into one indistinguishable outcome, leaks a timer
            // per call, and misreports a client abort as a deadline breach.
            // The grace window is how long a cooperating provider gets to notice.
            await task.WaitAsync(TimeSpan.FromMilliseconds(deadlineMs + GraceAfterDeadlineMs), CancellationToken.None)
                .ConfigureAwait(false);
        }
        catch (TimeoutException)
        {
            result["ok"] = false;
            result["error"] = "provider_deadline_exceeded";
            result["elapsedMs"] = started.ElapsedMilliseconds;
            result["note"] = "Provider ignored cancellation; its Task is still running in-process and cannot be killed.";
            return result;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // The CALLER went away. This is not the provider's fault and must never
            // be attributed to it, or client aborts would trip its circuit breaker.
            result["ok"] = false;
            result["error"] = "caller_cancelled";
            result["elapsedMs"] = started.ElapsedMilliseconds;
            return result;
        }
        catch (OperationCanceledException)
        {
            result["ok"] = false;
            result["error"] = "provider_cancelled";
            result["elapsedMs"] = started.ElapsedMilliseconds;
            result["note"] = "Provider observed cancellation at the deadline and stopped.";
            return result;
        }
        catch (TargetInvocationException ex)
        {
            result["ok"] = false;
            result["error"] = "provider_faulted";
            result["detail"] = ex.InnerException?.GetType().Name + ": " + ex.InnerException?.Message;
            result["elapsedMs"] = started.ElapsedMilliseconds;
            return result;
        }
        catch (Exception ex)
        {
            result["ok"] = false;
            result["error"] = "provider_faulted";
            result["detail"] = ex.GetType().Name + ": " + ex.Message;
            result["elapsedMs"] = started.ElapsedMilliseconds;
            return result;
        }

        try
        {
            var payload = task.GetType().GetProperty("Result")?.GetValue(task) as string;
            result["elapsedMs"] = started.ElapsedMilliseconds;
            result["responseChars"] = payload?.Length ?? 0;

            if (payload is null)
            {
                result["ok"] = false;
                result["error"] = "provider_returned_null";
                return result;
            }

            // Validate before letting a provider response leave the boundary.
            try
            {
                using var _ = JsonDocument.Parse(payload);
                result["ok"] = true;
                result["responsePreview"] = payload.Length > 256 ? payload[..256] + "\u2026" : payload;
            }
            catch (JsonException ex)
            {
                result["ok"] = false;
                result["error"] = "provider_response_invalid_json";
                result["detail"] = ex.Message;
            }

            return result;
        }
        catch (Exception ex)
        {
            result["ok"] = false;
            result["error"] = "provider_faulted";
            result["detail"] = ex.GetType().Name + ": " + ex.Message;
            return result;
        }
    }

    /// <summary>Stable per-process identity for a load context, so two probes can be compared.</summary>
    private static string? Describe(AssemblyLoadContext? context) => context is null
        ? null
        : System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(context).ToString(System.Globalization.CultureInfo.InvariantCulture)
          + " name=" + (context.Name ?? "<null>")
          + " collectible=" + context.IsCollectible.ToString();

    private Assembly? FindProviderAssembly(out string diagnostic)
    {
        // Bind by GUID, never by display name: the name is mutable, is what Jellyfin
        // sorts load order on, and is attacker-influenced for a third-party plugin.
        var provider = _pluginManager.Plugins.FirstOrDefault(p => p.Id == ProviderPluginId);
        if (provider is null)
        {
            diagnostic = "no plugin with GUID " + ProviderPluginId.ToString("D") + " in IPluginManager.Plugins";
            return null;
        }

        if (provider.Manifest.Status != MediaBrowser.Model.Plugins.PluginStatus.Active)
        {
            diagnostic = $"provider present but status={provider.Manifest.Status}";
            return null;
        }

        var assembly = provider.Instance?.GetType().Assembly;
        if (assembly is null)
        {
            diagnostic = "provider manifest present but no live Instance (not loaded into a context)";
            return null;
        }

        diagnostic = "ok";
        _logger.LogDebug("EP-00 spike bound provider assembly {Assembly}", assembly.FullName);
        return assembly;
    }
}
