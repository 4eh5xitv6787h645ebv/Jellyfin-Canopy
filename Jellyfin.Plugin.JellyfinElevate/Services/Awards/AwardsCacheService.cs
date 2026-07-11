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
using MediaBrowser.Controller.Entities.Movies;
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

        // Serializes rebuilds so the version read-modify-write and snapshot swap are atomic
        // across concurrent callers (e.g. the first-install startup build racing a manual
        // dashboard run of the refresh task). Reads never take this lock — they read the
        // volatile snapshot reference directly.
        private readonly object _rebuildLock = new();

        // Monotonic refresh generation: a caller stamps its refresh with NextRefreshGeneration()
        // BEFORE fetching, so a slower older-started refresh that finishes late can be rejected in
        // favor of a newer one — publication order follows freshness, not completion order.
        private long _generationCounter;
        private long _lastPublishedGeneration;

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
        /// Replace the whole index from a fresh set of provider rows, unconditionally. Groups
        /// rows by title, deduplicates awards, sorts them (newest first, wins before nominations),
        /// bumps the version, swaps the snapshot atomically, then persists to disk. Prefer
        /// <see cref="TryReplaceFrom"/> from refresh callers so a partial fetch can't clobber a
        /// complete index; this primitive is for callers that always want to publish.
        /// </summary>
        public void ReplaceFrom(IReadOnlyCollection<AwardRow> rows)
            => TryReplaceFrom(rows, complete: true, NextRefreshGeneration());

        /// <summary>
        /// Reserve a monotonic refresh generation. A refresh caller calls this BEFORE it starts
        /// fetching, then passes the value to <see cref="TryReplaceFrom(IReadOnlyCollection{AwardRow}, bool, long)"/>,
        /// so an older-started refresh that finishes after a newer one is rejected rather than
        /// republishing older data.
        /// </summary>
        public long NextRefreshGeneration() => Interlocked.Increment(ref _generationCounter);

        /// <summary>
        /// Convenience overload that reserves a fresh generation at call time (for callers that
        /// publish immediately and don't span a long fetch, e.g. tests).
        /// </summary>
        public bool TryReplaceFrom(IReadOnlyCollection<AwardRow> rows, bool complete)
            => TryReplaceFrom(rows, complete, NextRefreshGeneration());

        /// <summary>
        /// Publish a fresh index, but only when it is safe to do so. Returns true if published.
        /// A <paramref name="complete"/> run always publishes; a PARTIAL run publishes only when
        /// the index is currently empty (first install) — never over an existing populated index,
        /// so a single failed ceremony query can't erase that ceremony's awards. A publication
        /// whose <paramref name="generation"/> is not newer than the last published one is also
        /// rejected, so an older-started refresh can't overwrite a newer one. The generation check,
        /// the currently-empty check, the version bump and the swap+persist all happen under one
        /// lock, so concurrent startup/manual/scheduled refreshes can't race. An empty row set
        /// never publishes.
        /// </summary>
        public bool TryReplaceFrom(IReadOnlyCollection<AwardRow> rows, bool complete, long generation)
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

            // The accept decision (partial vs complete over the CURRENT state) and the version
            // bump + swap + persist all happen under one lock, so the check is atomic with the
            // publish. The grouping work above is pure on locals, so it stays outside the lock.
            AwardsIndex next;
            lock (_rebuildLock)
            {
                if (generation <= _lastPublishedGeneration)
                {
                    _logger.LogWarning(
                        "[Awards] Rejected a stale refresh (generation {Gen} <= last published {Last}); a newer refresh already won.",
                        generation, _lastPublishedGeneration);
                    return false;
                }

                var currentlyEmpty = _index.Version == 0 && _index.ByImdb.Count == 0 && _index.ByTmdb.Count == 0;
                var producesEmpty = byImdb.Count == 0 && byTmdb.Count == 0;

                if (!currentlyEmpty)
                {
                    // Over an EXISTING index, only a complete AND non-empty result publishes. This
                    // rejects a partial refresh (some queries failed) and any empty result — an
                    // empty or partial fetch must never clear a good index.
                    if (!complete || producesEmpty)
                    {
                        _logger.LogWarning(
                            "[Awards] Rejected a {Kind} rebuild over the existing index of {Titles} titles.",
                            !complete ? "partial" : "empty", _index.ByImdb.Count);
                        return false;
                    }
                }
                else if (producesEmpty && !complete)
                {
                    // First install, but the fetch was partial AND produced nothing — don't mark
                    // the index "built" yet; wait for a real result. A COMPLETE empty result DOES
                    // publish here (a legitimate "built, no awards" state), clearing indexEmpty so
                    // the client stops treating it as not-ready.
                    return false;
                }

                next = new AwardsIndex
                {
                    Version = _index.Version + 1,
                    LastModified = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    BuiltAtUtc = DateTime.UtcNow.ToString("O"),
                    ByImdb = byImdb,
                    ByTmdb = byTmdb
                };

                _index = next;
                _lastPublishedGeneration = generation;

                _logger.LogInformation(
                    "[Awards] Rebuilt index v{Version} ({Completeness}): {Titles} titles by IMDb, {TmdbTitles} by TMDb.",
                    next.Version, complete ? "complete" : "partial first build", byImdb.Count, byTmdb.Count);

                SaveToDisk(next);
            }

            return true;
        }

        /// <summary>
        /// Awards for a single item, resolved from its provider ids. Merges the IMDb-keyed and
        /// TMDb-keyed lookups (a row may carry only one id), deduplicates, and returns them
        /// newest-first. Empty when the item has no tracked awards or no external id.
        /// </summary>
        public IReadOnlyList<AwardEntry> LookupForItem(BaseItem item)
            => item == null ? Array.Empty<AwardEntry>() : LookupInIndex(_index, item);

        /// <summary>
        /// The item's awards together with the version and emptiness of the SAME index snapshot,
        /// read once. This keeps the three values mutually consistent even if a rebuild publishes
        /// mid-request — the response can't claim the index is empty while also carrying awards.
        /// </summary>
        public AwardsView GetAwardsView(BaseItem item)
        {
            var index = _index; // single consistent snapshot
            var isEmpty = index.Version == 0 && index.ByImdb.Count == 0 && index.ByTmdb.Count == 0;
            var awards = item == null ? Array.Empty<AwardEntry>() : LookupInIndex(index, item);
            return new AwardsView(index.Version, isEmpty, awards);
        }

        private static IReadOnlyList<AwardEntry> LookupInIndex(AwardsIndex index, BaseItem item)
        {
            // Awards are only tracked for Movies and Series. Restricting the lookup to those types
            // also prevents a TMDb id-namespace collision: a Person/Episode/Season/MusicVideo TMDb
            // id is a different namespace from a movie's and could numerically match an award-winning
            // movie, which would otherwise surface that movie's awards on an unrelated page.
            if (item is not Movie && item is not Series)
            {
                return Array.Empty<AwardEntry>();
            }

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

                var loaded = new AwardsIndex
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

                // Install under the rebuild lock and only if it's newer than what's in memory.
                // If a manual refresh published a newer snapshot while this file read was in
                // flight, the fresher in-memory index wins — a stale disk read never downgrades it.
                lock (_rebuildLock)
                {
                    if (loaded.Version > _index.Version)
                    {
                        _index = loaded;
                        _logger.LogInformation(
                            "[Awards] Loaded {Titles} titles from disk (v{Version}).", loaded.ByImdb.Count, loaded.Version);
                    }
                    else
                    {
                        _logger.LogInformation(
                            "[Awards] Disk cache v{OnDisk} is not newer than the in-memory index v{InMemory}; keeping memory.",
                            loaded.Version, _index.Version);
                    }
                }
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
