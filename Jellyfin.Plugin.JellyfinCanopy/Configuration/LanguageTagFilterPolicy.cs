using System;
using System.Collections.Generic;

namespace Jellyfin.Plugin.JellyfinCanopy.Configuration
{
    public sealed class LanguageTagFilterPolicy
    {
        public int SchemaVersion { get; set; } = 1;
        public List<string> Languages { get; set; } = new();
        public bool IncludeOriginal { get; set; }
    }

    internal static class LanguageTagFilterPolicyV1
    {
        internal const int MaximumEntries = 16;

        internal static bool TryNormalize(LanguageTagFilterPolicy? input, out LanguageTagFilterPolicy? normalized)
        {
            if (input == null)
            {
                normalized = null;
                return true;
            }
            if (input.SchemaVersion != 1 || input.Languages == null || input.Languages.Count > MaximumEntries)
            {
                normalized = null;
                return false;
            }
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var languages = new List<string>(input.Languages.Count);
            foreach (var raw in input.Languages)
            {
                if (!PreferredAudioLanguageNormalizer.TryNormalize(raw, preserveNull: false, out var value)
                    || string.IsNullOrEmpty(value)
                    || !seen.Add(value))
                {
                    normalized = null;
                    return false;
                }
                languages.Add(value);
            }
            normalized = new LanguageTagFilterPolicy
            {
                SchemaVersion = 1,
                Languages = languages,
                IncludeOriginal = input.IncludeOriginal
            };
            return true;
        }
    }
}
