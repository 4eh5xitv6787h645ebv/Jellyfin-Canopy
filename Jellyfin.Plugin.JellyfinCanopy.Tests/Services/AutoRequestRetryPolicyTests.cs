using Jellyfin.Plugin.JellyfinCanopy.Helpers.Jellyseerr;
using Jellyfin.Plugin.JellyfinCanopy.Services.AutoRequest;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services
{
    /// <summary>
    /// ARR-6: the multi-URL Seerr request senders must fan out to the next backend ONLY on a
    /// pure transport failure (no server-side commit possible). A server that responded — even
    /// with an error — may already have committed the request, so re-POSTing it elsewhere would
    /// duplicate it on a distinct Seerr instance. 409 = already requested = idempotent success.
    /// </summary>
    public class AutoRequestRetryPolicyTests
    {
        [Theory]
        [InlineData(0, SeerrErrorCode.UpstreamError, true)]   // no HTTP status → pure transport failure
        [InlineData(0, SeerrErrorCode.Unreachable, true)]     // never reached Seerr
        [InlineData(0, SeerrErrorCode.Timeout, true)]         // timed out before a response
        [InlineData(504, SeerrErrorCode.Timeout, true)]       // timeout code retries even with a status
        [InlineData(500, SeerrErrorCode.UpstreamError, false)] // server responded → may have committed
        [InlineData(400, SeerrErrorCode.UpstreamError, false)]
        [InlineData(403, SeerrErrorCode.Forbidden, false)]
        [InlineData(409, SeerrErrorCode.UpstreamError, false)] // committed (duplicate) → don't re-POST
        // ARR-CS-1: proxy/CDN intercepts that fire BEFORE the POST reaches the Seerr API are
        // provable no-commit — fail over to the next URL instead of aborting the loop.
        [InlineData(302, SeerrErrorCode.UpstreamRedirect, true)] // proxy auth-challenge redirect
        [InlineData(200, SeerrErrorCode.HtmlResponse, true)]     // proxy served an HTML login/error page
        [InlineData(521, SeerrErrorCode.Cloudflare5xx, true)]    // origin down (no TCP connection)
        [InlineData(522, SeerrErrorCode.Cloudflare5xx, true)]    // connection to origin timed out
        [InlineData(523, SeerrErrorCode.Cloudflare5xx, true)]    // origin unreachable
        [InlineData(525, SeerrErrorCode.Cloudflare5xx, true)]    // origin TLS handshake failed
        [InlineData(526, SeerrErrorCode.Cloudflare5xx, true)]    // origin invalid TLS certificate
        [InlineData(527, SeerrErrorCode.Cloudflare5xx, true)]    // railgun connection error
        [InlineData(530, SeerrErrorCode.Cloudflare5xx, true)]    // origin DNS/other, no connection
        // ...but the ambiguous "origin was reached, response unreadable" Cloudflare cases must NOT
        // fail over — the origin may already have committed the POST.
        [InlineData(524, SeerrErrorCode.Cloudflare5xx, false)]   // timeout AFTER connecting to origin
        [InlineData(520, SeerrErrorCode.Cloudflare5xx, false)]   // origin returned an unknown/empty response
        public void ShouldTryNextUrl_OnlyForTransportFailures(int httpStatus, SeerrErrorCode code, bool expected)
        {
            var error = new SeerrError { HttpStatus = httpStatus, Code = code };
            Assert.Equal(expected, AutoRequestRetryPolicy.ShouldTryNextUrl(error));
        }

        [Theory]
        [InlineData(409, true)]
        [InlineData(500, false)]
        [InlineData(200, false)]
        [InlineData(0, false)]
        public void IsAlreadyRequested_OnlyFor409(int httpStatus, bool expected)
        {
            var error = new SeerrError { HttpStatus = httpStatus };
            Assert.Equal(expected, AutoRequestRetryPolicy.IsAlreadyRequested(error));
        }
    }
}
