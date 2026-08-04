using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting.Jellyfin;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

public sealed class PlatformProviderBindingServiceTests
{
    private const string OperationId = "org.jellyfin.canopy.conformance.hello";
    private const string ItemLookup = "jellyfin.canopy.items.lookup";
    private const string StorageRead = "jellyfin.canopy.storage.read";
    private static readonly Guid PluginId = new("0a110000-1111-4222-8333-444455556666");
    private static readonly Guid AdminId = new("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    private static readonly DateTimeOffset Now = new(2026, 8, 4, 10, 0, 0, TimeSpan.Zero);

    [Fact]
    public void ExactAlphaFixtureBindsAtomicallyWithoutInvokingItsOperation()
    {
        using var foreign = AlphaForeignBinding.Load();
        var registry = EnabledRegistry(new[] { ItemLookup, StorageRead });
        var services = new ServiceCollection();
        services.AddSingleton(foreign.Binding.EntrypointType, foreign.Binding.Instance);
        using var serviceProvider = services.BuildServiceProvider();
        var plugin = new LocalPlugin(
            "/plugins/alpha",
            true,
            new PluginManifest
            {
                Id = PluginId,
                Name = "mutable display name",
                Version = "1.0.0.0",
                Status = PluginStatus.Active,
            })
        {
            Instance = foreign.PluginInstance,
        };
        var host = new JellyfinPlatformProviderBindingHost(
            () => new[] { plugin },
            serviceProvider.GetService);
        var service = Service(registry, host);

        var result = service.Bind(PluginId, OperationId, negotiatedProtocol: 1);

        Assert.Equal(PlatformProviderBindingStatus.Bound, result.Status);
        var binding = Assert.IsType<PlatformProviderBoundOperation>(result.Binding);
        Assert.Same(foreign.Binding.Assembly, binding.Entrypoint.Assembly);
        Assert.Same(foreign.Binding.EntrypointType, binding.Entrypoint.EntrypointType);
        Assert.Same(foreign.Binding.Instance, binding.Entrypoint.Instance);
        Assert.Same(foreign.Binding.InvocationMethod, binding.Entrypoint.InvocationMethod);
        Assert.Equal(PluginId, binding.Claim.PluginId);
        Assert.Equal(1, binding.Claim.NegotiatedProtocol);
        Assert.Equal(
            binding.Claim.Operation.RequestSchemaId,
            binding.Schemas.RequestSchema.GetProperty("$id").GetString());
        Assert.Equal(
            binding.Claim.Operation.ResponseSchemaId,
            binding.Schemas.ResponseSchema.GetProperty("$id").GetString());
        Assert.Same(
            foreign.Binding.Instance,
            serviceProvider.GetService(foreign.Binding.EntrypointType));
    }

    [Theory]
    [MemberData(nameof(HostRejections))]
    public void EveryHostRejectionMapsWithoutPublishingPartialBinding(
        int hostStatusValue,
        int expectedValue)
    {
        var hostStatus = (PlatformProviderHostBindingStatus)hostStatusValue;
        var expected = (PlatformProviderBindingStatus)expectedValue;
        var registry = EnabledRegistry(new[] { ItemLookup, StorageRead });
        var host = new RecordingHost(_ => PlatformProviderHostBindingResult.Rejected(hostStatus));

        var result = Service(registry, host).Bind(PluginId, OperationId, 1);

        Assert.Equal(expected, result.Status);
        Assert.Null(result.Binding);
        Assert.Single(host.Requests);
    }

    [Fact]
    public void RegistryRefusalsNeverReachTheForeignBindingHost()
    {
        var enabled = EnabledRegistry(new[] { ItemLookup, StorageRead });
        var insufficient = EnabledRegistry(new[] { StorageRead });
        var pending = PendingRegistry();
        var host = new RecordingHost(_ => throw new InvalidOperationException("must not bind"));

        AssertRejected(
            Service(enabled, host).Bind(PluginId, "org.jellyfin.canopy.unknown", 1),
            PlatformProviderBindingStatus.OperationUnavailable);
        AssertRejected(
            Service(enabled, host).Bind(PluginId, OperationId, 2),
            PlatformProviderBindingStatus.ProtocolUnsupported);
        AssertRejected(
            Service(insufficient, host).Bind(PluginId, OperationId, 1),
            PlatformProviderBindingStatus.GrantInsufficient);
        AssertRejected(
            Service(pending, host).Bind(PluginId, OperationId, 1),
            PlatformProviderBindingStatus.AuthorityUnavailable);
        Assert.Empty(host.Requests);
    }

    [Fact]
    public void MissingEmbeddedSchemasRejectTheWholeBinding()
    {
        var registry = EnabledRegistry(new[] { ItemLookup, StorageRead });
        var type = typeof(LocalExactEntrypoint);
        var entrypoint = new LocalExactEntrypoint();
        var foreign = new PlatformProviderForeignEntrypoint(
            type.Assembly,
            entrypoint,
            type,
            entrypoint,
            type.GetMethod(nameof(LocalExactEntrypoint.InvokeAsync))!);

        var result = Service(
            registry,
            new RecordingHost(_ => PlatformProviderHostBindingResult.Bound(foreign)))
            .Bind(PluginId, OperationId, 1);

        AssertRejected(result, PlatformProviderBindingStatus.SchemaMissing);
    }

    [Fact]
    public void AuthorityMutationDuringForeignBindingRejectsTheOtherwiseValidBinding()
    {
        using var foreign = AlphaForeignBinding.Load();
        var registry = EnabledRegistry(new[] { ItemLookup, StorageRead });
        var host = new RecordingHost(_ =>
        {
            registry.BeginReconciliation();
            return PlatformProviderHostBindingResult.Bound(foreign.Binding);
        });

        var result = Service(registry, host).Bind(PluginId, OperationId, 1);

        AssertRejected(result, PlatformProviderBindingStatus.AuthorityChanged);
    }

    [Fact]
    public void AuthorityMutationAfterSchemaAdmissionRejectsTheOtherwiseValidBinding()
    {
        using var foreign = AlphaForeignBinding.Load();
        var registry = EnabledRegistry(new[] { ItemLookup, StorageRead });
        var service = new PlatformProviderBindingService(
            new Lazy<PlatformProviderRegistry>(() => registry),
            new RecordingHost(_ => PlatformProviderHostBindingResult.Bound(foreign.Binding)),
            (assembly, requestId, requestHash, responseId, responseHash) =>
            {
                var admitted = PlatformProviderEmbeddedSchemaAdmission.Admit(
                    assembly,
                    requestId,
                    requestHash,
                    responseId,
                    responseHash);
                Assert.Equal(PlatformProviderEmbeddedSchemaAdmissionStatus.Admitted, admitted.Status);
                registry.BeginReconciliation();
                return admitted;
            });

        var result = service.Bind(PluginId, OperationId, 1);

        AssertRejected(result, PlatformProviderBindingStatus.AuthorityChanged);
    }

    [Fact]
    public void HostLifecycleChangeAfterSchemaAdmissionRejectsTheOtherwiseValidBinding()
    {
        using var foreign = AlphaForeignBinding.Load();
        var registry = EnabledRegistry(new[] { ItemLookup, StorageRead });
        var host = new RecordingHost(
            _ => PlatformProviderHostBindingResult.Bound(foreign.Binding),
            (_, _) => PlatformProviderHostBindingStatus.ProviderAbsent);

        var result = Service(registry, host).Bind(PluginId, OperationId, 1);

        AssertRejected(result, PlatformProviderBindingStatus.ProviderAbsent);
    }

    [Fact]
    public void UnexpectedRegistryAndHostFailuresAreClosedAndRedacted()
    {
        var hostFailure = Service(
            EnabledRegistry(new[] { ItemLookup, StorageRead }),
            new RecordingHost(_ => throw new InvalidOperationException("foreign details")))
            .Bind(PluginId, OperationId, 1);
        var registryFailure = new PlatformProviderBindingService(
            new Lazy<PlatformProviderRegistry>(() => throw new InvalidOperationException("store details")),
            new RecordingHost(_ => throw new InvalidOperationException("must not bind")))
            .Bind(PluginId, OperationId, 1);
        using var foreign = AlphaForeignBinding.Load();
        var revalidationFailure = Service(
            EnabledRegistry(new[] { ItemLookup, StorageRead }),
            new RecordingHost(
                _ => PlatformProviderHostBindingResult.Bound(foreign.Binding),
                (_, _) => throw new InvalidOperationException("host topology details")))
            .Bind(PluginId, OperationId, 1);

        AssertRejected(hostFailure, PlatformProviderBindingStatus.BindingFailed);
        AssertRejected(registryFailure, PlatformProviderBindingStatus.BindingFailed);
        AssertRejected(revalidationFailure, PlatformProviderBindingStatus.BindingFailed);
    }

    public static TheoryData<int, int>
        HostRejections => new()
        {
            { (int)PlatformProviderHostBindingStatus.ProviderAbsent, (int)PlatformProviderBindingStatus.ProviderAbsent },
            { (int)PlatformProviderHostBindingStatus.ProviderNotActive, (int)PlatformProviderBindingStatus.ProviderNotActive },
            { (int)PlatformProviderHostBindingStatus.HostIdentityChanged, (int)PlatformProviderBindingStatus.HostIdentityChanged },
            { (int)PlatformProviderHostBindingStatus.ProviderInstanceUnavailable, (int)PlatformProviderBindingStatus.ProviderInstanceUnavailable },
            { (int)PlatformProviderHostBindingStatus.EntrypointMissing, (int)PlatformProviderBindingStatus.EntrypointMissing },
            { (int)PlatformProviderHostBindingStatus.AbiMismatch, (int)PlatformProviderBindingStatus.AbiMismatch },
            { (int)PlatformProviderHostBindingStatus.ServiceUnavailable, (int)PlatformProviderBindingStatus.ServiceUnavailable },
            { (int)PlatformProviderHostBindingStatus.ServiceResolutionFailed, (int)PlatformProviderBindingStatus.ServiceResolutionFailed },
            { (int)PlatformProviderHostBindingStatus.BindingFailed, (int)PlatformProviderBindingStatus.BindingFailed },
        };

    private static PlatformProviderBindingService Service(
        PlatformProviderRegistry registry,
        IPlatformProviderBindingHost host) => new(new Lazy<PlatformProviderRegistry>(() => registry), host);

    private static PlatformProviderRegistry PendingRegistry()
    {
        var registry = Registry();
        Reconcile(registry);
        return registry;
    }

    private static PlatformProviderRegistry EnabledRegistry(IReadOnlyList<string> grants)
    {
        var registry = PendingRegistry();
        var entry = Assert.Single(registry.Snapshot.Entries);
        Assert.Equal(
            PlatformProviderRegistryMutationStatus.Applied,
            registry.Apply(
                PlatformProviderAdminCommand.Approve(
                    registry.Snapshot.Revision,
                    PluginId,
                    entry.Generation,
                    entry.Fingerprint!,
                    grants,
                    "Approve provider binding service test"),
                AdminAuthorization()).Status);
        return registry;
    }

    private static PlatformProviderRegistry Registry() =>
        new(new RecordingStore(), new FixedTimeProvider(Now));

    private static void Reconcile(PlatformProviderRegistry registry)
    {
        var snapshot = PlatformInstalledManifestBindingTests.Snapshot(
            pluginId: PluginId,
            version: new Version(1, 0, 0, 0));
        var observation = PlatformInstalledManifestBinder.Bind(
            snapshot,
            PlatformInstalledManifestBindingTests.Snapshot(
                pluginId: PluginId,
                version: new Version(1, 0, 0, 0)),
            PlatformInstalledManifestReadResult.Acquired(
                File.ReadAllBytes(AlphaManifestPath()),
                "sha256:provider-binding-service-test"));
        var sweep = PlatformInstalledManifestSweep.EstablishCompleted(
            ImmutableArray.Create(observation));
        Assert.Equal(
            PlatformProviderRegistryMutationStatus.Applied,
            registry.Reconcile(registry.BeginReconciliation(), sweep).Status);
    }

    private static PlatformProviderAdminAuthorization AdminAuthorization()
    {
        var boundaryActor = PlatformActorTestFactory.Create(
            AdminId,
            isElevated: true,
            "provider-binding-service-test",
            "test-client",
            "test-device");
        return Assert.IsType<PlatformProviderAdminAuthorization>(
            PlatformProviderRegistryAdminBoundary.ReauthorizeElevatedAdministrator(
                boundaryActor,
                new ReauthorizationHost()));
    }

    private static void AssertRejected(
        PlatformProviderBindingResult result,
        PlatformProviderBindingStatus expected)
    {
        Assert.Equal(expected, result.Status);
        Assert.Null(result.Binding);
    }

    private static string AlphaManifestPath() => Path.Combine(
        RepositoryRoot(),
        "conformance",
        "platform-providers",
        "Jellyfin.Plugin.CanopyConformance.Alpha",
        "jellyfin-canopy-extension.json");

    private static string AlphaAssemblyPath() => Path.Combine(
        RepositoryRoot(),
        "conformance",
        "platform-providers",
        "Jellyfin.Plugin.CanopyConformance.Alpha",
        "bin",
        "Release",
        "net10.0",
        "Jellyfin.Plugin.CanopyConformance.Alpha.dll");

    private static string RepositoryRoot([CallerFilePath] string sourceFile = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(sourceFile)!, "..", ".."));

    private sealed class RecordingHost(
        Func<PlatformProviderHostBindingRequest, PlatformProviderHostBindingResult> bind,
        Func<PlatformProviderHostBindingRequest, PlatformProviderForeignEntrypoint,
            PlatformProviderHostBindingStatus>? revalidate = null)
        : IPlatformProviderBindingHost
    {
        internal List<PlatformProviderHostBindingRequest> Requests { get; } = [];

        public PlatformProviderHostBindingResult Bind(PlatformProviderHostBindingRequest request)
        {
            Requests.Add(request);
            return bind(request);
        }

        public PlatformProviderHostBindingStatus Revalidate(
            PlatformProviderHostBindingRequest request,
            PlatformProviderForeignEntrypoint binding) =>
            revalidate?.Invoke(request, binding) ?? PlatformProviderHostBindingStatus.Bound;
    }

    private sealed class AlphaForeignBinding : IDisposable
    {
        private readonly AssemblyLoadContext _loadContext;

        private AlphaForeignBinding(
            AssemblyLoadContext loadContext,
            IPlugin pluginInstance,
            PlatformProviderForeignEntrypoint binding)
        {
            _loadContext = loadContext;
            PluginInstance = pluginInstance;
            Binding = binding;
        }

        internal IPlugin PluginInstance { get; }

        internal PlatformProviderForeignEntrypoint Binding { get; }

        internal static AlphaForeignBinding Load()
        {
            var loadContext = new AssemblyLoadContext(
                "provider-binding-service-alpha-" + Guid.NewGuid().ToString("N"),
                isCollectible: true);
            var assembly = loadContext.LoadFromAssemblyPath(AlphaAssemblyPath());
            var type = assembly.GetType(PlatformProviderAbiContract.EntrypointTypeName)
                ?? throw new InvalidOperationException("The Alpha fixture entrypoint is missing.");
            var instance = Activator.CreateInstance(type)!;
            var pluginType = assembly.GetType(
                "Jellyfin.Plugin.CanopyConformance.Alpha.AlphaPlugin")
                ?? throw new InvalidOperationException("The Alpha fixture plugin type is missing.");
            var pluginInstance = Assert.IsAssignableFrom<IPlugin>(
                RuntimeHelpers.GetUninitializedObject(pluginType));
            var method = Assert.Single(type.GetMethods(BindingFlags.Public | BindingFlags.Instance),
                candidate => candidate.Name == PlatformProviderAbiContract.InvocationMethodName);
            return new AlphaForeignBinding(
                loadContext,
                pluginInstance,
                new PlatformProviderForeignEntrypoint(
                    assembly,
                    pluginInstance,
                    type,
                    instance,
                    method));
        }

        public void Dispose() => _loadContext.Unload();
    }

    private sealed class RecordingStore : IPlatformProviderRegistryStateStore
    {
        private PlatformProviderRegistryDurableState _state = PlatformProviderRegistryDurableState.Empty;

        public PlatformProviderRegistryStoreLoadResult Load() =>
            PlatformProviderRegistryStoreLoadResult.Healthy(_state);

        public void Save(PlatformProviderRegistryDurableState state) => _state = state;

        public void ResetQuarantined(Guid administratorId, string reason, DateTimeOffset decidedAtUtc) =>
            _state = PlatformProviderRegistryDurableState.Empty;

        public void FenceQuarantined()
        {
        }
    }

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    private sealed class ReauthorizationHost : IPlatformHost, IHostUsers
    {
        public IHostUsers Users => this;

        public IHostLibrary Library => throw new NotSupportedException();

        public IHostSessions Sessions => throw new NotSupportedException();

        public IHostPlugins Plugins => throw new NotSupportedException();

        public HostUser? Find(Guid id) => id == AdminId
            ? new HostUser(AdminId, "Registry admin", true)
            : null;

        public IReadOnlyList<HostUser> All() => [];
    }

    public sealed class LocalExactEntrypoint
    {
        public Task<string> InvokeAsync(
            string operationId,
            string requestJson,
            CancellationToken cancellationToken) => Task.FromResult("{}");
    }
}
