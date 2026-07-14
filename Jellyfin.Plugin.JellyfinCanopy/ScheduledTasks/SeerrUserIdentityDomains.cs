using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr;

namespace Jellyfin.Plugin.JellyfinCanopy.ScheduledTasks
{
    internal sealed class SeerrUserIdentityDomain
    {
        public SeerrUserIdentityDomain(
            string sourceUrl,
            IReadOnlyDictionary<string, string> seerrUserIdsByJellyfinUserId)
        {
            SourceUrl = sourceUrl;
            SeerrUserIdsByJellyfinUserId = seerrUserIdsByJellyfinUserId;
        }

        public string SourceUrl { get; }

        public IReadOnlyDictionary<string, string> SeerrUserIdsByJellyfinUserId { get; }
    }

    internal readonly record struct SeerrUserBinding(string SourceUrl, string SeerrUserId);

    internal static class SeerrUserIdentityDomains
    {
        public static bool TryParse(
            SeerrMultiSourceCollectionResult snapshots,
            out IReadOnlyList<SeerrUserIdentityDomain> domains)
        {
            var parsedDomains = new List<SeerrUserIdentityDomain>();
            domains = parsedDomains;
            if (!snapshots.IsComplete || snapshots.Sources.Count == 0)
            {
                return false;
            }

            var seenSources = new HashSet<string>(StringComparer.Ordinal);
            foreach (var snapshot in snapshots.Sources)
            {
                if (!snapshot.IsComplete
                    || string.IsNullOrWhiteSpace(snapshot.SourceUrl)
                    || !seenSources.Add(snapshot.SourceUrl))
                {
                    return false;
                }

                var userIds = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                var jellyfinUserIdsBySeerrUserId = new Dictionary<string, string>(StringComparer.Ordinal);
                foreach (var user in snapshot.Items)
                {
                    if (!user.TryGetProperty("jellyfinUserId", out var jellyfinUserId)
                        || jellyfinUserId.ValueKind == JsonValueKind.Null)
                    {
                        continue;
                    }

                    if (jellyfinUserId.ValueKind != JsonValueKind.String)
                    {
                        return false;
                    }

                    var rawJellyfinUserId = jellyfinUserId.GetString();
                    if (string.IsNullOrWhiteSpace(rawJellyfinUserId))
                    {
                        continue;
                    }

                    var normalizedJellyfinUserId = SeerrPaginationHelper.CanonicalJellyfinUserIdentity(
                        rawJellyfinUserId);
                    if (normalizedJellyfinUserId == null) return false;

                    if (!user.TryGetProperty("id", out var id)
                        || !int.TryParse(
                            ScalarText(id),
                            NumberStyles.Integer,
                            CultureInfo.InvariantCulture,
                            out var parsedSeerrUserId)
                        || parsedSeerrUserId <= 0)
                    {
                        return false;
                    }

                    var seerrUserId = parsedSeerrUserId.ToString(CultureInfo.InvariantCulture);
                    if (jellyfinUserIdsBySeerrUserId.TryGetValue(
                            seerrUserId,
                            out var existingJellyfinUserId)
                        && !string.Equals(
                            existingJellyfinUserId,
                            normalizedJellyfinUserId,
                            StringComparison.OrdinalIgnoreCase))
                    {
                        // A source-local Seerr account cannot safely own two
                        // different Jellyfin identities. Without this reverse
                        // check both scheduled sync directions would apply or
                        // publish one account's watchlist for both users.
                        return false;
                    }

                    if (userIds.TryGetValue(normalizedJellyfinUserId, out var existingSeerrUserId))
                    {
                        if (!string.Equals(existingSeerrUserId, seerrUserId, StringComparison.Ordinal))
                        {
                            return false;
                        }

                        continue;
                    }

                    userIds.Add(normalizedJellyfinUserId, seerrUserId);
                    jellyfinUserIdsBySeerrUserId.Add(seerrUserId, normalizedJellyfinUserId);
                }

                parsedDomains.Add(new SeerrUserIdentityDomain(snapshot.SourceUrl, userIds));
            }

            return true;
        }

        public static IReadOnlyList<SeerrUserBinding> FindBindings(
            IEnumerable<SeerrUserIdentityDomain> domains,
            string? jellyfinUserId)
        {
            var normalizedUserId = SeerrPaginationHelper.CanonicalJellyfinUserIdentity(jellyfinUserId);
            if (normalizedUserId == null)
            {
                return Array.Empty<SeerrUserBinding>();
            }

            return domains
                .Where(domain => domain.SeerrUserIdsByJellyfinUserId.ContainsKey(normalizedUserId))
                .Select(domain => new SeerrUserBinding(
                    domain.SourceUrl,
                    domain.SeerrUserIdsByJellyfinUserId[normalizedUserId]))
                .ToArray();
        }

        public static bool AreEquivalent(
            IReadOnlyList<SeerrUserIdentityDomain> first,
            IReadOnlyList<SeerrUserIdentityDomain> second)
        {
            if (first.Count != second.Count) return false;
            for (var index = 0; index < first.Count; index++)
            {
                var firstDomain = first[index];
                var secondDomain = second[index];
                if (!string.Equals(firstDomain.SourceUrl, secondDomain.SourceUrl, StringComparison.Ordinal)
                    || firstDomain.SeerrUserIdsByJellyfinUserId.Count
                        != secondDomain.SeerrUserIdsByJellyfinUserId.Count)
                {
                    return false;
                }

                foreach (var binding in firstDomain.SeerrUserIdsByJellyfinUserId)
                {
                    if (!secondDomain.SeerrUserIdsByJellyfinUserId.TryGetValue(
                            binding.Key,
                            out var secondSeerrUserId)
                        || !string.Equals(binding.Value, secondSeerrUserId, StringComparison.Ordinal))
                    {
                        return false;
                    }
                }
            }

            return true;
        }

        private static string? ScalarText(JsonElement value)
        {
            return value.ValueKind switch
            {
                JsonValueKind.String => value.GetString(),
                JsonValueKind.Number => value.GetRawText(),
                _ => null
            };
        }
    }
}
