using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Jellyseerr
{
    /// <summary>
    /// Filters a raw Seerr search/discovery JSON body so a Jellyfin user never
    /// sees titles their own parental-rating limit would block once requested.
    /// Applied server-side at the proxy boundary (never client-side, which would
    /// only hide DOM cards while still delivering the restricted titles to the
    /// browser). See <see cref="Helpers.Jellyseerr.ParentalRatingDecision"/>.
    /// </summary>
    public interface ISeerrParentalFilter
    {
        /// <summary>
        /// Returns <paramref name="json"/> with any result items the caller may not
        /// see removed, or the body unchanged when filtering does not apply (feature
        /// off, admin caller, caller has no rating limit, or the endpoint is not a
        /// media result list). Never throws — on any internal error the original
        /// body is returned.
        /// </summary>
        /// <param name="json">The raw JSON body Seerr returned for <paramref name="apiPath"/>.</param>
        /// <param name="apiPath">The upstream Seerr path (e.g. <c>/api/v1/search?query=...</c>).</param>
        /// <param name="caller">The resolved Jellyfin caller identity.</param>
        Task<string> FilterListBodyAsync(string json, string apiPath, JellyseerrCaller caller);
    }
}
