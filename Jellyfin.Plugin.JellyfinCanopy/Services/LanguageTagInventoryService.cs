using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Jellyfin.Plugin.JellyfinCanopy.Model;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinCanopy.Services
{
    /// <summary>
    /// Produces a bounded canonical choice inventory from current cache evidence for
    /// accessible leaf items. Privacy-sensitive projections are never cached.
    /// </summary>
    public sealed class LanguageTagInventoryService
    {
        internal const int MaximumItemsToScan = 20_000;
        internal const int MaximumLanguages = 128;
        private static readonly TimeSpan CacheTtl = TimeSpan.FromSeconds(30);

        private readonly ILibraryManager _libraryManager;
        private readonly TagCacheService _tagCache;
        private readonly BoundedTtlCache<string, LanguageTagInventory> _cache = new(
            maximumEntries: 256,
            maximumWeight: 256L * MaximumLanguages,
            weight: static (key, value) => key.Length + value.Languages.Sum(static language => language.Length),
            comparer: StringComparer.Ordinal);

        public LanguageTagInventoryService(ILibraryManager libraryManager, TagCacheService tagCache)
        {
            _libraryManager = libraryManager ?? throw new ArgumentNullException(nameof(libraryManager));
            _tagCache = tagCache ?? throw new ArgumentNullException(nameof(tagCache));
        }

        internal LanguageTagInventory Get(
            JUser user,
            Action<Dictionary<string, TagCacheEntry>>? privacyProjection = null,
            CancellationToken cancellationToken = default)
        {
            ArgumentNullException.ThrowIfNull(user);
            var cacheKey = string.Concat(
                user.Id.ToString("N"), ":", user.RowVersion.ToString(System.Globalization.CultureInfo.InvariantCulture),
                ":", _tagCache.ContentRevision.ToString(System.Globalization.CultureInfo.InvariantCulture));
            if (privacyProjection == null && _cache.TryGet(cacheKey, out var cached)) return cached;

            var page = _libraryManager.GetItemsResult(new InternalItemsQuery(user)
            {
                IncludeItemTypes = new[] { BaseItemKind.Movie, BaseItemKind.Episode },
                Recursive = true,
                IsVirtualItem = false,
                Limit = MaximumItemsToScan + 1,
                EnableTotalRecordCount = false,
            });
            if (page.Items.Count > MaximumItemsToScan + 1
                || page.Items.Any(static item => item.IsVirtualItem
                    || (item.GetBaseItemKind() != BaseItemKind.Movie
                        && item.GetBaseItemKind() != BaseItemKind.Episode))
                || page.Items.Select(static item => item.Id).Distinct().Count() != page.Items.Count)
            {
                return new LanguageTagInventory { Complete = false, Truncated = true };
            }

            var boundedItems = page.Items.Take(MaximumItemsToScan).ToArray();
            var entries = _tagCache.GetCachedEntriesByIds(boundedItems.Select(static item => item.Id))
                .ToDictionary(static pair => pair.Key.ToString("N"), static pair => pair.Value.Clone(), StringComparer.Ordinal);
            privacyProjection?.Invoke(entries);

            var complete = page.Items.Count <= MaximumItemsToScan;
            var languages = new SortedSet<string>(StringComparer.Ordinal);
            foreach (var item in boundedItems)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (!entries.TryGetValue(item.Id.ToString("N"), out var entry)
                    || entry.SourceRevision == 0
                    || entry.SourceRevision != item.DateLastSaved.Ticks)
                {
                    complete = false;
                    continue;
                }

                foreach (var value in entry.AudioLanguages ?? Array.Empty<string>())
                {
                    var canonical = TagLanguageCoverageProjector.CanonicalizeLanguageTag(value);
                    if (canonical != null) languages.Add(canonical);
                }
            }

            var result = new LanguageTagInventory
            {
                Languages = languages.Take(MaximumLanguages).ToArray(),
                Complete = complete && languages.Count <= MaximumLanguages,
                Truncated = !complete || languages.Count > MaximumLanguages,
            };
            if (privacyProjection == null && result.Complete) _cache.Set(cacheKey, result, CacheTtl);
            return result;
        }

        internal int CacheCount => _cache.Count;
    }
}
