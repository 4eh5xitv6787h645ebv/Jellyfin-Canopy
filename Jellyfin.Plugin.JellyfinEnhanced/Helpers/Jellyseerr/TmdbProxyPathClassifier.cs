using System;
using System.Globalization;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr
{
    /// <summary>Gate decision for a raw-TMDB passthrough path.</summary>
    internal enum TmdbProxyGate
    {
        /// <summary>Rating-free metadata (genres, keyword/company/person search) — always allowed.</summary>
        Neutral,

        /// <summary>A movie/tv detail or sub-resource — allowed only when the parent title is within the caller's limit.</summary>
        DetailGate,

        /// <summary>Anything else — denied (403) for a rating-limited caller (deny-by-default).</summary>
        Restricted,
    }

    /// <summary>
    /// The classified decision plus, for <see cref="TmdbProxyGate.DetailGate"/>, the
    /// parent title to check.
    /// </summary>
    internal readonly record struct TmdbProxyDecision(TmdbProxyGate Gate, string MediaType, int TmdbId);

    /// <summary>
    /// Deny-by-default classification of a raw <c>/tmdb/{**apiPath}</c> passthrough
    /// path. Only an explicit allow-list is <see cref="TmdbProxyGate.Neutral"/>; bare
    /// movie/tv detail and their non-list sub-resources are parent-gated
    /// (<see cref="TmdbProxyGate.DetailGate"/>); everything else — including any
    /// future/unknown shape — is <see cref="TmdbProxyGate.Restricted"/>, so a new
    /// leaky endpoint added later is blocked-by-default rather than exposed-by-default.
    /// Pure and never throws.
    /// </summary>
    internal static class TmdbProxyPathClassifier
    {
        internal static TmdbProxyDecision Classify(string apiPath)
        {
            var restricted = new TmdbProxyDecision(TmdbProxyGate.Restricted, string.Empty, 0);
            var neutral = new TmdbProxyDecision(TmdbProxyGate.Neutral, string.Empty, 0);

            if (string.IsNullOrWhiteSpace(apiPath))
            {
                return restricted;
            }

            // The catch-all route captures the path without the query string, but strip
            // a trailing ?query defensively so classification never depends on it.
            var path = apiPath;
            var q = path.IndexOf('?');
            if (q >= 0)
            {
                path = path.Substring(0, q);
            }

            var segments = path.Trim('/').Split('/', StringSplitOptions.RemoveEmptyEntries);
            if (segments.Length == 0)
            {
                return restricted;
            }

            var head = segments[0];

            // Rating-free genre lists (client: /tmdb/genres/{movie,tv}).
            if (Eq(head, "genres") || Eq(head, "genre"))
            {
                return neutral;
            }

            if (Eq(head, "search"))
            {
                // keyword / company / person search return no rating-gated title list.
                if (segments.Length >= 2
                    && (Eq(segments[1], "keyword") || Eq(segments[1], "company") || Eq(segments[1], "person")))
                {
                    return neutral;
                }

                // multi / movie / tv / collection search enumerate titles.
                return restricted;
            }

            // Movie/TV detail and sub-resources.
            if (Eq(head, "movie") || Eq(head, "tv"))
            {
                if (segments.Length < 2
                    || !int.TryParse(segments[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out var tmdbId)
                    || tmdbId <= 0)
                {
                    return restricted; // cannot identify the parent title -> deny
                }

                var mediaType = Eq(head, "tv") ? "tv" : "movie";

                // Bare /tmdb/{movie|tv}/{id}.
                if (segments.Length == 2)
                {
                    return new TmdbProxyDecision(TmdbProxyGate.DetailGate, mediaType, tmdbId);
                }

                // Sub-resources: similar/recommendations enumerate OTHER titles that may
                // exceed the limit even when the parent is allowed — deny those. Every
                // other sub-resource (watch/providers, reviews, season/{n}, videos, …) is
                // gated on the parent title: a blocked title exposes none of its parts,
                // an allowed one's own parts pass.
                if (Eq(segments[2], "similar") || Eq(segments[2], "recommendations"))
                {
                    return restricted;
                }

                return new TmdbProxyDecision(TmdbProxyGate.DetailGate, mediaType, tmdbId);
            }

            // discover / trending / person / collection / configuration / unknown.
            return restricted;
        }

        private static bool Eq(string value, string literal)
            => string.Equals(value, literal, StringComparison.OrdinalIgnoreCase);
    }
}
