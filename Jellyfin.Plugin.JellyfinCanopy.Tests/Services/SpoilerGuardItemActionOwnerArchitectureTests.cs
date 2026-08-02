using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class SpoilerGuardItemActionOwnerArchitectureTests
{
    private static readonly Regex ForbiddenOwnerDependency = new(
        @"\b(?:Microsoft\.AspNetCore|MediaBrowser|ControllerBase|IActionResult|HttpContext|HttpRequest|ClaimsPrincipal|BaseItem)\b",
        RegexOptions.Compiled);

    [Fact]
    public void OwnerContractIsHttpFreeAndAcceptsOnlySafeProjections()
    {
        var method = typeof(ISpoilerGuardItemActionOwner).GetMethod(
            nameof(ISpoilerGuardItemActionOwner.Configure));

        Assert.NotNull(method);
        Assert.Equal(
            new[]
            {
                typeof(SpoilerGuardActorProjection),
                typeof(SpoilerGuardItemProjection),
                typeof(SpoilerGuardItemConfiguration),
            },
            method!.GetParameters().Select(parameter => parameter.ParameterType));
        Assert.Equal(typeof(SpoilerGuardItemActionResult), method.ReturnType);

        foreach (var type in new[]
        {
            typeof(SpoilerGuardActorProjection),
            typeof(SpoilerGuardItemProjection),
            typeof(SpoilerGuardItemConfiguration),
            typeof(SpoilerGuardItemActionResult),
        })
        {
            Assert.True(type.IsSealed);
            Assert.Empty(type.GetConstructors(BindingFlags.Instance | BindingFlags.Public));
        }
    }

    [Fact]
    public void OwnerSourceHasNoHttpControllerOrJellyfinEntityDependency()
    {
        var code = PlatformHostSeamTests.CodeOnly(File.ReadAllText(OwnerSource()));

        Assert.DoesNotMatch(ForbiddenOwnerDependency, code);
        Assert.Contains("RmwUserConfiguration<UserSpoilerBlur>", code, StringComparison.Ordinal);
        Assert.Contains("SpoilerUserResolver.InvalidateUser", code, StringComparison.Ordinal);

        Assert.Matches(ForbiddenOwnerDependency, "using Microsoft.AspNetCore.Mvc;");
        Assert.Matches(ForbiddenOwnerDependency, "private BaseItem _item;");
    }

    [Fact]
    public void LegacyInstalledItemActionsDelegatePersistenceToTheOwner()
    {
        var source = PlatformHostSeamTests.CodeOnly(File.ReadAllText(ControllerSource()));
        var installedActions = source.Substring(
            source.IndexOf("EnableSpoilerBlurForSeries", StringComparison.Ordinal),
            source.IndexOf("GetMovieSpoilerScope", StringComparison.Ordinal)
                - source.IndexOf("EnableSpoilerBlurForSeries", StringComparison.Ordinal));

        Assert.Equal(4, Regex.Matches(installedActions, @"_itemActionOwner\s*\.\s*Configure\s*\(").Count);
        Assert.DoesNotContain("RmwUserConfiguration<UserSpoilerBlur>", installedActions, StringComparison.Ordinal);
        Assert.DoesNotContain("SpoilerUserResolver.InvalidateUser", installedActions, StringComparison.Ordinal);
    }

    private static string OwnerSource([CallerFilePath] string sourceFile = "")
        => Path.GetFullPath(Path.Combine(
            Path.GetDirectoryName(sourceFile)!,
            "..", "..", "Jellyfin.Plugin.JellyfinCanopy", "Services", "SpoilerGuard",
            "SpoilerGuardItemActionOwner.cs"));

    private static string ControllerSource([CallerFilePath] string sourceFile = "")
        => Path.GetFullPath(Path.Combine(
            Path.GetDirectoryName(sourceFile)!,
            "..", "..", "Jellyfin.Plugin.JellyfinCanopy", "Controllers",
            "SpoilerGuardController.cs"));
}
