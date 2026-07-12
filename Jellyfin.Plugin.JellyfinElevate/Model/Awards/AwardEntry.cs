using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinElevate.Model.Awards
{
    /// <summary>
    /// A single award a title received or was nominated for — the unit stored in the
    /// awards index and returned to the client. Ceremony/Category are human-readable
    /// English labels sourced from Wikidata (e.g. "Academy Awards" / "Best Picture").
    /// Deliberately small: the global index holds tens of thousands of these, so it
    /// avoids per-entry ids/urls the client never needs.
    /// </summary>
    public sealed class AwardEntry
    {
        /// <summary>The awarding body/ceremony, e.g. "Academy Awards", "Golden Globe Awards".</summary>
        [JsonPropertyName("ceremony")]
        public string Ceremony { get; set; } = string.Empty;

        /// <summary>The award category, e.g. "Best Picture", "Best Actor".</summary>
        [JsonPropertyName("category")]
        public string Category { get; set; } = string.Empty;

        /// <summary>Ceremony year (year the award was given), when Wikidata records it.</summary>
        [JsonPropertyName("year")]
        public int? Year { get; set; }

        /// <summary>True for a win; false for a nomination.</summary>
        [JsonPropertyName("won")]
        public bool Won { get; set; }
    }
}
