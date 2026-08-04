using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Threading;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

public sealed class PlatformInstalledManifestArchitectureTests
{
    private const string BindingFileName = "PlatformInstalledManifestBindingDomain.cs";
    private const string AcquisitionFileName = "PlatformInstalledManifestAcquisition.cs";
    private const string HostTypesFileName = "HostTypes.cs";
    private const string JellyfinHostFileName = "JellyfinPlatformHost.cs";

    private static readonly string[] ForbiddenBindingTokens =
    {
        "System.IO", "File.", "Directory", "Path.", "Stream", "SafeFileHandle", "DllImport",
        "LibraryImport", "MediaBrowser", "IPluginManager", "LocalPlugin", "PluginStatus",
        "HttpClient", "System.Net", "IConfiguration", "IServiceCollection", "AtomicFile",
        "Persistence", "Repository", "Registry", "Lifecycle", "Approval", "GrantedCapability",
        "PlatformApprovedProviderIdentity", "PlatformActorFactory", "CreateProvider",
        "System.Reflection", "Activator", "Assembly.Load", "ProviderInvocation", "Controller",
        "Route(", "IHostedService", "BackgroundService", "AddHostedService", "DateTime", "Random",
        "Android",
    };

    [Fact]
    public void ClosedOutcomeStatusAndCompatibilityVocabulariesAreExact()
    {
        Assert.Equal(
            new[]
            {
                "Acquired", "ManifestAbsent", "HostMetadataInvalid", "AmbiguousHostIdentity",
                "HostStatusNotActive", "UnsafeOrUnverifiableRoot", "UnsafeTarget", "OpenTimedOut",
                "NotRegularFile", "DescriptorUnverifiable", "DocumentTooLarge", "ReadChanged",
                "ReadFailed", "ManifestRejected", "PluginIdMismatch", "PluginVersionMismatch",
                "AssemblyUnavailable", "AssemblyMismatch", "HostSnapshotChanged", "AcquisitionFailed",
            },
            Enum.GetNames<PlatformInstalledManifestOutcome>());
        Assert.Equal(Enumerable.Range(0, 20),
            Enum.GetValues<PlatformInstalledManifestOutcome>().Select(value => (int)value));
        Assert.Equal(
            new[] { "Compatible", "PlatformIncompatible", "HostIncompatible" },
            Enum.GetNames<PlatformInstalledManifestCompatibility>());
        Assert.Equal(
            new[] { "Restart", "Active", "Disabled", "NotSupported", "Malfunctioned", "Superseded", "Deleted" },
            Enum.GetNames<PlatformInstalledPluginHostStatus>());
        Assert.Equal(1, PlatformInstalledManifestBinder.PlatformMajor);
        Assert.Equal(12, PlatformInstalledManifestBinder.JellyfinHostMajor);
        Assert.Equal(128, PlatformInstalledManifestLimits.MaximumDllFileCount);
        Assert.True(PlatformInstalledManifestDiscovery.MaximumPluginCount > 0);
        Assert.True(PlatformInstalledManifestDiscovery.MaximumConcurrentAcquisitions > 0);
    }

    [Fact]
    public void BoundManifestAndObservationAreSealedImmutableRedactionSafeAllowLists()
    {
        AssertImmutableShape(
            typeof(HostBoundInstalledManifest),
            new[]
            {
                "AssemblyIdentity", "Compatibility", "Fingerprint", "HostName", "HostStatus",
                "HostVersion", "Manifest", "PluginId",
            });
        AssertImmutableShape(
            typeof(PlatformInstalledManifestObservation),
            new[]
            {
                "BoundManifest", "Compatibility", "HostStatus", "ManifestRejectionReason",
                "Outcome", "PluginId",
            });

        var forbiddenNames = new[]
        {
            "Approved", "Grant", "Effective", "Enabled", "Registered", "Callable", "Credential",
            "Secret", "Actor", "Registry", "Lifecycle", "Root", "Path", "Dll", "Raw", "Bytes",
            "Handle", "Exception",
        };
        foreach (var type in new[] { typeof(HostBoundInstalledManifest), typeof(PlatformInstalledManifestObservation) })
        {
            Assert.DoesNotContain(type.GetProperties(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance),
                property => forbiddenNames.Any(name =>
                    property.Name.Contains(name, StringComparison.OrdinalIgnoreCase)));
            Assert.DoesNotContain(type.GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance),
                field => field.FieldType == typeof(byte[]) || field.FieldType == typeof(Exception));
        }
    }

    [Fact]
    public void ReaderAndDiscoveryExposeNoCallerSelectedPathFilenameOrAuthorityInput()
    {
        var read = Assert.Single(typeof(IPlatformInstalledManifestReader).GetMethods());
        Assert.Equal("ReadAsync", read.Name);
        Assert.Equal(
            new[] { typeof(PlatformInstalledPluginSnapshot), typeof(CancellationToken) },
            read.GetParameters().Select(parameter => parameter.ParameterType));
        Assert.DoesNotContain(read.GetParameters(), parameter => parameter.ParameterType == typeof(string));

        var sweep = typeof(PlatformInstalledManifestDiscovery).GetMethod(
            "SweepAsync",
            BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(sweep);
        Assert.DoesNotContain(sweep!.GetParameters(), parameter => parameter.ParameterType == typeof(string));
        Assert.DoesNotContain(sweep.GetParameters(), parameter =>
            parameter.Name is not null
            && (parameter.Name.Contains("path", StringComparison.OrdinalIgnoreCase)
                || parameter.Name.Contains("root", StringComparison.OrdinalIgnoreCase)
                || parameter.Name.Contains("file", StringComparison.OrdinalIgnoreCase)));
    }

    [Fact]
    public void PlantedCallerSelectedPathSignatureIsCaught()
    {
        var reviewed = Assert.Single(typeof(IPlatformInstalledManifestReader).GetMethods());
        var planted = typeof(UnsafePathReaderFixture).GetMethod(nameof(UnsafePathReaderFixture.ReadAsync))!;

        Assert.False(HasCallerSelectedPathInput(reviewed));
        Assert.True(HasCallerSelectedPathInput(planted));
    }

    [Fact]
    public void PureBindingOwnerHasNoFilesystemHostAuthorityRuntimeOrStartupDependencies()
    {
        var code = Code(SourceFile(BindingFileName));
        Assert.Empty(ForbiddenBindingDependenciesIn(code));
        Assert.Contains(nameof(PlatformExtensionManifestParser), code, StringComparison.Ordinal);
        Assert.Contains(nameof(PlatformInstalledPluginSnapshot), code, StringComparison.Ordinal);
        Assert.Contains(nameof(CancellationToken), code, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("using System.IO; var bytes = File.ReadAllBytes(path);", "System.IO")]
    [InlineData("IPluginManager manager; LocalPlugin plugin;", "IPluginManager")]
    [InlineData("var approved = new PlatformApprovedProviderIdentity();", "PlatformApprovedProviderIdentity")]
    [InlineData("services.AddHostedService<DiscoveryWorker>();", "AddHostedService")]
    [InlineData("[Route(\"manifest\")] sealed class ManifestController : Controller { }", "Controller")]
    [InlineData("Assembly.Load(bytes); Activator.CreateInstance(type);", "Activator")]
    public void PlantedArchitectureViolationsAreNamed(string source, string expected) =>
        Assert.Contains(expected, ForbiddenBindingDependenciesIn(source), StringComparer.OrdinalIgnoreCase);

    [Fact]
    public void SnapshotBindingAndParserConstructionRemainSingleOwned()
    {
        Assert.Equal(
            new[] { HostTypesFileName, JellyfinHostFileName },
            MemberOwners(nameof(PlatformInstalledPluginSnapshot), "EstablishHostSnapshot"));
        Assert.Equal(
            new[] { BindingFileName },
            MemberOwners(nameof(HostBoundInstalledManifest), "EstablishBoundManifest"));
        Assert.Equal(
            new[] { "PlatformExtensionManifestDomain.cs", BindingFileName },
            MemberOwners(nameof(PlatformExtensionManifestParser), nameof(PlatformExtensionManifestParser.TryParse)));
    }

    [Fact]
    public void HostSnapshotNeverInspectsOrInvokesTheProviderInstance()
    {
        var hostAdapter = Code(SourceFile(JellyfinHostFileName));
        foreach (var forbidden in new[]
        {
            "plugin.Instance", ".Instance?.GetType()", "System.Reflection", "Assembly.Load",
            "Activator.CreateInstance",
        })
        {
            Assert.DoesNotContain(forbidden, hostAdapter, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void BindingSliceFeedsOnlyRegistryWithoutRoutesStartupOrExistingActionPaths()
    {
        var production = ProductionFiles().ToDictionary(
            file => Path.GetFileName(file)!,
            Code,
            StringComparer.Ordinal);
        var bindingConsumers = production
            .Where(pair => pair.Value.Contains(nameof(PlatformInstalledManifestDiscovery), StringComparison.Ordinal))
            .Select(pair => pair.Key)
            .Order(StringComparer.Ordinal)
            .ToArray();
        Assert.Equal(
            new[] { AcquisitionFileName, BindingFileName, "PlatformProviderRegistry.cs" },
            bindingConsumers);

        foreach (var pair in production)
        {
            Assert.DoesNotContain("new PlatformApprovedProviderIdentity", pair.Value, StringComparison.Ordinal);
        }

        foreach (var actionPath in new[]
        {
            "PlatformActionCapabilityService.cs", "PlatformActionInvocationCoordinator.cs",
            "PlatformFirstPartyActionDispatcher.cs", "PlatformNativeCatalogService.cs",
            "PlatformNativeController.cs",
        })
        {
            Assert.DoesNotContain("PlatformInstalledManifest", production[actionPath], StringComparison.Ordinal);
        }
    }

    private static void AssertImmutableShape(Type type, IReadOnlyList<string> expectedProperties)
    {
        Assert.True(type.IsSealed);
        Assert.Empty(type.GetConstructors(BindingFlags.Public | BindingFlags.Instance));
        var properties = type.GetProperties(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
            .OrderBy(property => property.Name, StringComparer.Ordinal)
            .ToArray();
        Assert.Equal(expectedProperties, properties.Select(property => property.Name));
        Assert.All(properties, property => Assert.False(property.CanWrite));
    }

    private static string[] ForbiddenBindingDependenciesIn(string source) => ForbiddenBindingTokens
        .Where(token => source.Contains(token, StringComparison.OrdinalIgnoreCase))
        .ToArray();

    private static bool HasCallerSelectedPathInput(MethodInfo method) => method.GetParameters().Any(parameter =>
        parameter.ParameterType == typeof(string)
        || (parameter.Name is not null
            && (parameter.Name.Contains("path", StringComparison.OrdinalIgnoreCase)
                || parameter.Name.Contains("root", StringComparison.OrdinalIgnoreCase)
                || parameter.Name.Contains("file", StringComparison.OrdinalIgnoreCase))));

    private static string[] MemberOwners(string typeName, string memberName) => ProductionFiles()
        .Where(file =>
        {
            var code = Code(file);
            return code.Contains(typeName, StringComparison.Ordinal)
                && code.Contains(memberName, StringComparison.Ordinal);
        })
        .Select(file => Path.GetFileName(file)!)
        .OrderBy(name => name, StringComparer.Ordinal)
        .ToArray();

    private static string Code(string file) => PlatformHostSeamTests.CodeOnly(File.ReadAllText(file));

    private static IEnumerable<string> ProductionFiles() =>
        Directory.EnumerateFiles(ProductionRoot(), "*.cs", SearchOption.AllDirectories)
            .Where(file => !file.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}",
                    StringComparison.Ordinal)
                && !file.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}",
                    StringComparison.Ordinal));

    private static string SourceFile(string name) => ProductionFiles()
        .Single(file => Path.GetFileName(file) == name);

    private static string ProductionRoot([CallerFilePath] string sourceFile = "") =>
        Path.GetFullPath(Path.Combine(
            Path.GetDirectoryName(sourceFile)!,
            "..",
            "..",
            "Jellyfin.Plugin.JellyfinCanopy"));

    private sealed class UnsafePathReaderFixture
    {
        public void ReadAsync(string root, string fileName)
        {
        }
    }
}
