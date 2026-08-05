using System;
using System.Globalization;
using System.Linq;

namespace Jellyfin.Plugin.JellyfinCanopy.Configuration
{
    /// <summary>Canonicalizes the shared BCP-47 preference contract for admin and user writes.</summary>
    internal static class PreferredAudioLanguageNormalizer
    {
        internal const int MaxLength = 255;

        internal static bool TryNormalize(string? input, bool preserveNull, out string? normalized)
        {
            if (input == null)
            {
                normalized = preserveNull ? null : string.Empty;
                return true;
            }

            var value = input.Trim();
            if (value.Length == 0)
            {
                normalized = string.Empty;
                return true;
            }

            if (value.Length > MaxLength
                || string.Equals(value, "und", StringComparison.OrdinalIgnoreCase)
                || string.Equals(value, "root", StringComparison.OrdinalIgnoreCase)
                || !HasSupportedLanguageTagShape(value))
            {
                normalized = null;
                return false;
            }

            try
            {
                normalized = CultureInfo.GetCultureInfo(value).Name;
                return !string.IsNullOrWhiteSpace(normalized);
            }
            catch (CultureNotFoundException)
            {
                normalized = null;
                return false;
            }
        }

        private static bool HasSupportedLanguageTagShape(string value)
        {
            var subtags = value.Split('-');
            return subtags.Length > 0
                && subtags[0].Length is >= 2 and <= 8
                && subtags[0].All(IsAsciiLetter)
                && subtags.Skip(1).All(subtag => subtag.Length is >= 1 and <= 8
                    && subtag.All(character => IsAsciiLetter(character) || character is >= '0' and <= '9'));
        }

        private static bool IsAsciiLetter(char value)
            => value is >= 'A' and <= 'Z' or >= 'a' and <= 'z';
    }
}
