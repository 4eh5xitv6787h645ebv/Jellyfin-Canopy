using System.Collections.Frozen;

namespace Jellyfin.Plugin.JellyfinCanopy.Configuration
{
    /// <summary>Normalizes TMDB/Seerr region keys against the mirrored supported catalog.</summary>
    internal static class StreamingRegionNormalizer
    {
        internal const string Fallback = "US";

        // Release snapshot of Jellyfin-Elsewhere resources/regions.txt. Runtime
        // config updates cannot depend on the network-backed asset cache, so this
        // is the synchronous membership authority shared with effective-region.ts
        // and the admin page. The mirror remains the display-name source.
        private const string SupportedCodeList =
            "AD AE AG AL AO AR AT AU AZ BA BB BE BF BG BH BM BO BR BS BY BZ CA CD CH CI CL CM CO CR CU CV CY CZ DE DK DO DZ EC EE EG ES FI FJ FR GB GF GH GI GP GQ GR GT GY HK HN HR HU ID IE IL IN IQ IS IT JM JO JP KE KR KW LB LC LI LT LU LV LY MA MC MD ME MG MK ML MT MU MW MX MY MZ NE NG NI NL NO NZ OM PA PE PF PG PH PK PL PS PT PY QA RO RS RU SA SC SE SG SI SK SM SN SV TC TD TH TN TR TT TW TZ UA UG US UY VA VE XK YE ZA ZM ZW";

        private static readonly FrozenSet<string> SupportedCodes = SupportedCodeList
            .Split(' ', StringSplitOptions.RemoveEmptyEntries)
            .ToFrozenSet(StringComparer.Ordinal);

        internal static int SupportedCount => SupportedCodes.Count;

        internal static bool IsSupported(string? value)
        {
            var normalized = NormalizeSyntax(value);
            return normalized != null && SupportedCodes.Contains(normalized);
        }

        /// <summary>
        /// Returns an uppercase supported code, or US for empty, malformed, or
        /// unsupported state. The built-in membership snapshot preserves uncommon
        /// supported codes without depending on a catalog refresh.
        /// </summary>
        internal static string Normalize(string? value)
            => NormalizeSupported(value) ?? Fallback;

        /// <summary>
        /// Returns an uppercase supported override, or empty to inherit the current
        /// administrator default for empty, malformed, or unsupported state.
        /// </summary>
        internal static string NormalizeOverride(string? value)
            => NormalizeSupported(value) ?? string.Empty;

        /// <summary>Normalizes, filters, and de-duplicates manual-search regions.</summary>
        internal static List<string> NormalizeOverrides(IEnumerable<string>? values)
            => (values ?? Array.Empty<string>())
                .Select(NormalizeOverride)
                .Where(region => region.Length != 0)
                .Distinct(StringComparer.Ordinal)
                .ToList();

        private static string? NormalizeSupported(string? value)
        {
            var normalized = NormalizeSyntax(value);
            return normalized != null && SupportedCodes.Contains(normalized)
                ? normalized
                : null;
        }

        private static string? NormalizeSyntax(string? value)
        {
            var normalized = value?.Trim().ToUpperInvariant();
            return normalized?.Length == 2
                && normalized[0] is >= 'A' and <= 'Z'
                && normalized[1] is >= 'A' and <= 'Z'
                    ? normalized
                    : null;
        }
    }
}
