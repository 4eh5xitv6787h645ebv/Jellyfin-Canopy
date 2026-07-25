using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinCanopy.Model.Seerr
{
    /// <summary>
    /// Browser-safe projection of one Seerr Media download row. Raw Arr/downloader
    /// identifiers, release titles, paths, URLs, sizes, and status messages are deliberately
    /// absent from this allowlist.
    /// </summary>
    public sealed class SeerrDownloadStatusDto
    {
        /// <summary>An allowlisted value from the shared Arr lifecycle vocabulary.</summary>
        [JsonPropertyName("lifecycle")]
        public string Lifecycle { get; set; } = string.Empty;

        /// <summary>Transfer progress only; it does not imply import or availability.</summary>
        [JsonPropertyName("progress")]
        public double? Progress { get; set; }

        /// <summary>A validated invariant duration, never an upstream free-form message.</summary>
        [JsonPropertyName("timeRemaining")]
        public string? TimeRemaining { get; set; }

        /// <summary>Safe TV grouping metadata used by the season request UI.</summary>
        [JsonPropertyName("seasonNumber")]
        public int? SeasonNumber { get; set; }
    }
}
