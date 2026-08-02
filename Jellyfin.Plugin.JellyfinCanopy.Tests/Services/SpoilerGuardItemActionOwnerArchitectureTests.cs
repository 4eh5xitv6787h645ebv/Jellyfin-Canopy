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
        var configure = typeof(ISpoilerGuardItemActionOwner).GetMethod(
            nameof(ISpoilerGuardItemActionOwner.Configure));
        var getState = typeof(ISpoilerGuardItemActionOwner).GetMethod(
            nameof(ISpoilerGuardItemActionOwner.GetState));

        Assert.NotNull(configure);
        Assert.Equal(
            new[]
            {
                typeof(SpoilerGuardActorProjection),
                typeof(SpoilerGuardItemProjection),
                typeof(SpoilerGuardItemConfiguration),
            },
            configure!.GetParameters().Select(parameter => parameter.ParameterType));
        Assert.Equal(typeof(SpoilerGuardItemActionResult), configure.ReturnType);
        Assert.NotNull(getState);
        Assert.Equal(
            new[] { typeof(SpoilerGuardActorProjection), typeof(SpoilerGuardItemProjection) },
            getState!.GetParameters().Select(parameter => parameter.ParameterType));
        Assert.Equal(typeof(SpoilerGuardItemState), getState.ReturnType);

        foreach (var type in new[]
        {
            typeof(SpoilerGuardActorProjection),
            typeof(SpoilerGuardItemProjection),
            typeof(SpoilerGuardItemConfiguration),
            typeof(SpoilerGuardItemActionResult),
            typeof(SpoilerGuardItemState),
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
        Assert.Contains("ReadUserConfiguration<UserSpoilerBlur>", code, StringComparison.Ordinal);
        Assert.Contains("configuration.ExpectedOverridesRevision", code, StringComparison.Ordinal);
        Assert.Contains("SpoilerUserResolver.InvalidateUser", code, StringComparison.Ordinal);

        Assert.Matches(ForbiddenOwnerDependency, "using Microsoft.AspNetCore.Mvc;");
        Assert.Matches(ForbiddenOwnerDependency, "private BaseItem _item;");
    }

    [Fact]
    public void PlatformAdapterAcceptsOnlyAuthoritativeProjectionsAndHasNoStoreDependency()
    {
        var code = PlatformHostSeamTests.CodeOnly(File.ReadAllText(AdapterSource()));
        var methods = typeof(global::Jellyfin.Plugin.JellyfinCanopy.Platform.SpoilerGuardPlatformItemActionAdapter)
            .GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly);

        Assert.Equal(2, methods.Length);
        Assert.All(methods, method =>
        {
            var parameters = method.GetParameters().Select(parameter => parameter.ParameterType).ToArray();
            Assert.Equal(
                typeof(global::Jellyfin.Plugin.JellyfinCanopy.Platform.PlatformActor),
                parameters[0]);
            Assert.Equal(
                typeof(global::Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting.HostAccessibleItem),
                parameters[1]);
            Assert.DoesNotContain(typeof(Guid), parameters);
            Assert.DoesNotContain(typeof(string), parameters);
        });
        Assert.DoesNotContain("UserConfigurationManager", code, StringComparison.Ordinal);
        Assert.DoesNotContain("ReadUserConfiguration", code, StringComparison.Ordinal);
        Assert.DoesNotContain("RmwUserConfiguration", code, StringComparison.Ordinal);
        Assert.Contains("ExpectedOverridesRevision", code, StringComparison.Ordinal);
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

    private static string AdapterSource([CallerFilePath] string sourceFile = "")
        => Path.GetFullPath(Path.Combine(
            Path.GetDirectoryName(sourceFile)!,
            "..", "..", "Jellyfin.Plugin.JellyfinCanopy", "Platform",
            "SpoilerGuardPlatformItemActionAdapter.cs"));
}
