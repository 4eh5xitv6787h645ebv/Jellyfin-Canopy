using System;
using System.Collections.Generic;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Jellyfin.Plugin.JellyfinCanopy.Data;
using Jellyfin.Plugin.JellyfinCanopy.Model.Arr;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Arr
{
    internal sealed record ArrActivityProvider(
        string Provider,
        string Value,
        ItemLookupKind Kind);

    /// <summary>
    /// Sanitized server-internal projection of a queue/history row. Operational fields needed
    /// only for strong correlation remain internal and are not part of any wire DTO.
    /// </summary>
    internal sealed record ArrDownloadActivityRecord
    {
        public string Source { get; init; } = string.Empty;

        public ArrInstance Instance { get; init; } = null!;

        public string InstanceId { get; init; } = string.Empty;

        public string InstanceName { get; init; } = string.Empty;

        public string RecordId { get; init; } = string.Empty;

        public string? DownloadId { get; init; }

        public string ParentEntityKey { get; init; } = string.Empty;

        public string EntityKey { get; init; } = string.Empty;

        public string MediaType { get; init; } = string.Empty;

        public int? TmdbId { get; init; }

        public int? TvdbId { get; init; }

        public int? SeasonNumber { get; init; }

        public int? EpisodeNumber { get; init; }

        public bool HasEpisodeDetail { get; init; }

        public string Title { get; init; } = string.Empty;

        public string? Subtitle { get; init; }

        public IReadOnlyList<ArrActivityProvider> Providers { get; init; }
            = Array.Empty<ArrActivityProvider>();

        public string RawStatus { get; init; } = string.Empty;

        public string TrackedState { get; init; } = string.Empty;

        public string TrackedStatus { get; init; } = string.Empty;

        public double? Size { get; init; }

        public double? SizeLeft { get; init; }

        public string? TimeLeft { get; init; }

        public string? HistoryEventType { get; init; }

        public DateTimeOffset? OccurredAt { get; init; }

        /// <summary>
        /// Cache-owned time at which Canopy first observed a terminal state in the live queue.
        /// ARR's queue <c>added</c> value is the download-start time, not terminal-event time,
        /// so it must not be used to age terminal queue evidence.
        /// </summary>
        public DateTimeOffset? TerminalFirstObservedAt { get; init; }

        /// <summary>
        /// Server-internal retention boundary for reused collection rows and queue
        /// disappearance handoffs. This is deliberately not projected onto the wire.
        /// </summary>
        public DateTimeOffset? SnapshotExpiresAt { get; init; }

        public bool TransitionPending { get; init; }

        public bool Stale { get; init; }

        public bool IsHistory => !string.IsNullOrEmpty(HistoryEventType);

        public string StrongJobKey
            => string.IsNullOrWhiteSpace(DownloadId)
                || string.IsNullOrWhiteSpace(ParentEntityKey)
                ? string.Empty
                : HashStrongJobKey(Source, InstanceId, DownloadId, ParentEntityKey);

        private static string HashStrongJobKey(params string[] segments)
        {
            var material = new StringBuilder();
            foreach (var segment in segments)
            {
                material.Append(segment.Length.ToString(CultureInfo.InvariantCulture))
                    .Append(':')
                    .Append(segment);
            }

            return Convert.ToHexString(
                SHA256.HashData(Encoding.UTF8.GetBytes(material.ToString())));
        }
    }

    internal sealed record ArrDownloadAccessContext
    {
        public bool IsAdmin { get; init; }

        public JUser? User { get; init; }

        public bool SeerrScopeComplete { get; init; }

        public IReadOnlySet<(int TmdbId, string MediaType)> SeerrRequests { get; init; }
            = new HashSet<(int, string)>();

        public IReadOnlySet<int> SeerrTvTvdbIds { get; init; } = new HashSet<int>();

        /// <summary>
        /// ARR source/instance identities for which the caller's pinned Seerr source has an
        /// unambiguous configured topology. Media-id correlation is not authorization unless
        /// the record also belongs to one of these scopes.
        /// </summary>
        public IReadOnlySet<(string Source, string InstanceId)> SeerrArrScopes { get; init; }
            = new HashSet<(string, string)>();

        public bool FilterByUserRequests { get; init; }

        public bool AllowActive { get; init; }

        public bool AllowProcessing { get; init; }

        public bool AllowWarnings { get; init; }

        public bool AllowHistory { get; init; }

        public bool AllowProvenance { get; init; }

        public bool DetailedLifecycle { get; init; }

        public int HistoryPage { get; init; } = 1;

        public int HistoryPageSize { get; init; } = 20;

        public string Search { get; init; } = string.Empty;
    }

    internal sealed class ArrAuthorizedRecord
    {
        public ArrDownloadActivityRecord Record { get; init; } = null!;

        public bool IsQueue { get; init; }

        public bool SeerrAssociated { get; init; }

        public Guid? JellyfinItemId { get; init; }

        public bool JellyfinAvailable { get; init; }
    }
}
