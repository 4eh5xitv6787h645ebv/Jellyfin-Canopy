using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Extensions;

namespace Jellyfin.Plugin.JellyfinElevate.Helpers.Jellyseerr
{
    /// <summary>
    /// Pure port of the TAG branch (branch A) of Jellyfin core's
    /// <c>BaseItem.IsParentalAllowed</c> → <c>IsVisibleViaTags</c>, adapted for
    /// external TMDB titles. Companion to <see cref="ParentalRatingDecision"/>
    /// (which ports the rating branches B–E); together they retire the old
    /// "tag restrictions are unenforceable for Seerr results" limitation.
    ///
    /// Core semantics preserved exactly:
    ///   • BlockedTags always wins — one overlap hides the item even if an
    ///     allowed tag also matches.
    ///   • AllowedTags (when non-empty) is a strict allow-list: the item must
    ///     carry at least one allowed tag or it is hidden.
    ///   • Both lists empty → no gating.
    ///   • Matching is whole-token over values normalized with core's own
    ///     <c>String.GetCleanValue()</c> (lowercase, diacritics stripped,
    ///     punctuation → spaces, whitespace collapsed) — "Sci-Fi" == "sci fi".
    ///
    /// Adaptation for external titles (documented in docs/seerr): the item's
    /// "tags" are its TMDB <b>keywords ∪ genres</b>. Keywords are the parity
    /// signal — Jellyfin's TMDB metadata provider imports TMDB keywords as the
    /// item Tags that native tag-blocking matches — and genre names are a
    /// deliberate intent extension (an admin blocking "horror" means the genre
    /// too; over-blocking is the safe direction for a parental control).
    /// </summary>
    public static class ParentalTagDecision
    {
        /// <summary>
        /// Decides whether a title with the given normalized tag set is
        /// visible under the user's normalized blocked/allowed tag lists.
        /// All inputs must already be cleaned via <see cref="CleanTags"/> /
        /// <c>GetCleanValue()</c> — this method does set overlap only, exactly
        /// like core's <c>IsVisibleViaTags</c>.
        /// </summary>
        /// <param name="titleTags">The title's cleaned keyword∪genre set.</param>
        /// <param name="blockedTags">The user's cleaned BlockedTags.</param>
        /// <param name="allowedTags">The user's cleaned AllowedTags.</param>
        public static bool IsAllowed(
            IReadOnlyCollection<string> titleTags,
            IReadOnlyCollection<string> blockedTags,
            IReadOnlyCollection<string> allowedTags)
        {
            if (blockedTags.Count == 0 && allowedTags.Count == 0)
            {
                return true;
            }

            if (blockedTags.Count > 0 && titleTags.Any(blockedTags.Contains))
            {
                return false; // blocked wins, even over an allowed match
            }

            if (allowedTags.Count > 0 && !titleTags.Any(allowedTags.Contains))
            {
                return false; // allow-list active and nothing matched
            }

            return true;
        }

        /// <summary>
        /// Normalizes a raw tag list with core's <c>GetCleanValue()</c>,
        /// dropping entries that clean to empty. Used for BOTH sides of the
        /// comparison (user policy lists and title keyword/genre names) so the
        /// match rules cannot drift from native enforcement.
        /// </summary>
        public static HashSet<string> CleanTags(IEnumerable<string?>? raw)
        {
            var result = new HashSet<string>(StringComparer.Ordinal);
            if (raw == null)
            {
                return result;
            }

            foreach (var value in raw)
            {
                if (string.IsNullOrWhiteSpace(value))
                {
                    continue;
                }

                var cleaned = value.GetCleanValue();
                if (!string.IsNullOrEmpty(cleaned))
                {
                    result.Add(cleaned);
                }
            }

            return result;
        }
    }
}
