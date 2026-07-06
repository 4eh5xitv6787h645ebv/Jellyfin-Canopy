using Microsoft.AspNetCore.Mvc;
using System;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Security.Cryptography;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.StaticFiles;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Controller;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model;
using MediaBrowser.Controller.Persistence;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Data;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>
    /// Arr calendar events and calendar user-data.
    /// Split out of the former JellyfinEnhancedController; method bodies, routes
    /// and attributes are unchanged.
    /// </summary>
    [Route("JellyfinEnhanced")]
    [ApiController]
    public class ArrCalendarController : JellyfinEnhancedControllerBase
    {
        private readonly ILibraryManager _libraryManager;
        private readonly IUserDataManager _userDataManager;
        private readonly IItemLookupService _itemLookup;
        private readonly Services.Arr.ArrFetchService _arrFetch;

        public ArrCalendarController(
            IHttpClientFactory httpClientFactory,
            ILogger<ArrCalendarController> logger,
            IUserManager userManager,
            ISeerrCache seerrCache,
            IPluginConfigProvider configProvider,
            ILibraryManager libraryManager,
            IUserDataManager userDataManager,
            IItemLookupService itemLookup,
            Services.Arr.ArrFetchService arrFetch)
            : base(httpClientFactory, logger, userManager, seerrCache, configProvider)
        {
            _libraryManager = libraryManager;
            _userDataManager = userDataManager;
            _itemLookup = itemLookup;
            _arrFetch = arrFetch;
        }

        [HttpGet("arr/calendar")]
        [Authorize]
        public async Task<IActionResult> GetCalendarEvents()
        {
            var config = _configProvider.ConfigurationOrNull;
            if (config == null)
                return StatusCode(500, "Plugin configuration not available");

            var events = new List<ArrItem>();

            var todayUtc = DateTime.UtcNow.Date;
            DateTime startDate = todayUtc;
            DateTime endDate = todayUtc.AddDays(90);

            if (Request.Query.TryGetValue("start", out var startValues))
            {
                if (DateTime.TryParse(startValues.ToString(), out var parsedStart))
                {
                    startDate = parsedStart.Kind == DateTimeKind.Unspecified ? DateTime.SpecifyKind(parsedStart, DateTimeKind.Utc) : parsedStart.ToUniversalTime();
                }
            }

            if (Request.Query.TryGetValue("end", out var endValues))
            {
                if (DateTime.TryParse(endValues.ToString(), out var parsedEnd))
                {
                    endDate = parsedEnd.Kind == DateTimeKind.Unspecified ? DateTime.SpecifyKind(parsedEnd, DateTimeKind.Utc) : parsedEnd.ToUniversalTime();
                }
            }

            if (endDate < startDate)
            {
                (startDate, endDate) = (endDate, startDate);
            }

            // cap the requested range to prevent an authed
            // user from passing start=1900..end=2099 and triggering 200 years
            // worth of arr-side calendar fetches + dedup loops.
            const int maxCalendarRangeDays = 365;
            var requestedRange = (endDate - startDate).TotalDays;
            bool capApplied = false;
            if (requestedRange > maxCalendarRangeDays)
            {
                _logger.LogInformation($"Calendar range capped from {(int)requestedRange} days to {maxCalendarRangeDays} days.");
                endDate = startDate.AddDays(maxCalendarRangeDays);
                capApplied = true;
            }

            // Local calendar-day bounds of the view (yyyy-MM-dd). The client sends these alongside
            // the UTC instants so date-only releases (which carry no clock time) can be range-
            // filtered by LOCAL day — a UTC-instant compare drops a midnight-UTC release whose local
            // day is in view for any viewer off UTC (CRIT-1). Fall back to the UTC date portion when
            // the params are absent/invalid, or when the abuse cap reshaped the requested range.
            string startDayKey = startDate.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
            string endDayKey = endDate.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
            if (!capApplied
                && Request.Query.TryGetValue("startDay", out var startDayValues) && IsDayKey(startDayValues.ToString())
                && Request.Query.TryGetValue("endDay", out var endDayValues) && IsDayKey(endDayValues.ToString()))
            {
                startDayKey = startDayValues.ToString();
                endDayKey = endDayValues.ToString();
                if (string.CompareOrdinal(startDayKey, endDayKey) > 0)
                {
                    (startDayKey, endDayKey) = (endDayKey, startDayKey);
                }
            }

            // Query the arr instances over a window widened by a day on each side so a date-only
            // release whose LOCAL day intersects the view is RETURNED even though its midnight-UTC
            // instant can sit up to a timezone offset outside [startDate,endDate]. The precise
            // in-code filter (IsEventInView) trims the widened result back to the requested view.
            var startIso = startDate.AddDays(-1).ToUniversalTime().ToString("o");
            var endIso = endDate.AddDays(1).ToUniversalTime().ToString("o");

            DateTime? ParseDate(object? value)
            {
                if (value == null)
                {
                    return null;
                }

                if (value is DateTime dateTimeValue)
                {
                    return dateTimeValue.Kind == DateTimeKind.Unspecified
                        ? DateTime.SpecifyKind(dateTimeValue, DateTimeKind.Utc)
                        : dateTimeValue;
                }

                var asString = Convert.ToString(value);
                if (string.IsNullOrWhiteSpace(asString))
                {
                    return null;
                }

                // Try parsing with invariant culture and assume UTC to avoid local timezone interpretation
                if (DateTime.TryParse(asString, System.Globalization.CultureInfo.InvariantCulture,
                    System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal,
                    out var parsed))
                {
                    return parsed;
                }

                // Fallback to regular parsing if above fails
                if (DateTime.TryParse(asString, out parsed))
                {
                    if (parsed.Kind == DateTimeKind.Unspecified)
                    {
                        parsed = DateTime.SpecifyKind(parsed, DateTimeKind.Utc);
                    }
                    return parsed;
                }

                return null;
            }

            void AddRelease(Dictionary<string, DateTime> releases, string type, object? value)
            {
                var parsed = ParseDate(value);
                if (!parsed.HasValue)
                {
                    return;
                }

                if (!releases.TryGetValue(type, out var existing) || parsed.Value < existing)
                {
                    releases[type] = parsed.Value;
                }
            }

            // Fetch calendar events from all configured instances in parallel
            WarnIfArrInstancesCorrupt(config);
            var sonarrInstances = config.GetEnabledSonarrInstances();
            var radarrInstances = config.GetEnabledRadarrInstances();
            var ct = HttpContext.RequestAborted;

            var sonarrTasks = sonarrInstances.Select((i, idx) => FetchSonarrCalendar(i, idx, startIso, endIso, startDate, endDate, startDayKey, endDayKey, ParseDate, ct)).ToList();
            var radarrTasks = radarrInstances.Select((i, idx) => FetchRadarrCalendar(i, idx, startIso, endIso, startDate, endDate, startDayKey, endDayKey, ParseDate, AddRelease, ct)).ToList();

            var sonarrCalResults = await Task.WhenAll(sonarrTasks);
            var radarrCalResults = await Task.WhenAll(radarrTasks);

            var errors = new List<object>();
            if (config.IsSonarrInstancesCorrupt())
                errors.Add(new { instanceName = "Sonarr", source = "Sonarr", reason = "config corrupt — see server logs" });
            else if (sonarrInstances.Count == 0 && config.GetSonarrInstances().Count > 0)
                errors.Add(new { instanceName = "Sonarr", source = "Sonarr", reason = "all Sonarr instances are disabled" });
            if (config.IsRadarrInstancesCorrupt())
                errors.Add(new { instanceName = "Radarr", source = "Radarr", reason = "config corrupt — see server logs" });
            else if (radarrInstances.Count == 0 && config.GetRadarrInstances().Count > 0)
                errors.Add(new { instanceName = "Radarr", source = "Radarr", reason = "all Radarr instances are disabled" });
            for (int i = 0; i < sonarrCalResults.Length; i++)
            {
                events.AddRange(sonarrCalResults[i].Items);
                if (sonarrCalResults[i].Error != null)
                    errors.Add(new { instanceName = sonarrInstances[i].Name, source = "Sonarr", reason = sonarrCalResults[i].Error });
            }
            for (int i = 0; i < radarrCalResults.Length; i++)
            {
                events.AddRange(radarrCalResults[i].Items);
                if (radarrCalResults[i].Error != null)
                    errors.Add(new { instanceName = radarrInstances[i].Name, source = "Radarr", reason = radarrCalResults[i].Error });
            }

            // Resolve ItemIds against Jellyfin's library BEFORE dedup so the dedup tie-breaker can
            // prefer candidates that the current user can actually access (H4). Without this, dedup
            // might pick an instance-B candidate with HasFile=true in a root folder the user can't
            // read, and then the subsequent access filter would hide the event entirely — even
            // though instance-A had the same episode in an accessible root folder.
            var providerKeys = events
                .SelectMany(ProviderHelper.GetAllProviders)
                .Distinct()
                .ToList();

            var itemMap = _itemLookup.GetItemIdsByProvidersBatch(providerKeys);

            foreach (var evt in events)
            {
                evt.ItemId = ProviderHelper.GetBestItemId(ProviderHelper.GetProviders(evt), itemMap);
                evt.ItemEpisodeId = ProviderHelper.GetBestItemId(ProviderHelper.GetEpisodeProviders(evt), itemMap);
            }

            // Build access info now so the dedup step can consult it.
            HashSet<Guid>? accessibleIds = null;
            Dictionary<string, bool>? rootFolderAccessMap = null;
            if (config.CalendarFilterByLibraryAccess)
            {
                var calendarUserId = UserHelper.GetCurrentUserId(User);
                if (calendarUserId.HasValue)
                {
                    var calendarUserForFilter = _userManager.GetUserById(calendarUserId.Value);
                    if (calendarUserForFilter != null)
                    {
                        var uniqueItemIds = events
                            .Select(e => e.ItemId)
                            .Where(id => id.HasValue)
                            .Select(id => id!.Value)
                            .Distinct()
                            .ToList();

                        accessibleIds = new HashSet<Guid>();
                        foreach (var id in uniqueItemIds)
                        {
                            if (_libraryManager.GetItemById<BaseItem>(id, calendarUserForFilter) != null)
                                accessibleIds.Add(id);
                        }

                        rootFolderAccessMap = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);
                        foreach (var evt in events.Where(e => e.ItemId.HasValue && !string.IsNullOrEmpty(e.RootFolderPath)))
                        {
                            var isAccessible = accessibleIds.Contains(evt.ItemId!.Value);
                            if (isAccessible || !rootFolderAccessMap.ContainsKey(evt.RootFolderPath!))
                                rootFolderAccessMap[evt.RootFolderPath!] = isAccessible;
                        }
                    }
                }
            }

            // Returns true when the filter is off, or when we have positive evidence the user can
            // access this event. "No information" defaults to true (same as the final filter).
            bool IsAccessible(ArrItem evt)
            {
                if (accessibleIds == null) return true;
                if (evt.ItemId.HasValue)
                    return accessibleIds.Contains(evt.ItemId.Value);
                if (!string.IsNullOrEmpty(evt.RootFolderPath)
                    && rootFolderAccessMap != null
                    && rootFolderAccessMap.TryGetValue(evt.RootFolderPath, out var a))
                    return a;
                return true;
            }

            // Deduplicate events across instances. Tie-break priority:
            //   1. Accessible to the current user (prevents H4 hide-accessible-event bug).
            //   2. HasFile=true (if one instance has the file downloaded, show that).
            // The losing candidate's InstanceName is preserved in AlsoInInstances so the UI
            // can show "also in: X, Y" context instead of silently erasing other instances.
            var deduped = new Dictionary<string, ArrItem>();
            foreach (var evt in events)
            {
                var dedupeKey = BuildDedupKey(evt);

                if (!deduped.TryGetValue(dedupeKey, out var existing))
                {
                    deduped[dedupeKey] = evt;
                    continue;
                }

                var existingAccess = IsAccessible(existing);
                var newAccess = IsAccessible(evt);
                ArrItem winner, loser;
                if (newAccess && !existingAccess)
                {
                    winner = evt; loser = existing;
                }
                else if (newAccess == existingAccess && !existing.HasFile && evt.HasFile)
                {
                    winner = evt; loser = existing;
                }
                else
                {
                    winner = existing; loser = evt;
                }

                if (!ReferenceEquals(winner, existing))
                {
                    deduped[dedupeKey] = winner;
                }

                // Merge loser's instance name into winner's AlsoInInstances (dedup & skip self).
                if (!string.IsNullOrEmpty(loser.InstanceName)
                    && !string.Equals(loser.InstanceName, winner.InstanceName, StringComparison.Ordinal))
                {
                    winner.AlsoInInstances ??= new List<string>();
                    if (!winner.AlsoInInstances.Contains(loser.InstanceName))
                        winner.AlsoInInstances.Add(loser.InstanceName);
                }
                // Preserve loser's own AlsoInInstances entries too.
                if (loser.AlsoInInstances != null)
                {
                    winner.AlsoInInstances ??= new List<string>();
                    foreach (var name in loser.AlsoInInstances)
                    {
                        if (!string.Equals(name, winner.InstanceName, StringComparison.Ordinal)
                            && !winner.AlsoInInstances.Contains(name))
                            winner.AlsoInInstances.Add(name);
                    }
                }
            }
            events = deduped.Values.ToList();

            // Final safety-net access filter (defense in depth — dedup above already respects this,
            // but if the filter is on and a lone candidate is inaccessible, it must still be hidden).
            if (config.CalendarFilterByLibraryAccess && accessibleIds != null)
            {
                events = events.Where(e =>
                {
                    if (e.ItemId.HasValue)
                        return accessibleIds.Contains(e.ItemId.Value);
                    if (!string.IsNullOrEmpty(e.RootFolderPath)
                        && rootFolderAccessMap != null
                        && rootFolderAccessMap.TryGetValue(e.RootFolderPath, out var hasAccess))
                        return hasAccess;
                    return true;
                }).ToList();
            }

            return Ok(new { events, errors });
        }

        // Cross-instance dedup key. A series tvdbId + S/E (or a movie tmdbId + release-type) already
        // uniquely identifies the item, so the release date is intentionally NOT part of the key: a
        // given episode/movie-release can't legitimately occur twice, and including the date could only
        // false-split the same item across a UTC-midnight boundary (the TZ drift the old normalizer
        // tried to absorb) — never a wrong merge. TvdbId/TmdbId are pre-normalized by
        // ArrIdHelper.ToNullableId, so a present-but-0 id takes the title fallback.
        /// <summary>True for a well-formed "yyyy-MM-dd" local-day key.</summary>
        internal static bool IsDayKey(string? value)
            => !string.IsNullOrEmpty(value)
            && DateTime.TryParseExact(value, "yyyy-MM-dd",
                System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.None, out _);

        /// <summary>
        /// Whether a mapped calendar event falls within the requested view. Date-only releases
        /// (Radarr cinema/digital/physical; Sonarr airDate fallback) carry no clock time, so they
        /// are compared by their LOCAL calendar day against the client's local-day bounds — a
        /// UTC-instant comparison would drop a midnight-UTC release whose local day intersects the
        /// view for any viewer off UTC (CRIT-1). Genuine instants keep the exact UTC-window compare.
        /// </summary>
        internal static bool IsEventInView(
            bool dateOnly, string? releaseLocalDay, DateTime releaseUtc,
            DateTime startUtc, DateTime endUtc, string startDay, string endDay)
        {
            if (dateOnly)
            {
                return !string.IsNullOrEmpty(releaseLocalDay)
                    && string.CompareOrdinal(releaseLocalDay, startDay) >= 0
                    && string.CompareOrdinal(releaseLocalDay, endDay) <= 0;
            }

            return releaseUtc >= startUtc && releaseUtc <= endUtc;
        }

        internal static string BuildDedupKey(ArrItem evt)
        {
            if (evt.Source == nameof(ArrType.Sonarr))
            {
                var seriesKey = evt.TvdbId?.ToString() ?? $"title:{evt.Title}";
                return $"sonarr|{seriesKey}|S{evt.SeasonNumber}E{evt.EpisodeNumber}";
            }

            var movieKey = evt.TmdbId?.ToString() ?? $"title:{evt.Title}";
            return $"radarr|{movieKey}|{evt.ReleaseType}";
        }

        private Task<(List<ArrItem> Items, string? Error)> FetchSonarrCalendar(
            ArrInstance instance, int instanceIndex, string startIso, string endIso,
            DateTime startDate, DateTime endDate, string startDayKey, string endDayKey,
            Func<object?, DateTime?> parseDate, CancellationToken ct)
        {
            return _arrFetch.FetchAndMapAsync<List<ArrItem>>(
                instance,
                $"/api/v3/calendar?includeSeries=true&unmonitored=true&start={startIso}&end={endIso}",
                data =>
                {
                    var items = new List<ArrItem>();
                    if (data == null) return items;
                    foreach (var episode in data.AsArray())
                    {
                        var series = episode?["series"];
                        var airDateUtcRaw = (string?)episode?["airDateUtc"];
                        var airDate = parseDate(airDateUtcRaw ?? (string?)episode?["airDate"]);
                        if (!airDate.HasValue) continue;
                        // Genuine instant only when airDateUtc was present; the airDate fallback
                        // is a calendar day with no broadcast time and must render date-only.
                        var sonarrDateOnly = string.IsNullOrWhiteSpace(airDateUtcRaw);

                        string? seriesPosterUrl = null;
                        string? seriesBackdropUrl = null;
                        if (series?["images"] is JsonArray seriesImages)
                        {
                            foreach (var img in seriesImages)
                            {
                                var coverType = (string?)img?["coverType"];
                                var imageUrl = (string?)img?["remoteUrl"] ?? (string?)img?["url"];
                                if (string.IsNullOrWhiteSpace(imageUrl)) continue;
                                if (seriesBackdropUrl == null && (coverType == "fanart" || coverType == "banner"))
                                    seriesBackdropUrl = imageUrl;
                                else if (seriesPosterUrl == null && coverType == "poster")
                                    seriesPosterUrl = imageUrl;
                            }
                        }

                        var seasonNumber = (int?)episode?["seasonNumber"] ?? 0;
                        var episodeNumber = (int?)episode?["episodeNumber"] ?? 0;
                        var episodeTitle = (string?)episode?["title"] ?? "Unknown Episode";

                        var sonarrUtc = airDate.Value.ToUniversalTime();
                        var (sonarrIso, sonarrLocal) = Helpers.Arr.ArrReleaseDate.Build(sonarrUtc, sonarrDateOnly);
                        // Trim the day-widened arr query back to the requested view. A date-only
                        // airDate is kept when its LOCAL day intersects the view; a genuine instant
                        // (airDateUtc) keeps the exact UTC-window comparison (CRIT-1).
                        if (!IsEventInView(sonarrDateOnly, sonarrLocal, sonarrUtc, startDate, endDate, startDayKey, endDayKey))
                            continue;

                        items.Add(new ArrItem
                        {
                            // Namespace the per-instance row id by source + the instance's unique
                            // position so two Sonarr instances that both number episodes from 1 —
                            // even with an identical or blank display name — can't collide.
                            Id = ArrIdHelper.NamespacedId(nameof(ArrType.Sonarr), instanceIndex, episode?["id"]),
                            Source = nameof(ArrType.Sonarr),
                            InstanceName = instance.Name,
                            Type = "Series",
                            Title = (string?)series?["title"] ?? "Unknown Series",
                            Subtitle = $"S{seasonNumber:D2}E{episodeNumber:D2} - {episodeTitle}",
                            ReleaseDate = sonarrIso,
                            ReleaseDateLocal = sonarrLocal,
                            DateOnly = sonarrDateOnly,
                            ReleaseType = "Episode",
                            HasFile = (bool?)episode?["hasFile"] ?? false,
                            Monitored = (bool?)episode?["monitored"] ?? false,
                            SeriesId = (int?)episode?["seriesId"],
                            SeasonNumber = seasonNumber,
                            EpisodeNumber = episodeNumber,
                            EpisodeTitle = episodeTitle,
                            Overview = (string?)episode?["overview"],
                            TvdbId = ArrIdHelper.ToNullableId((int?)series?["tvdbId"]),
                            ImdbId = (string?)series?["imdbId"],
                            TmdbId = ArrIdHelper.ToNullableId((int?)series?["tmdbId"]),
                            PosterUrl = seriesPosterUrl,
                            BackdropUrl = seriesBackdropUrl,
                            EpisodeTvdbId = ArrIdHelper.ToNullableId((int?)episode?["tvdbId"]),
                            EpisodeImdbId = (string?)episode?["imdbId"],
                            RootFolderPath = Services.Arr.ArrFetchService.GetRootFolderFromPath((string?)series?["path"])
                        });
                    }
                    return items;
                },
                emptyResult: new List<ArrItem>(),
                // aligned with Radarr (15s) — was 30s, which doubled
                // the worst-case calendar latency under one slow instance.
                timeout: TimeSpan.FromSeconds(15),
                contextLabel: "Sonarr calendar",
                ct: ct);
        }

        private Task<(List<ArrItem> Items, string? Error)> FetchRadarrCalendar(
            ArrInstance instance, int instanceIndex, string startIso, string endIso,
            DateTime startDate, DateTime endDate, string startDayKey, string endDayKey,
            Func<object?, DateTime?> parseDate,
            Action<Dictionary<string, DateTime>, string, object?> addRelease,
            CancellationToken ct)
        {
            return _arrFetch.FetchAndMapAsync<List<ArrItem>>(
                instance,
                $"/api/v3/calendar?unmonitored=true&start={startIso}&end={endIso}",
                data =>
                {
                    var items = new List<ArrItem>();
                    if (data == null) return items;
                    foreach (var movie in data.AsArray())
                    {
                        var releaseDates = new Dictionary<string, DateTime>(StringComparer.OrdinalIgnoreCase);

                        string? posterUrl = null;
                        string? backdropUrl = null;
                        if (movie?["images"] is JsonArray movieImages)
                        {
                            foreach (var img in movieImages)
                            {
                                var coverType = (string?)img?["coverType"];
                                var imageUrl = (string?)img?["remoteUrl"] ?? (string?)img?["url"];
                                if (string.IsNullOrWhiteSpace(imageUrl)) continue;
                                if (posterUrl == null && coverType == "poster") { posterUrl = imageUrl; continue; }
                                if (backdropUrl == null && (coverType == "fanart" || coverType == "backdrop"))
                                    backdropUrl = imageUrl;
                            }
                        }

                        addRelease(releaseDates, "CinemaRelease", (string?)movie?["inCinemas"]);
                        addRelease(releaseDates, "PhysicalRelease", (string?)movie?["physicalRelease"]);
                        addRelease(releaseDates, "DigitalRelease", (string?)movie?["digitalRelease"]);

                        if (movie?["releases"] is JsonArray movieReleases)
                        {
                            foreach (var release in movieReleases)
                            {
                                // ParseDate accepts the node's raw text via Convert.ToString.
                                var releaseDate = (object?)release?["releaseDate"] ?? release?["date"];
                                var type = release?["type"]?.ToString()?.ToLowerInvariant();
                                var isPhysical = (bool?)release?["isPhysical"] ?? false;
                                if (isPhysical) addRelease(releaseDates, "PhysicalRelease", releaseDate);
                                else if (type == "digital") addRelease(releaseDates, "DigitalRelease", releaseDate);
                                else if (type == "theatrical" || type == "cinema" || type == "theater")
                                    addRelease(releaseDates, "CinemaRelease", releaseDate);
                            }
                        }

                        if (releaseDates.Count == 0) continue;

                        var movieTitle = (string?)movie?["title"] ?? (string?)movie?["originalTitle"] ?? "Unknown";
                        string? movieYear = movie?["year"]?.ToString();

                        foreach (var kvp in releaseDates)
                        {
                            var releaseUtc = kvp.Value.ToUniversalTime();
                            // Radarr cinema/digital/physical releases are date-granularity by
                            // definition — emit the date-only contract so the client buckets them
                            // on the correct local day and prints no bogus clock time.
                            var (releaseIso, releaseLocal) = Helpers.Arr.ArrReleaseDate.Build(releaseUtc, dateOnly: true);
                            // Trim the day-widened arr query back to the view by LOCAL day: a
                            // midnight-UTC release whose local day is in view must survive even
                            // though its instant can sit a timezone offset outside [start,end] (CRIT-1).
                            if (!IsEventInView(true, releaseLocal, releaseUtc, startDate, endDate, startDayKey, endDayKey))
                                continue;
                            items.Add(new ArrItem
                            {
                                // Namespace the per-instance row id (plus release-type) by source + the
                                // instance's unique position so two Radarr instances numbering movies
                                // from 1 — even with an identical or blank display name — can't collide.
                                Id = ArrIdHelper.NamespacedId(nameof(ArrType.Radarr), instanceIndex, $"{movie?["id"]}-{kvp.Key}"),
                                Source = nameof(ArrType.Radarr),
                                InstanceName = instance.Name,
                                Type = "Movie",
                                Title = movieTitle,
                                Subtitle = movieYear,
                                ReleaseDate = releaseIso,
                                ReleaseDateLocal = releaseLocal,
                                DateOnly = true,
                                ReleaseType = kvp.Key,
                                HasFile = (bool?)movie?["hasFile"] ?? false,
                                Monitored = (bool?)movie?["monitored"] ?? false,
                                PosterUrl = posterUrl,
                                BackdropUrl = backdropUrl,
                                TmdbId = ArrIdHelper.ToNullableId((int?)movie?["tmdbId"]),
                                ImdbId = (string?)movie?["imdbId"],
                                RootFolderPath = Services.Arr.ArrFetchService.GetRootFolderFromPath((string?)movie?["path"])
                            });
                        }
                    }
                    return items;
                },
                emptyResult: new List<ArrItem>(),
                // aligned with Sonarr (15s) — was 10s, which timed
                // out busy Radarr instances behind slow proxies.
                timeout: TimeSpan.FromSeconds(15),
                contextLabel: "Radarr calendar",
                ct: ct);
        }

        [HttpPost("arr/calendar/user-data")]
        [Authorize]
        public IActionResult GetCalendarUserDataForEvents([FromBody] CalendarUserDataRequest request)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null)
                return Unauthorized("User not found");

            var user = _userManager.GetUserById(userId.Value);
            if (user == null)
                return Unauthorized("User not found");

            var results = new List<object>();

            try
            {
                if (request?.Events == null || request.Events.Count == 0)
                    return Ok(new { results });

                var ids = request.Events
                    .SelectMany(e => new Guid?[] { e.ItemId, e.ItemEpisodeId })
                    .Where(id => id.HasValue)
                    .Select(id => id!.Value)
                    .Distinct()
                    .ToList();

                var itemsById = new Dictionary<Guid, BaseItem>();
                if (ids.Count > 0)
                {
                    var items = _libraryManager.GetItemList(new InternalItemsQuery
                    {
                        User = user,
                        ItemIds = ids.ToArray(),
                        Recursive = true
                    });

                    foreach (var item in items)
                    {
                        if (!itemsById.ContainsKey(item.Id))
                            itemsById[item.Id] = item;
                    }
                }

                // Process each event using pre-fetched items
                foreach (var evt in request.Events)
                {
                    bool isFavorite = false;
                    bool isWatched = false;

                    BaseItem? item = null;
                    BaseItem? episodeItem = null;

                    if (evt.ItemId.HasValue)
                        itemsById.TryGetValue(evt.ItemId.Value, out item);
                    if (evt.ItemEpisodeId.HasValue)
                        itemsById.TryGetValue(evt.ItemEpisodeId.Value, out episodeItem);

                    if (item != null)
                    {
                        var itemData = _userDataManager.GetUserData(user, item);
                        isFavorite = itemData?.Likes == true;

                        if (evt.Type == "Movie")
                        {
                            isWatched = itemData?.Played == true || (itemData?.PlaybackPositionTicks ?? 0) > 0;
                        }
                    }

                    if (evt.Type == "Series" && episodeItem != null)
                    {
                        var epData = _userDataManager.GetUserData(user, episodeItem);
                        isWatched = epData?.Played == true || (epData?.PlaybackPositionTicks ?? 0) > 0;
                    }

                    results.Add(new
                    {
                        id = evt.Id,
                        isFavorite,
                        isWatched
                    });
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"Failed to get calendar user data: {ex.Message}");
            }

            return Ok(new { results });
        }

        public class CalendarUserDataRequest
        {
            public List<CalendarEventInfo> Events { get; set; } = new();
        }

        public class CalendarEventInfo
        {
            public string? Id { get; set; }
            public string? Type { get; set; }
            public string? Title { get; set; }
            public Guid? ItemId { get; set; }
            public Guid? ItemEpisodeId { get; set; }
            public int? TvdbId { get; set; }
            public string? ImdbId { get; set; }
            public int? TmdbId { get; set; }
            public int? SeasonNumber { get; set; }
            public int? EpisodeNumber { get; set; }
        }
    }
}
