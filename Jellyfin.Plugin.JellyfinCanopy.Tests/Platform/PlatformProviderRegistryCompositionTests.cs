using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

public sealed class PlatformProviderRegistryCompositionTests
{
    private const string StateFileName =
        "Jellyfin.Plugin.JellyfinCanopy.platform-provider-registry-v1.json";

    [Fact]
    public void CompositionRegistersOneOwnerAndOneAliasForEveryBoundary()
    {
        var services = new ServiceCollection();

        PluginServiceRegistrator.RegisterPlatformProviderRegistryServices(services);

        AssertSingle<IPlatformInstalledManifestReader>(services);
        AssertSingle<PlatformInstalledManifestAcquisition>(services);
        AssertSingle<IPlatformInstalledManifestSweepSource>(services);
        AssertSingle<IPlatformProviderRegistryStateStore>(services);
        AssertSingle<PlatformProviderRegistry>(services);
        AssertSingle<Lazy<PlatformProviderRegistry>>(services);
        AssertSingle<PlatformProviderRegistryOrchestrator>(services);
        AssertSingle<IHostedService>(services);
        Assert.All(services, descriptor => Assert.Equal(ServiceLifetime.Singleton, descriptor.Lifetime));
    }

    [Fact]
    public async Task ResolutionAndStartAreLazyUntilApplicationStartedThenUseFixedStatePath()
    {
        var root = Path.Combine(
            Path.GetTempPath(),
            "jc-provider-registry-composition-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var host = new CountingHost();
            var lifetime = new TestApplicationLifetime();
            var services = new ServiceCollection();
            services.AddLogging();
            services.AddSingleton<IApplicationPaths>(new StubAppPaths(root));
            services.AddSingleton<IPlatformHost>(host);
            services.AddSingleton<IHostApplicationLifetime>(lifetime);
            PluginServiceRegistrator.RegisterPlatformProviderRegistryServices(services);

            await using var provider = services.BuildServiceProvider();
            var hosted = Assert.Single(provider.GetServices<IHostedService>());
            var owner = provider.GetRequiredService<PlatformProviderRegistryOrchestrator>();
            Assert.Same(owner, hosted);
            Assert.Equal(0, host.InventoryReads);
            Assert.False(File.Exists(Path.Combine(root, StateFileName)));

            await hosted.StartAsync(CancellationToken.None);
            Assert.Equal(0, host.InventoryReads);
            Assert.False(File.Exists(Path.Combine(root, StateFileName)));

            lifetime.SignalStarted();
            await host.InventoryObserved.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await WaitUntilAsync(
                () => File.Exists(Path.Combine(root, StateFileName)),
                TimeSpan.FromSeconds(10));

            Assert.Equal(1, host.InventoryReads);
            await hosted.StopAsync(CancellationToken.None);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task StopBeforeApplicationStartedPreventsLazyRegistryConstruction()
    {
        var root = Path.Combine(
            Path.GetTempPath(),
            "jc-provider-registry-stopped-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var host = new CountingHost();
            var lifetime = new TestApplicationLifetime();
            var services = new ServiceCollection();
            services.AddLogging();
            services.AddSingleton<IApplicationPaths>(new StubAppPaths(root));
            services.AddSingleton<IPlatformHost>(host);
            services.AddSingleton<IHostApplicationLifetime>(lifetime);
            PluginServiceRegistrator.RegisterPlatformProviderRegistryServices(services);

            await using var provider = services.BuildServiceProvider();
            var hosted = Assert.Single(provider.GetServices<IHostedService>());
            await hosted.StartAsync(CancellationToken.None);
            await hosted.StopAsync(CancellationToken.None);
            lifetime.SignalStarted();
            await Task.Delay(50);

            Assert.Equal(0, host.InventoryReads);
            Assert.False(File.Exists(Path.Combine(root, StateFileName)));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task ManualRequestBeforeApplicationStartedDoesNotLoadStateOrInventory()
    {
        var root = Path.Combine(
            Path.GetTempPath(),
            "jc-provider-registry-pre-start-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var host = new CountingHost();
            var store = new CountingStore();
            var lifetime = new TestApplicationLifetime();
            var services = new ServiceCollection();
            services.AddLogging();
            services.AddSingleton<IApplicationPaths>(new StubAppPaths(root));
            services.AddSingleton<IPlatformHost>(host);
            services.AddSingleton<IHostApplicationLifetime>(lifetime);
            PluginServiceRegistrator.RegisterPlatformProviderRegistryServices(services);
            services.Replace(ServiceDescriptor.Singleton<IPlatformProviderRegistryStateStore>(store));

            await using var provider = services.BuildServiceProvider();
            var hosted = Assert.Single(provider.GetServices<IHostedService>());
            var owner = provider.GetRequiredService<PlatformProviderRegistryOrchestrator>();
            await hosted.StartAsync(CancellationToken.None);

            var preStart = await owner.ReconcileAsync(CancellationToken.None);

            Assert.Equal(PlatformProviderRegistryOrchestrationStatus.NotStarted, preStart.Status);
            Assert.Equal(0, store.LoadCount);
            Assert.Equal(0, store.SaveCount);
            Assert.Equal(0, host.InventoryReads);

            lifetime.SignalStarted();
            await store.SaveObserved.Task.WaitAsync(TimeSpan.FromSeconds(10));
            Assert.Equal(1, store.LoadCount);
            Assert.Equal(1, store.SaveCount);
            Assert.Equal(1, host.InventoryReads);
            await hosted.StopAsync(CancellationToken.None);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task AlreadySignalledApplicationStartedNeverPerformsRegistryIoInsideStartAsync()
    {
        var root = Path.Combine(
            Path.GetTempPath(),
            "jc-provider-registry-signalled-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var store = new BlockingStore();
        try
        {
            var host = new CountingHost();
            using var lifetime = new TestApplicationLifetime();
            lifetime.SignalStarted();
            var services = new ServiceCollection();
            services.AddLogging();
            services.AddSingleton<IApplicationPaths>(new StubAppPaths(root));
            services.AddSingleton<IPlatformHost>(host);
            services.AddSingleton<IHostApplicationLifetime>(lifetime);
            PluginServiceRegistrator.RegisterPlatformProviderRegistryServices(services);
            services.Replace(ServiceDescriptor.Singleton<IPlatformProviderRegistryStateStore>(store));

            await using var provider = services.BuildServiceProvider();
            var hosted = Assert.Single(provider.GetServices<IHostedService>());

            await hosted.StartAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(1));
            await store.LoadObserved.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(0, host.InventoryReads);

            store.ReleaseLoad.Set();
            await store.SaveObserved.Task.WaitAsync(TimeSpan.FromSeconds(10));
            Assert.Equal(1, host.InventoryReads);
            await hosted.StopAsync(CancellationToken.None);
        }
        finally
        {
            store.ReleaseLoad.Set();
            store.Dispose();
            Directory.Delete(root, recursive: true);
        }
    }

    private static void AssertSingle<T>(IEnumerable<ServiceDescriptor> services) =>
        Assert.Single(services, descriptor => descriptor.ServiceType == typeof(T));

    private static async Task WaitUntilAsync(Func<bool> predicate, TimeSpan timeout)
    {
        using var cancellation = new CancellationTokenSource(timeout);
        while (!predicate())
        {
            await Task.Delay(10, cancellation.Token);
        }
    }

    private sealed class CountingHost : IPlatformHost, IHostPlugins
    {
        internal TaskCompletionSource InventoryObserved { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        internal int InventoryReads { get; private set; }

        public IHostUsers Users => throw new NotSupportedException();

        public IHostLibrary Library => throw new NotSupportedException();

        public IHostSessions Sessions => throw new NotSupportedException();

        public IHostPlugins Plugins => this;

        public IReadOnlyList<HostPlugin> Installed() => [];

        public HostPlugin? Find(Guid id) => null;

        IReadOnlyList<PlatformInstalledPluginSnapshot> IHostPlugins.InstalledSnapshots()
        {
            InventoryReads++;
            InventoryObserved.TrySetResult();
            return [];
        }

        PlatformInstalledPluginSnapshot? IHostPlugins.FindSnapshot(Guid id) => null;
    }

    private sealed class CountingStore : IPlatformProviderRegistryStateStore
    {
        internal TaskCompletionSource SaveObserved { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        internal int LoadCount { get; private set; }

        internal int SaveCount { get; private set; }

        public PlatformProviderRegistryStoreLoadResult Load()
        {
            LoadCount++;
            return PlatformProviderRegistryStoreLoadResult.Healthy(
                PlatformProviderRegistryDurableState.Empty);
        }

        public void Save(PlatformProviderRegistryDurableState state)
        {
            SaveCount++;
            SaveObserved.TrySetResult();
        }

        public void ResetQuarantined(Guid administratorId, string reason, DateTimeOffset decidedAtUtc)
        {
        }

        public void FenceQuarantined()
        {
        }
    }

    private sealed class BlockingStore : IPlatformProviderRegistryStateStore, IDisposable
    {
        internal TaskCompletionSource LoadObserved { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        internal TaskCompletionSource SaveObserved { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        internal ManualResetEventSlim ReleaseLoad { get; } = new(initialState: false);

        public PlatformProviderRegistryStoreLoadResult Load()
        {
            LoadObserved.TrySetResult();
            ReleaseLoad.Wait();
            return PlatformProviderRegistryStoreLoadResult.Healthy(
                PlatformProviderRegistryDurableState.Empty);
        }

        public void Save(PlatformProviderRegistryDurableState state) =>
            SaveObserved.TrySetResult();

        public void ResetQuarantined(Guid administratorId, string reason, DateTimeOffset decidedAtUtc)
        {
        }

        public void FenceQuarantined()
        {
        }

        public void Dispose() => ReleaseLoad.Dispose();
    }

    private sealed class TestApplicationLifetime : IHostApplicationLifetime, IDisposable
    {
        private readonly CancellationTokenSource _started = new();
        private readonly CancellationTokenSource _stopping = new();
        private readonly CancellationTokenSource _stopped = new();

        public CancellationToken ApplicationStarted => _started.Token;

        public CancellationToken ApplicationStopping => _stopping.Token;

        public CancellationToken ApplicationStopped => _stopped.Token;

        public void StopApplication() => _stopping.Cancel();

        internal void SignalStarted() => _started.Cancel();

        public void Dispose()
        {
            _started.Dispose();
            _stopping.Dispose();
            _stopped.Dispose();
        }
    }
}
