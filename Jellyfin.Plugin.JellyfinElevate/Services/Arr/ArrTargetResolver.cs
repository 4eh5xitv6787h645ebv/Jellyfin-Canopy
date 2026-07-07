using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinElevate.Helpers.Arr;
using Jellyfin.Plugin.JellyfinElevate.Model.Arr;

namespace Jellyfin.Plugin.JellyfinElevate.Services.Arr
{
    /// <summary>One configured instance that already tracks a resolved item, with its arr internal ids.</summary>
    public sealed class ArrInstanceMatch
    {
        public ArrInstance Instance { get; init; } = null!;
        public string Service { get; init; } = string.Empty;
        /// <summary>Sonarr seriesId / Radarr movieId.</summary>
        public int ArrId { get; init; }
        /// <summary>Sonarr episodeId when the resolved item is a single episode.</summary>
        public int? EpisodeId { get; init; }
        public bool Monitored { get; init; }
        public bool HasFile { get; init; }
    }

    /// <summary>
    /// Fans a resolved item out across the enabled Sonarr/Radarr instances and reports which ones
    /// already track it (plus the ids/monitor/file state the Search + Manage services need). Shared
    /// by <see cref="ArrActionService"/>; all upstream calls go through <see cref="ArrFetchService"/>
    /// (SSRF-guarded, per-request key, standard error taxonomy).
    /// </summary>
    public sealed class ArrTargetResolver
    {
        internal static readonly TimeSpan LookupTimeout = TimeSpan.FromSeconds(10);

        private readonly ArrFetchService _fetch;

        public ArrTargetResolver(ArrFetchService fetch)
        {
            _fetch = fetch;
        }

        /// <summary>
        /// Resolves the matches for <paramref name="item"/> across <paramref name="instances"/>.
        /// Returns present matches plus per-instance errors (an instance that simply doesn't track the
        /// item is neither a match nor an error).
        /// </summary>
        public async Task<(List<ArrInstanceMatch> Matches, List<ArrErrorDto> Errors)> ResolveMatchesAsync(
            ArrResolvedItem item, IReadOnlyList<ArrInstance> instances, string service, CancellationToken ct)
        {
            var results = await Task.WhenAll(instances.Select(i => ResolveOneAsync(item, i, service, ct))).ConfigureAwait(false);

            var matches = new List<ArrInstanceMatch>();
            var errors = new List<ArrErrorDto>();
            foreach (var (match, error, instanceName) in results)
            {
                if (match != null) matches.Add(match);
                if (error != null) errors.Add(new ArrErrorDto { InstanceName = instanceName, Reason = error });
            }
            return (matches, errors);
        }

        private async Task<(ArrInstanceMatch? Match, string? Error, string InstanceName)> ResolveOneAsync(
            ArrResolvedItem item, ArrInstance instance, string service, CancellationToken ct)
        {
            if (service == "radarr")
            {
                var (match, error) = await _fetch.FetchAndMapAsync<ArrInstanceMatch?>(
                    instance,
                    $"/api/v3/movie?tmdbId={item.TmdbId}",
                    node =>
                    {
                        var movie = First(node);
                        if (movie == null) return null;
                        return new ArrInstanceMatch
                        {
                            Instance = instance,
                            Service = "radarr",
                            ArrId = ArrSearchMapping.Int(movie["id"]),
                            Monitored = ArrSearchMapping.Bool(movie["monitored"]),
                            HasFile = ArrSearchMapping.Bool(movie["hasFile"]),
                        };
                    },
                    emptyResult: null,
                    timeout: LookupTimeout,
                    contextLabel: $"Radarr movie (TMDB {item.TmdbId})",
                    ct: ct).ConfigureAwait(false);
                return (match, error, instance.Name);
            }

            // Sonarr: resolve the series first (all TV kinds need it).
            var (series, seriesError) = await _fetch.FetchAndMapAsync<JsonNode?>(
                instance,
                $"/api/v3/series?tvdbId={item.SeriesTvdbId}",
                node => First(node),
                emptyResult: null,
                timeout: LookupTimeout,
                contextLabel: $"Sonarr series (TVDB {item.SeriesTvdbId})",
                ct: ct).ConfigureAwait(false);

            if (seriesError != null) return (null, seriesError, instance.Name);
            if (series is not JsonObject seriesObj) return (null, null, instance.Name);

            var seriesId = ArrSearchMapping.Int(seriesObj["id"]);
            if (seriesId <= 0) return (null, null, instance.Name);

            switch (item.Kind)
            {
                case ArrMediaKind.Series:
                    return (new ArrInstanceMatch
                    {
                        Instance = instance,
                        Service = "sonarr",
                        ArrId = seriesId,
                        Monitored = ArrSearchMapping.Bool(seriesObj["monitored"]),
                        HasFile = ArrSearchMapping.Int(seriesObj["statistics"]?["episodeFileCount"]) > 0,
                    }, null, instance.Name);

                case ArrMediaKind.Season:
                {
                    var (monitored, hasFile) = SeasonState(seriesObj, item.SeasonNumber);
                    return (new ArrInstanceMatch
                    {
                        Instance = instance,
                        Service = "sonarr",
                        ArrId = seriesId,
                        Monitored = monitored,
                        HasFile = hasFile,
                    }, null, instance.Name);
                }

                case ArrMediaKind.Episode:
                {
                    var (epMatch, epError) = await ResolveEpisodeAsync(item, instance, seriesId, ct).ConfigureAwait(false);
                    return (epMatch, epError, instance.Name);
                }

                default:
                    return (null, null, instance.Name);
            }
        }

        private async Task<(ArrInstanceMatch? Match, string? Error)> ResolveEpisodeAsync(
            ArrResolvedItem item, ArrInstance instance, int seriesId, CancellationToken ct)
        {
            return await _fetch.FetchAndMapAsync<ArrInstanceMatch?>(
                instance,
                $"/api/v3/episode?seriesId={seriesId}&seasonNumber={item.SeasonNumber}",
                node =>
                {
                    if (node is not JsonArray episodes) return null;
                    foreach (var ep in episodes)
                    {
                        if (ArrSearchMapping.IntN(ep?["episodeNumber"]) != item.EpisodeNumber) continue;
                        return new ArrInstanceMatch
                        {
                            Instance = instance,
                            Service = "sonarr",
                            ArrId = seriesId,
                            EpisodeId = ArrSearchMapping.IntN(ep?["id"]),
                            Monitored = ArrSearchMapping.Bool(ep?["monitored"]),
                            HasFile = ArrSearchMapping.Bool(ep?["hasFile"]),
                        };
                    }
                    return null;
                },
                emptyResult: null,
                timeout: LookupTimeout,
                contextLabel: $"Sonarr episodes (series {seriesId} s{item.SeasonNumber})",
                ct: ct).ConfigureAwait(false);
        }

        private static (bool Monitored, bool HasFile) SeasonState(JsonObject seriesObj, int? seasonNumber)
        {
            if (seriesObj["seasons"] is JsonArray seasons)
            {
                foreach (var s in seasons)
                {
                    if (ArrSearchMapping.IntN(s?["seasonNumber"]) != seasonNumber) continue;
                    var monitored = ArrSearchMapping.Bool(s?["monitored"]);
                    var hasFile = ArrSearchMapping.Int(s?["statistics"]?["episodeFileCount"]) > 0;
                    return (monitored, hasFile);
                }
            }
            return (false, false);
        }

        /// <summary>First element of an arr array response, or the node itself if it isn't an array.</summary>
        internal static JsonNode? First(JsonNode? node)
        {
            if (node is JsonArray arr)
                return arr.Count > 0 ? arr[0] : null;
            return node;
        }
    }
}
