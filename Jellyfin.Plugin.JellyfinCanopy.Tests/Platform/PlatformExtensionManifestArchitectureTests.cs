using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

/// <summary>Guards the pure manifest contract before filesystem discovery or registry ownership exists.</summary>
public sealed class PlatformExtensionManifestArchitectureTests
{
    private const string ManifestDomainFileName = "PlatformExtensionManifestDomain.cs";

    private static readonly Regex IdentifierUnicodeEscape = new(
        @"\\(?:u(?<short>[0-9a-fA-F]{4})|U(?<long>[0-9a-fA-F]{8}))",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly string[] ForbiddenManifestDependencyTokens =
    {
        "System.IO",
        "File.",
        "FileInfo",
        "Directory",
        "DirectoryInfo",
        "Path.",
        "Stream",
        "System.Net",
        "HttpClient",
        "IPluginManager",
        "MediaBrowser",
        "IPlatformHost",
        "HostPlugin",
        "Microsoft.AspNetCore",
        "HttpContext",
        "HttpRequest",
        "Controller",
        "Route(",
        "Microsoft.Extensions.Configuration",
        "Microsoft.Extensions.DependencyInjection",
        "IConfiguration",
        "IServiceCollection",
        "IServiceProvider",
        "AddSingleton",
        "AddScoped",
        "AddTransient",
        "System.Data",
        "DbConnection",
        "DbContext",
        "Microsoft.Data.Sqlite",
        "SqliteConnection",
        "Persistence",
        "Repository",
        "Registry",
        "Lifecycle",
        "Approval",
        "GrantedCapability",
        "GrantCeiling",
        "PlatformApprovedProviderIdentity",
        "PlatformActorFactory",
        "CreateProvider",
        "PlatformInstalledProviderActor",
        "ProviderInvocation",
        "Credential",
        "Secret",
        "Asset",
        "System.Reflection",
        "Activator",
        "Assembly.Load",
        "DateTime",
        "DateTimeOffset",
        "Random",
        "Guid.NewGuid",
        "Environment.",
    };

    [Fact]
    public void ManifestModelIsASealedImmutableBoundedAllowList()
    {
        var type = typeof(PlatformExtensionManifest);
        Assert.True(type.IsSealed);
        Assert.Empty(type.GetConstructors(BindingFlags.Public | BindingFlags.Instance));

        var properties = type.GetProperties(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
            .OrderBy(property => property.Name, StringComparer.Ordinal)
            .ToArray();
        Assert.Equal(
            new[]
            {
                "Description",
                "DisplayName",
                "Fingerprint",
                "HostRange",
                "Id",
                "Kind",
                "PlatformRange",
                "PluginId",
                "RequestedCapabilities",
                "SchemaVersion",
                "Version",
            },
            properties.Select(property => property.Name));
        Assert.All(properties, property => Assert.False(property.CanWrite));

        Assert.Equal(typeof(int), Property("SchemaVersion").PropertyType);
        Assert.Equal(typeof(string), Property("Id").PropertyType);
        Assert.Equal(typeof(Guid), Property("PluginId").PropertyType);
        Assert.Equal(typeof(Version), Property("Version").PropertyType);
        Assert.Equal(typeof(PlatformActorKind), Property("Kind").PropertyType);
        Assert.Equal(typeof(string), Property("DisplayName").PropertyType);
        Assert.Equal(typeof(string), Property("Description").PropertyType);
        Assert.Equal(typeof(PlatformExtensionProtocolRange), Property("PlatformRange").PropertyType);
        Assert.Equal(typeof(PlatformExtensionHostRange), Property("HostRange").PropertyType);
        Assert.Equal(typeof(PlatformRequestedCapabilitySet), Property("RequestedCapabilities").PropertyType);
        Assert.Equal(typeof(PlatformManifestFingerprint), Property("Fingerprint").PropertyType);

        var forbiddenShape = new[]
        {
            "approved",
            "grant",
            "effective",
            "enabled",
            "installed",
            "registered",
            "callable",
            "credential",
            "secret",
            "path",
            "url",
            "assembly",
            "type",
            "method",
            "script",
            "operation",
            "contribution",
            "asset",
            "raw",
            "bytes",
            "exception",
        };
        Assert.DoesNotContain(
            properties,
            property => forbiddenShape.Contains(property.Name, StringComparer.OrdinalIgnoreCase));
        Assert.DoesNotContain(
            type.GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance),
            field => field.FieldType == typeof(byte[])
                || field.FieldType == typeof(ReadOnlyMemory<byte>)
                || field.FieldType == typeof(Memory<byte>));

        PropertyInfo Property(string name) => properties.Single(property => property.Name == name);
    }

    [Fact]
    public void ParserExposesOnlyTheBoundedTryParseBoundaryAndClosedRejectionReasons()
    {
        var methods = typeof(PlatformExtensionManifestParser)
            .GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.DeclaredOnly)
            .Where(method => !method.IsSpecialName)
            .ToArray();
        var parse = Assert.Single(methods, method => method.Name == "TryParse");
        Assert.All(methods.Where(method => method != parse), method => Assert.True(method.IsPrivate));
        Assert.False(parse.IsPublic);
        Assert.Equal(typeof(bool), parse.ReturnType);
        Assert.Equal(
            new[]
            {
                typeof(byte[]),
                typeof(PlatformExtensionManifest).MakeByRefType(),
                typeof(PlatformExtensionManifestRejectionReason).MakeByRefType(),
            },
            parse.GetParameters().Select(parameter => parameter.ParameterType));

        Assert.True(typeof(PlatformExtensionManifestRejectionReason).IsEnum);
        var reasons = Enum.GetValues<PlatformExtensionManifestRejectionReason>();
        Assert.Equal(
            new[]
            {
                "None",
                "MissingDocument",
                "DocumentTooLarge",
                "InvalidUtf8",
                "InvalidJson",
                "DuplicateProperty",
                "UnknownProperty",
                "MissingProperty",
                "InvalidPropertyType",
                "UnsupportedSchemaVersion",
                "InvalidIdentifier",
                "InvalidPluginId",
                "InvalidVersion",
                "InvalidKind",
                "InvalidDisplayName",
                "InvalidDescription",
                "InvalidPlatformRange",
                "InvalidHostRange",
                "InvalidRequestedCapabilities",
                "IncompatibleRequestedCapability",
            },
            Enum.GetNames<PlatformExtensionManifestRejectionReason>());
        Assert.Equal(Enumerable.Range(0, 20), reasons.Select(reason => (int)reason));
    }

    [Fact]
    public void ManifestDomainHasNoFilesystemHostHttpRegistryAuthorityOrExecutionDependencies()
    {
        var code = Code(SourceFile(ManifestDomainFileName));
        Assert.Empty(ForbiddenManifestDependenciesIn(code));
        Assert.Contains("SHA256", code, StringComparison.Ordinal);
        Assert.Contains("UTF8", code, StringComparison.OrdinalIgnoreCase);
        Assert.Contains(nameof(PlatformRequestedCapabilitySet), code, StringComparison.Ordinal);
        Assert.Contains(nameof(PlatformManifestFingerprint), code, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("using System.Net.Http; var client = new HttpClient();", "System.Net")]
    [InlineData("using System.Data.Common; DbConnection connection;", "System.Data")]
    [InlineData("using Microsoft.Data.Sqlite; var db = new SqliteConnection();", "Microsoft.Data.Sqlite")]
    [InlineData("sealed class ManifestRepository { }", "Repository")]
    public void DependencyGuardRejectsPlantedHttpAndPersistenceReferences(string source, string expected) =>
        Assert.Contains(expected, ForbiddenManifestDependenciesIn(source));

    [Fact]
    public void ManifestParsingConstructionAndFingerprintEstablishmentAreSourceOwned()
    {
        Assert.Equal(
            new[] { ManifestDomainFileName },
            MemberOwners(nameof(PlatformExtensionManifestParser), nameof(PlatformExtensionManifestParser.TryParse)));
        Assert.Equal(
            new[] { "PlatformActorDomain.cs", ManifestDomainFileName },
            MemberOwners(nameof(PlatformManifestFingerprint), "EstablishValidatedManifestFingerprint"));
        Assert.Equal(
            new[] { ManifestDomainFileName },
            MemberOwners(nameof(PlatformExtensionManifest), "EstablishValidatedManifest"));
        Assert.Equal(
            new[] { ManifestDomainFileName },
            ConstructorOwners(nameof(PlatformExtensionManifest)));
        Assert.Equal(
            new[] { ManifestDomainFileName },
            ConstructorOwners(nameof(PlatformExtensionProtocolRange)));
        Assert.Equal(
            new[] { ManifestDomainFileName },
            ConstructorOwners(nameof(PlatformExtensionHostRange)));

        Assert.True(HasMemberUse(
            "var ok = global::Jellyfin.Plugin.JellyfinCanopy.Platform.PlatformExtensionManifestParser.TryParse(bytes, out var manifest, out var reason);",
            nameof(PlatformExtensionManifestParser),
            nameof(PlatformExtensionManifestParser.TryParse)));
        Assert.True(HasConstructorUse(
            "var range = new PlatformExtensionProtocolRange(1, 1);",
            nameof(PlatformExtensionProtocolRange)));
        Assert.True(HasConstructorUse(
            "PlatformExtensionProtocolRange range = new(1, 1);",
            nameof(PlatformExtensionProtocolRange)));
        Assert.True(HasConstructorUse(
            "using HostRange = Jellyfin.Plugin.JellyfinCanopy.Platform.PlatformExtensionHostRange; var range = new HostRange(12, 12);",
            nameof(PlatformExtensionHostRange)));
        Assert.True(HasMemberUse(
            "using Parser = Jellyfin.Plugin.JellyfinCanopy.Platform.PlatformExtensionManifestParser; var ok = Parser.TryParse(bytes, out var manifest, out var reason);",
            nameof(PlatformExtensionManifestParser),
            nameof(PlatformExtensionManifestParser.TryParse)));
        Assert.True(HasMemberUse(
            "var ok = PlatformExtensionManifestParser.Try\\u0050arse(bytes, out var manifest, out var reason);",
            nameof(PlatformExtensionManifestParser),
            nameof(PlatformExtensionManifestParser.TryParse)));
    }

    [Fact]
    public void CrossFileGlobalAliasesCannotHideManifestAuthorityOwners()
    {
        var sensitiveTypes = new[]
        {
            nameof(PlatformExtensionManifestParser),
            nameof(PlatformExtensionManifest),
            nameof(PlatformManifestFingerprint),
            nameof(PlatformExtensionProtocolRange),
            nameof(PlatformExtensionHostRange),
        };
        var aliases = ProductionFiles()
            .Where(file => Regex.IsMatch(
                Code(file),
                @"^\s*global\s+using(?:\s+static)?\s+[^;]*(?:"
                    + string.Join('|', sensitiveTypes.Select(Regex.Escape))
                    + @")\s*;",
                RegexOptions.CultureInvariant | RegexOptions.Multiline))
            .Select(file => Path.GetFileName(file))
            .ToArray();

        Assert.Empty(aliases);
        Assert.Matches(
            @"^\s*global\s+using",
            "global using Parser = Jellyfin.Plugin.JellyfinCanopy.Platform.PlatformExtensionManifestParser;");
    }

    [Fact]
    public void ManifestSliceDoesNotIssueApprovedProviderIdentityOrActivateExistingPaths()
    {
        var production = ProductionFiles()
            .ToDictionary(file => Path.GetFileName(file)!, Code, StringComparer.Ordinal);
        Assert.All(production, pair => Assert.DoesNotContain(
            "new PlatformApprovedProviderIdentity",
            pair.Value,
            StringComparison.Ordinal));
        Assert.All(production.Where(pair => pair.Key != "PlatformActorDomain.cs"), pair => Assert.DoesNotContain(
            "PlatformActorFactory.CreateProvider",
            pair.Value,
            StringComparison.Ordinal));

        var existingActionPathFiles = new[]
        {
            "PlatformActionCapabilityService.cs",
            "PlatformActionInvocationCoordinator.cs",
            "PlatformFirstPartyActionDispatcher.cs",
            "PlatformNativeCatalogService.cs",
            "PlatformNativeController.cs",
            "PlatformOperationVocabulary.cs",
        };
        foreach (var fileName in existingActionPathFiles)
        {
            Assert.DoesNotContain("PlatformExtensionManifest", production[fileName], StringComparison.Ordinal);
        }

        Assert.Equal(3, PlatformOperationVocabulary.All.Length);
    }

    private static string[] MemberOwners(string typeName, string memberName) => ProductionFiles()
        .Where(file => HasMemberUse(Code(file), typeName, memberName))
        .Select(file => Path.GetFileName(file)!)
        .OrderBy(name => name, StringComparer.Ordinal)
        .ToArray();

    private static string[] ConstructorOwners(string typeName) => ProductionFiles()
        .Where(file => HasConstructorUse(Code(file), typeName))
        .Select(file => Path.GetFileName(file)!)
        .OrderBy(name => name, StringComparer.Ordinal)
        .ToArray();

    private static bool HasConstructorUse(string source, string typeName)
    {
        var code = NormalizeIdentifierUnicodeEscapes(source);
        var escapedType = Regex.Escape(typeName);
        var identifier = @"[A-Za-z_]\w*";

        // A local or global alias/import naming the sensitive type is conservatively
        // treated as ownership so aliases cannot hide either explicit or target-typed new.
        if (HasUsingDirectiveNamingType(code, escapedType))
        {
            return true;
        }

        if (Regex.IsMatch(
                code,
                $@"\bnew\s+(?:(?:global\s*::\s*)?{identifier}\s*\.\s*)*{escapedType}\s*\(",
                RegexOptions.CultureInvariant)
            || Regex.IsMatch(
                code,
                $@"\b{escapedType}\b\s+{identifier}\s*=\s*new\s*\(",
                RegexOptions.CultureInvariant))
        {
            return true;
        }

        return Regex.IsMatch(
                code,
                $@"\b(?:class|struct)\s+{escapedType}\b",
                RegexOptions.CultureInvariant)
            && Regex.IsMatch(code, $@"\b{escapedType}\s*\(", RegexOptions.CultureInvariant);
    }

    private static bool HasUsingDirectiveNamingType(string code, string escapedTypePattern) => Regex.IsMatch(
        code,
        $@"^\s*(?:global\s+)?using\s+(?:static\s+)?[^;]*\b(?:{escapedTypePattern})\b\s*;",
        RegexOptions.CultureInvariant | RegexOptions.Multiline);

    private static string[] ForbiddenManifestDependenciesIn(string source) =>
        ForbiddenManifestDependencyTokens
            .Where(value => source.Contains(value, StringComparison.OrdinalIgnoreCase))
            .ToArray();

    private static bool HasMemberUse(string source, string typeName, string memberName)
    {
        var code = NormalizeIdentifierUnicodeEscapes(source)
            .Replace("global::", string.Empty, StringComparison.Ordinal);
        var compact = new string(code.Where(character => !char.IsWhiteSpace(character)).ToArray());
        var direct = typeName + "." + memberName;
        if (compact.Contains(direct, StringComparison.Ordinal))
        {
            return true;
        }

        foreach (var line in code.Split('\n'))
        {
            var trimmed = line.Trim();
            if (!trimmed.StartsWith("using ", StringComparison.Ordinal)
                || !trimmed.Contains('=')
                || !trimmed.Contains(typeName, StringComparison.Ordinal))
            {
                continue;
            }

            var alias = trimmed[6..trimmed.IndexOf('=')].Trim();
            if (compact.Contains(alias + "." + memberName, StringComparison.Ordinal))
            {
                return true;
            }
        }

        return (code.Contains("class " + typeName, StringComparison.Ordinal)
                || code.Contains("struct " + typeName, StringComparison.Ordinal))
            && code.Contains(memberName, StringComparison.Ordinal);
    }

    private static string Code(string file) => NormalizeIdentifierUnicodeEscapes(
        PlatformHostSeamTests.CodeOnly(File.ReadAllText(file)));

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
            if (Rune.GetUnicodeCategory(rune) != System.Globalization.UnicodeCategory.Format)
            {
                normalized.Append(rune.ToString());
            }
        }

        return normalized.ToString();
    }

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
