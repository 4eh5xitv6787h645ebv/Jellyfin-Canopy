using System;
using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinCanopy.Model.Arr
{
    /// <summary>
    /// Allowlisted response for the Requests-page download activity feed. It intentionally
    /// excludes raw Arr records, service URLs, paths, release/downloader titles, status-message
    /// text, API keys, and download identifiers.
    /// </summary>
    public sealed class ArrDownloadActivityResponseDto
    {
        [JsonPropertyName("items")]
        public List<ArrDownloadActivityDto> Items { get; set; } = new();

        [JsonPropertyName("history")]
        public List<ArrDownloadActivityDto> History { get; set; } = new();

        [JsonPropertyName("sources")]
        public List<ArrDownloadSourceStatusDto> Sources { get; set; } = new();

        [JsonPropertyName("degraded")]
        public bool Degraded { get; set; }

        [JsonPropertyName("stale")]
        public bool Stale { get; set; }

        [JsonPropertyName("generatedAt")]
        public DateTimeOffset GeneratedAt { get; set; }

        [JsonPropertyName("counts")]
        public ArrDownloadActivityCountsDto Counts { get; set; } = new();

        [JsonPropertyName("historyPage")]
        public int HistoryPage { get; set; }

        [JsonPropertyName("historyPageSize")]
        public int HistoryPageSize { get; set; }

        [JsonPropertyName("historyTotalItems")]
        public int HistoryTotalItems { get; set; }

        [JsonPropertyName("historyTotalPages")]
        public int HistoryTotalPages { get; set; }

        [JsonPropertyName("historyTruncated")]
        public bool HistoryTruncated { get; set; }

        [JsonPropertyName("activeTruncated")]
        public bool ActiveTruncated { get; set; }
    }

    /// <summary>A single sanitized, authorized logical download activity.</summary>
    public sealed class ArrDownloadActivityDto
    {
        [JsonPropertyName("id")]
        public string Id { get; set; } = string.Empty;

        [JsonPropertyName("source")]
        public string Source { get; set; } = string.Empty;

        [JsonPropertyName("instanceId")]
        public string InstanceId { get; set; } = string.Empty;

        [JsonPropertyName("instanceName")]
        public string InstanceName { get; set; } = string.Empty;

        [JsonPropertyName("title")]
        public string Title { get; set; } = string.Empty;

        [JsonPropertyName("subtitle")]
        public string? Subtitle { get; set; }

        [JsonPropertyName("mediaType")]
        public string MediaType { get; set; } = string.Empty;

        [JsonPropertyName("seasonNumber")]
        public int? SeasonNumber { get; set; }

        [JsonPropertyName("episodeNumber")]
        public int? EpisodeNumber { get; set; }

        /// <summary><c>downloading</c>, <c>processing</c>, or <c>history</c>.</summary>
        [JsonPropertyName("section")]
        public string Section { get; set; } = ArrDownloadSections.Processing;

        /// <summary>One of the allowlisted values in <see cref="ArrDownloadLifecycles"/>.</summary>
        [JsonPropertyName("lifecycle")]
        public string Lifecycle { get; set; } = ArrDownloadLifecycles.Unknown;

        /// <summary>Transfer progress only. It never implies import or availability.</summary>
        [JsonPropertyName("progress")]
        public double? Progress { get; set; }

        [JsonPropertyName("timeRemaining")]
        public string? TimeRemaining { get; set; }

        [JsonPropertyName("occurredAt")]
        public DateTimeOffset? OccurredAt { get; set; }

        [JsonPropertyName("stale")]
        public bool Stale { get; set; }

        /// <summary>Sanitized code from <see cref="ArrDownloadReasonCodes"/>; never upstream text.</summary>
        [JsonPropertyName("reasonCode")]
        public string? ReasonCode { get; set; }

        [JsonPropertyName("terminal")]
        public bool Terminal { get; set; }

        [JsonPropertyName("groupCount")]
        public int GroupCount { get; set; } = 1;

        [JsonPropertyName("importedCount")]
        public int? ImportedCount { get; set; }

        [JsonPropertyName("expectedCount")]
        public int? ExpectedCount { get; set; }

        [JsonPropertyName("partial")]
        public bool Partial { get; set; }

        /// <summary><c>seerrAssociated</c>, <c>unknown</c>, or null when hidden by policy.</summary>
        [JsonPropertyName("provenance")]
        public string? Provenance { get; set; }

        /// <summary>Present only after a positive user-scoped Jellyfin library lookup.</summary>
        [JsonPropertyName("jellyfinItemId")]
        public string? JellyfinItemId { get; set; }

        /// <summary><c>available</c>, <c>unavailable</c>, or <c>unknown</c>.</summary>
        [JsonPropertyName("availability")]
        public string Availability { get; set; } = ArrDownloadAvailability.Unknown;
    }

    public sealed class ArrDownloadSourceStatusDto
    {
        [JsonPropertyName("source")]
        public string Source { get; set; } = string.Empty;

        [JsonPropertyName("instanceId")]
        public string InstanceId { get; set; } = string.Empty;

        [JsonPropertyName("instanceName")]
        public string InstanceName { get; set; } = string.Empty;

        /// <summary>One of the allowlisted values in <see cref="ArrDownloadSourceStates"/>.</summary>
        [JsonPropertyName("state")]
        public string State { get; set; } = ArrDownloadSourceStates.Fresh;

        [JsonPropertyName("capturedAt")]
        public DateTimeOffset? CapturedAt { get; set; }
    }

    public sealed class ArrDownloadActivityCountsDto
    {
        [JsonPropertyName("downloading")]
        public int Downloading { get; set; }

        [JsonPropertyName("processing")]
        public int Processing { get; set; }

        [JsonPropertyName("history")]
        public int History { get; set; }
    }

    public static class ArrDownloadSections
    {
        public const string Downloading = "downloading";
        public const string Processing = "processing";
        public const string History = "history";
    }

    public static class ArrDownloadLifecycles
    {
        public const string Queued = "queued";
        public const string Downloading = "downloading";
        public const string Paused = "paused";
        public const string Delayed = "delayed";
        public const string PostProcessing = "postProcessing";
        public const string ImportPending = "importPending";
        public const string Importing = "importing";
        public const string WaitingForImport = "waitingForImport";
        public const string Attention = "attention";
        public const string Warning = "warning";
        public const string Failed = "failed";
        public const string Canceled = "canceled";
        public const string Removed = "removed";
        public const string Imported = "imported";
        public const string Unknown = "unknown";
    }

    public static class ArrDownloadReasonCodes
    {
        public const string DownloadClientUnavailable = "downloadClientUnavailable";
        public const string Fallback = "fallback";
        public const string ImportBlocked = "importBlocked";
        public const string FailedPending = "failedPending";
        public const string DownloadWarning = "downloadWarning";
        public const string DownloadFailed = "downloadFailed";
        public const string DownloadIgnored = "downloadIgnored";
        public const string PartialImport = "partialImport";
        public const string TransitionPending = "transitionPending";
        public const string UnknownState = "unknownState";
    }

    public static class ArrDownloadSourceStates
    {
        public const string Fresh = "fresh";
        public const string Stale = "stale";
        public const string Unavailable = "unavailable";
        public const string Incomplete = "incomplete";
        public const string Truncated = "truncated";
        public const string Configuration = "configuration";
    }

    public static class ArrDownloadAvailability
    {
        public const string Available = "available";
        public const string Unavailable = "unavailable";
        public const string Unknown = "unknown";
    }

    public static class ArrDownloadProvenance
    {
        public const string SeerrAssociated = "seerrAssociated";
        public const string Unknown = "unknown";
    }
}
