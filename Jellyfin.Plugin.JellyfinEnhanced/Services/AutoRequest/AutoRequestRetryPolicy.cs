using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.AutoRequest
{
    /// <summary>
    /// The single decision point the multi-URL Seerr request senders use to tell a pure
    /// transport failure (safe to try the next backend) apart from a server-committed
    /// response (stop — re-POSTing the same request to a second backend would create a
    /// duplicate on a distinct Seerr instance).
    /// </summary>
    internal static class AutoRequestRetryPolicy
    {
        /// <summary>
        /// True only when NO server-side commit could have happened — the send never
        /// reached a responding Seerr (transport failure), so advancing to the next
        /// configured URL is safe. Any real HTTP status back from Seerr (even an error)
        /// means the request may already have been committed, so we must NOT re-POST it.
        /// </summary>
        public static bool ShouldTryNextUrl(SeerrError error) =>
            error.HttpStatus == 0
            || error.Code is SeerrErrorCode.Unreachable or SeerrErrorCode.Timeout;

        /// <summary>
        /// Seerr returns 409 Conflict when the media is already requested — that is an
        /// idempotent success for our purposes (the request exists), not a reason to fan
        /// out to another backend.
        /// </summary>
        public static bool IsAlreadyRequested(SeerrError error) =>
            error.HttpStatus == 409;
    }
}
