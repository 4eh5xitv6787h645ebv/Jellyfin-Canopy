using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>The closed Platform v1 capability domains.</summary>
    public enum PlatformCapabilityDomain
    {
        /// <summary>Platform discovery and negotiation.</summary>
        Discovery = 1,

        /// <summary>Bounded Jellyfin item lookup.</summary>
        ItemLookup = 2,

        /// <summary>Current-user data access.</summary>
        UserData = 3,

        /// <summary>Bounded Platform event subscriptions.</summary>
        Events = 4,

        /// <summary>Kernel-owned namespaced state.</summary>
        Storage = 5,

        /// <summary>Declarative UI contributions.</summary>
        UiContributions = 6,

        /// <summary>Approved integration actions.</summary>
        IntegrationActions = 7,

        /// <summary>Elevated Platform administration.</summary>
        Administration = 8,

        /// <summary>Elevated redacted diagnostics.</summary>
        Diagnostics = 9,
    }

    /// <summary>A code-owned exact Platform v1 capability identifier.</summary>
    public readonly record struct PlatformCapabilityId
    {
        private PlatformCapabilityId(string value)
        {
            if (!PlatformCapabilityVocabulary.IsValidIdentifier(value))
            {
                throw new ArgumentException(
                    "Capability ids must use the exact bounded Platform v1 grammar.",
                    nameof(value));
            }

            Value = value;
        }

        /// <summary>Gets the stable, case-sensitive identifier.</summary>
        public string Value { get; }

        /// <inheritdoc />
        public override string ToString() => Value ?? string.Empty;

        internal static PlatformCapabilityId EstablishCodeOwnedId(string value) =>
            new PlatformCapabilityId(value);
    }

    /// <summary>Immutable authority metadata for one code-owned capability.</summary>
    public sealed class PlatformCapabilityDefinition
    {
        private PlatformCapabilityDefinition(
            PlatformCapabilityId id,
            PlatformCapabilityDomain domain,
            ImmutableArray<PlatformActorKind> allowedActorKinds,
            bool requiresElevation)
        {
            if (string.IsNullOrEmpty(id.Value))
            {
                throw new ArgumentException("A code-owned capability id is required.", nameof(id));
            }

            if (!Enum.IsDefined(domain))
            {
                throw new ArgumentOutOfRangeException(nameof(domain));
            }

            if (allowedActorKinds.IsDefaultOrEmpty
                || allowedActorKinds.Any(kind => !PlatformActorKindVocabulary.IsDefined(kind))
                || allowedActorKinds.Distinct().Count() != allowedActorKinds.Length)
            {
                throw new ArgumentException(
                    "A capability must declare distinct closed actor kinds.",
                    nameof(allowedActorKinds));
            }

            if (requiresElevation
                && (allowedActorKinds.Length != 1
                    || allowedActorKinds[0] != PlatformActorKind.JellyfinUserClient))
            {
                throw new ArgumentException(
                    "An elevated capability must admit only the Jellyfin user actor kind.",
                    nameof(requiresElevation));
            }

            if (domain is PlatformCapabilityDomain.Administration or PlatformCapabilityDomain.Diagnostics
                && !requiresElevation)
            {
                throw new ArgumentException(
                    "Administration and diagnostics capabilities must require current user elevation.",
                    nameof(requiresElevation));
            }

            Id = id;
            Domain = domain;
            AllowedActorKinds = allowedActorKinds;
            RequiresElevation = requiresElevation;
        }

        /// <summary>Gets the exact capability id.</summary>
        public PlatformCapabilityId Id { get; }

        /// <summary>Gets the closed capability domain.</summary>
        public PlatformCapabilityDomain Domain { get; }

        /// <summary>Gets the exact actor kinds eligible to exercise this capability.</summary>
        public ImmutableArray<PlatformActorKind> AllowedActorKinds { get; }

        /// <summary>Gets whether a current Jellyfin administrator is required.</summary>
        public bool RequiresElevation { get; }

        internal static PlatformCapabilityDefinition EstablishCodeOwnedDefinition(
            PlatformCapabilityId id,
            PlatformCapabilityDomain domain,
            ImmutableArray<PlatformActorKind> allowedActorKinds,
            bool requiresElevation) => new PlatformCapabilityDefinition(
                id,
                domain,
                allowedActorKinds,
                requiresElevation);
    }

    /// <summary>
    /// The single immutable Platform v1 capability owner. Vocabulary membership names
    /// authority; it does not activate a route, provider, event, state store or UI surface.
    /// </summary>
    public static class PlatformCapabilityVocabulary
    {
        /// <summary>The exact identifier segment count.</summary>
        public const int IdentifierSegmentCount = 4;

        /// <summary>The maximum ASCII identifier length.</summary>
        public const int MaximumIdentifierLength = 128;

        /// <summary>The maximum domain or action segment length.</summary>
        public const int MaximumVariableSegmentLength = 64;

        /// <summary>The exact current v1 vocabulary count and raw set bound.</summary>
        public const int MaximumCapabilityCount = 9;

        private static readonly ImmutableArray<PlatformCapabilityDefinition> Definitions =
        [
            Definition(
                "jellyfin.canopy.discovery.read",
                PlatformCapabilityDomain.Discovery,
                [PlatformActorKind.JellyfinUserClient]),
            Definition(
                "jellyfin.canopy.items.lookup",
                PlatformCapabilityDomain.ItemLookup,
                [PlatformActorKind.JellyfinUserClient, PlatformActorKind.InstalledProvider]),
            Definition(
                "jellyfin.canopy.user-data.read",
                PlatformCapabilityDomain.UserData,
                [PlatformActorKind.JellyfinUserClient, PlatformActorKind.InstalledProvider]),
            Definition(
                "jellyfin.canopy.events.subscribe",
                PlatformCapabilityDomain.Events,
                [PlatformActorKind.CompanionService]),
            Definition(
                "jellyfin.canopy.storage.read",
                PlatformCapabilityDomain.Storage,
                [PlatformActorKind.JellyfinUserClient, PlatformActorKind.InstalledProvider]),
            Definition(
                "jellyfin.canopy.ui.contribute",
                PlatformCapabilityDomain.UiContributions,
                [PlatformActorKind.InstalledProvider]),
            Definition(
                "jellyfin.canopy.integrations.invoke",
                PlatformCapabilityDomain.IntegrationActions,
                [PlatformActorKind.JellyfinUserClient, PlatformActorKind.InstalledProvider]),
            Definition(
                "jellyfin.canopy.administration.manage",
                PlatformCapabilityDomain.Administration,
                [PlatformActorKind.JellyfinUserClient],
                requiresElevation: true),
            Definition(
                "jellyfin.canopy.diagnostics.read",
                PlatformCapabilityDomain.Diagnostics,
                [PlatformActorKind.JellyfinUserClient],
                requiresElevation: true),
        ];

        /// <summary>Gets the complete vocabulary in append-only contract order.</summary>
        public static ImmutableArray<PlatformCapabilityDefinition> All => Definitions;

        /// <summary>Finds an exact known id or fails closed.</summary>
        public static PlatformCapabilityDefinition? Find(string? capabilityId)
        {
            if (!IsValidIdentifier(capabilityId))
            {
                return null;
            }

            foreach (var definition in Definitions)
            {
                if (string.Equals(definition.Id.Value, capabilityId, StringComparison.Ordinal))
                {
                    return definition;
                }
            }

            return null;
        }

        internal static bool IsValidIdentifier(string? value)
        {
            if (value is null
                || value.Length > MaximumIdentifierLength
                || !value.StartsWith("jellyfin.canopy.", StringComparison.Ordinal))
            {
                return false;
            }

            var segments = value.Split('.');
            if (segments.Length != IdentifierSegmentCount
                || !string.Equals(segments[0], "jellyfin", StringComparison.Ordinal)
                || !string.Equals(segments[1], "canopy", StringComparison.Ordinal)
                || segments[2].Length is < 1 or > MaximumVariableSegmentLength
                || segments[3].Length is < 1 or > MaximumVariableSegmentLength)
            {
                return false;
            }

            return IsValidVariableSegment(segments[2]) && IsValidVariableSegment(segments[3]);
        }

        internal static bool IsWithinInstalledProviderCeiling(string? capabilityId)
        {
            var definition = Find(capabilityId);
            return definition is not null
                && definition.AllowedActorKinds.Contains(PlatformActorKind.InstalledProvider)
                && !definition.RequiresElevation;
        }

        private static PlatformCapabilityDefinition Definition(
            string value,
            PlatformCapabilityDomain domain,
            ImmutableArray<PlatformActorKind> allowedActorKinds,
            bool requiresElevation = false) =>
            PlatformCapabilityDefinition.EstablishCodeOwnedDefinition(
                PlatformCapabilityId.EstablishCodeOwnedId(value),
                domain,
                allowedActorKinds,
                requiresElevation);

        private static bool IsValidVariableSegment(string value)
        {
            if (!IsLowerAsciiLetter(value[0]))
            {
                return false;
            }

            for (var index = 1; index < value.Length; index++)
            {
                var character = value[index];
                if (IsLowerAsciiLetter(character) || IsAsciiDigit(character))
                {
                    continue;
                }

                if (character != '-'
                    || !IsLowerAsciiLetterOrDigit(value[index - 1])
                    || index == value.Length - 1
                    || !IsLowerAsciiLetterOrDigit(value[index + 1]))
                {
                    return false;
                }
            }

            return true;
        }

        private static bool IsLowerAsciiLetterOrDigit(char value) =>
            IsLowerAsciiLetter(value) || IsAsciiDigit(value);

        private static bool IsLowerAsciiLetter(char value) => value is >= 'a' and <= 'z';

        private static bool IsAsciiDigit(char value) => value is >= '0' and <= '9';
    }

    /// <summary>An immutable, validated requested-capability set.</summary>
    public sealed class PlatformRequestedCapabilitySet
    {
        private static readonly PlatformRequestedCapabilitySet Invalid = new(false, []);
        private readonly ImmutableArray<PlatformCapabilityDefinition> _capabilities;

        private PlatformRequestedCapabilitySet(
            bool isValid,
            ImmutableArray<PlatformCapabilityDefinition> capabilities)
        {
            IsValid = isValid;
            _capabilities = capabilities;
        }

        internal bool IsValid { get; }

        internal ImmutableArray<PlatformCapabilityDefinition> Capabilities => _capabilities;

        internal static bool TryCreate(
            IReadOnlyList<string>? values,
            out PlatformRequestedCapabilitySet result)
        {
            if (!PlatformCapabilitySetResolver.TryResolve(values, out var capabilities))
            {
                result = Invalid;
                return false;
            }

            result = new PlatformRequestedCapabilitySet(true, capabilities);
            return true;
        }
    }

    /// <summary>An immutable, validated administrator-granted capability set.</summary>
    public sealed class PlatformGrantedCapabilitySet
    {
        private static readonly PlatformGrantedCapabilitySet Invalid = new(false, false, []);
        private readonly ImmutableArray<PlatformCapabilityDefinition> _capabilities;

        private PlatformGrantedCapabilitySet(
            bool isValid,
            bool isPresent,
            ImmutableArray<PlatformCapabilityDefinition> capabilities)
        {
            IsValid = isValid;
            IsPresent = isPresent;
            _capabilities = capabilities;
        }

        /// <summary>Gets the explicit absence of a persisted grant record.</summary>
        internal static PlatformGrantedCapabilitySet Missing { get; } = new(true, false, []);

        internal bool IsValid { get; }

        internal bool IsPresent { get; }

        internal ImmutableArray<PlatformCapabilityDefinition> Capabilities => _capabilities;

        internal static bool TryCreate(
            IReadOnlyList<string>? values,
            out PlatformGrantedCapabilitySet result)
        {
            if (!PlatformCapabilitySetResolver.TryResolve(values, out var capabilities))
            {
                result = Invalid;
                return false;
            }

            result = new PlatformGrantedCapabilitySet(true, true, capabilities);
            return true;
        }
    }

    file static class PlatformCapabilitySetResolver
    {
        internal static bool TryResolve(
            IReadOnlyList<string>? values,
            out ImmutableArray<PlatformCapabilityDefinition> capabilities)
        {
            capabilities = [];
            if (values is null)
            {
                return false;
            }

            var count = values.Count;
            if (count > PlatformCapabilityVocabulary.MaximumCapabilityCount)
            {
                return false;
            }

            var seen = new HashSet<string>(StringComparer.Ordinal);
            var requested = new HashSet<string>(StringComparer.Ordinal);
            for (var index = 0; index < count; index++)
            {
                var value = values[index];
                var definition = PlatformCapabilityVocabulary.Find(value);
                if (definition is null || !seen.Add(value))
                {
                    return false;
                }

                requested.Add(definition.Id.Value);
            }

            capabilities = PlatformCapabilityVocabulary.All
                .Where(definition => requested.Contains(definition.Id.Value))
                .ToImmutableArray();
            return true;
        }
    }

    /// <summary>The bounded outcome of one pure grant-ceiling evaluation.</summary>
    public enum PlatformGrantEvaluationStatus
    {
        /// <summary>The inputs formed a valid grant preview.</summary>
        Valid = 1,

        /// <summary>The requested set was absent or invalid.</summary>
        InvalidRequestedSet = 2,

        /// <summary>The grant set was invalid or granted an unrequested capability.</summary>
        InvalidGrantSet = 3,

        /// <summary>The actor authority projection was default or invalid.</summary>
        InvalidActorAuthority = 4,
    }

    /// <summary>A closed, redaction-safe reason for one preview decision.</summary>
    public enum PlatformGrantDecisionReason
    {
        /// <summary>The capability is requested, granted and within current authority.</summary>
        Allowed = 1,

        /// <summary>No current grant exists for the requested capability.</summary>
        MissingGrant = 2,

        /// <summary>The current actor kind cannot exercise the capability.</summary>
        ActorKindNotAllowed = 3,

        /// <summary>The current Jellyfin user is not elevated.</summary>
        ElevationRequired = 4,

        /// <summary>The grant contains at least one unrequested capability.</summary>
        InvalidGrantRecord = 5,
    }

    /// <summary>One immutable, vocabulary-owned capability preview decision.</summary>
    public readonly record struct PlatformCapabilityDecision
    {
        private PlatformCapabilityDecision(
            PlatformCapabilityDefinition capability,
            PlatformGrantDecisionReason reason)
        {
            ArgumentNullException.ThrowIfNull(capability);
            if (!Enum.IsDefined(reason))
            {
                throw new ArgumentOutOfRangeException(nameof(reason));
            }

            Capability = capability;
            Reason = reason;
        }

        /// <summary>Gets the code-owned capability definition.</summary>
        public PlatformCapabilityDefinition Capability { get; }

        /// <summary>Gets whether the current intersection allows the capability.</summary>
        public bool IsAllowed => Reason == PlatformGrantDecisionReason.Allowed;

        /// <summary>Gets the closed decision reason.</summary>
        public PlatformGrantDecisionReason Reason { get; }

        internal static PlatformCapabilityDecision EstablishDecision(
            PlatformCapabilityDefinition capability,
            PlatformGrantDecisionReason reason) =>
            new PlatformCapabilityDecision(capability, reason);
    }

    /// <summary>An immutable, bounded and non-authoritative effective-grant preview.</summary>
    public sealed class PlatformGrantPreview
    {
        private PlatformGrantPreview(
            PlatformGrantEvaluationStatus status,
            ImmutableArray<PlatformCapabilityDecision> decisions)
        {
            if (!Enum.IsDefined(status)
                || decisions.IsDefault
                || decisions.Length > PlatformCapabilityVocabulary.MaximumCapabilityCount)
            {
                throw new ArgumentException("The grant preview is invalid.", nameof(decisions));
            }

            Status = status;
            Decisions = decisions;
        }

        /// <summary>Gets the structural evaluation status.</summary>
        public PlatformGrantEvaluationStatus Status { get; }

        /// <summary>Gets the canonical decisions in frozen vocabulary order.</summary>
        public ImmutableArray<PlatformCapabilityDecision> Decisions { get; }

        internal static PlatformGrantPreview EstablishPreview(
            PlatformGrantEvaluationStatus status,
            ImmutableArray<PlatformCapabilityDecision> decisions) =>
            new PlatformGrantPreview(status, decisions);
    }

    /// <summary>Pure bounded evaluator for requested ∩ granted ∩ current actor authority.</summary>
    public static class PlatformGrantCeilingEvaluator
    {
        /// <summary>
        /// Computes a diagnostic preview. The returned value carries no reusable authority;
        /// every protected operation must evaluate current inputs again at admission/release.
        /// </summary>
        internal static PlatformGrantPreview Evaluate(
            PlatformRequestedCapabilitySet? requested,
            PlatformGrantedCapabilitySet? granted,
            PlatformActorAuthority authority)
        {
            if (requested is null || !requested.IsValid)
            {
                return Invalid(PlatformGrantEvaluationStatus.InvalidRequestedSet);
            }

            if (granted is null || !granted.IsValid)
            {
                return Invalid(PlatformGrantEvaluationStatus.InvalidGrantSet);
            }

            if (!authority.IsValid)
            {
                return Invalid(PlatformGrantEvaluationStatus.InvalidActorAuthority);
            }

            var requestedIds = requested.Capabilities
                .Select(definition => definition.Id.Value)
                .ToHashSet(StringComparer.Ordinal);
            var unrequestedGrant = granted.Capabilities.Any(definition => !requestedIds.Contains(definition.Id.Value));
            if (unrequestedGrant)
            {
                var union = requestedIds;
                union.UnionWith(granted.Capabilities.Select(definition => definition.Id.Value));
                return PlatformGrantPreview.EstablishPreview(
                    PlatformGrantEvaluationStatus.InvalidGrantSet,
                    PlatformCapabilityVocabulary.All
                        .Where(definition => union.Contains(definition.Id.Value))
                        .Select(definition => PlatformCapabilityDecision.EstablishDecision(
                            definition,
                            PlatformGrantDecisionReason.InvalidGrantRecord))
                        .ToImmutableArray());
            }

            var grantedIds = granted.Capabilities
                .Select(definition => definition.Id.Value)
                .ToHashSet(StringComparer.Ordinal);
            var decisions = requested.Capabilities
                .Select(definition => PlatformCapabilityDecision.EstablishDecision(
                    definition,
                    !granted.IsPresent || !grantedIds.Contains(definition.Id.Value)
                        ? PlatformGrantDecisionReason.MissingGrant
                        : DecisionFor(definition, authority)))
                .ToImmutableArray();

            return PlatformGrantPreview.EstablishPreview(PlatformGrantEvaluationStatus.Valid, decisions);
        }

        private static PlatformGrantPreview Invalid(PlatformGrantEvaluationStatus status) =>
            PlatformGrantPreview.EstablishPreview(status, []);

        private static PlatformGrantDecisionReason DecisionFor(
            PlatformCapabilityDefinition definition,
            PlatformActorAuthority authority)
        {
            if (!authority.IsValid || !definition.AllowedActorKinds.Contains(authority.Kind))
            {
                return PlatformGrantDecisionReason.ActorKindNotAllowed;
            }

            if (definition.RequiresElevation
                && (authority.Kind != PlatformActorKind.JellyfinUserClient || !authority.IsElevated))
            {
                return PlatformGrantDecisionReason.ElevationRequired;
            }

            return PlatformGrantDecisionReason.Allowed;
        }
    }
}
