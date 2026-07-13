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
    }
}
