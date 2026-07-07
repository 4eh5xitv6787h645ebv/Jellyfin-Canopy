using System;
using System.Collections.Generic;
using System.Linq;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Querying;

namespace Jellyfin.Plugin.JellyfinElevate.Data
{
    /// <summary>
    /// <see cref="IItemLookupService"/> implementation.
    ///
    /// Batch provider lookups use a single supported <see cref="ILibraryManager"/>
    /// query via <c>InternalItemsQuery.HasAnyProviderIds</c> (multi-value per
    /// provider). Matches are on the exact provider key/value strings
    /// (case-sensitive) and the queries never receive empty values
    /// (see <see cref="NormalizePairs"/>).
    ///
    /// The single-pair lookup (items/by-providers) uses <see cref="ILibraryManager"/>
    /// with <c>HasAnyProviderId</c> (single value per provider).
    /// </summary>
    public class ItemLookupService : IItemLookupService
    {
        private readonly ILibraryManager _libraryManager;

        public ItemLookupService(ILibraryManager libraryManager)
        {
            _libraryManager = libraryManager;
        }

        /// <inheritdoc />
        public IReadOnlyList<Guid> GetItemIdsByProviders(IDictionary<string, string>? providers, JUser? user = null)
        {
            if (providers == null || providers.Count == 0)
                return Array.Empty<Guid>();

            return _libraryManager.GetItemIds(BuildProviderQuery(providers, user));
        }

        /// <inheritdoc />
        public Dictionary<(string Provider, string Value), Guid> GetItemIdsByProvidersBatch(
            IReadOnlyCollection<(string Provider, string Value)> providers)
        {
            var pairs = NormalizePairs(providers);
            if (pairs.Count == 0)
                return new Dictionary<(string, string), Guid>();

            // One supported query resolves the whole batch; matched items are
            // mapped back to their (Provider, Value) pairs in memory.
            var matchedItems = new Dictionary<Guid, BaseItem>();
            foreach (var item in _libraryManager.GetItemList(BuildBatchQuery(pairs)))
            {
                matchedItems.TryAdd(item.Id, item);
            }

            return MapProviderPairs(matchedItems.Values, pairs);
        }

        /// <summary>
        /// Query for the single-value-per-provider lookup (items/by-providers endpoint).
        /// When <paramref name="user"/> is non-null the query is scoped to that user's
        /// accessible libraries (a null user preserves the former unscoped behavior).
        /// </summary>
        internal static InternalItemsQuery BuildProviderQuery(IDictionary<string, string> providers, JUser? user = null)
        {
            return new InternalItemsQuery
            {
                HasAnyProviderId = new Dictionary<string, string>(providers),
                Recursive = true,
                User = user
            };
        }

        /// <summary>
        /// Drops pairs with a blank provider or value and de-duplicates. Blank values
        /// must never reach the queries: HasAnyProviderIds treats an empty value as
        /// "has this provider at all" (existence match).
        /// </summary>
        internal static List<(string Provider, string Value)> NormalizePairs(
            IReadOnlyCollection<(string Provider, string Value)> providers)
        {
            return providers
                .Where(p => !string.IsNullOrWhiteSpace(p.Provider) && !string.IsNullOrWhiteSpace(p.Value))
                .Distinct()
                .ToList();
        }

        /// <summary>
        /// Builds the single batch query: HasAnyProviderIds takes multiple values per
        /// provider, so the whole batch resolves at once. Pairs must already be
        /// normalized.
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
        /// both key and value, matching the server's BINARY-collation storage.
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
    }
}
