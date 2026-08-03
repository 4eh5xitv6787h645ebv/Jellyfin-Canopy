using System;
using System.Collections.Immutable;
using System.Linq;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>A code-owned, namespaced Platform operation identifier.</summary>
    public readonly record struct PlatformOperationId
    {
        private PlatformOperationId(string value)
        {
            if (!PlatformOperationVocabulary.IsValidIdentifier(value))
            {
                throw new ArgumentException(
                    "Operation ids must use the bounded lower-case Platform identifier grammar.",
                    nameof(value));
            }

            Value = value;
        }

        /// <summary>Gets the stable, case-sensitive identifier.</summary>
        public string Value { get; }

        internal static PlatformOperationId SpoilerGuardConfigureItem { get; } =
            new PlatformOperationId("jellyfin.canopy.spoiler-guard.configure-item");

        internal static PlatformOperationId HiddenContentConfigureItem { get; } =
            new PlatformOperationId("jellyfin.canopy.hidden-content.configure-item");

        internal static PlatformOperationId SeerrRequestItem { get; } =
            new PlatformOperationId("jellyfin.canopy.seerr.request-item");

        /// <inheritdoc />
        public override string ToString() => Value ?? string.Empty;
    }

    /// <summary>A code-owned identifier for one bounded action-input schema.</summary>
    public readonly record struct PlatformInputSchemaId
    {
        private PlatformInputSchemaId(string value)
        {
            if (!PlatformOperationVocabulary.IsValidIdentifier(value))
            {
                throw new ArgumentException(
                    "Input schema ids must use the bounded lower-case Platform identifier grammar.",
                    nameof(value));
            }

            Value = value;
        }

        /// <summary>Gets the stable, case-sensitive identifier.</summary>
        public string Value { get; }

        internal static PlatformInputSchemaId SpoilerGuardItemConfigurationV1 { get; } =
            new PlatformInputSchemaId("jellyfin.canopy.spoiler-guard.item-configuration.v1");

        internal static PlatformInputSchemaId HiddenContentItemConfigurationV1 { get; } =
            new PlatformInputSchemaId("jellyfin.canopy.hidden-content.item-configuration.v1");

        internal static PlatformInputSchemaId SeerrItemRequestV1 { get; } =
            new PlatformInputSchemaId("jellyfin.canopy.seerr.item-request.v1");

        /// <inheritdoc />
        public override string ToString() => Value ?? string.Empty;
    }

    /// <summary>The complete first-party product-family vocabulary for the native pilot.</summary>
    public enum PlatformOperationFamily
    {
        /// <summary>Per-user Spoiler Guard item configuration.</summary>
        SpoilerGuard,

        /// <summary>Per-user Hidden Content item configuration.</summary>
        HiddenContent,

        /// <summary>Per-user Seerr media requests.</summary>
        Seerr,
    }

    /// <summary>The Jellyfin authority an operation requires at invocation.</summary>
    public enum PlatformAuthorityLevel
    {
        /// <summary>Any authoritative authenticated first-party actor.</summary>
        Authenticated,

        /// <summary>An actor whose current Jellyfin user is elevated.</summary>
        Elevated,
    }

    /// <summary>The bounded context an operation may act on.</summary>
    public enum PlatformItemScope
    {
        /// <summary>The exact user-accessible Jellyfin item bound to the action.</summary>
        ExactItem,
    }

    /// <summary>Immutable authority metadata for one fixed first-party operation.</summary>
    public sealed class PlatformOperationDefinition
    {
        private PlatformOperationDefinition(
            PlatformOperationId id,
            PlatformOperationFamily family,
            PlatformAuthorityLevel authority,
            ImmutableArray<PlatformActorKind> allowedActorKinds,
            PlatformItemScope itemScope,
            ImmutableArray<HostItemKind> supportedItemKinds,
            bool isMutation,
            PlatformInputSchemaId inputSchemaId,
            long invalidationGeneration)
        {
            if (string.IsNullOrEmpty(id.Value))
            {
                throw new ArgumentException("A code-owned operation id is required.", nameof(id));
            }

            if (!Enum.IsDefined(family))
            {
                throw new ArgumentOutOfRangeException(nameof(family));
            }

            if (!Enum.IsDefined(authority))
            {
                throw new ArgumentOutOfRangeException(nameof(authority));
            }

            if (allowedActorKinds.IsDefaultOrEmpty
                || allowedActorKinds.Any(kind => !PlatformActorKindVocabulary.IsDefined(kind))
                || allowedActorKinds.Distinct().Count() != allowedActorKinds.Length)
            {
                throw new ArgumentException(
                    "An operation must declare distinct closed actor kinds.",
                    nameof(allowedActorKinds));
            }

            if (!Enum.IsDefined(itemScope))
            {
                throw new ArgumentOutOfRangeException(nameof(itemScope));
            }

            if (supportedItemKinds.IsDefaultOrEmpty
                || supportedItemKinds.Any(kind => kind == HostItemKind.Other || !Enum.IsDefined(kind))
                || supportedItemKinds.Distinct().Count() != supportedItemKinds.Length)
            {
                throw new ArgumentException(
                    "An operation must declare distinct supported closed item kinds.",
                    nameof(supportedItemKinds));
            }

            if (!isMutation)
            {
                throw new ArgumentException(
                    "Every native-pilot operation is a mutation and must use replay protection.",
                    nameof(isMutation));
            }

            if (string.IsNullOrEmpty(inputSchemaId.Value))
            {
                throw new ArgumentException("A code-owned input schema id is required.", nameof(inputSchemaId));
            }

            if (invalidationGeneration <= 0)
            {
                throw new ArgumentOutOfRangeException(
                    nameof(invalidationGeneration),
                    "An operation invalidation generation must be positive.");
            }

            Id = id;
            Family = family;
            Authority = authority;
            AllowedActorKinds = allowedActorKinds;
            ItemScope = itemScope;
            SupportedItemKinds = supportedItemKinds;
            IsMutation = isMutation;
            InputSchemaId = inputSchemaId;
            InvalidationGeneration = invalidationGeneration;
        }

        /// <summary>Gets the code-owned stable operation identifier.</summary>
        public PlatformOperationId Id { get; }

        /// <summary>Gets the owning first-party product family.</summary>
        public PlatformOperationFamily Family { get; }

        /// <summary>Gets the current Jellyfin authority required from the actor.</summary>
        public PlatformAuthorityLevel Authority { get; }

        /// <summary>Gets the exact closed actor kinds eligible for this operation.</summary>
        public ImmutableArray<PlatformActorKind> AllowedActorKinds { get; }

        /// <summary>Gets the bounded item context this operation accepts.</summary>
        public PlatformItemScope ItemScope { get; }

        /// <summary>Gets the exact closed host item kinds this operation accepts.</summary>
        public ImmutableArray<HostItemKind> SupportedItemKinds { get; }

        /// <summary>Gets whether the operation changes state and therefore requires replay protection.</summary>
        public bool IsMutation { get; }

        /// <summary>Gets the code-owned bounded input-schema identifier.</summary>
        public PlatformInputSchemaId InputSchemaId { get; }

        /// <summary>
        /// Gets the code generation bound into prepared actions. Incrementing it
        /// invalidates capabilities prepared against older operation semantics.
        /// </summary>
        public long InvalidationGeneration { get; }

        /// <summary>
        /// Applies the single actor-kind and current-authority policy for this operation.
        /// Unknown/default actors and all kind/ceiling mismatches fail closed.
        /// </summary>
        internal bool Allows(PlatformActorAuthority authority)
        {
            if (!authority.IsValid
                || !AllowedActorKinds.Contains(authority.Kind)
                || authority.Kind != PlatformActorKind.JellyfinUserClient)
            {
                return false;
            }

            return Authority switch
            {
                PlatformAuthorityLevel.Authenticated => true,
                PlatformAuthorityLevel.Elevated => authority.IsElevated,
                _ => false,
            };
        }

        internal static PlatformOperationDefinition SpoilerGuardConfigureItem { get; } = new PlatformOperationDefinition(
            PlatformOperationId.SpoilerGuardConfigureItem,
            PlatformOperationFamily.SpoilerGuard,
            PlatformAuthorityLevel.Authenticated,
            [PlatformActorKind.JellyfinUserClient],
            PlatformItemScope.ExactItem,
            [HostItemKind.Movie, HostItemKind.Series],
            true,
            PlatformInputSchemaId.SpoilerGuardItemConfigurationV1,
            1);

        internal static PlatformOperationDefinition HiddenContentConfigureItem { get; } = new PlatformOperationDefinition(
            PlatformOperationId.HiddenContentConfigureItem,
            PlatformOperationFamily.HiddenContent,
            PlatformAuthorityLevel.Authenticated,
            [PlatformActorKind.JellyfinUserClient],
            PlatformItemScope.ExactItem,
            [HostItemKind.Movie, HostItemKind.Series, HostItemKind.Episode],
            true,
            PlatformInputSchemaId.HiddenContentItemConfigurationV1,
            1);

        internal static PlatformOperationDefinition SeerrRequestItem { get; } = new PlatformOperationDefinition(
            PlatformOperationId.SeerrRequestItem,
            PlatformOperationFamily.Seerr,
            PlatformAuthorityLevel.Authenticated,
            [PlatformActorKind.JellyfinUserClient],
            PlatformItemScope.ExactItem,
            [HostItemKind.Movie, HostItemKind.Series],
            true,
            PlatformInputSchemaId.SeerrItemRequestV1,
            1);
    }

    /// <summary>
    /// The complete code-owned authority vocabulary for the three native pilot families.
    /// </summary>
    /// <remarks>
    /// This is deliberately not a registry. There is no manifest, request or service
    /// registration path: adding an operation is a reviewed source change. Callers may
    /// look up a known id, but an unknown or differently-cased id returns no definition.
    /// </remarks>
    public static class PlatformOperationVocabulary
    {
        /// <summary>Maximum UTF-16/ASCII length of an operation or input-schema identifier.</summary>
        public const int MaximumIdentifierLength = 128;

        private static readonly ImmutableArray<PlatformOperationDefinition> Definitions =
        [
            PlatformOperationDefinition.SpoilerGuardConfigureItem,
            PlatformOperationDefinition.HiddenContentConfigureItem,
            PlatformOperationDefinition.SeerrRequestItem,
        ];

        /// <summary>Gets the immutable complete pilot definition set.</summary>
        public static ImmutableArray<PlatformOperationDefinition> All => Definitions;

        /// <summary>
        /// Finds an exact known id. Invalid, unknown and case-variant values all fail
        /// closed rather than creating caller-owned operation authority.
        /// </summary>
        public static PlatformOperationDefinition? Find(string? operationId)
        {
            if (!IsValidIdentifier(operationId))
            {
                return null;
            }

            foreach (var definition in Definitions)
            {
                if (string.Equals(definition.Id.Value, operationId, StringComparison.Ordinal))
                {
                    return definition;
                }
            }

            return null;
        }

        internal static bool IsValidIdentifier(string? value)
        {
            if (value is null
                || value.Length is < 1 or > MaximumIdentifierLength
                || !IsLowerAsciiLetter(value[0]))
            {
                return false;
            }

            var dotCount = 0;
            for (var index = 0; index < value.Length; index++)
            {
                var character = value[index];
                if (IsLowerAsciiLetter(character) || IsAsciiDigit(character))
                {
                    continue;
                }

                if (character is not ('.' or '-')
                    || index == 0
                    || index == value.Length - 1
                    || !IsLowerAsciiLetterOrDigit(value[index - 1])
                    || !IsLowerAsciiLetterOrDigit(value[index + 1]))
                {
                    return false;
                }

                if (character == '.')
                {
                    dotCount++;
                }
            }

            // vendor.extension.name is the smallest ADR-0001 namespace shape.
            return dotCount >= 2;
        }

        private static bool IsLowerAsciiLetterOrDigit(char value) =>
            IsLowerAsciiLetter(value) || IsAsciiDigit(value);

        private static bool IsLowerAsciiLetter(char value) => value is >= 'a' and <= 'z';

        private static bool IsAsciiDigit(char value) => value is >= '0' and <= '9';
    }
}
