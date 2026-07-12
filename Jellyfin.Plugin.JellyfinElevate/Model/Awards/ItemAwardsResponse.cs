using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinElevate.Model.Awards
{
    /// <summary>
    /// The awards payload returned to the client for a single item. The client renders
    /// the section only when <see cref="Enabled"/> is true and <see cref="Awards"/> is
    /// non-empty; <see cref="Version"/> lets the client cache per index build.
    /// </summary>
    public sealed class ItemAwardsResponse
    {
        /// <summary>Whether the Awards feature is enabled by the admin.</summary>
        [JsonPropertyName("enabled")]
        public bool Enabled { get; set; }

        /// <summary>
        /// Version of the awards index this response was served from. Monotonic per rebuild,
        /// so the client can key a local cache on it and drop stale entries after a refresh.
        /// </summary>
        [JsonPropertyName("version")]
        public long Version { get; set; }

        /// <summary>
        /// True when the server has never built the index yet (first install before the
        /// scheduled task ran). The client treats this as "not ready" rather than "no awards".
        /// </summary>
        [JsonPropertyName("indexEmpty")]
        public bool IndexEmpty { get; set; }

        /// <summary>
        /// True when the current index came from a fully successful fetch. When false (a partial
        /// index, e.g. one ceremony query failed on first install), an empty award list means
        /// "not fetched yet", not "no awards" — the client keeps retrying rather than caching it.
        /// </summary>
        [JsonPropertyName("indexComplete")]
        public bool IndexComplete { get; set; }

        /// <summary>Awards for this item, most recent first. Empty when the item has none.</summary>
        [JsonPropertyName("awards")]
        public IReadOnlyList<AwardEntry> Awards { get; set; } = System.Array.Empty<AwardEntry>();
    }
}
