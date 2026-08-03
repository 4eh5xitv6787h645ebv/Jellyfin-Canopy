using System;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Seerr
{
    /// <summary>
    /// Status-code-independent request result for native SDKs that discard
    /// non-success response bodies.
    /// </summary>
    public sealed class SeerrRequestOutcomeResponse
    {
        /// <summary>
        /// Stable outcome token: submitted, already_requested, quota_exceeded,
        /// blocked, denied, unavailable, or failed.
        /// </summary>
        public string Outcome { get; set; } = "failed";

        /// <summary>Whether Seerr accepted a new media request.</summary>
        public bool Submitted { get; set; }

        /// <summary>Whether retrying later can reasonably change the result.</summary>
        public bool Retryable { get; set; }

        /// <summary>
        /// The status produced by the compatibility route before normalization.
        /// This is diagnostic only; callers branch on <see cref="Outcome"/>.
        /// </summary>
        public int SourceStatus { get; set; }

        /// <summary>Safe user-facing summary with no provider URL or credential.</summary>
        public string Message { get; set; } = "The request could not be completed.";
    }

    internal static class SeerrRequestOutcome
    {
        internal static IActionResult FromProxyResult(IActionResult result)
        {
            ArgumentNullException.ThrowIfNull(result);
            var (status, body) = ReadResult(result);
            var code = ReadString(body, "code");
            var message = ReadString(body, "message");

            if (EqualsCode(code, "seerr_accepted_spoiler_intent_failed")
                && ReadBoolean(body, "seerrAccepted") == true)
            {
                return Ok(
                    "submitted",
                    submitted: true,
                    retryable: false,
                    status,
                    "Request accepted, but Spoiler Guard needs manual setup. Do not retry the request.");
            }

            if (status >= 200 && status < 300)
            {
                if (status == 202
                    && message?.Contains(
                        "No seasons available to request",
                        StringComparison.OrdinalIgnoreCase) == true)
                {
                    return Ok(
                        "already_requested",
                        submitted: false,
                        retryable: false,
                        status,
                        "All selected seasons are already requested or available.");
                }

                return Ok(
                    "submitted",
                    submitted: true,
                    retryable: false,
                    status,
                    "Request submitted.");
            }

            if (EqualsCode(code, "QuotaExceeded") || status == 429)
            {
                return Ok(
                    "quota_exceeded",
                    submitted: false,
                    retryable: false,
                    status,
                    "Your Seerr request quota has been reached.");
            }

            if (EqualsCode(code, "AlreadyRequested")
                || (status == 409 && !IsRetryableConflict(code)))
            {
                return Ok(
                    "already_requested",
                    submitted: false,
                    retryable: false,
                    status,
                    "This title is already requested.");
            }

            if (EqualsCode(code, "Blocklisted") || EqualsCode(code, "blocked"))
            {
                return Ok(
                    "blocked",
                    submitted: false,
                    retryable: false,
                    status,
                    "This request is blocked by server policy.");
            }

            if (EqualsCode(code, "Unauthorized"))
            {
                return Ok(
                    "unavailable",
                    submitted: false,
                    retryable: false,
                    status,
                    "The Seerr connection requires administrator attention.");
            }

            if (status == 401 || status == 403 || IsDeniedCode(code))
            {
                return Ok(
                    "denied",
                    submitted: false,
                    retryable: false,
                    status,
                    "You do not have permission to make this request.");
            }

            if (status is 408 or 502 or 503 or 504
                || EqualsCode(code, "unreachable")
                || EqualsCode(code, "unavailable")
                || IsRetryableConflict(code))
            {
                return Ok(
                    "unavailable",
                    submitted: false,
                    retryable: true,
                    status,
                    "Seerr is temporarily unavailable. Please try again.");
            }

            return Ok(
                "failed",
                submitted: false,
                retryable: status >= 500,
                status,
                "The request could not be completed.");
        }

        private static OkObjectResult Ok(
            string outcome,
            bool submitted,
            bool retryable,
            int status,
            string message)
            => new(new SeerrRequestOutcomeResponse
            {
                Outcome = outcome,
                Submitted = submitted,
                Retryable = retryable,
                SourceStatus = status,
                Message = message,
            });

        private static (int Status, JsonElement? Body) ReadResult(IActionResult result)
        {
            try
            {
                return result switch
                {
                    ContentResult content => (
                        content.StatusCode ?? 200,
                        string.IsNullOrWhiteSpace(content.Content)
                            ? null
                            : ParseContent(content.Content)),
                    ObjectResult value => (
                        value.StatusCode ?? 200,
                        value.Value == null
                            ? null
                            : JsonSerializer.SerializeToElement(value.Value)),
                    ForbidResult => (403, null),
                    UnauthorizedResult => (401, null),
                    StatusCodeResult status => (status.StatusCode, null),
                    _ => (500, null),
                };
            }
            catch (JsonException)
            {
                return (500, null);
            }
            catch (NotSupportedException)
            {
                return (500, null);
            }
        }

        private static JsonElement ParseContent(string content)
        {
            using var document = JsonDocument.Parse(content);
            return document.RootElement.Clone();
        }

        private static string? ReadString(JsonElement? body, string property)
        {
            if (!body.HasValue
                || body.Value.ValueKind != JsonValueKind.Object
                || !body.Value.TryGetProperty(property, out var value)
                || value.ValueKind != JsonValueKind.String)
            {
                return null;
            }

            return value.GetString();
        }

        private static bool? ReadBoolean(JsonElement? body, string property)
        {
            if (!body.HasValue
                || body.Value.ValueKind != JsonValueKind.Object
                || !body.Value.TryGetProperty(property, out var value)
                || value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            {
                return null;
            }

            return value.GetBoolean();
        }

        private static bool IsDeniedCode(string? code)
            => EqualsCode(code, "no_request_permission")
                || EqualsCode(code, "no_4k_request_permission")
                || EqualsCode(code, "4k_requests_disabled");

        private static bool IsRetryableConflict(string? code)
            => EqualsCode(code, "mutation_configuration_changed")
                || EqualsCode(code, "mutation_identity_changed")
                || EqualsCode(code, "mutation_identity_unavailable");

        private static bool EqualsCode(string? actual, string expected)
            => string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase);
    }
}
