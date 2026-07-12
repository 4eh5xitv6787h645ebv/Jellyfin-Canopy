using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Arr;
using Jellyfin.Plugin.JellyfinCanopy.Model.Arr;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Arr
{
    /// <summary>Options for adding a resolved item to a Sonarr/Radarr instance.</summary>
    public sealed record ArrAddRequest(
        string InstanceName,
        int QualityProfileId,
        string RootFolderPath,
        bool Monitored,
        bool SearchOnAdd,
        string? Monitor,
        string? MinimumAvailability);

    /// <summary>
    /// Orchestrates the Search / Interactive Search / Manage actions against Sonarr/Radarr for a
    /// resolved Jellyfin item. Pure JSON shaping is delegated to <see cref="ArrSearchMapping"/> and
    /// instance discovery to <see cref="ArrTargetResolver"/>; every HTTP call goes through
    /// <see cref="ArrFetchService"/>. Consumed only by the admin-gated <c>ArrSearchController</c>.
    /// </summary>
    public sealed class ArrActionService
    {
        // Interactive search hits live indexers and is legitimately slow; the rest are quick.
        private static readonly TimeSpan ReleaseTimeout = TimeSpan.FromSeconds(90);
        private static readonly TimeSpan CommandTimeout = TimeSpan.FromSeconds(20);
        private static readonly TimeSpan MutateTimeout = TimeSpan.FromSeconds(30);
        private static readonly TimeSpan QueueTimeout = TimeSpan.FromSeconds(15);

        private readonly ArrFetchService _fetch;
        private readonly ArrTargetResolver _targets;
        private readonly ILogger<ArrActionService> _logger;

        public ArrActionService(ArrFetchService fetch, ArrTargetResolver targets, ILogger<ArrActionService> logger)
        {
            _fetch = fetch;
            _targets = targets;
            _logger = logger;
        }

        private static string ServiceOf(ArrResolvedItem item) => item.IsRadarr ? "radarr" : "sonarr";

        private static List<ArrInstance> EnabledInstances(ArrResolvedItem item, PluginConfiguration config)
            => item.IsRadarr ? config.GetEnabledRadarrInstances() : config.GetEnabledSonarrInstances();

        private static List<ArrInstance> EnabledInstances(string service, PluginConfiguration config)
            => service == "radarr" ? config.GetEnabledRadarrInstances() : config.GetEnabledSonarrInstances();

        // ── context ──────────────────────────────────────────────────────────

        /// <summary>Resolves what the client should offer for an item, and where it's already tracked.</summary>
        public async Task<ArrContextDto> BuildContextAsync(ArrResolvedItem item, PluginConfiguration config, CancellationToken ct)
        {
            var dto = new ArrContextDto
            {
                Kind = KindString(item.Kind),
                Name = item.Name,
                SeasonNumber = item.SeasonNumber,
                EpisodeNumber = item.EpisodeNumber,
            };

            if (item.Kind == ArrMediaKind.Unknown)
                return dto;

            var service = ServiceOf(item);
            dto.Service = service;
            dto.SupportsInteractive = item.Kind is ArrMediaKind.Movie or ArrMediaKind.Season or ArrMediaKind.Episode;

            var instances = EnabledInstances(item, config);
            dto.ServiceConfigured = instances.Count > 0;
            if (instances.Count == 0 || !item.HasArrIdentity)
                return dto;

            var (matches, errors) = await _targets.ResolveMatchesAsync(item, instances, service, ct).ConfigureAwait(false);
            dto.Errors = errors;
            foreach (var m in matches)
            {
                dto.Targets.Add(new ArrTargetDto
                {
                    InstanceName = m.Instance.Name,
                    Service = m.Service,
                    ArrId = m.ArrId,
                    EpisodeId = m.EpisodeId,
                    Monitored = m.Monitored,
                    HasFile = m.HasFile,
                });
            }

            // Add applies only to a whole movie/series (a season/episode is added with its series),
            // and only to enabled instances that don't already track it.
            if (item.Kind is ArrMediaKind.Movie or ArrMediaKind.Series)
            {
                var present = new HashSet<string>(matches.Select(m => m.Instance.Name), StringComparer.Ordinal);
                dto.AddableInstances = instances
                    .Select(i => i.Name)
                    .Where(name => !present.Contains(name))
                    .Distinct(StringComparer.Ordinal)
                    .ToList();
            }

            return dto;
        }

        // ── automatic search ─────────────────────────────────────────────────

        /// <summary>Dispatches the correct search command to every tracking instance (or one named instance).</summary>
        public async Task<ArrDispatchResultDto> DispatchAutoSearchAsync(
            ArrResolvedItem item, PluginConfiguration config, string? instanceName, CancellationToken ct)
        {
            var result = new ArrDispatchResultDto();
            var service = ServiceOf(item);
            var instances = EnabledInstances(item, config);
            var (matches, errors) = await _targets.ResolveMatchesAsync(item, instances, service, ct).ConfigureAwait(false);
            result.Errors.AddRange(errors);

            var targets = instanceName != null
                ? matches.Where(m => string.Equals(m.Instance.Name, instanceName, StringComparison.Ordinal))
                : matches;

            foreach (var m in targets)
            {
                var command = ArrSearchMapping.AutoSearchCommand(item, m.ArrId, m.EpisodeId);
                if (command == null)
                {
                    result.Errors.Add(new ArrErrorDto { InstanceName = m.Instance.Name, Reason = "unsupported item kind" });
                    continue;
                }

                var (id, error) = await _fetch.SendAndMapAsync<int?>(
                    m.Instance, HttpMethod.Post, "/api/v3/command", command.Body,
                    node => ArrSearchMapping.IntN(node?["id"]),
                    emptyResult: null, CommandTimeout, $"{command.Name} command", ct).ConfigureAwait(false);

                if (error != null)
                    result.Errors.Add(new ArrErrorDto { InstanceName = m.Instance.Name, Reason = error });
                else
                    result.Dispatched.Add(new ArrDispatchedDto
                    {
                        InstanceName = m.Instance.Name,
                        CommandId = id ?? 0,
                        CommandName = command.Name,
                    });
            }

            if (result.Dispatched.Count == 0 && matches.Count == 0 && errors.Count == 0)
                result.Errors.Add(new ArrErrorDto { InstanceName = service, Reason = "not tracked in any configured instance" });

            return result;
        }

        // ── interactive search ───────────────────────────────────────────────

        /// <summary>Lists candidate releases from one instance for the manual picker.</summary>
        public async Task<ArrReleaseListDto> ListReleasesAsync(
            ArrResolvedItem item, PluginConfiguration config, string instanceName, CancellationToken ct)
        {
            var service = ServiceOf(item);
            var dto = new ArrReleaseListDto { InstanceName = instanceName, Service = service };

            var instances = EnabledInstances(item, config);
            var (matches, _) = await _targets.ResolveMatchesAsync(item, instances, service, ct).ConfigureAwait(false);
            var match = matches.FirstOrDefault(m => string.Equals(m.Instance.Name, instanceName, StringComparison.Ordinal));
            if (match == null)
            {
                dto.Error = "not tracked in this instance";
                return dto;
            }

            var path = ArrSearchMapping.InteractiveReleasePath(item, match.ArrId, match.EpisodeId);
            if (path == null)
            {
                dto.Error = "interactive search is not supported for this item";
                return dto;
            }

            var (releases, error) = await _fetch.FetchAndMapAsync<List<ArrReleaseDto>>(
                match.Instance, path, MapReleases, emptyResult: new List<ArrReleaseDto>(),
                ReleaseTimeout, "interactive release search", ct).ConfigureAwait(false);

            dto.Releases = releases;
            dto.Error = error;
            return dto;
        }

        private static List<ArrReleaseDto> MapReleases(JsonNode? node)
        {
            var list = new List<ArrReleaseDto>();
            if (node is JsonArray arr)
            {
                foreach (var r in arr)
                {
                    var dto = ArrSearchMapping.MapRelease(r);
                    if (!string.IsNullOrEmpty(dto.Guid)) list.Add(dto);
                }
            }
            return list;
        }

        /// <summary>Grabs a chosen release. <paramref name="service"/> selects the instance pool.</summary>
        public async Task<(bool Ok, string? Error)> GrabAsync(
            PluginConfiguration config, string service, string instanceName, string guid, int indexerId, CancellationToken ct)
        {
            var instance = EnabledInstances(service, config)
                .FirstOrDefault(i => string.Equals(i.Name, instanceName, StringComparison.Ordinal));
            if (instance == null)
                return (false, "instance not found");
            if (string.IsNullOrWhiteSpace(guid) || indexerId <= 0)
                return (false, "invalid release");

            var body = new JsonObject { ["guid"] = guid, ["indexerId"] = indexerId };
            var (_, error) = await _fetch.SendAndMapAsync<bool>(
                instance, HttpMethod.Post, "/api/v3/release", body,
                _ => true, emptyResult: false, MutateTimeout, "grab release", ct).ConfigureAwait(false);
            return (error == null, error);
        }

        // ── monitor toggle ───────────────────────────────────────────────────

        /// <summary>Sets the monitored flag on every tracking instance (or one named instance).</summary>
        public async Task<ArrDispatchResultDto> SetMonitoredAsync(
            ArrResolvedItem item, PluginConfiguration config, bool monitored, string? instanceName, CancellationToken ct)
        {
            var result = new ArrDispatchResultDto();
            var service = ServiceOf(item);
            var instances = EnabledInstances(item, config);
            var (matches, errors) = await _targets.ResolveMatchesAsync(item, instances, service, ct).ConfigureAwait(false);
            result.Errors.AddRange(errors);

            var targets = instanceName != null
                ? matches.Where(m => string.Equals(m.Instance.Name, instanceName, StringComparison.Ordinal))
                : matches;

            foreach (var m in targets)
            {
                var error = await SetMonitoredOnInstanceAsync(item, m, monitored, ct).ConfigureAwait(false);
                if (error != null)
                    result.Errors.Add(new ArrErrorDto { InstanceName = m.Instance.Name, Reason = error });
                else
                    result.Dispatched.Add(new ArrDispatchedDto { InstanceName = m.Instance.Name, CommandName = monitored ? "monitor" : "unmonitor" });
            }
            return result;
        }

        private async Task<string?> SetMonitoredOnInstanceAsync(ArrResolvedItem item, ArrInstanceMatch m, bool monitored, CancellationToken ct)
        {
            switch (item.Kind)
            {
                case ArrMediaKind.Movie:
                {
                    var body = new JsonObject { ["movieIds"] = new JsonArray(m.ArrId), ["monitored"] = monitored };
                    var (_, err) = await _fetch.SendAndMapAsync<bool>(m.Instance, HttpMethod.Put, "/api/v3/movie/editor", body, _ => true, false, MutateTimeout, "monitor movie", ct).ConfigureAwait(false);
                    return err;
                }
                case ArrMediaKind.Series:
                {
                    var body = new JsonObject { ["seriesIds"] = new JsonArray(m.ArrId), ["monitored"] = monitored };
                    var (_, err) = await _fetch.SendAndMapAsync<bool>(m.Instance, HttpMethod.Put, "/api/v3/series/editor", body, _ => true, false, MutateTimeout, "monitor series", ct).ConfigureAwait(false);
                    return err;
                }
                case ArrMediaKind.Episode when m.EpisodeId is int episodeId:
                {
                    var body = new JsonObject { ["episodeIds"] = new JsonArray(episodeId), ["monitored"] = monitored };
                    var (_, err) = await _fetch.SendAndMapAsync<bool>(m.Instance, HttpMethod.Put, "/api/v3/episode/monitor", body, _ => true, false, MutateTimeout, "monitor episode", ct).ConfigureAwait(false);
                    return err;
                }
                case ArrMediaKind.Season:
                    return await SetSeasonMonitoredAsync(item, m, monitored, ct).ConfigureAwait(false);
                default:
                    return "unsupported item kind";
            }
        }

        // Sonarr has no season-level editor: fetch the series, flip the one season's monitored flag,
        // and PUT the whole resource back (the canonical approach the Sonarr UI itself uses).
        private async Task<string?> SetSeasonMonitoredAsync(ArrResolvedItem item, ArrInstanceMatch m, bool monitored, CancellationToken ct)
        {
            var (series, getError) = await _fetch.FetchAndMapAsync<JsonNode?>(
                m.Instance, $"/api/v3/series/{m.ArrId}", n => n, emptyResult: null,
                ArrTargetResolver.LookupTimeout, "series for season monitor", ct).ConfigureAwait(false);
            if (getError != null) return getError;
            if (series is not JsonObject seriesObj || seriesObj["seasons"] is not JsonArray seasons)
                return "series not found";

            var flipped = false;
            foreach (var s in seasons)
            {
                if (ArrSearchMapping.IntN(s?["seasonNumber"]) != item.SeasonNumber) continue;
                if (s is JsonObject seasonObj) { seasonObj["monitored"] = monitored; flipped = true; }
                break;
            }
            if (!flipped) return "season not found";

            // Detach from the response tree before reusing as a request body.
            var body = JsonNode.Parse(seriesObj.ToJsonString());
            var (_, putError) = await _fetch.SendAndMapAsync<bool>(
                m.Instance, HttpMethod.Put, $"/api/v3/series/{m.ArrId}", body, _ => true, false,
                MutateTimeout, "monitor season", ct).ConfigureAwait(false);
            return putError;
        }

        // ── add to arr ───────────────────────────────────────────────────────

        /// <summary>Quality profiles + root folders for the add form.</summary>
        public async Task<ArrAddOptionsDto> GetAddOptionsAsync(PluginConfiguration config, string service, string instanceName, CancellationToken ct)
        {
            var dto = new ArrAddOptionsDto { Service = service, InstanceName = instanceName };
            var instance = EnabledInstances(service, config)
                .FirstOrDefault(i => string.Equals(i.Name, instanceName, StringComparison.Ordinal));
            if (instance == null) { dto.Error = "instance not found"; return dto; }

            var (profiles, profileError) = await _fetch.FetchAndMapAsync<List<ArrNamedIdDto>>(
                instance, "/api/v3/qualityprofile",
                node => (node as JsonArray)?.Select(p => new ArrNamedIdDto { Id = ArrSearchMapping.Int(p?["id"]), Name = ArrSearchMapping.Str(p?["name"]) ?? "" }).ToList() ?? new(),
                new(), ArrTargetResolver.LookupTimeout, "quality profiles", ct).ConfigureAwait(false);

            var (roots, rootError) = await _fetch.FetchAndMapAsync<List<ArrRootFolderDto>>(
                instance, "/api/v3/rootfolder",
                node => (node as JsonArray)?.Select(p => new ArrRootFolderDto { Path = ArrSearchMapping.Str(p?["path"]) ?? "", FreeSpace = ArrSearchMapping.Long(p?["freeSpace"]) }).ToList() ?? new(),
                new(), ArrTargetResolver.LookupTimeout, "root folders", ct).ConfigureAwait(false);

            dto.QualityProfiles = profiles;
            dto.RootFolders = roots;
            dto.Error = profileError ?? rootError;
            if (service == "radarr")
                dto.MinimumAvailabilityOptions = new List<string> { "announced", "inCinemas", "released" };
            return dto;
        }

        /// <summary>Looks the item up in the arr and adds it with the chosen options.</summary>
        public async Task<(bool Ok, string? Error, int? ArrId)> AddAsync(
            ArrResolvedItem item, PluginConfiguration config, ArrAddRequest request, CancellationToken ct)
        {
            if (item.Kind is not (ArrMediaKind.Movie or ArrMediaKind.Series))
                return (false, "only a movie or series can be added", null);
            if (!item.HasArrIdentity)
                return (false, "item has no TVDB/TMDB id", null);
            if (request.QualityProfileId <= 0 || string.IsNullOrWhiteSpace(request.RootFolderPath))
                return (false, "quality profile and root folder are required", null);

            var service = ServiceOf(item);
            var instance = EnabledInstances(service, config)
                .FirstOrDefault(i => string.Equals(i.Name, request.InstanceName, StringComparison.Ordinal));
            if (instance == null)
                return (false, "instance not found", null);

            var lookupPath = service == "radarr"
                ? $"/api/v3/movie/lookup?term=tmdb:{item.TmdbId}"
                : $"/api/v3/series/lookup?term=tvdb:{item.SeriesTvdbId}";

            var (lookup, lookupError) = await _fetch.FetchAndMapAsync<JsonNode?>(
                instance, lookupPath, node => Detach(ArrTargetResolver.First(node)), emptyResult: null,
                ArrTargetResolver.LookupTimeout, "add lookup", ct).ConfigureAwait(false);
            if (lookupError != null) return (false, lookupError, null);
            if (lookup is not JsonObject body) return (false, "item not found in arr lookup", null);

            body["qualityProfileId"] = request.QualityProfileId;
            body["rootFolderPath"] = request.RootFolderPath;
            body["monitored"] = request.Monitored;
            if (service == "radarr")
            {
                body["minimumAvailability"] = request.MinimumAvailability ?? "released";
                body["addOptions"] = new JsonObject
                {
                    ["monitor"] = request.Monitor ?? "movieOnly",
                    ["searchForMovie"] = request.SearchOnAdd,
                };
            }
            else
            {
                body["addOptions"] = new JsonObject
                {
                    ["monitor"] = request.Monitor ?? "all",
                    ["searchForMissingEpisodes"] = request.SearchOnAdd,
                };
            }

            var (addedId, addError) = await _fetch.SendAndMapAsync<int?>(
                instance, HttpMethod.Post, service == "radarr" ? "/api/v3/movie" : "/api/v3/series", body,
                node => ArrSearchMapping.IntN(node?["id"]), emptyResult: null, MutateTimeout, "add item", ct).ConfigureAwait(false);
            return (addError == null, addError, addedId);
        }

        // ── queue status (reuses the Downloads-page data source; no second UI) ─

        /// <summary>Active-download rows for a resolved item, for post-action progress feedback.</summary>
        public async Task<List<ArrQueueRowDto>> GetQueueStatusAsync(ArrResolvedItem item, PluginConfiguration config, CancellationToken ct)
        {
            var rows = new List<ArrQueueRowDto>();
            if (item.Kind == ArrMediaKind.Unknown || !item.HasArrIdentity)
                return rows;

            var service = ServiceOf(item);
            var instances = EnabledInstances(item, config);
            var (matches, _) = await _targets.ResolveMatchesAsync(item, instances, service, ct).ConfigureAwait(false);

            var perInstance = await Task.WhenAll(matches.Select(m => QueueForInstanceAsync(m, service, ct))).ConfigureAwait(false);
            foreach (var list in perInstance) rows.AddRange(list);
            return rows;
        }

        private async Task<List<ArrQueueRowDto>> QueueForInstanceAsync(ArrInstanceMatch m, string service, CancellationToken ct)
        {
            var path = service == "radarr"
                ? $"/api/v3/queue?movieIds={m.ArrId}&pageSize=100"
                : $"/api/v3/queue?includeSeries=false&includeEpisode=false&pageSize=200";

            var (list, _) = await _fetch.FetchAndMapAsync<List<ArrQueueRowDto>>(
                m.Instance, path,
                node =>
                {
                    var result = new List<ArrQueueRowDto>();
                    if (node?["records"] is JsonArray records)
                    {
                        foreach (var rec in records)
                        {
                            // Sonarr's queue isn't reliably server-filterable by series across versions —
                            // filter to this series here so we only report the item the user acted on.
                            if (service == "sonarr" && ArrSearchMapping.IntN(rec?["seriesId"]) != m.ArrId) continue;
                            result.Add(ArrSearchMapping.MapQueueRow(rec, service, m.Instance.Name));
                        }
                    }
                    return result;
                },
                emptyResult: new List<ArrQueueRowDto>(), QueueTimeout, "queue status", ct).ConfigureAwait(false);
            return list;
        }

        private static JsonNode? Detach(JsonNode? node) => node == null ? null : JsonNode.Parse(node.ToJsonString());

        private static string KindString(ArrMediaKind kind) => kind switch
        {
            ArrMediaKind.Movie => "movie",
            ArrMediaKind.Series => "series",
            ArrMediaKind.Season => "season",
            ArrMediaKind.Episode => "episode",
            _ => "unknown",
        };
    }
}
