using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting.Jellyfin;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    /// <summary>Focused contract tests for lazy foreign concrete-type binding.</summary>
    public sealed class JellyfinPlatformProviderBindingHostTests
    {
        private static readonly Guid ProviderId = new("0a110000-1111-4222-8333-444455556666");
        private static readonly Version ProviderVersion = new(1, 2, 3);

        [Fact]
        public void AbsentProviderIsRejectedWithoutResolvingAService()
        {
            var resolveCalls = 0;
            var result = Host(
                Array.Empty<LocalPlugin>(),
                _ =>
                {
                    resolveCalls++;
                    return null;
                }).Bind(Request());

            AssertRejected(PlatformProviderHostBindingStatus.ProviderAbsent, result);
            Assert.Equal(0, resolveCalls);
        }

        [Theory]
        [InlineData(PluginStatus.Restart)]
        [InlineData(PluginStatus.Disabled)]
        [InlineData(PluginStatus.NotSupported)]
        [InlineData(PluginStatus.Malfunctioned)]
        [InlineData(PluginStatus.Superseded)]
        [InlineData(PluginStatus.Deleted)]
        public void EveryNonActiveHostStatusIsRejectedBeforeServiceResolution(PluginStatus status)
        {
            var resolveCalls = 0;
            var plugin = Plugin(status, new ProviderBindingTestPluginInstance());

            var result = Host(
                new[] { plugin },
                _ =>
                {
                    resolveCalls++;
                    return null;
                }).Bind(Request());

            AssertRejected(PlatformProviderHostBindingStatus.ProviderNotActive, result);
            Assert.Equal(0, resolveCalls);
        }

        [Fact]
        public void DuplicateExactGuidIsRejectedInsteadOfSelectingEitherInstance()
        {
            var first = Plugin(PluginStatus.Active, new ProviderBindingTestPluginInstance());
            var duplicate = Plugin(
                PluginStatus.Active,
                new ProviderBindingTestPluginInstance(),
                id: first.Id);

            var result = Host(new[] { first, duplicate }).Bind(Request(first.Id));

            AssertRejected(PlatformProviderHostBindingStatus.HostIdentityChanged, result);
        }

        [Fact]
        public void ExactGuidIsSelectedWithoutConsultingNamesOrOtherPlugins()
        {
            var foreign = ForeignAssembly(validAbi: true);
            var target = Plugin(PluginStatus.Active, foreign.PluginInstance, name: "mutable name");
            var decoy = Plugin(
                PluginStatus.Active,
                new ProviderBindingTestPluginInstance(),
                id: Guid.NewGuid(),
                name: "mutable name");

            var result = Host(
                new[] { decoy, target },
                type => type == foreign.EntrypointType ? foreign.Entrypoint : null)
                .Bind(Request(target.Id));

            Assert.Equal(PlatformProviderHostBindingStatus.Bound, result.Status);
            Assert.NotNull(result.Binding);
        }

        [Fact]
        public void ExactVersionValueBindsWhileVersionDriftFailsClosed()
        {
            var foreign = ForeignAssembly(validAbi: true);
            var plugin = Plugin(PluginStatus.Active, foreign.PluginInstance);
            var host = Host(new[] { plugin }, _ => foreign.Entrypoint);

            var exact = host.Bind(Request(version: new Version(ProviderVersion.ToString())));
            var drifted = host.Bind(Request(version: new Version(1, 2, 4)));

            Assert.Equal(PlatformProviderHostBindingStatus.Bound, exact.Status);
            AssertRejected(PlatformProviderHostBindingStatus.HostIdentityChanged, drifted);
        }

        [Fact]
        public void MissingLivePluginInstanceIsRejectedBeforeEntrypointInspection()
        {
            var plugin = Plugin(PluginStatus.Active, instance: null);

            var result = Host(new[] { plugin }).Bind(Request());

            AssertRejected(PlatformProviderHostBindingStatus.ProviderInstanceUnavailable, result);
        }

        [Fact]
        public void MissingConventionEntrypointIsDistinctFromAnAbiMismatch()
        {
            var missing = Host(new[]
            {
                Plugin(PluginStatus.Active, new ProviderBindingTestPluginInstance()),
            }).Bind(Request());
            var wrongAbi = ForeignAssembly(validAbi: false);
            var mismatched = Host(new[]
            {
                Plugin(PluginStatus.Active, wrongAbi.PluginInstance),
            }).Bind(Request());

            AssertRejected(PlatformProviderHostBindingStatus.EntrypointMissing, missing);
            AssertRejected(PlatformProviderHostBindingStatus.AbiMismatch, mismatched);
        }

        [Fact]
        public void NullThrowingAndWrongConcreteServiceResolutionFailClosed()
        {
            var foreign = ForeignAssembly(validAbi: true);
            var plugin = Plugin(PluginStatus.Active, foreign.PluginInstance);

            AssertRejected(
                PlatformProviderHostBindingStatus.ServiceUnavailable,
                Host(new[] { plugin }, _ => null).Bind(Request()));
            AssertRejected(
                PlatformProviderHostBindingStatus.ServiceResolutionFailed,
                Host(new[] { plugin }, _ => throw new InvalidOperationException("test resolver fault"))
                    .Bind(Request()));
            AssertRejected(
                PlatformProviderHostBindingStatus.ServiceResolutionFailed,
                Host(new[] { plugin }, _ => new object()).Bind(Request()));
        }

        [Fact]
        public void UnexpectedInventoryFailureMapsToTheClosedBindingFailure()
        {
            var host = new JellyfinPlatformProviderBindingHost(
                () => throw new InvalidOperationException("test inventory fault"),
                _ => throw new InvalidOperationException("must not resolve"));

            AssertRejected(PlatformProviderHostBindingStatus.BindingFailed, host.Bind(Request()));
        }

        [Fact]
        public void ConstructionIsLazyAndEachBindReenumeratesAndResolvesAtMostOnce()
        {
            var inventoryReads = 0;
            var resolutionCalls = 0;
            var foreign = ForeignAssembly(validAbi: true);
            var plugin = Plugin(PluginStatus.Active, foreign.PluginInstance);
            var installed = true;
            var host = new JellyfinPlatformProviderBindingHost(
                () =>
                {
                    inventoryReads++;
                    return installed ? new[] { plugin } : Array.Empty<LocalPlugin>();
                },
                type =>
                {
                    resolutionCalls++;
                    Assert.Same(foreign.EntrypointType, type);
                    return foreign.Entrypoint;
                });

            Assert.Equal(0, inventoryReads);
            Assert.Equal(0, resolutionCalls);

            var first = host.Bind(Request());
            installed = false;
            var second = host.Bind(Request());

            Assert.Equal(PlatformProviderHostBindingStatus.Bound, first.Status);
            AssertRejected(PlatformProviderHostBindingStatus.ProviderAbsent, second);
            Assert.Equal(3, inventoryReads);
            Assert.Equal(1, resolutionCalls);
        }

        [Fact]
        public void InventoryChangeDuringServiceResolutionRejectsTheStaleBinding()
        {
            var foreign = ForeignAssembly(validAbi: true);
            var plugin = Plugin(PluginStatus.Active, foreign.PluginInstance);
            IEnumerable<LocalPlugin> installed = new[] { plugin };
            var host = new JellyfinPlatformProviderBindingHost(
                () => installed,
                _ =>
                {
                    installed = Array.Empty<LocalPlugin>();
                    return foreign.Entrypoint;
                });

            var result = host.Bind(Request());

            AssertRejected(PlatformProviderHostBindingStatus.ProviderAbsent, result);
        }

        [Fact]
        public void ExplicitRevalidationRequiresTheSameLivePluginInstanceAndAssembly()
        {
            var foreign = ForeignAssembly(validAbi: true);
            var plugin = Plugin(PluginStatus.Active, foreign.PluginInstance);
            IEnumerable<LocalPlugin> installed = new[] { plugin };
            var host = Host(
                installed,
                _ => foreign.Entrypoint);
            var bound = Assert.IsType<PlatformProviderForeignEntrypoint>(
                host.Bind(Request()).Binding);

            installed = new[]
            {
                Plugin(PluginStatus.Active, new ProviderBindingTestPluginInstance()),
            };

            Assert.Equal(
                PlatformProviderHostBindingStatus.HostIdentityChanged,
                new JellyfinPlatformProviderBindingHost(
                    () => installed,
                    _ => throw new InvalidOperationException("must not resolve"))
                    .Revalidate(Request(), bound));
        }

        [Fact]
        public void SuccessfulBindingReturnsExactForeignReflectionFactsWithoutInvokingProviderCode()
        {
            ProviderInvocationProbe.Reset();
            var foreign = ForeignAssembly(validAbi: true);
            var plugin = Plugin(PluginStatus.Active, foreign.PluginInstance);

            var result = Host(
                new[] { plugin },
                type => type == foreign.EntrypointType ? foreign.Entrypoint : null)
                .Bind(Request());

            Assert.Equal(PlatformProviderHostBindingStatus.Bound, result.Status);
            var binding = Assert.IsType<PlatformProviderForeignEntrypoint>(result.Binding);
            Assert.Same(foreign.PluginInstance.GetType().Assembly, binding.Assembly);
            Assert.Same(foreign.EntrypointType, binding.EntrypointType);
            Assert.Same(foreign.Entrypoint, binding.Instance);
            Assert.Equal("InvokeAsync", binding.InvocationMethod.Name);
            Assert.Same(foreign.EntrypointType, binding.InvocationMethod.DeclaringType);
            Assert.Equal(0, ProviderInvocationProbe.InvocationCount);
        }

        [Theory]
        [MemberData(nameof(InvocationMethodShapes))]
        public void InvocationMethodResolutionAcceptsOnlyTheExactFrozenAbi(
            Type entrypointType,
            bool expected)
        {
            var accepted = JellyfinPlatformProviderBindingHost.TryResolveInvocationMethod(
                entrypointType,
                out var method);

            Assert.Equal(expected, accepted);
            Assert.Equal(expected, method is not null);
            if (method is not null)
            {
                Assert.Equal("InvokeAsync", method.Name);
                Assert.Equal(typeof(Task<string>), method.ReturnType);
            }
        }

        public static TheoryData<Type, bool> InvocationMethodShapes => new()
        {
            { typeof(ExactEntrypoint), true },
            { typeof(WrongNameEntrypoint), false },
            { typeof(TaskOnlyEntrypoint), false },
            { typeof(ValueTaskEntrypoint), false },
            { typeof(StaticEntrypoint), false },
            { typeof(GenericMethodEntrypoint), false },
            { typeof(WrongOperationParameterEntrypoint), false },
            { typeof(WrongJsonParameterEntrypoint), false },
            { typeof(WrongCancellationParameterEntrypoint), false },
            { typeof(OptionalParameterEntrypoint), false },
            { typeof(ParamsEntrypoint), false },
            { typeof(ByRefEntrypoint), false },
            { typeof(OverloadedEntrypoint), false },
            { typeof(InheritedOnlyEntrypoint), false },
            { typeof(DeclaredExactWithInheritedOverloadEntrypoint), false },
            { VarArgsEntrypoint(), false },
            { typeof(AbstractEntrypoint), false },
            { typeof(GenericEntrypoint<>), false },
            { typeof(PrivateEntrypoint), false },
            { typeof(StructEntrypoint), false },
        };

        private static JellyfinPlatformProviderBindingHost Host(
            IEnumerable<LocalPlugin> plugins,
            Func<Type, object?>? resolve = null) => new(
            () => plugins,
            resolve ?? (_ => null));

        private static LocalPlugin Plugin(
            PluginStatus status,
            IPlugin? instance,
            Guid? id = null,
            string name = "Provider",
            string version = "1.2.3")
        {
            var plugin = new LocalPlugin(
                "/plugins/" + name,
                true,
                new PluginManifest
                {
                    Id = id ?? ProviderId,
                    Name = name,
                    Version = version,
                    Status = status,
                });
            plugin.Instance = instance;
            return plugin;
        }

        private static PlatformProviderHostBindingRequest Request(
            Guid? id = null,
            Version? version = null) => new(id ?? ProviderId, version ?? ProviderVersion);

        private static void AssertRejected(
            PlatformProviderHostBindingStatus expected,
            PlatformProviderHostBindingResult result)
        {
            Assert.Equal(expected, result.Status);
            Assert.Null(result.Binding);
        }

        private static ForeignFixture ForeignAssembly(bool validAbi)
        {
            var assembly = AssemblyBuilder.DefineDynamicAssembly(
                new AssemblyName("Canopy.ProviderBinding.Tests." + Guid.NewGuid().ToString("N")),
                AssemblyBuilderAccess.RunAndCollect);
            var module = assembly.DefineDynamicModule("Provider");
            var pluginBuilder = module.DefineType(
                "ForeignPluginInstance",
                TypeAttributes.Public | TypeAttributes.Class | TypeAttributes.Sealed,
                typeof(ProviderBindingTestPluginInstance));
            pluginBuilder.DefineDefaultConstructor(MethodAttributes.Public);
            var pluginType = pluginBuilder.CreateType()!;
            var entrypointBuilder = module.DefineType(
                "JellyfinCanopy.ExtensionProviderEntrypoint",
                TypeAttributes.Public | TypeAttributes.Class | TypeAttributes.Sealed);
            entrypointBuilder.DefineDefaultConstructor(MethodAttributes.Public);
            var method = entrypointBuilder.DefineMethod(
                "InvokeAsync",
                MethodAttributes.Public | MethodAttributes.HideBySig,
                validAbi ? typeof(Task<string>) : typeof(Task),
                new[] { typeof(string), typeof(string), typeof(CancellationToken) });
            var il = method.GetILGenerator();
            il.Emit(OpCodes.Call, typeof(ProviderInvocationProbe).GetMethod(
                nameof(ProviderInvocationProbe.MarkInvoked),
                BindingFlags.Public | BindingFlags.Static)!);
            if (validAbi)
            {
                il.Emit(OpCodes.Ldstr, "{}");
                il.Emit(OpCodes.Call, typeof(Task).GetMethods(BindingFlags.Public | BindingFlags.Static)
                    .Single(candidate => candidate.Name == nameof(Task.FromResult))
                    .MakeGenericMethod(typeof(string)));
            }
            else
            {
                il.Emit(OpCodes.Call, typeof(Task).GetProperty(nameof(Task.CompletedTask))!.GetMethod!);
            }

            il.Emit(OpCodes.Ret);
            var entrypointType = entrypointBuilder.CreateType()!;
            return new ForeignFixture(
                (IPlugin)Activator.CreateInstance(pluginType)!,
                entrypointType,
                Activator.CreateInstance(entrypointType)!);
        }

        private static Type VarArgsEntrypoint()
        {
            var assembly = AssemblyBuilder.DefineDynamicAssembly(
                new AssemblyName("Canopy.ProviderBinding.VarArgs.Tests." + Guid.NewGuid().ToString("N")),
                AssemblyBuilderAccess.RunAndCollect);
            var typeBuilder = assembly
                .DefineDynamicModule("Provider")
                .DefineType(
                    "VarArgsEntrypoint",
                    TypeAttributes.Public | TypeAttributes.Class | TypeAttributes.Sealed);
            typeBuilder.DefineDefaultConstructor(MethodAttributes.Public);
            var method = typeBuilder.DefineMethod(
                "InvokeAsync",
                MethodAttributes.Public | MethodAttributes.HideBySig,
                CallingConventions.VarArgs,
                typeof(Task<string>),
                new[] { typeof(string), typeof(string), typeof(CancellationToken) });
            var il = method.GetILGenerator();
            il.Emit(OpCodes.Ldstr, "{}");
            il.Emit(OpCodes.Call, typeof(Task).GetMethods(BindingFlags.Public | BindingFlags.Static)
                .Single(candidate => candidate.Name == nameof(Task.FromResult))
                .MakeGenericMethod(typeof(string)));
            il.Emit(OpCodes.Ret);
            return typeBuilder.CreateType()!;
        }

        private sealed record ForeignFixture(
            IPlugin PluginInstance,
            Type EntrypointType,
            object Entrypoint);

        /// <summary>Public base that lets a dynamic foreign assembly expose an IPlugin instance.</summary>
        public class ProviderBindingTestPluginInstance : IPlugin
        {
            public string Name => "Foreign provider test plugin";

            public string Description => "Test-only live provider instance.";

            public Guid Id { get; } = Guid.NewGuid();

            public Version Version { get; } = ProviderVersion;

            public string AssemblyFilePath => GetType().Assembly.Location;

            public bool CanUninstall => false;

            public string DataFolderPath => "/test-provider";

            public PluginInfo GetPluginInfo() => new(Name, Version, Description, Id, CanUninstall);

            public void OnUninstalling()
            {
            }
        }

        /// <summary>Observable guard proving binding never executes the operation method.</summary>
        public static class ProviderInvocationProbe
        {
            private static int _invocationCount;

            public static int InvocationCount => Volatile.Read(ref _invocationCount);

            public static void MarkInvoked() => Interlocked.Increment(ref _invocationCount);

            public static void Reset() => Volatile.Write(ref _invocationCount, 0);
        }

        public sealed class ExactEntrypoint
        {
            public Task<string> InvokeAsync(string operationId, string requestJson, CancellationToken cancellationToken) =>
                Task.FromResult("{}");
        }

        public sealed class WrongNameEntrypoint
        {
            public Task<string> Invoke(string operationId, string requestJson, CancellationToken cancellationToken) =>
                Task.FromResult("{}");
        }

        public sealed class TaskOnlyEntrypoint
        {
            public Task InvokeAsync(string operationId, string requestJson, CancellationToken cancellationToken) =>
                Task.CompletedTask;
        }

        public sealed class ValueTaskEntrypoint
        {
            public ValueTask<string> InvokeAsync(string operationId, string requestJson, CancellationToken cancellationToken) =>
                ValueTask.FromResult("{}");
        }

        public sealed class StaticEntrypoint
        {
            public static Task<string> InvokeAsync(string operationId, string requestJson, CancellationToken cancellationToken) =>
                Task.FromResult("{}");
        }

        public sealed class GenericMethodEntrypoint
        {
            public Task<string> InvokeAsync<T>(string operationId, string requestJson, CancellationToken cancellationToken) =>
                Task.FromResult("{}");
        }

        public sealed class WrongOperationParameterEntrypoint
        {
            public Task<string> InvokeAsync(object operationId, string requestJson, CancellationToken cancellationToken) =>
                Task.FromResult("{}");
        }

        public sealed class WrongJsonParameterEntrypoint
        {
            public Task<string> InvokeAsync(string operationId, object requestJson, CancellationToken cancellationToken) =>
                Task.FromResult("{}");
        }

        public sealed class WrongCancellationParameterEntrypoint
        {
            public Task<string> InvokeAsync(string operationId, string requestJson, CancellationTokenSource cancellationToken) =>
                Task.FromResult("{}");
        }

        public sealed class OptionalParameterEntrypoint
        {
            public Task<string> InvokeAsync(
                string operationId,
                string requestJson,
                CancellationToken cancellationToken = default) => Task.FromResult("{}");
        }

        public sealed class ParamsEntrypoint
        {
            public Task<string> InvokeAsync(string operationId, string requestJson, params CancellationToken[] cancellationToken) =>
                Task.FromResult("{}");
        }

        public sealed class ByRefEntrypoint
        {
            public Task<string> InvokeAsync(ref string operationId, string requestJson, CancellationToken cancellationToken) =>
                Task.FromResult("{}");
        }

        public sealed class OverloadedEntrypoint
        {
            public Task<string> InvokeAsync(string operationId, string requestJson, CancellationToken cancellationToken) =>
                Task.FromResult("{}");

            public Task<string> InvokeAsync(string operationId, string requestJson) => Task.FromResult("{}");
        }

        public class BaseEntrypoint
        {
            public Task<string> InvokeAsync(string operationId, string requestJson, CancellationToken cancellationToken) =>
                Task.FromResult("{}");
        }

        public sealed class InheritedOnlyEntrypoint : BaseEntrypoint
        {
        }

        public class BaseOverloadEntrypoint
        {
            public Task<string> InvokeAsync(string operationId, string requestJson) =>
                Task.FromResult("{}");
        }

        public sealed class DeclaredExactWithInheritedOverloadEntrypoint : BaseOverloadEntrypoint
        {
            public Task<string> InvokeAsync(
                string operationId,
                string requestJson,
                CancellationToken cancellationToken) => Task.FromResult("{}");
        }

        public abstract class AbstractEntrypoint
        {
            public Task<string> InvokeAsync(string operationId, string requestJson, CancellationToken cancellationToken) =>
                Task.FromResult("{}");
        }

        public sealed class GenericEntrypoint<T>
        {
            public Task<string> InvokeAsync(string operationId, string requestJson, CancellationToken cancellationToken) =>
                Task.FromResult("{}");
        }

        private sealed class PrivateEntrypoint
        {
            public Task<string> InvokeAsync(string operationId, string requestJson, CancellationToken cancellationToken) =>
                Task.FromResult("{}");
        }

        public readonly struct StructEntrypoint
        {
            public Task<string> InvokeAsync(string operationId, string requestJson, CancellationToken cancellationToken) =>
                Task.FromResult("{}");
        }
    }
}
