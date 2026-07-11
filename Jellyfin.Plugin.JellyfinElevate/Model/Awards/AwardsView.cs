using System.Collections.Generic;

namespace Jellyfin.Plugin.JellyfinElevate.Model.Awards
{
    /// <summary>
    /// A mutually-consistent read of the awards index for one item: the index version, whether the
    /// index has never been built, and the item's awards — all taken from the same snapshot, so a
    /// concurrent rebuild can never make these three disagree (e.g. "empty" while carrying awards).
    /// </summary>
    public sealed record AwardsView(long Version, bool IsEmpty, IReadOnlyList<AwardEntry> Awards);
}
