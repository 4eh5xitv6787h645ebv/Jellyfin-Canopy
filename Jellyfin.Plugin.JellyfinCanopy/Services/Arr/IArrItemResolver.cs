using System;
using Jellyfin.Plugin.JellyfinCanopy.Model.Arr;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Arr
{
    /// <summary>
    /// Resolves a Jellyfin library item id to the Sonarr/Radarr identifiers the Search feature
    /// needs (kind, provider ids, season/episode numbers). Implemented over the supported
    /// <c>ILibraryManager</c> surface — see <see cref="ArrItemResolver"/>.
    /// </summary>
    public interface IArrItemResolver
    {
        /// <summary>
        /// Resolves <paramref name="itemId"/>. Returns a record whose <see cref="ArrResolvedItem.Kind"/>
        /// is <see cref="ArrMediaKind.Unknown"/> when the item is missing or is not a
        /// movie/series/season/episode.
        /// </summary>
        ArrResolvedItem Resolve(Guid itemId);
    }
}
