using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinElevate.Model.Awards;

namespace Jellyfin.Plugin.JellyfinElevate.Services.Awards
{
    /// <summary>
    /// The outcome of an awards fetch: the rows collected, plus whether the run was
    /// <see cref="Complete"/> (every sub-query succeeded). A partial run still returns the rows
    /// it got, but the caller must NOT publish a partial run over an existing complete index —
    /// otherwise a single timed-out ceremony query would erase all of that ceremony's awards
    /// until a later full success.
    /// </summary>
    public sealed record AwardsFetchResult(IReadOnlyList<AwardRow> Rows, bool Complete);

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
        /// cancellation. A single failing sub-query must not abort the whole run (partial data
        /// beats none), but the result's <see cref="AwardsFetchResult.Complete"/> flag reports
        /// whether ANY sub-query failed so the caller can avoid overwriting a good index with a
        /// partial one. Throws only when it could not fetch anything at all.
        /// </summary>
        Task<AwardsFetchResult> FetchAllAsync(IProgress<double>? progress, CancellationToken cancellationToken);
    }
}
