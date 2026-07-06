using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.AutoRequest;
using Xunit;

namespace Jellyfin.Plugin.JellyfinEnhanced.Tests.Services
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
