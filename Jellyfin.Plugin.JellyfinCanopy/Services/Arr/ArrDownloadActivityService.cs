using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Data;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Jellyfin.Plugin.JellyfinCanopy.Model.Arr;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Arr
{
    /// <summary>
    /// Single owner for bounded Arr queue/history collection, normalization, reconciliation,
    /// user-scoped Jellyfin resolution, stale handoff, visibility projection, and response
    /// pagination. Raw Arr payloads never cross this boundary.
    /// </summary>
    public sealed class ArrDownloadActivityService
    {
        internal const int MaxActivityQueueRecordsPerInstance = 2_000;
        internal const int MaxActiveResponseItems = 500;
        internal const int MaxHistoryPageSize = 50;
        internal const int MaxConfiguredInstances = 32;
        internal const int MaxConcurrentInstanceFetches = 4;
        internal const int MaxCachedInstances = 64;
        internal const int MaxHandoffRecordsPerInstance = 500;
        internal const int MaxLibraryProviderPairs = 10_000;
        internal const int MaxLibraryCandidates = 10_000;
        internal static readonly TimeSpan CacheReuseDuration = TimeSpan.FromSeconds(5);
        internal static readonly TimeSpan StaleSnapshotLifetime = TimeSpan.FromMinutes(5);
        internal static readonly TimeSpan QueueHistoryHandoffLifetime = TimeSpan.FromSeconds(90);

        private static readonly TimeSpan QueueRequestTimeout = TimeSpan.FromSeconds(10);
        private static readonly TimeSpan HistoryRequestTimeout = TimeSpan.FromSeconds(10);

        private readonly ArrFetchService _fetch;
        private readonly IItemLookupService _itemLookup;
        private readonly ILogger<ArrDownloadActivityService> _logger;
        private readonly ConcurrentDictionary<string, InstanceCache> _cache = new(StringComparer.Ordinal);
        private readonly SemaphoreSlim _instanceFetchGate = new(
            MaxConcurrentInstanceFetches,
            MaxConcurrentInstanceFetches);
        private readonly Func<DateTimeOffset> _utcNow;

        public ArrDownloadActivityService(
            ArrFetchService fetch,
            IItemLookupService itemLookup,
            ILogger<ArrDownloadActivityService> logger)
            : this(fetch, itemLookup, logger, () => DateTimeOffset.UtcNow)
        {
        }

        internal ArrDownloadActivityService(
            ArrFetchService fetch,
            IItemLookupService itemLookup,
            ILogger<ArrDownloadActivityService> logger,
            Func<DateTimeOffset> utcNow)
        {
            _fetch = fetch;
            _itemLookup = itemLookup;
            _logger = logger;
            _utcNow = utcNow;
        }

        internal async Task<ArrDownloadActivityResponseDto> GetActivityAsync(
            PluginConfiguration config,
            ArrDownloadAccessContext access,
            CancellationToken ct)
        {
            ArgumentNullException.ThrowIfNull(config);
            ArgumentNullException.ThrowIfNull(access);

            var now = _utcNow();
            var historyDays = Math.Clamp(config.DownloadsHistoryWindowDays, 1, 30);
            var cutoff = now.AddDays(-historyDays);
            var sources = new List<ArrDownloadSourceStatusDto>();
            var instanceTasks = new List<Task<InstanceSnapshot>>();

            AddConfigurationStatus(
                sources,
                "Sonarr",
                config.IsSonarrInstancesCorrupt()
                    || config.HasInvalidEnabledSonarrInstances(),
                config.GetSonarrInstances().Count,
                config.GetEnabledSonarrInstances().Count);
            AddConfigurationStatus(
                sources,
                "Radarr",
                config.IsRadarrInstancesCorrupt()
                    || config.HasInvalidEnabledRadarrInstances(),
                config.GetRadarrInstances().Count,
                config.GetEnabledRadarrInstances().Count);

            var enabledInstances = config.GetEnabledSonarrInstances()
                .Select(instance => (Source: "Sonarr", Instance: instance))
                .Concat(config.GetEnabledRadarrInstances()
                    .Select(instance => (Source: "Radarr", Instance: instance)))
                .Take(MaxConfiguredInstances)
                .ToList();
            var totalEnabledInstances = config.GetEnabledSonarrInstances().Count
                + config.GetEnabledRadarrInstances().Count;
            if (totalEnabledInstances > MaxConfiguredInstances)
            {
                sources.Add(new ArrDownloadSourceStatusDto
                {
                    Source = "ARR",
                    InstanceId = "instance-limit",
                    InstanceName = "ARR instance limit",
                    State = ArrDownloadSourceStates.Configuration,
                    CapturedAt = null,
                });
            }

            PruneCache(
                now,
                enabledInstances
                    .Select(pair => string.Concat(
                        pair.Source,
                        "|",
                        ArrIdHelper.GetStableInstanceId(pair.Instance)))
                    .ToHashSet(StringComparer.Ordinal));
            foreach (var pair in enabledInstances)
            {
                instanceTasks.Add(FetchInstanceAsync(
                    pair.Source,
                    pair.Instance,
                    cutoff,
                    historyDays,
                    ct));
            }

            var snapshots = await Task.WhenAll(instanceTasks).ConfigureAwait(false);
            sources.AddRange(snapshots.Select(snapshot => snapshot.Status));
            if (!access.IsAdmin && !access.SeerrScopeComplete)
            {
                sources.Add(new ArrDownloadSourceStatusDto
                {
                    Source = "Seerr",
                    InstanceId = "request-scope",
                    InstanceName = "Seerr request scope",
                    State = ArrDownloadSourceStates.Unavailable,
                    CapturedAt = null,
                });
            }

            var queue = snapshots.SelectMany(snapshot => snapshot.Queue).ToList();
            var history = snapshots.SelectMany(snapshot => snapshot.History).ToList();
            var authorization = Authorize(queue, history, access);
            if (!authorization.LibraryResolutionComplete)
            {
                sources.Add(new ArrDownloadSourceStatusDto
                {
                    Source = "Jellyfin",
                    InstanceId = "library-scope",
                    InstanceName = "Jellyfin library scope",
                    State = authorization.LibraryResolutionBoundExceeded
                        ? ArrDownloadSourceStates.Incomplete
                        : ArrDownloadSourceStates.Unavailable,
                    CapturedAt = null,
                });
            }

            var reconciled = ArrDownloadActivityReconciler.Reconcile(
                authorization.Records.Where(row => row.IsQueue).ToList(),
                authorization.Records.Where(row => !row.IsQueue).ToList());
            var active = reconciled.Active
                .Select(item => ApplyVisibility(item, access))
                .Where(item => item != null)
                .Select(item => item!)
                .Where(item => MatchesSearch(item, access.Search))
                .OrderBy(item => item.Section == ArrDownloadSections.Downloading ? 0 : 1)
                .ThenByDescending(item => LifecycleSortPriority(item.Lifecycle))
                .ThenBy(item => item.Title, StringComparer.OrdinalIgnoreCase)
                .ThenBy(item => item.Id, StringComparer.Ordinal)
                .ToList();
            var visibleHistory = reconciled.History
                .Select(item => ApplyVisibility(item, access))
                .Where(item => item != null)
                .Select(item => item!)
                .Where(item => MatchesSearch(item, access.Search))
                .OrderByDescending(item => item.OccurredAt)
                .ThenBy(item => item.Id, StringComparer.Ordinal)
                .ToList();

            var downloadingCount = active.Count(item =>
                item.Section == ArrDownloadSections.Downloading);
            var processingCount = active.Count(item =>
                item.Section == ArrDownloadSections.Processing);
            var handoffTruncated = snapshots.Any(snapshot => snapshot.ActiveTruncated);
            var activeTruncated = active.Count > MaxActiveResponseItems || handoffTruncated;
            if (activeTruncated)
            {
                active = active.Take(MaxActiveResponseItems).ToList();
            }

            var historyPageSize = Math.Clamp(access.HistoryPageSize, 1, MaxHistoryPageSize);
            var historyTotal = visibleHistory.Count;
            var historyTotalPages = historyTotal == 0
                ? 0
                : (int)Math.Ceiling(historyTotal / (double)historyPageSize);
            var historyPage = historyTotalPages == 0
                ? 1
                : Math.Clamp(access.HistoryPage, 1, historyTotalPages);
            var pagedHistory = visibleHistory
                .Skip((historyPage - 1) * historyPageSize)
                .Take(historyPageSize)
                .ToList();
            var sourceTruncated = snapshots.Any(snapshot => snapshot.HistoryTruncated);
            var stale = active.Any(item => item.Stale)
                || pagedHistory.Any(item => item.Stale)
                || sources.Any(source => source.State == ArrDownloadSourceStates.Stale);
            var degraded = stale
                || activeTruncated
                || sourceTruncated
                || sources.Any(source => source.State != ArrDownloadSourceStates.Fresh);

            return new ArrDownloadActivityResponseDto
            {
                Items = active,
                History = pagedHistory,
                Sources = sources
                    .OrderBy(source => source.Source, StringComparer.Ordinal)
                    .ThenBy(source => source.InstanceName, StringComparer.Ordinal)
                    .ThenBy(source => source.InstanceId, StringComparer.Ordinal)
                    .ToList(),
                Degraded = degraded,
                Stale = stale,
                GeneratedAt = now,
                Counts = new ArrDownloadActivityCountsDto
                {
                    Downloading = downloadingCount,
                    Processing = processingCount,
                    History = historyTotal,
                },
                HistoryPage = historyPage,
                HistoryPageSize = historyPageSize,
                HistoryTotalItems = historyTotal,
                HistoryTotalPages = historyTotalPages,
                HistoryTruncated = sourceTruncated,
                ActiveTruncated = activeTruncated,
            };
        }

        private async Task<InstanceSnapshot> FetchInstanceAsync(
            string source,
            ArrInstance instance,
            DateTimeOffset cutoff,
            int historyDays,
            CancellationToken ct)
        {
            var instanceId = ArrIdHelper.GetStableInstanceId(instance);
            var key = string.Concat(source, "|", instanceId);
            var fingerprint = ConfigurationFingerprint(source, instance, historyDays);
            var cache = _cache.GetOrAdd(key, _ => new InstanceCache());
            await cache.Gate.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                var now = _utcNow();
                if (!string.Equals(cache.Fingerprint, fingerprint, StringComparison.Ordinal))
                {
                    cache.Reset(fingerprint);
                }

                if (cache.LastAttemptAt.HasValue
                    && now - cache.LastAttemptAt.Value <= CacheReuseDuration
                    && (cache.HasPublishedSnapshot
                        || cache.LastQueueError != null
                        || cache.LastHistoryError != null))
                {
                    return cache.ToSnapshot(source, instance, now);
                }

                cache.LastAttemptAt = now;
                await _instanceFetchGate.WaitAsync(ct).ConfigureAwait(false);
                ArrQueueCollection<ArrDownloadActivityRecord> queueResult;
                ArrHistoryCollection<ArrDownloadActivityRecord> historyResult;
                try
                {
                    var queueTask = FetchQueueAsync(source, instance, ct);
                    var historyTask = FetchHistoryAsync(source, instance, cutoff, ct);
                    await Task.WhenAll(queueTask, historyTask).ConfigureAwait(false);
                    queueResult = await queueTask.ConfigureAwait(false);
                    historyResult = await historyTask.ConfigureAwait(false);
                }
                finally
                {
                    _instanceFetchGate.Release();
                }

                var queueFailed = !queueResult.IsComplete;
                var historyFailed = historyResult.Error != null;
                var cachedHistoryFreshEnough = cache.HistoryCapturedAt.HasValue
                    && now - cache.HistoryCapturedAt.Value <= StaleSnapshotLifetime;
                IReadOnlyCollection<ArrDownloadActivityRecord> historyForHandoff =
                    !historyFailed
                        ? historyResult.Items
                        : cachedHistoryFreshEnough
                            ? cache.History
                            : Array.Empty<ArrDownloadActivityRecord>();

                if (!queueFailed)
                {
                    cache.ApplyFreshQueue(
                        queueResult.Items,
                        historyForHandoff,
                        now,
                        QueueHistoryHandoffLifetime);
                }

                if (!historyFailed)
                {
                    cache.History = historyResult.Items;
                    cache.HistoryCapturedAt = now;
                    cache.HistoryTruncated = historyResult.IsTruncated;
                }

                cache.LastQueueError = queueFailed ? queueResult.Error : null;
                cache.LastHistoryError = historyFailed ? historyResult.Error : null;
                cache.LastState = DetermineSourceState(
                    queueFailed,
                    historyFailed,
                    cache,
                    historyResult.IsTruncated || cache.IsHandoffTruncated(now),
                    now);
                cache.LastStateCapturedAt = cache.LastState == ArrDownloadSourceStates.Stale
                    ? OldestCapture(cache)
                    : now;
                return cache.ToSnapshot(source, instance, now);
            }
            finally
            {
                cache.Gate.Release();
            }
        }

        private Task<ArrQueueCollection<ArrDownloadActivityRecord>> FetchQueueAsync(
            string source,
            ArrInstance instance,
            CancellationToken ct)
        {
            var sonarr = string.Equals(source, "Sonarr", StringComparison.Ordinal);
            return _fetch.FetchQueueCollectionAsync(
                instance,
                (page, pageSize) => sonarr
                    ? $"/api/v3/queue?includeUnknownSeriesItems=true&includeEpisode=true&includeSeries=true&page={page}&pageSize={pageSize}&sortKey=timeleft&sortDirection=ascending"
                    : $"/api/v3/queue?includeUnknownMovieItems=true&includeMovie=true&page={page}&pageSize={pageSize}&sortKey=timeleft&sortDirection=ascending",
                pageSize: ArrFetchService.MaxHistoryPageSize,
                identity: record => StableJsonIdentity(record["id"]),
                projector: record => ParseQueueRecord(source, instance, record),
                requestTimeout: QueueRequestTimeout,
                contextLabel: $"{source} download activity queue",
                ct: ct,
                maxRecords: MaxActivityQueueRecordsPerInstance);
        }

        private Task<ArrHistoryCollection<ArrDownloadActivityRecord>> FetchHistoryAsync(
            string source,
            ArrInstance instance,
            DateTimeOffset cutoff,
            CancellationToken ct)
        {
            var sonarr = string.Equals(source, "Sonarr", StringComparison.Ordinal);
            return _fetch.FetchHistoryCollectionAsync(
                instance,
                (page, pageSize) => sonarr
                    ? $"/api/v3/history?includeSeries=true&includeEpisode=true&page={page}&pageSize={pageSize}&sortKey=date&sortDirection=descending"
                    : $"/api/v3/history?includeMovie=true&page={page}&pageSize={pageSize}&sortKey=date&sortDirection=descending",
                cutoff,
                identity: record => StableJsonIdentity(record["id"]),
                timestamp: record => ReadDate(record["date"]),
                projector: record => ParseHistoryRecord(source, instance, record),
                requestTimeout: HistoryRequestTimeout,
                contextLabel: $"{source} download activity history",
                ct: ct);
        }

        private static ArrDownloadActivityRecord? ParseQueueRecord(
            string source,
            ArrInstance instance,
            JsonNode record)
        {
            var recordId = StableJsonIdentity(record["id"]);
            if (recordId == null)
            {
                return null;
            }

            var sonarr = string.Equals(source, "Sonarr", StringComparison.Ordinal);
            var media = sonarr ? record["series"] : record["movie"];
            var episode = sonarr ? record["episode"] : null;
            var seriesId = ArrIdHelper.ToNullableId(ReadInt(record["seriesId"]))
                ?? ArrIdHelper.ToNullableId(ReadInt(media?["id"]));
            var episodeId = ArrIdHelper.ToNullableId(ReadInt(record["episodeId"]))
                ?? ArrIdHelper.ToNullableId(ReadInt(episode?["id"]));
            var movieId = ArrIdHelper.ToNullableId(ReadInt(record["movieId"]))
                ?? ArrIdHelper.ToNullableId(ReadInt(media?["id"]));
            var tmdbId = ArrIdHelper.ToNullableId(ReadInt(media?["tmdbId"]));
            var tvdbId = ArrIdHelper.ToNullableId(ReadInt(media?["tvdbId"]));
            var episodeTvdbId = ArrIdHelper.ToNullableId(ReadInt(episode?["tvdbId"]));
            var seasonNumber = sonarr
                ? ReadInt(episode?["seasonNumber"]) ?? ReadInt(record["seasonNumber"])
                : null;
            var episodeNumber = sonarr ? ReadInt(episode?["episodeNumber"]) : null;
            var episodeTitle = sonarr
                ? SafeLabelOrNull(ReadString(episode?["title"]), 256)
                : null;
            var parentEntityKey = sonarr
                ? seriesId.HasValue ? $"series:{seriesId.Value}" : string.Empty
                : movieId.HasValue ? $"movie:{movieId.Value}" : string.Empty;
            var entityKey = sonarr
                ? episodeId.HasValue ? $"episode:{episodeId.Value}" : parentEntityKey
                : parentEntityKey;
            var fallbackTitle = sonarr ? "Series download" : "Movie download";
            var title = SafeLabel(ReadString(media?["title"]), fallbackTitle, 256);
            var subtitle = sonarr
                ? BuildEpisodeSubtitle(
                    seasonNumber,
                    episodeNumber,
                    episodeTitle)
                : SafeYear(ReadInt(media?["year"]));

            return new ArrDownloadActivityRecord
            {
                Source = source,
                Instance = instance,
                InstanceId = ArrIdHelper.GetStableInstanceId(instance),
                InstanceName = SafeLabel(instance.Name, source, 80),
                RecordId = recordId,
                DownloadId = SafeCorrelationId(ReadString(record["downloadId"])),
                ParentEntityKey = parentEntityKey,
                EntityKey = string.IsNullOrEmpty(entityKey) ? $"queue:{recordId}" : entityKey,
                MediaType = sonarr ? "tv" : "movie",
                TmdbId = tmdbId,
                TvdbId = tvdbId,
                SeasonNumber = seasonNumber,
                EpisodeNumber = episodeNumber,
                HasEpisodeDetail = episodeId.HasValue
                    || episodeNumber.HasValue
                    || episodeTvdbId.HasValue
                    || episodeTitle != null,
                Title = title,
                Subtitle = subtitle,
                Providers = BuildProviders(sonarr, tmdbId, tvdbId, episodeTvdbId),
                RawStatus = SafeEnum(ReadString(record["status"])),
                TrackedState = SafeEnum(ReadString(record["trackedDownloadState"])),
                TrackedStatus = SafeEnum(ReadString(record["trackedDownloadStatus"])),
                Size = ReadDouble(record["size"]),
                SizeLeft = ReadDouble(record["sizeleft"]),
                TimeLeft = ReadString(record["timeleft"]),
                OccurredAt = ReadDate(record["added"]),
            };
        }

        private static ArrDownloadActivityRecord? ParseHistoryRecord(
            string source,
            ArrInstance instance,
            JsonNode record)
        {
            var recordId = StableJsonIdentity(record["id"]);
            var occurredAt = ReadDate(record["date"]);
            if (recordId == null || !occurredAt.HasValue)
            {
                return null;
            }

            var sonarr = string.Equals(source, "Sonarr", StringComparison.Ordinal);
            var media = sonarr ? record["series"] : record["movie"];
            var episode = sonarr ? record["episode"] : null;
            var seriesId = ArrIdHelper.ToNullableId(ReadInt(record["seriesId"]))
                ?? ArrIdHelper.ToNullableId(ReadInt(media?["id"]));
            var episodeId = ArrIdHelper.ToNullableId(ReadInt(record["episodeId"]))
                ?? ArrIdHelper.ToNullableId(ReadInt(episode?["id"]));
            var movieId = ArrIdHelper.ToNullableId(ReadInt(record["movieId"]))
                ?? ArrIdHelper.ToNullableId(ReadInt(media?["id"]));
            var tmdbId = ArrIdHelper.ToNullableId(ReadInt(media?["tmdbId"]));
            var tvdbId = ArrIdHelper.ToNullableId(ReadInt(media?["tvdbId"]));
            var episodeTvdbId = ArrIdHelper.ToNullableId(ReadInt(episode?["tvdbId"]));
            var seasonNumber = sonarr ? ReadInt(episode?["seasonNumber"]) : null;
            var episodeNumber = sonarr ? ReadInt(episode?["episodeNumber"]) : null;
            var episodeTitle = sonarr
                ? SafeLabelOrNull(ReadString(episode?["title"]), 256)
                : null;
            var parentEntityKey = sonarr
                ? seriesId.HasValue ? $"series:{seriesId.Value}" : string.Empty
                : movieId.HasValue ? $"movie:{movieId.Value}" : string.Empty;
            var entityKey = sonarr
                ? episodeId.HasValue ? $"episode:{episodeId.Value}" : parentEntityKey
                : parentEntityKey;
            var fallbackTitle = sonarr ? "Series download" : "Movie download";

            return new ArrDownloadActivityRecord
            {
                Source = source,
                Instance = instance,
                InstanceId = ArrIdHelper.GetStableInstanceId(instance),
                InstanceName = SafeLabel(instance.Name, source, 80),
                RecordId = recordId,
                DownloadId = SafeCorrelationId(ReadString(record["downloadId"])),
                ParentEntityKey = parentEntityKey,
                EntityKey = string.IsNullOrEmpty(entityKey) ? $"history:{recordId}" : entityKey,
                MediaType = sonarr ? "tv" : "movie",
                TmdbId = tmdbId,
                TvdbId = tvdbId,
                SeasonNumber = seasonNumber,
                EpisodeNumber = episodeNumber,
                HasEpisodeDetail = episodeId.HasValue
                    || episodeNumber.HasValue
                    || episodeTvdbId.HasValue
                    || episodeTitle != null,
                Title = SafeLabel(ReadString(media?["title"]), fallbackTitle, 256),
                Subtitle = sonarr
                    ? BuildEpisodeSubtitle(
                        seasonNumber,
                        episodeNumber,
                        episodeTitle)
                    : SafeYear(ReadInt(media?["year"])),
                Providers = BuildProviders(sonarr, tmdbId, tvdbId, episodeTvdbId),
                HistoryEventType = SafeEnum(ReadString(record["eventType"])),
                OccurredAt = occurredAt,
            };
        }

        private AuthorizationResult Authorize(
            IReadOnlyCollection<ArrDownloadActivityRecord> queue,
            IReadOnlyCollection<ArrDownloadActivityRecord> history,
            ArrDownloadAccessContext access)
        {
            var records = queue
                .Select(record => (Record: record, IsQueue: true))
                .Concat(history.Select(record => (Record: record, IsQueue: false)))
                .ToList();
            var providerBoundsExceeded = !TryCollectProviderPairs(
                records.Select(entry => entry.Record),
                MaxLibraryProviderPairs,
                out var providerPairs);

            Dictionary<(string Provider, string Value), IReadOnlyList<ItemLookupCandidate>> itemMap;
            IReadOnlySet<Guid> accessibleIds = new HashSet<Guid>();
            var resolutionComplete = !providerBoundsExceeded;
            var resolutionBoundExceeded = providerBoundsExceeded;
            try
            {
                if (providerBoundsExceeded)
                {
                    itemMap =
                        new Dictionary<(string, string), IReadOnlyList<ItemLookupCandidate>>();
                }
                else
                {
                    var lookup = _itemLookup.GetItemCandidatesByProvidersBatchBounded(
                        providerPairs,
                        MaxLibraryProviderPairs,
                        MaxLibraryCandidates);
                    itemMap = lookup.Candidates;
                    resolutionComplete = lookup.IsComplete;
                    resolutionBoundExceeded = !lookup.IsComplete;
                    if (lookup.IsComplete && access.User != null)
                    {
                        var candidateIds = itemMap.Values
                            .SelectMany(candidates => candidates)
                            .Select(candidate => candidate.ItemId)
                            .Distinct()
                            .ToList();
                        accessibleIds = _itemLookup.GetAccessibleItemIdsBatch(
                            candidateIds,
                            access.User);
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(
                    "Jellyfin library access resolution failed for download activity: {Message}",
                    ex.Message);
                itemMap = new Dictionary<(string, string), IReadOnlyList<ItemLookupCandidate>>();
                resolutionComplete = false;
                resolutionBoundExceeded = false;
            }

            var authorized = new List<ArrAuthorizedRecord>();
            foreach (var entry in records)
            {
                var record = entry.Record;
                var seerrAssociated = IsSeerrAssociated(record, access);
                var candidate = ResolveAccessibleCandidate(
                    record,
                    itemMap,
                    accessibleIds,
                    out var requiresAccessibleLibraryCandidate);
                var visibleRecord = access.IsAdmin && candidate == null
                    ? MinimizeUnmappedAdminRecord(record)
                    : record;
                // A Seerr association proves request scope, not Jellyfin library scope.
                // Full metadata is safe for a regular user only after a complete lookup
                // and any required Jellyfin candidate is accessible to the caller.
                // Exact episodes always require their own accessible Episode candidate.
                var libraryScopeSafe = resolutionComplete
                    && (!requiresAccessibleLibraryCandidate || candidate != null);
                var allowed = access.IsAdmin
                    || (libraryScopeSafe
                        && (access.FilterByUserRequests
                            ? seerrAssociated
                            : seerrAssociated || candidate != null));
                if (!allowed)
                {
                    continue;
                }

                authorized.Add(new ArrAuthorizedRecord
                {
                    Record = visibleRecord,
                    IsQueue = entry.IsQueue,
                    SeerrAssociated = seerrAssociated,
                    JellyfinItemId = candidate?.ItemId,
                    JellyfinAvailable = candidate?.HasMediaFile == true,
                });
            }

            return new AuthorizationResult(
                authorized,
                resolutionComplete,
                resolutionBoundExceeded);
        }

        internal static bool TryCollectProviderPairs(
            IEnumerable<ArrDownloadActivityRecord> records,
            int maxProviderPairs,
            out HashSet<(string Provider, string Value)> providerPairs)
        {
            providerPairs = new HashSet<(string, string)>();
            if (maxProviderPairs < 1)
            {
                return false;
            }

            foreach (var provider in records.SelectMany(record => record.Providers))
            {
                providerPairs.Add((provider.Provider, provider.Value));
                if (providerPairs.Count > maxProviderPairs)
                {
                    providerPairs.Clear();
                    return false;
                }
            }

            return true;
        }

        private static ArrDownloadActivityRecord MinimizeUnmappedAdminRecord(
            ArrDownloadActivityRecord record)
            => record with
            {
                // The client renders the existing localized Unknown label for an empty title.
                Title = string.Empty,
                Subtitle = null,
                TmdbId = null,
                TvdbId = null,
                SeasonNumber = null,
                EpisodeNumber = null,
                Providers = Array.Empty<ArrActivityProvider>(),
            };

        private static ItemLookupCandidate? ResolveAccessibleCandidate(
            ArrDownloadActivityRecord record,
            IReadOnlyDictionary<(string Provider, string Value), IReadOnlyList<ItemLookupCandidate>> itemMap,
            IReadOnlySet<Guid> accessibleIds,
            out bool requiresAccessibleLibraryCandidate)
        {
            var exactEpisode = IsExactEpisodeRecord(record);
            var candidates = record.Providers
                .SelectMany(provider => itemMap.TryGetValue(
                    (provider.Provider, provider.Value),
                    out var matches)
                        ? matches.Where(candidate => candidate.Kind == provider.Kind)
                        : Array.Empty<ItemLookupCandidate>())
                .DistinctBy(candidate => candidate.ItemId)
                .ToList();

            // Jellyfin access can be narrower for one episode than for its parent
            // series. An exact Sonarr episode must therefore resolve through an
            // episode candidate; an accessible series is correlation context, not
            // authorization for the episode's title, number, or availability.
            if (exactEpisode)
            {
                candidates = candidates
                    .Where(candidate => candidate.Kind == ItemLookupKind.Episode)
                    .ToList();
            }

            // A series-level Seerr association cannot prove access to one exact
            // episode. If Jellyfin cannot positively resolve that episode, fail
            // closed instead of interpreting a missing provider/candidate as proof
            // that the episode is not yet present.
            requiresAccessibleLibraryCandidate = exactEpisode || candidates.Count != 0;
            return candidates
                .Where(candidate => accessibleIds.Contains(candidate.ItemId))
                .OrderByDescending(candidate => candidate.HasMediaFile)
                .ThenBy(candidate => candidate.Kind == ItemLookupKind.Episode ? 0 : 1)
                .ThenBy(candidate => candidate.ItemId)
                .FirstOrDefault();
        }

        private static bool IsExactEpisodeRecord(ArrDownloadActivityRecord record)
            => string.Equals(record.MediaType, "tv", StringComparison.Ordinal)
                && (record.HasEpisodeDetail
                    || record.EpisodeNumber.HasValue
                    || record.Providers.Any(provider =>
                        provider.Kind == ItemLookupKind.Episode)
                    || record.EntityKey.StartsWith(
                        "episode:",
                        StringComparison.Ordinal));

        internal static bool IsSeerrAssociated(
            ArrDownloadActivityRecord record,
            ArrDownloadAccessContext access)
        {
            if (!access.SeerrScopeComplete
                || !access.SeerrArrScopes.Contains((record.Source, record.InstanceId)))
            {
                return false;
            }

            var tmdbMatch = record.TmdbId.HasValue
                && access.SeerrRequests.Contains((record.TmdbId.Value, record.MediaType));
            var tvdbMatch = record.MediaType == "tv"
                && record.TvdbId.HasValue
                && access.SeerrTvTvdbIds.Contains(record.TvdbId.Value);
            return tmdbMatch || tvdbMatch;
        }

        /// <summary>
        /// Returns the only ARR scopes for which a media-id association can be source-safe
        /// without an explicit Seerr-server-to-ARR-instance mapping. Multiple Seerr identity
        /// domains or multiple enabled instances of the same service are ambiguous and
        /// deliberately produce no scope for that service.
        /// </summary>
        internal static IReadOnlySet<(string Source, string InstanceId)> GetUnambiguousSeerrArrScopes(
            PluginConfiguration config,
            int configuredSeerrSourceCount)
        {
            var scopes = new HashSet<(string, string)>();
            if (configuredSeerrSourceCount != 1)
            {
                return scopes;
            }

            AddUnambiguousScope(
                scopes,
                "Sonarr",
                config.GetEnabledSonarrInstances(),
                config.IsSonarrInstancesCorrupt()
                    || config.HasInvalidEnabledSonarrInstances());
            AddUnambiguousScope(
                scopes,
                "Radarr",
                config.GetEnabledRadarrInstances(),
                config.IsRadarrInstancesCorrupt()
                    || config.HasInvalidEnabledRadarrInstances());
            return scopes;
        }

        private static void AddUnambiguousScope(
            ISet<(string Source, string InstanceId)> scopes,
            string source,
            IReadOnlyList<ArrInstance> enabledInstances,
            bool invalidConfiguration)
        {
            if (invalidConfiguration || enabledInstances.Count != 1)
            {
                return;
            }

            var instanceId = ArrIdHelper.GetStableInstanceId(enabledInstances[0]);
            if (!string.IsNullOrWhiteSpace(instanceId))
            {
                scopes.Add((source, instanceId));
            }
        }

        internal static ArrDownloadActivityDto? ApplyVisibility(
            ArrDownloadActivityDto item,
            ArrDownloadAccessContext access)
        {
            if (access.IsAdmin)
            {
                return item;
            }

            if (item.Section == ArrDownloadSections.Downloading && !access.AllowActive)
            {
                return null;
            }

            if (item.Section == ArrDownloadSections.Processing && !access.AllowProcessing)
            {
                return null;
            }

            if (item.Section == ArrDownloadSections.History && !access.AllowHistory)
            {
                return null;
            }

            var clone = Clone(item);
            if (!access.AllowProvenance)
            {
                clone.Provenance = null;
            }

            if (!access.AllowWarnings
                && clone.Lifecycle is ArrDownloadLifecycles.Attention
                    or ArrDownloadLifecycles.Warning
                    or ArrDownloadLifecycles.Failed)
            {
                clone.Lifecycle = clone.Section == ArrDownloadSections.History
                    ? ArrDownloadLifecycles.Unknown
                    : ArrDownloadLifecycles.WaitingForImport;
                clone.ReasonCode = null;
            }

            if (!access.DetailedLifecycle)
            {
                clone.Lifecycle = clone.Section switch
                {
                    ArrDownloadSections.Downloading => ArrDownloadLifecycles.Downloading,
                    ArrDownloadSections.Processing
                        when clone.Lifecycle is ArrDownloadLifecycles.Attention
                            or ArrDownloadLifecycles.Warning
                            or ArrDownloadLifecycles.Failed
                        => access.AllowWarnings
                            ? ArrDownloadLifecycles.Attention
                            : ArrDownloadLifecycles.WaitingForImport,
                    ArrDownloadSections.Processing => ArrDownloadLifecycles.WaitingForImport,
                    _ => clone.Lifecycle,
                };
                if (clone.Lifecycle != ArrDownloadLifecycles.Attention)
                {
                    clone.ReasonCode = null;
                }
            }

            return clone;
        }

        private static ArrDownloadActivityDto Clone(ArrDownloadActivityDto source)
            => new()
            {
                Id = source.Id,
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

        private static bool MatchesSearch(ArrDownloadActivityDto item, string search)
        {
            if (string.IsNullOrWhiteSpace(search))
            {
                return true;
            }

            var needle = search.Trim();
            return item.Title.Contains(needle, StringComparison.OrdinalIgnoreCase)
                || (item.Subtitle?.Contains(needle, StringComparison.OrdinalIgnoreCase) ?? false)
                || item.InstanceName.Contains(needle, StringComparison.OrdinalIgnoreCase)
                || item.Source.Contains(needle, StringComparison.OrdinalIgnoreCase)
                || item.Lifecycle.Contains(needle, StringComparison.OrdinalIgnoreCase);
        }

        private static IReadOnlyList<ArrActivityProvider> BuildProviders(
            bool sonarr,
            int? tmdbId,
            int? tvdbId,
            int? episodeTvdbId)
        {
            var providers = new List<ArrActivityProvider>();
            if (sonarr)
            {
                AddProvider(providers, "Tvdb", episodeTvdbId, ItemLookupKind.Episode);
                AddProvider(providers, "Tvdb", tvdbId, ItemLookupKind.Series);
                AddProvider(providers, "Tmdb", tmdbId, ItemLookupKind.Series);
            }
            else
            {
                AddProvider(providers, "Tmdb", tmdbId, ItemLookupKind.Movie);
            }

            return providers;
        }

        private static void AddProvider(
            ICollection<ArrActivityProvider> providers,
            string provider,
            int? value,
            ItemLookupKind kind)
        {
            var normalized = ArrIdHelper.ToProviderValue(value);
            if (normalized != null)
            {
                providers.Add(new ArrActivityProvider(provider, normalized, kind));
            }
        }

        private static string DetermineSourceState(
            bool queueFailed,
            bool historyFailed,
            InstanceCache cache,
            bool historyTruncated,
            DateTimeOffset now)
        {
            if (!queueFailed && !historyFailed)
            {
                return historyTruncated
                    ? ArrDownloadSourceStates.Truncated
                    : ArrDownloadSourceStates.Fresh;
            }

            var queueUsable = !queueFailed
                || cache.QueueCapturedAt.HasValue
                    && now - cache.QueueCapturedAt.Value <= StaleSnapshotLifetime;
            var historyUsable = !historyFailed
                || cache.HistoryCapturedAt.HasValue
                    && now - cache.HistoryCapturedAt.Value <= StaleSnapshotLifetime;
            if (queueUsable && historyUsable)
            {
                return ArrDownloadSourceStates.Stale;
            }

            var error = string.Concat(cache.LastQueueError, " ", cache.LastHistoryError);
            return error.Contains("invalid", StringComparison.OrdinalIgnoreCase)
                || error.Contains("incomplete", StringComparison.OrdinalIgnoreCase)
                || error.Contains("limit", StringComparison.OrdinalIgnoreCase)
                || error.Contains("advance", StringComparison.OrdinalIgnoreCase)
                ? ArrDownloadSourceStates.Incomplete
                : error.Contains("URL rejected", StringComparison.OrdinalIgnoreCase)
                    ? ArrDownloadSourceStates.Configuration
                    : ArrDownloadSourceStates.Unavailable;
        }

        private static DateTimeOffset? OldestCapture(InstanceCache cache)
        {
            if (!cache.QueueCapturedAt.HasValue)
            {
                return cache.HistoryCapturedAt;
            }

            if (!cache.HistoryCapturedAt.HasValue)
            {
                return cache.QueueCapturedAt;
            }

            return cache.QueueCapturedAt.Value <= cache.HistoryCapturedAt.Value
                ? cache.QueueCapturedAt
                : cache.HistoryCapturedAt;
        }

        private static void AddConfigurationStatus(
            ICollection<ArrDownloadSourceStatusDto> sources,
            string source,
            bool corrupt,
            int configuredCount,
            int enabledCount)
        {
            if (!corrupt && (configuredCount == 0 || enabledCount > 0))
            {
                return;
            }

            sources.Add(new ArrDownloadSourceStatusDto
            {
                Source = source,
                InstanceId = string.Concat(source.ToLowerInvariant(), "-configuration"),
                InstanceName = source,
                State = ArrDownloadSourceStates.Configuration,
                CapturedAt = null,
            });
        }

        private static int LifecycleSortPriority(string lifecycle)
            => lifecycle switch
            {
                ArrDownloadLifecycles.Attention => 100,
                ArrDownloadLifecycles.Failed => 95,
                ArrDownloadLifecycles.Warning => 90,
                ArrDownloadLifecycles.Unknown => 80,
                ArrDownloadLifecycles.WaitingForImport => 70,
                ArrDownloadLifecycles.ImportPending => 60,
                ArrDownloadLifecycles.Importing => 50,
                ArrDownloadLifecycles.Delayed => 40,
                ArrDownloadLifecycles.Paused => 30,
                _ => 0,
            };

        private void PruneCache(DateTimeOffset now, IReadOnlySet<string> activeKeys)
        {
            foreach (var pair in _cache)
            {
                if (!activeKeys.Contains(pair.Key)
                    && (!pair.Value.LastAttemptAt.HasValue
                        || now - pair.Value.LastAttemptAt.Value > StaleSnapshotLifetime))
                {
                    _cache.TryRemove(pair.Key, out _);
                }
            }

            if (_cache.Count <= MaxCachedInstances)
            {
                return;
            }

            foreach (var key in _cache
                .Where(pair => !activeKeys.Contains(pair.Key))
                .OrderBy(pair => pair.Value.LastAttemptAt ?? DateTimeOffset.MinValue)
                .Take(_cache.Count - MaxCachedInstances)
                .Select(pair => pair.Key)
                .ToList())
            {
                _cache.TryRemove(key, out _);
            }
        }

        private static string ConfigurationFingerprint(
            string source,
            ArrInstance instance,
            int historyDays)
        {
            var material = string.Concat(
                source,
                "\0",
                instance.Url?.Trim(),
                "\0",
                instance.ApiKey?.Trim(),
                "\0",
                historyDays.ToString(CultureInfo.InvariantCulture));
            return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(material)));
        }

        private static string? StableJsonIdentity(JsonNode? node)
        {
            if (node == null)
            {
                return null;
            }

            var value = node.ToJsonString();
            return value.Length is > 0 and <= 128 ? value : null;
        }

        private static string? SafeCorrelationId(string? value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return null;
            }

            var trimmed = value.Trim();
            return trimmed.Length <= 512 && !trimmed.Any(char.IsControl)
                ? trimmed
                : null;
        }

        private static string SafeEnum(string? value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return string.Empty;
            }

            var trimmed = value.Trim();
            return trimmed.Length <= 64
                && trimmed.All(character => char.IsAsciiLetterOrDigit(character)
                    || character is '_' or '-')
                ? trimmed
                : string.Empty;
        }

        private static string SafeLabel(string? value, string fallback, int maxLength)
            => SafeLabelOrNull(value, maxLength) ?? fallback;

        private static string? SafeLabelOrNull(string? value, int maxLength)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return null;
            }

            var normalized = new string(value
                .Where(character => !char.IsControl(character))
                .Take(maxLength)
                .ToArray())
                .Trim();
            return normalized.Length == 0 ? null : normalized;
        }

        private static string? BuildEpisodeSubtitle(
            int? season,
            int? episode,
            string? title)
        {
            var number = season.HasValue && episode.HasValue
                ? string.Create(CultureInfo.InvariantCulture, $"S{season.Value:D2}E{episode.Value:D2}")
                : null;
            return (number, title) switch
            {
                (null, null) => null,
                (not null, null) => number,
                (null, not null) => title,
                _ => string.Concat(number, " · ", title),
            };
        }

        private static string? SafeYear(int? year)
            => year is >= 1800 and <= 3000
                ? year.Value.ToString(CultureInfo.InvariantCulture)
                : null;

        private static int? ReadInt(JsonNode? node)
            => node is JsonValue value && value.TryGetValue<int>(out var result)
                ? result
                : null;

        private static double? ReadDouble(JsonNode? node)
        {
            if (node is not JsonValue value)
            {
                return null;
            }

            if (value.TryGetValue<double>(out var doubleValue))
            {
                return doubleValue;
            }

            return value.TryGetValue<long>(out var longValue) ? longValue : null;
        }

        private static string? ReadString(JsonNode? node)
            => node is JsonValue value && value.TryGetValue<string>(out var result)
                ? result
                : null;

        private static DateTimeOffset? ReadDate(JsonNode? node)
        {
            var value = ReadString(node);
            return DateTimeOffset.TryParse(
                value,
                CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                out var parsed)
                ? parsed
                : null;
        }

        private sealed record AuthorizationResult(
            List<ArrAuthorizedRecord> Records,
            bool LibraryResolutionComplete,
            bool LibraryResolutionBoundExceeded);

        private sealed record InstanceSnapshot(
            List<ArrDownloadActivityRecord> Queue,
            List<ArrDownloadActivityRecord> History,
            ArrDownloadSourceStatusDto Status,
            bool HistoryTruncated,
            bool ActiveTruncated);

        private sealed record Handoff(
            ArrDownloadActivityRecord Record,
            DateTimeOffset ExpiresAt);

        private sealed class InstanceCache
        {
            public SemaphoreSlim Gate { get; } = new(1, 1);

            public string Fingerprint { get; private set; } = string.Empty;

            public List<ArrDownloadActivityRecord> Queue { get; private set; } = new();

            public DateTimeOffset? QueueCapturedAt { get; private set; }

            public List<ArrDownloadActivityRecord> History { get; set; } = new();

            public DateTimeOffset? HistoryCapturedAt { get; set; }

            public bool HistoryTruncated { get; set; }

            public Dictionary<string, Handoff> Handoffs { get; } = new(StringComparer.Ordinal);

            public DateTimeOffset? HandoffTruncatedUntil { get; private set; }

            public DateTimeOffset? LastAttemptAt { get; set; }

            public string? LastQueueError { get; set; }

            public string? LastHistoryError { get; set; }

            public string LastState { get; set; } = ArrDownloadSourceStates.Unavailable;

            public DateTimeOffset? LastStateCapturedAt { get; set; }

            public bool HasPublishedSnapshot
                => QueueCapturedAt.HasValue || HistoryCapturedAt.HasValue;

            public void Reset(string fingerprint)
            {
                Fingerprint = fingerprint;
                Queue = new List<ArrDownloadActivityRecord>();
                QueueCapturedAt = null;
                History = new List<ArrDownloadActivityRecord>();
                HistoryCapturedAt = null;
                HistoryTruncated = false;
                Handoffs.Clear();
                HandoffTruncatedUntil = null;
                LastAttemptAt = null;
                LastQueueError = null;
                LastHistoryError = null;
                LastState = ArrDownloadSourceStates.Unavailable;
                LastStateCapturedAt = null;
            }

            public void ApplyFreshQueue(
                List<ArrDownloadActivityRecord> fresh,
                IReadOnlyCollection<ArrDownloadActivityRecord> history,
                DateTimeOffset now,
                TimeSpan handoffLifetime)
            {
                if (HandoffTruncatedUntil <= now)
                {
                    HandoffTruncatedUntil = null;
                }

                var currentKeys = fresh
                    .Select(RecordIdentity)
                    .ToHashSet(StringComparer.Ordinal);
                var previousQueue = QueueCapturedAt.HasValue
                    && now - QueueCapturedAt.Value <= StaleSnapshotLifetime
                        ? Queue
                        : Enumerable.Empty<ArrDownloadActivityRecord>();
                var previous = previousQueue
                    .Concat(Handoffs.Values.Select(handoff => handoff.Record))
                    .GroupBy(RecordIdentity, StringComparer.Ordinal)
                    .Select(group => group.First())
                    .ToList();

                foreach (var old in previous)
                {
                    var identity = RecordIdentity(old);
                    if (currentKeys.Contains(identity)
                        || HasTerminalHistory(old, history))
                    {
                        Handoffs.Remove(identity);
                        continue;
                    }

                    if (!Handoffs.TryGetValue(identity, out var existing))
                    {
                        Handoffs[identity] = new Handoff(
                            old with
                            {
                                TransitionPending = true,
                                Stale = true,
                            },
                            now.Add(handoffLifetime));
                    }
                    else if (existing.ExpiresAt <= now)
                    {
                        Handoffs.Remove(identity);
                    }
                }

                foreach (var identity in Handoffs
                    .Where(pair => pair.Value.ExpiresAt <= now
                        || currentKeys.Contains(pair.Key)
                        || HasTerminalHistory(pair.Value.Record, history))
                    .Select(pair => pair.Key)
                    .ToList())
                {
                    Handoffs.Remove(identity);
                }

                if (Handoffs.Count > MaxHandoffRecordsPerInstance)
                {
                    foreach (var identity in Handoffs
                        .OrderByDescending(pair => pair.Value.ExpiresAt)
                        .ThenBy(pair => pair.Key, StringComparer.Ordinal)
                        .Skip(MaxHandoffRecordsPerInstance)
                        .Select(pair => pair.Key)
                        .ToList())
                    {
                        Handoffs.Remove(identity);
                    }

                    HandoffTruncatedUntil = now.Add(handoffLifetime);
                }

                Queue = fresh;
                QueueCapturedAt = now;
            }

            public bool IsHandoffTruncated(DateTimeOffset now)
                => HandoffTruncatedUntil > now;

            public InstanceSnapshot ToSnapshot(
                string source,
                ArrInstance instance,
                DateTimeOffset now)
            {
                var currentInstanceName = SafeLabel(instance.Name, source, 80);
                var queueFreshEnough = QueueCapturedAt.HasValue
                    && now - QueueCapturedAt.Value <= StaleSnapshotLifetime;
                var historyFreshEnough = HistoryCapturedAt.HasValue
                    && now - HistoryCapturedAt.Value <= StaleSnapshotLifetime;
                var staleState = LastState == ArrDownloadSourceStates.Stale;
                var queue = queueFreshEnough
                    ? Queue
                        .Select(record => record with
                        {
                            Instance = instance,
                            InstanceName = currentInstanceName,
                            Stale = staleState || record.Stale,
                        })
                        .Concat(Handoffs.Values
                            .Where(handoff => handoff.ExpiresAt > now)
                            .Select(handoff => handoff.Record with
                            {
                                Instance = instance,
                                InstanceName = currentInstanceName,
                            }))
                        .ToList()
                    : new List<ArrDownloadActivityRecord>();
                var history = historyFreshEnough
                    ? History
                        .Select(record => record with
                        {
                            Instance = instance,
                            InstanceName = currentInstanceName,
                            Stale = staleState || record.Stale,
                        })
                        .ToList()
                    : new List<ArrDownloadActivityRecord>();
                return new InstanceSnapshot(
                    queue,
                    history,
                    new ArrDownloadSourceStatusDto
                    {
                        Source = source,
                        InstanceId = ArrIdHelper.GetStableInstanceId(instance),
                        InstanceName = currentInstanceName,
                        State = LastState,
                        CapturedAt = LastStateCapturedAt,
                    },
                    HistoryTruncated,
                    IsHandoffTruncated(now));
            }

            private static bool HasTerminalHistory(
                ArrDownloadActivityRecord queue,
                IReadOnlyCollection<ArrDownloadActivityRecord> history)
            {
                if (string.IsNullOrEmpty(queue.StrongJobKey)
                    || !queue.OccurredAt.HasValue)
                {
                    return false;
                }

                DateTimeOffset? latestTerminal = null;
                DateTimeOffset? latestGrab = null;
                foreach (var record in history)
                {
                    if (!string.Equals(
                            record.StrongJobKey,
                            queue.StrongJobKey,
                            StringComparison.Ordinal)
                        || !record.OccurredAt.HasValue)
                    {
                        continue;
                    }

                    var occurredAt = record.OccurredAt.Value;
                    switch (SafeEnum(record.HistoryEventType).ToLowerInvariant())
                    {
                        case "grabbed":
                            if (!latestGrab.HasValue || occurredAt > latestGrab.Value)
                            {
                                latestGrab = occurredAt;
                            }

                            break;
                        case "downloadfolderimported":
                        case "downloadfailed":
                        case "downloadignored":
                            if (!latestTerminal.HasValue || occurredAt > latestTerminal.Value)
                            {
                                latestTerminal = occurredAt;
                            }

                            break;
                    }
                }

                // A grab at or after the latest terminal starts a new explicit attempt. The
                // terminal must also be strictly later than this queue observation: equal
                // timestamps are ambiguous, while a terminal before the queue proves an older
                // retry/re-grab attempt even if its new grabbed history marker has not appeared.
                return latestTerminal.HasValue
                    && (!latestGrab.HasValue || latestGrab.Value < latestTerminal.Value)
                    && latestTerminal.Value > queue.OccurredAt.Value;
            }

            private static string RecordIdentity(ArrDownloadActivityRecord record)
                => string.Concat(
                    record.Source,
                    "|",
                    record.InstanceId,
                    "|",
                    record.RecordId);
        }
    }
}
