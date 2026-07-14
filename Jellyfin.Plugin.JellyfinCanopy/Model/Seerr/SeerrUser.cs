using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinCanopy.Model.Seerr {
    public class SeerrUser
    {
        [JsonPropertyName("id")]
        public int Id { get; set; }

        [JsonPropertyName("jellyfinUserId")]
        public string? JellyfinUserId { get; set; }

        [JsonPropertyName("permissions")]
        public SeerrPermission Permissions { get; set; }

        /// <summary>
        /// Configured Seerr base URL that produced this user record. Seerr user
        /// ids are instance-local, so authenticated reads and mutations must stay
        /// on this source instead of replaying the id against another URL.
        /// </summary>
        [JsonIgnore]
        public string? SourceUrl { get; set; }
    }
}
