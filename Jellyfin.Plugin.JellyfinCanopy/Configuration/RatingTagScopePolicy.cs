using System;
using System.Collections.Generic;

namespace Jellyfin.Plugin.JellyfinCanopy.Configuration
{
    /// <summary>
    /// Versioned, code-owned rating-tag display policy. Values are semantic
    /// identifiers rather than selectors so configuration cannot inject DOM
    /// queries or depend on translated Jellyfin headings.
    /// </summary>
    public sealed class RatingTagScopePolicy
    {
        public int Version { get; set; } = RatingTagScopePolicyV1.Version;

        public List<string> DisabledItemTypes { get; set; } = new();

        public List<string> DisabledSurfaces { get; set; } = new();
    }

    /// <summary>Canonical schema-v1 parser shared by defaults and persistence.</summary>
    public static class RatingTagScopePolicyV1
    {
        public const int Version = 1;

        public static readonly IReadOnlyList<string> ItemTypes = new[]
        {
            "Movie",
            "Episode",
            "Series",
            "Season",
            "BoxSet"
        };

        public static readonly IReadOnlyList<string> Surfaces = new[]
        {
            "NextUp",
            "ContinueWatching",
            "HomeOther",
            "Other"
        };

        /// <summary>
        /// Normalizes a persisted policy. A missing policy, or the never-shipped
        /// version-zero empty shape, is the legacy state and migrates to an empty
        /// v1 deny set so existing installations retain every rating tag.
        /// </summary>
        public static bool TryNormalize(
            RatingTagScopePolicy? policy,
            out RatingTagScopePolicy normalized)
        {
            if (policy == null)
            {
                normalized = CreateEmpty();
                return true;
            }

            var itemTypes = policy.DisabledItemTypes;
            var surfaces = policy.DisabledSurfaces;
            if (policy.Version == 0
                && (itemTypes == null || itemTypes.Count == 0)
                && (surfaces == null || surfaces.Count == 0))
            {
                normalized = CreateEmpty();
                return true;
            }

            if (policy.Version != Version || itemTypes == null || surfaces == null)
            {
                normalized = CreateEmpty();
                return false;
            }

            if (!TryCanonicalize(itemTypes, ItemTypes, out var canonicalItemTypes)
                || !TryCanonicalize(surfaces, Surfaces, out var canonicalSurfaces))
            {
                normalized = CreateEmpty();
                return false;
            }

            normalized = new RatingTagScopePolicy
            {
                Version = Version,
                DisabledItemTypes = canonicalItemTypes,
                DisabledSurfaces = canonicalSurfaces
            };
            return true;
        }

        public static RatingTagScopePolicy CreateEmpty()
            => new()
            {
                Version = Version,
                DisabledItemTypes = new List<string>(),
                DisabledSurfaces = new List<string>()
            };

        private static bool TryCanonicalize(
            IReadOnlyCollection<string> values,
            IReadOnlyList<string> allowed,
            out List<string> canonical)
        {
            canonical = new List<string>();
            if (values.Count > allowed.Count)
            {
                return false;
            }

            var selected = new HashSet<string>(StringComparer.Ordinal);
            foreach (var raw in values)
            {
                if (raw == null)
                {
                    return false;
                }

                string? match = null;
                foreach (var candidate in allowed)
                {
                    if (string.Equals(raw.Trim(), candidate, StringComparison.OrdinalIgnoreCase))
                    {
                        match = candidate;
                        break;
                    }
                }

                if (match == null)
                {
                    return false;
                }

                selected.Add(match);
            }

            foreach (var candidate in allowed)
            {
                if (selected.Contains(candidate))
                {
                    canonical.Add(candidate);
                }
            }

            return true;
        }
    }
}
