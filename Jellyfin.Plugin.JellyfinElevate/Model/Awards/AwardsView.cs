using System.Collections.Generic;

namespace Jellyfin.Plugin.JellyfinElevate.Model.Awards
{
    /// <summary>
    /// A mutually-consistent read of the awards index for one item: the index version, whether the
    /// index has never been built, whether the current snapshot came from a fully successful fetch,
    /// and the item's awards — all taken from the same snapshot, so a concurrent rebuild can never
    /// make these disagree (e.g. "empty" while carrying awards). <see cref="Complete"/> lets the
    /// client distinguish a genuine "no awards" (complete index) from "not fetched yet" (a partial
    /// index that may be missing this item's ceremony).
    /// </summary>
    public sealed record AwardsView(long Version, bool IsEmpty, bool Complete, IReadOnlyList<AwardEntry> Awards);
}
