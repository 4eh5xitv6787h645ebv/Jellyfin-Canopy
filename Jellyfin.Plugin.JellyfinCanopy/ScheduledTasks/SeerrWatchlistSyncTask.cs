using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;
using Jellyfin.Plugin.JellyfinCanopy.Services;

namespace Jellyfin.Plugin.JellyfinCanopy.ScheduledTasks
{
    // Scheduled task that syncs Seerr watchlist items to Jellyfin watchlist.
    public partial class SeerrWatchlistSyncTask : IScheduledTask
    {
        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;
        private readonly IUserDataManager _userDataManager;
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly Configuration.UserConfigurationManager _userConfigurationManager;
        private readonly ILogger<SeerrWatchlistSyncTask> _logger;
        private readonly IPluginConfigProvider _configProvider;

        public SeerrWatchlistSyncTask(
            ILibraryManager libraryManager,
            IUserManager userManager,
            IUserDataManager userDataManager,
            IHttpClientFactory httpClientFactory,
            Configuration.UserConfigurationManager userConfigurationManager,
            ILogger<SeerrWatchlistSyncTask> logger,
            IPluginConfigProvider configProvider)
        {
            _libraryManager = libraryManager;
            _userManager = userManager;
            _userDataManager = userDataManager;
            _httpClientFactory = httpClientFactory;
            _userConfigurationManager = userConfigurationManager;
            _configProvider = configProvider;
            _logger = logger;
        }

        public string Name => "Sync Watchlist from Seerr to Jellyfin";

        // Persisted scheduler identity: Jellyfin keys trigger customizations by
        // this opaque string, so it stays frozen at its pre-rename value — a
        // renamed key would silently reset every admin-customized schedule.
        public string Key => "JellyfinCanopyJellyseerrWatchlistSync";

        public string Description => "Syncs items from each user's Seerr watchlist to their Jellyfin watchlist.\n\nConfigure the task triggers to run this task periodically for automatic syncing.";

        public string Category => "Jellyfin Canopy";

        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
        {
            return new[]
            {
                new TaskTriggerInfo
                {
                    Type = TaskTriggerInfoType.DailyTrigger,
                    TimeOfDayTicks = TimeSpan.FromHours(3).Ticks
                }
            };
        }

        public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            var config = _configProvider.ConfigurationOrNull;

            if (config == null || !config.SyncSeerrWatchlist || !config.SeerrEnabled)
            {
                _logger.LogInformation("[Seerr→Jellyfin Watchlist Sync] Sync is disabled in plugin configuration.");
                progress?.Report(100);
                return;
            }

            if (string.IsNullOrEmpty(config.SeerrUrls) || string.IsNullOrEmpty(config.SeerrApiKey))
            {
                _logger.LogWarning("[Seerr→Jellyfin Watchlist Sync] Seerr URL or API key not configured.");
                progress?.Report(100);
                return;
            }

            var syncConfigStamp = SeerrMutationConfigStamp.Capture(
                config,
                _configProvider.ConfigurationRevision);

            _logger.LogInformation("[Seerr→Jellyfin Watchlist Sync] Starting Seerr watchlist sync task...");
            progress?.Report(0);

            var urls = Jellyfin.Plugin.JellyfinCanopy.Services.Seerr.SeerrClient
                .GetConfiguredUrls(config.SeerrUrls);

            if (urls.Length == 0)
            {
                _logger.LogWarning("[Seerr→Jellyfin Watchlist Sync] No valid Seerr URL found.");
                progress?.Report(100);
                return;
            }

            var httpClient = Helpers.Seerr.SeerrHttpHelper.CreateClient(_httpClientFactory);

            var userSnapshots = await FetchSeerrUserMapSnapshotsAsync(
                httpClient,
                urls,
                config.SeerrApiKey,
                cancellationToken).ConfigureAwait(false);
            if (!userSnapshots.IsComplete)
            {
                LogIncompleteCollection("user maps", userSnapshots);
                progress?.Report(100);
                return;
            }

            if (!SeerrUserIdentityDomains.TryParse(userSnapshots, out var seerrUserDomains))
            {
                _logger.LogWarning("[Seerr→Jellyfin Watchlist Sync] A complete Seerr user map contained an invalid linked-user row or duplicate identity domain. No changes will be applied.");
                progress?.Report(100);
                return;
            }
            if (seerrUserDomains.All(static domain => domain.SeerrUserIdsByJellyfinUserId.Count == 0))
            {
                _logger.LogWarning("[Seerr→Jellyfin Watchlist Sync] Complete Seerr user maps contained no linked Jellyfin users.");
            }

            // Get all Jellyfin users, then filter out the SeerrImportBlockedUsers
            // so blocked users don't get watchlist sync.
            var blockedIds = Helpers.Seerr.SeerrUserImportHelper
                .GetBlockedUserIds(config.SeerrImportBlockedUsers);
            var allUsers = _userManager.GetUsers().ToList();
            var jellyfinUsers = allUsers
                .Where(u => !blockedIds.Contains(u.Id.ToString().Replace("-", ""), StringComparer.OrdinalIgnoreCase))
                .ToList();
            var skippedBlocked = allUsers.Count - jellyfinUsers.Count;
            if (skippedBlocked > 0)
            {
                _logger.LogInformation($"[Seerr→Jellyfin Watchlist Sync] Skipping {skippedBlocked} blocked user(s) per SeerrImportBlockedUsers");
            }
            _logger.LogInformation($"[Seerr→Jellyfin Watchlist Sync] Found {jellyfinUsers.Count} Jellyfin users (of {allUsers.Count} total)");

            // Build and validate the complete remote input for the whole run before the
            // first local write. A failure on a later user or identity domain must not
            // leave earlier users reconciled from a mixed-authority snapshot.
            var stagedInputs = new Dictionary<Guid, (List<WatchlistItem> WatchlistItems, List<WatchlistItem> RequestItems)>();
            try
            {
                foreach (var jellyfinUser in jellyfinUsers)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    var seerrBindings = SeerrUserIdentityDomains.FindBindings(
                        seerrUserDomains,
                        jellyfinUser.Id.ToString());
                    if (seerrBindings.Count == 0)
                    {
                        continue;
                    }

                    var watchlistItems = new List<WatchlistItem>();
                    var requestItems = new List<WatchlistItem>();
                    foreach (var binding in seerrBindings)
                    {
                        var watchlistSnapshot = await FetchSeerrWatchlistSnapshotAsync(
                            httpClient,
                            binding.SourceUrl,
                            binding.SeerrUserId,
                            config.SeerrApiKey,
                            cancellationToken).ConfigureAwait(false);
                        if (!watchlistSnapshot.IsComplete)
                        {
                            LogIncompleteCollection($"watchlist for {jellyfinUser.Username}", watchlistSnapshot);
                            progress?.Report(100);
                            return;
                        }

                        if (!TryParseWatchlistItems(watchlistSnapshot.Items, out var sourceWatchlistItems))
                        {
                            _logger.LogWarning($"[Seerr→Jellyfin Watchlist Sync] Complete watchlist for {jellyfinUser.Username} from {binding.SourceUrl} contained an invalid row. No changes will be applied for this run.");
                            progress?.Report(100);
                            return;
                        }

                        watchlistItems.AddRange(sourceWatchlistItems);

                        if (!config.AddRequestedMediaToWatchlist)
                        {
                            continue;
                        }

                        var requestSnapshot = await FetchSeerrRequestSnapshotAsync(
                            httpClient,
                            binding.SourceUrl,
                            binding.SeerrUserId,
                            config.SeerrApiKey,
                            cancellationToken).ConfigureAwait(false);
                        if (!requestSnapshot.IsComplete)
                        {
                            // Watchlist + request rows across every identity domain form one
                            // additive input set. Never publish only its complete prefix.
                            LogIncompleteCollection($"requests for {jellyfinUser.Username}", requestSnapshot);
                            progress?.Report(100);
                            return;
                        }

                        if (!TryParseRequestItems(
                                requestSnapshot.Items,
                                binding.SeerrUserId,
                                out var sourceRequestItems))
                        {
                            _logger.LogWarning($"[Seerr→Jellyfin Watchlist Sync] Complete request collection for {jellyfinUser.Username} from {binding.SourceUrl} contained an invalid row. No changes will be applied for this run.");
                            progress?.Report(100);
                            return;
                        }

                        requestItems.AddRange(sourceRequestItems);
                    }

                    stagedInputs.Add(jellyfinUser.Id, (watchlistItems, requestItems));
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogError($"[Seerr→Jellyfin Watchlist Sync] Failed while staging the complete multi-source snapshot: {ex.Message}. No changes will be applied.");
                progress?.Report(100);
                return;
            }

            cancellationToken.ThrowIfCancellationRequested();
            // Remote rows and their owner bindings form one authorization
            // snapshot. Re-prove the complete all-domain identity map after all
            // watchlist/request reads and require exact equality immediately
            // before the first local mutation. A source-local id rebound during
            // staging must invalidate the whole run, not apply B's rows to A.
            var commitUserSnapshots = await FetchSeerrUserMapSnapshotsAsync(
                httpClient,
                urls,
                config.SeerrApiKey,
                cancellationToken).ConfigureAwait(false);
            if (!commitUserSnapshots.IsComplete
                || !SeerrUserIdentityDomains.TryParse(
                    commitUserSnapshots,
                    out var commitUserDomains)
                || !SeerrUserIdentityDomains.AreEquivalent(
                    seerrUserDomains,
                    commitUserDomains))
            {
                _logger.LogWarning(
                    "[Seerr→Jellyfin Watchlist Sync] User ownership changed or could not be revalidated before the local commit. No changes will be applied.");
                progress?.Report(100);
                return;
            }

            var commitConfig = _configProvider.ConfigurationOrNull;
            if (!syncConfigStamp.Matches(
                    commitConfig,
                    _configProvider.ConfigurationRevision)
                || commitConfig?.SeerrEnabled != true
                || !commitConfig.SyncSeerrWatchlist)
            {
                _logger.LogWarning(
                    "[Seerr→Jellyfin Watchlist Sync] Configuration changed while staging the sync. No local changes will be applied.");
                progress?.Report(100);
                return;
            }

            config = commitConfig;
            var totalUsers = jellyfinUsers.Count;
            var processedUsers = 0;
            var totalItemsAdded = 0;

            foreach (var jellyfinUser in jellyfinUsers)
            {
                try
                {
                    _logger.LogInformation($"=================================================================================================================================");
                    _logger.LogInformation($"=================================================================================================================================");

                    _logger.LogInformation($"[Seerr→Jellyfin Watchlist Sync] Processing user: {jellyfinUser.Username}");

                    if (!stagedInputs.TryGetValue(jellyfinUser.Id, out var stagedInput))
                    {
                        _logger.LogWarning($"[Seerr→Jellyfin Watchlist Sync] No Seerr account linked for user: {jellyfinUser.Username}");
                        processedUsers++;
                        progress?.Report((double)processedUsers / totalUsers * 100);
                        continue;
                    }

                    var watchlistItems = stagedInput.WatchlistItems;
                    var requestItems = stagedInput.RequestItems;

                    // This is a local mutation, so it belongs after every required
                    // Seerr collection for the entire run has been proven complete.
                    if (config.PreventWatchlistReAddition)
                    {
                        _userConfigurationManager.CleanupOldProcessedWatchlistItems(jellyfinUser.Id, config.WatchlistMemoryRetentionDays);
                    }

                    // Log consolidated summary
                    var totalItems = watchlistItems.Count + requestItems.Count;
                    if (totalItems > 0)
                    {
                        var parts = new List<string>();
                        if (watchlistItems.Count > 0) parts.Add($"{watchlistItems.Count} watchlist items");
                        if (requestItems.Count > 0) parts.Add($"{requestItems.Count} requests");
                        _logger.LogInformation($"[Seerr→Jellyfin Watchlist Sync] Found {string.Join(", ", parts)} for user: {jellyfinUser.Username}");
                    }
                    else
                    {
                        _logger.LogInformation($"[Seerr→Jellyfin Watchlist Sync] No items found for user: {jellyfinUser.Username}");
                    }

                    var combinedItems = watchlistItems.Concat(requestItems).ToList();

                    // Process each item
                    var itemsAdded = 0;
                    var itemsPending = 0;
                    var alreadyProcessedItems = new List<string>();
                    var alreadyInWatchlistItems = new List<string>();
                    var notInLibraryItems = new List<string>();
                    var processedKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    foreach (var item in combinedItems)
                    {
                        var key = $"{item.MediaType}:{item.TmdbId}";
                        if (!processedKeys.Add(key))
                        {
                            continue;
                        }

                        var result = await ProcessWatchlistItem(
                            jellyfinUser,
                            item,
                            config,
                            CancellationToken.None).ConfigureAwait(false);
                        var itemInfo = $"TMDB: {item.TmdbId}";

                        switch (result)
                        {
                            case WatchlistItemResult.Added:
                                itemsAdded++;
                                totalItemsAdded++;
                                break;
                            case WatchlistItemResult.AddedToPending:
                                itemsPending++;
                                break;
                            case WatchlistItemResult.AlreadyProcessed:
                                alreadyProcessedItems.Add(itemInfo);
                                break;
                            case WatchlistItemResult.AlreadyInWatchlist:
                                alreadyInWatchlistItems.Add(itemInfo);
                                break;
                            case WatchlistItemResult.NotInLibrary:
                                notInLibraryItems.Add(itemInfo);
                                break;
                        }
                    }

                    // Log consolidated results
                    if (alreadyProcessedItems.Count > 0)
                    {
                        _logger.LogDebug($"[Seerr→Jellyfin Watchlist Sync] Items already processed for user {jellyfinUser.Username}: {string.Join(", ", alreadyProcessedItems)}");
                    }
                    if (alreadyInWatchlistItems.Count > 0)
                    {
                        _logger.LogDebug($"[Seerr→Jellyfin Watchlist Sync] Items already in watchlist for user {jellyfinUser.Username}: {string.Join(", ", alreadyInWatchlistItems)}");
                    }
                    if (notInLibraryItems.Count > 0)
                    {
                        _logger.LogDebug($"[Seerr→Jellyfin Watchlist Sync] Items not in library for user {jellyfinUser.Username} (will be auto-added by WatchlistMonitor): {string.Join(", ", notInLibraryItems)}");
                    }

                    _logger.LogInformation($"[Seerr→Jellyfin Watchlist Sync] User {jellyfinUser.Username}: Added {itemsAdded} items to watchlist, {itemsPending} items added to pending watchlist, {alreadyProcessedItems.Count} already processed, {alreadyInWatchlistItems.Count} already in watchlist, {notInLibraryItems.Count} not in library");
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    _logger.LogError($"[Seerr→Jellyfin Watchlist Sync] Error processing user {jellyfinUser.Username}: {ex.Message}");
                }

                processedUsers++;
                var currentProgress = (int)((double)processedUsers / totalUsers * 100);
                progress?.Report(currentProgress);
            }

            _logger.LogInformation($"=================================================================================================================================");
            _logger.LogInformation($"=================================================================================================================================");
            _logger.LogInformation($"[Seerr→Jellyfin Watchlist Sync] Completed. Added {totalItemsAdded} total items across {processedUsers} users");
            progress?.Report(100);
        }

        internal static Task<SeerrPagedCollectionResult> FetchSeerrUserMapSnapshotAsync(
            HttpClient httpClient,
            IEnumerable<string> seerrUrls,
            string apiKey,
            CancellationToken cancellationToken)
        {
            const int pageSize = 1000;
            return SeerrPaginationHelper.FetchAllAsync(
                httpClient,
                seerrUrls,
                static (url, _, skip) => $"{url}/api/v1/user?take={pageSize}&skip={skip}",
                apiKey,
                apiUserId: null,
                requestedPageSize: pageSize,
                JsonIdIdentity,
                cancellationToken);
        }

        internal static Task<SeerrMultiSourceCollectionResult> FetchSeerrUserMapSnapshotsAsync(
            HttpClient httpClient,
            IEnumerable<string> seerrUrls,
            string apiKey,
            CancellationToken cancellationToken)
        {
            const int pageSize = 1000;
            return SeerrPaginationHelper.FetchAllSourcesAsync(
                httpClient,
                seerrUrls,
                static (url, _, skip) => $"{url}/api/v1/user?take={pageSize}&skip={skip}",
                apiKey,
                apiUserId: null,
                requestedPageSize: pageSize,
                JsonIdIdentity,
                cancellationToken);
        }

        internal static Task<SeerrPagedCollectionResult> FetchSeerrWatchlistSnapshotAsync(
            HttpClient httpClient,
            string seerrUrl,
            string seerrUserId,
            string apiKey,
            CancellationToken cancellationToken)
        {
            const int pageSize = 100;
            return SeerrPaginationHelper.FetchAllAsync(
                httpClient,
                new[] { seerrUrl },
                (url, page, _) => $"{url}/api/v1/user/{seerrUserId}/watchlist?take={pageSize}&page={page}",
                apiKey,
                seerrUserId,
                requestedPageSize: pageSize,
                WatchlistIdentity,
                cancellationToken);
        }

        private static bool TryParseWatchlistItems(
            IEnumerable<JsonElement> rows,
            out List<WatchlistItem> items)
        {
            items = new List<WatchlistItem>();
            foreach (var row in rows)
            {
                if (!row.TryGetProperty("tmdbId", out var tmdbId)
                    || !tmdbId.TryGetInt32(out var parsedTmdbId)
                    || parsedTmdbId <= 0
                    || !row.TryGetProperty("mediaType", out var mediaType)
                    || !TryNormalizeMediaType(mediaType, out var normalizedMediaType))
                {
                    return false;
                }

                items.Add(new WatchlistItem
                {
                    TmdbId = parsedTmdbId,
                    MediaType = normalizedMediaType,
                    Title = row.TryGetProperty("title", out var title) && title.ValueKind == JsonValueKind.String
                        ? title.GetString() ?? string.Empty
                        : string.Empty
                });
            }

            return true;
        }

        internal static Task<SeerrPagedCollectionResult> FetchSeerrRequestSnapshotAsync(
            HttpClient httpClient,
            string seerrUrl,
            string seerrUserId,
            string apiKey,
            CancellationToken cancellationToken)
        {
            const int pageSize = 500;
            return SeerrPaginationHelper.FetchAllAsync(
                httpClient,
                new[] { seerrUrl },
                (url, _, skip) => $"{url}/api/v1/request?take={pageSize}&skip={skip}&sort=added&filter=all&requestedBy={Uri.EscapeDataString(seerrUserId)}",
                apiKey,
                seerrUserId,
                requestedPageSize: pageSize,
                JsonIdIdentity,
                cancellationToken);
        }

        private static bool TryParseRequestItems(
            IEnumerable<JsonElement> rows,
            string seerrUserId,
            out List<WatchlistItem> items)
        {
            items = new List<WatchlistItem>();
            foreach (var row in rows)
            {
                if (!TryGetRequestOwnerId(row, out var ownerId)) return false;
                if (!string.Equals(ownerId, seerrUserId, StringComparison.OrdinalIgnoreCase)) continue;
                var parsed = ParseRequestItem(row);
                if (parsed == null) return false;
                items.Add(parsed);
            }

            return true;
        }

        internal static bool HasCompleteValidRequestProjection(
            IEnumerable<JsonElement> rows,
            string seerrUserId)
            => CountCompleteValidRequestProjection(rows, seerrUserId).HasValue;

        internal static int? CountCompleteValidRequestProjection(
            IEnumerable<JsonElement> rows,
            string seerrUserId)
            => TryParseRequestItems(rows, seerrUserId, out var items)
                ? items.Count
                : null;

        private static string? JsonIdIdentity(JsonElement item)
            => SeerrPaginationHelper.CanonicalPositiveIntegerPropertyIdentity(item, "id");

        private static string? WatchlistIdentity(JsonElement item)
        {
            if (item.TryGetProperty("tmdbId", out var tmdbId)
                && tmdbId.TryGetInt32(out var parsedTmdbId)
                && item.TryGetProperty("mediaType", out var mediaType)
                && mediaType.ValueKind == JsonValueKind.String
                && !string.IsNullOrWhiteSpace(mediaType.GetString()))
            {
                return $"{mediaType.GetString()!.Trim().ToLowerInvariant()}:{parsedTmdbId}";
            }

            return JsonIdIdentity(item);
        }

        private void LogIncompleteCollection(string collectionName, SeerrPagedCollectionResult snapshot)
        {
            if (snapshot.Error != null)
            {
                _logger.LogWarning(
                    $"[Seerr→Jellyfin Watchlist Sync] Incomplete {collectionName} from {snapshot.SourceUrl}: code={snapshot.Error.Code} status={snapshot.Error.HttpStatus} cf-ray={snapshot.Error.CfRay} — {snapshot.Error.Message}; {snapshot.FailureReason}. No changes will be applied.");
                return;
            }

            _logger.LogWarning(
                $"[Seerr→Jellyfin Watchlist Sync] Incomplete {collectionName} from {snapshot.SourceUrl ?? "configured URLs"}: {snapshot.FailureReason}. No changes will be applied.");
        }

        private void LogIncompleteCollection(
            string collectionName,
            SeerrMultiSourceCollectionResult snapshots)
        {
            if (snapshots.Error != null)
            {
                var error = snapshots.Error;
                _logger.LogWarning(
                    $"[Seerr→Jellyfin Watchlist Sync] Incomplete {collectionName} from {snapshots.FailedSourceUrl}: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay} — {error.Message}; {snapshots.FailureReason}. No changes will be applied.");
                return;
            }

            _logger.LogWarning(
                $"[Seerr→Jellyfin Watchlist Sync] Incomplete {collectionName} from {snapshots.FailedSourceUrl ?? "configured URLs"}: {snapshots.FailureReason}. No changes will be applied.");
        }

        private static bool TryGetRequestOwnerId(JsonElement requestElement, out string? ownerId)
        {
            ownerId = null;
            // Check common shapes: requestedBy is object with id, or scalar id, or userId
            if (requestElement.TryGetProperty("requestedBy", out var requestedBy))
            {
                if (requestedBy.ValueKind == JsonValueKind.Number && requestedBy.TryGetInt32(out var idNumber))
                {
                    ownerId = idNumber.ToString(System.Globalization.CultureInfo.InvariantCulture);
                    return idNumber > 0;
                }

                if (requestedBy.ValueKind == JsonValueKind.String
                    && TryReadPositiveInt(requestedBy, out var stringId))
                {
                    ownerId = stringId.ToString(System.Globalization.CultureInfo.InvariantCulture);
                    return true;
                }

                if (requestedBy.ValueKind == JsonValueKind.Object && requestedBy.TryGetProperty("id", out var idProp))
                {
                    if (idProp.ValueKind == JsonValueKind.Number && idProp.TryGetInt32(out var objId))
                    {
                        ownerId = objId.ToString(System.Globalization.CultureInfo.InvariantCulture);
                        return objId > 0;
                    }

                    if (idProp.ValueKind == JsonValueKind.String
                        && TryReadPositiveInt(idProp, out var objectStringId))
                    {
                        ownerId = objectStringId.ToString(System.Globalization.CultureInfo.InvariantCulture);
                        return true;
                    }

                    return false;
                }
            }

            return false;
        }

        private static WatchlistItem? ParseRequestItem(JsonElement requestElement)
        {
            // Prefer media.tmdbId / media.mediaType, fallback to top-level tmdbId/mediaType
            int tmdbId = 0;
            string? mediaType = null;
            string title = "";

            if (requestElement.TryGetProperty("media", out var media))
            {
                if (media.ValueKind != JsonValueKind.Object) return null;
                if (media.TryGetProperty("tmdbId", out var tmdbProp))
                {
                    if (!TryReadPositiveInt(tmdbProp, out tmdbId)) return null;
                }
                if (!TryMergeMediaType(media, "mediaType", ref mediaType))
                {
                    return null;
                }
                if (media.TryGetProperty("title", out var titleProp) && titleProp.ValueKind == JsonValueKind.String)
                {
                    title = titleProp.GetString() ?? "";
                }
            }

            if (requestElement.TryGetProperty("tmdbId", out var topTmdb))
            {
                if (!TryReadPositiveInt(topTmdb, out var topTmdbId)) return null;
                if (tmdbId > 0 && tmdbId != topTmdbId) return null;
                tmdbId = topTmdbId;
            }

            if (!TryMergeMediaType(requestElement, "mediaType", ref mediaType)
                || !TryMergeMediaType(requestElement, "type", ref mediaType))
            {
                return null;
            }

            if (string.IsNullOrWhiteSpace(title) && requestElement.TryGetProperty("title", out var topTitle) && topTitle.ValueKind == JsonValueKind.String)
            {
                title = topTitle.GetString() ?? "";
            }

            if (tmdbId <= 0 || mediaType == null)
            {
                return null;
            }

            return new WatchlistItem
            {
                TmdbId = tmdbId,
                MediaType = mediaType,
                Title = title
            };
        }

        private static bool TryNormalizeMediaType(JsonElement value, out string normalized)
        {
            normalized = string.Empty;
            if (value.ValueKind != JsonValueKind.String) return false;
            normalized = value.GetString()?.Trim().ToLowerInvariant() ?? string.Empty;
            return normalized is "movie" or "tv";
        }

        private static bool TryReadPositiveInt(JsonElement value, out int parsed)
        {
            parsed = 0;
            if (value.ValueKind == JsonValueKind.Number)
            {
                return value.TryGetInt32(out parsed) && parsed > 0;
            }

            return value.ValueKind == JsonValueKind.String
                && int.TryParse(
                    value.GetString(),
                    System.Globalization.NumberStyles.None,
                    System.Globalization.CultureInfo.InvariantCulture,
                    out parsed)
                && parsed > 0;
        }

        private static bool TryMergeMediaType(
            JsonElement owner,
            string propertyName,
            ref string? mediaType)
        {
            if (!owner.TryGetProperty(propertyName, out var value)) return true;
            if (!TryNormalizeMediaType(value, out var candidate)) return false;
            if (mediaType != null && !string.Equals(mediaType, candidate, StringComparison.Ordinal)) return false;
            mediaType = candidate;
            return true;
        }

        private enum WatchlistItemResult
        {
            Added,
            AddedToPending,
            AlreadyInWatchlist,
            AlreadyProcessed,
            NotInLibrary,
            Skipped
        }

        /// <summary>
        /// Whether a Jellyfin item's TMDB provider-id string matches the watchlist item's TMDB id.
        /// A watchlist item with no real TMDB id (absent → 0, or an explicit 0 for an unknown-provider
        /// entry) matches NOTHING — otherwise it would "like" a Jellyfin item stored with
        /// ProviderIds["Tmdb"]=="0" (an unknown-provider placeholder). Mirrors the WatchlistMonitor
        /// drop-zero guard, routed through ArrIdHelper.
        /// </summary>
        internal static bool MatchesTmdb(string? itemTmdbId, int watchlistTmdbId)
        {
            var wanted = ArrIdHelper.ToNullableId(watchlistTmdbId);
            return wanted.HasValue
                && string.Equals(
                    itemTmdbId,
                    wanted.Value.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    StringComparison.Ordinal);
        }

        private Task<WatchlistItemResult> ProcessWatchlistItem(
            JUser user,
            WatchlistItem watchlistItem,
            PluginConfiguration config,
            CancellationToken cancellationToken)
        {
            try
            {
                cancellationToken.ThrowIfCancellationRequested();

                // Drop items with no real TMDB id (absent → 0, or an explicit 0) before matching or
                // recording them: a 0 would otherwise key the processed-items check and match a
                // Jellyfin item stored with ProviderIds["Tmdb"]=="0", liking the wrong item.
                if (ArrIdHelper.ToNullableId(watchlistItem.TmdbId) == null)
                {
                    return Task.FromResult(WatchlistItemResult.Skipped);
                }

                if (config.PreventWatchlistReAddition)
                {
                    // Check if this item was already processed for this user
                    var processedItems = _userConfigurationManager.GetProcessedWatchlistItems(user.Id);
                    if (processedItems.Items.Any(p => p.TmdbId == watchlistItem.TmdbId && p.MediaType == watchlistItem.MediaType))
                    {
                        return Task.FromResult(WatchlistItemResult.AlreadyProcessed);
                    }
                }

                // Determine Jellyfin item type based on Seerr media type
                var itemType = watchlistItem.MediaType == "movie" ? BaseItemKind.Movie : BaseItemKind.Series;

                // Find the item in Jellyfin library by TMDB ID
                var items = _libraryManager.GetItemList(new InternalItemsQuery
                {
                    IncludeItemTypes = new[] { itemType },
                    HasTmdbId = true,
                    Recursive = true
                });

                var item = items.FirstOrDefault(i =>
                    i.ProviderIds != null
                    && i.ProviderIds.TryGetValue("Tmdb", out var tmdbId)
                    && MatchesTmdb(tmdbId, watchlistItem.TmdbId));

                if (item == null)
                {
                    // Item not in library yet - WatchlistMonitor will automatically add it when it arrives
                    return Task.FromResult(WatchlistItemResult.NotInLibrary);
                }

                // Get user data
                var userData = _userDataManager.GetUserData(user, item);
                if (userData == null)
                {
                    _logger.LogWarning($"[Seerr→Jellyfin Watchlist Sync] User data is null for item {item.Name}; skipping.");
                    return Task.FromResult(WatchlistItemResult.Skipped);
                }

                // Check if already in watchlist
                if (userData.Likes == true)
                {
                    // Mark as processed if prevention is enabled and not already marked
                    if (config.PreventWatchlistReAddition)
                    {
                        TryMarkProcessed(user.Id, watchlistItem.TmdbId, watchlistItem.MediaType, "existing");
                    }

                    return Task.FromResult(WatchlistItemResult.AlreadyInWatchlist);
                }

                // Add to watchlist
                userData.Likes = true;
                _userDataManager.SaveUserData(
                    user,
                    item,
                    userData,
                    UserDataSaveReason.UpdateUserRating,
                    cancellationToken);

                // Mark as processed if prevention is enabled
                if (config.PreventWatchlistReAddition)
                {
                    TryMarkProcessed(user.Id, watchlistItem.TmdbId, watchlistItem.MediaType, "sync");
                }

                _logger.LogInformation($"[Seerr→Jellyfin Watchlist Sync] ✓ Added to watchlist: {item.Name} for user {user.Username}");
                return Task.FromResult(WatchlistItemResult.Added);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogError($"[Seerr→Jellyfin Watchlist Sync] Error processing watchlist item: {ex.Message}");
                return Task.FromResult(WatchlistItemResult.Skipped);
            }
        }

        // Serialize the processed-watchlist marker append through the locked RMW primitive so this
        // scheduled task can't clobber a marker the event monitor just added (or vice versa). The
        // in-lock re-check keeps the append idempotent; strict-read quarantine is skipped silently
        // so a single corrupt user file can't fail the whole sync task.
        private void TryMarkProcessed(Guid userId, int tmdbId, string mediaType, string source)
        {
            try
            {
                _userConfigurationManager.RmwProcessedWatchlistItems(userId, items =>
                {
                    if (items.Items.Any(p => p.TmdbId == tmdbId && p.MediaType == mediaType))
                    {
                        return 0;
                    }

                    items.Items.Add(new ProcessedWatchlistItem
                    {
                        TmdbId = tmdbId,
                        MediaType = mediaType,
                        ProcessedAt = System.DateTime.UtcNow,
                        Source = source
                    });
                    return 1;
                });
            }
            catch (UserStoreUnhealthyException)
            {
                // The durable generation was logged once when quarantined.
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"[Seerr→Jellyfin Watchlist Sync] Failed to record processed marker for user {userId}: {ex.Message}");
            }
        }

        private class WatchlistItem
        {
            public int TmdbId { get; set; }
            public string MediaType { get; set; } = "";
            public string Title { get; set; } = "";
        }
    }
}
