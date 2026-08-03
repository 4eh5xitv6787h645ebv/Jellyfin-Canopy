using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class AuthenticatedUserClaimArchitectureTests
{
    private static readonly Regex AuthoritativeClaimLiteral = new(
        "\\\"Jellyfin-UserId\\\"",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly Regex LegacyClaimFallback = new(
        @"ClaimTypes\.(?:NameIdentifier|Sid)|""(?:sub|Sid)""",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly Regex PrincipalWideRoleLookup = new(
        @"\b(?:User|claimsPrincipal)\.IsInRole\(",
        RegexOptions.Compiled);

    [Fact]
    public void OnlyTheCanonicalOwnerNamesTheAuthoritativeUserClaim()
    {
        var owners = ProductionFiles()
            .Where(file => AuthoritativeClaimLiteral.IsMatch(
                PlatformHostSeamTests.CodeOnly(File.ReadAllText(file))))
            .Select(Path.GetFileName)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToList();

        Assert.Equal(new[] { "AuthenticatedUserClaimResolver.cs" }, owners);
        Assert.Matches(AuthoritativeClaimLiteral, "principal.FindFirst(\"Jellyfin-UserId\")");
    }

    [Fact]
    public void LegacyAuthorityFallbacksCannotReturnToProduction()
    {
        var offenders = ProductionFiles()
            .Where(file => LegacyClaimFallback.IsMatch(
                PlatformHostSeamTests.CodeOnly(File.ReadAllText(file))))
            .Select(Path.GetFileName)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToList();

        Assert.Empty(offenders);
        Assert.Matches(LegacyClaimFallback, "principal.FindFirst(ClaimTypes.NameIdentifier)");
        Assert.Matches(LegacyClaimFallback, "principal.FindFirst(ClaimTypes.Sid)");
        Assert.Matches(LegacyClaimFallback, "principal.FindFirst(\"sub\")");
        Assert.Matches(LegacyClaimFallback, "principal.FindFirst(\"Sid\")");
        Assert.Matches(LegacyClaimFallback, "principal.FindFirst(\"SID\")");
        Assert.Matches(LegacyClaimFallback, "principal.FindFirstValue(\"sub\")");
        Assert.Matches(LegacyClaimFallback, "principal.FindAll(\"Sid\")");
        Assert.Matches(LegacyClaimFallback, "principal.Claims.Where(c => c.Type == \"sub\")");
        Assert.Matches(LegacyClaimFallback, "ResolveClaim(principal, \"Sid\")");
    }

    [Fact]
    public void AdministratorRoleCannotBeSplicedFromAnotherIdentity()
    {
        var offenders = ProductionFiles()
            .Where(file => PrincipalWideRoleLookup.IsMatch(
                PlatformHostSeamTests.CodeOnly(File.ReadAllText(file))))
            .Select(Path.GetFileName)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToList();

        Assert.Empty(offenders);
        Assert.Matches(PrincipalWideRoleLookup, "claimsPrincipal.IsInRole(\"Administrator\")");
        Assert.Matches(PrincipalWideRoleLookup, "User.IsInRole(\"Administrator\")");
    }

    [Fact]
    public void SessionControlRoutesKeepUsingTheCanonicalBaseIdentity()
    {
        var activeStreams = Code("Controllers", "ActiveStreamsController.cs");
        var maintenance = Code("Controllers", "MaintenanceModeController.cs");
        var userHelper = Code("Helpers", "UserHelper.cs");

        Assert.Contains("UserHelper.GetCurrentUserId(User)", activeStreams, StringComparison.Ordinal);
        Assert.Contains("UserHelper.GetCurrentUserId(User)", maintenance, StringComparison.Ordinal);
        Assert.Contains("AuthenticatedUserClaimResolver.Resolve(claimsPrincipal)", userHelper, StringComparison.Ordinal);
    }

    [Fact]
    public void RequestIdentityLadderCannotBecomeAnAuthorityInput()
    {
        var references = ProductionFiles()
            .Where(file => PlatformHostSeamTests.CodeOnly(File.ReadAllText(file))
                .Contains("RequestIdentityService", StringComparison.Ordinal))
            .Select(file => Path.GetRelativePath(ProductionRoot(), file).Replace('\\', '/'))
            .OrderBy(path => path, StringComparer.Ordinal)
            .ToList();

        Assert.Equal(new[]
        {
            "EventHandlers/UserTopologyEvents.cs",
            "PluginServiceRegistrator.cs",
            "Services/Identity/RequestIdentityService.cs",
            "Services/SpoilerGuard/SpoilerUserResolver.cs",
        }, references);

        var resolverConsumers = ProductionFiles()
            .Where(file => PlatformHostSeamTests.CodeOnly(File.ReadAllText(file))
                .Contains("_identity.Resolve(", StringComparison.Ordinal))
            .Select(file => Path.GetRelativePath(ProductionRoot(), file).Replace('\\', '/'))
            .OrderBy(path => path, StringComparer.Ordinal)
            .ToList();

        Assert.Equal(new[] { "Services/SpoilerGuard/SpoilerUserResolver.cs" }, resolverConsumers);
    }

    [Fact]
    public void ExplicitTargetSelectionStaysOwnedByTheControllerAuthorityBoundary()
    {
        var consumers = ProductionFiles()
            .Where(file => PlatformHostSeamTests.CodeOnly(File.ReadAllText(file))
                .Contains("UserHelper.GetUserId(", StringComparison.Ordinal))
            .Select(file => Path.GetRelativePath(ProductionRoot(), file).Replace('\\', '/'))
            .OrderBy(path => path, StringComparer.Ordinal)
            .ToList();

        Assert.Equal(new[] { "Controllers/JellyfinCanopyControllerBase.cs" }, consumers);
    }

    private static string Code(params string[] segments)
        => PlatformHostSeamTests.CodeOnly(File.ReadAllText(Path.Combine(
            new[] { ProductionRoot() }.Concat(segments).ToArray())));

    private static IEnumerable<string> ProductionFiles()
        => Directory.EnumerateFiles(ProductionRoot(), "*.cs", SearchOption.AllDirectories)
            .Where(file => !file.Contains(
                $"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}",
                StringComparison.Ordinal)
                && !file.Contains(
                    $"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}",
                    StringComparison.Ordinal));

    private static string ProductionRoot([CallerFilePath] string sourceFile = "")
        => Path.GetFullPath(Path.Combine(
            Path.GetDirectoryName(sourceFile)!,
            "..",
            "..",
            "Jellyfin.Plugin.JellyfinCanopy"));
}
