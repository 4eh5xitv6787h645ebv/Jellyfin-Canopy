using System.Collections.Generic;
using System.Text.Json;

namespace Jellyfin.Plugin.JellyfinElevate.Helpers.Jellyseerr
{
    /// <summary>
    /// Extracts a title's tag signature — the cleaned set of TMDB keyword and
    /// genre NAMES — from a movie/tv detail body, for the tag branch of the
    /// Seerr parental filter (see <see cref="ParentalTagDecision"/>).
    /// Companion to <see cref="SeerrCertificationExtractor"/>; accepts the
    /// same body shapes the cert path can produce:
    ///   • Seerr detail (<c>/api/v1/movie|tv/{id}</c>): flat
    ///     <c>keywords: [{id,name}]</c> and <c>genres: [{id,name}]</c>.
    ///   • Raw TMDB detail with <c>append_to_response=keywords</c>: movies
    ///     wrap as <c>keywords: { keywords: [...] }</c>, tv as
    ///     <c>keywords: { results: [...] }</c>.
    /// Missing/malformed containers contribute nothing (the caller decides
    /// whether an EMPTY signature means "known none" — this extractor never
    /// throws on shape).
    /// </summary>
    public static class SeerrTagSignatureExtractor
    {
        /// <summary>Extracts the cleaned keyword∪genre name set from a detail body.</summary>
        public static HashSet<string> Extract(JsonElement detail)
        {
            var names = new List<string?>();
            if (detail.ValueKind == JsonValueKind.Object)
            {
                if (detail.TryGetProperty("keywords", out var keywords))
                {
                    CollectNames(keywords, names);
                }

                if (detail.TryGetProperty("genres", out var genres))
                {
                    CollectNames(genres, names);
                }
            }

            return ParentalTagDecision.CleanTags(names);
        }

        // Accepts a flat array of {name}, or the raw-TMDB wrappers
        // { keywords: [...] } / { results: [...] }.
        private static void CollectNames(JsonElement container, List<string?> names)
        {
            if (container.ValueKind == JsonValueKind.Object)
            {
                if (container.TryGetProperty("keywords", out var wrappedMovie))
                {
                    CollectNames(wrappedMovie, names);
                }

                if (container.TryGetProperty("results", out var wrappedTv))
                {
                    CollectNames(wrappedTv, names);
                }

                return;
            }

            if (container.ValueKind != JsonValueKind.Array)
            {
                return;
            }

            foreach (var entry in container.EnumerateArray())
            {
                if (entry.ValueKind == JsonValueKind.Object
                    && entry.TryGetProperty("name", out var name)
                    && name.ValueKind == JsonValueKind.String)
                {
                    names.Add(name.GetString());
                }
            }
        }
    }
}
