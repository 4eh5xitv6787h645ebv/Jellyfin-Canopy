using System;
using System.Collections.Immutable;
using System.Text.Json;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>Closed, redaction-safe outcomes for one bounded provider invocation.</summary>
    internal enum PlatformProviderInvocationStatus
    {
        Succeeded = 1,
        AuthorityUnavailable = 2,
        AuthorityChanged = 3,
        InvalidRequest = 4,
        RequestSchemaRejected = 5,
        ProviderBusy = 6,
        CallerCancelled = 7,
        GenerationCancelled = 8,
        DeadlineExceeded = 9,
        ProviderIgnoredCancellation = 10,
        ProviderFaulted = 11,
        ResponseMissing = 12,
        ResponseTooLarge = 13,
        ResponseInvalidJson = 14,
        ResponseEnvelopeMismatch = 15,
        ResponseSchemaRejected = 16,
        ResultReleaseRejected = 17,
        InvocationFailed = 18,
    }

    /// <summary>
    /// Minimal host-authored projection accepted by the provider invocation boundary.
    /// It carries attribution and already-authorized context, never caller credentials or
    /// access to host services.
    /// </summary>
    internal sealed class PlatformProviderInvocationRequest
    {
        internal PlatformProviderInvocationRequest(
            string correlationId,
            string userAttribution,
            string deviceAttribution,
            Guid? itemId,
            string? surface,
            string locale,
            ImmutableArray<string> accessibilityHints,
            int remainingDeadlineMilliseconds,
            JsonElement input)
        {
            CorrelationId = correlationId;
            UserAttribution = userAttribution;
            DeviceAttribution = deviceAttribution;
            ItemId = itemId;
            Surface = surface;
            Locale = locale;
            AccessibilityHints = accessibilityHints.IsDefault
                ? accessibilityHints
                : ImmutableArray.CreateRange(accessibilityHints);
            RemainingDeadlineMilliseconds = remainingDeadlineMilliseconds;
            Input = PlatformProviderJsonPayloadValidator.OwnBoundedOperationInput(input);
        }

        internal string CorrelationId { get; }

        internal string UserAttribution { get; }

        internal string DeviceAttribution { get; }

        internal Guid? ItemId { get; }

        internal string? Surface { get; }

        internal string Locale { get; }

        internal ImmutableArray<string> AccessibilityHints { get; }

        internal int RemainingDeadlineMilliseconds { get; }

        internal JsonElement Input { get; }
    }

    /// <summary>One atomic result. Provider payload is published only for success.</summary>
    internal readonly record struct PlatformProviderInvocationResult
    {
        private PlatformProviderInvocationResult(
            PlatformProviderInvocationStatus status,
            JsonElement? result)
        {
            if (!Enum.IsDefined(status)
                || (status == PlatformProviderInvocationStatus.Succeeded) != result.HasValue)
            {
                throw new ArgumentOutOfRangeException(nameof(status));
            }

            Status = status;
            Result = result?.Clone();
        }

        internal PlatformProviderInvocationStatus Status { get; }

        internal JsonElement? Result { get; }

        internal static PlatformProviderInvocationResult Succeeded(JsonElement result) =>
            new(PlatformProviderInvocationStatus.Succeeded, result);

        internal static PlatformProviderInvocationResult Rejected(
            PlatformProviderInvocationStatus status) => new(status, null);
    }
}
