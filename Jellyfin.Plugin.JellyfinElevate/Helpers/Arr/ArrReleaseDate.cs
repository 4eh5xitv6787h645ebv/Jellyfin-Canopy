using System;
using System.Globalization;

namespace Jellyfin.Plugin.JellyfinElevate.Helpers.Arr
{
    /// <summary>
    /// Single source of truth for how a parsed arr release <see cref="DateTime"/> is emitted to the client.
    /// A date-only release (Radarr cinema/digital/physical; Sonarr airDate fallback) must ship a stable
    /// "yyyy-MM-dd" bucket key so the client renders it on the correct LOCAL day with no spurious clock
    /// time. A genuine instant (Sonarr airDateUtc) ships the full ISO string and no local-date key so the
    /// client keeps timezone-converting it.
    /// </summary>
    public static class ArrReleaseDate
    {
        /// <summary>
        /// Emit the (releaseDate, releaseDateLocal) contract for a parsed arr release date.
        /// </summary>
        /// <param name="utc">The parsed release DateTime (assumed/normalised to UTC by the caller).</param>
        /// <param name="dateOnly">True for date-only shapes; false for genuine instants.</param>
        /// <returns>The ISO-8601 release string and, when <paramref name="dateOnly"/> is true, the
        /// "yyyy-MM-dd" local bucket key (otherwise null).</returns>
        public static (string ReleaseDate, string? ReleaseDateLocal) Build(DateTime utc, bool dateOnly)
        {
            var normalized = utc.ToUniversalTime();
            var iso = normalized.ToString("o", CultureInfo.InvariantCulture);
            // For a date-only value the server parsed it AssumeUniversal, so the UTC date IS the
            // intended calendar date (Radarr emits midnight-Z). Take the date portion directly.
            var local = dateOnly
                ? normalized.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)
                : (string?)null;
            return (iso, local);
        }
    }
}
