using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinCanopy.Model.Arr;

namespace Jellyfin.Plugin.JellyfinCanopy.Helpers.Arr
{
    /// <summary>
    /// Pure Sonarr/Radarr JSON → DTO mapping and request-body building for the Search feature.
    /// No HTTP, no config — everything here is deterministic and unit-testable in isolation
    /// (the reusable-logic-in-Helpers convention, mirroring Helpers/Seerr/*). All JSON reads
    /// are defensive: a missing/wrong-typed field yields the type default, never an exception,
    /// because release payloads vary across indexers and arr versions.
    /// </summary>
    public static class ArrSearchMapping
    {
        // ── defensive JsonNode accessors ─────────────────────────────────────
        internal static string? Str(JsonNode? n) { try { return n?.GetValue<string>(); } catch { return n?.ToString(); } }
        internal static int Int(JsonNode? n) => IntN(n) ?? 0;

        internal static int? IntN(JsonNode? n)
        {
            if (n == null) return null;
            try { return n.GetValue<int>(); }
            catch
            {
                try { return (int)Math.Round(n.GetValue<double>()); } catch { }
                if (int.TryParse(n.ToString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var v)) return v;
                return null;
            }
        }

        internal static long Long(JsonNode? n)
        {
            if (n == null) return 0;
            try { return n.GetValue<long>(); }
            catch
            {
                try { return (long)n.GetValue<double>(); } catch { }
                if (long.TryParse(n.ToString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var v)) return v;
                return 0;
            }
        }

        internal static double Dbl(JsonNode? n)
        {
            if (n == null) return 0;
            try { return n.GetValue<double>(); }
            catch
            {
                if (double.TryParse(n.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var v)) return v;
                return 0;
            }
        }

        internal static bool Bool(JsonNode? n)
        {
            if (n == null) return false;
            try { return n.GetValue<bool>(); }
            catch { return string.Equals(n.ToString(), "true", StringComparison.OrdinalIgnoreCase); }
        }

        private static List<string> StringArray(JsonNode? n)
        {
            var list = new List<string>();
            if (n is JsonArray arr)
            {
                foreach (var e in arr)
                {
                    var s = Str(e);
                    if (!string.IsNullOrWhiteSpace(s)) list.Add(s!);
                }
            }
            return list;
        }

        private static List<string> NamedArray(JsonNode? n, string key)
        {
            var list = new List<string>();
            if (n is JsonArray arr)
            {
                foreach (var e in arr)
                {
                    var s = Str(e?[key]);
                    if (!string.IsNullOrWhiteSpace(s)) list.Add(s!);
                }
            }
            return list;
        }

        // ── release normalization ────────────────────────────────────────────

        /// <summary>Normalizes one Sonarr/Radarr <c>ReleaseResource</c> node into the client DTO.</summary>
        public static ArrReleaseDto MapRelease(JsonNode? node)
        {
            var dto = new ArrReleaseDto
            {
                Guid = Str(node?["guid"]) ?? string.Empty,
                IndexerId = Int(node?["indexerId"]),
                Indexer = Str(node?["indexer"]),
                Title = Str(node?["title"]),
                Quality = Str(node?["quality"]?["quality"]?["name"]),
                QualityWeight = Int(node?["qualityWeight"]),
                Size = Long(node?["size"]),
                AgeHours = Dbl(node?["ageHours"]),
                Seeders = IntN(node?["seeders"]),
                Leechers = IntN(node?["leechers"]),
                Protocol = Str(node?["protocol"]),
                Approved = Bool(node?["approved"]),
                DownloadAllowed = Bool(node?["downloadAllowed"]),
                Rejections = StringArray(node?["rejections"]),
                SeasonNumber = IntN(node?["seasonNumber"]),
                FullSeason = Bool(node?["fullSeason"]),
                ReleaseGroup = Str(node?["releaseGroup"]),
                CustomFormatScore = Int(node?["customFormatScore"]),
                Languages = NamedArray(node?["languages"], "name"),
                IndexerFlags = StringArray(node?["indexerFlags"]),
            };
            return dto;
        }

        /// <summary>Maps one Sonarr/Radarr <c>/queue</c> record into a progress row.</summary>
        public static ArrQueueRowDto MapQueueRow(JsonNode? node, string service, string instanceName)
        {
            var size = Dbl(node?["size"]);
            var sizeleft = Dbl(node?["sizeleft"]);
            double progress = size > 0 ? Math.Clamp((size - sizeleft) / size * 100.0, 0, 100) : 0;
            return new ArrQueueRowDto
            {
                InstanceName = instanceName,
                Service = service,
                Title = Str(node?["title"]),
                Status = Str(node?["status"]),
                TrackedDownloadState = Str(node?["trackedDownloadState"]),
                Progress = Math.Round(progress, 1),
                TimeRemaining = Str(node?["timeleft"]),
            };
        }

        // ── automatic-search command selection ───────────────────────────────

        /// <summary>
        /// The <c>POST /api/v3/command</c> body for an automatic search of the resolved item in an
        /// instance where its arr id (and, for a single episode, its episodeId) are already known.
        /// Returns null when the item kind cannot be auto-searched with the ids available.
        /// </summary>
        public static ArrCommand? AutoSearchCommand(ArrResolvedItem item, int arrId, int? episodeId)
        {
            switch (item.Kind)
            {
                case ArrMediaKind.Movie:
                    return new ArrCommand("MoviesSearch", new JsonObject { ["name"] = "MoviesSearch", ["movieIds"] = new JsonArray(arrId) });
                case ArrMediaKind.Series:
                    return new ArrCommand("SeriesSearch", new JsonObject { ["name"] = "SeriesSearch", ["seriesId"] = arrId });
                case ArrMediaKind.Season when item.SeasonNumber is int sn:
                    return new ArrCommand("SeasonSearch", new JsonObject { ["name"] = "SeasonSearch", ["seriesId"] = arrId, ["seasonNumber"] = sn });
                case ArrMediaKind.Episode when episodeId is int eid:
                    return new ArrCommand("EpisodeSearch", new JsonObject { ["name"] = "EpisodeSearch", ["episodeIds"] = new JsonArray(eid) });
                default:
                    return null;
            }
        }

        /// <summary>The <c>GET /api/v3/release</c> query path for an interactive search of the resolved item.</summary>
        public static string? InteractiveReleasePath(ArrResolvedItem item, int arrId, int? episodeId)
        {
            switch (item.Kind)
            {
                case ArrMediaKind.Movie:
                    return $"/api/v3/release?movieId={arrId}";
                case ArrMediaKind.Season when item.SeasonNumber is int sn:
                    return $"/api/v3/release?seriesId={arrId}&seasonNumber={sn}";
                case ArrMediaKind.Episode when episodeId is int eid:
                    return $"/api/v3/release?episodeId={eid}";
                default:
                    // Whole-series interactive search is not a Sonarr concept (it searches per season/episode).
                    return null;
            }
        }
    }

    /// <summary>A resolved arr command: the human command name plus the POST body.</summary>
    public sealed record ArrCommand(string Name, JsonObject Body);
}
