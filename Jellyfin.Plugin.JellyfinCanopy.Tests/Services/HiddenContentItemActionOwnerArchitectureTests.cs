using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class HiddenContentItemActionOwnerArchitectureTests
{
    [Fact]
    public void OwnerSource_IsHttpFreeAndHostIndependent()
    {
        var source = PlatformHostSeamTests.CodeOnly(File.ReadAllText(OwnerSource()));
        foreach (var forbidden in new[]
        {
            "Microsoft.AspNetCore",
            "HttpContext",
            "IActionResult",
            "ControllerBase",
            "MediaBrowser",
            "ILibraryManager",
            "IUserManager"
        })
        {
            Assert.DoesNotContain(forbidden, source, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void OwnerInterface_AcceptsOnlyClosedDomainProjectionsAndInput()
    {
        var methods = typeof(IHiddenContentItemActionOwner)
            .GetMethods(BindingFlags.Instance | BindingFlags.Public)
            .OrderBy(method => method.Name, StringComparer.Ordinal)
            .ToArray();

        Assert.Equal(new[] { "Configure", "GetState" }, methods.Select(method => method.Name));
        Assert.All(methods, method => Assert.Equal(typeof(HiddenContentItemActionResult), method.ReturnType));
        Assert.Equal(
            new[]
            {
                typeof(HiddenContentActorProjection),
                typeof(HiddenContentItemProjection),
                typeof(HiddenContentItemConfiguration)
            },
            methods.Single(method => method.Name == "Configure")
                .GetParameters()
                .Select(parameter => parameter.ParameterType));
        Assert.Equal(
            new[]
            {
                typeof(HiddenContentActorProjection),
                typeof(HiddenContentItemProjection),
                typeof(HiddenContentItemScope)
            },
            methods.Single(method => method.Name == "GetState")
                .GetParameters()
                .Select(parameter => parameter.ParameterType));
    }

    [Fact]
    public void OnlyReviewedAccessBoundaries_CanMintOwnerProjections()
    {
        var construction = new Regex(
            @"\bnew\s+(?:(?:global::)?[A-Za-z_]\w*\.)*HiddenContent(?:Actor|Item)Projection\s*\(",
            RegexOptions.Compiled);
        var allowed = new HashSet<string>(StringComparer.Ordinal)
        {
            "HiddenContentController.cs",
            "HiddenContentPlatformItemActionAdapter.cs"
        };
        var offenders = Directory
            .EnumerateFiles(ProductionRoot(), "*.cs", SearchOption.AllDirectories)
            .Where(file => !file.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                && !file.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            .Where(file => construction.IsMatch(PlatformHostSeamTests.CodeOnly(File.ReadAllText(file))))
            .Select(Path.GetFileName)
            .Where(name => name != null && !allowed.Contains(name))
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();

        Assert.Empty(offenders);
        Assert.Empty(typeof(HiddenContentActorProjection).GetConstructors());
        Assert.Empty(typeof(HiddenContentItemProjection).GetConstructors());
        Assert.Matches(construction, "new HiddenContentItemProjection(itemId, kind, null, null, null, null, null, null)");
    }

    [Fact]
    public void ResultEvidence_IsOpaqueDataFreeAndCannotBeMintedByPublicCallers()
    {
        Assert.Empty(typeof(HiddenContentItemState).GetConstructors());
        Assert.Empty(typeof(HiddenContentItemIdentityState).GetConstructors());
        Assert.Null(typeof(HiddenContentItemState).GetProperty("ExtensionData"));
        Assert.Null(typeof(HiddenContentItemIdentityState).GetProperty("ExtensionData"));
        Assert.Equal(
            typeof(HiddenContentItemState),
            typeof(HiddenContentItemActionResult)
                .GetProperty(nameof(HiddenContentItemActionResult.Entry))!
                .PropertyType);
    }

    [Fact]
    public void OwnerExtensionMerge_UsesOnePassBoundedAccumulator()
    {
        var source = PlatformHostSeamTests.CodeOnly(File.ReadAllText(OwnerSource()));

        Assert.Contains("TryAddMergedExtensionValue", source, StringComparison.Ordinal);
        Assert.DoesNotContain("PreserveExistingExtensionData", source, StringComparison.Ordinal);
    }

    [Fact]
    public void FullLegacyEvidence_IsInternalAndAbsentFromPlatformSources()
    {
        Assert.True(typeof(IHiddenContentLegacyItemActionOwner).IsNotPublic);
        Assert.True(typeof(HiddenContentLegacyItemActionResult).IsNotPublic);
        Assert.Empty(typeof(HiddenContentLegacyItemActionResult).GetConstructors());
        Assert.Empty(typeof(HiddenContentLegacyItemActionResult).GetProperties());

        var offenders = Directory
            .EnumerateFiles(
                Path.Combine(ProductionRoot(), "Platform"),
                "*.cs",
                SearchOption.AllDirectories)
            .Where(file => PlatformHostSeamTests.CodeOnly(File.ReadAllText(file))
                .Contains("HiddenContentLegacyItemAction", StringComparison.Ordinal))
            .Select(Path.GetFileName)
            .ToArray();

        Assert.Empty(offenders);
    }

    private static string OwnerSource([CallerFilePath] string sourceFile = "")
        => Path.GetFullPath(Path.Combine(
            Path.GetDirectoryName(sourceFile)!,
            "..",
            "..",
            "Jellyfin.Plugin.JellyfinCanopy",
            "Services",
            "HiddenContent",
            "HiddenContentItemActionOwner.cs"));

    private static string ProductionRoot([CallerFilePath] string sourceFile = "")
        => Path.GetFullPath(Path.Combine(
            Path.GetDirectoryName(sourceFile)!,
            "..",
            "..",
            "Jellyfin.Plugin.JellyfinCanopy"));
}
