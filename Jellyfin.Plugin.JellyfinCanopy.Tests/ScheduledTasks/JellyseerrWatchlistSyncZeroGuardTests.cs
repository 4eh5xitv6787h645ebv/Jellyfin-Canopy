using Jellyfin.Plugin.JellyfinCanopy.ScheduledTasks;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.ScheduledTasks
{
    /// <summary>
    /// Zero-as-key guard for the Seerr→Jellyfin watchlist SYNC TASK. Seerr can carry a watchlist
    /// item with tmdbId 0/absent (an unknown-provider entry). Left as 0 it would match a Jellyfin
    /// item stored with ProviderIds["Tmdb"]=="0" and "like" the wrong item. The library match must
    /// therefore drop a 0 id, mirroring the WatchlistMonitor drop-zero guard (via ArrIdHelper).
    /// </summary>
    public class JellyseerrWatchlistSyncZeroGuardTests
    {
        [Theory]
        [InlineData("550", 550, true)]     // real id matches
        [InlineData("0", 0, false)]        // unknown-provider item must not match the "0" placeholder
        [InlineData("0", 550, false)]      // a real request never matches a "0" library item
        [InlineData("550", 0, false)]      // a 0-tmdb watchlist item matches nothing
        [InlineData("551", 550, false)]    // genuine mismatch
        [InlineData(null, 550, false)]     // item carries no Tmdb string
        public void MatchesTmdb_DropsZeroAndRejectsMismatches(string? itemTmdbId, int watchlistTmdbId, bool expected)
            => Assert.Equal(expected, JellyseerrWatchlistSyncTask.MatchesTmdb(itemTmdbId, watchlistTmdbId));
    }
}
