using System;
using System.Collections.Generic;
using System.Threading;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinCanopy.Services
{
    /// <summary>
    /// Resolves item identities to their canonical parent series through one
    /// user-scoped Jellyfin query. DTO filters whose response shape omits
    /// <c>SeriesId</c> share this owner instead of probing items one at a time.
    /// </summary>
    public sealed class HiddenContentHierarchyResolver
    {
        internal const int MaximumItemIds = 512;

        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;

        public HiddenContentHierarchyResolver(ILibraryManager libraryManager, IUserManager userManager)
        {
            _libraryManager = libraryManager;
            _userManager = userManager;
        }

        /// <summary>
        /// Resolves at most <see cref="MaximumItemIds"/> unique item IDs as one
        /// atomic operation. A successful result can omit IDs only when Jellyfin
        /// did not return an accessible Episode/Season with a live parent series.
        /// No partial map is returned for cancellation or a transient query fault.
        /// </summary>
        internal HiddenContentHierarchyResolution ResolveSeriesIds(
            Guid userId,
            IReadOnlyCollection<Guid> itemIds,
            CancellationToken cancellationToken)
        {
            if (cancellationToken.IsCancellationRequested)
            {
                return HiddenContentHierarchyResolution.Failed(HiddenContentHierarchyResolutionStatus.Cancelled);
            }

            var uniqueIds = new HashSet<Guid>();
            foreach (var itemId in itemIds)
            {
                if (cancellationToken.IsCancellationRequested)
                {
                    return HiddenContentHierarchyResolution.Failed(HiddenContentHierarchyResolutionStatus.Cancelled);
                }

                if (itemId == Guid.Empty || !uniqueIds.Add(itemId)) continue;
                if (uniqueIds.Count > MaximumItemIds)
                {
                    return HiddenContentHierarchyResolution.Failed(HiddenContentHierarchyResolutionStatus.TooManyCandidates);
                }
            }

            if (uniqueIds.Count == 0)
            {
                return HiddenContentHierarchyResolution.Succeeded(new Dictionary<Guid, Guid>());
            }

            User? user;
            try
            {
                user = _userManager.GetUserById(userId);
            }
            catch
            {
                return HiddenContentHierarchyResolution.Failed(HiddenContentHierarchyResolutionStatus.UserResolutionFailed);
            }

            if (user is null)
            {
                return HiddenContentHierarchyResolution.Failed(HiddenContentHierarchyResolutionStatus.UserResolutionFailed);
            }

            IReadOnlyList<MediaBrowser.Controller.Entities.BaseItem> items;
            try
            {
                cancellationToken.ThrowIfCancellationRequested();
                var query = new InternalItemsQuery(user)
                {
                    ItemIds = Array.Empty<Guid>(),
                };

                // Jellyfin 12 deliberately skips its normal enabled-library
                // derivation when ItemIds is already populated. Configure access
                // while the exact-ID set is still empty so TopParentIds is owned
                // by Jellyfin's canonical user-access implementation.
                _libraryManager.ConfigureUserAccess(query, user);
                cancellationToken.ThrowIfCancellationRequested();

                query.ItemIds = new List<Guid>(uniqueIds).ToArray();
                query.Recursive = true;
                query.Limit = uniqueIds.Count;
                items = _libraryManager.GetItemList(query);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return HiddenContentHierarchyResolution.Failed(HiddenContentHierarchyResolutionStatus.Cancelled);
            }
            catch
            {
                return HiddenContentHierarchyResolution.Failed(HiddenContentHierarchyResolutionStatus.QueryFailed);
            }

            if (cancellationToken.IsCancellationRequested)
            {
                return HiddenContentHierarchyResolution.Failed(HiddenContentHierarchyResolutionStatus.Cancelled);
            }

            // The query limit bounds the real Jellyfin result. Keep the owner
            // fail-closed if an implementation violates that contract rather
            // than traversing or publishing an unbounded partial response.
            if (items.Count > MaximumItemIds)
            {
                return HiddenContentHierarchyResolution.Failed(HiddenContentHierarchyResolutionStatus.QueryFailed);
            }

            var seriesByItemId = new Dictionary<Guid, Guid>();
            foreach (var item in items)
            {
                if (cancellationToken.IsCancellationRequested)
                {
                    return HiddenContentHierarchyResolution.Failed(HiddenContentHierarchyResolutionStatus.Cancelled);
                }

                if (!uniqueIds.Contains(item.Id)) continue;
                var seriesId = item switch
                {
                    Episode episode => episode.SeriesId,
                    Season season => season.SeriesId,
                    _ => Guid.Empty,
                };
                if (seriesId != Guid.Empty)
                {
                    seriesByItemId[item.Id] = seriesId;
                }
            }

            return HiddenContentHierarchyResolution.Succeeded(seriesByItemId);
        }
    }

    internal enum HiddenContentHierarchyResolutionStatus
    {
        Success,
        Cancelled,
        TooManyCandidates,
        UserResolutionFailed,
        QueryFailed,
    }

    internal sealed class HiddenContentHierarchyResolution
    {
        private HiddenContentHierarchyResolution(
            HiddenContentHierarchyResolutionStatus status,
            IReadOnlyDictionary<Guid, Guid> seriesByItemId)
        {
            Status = status;
            SeriesByItemId = seriesByItemId;
        }

        public HiddenContentHierarchyResolutionStatus Status { get; }

        public IReadOnlyDictionary<Guid, Guid> SeriesByItemId { get; }

        public bool IsSuccess => Status == HiddenContentHierarchyResolutionStatus.Success;

        public static HiddenContentHierarchyResolution Succeeded(IReadOnlyDictionary<Guid, Guid> seriesByItemId)
            => new(HiddenContentHierarchyResolutionStatus.Success, seriesByItemId);

        public static HiddenContentHierarchyResolution Failed(HiddenContentHierarchyResolutionStatus status)
            => new(status, new Dictionary<Guid, Guid>());
    }
}
