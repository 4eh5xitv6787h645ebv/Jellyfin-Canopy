using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using System.Security.Cryptography;
using System.Text.Json;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

public sealed class PlatformProviderFixtureContractTests
{
    private const string RequestSchemaSha256 = "9cb99774427c0836710a42bf94cb647980f76fe6150300f9b8e824f667402330";
    private const string ResponseSchemaSha256 = "dd8c7f2456f95f2404c9274e1b2dfa7e71958d7013e53cd35dbfcb8fe1bbffd2";
    private const string SchemaResourcePrefix = "JellyfinCanopy.ProviderSchemas.";
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
        var source = string.Join(
            "\n",
            Directory.EnumerateFiles(root, "*.cs", SearchOption.TopDirectoryOnly)
                .OrderBy(path => path, StringComparer.Ordinal)
                .Select(File.ReadAllText));

        Assert.DoesNotContain("ProjectReference", project, StringComparison.Ordinal);
        Assert.Equal(2, Count(project, "<PackageReference Include="));
        Assert.Contains("Jellyfin.Controller", project, StringComparison.Ordinal);
        Assert.Contains("Jellyfin.Model", project, StringComparison.Ordinal);
        Assert.Contains("<IsPackable>false</IsPackable>", project, StringComparison.Ordinal);
        Assert.Contains(fixture.Name, source, StringComparison.Ordinal);
        Assert.Contains(fixture.PluginId, source, StringComparison.Ordinal);
        foreach (var forbidden in new[]
        {
            "Jellyfin.Plugin.JellyfinCanopy", "ControllerBase", "Route(",
            "IHostedService", "IScheduledTask", "Reflection", "Assembly.Load", "HttpClient",
        })
        {
            Assert.DoesNotContain(forbidden, source, StringComparison.OrdinalIgnoreCase);
        }
    }

    [Fact]
    public async Task AlphaHelloEntrypointUsesExactConcreteTypeRegistrationAndJsonAbi()
    {
        var root = FixtureRoot(Alpha);
        var entrypointSource = File.ReadAllText(Path.Combine(root, "ExtensionProviderEntrypoint.cs"));
        var registrationSource = File.ReadAllText(Path.Combine(root, "AlphaPluginServiceRegistrator.cs"));
        using var manifest = JsonDocument.Parse(File.ReadAllBytes(
            Path.Combine(root, "jellyfin-canopy-extension.json")));

        Assert.Contains("namespace JellyfinCanopy;", entrypointSource, StringComparison.Ordinal);
        Assert.Contains("public sealed class ExtensionProviderEntrypoint", entrypointSource, StringComparison.Ordinal);
        Assert.Contains(
            "public const string HelloOperationId = \"org.jellyfin.canopy.conformance.hello\";",
            entrypointSource,
            StringComparison.Ordinal);
        Assert.Contains("public Task<string> InvokeAsync(", entrypointSource, StringComparison.Ordinal);
        Assert.Contains("string operationId,", entrypointSource, StringComparison.Ordinal);
        Assert.Contains("string requestJson,", entrypointSource, StringComparison.Ordinal);
        Assert.Contains("CancellationToken cancellationToken)", entrypointSource, StringComparison.Ordinal);
        Assert.Contains("IPluginServiceRegistrator", registrationSource, StringComparison.Ordinal);
        Assert.Contains(
            "AddSingleton<global::JellyfinCanopy.ExtensionProviderEntrypoint>()",
            registrationSource,
            StringComparison.Ordinal);
        Assert.DoesNotContain("AddSingleton<", registrationSource.Replace(
            "AddSingleton<global::JellyfinCanopy.ExtensionProviderEntrypoint>()",
            string.Empty,
            StringComparison.Ordinal), StringComparison.Ordinal);
        var operation = Assert.Single(manifest.RootElement.GetProperty("providerOperations").EnumerateArray());
        Assert.Equal("org.jellyfin.canopy.conformance.hello", operation.GetProperty("id").GetString());
        Assert.Equal(1, operation.GetProperty("protocol").GetProperty("min").GetInt32());
        Assert.Equal(1, operation.GetProperty("protocol").GetProperty("max").GetInt32());
        Assert.Equal(
            "jellyfin.canopy.items.lookup",
            Assert.Single(operation.GetProperty("requiredCapabilities").EnumerateArray()).GetString());
        Assert.Equal(
            "urn:jellyfin-canopy:provider-schema:org.jellyfin.canopy-alpha:org.jellyfin.canopy.conformance.hello:request:1",
            operation.GetProperty("requestSchemaId").GetString());
        Assert.Equal(RequestSchemaSha256, operation.GetProperty("requestSchemaSha256").GetString());
        Assert.Equal(
            "urn:jellyfin-canopy:provider-schema:org.jellyfin.canopy-alpha:org.jellyfin.canopy.conformance.hello:response:1",
            operation.GetProperty("responseSchemaId").GetString());
        Assert.Equal(ResponseSchemaSha256, operation.GetProperty("responseSchemaSha256").GetString());

        var assemblyPath = Path.Combine(root, "bin", "Release", "net10.0", Alpha.Assembly + ".dll");
        Assert.True(File.Exists(assemblyPath), $"Missing fixture assembly: {assemblyPath}");
        var loadContext = new AssemblyLoadContext("alpha-hello-contract", isCollectible: true);
        try
        {
            var assembly = loadContext.LoadFromAssemblyPath(assemblyPath);
            AssertEmbeddedSchemaResources(assembly, operation);
            var type = assembly.GetType("JellyfinCanopy.ExtensionProviderEntrypoint", throwOnError: true)!;
            Assert.True(type.IsSealed);
            var method = Assert.Single(type.GetMethods(), candidate => candidate.Name == "InvokeAsync");
            Assert.Equal(typeof(Task<string>).FullName, method.ReturnType.FullName);
            Assert.Equal(
                new[]
                {
                    typeof(string).FullName,
                    typeof(string).FullName,
                    typeof(CancellationToken).FullName,
                },
                method.GetParameters().Select(parameter => parameter.ParameterType.FullName));
            const string requestJson = """
                {"schemaVersion":1,"correlationId":"01J00000000000000000000000","protocol":1,"grantedScopes":["jellyfin.canopy.items.lookup"],"attribution":{"user":"opaque-user-01","device":"opaque-device-01"},"context":{"itemId":"11111111-2222-3333-8444-555555555555","surface":"item-detail"},"hints":{"locale":"en-AU","accessibility":["reduced-motion"]},"remainingDeadlineMilliseconds":2500,"input":{"name":"Canopy"}}
                """;
            var entrypoint = Activator.CreateInstance(type);
            var invocation = Assert.IsType<Task<string>>(method.Invoke(
                entrypoint,
                new object[]
                {
                    "org.jellyfin.canopy.conformance.hello",
                    requestJson,
                    CancellationToken.None,
                }));
            Assert.Equal(
                "{\"schemaVersion\":1,\"correlationId\":\"01J00000000000000000000000\",\"protocol\":1,\"result\":{\"message\":\"Hello, Canopy!\"}}",
                await invocation);
        }
        finally
        {
            loadContext.Unload();
        }
    }

    [Fact]
    public void OmegaRemainsIdentityOnlyAndNonCallable()
    {
        var source = string.Join(
            "\n",
            Directory.EnumerateFiles(FixtureRoot(Omega), "*.cs", SearchOption.TopDirectoryOnly)
                .OrderBy(path => path, StringComparer.Ordinal)
                .Select(File.ReadAllText));

        Assert.DoesNotContain("IPluginServiceRegistrator", source, StringComparison.Ordinal);
        Assert.DoesNotContain("ExtensionProviderEntrypoint", source, StringComparison.Ordinal);
        Assert.DoesNotContain("InvokeAsync", source, StringComparison.Ordinal);
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
        Assert.Equal(
            fixture == Alpha ? 1 : 0,
            metadata.TypeDefinitions.Count(handle =>
            {
                var type = metadata.GetTypeDefinition(handle);
                return metadata.GetString(type.Namespace) == "JellyfinCanopy"
                    && metadata.GetString(type.Name) == "ExtensionProviderEntrypoint";
            }));
        var references = metadata.AssemblyReferences
            .Select(handle => metadata.GetString(metadata.GetAssemblyReference(handle).Name))
            .ToArray();
        Assert.DoesNotContain(references, name =>
            name.Contains("Canopy", StringComparison.OrdinalIgnoreCase)
            || name.EndsWith("Tests", StringComparison.OrdinalIgnoreCase));
        Assert.All(references, name => Assert.True(
            name.StartsWith("System", StringComparison.Ordinal)
            || name.StartsWith("Microsoft.Extensions.DependencyInjection", StringComparison.Ordinal)
            || name.StartsWith("MediaBrowser.", StringComparison.Ordinal),
            $"Fixture PE contains an unapproved assembly reference: {name}"));
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
            Assert.DoesNotContain("Jellyfin.Plugin.JellyfinCanopy", project, StringComparison.Ordinal);
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
            Assert.Contains(metadata.TypeDefinitions, handle =>
            {
                var type = metadata.GetTypeDefinition(handle);
                return metadata.GetString(type.Namespace) == "JellyfinCanopy"
                    && metadata.GetString(type.Name) == "ExtensionProviderEntrypoint";
            });
            using var meta = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(package, "meta.json")));
            using var extension = JsonDocument.Parse(File.ReadAllBytes(
                Path.Combine(package, "jellyfin-canopy-extension.json")));
            var loadContext = new AssemblyLoadContext("alpha-variant-schema-" + variant.Project, isCollectible: true);
            try
            {
                var assembly = loadContext.LoadFromAssemblyPath(Path.Combine(
                    package,
                    "Jellyfin.Plugin.CanopyConformance.Alpha.dll"));
                var operation = Assert.Single(extension.RootElement
                    .GetProperty("providerOperations")
                    .EnumerateArray());
                AssertEmbeddedSchemaResources(assembly, operation);
            }
            finally
            {
                loadContext.Unload();
            }
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

    private static void AssertEmbeddedSchemaResources(
        System.Reflection.Assembly assembly,
        JsonElement operation)
    {
        var expected = new[]
        {
            (Id: operation.GetProperty("requestSchemaId").GetString()!,
                Sha256: operation.GetProperty("requestSchemaSha256").GetString()!),
            (Id: operation.GetProperty("responseSchemaId").GetString()!,
                Sha256: operation.GetProperty("responseSchemaSha256").GetString()!),
        };
        Assert.Equal(
            expected.Select(schema => SchemaResourcePrefix + schema.Sha256 + ".json")
                .OrderBy(name => name, StringComparer.Ordinal),
            assembly.GetManifestResourceNames()
                .Where(name => name.StartsWith(SchemaResourcePrefix, StringComparison.Ordinal))
                .OrderBy(name => name, StringComparer.Ordinal));

        foreach (var schema in expected)
        {
            using var stream = Assert.IsAssignableFrom<Stream>(assembly.GetManifestResourceStream(
                SchemaResourcePrefix + schema.Sha256 + ".json"));
            using var memory = new MemoryStream();
            stream.CopyTo(memory);
            var bytes = memory.ToArray();
            Assert.Equal(
                schema.Sha256,
                Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant());
            using var document = JsonDocument.Parse(bytes);
            Assert.Equal(schema.Id, document.RootElement.GetProperty("$id").GetString());
            Assert.Equal("object", document.RootElement.GetProperty("type").GetString());
            Assert.False(document.RootElement.GetProperty("additionalProperties").GetBoolean());
        }
    }

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
