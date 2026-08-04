using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

public sealed class PlatformProviderBindingArchitectureTests
{
    private const string BindingServiceFile = "PlatformProviderBindingService.cs";
    private const string BindingHostFile = "JellyfinPlatformProviderBindingHost.cs";
    private const string BindingDomainFile = "IPlatformProviderBindingHost.cs";

    [Fact]
    public void BindingOutcomesAndPublishedShapesAreExactClosedContracts()
    {
        Assert.Equal(
            new[]
            {
                "Bound", "AuthorityUnavailable", "OperationUnavailable", "ProtocolUnsupported",
                "GrantInsufficient", "ProviderAbsent", "ProviderNotActive", "HostIdentityChanged",
                "ProviderInstanceUnavailable", "EntrypointMissing", "AbiMismatch", "ServiceUnavailable",
                "ServiceResolutionFailed", "SchemaMissing", "SchemaResourceAmbiguous", "SchemaReadFailed",
                "SchemaTooLarge", "SchemaHashMismatch", "SchemaInvalidUtf8", "SchemaInvalidJson",
                "SchemaBoundsExceeded", "SchemaIdentityMismatch", "SchemaDialectUnsupported",
                "SchemaExternalReference", "SchemaVocabularyUnsupported", "AuthorityChanged", "BindingFailed",
            },
            Enum.GetNames<PlatformProviderBindingStatus>());
        Assert.Equal(
            Enumerable.Range(1, 27),
            Enum.GetValues<PlatformProviderBindingStatus>().Select(value => (int)value));
        Assert.Equal(
            new[]
            {
                "Bound", "ProviderAbsent", "ProviderNotActive", "HostIdentityChanged",
                "ProviderInstanceUnavailable", "EntrypointMissing", "AbiMismatch", "ServiceUnavailable",
                "ServiceResolutionFailed", "BindingFailed",
            },
            Enum.GetNames<PlatformProviderHostBindingStatus>());

        AssertImmutable(typeof(PlatformProviderBindingResult), new[] { "Binding", "Status" });
        AssertImmutable(
            typeof(PlatformProviderBoundOperation),
            new[] { "Claim", "Entrypoint", "Schemas" });
        AssertImmutable(
            typeof(PlatformProviderForeignEntrypoint),
            new[] { "Assembly", "EntrypointType", "Instance", "InvocationMethod" });
        AssertImmutable(
            typeof(PlatformProviderHostBindingRequest),
            new[] { "HostVersion", "PluginId" });
        AssertImmutable(
            typeof(PlatformProviderHostBindingResult),
            new[] { "Binding", "Status" });
    }

    [Fact]
    public void BindingCoordinatorHasNoInvocationCacheRouteTimerOrHostManagerSurface()
    {
        var code = Code(SourceFile(BindingServiceFile));
        Assert.Contains("ClaimOperationBinding(", code, StringComparison.Ordinal);
        Assert.Equal(2, Count(code, "RevalidateOperationBindingClaim("));
        Assert.Contains("PlatformProviderEmbeddedSchemaAdmission.Admit", code, StringComparison.Ordinal);
        Assert.Contains("_host.Revalidate(hostRequest, hostResult.Binding)", code, StringComparison.Ordinal);
        foreach (var forbidden in new[]
        {
            "MethodInfo.Invoke", ".Invoke(instance", "InvocationMethod.Invoke", "InvokeAsync(",
            "Assembly.Load", "LoadFromAssemblyPath", "Activator", "IPluginManager", "LocalPlugin",
            "System.IO", "File.", "Directory.", "Path.", "HttpClient", "Controller", "Route(",
            "IHostedService", "BackgroundService", "Timer", "Task.Delay", "ConcurrentDictionary",
            "MemoryCache", "ILogger", "Android", "CanopyConformance",
        })
        {
            Assert.DoesNotContain(forbidden, code, StringComparison.OrdinalIgnoreCase);
        }
    }

    [Fact]
    public void JellyfinAdapterIsTheOnlyLiveForeignBindingOwnerAndNeverInvokesOrLoads()
    {
        Assert.Equal(new[] { BindingHostFile }, Owners("plugin.Instance"));
        Assert.Equal(new[] { BindingHostFile }, Owners("serviceProvider.GetService"));
        Assert.Equal(new[] { BindingHostFile }, Owners("_resolve(entrypointType)"));
        Assert.Equal(new[] { BindingHostFile }, Owners("TryResolveInvocationMethod"));

        var code = Code(SourceFile(BindingHostFile));
        Assert.Contains("candidate.Id == request.PluginId", code, StringComparison.Ordinal);
        Assert.Contains("plugin.Manifest.Status != PluginStatus.Active", code, StringComparison.Ordinal);
        Assert.Contains("pluginInstance.GetType().Assembly", code, StringComparison.Ordinal);
        Assert.Contains("binding.IsBoundToHostPluginInstance(pluginInstance)", code, StringComparison.Ordinal);
        Assert.Contains("BindingFlags.DeclaredOnly", code, StringComparison.Ordinal);
        foreach (var forbidden in new[]
        {
            "MethodInfo.Invoke", ".Invoke(instance", "InvocationMethod.Invoke", "InvokeAsync(",
            "Assembly.Load", "LoadFromAssemblyPath", "Assembly.LoadFile", "Assembly.LoadFrom",
            "Activator", "File.", "Directory.", "Path.", "Controller", "Route(", "IHostedService",
            "BackgroundService", "Timer", "Task.Delay", "HttpClient", "ILogger", "Android",
            "CanopyConformance",
        })
        {
            Assert.DoesNotContain(forbidden, code, StringComparison.OrdinalIgnoreCase);
        }
    }

    [Fact]
    public void CompositionIsLazySingletonOnlyAndCreatesNoStartupConsumer()
    {
        var registrator = Code(SourceFile("PluginServiceRegistrator.cs"));
        Assert.Contains(
            "AddSingleton<IPlatformProviderBindingHost, JellyfinPlatformProviderBindingHost>()",
            registrator,
            StringComparison.Ordinal);
        Assert.Contains(
            "AddSingleton(serviceProvider => new PlatformProviderBindingService(",
            registrator,
            StringComparison.Ordinal);
        Assert.Equal(new[] { "PluginServiceRegistrator.cs" }, Owners("new PlatformProviderBindingService("));

        var production = string.Join('\n', ProductionFiles().Select(Code));
        Assert.DoesNotContain("AddHostedService<PlatformProviderBinding", production, StringComparison.Ordinal);
        Assert.DoesNotContain("IHostedService<PlatformProviderBinding", production, StringComparison.Ordinal);
        Assert.DoesNotContain("PlatformProviderBindingController", production, StringComparison.Ordinal);
    }

    [Fact]
    public void HostNeutralBoundaryCarriesOnlyBclReflectionFactsAndNoJellyfinTypes()
    {
        var code = Code(SourceFile(BindingDomainFile));
        foreach (var forbidden in new[]
        {
            "MediaBrowser", "IPluginManager", "LocalPlugin", "PluginStatus", "IServiceProvider",
            "File.", "Directory.", "Path.", "Controller", "Route(", "HttpClient", "Android",
        })
        {
            Assert.DoesNotContain(forbidden, code, StringComparison.OrdinalIgnoreCase);
        }
    }

    private static void AssertImmutable(Type type, string[] expectedProperties)
    {
        Assert.True(type.IsSealed || type.IsValueType);
        Assert.Empty(type.GetConstructors(BindingFlags.Public | BindingFlags.Instance));
        var properties = type
            .GetProperties(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
            .OrderBy(property => property.Name, StringComparer.Ordinal)
            .ToArray();
        Assert.Equal(expectedProperties, properties.Select(property => property.Name));
        Assert.All(properties, property => Assert.False(property.CanWrite));
    }

    private static int Count(string value, string fragment)
    {
        var count = 0;
        var offset = 0;
        while ((offset = value.IndexOf(fragment, offset, StringComparison.Ordinal)) >= 0)
        {
            count++;
            offset += fragment.Length;
        }

        return count;
    }

    private static string[] Owners(string fragment) => ProductionFiles()
        .Where(file => Code(file).Contains(fragment, StringComparison.Ordinal))
        .Select(Path.GetFileName)
        .OrderBy(name => name, StringComparer.Ordinal)
        .ToArray()!;

    private static string Code(string file) => PlatformHostSeamTests.CodeOnly(File.ReadAllText(file));

    private static string SourceFile(string name) => ProductionFiles()
        .Single(file => Path.GetFileName(file) == name);

    private static string[] ProductionFiles() => Directory
        .EnumerateFiles(ProductionRoot(), "*.cs", SearchOption.AllDirectories)
        .Where(file => !file.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
            && !file.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
        .ToArray();

    private static string ProductionRoot([CallerFilePath] string sourceFile = "") =>
        Path.GetFullPath(Path.Combine(
            Path.GetDirectoryName(sourceFile)!,
            "..",
            "..",
            "Jellyfin.Plugin.JellyfinCanopy"));
}
