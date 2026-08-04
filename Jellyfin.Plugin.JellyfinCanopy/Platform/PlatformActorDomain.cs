using System;
using System.Collections.Immutable;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>The exact closed kinds of authoritative Platform actors.</summary>
    public enum PlatformActorKind
    {
        /// <summary>An authenticated Jellyfin user client.</summary>
        JellyfinUserClient = 1,

        /// <summary>An installed provider approved by the future registry owner.</summary>
        InstalledProvider = 2,

        /// <summary>A companion service bound to a current credential generation.</summary>
        CompanionService = 3,
    }

    /// <summary>Code-owned stable contract tokens for the closed actor-kind domain.</summary>
    public static class PlatformActorKindVocabulary
    {
        private static readonly ImmutableArray<PlatformActorKind> Kinds =
        [
            PlatformActorKind.JellyfinUserClient,
            PlatformActorKind.InstalledProvider,
            PlatformActorKind.CompanionService,
        ];

        /// <summary>Gets the complete actor-kind vocabulary in stable contract order.</summary>
        public static ImmutableArray<PlatformActorKind> All => Kinds;

        /// <summary>Returns the exact v1 token for a known kind, or <c>null</c>.</summary>
        public static string? TokenFor(PlatformActorKind kind) => kind switch
        {
            PlatformActorKind.JellyfinUserClient => "jellyfin-user-client",
            PlatformActorKind.InstalledProvider => "installed-provider",
            PlatformActorKind.CompanionService => "companion-service",
            _ => null,
        };

        internal static bool IsDefined(PlatformActorKind kind) => TokenFor(kind) is not null;
    }

    /// <summary>
    /// The immutable current-authority projection consumed by Platform policy and the
    /// future grant-ceiling evaluator. It carries no identity, request, token, grant,
    /// capability or attribution data.
    /// </summary>
    public readonly struct PlatformActorAuthority
    {
        private readonly bool _initialized;

        private PlatformActorAuthority(PlatformActorKind kind, bool isElevated)
        {
            if (!PlatformActorKindVocabulary.IsDefined(kind))
            {
                throw new ArgumentOutOfRangeException(nameof(kind));
            }

            if (isElevated && kind != PlatformActorKind.JellyfinUserClient)
            {
                throw new ArgumentException(
                    "Only a current Jellyfin user actor can be elevated.",
                    nameof(isElevated));
            }

            Kind = kind;
            IsElevated = isElevated;
            _initialized = true;
        }

        /// <summary>Gets the closed actor kind.</summary>
        public PlatformActorKind Kind { get; }

        /// <summary>Gets current host elevation for a Jellyfin user actor.</summary>
        public bool IsElevated { get; }

        internal bool IsValid => _initialized
            && PlatformActorKindVocabulary.IsDefined(Kind)
            && (!IsElevated || Kind == PlatformActorKind.JellyfinUserClient);

        internal static PlatformActorAuthority ProjectAuthenticatedUserAuthority(bool isElevated) =>
            new(PlatformActorKind.JellyfinUserClient, isElevated);

        internal static PlatformActorAuthority ProjectInstalledProviderAuthority() =>
            new(PlatformActorKind.InstalledProvider, false);

        internal static PlatformActorAuthority ProjectCompanionServiceAuthority() =>
            new(PlatformActorKind.CompanionService, false);
    }

    /// <summary>
    /// Opaque proof that the controller boundary completed canonical authenticated-user,
    /// same-identity non-API-key and live-host validation.
    /// </summary>
    internal sealed class PlatformUserBoundaryResult
    {
        private PlatformUserBoundaryResult(
            Guid userId,
            bool isElevated,
            string correlationId,
            string? clientName,
            string? deviceId)
        {
            if (userId == Guid.Empty)
            {
                throw new ArgumentException("A boundary result requires a live user.", nameof(userId));
            }

            ArgumentException.ThrowIfNullOrWhiteSpace(correlationId);
            UserId = userId;
            IsElevated = isElevated;
            CorrelationId = correlationId;
            ClientName = clientName;
            DeviceId = deviceId;
        }

        internal Guid UserId { get; }

        internal bool IsElevated { get; }

        internal string CorrelationId { get; }

        internal string? ClientName { get; }

        internal string? DeviceId { get; }

        internal static PlatformUserBoundaryResult EstablishAuthenticatedUserBoundary(
            HostUser currentUser,
            string correlationId,
            string? clientName,
            string? deviceId) =>
            new(
                currentUser.Id,
                currentUser.IsAdministrator,
                correlationId,
                clientName,
                deviceId);

        internal static PlatformUserBoundaryResult EstablishReauthorizedUserBoundary(
            PlatformActor boundaryActor,
            HostUser currentUser)
        {
            ArgumentNullException.ThrowIfNull(boundaryActor);
            if (currentUser.Id == Guid.Empty || currentUser.Id != boundaryActor.UserId)
            {
                throw new ArgumentException(
                    "A reauthorization result must preserve the boundary identity.",
                    nameof(currentUser));
            }

            return new(
                currentUser.Id,
                currentUser.IsAdministrator,
                boundaryActor.CorrelationId,
                boundaryActor.ClientName,
                boundaryActor.DeviceId);
        }
    }

    /// <summary>A typed installed-plugin identifier released only by a registry owner.</summary>
    internal readonly struct PlatformInstalledPluginId
    {
        private PlatformInstalledPluginId(Guid value)
        {
            if (value == Guid.Empty)
            {
                throw new ArgumentException("An installed plugin id cannot be empty.", nameof(value));
            }

            Value = value;
        }

        internal Guid Value { get; }

        internal static PlatformInstalledPluginId EstablishCurrentRegistryId(Guid value) => new(value);
    }

    /// <summary>An immutable canonical SHA-256 manifest fingerprint.</summary>
    internal readonly struct PlatformManifestFingerprint
    {
        private PlatformManifestFingerprint(string value)
        {
            ArgumentNullException.ThrowIfNull(value);
            if (value.Length != 64 || !IsLowerHex(value))
            {
                throw new ArgumentException(
                    "A manifest fingerprint must be exactly 64 lower-case hexadecimal characters.",
                    nameof(value));
            }

            Value = value;
        }

        internal string Value { get; }

        internal static PlatformManifestFingerprint EstablishValidatedManifestFingerprint(string value) =>
            new(value);

        private static bool IsLowerHex(string value)
        {
            foreach (var character in value)
            {
                if (character is not (>= '0' and <= '9') and not (>= 'a' and <= 'f'))
                {
                    return false;
                }
            }

            return true;
        }
    }

    /// <summary>The positive current generation of an installed provider.</summary>
    internal readonly struct PlatformProviderGeneration
    {
        private PlatformProviderGeneration(long value)
        {
            if (value <= 0)
            {
                throw new ArgumentOutOfRangeException(nameof(value));
            }

            Value = value;
        }

        internal long Value { get; }

        internal static PlatformProviderGeneration EstablishCurrentRegistryGeneration(long value) => new(value);
    }

    /// <summary>Opaque registry approval proof for one installed provider.</summary>
    internal sealed class PlatformApprovedProviderIdentity
    {
        private PlatformApprovedProviderIdentity(
            PlatformInstalledPluginId installedPluginId,
            PlatformManifestFingerprint manifestFingerprint,
            PlatformProviderGeneration providerGeneration)
        {
            if (installedPluginId.Value == Guid.Empty)
            {
                throw new ArgumentException("A provider approval requires an installed plugin.", nameof(installedPluginId));
            }

            if (string.IsNullOrEmpty(manifestFingerprint.Value))
            {
                throw new ArgumentException("A provider approval requires a manifest fingerprint.", nameof(manifestFingerprint));
            }

            if (providerGeneration.Value <= 0)
            {
                throw new ArgumentOutOfRangeException(nameof(providerGeneration));
            }

            InstalledPluginId = installedPluginId;
            ManifestFingerprint = manifestFingerprint;
            ProviderGeneration = providerGeneration;
        }

        internal PlatformInstalledPluginId InstalledPluginId { get; }

        internal PlatformManifestFingerprint ManifestFingerprint { get; }

        internal PlatformProviderGeneration ProviderGeneration { get; }

        internal static PlatformApprovedProviderIdentity EstablishCurrentRegistryApproval(
            Guid installedPluginId,
            string manifestFingerprint,
            long providerGeneration) =>
            new(
                PlatformInstalledPluginId.EstablishCurrentRegistryId(installedPluginId),
                PlatformManifestFingerprint.EstablishValidatedManifestFingerprint(manifestFingerprint),
                PlatformProviderGeneration.EstablishCurrentRegistryGeneration(providerGeneration));
    }

    /// <summary>A typed companion-service registration identifier.</summary>
    internal readonly struct PlatformServiceRegistrationId
    {
        private PlatformServiceRegistrationId(Guid value)
        {
            if (value == Guid.Empty)
            {
                throw new ArgumentException("A service registration id cannot be empty.", nameof(value));
            }

            Value = value;
        }

        internal Guid Value { get; }
    }

    /// <summary>The positive current generation of a service credential.</summary>
    internal readonly struct PlatformCredentialGeneration
    {
        private PlatformCredentialGeneration(long value)
        {
            if (value <= 0)
            {
                throw new ArgumentOutOfRangeException(nameof(value));
            }

            Value = value;
        }

        internal long Value { get; }
    }

    /// <summary>Opaque registration and current-generation proof for a companion service.</summary>
    internal sealed class PlatformCurrentServiceIdentity
    {
        private PlatformCurrentServiceIdentity(
            PlatformServiceRegistrationId registrationId,
            PlatformCredentialGeneration credentialGeneration)
        {
            if (registrationId.Value == Guid.Empty)
            {
                throw new ArgumentException("A current service identity requires a registration.", nameof(registrationId));
            }

            if (credentialGeneration.Value <= 0)
            {
                throw new ArgumentOutOfRangeException(nameof(credentialGeneration));
            }

            RegistrationId = registrationId;
            CredentialGeneration = credentialGeneration;
        }

        internal PlatformServiceRegistrationId RegistrationId { get; }

        internal PlatformCredentialGeneration CredentialGeneration { get; }
    }

    /// <summary>An immutable registry-approved installed-provider actor.</summary>
    public sealed class PlatformInstalledProviderActor
    {
        internal PlatformInstalledProviderActor(PlatformApprovedProviderIdentity identity)
        {
            ArgumentNullException.ThrowIfNull(identity);
            InstalledPluginId = identity.InstalledPluginId.Value;
            ManifestFingerprint = identity.ManifestFingerprint.Value;
            ProviderGeneration = identity.ProviderGeneration.Value;
        }

        /// <summary>Gets the actor kind.</summary>
        public PlatformActorKind Kind => PlatformActorKind.InstalledProvider;

        /// <summary>Gets the registry-approved installed plugin identifier.</summary>
        public Guid InstalledPluginId { get; }

        /// <summary>Gets the immutable approved manifest fingerprint.</summary>
        public string ManifestFingerprint { get; }

        /// <summary>Gets the registry generation that must be rechecked at invocation.</summary>
        public long ProviderGeneration { get; }

        internal PlatformActorAuthority Authority => PlatformActorAuthority.ProjectInstalledProviderAuthority();
    }

    /// <summary>An immutable registered companion-service actor.</summary>
    public sealed class PlatformCompanionServiceActor
    {
        internal PlatformCompanionServiceActor(PlatformCurrentServiceIdentity identity)
        {
            ArgumentNullException.ThrowIfNull(identity);
            RegistrationId = identity.RegistrationId.Value;
            CredentialGeneration = identity.CredentialGeneration.Value;
        }

        /// <summary>Gets the actor kind.</summary>
        public PlatformActorKind Kind => PlatformActorKind.CompanionService;

        /// <summary>Gets the server-owned service registration identifier.</summary>
        public Guid RegistrationId { get; }

        /// <summary>Gets the verified current credential generation, never the credential.</summary>
        public long CredentialGeneration { get; }

        internal PlatformActorAuthority Authority => PlatformActorAuthority.ProjectCompanionServiceAuthority();
    }

    /// <summary>The single kernel owner that converts typed proofs into actor objects.</summary>
    internal static class PlatformActorFactory
    {
        internal static PlatformActor CreateAuthenticatedUserActor(PlatformUserBoundaryResult boundaryResult)
        {
            ArgumentNullException.ThrowIfNull(boundaryResult);
            return new PlatformActor(boundaryResult);
        }

        internal static PlatformInstalledProviderActor CreateProvider(
            PlatformApprovedProviderIdentity approvedIdentity)
        {
            ArgumentNullException.ThrowIfNull(approvedIdentity);
            return new PlatformInstalledProviderActor(approvedIdentity);
        }

        internal static PlatformCompanionServiceActor CreateService(
            PlatformCurrentServiceIdentity currentIdentity)
        {
            ArgumentNullException.ThrowIfNull(currentIdentity);
            return new PlatformCompanionServiceActor(currentIdentity);
        }

    }
}
