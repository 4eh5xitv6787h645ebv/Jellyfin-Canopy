using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Claims;
using System.Text;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Microsoft.AspNetCore.Http;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

/// <summary>Guards the closed actor domain and its kernel-only construction paths.</summary>
public sealed class PlatformActorAuthorityArchitectureTests
{
    private static readonly Regex ExplicitActorConstruction = new(
        @"\bnew\s+(?:(?:global::)?[A-Za-z_]\w*\.)*(?:PlatformActor|PlatformInstalledProviderActor|PlatformCompanionServiceActor)\s*\(",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex TargetTypedActorConstruction = new(
        @"\b(?:PlatformActor|PlatformInstalledProviderActor|PlatformCompanionServiceActor)\s+[A-Za-z_]\w*\s*=\s*new\s*\(",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex ActorTypeAlias = new(
        @"^\s*using\s+[A-Za-z_]\w*\s*=\s*(?:(?:global::)?[A-Za-z_]\w*\.)*(?:PlatformActor|PlatformInstalledProviderActor|PlatformCompanionServiceActor)\s*;",
        RegexOptions.Compiled | RegexOptions.CultureInvariant | RegexOptions.Multiline);

    private static readonly Regex IdentifierUnicodeEscape = new(
        @"\\(?:u(?<short>[0-9a-fA-F]{4})|U(?<long>[0-9a-fA-F]{8}))",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    [Fact]
    public void ActorRepresentationsAreSealedDistinctAndImmutable()
    {
        var actorTypes = new[]
        {
            typeof(PlatformActor),
            typeof(PlatformInstalledProviderActor),
            typeof(PlatformCompanionServiceActor),
        };

        Assert.All(actorTypes, type =>
        {
            Assert.True(type.IsSealed);
            Assert.Empty(type.GetConstructors(BindingFlags.Public | BindingFlags.Instance));
            Assert.All(
                type.GetProperties(BindingFlags.Public | BindingFlags.Instance),
                property => Assert.False(property.CanWrite));
            Assert.DoesNotContain(
                type.GetMethods(BindingFlags.Public | BindingFlags.Static),
                method => method.Name is "op_Implicit" or "op_Explicit");
        });

        Assert.All(actorTypes, type => Assert.Equal(typeof(object), type.BaseType));
        Assert.Empty(actorTypes.SelectMany(type => type.GetInterfaces()));
        Assert.Null(typeof(PlatformInstalledProviderActor).GetProperty("UserId"));
        Assert.Null(typeof(PlatformInstalledProviderActor).GetProperty("IsElevated"));
        Assert.Null(typeof(PlatformCompanionServiceActor).GetProperty("UserId"));
        Assert.Null(typeof(PlatformCompanionServiceActor).GetProperty("IsElevated"));
    }

    [Fact]
    public void AuthorityProjectionCarriesOnlyKindAndCurrentElevation()
    {
        var properties = typeof(PlatformActorAuthority)
            .GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .OrderBy(property => property.Name, StringComparer.Ordinal)
            .ToArray();

        Assert.Equal(new[] { "IsElevated", "Kind" }, properties.Select(property => property.Name));
        Assert.Equal(typeof(bool), properties.Single(property => property.Name == "IsElevated").PropertyType);
        Assert.Equal(typeof(PlatformActorKind), properties.Single(property => property.Name == "Kind").PropertyType);
        Assert.All(properties, property => Assert.False(property.CanWrite));
        Assert.Empty(typeof(PlatformActorAuthority).GetConstructors(BindingFlags.Public | BindingFlags.Instance));

        var forbidden = new Regex(
            "id|token|secret|credential|claim|principal|http|request|route|query|body|payload|manifest|grant|capability|correlation|client|device|ip",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        Assert.All(properties, property => Assert.DoesNotMatch(forbidden, property.Name));
    }

    [Fact]
    public void ConstructionProofsAreOpaqueAndHaveOnlyPrivateConstructors()
    {
        foreach (var type in new[]
        {
            typeof(PlatformUserBoundaryResult),
            typeof(PlatformInstalledPluginId),
            typeof(PlatformManifestFingerprint),
            typeof(PlatformProviderGeneration),
            typeof(PlatformApprovedProviderIdentity),
            typeof(PlatformServiceRegistrationId),
            typeof(PlatformCredentialGeneration),
            typeof(PlatformCurrentServiceIdentity),
        })
        {
            Assert.Empty(type.GetConstructors(BindingFlags.Public | BindingFlags.Instance));
            var constructors = type.GetConstructors(BindingFlags.NonPublic | BindingFlags.Instance);
            Assert.Single(constructors);
            Assert.True(constructors[0].IsPrivate);
        }
    }

    [Fact]
    public void ActorFactoryAcceptsOnlyTypedProofs()
    {
        var methods = typeof(PlatformActorFactory)
            .GetMethods(BindingFlags.Static | BindingFlags.NonPublic)
            .Where(method => !method.IsSpecialName)
            .OrderBy(method => method.Name, StringComparer.Ordinal)
            .ToArray();

        Assert.Equal(
            new[] { "CreateAuthenticatedUserActor", "CreateProvider", "CreateService" },
            methods.Select(method => method.Name));
        Assert.Equal(
            new[] { typeof(PlatformApprovedProviderIdentity) },
            Method("CreateProvider").GetParameters().Select(parameter => parameter.ParameterType));
        Assert.Equal(
            new[] { typeof(PlatformCurrentServiceIdentity) },
            Method("CreateService").GetParameters().Select(parameter => parameter.ParameterType));
        Assert.Equal(
            new[] { typeof(PlatformUserBoundaryResult) },
            Method("CreateAuthenticatedUserActor").GetParameters().Select(parameter => parameter.ParameterType));
        var forbidden = new[]
        {
            typeof(Guid),
            typeof(string),
            typeof(byte[]),
            typeof(Claim),
            typeof(ClaimsIdentity),
            typeof(ClaimsPrincipal),
            typeof(HttpContext),
            typeof(HttpRequest),
            typeof(HttpResponse),
        };
        Assert.DoesNotContain(
            methods.SelectMany(method => method.GetParameters()).Select(parameter => parameter.ParameterType),
            parameterType => forbidden.Contains(parameterType));

        MethodInfo Method(string name) => methods.Single(method => method.Name == name);
    }

    [Fact]
    public void OnlyTheActorDomainConstructsActorsAndOnlyTheBoundaryCompletesUserProof()
    {
        var actorConstructionOwners = ProductionFiles()
            .Where(file => HasActorConstruction(PlatformHostSeamTests.CodeOnly(File.ReadAllText(file))))
            .Select(Path.GetFileName)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();
        Assert.Equal(new[] { "PlatformActorDomain.cs" }, actorConstructionOwners);

        Assert.Equal(
            new[] { "PlatformActorBoundaryFilter.cs", "PlatformActorDomain.cs" },
            SensitiveMemberOwners("EstablishAuthenticatedUserBoundary"));
        Assert.Equal(
            new[] { "PlatformActorBoundaryFilter.cs", "PlatformActorDomain.cs" },
            SensitiveMemberOwners("EstablishReauthorizedUserBoundary"));
        Assert.Equal(
            new[] { "PlatformActorBoundaryFilter.cs", "PlatformActorDomain.cs" },
            SensitiveMemberOwners("CreateAuthenticatedUserActor"));

        Assert.True(HasSensitiveMemberUse(
            "using Proof = PlatformUserBoundaryResult; var proof = Proof.EstablishAuthenticatedUserBoundary (user, id, null, null);",
            "EstablishAuthenticatedUserBoundary"));
        Assert.True(HasSensitiveMemberUse(
            "using Factory = PlatformActorFactory; var actor = Factory\n .\n CreateAuthenticatedUserActor (proof);",
            "CreateAuthenticatedUserActor"));
        Assert.True(HasSensitiveMemberUse(
            "using static PlatformActorFactory; var actor = CreateAuthenticatedUserActor(proof);",
            "CreateAuthenticatedUserActor"));
        Assert.True(HasSensitiveMemberUse(
            "Func<PlatformUserBoundaryResult, PlatformActor> create = PlatformActorFactory.CreateAuthenticatedUserActor;",
            "CreateAuthenticatedUserActor"));
        Assert.True(HasSensitiveMemberUse(
            """var proof = PlatformUserBoundaryResult.EstablishAuthenticatedUser\u0042oundary(user, id, null, null);""",
            "EstablishAuthenticatedUserBoundary"));
        Assert.True(HasSensitiveMemberUse(
            """var actor = PlatformActorFactory.CreateAuthenticatedUser\u0041ctor(proof);""",
            "CreateAuthenticatedUserActor"));
        Assert.True(HasSensitiveMemberUse(
            """var proof = PlatformUserBoundaryResult.EstablishAuthenticatedUser\u200cBoundary(user, id, null, null);""",
            "EstablishAuthenticatedUserBoundary"));
        Assert.True(HasSensitiveMemberUse(
            "PlatformActorFactory.CreateAuthenticatedUser"
                + '\u200C'
                + "Actor(proof);",
            "CreateAuthenticatedUserActor"));

        Assert.True(HasActorConstruction("var actor = new global::Jellyfin.Plugin.JellyfinCanopy.Platform.PlatformActor(proof);"));
        Assert.True(HasActorConstruction("PlatformActor actor = new(proof);"));
        Assert.True(HasActorConstruction(
            "using ActorAlias = Jellyfin.Plugin.JellyfinCanopy.Platform.PlatformActor;\nActorAlias actor = new(proof);"));
    }

    [Fact]
    public void OnlyActorRepresentationsCanProjectAuthority()
    {
        Assert.Equal(
            new[] { "PlatformActor.cs", "PlatformActorDomain.cs" },
            SensitiveMemberOwners("ProjectAuthenticatedUserAuthority"));
        Assert.Equal(
            new[] { "PlatformActorDomain.cs" },
            SensitiveMemberOwners("ProjectInstalledProviderAuthority"));
        Assert.Equal(
            new[] { "PlatformActorDomain.cs" },
            SensitiveMemberOwners("ProjectCompanionServiceAuthority"));

        Assert.True(HasSensitiveMemberUse(
            "using Authority = PlatformActorAuthority; Func<bool, PlatformActorAuthority> project = Authority.ProjectAuthenticatedUserAuthority;",
            "ProjectAuthenticatedUserAuthority"));
    }

    [Fact]
    public void OnlyCurrentKernelOwnersCanRequestBoundaryReauthorization()
    {
        Assert.Equal(
            new[]
            {
                "PlatformActionInvocationCoordinator.cs",
                "PlatformActorBoundaryFilter.cs",
                "PlatformNativeCatalogService.cs",
                "PlatformProviderRegistryDomain.cs",
            },
            SensitiveMemberOwners("ReauthorizeUserActor"));

        var parameters = typeof(PlatformActorBoundaryFilter)
            .GetMethod("ReauthorizeUserActor", BindingFlags.Static | BindingFlags.NonPublic)!
            .GetParameters()
            .Select(parameter => parameter.ParameterType)
            .ToArray();
        Assert.Equal(new[] { typeof(PlatformActor), typeof(IPlatformHost) }, parameters);
        Assert.DoesNotContain(typeof(HostUser), parameters);

        Assert.True(HasSensitiveMemberUse(
            "using Boundary = PlatformActorBoundaryFilter; var actor = Boundary . ReauthorizeUserActor (current, host);",
            "ReauthorizeUserActor"));
    }

    [Fact]
    public void ProviderProofHasOnlyTheRegistryIssuerAndServiceProofStillHasNoIssuer()
    {
        var source = string.Join(
            "\n",
            ProductionFiles().Select(file => PlatformHostSeamTests.CodeOnly(File.ReadAllText(file))));

        Assert.DoesNotContain("new PlatformApprovedProviderIdentity", source, StringComparison.Ordinal);
        Assert.DoesNotContain("new PlatformCurrentServiceIdentity", source, StringComparison.Ordinal);
        Assert.Equal(
            new[] { "PlatformActorDomain.cs", "PlatformProviderRegistry.cs" },
            SensitiveMemberOwners("EstablishCurrentRegistryApproval"));
        Assert.DoesNotContain("PlatformActorFactory.CreateProvider(", source.Replace(
            "internal static PlatformInstalledProviderActor CreateProvider(",
            string.Empty,
            StringComparison.Ordinal), StringComparison.Ordinal);
        Assert.DoesNotContain("PlatformActorFactory.CreateService(", source.Replace(
            "internal static PlatformCompanionServiceActor CreateService(",
            string.Empty,
            StringComparison.Ordinal), StringComparison.Ordinal);
        Assert.DoesNotContain("AddSingleton<PlatformActorFactory", source, StringComparison.Ordinal);
        Assert.DoesNotContain("AddScoped<PlatformActorFactory", source, StringComparison.Ordinal);
        Assert.DoesNotContain("AddTransient<PlatformActorFactory", source, StringComparison.Ordinal);
    }

    private static bool HasActorConstruction(string code) =>
        ExplicitActorConstruction.IsMatch(code)
        || TargetTypedActorConstruction.IsMatch(code)
        || ActorTypeAlias.IsMatch(code);

    private static string[] SensitiveMemberOwners(string memberName) => ProductionFiles()
        .Where(file => HasSensitiveMemberUse(
            PlatformHostSeamTests.CodeOnly(File.ReadAllText(file)),
            memberName))
        .Select(file => Path.GetFileName(file)!)
        .OrderBy(name => name, StringComparer.Ordinal)
        .ToArray();

    private static bool HasSensitiveMemberUse(string code, string memberName) =>
        Regex.IsMatch(
            NormalizeIdentifierUnicodeEscapes(code),
            $@"\b{Regex.Escape(memberName)}\b",
            RegexOptions.CultureInvariant);

    private static string NormalizeIdentifierUnicodeEscapes(string code)
    {
        var decoded = IdentifierUnicodeEscape.Replace(code, match =>
        {
            var shortHex = match.Groups["short"];
            if (shortHex.Success)
            {
                return ((char)Convert.ToInt32(shortHex.Value, 16)).ToString();
            }

            var scalar = Convert.ToInt32(match.Groups["long"].Value, 16);
            return scalar is >= 0 and <= 0x10FFFF
                && scalar is not (>= 0xD800 and <= 0xDFFF)
                    ? char.ConvertFromUtf32(scalar)
                    : match.Value;
        });

        var normalized = new StringBuilder(decoded.Length);
        foreach (var rune in decoded.EnumerateRunes())
        {
            if (Rune.GetUnicodeCategory(rune) != UnicodeCategory.Format)
            {
                normalized.Append(rune.ToString());
            }
        }

        return normalized.ToString();
    }

    private static IEnumerable<string> ProductionFiles() =>
        Directory.EnumerateFiles(ProductionRoot(), "*.cs", SearchOption.AllDirectories)
            .Where(file => !file.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                && !file.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal));

    private static string ProductionRoot([CallerFilePath] string sourceFile = "") =>
        Path.GetFullPath(Path.Combine(
            Path.GetDirectoryName(sourceFile)!,
            "..",
            "..",
            "Jellyfin.Plugin.JellyfinCanopy"));
}
