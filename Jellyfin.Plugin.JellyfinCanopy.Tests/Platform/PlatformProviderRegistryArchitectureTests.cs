using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

public sealed class PlatformProviderRegistryArchitectureTests
{
    private const string RegistryFile = "PlatformProviderRegistry.cs";
    private const string StoreFile = "PlatformProviderRegistryJsonStateStore.cs";
    private const string DomainFile = "PlatformProviderRegistryDomain.cs";

    [Fact]
    public void LifecycleAndMutationVocabulariesAreExactClosedContracts()
    {
        Assert.Equal(
            new[]
            {
                "Pending", "Enabled", "Disabled", "RestartPending", "Incompatible",
                "Quarantined", "Revoked", "Absent",
            },
            Enum.GetNames<PlatformProviderLifecycleState>());
        Assert.Equal(
            new[]
            {
                "Applied", "ElevationRequired", "StaleRevision", "ProviderNotFound",
                "StaleProvider", "InvalidGrant", "InvalidCommand", "PersistenceFailed",
                "StoreQuarantined", "InvalidSweep", "StaleReconciliation",
            },
            Enum.GetNames<PlatformProviderRegistryMutationStatus>());
        Assert.Equal(1024, PlatformProviderRegistry.MaximumProviderCount);
        Assert.Equal(256, PlatformProviderRegistry.MaximumReasonLength);
        Assert.Equal(1024 * 1024, PlatformProviderRegistryJsonStateStore.MaximumDocumentBytes);
        Assert.Equal(8, PlatformProviderRegistryJsonStateStore.MaximumRecoveryEpochs);
    }

    [Fact]
    public void PublishedSnapshotEntryAndAuthorityReleaseAreSealedImmutableAllowLists()
    {
        AssertImmutable(
            typeof(PlatformProviderRegistrySnapshot),
            new[] { "Entries", "Revision", "StoreHealth" });
        AssertImmutable(
            typeof(PlatformProviderRegistryEntry),
            new[]
            {
                "ApprovedFingerprint", "Fingerprint", "Generation", "GrantedCapabilityIds",
                "PluginId", "RequestedCapabilityIds", "State",
            });
        AssertImmutable(
            typeof(PlatformProviderAuthorityRelease),
            new[] { "Generation", "GrantedCapabilityIds", "Identity" });
        AssertImmutable(
            typeof(PlatformProviderAdminAuthorization),
            new[] { "AdministratorId" });

        foreach (var type in new[]
        {
            typeof(PlatformProviderRegistrySnapshot),
            typeof(PlatformProviderRegistryEntry),
            typeof(PlatformProviderAuthorityRelease),
        })
        {
            Assert.DoesNotContain(
                type.GetProperties(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic),
                property => new[]
                {
                    "Root", "Path", "Dll", "Bytes", "Handle", "Exception", "Token", "Secret",
                    "Principal", "HttpContext", "ProviderInstance",
                }.Any(token => property.Name.Contains(token, StringComparison.OrdinalIgnoreCase)));
        }
    }

    [Fact]
    public void RegistryIsTheOnlyProductionCallerThatMintsProviderApprovalProof()
    {
        Assert.Equal(
            new[] { "PlatformActorDomain.cs", RegistryFile },
            MemberOwners("EstablishCurrentRegistryApproval"));
        Assert.Equal(
            new[] { "PlatformActorDomain.cs" },
            MemberOwners("EstablishCurrentRegistryId"));
        Assert.Equal(
            new[] { "PlatformProviderRegistryAdminBoundary.cs", DomainFile },
            MemberOwners("EstablishFreshElevatedBoundary"));

        var registry = Code(SourceFile(RegistryFile));
        Assert.Contains("PlatformApprovedProviderIdentity.EstablishCurrentRegistryApproval", registry, StringComparison.Ordinal);
        foreach (var file in ProductionFiles().Where(file => Path.GetFileName(file) is not (
                     RegistryFile or "PlatformActorDomain.cs")))
        {
            Assert.DoesNotContain(
                "EstablishCurrentRegistryApproval",
                Code(file),
                StringComparison.Ordinal);
        }
    }

    [Fact]
    public void OnlyDiscoveryCanMintACompletedSweepAndRegistryRequiresThatToken()
    {
        Assert.Equal(
            new[] { "PlatformInstalledManifestBindingDomain.cs" },
            MemberOwners("EstablishCompleted"));
        var reconcile = typeof(PlatformProviderRegistry).GetMethod(
            "Reconcile",
            BindingFlags.Instance | BindingFlags.NonPublic);
        Assert.NotNull(reconcile);
        Assert.Equal(
            new[]
            {
                typeof(IPlatformProviderRegistryReconciliationEpoch),
                typeof(PlatformInstalledManifestSweep),
            },
            reconcile.GetParameters().Select(parameter => parameter.ParameterType));
    }

    [Fact]
    public void OnlyRegistryOwnerCanInvokeDurableRecoveryAndAuthorityFencing()
    {
        Assert.Equal(
            new[] { RegistryFile, DomainFile, StoreFile },
            MemberOwners("ResetQuarantined"));
        Assert.Equal(
            new[] { RegistryFile, DomainFile, StoreFile },
            MemberOwners("FenceQuarantined"));
    }

    [Fact]
    public void RegistryOwnsLeasesWithoutFilesystemHostManagerRoutesOrForeignInvocation()
    {
        var registry = Code(SourceFile(RegistryFile));
        Assert.Contains(nameof(PlatformInstalledManifestObservation), registry, StringComparison.Ordinal);
        Assert.DoesNotContain(nameof(PlatformInstalledManifestAcquisition), registry, StringComparison.Ordinal);
        foreach (var forbidden in new[]
        {
            "System.IO", "File.", "Directory.", "Path.", "IPluginManager", "LocalPlugin",
            "MediaBrowser", "Controller", "Route(", "HttpContext", "IHostedService",
            "BackgroundService", "AddHostedService", "System.Reflection", "Assembly.Load",
            "Activator", "MethodInfo.Invoke", "InvocationMethod.Invoke", "CreateProvider(",
            "PlatformProviderForeignEntrypoint", "Android",
        })
        {
            Assert.DoesNotContain(forbidden, registry, StringComparison.OrdinalIgnoreCase);
        }
    }

    [Fact]
    public void PersistenceUsesOnlyAtomicFileForWritesAndCarriesNoAuthorityProof()
    {
        var store = Code(SourceFile(StoreFile));
        Assert.Contains("AtomicFile.WriteAllBytes", store, StringComparison.Ordinal);
        Assert.Contains("AtomicFile.WriteAllText", store, StringComparison.Ordinal);
        var withoutAtomicWrites = store
            .Replace("AtomicFile.WriteAllBytes", string.Empty, StringComparison.Ordinal)
            .Replace("AtomicFile.WriteAllText", string.Empty, StringComparison.Ordinal);
        foreach (var forbidden in new[]
        {
            "File.Write", "File.Create", "new FileStream(_statePath, FileMode.Create",
            "PlatformApprovedProviderIdentity", "PlatformActor", "PlatformUserBoundaryResult",
            "ProviderInvocation", "Controller", "Route(", "HttpClient", "Android",
        })
        {
            Assert.DoesNotContain(forbidden, withoutAtomicWrites, StringComparison.OrdinalIgnoreCase);
        }

        var durableProperties = typeof(PlatformProviderRegistryDurableRecord)
            .GetProperties(BindingFlags.Instance | BindingFlags.NonPublic)
            .Select(property => property.Name)
            .ToArray();
        Assert.DoesNotContain(durableProperties, name => new[]
        {
            "Authority", "Actor", "Token", "Secret", "Root", "Path", "Bytes",
            "Handle", "Exception", "Manifest",
        }.Any(token => name.Contains(token, StringComparison.OrdinalIgnoreCase)));
    }

    [Fact]
    public void RegistryCompositionIsSingleOwnedAndHasNoRoutesOrAndroidConsumers()
    {
        var consumers = ProductionFiles()
            .Where(file => Code(file).Contains(nameof(PlatformProviderRegistry), StringComparison.Ordinal))
            .Select(file => Path.GetFileName(file)!)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();

        Assert.Equal(
            new[]
            {
                "PlatformProviderBindingService.cs",
                "PlatformProviderInvocationService.cs",
                RegistryFile,
                "PlatformProviderRegistryAdminBoundary.cs",
                DomainFile,
                StoreFile,
                "PlatformProviderRegistryOrchestrator.cs",
                "PluginServiceRegistrator.cs",
            },
            consumers);
        var production = string.Join("\n", ProductionFiles().Select(Code));
        Assert.DoesNotContain("AddHostedService<PlatformProviderRegistry", production, StringComparison.Ordinal);
        Assert.DoesNotContain("PlatformProviderRegistryController", production, StringComparison.Ordinal);
        Assert.Equal(
            new[] { RegistryFile, "PlatformProviderRegistryOrchestrator.cs" },
            MemberOwners("BeginReconciliation"));
        Assert.Equal(
            new[] { RegistryFile, "PlatformProviderRegistryOrchestrator.cs" },
            MemberOwners("AbandonReconciliation"));
        Assert.Equal(
            new[] { RegistryFile, "PlatformProviderRegistryOrchestrator.cs" },
            MemberOwners("IPlatformProviderRegistryReconciliationEpoch"));
        Assert.Equal(
            new[] { RegistryFile },
            MemberOwners("private sealed class ReconciliationEpoch"));

        var orchestrator = Code(SourceFile("PlatformProviderRegistryOrchestrator.cs"));
        foreach (var forbidden in new[]
        {
            "Controller", "Route(", "OpenApi", "Assembly.Load", "System.Reflection",
            "Activator.CreateInstance", "Type.GetType", "ProviderInvocation", "TryRelease(",
            "BackgroundService", "PeriodicTimer", "System.Threading.Timer", "new Timer(",
            "System.Timers.Timer", "CreateTimer(", "Task.Delay(", "ConcurrentQueue",
            "BlockingCollection", "Queue<", "HealthCheck", "CircuitBreaker", "EventBus", "StateEvent",
            "Catalog", "CompanionCredential", "ProviderResolver", "HttpClient", "Android",
            "System.Threading.Channels",
        })
        {
            Assert.DoesNotContain(forbidden, orchestrator, StringComparison.OrdinalIgnoreCase);
        }
    }

    [Fact]
    public void OrchestratorIsSoleProductionAcquisitionToReconcileCallerAndFixturesStayAbsent()
    {
        Assert.Equal(
            new[] { "PlatformProviderRegistryOrchestrator.cs" },
            ProductionFiles()
                .Where(file => Code(file).Contains("registry.Reconcile(", StringComparison.Ordinal))
                .Select(file => Path.GetFileName(file)!)
                .OrderBy(value => value, StringComparer.Ordinal));
        Assert.Equal(
            new[] { "PlatformProviderRegistryOrchestrator.cs" },
            ProductionFiles()
                .Where(file => Code(file).Contains("_sweepSource.SweepAsync(", StringComparison.Ordinal))
                .Select(file => Path.GetFileName(file)!)
                .OrderBy(value => value, StringComparer.Ordinal));
        Assert.Equal(
            new[] { RegistryFile, DomainFile },
            ProductionFiles()
                .Where(file => Code(file).Contains(nameof(PlatformProviderAuthorityRelease), StringComparison.Ordinal))
                .Select(file => Path.GetFileName(file)!)
                .OrderBy(value => value, StringComparer.Ordinal));

        var production = string.Join("\n", ProductionFiles().Select(Code));
        Assert.DoesNotContain("CanopyConformance", production, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("conformance/platform-providers", production, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("conformance\\platform-providers", production, StringComparison.OrdinalIgnoreCase);
    }

    private static void AssertImmutable(Type type, IReadOnlyList<string> expectedProperties)
    {
        Assert.True(type.IsSealed);
        Assert.Empty(type.GetConstructors(BindingFlags.Public | BindingFlags.Instance));
        var properties = type.GetProperties(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
            .OrderBy(property => property.Name, StringComparer.Ordinal)
            .ToArray();
        Assert.Equal(expectedProperties, properties.Select(property => property.Name));
        Assert.All(properties, property => Assert.False(property.CanWrite));
    }

    private static string[] MemberOwners(string memberName) => ProductionFiles()
        .Where(file => Code(file).Contains(memberName, StringComparison.Ordinal))
        .Select(file => Path.GetFileName(file)!)
        .OrderBy(name => name, StringComparer.Ordinal)
        .ToArray();

    private static string Code(string file) => PlatformHostSeamTests.CodeOnly(File.ReadAllText(file));

    private static IEnumerable<string> ProductionFiles() =>
        Directory.EnumerateFiles(ProductionRoot(), "*.cs", SearchOption.AllDirectories)
            .Where(file => !file.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                && !file.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal));

    private static string SourceFile(string name) => ProductionFiles()
        .Single(file => Path.GetFileName(file) == name);

    private static string ProductionRoot([CallerFilePath] string sourceFile = "") =>
        Path.GetFullPath(Path.Combine(
            Path.GetDirectoryName(sourceFile)!,
            "..",
            "..",
            "Jellyfin.Plugin.JellyfinCanopy"));
}
