using System;
using System.Linq;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Jellyfin.Plugin.JellyfinCanopy.Services;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>
    /// Maps the Platform kernel's authoritative actor and accessible-item projections
    /// to the shared Hidden Content owner. It cannot accept a raw item or user id.
    /// </summary>
    public sealed class HiddenContentPlatformItemActionAdapter
    {
        private readonly IHiddenContentItemActionOwner _owner;

        /// <summary>Initializes the Platform adapter.</summary>
        public HiddenContentPlatformItemActionAdapter(IHiddenContentItemActionOwner owner)
        {
            _owner = owner ?? throw new ArgumentNullException(nameof(owner));
        }

        /// <summary>Reads one exact accessible item's state with one owner invocation.</summary>
        public HiddenContentItemActionResult GetState(
            PlatformActor actor,
            HostAccessibleItem item,
            HiddenContentItemScope scope)
        {
            var mapped = Map(actor, item);
            return _owner.GetState(mapped.Actor, mapped.Item, scope);
        }

        /// <summary>Configures one exact accessible item with one owner invocation.</summary>
        public HiddenContentItemActionResult Configure(
            PlatformActor actor,
            HostAccessibleItem item,
            HiddenContentItemConfiguration configuration)
        {
            ArgumentNullException.ThrowIfNull(configuration);
            var mapped = Map(actor, item);
            return _owner.Configure(mapped.Actor, mapped.Item, configuration);
        }

        private static (HiddenContentActorProjection Actor, HiddenContentItemProjection Item) Map(
            PlatformActor actor,
            HostAccessibleItem item)
        {
            ArgumentNullException.ThrowIfNull(actor);
            var kind = item.Kind switch
            {
                HostItemKind.Movie => HiddenContentItemKind.Movie,
                HostItemKind.Series => HiddenContentItemKind.Series,
                HostItemKind.Episode => HiddenContentItemKind.Episode,
                _ => throw new ArgumentOutOfRangeException(nameof(item), "The accessible item kind is not supported by Hidden Content."),
            };
            var tmdbIds = item.ProviderReferences
                .Where(reference => string.Equals(reference.Provider, "tmdb", StringComparison.OrdinalIgnoreCase))
                .Select(reference => reference.Value)
                .Distinct(StringComparer.Ordinal)
                .Take(2)
                .ToArray();

            return (
                new HiddenContentActorProjection(actor.UserId),
                new HiddenContentItemProjection(
                    item.Id,
                    kind,
                    displayName: null,
                    tmdbIds.Length == 1 ? tmdbIds[0] : null,
                    item.SeriesId,
                    seriesName: null,
                    seasonNumber: null,
                    episodeNumber: null));
        }
    }
}
