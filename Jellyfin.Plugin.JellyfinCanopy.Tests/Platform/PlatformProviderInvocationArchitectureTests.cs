using System.IO;
using System.Runtime.CompilerServices;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

public sealed class PlatformProviderInvocationArchitectureTests
{
    private const string InvocationFile = "PlatformProviderInvocationService.cs";
    private const string ValidatorFile = "PlatformProviderJsonPayloadValidator.cs";

    [Fact]
    public void InvocationCoordinatorIsTheOnlyForeignMethodOwnerAndNeverRediscoversTypes()
    {
        Assert.Equal(new[] { InvocationFile }, Owners("InvocationMethod.Invoke"));
        var code = Code(SourceFile(InvocationFile));
        Assert.Contains("TryAcquireInvocationLease", code, StringComparison.Ordinal);
        Assert.Contains("TryAcquireResultReleaseLease", code, StringComparison.Ordinal);
        Assert.Contains("_host.Revalidate", code, StringComparison.Ordinal);
        Assert.Contains("WaitAsync(", code, StringComparison.Ordinal);
        Assert.DoesNotContain("Task.WhenAny", code, StringComparison.Ordinal);
        Assert.Contains(
            "finally\n            {\n                resultRelease.Dispose();\n            }\n\n"
            + "            CompleteOwnedInvocation(providerTask, invocationLease, cancellation);",
            code,
            StringComparison.Ordinal);
        foreach (var forbidden in new[]
        {
            "Assembly.Load", "LoadFromAssemblyPath", "Activator", "Type.GetType",
            "GetMethods(", "GetMethod(", "IServiceProvider", "IPluginManager", "LocalPlugin",
            "System.IO", "File.", "Directory.", "Path.", "HttpContext", "ClaimsPrincipal",
            "Controller", "Route(", "HttpClient", "ConcurrentDictionary", "MemoryCache",
            "BackgroundService", "IHostedService", "Android", "CanopyConformance",
        })
        {
            Assert.DoesNotContain(forbidden, code, StringComparison.OrdinalIgnoreCase);
        }
    }

    [Fact]
    public void PayloadValidatorIsLocalBoundedAndHasNoResolverOrSidecarDependency()
    {
        var code = Code(SourceFile(ValidatorFile));
        Assert.Contains(nameof(PlatformProviderAbiContract.MaximumRequestDocumentBytes), code, StringComparison.Ordinal);
        Assert.Contains(nameof(PlatformProviderAbiContract.MaximumResponseDocumentBytes), code, StringComparison.Ordinal);
        Assert.Contains(nameof(PlatformProviderJsonPayloadValidator.MaximumSchemaWorkUnits), code, StringComparison.Ordinal);
        foreach (var forbidden in new[]
        {
            "System.IO", "File.", "Directory.", "Path.", "HttpClient", "WebRequest",
            "Assembly", "Reflection", "JsonSchema.Net", "NJsonSchema",
            "Regex", "ConcurrentDictionary", "MemoryCache", "Controller", "Route(", "Android",
        })
        {
            Assert.DoesNotContain(forbidden, code, StringComparison.OrdinalIgnoreCase);
        }

        var project = File.ReadAllText(Path.Combine(ProductionRoot(), "JellyfinCanopy.csproj"));
        Assert.DoesNotContain("JsonSchema.Net", project, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("NJsonSchema", project, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void CompositionIsOneLazySingletonWithNoRouteOrStartupWorker()
    {
        var registrator = Code(SourceFile("PluginServiceRegistrator.cs"));
        Assert.Contains(
            "AddSingleton(serviceProvider => new PlatformProviderInvocationService(",
            registrator,
            StringComparison.Ordinal);
        Assert.Equal(new[] { "PluginServiceRegistrator.cs" }, Owners("new PlatformProviderInvocationService("));

        var production = string.Join('\n', ProductionFiles().Select(Code));
        Assert.DoesNotContain("PlatformProviderInvocationController", production, StringComparison.Ordinal);
        Assert.DoesNotContain("AddHostedService<PlatformProviderInvocation", production, StringComparison.Ordinal);
        Assert.DoesNotContain("IHostedService<PlatformProviderInvocation", production, StringComparison.Ordinal);
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
        .Where(file => !file.Contains(
            $"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}",
            StringComparison.Ordinal)
            && !file.Contains(
                $"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}",
                StringComparison.Ordinal))
        .ToArray();

    private static string ProductionRoot([CallerFilePath] string sourceFile = "") =>
        Path.GetFullPath(Path.Combine(
            Path.GetDirectoryName(sourceFile)!,
            "..",
            "..",
            "Jellyfin.Plugin.JellyfinCanopy"));
}
