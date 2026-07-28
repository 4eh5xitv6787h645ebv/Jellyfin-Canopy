using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>
    /// The enumerated set of machine-readable Platform v1 error codes.
    ///
    /// These are codes, not messages. A consumer branches on <see cref="PlatformError.Code"/>
    /// and shows <see cref="PlatformError.Message"/>; the message may be reworded or
    /// translated at any time, the code may not. Free-form code strings are what the
    /// legacy surface does, and they are exactly what makes its failures
    /// indistinguishable from one another.
    ///
    /// Adding a code is a protocol change: a consumer written against v1 has to be able
    /// to treat an unfamiliar code as a generic failure of its HTTP status class, which
    /// is why every code below maps to exactly one status.
    /// </summary>
    public static class PlatformErrorCode
    {
        /// <summary>The request was malformed, missing something required, or self-contradictory.</summary>
        public const string InvalidRequest = "invalid_request";

        /// <summary>No protocol version is common to the client and this host. See the negotiate endpoint.</summary>
        public const string UnsupportedProtocol = "unsupported_protocol";

        /// <summary>The addressed thing does not exist, or the caller may not know whether it exists.</summary>
        public const string NotFound = "not_found";

        /// <summary>The request was valid but conflicts with current state, typically a lost update.</summary>
        public const string Conflict = "conflict";

        /// <summary>The request body or a collection within it exceeded a kernel-owned bound.</summary>
        public const string PayloadTooLarge = "payload_too_large";

        /// <summary>The caller is issuing requests faster than the host will serve them.</summary>
        public const string RateLimited = "rate_limited";

        /// <summary>Something failed inside the host. Deliberately opaque: no internals cross this boundary.</summary>
        public const string InternalError = "internal_error";

        /// <summary>A dependency the operation needs is not currently usable.</summary>
        public const string Unavailable = "unavailable";

        /// <summary>The operation exceeded its deadline. Distinct from <see cref="Unavailable"/>: work may have started.</summary>
        public const string Timeout = "timeout";

        /// <summary>
        /// Whether each code is worth retrying, and the status it maps to.
        ///
        /// Retryability is a property OF THE CODE rather than something a caller of
        /// <c>PlatformProblem</c> chooses per call site. Two endpoints returning the same
        /// code but disagreeing about whether it is retryable is precisely the kind of
        /// inconsistency this issue exists to remove, so the choice is not offered.
        /// </summary>
        private static readonly ReadOnlyDictionary<string, (int Status, bool Retryable)> Definitions =
            new(new Dictionary<string, (int, bool)>(StringComparer.Ordinal)
            {
                [InvalidRequest] = (400, false),
                [UnsupportedProtocol] = (400, false),
                [NotFound] = (404, false),
                [Conflict] = (409, false),
                [PayloadTooLarge] = (413, false),

                // Retryable, but only after backing off - which is why the code exists
                // separately from a bare 500.
                [RateLimited] = (429, true),

                // Retryable in the sense that the caller has no better option and the
                // failure may be transient. It is never a promise that a retry will work.
                [InternalError] = (500, true),
                [Unavailable] = (503, true),

                // Retryable, but NOT idempotent-safe on its own: a timeout means the
                // host stopped waiting, not that the work did not happen.
                [Timeout] = (504, true),
            });

        /// <summary>Every code in the enumerated set. Used by the tests that pin it.</summary>
        public static IReadOnlyCollection<string> All => (IReadOnlyCollection<string>)Definitions.Keys;

        /// <summary>Whether <paramref name="code"/> belongs to the enumerated set.</summary>
        public static bool IsKnown(string? code) => code is not null && Definitions.ContainsKey(code);

        /// <summary>The HTTP status this code is returned with. One code, one status.</summary>
        /// <exception cref="ArgumentOutOfRangeException">The code is not part of the enumerated set.</exception>
        public static int StatusFor(string code) => Lookup(code).Status;

        /// <summary>Whether retrying the same request could plausibly succeed.</summary>
        /// <exception cref="ArgumentOutOfRangeException">The code is not part of the enumerated set.</exception>
        public static bool IsRetryable(string code) => Lookup(code).Retryable;

        private static (int Status, bool Retryable) Lookup(string code)
        {
            if (!Definitions.TryGetValue(code ?? string.Empty, out var definition))
            {
                // Throwing rather than inventing a default: an unknown code reaching here
                // means a caller invented one, and silently serving it as a 500 would let
                // the free-form strings this type exists to prevent back onto the wire.
                throw new ArgumentOutOfRangeException(
                    nameof(code),
                    code,
                    "Not a Platform v1 error code. Codes are an enumerated set; add it to PlatformErrorCode "
                    + "with its status and retryability rather than passing a free-form string.");
            }

            return definition;
        }
    }
}
