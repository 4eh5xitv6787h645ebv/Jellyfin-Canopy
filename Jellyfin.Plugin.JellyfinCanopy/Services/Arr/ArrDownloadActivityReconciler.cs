using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Jellyfin.Plugin.JellyfinCanopy.Model.Arr;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Arr
{
    /// <summary>
    /// Pure queue/history reconciliation. Joins require stable instance + non-empty download ID
    /// + parent entity identity. Title, display name, list position, and transfer percentage are
    /// never correlation keys.
    /// </summary>
    internal static class ArrDownloadActivityReconciler
    {
        internal sealed record Result(
            List<ArrDownloadActivityDto> Active,
            List<ArrDownloadActivityDto> History)
        {
            /// <summary>
            /// Deterministic work accounting for the strong-key join. These counters keep the
            /// bounded-work contract testable without relying on wall-clock timing.
            /// </summary>
            internal int HistoryAttemptIndexWrites { get; init; }

            internal int QueueAttemptIndexLookups { get; init; }
        }

        private sealed record BuiltActivity(
            ArrDownloadActivityDto Dto,
            string StrongJobKey,
            DateTimeOffset? StartedAt,
            DateTimeOffset? EndedAt,
            string AttemptSeed);

        private sealed record HistoryAttempt(
            BuiltActivity? Activity,
            string StrongJobKey,
            DateTimeOffset? StartedAt,
            DateTimeOffset? EndedAt,
            string AttemptSeed);

        public static Result Reconcile(
            IReadOnlyCollection<ArrAuthorizedRecord> queue,
            IReadOnlyCollection<ArrAuthorizedRecord> history)
        {
            var historyAttempts = BuildHistoryAttempts(history);
            var queueActivities = BuildQueueActivities(queue);
            var retainedQueue = new List<BuiltActivity>();
            var suppressedHistory = new HashSet<string>(StringComparer.Ordinal);
            var latestHistoryAttemptByStrongKey =
                new Dictionary<string, HistoryAttempt>(StringComparer.Ordinal);
            var historyAttemptIndexWrites = 0;
            foreach (var attempt in historyAttempts)
            {
                if (string.IsNullOrEmpty(attempt.StrongJobKey))
                {
                    continue;
                }

                // BuildHistoryAttempts emits attempts for one strong key in timestamp order.
                // Replacing the entry therefore preserves the former LastOrDefault semantics
                // while making the queue/history join linear instead of O(queue × history).
                latestHistoryAttemptByStrongKey[attempt.StrongJobKey] = attempt;
                historyAttemptIndexWrites++;
            }

            var queueAttemptIndexLookups = 0;

            foreach (var activity in queueActivities)
            {
                if (string.IsNullOrEmpty(activity.StrongJobKey))
                {
                    retainedQueue.Add(activity);
                    continue;
                }

                // Only the newest attempt can overlap the current queue. Earlier terminal
                // attempts remain visible, which preserves retries/re-grabs that reuse an ID.
                queueAttemptIndexLookups++;
                latestHistoryAttemptByStrongKey.TryGetValue(
                    activity.StrongJobKey,
                    out var latestAttempt);

                if (latestAttempt == null || !CouldRepresentSameAttempt(activity, latestAttempt))
                {
                    retainedQueue.Add(activity);
                    continue;
                }

                if (latestAttempt.Activity?.Dto.Terminal == true)
                {
                    // Positive terminal history establishes the handoff; the transient queue
                    // overlap no longer wins. This prevents duplicate Imported/Failed cards.
                    continue;
                }

                // A partial/non-terminal history prefix must not replace a live queue state.
                // Grabbed-only attempts are kept internally as boundaries even though they are
                // never published; this prevents a terminal result from an older attempt from
                // suppressing an active retry that reused the same downloader ID.
                if (latestAttempt.Activity != null)
                {
                    suppressedHistory.Add(latestAttempt.AttemptSeed);
                }

                retainedQueue.Add(activity with
                {
                    Dto = activity.Dto.WithId(HashActivityId(latestAttempt.AttemptSeed)),
                });
            }

            var retainedHistory = historyAttempts
                .Where(attempt => attempt.Activity != null
                    && !suppressedHistory.Contains(attempt.AttemptSeed))
                .Select(attempt => attempt.Activity!)
                .ToList();
            return new Result(
                retainedQueue
                    .Concat(retainedHistory.Where(activity =>
                        activity.Dto.Section != ArrDownloadSections.History))
                    .Select(activity => activity.Dto)
                    .ToList(),
                retainedHistory
                    .Where(activity => activity.Dto.Section == ArrDownloadSections.History)
                    .Select(activity => activity.Dto)
                    .ToList())
            {
                HistoryAttemptIndexWrites = historyAttemptIndexWrites,
                QueueAttemptIndexLookups = queueAttemptIndexLookups,
            };
        }

        private static List<BuiltActivity> BuildQueueActivities(
            IReadOnlyCollection<ArrAuthorizedRecord> records)
        {
            var grouped = records
                .GroupBy(
                    item => string.IsNullOrEmpty(item.Record.StrongJobKey)
                        ? $"record:{item.Record.Source}|{item.Record.InstanceId}|{item.Record.RecordId}"
                        : $"job:{item.Record.StrongJobKey}",
                    StringComparer.Ordinal);
            var result = new List<BuiltActivity>();

            foreach (var group in grouped)
            {
                var rows = group
                    .OrderBy(row => row.Record.SeasonNumber)
                    .ThenBy(row => row.Record.EpisodeNumber)
                    .ThenBy(row => row.Record.RecordId, StringComparer.Ordinal)
                    .ToList();
                var first = rows[0];
                var normalized = rows
                    .Select(row => ArrDownloadLifecycleNormalizer.NormalizeQueue(new ArrDownloadQueueSignal
                    {
                        RawStatus = row.Record.RawStatus,
                        TrackedState = row.Record.TrackedState,
                        TrackedStatus = row.Record.TrackedStatus,
                        Size = row.Record.Size,
                        SizeLeft = row.Record.SizeLeft,
                        TimeLeft = row.Record.TimeLeft,
                    }))
                    .ToList();
                var importedCount = normalized.Count(state =>
                    state.Lifecycle == ArrDownloadLifecycles.Imported);
                var partial = importedCount > 0 && importedCount < rows.Count;
                ArrNormalizedLifecycle lifecycle;
                if (rows.Any(row => row.Record.TransitionPending))
                {
                    lifecycle = new ArrNormalizedLifecycle(
                        ArrDownloadLifecycles.WaitingForImport,
                        ArrDownloadSections.Processing,
                        ArrDownloadReasonCodes.TransitionPending,
                        false);
                }
                else if (partial)
                {
                    lifecycle = new ArrNormalizedLifecycle(
                        ArrDownloadLifecycles.Attention,
                        ArrDownloadSections.Processing,
                        ArrDownloadReasonCodes.PartialImport,
                        false);
                }
                else
                {
                    lifecycle = normalized
                        .OrderByDescending(LifecyclePriority)
                        .First();
                }

                var progress = AggregateProgress(rows.Select(row => row.Record));
                var startedAt = rows
                    .Select(row => row.Record.OccurredAt)
                    .Where(value => value.HasValue)
                    .Select(value => value!.Value)
                    .DefaultIfEmpty()
                    .Min();
                DateTimeOffset? nullableStartedAt = startedAt == default ? null : startedAt;
                var seed = !string.IsNullOrEmpty(first.Record.StrongJobKey)
                    ? string.Concat(
                        first.Record.StrongJobKey,
                        "|queue|",
                        nullableStartedAt?.ToString("O", CultureInfo.InvariantCulture) ?? "undated")
                    : string.Concat(
                        first.Record.Source,
                        "|",
                        first.Record.InstanceId,
                        "|queue|",
                        first.Record.RecordId);
                var dto = BuildBaseDto(rows, lifecycle, HashActivityId(seed));
                dto.Progress = progress;
                dto.TimeRemaining = rows
                    .Select(row => ArrDownloadLifecycleNormalizer.SanitizeTimeRemaining(
                        row.Record.TimeLeft))
                    .FirstOrDefault(value => value != null);
                dto.OccurredAt = nullableStartedAt;
                dto.GroupCount = rows.Count;
                dto.ImportedCount = importedCount > 0 ? importedCount : null;
                dto.ExpectedCount = rows.Count > 1 ? rows.Count : null;
                dto.Partial = partial;
                dto.Stale = rows.Any(row => row.Record.Stale);

                result.Add(new BuiltActivity(
                    dto,
                    first.Record.StrongJobKey,
                    nullableStartedAt,
                    null,
                    seed));
            }

            return result;
        }

        private static List<HistoryAttempt> BuildHistoryAttempts(
            IReadOnlyCollection<ArrAuthorizedRecord> records)
        {
            var result = new List<HistoryAttempt>();
            var correlated = records
                .Where(row => !string.IsNullOrEmpty(row.Record.StrongJobKey))
                .GroupBy(row => row.Record.StrongJobKey, StringComparer.Ordinal);

            foreach (var job in correlated)
            {
                var current = new List<ArrAuthorizedRecord>();
                var terminalSeen = false;
                foreach (var row in job
                    .OrderBy(item => item.Record.OccurredAt)
                    .ThenBy(item => item.Record.RecordId, StringComparer.Ordinal))
                {
                    var eventType = Canonical(row.Record.HistoryEventType);
                    if (eventType == "grabbed" && terminalSeen && current.Count > 0)
                    {
                        AddAttempt(result, current, job.Key);
                        current = new List<ArrAuthorizedRecord>();
                        terminalSeen = false;
                    }

                    current.Add(row);
                    terminalSeen |= IsTerminalHistoryEvent(eventType);
                }

                AddAttempt(result, current, job.Key);
            }

            // A missing download ID is valid for manual imports, but it is not evidence that
            // independent rows belong together. Each source-qualified history row stands alone.
            foreach (var row in records.Where(item => string.IsNullOrEmpty(
                item.Record.StrongJobKey)))
            {
                AddAttempt(
                    result,
                    new List<ArrAuthorizedRecord> { row },
                    string.Empty);
            }

            return result;
        }

        private static void AddAttempt(
            ICollection<HistoryAttempt> output,
            IReadOnlyList<ArrAuthorizedRecord> rows,
            string strongJobKey)
        {
            if (rows.Count == 0)
            {
                return;
            }

            var ordered = rows
                .OrderBy(row => row.Record.OccurredAt)
                .ThenBy(row => row.Record.RecordId, StringComparer.Ordinal)
                .ToList();
            var grabbed = ordered
                .Where(row => Canonical(row.Record.HistoryEventType) == "grabbed")
                .Select(row => row.Record.EntityKey)
                .Where(value => !string.IsNullOrEmpty(value))
                .ToHashSet(StringComparer.Ordinal);
            var imported = ordered
                .Where(row => Canonical(row.Record.HistoryEventType) == "downloadfolderimported")
                .Select(row => row.Record.EntityKey)
                .Where(value => !string.IsNullOrEmpty(value))
                .ToHashSet(StringComparer.Ordinal);
            var latestTerminalEvent = ordered
                .Select(row => Canonical(row.Record.HistoryEventType))
                .LastOrDefault(IsTerminalHistoryEvent);

            ArrNormalizedLifecycle? lifecycle = null;
            var expectedCount = grabbed.Count;
            var importedCount = imported.Count;
            var partial = expectedCount > 0
                && importedCount > 0
                && !grabbed.IsSubsetOf(imported);

            if (latestTerminalEvent == "downloadfolderimported" && partial)
            {
                lifecycle = new ArrNormalizedLifecycle(
                    ArrDownloadLifecycles.Attention,
                    ArrDownloadSections.Processing,
                    ArrDownloadReasonCodes.PartialImport,
                    false);
            }
            else if (latestTerminalEvent == "downloadfailed")
            {
                lifecycle = new ArrNormalizedLifecycle(
                    ArrDownloadLifecycles.Failed,
                    ArrDownloadSections.History,
                    ArrDownloadReasonCodes.DownloadFailed,
                    true);
            }
            else if (latestTerminalEvent == "downloadignored")
            {
                lifecycle = new ArrNormalizedLifecycle(
                    ArrDownloadLifecycles.Canceled,
                    ArrDownloadSections.History,
                    ArrDownloadReasonCodes.DownloadIgnored,
                    true);
            }
            else if (latestTerminalEvent == "downloadfolderimported"
                && importedCount > 0
                && (expectedCount == 0 || grabbed.IsSubsetOf(imported)))
            {
                lifecycle = new ArrNormalizedLifecycle(
                    ArrDownloadLifecycles.Imported,
                    ArrDownloadSections.History,
                    null,
                    true);
            }

            var relevantRows = ordered
                .Where(row => Canonical(row.Record.HistoryEventType) is
                    "grabbed" or "downloadfolderimported" or "downloadfailed" or "downloadignored")
                .ToList();
            var first = relevantRows.Count > 0 ? relevantRows[0] : ordered[0];
            var latest = relevantRows.Count > 0 ? relevantRows[^1] : ordered[^1];
            var seed = string.Concat(
                first.Record.Source,
                "|",
                first.Record.InstanceId,
                "|history|",
                first.Record.RecordId);

            // Grabbed-only, renamed/deleted, series-folder-imported, and future events do not
            // prove a terminal download outcome and are intentionally absent from History.
            // Keep the attempt boundary, however, so a later grabbed marker cannot be erased
            // and accidentally associate a current queue row with an older terminal attempt.
            if (lifecycle == null)
            {
                output.Add(new HistoryAttempt(
                    null,
                    strongJobKey,
                    first.Record.OccurredAt,
                    latest.Record.OccurredAt,
                    seed));
                return;
            }

            var dto = BuildBaseDto(relevantRows.Count > 0 ? relevantRows : ordered, lifecycle, HashActivityId(seed));
            dto.OccurredAt = latest.Record.OccurredAt;
            dto.GroupCount = Math.Max(
                1,
                grabbed.Union(imported).Count());
            dto.ExpectedCount = expectedCount > 0 ? expectedCount : null;
            dto.ImportedCount = importedCount > 0 ? importedCount : null;
            dto.Partial = partial;
            dto.Stale = ordered.Any(row => row.Record.Stale);

            output.Add(new HistoryAttempt(
                new BuiltActivity(
                    dto,
                    strongJobKey,
                    first.Record.OccurredAt,
                    latest.Record.OccurredAt,
                    seed),
                strongJobKey,
                first.Record.OccurredAt,
                latest.Record.OccurredAt,
                seed));
        }

        private static ArrDownloadActivityDto BuildBaseDto(
            IReadOnlyList<ArrAuthorizedRecord> rows,
            ArrNormalizedLifecycle lifecycle,
            string id)
        {
            var representative = rows
                .OrderByDescending(row => row.Record.OccurredAt)
                .ThenBy(row => row.Record.RecordId, StringComparer.Ordinal)
                .First();
            var allAvailable = rows.Count > 0
                && rows.All(row => row.JellyfinAvailable && row.JellyfinItemId.HasValue);
            var allAccessible = rows.Count > 0
                && rows.All(row => row.JellyfinItemId.HasValue);
            var distinctAccessibleIds = rows
                .Where(row => row.JellyfinItemId.HasValue)
                .Select(row => row.JellyfinItemId!.Value)
                .Distinct()
                .ToList();
            var navigationId = allAccessible && distinctAccessibleIds.Count == 1
                ? distinctAccessibleIds[0]
                : (Guid?)null;

            return new ArrDownloadActivityDto
            {
                Id = id,
                Source = representative.Record.Source,
                InstanceId = representative.Record.InstanceId,
                InstanceName = representative.Record.InstanceName,
                Title = representative.Record.Title,
                Subtitle = BuildSubtitle(rows.Select(row => row.Record).ToList()),
                MediaType = representative.Record.MediaType,
                SeasonNumber = representative.Record.SeasonNumber,
                EpisodeNumber = rows.Count == 1 ? representative.Record.EpisodeNumber : null,
                Section = lifecycle.Section,
                Lifecycle = lifecycle.Lifecycle,
                ReasonCode = lifecycle.ReasonCode,
                Terminal = lifecycle.Terminal,
                Provenance = rows.Any(row => row.SeerrAssociated)
                    ? ArrDownloadProvenance.SeerrAssociated
                    : ArrDownloadProvenance.Unknown,
                JellyfinItemId = navigationId?.ToString("N", CultureInfo.InvariantCulture),
                Availability = allAvailable
                    ? ArrDownloadAvailability.Available
                    : allAccessible
                        ? ArrDownloadAvailability.Unavailable
                        : ArrDownloadAvailability.Unknown,
            };
        }

        private static string? BuildSubtitle(IReadOnlyList<ArrDownloadActivityRecord> rows)
        {
            if (rows.Count == 1)
            {
                return rows[0].Subtitle;
            }

            var seasons = rows
                .Select(row => row.SeasonNumber)
                .Where(value => value.HasValue)
                .Select(value => value!.Value)
                .Distinct()
                .OrderBy(value => value)
                .ToList();
            return seasons.Count == 1
                ? string.Create(
                    CultureInfo.InvariantCulture,
                    $"Season {seasons[0]} · {rows.Count} episodes")
                : string.Create(CultureInfo.InvariantCulture, $"{rows.Count} episodes");
        }

        private static double? AggregateProgress(
            IEnumerable<ArrDownloadActivityRecord> records)
        {
            var rows = records.ToList();
            var sized = rows
                .Where(row => row.Size is > 0
                    && row.SizeLeft.HasValue
                    && double.IsFinite(row.Size.Value)
                    && double.IsFinite(row.SizeLeft.Value))
                .ToList();
            if (sized.Count == rows.Count && sized.Count > 0)
            {
                var total = sized.Sum(row => row.Size!.Value);
                var remaining = sized.Sum(row => row.SizeLeft!.Value);
                return ArrDownloadLifecycleNormalizer.CalculateTransferProgress(total, remaining);
            }

            var known = rows
                .Select(row => ArrDownloadLifecycleNormalizer.CalculateTransferProgress(
                    row.Size,
                    row.SizeLeft))
                .Where(value => value.HasValue)
                .Select(value => value!.Value)
                .ToList();
            return known.Count == 0 ? null : Math.Round(known.Average(), 1);
        }

        private static bool CouldRepresentSameAttempt(
            BuiltActivity queue,
            HistoryAttempt history)
        {
            if (!string.Equals(queue.StrongJobKey, history.StrongJobKey, StringComparison.Ordinal))
            {
                return false;
            }

            if (!queue.StartedAt.HasValue || !history.EndedAt.HasValue)
            {
                // A shared downloader id is insufficient when either side lacks temporal
                // evidence: the id may have been reused for a later retry or upgrade. Preserve
                // both rows rather than fabricating an overlap.
                return false;
            }

            // Queue work observed at or after the last event in a history attempt is ambiguous
            // or positively newer, even when a downloader reuses the same download ID. Both
            // timestamps originate in the same Arr service, so a post-terminal tolerance would
            // let an old completion erase an immediate retry while its new grabbed event lags.
            // Preserve the active row on equality as the conservative ambiguity rule.
            return queue.StartedAt.Value < history.EndedAt.Value;
        }

        private static int LifecyclePriority(ArrNormalizedLifecycle lifecycle)
            => lifecycle.Lifecycle switch
            {
                ArrDownloadLifecycles.Failed => 100,
                ArrDownloadLifecycles.Attention => 90,
                ArrDownloadLifecycles.Warning => 80,
                ArrDownloadLifecycles.Unknown => 70,
                ArrDownloadLifecycles.WaitingForImport => 60,
                ArrDownloadLifecycles.ImportPending => 55,
                ArrDownloadLifecycles.Importing => 50,
                ArrDownloadLifecycles.Delayed => 45,
                ArrDownloadLifecycles.Paused => 40,
                ArrDownloadLifecycles.Queued => 30,
                ArrDownloadLifecycles.Downloading => 20,
                ArrDownloadLifecycles.Imported => 10,
                ArrDownloadLifecycles.Canceled => 10,
                _ => 0,
            };

        private static bool IsTerminalHistoryEvent(string eventType)
            => eventType is "downloadfolderimported" or "downloadfailed" or "downloadignored";

        private static string Canonical(string? value)
            => string.IsNullOrWhiteSpace(value)
                ? string.Empty
                : value.Trim().Replace("_", string.Empty, StringComparison.Ordinal)
                    .Replace("-", string.Empty, StringComparison.Ordinal)
                    .ToLowerInvariant();

        internal static string HashActivityId(string material)
        {
            var digest = SHA256.HashData(Encoding.UTF8.GetBytes(material));
            return string.Concat(
                "activity-",
                Convert.ToHexString(digest.AsSpan(0, 16)).ToLowerInvariant());
        }

        private static ArrDownloadActivityDto WithId(
            this ArrDownloadActivityDto source,
            string id)
            => new()
            {
                Id = id,
                Source = source.Source,
                InstanceId = source.InstanceId,
                InstanceName = source.InstanceName,
                Title = source.Title,
                Subtitle = source.Subtitle,
                MediaType = source.MediaType,
                SeasonNumber = source.SeasonNumber,
                EpisodeNumber = source.EpisodeNumber,
                Section = source.Section,
                Lifecycle = source.Lifecycle,
                Progress = source.Progress,
                TimeRemaining = source.TimeRemaining,
                OccurredAt = source.OccurredAt,
                Stale = source.Stale,
                ReasonCode = source.ReasonCode,
                Terminal = source.Terminal,
                GroupCount = source.GroupCount,
                ImportedCount = source.ImportedCount,
                ExpectedCount = source.ExpectedCount,
                Partial = source.Partial,
                Provenance = source.Provenance,
                JellyfinItemId = source.JellyfinItemId,
                Availability = source.Availability,
            };
    }
}
