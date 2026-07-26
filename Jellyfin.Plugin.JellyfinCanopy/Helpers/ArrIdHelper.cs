using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinCanopy.Model.Arr;

namespace Jellyfin.Plugin.JellyfinCanopy.Helpers
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
        private const int InstanceIdHexLength = 32;
        private const string LegacyIdentityDomain = "jellyfin-canopy-arr-instance-v1";

        /// <summary>Null unless the id is a real, positive value.</summary>
        public static int? ToNullableId(int? raw) => raw is > 0 ? raw : null;

        /// <summary>Provider-map value string, or null for absent/0 (so it never becomes a ("Tvdb","0") pair).</summary>
        public static string? ToProviderValue(int? raw)
            => raw is > 0 ? raw.Value.ToString(CultureInfo.InvariantCulture) : null;

        /// <summary>
        /// Canonical identity for a Sonarr/Radarr queue or history record. Those APIs expose
        /// positive 32-bit integer record ids; every other JSON shape is untrustworthy and must
        /// make complete-snapshot pagination fail closed.
        /// </summary>
        public static string? ToStableRecordIdentity(JsonNode? raw)
            => raw is JsonValue value
                && value.TryGetValue<int>(out var id)
                && id > 0
                    ? id.ToString(CultureInfo.InvariantCulture)
                    : null;

        /// <summary>
        /// Returns this instance's stable opaque id. Valid persisted ids are normalized to
        /// lower-case. Legacy/malformed ids fall back to the first 128 bits of a domain-separated
        /// SHA-256 digest over normalized connection material. URL and API-key material are used
        /// only as hash input and are never returned, logged or projected.
        ///
        /// The fallback intentionally excludes display name, enabled state and list position, so
        /// legacy identities survive rename, reorder and enable/disable changes. Server startup
        /// persists the fallback before projecting admin configuration, and the save hook
        /// reinforces that invariant; subsequent URL or API-key changes therefore retain the id.
        /// </summary>
        public static string GetStableInstanceId(ArrInstance instance)
        {
            ArgumentNullException.ThrowIfNull(instance);

            if (TryNormalizeInstanceId(instance.InstanceId, out var persisted))
            {
                return persisted;
            }

            var canonicalUrl = NormalizeLegacyUrl(instance.Url);
            var apiKey = instance.ApiKey?.Trim() ?? string.Empty;
            var material = string.Concat(
                LegacyIdentityDomain,
                "\0",
                canonicalUrl,
                "\0",
                apiKey);
            var digest = SHA256.HashData(Encoding.UTF8.GetBytes(material));
            return Convert.ToHexString(digest.AsSpan(0, InstanceIdHexLength / 2))
                .ToLowerInvariant();
        }

        /// <summary>
        /// Stable server-side key used to bind an event to the root folders fetched from the
        /// same service instance.
        /// </summary>
        public static string InstanceKey(string source, ArrInstance instance)
            => $"{(source ?? string.Empty).Trim().ToLowerInvariant()}:{GetStableInstanceId(instance)}";

        /// <summary>
        /// Global event/queue id namespaced by source + a stable opaque instance id so two
        /// same-source instances that both number rows from 1 cannot collide.
        /// </summary>
        public static string NamespacedId(string source, ArrInstance instance, object? rawId)
            => NamespacedId(source, GetStableInstanceId(instance), rawId);

        /// <summary>
        /// Low-level formatter for callers that already hold a validated opaque instance key.
        /// </summary>
        public static string NamespacedId(string source, string? instanceKey, object? rawId)
            => $"{source}|{instanceKey}|{rawId}";

        /// <summary>
        /// Adds or repairs persisted instance ids inside a Sonarr/Radarr instance JSON array.
        /// Clean modern JSON is returned byte-for-byte. Corrupt JSON is left untouched for the
        /// existing corruption-recovery owner.
        ///
        /// If multiple rows resolve to one identity (including truly identical legacy rows or a
        /// copied persisted id), every colliding row receives a fresh opaque id. The optional
        /// callback receives display names only; connection material and ids are never exposed.
        /// </summary>
        public static string EnsureInstanceIdsJson(
            string json,
            Action<string>? onDuplicateReassigned = null)
        {
            if (string.IsNullOrWhiteSpace(json))
            {
                return json;
            }

            try
            {
                var instances = JsonSerializer.Deserialize<List<ArrInstance>>(json);
                if (instances == null)
                {
                    return json;
                }

                var candidates = instances
                    .Where(instance => instance != null)
                    .Select(instance => (Instance: instance, StableId: GetStableInstanceId(instance)))
                    .ToList();
                var duplicateIds = candidates
                    .GroupBy(candidate => candidate.StableId, StringComparer.Ordinal)
                    .Where(group => group.Count() > 1)
                    .Select(group => group.Key)
                    .ToHashSet(StringComparer.Ordinal);
                var used = candidates
                    .Where(candidate => !duplicateIds.Contains(candidate.StableId))
                    .Select(candidate => candidate.StableId)
                    .ToHashSet(StringComparer.Ordinal);

                var changed = false;
                foreach (var candidate in candidates)
                {
                    var stableId = candidate.StableId;
                    if (duplicateIds.Contains(stableId))
                    {
                        do
                        {
                            stableId = Guid.NewGuid().ToString("N", CultureInfo.InvariantCulture);
                        }
                        while (!used.Add(stableId));

                        onDuplicateReassigned?.Invoke(candidate.Instance.Name);
                    }

                    if (!string.Equals(
                            candidate.Instance.InstanceId,
                            stableId,
                            StringComparison.Ordinal))
                    {
                        candidate.Instance.InstanceId = stableId;
                        changed = true;
                    }
                }

                return changed ? JsonSerializer.Serialize(instances) : json;
            }
            catch (JsonException)
            {
                return json;
            }
        }

        /// <summary>True only for the canonical 128-bit lower/upper-case hexadecimal token format.</summary>
        internal static bool TryNormalizeInstanceId(string? value, out string normalized)
        {
            normalized = string.Empty;
            if (value == null || value.Length != InstanceIdHexLength)
            {
                return false;
            }

            foreach (var ch in value)
            {
                if (!char.IsAsciiHexDigit(ch))
                {
                    return false;
                }
            }

            normalized = value.ToLowerInvariant();
            return true;
        }

        private static string NormalizeLegacyUrl(string? value)
        {
            var trimmed = value?.Trim() ?? string.Empty;
            if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var uri)
                || string.IsNullOrWhiteSpace(uri.Host))
            {
                return trimmed.TrimEnd('/');
            }

            var port = uri.IsDefaultPort
                ? string.Empty
                : ":" + uri.Port.ToString(CultureInfo.InvariantCulture);
            var path = uri.GetComponents(UriComponents.Path, UriFormat.UriEscaped).TrimEnd('/');
            var query = uri.GetComponents(UriComponents.Query, UriFormat.UriEscaped);
            return string.Concat(
                uri.Scheme.ToLowerInvariant(),
                "://",
                uri.IdnHost.ToLowerInvariant(),
                port,
                path.Length == 0 ? string.Empty : "/" + path,
                query.Length == 0 ? string.Empty : "?" + query);
        }
    }
}
