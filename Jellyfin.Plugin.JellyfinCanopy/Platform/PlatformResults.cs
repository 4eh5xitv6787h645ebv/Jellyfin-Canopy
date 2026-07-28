using System;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>
    /// Builds Platform v1 error responses. The single place the envelope is constructed,
    /// so its shape and its status mapping cannot drift apart per call site.
    /// </summary>
    public static class PlatformResults
    {
        /// <summary>
        /// An error response for <paramref name="code"/>.
        ///
        /// The status and the retryability both come from the code rather than from
        /// arguments, so a call site cannot return <c>not_found</c> with a <c>500</c>, or
        /// disagree with another endpoint about whether the same code is worth retrying.
        /// Only the human-readable message is the caller's to choose.
        /// </summary>
        /// <param name="code">A code from <see cref="PlatformErrorCode"/>.</param>
        /// <param name="message">Human-readable, safe to display, and free of internals.</param>
        /// <param name="correlationId">The id for the current request.</param>
        /// <returns>A result carrying the envelope at the code's status.</returns>
        /// <exception cref="ArgumentOutOfRangeException">The code is not part of the enumerated set.</exception>
        public static ObjectResult Error(string code, string message, string correlationId)
        {
            // Resolve first: an invented code must fail loudly here rather than being
            // serialized onto the wire as if it were part of the protocol.
            var status = PlatformErrorCode.StatusFor(code);

            return new ObjectResult(new PlatformError
            {
                Error = true,
                Code = code,
                Message = message,
                Retryable = PlatformErrorCode.IsRetryable(code),
                CorrelationId = correlationId,
            })
            {
                StatusCode = status,
            };
        }
    }
}
