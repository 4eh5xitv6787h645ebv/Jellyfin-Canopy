using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinElevate.Model.Awards;

namespace Jellyfin.Plugin.JellyfinElevate.Services.Awards
{
    /// <summary>
    /// Source of the global awards dataset. An implementation performs a bounded number of
    /// bulk queries (independent of library size) and returns flat <see cref="AwardRow"/>
    /// records keyed by external id; the cache service groups and indexes them. Kept as an
    /// interface so the data source (Wikidata today) can be swapped or extended without
    /// touching the cache/task/controller layers.
    /// </summary>
    public interface IAwardsProvider
    {
        /// <summary>
        /// Fetch every tracked award record. Reports coarse progress (0-100) and honors
        /// cancellation. Returns whatever it could collect; a single failing sub-query must
        /// not abort the whole run (partial data beats none). Throws only when it could not
        /// fetch anything at all, so the caller can decide whether to keep the previous index.
        /// </summary>
        Task<IReadOnlyList<AwardRow>> FetchAllAsync(IProgress<double>? progress, CancellationToken cancellationToken);
    }
}
