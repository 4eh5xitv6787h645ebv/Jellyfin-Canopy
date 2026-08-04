using System;
using System.Reflection;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting
{
    /// <summary>Closed host-adapter outcomes for lazy foreign provider binding.</summary>
    internal enum PlatformProviderHostBindingStatus
    {
        Bound = 1,
        ProviderAbsent = 2,
        ProviderNotActive = 3,
        HostIdentityChanged = 4,
        ProviderInstanceUnavailable = 5,
        EntrypointMissing = 6,
        AbiMismatch = 7,
        ServiceUnavailable = 8,
        ServiceResolutionFailed = 9,
        BindingFailed = 10,
    }

    /// <summary>
    /// Exact inert registry facts the Jellyfin adapter must re-observe before it may
    /// resolve a foreign concrete service. No caller-selected CLR selector crosses here.
    /// </summary>
    internal readonly record struct PlatformProviderHostBindingRequest
    {
        internal PlatformProviderHostBindingRequest(Guid pluginId, Version hostVersion)
        {
            if (pluginId == Guid.Empty)
            {
                throw new ArgumentException("A provider plugin id cannot be empty.", nameof(pluginId));
            }

            ArgumentNullException.ThrowIfNull(hostVersion);
            PluginId = pluginId;
            HostVersion = new Version(hostVersion.ToString());
        }

        internal Guid PluginId { get; }

        internal Version HostVersion { get; }
    }

    /// <summary>
    /// One ephemeral foreign concrete binding. The BCL reflection objects are safe across
    /// load contexts; no Canopy model or interface is implemented by the provider.
    /// </summary>
    internal sealed class PlatformProviderForeignEntrypoint
    {
        internal PlatformProviderForeignEntrypoint(
            Assembly assembly,
            object hostPluginInstance,
            Type entrypointType,
            object instance,
            MethodInfo invocationMethod)
        {
            ArgumentNullException.ThrowIfNull(assembly);
            ArgumentNullException.ThrowIfNull(hostPluginInstance);
            ArgumentNullException.ThrowIfNull(entrypointType);
            ArgumentNullException.ThrowIfNull(instance);
            ArgumentNullException.ThrowIfNull(invocationMethod);
            if (!ReferenceEquals(hostPluginInstance.GetType().Assembly, assembly)
                || !ReferenceEquals(entrypointType.Assembly, assembly)
                || instance.GetType() != entrypointType
                || !ReferenceEquals(invocationMethod.DeclaringType, entrypointType))
            {
                throw new ArgumentException("The foreign entrypoint binding is inconsistent.");
            }

            Assembly = assembly;
            EntrypointType = entrypointType;
            Instance = instance;
            InvocationMethod = invocationMethod;
            _hostPluginInstance = hostPluginInstance;
        }

        internal Assembly Assembly { get; }

        internal Type EntrypointType { get; }

        internal object Instance { get; }

        internal MethodInfo InvocationMethod { get; }

        private readonly object _hostPluginInstance;

        internal bool IsBoundToHostPluginInstance(object instance) =>
            ReferenceEquals(_hostPluginInstance, instance);
    }

    /// <summary>One redaction-safe result from the Jellyfin binding adapter.</summary>
    internal readonly record struct PlatformProviderHostBindingResult
    {
        private PlatformProviderHostBindingResult(
            PlatformProviderHostBindingStatus status,
            PlatformProviderForeignEntrypoint? binding)
        {
            if (!Enum.IsDefined(status)
                || (status == PlatformProviderHostBindingStatus.Bound) != (binding is not null))
            {
                throw new ArgumentException("The provider host binding result is inconsistent.", nameof(status));
            }

            Status = status;
            Binding = binding;
        }

        internal PlatformProviderHostBindingStatus Status { get; }

        internal PlatformProviderForeignEntrypoint? Binding { get; }

        internal static PlatformProviderHostBindingResult Bound(PlatformProviderForeignEntrypoint binding) =>
            new(PlatformProviderHostBindingStatus.Bound, binding);

        internal static PlatformProviderHostBindingResult Rejected(PlatformProviderHostBindingStatus status) =>
            new(status, null);
    }

    /// <summary>
    /// Host-neutral seam for the only production owner allowed to inspect a live Jellyfin
    /// plugin instance and resolve its foreign concrete entrypoint from shared DI.
    /// </summary>
    internal interface IPlatformProviderBindingHost
    {
        PlatformProviderHostBindingResult Bind(PlatformProviderHostBindingRequest request);

        PlatformProviderHostBindingStatus Revalidate(
            PlatformProviderHostBindingRequest request,
            PlatformProviderForeignEntrypoint binding);
    }
}
