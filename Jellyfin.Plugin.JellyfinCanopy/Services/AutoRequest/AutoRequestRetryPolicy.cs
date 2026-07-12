using Jellyfin.Plugin.JellyfinCanopy.Helpers.Jellyseerr;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.AutoRequest
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
        /// True only when NO server-side commit could have happened, so advancing to the next
        /// configured URL is safe. Two provable no-commit families qualify:
        /// <list type="bullet">
        /// <item>A pure transport failure — the send never reached a responding Seerr
        /// (HttpStatus 0, or the Unreachable/Timeout codes).</item>
        /// <item>A reverse-proxy / CDN intercept that fired BEFORE the request reached the Seerr
        /// API, so the POST was never delivered to the origin: a redirect to an auth challenge
        /// (<see cref="SeerrErrorCode.UpstreamRedirect"/>), a non-JSON error/login page served in
        /// place of the JSON API (<see cref="SeerrErrorCode.HtmlResponse"/>), or a Cloudflare 5xx
        /// where Cloudflare could not reach the origin (connection down/refused/unreachable/TLS/
        /// railgun/DNS).</item>
        /// </list>
        /// The genuinely-ambiguous "committed-but-read-failed" cases must NOT fail over, or the
        /// request could be double-POSTed to a second Seerr instance: any real HTTP status from
        /// the origin Seerr itself, plus Cloudflare 524 (origin timed out AFTER the connection was
        /// established → it may have received and committed the POST) and 520 (origin returned an
        /// unknown/empty response → it was reached and may have committed).
        /// </summary>
        public static bool ShouldTryNextUrl(SeerrError error) =>
            error.HttpStatus == 0
            || error.Code is SeerrErrorCode.Unreachable or SeerrErrorCode.Timeout
            || error.Code is SeerrErrorCode.UpstreamRedirect or SeerrErrorCode.HtmlResponse
            || (error.Code == SeerrErrorCode.Cloudflare5xx
                && error.HttpStatus != 520
                && error.HttpStatus != 524);

        /// <summary>
        /// Seerr returns 409 Conflict when the media is already requested — that is an
        /// idempotent success for our purposes (the request exists), not a reason to fan
        /// out to another backend.
        /// </summary>
        public static bool IsAlreadyRequested(SeerrError error) =>
            error.HttpStatus == 409;
    }
}
