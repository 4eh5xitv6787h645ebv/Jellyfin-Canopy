using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.CompilerServices;
using System.Text.Json;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

public sealed class PlatformProviderFixtureContractTests
{
    private static readonly Fixture Alpha = new(
        "Jellyfin.Plugin.CanopyConformance.Alpha",
        "AlphaPlugin.cs",
        "AAA Canopy Conformance Alpha",
        "0a110000-1111-4222-8333-444455556666",
        new[]
        {
            "jellyfin.canopy.items.lookup",
            "jellyfin.canopy.storage.read",
        });

    private static readonly Fixture Omega = new(
        "Jellyfin.Plugin.CanopyConformance.Omega",
        "OmegaPlugin.cs",
        "ZZZ Canopy Conformance Omega",
        "0b220000-1111-4222-8333-444455556777",
        new[]
        {
            "jellyfin.canopy.user-data.read",
            "jellyfin.canopy.ui.contribute",
            "jellyfin.canopy.integrations.invoke",
        });

    [Fact]
    public void FixturesHaveIndependentExactIdentitiesAndOppositeLoadOrder()
    {
        var alpha = ReadFixture(Alpha);
        var omega = ReadFixture(Omega);

        Assert.Equal(Alpha.Name, alpha.MetaName);
        Assert.Equal(Omega.Name, omega.MetaName);
        Assert.True(StringComparer.OrdinalIgnoreCase.Compare(alpha.MetaName, "Jellyfin Canopy") < 0);
        Assert.True(StringComparer.OrdinalIgnoreCase.Compare(omega.MetaName, "Jellyfin Canopy") > 0);
        Assert.NotEqual(alpha.PluginId, omega.PluginId);
        Assert.NotEqual(alpha.ExtensionId, omega.ExtensionId);
        Assert.NotEqual(alpha.Assembly, omega.Assembly);
        Assert.Empty(alpha.Capabilities.Intersect(omega.Capabilities, StringComparer.Ordinal));
        Assert.Equal(Alpha.Capabilities, alpha.Capabilities);
        Assert.Equal(Omega.Capabilities, omega.Capabilities);
    }

    [Theory]
    [MemberData(nameof(Fixtures))]
    public void FixtureSourceReferencesOnlyJellyfinAndContainsNoRuntimeSurface(string fixtureName)
    {
        var fixture = FixtureByName(fixtureName);
        var root = FixtureRoot(fixture);
        var project = File.ReadAllText(Path.Combine(root, fixture.Assembly + ".csproj"));
        var source = File.ReadAllText(Path.Combine(root, fixture.SourceFile));

        Assert.DoesNotContain("ProjectReference", project, StringComparison.Ordinal);
        Assert.Equal(2, Count(project, "<PackageReference Include="));
        Assert.Contains("Jellyfin.Controller", project, StringComparison.Ordinal);
        Assert.Contains("Jellyfin.Model", project, StringComparison.Ordinal);
        Assert.Contains("<IsPackable>false</IsPackable>", project, StringComparison.Ordinal);
        Assert.Contains(fixture.Name, source, StringComparison.Ordinal);
        Assert.Contains(fixture.PluginId, source, StringComparison.Ordinal);
        foreach (var forbidden in new[]
        {
            "JellyfinCanopy", "Jellyfin.Plugin.JellyfinCanopy", "Controller", "Route(",
            "IHostedService", "IScheduledTask", "IPluginServiceRegistrator", "Reflection",
            "Assembly.Load", "Invoke", "HttpClient",
        })
        {
            Assert.DoesNotContain(forbidden, source, StringComparison.OrdinalIgnoreCase);
        }
    }

    [Theory]
    [MemberData(nameof(Fixtures))]
    public void StagedPackageContainsExactlyOwnAssemblyMetaAndExtensionManifest(string fixtureName)
    {
        var fixture = FixtureByName(fixtureName);
        var package = Path.Combine(
            FixtureRoot(fixture),
            "bin",
            "Release",
            "net10.0",
            "package");
        Assert.True(Directory.Exists(package), $"Missing fixture package: {package}");
        Assert.Equal(
            new[]
            {
                fixture.Assembly + ".dll",
                "jellyfin-canopy-extension.json",
                "meta.json",
            },
            Directory.EnumerateFiles(package, "*", SearchOption.AllDirectories)
                .Select(path => Path.GetRelativePath(package, path))
                .OrderBy(name => name, StringComparer.Ordinal));
        Assert.Empty(Directory.EnumerateDirectories(package, "*", SearchOption.AllDirectories));

        using var stream = File.OpenRead(Path.Combine(package, fixture.Assembly + ".dll"));
        using var pe = new PEReader(stream);
        var metadata = pe.GetMetadataReader();
        var ownAssembly = metadata.GetAssemblyDefinition();
        Assert.Equal(fixture.Assembly, metadata.GetString(ownAssembly.Name));
        Assert.Equal(new Version(1, 0, 0, 0), ownAssembly.Version);
        var references = metadata.AssemblyReferences
            .Select(handle => metadata.GetString(metadata.GetAssemblyReference(handle).Name))
            .ToArray();
        Assert.DoesNotContain(references, name =>
            name.Contains("Canopy", StringComparison.OrdinalIgnoreCase)
            || name.EndsWith("Tests", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void ProductionReleaseInputsNeverReferenceFixtureArtifacts()
    {
        var root = RepositoryRoot();
        foreach (var relative in new[]
        {
            ".github/workflows/release.yml",
            "scripts/lib/zip-layout.js",
            "Jellyfin.Plugin.JellyfinCanopy/JellyfinCanopy.csproj",
        })
        {
            var content = File.ReadAllText(Path.Combine(root, relative));
            Assert.DoesNotContain("CanopyConformance", content, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("platform-providers", content, StringComparison.OrdinalIgnoreCase);
        }
    }

    [Fact]
    public void DeterministicVariantInventoryAndPackagesAreClosedAndIndependent()
    {
        var root = Path.Combine(
            RepositoryRoot(),
            "conformance",
            "platform-providers");
        using var scenarios = JsonDocument.Parse(
            File.ReadAllBytes(Path.Combine(root, "variants", "scenarios.json")));
        Assert.Equal(1, scenarios.RootElement.GetProperty("schemaVersion").GetInt32());
        Assert.Equal(
            new[]
            {
                "baseline", "upgrade", "downgrade", "assembly-drift",
                "requested-scope-drift", "malformed-manifest", "disabled",
                "restart-pending", "removed", "same-guid-reinstall",
                "load-order-alpha-canopy-omega", "load-order-omega-canopy-alpha", "aba",
            },
            scenarios.RootElement.GetProperty("scenarios")
                .EnumerateArray()
                .Select(value => value.GetProperty("id").GetString()));

        foreach (var variant in new[]
        {
            (Project: "Jellyfin.Plugin.CanopyConformance.Alpha.Upgrade", Version: new Version(1, 1, 0, 0)),
            (Project: "Jellyfin.Plugin.CanopyConformance.Alpha.Downgrade", Version: new Version(0, 9, 0, 0)),
            (Project: "Jellyfin.Plugin.CanopyConformance.Alpha.AssemblyDrift", Version: new Version(1, 0, 0, 0)),
        })
        {
            var projectRoot = Path.Combine(root, variant.Project);
            var project = File.ReadAllText(Path.Combine(projectRoot, variant.Project + ".csproj"));
            Assert.DoesNotContain("ProjectReference", project, StringComparison.Ordinal);
            Assert.DoesNotContain("JellyfinCanopy", project, StringComparison.Ordinal);
            Assert.Equal(2, Count(project, "<PackageReference Include="));
            var package = Path.Combine(projectRoot, "bin", "Release", "net10.0", "package");
            Assert.Equal(
                new[]
                {
                    "Jellyfin.Plugin.CanopyConformance.Alpha.dll",
                    "jellyfin-canopy-extension.json",
                    "meta.json",
                },
                Directory.EnumerateFiles(package, "*", SearchOption.AllDirectories)
                    .Select(path => Path.GetRelativePath(package, path))
                    .OrderBy(value => value, StringComparer.Ordinal));
            Assert.Empty(Directory.EnumerateDirectories(package, "*", SearchOption.AllDirectories));
            using var stream = File.OpenRead(Path.Combine(
                package,
                "Jellyfin.Plugin.CanopyConformance.Alpha.dll"));
            using var pe = new PEReader(stream);
            var metadata = pe.GetMetadataReader();
            var definition = metadata.GetAssemblyDefinition();
            Assert.Equal(
                "Jellyfin.Plugin.CanopyConformance.Alpha",
                metadata.GetString(definition.Name));
            Assert.Equal(variant.Version, definition.Version);
            using var meta = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(package, "meta.json")));
            using var extension = JsonDocument.Parse(File.ReadAllBytes(
                Path.Combine(package, "jellyfin-canopy-extension.json")));
            Assert.Equal(variant.Version.ToString(), meta.RootElement.GetProperty("version").GetString());
            Assert.Equal(
                meta.RootElement.GetProperty("version").GetString(),
                extension.RootElement.GetProperty("version").GetString());
            Assert.Equal(Alpha.PluginId, extension.RootElement.GetProperty("pluginId").GetString());
        }

        Assert.True(File.Exists(Path.Combine(
            root,
            "variants",
            "alpha-scope-drift",
            "jellyfin-canopy-extension.json")));
        Assert.True(File.Exists(Path.Combine(
            root,
            "variants",
            "alpha-malformed",
            "jellyfin-canopy-extension.json")));
    }

    public static TheoryData<string> Fixtures => new()
    {
        Alpha.Assembly,
        Omega.Assembly,
    };

    private static FixtureContract ReadFixture(Fixture fixture)
    {
        var root = FixtureRoot(fixture);
        using var meta = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(root, "meta.json")));
        using var extension = JsonDocument.Parse(
            File.ReadAllBytes(Path.Combine(root, "jellyfin-canopy-extension.json")));
        var metaRoot = meta.RootElement;
        var extensionRoot = extension.RootElement;
        var assembly = Assert.Single(metaRoot.GetProperty("assemblies").EnumerateArray()).GetString();
        Assert.Equal(fixture.Assembly + ".dll", assembly);
        Assert.Equal(fixture.PluginId, metaRoot.GetProperty("guid").GetString());
        Assert.Equal(fixture.Name, metaRoot.GetProperty("name").GetString());
        Assert.Equal(metaRoot.GetProperty("guid").GetString(), extensionRoot.GetProperty("pluginId").GetString());
        Assert.Equal(metaRoot.GetProperty("version").GetString(), extensionRoot.GetProperty("version").GetString());
        return new FixtureContract(
            metaRoot.GetProperty("name").GetString()!,
            metaRoot.GetProperty("guid").GetString()!,
            extensionRoot.GetProperty("id").GetString()!,
            fixture.Assembly,
            extensionRoot.GetProperty("requestedCapabilities")
                .EnumerateArray()
                .Select(value => value.GetString()!)
                .ToArray());
    }

    private static Fixture FixtureByName(string name) =>
        name == Alpha.Assembly ? Alpha : Omega;

    private static string FixtureRoot(Fixture fixture) =>
        Path.Combine(RepositoryRoot(), "conformance", "platform-providers", fixture.Assembly);

    private static int Count(string value, string token) =>
        (value.Length - value.Replace(token, string.Empty, StringComparison.Ordinal).Length) / token.Length;

    private static string RepositoryRoot([CallerFilePath] string sourceFile = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(sourceFile)!, "..", ".."));

    private sealed record Fixture(
        string Assembly,
        string SourceFile,
        string Name,
        string PluginId,
        IReadOnlyList<string> Capabilities);

    private sealed record FixtureContract(
        string MetaName,
        string PluginId,
        string ExtensionId,
        string Assembly,
        IReadOnlyList<string> Capabilities);
}
