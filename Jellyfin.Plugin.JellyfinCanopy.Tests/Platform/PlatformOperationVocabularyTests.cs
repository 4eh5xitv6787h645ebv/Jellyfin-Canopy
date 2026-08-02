using System;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using System.Runtime.ExceptionServices;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    public class PlatformOperationVocabularyTests
    {
        [Fact]
        public void VocabularyIsTheExactThreeFamilyNativePilotGolden()
        {
            var actual = PlatformOperationVocabulary.All
                .Select(definition => new
                {
                    Id = definition.Id.Value,
                    definition.Family,
                    definition.Authority,
                    definition.ItemScope,
                    Kinds = string.Join(",", definition.SupportedItemKinds),
                    definition.IsMutation,
                    Schema = definition.InputSchemaId.Value,
                    definition.InvalidationGeneration,
                })
                .ToArray();

            Assert.Equal(
                new[]
                {
                    new
                    {
                        Id = "jellyfin.canopy.spoiler-guard.configure-item",
                        Family = PlatformOperationFamily.SpoilerGuard,
                        Authority = PlatformAuthorityLevel.Authenticated,
                        ItemScope = PlatformItemScope.ExactItem,
                        Kinds = "Movie,Series",
                        IsMutation = true,
                        Schema = "jellyfin.canopy.spoiler-guard.item-configuration.v1",
                        InvalidationGeneration = 1L,
                    },
                    new
                    {
                        Id = "jellyfin.canopy.hidden-content.configure-item",
                        Family = PlatformOperationFamily.HiddenContent,
                        Authority = PlatformAuthorityLevel.Authenticated,
                        ItemScope = PlatformItemScope.ExactItem,
                        Kinds = "Movie,Series,Episode",
                        IsMutation = true,
                        Schema = "jellyfin.canopy.hidden-content.item-configuration.v1",
                        InvalidationGeneration = 1L,
                    },
                    new
                    {
                        Id = "jellyfin.canopy.seerr.request-item",
                        Family = PlatformOperationFamily.Seerr,
                        Authority = PlatformAuthorityLevel.Authenticated,
                        ItemScope = PlatformItemScope.ExactItem,
                        Kinds = "Movie,Series",
                        IsMutation = true,
                        Schema = "jellyfin.canopy.seerr.item-request.v1",
                        InvalidationGeneration = 1L,
                    },
                },
                actual);
        }

        [Fact]
        public void EveryDefinitionIsUniqueBoundedAndClosed()
        {
            var definitions = PlatformOperationVocabulary.All;

            Assert.Equal(definitions.Length, definitions.Select(definition => definition.Id.Value).Distinct(StringComparer.Ordinal).Count());
            Assert.Equal(definitions.Length, definitions.Select(definition => definition.InputSchemaId.Value).Distinct(StringComparer.Ordinal).Count());
            Assert.Equal(definitions.Length, definitions.Select(definition => definition.Family).Distinct().Count());
            Assert.All(definitions, definition =>
            {
                Assert.True(PlatformOperationVocabulary.IsValidIdentifier(definition.Id.Value));
                Assert.True(PlatformOperationVocabulary.IsValidIdentifier(definition.InputSchemaId.Value));
                Assert.InRange(definition.Id.Value.Length, 1, PlatformOperationVocabulary.MaximumIdentifierLength);
                Assert.InRange(definition.InputSchemaId.Value.Length, 1, PlatformOperationVocabulary.MaximumIdentifierLength);
                Assert.Equal(PlatformAuthorityLevel.Authenticated, definition.Authority);
                Assert.Equal(PlatformItemScope.ExactItem, definition.ItemScope);
                Assert.True(definition.IsMutation);
                Assert.True(definition.InvalidationGeneration > 0);
                Assert.NotEmpty(definition.SupportedItemKinds);
                Assert.DoesNotContain(HostItemKind.Other, definition.SupportedItemKinds);
                Assert.Equal(definition.SupportedItemKinds.Length, definition.SupportedItemKinds.Distinct().Count());
            });
        }

        [Fact]
        public void FindUsesExactOrdinalKnownIdsAndFailsClosedForEverythingElse()
        {
            foreach (var expected in PlatformOperationVocabulary.All)
            {
                Assert.Same(expected, PlatformOperationVocabulary.Find(expected.Id.Value));
            }

            Assert.Null(PlatformOperationVocabulary.Find(null));
            Assert.Null(PlatformOperationVocabulary.Find(string.Empty));
            Assert.Null(PlatformOperationVocabulary.Find("jellyfin.canopy.unknown-operation"));
            Assert.Null(PlatformOperationVocabulary.Find("JELLYFIN.CANOPY.SEERR.REQUEST-ITEM"));
            Assert.Null(PlatformOperationVocabulary.Find(" jellyfin.canopy.seerr.request-item"));
            Assert.Null(PlatformOperationVocabulary.Find("jellyfin.canopy.seerr.request-item "));
        }

        [Theory]
        [InlineData("vendor.extension.operation")]
        [InlineData("vendor.extension.operation-name.v1")]
        [InlineData("a.b.c")]
        public void IdentifierGrammarAcceptsBoundedLowerCaseNamespaces(string value)
            => Assert.True(PlatformOperationVocabulary.IsValidIdentifier(value));

        [Theory]
        [InlineData("operation")]
        [InlineData("vendor.operation")]
        [InlineData("1vendor.extension.operation")]
        [InlineData("Vendor.extension.operation")]
        [InlineData("vendor..operation")]
        [InlineData("vendor.extension.")]
        [InlineData("vendor.extension.-operation")]
        [InlineData("vendor.extension.operation-")]
        [InlineData("vendor.extension.operation_name")]
        [InlineData("vendor/extension/operation")]
        [InlineData("vendor.extension.opération")]
        public void IdentifierGrammarRejectsUnnamespacedOrNonAsciiValues(string value)
            => Assert.False(PlatformOperationVocabulary.IsValidIdentifier(value));

        [Fact]
        public void IdentifierGrammarEnforcesItsExactLengthBoundary()
        {
            const string prefix = "vendor.extension.";
            var maximum = prefix + new string('a', PlatformOperationVocabulary.MaximumIdentifierLength - prefix.Length);

            Assert.True(PlatformOperationVocabulary.IsValidIdentifier(maximum));
            Assert.False(PlatformOperationVocabulary.IsValidIdentifier(maximum + "a"));
        }

        [Fact]
        public void IdentifierValueTypesRejectInvalidConstructionAndHaveSafeDefaults()
        {
            Assert.Throws<ArgumentException>(() => ConstructPrivately<PlatformOperationId>("free-form"));
            Assert.Throws<ArgumentException>(() => ConstructPrivately<PlatformInputSchemaId>("free-form"));
            Assert.Equal(string.Empty, default(PlatformOperationId).ToString());
            Assert.Equal(string.Empty, default(PlatformInputSchemaId).ToString());
        }

        [Fact]
        public void DefinitionRejectsInvalidOrOpenEndedMetadata()
        {
            var id = ConstructPrivately<PlatformOperationId>("vendor.extension.operation");
            var schema = ConstructPrivately<PlatformInputSchemaId>("vendor.extension.input.v1");
            var kinds = ImmutableArray.Create(HostItemKind.Movie);

            Assert.Throws<ArgumentException>(() => New(default, kinds: kinds));
            Assert.Throws<ArgumentOutOfRangeException>(() => New(id, family: (PlatformOperationFamily)99, kinds: kinds));
            Assert.Throws<ArgumentOutOfRangeException>(() => New(id, authority: (PlatformAuthorityLevel)99, kinds: kinds));
            Assert.Throws<ArgumentOutOfRangeException>(() => New(id, itemScope: (PlatformItemScope)99, kinds: kinds));
            Assert.Throws<ArgumentException>(() => New(id, kinds: default));
            Assert.Throws<ArgumentException>(() => New(id, kinds: [HostItemKind.Other]));
            Assert.Throws<ArgumentException>(() => New(id, kinds: [(HostItemKind)99]));
            Assert.Throws<ArgumentException>(() => New(id, kinds: [HostItemKind.Movie, HostItemKind.Movie]));
            Assert.Throws<ArgumentException>(() => New(id, kinds: kinds, isMutation: false));
            Assert.Throws<ArgumentException>(() => ConstructPrivately<PlatformOperationDefinition>(
                id,
                PlatformOperationFamily.Seerr,
                PlatformAuthorityLevel.Authenticated,
                PlatformItemScope.ExactItem,
                kinds,
                true,
                default,
                1));
            Assert.Throws<ArgumentOutOfRangeException>(() => New(id, kinds: kinds, invalidationGeneration: 0));

            PlatformOperationDefinition New(
                PlatformOperationId operationId,
                PlatformOperationFamily family = PlatformOperationFamily.Seerr,
                PlatformAuthorityLevel authority = PlatformAuthorityLevel.Authenticated,
                PlatformItemScope itemScope = PlatformItemScope.ExactItem,
                ImmutableArray<HostItemKind> kinds = default,
                bool isMutation = true,
                long invalidationGeneration = 1)
                => ConstructPrivately<PlatformOperationDefinition>(
                    operationId,
                    family,
                    authority,
                    itemScope,
                    kinds,
                    isMutation,
                    schema,
                    invalidationGeneration);
        }

        private static T ConstructPrivately<T>(params object?[] arguments)
        {
            var constructor = typeof(T)
                .GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic)
                .Single();

            try
            {
                return (T)constructor.Invoke(arguments);
            }
            catch (TargetInvocationException exception) when (exception.InnerException is not null)
            {
                ExceptionDispatchInfo.Capture(exception.InnerException).Throw();
                throw;
            }
        }
    }
}
