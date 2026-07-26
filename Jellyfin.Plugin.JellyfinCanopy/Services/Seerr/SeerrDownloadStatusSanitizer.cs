using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinCanopy.Model.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Services.Arr;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Seerr
{
    /// <summary>
    /// Replaces raw Arr/downloader rows embedded in Seerr Media responses with the
    /// browser-safe <see cref="SeerrDownloadStatusDto"/> allowlist.
    /// </summary>
    internal static class SeerrDownloadStatusSanitizer
    {
        private static readonly string[] DownloadProperties =
        {
            "downloadStatus",
            "downloadStatus4k",
        };

        public static bool TrySanitize(
            string body,
            DateTimeOffset now,
            bool includeDownloadRelations,
            out string sanitizedBody)
        {
            sanitizedBody = body;
            // Seerr's Media entity attaches these queue relations after every load, so they can
            // appear in detail, search, slider, collection, and request-shaped documents. Avoid
            // reparsing the overwhelmingly common responses that cannot contain either field.
            // The owning transport caps bodies at 8 MiB and JsonNode keeps the default 64-level
            // depth limit, so the one-pass projection and its temporary DOM remain bounded.
            if (!body.Contains("\"downloadStatus", StringComparison.OrdinalIgnoreCase)
                && !body.Contains("\\u", StringComparison.Ordinal))
            {
                return true;
            }

            try
            {
                var root = JsonNode.Parse(body);
                if (root == null)
                {
                    return false;
                }

                ProjectRelations(root, now, includeDownloadRelations);

                sanitizedBody = root.ToJsonString();
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

        private static void ProjectRelations(
            JsonNode node,
            DateTimeOffset now,
            bool includeDownloadRelations)
        {
            if (node is JsonArray array)
            {
                foreach (var item in array)
                {
                    if (item != null)
                    {
                        ProjectRelations(item, now, includeDownloadRelations);
                    }
                }

                return;
            }

            if (node is not JsonObject value)
            {
                return;
            }

            List<KeyValuePair<string, JsonArray>>? replacements = null;
            foreach (var (propertyName, child) in value)
            {
                if (IsDownloadProperty(propertyName))
                {
                    var projected = new JsonArray();
                    if (includeDownloadRelations && child is JsonArray downloadArray)
                    {
                        foreach (var rawDownload in downloadArray)
                        {
                            if (rawDownload is not JsonObject download)
                            {
                                continue;
                            }

                            projected.Add(JsonSerializer.SerializeToNode(Project(download, now)));
                        }
                    }

                    // A malformed/null upstream relation is not evidence of a row. Preserve
                    // the public array contract while failing closed on its contents.
                    replacements ??= new List<KeyValuePair<string, JsonArray>>(2);
                    replacements.Add(new KeyValuePair<string, JsonArray>(propertyName, projected));
                    continue;
                }

                if (child != null)
                {
                    ProjectRelations(child, now, includeDownloadRelations);
                }
            }

            if (replacements == null)
            {
                return;
            }

            foreach (var (propertyName, replacement) in replacements)
            {
                value[propertyName] = replacement;
            }
        }

        private static SeerrDownloadStatusDto Project(JsonObject download, DateTimeOffset now)
        {
            var size = ReadDouble(download["size"]);
            var sizeLeft = ReadDouble(download["sizeLeft"] ?? download["sizeleft"]);
            var normalized = ArrDownloadLifecycleNormalizer.NormalizeQueue(
                new ArrDownloadQueueSignal
                {
                    RawStatus = ReadString(download["status"]),
                    TrackedState = ReadString(
                        download["trackedDownloadState"] ?? download["trackedState"]),
                    TrackedStatus = ReadString(
                        download["trackedDownloadStatus"] ?? download["trackedStatus"]),
                    Size = size,
                    SizeLeft = sizeLeft,
                    TimeLeft = ReadString(download["timeleft"] ?? download["timeLeft"]),
                });

            return new SeerrDownloadStatusDto
            {
                Lifecycle = normalized.Lifecycle,
                Progress = ArrDownloadLifecycleNormalizer.CalculateTransferProgress(size, sizeLeft),
                TimeRemaining = ReadTimeRemaining(download, now),
                SeasonNumber = ReadSeasonNumber(download),
            };
        }

        private static string? ReadTimeRemaining(JsonObject download, DateTimeOffset now)
        {
            var direct = ArrDownloadLifecycleNormalizer.SanitizeTimeRemaining(
                ReadString(download["timeleft"] ?? download["timeLeft"]));
            if (direct != null)
            {
                return direct;
            }

            var estimatedCompletion = ReadString(download["estimatedCompletionTime"]);
            if (string.IsNullOrWhiteSpace(estimatedCompletion)
                || !DateTimeOffset.TryParse(
                    estimatedCompletion,
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.AllowWhiteSpaces | DateTimeStyles.AssumeUniversal,
                    out var completion))
            {
                return null;
            }

            var remaining = completion.ToUniversalTime() - now.ToUniversalTime();
            if (remaining < TimeSpan.Zero || remaining > TimeSpan.FromDays(365))
            {
                return null;
            }

            // Whole seconds are sufficient for a human ETA and avoid forwarding the
            // upstream timestamp's sub-second precision.
            remaining = TimeSpan.FromSeconds(Math.Ceiling(remaining.TotalSeconds));
            return ArrDownloadLifecycleNormalizer.SanitizeTimeRemaining(
                remaining.ToString("c", CultureInfo.InvariantCulture));
        }

        private static int? ReadSeasonNumber(JsonObject download)
        {
            if (download["episode"] is not JsonObject episode)
            {
                return null;
            }

            var value = ReadInt(episode["seasonNumber"]);
            return value is >= 0 and <= 10_000 ? value : null;
        }

        private static string ReadString(JsonNode? node)
            => node is JsonValue value && value.TryGetValue<string>(out var text)
                ? text ?? string.Empty
                : string.Empty;

        private static double? ReadDouble(JsonNode? node)
        {
            if (node is not JsonValue value
                || !value.TryGetValue<double>(out var number)
                || !double.IsFinite(number))
            {
                return null;
            }

            return number;
        }

        private static int? ReadInt(JsonNode? node)
        {
            if (node is not JsonValue value || !value.TryGetValue<int>(out var number))
            {
                return null;
            }

            return number;
        }

        private static bool IsDownloadProperty(string propertyName)
        {
            foreach (var candidate in DownloadProperties)
            {
                if (string.Equals(propertyName, candidate, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }

            return false;
        }
    }
}
