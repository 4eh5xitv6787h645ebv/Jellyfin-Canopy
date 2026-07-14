using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.ScheduledTasks;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services
{
    // Monitors library additions to automatically add requested media to user watchlists.
    // Queries Seerr API directly to check if added items were requested by users.
    public class WatchlistMonitor : IDisposable
    {
        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;
        private readonly IUserDataManager _userDataManager;
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly UserConfigurationManager _userConfigurationManager;
        private readonly ILogger<WatchlistMonitor> _logger;
        private readonly IPluginConfigProvider _configProvider;
        private readonly Dictionary<string, (List<RequestItemWithUser> Items, DateTime CachedAt)> _requestsCache = new();
        private readonly object _requestsCacheLock = new();
        private readonly ConcurrentDictionary<string, Lazy<Task<List<RequestItemWithUser>?>>> _requestsInFlight = new();
        private readonly object _lifecycleLock = new();
        private readonly HashSet<Task> _activeTasks = new();
        private readonly CancellationTokenSource _lifetimeCts = new();
        private bool _subscribed;
        private bool _disposed;
        private bool _cancellationIssued;
        private bool _lifetimeCtsDisposed;

        public WatchlistMonitor(
            ILibraryManager libraryManager,
            IUserManager userManager,
            IUserDataManager userDataManager,
            IHttpClientFactory httpClientFactory,
            UserConfigurationManager userConfigurationManager,
            ILogger<WatchlistMonitor> logger,
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

        private static TimeSpan GetRequestsCacheTtl()
        {
            return TimeSpan.FromSeconds(30);
        }

        // Initialize and start monitoring library events.
        public void Initialize()
        {
            // Only initialize if the watchlist feature is enabled in plugin configuration.
            var config = _configProvider.ConfigurationOrNull as Configuration.PluginConfiguration;
            if (config == null)
            {
                _logger.LogWarning("[Watchlist] Configuration is null - skipping watchlist monitoring initialization");
                return;
            }

            if (!config.AddRequestedMediaToWatchlist || !config.SeerrEnabled)
            {
                _logger.LogInformation("[Watchlist] Watchlist monitoring is disabled in configuration - not subscribing to library events");
                return;
            }

            // Guard against a second startup-task run double-subscribing (a dashboard "Run" button
            // always exists). The disabled-feature early-return stays ahead of the lock so re-running
            // the task after enabling the feature still subscribes.
            lock (_lifecycleLock)
            {
                if (_disposed || _subscribed) return;
                _libraryManager.ItemAdded += OnItemAdded;
                _libraryManager.ItemUpdated += OnItemUpdated;
                _subscribed = true;
            }
            _logger.LogInformation("[Watchlist] Successfully subscribed to library ItemAdded and ItemUpdated events");
        }

        // Handle library item added events to check if they match pending watchlist items.
        private void OnItemAdded(object? sender, ItemChangeEventArgs e) => ScheduleWatchlistCheck(e, "ItemAdded");

        // Handle library item updated events (fires after metadata refresh) to check if they match pending watchlist items.
        private void OnItemUpdated(object? sender, ItemChangeEventArgs e) => ScheduleWatchlistCheck(e, "ItemUpdated");

        // PERF(S1): ItemAdded/ItemUpdated fire synchronously on Jellyfin's library-scan thread. Do only
        // the cheap Movie/Series reject here, then run the Seerr request lookup + per-user watchlist
        // writes off-thread. (Awaiting ProcessItemForWatchlist is NOT enough: GetAllSeerrRequests
        // returns synchronously on a cache hit, so the continuation would run on the scan thread.)
        // See docs/advanced/performance-rules.md (S1).
        private void ScheduleWatchlistCheck(ItemChangeEventArgs e, string eventType)
        {
            var kind = e.Item?.GetBaseItemKind();
            if (kind != BaseItemKind.Movie && kind != BaseItemKind.Series) return;

            Task task;
            lock (_lifecycleLock)
            {
                if (_disposed) return;

                var cancellationToken = _lifetimeCts.Token;
                task = Task.Run(
                    () => ProcessItemForWatchlist(e, eventType, cancellationToken),
                    CancellationToken.None);
                _activeTasks.Add(task);
            }

            _ = task.ContinueWith(
                completedTask => OnScheduledTaskCompleted(completedTask),
                CancellationToken.None,
                TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
        }

        private void OnScheduledTaskCompleted(Task completedTask)
        {
            // ProcessItemForWatchlist handles operation failures itself. Observe any unexpected
            // scheduling fault here so a fire-and-forget task can never become unobserved.
            if (completedTask.IsFaulted)
            {
                _logger.LogError(
                    completedTask.Exception,
                    "[Watchlist] Unexpected failure in scheduled watchlist processing");
            }

            CancellationTokenSource? ctsToDispose = null;
            lock (_lifecycleLock)
            {
                _activeTasks.Remove(completedTask);
                if (_disposed
                    && _cancellationIssued
                    && _activeTasks.Count == 0
                    && !_lifetimeCtsDisposed)
                {
                    _lifetimeCtsDisposed = true;
                    ctsToDispose = _lifetimeCts;
                }
            }

            ctsToDispose?.Dispose();
        }

        // Deterministic test seam over the same operation scheduled by library events. Keeping
        // scheduling out of authorization tests lets them assert that a rejected projection has
        // completed with zero writes rather than relying on timing a fire-and-forget worker.
        internal Task ProcessItemForWatchlistForTestAsync(
            BaseItem item,
            CancellationToken cancellationToken = default)
            => ProcessItemForWatchlist(
                new ItemChangeEventArgs { Item = item },
                "Test",
                cancellationToken);

        // Process an item from library events to check if it matches any Seerr requests.
        private async Task ProcessItemForWatchlist(
            ItemChangeEventArgs e,
            string eventType,
            CancellationToken cancellationToken)
        {
            try
            {
                cancellationToken.ThrowIfCancellationRequested();

                // Only process movies and TV series - check this first to avoid spam
                var itemKind = e.Item?.GetBaseItemKind();
                if (itemKind != BaseItemKind.Movie && itemKind != BaseItemKind.Series)
                {
                    return;
                }

                // _logger.LogInformation($"[Watchlist] {eventType} event triggered for: {e.Item?.Name ?? "Unknown"} (Type: {itemKind})");

                // Check if watchlist feature is enabled
                var config = _configProvider.ConfigurationOrNull as PluginConfiguration;
                if (config == null)
                {
                    _logger.LogWarning("[Watchlist] Configuration is null");
                    return;
                }

                if (!config.AddRequestedMediaToWatchlist)
                {
                    _logger.LogDebug("[Watchlist] AddRequestedMediaToWatchlist is disabled");
                    return;
                }

                if (!config.SeerrEnabled)
                {
                    _logger.LogDebug("[Watchlist] SeerrEnabled is disabled");
                    return;
                }

                // Everything below prepares a source-bound authorization decision. The complete
                // configuration digest plus monotonic object revision prevents an admin save,
                // including an A→B→A replacement, from authorizing a local write prepared with
                // stale URLs, credentials, ownership, blocklists, or feature settings.
                var configRevision = _configProvider.ConfigurationRevision;
                var configStamp = SeerrMutationConfigStamp.Capture(config, configRevision);

                // Check if item has TMDB ID
                if (e.Item?.ProviderIds == null)
                {
                    _logger.LogDebug($"[Watchlist] [{eventType}] Item has no ProviderIds yet: {e.Item?.Name}");
                    return;
                }

                if (!e.Item.ProviderIds.TryGetValue("Tmdb", out var tmdbIdString))
                {
                    _logger.LogDebug($"[Watchlist] [{eventType}] Item has no TMDB ID yet: {e.Item.Name}");
                    return;
                }

                if (!int.TryParse(tmdbIdString, out var tmdbId) || tmdbId <= 0)
                {
                    // A Tmdb=="0" library item must not auto-add to every 0-tmdb requester's watchlist.
                    _logger.LogWarning($"[Watchlist] Invalid TMDB ID format: {tmdbIdString}");
                    return;
                }

                var mediaType = itemKind == BaseItemKind.Movie ? "movie" : "tv";
                // _logger.LogInformation($"[Watchlist] New {mediaType} added to library: '{e.Item.Name}' (TMDB: {tmdbId})");

                // Query Seerr for one complete snapshot of every request.
                var seerrUrls = Seerr.SeerrClient.GetConfiguredUrls(config.SeerrUrls);
                if (seerrUrls.Length == 0 || string.IsNullOrEmpty(config.SeerrApiKey))
                {
                    _logger.LogWarning("[Watchlist] Seerr URL or API key not configured");
                    return;
                }

                var httpClient = Helpers.Seerr.SeerrHttpHelper.CreateClient(_httpClientFactory);

                // Fetch all requests at once (no X-Api-User header = all requests)
                var allRequests = await GetAllSeerrRequests(
                    httpClient,
                    seerrUrls,
                    config.SeerrApiKey,
                    configRevision,
                    cancellationToken).ConfigureAwait(false);
                cancellationToken.ThrowIfCancellationRequested();
                if (allRequests == null || allRequests.Count == 0)
                {
                    return;
                }

                // Find requests matching this TMDB ID and media type. Every row retained here
                // already carries its normalized source, positive source-local Seerr owner id,
                // and canonical Jellyfin GUID.
                var matchingRequests = allRequests
                    .Where(r => r.TmdbId == tmdbId && r.MediaType == mediaType)
                    .ToList();

                if (matchingRequests.Count == 0)
                {
                    return;
                }

                // A request row's embedded jellyfinUserId is only a claim. Authorize it against a
                // separate, complete and stable user collection from the exact source domain.
                // Seerr ids are source-local, so neither ids nor ownership may cross URL domains.
                var preparedUserSnapshots = await FetchAllUserSnapshotsAsync(
                    httpClient,
                    seerrUrls,
                    config.SeerrApiKey,
                    cancellationToken).ConfigureAwait(false);
                if (!SeerrUserIdentityDomains.TryParse(preparedUserSnapshots, out var preparedDomains))
                {
                    _logger.LogWarning(
                        "[Watchlist] Refusing to update local watchlists because a complete, bijective all-domain Seerr user map was unavailable.");
                    return;
                }

                foreach (var request in matchingRequests)
                {
                    if (!IsExactAuthorizedBinding(preparedDomains, request))
                    {
                        _logger.LogWarning(
                            "[Watchlist] Request owner {SeerrUserId} at {SourceUrl} did not match the authoritative Jellyfin binding; no local watchlists were changed.",
                            request.RequestedBySeerrUserId,
                            request.SourceUrl);
                        return;
                    }
                }

                var usersByNormalizedId = _userManager.GetUsers()
                    .GroupBy(user => user.Id.ToString("N"), StringComparer.OrdinalIgnoreCase)
                    .ToDictionary(group => group.Key, group => group.First(), StringComparer.OrdinalIgnoreCase);

                // filter out users in the import
                // blocklist so a blocked user's existing requests don't keep
                // syncing to their Jellyfin watchlist (defeats admin intent).
                var blockedIds = Helpers.Seerr.SeerrUserImportHelper
                    .GetBlockedUserIds(config.SeerrImportBlockedUsers);

                var requesterIds = matchingRequests
                    .Select(request => request.RequestedByJellyfinUserId)
                    .Where(id => !blockedIds.Contains(id))
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .ToList();

                // Stage every local decision without changing UserItemData or processed-marker
                // files. A later ownership/configuration failure therefore produces zero partial
                // local writes across a multi-requester event.
                var pendingMutations = new List<PendingWatchlistMutation>();
                foreach (var jellyfinUserId in requesterIds)
                {
                    cancellationToken.ThrowIfCancellationRequested();

                    if (!usersByNormalizedId.TryGetValue(jellyfinUserId, out var user))
                    {
                        continue;
                    }

                    // Check if prevention is enabled and item was already processed
                    if (config.PreventWatchlistReAddition)
                    {
                        var processedItems = _userConfigurationManager.GetProcessedWatchlistItems(user.Id);
                        if (processedItems.Items.Any(p => p.TmdbId == tmdbId && p.MediaType == mediaType))
                        {
                            continue; // Skip this user, item was already processed
                        }
                    }

                    var userData = _userDataManager.GetUserData(user, e.Item);
                    if (userData != null && userData.Likes != true)
                    {
                        pendingMutations.Add(new PendingWatchlistMutation(user, userData, addLike: true));
                    }
                    else if (userData != null && userData.Likes == true && config.PreventWatchlistReAddition)
                    {
                        pendingMutations.Add(new PendingWatchlistMutation(user, userData, addLike: false));
                    }
                }

                if (pendingMutations.Count == 0) return;

                // Ownership can be rebound while request rows and local user data are being
                // prepared. Immediately before the first local mutation, obtain another stable,
                // complete all-domain map and require the entire canonical ownership projection
                // to be unchanged. FetchAllSourcesAsync already requires two identical complete
                // pagination scans per domain on each invocation.
                var dispatchUserSnapshots = await FetchAllUserSnapshotsAsync(
                    httpClient,
                    seerrUrls,
                    config.SeerrApiKey,
                    cancellationToken).ConfigureAwait(false);
                if (!SeerrUserIdentityDomains.TryParse(dispatchUserSnapshots, out var dispatchDomains)
                    || !UserIdentityDomainsMatch(preparedDomains, dispatchDomains))
                {
                    _logger.LogWarning(
                        "[Watchlist] Seerr user ownership changed or became incomplete during preparation; no local watchlists were changed.");
                    return;
                }

                // No awaits occur between this final authorization barrier and the local batch.
                // Re-check before each individual write as well so a concurrent admin save is
                // observed at the narrowest available boundary.
                if (!IsCurrentMutationAuthorized(configStamp))
                {
                    _logger.LogWarning(
                        "[Watchlist] Configuration changed during preparation; no local watchlists were changed.");
                    return;
                }

                var addedCount = 0;
                var addedUsers = new List<string>();
                foreach (var pending in pendingMutations)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (!IsCurrentMutationAuthorized(configStamp))
                    {
                        _logger.LogWarning(
                            "[Watchlist] Configuration changed before a local watchlist write; remaining writes were suppressed.");
                        return;
                    }

                    if (pending.AddLike)
                    {
                        pending.UserData.Likes = true;
                        _userDataManager.SaveUserData(
                            pending.User,
                            e.Item,
                            pending.UserData,
                            UserDataSaveReason.UpdateUserRating,
                            cancellationToken);
                        addedCount++;
                        addedUsers.Add(pending.User.Username);

                        if (config.PreventWatchlistReAddition
                            && IsCurrentMutationAuthorized(configStamp))
                        {
                            TryMarkProcessed(pending.User.Id, tmdbId, mediaType, "monitor");
                        }
                    }
                    else if (IsCurrentMutationAuthorized(configStamp))
                    {
                        TryMarkProcessed(pending.User.Id, tmdbId, mediaType, "existing");
                    }
                }

                // Only log if we actually added the item to at least one watchlist
                if (addedCount > 0)
                {
                    _logger.LogInformation($"[Watchlist] ✓ Added '{e.Item.Name}' to watchlist for {string.Join(", ", addedUsers)}");
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                // The lifetime token is cancelled only by Dispose. Shutdown cancellation is an
                // expected completion path and must not be reported as an operation failure.
            }
            catch (Exception ex)
            {
                _logger.LogError($"[Watchlist] Error in ProcessItemForWatchlist: {ex.Message}\nStack trace: {ex.StackTrace}");
            }
        }

        // Serialize the processed-watchlist marker append through the locked RMW primitive so a
        // concurrent scheduled sync (or another event) can't clobber a just-added marker. The
        // in-lock re-check keeps the append idempotent; strict-read corruption is logged + skipped
        // (this runs off the request path in Task.Run — never throw into the scan thread).
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
            catch (Exception ex)
            {
                _logger.LogWarning($"[Watchlist] Failed to record processed marker for user {userId}: {ex.Message}");
            }
        }

        // Get a complete request snapshot from every configured Seerr identity
        // domain. No domain's rows are cached or acted on unless all domains
        // complete independently.
        private async Task<List<RequestItemWithUser>?> GetAllSeerrRequests(
            HttpClient httpClient,
            IReadOnlyList<string> seerrUrls,
            string apiKey,
            long configRevision,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var cacheKey = BuildRequestsCacheKey(seerrUrls, apiKey, configRevision);
            var cacheTtl = GetRequestsCacheTtl();

            lock (_requestsCacheLock)
            {
                if (_requestsCache.TryGetValue(cacheKey, out var cached) &&
                    DateTime.UtcNow - cached.CachedAt < cacheTtl)
                {
                    return cached.Items;
                }
            }

            async Task<List<RequestItemWithUser>?> FetchAsync()
            {
                try
                {
                    var snapshots = await FetchAllRequestsSnapshotsAsync(
                        httpClient,
                        seerrUrls,
                        apiKey,
                        cancellationToken).ConfigureAwait(false);
                    if (!snapshots.IsComplete)
                    {
                        if (snapshots.Error != null)
                        {
                            var error = snapshots.Error;
                            _logger.LogWarning(
                                $"[Watchlist] Failed to fetch a complete request collection from {snapshots.FailedSourceUrl}: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay} — {error.Message}; {snapshots.FailureReason}");
                        }
                        else
                        {
                            _logger.LogWarning(
                                "[Watchlist] Failed to fetch complete request collections from every configured Seerr identity domain: {Reason}",
                                snapshots.FailureReason);
                        }

                        return null;
                    }

                    var items = new List<RequestItemWithUser>();
                    foreach (var snapshot in snapshots.Sources)
                    {
                        foreach (var item in snapshot.Items)
                        {
                            if (!TryParseRequestItemWithUser(snapshot.SourceUrl, item, out var parsed))
                            {
                                _logger.LogWarning(
                                    "[Watchlist] Complete request collection from {Url} contained an invalid row; refusing to cache or act on the multi-source projection.",
                                    snapshot.SourceUrl);
                                return null;
                            }

                            // A valid request from a local/Plex Seerr user has no
                            // Jellyfin id and cannot target a Jellyfin watchlist.
                            if (parsed != null) items.Add(parsed);
                        }
                    }

                    return items;
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    _logger.LogError($"[Watchlist] Error fetching all requests: {ex.Message}");
                    return null;
                }
            }

            async Task<List<RequestItemWithUser>?> FetchAndCacheAsync()
            {
                var fetchedItems = await FetchAsync().ConfigureAwait(false);
                if (fetchedItems != null)
                {
                    // Populate the result cache before the shared task completes.
                    // This closes the completion/removal window in which a new
                    // caller could otherwise start a duplicate fetch.
                    lock (_requestsCacheLock)
                    {
                        _requestsCache[cacheKey] = (fetchedItems, DateTime.UtcNow);
                    }
                }

                return fetchedItems;
            }

            var fetchTask = Helpers.AsyncSingleFlight.GetOrAdd(
                _requestsInFlight,
                cacheKey,
                FetchAndCacheAsync);
            var items = await fetchTask.ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            return items;
        }

        internal static string BuildRequestsCacheKey(
            IEnumerable<string> seerrUrls,
            string apiKey,
            long configRevision)
        {
            var material = new StringBuilder();
            material.Append(configRevision.ToString(CultureInfo.InvariantCulture)).Append('|');
            foreach (var sourceUrl in seerrUrls
                         .Select(SeerrUrlIdentity.Normalize)
                         .Where(static url => url != null)
                         .Select(static url => url!)
                         .Distinct(StringComparer.Ordinal))
            {
                material.Append(sourceUrl.Length.ToString(CultureInfo.InvariantCulture))
                    .Append(':')
                    .Append(sourceUrl);
            }

            // The API key participates in the identity but is never retained in plaintext in a
            // dictionary key, log message, or diagnostic dump.
            material.Append('|')
                .Append(apiKey.Length.ToString(CultureInfo.InvariantCulture))
                .Append(':')
                .Append(apiKey);
            return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(material.ToString())));
        }

        private static string? UserCollectionIdentity(JsonElement item)
            => SeerrPaginationHelper.CanonicalPositiveIntegerPropertyIdentity(item, "id");

        private static Task<SeerrMultiSourceCollectionResult> FetchAllUserSnapshotsAsync(
            HttpClient httpClient,
            IEnumerable<string> seerrUrls,
            string apiKey,
            CancellationToken cancellationToken)
            => SeerrPaginationHelper.FetchAllSourcesAsync(
                httpClient,
                seerrUrls,
                static (url, _, skip) => $"{url}/api/v1/user?take=1000&skip={skip}",
                apiKey,
                apiUserId: null,
                requestedPageSize: 1000,
                UserCollectionIdentity,
                cancellationToken);

        private bool IsCurrentMutationAuthorized(SeerrMutationConfigStamp configStamp)
        {
            try
            {
                var current = _configProvider.ConfigurationOrNull;
                var currentRevision = _configProvider.ConfigurationRevision;
                return current != null
                    && current.SeerrEnabled
                    && current.AddRequestedMediaToWatchlist
                    && configStamp.Matches(current, currentRevision);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(
                    ex,
                    "[Watchlist] Failed to verify the live configuration before a local watchlist mutation.");
                return false;
            }
        }

        private static bool IsExactAuthorizedBinding(
            IReadOnlyList<SeerrUserIdentityDomain> domains,
            RequestItemWithUser request)
        {
            var domain = domains.SingleOrDefault(candidate => string.Equals(
                candidate.SourceUrl,
                request.SourceUrl,
                StringComparison.Ordinal));
            return domain != null
                && domain.SeerrUserIdsByJellyfinUserId.TryGetValue(
                    request.RequestedByJellyfinUserId,
                    out var currentSeerrUserId)
                && string.Equals(
                    currentSeerrUserId,
                    request.RequestedBySeerrUserId,
                    StringComparison.Ordinal);
        }

        private static bool UserIdentityDomainsMatch(
            IReadOnlyList<SeerrUserIdentityDomain> prepared,
            IReadOnlyList<SeerrUserIdentityDomain> dispatch)
        {
            if (prepared.Count != dispatch.Count) return false;
            for (var index = 0; index < prepared.Count; index++)
            {
                var first = prepared[index];
                var second = dispatch[index];
                if (!string.Equals(first.SourceUrl, second.SourceUrl, StringComparison.Ordinal)
                    || first.SeerrUserIdsByJellyfinUserId.Count
                        != second.SeerrUserIdsByJellyfinUserId.Count)
                {
                    return false;
                }

                foreach (var binding in first.SeerrUserIdsByJellyfinUserId)
                {
                    if (!second.SeerrUserIdsByJellyfinUserId.TryGetValue(
                            binding.Key,
                            out var secondSeerrUserId)
                        || !string.Equals(binding.Value, secondSeerrUserId, StringComparison.Ordinal))
                    {
                        return false;
                    }
                }
            }

            return true;
        }

        private static string? RequestCollectionIdentity(JsonElement item)
            => Helpers.Seerr.SeerrPaginationHelper.CanonicalPositiveIntegerPropertyIdentity(item, "id");

        internal static Task<Helpers.Seerr.SeerrPagedCollectionResult> FetchAllRequestsSnapshotAsync(
            HttpClient httpClient,
            IEnumerable<string> seerrUrls,
            string apiKey,
            CancellationToken cancellationToken)
            => Helpers.Seerr.SeerrPaginationHelper.FetchAllAsync(
                httpClient,
                seerrUrls,
                static (url, _, skip) => $"{url}/api/v1/request?take=1000&skip={skip}&sort=added&filter=all",
                apiKey,
                apiUserId: null,
                requestedPageSize: 1000,
                RequestCollectionIdentity,
                cancellationToken);

        internal static Task<Helpers.Seerr.SeerrMultiSourceCollectionResult> FetchAllRequestsSnapshotsAsync(
            HttpClient httpClient,
            IEnumerable<string> seerrUrls,
            string apiKey,
            CancellationToken cancellationToken)
            => Helpers.Seerr.SeerrPaginationHelper.FetchAllSourcesAsync(
                httpClient,
                seerrUrls,
                static (url, _, skip) => $"{url}/api/v1/request?take=1000&skip={skip}&sort=added&filter=all",
                apiKey,
                apiUserId: null,
                requestedPageSize: 1000,
                RequestCollectionIdentity,
                cancellationToken);

        // Parses one request row. A null parsed item with true means a valid
        // request owned by a non-Jellyfin Seerr user; false means malformed.
        private bool TryParseRequestItemWithUser(
            string? sourceUrl,
            JsonElement item,
            out RequestItemWithUser? parsed)
        {
            parsed = null;
            try
            {
                if (item.ValueKind != JsonValueKind.Object
                    || !item.TryGetProperty("type", out var typeElement)
                    || typeElement.ValueKind != JsonValueKind.String)
                {
                    return false;
                }

                var mediaType = typeElement.GetString()?.Trim().ToLowerInvariant();
                if (mediaType != "movie" && mediaType != "tv") return false;

                if (!item.TryGetProperty("media", out var mediaElement)
                    || mediaElement.ValueKind != JsonValueKind.Object
                    || !mediaElement.TryGetProperty("tmdbId", out var tmdbElement)
                    || !tmdbElement.TryGetInt32(out var tmdbId)
                    || tmdbId <= 0)
                {
                    return false;
                }

                if (mediaElement.TryGetProperty("mediaType", out var nestedType))
                {
                    if (nestedType.ValueKind != JsonValueKind.String
                        || !string.Equals(
                            nestedType.GetString()?.Trim(),
                            mediaType,
                            StringComparison.OrdinalIgnoreCase))
                    {
                        return false;
                    }
                }

                var normalizedSourceUrl = SeerrUrlIdentity.Normalize(sourceUrl);
                if (normalizedSourceUrl == null
                    || !item.TryGetProperty("requestedBy", out var requestedByElement)
                    || requestedByElement.ValueKind != JsonValueKind.Object)
                {
                    return false;
                }

                var requestedBySeerrUserId = SeerrPaginationHelper
                    .CanonicalPositiveIntegerPropertyIdentity(requestedByElement, "id");
                if (requestedBySeerrUserId == null) return false;

                if (!requestedByElement.TryGetProperty("jellyfinUserId", out var jellyfinUserIdElement)
                    || jellyfinUserIdElement.ValueKind == JsonValueKind.Null)
                {
                    return true;
                }

                if (jellyfinUserIdElement.ValueKind != JsonValueKind.String) return false;
                var rawRequestedByJellyfinUserId = jellyfinUserIdElement.GetString();
                if (string.IsNullOrWhiteSpace(rawRequestedByJellyfinUserId)) return true;
                var requestedByJellyfinUserId = SeerrPaginationHelper
                    .CanonicalJellyfinUserIdentity(rawRequestedByJellyfinUserId);
                if (requestedByJellyfinUserId == null) return false;

                parsed = new RequestItemWithUser
                {
                    TmdbId = tmdbId,
                    MediaType = mediaType,
                    SourceUrl = normalizedSourceUrl,
                    RequestedBySeerrUserId = requestedBySeerrUserId,
                    RequestedByJellyfinUserId = requestedByJellyfinUserId,
                };
                return true;
            }
            catch (Exception ex)
            {
                _logger.LogDebug($"[Watchlist] Error parsing request item: {ex.Message}");
                return false;
            }
        }


        // Cleanup when the plugin is disposed.
        public void Dispose()
        {
            lock (_lifecycleLock)
            {
                if (_disposed) return;
                _disposed = true;

                if (_subscribed)
                {
                    _logger.LogInformation("[Watchlist] Unsubscribing from library events");
                    _libraryManager.ItemAdded -= OnItemAdded;
                    _libraryManager.ItemUpdated -= OnItemUpdated;
                }

                _subscribed = false;
            }

            // Cancellation runs outside the lifecycle lock because token callbacks are allowed to
            // complete scheduled tasks synchronously. The CTS is disposed only after every task
            // that captured its token has completed.
            _lifetimeCts.Cancel();

            CancellationTokenSource? ctsToDispose = null;
            lock (_lifecycleLock)
            {
                _cancellationIssued = true;
                if (_activeTasks.Count == 0 && !_lifetimeCtsDisposed)
                {
                    _lifetimeCtsDisposed = true;
                    ctsToDispose = _lifetimeCts;
                }
            }

            ctsToDispose?.Dispose();
            GC.SuppressFinalize(this);
        }

        private sealed class PendingWatchlistMutation
        {
            public PendingWatchlistMutation(User user, UserItemData userData, bool addLike)
            {
                User = user;
                UserData = userData;
                AddLike = addLike;
            }

            public User User { get; }

            public UserItemData UserData { get; }

            public bool AddLike { get; }
        }

        // Model for Seerr request items with requesting user
        private sealed class RequestItemWithUser
        {
            public int TmdbId { get; set; }
            public string MediaType { get; set; } = string.Empty;
            public string SourceUrl { get; set; } = string.Empty;
            public string RequestedBySeerrUserId { get; set; } = string.Empty;
            public string RequestedByJellyfinUserId { get; set; } = string.Empty;
        }
    }
}
