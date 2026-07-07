using System.Collections.Generic;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinElevate.Configuration;
using Jellyfin.Plugin.JellyfinElevate.Controllers;
using Jellyfin.Plugin.JellyfinElevate.Services.Jellyseerr;
using Jellyfin.Plugin.JellyfinElevate.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.Controllers
{
    /// <summary>
    /// ARR-2: the per-user download-queue filter must match a Sonarr TV download to the caller's
    /// own Seerr request via TVDB when Sonarr reports the series with tmdbId 0 — otherwise the user's
    /// own download is silently hidden. A 0 id is never a valid key on either side.
    /// </summary>
    public class ArrRequestsQueueFilterTests
    {
        private static HashSet<(int TmdbId, string MediaType)> Requests(params (int, string)[] entries)
            => new(entries);

        [Fact]
        public void SonarrTvDownload_TmdbZeroButRequestedViaTvdb_IsAllowed()
        {
            // The ARR-2 case: Sonarr reports tmdbId 0, but the user requested the show and Seerr
            // carried its tvdbId (999). Pre-fix this was dropped (tmdb-only match).
            var allowed = IsAllowed(tmdbId: 0, tvdbId: 999,
                allowedRequests: Requests((100, "tv")),
                allowedTvTvdb: new HashSet<int> { 999 });

            Assert.True(allowed);
        }

        [Fact]
        public void SonarrTvDownload_MatchedByTmdb_StillAllowed()
        {
            var allowed = IsAllowed(tmdbId: 42, tvdbId: null,
                allowedRequests: Requests((42, "tv")),
                allowedTvTvdb: new HashSet<int>());

            Assert.True(allowed);
        }

        [Fact]
        public void SonarrTvDownload_BothIdsZero_IsDropped()
        {
            // 0 is never a key, even if the allow-sets are populated.
            var allowed = IsAllowed(tmdbId: 0, tvdbId: 0,
                allowedRequests: Requests((42, "tv")),
                allowedTvTvdb: new HashSet<int> { 999 });

            Assert.False(allowed);
        }

        [Fact]
        public void SonarrTvDownload_UnfilteredPassthrough_IsAllowed()
        {
            // allowedRequests == null => admin/unfiltered: everything passes.
            var allowed = IsAllowed(tmdbId: 0, tvdbId: 999, allowedRequests: null, allowedTvTvdb: null);

            Assert.True(allowed);
        }

        private static bool IsAllowed(
            int? tmdbId, int? tvdbId,
            HashSet<(int TmdbId, string MediaType)>? allowedRequests,
            HashSet<int>? allowedTvTvdb)
            => ArrRequestsController.IsSonarrQueueItemAllowed(tmdbId, tvdbId, allowedRequests, allowedTvTvdb);

        [Fact]
        public async Task GetRequestsForUser_ExposesTvdbId_AndDropsZero()
        {
            // Exercises the real ParseRequestItem path: a TV request carries tvdbId 999 (exposed) and
            // a second carries tvdbId 0 (normalized to null). GetRequestsForUser depends only on the
            // config + HTTP seams, so the user/parental deps are unused here.
            const string list = @"{ ""results"": [
                { ""type"": ""tv"", ""requestedBy"": { ""id"": 7 }, ""media"": { ""tmdbId"": 555, ""tvdbId"": 999, ""mediaType"": ""tv"" } },
                { ""type"": ""tv"", ""requestedBy"": { ""id"": 7 }, ""media"": { ""tmdbId"": 556, ""tvdbId"": 0, ""mediaType"": ""tv"" } } ] }";

            var handler = new RecordingHttpMessageHandler();
            handler.AddResponse("/api/v1/request", list);
            var factory = new RecordingHttpClientFactory(handler);
            var provider = new FakePluginConfigProvider(new PluginConfiguration
            {
                JellyseerrUrls = "http://seerr:5055",
                JellyseerrApiKey = "key",
            });

            var client = new JellyseerrClient(
                factory,
                NullLogger<JellyseerrClient>.Instance,
                userManager: null!,
                new SeerrCache(provider),
                provider,
                parentalFilter: null!);

            var items = await client.GetRequestsForUser("7");

            Assert.NotNull(items);
            Assert.Equal(999, Assert.Single(items!, i => i.TmdbId == 555).TvdbId);
            Assert.Null(Assert.Single(items!, i => i.TmdbId == 556).TvdbId);
        }
    }
}
