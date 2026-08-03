using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

/// <summary>Guards the closed capability vocabulary and its pure grant-ceiling owner.</summary>
public sealed class PlatformCapabilityArchitectureTests
{
    private const string CapabilityDomainFileName = "PlatformCapabilityDomain.cs";

    private static readonly string[] ClosedConstructionTypeNames =
    {
        nameof(PlatformCapabilityDecision),
        nameof(PlatformCapabilityDefinition),
        nameof(PlatformCapabilityId),
        nameof(PlatformGrantedCapabilitySet),
        nameof(PlatformGrantPreview),
        nameof(PlatformRequestedCapabilitySet),
    };

    private static readonly (string TypeName, string MemberName)[] SensitiveMembers =
    {
        (nameof(PlatformCapabilityId), nameof(PlatformCapabilityId.EstablishCodeOwnedId)),
        (nameof(PlatformCapabilityDefinition), nameof(PlatformCapabilityDefinition.EstablishCodeOwnedDefinition)),
        (nameof(PlatformCapabilityVocabulary), nameof(PlatformCapabilityVocabulary.Find)),
        (nameof(PlatformRequestedCapabilitySet), nameof(PlatformRequestedCapabilitySet.TryCreate)),
        (nameof(PlatformGrantedCapabilitySet), nameof(PlatformGrantedCapabilitySet.TryCreate)),
        (nameof(PlatformGrantedCapabilitySet), nameof(PlatformGrantedCapabilitySet.Missing)),
        ("PlatformCapabilitySetResolver", "TryResolve"),
        (nameof(PlatformCapabilityDecision), nameof(PlatformCapabilityDecision.EstablishDecision)),
        (nameof(PlatformGrantPreview), nameof(PlatformGrantPreview.EstablishPreview)),
        (nameof(PlatformGrantCeilingEvaluator), nameof(PlatformGrantCeilingEvaluator.Evaluate)),
    };

    private static readonly Regex IdentifierUnicodeEscape = new(
        @"\\(?:u(?<short>[0-9a-fA-F]{4})|U(?<long>[0-9a-fA-F]{8}))",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    [Fact]
    public void CapabilityIdentifiersAndDefinitionsHaveOnlyPrivateConstructors()
    {
        foreach (var type in new[]
        {
            typeof(PlatformCapabilityDecision),
            typeof(PlatformCapabilityId),
            typeof(PlatformCapabilityDefinition),
            typeof(PlatformRequestedCapabilitySet),
            typeof(PlatformGrantedCapabilitySet),
            typeof(PlatformGrantPreview),
        })
        {
            var constructors = type.GetConstructors(
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);

            Assert.Single(constructors);
            Assert.True(constructors[0].IsPrivate);
        }
    }

    [Fact]
    public void CrossFileGlobalAliasesCannotHideSensitiveCapabilityOwners()
    {
        var owners = ProductionFiles()
            .Where(file => HasSensitiveGlobalAliasDeclaration(Code(file)))
            .Select(Path.GetFileName)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();

        Assert.Empty(owners);

        const string aliasSource =
            "global using Grants = Jellyfin.Plugin.JellyfinCanopy.Platform.PlatformGrantedCapabilitySet;";
        const string useSource =
            "internal class OtherOwner { void Use() => Grants.TryCreate(values, out var grants); }";
        Assert.True(HasCrossFileSensitiveMemberUse(
            aliasSource,
            useSource,
            nameof(PlatformGrantedCapabilitySet),
            nameof(PlatformGrantedCapabilitySet.TryCreate)));

        const string staticAliasSource =
            "global using static Jellyfin.Plugin.JellyfinCanopy.Platform.PlatformGrantCeilingEvaluator;";
        const string staticUseSource =
            "internal class OtherOwner { void Use() => Evaluate(requested, granted, authority); }";
        Assert.True(HasCrossFileSensitiveMemberUse(
            staticAliasSource,
            staticUseSource,
            nameof(PlatformGrantCeilingEvaluator),
            nameof(PlatformGrantCeilingEvaluator.Evaluate)));

        const string verbatimAliasSource =
            "global using @Grants = Jellyfin.Plugin.JellyfinCanopy.Platform.PlatformGrantedCapabilitySet;";
        const string verbatimUseSource =
            "internal class OtherOwner { void Use() => @Grants.TryCreate(values, out var grants); }";
        Assert.True(HasCrossFileSensitiveMemberUse(
            verbatimAliasSource,
            verbatimUseSource,
            nameof(PlatformGrantedCapabilitySet),
            nameof(PlatformGrantedCapabilitySet.TryCreate)));

        const string unicodeAliasSource =
            "global using 授權 = Jellyfin.Plugin.JellyfinCanopy.Platform.PlatformGrantPreview;";
        const string unicodeUseSource =
            "internal class OtherOwner { void Use() => 授權.EstablishPreview(status, decisions); }";
        Assert.True(HasCrossFileSensitiveMemberUse(
            unicodeAliasSource,
            unicodeUseSource,
            nameof(PlatformGrantPreview),
            nameof(PlatformGrantPreview.EstablishPreview)));

        Assert.True(HasSensitiveGlobalAliasDeclaration(
            "global using @Grants =\n"
            + "    Jellyfin.Plugin.JellyfinCanopy.Platform.PlatformGrantedCapabilitySet;"));
        Assert.True(HasSensitiveGlobalAliasDeclaration(
            "global using 授權 =\n"
            + "    Jellyfin.Plugin.JellyfinCanopy.Platform.PlatformGrantPreview;"));
        Assert.False(HasSensitiveGlobalAliasDeclaration(
            "global using Platform = Jellyfin.Plugin.JellyfinCanopy.Platform;"));
        Assert.False(HasSensitiveGlobalAliasDeclaration(
            "global using Similar = Example.PlatformGrantPreviewLike;"));
    }

    [Fact]
    public void OnlyTheCapabilityDomainConstructsClosedCapabilityTypes()
    {
        var owners = ProductionFiles()
            .Where(file => HasClosedTypeConstruction(Code(file)))
            .Select(Path.GetFileName)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();

        Assert.Equal(new[] { CapabilityDomainFileName }, owners);

        Assert.True(HasClosedTypeConstruction(
            "var id = new global::Jellyfin.Plugin.JellyfinCanopy.Platform.PlatformCapabilityId(value);"));
        Assert.True(HasClosedTypeConstruction(
            "PlatformCapabilityDefinition definition = new(id, domain, actorKind, false);"));
        Assert.True(HasClosedTypeConstruction(
            "using Definition = Jellyfin.Plugin.JellyfinCanopy.Platform.PlatformCapabilityDefinition;\n"
            + "Definition definition = new(id, domain, actorKind, false);"));
        Assert.True(HasClosedTypeConstruction(
            "using Id = global::Jellyfin.Plugin.JellyfinCanopy.Platform.PlatformCapabilityId;\n"
            + "var id = new Id(value);"));
        Assert.True(HasClosedTypeConstruction(
            "using @Id = global::Jellyfin.Plugin.JellyfinCanopy.Platform.PlatformCapabilityId;\n"
            + "var id = new @Id(value);"));
        Assert.True(HasClosedTypeConstruction(
            "using 識別碼 = global::Jellyfin.Plugin.JellyfinCanopy.Platform.PlatformCapabilityId;\n"
            + "var id = new 識別碼(value);"));
        Assert.True(HasClosedTypeConstruction(
            "var id = new PlatformCapability\\u0049d(value);"));
        Assert.True(HasClosedTypeConstruction(
            "var id = new PlatformCapability\u200cId(value);"));
    }

    [Fact]
    public void RawResolutionSetFactoriesMissingSentinelAndEvaluatorHaveOneOwner()
    {
        foreach (var (typeName, memberName) in SensitiveMembers)
        {
            var expectedOwners = typeName == nameof(PlatformRequestedCapabilitySet)
                && memberName == nameof(PlatformRequestedCapabilitySet.TryCreate)
                    ? new[] { CapabilityDomainFileName, "PlatformExtensionManifestDomain.cs" }
                    : new[] { CapabilityDomainFileName };
            Assert.Equal(
                expectedOwners,
                SensitiveMemberOwners(typeName, memberName));
        }

        Assert.True(HasSensitiveMemberUse(
            "var result = global::Jellyfin.Plugin.JellyfinCanopy.Platform.PlatformCapabilityVocabulary . Find (value);",
            nameof(PlatformCapabilityVocabulary),
            nameof(PlatformCapabilityVocabulary.Find)));
        Assert.True(HasSensitiveMemberUse(
            "using Vocabulary = Jellyfin.Plugin.JellyfinCanopy.Platform.PlatformCapabilityVocabulary;\n"
            + "var result = Vocabulary.Find(value);",
            nameof(PlatformCapabilityVocabulary),
            nameof(PlatformCapabilityVocabulary.Find)));
        Assert.True(HasSensitiveMemberUse(
            "using static Jellyfin.Plugin.JellyfinCanopy.Platform.PlatformCapabilityVocabulary;\n"
            + "var result = Find(value);",
            nameof(PlatformCapabilityVocabulary),
            nameof(PlatformCapabilityVocabulary.Find)));
        Assert.True(HasSensitiveMemberUse(
            "Func<string, PlatformCapabilityDefinition?> resolve = PlatformCapabilityVocabulary.Find;",
            nameof(PlatformCapabilityVocabulary),
            nameof(PlatformCapabilityVocabulary.Find)));
        Assert.True(HasSensitiveMemberUse(
            "var result = PlatformRequestedCapabilitySet.TryCreate (values, out var requested);",
            nameof(PlatformRequestedCapabilitySet),
            nameof(PlatformRequestedCapabilitySet.TryCreate)));
        Assert.True(HasSensitiveMemberUse(
            "using Grants = PlatformGrantedCapabilitySet; var missing = Grants . Missing;",
            nameof(PlatformGrantedCapabilitySet),
            nameof(PlatformGrantedCapabilitySet.Missing)));
        Assert.True(HasSensitiveMemberUse(
            "using @Grants = PlatformGrantedCapabilitySet; var missing = @Grants.Missing;",
            nameof(PlatformGrantedCapabilitySet),
            nameof(PlatformGrantedCapabilitySet.Missing)));
        Assert.True(HasSensitiveMemberUse(
            "using 授權 = PlatformGrantPreview; var preview = 授權.EstablishPreview(status, decisions);",
            nameof(PlatformGrantPreview),
            nameof(PlatformGrantPreview.EstablishPreview)));
        Assert.True(HasSensitiveMemberUse(
            "var preview = PlatformGrantCeilingEvaluator.Eval\\u0075ate(requested, granted, authority);",
            nameof(PlatformGrantCeilingEvaluator),
            nameof(PlatformGrantCeilingEvaluator.Evaluate)));
        Assert.True(HasSensitiveMemberUse(
            "var preview = PlatformGrantCeilingEvaluator.Eval\u200cuate(requested, granted, authority);",
            nameof(PlatformGrantCeilingEvaluator),
            nameof(PlatformGrantCeilingEvaluator.Evaluate)));
    }

    [Fact]
    public void CapabilityDomainHasNoHostManifestRequestSecretOrRegistrationDependencies()
    {
        var code = Code(SourceFile(CapabilityDomainFileName));
        var forbidden = new[]
        {
            "Microsoft.AspNetCore",
            "Microsoft.Extensions.Configuration",
            "Microsoft.Extensions.DependencyInjection",
            "Microsoft.Extensions.Options",
            "Configuration",
            "HttpContext",
            "HttpRequest",
            "Controller",
            "Route(",
            "Manifest",
            "IConfiguration",
            "IOptions",
            "IServiceCollection",
            "IServiceProvider",
            "ClaimsPrincipal",
            "Token",
            "SecurityToken",
            "BearerToken",
            "Credential",
            "Secret",
            "Register(",
            "TryRegister(",
            "AddSingleton",
            "AddScoped",
            "AddTransient",
            "Activator.CreateInstance",
            "Assembly.Load",
            "AppDomain",
            "Type.GetType",
        };

        Assert.All(forbidden, value => Assert.DoesNotContain(value, code, StringComparison.OrdinalIgnoreCase));

        var vocabularyMethods = typeof(PlatformCapabilityVocabulary)
            .GetMethods(BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly)
            .Where(method => !method.IsSpecialName)
            .Select(method => method.Name)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();
        Assert.Equal(new[] { nameof(PlatformCapabilityVocabulary.Find) }, vocabularyMethods);
        Assert.DoesNotContain(
            typeof(PlatformCapabilityVocabulary).GetProperties(BindingFlags.Public | BindingFlags.Static),
            property => property.CanWrite);

        var vocabularyFields = typeof(PlatformCapabilityVocabulary)
            .GetFields(BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.DeclaredOnly);
        Assert.Single(vocabularyFields);
        Assert.True(vocabularyFields[0].IsInitOnly);
        Assert.Equal(typeof(ImmutableArray<PlatformCapabilityDefinition>), vocabularyFields[0].FieldType);
    }

    [Fact]
    public void ExistingFirstPartyActionPathDoesNotReferenceCapabilityGrants()
    {
        var existingActionPathFiles = new[]
        {
            "HiddenContentPlatformItemActionAdapter.cs",
            "PlatformActionAdmissionLimiter.cs",
            "PlatformActionCapabilityService.cs",
            "PlatformActionInvocationCoordinator.cs",
            "PlatformActionInvokeContract.cs",
            "PlatformAuditStore.cs",
            "PlatformFirstPartyActionDispatcher.cs",
            "PlatformNativeActionPorts.cs",
            "PlatformNativeCatalogService.cs",
            "PlatformNativeController.cs",
            "PlatformOperationVocabulary.cs",
            "PlatformPreparedActionContextOwner.cs",
            "PlatformPrepareHandleOwner.cs",
            "SpoilerGuardPlatformItemActionAdapter.cs",
        };
        var forbidden = new[]
        {
            "PlatformCapabilityVocabulary",
            "PlatformCapabilityDefinition",
            "PlatformCapabilityId",
            "PlatformRequestedCapabilitySet",
            "PlatformGrantedCapabilitySet",
            "PlatformGrantCeilingEvaluator",
            "PlatformGrantPreview",
            "grant",
        };

        foreach (var fileName in existingActionPathFiles)
        {
            var code = Code(SourceFile(fileName));
            Assert.All(
                forbidden,
                value => Assert.DoesNotContain(value, code, StringComparison.OrdinalIgnoreCase));
        }

        Assert.Equal(3, PlatformOperationVocabulary.All.Length);
        Assert.Equal(
            new[]
            {
                "jellyfin.canopy.spoiler-guard.configure-item",
                "jellyfin.canopy.hidden-content.configure-item",
                "jellyfin.canopy.seerr.request-item",
            },
            PlatformOperationVocabulary.All.Select(definition => definition.Id.Value));
    }

    private static string[] SensitiveMemberOwners(string typeName, string memberName) => ProductionFiles()
        .Where(file => HasSensitiveMemberUse(Code(file), typeName, memberName))
        .Select(file => Path.GetFileName(file)!)
        .OrderBy(name => name, StringComparer.Ordinal)
        .ToArray();

    private static bool HasSensitiveMemberUse(string source, string typeName, string memberName)
    {
        var code = NormalizeIdentifierUnicodeEscapes(source);
        var escapedType = Regex.Escape(typeName);
        var escapedMember = Regex.Escape(memberName);
        var identifier = @"[A-Za-z_]\w*";

        // Any alias or static import of a sensitive owner is itself ownership. This is
        // deliberately conservative and does not attempt to reimplement C#'s identifier
        // grammar, so verbatim and Unicode aliases cannot hide a sensitive member use.
        if (HasUsingDirectiveNamingType(code, escapedType, globalOnly: false))
        {
            return true;
        }

        if (Regex.IsMatch(
            code,
            $@"(?:(?:global\s*::\s*)?{identifier}\s*\.\s*)*\b{escapedType}\b\s*\.\s*\b{escapedMember}\b",
            RegexOptions.CultureInvariant))
        {
            return true;
        }

        return Regex.IsMatch(
                code,
                $@"\b(?:class|struct)\s+{escapedType}\b",
                RegexOptions.CultureInvariant)
            && Regex.IsMatch(code, $@"\b{escapedMember}\b", RegexOptions.CultureInvariant);
    }

    private static bool HasClosedTypeConstruction(string source)
    {
        var code = NormalizeIdentifierUnicodeEscapes(source);
        var typeAlternation = string.Join("|", ClosedConstructionTypeNames.Select(Regex.Escape));
        var identifier = @"[A-Za-z_]\w*";

        if (HasUsingDirectiveNamingType(code, typeAlternation, globalOnly: false))
        {
            return true;
        }

        if (Regex.IsMatch(
            code,
            $@"\bnew\s+(?:(?:global\s*::\s*)?{identifier}\s*\.\s*)*(?:{typeAlternation})\s*\(",
            RegexOptions.CultureInvariant)
            || Regex.IsMatch(
                code,
                $@"\b(?:{typeAlternation})\b\s+{identifier}\s*=\s*new\s*\(",
                RegexOptions.CultureInvariant))
        {
            return true;
        }

        return false;
    }

    private static bool HasSensitiveGlobalAliasDeclaration(string source)
    {
        var code = NormalizeIdentifierUnicodeEscapes(source);
        var types = string.Join("|", ClosedConstructionTypeNames
            .Concat(SensitiveMembers.Select(member => member.TypeName))
            .Distinct(StringComparer.Ordinal)
            .Select(Regex.Escape));
        return HasUsingDirectiveNamingType(code, types, globalOnly: true);
    }

    private static bool HasCrossFileSensitiveMemberUse(
        string aliasSource,
        string useSource,
        string typeName,
        string memberName)
    {
        var aliases = NormalizeIdentifierUnicodeEscapes(aliasSource);
        _ = useSource;
        _ = memberName;
        return HasUsingDirectiveNamingType(aliases, Regex.Escape(typeName), globalOnly: true);
    }

    private static bool HasUsingDirectiveNamingType(
        string code,
        string escapedTypePattern,
        bool globalOnly)
    {
        var prefix = globalOnly ? @"global\s+using" : @"(?:global\s+)?using";
        return Regex.IsMatch(
            code,
            $@"^\s*{prefix}\s+(?:static\s+)?[^;]*\b(?:{escapedTypePattern})\b\s*;",
            RegexOptions.CultureInvariant | RegexOptions.Multiline);
    }

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

    private static string Code(string file) =>
        NormalizeIdentifierUnicodeEscapes(PlatformHostSeamTests.CodeOnly(File.ReadAllText(file)));

    private static IEnumerable<string> ProductionFiles() =>
        Directory.EnumerateFiles(ProductionRoot(), "*.cs", SearchOption.AllDirectories)
            .Where(file => !file.Contains(
                    $"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}",
                    StringComparison.Ordinal)
                && !file.Contains(
                    $"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}",
                    StringComparison.Ordinal));

    private static string SourceFile(string name) => ProductionFiles()
        .Single(file => Path.GetFileName(file) == name);

    private static string ProductionRoot([CallerFilePath] string sourceFile = "") =>
        Path.GetFullPath(Path.Combine(
            Path.GetDirectoryName(sourceFile)!,
            "..",
            "..",
            "Jellyfin.Plugin.JellyfinCanopy"));
}
