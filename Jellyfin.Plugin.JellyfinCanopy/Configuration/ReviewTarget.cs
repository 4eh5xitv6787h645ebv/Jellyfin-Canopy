using System;
using System.Globalization;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.JellyfinCanopy.Configuration
{
    internal static partial class ReviewTarget
    {
        private const int MaximumPart = 100000;

        [GeneratedRegex(@"^(?<id>[1-9]\d*)(?::s(?<season>0|[1-9]\d*)(?::e(?<episode>0|[1-9]\d*))?)?$", RegexOptions.CultureInvariant)]
        private static partial Regex CanonicalPattern();

        [GeneratedRegex(@"^(?<id>\d+)(?::s(?<season>\d+)(?::e(?<episode>\d+))?)?$", RegexOptions.CultureInvariant)]
        private static partial Regex LegacyPattern();

        public static bool TryValidate(string mediaType, string target, out string canonical)
            => TryParse(mediaType, target, allowLegacyLeadingZeros: false, out canonical);

        public static bool TryNormalizeLegacy(string mediaType, string target, out string canonical)
            => TryParse(mediaType, target, allowLegacyLeadingZeros: true, out canonical);

        private static bool TryParse(string mediaType, string target, bool allowLegacyLeadingZeros, out string canonical)
        {
            canonical = string.Empty;
            if (!string.Equals(mediaType, "movie", StringComparison.Ordinal)
                && !string.Equals(mediaType, "tv", StringComparison.Ordinal))
            {
                return false;
            }

            if (string.IsNullOrWhiteSpace(target))
            {
                return false;
            }

            var match = (allowLegacyLeadingZeros ? LegacyPattern() : CanonicalPattern()).Match(target);
            if (!match.Success
                || !TryPart(match.Groups["id"].Value, 1, int.MaxValue, out var id))
            {
                return false;
            }

            var hasSeason = match.Groups["season"].Success;
            var hasEpisode = match.Groups["episode"].Success;
            if (string.Equals(mediaType, "movie", StringComparison.Ordinal) && (hasSeason || hasEpisode))
            {
                return false;
            }

            var result = id.ToString(CultureInfo.InvariantCulture);
            if (hasSeason)
            {
                if (!TryPart(match.Groups["season"].Value, 0, MaximumPart, out var season))
                {
                    return false;
                }

                result += ":s" + season.ToString(CultureInfo.InvariantCulture);
            }

            if (hasEpisode)
            {
                if (!TryPart(match.Groups["episode"].Value, 0, MaximumPart, out var episode))
                {
                    return false;
                }

                result += ":e" + episode.ToString(CultureInfo.InvariantCulture);
            }

            canonical = result;
            return true;
        }

        private static bool TryPart(string value, int minimum, int maximum, out int result)
            => int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out result)
               && result >= minimum
               && result <= maximum;
    }
}
