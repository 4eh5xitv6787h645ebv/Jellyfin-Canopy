using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Model.Arr;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Arr;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.ScheduledTasks
{
    /// Scheduled task that syncs tags from Radarr and Sonarr to Jellyfin items.
    public class ArrTagsSyncTask : IScheduledTask
    {
        private readonly ILibraryManager _libraryManager;
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly ILogger<ArrTagsSyncTask> _logger;
        private readonly IPluginConfigProvider _configProvider;
        private readonly Func<BaseItem, ItemUpdateType, CancellationToken, Task> _updateItem;

        public ArrTagsSyncTask(
            ILibraryManager libraryManager,
            IHttpClientFactory httpClientFactory,
            ILogger<ArrTagsSyncTask> logger,
            IPluginConfigProvider configProvider)
            : this(
                libraryManager,
                httpClientFactory,
                logger,
                configProvider,
                static (item, updateType, cancellationToken) =>
                    item.UpdateToRepositoryAsync(updateType, cancellationToken))
        {
        }

        /// <summary>Test seam for observing repository writes without a live Jellyfin repository.</summary>
        internal ArrTagsSyncTask(
            ILibraryManager libraryManager,
            IHttpClientFactory httpClientFactory,
            ILogger<ArrTagsSyncTask> logger,
            IPluginConfigProvider configProvider,
            Func<BaseItem, ItemUpdateType, CancellationToken, Task> updateItem)
        {
            _libraryManager = libraryManager;
            _httpClientFactory = httpClientFactory;
            _logger = logger;
            _configProvider = configProvider;
            _updateItem = updateItem;
        }

        public string Name => "Sync Tags from *arr to Jellyfin";

        public string Key => "JellyfinCanopyArrTagsSync";

        public string Description => "Fetches tags from Radarr and Sonarr and adds them to Jellyfin items as metadata tags. \n\n Configure the task triggers to run this task periodically for new items to be synced automatically.";

        public string Category => "Jellyfin Canopy";

        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
        {
            // No default triggers - run on demand only
            return Array.Empty<TaskTriggerInfo>();
        }

        public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            var config = _configProvider.ConfigurationOrNull;

            if (config == null || !config.ArrTagsSyncEnabled)
            {
                _logger.LogInformation("Arr Tags Sync is disabled in plugin configuration.");
                progress?.Report(100);
                return;
            }

            using var cancellationRegistration = cancellationToken.Register(
                () => _logger.LogInformation(
                    "Arr Tags Sync cancellation requested; no incomplete snapshot will be published."));

            _logger.LogInformation("Starting Arr Tags Sync task...");
            progress?.Report(0);

            var arrTagService = new ArrTagService(_httpClientFactory, _logger);

            var radarrTags = new Dictionary<int, List<string>>();
            var radarrSnapshotComplete = false;
            // Sonarr tags keyed BOTH by TVDB id (canonical) and IMDb id (fallback) so a
            // TVDB-scraped library (series without an IMDb id) still syncs.
            var sonarrTagsByTvdb = new Dictionary<int, List<string>>();
            var sonarrTagsByImdb = new Dictionary<string, List<string>>();
            var sonarrSnapshotComplete = false;

            // Fetch tags from all configured Radarr instances
            var radarrConfigCorrupt = config.IsRadarrInstancesCorrupt();
            var radarrConfigHasInvalidEnabledRows = !radarrConfigCorrupt
                && config.HasInvalidEnabledRadarrInstances();
            if (radarrConfigCorrupt)
            {
                _logger.LogError("RadarrInstances config is corrupt JSON — preserving existing Radarr-owned tags. "
                    + "Admin must open the Arr Links config page and reset the corrupt value before sync can resume.");
            }
            else if (radarrConfigHasInvalidEnabledRows)
            {
                _logger.LogError(
                    "RadarrInstances contains an enabled row without a usable URL/API key — "
                    + "preserving existing Radarr-owned tags until the row is fixed or disabled.");
            }
            var allAuthoritativeRadarr = radarrConfigCorrupt
                ? new List<ArrInstance>()
                : config.GetRadarrInstancesForAuthoritativeSnapshot();
            var radarrInstances = allAuthoritativeRadarr.Where(i => i.Enabled).ToList();
            if (radarrInstances.Count > 0)
            {
                radarrSnapshotComplete = !radarrConfigHasInvalidEnabledRows;
                foreach (var instance in radarrInstances)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    try
                    {
                        _logger.LogInformation($"Fetching tags from Radarr instance: {instance.Name}");
                        var result = await arrTagService.GetMovieTagsByTmdbId(instance.Url, instance.ApiKey, cancellationToken);
                        if (!result.IsComplete)
                        {
                            radarrSnapshotComplete = false;
                            _logger.LogWarning(
                                $"Radarr tag snapshot from {instance.Name} is incomplete ({result.FailureReason}); "
                                + "existing movie tags will be preserved.");
                            continue;
                        }

                        _logger.LogInformation($"Fetched {result.Value.Count} movie tag mappings from {instance.Name}");
                        MergeTagMap(radarrTags, result.Value);
                    }
                    catch (OperationCanceledException) { throw; }
                    catch (Exception ex)
                    {
                        radarrSnapshotComplete = false;
                        _logger.LogError($"Failed to sync tags from Radarr instance {instance.Name}: {ex.Message}");
                    }
                }
            }
            else
            {
                if (allAuthoritativeRadarr.Count > 0)
                    _logger.LogInformation($"All {allAuthoritativeRadarr.Count} Radarr instances are disabled — skipping Radarr sync");
                else
                    _logger.LogInformation("No usable enabled Radarr sources configured, skipping Radarr sync");
            }

            progress?.Report(25);
            cancellationToken.ThrowIfCancellationRequested();

            // Fetch tags from all configured Sonarr instances
            var sonarrConfigCorrupt = config.IsSonarrInstancesCorrupt();
            var sonarrConfigHasInvalidEnabledRows = !sonarrConfigCorrupt
                && config.HasInvalidEnabledSonarrInstances();
            if (sonarrConfigCorrupt)
            {
                _logger.LogError("SonarrInstances config is corrupt JSON — preserving existing Sonarr-owned tags. "
                    + "Admin must open the Arr Links config page and reset the corrupt value before sync can resume.");
            }
            else if (sonarrConfigHasInvalidEnabledRows)
            {
                _logger.LogError(
                    "SonarrInstances contains an enabled row without a usable URL/API key — "
                    + "preserving existing Sonarr-owned tags until the row is fixed or disabled.");
            }
            var allAuthoritativeSonarr = sonarrConfigCorrupt
                ? new List<ArrInstance>()
                : config.GetSonarrInstancesForAuthoritativeSnapshot();
            var sonarrInstances = allAuthoritativeSonarr.Where(i => i.Enabled).ToList();
            if (sonarrInstances.Count > 0)
            {
                sonarrSnapshotComplete = !sonarrConfigHasInvalidEnabledRows;
                foreach (var instance in sonarrInstances)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    try
                    {
                        _logger.LogInformation($"Fetching tags from Sonarr instance: {instance.Name}");
                        var result = await arrTagService.GetSeriesTagsAsync(instance.Url, instance.ApiKey, cancellationToken);
                        if (!result.IsComplete)
                        {
                            sonarrSnapshotComplete = false;
                            _logger.LogWarning(
                                $"Sonarr tag snapshot from {instance.Name} is incomplete ({result.FailureReason}); "
                                + "existing series tags will be preserved.");
                            continue;
                        }

                        _logger.LogInformation($"Fetched {result.Value.ByTvdbId.Count} series tag mappings by TVDB, {result.Value.ByImdbId.Count} by IMDb from {instance.Name}");
                        MergeTagMap(sonarrTagsByTvdb, result.Value.ByTvdbId);
                        MergeTagMap(sonarrTagsByImdb, result.Value.ByImdbId);
                    }
                    catch (OperationCanceledException) { throw; }
                    catch (Exception ex)
                    {
                        sonarrSnapshotComplete = false;
                        _logger.LogError($"Failed to sync tags from Sonarr instance {instance.Name}: {ex.Message}");
                    }
                }
            }
            else
            {
                if (allAuthoritativeSonarr.Count > 0)
                    _logger.LogInformation($"All {allAuthoritativeSonarr.Count} Sonarr instances are disabled — skipping Sonarr sync");
                else
                    _logger.LogInformation("No usable enabled Sonarr sources configured, skipping Sonarr sync");
            }

            progress?.Report(50);
            cancellationToken.ThrowIfCancellationRequested();

            if (!radarrSnapshotComplete && !sonarrSnapshotComplete)
            {
                _logger.LogWarning(
                    "Arr Tags Sync did not receive any complete authoritative snapshot; "
                    + "existing Arr-owned tags were preserved and no library metadata was written.");
                progress?.Report(100);
                return;
            }

            // Get all movies and series from Jellyfin
            var allItems = _libraryManager.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { BaseItemKind.Movie, BaseItemKind.Series },
                IsVirtualItem = false,
                Recursive = true
            }).ToList();
            cancellationToken.ThrowIfCancellationRequested();

            _logger.LogInformation($"Found {allItems.Count} items in Jellyfin library");

            var updatedCount = 0;
            var totalItems = allItems.Count;
            var processedItems = 0;
            var updatedItemNames = new List<string>(); // Track updated items for batch logging

            string tagPrefix = ResolveTagPrefix(config);
            bool clearOldTags = config.ArrTagsClearOldTags;

            // Parse sync filter - if empty, sync all tags
            var syncFilterTags = ParseSyncFilter(config.ArrTagsSyncFilter);
            if (syncFilterTags.Count > 0)
            {
                _logger.LogInformation($"Filtering tags to sync: {string.Join(", ", syncFilterTags)}");
            }

            foreach (var item in allItems)
            {
                cancellationToken.ThrowIfCancellationRequested();

                List<string>? tagsToAdd = null;
                var itemSnapshotComplete = false;
                var itemHasUsableProviderId = false;

                // Check if it's a movie
                if (item is Movie movie)
                {
                    itemSnapshotComplete = radarrSnapshotComplete;
                    var tmdbId = movie.GetProviderId(MediaBrowser.Model.Entities.MetadataProvider.Tmdb);
                    if (!string.IsNullOrWhiteSpace(tmdbId)
                        && int.TryParse(tmdbId, out var tmdbIdInt)
                        && tmdbIdInt > 0)
                    {
                        itemHasUsableProviderId = true;
                        if (radarrTags.TryGetValue(tmdbIdInt, out var tags))
                        {
                            tagsToAdd = tags;
                        }
                    }
                }
                // Check if it's a series — prefer TVDB (Sonarr's canonical id), fall back to IMDb.
                else if (item is Series series)
                {
                    itemSnapshotComplete = sonarrSnapshotComplete;
                    var tvdbId = series.GetProviderId(MediaBrowser.Model.Entities.MetadataProvider.Tvdb);
                    if (!string.IsNullOrWhiteSpace(tvdbId)
                        && int.TryParse(tvdbId, out var tvdbIdInt)
                        && tvdbIdInt > 0)
                    {
                        itemHasUsableProviderId = true;
                        if (sonarrTagsByTvdb.TryGetValue(tvdbIdInt, out var tvdbTags))
                        {
                            tagsToAdd = tvdbTags;
                        }
                    }

                    if (tagsToAdd == null)
                    {
                        var imdbId = series.GetProviderId(MediaBrowser.Model.Entities.MetadataProvider.Imdb);
                        if (!string.IsNullOrWhiteSpace(imdbId))
                        {
                            if (sonarrTagsByImdb.TryGetValue(imdbId, out var imdbTags))
                            {
                                // IMDb is a matching fallback, not authoritative absence: Sonarr
                                // may legitimately omit IMDb while TVDB remains canonical. A local
                                // IMDb-only item is safe to reconcile only when it actually matched.
                                itemHasUsableProviderId = true;
                                tagsToAdd = imdbTags;
                            }
                        }
                    }
                }

                if (!itemSnapshotComplete || !itemHasUsableProviderId)
                {
                    ReportItemProgress();
                    continue;
                }

                var existingTags = item.Tags?.ToList() ?? new List<string>();
                var desiredTags = BuildDesiredTags(existingTags, tagsToAdd, tagPrefix, clearOldTags, syncFilterTags);

                // Update item if modified
                if (!TagCollectionsEqual(existingTags, desiredTags))
                {
                    var previousTags = item.Tags;
                    item.Tags = desiredTags.ToArray();
                    try
                    {
                        await _updateItem(item, ItemUpdateType.MetadataEdit, cancellationToken);
                    }
                    catch
                    {
                        // A failed repository write must not leave the live in-memory item looking
                        // as if destructive reconciliation succeeded.
                        item.Tags = previousTags;
                        throw;
                    }

                    updatedCount++;
                    updatedItemNames.Add(item.Name);
                    
                    // Log in batches of 50 items to reduce log spam
                    if (updatedItemNames.Count >= 50)
                    {
                        _logger.LogInformation($"Updated tags for {updatedItemNames.Count} items: {string.Join(", ", updatedItemNames.Take(10))}...");
                        updatedItemNames.Clear();
                    }
                }

                ReportItemProgress();
            }

            // Log any remaining updated items
            if (updatedItemNames.Count > 0)
            {
                if (updatedItemNames.Count <= 10)
                {
                    _logger.LogInformation($"Updated tags for: {string.Join(", ", updatedItemNames)}");
                }
                else
                {
                    _logger.LogInformation($"Updated tags for {updatedItemNames.Count} items: {string.Join(", ", updatedItemNames.Take(10))}...");
                }
            }

            _logger.LogInformation($"Arr Tags Sync completed. Updated {updatedCount} items out of {totalItems}");
            progress?.Report(100);

            void ReportItemProgress()
            {
                processedItems++;
                var currentProgress = totalItems == 0
                    ? 100
                    : 50 + (int)((double)processedItems / totalItems * 50);
                progress?.Report(currentProgress);
            }
        }

        /// <summary>
        /// Parses the admin-documented one-tag-per-line format while retaining the legacy comma
        /// and semicolon separators. Empty/whitespace-only entries never become filter values.
        /// </summary>
        internal static HashSet<string> ParseSyncFilter(string? configuredFilter)
        {
            var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (string.IsNullOrWhiteSpace(configuredFilter))
            {
                return result;
            }

            var parts = configuredFilter.Split(
                new[] { ',', ';', '\r', '\n' },
                StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            foreach (var part in parts)
            {
                if (part.Length > 0)
                {
                    result.Add(part);
                }
            }

            return result;
        }

        /// <summary>
        /// Builds the authoritative final tag collection without mutating the live item. Owned
        /// tags are cleared only after every configured source for that media type completed; the
        /// caller enforces that completeness gate before invoking this helper.
        /// </summary>
        internal static List<string> BuildDesiredTags(
            IReadOnlyList<string> existingTags,
            IReadOnlyList<string>? tagsToAdd,
            string tagPrefix,
            bool clearOldTags,
            IReadOnlySet<string> syncFilterTags)
        {
            var desiredTags = clearOldTags
                ? existingTags
                    .Where(t => !t.StartsWith(tagPrefix, StringComparison.OrdinalIgnoreCase))
                    .ToList()
                : existingTags.ToList();

            if (tagsToAdd == null)
            {
                return desiredTags;
            }

            foreach (var tag in tagsToAdd)
            {
                if (syncFilterTags.Count > 0 && !syncFilterTags.Contains(tag))
                {
                    continue;
                }

                var formattedTag = $"{tagPrefix}{tag}";
                if (!desiredTags.Contains(formattedTag, StringComparer.OrdinalIgnoreCase))
                {
                    desiredTags.Add(formattedTag);
                }
            }

            return desiredTags;
        }

        /// <summary>Order-insensitive, case-insensitive comparison that preserves multiplicity.</summary>
        internal static bool TagCollectionsEqual(IReadOnlyList<string> left, IReadOnlyList<string> right)
            => left.Count == right.Count
                && left
                    .OrderBy(t => t, StringComparer.OrdinalIgnoreCase)
                    .SequenceEqual(
                        right.OrderBy(t => t, StringComparer.OrdinalIgnoreCase),
                        StringComparer.OrdinalIgnoreCase);

        /// <summary>
        /// Resolves the tag prefix, defaulting only an empty/absent admin value so the write side
        /// matches the client read side EXACTLY. The client uses <c>config.ArrTagsPrefix || 'JC Arr
        /// Tag: '</c>, and JS treats only <c>''</c>/<c>undefined</c> as falsy — a whitespace-only
        /// prefix stays verbatim on the client. Using <see cref="string.IsNullOrEmpty"/> (not
        /// <c>IsNullOrWhiteSpace</c>) keeps the two in lockstep: a whitespace prefix is preserved on
        /// both, so the client's <c>tag.startsWith(prefix)</c> read matches the tags the sync writes
        /// (ARR-CS-3). <c>IsNullOrWhiteSpace</c> would default the write side while the client kept
        /// the whitespace, diverging write vs read.
        /// </summary>
        internal static string ResolveTagPrefix(PluginConfiguration config)
            => string.IsNullOrEmpty(config.ArrTagsPrefix)
                ? PluginConfiguration.DefaultArrTagsPrefix
                : config.ArrTagsPrefix;

        /// <summary>
        /// Merges one instance's tag map into the accumulator: unions tag labels for an
        /// existing key (case-insensitive) and copies the value list for a new key so the
        /// accumulator never shares a reference with the source map.
        /// </summary>
        private static void MergeTagMap<TKey>(Dictionary<TKey, List<string>> accumulator, Dictionary<TKey, List<string>> instanceTags)
            where TKey : notnull
        {
            foreach (var kvp in instanceTags)
            {
                if (accumulator.TryGetValue(kvp.Key, out var existing))
                {
                    foreach (var tag in kvp.Value)
                    {
                        if (!existing.Contains(tag, StringComparer.OrdinalIgnoreCase))
                            existing.Add(tag);
                    }
                }
                else
                {
                    accumulator[kvp.Key] = new List<string>(kvp.Value);
                }
            }
        }
    }
}
