using System;
using System.Globalization;

namespace Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr
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

            // The catch-all route captures the path without the query string, but the raw
            // passthrough forwards the caller's FULL query to TMDB. Split the query off so
            // path classification never depends on it, yet keep it to reject a
            // title-smuggling append_to_response below.
            var path = apiPath;
            string? query = null;
            var q = path.IndexOf('?');
            if (q >= 0)
            {
                query = path.Substring(q + 1);
                path = path.Substring(0, q);
            }

            // append_to_response=similar,recommendations (or any list-bearing append) rides
            // on an otherwise-allowed movie/tv detail and returns above-limit/adult title
            // lists that the raw passthrough cannot body-filter. The client never uses
            // append_to_response on this passthrough, so deny it wholesale (deny-by-default)
            // rather than maintain a fragile allow-list of "safe" appends. Classify is only
            // consulted once the gate is active, so admins / no-limit callers are unaffected.
            if (HasAppendToResponse(query))
            {
                return restricted;
            }

            var segments = path.Trim('/').Split('/', StringSplitOptions.RemoveEmptyEntries);
            if (segments.Length == 0)
            {
                return restricted;
            }

            // Defense-in-depth: reject any dot-segment (./..) or its percent-encoded form.
            // The host normalizes these away before the catch-all binds (verified: encoded
            // %2e%2e is decoded + collapsed too), so the classifier never sees them today.
            // But the outbound Uri DOES collapse dot-segments (genres/../movie/{id} ->
            // movie/{id}), so if a future host/middleware ever delivered a raw, un-normalized
            // path, a Neutral first segment (genres) could front a blocked title. Rejecting
            // up front keeps the gate correct without depending on the host.
            if (HasDotSegment(path, segments))
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
                // keyword / company search return no rating-gated title list.
                // person is deliberately excluded: raw TMDB /3/search/person returns
                // results[].known_for[] full title objects (name/overview/poster/adult),
                // and the raw passthrough cannot body-filter — so it must fall through
                // to Restricted rather than leak above-limit/adult titles.
                if (segments.Length >= 2
                    && (Eq(segments[1], "keyword") || Eq(segments[1], "company")))
                {
                    return neutral;
                }

                // multi / movie / tv / collection / person search enumerate titles.
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

        // True when the path carries a dot-segment (./..) or a percent-encoded dot
        // (%2e / %2E) that a raw-path host could deliver undecoded. No legitimate TMDB
        // resource segment is "." / ".." or contains a percent sign, so this never
        // rejects a real passthrough path.
        private static bool HasDotSegment(string path, string[] segments)
        {
            if (path.Contains("%2e", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            foreach (var segment in segments)
            {
                if (segment == "." || segment == "..")
                {
                    return true;
                }
            }

            return false;
        }

        // True when the query carries a non-empty append_to_response parameter. TMDB
        // percent-decodes query param NAMES before matching them, so the gate must decode
        // too: otherwise `append%5Fto_response` (%5F = '_') — or any percent-encoded spelling
        // — slips past a raw string compare here while TMDB still decodes it and enumerates
        // above-limit/adult titles. Uri.UnescapeDataString mirrors TMDB's decode (and never
        // throws on malformed input, preserving Classify's no-throw contract); the compare is
        // case-insensitive. append_to_response is TMDB v3's only response-appending mechanism
        // (no aliases), so decoding the name closes the whole hole. The value is only checked
        // for non-emptiness.
        private static bool HasAppendToResponse(string? query)
        {
            if (string.IsNullOrEmpty(query))
            {
                return false;
            }

            foreach (var pair in query.Split('&', StringSplitOptions.RemoveEmptyEntries))
            {
                var eq = pair.IndexOf('=');
                var rawName = eq >= 0 ? pair.Substring(0, eq) : pair;
                var name = Uri.UnescapeDataString(rawName);
                if (Eq(name, "append_to_response"))
                {
                    var value = eq >= 0 ? pair.Substring(eq + 1) : string.Empty;
                    if (!string.IsNullOrWhiteSpace(value))
                    {
                        return true;
                    }
                }
            }

            return false;
        }
    }
}
