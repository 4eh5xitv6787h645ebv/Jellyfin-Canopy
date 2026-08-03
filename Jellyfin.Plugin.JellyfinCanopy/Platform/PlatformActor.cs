using System;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>
    /// The immutable first-party identity and attribution carried below the Platform
    /// controller boundary.
    /// </summary>
    /// <remarks>
    /// This is deliberately a data-only allow-list. In particular it cannot carry the
    /// request principal (which contains the bearer token), an HTTP context, or any
    /// caller-selected target identity. <see cref="ClientName"/> and
    /// <see cref="DeviceId"/> are audit attribution only and must never participate in
    /// an authorization decision.
    /// </remarks>
    public sealed class PlatformActor
    {
        internal PlatformActor(PlatformUserBoundaryResult boundaryResult)
        {
            ArgumentNullException.ThrowIfNull(boundaryResult);
            UserId = boundaryResult.UserId;
            IsElevated = boundaryResult.IsElevated;
            CorrelationId = boundaryResult.CorrelationId;
            ClientName = boundaryResult.ClientName;
            DeviceId = boundaryResult.DeviceId;
        }

        /// <summary>Gets the actor kind.</summary>
        public PlatformActorKind Kind => PlatformActorKind.JellyfinUserClient;

        /// <summary>The authoritative authenticated Jellyfin user.</summary>
        public Guid UserId { get; }

        /// <summary>The current host elevation result for <see cref="UserId"/>.</summary>
        public bool IsElevated { get; }

        /// <summary>The host-generated identifier joining this action to its audit record.</summary>
        public string CorrelationId { get; }

        /// <summary>Bounded caller-reported client name. Attribution only.</summary>
        public string? ClientName { get; }

        /// <summary>Bounded caller-reported device identifier. Attribution only.</summary>
        public string? DeviceId { get; }

        internal PlatformActorAuthority Authority =>
            PlatformActorAuthority.ProjectAuthenticatedUserAuthority(IsElevated);
    }
}
