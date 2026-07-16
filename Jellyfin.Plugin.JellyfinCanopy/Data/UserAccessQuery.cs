using System;
using System.Collections.Generic;
using System.Linq;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinCanopy.Data
{
    /// <summary>
    /// Builds an item-id query without bypassing Jellyfin's top-parent library projection.
    /// Jellyfin deliberately skips that projection if ItemIds is already populated, so user
    /// access must be configured first and the caller-supplied ids assigned afterward.
    /// </summary>
    public static class UserAccessQuery
    {
        public static InternalItemsQuery BuildItemIds(
            ILibraryManager libraryManager,
            JUser user,
            IReadOnlyCollection<Guid> itemIds)
        {
            var query = new InternalItemsQuery(user)
            {
                Recursive = true
            };
            libraryManager.ConfigureUserAccess(query, user);
            query.ItemIds = itemIds.Distinct().ToArray();
            return query;
        }
    }
}
