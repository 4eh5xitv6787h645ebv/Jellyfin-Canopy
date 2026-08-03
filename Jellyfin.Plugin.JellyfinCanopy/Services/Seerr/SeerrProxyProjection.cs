using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Seerr
{
    /// <summary>
    /// Applies the small compatibility projections owned by Canopy's Seerr
    /// proxy. The upstream body has already passed the shared streaming byte
    /// limit and JSON parser before it reaches this class.
    /// </summary>
    internal static class SeerrProxyProjection
    {
        private const int MediaStatusUnknown = 1;
        private const int MediaStatusPending = 2;
        private const int MediaStatusProcessing = 3;
        private const int MediaStatusAvailable = 5;

        /// <summary>
        /// Normalizes only exact, reviewed response shapes. Unknown routes are
        /// returned byte-for-byte so this layer cannot become a generic JSON
        /// rewriting surface.
        /// </summary>
        internal static bool TryProject(string json, string apiPath, out string projected)
        {
            projected = json;
            var path = PathOnly(apiPath);
            var isWatchlist = string.Equals(
                path,
                "/api/v1/discover/watchlist",
                StringComparison.OrdinalIgnoreCase);
            var isTvDetail = IsExactTvDetailPath(path);
            if (!isWatchlist && !isTvDetail)
            {
                return true;
            }

            try
            {
                if (JsonNode.Parse(json) is not JsonObject root)
                {
                    return false;
                }

                bool changed;
                var valid = isWatchlist
                    ? TryAddUniformWatchlistIds(root, out changed)
                    : TryAddPerSeason4kStatus(root, out changed);
                if (!valid)
                {
                    return false;
                }

                if (changed)
                {
                    projected = root.ToJsonString();
                }

                return true;
            }
            catch (JsonException)
            {
                return false;
            }
            catch (InvalidOperationException)
            {
                return false;
            }
        }

        private static bool TryAddUniformWatchlistIds(JsonObject root, out bool changed)
        {
            changed = false;
            if (root["results"] is not JsonArray results)
            {
                // Keep compatibility with upstream variants and test doubles
                // that omit the collection on an otherwise valid response.
                return true;
            }

            foreach (var node in results)
            {
                if (node is not JsonObject item
                    || item.ContainsKey("id")
                    || !TryReadPositiveInt(item["tmdbId"], out var tmdbId))
                {
                    continue;
                }

                // Retain tmdbId for every existing consumer and add the same
                // id key used by search/discovery rows.
                item["id"] = tmdbId;
                changed = true;
            }

            return true;
        }

        private static bool TryAddPerSeason4kStatus(JsonObject root, out bool changed)
        {
            changed = false;
            if (root["mediaInfo"] is not JsonObject mediaInfo
                || mediaInfo["seasons"] is not JsonArray seasons)
            {
                // Unrequested shows can legitimately have no mediaInfo yet.
                // There is no season-owned state to project in that shape.
                return true;
            }

            var derived = Derive4kRequestStates(mediaInfo["requests"] as JsonArray);
            foreach (var node in seasons)
            {
                if (node is not JsonObject season
                    || TryReadPositiveInt(season["status4k"], out _))
                {
                    continue;
                }

                var status = MediaStatusUnknown;
                if (TryReadPositiveInt(season["seasonNumber"], out var seasonNumber)
                    && derived.TryGetValue(seasonNumber, out var requestStatus))
                {
                    status = requestStatus;
                }

                season["status4k"] = status;
                changed = true;
            }

            return true;
        }

        private static Dictionary<int, int> Derive4kRequestStates(JsonArray? requests)
        {
            var states = new Dictionary<int, int>();
            if (requests == null)
            {
                return states;
            }

            foreach (var node in requests)
            {
                if (node is not JsonObject request
                    || !IsTrue(request["is4k"])
                    || request["seasons"] is not JsonArray requestSeasons)
                {
                    continue;
                }

                TryReadPositiveInt(request["status"], out var parentStatus);
                foreach (var seasonNode in requestSeasons)
                {
                    if (seasonNode is not JsonObject requestSeason
                        || !TryReadPositiveInt(requestSeason["seasonNumber"], out var seasonNumber))
                    {
                        continue;
                    }

                    var requestStatus = TryReadPositiveInt(requestSeason["status"], out var childStatus)
                        ? childStatus
                        : parentStatus;
                    var mediaStatus = RequestStatusToMediaStatus(requestStatus);
                    if (mediaStatus == MediaStatusUnknown)
                    {
                        continue;
                    }

                    if (!states.TryGetValue(seasonNumber, out var current)
                        || StatusPriority(mediaStatus) > StatusPriority(current))
                    {
                        states[seasonNumber] = mediaStatus;
                    }
                }
            }

            return states;
        }

        private static int RequestStatusToMediaStatus(int requestStatus) => requestStatus switch
        {
            // Seerr MediaRequestStatus: pending=1, approved=2,
            // declined=3, failed=4, completed=5.
            1 => MediaStatusPending,
            2 => MediaStatusProcessing,
            5 => MediaStatusAvailable,
            _ => MediaStatusUnknown,
        };

        private static int StatusPriority(int status) => status switch
        {
            MediaStatusAvailable => 3,
            MediaStatusProcessing => 2,
            MediaStatusPending => 1,
            _ => 0,
        };

        private static bool IsTrue(JsonNode? node)
        {
            if (node is not JsonValue value)
            {
                return false;
            }

            if (value.TryGetValue<bool>(out var boolean))
            {
                return boolean;
            }

            if (value.TryGetValue<int>(out var number))
            {
                return number != 0;
            }

            return value.TryGetValue<string>(out var text)
                && (string.Equals(text, "true", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(text, "1", StringComparison.Ordinal));
        }

        private static bool TryReadPositiveInt(JsonNode? node, out int value)
        {
            value = 0;
            if (node is not JsonValue jsonValue)
            {
                return false;
            }

            if (jsonValue.TryGetValue<int>(out value))
            {
                return value > 0;
            }

            return jsonValue.TryGetValue<string>(out var text)
                && int.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out value)
                && value > 0;
        }

        private static bool IsExactTvDetailPath(string path)
        {
            const string prefix = "/api/v1/tv/";
            return path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
                && int.TryParse(
                    path.Substring(prefix.Length),
                    NumberStyles.None,
                    CultureInfo.InvariantCulture,
                    out var tmdbId)
                && tmdbId > 0;
        }

        private static string PathOnly(string apiPath)
        {
            var query = apiPath.IndexOf('?', StringComparison.Ordinal);
            return query >= 0 ? apiPath.Substring(0, query) : apiPath;
        }
    }
}
