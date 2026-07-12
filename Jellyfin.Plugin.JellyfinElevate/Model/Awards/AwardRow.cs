namespace Jellyfin.Plugin.JellyfinElevate.Model.Awards
{
    /// <summary>
    /// A flat award record as produced by an <c>IAwardsProvider</c> before it is grouped
    /// into the per-title index. Each row identifies a title by whatever external ids the
    /// source exposed (IMDb and/or TMDb) plus one award result. The cache service groups
    /// rows by title and deduplicates them; providers only need to emit rows.
    /// </summary>
    public sealed class AwardRow
    {
        /// <summary>IMDb id including the "tt" prefix (e.g. "tt6710474"), or null.</summary>
        public string? ImdbId { get; set; }

        /// <summary>TMDb numeric id as a string (e.g. "545611"), or null.</summary>
        public string? TmdbId { get; set; }

        /// <summary>"movie" or "tv" — selects which TMDb id namespace <see cref="TmdbId"/> lives in.</summary>
        public string MediaType { get; set; } = "movie";

        /// <summary>The awarding body/ceremony label.</summary>
        public string Ceremony { get; set; } = string.Empty;

        /// <summary>The award category label.</summary>
        public string Category { get; set; } = string.Empty;

        /// <summary>Ceremony year, when known.</summary>
        public int? Year { get; set; }

        /// <summary>True for a win; false for a nomination.</summary>
        public bool Won { get; set; }
    }
}
