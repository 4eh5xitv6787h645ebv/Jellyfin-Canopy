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
        internal PlatformActor(
            Guid userId,
            bool isElevated,
            string correlationId,
            string? clientName,
            string? deviceId)
        {
            if (userId == Guid.Empty)
            {
                throw new ArgumentException("An actor must have a non-empty user id.", nameof(userId));
            }

            ArgumentException.ThrowIfNullOrWhiteSpace(correlationId);

            UserId = userId;
            IsElevated = isElevated;
            CorrelationId = correlationId;
            ClientName = clientName;
            DeviceId = deviceId;
        }

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
    }
}
