using System.Globalization;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    /// <summary>
    /// Central guard for numeric provider / arr ids. A provider or arr numeric id of 0 (or absent) is
    /// NEVER a real key or lookup value — Sonarr/Radarr commonly emit tmdbId:0 / tvdbId:0 for un-mapped
    /// items, and some scanners store ProviderIds["Tvdb"]=="0" for "unknown". Every producer that reads a
    /// tmdb/tvdb id from arr/Seerr JSON must route it through here so 0 becomes null before it can key a
    /// dict, dedup bucket, or provider lookup. Per-instance ids (episode.id/movie.id/queue.id) are unique
    /// only within one instance and must be namespaced before use as a cross-instance correlation key.
    /// </summary>
    public static class ArrIdHelper
    {
        /// <summary>Null unless the id is a real, positive value.</summary>
        public static int? ToNullableId(int? raw) => raw is > 0 ? raw : null;

        /// <summary>Provider-map value string, or null for absent/0 (so it never becomes a ("Tvdb","0") pair).</summary>
        public static string? ToProviderValue(int? raw)
            => raw is > 0 ? raw.Value.ToString(CultureInfo.InvariantCulture) : null;

        /// <summary>
        /// Global event/queue id namespaced by source + a STABLE UNIQUE instance key so two same-source
        /// instances that both number rows from 1 cannot collide. The instance key must NOT be the
        /// display Name — two instances can share a name (or be blank) and would then still collide;
        /// callers pass a unique discriminator (the instance's position in the configured list, via the
        /// int overload). Value is opaque to the client (used only as a string key).
        /// </summary>
        public static string NamespacedId(string source, string? instanceKey, object? rawId)
            => $"{source}|{instanceKey}|{rawId}";

        /// <summary>
        /// Namespaces by the instance's position in the configured fan-out list — a guaranteed-unique
        /// discriminator within one response, unlike the display Name which can be duplicated or blank.
        /// </summary>
        public static string NamespacedId(string source, int instanceIndex, object? rawId)
            => NamespacedId(source, instanceIndex.ToString(CultureInfo.InvariantCulture), rawId);
    }
}
