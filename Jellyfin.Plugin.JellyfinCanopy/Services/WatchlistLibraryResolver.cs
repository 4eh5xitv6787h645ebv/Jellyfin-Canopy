using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using Jellyfin.Plugin.JellyfinCanopy.Data;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.JellyfinCanopy.Services
{
    /// <summary>
    /// Resolves Seerr movie/TV identities to every type-correct Jellyfin edition a
    /// user may currently access. Provider resolution, access projection and item
    /// materialization are each batched; callers can take a second snapshot at their
    /// mutation boundary to close over revocation during asynchronous preparation.
    /// </summary>
    internal sealed class WatchlistLibraryResolver
    {
        internal const int MaximumProviderPairs = 25_000;
        internal const int MaximumCandidates = 100_000;
        internal const int MaximumResolutionRequests = 100_000;
        internal const int MaximumCandidateProjections = 250_000;
        internal const int AccessProjectionBatchSize = 1_000;
        internal const int MaterializationBatchSize = 1_000;

        private readonly ILibraryManager _libraryManager;
        private readonly IItemLookupService _itemLookup;

        public WatchlistLibraryResolver(
            ILibraryManager libraryManager,
            IItemLookupService itemLookup)
        {
            _libraryManager = libraryManager;
            _itemLookup = itemLookup;
        }

        public WatchlistLibraryBatch Resolve(
            IReadOnlyCollection<WatchlistMediaKey> keys,
            IReadOnlyCollection<JUser> users,
            IReadOnlyCollection<BaseItem>? knownItems = null,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (keys.Count > MaximumResolutionRequests
                || users.Count > MaximumResolutionRequests)
            {
                return WatchlistLibraryBatch.Incomplete;
            }

            var uniqueKeys = keys
                .Where(static key => key.IsValid)
                .Distinct()
                .ToList();
            var uniqueUsers = users
                .GroupBy(static user => user.Id)
                .Select(static group => group.First())
                .ToList();

            // This overload intentionally means every user needs every key. Prove
            // that the cross-product fits the aggregate work budget before
            // constructing it; the sparse overload below is preferred for bulk
            // callers whose users own different key sets.
            if (uniqueUsers.Count > 0
                && uniqueKeys.Count > MaximumResolutionRequests / uniqueUsers.Count)
            {
                return WatchlistLibraryBatch.Incomplete;
            }

            var requests = new List<WatchlistLibraryRequest>(uniqueKeys.Count * uniqueUsers.Count);
            foreach (var user in uniqueUsers)
            {
                cancellationToken.ThrowIfCancellationRequested();
                foreach (var key in uniqueKeys)
                {
                    requests.Add(new WatchlistLibraryRequest(user, key));
                }
            }

            return Resolve(requests, knownItems, cancellationToken);
        }

        public WatchlistLibraryBatch Resolve(
            IReadOnlyCollection<WatchlistLibraryRequest> requests,
            IReadOnlyCollection<BaseItem>? knownItems = null,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (requests.Count > MaximumResolutionRequests
                || knownItems?.Count > MaximumCandidates)
            {
                return WatchlistLibraryBatch.Incomplete;
            }

            var usersById = new Dictionary<Guid, JUser>();
            var keysByUserId = new Dictionary<Guid, HashSet<WatchlistMediaKey>>();
            var resolutionCount = 0;
            foreach (var request in requests)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (!request.Key.IsValid)
                {
                    continue;
                }

                usersById.TryAdd(request.User.Id, request.User);
                if (!keysByUserId.TryGetValue(request.User.Id, out var userKeys))
                {
                    userKeys = new HashSet<WatchlistMediaKey>();
                    keysByUserId.Add(request.User.Id, userKeys);
                }

                if (userKeys.Add(request.Key))
                {
                    if (resolutionCount >= MaximumResolutionRequests)
                    {
                        return WatchlistLibraryBatch.Incomplete;
                    }

                    resolutionCount++;
                }
            }

            if (resolutionCount == 0)
            {
                return new WatchlistLibraryBatch(
                    new Dictionary<
                        Guid,
                        IReadOnlyDictionary<WatchlistMediaKey, WatchlistLibraryMatch>>(),
                    true);
            }

            var uniqueKeys = keysByUserId.Values
                .SelectMany(static keys => keys)
                .Distinct()
                .ToList();
            var providerPairs = uniqueKeys
                .Select(static key => key.ProviderPair)
                .Distinct()
                .ToList();

            var candidateBatch = _itemLookup.GetItemCandidatesByProvidersBatchBounded(
                providerPairs,
                MaximumProviderPairs,
                MaximumCandidates);
            cancellationToken.ThrowIfCancellationRequested();
            if (!candidateBatch.IsComplete)
            {
                return WatchlistLibraryBatch.Incomplete;
            }

            var candidates = candidateBatch.Candidates.ToDictionary(
                static pair => pair.Key,
                static pair => (IReadOnlyList<ItemLookupCandidate>)pair.Value.ToList());
            if (knownItems != null)
            {
                // An ItemAdded event may arrive before the provider index query can
                // observe that exact item. Merge only the explicitly supplied,
                // identity-checked items; the batch lookup still supplies every
                // alternate edition already present in the library index.
                var knownCandidates = ItemLookupService.MapProviderPairs(
                    knownItems,
                    providerPairs);
                foreach (var (pair, matches) in knownCandidates)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    var merged = candidates.GetValueOrDefault(pair)
                        ?.Concat(matches)
                        ?? matches;
                    candidates[pair] = merged
                        .DistinctBy(static candidate => candidate.ItemId)
                        .OrderBy(static candidate => candidate.ItemId)
                        .ToList();
                }
            }

            if (candidates.Values.Sum(static matches => (long)matches.Count) > MaximumCandidates)
            {
                return WatchlistLibraryBatch.Incomplete;
            }

            var candidatesByKey = uniqueKeys.ToDictionary(
                static key => key,
                key => (IReadOnlyList<ItemLookupCandidate>)GetTypeCorrectCandidates(candidates, key)
                    .ToList());
            long candidateProjectionCount = 0;
            foreach (var userKeys in keysByUserId.Values)
            {
                cancellationToken.ThrowIfCancellationRequested();
                foreach (var key in userKeys)
                {
                    candidateProjectionCount += candidatesByKey.GetValueOrDefault(key)?.Count ?? 0;
                    if (candidateProjectionCount > MaximumCandidateProjections)
                    {
                        return WatchlistLibraryBatch.Incomplete;
                    }
                }
            }

            var accessibleIdsByUser = new Dictionary<Guid, IReadOnlySet<Guid>>();
            var candidateIdSet = new HashSet<Guid>();
            foreach (var (userId, userKeys) in keysByUserId)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var userCandidateIds = userKeys
                    .SelectMany(key => candidatesByKey.GetValueOrDefault(key)
                        ?? Array.Empty<ItemLookupCandidate>())
                    .Select(static candidate => candidate.ItemId)
                    .Distinct()
                    .ToList();
                candidateIdSet.UnionWith(userCandidateIds);
                accessibleIdsByUser[userId] = GetAccessibleItemIdsBounded(
                    userCandidateIds,
                    usersById[userId],
                    cancellationToken);
            }

            var accessibleCandidateIds = accessibleIdsByUser.Values
                .SelectMany(static ids => ids)
                .Where(candidateIdSet.Contains)
                .Distinct()
                .ToHashSet();
            var itemsById = (knownItems ?? Array.Empty<BaseItem>())
                .Where(item => accessibleCandidateIds.Contains(item.Id))
                .GroupBy(static item => item.Id)
                .ToDictionary(static group => group.Key, static group => group.First());
            var missingIds = accessibleCandidateIds
                .Where(id => !itemsById.ContainsKey(id))
                .ToArray();
            if (missingIds.Length > 0)
            {
                for (var offset = 0; offset < missingIds.Length; offset += MaterializationBatchSize)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    var itemIds = missingIds
                        .Skip(offset)
                        .Take(MaterializationBatchSize)
                        .ToArray();
                    var materialized = _libraryManager.GetItemList(new InternalItemsQuery
                    {
                        ItemIds = itemIds,
                        Recursive = true,
                        Limit = itemIds.Length + 1
                    });
                    cancellationToken.ThrowIfCancellationRequested();

                    foreach (var item in materialized)
                    {
                        if (accessibleCandidateIds.Contains(item.Id))
                        {
                            itemsById.TryAdd(item.Id, item);
                        }
                    }
                }
            }

            var resolutions = new Dictionary<
                Guid,
                IReadOnlyDictionary<WatchlistMediaKey, WatchlistLibraryMatch>>();
            foreach (var (userId, userKeys) in keysByUserId)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var allowedIds = accessibleIdsByUser[userId];
                var userResolutions = new Dictionary<WatchlistMediaKey, WatchlistLibraryMatch>();
                foreach (var key in userKeys)
                {
                    var typeCorrectCandidates = candidatesByKey.GetValueOrDefault(key)
                        ?? Array.Empty<ItemLookupCandidate>();
                    if (typeCorrectCandidates.Count == 0)
                    {
                        userResolutions[key] = WatchlistLibraryMatch.NotInLibrary;
                        continue;
                    }

                    var accessibleItems = typeCorrectCandidates
                        .Where(candidate => allowedIds.Contains(candidate.ItemId))
                        .Select(candidate => itemsById.GetValueOrDefault(candidate.ItemId))
                        .Where(item => item != null && MatchesIdentity(item, key))
                        .Cast<BaseItem>()
                        .DistinctBy(static item => item.Id)
                        .OrderBy(static item => item.Id)
                        .ToList();
                    userResolutions[key] = accessibleItems.Count == 0
                        ? WatchlistLibraryMatch.Inaccessible
                        : new WatchlistLibraryMatch(
                            WatchlistLibraryMatchState.Accessible,
                            accessibleItems);
                }

                resolutions[userId] = userResolutions;
            }

            return new WatchlistLibraryBatch(resolutions, true);
        }

        /// <summary>
        /// Resolves a sparse request set while flattening the caller's bounded
        /// library snapshot once per distinct requested media key. The count pass
        /// rejects an oversized projection before any edition list is enumerated
        /// and, because the provider lookup occurs in the delegated overload, before
        /// any provider or access query is issued.
        /// </summary>
        public WatchlistLibraryBatch Resolve<TCollection>(
            IReadOnlyCollection<WatchlistLibraryRequest> requests,
            IReadOnlyDictionary<WatchlistMediaKey, TCollection> knownItemsByKey,
            CancellationToken cancellationToken = default)
            where TCollection : IReadOnlyCollection<BaseItem>
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (requests.Count > MaximumResolutionRequests)
            {
                return WatchlistLibraryBatch.Incomplete;
            }

            var requestedKeys = requests
                .Select(static request => request.Key)
                .Where(static key => key.IsValid)
                .Distinct()
                .ToList();
            long projectedItemCount = 0;
            foreach (var key in requestedKeys)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (!knownItemsByKey.TryGetValue(key, out var editions))
                {
                    continue;
                }

                projectedItemCount += editions.Count;
                if (projectedItemCount > MaximumCandidates)
                {
                    return WatchlistLibraryBatch.Incomplete;
                }
            }

            var knownItems = new List<BaseItem>((int)projectedItemCount);
            var knownItemIds = new HashSet<Guid>();
            var enumeratedItemCount = 0;
            foreach (var key in requestedKeys)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (!knownItemsByKey.TryGetValue(key, out var editions))
                {
                    continue;
                }

                foreach (var item in editions)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (enumeratedItemCount >= MaximumCandidates)
                    {
                        return WatchlistLibraryBatch.Incomplete;
                    }

                    enumeratedItemCount++;
                    if (knownItemIds.Add(item.Id))
                    {
                        knownItems.Add(item);
                    }
                }
            }

            return Resolve(requests, knownItems, cancellationToken);
        }

        /// <summary>
        /// Revalidates one already-selected edition at the narrow local-mutation
        /// boundary. This intentionally avoids another provider search: the item id
        /// is fixed, identity-checked, and projected through the live user policy
        /// before its user data is saved or marked processed.
        /// </summary>
        public BaseItem? RevalidateSelection(
            JUser user,
            WatchlistMediaKey key,
            BaseItem item,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!key.IsValid
                || item.Id == Guid.Empty
                || !MatchesIdentity(item, key))
            {
                return null;
            }

            var accessibleIds = GetAccessibleItemIdsBounded(
                new[] { item.Id },
                user,
                cancellationToken);
            return accessibleIds.Contains(item.Id)
                ? item
                : null;
        }

        /// <summary>
        /// Reprojects a previously bounded, type-correct edition set through the
        /// target user's live access policy. The provider lookup remains batched at
        /// the caller; this boundary performs one fixed-id access query and returns
        /// only identities that still match the requested typed media key.
        /// </summary>
        public IReadOnlyList<BaseItem> RevalidateAccessibleItems(
            JUser user,
            WatchlistMediaKey key,
            IReadOnlyList<BaseItem> items,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!key.IsValid || items.Count == 0)
            {
                return Array.Empty<BaseItem>();
            }

            var candidates = items
                .Where(item => item.Id != Guid.Empty && MatchesIdentity(item, key))
                .DistinctBy(static item => item.Id)
                .OrderBy(static item => item.Id)
                .ToList();
            if (candidates.Count == 0)
            {
                return Array.Empty<BaseItem>();
            }

            var accessibleIds = GetAccessibleItemIdsBounded(
                candidates.Select(static item => item.Id).ToArray(),
                user,
                cancellationToken);
            return candidates
                .Where(item => accessibleIds.Contains(item.Id))
                .ToList();
        }

        /// <summary>
        /// Projects a deterministic fixed-id set through Jellyfin's live user
        /// policy in bounded queries. Only ids requested in the corresponding
        /// chunk may enter the union, so an unexpected host result fails closed.
        /// The synchronous host API cannot be awaited, but yielding between chunks
        /// prevents one large user projection from monopolizing the worker thread.
        /// </summary>
        internal IReadOnlySet<Guid> GetAccessibleItemIdsBounded(
            IEnumerable<Guid> itemIds,
            JUser user,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var orderedIds = itemIds
                .Where(static id => id != Guid.Empty)
                .Distinct()
                .OrderBy(static id => id)
                .ToList();
            var accessibleIds = new HashSet<Guid>();
            for (var offset = 0; offset < orderedIds.Count; offset += AccessProjectionBatchSize)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var batch = orderedIds
                    .Skip(offset)
                    .Take(AccessProjectionBatchSize)
                    .ToArray();
                var batchSet = batch.ToHashSet();
                var batchAccessibleIds = _itemLookup.GetAccessibleItemIdsBatch(batch, user);
                cancellationToken.ThrowIfCancellationRequested();
                foreach (var accessibleId in batchAccessibleIds)
                {
                    if (batchSet.Contains(accessibleId))
                    {
                        accessibleIds.Add(accessibleId);
                    }
                }

                if (offset + batch.Length < orderedIds.Count)
                {
                    Thread.Yield();
                    cancellationToken.ThrowIfCancellationRequested();
                }
            }

            return accessibleIds;
        }

        private static IEnumerable<ItemLookupCandidate> GetTypeCorrectCandidates(
            Dictionary<(string Provider, string Value), IReadOnlyList<ItemLookupCandidate>> candidates,
            WatchlistMediaKey key)
            => candidates.TryGetValue(key.ProviderPair, out var matches)
                ? matches.Where(candidate => candidate.Kind == key.ExpectedKind)
                : Enumerable.Empty<ItemLookupCandidate>();

        private static bool MatchesIdentity(BaseItem item, WatchlistMediaKey key)
            => ItemLookupService.GetItemKind(item) == key.ExpectedKind
                && item.ProviderIds.TryGetValue("Tmdb", out var tmdbId)
                && string.Equals(tmdbId, key.ProviderPair.Value, StringComparison.Ordinal);
    }

    internal readonly record struct WatchlistLibraryRequest(
        JUser User,
        WatchlistMediaKey Key);

    internal readonly record struct WatchlistMediaKey(string MediaType, int TmdbId)
    {
        public bool IsValid
            => TmdbId > 0
                && (string.Equals(MediaType, "movie", StringComparison.Ordinal)
                    || string.Equals(MediaType, "tv", StringComparison.Ordinal));

        public ItemLookupKind ExpectedKind
            => string.Equals(MediaType, "movie", StringComparison.Ordinal)
                ? ItemLookupKind.Movie
                : string.Equals(MediaType, "tv", StringComparison.Ordinal)
                    ? ItemLookupKind.Series
                    : ItemLookupKind.Other;

        public (string Provider, string Value) ProviderPair
            => ("Tmdb", TmdbId.ToString(CultureInfo.InvariantCulture));
    }

    internal enum WatchlistLibraryMatchState
    {
        NotInLibrary,
        Inaccessible,
        Accessible
    }

    internal sealed record WatchlistLibraryMatch(
        WatchlistLibraryMatchState State,
        IReadOnlyList<BaseItem> AccessibleItems)
    {
        public static WatchlistLibraryMatch NotInLibrary { get; } = new(
            WatchlistLibraryMatchState.NotInLibrary,
            Array.Empty<BaseItem>());

        public static WatchlistLibraryMatch Inaccessible { get; } = new(
            WatchlistLibraryMatchState.Inaccessible,
            Array.Empty<BaseItem>());

        public BaseItem? SelectedItem => AccessibleItems.FirstOrDefault();

        /// <summary>
        /// Chooses an already-liked accessible edition first. If none is liked,
        /// chooses the lowest-id accessible edition for which Jellyfin returned
        /// user data. Both passes preserve the resolver's deterministic id order.
        /// </summary>
        public WatchlistLibrarySelection? SelectPreferred(
            IReadOnlyDictionary<Guid, UserItemData> userDataByItemId)
        {
            foreach (var item in AccessibleItems)
            {
                if (userDataByItemId.TryGetValue(item.Id, out var userData)
                    && userData.Likes == true)
                {
                    return new WatchlistLibrarySelection(item, userData);
                }
            }

            foreach (var item in AccessibleItems)
            {
                if (userDataByItemId.TryGetValue(item.Id, out var userData))
                {
                    return new WatchlistLibrarySelection(item, userData);
                }
            }

            return null;
        }
    }

    internal sealed record WatchlistLibrarySelection(
        BaseItem Item,
        UserItemData UserData);

    internal sealed class WatchlistLibraryBatch
    {
        private readonly IReadOnlyDictionary<
            Guid,
            IReadOnlyDictionary<WatchlistMediaKey, WatchlistLibraryMatch>> _resolutions;

        public WatchlistLibraryBatch(
            IReadOnlyDictionary<Guid, IReadOnlyDictionary<WatchlistMediaKey, WatchlistLibraryMatch>> resolutions,
            bool isComplete)
        {
            _resolutions = resolutions;
            IsComplete = isComplete;
        }

        public static WatchlistLibraryBatch Incomplete { get; } = new(
            new Dictionary<Guid, IReadOnlyDictionary<WatchlistMediaKey, WatchlistLibraryMatch>>(),
            false);

        public bool IsComplete { get; }

        public WatchlistLibraryMatch Get(JUser user, WatchlistMediaKey key)
            => _resolutions.TryGetValue(user.Id, out var userResolutions)
                && userResolutions.TryGetValue(key, out var resolution)
                    ? resolution
                    : WatchlistLibraryMatch.NotInLibrary;
    }
}
