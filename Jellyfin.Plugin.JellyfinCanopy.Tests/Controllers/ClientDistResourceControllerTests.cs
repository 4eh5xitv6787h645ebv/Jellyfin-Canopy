using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers;

public sealed class ClientDistResourceControllerTests
{
    private const string BuildId =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    private static readonly byte[] BootBytes =
        Encoding.UTF8.GetBytes("import '../chunks/chunk-ABC123.js';\n");
    private static readonly byte[] ChunkBytes =
        Encoding.UTF8.GetBytes("export const shared = true;\n");
    private static readonly byte[] MapBytes =
        Encoding.UTF8.GetBytes("{\"version\":3,\"sources\":[]}");

    [Fact]
    public void Catalog_ResolvesBareAndCurrentGenerationPathsOnly()
    {
        var fixture = CreateFixture();

        var bare = fixture.Catalog.Resolve("entries/boot.js");
        Assert.Equal(ClientDistResolutionStatus.Found, bare.Status);
        Assert.False(bare.IsGenerationScoped);
        Assert.Equal(BootBytes, bare.Resource!.Content);

        var generated = fixture.Catalog.Resolve(
            $"{BuildId}/chunks/chunk-ABC123.js");
        Assert.Equal(ClientDistResolutionStatus.Found, generated.Status);
        Assert.True(generated.IsGenerationScoped);
        Assert.Equal(ChunkBytes, generated.Resource!.Content);

        var stale = fixture.Catalog.Resolve(
            $"{new string('b', 64)}/entries/boot.js");
        Assert.Equal(ClientDistResolutionStatus.StaleGeneration, stale.Status);

        Assert.Equal(
            ClientDistResolutionStatus.Unknown,
            fixture.Catalog.Resolve($"{BuildId}/client-manifest.json").Status);
        Assert.Equal(
            ClientDistResolutionStatus.Unknown,
            fixture.Catalog.Resolve("entries/unknown.js").Status);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("../entries/boot.js")]
    [InlineData("entries/../boot.js")]
    [InlineData("entries//boot.js")]
    [InlineData("/entries/boot.js")]
    [InlineData("entries/boot.js/")]
    [InlineData("entries\\boot.js")]
    [InlineData("entries/%2e%2e/boot.js")]
    [InlineData("entries/boot.js?attempt=0")]
    [InlineData("entries/boot.js#fragment")]
    public void Catalog_RejectsUnsafePathsBeforeLookup(string? path)
    {
        var resolution = CreateFixture().Catalog.Resolve(path);

        Assert.Equal(ClientDistResolutionStatus.Invalid, resolution.Status);
        Assert.Null(resolution.Resource);
    }

    [Theory]
    [InlineData("../entries/boot.js")]
    [InlineData("entries/%2e%2e/boot.js")]
    [InlineData("entries/unknown.js")]
    [InlineData("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/entries/boot.js")]
    public void Delivery_ReturnsNonCacheable404ForUnsafeUnknownOrStalePaths(
        string path)
    {
        var controller = CreateController(CreateFixture().Catalog);

        Assert.IsType<NotFoundResult>(controller.GetBundleResource(path));
        Assert.Equal(
            "no-store",
            controller.Response.Headers.CacheControl.ToString());
        Assert.False(controller.Response.Headers.ContainsKey("ETag"));
    }

    [Theory]
    [InlineData(null, true)]
    [InlineData("?attempt=0", true)]
    [InlineData("?attempt=1", true)]
    [InlineData("?attempt=2", true)]
    [InlineData("?attempt=3", false)]
    [InlineData("?attempt=-1", false)]
    [InlineData("?attempt=+1", false)]
    [InlineData("?attempt=01", false)]
    [InlineData("?attempt=0&attempt=1", false)]
    [InlineData("?attempt=1&v=legacy", false)]
    [InlineData("?v=legacy", false)]
    public void GenerationRoute_BoundsRetryCacheKeys(
        string? query,
        bool expectedSuccess)
    {
        var controller = CreateController(
            CreateFixture().Catalog,
            devMode: false,
            query);

        var result = controller.GetBundleResource(
            $"{BuildId}/entries/boot.js");

        if (expectedSuccess)
        {
            Assert.IsType<FileContentResult>(result);
        }
        else
        {
            Assert.IsType<NotFoundResult>(result);
            Assert.Equal("no-store", controller.Response.Headers.CacheControl.ToString());
        }
    }

    [Fact]
    public void BareCompatibilityRoute_RetainsVersionQueryButRejectsRetrySuffix()
    {
        var versioned = CreateController(
            CreateFixture().Catalog,
            devMode: false,
            "?v=2.0.0.0-123");
        Assert.IsType<FileContentResult>(
            versioned.GetBundleResource("entries/boot.js"));

        var retry = CreateController(
            CreateFixture().Catalog,
            devMode: false,
            "?attempt=1");
        Assert.IsType<NotFoundResult>(
            retry.GetBundleResource("entries/boot.js"));
    }

    [Fact]
    public void Delivery_UsesSuffixDerivedMimeAndExactEmbeddedBytes()
    {
        var fixture = CreateFixture();
        var jsController = CreateController(fixture.Catalog);
        var js = Assert.IsType<FileContentResult>(
            jsController.GetBundleResource("entries/boot.js"));
        Assert.Equal(ClientDistResourceCatalog.JavaScriptContentType, js.ContentType);
        Assert.Equal(BootBytes, js.FileContents);

        var mapController = CreateController(fixture.Catalog);
        var map = Assert.IsType<FileContentResult>(
            mapController.GetBundleResource("entries/boot.js.map"));
        Assert.Equal(ClientDistResourceCatalog.JsonContentType, map.ContentType);
        Assert.Equal(MapBytes, map.FileContents);

        var manifestController = CreateController(fixture.Catalog);
        var manifest = Assert.IsType<FileContentResult>(
            manifestController.GetBundleResource(ClientDistResourceCatalog.ManifestPath));
        Assert.Equal(ClientDistResourceCatalog.JsonContentType, manifest.ContentType);
        Assert.Equal(fixture.ManifestBytes, manifest.FileContents);
    }

    [Fact]
    public void ProductionDelivery_RevalidatesManifestAndCachesAssetsImmutably()
    {
        var fixture = CreateFixture();
        var manifestController = CreateController(fixture.Catalog);
        manifestController.GetBundleResource(ClientDistResourceCatalog.ManifestPath);
        Assert.Equal(
            "public, max-age=0, must-revalidate",
            manifestController.Response.Headers.CacheControl.ToString());

        var fileController = CreateController(fixture.Catalog);
        fileController.GetBundleResource($"{BuildId}/entries/boot.js");
        Assert.Equal(
            "public, max-age=31536000, immutable",
            fileController.Response.Headers.CacheControl.ToString());
    }

    [Fact]
    public void DevMode_AlwaysUsesNoStore()
    {
        var controller = CreateController(
            CreateFixture().Catalog,
            devMode: true,
            "?attempt=2");

        Assert.IsType<FileContentResult>(controller.GetBundleResource(
            $"{BuildId}/entries/boot.js"));
        Assert.Equal("no-store", controller.Response.Headers.CacheControl.ToString());
    }

    [Theory]
    [InlineData("*")]
    [InlineData("W/\"unrelated\", W/\"sha256-{0}\"")]
    [InlineData("\"unrelated\", \"sha256-{0}\"")]
    public void MatchingIfNoneMatch_Returns304WithStrongSha256Validator(
        string headerTemplate)
    {
        var expectedSha = Sha256(BootBytes);
        var controller = CreateController(CreateFixture().Catalog);
        controller.Request.Headers.IfNoneMatch = string.Format(
            System.Globalization.CultureInfo.InvariantCulture,
            headerTemplate,
            expectedSha);

        var result = Assert.IsType<StatusCodeResult>(
            controller.GetBundleResource("entries/boot.js"));

        Assert.Equal(StatusCodes.Status304NotModified, result.StatusCode);
        Assert.Equal(
            $"\"sha256-{expectedSha}\"",
            controller.Response.Headers.ETag.ToString());
        Assert.Equal(
            "public, max-age=31536000, immutable",
            controller.Response.Headers.CacheControl.ToString());
    }

    [Fact]
    public void NonMatchingIfNoneMatch_ReturnsBytesWithSha256Validator()
    {
        var controller = CreateController(CreateFixture().Catalog);
        controller.Request.Headers.IfNoneMatch = "\"sha256-unknown\"";

        var result = Assert.IsType<FileContentResult>(
            controller.GetBundleResource("entries/boot.js"));

        Assert.Equal(BootBytes, result.FileContents);
        Assert.Equal(
            $"\"sha256-{Sha256(BootBytes)}\"",
            controller.Response.Headers.ETag.ToString());
    }

    [Theory]
    [InlineData("content-type")]
    [InlineData("digest")]
    [InlineData("length")]
    [InlineData("unknown-import")]
    [InlineData("unsafe-path")]
    [InlineData("kind")]
    [InlineData("build-id")]
    [InlineData("resource-collision")]
    public void Catalog_FailsClosedOnManifestOrByteDrift(string mutation)
    {
        var fixture = CreateFixture();
        var manifest = JsonNode.Parse(fixture.ManifestBytes)!.AsObject();
        var files = manifest["files"]!.AsObject();
        var resources = fixture.Resources.ToDictionary(
            pair => pair.Key,
            pair => pair.Value,
            StringComparer.Ordinal);

        switch (mutation)
        {
            case "content-type":
                files["entries/boot.js"]!["contentType"] = "application/javascript";
                break;
            case "digest":
                files["entries/boot.js"]!["sha256"] = new string('f', 64);
                break;
            case "length":
                files["entries/boot.js"]!["bytes"] = BootBytes.Length + 1;
                break;
            case "unknown-import":
                files["entries/boot.js"]!["imports"] = new JsonArray("chunks/missing.js");
                break;
            case "unsafe-path":
                files["../escape.js"] = files["entries/boot.js"]!.DeepClone();
                resources["../escape.js"] = BootBytes;
                break;
            case "kind":
                files["entries/boot.js"]!["kind"] = "chunk";
                break;
            case "build-id":
                manifest["buildId"] = BuildId.ToUpperInvariant();
                break;
            case "resource-collision":
                files["entries.boot/js.map"] = files["entries/boot.js.map"]!.DeepClone();
                resources["entries.boot/js.map"] = MapBytes;
                break;
        }

        var mutatedManifest = JsonSerializer.SerializeToUtf8Bytes(manifest);
        resources[ClientDistResourceCatalog.ManifestPath] = mutatedManifest;

        Assert.Throws<InvalidOperationException>(() =>
            ClientDistResourceCatalog.Create(mutatedManifest, resources));
    }

    [Fact]
    public void Catalog_RejectsUnlistedEmbeddedResources()
    {
        var fixture = CreateFixture();
        var resources = fixture.Resources.ToDictionary(
            pair => pair.Key,
            pair => pair.Value,
            StringComparer.Ordinal);
        resources["chunks/unlisted.js"] = ChunkBytes;

        Assert.Throws<InvalidOperationException>(() =>
            ClientDistResourceCatalog.Create(fixture.ManifestBytes, resources));
    }

    private static Fixture CreateFixture()
    {
        var files = new SortedDictionary<string, object>(StringComparer.Ordinal)
        {
            ["chunks/chunk-ABC123.js"] = FileDescriptor(
                ChunkBytes,
                "chunk",
                ClientDistResourceCatalog.JavaScriptContentType),
            ["entries/boot.js"] = FileDescriptor(
                BootBytes,
                "module-entry",
                ClientDistResourceCatalog.JavaScriptContentType,
                imports: new[] { "chunks/chunk-ABC123.js" },
                entryPoint: "Jellyfin.Plugin.JellyfinCanopy/src/entries/boot.ts"),
            ["entries/boot.js.map"] = FileDescriptor(
                MapBytes,
                "source-map",
                ClientDistResourceCatalog.JsonContentType),
        };
        var manifest = new
        {
            schemaVersion = 2,
            buildId = BuildId,
            entries = new SortedDictionary<string, object>(StringComparer.Ordinal)
            {
                ["boot"] = new
                {
                    kind = "module",
                    path = "entries/boot.js",
                    role = "boot",
                },
            },
            files,
            budgets = new { outputCount = files.Count + 1 },
        };
        var manifestBytes = JsonSerializer.SerializeToUtf8Bytes(manifest);
        var resources = new Dictionary<string, byte[]>(StringComparer.Ordinal)
        {
            [ClientDistResourceCatalog.ManifestPath] = manifestBytes,
            ["chunks/chunk-ABC123.js"] = ChunkBytes,
            ["entries/boot.js"] = BootBytes,
            ["entries/boot.js.map"] = MapBytes,
        };
        return new Fixture(
            ClientDistResourceCatalog.Create(manifestBytes, resources),
            manifestBytes,
            resources);
    }

    private static object FileDescriptor(
        byte[] bytes,
        string kind,
        string contentType,
        string[]? imports = null,
        string? entryPoint = null)
        => new
        {
            bytes = bytes.Length,
            contentType,
            dynamicImports = Array.Empty<string>(),
            gzipBytes = Math.Max(1, bytes.Length / 2),
            imports = imports ?? Array.Empty<string>(),
            kind,
            sha256 = Sha256(bytes),
            entryPoint,
        };

    private static string Sha256(byte[] bytes)
        => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static ConfigController CreateController(
        ClientDistResourceCatalog catalog,
        bool devMode = false,
        string? query = null)
    {
        var controller = new ConfigController(
            null!,
            NullLogger<ConfigController>.Instance,
            null!,
            null!,
            new FakePluginConfigProvider(new PluginConfiguration
            {
                DevMode = devMode,
            }),
            null!,
            new LocaleMissLogLimiter(),
            catalog);
        var context = new DefaultHttpContext();
        if (query != null)
        {
            context.Request.QueryString = new QueryString(query);
        }

        controller.ControllerContext = new ControllerContext
        {
            HttpContext = context,
        };
        return controller;
    }

    private sealed record Fixture(
        ClientDistResourceCatalog Catalog,
        byte[] ManifestBytes,
        IReadOnlyDictionary<string, byte[]> Resources);
}
