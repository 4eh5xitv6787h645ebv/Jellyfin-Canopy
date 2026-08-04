using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting.Jellyfin
{
    /// <summary>
    /// Lazily joins an exact registry-approved plugin id to its live foreign concrete
    /// entrypoint in Jellyfin's shared service container. It never loads an assembly,
    /// follows a path, or invokes the provider operation.
    /// </summary>
    internal sealed class JellyfinPlatformProviderBindingHost : IPlatformProviderBindingHost
    {
        private readonly Func<IEnumerable<LocalPlugin>> _installed;
        private readonly Func<Type, object?> _resolve;

        public JellyfinPlatformProviderBindingHost(
            IPluginManager pluginManager,
            IServiceProvider serviceProvider)
            : this(
                () => pluginManager.Plugins,
                serviceProvider.GetService)
        {
        }

        internal JellyfinPlatformProviderBindingHost(
            Func<IEnumerable<LocalPlugin>> installed,
            Func<Type, object?> resolve)
        {
            ArgumentNullException.ThrowIfNull(installed);
            ArgumentNullException.ThrowIfNull(resolve);
            _installed = installed;
            _resolve = resolve;
        }

        public PlatformProviderHostBindingResult Bind(PlatformProviderHostBindingRequest request)
        {
            try
            {
                var matches = _installed()
                    .Where(candidate => candidate.Id == request.PluginId)
                    .Take(2)
                    .ToList();
                if (matches.Count == 0)
                {
                    return Rejected(PlatformProviderHostBindingStatus.ProviderAbsent);
                }

                if (matches.Count != 1)
                {
                    return Rejected(PlatformProviderHostBindingStatus.HostIdentityChanged);
                }

                var plugin = matches[0];
                if (plugin.Manifest.Status != PluginStatus.Active)
                {
                    return Rejected(PlatformProviderHostBindingStatus.ProviderNotActive);
                }

                if (plugin.Version is null || plugin.Version != request.HostVersion)
                {
                    return Rejected(PlatformProviderHostBindingStatus.HostIdentityChanged);
                }

                var pluginInstance = plugin.Instance;
                if (pluginInstance is null)
                {
                    return Rejected(PlatformProviderHostBindingStatus.ProviderInstanceUnavailable);
                }

                var assembly = pluginInstance.GetType().Assembly;
                var entrypointType = assembly.GetType(
                    PlatformProviderAbiContract.EntrypointTypeName,
                    throwOnError: false,
                    ignoreCase: false);
                if (entrypointType is null)
                {
                    return Rejected(PlatformProviderHostBindingStatus.EntrypointMissing);
                }

                if (!TryResolveInvocationMethod(entrypointType, out var invocationMethod))
                {
                    return Rejected(PlatformProviderHostBindingStatus.AbiMismatch);
                }

                object? entrypoint;
                try
                {
                    entrypoint = _resolve(entrypointType);
                }
                catch (Exception)
                {
                    return Rejected(PlatformProviderHostBindingStatus.ServiceResolutionFailed);
                }

                if (entrypoint is null)
                {
                    return Rejected(PlatformProviderHostBindingStatus.ServiceUnavailable);
                }

                if (entrypoint.GetType() != entrypointType)
                {
                    return Rejected(PlatformProviderHostBindingStatus.ServiceResolutionFailed);
                }

                var binding = new PlatformProviderForeignEntrypoint(
                        assembly,
                        pluginInstance,
                        entrypointType,
                        entrypoint,
                        invocationMethod!);
                var revalidation = Revalidate(request, binding);
                return revalidation == PlatformProviderHostBindingStatus.Bound
                    ? PlatformProviderHostBindingResult.Bound(binding)
                    : Rejected(revalidation);
            }
            catch (Exception)
            {
                return Rejected(PlatformProviderHostBindingStatus.BindingFailed);
            }
        }

        public PlatformProviderHostBindingStatus Revalidate(
            PlatformProviderHostBindingRequest request,
            PlatformProviderForeignEntrypoint binding)
        {
            ArgumentNullException.ThrowIfNull(binding);
            try
            {
                var matches = _installed()
                    .Where(candidate => candidate.Id == request.PluginId)
                    .Take(2)
                    .ToList();
                if (matches.Count == 0)
                {
                    return PlatformProviderHostBindingStatus.ProviderAbsent;
                }

                if (matches.Count != 1)
                {
                    return PlatformProviderHostBindingStatus.HostIdentityChanged;
                }

                var plugin = matches[0];
                if (plugin.Manifest.Status != PluginStatus.Active)
                {
                    return PlatformProviderHostBindingStatus.ProviderNotActive;
                }

                if (plugin.Version is null || plugin.Version != request.HostVersion)
                {
                    return PlatformProviderHostBindingStatus.HostIdentityChanged;
                }

                var pluginInstance = plugin.Instance;
                if (pluginInstance is null)
                {
                    return PlatformProviderHostBindingStatus.ProviderInstanceUnavailable;
                }

                return binding.IsBoundToHostPluginInstance(pluginInstance)
                    && ReferenceEquals(pluginInstance.GetType().Assembly, binding.Assembly)
                    ? PlatformProviderHostBindingStatus.Bound
                    : PlatformProviderHostBindingStatus.HostIdentityChanged;
            }
            catch (Exception)
            {
                return PlatformProviderHostBindingStatus.BindingFailed;
            }
        }

        internal static bool TryResolveInvocationMethod(
            Type entrypointType,
            out MethodInfo? invocationMethod)
        {
            ArgumentNullException.ThrowIfNull(entrypointType);
            invocationMethod = null;
            if (!entrypointType.IsClass
                || entrypointType.IsAbstract
                || entrypointType.IsGenericTypeDefinition
                || !(entrypointType.IsPublic || entrypointType.IsNestedPublic))
            {
                return false;
            }

            var candidates = entrypointType
                .GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)
                .Where(method => string.Equals(
                    method.Name,
                    PlatformProviderAbiContract.InvocationMethodName,
                    StringComparison.Ordinal))
                .ToArray();
            if (candidates.Length != 1)
            {
                return false;
            }

            var allNamedCandidates = entrypointType
                .GetMethods(BindingFlags.Public | BindingFlags.Instance)
                .Count(method => string.Equals(
                    method.Name,
                    PlatformProviderAbiContract.InvocationMethodName,
                    StringComparison.Ordinal));
            if (allNamedCandidates != 1)
            {
                return false;
            }

            var method = candidates[0];
            var callingConvention = method.CallingConvention;
            if (method.IsStatic
                || method.IsGenericMethod
                || method.IsGenericMethodDefinition
                || (callingConvention & CallingConventions.Any) != CallingConventions.Standard
                || (callingConvention & CallingConventions.HasThis) == 0
                || (callingConvention & CallingConventions.ExplicitThis) != 0
                || method.ReturnType != typeof(Task<string>))
            {
                return false;
            }

            var parameters = method.GetParameters();
            if (parameters.Length != 3
                || parameters[0].ParameterType != typeof(string)
                || parameters[1].ParameterType != typeof(string)
                || parameters[2].ParameterType != typeof(CancellationToken)
                || parameters.Any(parameter =>
                    parameter.IsOut
                    || parameter.ParameterType.IsByRef
                    || parameter.IsOptional
                    || parameter.GetCustomAttribute<ParamArrayAttribute>() is not null))
            {
                return false;
            }

            invocationMethod = method;
            return true;
        }

        private static PlatformProviderHostBindingResult Rejected(
            PlatformProviderHostBindingStatus status) =>
            PlatformProviderHostBindingResult.Rejected(status);

    }
}
