using System.Collections.Generic;
using Jellyfin.Data.Enums;

namespace Jellyfin.Plugin.JellyfinElevate.Helpers.Jellyseerr
{
    /// <summary>
    /// Pure, side-effect-free port of Jellyfin's parental-control decision
    /// (<c>MediaBrowser.Controller.Entities.BaseItem.IsParentalAllowed</c>),
    /// used to decide whether a Seerr/TMDB search or discovery result should be
    /// shown to a given Jellyfin user.
    ///
    /// It reproduces exactly the rating branches of the core gate:
    ///  - (B/C) no usable rating -> allowed unless the user blocks unrated items
    ///          of this type;
    ///  - (D)   the user has no rating limit -> allowed;
    ///  - (E)   otherwise the item's (score, subScore) must be &lt;= the user's
    ///          (maxScore, maxSubScore), compared lexicographically.
    ///
    /// The tag gate (branch A of the core method) is deliberately NOT implemented:
    /// Seerr results are external TMDB titles that are not in the Jellyfin library
    /// yet, so they carry no Jellyfin tags. Tag-based blocked/allowed restrictions
    /// therefore cannot be evaluated against them and are documented as
    /// unenforceable for Seerr results.
    /// </summary>
    public static class ParentalRatingDecision
    {
        /// <summary>
        /// Decides whether an item is allowed for a user under their parental limit.
        /// </summary>
        /// <param name="itemScore">
        /// The item's resolved parental score, or <c>null</c> when the item is
        /// unrated or its rating string could not be recognized. Mirrors the
        /// <c>null</c> return of <c>ILocalizationManager.GetRatingScore</c>.
        /// </param>
        /// <param name="itemSubScore">The item's sub-score; <c>null</c> is treated as 0.</param>
        /// <param name="unratedType">
        /// The <see cref="UnratedItem"/> bucket for this item (Movie for movies,
        /// Series for TV) — used only when the item has no usable rating.
        /// </param>
        /// <param name="maxScore">The user's MaxParentalRatingScore; <c>null</c> means no limit.</param>
        /// <param name="maxSubScore">
        /// The user's MaxParentalRatingSubScore; <c>null</c> means unbounded at the
        /// matching score level.
        /// </param>
        /// <param name="blockUnrated">The user's BlockUnratedItems set (may be empty/null).</param>
        /// <returns><c>true</c> when the item should be shown; <c>false</c> to hide it.</returns>
        public static bool IsAllowed(
            int? itemScore,
            int? itemSubScore,
            UnratedItem unratedType,
            int? maxScore,
            int? maxSubScore,
            IReadOnlyCollection<UnratedItem>? blockUnrated)
        {
            // (B/C) No usable rating -> allow unless the user blocks unrated items of this type.
            if (itemScore is null)
            {
                return blockUnrated is null || !blockUnrated.Contains(unratedType);
            }

            // (D) The user has no configured rating limit -> allow.
            if (maxScore is null)
            {
                return true;
            }

            // (E) Compare (score, subScore) lexicographically against the user's max.
            if (itemScore.Value != maxScore.Value)
            {
                return itemScore.Value < maxScore.Value;
            }

            return maxSubScore is null || (itemSubScore ?? 0) <= maxSubScore.Value;
        }
    }
}
