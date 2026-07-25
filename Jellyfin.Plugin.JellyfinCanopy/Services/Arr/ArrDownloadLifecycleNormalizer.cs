using System;
using System.Globalization;
using Jellyfin.Plugin.JellyfinCanopy.Model.Arr;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Arr
{
    /// <summary>
    /// The source data needed to normalize one queue row. Raw operational fields are retained
    /// only inside the server process and never serialized to a browser response.
    /// </summary>
    internal sealed class ArrDownloadQueueSignal
    {
        public string RawStatus { get; init; } = string.Empty;

        public string TrackedState { get; init; } = string.Empty;

        public string TrackedStatus { get; init; } = string.Empty;

        public double? Size { get; init; }

        public double? SizeLeft { get; init; }

        public string? TimeLeft { get; init; }
    }

    internal sealed record ArrNormalizedLifecycle(
        string Lifecycle,
        string Section,
        string? ReasonCode,
        bool Terminal);

    /// <summary>
    /// One deterministic lifecycle truth table shared by the Requests feed and the admin
    /// manage/status surface. Transfer progress is deliberately computed independently.
    /// Unknown or conflicting future values always degrade to a non-success state.
    /// </summary>
    internal static class ArrDownloadLifecycleNormalizer
    {
        public static ArrNormalizedLifecycle NormalizeQueue(ArrDownloadQueueSignal signal)
        {
            ArgumentNullException.ThrowIfNull(signal);

            var status = Canonical(signal.RawStatus);
            var trackedState = Canonical(signal.TrackedState);
            var trackedStatus = Canonical(signal.TrackedStatus);

            // Explicit failure is stronger than all other queue hints. A row that remains in
            // the active queue stays in Processing; a terminal history event moves it to History.
            if (status == "failed" || trackedState == "failed")
            {
                return Processing(ArrDownloadLifecycles.Failed, ArrDownloadReasonCodes.DownloadFailed);
            }

            if (trackedState == "failedpending")
            {
                return Processing(ArrDownloadLifecycles.Attention, ArrDownloadReasonCodes.FailedPending);
            }

            if (trackedState == "importblocked")
            {
                return Processing(ArrDownloadLifecycles.Attention, ArrDownloadReasonCodes.ImportBlocked);
            }

            if (trackedStatus is "warning" or "error" || status == "warning")
            {
                return Processing(ArrDownloadLifecycles.Warning, ArrDownloadReasonCodes.DownloadWarning);
            }

            if (status == "downloadclientunavailable")
            {
                return Processing(
                    ArrDownloadLifecycles.Attention,
                    ArrDownloadReasonCodes.DownloadClientUnavailable);
            }

            if (status == "fallback")
            {
                return Processing(ArrDownloadLifecycles.Attention, ArrDownloadReasonCodes.Fallback);
            }

            // These tracked states are authoritative about Arr's import stage and therefore
            // take precedence over raw transfer hints and a 100% transfer percentage.
            if (trackedState == "importpending")
            {
                return Processing(ArrDownloadLifecycles.ImportPending);
            }

            if (trackedState == "importing")
            {
                return Processing(ArrDownloadLifecycles.Importing);
            }

            if (trackedState == "imported")
            {
                return new ArrNormalizedLifecycle(
                    ArrDownloadLifecycles.Imported,
                    ArrDownloadSections.History,
                    null,
                    true);
            }

            if (status == "delay")
            {
                return Downloading(ArrDownloadLifecycles.Delayed);
            }

            if (status == "paused")
            {
                return Downloading(ArrDownloadLifecycles.Paused);
            }

            if (trackedState == "ignored")
            {
                return new ArrNormalizedLifecycle(
                    ArrDownloadLifecycles.Canceled,
                    ArrDownloadSections.History,
                    ArrDownloadReasonCodes.DownloadIgnored,
                    true);
            }

            if (status == "completed")
            {
                return Processing(ArrDownloadLifecycles.WaitingForImport);
            }

            if (status == "queued")
            {
                return Downloading(ArrDownloadLifecycles.Queued);
            }

            if (status == "downloading" || trackedState == "downloading")
            {
                return Downloading(ArrDownloadLifecycles.Downloading);
            }

            return Processing(ArrDownloadLifecycles.Unknown, ArrDownloadReasonCodes.UnknownState);
        }

        public static double? CalculateTransferProgress(double? size, double? sizeLeft)
        {
            if (!size.HasValue
                || !sizeLeft.HasValue
                || !double.IsFinite(size.Value)
                || !double.IsFinite(sizeLeft.Value)
                || size.Value <= 0)
            {
                return null;
            }

            var progress = (size.Value - sizeLeft.Value) / size.Value * 100.0;
            return Math.Round(Math.Clamp(progress, 0.0, 100.0), 1);
        }

        /// <summary>
        /// Accepts only a parseable duration and returns an invariant representation. Arbitrary
        /// upstream text is never forwarded.
        /// </summary>
        public static string? SanitizeTimeRemaining(string? value)
        {
            if (string.IsNullOrWhiteSpace(value)
                || !TimeSpan.TryParse(value, CultureInfo.InvariantCulture, out var duration)
                || duration < TimeSpan.Zero
                || duration > TimeSpan.FromDays(365))
            {
                return null;
            }

            return duration.ToString("c", CultureInfo.InvariantCulture);
        }

        private static string Canonical(string? value)
            => string.IsNullOrWhiteSpace(value)
                ? string.Empty
                : value.Trim().Replace("_", string.Empty, StringComparison.Ordinal)
                    .Replace("-", string.Empty, StringComparison.Ordinal)
                    .ToLowerInvariant();

        private static ArrNormalizedLifecycle Downloading(string lifecycle)
            => new(lifecycle, ArrDownloadSections.Downloading, null, false);

        private static ArrNormalizedLifecycle Processing(string lifecycle, string? reasonCode = null)
            => new(lifecycle, ArrDownloadSections.Processing, reasonCode, false);
    }
}
