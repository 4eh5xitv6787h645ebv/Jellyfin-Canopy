using System;
using System.Collections.Generic;
using System.Linq;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
#if NET10_0_OR_GREATER
using MediaBrowser.Controller.Dto;
using MediaBrowser.Model.Querying;
#else
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Microsoft.EntityFrameworkCore;
#endif

namespace Jellyfin.Plugin.JellyfinEnhanced.Data
{
    /// <summary>
    /// <see cref="IItemLookupService"/> implementation.
    ///
    /// Batch provider lookups are split per target:
    /// <list type="bullet">
    ///   <item>Jellyfin 12 (net10.0 artifact): a single supported
    ///     <see cref="ILibraryManager"/> query using
    ///     <c>InternalItemsQuery.HasAnyProviderIds</c> (multi-value per provider,
    ///     new in 12). Jellyfin 12 reworks the internal DB schema, so raw EF access
    ///     is not an option there.</item>
    ///   <item>Jellyfin 10.11 (net9.0 artifact): the proven raw EF query against the
    ///     BaseItemProviders table (one indexed IN-query per provider). 10.11's
    ///     schema is frozen — it gets no schema rework — and the supported 10.11
    ///     surface (<c>HasAnyProviderId</c>, single value per provider) would need
    ///     one query per provider value, which live-tested ~30s for a 10-day
    ///     calendar window vs sub-second for the raw path.</item>
    /// </list>
    /// Both paths match on the exact provider key/value strings (case-sensitive
    /// under SQLite's default BINARY collation) and never receive empty values
    /// (see <see cref="NormalizePairs"/>).
    ///
    /// The single-pair lookup (items/by-providers) uses <see cref="ILibraryManager"/>
    /// on both targets — A/B-verified byte-identical and fast on 10.11.
    /// </summary>
    public class ItemLookupService : IItemLookupService
    {
        private readonly ILibraryManager _libraryManager;

#if NET10_0_OR_GREATER
        public ItemLookupService(ILibraryManager libraryManager)
        {
            _libraryManager = libraryManager;
        }
#else
        private readonly IDbContextFactory<JellyfinDbContext> _dbContextFactory;

        public ItemLookupService(
            ILibraryManager libraryManager,
            IDbContextFactory<JellyfinDbContext> dbContextFactory)
        {
            _libraryManager = libraryManager;
            _dbContextFactory = dbContextFactory;
        }
#endif

        /// <inheritdoc />
        public IReadOnlyList<Guid> GetItemIdsByProviders(IDictionary<string, string>? providers)
        {
            if (providers == null || providers.Count == 0)
                return Array.Empty<Guid>();

            return _libraryManager.GetItemIds(BuildProviderQuery(providers));
        }

        /// <inheritdoc />
        public Dictionary<(string Provider, string Value), Guid> GetItemIdsByProvidersBatch(
            IReadOnlyCollection<(string Provider, string Value)> providers)
        {
            var pairs = NormalizePairs(providers);
            if (pairs.Count == 0)
                return new Dictionary<(string, string), Guid>();

#if NET10_0_OR_GREATER
            // Jellyfin 12: one supported query resolves the whole batch; matched
            // items are mapped back to their (Provider, Value) pairs in memory.
            var matchedItems = new Dictionary<Guid, BaseItem>();
            foreach (var item in _libraryManager.GetItemList(BuildBatchQuery(pairs)))
            {
                matchedItems.TryAdd(item.Id, item);
            }

            return MapProviderPairs(matchedItems.Values, pairs);
#else
            // Jellyfin 10.11: raw indexed query on the (frozen) BaseItemProviders
            // table — one IN-query per provider group, first row wins per pair.
            var providerGroups = pairs
                .GroupBy(p => p.Provider, StringComparer.Ordinal)
                .ToDictionary(
                    g => g.Key,
                    g => g.Select(p => p.Value).ToList(),
                    StringComparer.Ordinal);

            using var db = _dbContextFactory.CreateDbContext();

            var results = new List<BaseItemProvider>();
            foreach (var group in providerGroups)
            {
                var provider = group.Key;
                var values = group.Value;
                results.AddRange(db.BaseItemProviders
                    .Where(p => p.ProviderId == provider && values.Contains(p.ProviderValue))
                    .ToList());
            }

            return results
                .DistinctBy(p => (p.ProviderId, p.ProviderValue))
                .ToDictionary(p => (p.ProviderId, p.ProviderValue), p => p.ItemId);
#endif
        }

        /// <summary>
        /// Query for the single-value-per-provider lookup (items/by-providers endpoint).
        /// Kept byte-identical to the former IItemRepository-based query.
        /// </summary>
        internal static InternalItemsQuery BuildProviderQuery(IDictionary<string, string> providers)
        {
            return new InternalItemsQuery
            {
                HasAnyProviderId = new Dictionary<string, string>(providers),
                Recursive = true
            };
        }

        /// <summary>
        /// Drops pairs with a blank provider or value and de-duplicates. Blank values
        /// must never reach the queries: HasAnyProviderIds treats an empty value as
        /// "has this provider at all" (existence match), and the raw 10.11 SQL simply
        /// never matched them.
        /// </summary>
        internal static List<(string Provider, string Value)> NormalizePairs(
            IReadOnlyCollection<(string Provider, string Value)> providers)
        {
            return providers
                .Where(p => !string.IsNullOrWhiteSpace(p.Provider) && !string.IsNullOrWhiteSpace(p.Value))
                .Distinct()
                .ToList();
        }

#if NET10_0_OR_GREATER
        /// <summary>
        /// Builds the single Jellyfin-12 batch query: HasAnyProviderIds takes multiple
        /// values per provider, so the whole batch resolves at once. Pairs must
        /// already be normalized.
        /// </summary>
        internal static InternalItemsQuery BuildBatchQuery(
            IReadOnlyCollection<(string Provider, string Value)> pairs)
        {
            var grouped = pairs
                .GroupBy(p => p.Provider, StringComparer.Ordinal)
                .ToDictionary(
                    g => g.Key,
                    g => g.Select(p => p.Value).Distinct(StringComparer.Ordinal).ToArray(),
                    StringComparer.Ordinal);

            return new InternalItemsQuery
            {
                HasAnyProviderIds = grouped,
                Recursive = true,
                // Lean options: only the ProviderIds field is needed (it drives the
                // Provider navigation include that hydrates BaseItem.ProviderIds);
                // skip images/user-data joins.
                DtoOptions = new DtoOptions(false)
                {
                    Fields = new[] { ItemFields.ProviderIds },
                    EnableImages = false,
                    EnableUserData = false
                }
            };
        }

        /// <summary>
        /// Maps each requested (Provider, Value) pair to the first matched item that
        /// carries exactly that provider id. Comparison is ordinal (case-sensitive) on
        /// both key and value — the same net behavior as the 10.11 raw SQL, whose
        /// BINARY collation match + case-sensitive dictionary lookup was
        /// case-sensitive end-to-end.
        /// </summary>
        internal static Dictionary<(string Provider, string Value), Guid> MapProviderPairs(
            IEnumerable<BaseItem> items,
            IReadOnlyCollection<(string Provider, string Value)> pairs)
        {
            var requested = new HashSet<(string, string)>(pairs);
            var map = new Dictionary<(string Provider, string Value), Guid>();

            foreach (var item in items)
            {
                if (item.ProviderIds == null)
                    continue;

                foreach (var kv in item.ProviderIds)
                {
                    if (kv.Value == null)
                        continue;

                    var key = (kv.Key, kv.Value);
                    if (requested.Contains(key) && !map.ContainsKey(key))
                        map[key] = item.Id;
                }
            }

            return map;
        }
#endif
    }
}
