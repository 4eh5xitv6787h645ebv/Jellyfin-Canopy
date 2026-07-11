using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using Jellyfin.Plugin.JellyfinElevate.Configuration;
using Jellyfin.Plugin.JellyfinElevate.Model.Awards;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinElevate.Services.Awards
{
    /// <summary>
    /// Holds the global awards index — the set of every title that has won or been nominated
    /// for a tracked award — keyed by external id (IMDb and TMDb) so a per-item lookup at view
    /// time is an in-memory dictionary hit with no network call. This is what makes the feature
    /// scale to large libraries: the index is fetched ONCE per infrequent scheduled refresh
    /// (<c>BuildAwardsCacheTask</c>), not per item and not per page view.
    ///
    /// The index is an immutable snapshot swapped atomically: readers take the current reference
    /// and read dictionaries that are never mutated after publication, so lookups need no lock.
    /// A rebuild builds a fresh snapshot and swaps it in, then persists it to disk via
    /// <see cref="AtomicFile"/>. On startup the last snapshot is loaded from disk, so a restart
    /// never re-fetches from Wikidata.
    /// </summary>
    public sealed class AwardsCacheService
    {
        // Bump when the on-disk shape changes so an older cache is discarded and rebuilt
        // instead of being deserialized into an incompatible structure.
        private const int CurrentSchemaVersion = 1;

        private readonly IApplicationPaths _applicationPaths;
        private readonly ILogger<AwardsCacheService> _logger;
        private readonly object _saveLock = new();

        private volatile AwardsIndex _index = AwardsIndex.Empty;

        public AwardsCacheService(IApplicationPaths applicationPaths, ILogger<AwardsCacheService> logger)
        {
            _applicationPaths = applicationPaths;
            _logger = logger;
        }

        private string CacheFilePath =>
            Path.Combine(_applicationPaths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinElevate", "awards-cache.json");

        /// <summary>Monotonic index version, bumped on every rebuild. 0 until the first build.</summary>
        public long Version => _index.Version;

        /// <summary>Unix-ms timestamp of the last rebuild.</summary>
        public long LastModified => _index.LastModified;

        /// <summary>Number of distinct titles carrying at least one award (by IMDb id).</summary>
        public int TitleCount => _index.ByImdb.Count;

        /// <summary>True until the first successful build/load — i.e. the index has never been populated.</summary>
        public bool IsEmpty => _index.Version == 0 && _index.ByImdb.Count == 0 && _index.ByTmdb.Count == 0;

        /// <summary>
        /// Replace the whole index from a fresh set of provider rows. Groups rows by title,
        /// deduplicates awards, sorts them (newest first, wins before nominations), bumps the
        /// version, swaps the snapshot atomically, then persists to disk. A single title may be
        /// reachable by both its IMDb and TMDb id.
        /// </summary>
        public void ReplaceFrom(IReadOnlyCollection<AwardRow> rows)
        {
            ArgumentNullException.ThrowIfNull(rows);

            var byImdb = new Dictionary<string, List<AwardEntry>>(StringComparer.OrdinalIgnoreCase);
            var byTmdb = new Dictionary<string, List<AwardEntry>>(StringComparer.OrdinalIgnoreCase);

            foreach (var row in rows)
            {
                var entry = new AwardEntry
                {
                    Ceremony = row.Ceremony?.Trim() ?? string.Empty,
                    Category = row.Category?.Trim() ?? string.Empty,
                    Year = row.Year,
                    Won = row.Won
                };
                if (entry.Ceremony.Length == 0 || entry.Category.Length == 0)
                {
                    continue;
                }

                var imdb = NormalizeImdb(row.ImdbId);
                if (imdb != null)
                {
                    AddEntry(byImdb, imdb, entry);
                }

                var tmdbKey = NormalizeTmdbKey(row.TmdbId, row.MediaType);
                if (tmdbKey != null)
                {
                    AddEntry(byTmdb, tmdbKey, entry);
                }
            }

            DedupeAndSort(byImdb);
            DedupeAndSort(byTmdb);

            var next = new AwardsIndex
            {
                Version = _index.Version + 1,
                LastModified = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                BuiltAtUtc = DateTime.UtcNow.ToString("O"),
                ByImdb = byImdb,
                ByTmdb = byTmdb
            };

            _index = next;
            _logger.LogInformation(
                "[Awards] Rebuilt index v{Version}: {Titles} titles by IMDb, {TmdbTitles} by TMDb.",
                next.Version, byImdb.Count, byTmdb.Count);

            SaveToDisk(next);
        }

        /// <summary>
        /// Awards for a single item, resolved from its provider ids. Merges the IMDb-keyed and
        /// TMDb-keyed lookups (a row may carry only one id), deduplicates, and returns them
        /// newest-first. Empty when the item has no tracked awards or no external id.
        /// </summary>
        public IReadOnlyList<AwardEntry> LookupForItem(BaseItem item)
        {
            if (item == null)
            {
                return Array.Empty<AwardEntry>();
            }

            var index = _index;
            List<AwardEntry>? merged = null;

            var imdb = NormalizeImdb(item.GetProviderId(MetadataProvider.Imdb));
            if (imdb != null && index.ByImdb.TryGetValue(imdb, out var byImdb))
            {
                merged = new List<AwardEntry>(byImdb);
            }

            var mediaType = item is Series ? "tv" : "movie";
            var tmdbKey = NormalizeTmdbKey(item.GetProviderId(MetadataProvider.Tmdb), mediaType);
            if (tmdbKey != null && index.ByTmdb.TryGetValue(tmdbKey, out var byTmdb))
            {
                if (merged == null)
                {
                    merged = new List<AwardEntry>(byTmdb);
                }
                else
                {
                    merged.AddRange(byTmdb);
                }
            }

            if (merged == null || merged.Count == 0)
            {
                return Array.Empty<AwardEntry>();
            }

            return DedupeSorted(merged);
        }

        /// <summary>Load the last-built index from disk on startup. Leaves the index empty on any failure.</summary>
        public void LoadFromDisk()
        {
            var path = CacheFilePath;
            if (!File.Exists(path))
            {
                _logger.LogInformation("[Awards] No cache file found, starting empty.");
                return;
            }

            try
            {
                var json = File.ReadAllText(path);
                var data = JsonSerializer.Deserialize<AwardsCacheDiskFormat>(json);
                if (data == null)
                {
                    return;
                }

                if (data.SchemaVersion != CurrentSchemaVersion)
                {
                    _logger.LogInformation(
                        "[Awards] On-disk cache schema v{OnDisk} != current v{Current}; discarding and rebuilding on next refresh.",
                        data.SchemaVersion, CurrentSchemaVersion);
                    return;
                }

                _index = new AwardsIndex
                {
                    Version = data.Version,
                    LastModified = data.LastModified,
                    BuiltAtUtc = data.BuiltAtUtc,
                    ByImdb = data.ByImdb != null
                        ? new Dictionary<string, List<AwardEntry>>(data.ByImdb, StringComparer.OrdinalIgnoreCase)
                        : new Dictionary<string, List<AwardEntry>>(StringComparer.OrdinalIgnoreCase),
                    ByTmdb = data.ByTmdb != null
                        ? new Dictionary<string, List<AwardEntry>>(data.ByTmdb, StringComparer.OrdinalIgnoreCase)
                        : new Dictionary<string, List<AwardEntry>>(StringComparer.OrdinalIgnoreCase)
                };
                _logger.LogInformation(
                    "[Awards] Loaded {Titles} titles from disk (v{Version}).", _index.ByImdb.Count, _index.Version);
            }
            catch (Exception ex)
            {
                _logger.LogWarning("[Awards] Failed to load cache from disk: {Message}", ex.Message);
            }
        }

        private void SaveToDisk(AwardsIndex index)
        {
            lock (_saveLock)
            {
                try
                {
                    var dir = Path.GetDirectoryName(CacheFilePath);
                    if (dir != null)
                    {
                        Directory.CreateDirectory(dir);
                    }

                    var data = new AwardsCacheDiskFormat
                    {
                        SchemaVersion = CurrentSchemaVersion,
                        Version = index.Version,
                        LastModified = index.LastModified,
                        BuiltAtUtc = index.BuiltAtUtc,
                        ByImdb = index.ByImdb,
                        ByTmdb = index.ByTmdb
                    };

                    var json = JsonSerializer.Serialize(data, new JsonSerializerOptions { WriteIndented = false });
                    AtomicFile.WriteAllText(CacheFilePath, json);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning("[Awards] Failed to persist cache to disk: {Message}", ex.Message);
                }
            }
        }

        private static void AddEntry(Dictionary<string, List<AwardEntry>> map, string key, AwardEntry entry)
        {
            if (!map.TryGetValue(key, out var list))
            {
                list = new List<AwardEntry>();
                map[key] = list;
            }

            list.Add(entry);
        }

        private static void DedupeAndSort(Dictionary<string, List<AwardEntry>> map)
        {
            foreach (var key in map.Keys.ToList())
            {
                map[key] = DedupeSorted(map[key]);
            }
        }

        private static List<AwardEntry> DedupeSorted(IEnumerable<AwardEntry> entries)
        {
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var result = new List<AwardEntry>();
            foreach (var e in entries)
            {
                // Unit-separator delimited so distinct fields can't collide across boundaries.
                var key = string.Join(
                    '\u001f',
                    e.Ceremony,
                    e.Category,
                    e.Year?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? string.Empty,
                    e.Won ? "1" : "0");
                if (seen.Add(key))
                {
                    result.Add(e);
                }
            }

            // Newest first; within a year wins before nominations; then ceremony/category for stability.
            result.Sort((a, b) =>
            {
                var ay = a.Year ?? int.MinValue;
                var by = b.Year ?? int.MinValue;
                if (ay != by)
                {
                    return by.CompareTo(ay);
                }

                if (a.Won != b.Won)
                {
                    return a.Won ? -1 : 1;
                }

                var c = string.CompareOrdinal(a.Ceremony, b.Ceremony);
                return c != 0 ? c : string.CompareOrdinal(a.Category, b.Category);
            });

            return result;
        }

        private static string? NormalizeImdb(string? imdb)
        {
            if (string.IsNullOrWhiteSpace(imdb))
            {
                return null;
            }

            var trimmed = imdb.Trim();
            // Titles only ("tt…"); person ids ("nm…") are never a library item.
            return trimmed.StartsWith("tt", StringComparison.OrdinalIgnoreCase) ? trimmed : null;
        }

        private static string? NormalizeTmdbKey(string? tmdbId, string? mediaType)
        {
            if (string.IsNullOrWhiteSpace(tmdbId))
            {
                return null;
            }

            var kind = string.Equals(mediaType, "tv", StringComparison.OrdinalIgnoreCase) ? "tv" : "movie";
            return kind + ":" + tmdbId.Trim();
        }

        /// <summary>An immutable index snapshot. Dictionaries are never mutated after publication.</summary>
        private sealed class AwardsIndex
        {
            public static readonly AwardsIndex Empty = new()
            {
                Version = 0,
                LastModified = 0,
                BuiltAtUtc = null,
                ByImdb = new Dictionary<string, List<AwardEntry>>(StringComparer.OrdinalIgnoreCase),
                ByTmdb = new Dictionary<string, List<AwardEntry>>(StringComparer.OrdinalIgnoreCase)
            };

            public long Version { get; init; }

            public long LastModified { get; init; }

            public string? BuiltAtUtc { get; init; }

            public Dictionary<string, List<AwardEntry>> ByImdb { get; init; } = new(StringComparer.OrdinalIgnoreCase);

            public Dictionary<string, List<AwardEntry>> ByTmdb { get; init; } = new(StringComparer.OrdinalIgnoreCase);
        }

        private sealed class AwardsCacheDiskFormat
        {
            public int SchemaVersion { get; set; }

            public long Version { get; set; }

            public long LastModified { get; set; }

            public string? BuiltAtUtc { get; set; }

            public Dictionary<string, List<AwardEntry>>? ByImdb { get; set; }

            public Dictionary<string, List<AwardEntry>>? ByTmdb { get; set; }
        }
    }
}
