using System;
using System.Collections.Generic;
using System.Linq;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Querying;

namespace Jellyfin.Plugin.JellyfinEnhanced.Data
{
    /// <summary>
    /// <see cref="IItemLookupService"/> implementation on top of
    /// <see cref="ILibraryManager"/> + <see cref="InternalItemsQuery"/>.
    ///
    /// This replaces the plugin's former raw EF Core access to Jellyfin's internal
    /// database (querying the BaseItemProviders table via
    /// IDbContextFactory&lt;JellyfinDbContext&gt;), which was the plugin's biggest
    /// Jellyfin-12 breakage risk — the internal schema is not a plugin API.
    ///
    /// Query shape per target:
    /// <list type="bullet">
    ///   <item>Jellyfin 12 (net10.0 artifact): a single query using
    ///     <c>InternalItemsQuery.HasAnyProviderIds</c> (multi-value per provider,
    ///     new in 12).</item>
    ///   <item>Jellyfin 10.11 (net9.0 artifact): <c>HasAnyProviderId</c> only allows
    ///     one value per provider key, so the pairs are round-robin chunked into
    ///     dictionaries with at most one value per provider and one query is issued
    ///     per chunk (query count = the largest per-provider value count).</item>
    /// </list>
    /// Both server translations match on the exact "Provider:Value" string
    /// (case-sensitive under SQLite's default BINARY collation), the same semantics
    /// the old raw SQL had.
    /// </summary>
    public class ItemLookupService : IItemLookupService
    {
        private readonly ILibraryManager _libraryManager;

        public ItemLookupService(ILibraryManager libraryManager)
        {
            _libraryManager = libraryManager;
        }

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

            // Collect all matched items first (dedup by id — on 10.11 an item can be
            // returned by several chunk queries), then map pairs in a single pass.
            var matchedItems = new Dictionary<Guid, BaseItem>();
            foreach (var query in BuildBatchQueries(pairs))
            {
                foreach (var item in _libraryManager.GetItemList(query))
                {
                    matchedItems.TryAdd(item.Id, item);
                }
            }

            return MapProviderPairs(matchedItems.Values, pairs);
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
        /// must never reach HasAnyProviderId: there an empty value means "has this
        /// provider at all" (existence match), which would explode the result set;
        /// the old raw SQL simply never matched them.
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
        /// Builds the query list for a batch lookup. See class remarks for the
        /// per-target shape. Pairs must already be normalized.
        /// </summary>
        internal static IReadOnlyList<InternalItemsQuery> BuildBatchQueries(
            IReadOnlyCollection<(string Provider, string Value)> pairs)
        {
#if NET10_0_OR_GREATER
            // Jellyfin 12 target: HasAnyProviderIds takes multiple values per provider,
            // so the whole batch resolves in one query.
            var grouped = pairs
                .GroupBy(p => p.Provider, StringComparer.Ordinal)
                .ToDictionary(
                    g => g.Key,
                    g => g.Select(p => p.Value).Distinct(StringComparer.Ordinal).ToArray(),
                    StringComparer.Ordinal);

            return new[]
            {
                new InternalItemsQuery
                {
                    HasAnyProviderIds = grouped,
                    Recursive = true,
                    DtoOptions = ProviderIdsDtoOptions()
                }
            };
#else
            // Jellyfin 10.11 target: HasAnyProviderId allows one value per provider key.
            return BuildSingleValueChunks(pairs)
                .Select(chunk => new InternalItemsQuery
                {
                    HasAnyProviderId = chunk,
                    Recursive = true,
                    DtoOptions = ProviderIdsDtoOptions()
                })
                .ToList();
#endif
        }

        /// <summary>
        /// Round-robin chunks (Provider, Value) pairs into dictionaries holding at most
        /// one value per provider: chunk i holds the i-th distinct value of every
        /// provider. Chunk count = max distinct values of any single provider.
        /// Compiled (and unit-tested) on both targets; only the 10.11 artifact uses it.
        /// </summary>
        internal static List<Dictionary<string, string>> BuildSingleValueChunks(
            IReadOnlyCollection<(string Provider, string Value)> pairs)
        {
            var groups = pairs
                .GroupBy(p => p.Provider, StringComparer.Ordinal)
                .ToDictionary(
                    g => g.Key,
                    g => g.Select(p => p.Value).Distinct(StringComparer.Ordinal).ToList(),
                    StringComparer.Ordinal);

            var chunks = new List<Dictionary<string, string>>();
            var chunkCount = groups.Count == 0 ? 0 : groups.Values.Max(v => v.Count);
            for (var i = 0; i < chunkCount; i++)
            {
                var chunk = new Dictionary<string, string>(StringComparer.Ordinal);
                foreach (var group in groups)
                {
                    if (i < group.Value.Count)
                        chunk[group.Key] = group.Value[i];
                }

                chunks.Add(chunk);
            }

            return chunks;
        }

        /// <summary>
        /// Maps each requested (Provider, Value) pair to the first matched item that
        /// carries exactly that provider id. Comparison is ordinal (case-sensitive) on
        /// both key and value — the same net behavior as the old raw SQL, whose BINARY
        /// collation match + case-sensitive dictionary lookup was case-sensitive
        /// end-to-end.
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

        /// <summary>
        /// Lean DtoOptions for the batch lookup: only the ProviderIds field is needed
        /// (it drives the Provider navigation include that hydrates
        /// <see cref="BaseItem.ProviderIds"/>); skip images/user-data joins. The old
        /// raw SQL read only the providers table, so this keeps the query light.
        /// </summary>
        private static DtoOptions ProviderIdsDtoOptions()
        {
            return new DtoOptions(false)
            {
                Fields = new[] { ItemFields.ProviderIds },
                EnableImages = false,
                EnableUserData = false
            };
        }
    }
}
