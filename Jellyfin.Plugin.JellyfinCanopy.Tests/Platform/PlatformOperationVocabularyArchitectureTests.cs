using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    /// <summary>Guards the operation vocabulary against caller or manifest registration.</summary>
    public class PlatformOperationVocabularyArchitectureTests
    {
        private static readonly Regex ExplicitVocabularyTypeConstruction = new(
            @"\bnew\s+(?:(?:global::)?[A-Za-z_]\w*\.)*(?:PlatformOperationDefinition|PlatformOperationId|PlatformInputSchemaId)\s*\(",
            RegexOptions.Compiled | RegexOptions.CultureInvariant);

        private static readonly Regex TargetTypedVocabularyTypeConstruction = new(
            @"\b(?:PlatformOperationDefinition|PlatformOperationId|PlatformInputSchemaId)\s+[A-Za-z_]\w*\s*=\s*new\s*\(",
            RegexOptions.Compiled | RegexOptions.CultureInvariant);

        private static readonly Regex VocabularyTypeAlias = new(
            @"^\s*using\s+[A-Za-z_]\w*\s*=\s*(?:(?:global::)?[A-Za-z_]\w*\.)*(?:PlatformOperationDefinition|PlatformOperationId|PlatformInputSchemaId)\s*;",
            RegexOptions.Compiled | RegexOptions.CultureInvariant | RegexOptions.Multiline);

        [Fact]
        public void DefinitionsAndIdentifiersHaveOnlyPrivateConstructors()
        {
            foreach (var type in new[]
            {
                typeof(PlatformOperationDefinition),
                typeof(PlatformOperationId),
                typeof(PlatformInputSchemaId),
            })
            {
                var constructors = type.GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
                Assert.Single(constructors);
                Assert.True(constructors[0].IsPrivate);
            }
        }

        [Fact]
        public void OnlyTheCodeOwnedVocabularySourceConstructsClosedTypes()
        {
            var constructionOwners = ProductionFiles()
                .Where(file => HasVocabularyTypeConstruction(
                    PlatformHostSeamTests.CodeOnly(File.ReadAllText(file))))
                .Select(Path.GetFileName)
                .OrderBy(name => name, StringComparer.Ordinal)
                .ToArray();

            Assert.Equal(new[] { "PlatformOperationVocabulary.cs" }, constructionOwners);
            Assert.True(HasVocabularyTypeConstruction(
                "var planted = new PlatformOperationDefinition(id, family, authority, scope, kinds, true, schema, 1);"));
            Assert.True(HasVocabularyTypeConstruction(
                "var planted = new global::Jellyfin.Plugin.JellyfinCanopy.Platform.PlatformOperationId(value);"));
            Assert.True(HasVocabularyTypeConstruction(
                "var planted = new Jellyfin.Plugin.JellyfinCanopy.Platform.PlatformInputSchemaId(value);"));
            Assert.True(HasVocabularyTypeConstruction(
                "PlatformOperationDefinition planted = new(id, family, authority, scope, kinds, true, schema, 1);"));
            Assert.True(HasVocabularyTypeConstruction(
                "using Definition = global::Jellyfin.Plugin.JellyfinCanopy.Platform.PlatformOperationDefinition;\n"
                + "Definition planted = new(id, family, authority, scope, kinds, true, schema, 1);"));
        }

        [Fact]
        public void AssemblyVisibleInstancesAreTheExactFixedVocabularyOnly()
        {
            Assert.Equal(
                new[] { "HiddenContentConfigureItem", "SeerrRequestItem", "SpoilerGuardConfigureItem" },
                NonPublicStaticPropertyNames(typeof(PlatformOperationId)));
            Assert.Equal(
                new[] { "HiddenContentItemConfigurationV1", "SeerrItemRequestV1", "SpoilerGuardItemConfigurationV1" },
                NonPublicStaticPropertyNames(typeof(PlatformInputSchemaId)));
            Assert.Equal(
                new[] { "HiddenContentConfigureItem", "SeerrRequestItem", "SpoilerGuardConfigureItem" },
                NonPublicStaticPropertyNames(typeof(PlatformOperationDefinition)));

            Assert.Empty(typeof(PlatformOperationId).GetProperties(BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly));
            Assert.Empty(typeof(PlatformInputSchemaId).GetProperties(BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly));
            Assert.Empty(typeof(PlatformOperationDefinition).GetProperties(BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly));
        }

        [Fact]
        public void VocabularyExposesLookupButNoRegistrationSurface()
        {
            var publicMethods = typeof(PlatformOperationVocabulary)
                .GetMethods(BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly)
                .Where(method => !method.IsSpecialName)
                .Select(method => method.Name)
                .OrderBy(name => name, StringComparer.Ordinal)
                .ToArray();

            Assert.Equal(new[] { nameof(PlatformOperationVocabulary.Find) }, publicMethods);
            Assert.DoesNotContain(
                typeof(PlatformOperationVocabulary).GetProperties(BindingFlags.Public | BindingFlags.Static),
                property => property.CanWrite);
        }

        [Fact]
        public void DefinitionMetadataCannotNameRoutesMethodsOrServices()
        {
            var expectedProperties = new Dictionary<string, Type>(StringComparer.Ordinal)
            {
                [nameof(PlatformOperationDefinition.Authority)] = typeof(PlatformAuthorityLevel),
                [nameof(PlatformOperationDefinition.Family)] = typeof(PlatformOperationFamily),
                [nameof(PlatformOperationDefinition.Id)] = typeof(PlatformOperationId),
                [nameof(PlatformOperationDefinition.InputSchemaId)] = typeof(PlatformInputSchemaId),
                [nameof(PlatformOperationDefinition.InvalidationGeneration)] = typeof(long),
                [nameof(PlatformOperationDefinition.IsMutation)] = typeof(bool),
                [nameof(PlatformOperationDefinition.ItemScope)] = typeof(PlatformItemScope),
                [nameof(PlatformOperationDefinition.SupportedItemKinds)] = typeof(System.Collections.Immutable.ImmutableArray<HostItemKind>),
            };

            var actualProperties = typeof(PlatformOperationDefinition)
                .GetProperties(BindingFlags.Instance | BindingFlags.Public)
                .ToDictionary(property => property.Name, property => property.PropertyType, StringComparer.Ordinal);
            Assert.Equal(
                expectedProperties.Keys.OrderBy(name => name, StringComparer.Ordinal),
                actualProperties.Keys.OrderBy(name => name, StringComparer.Ordinal));
            Assert.All(expectedProperties, expected => Assert.Equal(expected.Value, actualProperties[expected.Key]));
            Assert.All(typeof(PlatformOperationDefinition).GetProperties(), property => Assert.False(property.CanWrite));

            Assert.All(PlatformOperationVocabulary.All, definition =>
            {
                Assert.DoesNotContain('/', definition.Id.Value);
                Assert.DoesNotContain(':', definition.Id.Value);
                Assert.DoesNotContain("controller", definition.Id.Value, StringComparison.Ordinal);
                Assert.DoesNotContain("service", definition.Id.Value, StringComparison.Ordinal);
                Assert.DoesNotContain("proxy", definition.Id.Value, StringComparison.Ordinal);
            });
        }

        [Fact]
        public void VocabularySourceHasNoHttpManifestOrDependencyInjectionRegistration()
        {
            var code = PlatformHostSeamTests.CodeOnly(File.ReadAllText(SourceFile("PlatformOperationVocabulary.cs")));

            foreach (var forbidden in new[]
            {
                "HttpGet",
                "HttpPost",
                "HttpPut",
                "HttpDelete",
                "Route(",
                "ControllerBase",
                "IServiceCollection",
                "IServiceProvider",
                "Manifest",
                "Register(",
            })
            {
                Assert.DoesNotContain(forbidden, code, StringComparison.Ordinal);
            }
        }

        private static IEnumerable<string> ProductionFiles() =>
            Directory.EnumerateFiles(ProductionRoot(), "*.cs", SearchOption.AllDirectories)
                .Where(file => !file.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                    && !file.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal));

        private static string SourceFile(string name) => ProductionFiles().Single(file => Path.GetFileName(file) == name);

        private static bool HasVocabularyTypeConstruction(string code) =>
            ExplicitVocabularyTypeConstruction.IsMatch(code)
            || TargetTypedVocabularyTypeConstruction.IsMatch(code)
            || VocabularyTypeAlias.IsMatch(code);

        private static string[] NonPublicStaticPropertyNames(Type type) =>
            type.GetProperties(BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.DeclaredOnly)
                .Select(property => property.Name)
                .OrderBy(name => name, StringComparer.Ordinal)
                .ToArray();

        private static string ProductionRoot([CallerFilePath] string sourceFile = "") =>
            Path.GetFullPath(Path.Combine(
                Path.GetDirectoryName(sourceFile)!,
                "..",
                "..",
                "Jellyfin.Plugin.JellyfinCanopy"));
    }
}
