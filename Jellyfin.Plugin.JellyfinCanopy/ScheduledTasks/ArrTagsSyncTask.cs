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

        public ArrTagsSyncTask(
            ILibraryManager libraryManager,
            IHttpClientFactory httpClientFactory,
            ILogger<ArrTagsSyncTask> logger,
            IPluginConfigProvider configProvider)
        {
            _libraryManager = libraryManager;
            _httpClientFactory = httpClientFactory;
            _logger = logger;
            _configProvider = configProvider;
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

            _logger.LogInformation("Starting Arr Tags Sync task...");
            progress?.Report(0);

            var arrTagService = new ArrTagService(_httpClientFactory, _logger);

            var radarrTags = new Dictionary<int, List<string>>();
            // Sonarr tags keyed BOTH by TVDB id (canonical) and IMDb id (fallback) so a
            // TVDB-scraped library (series without an IMDb id) still syncs.
            var sonarrTagsByTvdb = new Dictionary<int, List<string>>();
            var sonarrTagsByImdb = new Dictionary<string, List<string>>();

            // Fetch tags from all configured Radarr instances
            if (config.IsRadarrInstancesCorrupt())
            {
                _logger.LogError("RadarrInstances config is corrupt JSON — no Radarr tags will sync this run. "
                    + "Admin must open the Arr Links config page and reset the corrupt value.");
            }
            var radarrInstances = config.GetEnabledRadarrInstances();
            if (radarrInstances.Count > 0)
            {
                foreach (var instance in radarrInstances)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    try
                    {
                        _logger.LogInformation($"Fetching tags from Radarr instance: {instance.Name}");
                        var instanceTags = await arrTagService.GetMovieTagsByTmdbId(instance.Url, instance.ApiKey, cancellationToken);
                        _logger.LogInformation($"Fetched {instanceTags.Count} movie tag mappings from {instance.Name}");
                        MergeTagMap(radarrTags, instanceTags);
                    }
                    catch (OperationCanceledException) { throw; }
                    catch (Exception ex)
                    {
                        _logger.LogError($"Failed to sync tags from Radarr instance {instance.Name}: {ex.Message}");
                    }
                }
            }
            else
            {
                var allRadarr = config.GetRadarrInstances();
                if (allRadarr.Count > 0)
                    _logger.LogInformation($"All {allRadarr.Count} Radarr instances are disabled — skipping Radarr sync");
                else
                    _logger.LogInformation("No Radarr instances configured, skipping Radarr sync");
            }

            progress?.Report(25);
            cancellationToken.ThrowIfCancellationRequested();

            // Fetch tags from all configured Sonarr instances
            if (config.IsSonarrInstancesCorrupt())
            {
                _logger.LogError("SonarrInstances config is corrupt JSON — no Sonarr tags will sync this run. "
                    + "Admin must open the Arr Links config page and reset the corrupt value.");
            }
            var sonarrInstances = config.GetEnabledSonarrInstances();
            if (sonarrInstances.Count > 0)
            {
                foreach (var instance in sonarrInstances)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    try
                    {
                        _logger.LogInformation($"Fetching tags from Sonarr instance: {instance.Name}");
                        var instanceMaps = await arrTagService.GetSeriesTagsAsync(instance.Url, instance.ApiKey, cancellationToken);
                        _logger.LogInformation($"Fetched {instanceMaps.ByTvdbId.Count} series tag mappings by TVDB, {instanceMaps.ByImdbId.Count} by IMDb from {instance.Name}");
                        MergeTagMap(sonarrTagsByTvdb, instanceMaps.ByTvdbId);
                        MergeTagMap(sonarrTagsByImdb, instanceMaps.ByImdbId);
                    }
                    catch (OperationCanceledException) { throw; }
                    catch (Exception ex)
                    {
                        _logger.LogError($"Failed to sync tags from Sonarr instance {instance.Name}: {ex.Message}");
                    }
                }
            }
            else
            {
                var allSonarr = config.GetSonarrInstances();
                if (allSonarr.Count > 0)
                    _logger.LogInformation($"All {allSonarr.Count} Sonarr instances are disabled — skipping Sonarr sync");
                else
                    _logger.LogInformation("No Sonarr instances configured, skipping Sonarr sync");
            }

            progress?.Report(50);
            cancellationToken.ThrowIfCancellationRequested();

            // Get all movies and series from Jellyfin
            var allItems = _libraryManager.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { BaseItemKind.Movie, BaseItemKind.Series },
                IsVirtualItem = false,
                Recursive = true
            }).ToList();

            _logger.LogInformation($"Found {allItems.Count} items in Jellyfin library");

            var updatedCount = 0;
            var totalItems = allItems.Count;
            var processedItems = 0;
            var updatedItemNames = new List<string>(); // Track updated items for batch logging

            string tagPrefix = ResolveTagPrefix(config);
            bool clearOldTags = config.ArrTagsClearOldTags;

            // Parse sync filter - if empty, sync all tags
            var syncFilterTags = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (!string.IsNullOrWhiteSpace(config.ArrTagsSyncFilter))
            {
                var filterParts = config.ArrTagsSyncFilter.Split(new[] { ',', ';' }, StringSplitOptions.RemoveEmptyEntries);
                foreach (var part in filterParts)
                {
                    syncFilterTags.Add(part.Trim());
                }
                _logger.LogInformation($"Filtering tags to sync: {string.Join(", ", syncFilterTags)}");
            }

            foreach (var item in allItems)
            {
                cancellationToken.ThrowIfCancellationRequested();

                List<string>? tagsToAdd = null;

                // Check if it's a movie
                if (item is Movie movie)
                {
                    var tmdbId = movie.GetProviderId(MediaBrowser.Model.Entities.MetadataProvider.Tmdb);
                    if (!string.IsNullOrWhiteSpace(tmdbId) && int.TryParse(tmdbId, out var tmdbIdInt))
                    {
                        if (radarrTags.TryGetValue(tmdbIdInt, out var tags))
                        {
                            tagsToAdd = tags;
                        }
                    }
                }
                // Check if it's a series — prefer TVDB (Sonarr's canonical id), fall back to IMDb.
                else if (item is Series series)
                {
                    var tvdbId = series.GetProviderId(MediaBrowser.Model.Entities.MetadataProvider.Tvdb);
                    if (!string.IsNullOrWhiteSpace(tvdbId)
                        && int.TryParse(tvdbId, out var tvdbIdInt)
                        && sonarrTagsByTvdb.TryGetValue(tvdbIdInt, out var tvdbTags))
                    {
                        tagsToAdd = tvdbTags;
                    }
                    else
                    {
                        var imdbId = series.GetProviderId(MediaBrowser.Model.Entities.MetadataProvider.Imdb);
                        if (!string.IsNullOrWhiteSpace(imdbId)
                            && sonarrTagsByImdb.TryGetValue(imdbId, out var imdbTags))
                        {
                            tagsToAdd = imdbTags;
                        }
                    }
                }

                var existingTags = item.Tags?.ToList() ?? new List<string>();
                var modified = false;

                // Clear old tags with the prefix if enabled
                if (clearOldTags)
                {
                    var tagsToRemove = existingTags
                        .Where(t => t.StartsWith(tagPrefix, StringComparison.OrdinalIgnoreCase))
                        .ToList();

                    if (tagsToRemove.Count > 0)
                    {
                        foreach (var tag in tagsToRemove)
                        {
                            existingTags.Remove(tag);
                        }
                        modified = true;
                    }
                }

                // Add new tags if found
                if (tagsToAdd != null && tagsToAdd.Count > 0)
                {
                    foreach (var tag in tagsToAdd)
                    {
                        // Apply sync filter - skip tags not in filter (if filter is set)
                        if (syncFilterTags.Count > 0 && !syncFilterTags.Contains(tag))
                        {
                            continue;
                        }

                        var formattedTag = $"{tagPrefix}{tag}";

                        // Only add if not already present
                        if (!existingTags.Contains(formattedTag, StringComparer.OrdinalIgnoreCase))
                        {
                            existingTags.Add(formattedTag);
                            modified = true;
                        }
                    }
                }

                // Update item if modified
                if (modified)
                {
                    item.Tags = existingTags.ToArray();
                    await item.UpdateToRepositoryAsync(ItemUpdateType.MetadataEdit, cancellationToken);
                    updatedCount++;
                    updatedItemNames.Add(item.Name);
                    
                    // Log in batches of 50 items to reduce log spam
                    if (updatedItemNames.Count >= 50)
                    {
                        _logger.LogInformation($"Updated tags for {updatedItemNames.Count} items: {string.Join(", ", updatedItemNames.Take(10))}...");
                        updatedItemNames.Clear();
                    }
                }

                processedItems++;
                var currentProgress = 50 + (int)((double)processedItems / totalItems * 50);
                progress?.Report(currentProgress);
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
        }

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
