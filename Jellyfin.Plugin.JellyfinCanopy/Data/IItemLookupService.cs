using System;
using System.Collections.Generic;

namespace Jellyfin.Plugin.JellyfinCanopy.Data
{
    /// <summary>
    /// Resolves Jellyfin library items from external provider IDs (Tvdb/Tmdb/Imdb/...).
    /// Uses only the supported <c>ILibraryManager</c> query surface (Jellyfin 12's
    /// internal DB schema is not a plugin API). See <see cref="ItemLookupService"/>.
    /// </summary>
    public interface IItemLookupService
    {
        /// <summary>
        /// Returns the ids of all items matching ANY of the supplied provider id pairs.
        /// Mirrors <c>InternalItemsQuery.HasAnyProviderId</c> semantics: an empty/null
        /// value for a provider matches every item that has that provider set at all.
        /// </summary>
        /// <param name="providers">Provider name → provider value (e.g. "Tvdb" → "121361").</param>
        /// <param name="user">
        /// When non-null, scopes the query to the caller's accessible libraries so a
        /// non-admin cannot resolve ids for content they can't see. Null resolves across
        /// all libraries (server-side callers with no user context).
        /// </param>
        /// <returns>Matching item ids; empty when <paramref name="providers"/> is null or empty.</returns>
        IReadOnlyList<Guid> GetItemIdsByProviders(IDictionary<string, string>? providers, JUser? user = null);

        /// <summary>
        /// Batch-resolves many (Provider, Value) pairs at once and returns a map of each
        /// matched pair to one item id (first match wins when several items share the
        /// same provider id). Pairs with a null/blank provider or value are ignored.
        /// Matching is exact (case-sensitive), like the server's provider-id storage.
        /// </summary>
        /// <param name="providers">The (Provider, Value) pairs to resolve.</param>
        /// <returns>Map of matched (Provider, Value) pairs to item ids. Unmatched pairs are absent.</returns>
        Dictionary<(string Provider, string Value), Guid> GetItemIdsByProvidersBatch(
            IReadOnlyCollection<(string Provider, string Value)> providers);
    }
}
