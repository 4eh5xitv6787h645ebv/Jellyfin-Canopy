using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Jellyseerr
{
    /// <summary>Outcome of applying the parental filter to a proxied Seerr response.</summary>
    /// <param name="Block">
    /// True when the whole response must be denied (a restricted caller reaching a
    /// blocked title's detail/season body). The controller returns a bare 403.
    /// </param>
    /// <param name="Body">The body to return when <see cref="Block"/> is false (filtered list, or the original body).</param>
    public readonly record struct SeerrParentalResult(bool Block, string Body);

    /// <summary>
    /// Enforces each Jellyfin user's own parental-rating restriction across the
    /// Seerr integration, server-side. It covers three surfaces so a restricted
    /// account cannot see, open, or request a title above its limit:
    ///  - result LISTS (search/discovery/similar/recommendations/watchlist/
    ///    collection/person-credits/requests) have blocked items removed;
    ///  - DETAIL bodies (movie/tv/season) are denied outright (403);
    ///  - a request POST for a blocked title is rejected before it reaches Seerr.
    /// Filtering is server-side (never client-only, which would still deliver the
    /// titles). See <see cref="Helpers.Jellyseerr.ParentalRatingDecision"/>.
    /// </summary>
    public interface ISeerrParentalFilter
    {
        /// <summary>
        /// Applies the filter to a proxied response body. Returns the body unchanged
        /// when filtering does not apply (feature off, admin caller, caller has no
        /// limit, or the endpoint is not gated), a filtered body for list endpoints,
        /// or <c>Block=true</c> when a restricted caller requested a blocked
        /// detail/season body. Never throws.
        /// </summary>
        Task<SeerrParentalResult> ApplyAsync(string json, string apiPath, JellyseerrCaller caller);

        /// <summary>
        /// True when <paramref name="caller"/> must be blocked from the given title
        /// (used to gate request POSTs before they reach Seerr). Returns false when
        /// filtering does not apply; fails closed (true) when a restricted caller's
        /// title cannot be verified. Never throws.
        /// </summary>
        Task<bool> IsBlockedAsync(string mediaType, int tmdbId, JellyseerrCaller caller);

        /// <summary>
        /// True when the raw-TMDB passthrough (<c>/tmdb/{**apiPath}</c>) must deny
        /// (403) this path for the caller: a blocked movie/tv detail or sub-resource
        /// title, or any non-allow-listed metadata shape (deny-by-default). False for
        /// neutral paths, admins, no-limit callers, or the feature/Seerr being off.
        /// Never throws.
        /// </summary>
        Task<bool> IsTmdbProxyPathBlockedAsync(string tmdbApiPath, JellyseerrCaller caller);
    }
}
