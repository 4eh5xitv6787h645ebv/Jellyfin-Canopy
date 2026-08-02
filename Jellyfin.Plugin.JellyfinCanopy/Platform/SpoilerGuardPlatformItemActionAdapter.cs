using System;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Jellyfin.Plugin.JellyfinCanopy.Services;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>
    /// Maps the Platform kernel's authoritative actor and accessible-item projections
    /// to the shared Spoiler Guard owner. It cannot accept a raw item or user id.
    /// </summary>
    public sealed class SpoilerGuardPlatformItemActionAdapter
    {
        private readonly ISpoilerGuardItemActionOwner _owner;

        /// <summary>Initializes the Platform adapter.</summary>
        public SpoilerGuardPlatformItemActionAdapter(ISpoilerGuardItemActionOwner owner)
        {
            _owner = owner ?? throw new ArgumentNullException(nameof(owner));
        }

        /// <summary>Configures one exact accessible item with one owner invocation.</summary>
        public SpoilerGuardItemActionResult Configure(
            PlatformActor actor,
            HostAccessibleItem item,
            SpoilerGuardItemConfiguration configuration)
        {
            ArgumentNullException.ThrowIfNull(actor);
            ArgumentNullException.ThrowIfNull(configuration);

            var kind = item.Kind switch
            {
                HostItemKind.Movie => SpoilerGuardItemKind.Movie,
                HostItemKind.Series => SpoilerGuardItemKind.Series,
                _ => throw new ArgumentOutOfRangeException(
                    nameof(item),
                    "The accessible item kind is not supported by Spoiler Guard."),
            };

            return _owner.Configure(
                new SpoilerGuardActorProjection(actor.UserId),
                SpoilerGuardItemProjection.CurrentAccessible(item.Id, kind, displayName: null),
                configuration);
        }
    }
}
