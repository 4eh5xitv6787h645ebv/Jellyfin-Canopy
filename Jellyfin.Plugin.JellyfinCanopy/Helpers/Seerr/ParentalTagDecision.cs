using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Extensions;

namespace Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr
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
    /// Adaptation for external titles (documented in docs/seerr) — the two
    /// directions deliberately use DIFFERENT match surfaces because their
    /// safe-failure directions are opposite:
    ///   • <b>BlockedTags</b> match the title's keywords ∪ genre names.
    ///     Keywords are the parity signal (Jellyfin's TMDB provider imports
    ///     TMDB keywords as the item Tags native blocking matches); genre
    ///     names are an intent extension (blocking "horror" means the genre
    ///     too) — over-blocking is safe here.
    ///   • <b>AllowedTags</b> match <b>keywords ONLY</b> — native parity.
    ///     Genres never become item Tags, so letting a genre satisfy the
    ///     allow-list would show a restricted user titles the library itself
    ///     would hide (under-blocking, the unsafe direction).
    /// </summary>
    public static class ParentalTagDecision
    {
        /// <summary>
        /// Decides whether a title with the given normalized keyword/genre
        /// sets is visible under the user's normalized blocked/allowed tag
        /// lists. All inputs must already be cleaned via
        /// <see cref="CleanTags"/> / <c>GetCleanValue()</c> — this method does
        /// set overlap only, mirroring core's <c>IsVisibleViaTags</c>.
        /// </summary>
        /// <param name="titleKeywords">The title's cleaned TMDB keyword names.</param>
        /// <param name="titleGenres">The title's cleaned TMDB genre names.</param>
        /// <param name="blockedTags">The user's cleaned BlockedTags.</param>
        /// <param name="allowedTags">The user's cleaned AllowedTags.</param>
        public static bool IsAllowed(
            IReadOnlyCollection<string> titleKeywords,
            IReadOnlyCollection<string> titleGenres,
            IReadOnlyCollection<string> blockedTags,
            IReadOnlyCollection<string> allowedTags)
        {
            if (blockedTags.Count == 0 && allowedTags.Count == 0)
            {
                return true;
            }

            if (blockedTags.Count > 0
                && (titleKeywords.Any(blockedTags.Contains) || titleGenres.Any(blockedTags.Contains)))
            {
                return false; // blocked wins, even over an allowed match
            }

            // Allow-list: keywords ONLY — genre matches must not satisfy it
            // (native parity; see the class doc).
            if (allowedTags.Count > 0 && !titleKeywords.Any(allowedTags.Contains))
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
