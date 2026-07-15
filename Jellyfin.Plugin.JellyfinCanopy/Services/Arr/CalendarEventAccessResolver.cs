using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.JellyfinCanopy.Data;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Jellyfin.Plugin.JellyfinCanopy.Model.Arr;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Arr
{
    /// <summary>
    /// Pure owner for Calendar item selection and tri-state access. Keeping the combined decision
    /// out of the controller makes the old filter/dedup triggers directly regression-testable.
    /// </summary>
    public static class CalendarEventAccessResolver
    {
        public static Dictionary<ArrItem, CalendarAccessState> Resolve(
            IReadOnlyCollection<ArrItem> events,
            Dictionary<(string Provider, string Value), IReadOnlyList<ItemLookupCandidate>> itemMap,
            IReadOnlySet<Guid>? accessibleIds,
            CalendarAccessPolicy? rootAccessPolicy,
            bool filterByLibraryAccess)
        {
            var accessByEvent = new Dictionary<ArrItem, CalendarAccessState>();

            foreach (var item in events)
            {
                var expectedKind = item.Type == "Movie" ? ItemLookupKind.Movie : ItemLookupKind.Series;
                var providers = ProviderHelper.GetProviders(item);

                if (!filterByLibraryAccess)
                {
                    item.ItemId = ProviderHelper.GetBestItemId(providers, itemMap, expectedKind);
                    item.ItemEpisodeId = ProviderHelper.GetBestItemId(
                        ProviderHelper.GetEpisodeProviders(item), itemMap, ItemLookupKind.Episode);
                    accessByEvent[item] = CalendarAccessState.Accessible;
                    continue;
                }

                bool CorrelatesMain(ItemLookupCandidate candidate)
                    => rootAccessPolicy?.Correlates(item, candidate, expectedKind) == true;
                bool CorrelatesEpisode(ItemLookupCandidate candidate)
                    => rootAccessPolicy?.Correlates(item, candidate, ItemLookupKind.Episode) == true;

                item.ItemId = accessibleIds == null
                    ? null
                    : ProviderHelper.GetBestItemId(
                        providers, itemMap, expectedKind, accessibleIds, CorrelatesMain);
                item.ItemEpisodeId = accessibleIds == null
                    ? null
                    : ProviderHelper.GetBestItemId(
                        ProviderHelper.GetEpisodeProviders(item),
                        itemMap,
                        ItemLookupKind.Episode,
                        accessibleIds,
                        CorrelatesEpisode);

                if (item.ItemId.HasValue)
                {
                    accessByEvent[item] = CalendarAccessState.Accessible;
                }
                else if (ProviderHelper.HasCandidate(providers, itemMap, expectedKind, CorrelatesMain))
                {
                    accessByEvent[item] = CalendarAccessState.Inaccessible;
                }
                else
                {
                    accessByEvent[item] = rootAccessPolicy?.Resolve(item, expectedKind)
                        ?? CalendarAccessState.Unresolved;
                }
            }

            return accessByEvent;
        }

        /// <summary>
        /// Applies the access-aware cross-instance winner and final positive-evidence filter.
        /// The key selector remains controller-owned because it also defines the public calendar
        /// row identity contract.
        /// </summary>
        public static List<ArrItem> DeduplicateAndFilter(
            IEnumerable<ArrItem> events,
            IReadOnlyDictionary<ArrItem, CalendarAccessState> accessByEvent,
            bool filterByLibraryAccess,
            Func<ArrItem, string> keySelector)
        {
            bool IsAccessible(ArrItem item)
                => accessByEvent.TryGetValue(item, out var state)
                    && state == CalendarAccessState.Accessible;

            var deduped = new Dictionary<string, ArrItem>();
            foreach (var item in events)
            {
                var key = keySelector(item);
                if (!deduped.TryGetValue(key, out var existing))
                {
                    deduped[key] = item;
                    continue;
                }

                var existingAccess = IsAccessible(existing);
                var newAccess = IsAccessible(item);
                ArrItem winner;
                ArrItem loser;
                if (newAccess && !existingAccess)
                {
                    winner = item;
                    loser = existing;
                }
                else if (newAccess == existingAccess && !existing.HasFile && item.HasFile)
                {
                    winner = item;
                    loser = existing;
                }
                else
                {
                    winner = existing;
                    loser = item;
                }

                deduped[key] = winner;
                // Instance metadata is user-visible. Under access filtering, never attach the
                // name/existence of a restricted or unresolved duplicate to an accessible row.
                if (!filterByLibraryAccess || IsAccessible(loser))
                    MergeInstanceNames(winner, loser);
            }

            return deduped.Values
                .Where(item => !filterByLibraryAccess || IsAccessible(item))
                .ToList();
        }

        private static void MergeInstanceNames(ArrItem winner, ArrItem loser)
        {
            if (!string.IsNullOrEmpty(loser.InstanceName)
                && !string.Equals(loser.InstanceName, winner.InstanceName, StringComparison.Ordinal))
            {
                winner.AlsoInInstances ??= new List<string>();
                if (!winner.AlsoInInstances.Contains(loser.InstanceName))
                    winner.AlsoInInstances.Add(loser.InstanceName);
            }

            if (loser.AlsoInInstances == null)
                return;

            winner.AlsoInInstances ??= new List<string>();
            foreach (var name in loser.AlsoInInstances)
            {
                if (!string.Equals(name, winner.InstanceName, StringComparison.Ordinal)
                    && !winner.AlsoInInstances.Contains(name))
                    winner.AlsoInInstances.Add(name);
            }
        }
    }
}
