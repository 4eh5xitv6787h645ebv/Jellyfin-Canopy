namespace Jellyfin.Plugin.JellyfinCanopy.Configuration
{
    /// <summary>Normalizes the syntax of TMDB/Seerr two-letter region keys.</summary>
    internal static class StreamingRegionNormalizer
    {
        internal const string Fallback = "US";

        /// <summary>
        /// Returns an uppercase two-letter code, or US for empty/malformed state.
        /// Catalog membership is intentionally enforced by the catalog-backed admin
        /// selector: preserving an uncommon syntactically valid code here prevents a
        /// transient mirror failure from destroying persisted configuration.
        /// </summary>
        internal static string Normalize(string? value)
        {
            var normalized = value?.Trim().ToUpperInvariant();
            return normalized?.Length == 2
                && normalized[0] is >= 'A' and <= 'Z'
                && normalized[1] is >= 'A' and <= 'Z'
                    ? normalized
                    : Fallback;
        }
    }
}
