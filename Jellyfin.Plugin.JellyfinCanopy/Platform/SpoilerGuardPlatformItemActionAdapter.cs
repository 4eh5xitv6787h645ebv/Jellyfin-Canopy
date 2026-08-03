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

        /// <summary>Reads one exact accessible item's closed state and revision evidence.</summary>
        public SpoilerGuardItemState GetState(
            PlatformActor actor,
            HostAccessibleItem item)
        {
            var mapped = Map(actor, item);
            return _owner.GetState(mapped.Actor, mapped.Item);
        }

        /// <summary>Configures one exact accessible item with one owner invocation.</summary>
        public SpoilerGuardItemActionResult Configure(
            PlatformActor actor,
            HostAccessibleItem item,
            SpoilerGuardItemConfiguration configuration)
        {
            ArgumentNullException.ThrowIfNull(configuration);
            if (!configuration.ExpectedOverridesRevision.HasValue)
            {
                throw new ArgumentException(
                    "The Platform mutation requires an override-revision precondition.",
                    nameof(configuration));
            }

            var mapped = Map(actor, item);
            return _owner.Configure(mapped.Actor, mapped.Item, configuration);
        }

        private static (SpoilerGuardActorProjection Actor, SpoilerGuardItemProjection Item) Map(
            PlatformActor actor,
            HostAccessibleItem item)
        {
            ArgumentNullException.ThrowIfNull(actor);
            var kind = item.Kind switch
            {
                HostItemKind.Movie => SpoilerGuardItemKind.Movie,
                HostItemKind.Series => SpoilerGuardItemKind.Series,
                _ => throw new ArgumentOutOfRangeException(
                    nameof(item),
                    "The accessible item kind is not supported by Spoiler Guard."),
            };

            return (
                new SpoilerGuardActorProjection(actor.UserId),
                SpoilerGuardItemProjection.CurrentAccessible(
                    item.Id,
                    kind,
                    displayName: null));
        }
    }
}
