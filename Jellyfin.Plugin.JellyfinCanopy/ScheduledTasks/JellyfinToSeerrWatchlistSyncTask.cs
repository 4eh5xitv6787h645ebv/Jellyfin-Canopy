using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;
using Jellyfin.Plugin.JellyfinCanopy.Services;

namespace Jellyfin.Plugin.JellyfinCanopy.ScheduledTasks
{
    // Scheduled task that syncs Jellyfin watchlist items to Seerr watchlist.
    public class JellyfinToSeerrWatchlistSyncTask : IScheduledTask
    {
        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;
        private readonly IUserDataManager _userDataManager;
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly Configuration.UserConfigurationManager _userConfigurationManager;
        private readonly ILogger<JellyfinToSeerrWatchlistSyncTask> _logger;
        private readonly IPluginConfigProvider _configProvider;

        public JellyfinToSeerrWatchlistSyncTask(
            ILibraryManager libraryManager,
            IUserManager userManager,
            IUserDataManager userDataManager,
            IHttpClientFactory httpClientFactory,
            Configuration.UserConfigurationManager userConfigurationManager,
            ILogger<JellyfinToSeerrWatchlistSyncTask> logger,
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

        public string Name => "Sync Watchlist from Jellyfin to Seerr";

        public string Key => "JellyfinCanopyJellyfinToSeerrWatchlistSync";

        public string Description => "Syncs items from each user's Jellyfin watchlist to their Seerr watchlist.\n\nConfigure the task triggers to run this task periodically for automatic syncing.";

        public string Category => "Jellyfin Canopy";

        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
        {
            return new[]
            {
                new TaskTriggerInfo
                {
                    Type = TaskTriggerInfoType.DailyTrigger,
                    TimeOfDayTicks = TimeSpan.FromHours(3).Ticks + TimeSpan.FromMinutes(30).Ticks
                }
            };
        }

        public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            var config = _configProvider.ConfigurationOrNull;

            if (config == null)
            {
                _logger.LogInformation("[Jellyfin→Seerr Watchlist Sync] Sync is disabled in plugin configuration.");
                progress?.Report(100);
                return;
            }

            // Bind every later write to the exact configuration object and
            // contents observed at task start. The revision additionally
            // detects a transient A→B→A replacement during staging.
            var mutationConfigStamp = SeerrMutationConfigStamp.Capture(
                config,
                _configProvider.ConfigurationRevision);
            var initialApiKey = config.SeerrApiKey;

            if (!config.SyncJellyfinWatchlistToSeerr || !config.SeerrEnabled)
            {
                _logger.LogInformation("[Jellyfin→Seerr Watchlist Sync] Sync is disabled in plugin configuration.");
                progress?.Report(100);
                return;
            }

            if (string.IsNullOrEmpty(config.SeerrUrls) || string.IsNullOrEmpty(initialApiKey))
            {
                _logger.LogWarning("[Jellyfin→Seerr Watchlist Sync] Seerr URL or API key not configured.");
                progress?.Report(100);
                return;
            }

            _logger.LogInformation("[Jellyfin→Seerr Watchlist Sync] Starting sync task...");
            progress?.Report(0);

            var urls = Jellyfin.Plugin.JellyfinCanopy.Services.Seerr.SeerrClient
                .GetConfiguredUrls(config.SeerrUrls);

            if (urls.Length == 0)
            {
                _logger.LogWarning("[Jellyfin→Seerr Watchlist Sync] No valid Seerr URL found.");
                progress?.Report(100);
                return;
            }

            var httpClient = Helpers.Seerr.SeerrHttpHelper.CreateClient(_httpClientFactory);

            var userSnapshots = await FetchSeerrUserMapSnapshotsAsync(
                httpClient,
                urls,
                initialApiKey,
                cancellationToken).ConfigureAwait(false);
            if (!userSnapshots.IsComplete)
            {
                LogIncompleteCollection("user maps", userSnapshots);
                progress?.Report(100);
                return;
            }

            if (!SeerrUserIdentityDomains.TryParse(userSnapshots, out var seerrUserDomains))
            {
                _logger.LogWarning("[Jellyfin→Seerr Watchlist Sync] A complete Seerr user map contained an invalid linked-user row or duplicate identity domain. No Seerr mutations will be attempted.");
                progress?.Report(100);
                return;
            }
            if (seerrUserDomains.All(static domain => domain.SeerrUserIdsByJellyfinUserId.Count == 0))
            {
                _logger.LogWarning("[Jellyfin→Seerr Watchlist Sync] Complete Seerr user maps contained no linked Jellyfin users.");
            }

            var blockedIds = Helpers.Seerr.SeerrUserImportHelper
                .GetBlockedUserIds(config.SeerrImportBlockedUsers);
            var allUsers = _userManager.GetUsers().ToList();
            var jellyfinUsers = allUsers
                .Where(u => !blockedIds.Contains(u.Id.ToString().Replace("-", ""), StringComparer.OrdinalIgnoreCase))
                .ToList();

            var skippedBlocked = allUsers.Count - jellyfinUsers.Count;
            if (skippedBlocked > 0)
                _logger.LogInformation($"[Jellyfin→Seerr Watchlist Sync] Skipping {skippedBlocked} blocked user(s)");

            _logger.LogInformation($"[Jellyfin→Seerr Watchlist Sync] Found {jellyfinUsers.Count} Jellyfin users");

            // Pre-fetch all movies and series with TMDB IDs once — shared across users
            var allMovies = _libraryManager.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { BaseItemKind.Movie },
                HasTmdbId = true,
                Recursive = true
            }).Select(i => (item: i, mediaType: "movie"));

            var allSeries = _libraryManager.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { BaseItemKind.Series },
                HasTmdbId = true,
                Recursive = true
            }).Select(i => (item: i, mediaType: "tv"));

            var allLibraryItems = allMovies.Concat(allSeries).ToList();

            // Stage every local watchlist and every source-local absence proof for
            // the whole run before the first Seerr mutation. A failure on a later
            // user or domain therefore cannot produce a mixed-authority sync.
            var stagedInputs = new Dictionary<
                Guid,
                (List<(BaseItem Item, string MediaType, int TmdbId, string Key)> JellyfinWatchlist,
                    List<(SeerrUserBinding Binding, HashSet<string> Keys)> SeerrWatchlists)>();
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

                    var rawJellyfinWatchlist = allLibraryItems
                        .Where(t => _userDataManager.GetUserData(jellyfinUser, t.item)?.Likes == true)
                        .ToList();
                    var jellyfinWatchlist = new List<(
                        BaseItem Item,
                        string MediaType,
                        int TmdbId,
                        string Key)>(rawJellyfinWatchlist.Count);
                    var stagedJellyfinWatchlistKeys = new HashSet<string>(StringComparer.Ordinal);
                    foreach (var (item, mediaType) in rawJellyfinWatchlist)
                    {
                        if (!item.ProviderIds.TryGetValue("Tmdb", out var tmdbIdText)
                            || !int.TryParse(
                                tmdbIdText,
                                NumberStyles.None,
                                CultureInfo.InvariantCulture,
                                out var tmdbId)
                            || tmdbId <= 0)
                        {
                            _logger.LogWarning(
                                $"[Jellyfin→Seerr Watchlist Sync] Liked item {item.Name ?? item.Id.ToString()} for {jellyfinUser.Username} contained an invalid TMDB ID. No Seerr mutations will be attempted for this run.");
                            progress?.Report(100);
                            return;
                        }

                        var key = $"{mediaType}:{tmdbId.ToString(CultureInfo.InvariantCulture)}";
                        if (stagedJellyfinWatchlistKeys.Add(key))
                        {
                            jellyfinWatchlist.Add((item, mediaType, tmdbId, key));
                        }
                    }

                    var stagedWatchlists = new List<(SeerrUserBinding Binding, HashSet<string> Keys)>();

                    if (jellyfinWatchlist.Count > 0)
                    {
                        foreach (var binding in seerrBindings)
                        {
                            var seerrWatchlistSnapshot = await FetchSeerrWatchlistSnapshotAsync(
                                httpClient,
                                binding.SourceUrl,
                                binding.SeerrUserId,
                                initialApiKey,
                                cancellationToken).ConfigureAwait(false);
                            if (!seerrWatchlistSnapshot.IsComplete)
                            {
                                LogIncompleteCollection($"watchlist for {jellyfinUser.Username}", seerrWatchlistSnapshot);
                                progress?.Report(100);
                                return;
                            }

                            if (!TryParseSeerrWatchlist(seerrWatchlistSnapshot.Items, out var seerrWatchlist))
                            {
                                _logger.LogWarning($"[Jellyfin→Seerr Watchlist Sync] Complete watchlist for {jellyfinUser.Username} from {binding.SourceUrl} contained an invalid row. No Seerr mutations will be attempted for this run.");
                                progress?.Report(100);
                                return;
                            }

                            stagedWatchlists.Add((
                                binding,
                                new HashSet<string>(
                                    seerrWatchlist.Select(i => $"{i.MediaType}:{i.TmdbId}"),
                                    StringComparer.OrdinalIgnoreCase)));
                        }
                    }

                    stagedInputs.Add(jellyfinUser.Id, (jellyfinWatchlist, stagedWatchlists));
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogError($"[Jellyfin→Seerr Watchlist Sync] Failed while staging the complete multi-source snapshot: {ex.Message}. No Seerr mutations will be attempted.");
                progress?.Report(100);
                return;
            }

            cancellationToken.ThrowIfCancellationRequested();
            var totalUsers = jellyfinUsers.Count;
            var processedUsers = 0;
            var totalItemsAdded = 0;
            var attemptedMutations = new HashSet<(
                string SourceUrl,
                string SeerrUserId,
                string ItemKey)>();

            foreach (var jellyfinUser in jellyfinUsers)
            {
                cancellationToken.ThrowIfCancellationRequested();

                try
                {
                    _logger.LogInformation($"=================================================================================================================================");
                    _logger.LogInformation($"[Jellyfin→Seerr Watchlist Sync] Processing user: {jellyfinUser.Username}");

                    if (!stagedInputs.TryGetValue(jellyfinUser.Id, out var stagedInput))
                    {
                        _logger.LogWarning($"[Jellyfin→Seerr Watchlist Sync] No Seerr account linked for user: {jellyfinUser.Username}");
                        processedUsers++;
                        progress?.Report((double)processedUsers / totalUsers * 100);
                        continue;
                    }

                    var jellyfinWatchlist = stagedInput.JellyfinWatchlist;

                    _logger.LogInformation($"[Jellyfin→Seerr Watchlist Sync] User {jellyfinUser.Username}: {jellyfinWatchlist.Count} items in Jellyfin watchlist");

                    if (jellyfinWatchlist.Count == 0)
                    {
                        processedUsers++;
                        progress?.Report((double)processedUsers / totalUsers * 100);
                        continue;
                    }

                    var stagedWatchlists = stagedInput.SeerrWatchlists;

                    var itemsAdded = 0;
                    var itemsAlreadyPresent = 0;
                    var itemsSkipped = 0;

                    foreach (var (binding, seerrWatchlistKeys) in stagedWatchlists)
                    {
                        foreach (var (item, mediaType, tmdbId, key) in jellyfinWatchlist)
                        {
                            cancellationToken.ThrowIfCancellationRequested();

                            if (seerrWatchlistKeys.Contains(key))
                            {
                                itemsAlreadyPresent++;
                                continue;
                            }

                            var mutationIdentity = (
                                binding.SourceUrl,
                                binding.SeerrUserId,
                                key);
                            if (attemptedMutations.Contains(mutationIdentity))
                            {
                                itemsSkipped++;
                                continue;
                            }

                            // Re-authorize immediately before the awaited fresh
                            // account lookup, then again after it. The exact user
                            // endpoint proves the source-local numeric id still
                            // belongs to this Jellyfin GUID at commit time.
                            if (!TryAuthorizeMutationConfiguration(
                                    mutationConfigStamp,
                                    initialApiKey,
                                    binding.SourceUrl))
                            {
                                _logger.LogWarning(
                                    "[Jellyfin→Seerr Watchlist Sync] Plugin configuration changed while preparing a watchlist mutation. The run was stopped before dispatch.");
                                progress?.Report(100);
                                return;
                            }

                            var freshBindingIsValid = await HasFreshExactBindingAsync(
                                httpClient,
                                binding.SourceUrl,
                                binding.SeerrUserId,
                                jellyfinUser.Id,
                                initialApiKey,
                                cancellationToken).ConfigureAwait(false);

                            if (!TryAuthorizeMutationConfiguration(
                                    mutationConfigStamp,
                                    initialApiKey,
                                    binding.SourceUrl))
                            {
                                _logger.LogWarning(
                                    "[Jellyfin→Seerr Watchlist Sync] Plugin configuration changed during the final linked-user validation. The run was stopped before dispatch.");
                                progress?.Report(100);
                                return;
                            }

                            if (!freshBindingIsValid)
                            {
                                _logger.LogWarning(
                                    $"[Jellyfin→Seerr Watchlist Sync] Fresh linked-user validation failed for {jellyfinUser.Username} on {binding.SourceUrl}. The run was stopped before dispatch.");
                                progress?.Report(100);
                                return;
                            }

                            // Record the source-local operation before dispatch.
                            // A timeout or dropped response is ambiguous, so this
                            // run must never retry the same mutation.
                            if (!attemptedMutations.Add(mutationIdentity))
                            {
                                itemsSkipped++;
                                continue;
                            }

                            var result = await AddToSeerrWatchlist(
                                httpClient,
                                binding.SourceUrl,
                                binding.SeerrUserId,
                                initialApiKey,
                                tmdbId,
                                mediaType,
                                item.Name ?? string.Empty,
                                cancellationToken).ConfigureAwait(false);

                            if (result == 1)
                            {
                                itemsAdded++;
                                totalItemsAdded++;
                                seerrWatchlistKeys.Add(key);
                                _logger.LogInformation($"[Jellyfin→Seerr Watchlist Sync] ✓ Added to Seerr watchlist: {item.Name} for user {jellyfinUser.Username} on {binding.SourceUrl}");
                            }
                            else if (result == 0)
                            {
                                itemsAlreadyPresent++;
                                seerrWatchlistKeys.Add(key);
                            }
                            else
                            {
                                itemsSkipped++;
                            }
                        }
                    }

                    _logger.LogInformation($"[Jellyfin→Seerr Watchlist Sync] User {jellyfinUser.Username}: Added {itemsAdded}, already present {itemsAlreadyPresent}, skipped {itemsSkipped}");
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    _logger.LogError($"[Jellyfin→Seerr Watchlist Sync] Error processing user {jellyfinUser.Username}: {ex.Message}");
                }

                processedUsers++;
                progress?.Report((double)processedUsers / totalUsers * 100);
            }

            _logger.LogInformation($"=================================================================================================================================");
            _logger.LogInformation($"[Jellyfin→Seerr Watchlist Sync] Completed. Added {totalItemsAdded} total items across {processedUsers} users");
            progress?.Report(100);
        }

        private bool TryAuthorizeMutationConfiguration(
            SeerrMutationConfigStamp mutationConfigStamp,
            string initialApiKey,
            string pinnedSourceUrl)
        {
            var candidate = _configProvider.ConfigurationOrNull;
            var revision = _configProvider.ConfigurationRevision;
            if (!mutationConfigStamp.Matches(candidate, revision)
                || candidate == null
                || !candidate.SeerrEnabled
                || !candidate.SyncJellyfinWatchlistToSeerr
                || string.IsNullOrWhiteSpace(candidate.SeerrApiKey)
                || !string.Equals(candidate.SeerrApiKey, initialApiKey, StringComparison.Ordinal))
            {
                return false;
            }

            var sourceStillConfigured = Jellyfin.Plugin.JellyfinCanopy.Services.Seerr.SeerrClient
                .GetConfiguredUrls(candidate.SeerrUrls)
                .Any(url => string.Equals(url, pinnedSourceUrl, StringComparison.Ordinal));
            if (!sourceStillConfigured)
            {
                return false;
            }

            return true;
        }

        private async Task<bool> HasFreshExactBindingAsync(
            HttpClient httpClient,
            string seerrUrl,
            string seerrUserId,
            Guid jellyfinUserId,
            string apiKey,
            CancellationToken cancellationToken)
        {
            var canonicalSeerrUserId = CanonicalPositiveIntegerText(seerrUserId);
            var canonicalJellyfinUserId = SeerrPaginationHelper.CanonicalJellyfinUserIdentity(
                jellyfinUserId.ToString());
            if (canonicalSeerrUserId == null || canonicalJellyfinUserId == null)
            {
                return false;
            }

            var requestUri = $"{seerrUrl.TrimEnd('/')}/api/v1/user/{canonicalSeerrUserId}";
            try
            {
                using var request = Helpers.Seerr.SeerrHttpHelper.BuildRequest(
                    HttpMethod.Get,
                    requestUri,
                    apiKey);
                var (content, error, _) = await Helpers.Seerr.SeerrHttpHelper.SendAndReadJsonAsync(
                    httpClient,
                    request,
                    requestUri,
                    cancellationToken).ConfigureAwait(false);
                if (error != null || string.IsNullOrWhiteSpace(content))
                {
                    return false;
                }

                using var document = JsonDocument.Parse(content);
                var user = document.RootElement;
                if (user.ValueKind != JsonValueKind.Object
                    || !TryGetSingleProperty(user, "id", out var responseId)
                    || !TryGetSingleProperty(user, "jellyfinUserId", out var responseJellyfinUserId)
                    || responseJellyfinUserId.ValueKind != JsonValueKind.String)
                {
                    return false;
                }

                return string.Equals(
                        SeerrPaginationHelper.CanonicalPositiveIntegerIdentity(responseId),
                        canonicalSeerrUserId,
                        StringComparison.Ordinal)
                    && string.Equals(
                        SeerrPaginationHelper.CanonicalJellyfinUserIdentity(
                            responseJellyfinUserId.GetString()),
                        canonicalJellyfinUserId,
                        StringComparison.Ordinal);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(
                    $"[Jellyfin→Seerr Watchlist Sync] Fresh linked-user validation failed at {requestUri}: {ex.Message}");
                return false;
            }
        }

        private static string? CanonicalPositiveIntegerText(string? value)
        {
            if (!int.TryParse(
                    value,
                    NumberStyles.None,
                    CultureInfo.InvariantCulture,
                    out var parsed)
                || parsed <= 0)
            {
                return null;
            }

            return parsed.ToString(CultureInfo.InvariantCulture);
        }

        private static bool TryGetSingleProperty(
            JsonElement owner,
            string propertyName,
            out JsonElement value)
        {
            value = default;
            var found = false;
            foreach (var property in owner.EnumerateObject())
            {
                if (!string.Equals(property.Name, propertyName, StringComparison.Ordinal))
                {
                    continue;
                }

                if (found)
                {
                    return false;
                }

                value = property.Value;
                found = true;
            }

            return found;
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

        private static bool TryParseSeerrWatchlist(
            IEnumerable<JsonElement> rows,
            out List<SeerrWatchlistItem> items)
        {
            items = new List<SeerrWatchlistItem>();
            foreach (var row in rows)
            {
                if (!row.TryGetProperty("tmdbId", out var tmdbId)
                    || !tmdbId.TryGetInt32(out var parsedTmdbId)
                    || parsedTmdbId <= 0
                    || !row.TryGetProperty("mediaType", out var mediaType)
                    || mediaType.ValueKind != JsonValueKind.String)
                {
                    return false;
                }

                var normalizedMediaType = mediaType.GetString()?.Trim().ToLowerInvariant();
                if (normalizedMediaType is not ("movie" or "tv")) return false;

                items.Add(new SeerrWatchlistItem
                {
                    TmdbId = parsedTmdbId,
                    MediaType = normalizedMediaType
                });
            }

            return true;
        }

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
                    $"[Jellyfin→Seerr Watchlist Sync] Incomplete {collectionName} from {snapshot.SourceUrl}: code={snapshot.Error.Code} status={snapshot.Error.HttpStatus} cf-ray={snapshot.Error.CfRay} — {snapshot.Error.Message}; {snapshot.FailureReason}. No Seerr mutations will be attempted.");
                return;
            }

            _logger.LogWarning(
                $"[Jellyfin→Seerr Watchlist Sync] Incomplete {collectionName} from {snapshot.SourceUrl ?? "configured URLs"}: {snapshot.FailureReason}. No Seerr mutations will be attempted.");
        }

        private void LogIncompleteCollection(
            string collectionName,
            SeerrMultiSourceCollectionResult snapshots)
        {
            if (snapshots.Error != null)
            {
                var error = snapshots.Error;
                _logger.LogWarning(
                    $"[Jellyfin→Seerr Watchlist Sync] Incomplete {collectionName} from {snapshots.FailedSourceUrl}: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay} — {error.Message}; {snapshots.FailureReason}. No Seerr mutations will be attempted.");
                return;
            }

            _logger.LogWarning(
                $"[Jellyfin→Seerr Watchlist Sync] Incomplete {collectionName} from {snapshots.FailedSourceUrl ?? "configured URLs"}: {snapshots.FailureReason}. No Seerr mutations will be attempted.");
        }

        // Returns: 1 = added, 0 = already present, -1 = error
        private async Task<int> AddToSeerrWatchlist(
            HttpClient httpClient,
            string seerrUrl,
            string seerrUserId,
            string apiKey,
            int tmdbId,
            string mediaType,
            string title,
            CancellationToken cancellationToken)
        {
            try
            {
                var requestUri = $"{seerrUrl.TrimEnd('/')}/api/v1/watchlist";
                var body = JsonSerializer.Serialize(new { tmdbId, mediaType, title });
                using var request = Helpers.Seerr.SeerrHttpHelper.BuildRequest(HttpMethod.Post, requestUri, apiKey, seerrUserId, body);
                var (_, error, _) = await Helpers.Seerr.SeerrHttpHelper.SendAndReadJsonAsync(
                    httpClient,
                    request,
                    requestUri,
                    cancellationToken).ConfigureAwait(false);

                if (error != null)
                {
                    if (error.HttpStatus == 409)
                        return 0; // already in watchlist
                    _logger.LogWarning($"[Jellyfin→Seerr Watchlist Sync] Failed to add {title} (TMDB:{tmdbId}): {error.Code} {error.HttpStatus}");
                    return -1;
                }

                return 1;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogError($"[Jellyfin→Seerr Watchlist Sync] Error adding {title} to Seerr watchlist: {ex.Message}");
                return -1;
            }
        }

        private class SeerrWatchlistItem
        {
            public int TmdbId { get; set; }
            public string MediaType { get; set; } = "";
        }
    }
}
