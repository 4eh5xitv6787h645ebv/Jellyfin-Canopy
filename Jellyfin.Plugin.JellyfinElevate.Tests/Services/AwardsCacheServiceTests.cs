using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Jellyfin.Plugin.JellyfinElevate.Model.Awards;
using Jellyfin.Plugin.JellyfinElevate.Services.Awards;
using Jellyfin.Plugin.JellyfinElevate.Tests.TestDoubles;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.Services
{
    /// <summary>
    /// Covers the awards index: grouping/dedup/sort on rebuild, IMDb and TMDb (movie vs tv)
    /// lookup, person-id rejection, the atomic version bump, and the disk round-trip. These
    /// are the stateful, bug-prone parts — the lookup path is what every detail-page view hits.
    /// </summary>
    public sealed class AwardsCacheServiceTests : IDisposable
    {
        private readonly string _dir;

        public AwardsCacheServiceTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "je-awards-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_dir);
        }

        public void Dispose()
        {
            try { Directory.Delete(_dir, recursive: true); } catch { /* best-effort */ }
        }

        private AwardsCacheService NewService() =>
            new(new StubAppPaths(_dir), NullLogger<AwardsCacheService>.Instance);

        private static Movie Movie(string? imdb = null, string? tmdb = null)
        {
            var m = new Movie { Id = Guid.NewGuid() };
            if (imdb != null) m.ProviderIds["Imdb"] = imdb;
            if (tmdb != null) m.ProviderIds["Tmdb"] = tmdb;
            return m;
        }

        private static Series Series(string? imdb = null, string? tmdb = null)
        {
            var s = new Series { Id = Guid.NewGuid() };
            if (imdb != null) s.ProviderIds["Imdb"] = imdb;
            if (tmdb != null) s.ProviderIds["Tmdb"] = tmdb;
            return s;
        }

        private static AwardRow Row(string ceremony, string category, bool won, int? year, string? imdb = null, string? tmdb = null, string media = "movie") =>
            new() { Ceremony = ceremony, Category = category, Won = won, Year = year, ImdbId = imdb, TmdbId = tmdb, MediaType = media };

        [Fact]
        public void NewService_IsEmpty_AndVersionZero()
        {
            var svc = NewService();
            Assert.True(svc.IsEmpty);
            Assert.Equal(0, svc.Version);
            Assert.Empty(svc.LookupForItem(Movie(imdb: "tt1")));
        }

        [Fact]
        public void ReplaceFrom_ImdbLookup_ReturnsEntry_AndBumpsVersion()
        {
            var svc = NewService();
            svc.ReplaceFrom(new[] { Row("Academy Awards", "Academy Award for Best Picture", true, 2024, imdb: "tt6710474") });

            Assert.False(svc.IsEmpty);
            Assert.Equal(1, svc.Version);

            var awards = svc.LookupForItem(Movie(imdb: "tt6710474"));
            var award = Assert.Single(awards);
            Assert.Equal("Academy Awards", award.Ceremony);
            Assert.Equal("Academy Award for Best Picture", award.Category);
            Assert.True(award.Won);
            Assert.Equal(2024, award.Year);

            // An empty row set never clears an existing index (a fetch that returns nothing is
            // treated as "keep what we have", never "wipe it").
            svc.ReplaceFrom(Array.Empty<AwardRow>());
            Assert.Equal(1, svc.Version);
            Assert.Single(svc.LookupForItem(Movie(imdb: "tt6710474")));
        }

        [Fact]
        public void TmdbLookup_SeparatesMovieAndTvNamespaces()
        {
            var svc = NewService();
            svc.ReplaceFrom(new[]
            {
                Row("Academy Awards", "Best Picture", true, 2020, tmdb: "100", media: "movie"),
                Row("Primetime Emmy Awards", "Outstanding Drama Series", true, 2020, tmdb: "100", media: "tv"),
            });

            // A movie with TMDb 100 sees only the movie-namespaced award, never the tv one.
            var movieAwards = svc.LookupForItem(Movie(tmdb: "100"));
            Assert.Single(movieAwards);
            Assert.Equal("Academy Awards", movieAwards[0].Ceremony);

            // A series with TMDb 100 sees only the tv-namespaced award.
            var seriesAwards = svc.LookupForItem(Series(tmdb: "100"));
            Assert.Single(seriesAwards);
            Assert.Equal("Primetime Emmy Awards", seriesAwards[0].Ceremony);
        }

        [Fact]
        public void Lookup_MergesImdbAndTmdb_AndDeduplicates()
        {
            var svc = NewService();
            // Same award reachable by both ids, plus an exact duplicate row — one entry survives.
            svc.ReplaceFrom(new[]
            {
                Row("Academy Awards", "Best Picture", true, 2024, imdb: "tt1", tmdb: "50", media: "movie"),
                Row("Academy Awards", "Best Picture", true, 2024, imdb: "tt1", tmdb: "50", media: "movie"),
                Row("BAFTA Awards", "Best Film", true, 2024, tmdb: "50", media: "movie"),
            });

            var awards = svc.LookupForItem(Movie(imdb: "tt1", tmdb: "50"));
            Assert.Equal(2, awards.Count);
            Assert.Contains(awards, a => a.Ceremony == "Academy Awards");
            Assert.Contains(awards, a => a.Ceremony == "BAFTA Awards");
        }

        [Fact]
        public void Sort_NewestYearFirst_WinsBeforeNominations()
        {
            var svc = NewService();
            svc.ReplaceFrom(new[]
            {
                Row("Academy Awards", "Old Nomination", false, 2000, imdb: "tt1"),
                Row("Academy Awards", "Recent Nomination", false, 2024, imdb: "tt1"),
                Row("Academy Awards", "Recent Win", true, 2024, imdb: "tt1"),
            });

            var awards = svc.LookupForItem(Movie(imdb: "tt1"));
            Assert.Equal(3, awards.Count);
            // 2024 win first, then 2024 nomination, then the 2000 nomination.
            Assert.Equal("Recent Win", awards[0].Category);
            Assert.True(awards[0].Won);
            Assert.Equal("Recent Nomination", awards[1].Category);
            Assert.Equal(2000, awards[2].Year);
        }

        [Fact]
        public void Lookup_NonMovieOrSeriesItem_ReturnsEmpty_EvenOnTmdbCollision()
        {
            var svc = NewService();
            svc.ReplaceFrom(new[] { Row("Academy Awards", "Best Picture", true, 2024, tmdb: "100", media: "movie") });

            // An Episode whose TMDb id numerically collides with the awarded movie's must not
            // surface that movie's awards — awards are Movie/Series only.
            var ep = new Episode { Id = Guid.NewGuid() };
            ep.ProviderIds["Tmdb"] = "100";
            Assert.Empty(svc.LookupForItem(ep));

            // The real movie still resolves.
            Assert.Single(svc.LookupForItem(Movie(tmdb: "100")));
        }

        [Fact]
        public void PersonId_IsNotIndexed()
        {
            var svc = NewService();
            // A person award row (nm…) with no TMDb id must not be stored or matchable.
            svc.ReplaceFrom(new[] { Row("Academy Awards", "Best Actor", true, 2024, imdb: "nm123") });

            Assert.Equal(0, svc.TitleCount);
            Assert.Empty(svc.LookupForItem(Movie(imdb: "nm123")));
        }

        [Fact]
        public void BlankCeremonyOrCategory_IsSkipped()
        {
            var svc = NewService();
            svc.ReplaceFrom(new[]
            {
                Row("", "Best Picture", true, 2024, imdb: "tt1"),
                Row("Academy Awards", "", true, 2024, imdb: "tt1"),
                Row("Academy Awards", "Best Picture", true, 2024, imdb: "tt1"),
            });

            var awards = svc.LookupForItem(Movie(imdb: "tt1"));
            Assert.Single(awards);
        }

        [Fact]
        public void DiskRoundTrip_RestoresIndexAndVersion()
        {
            var first = NewService();
            first.ReplaceFrom(new[]
            {
                Row("Academy Awards", "Best Picture", true, 2024, imdb: "tt1"),
                Row("Cannes Film Festival", "Palme d'Or", true, 2019, tmdb: "77", media: "movie"),
            });
            var versionBefore = first.Version;

            // A fresh instance (as on server restart) loads the same data from disk.
            var reloaded = NewService();
            reloaded.LoadFromDisk();

            Assert.False(reloaded.IsEmpty);
            Assert.Equal(versionBefore, reloaded.Version);
            Assert.Single(reloaded.LookupForItem(Movie(imdb: "tt1")));
            Assert.Equal("Palme d'Or", reloaded.LookupForItem(Movie(tmdb: "77")).Single().Category);
        }

        [Fact]
        public void GetAwardsView_ReturnsConsistentSnapshot()
        {
            var svc = NewService();

            // Before any build: empty + version 0 + no awards, all from one snapshot.
            var before = svc.GetAwardsView(Movie(imdb: "tt1"));
            Assert.True(before.IsEmpty);
            Assert.Equal(0, before.Version);
            Assert.Empty(before.Awards);

            svc.ReplaceFrom(new[] { Row("Academy Awards", "Best Picture", true, 2024, imdb: "tt1") });

            var after = svc.GetAwardsView(Movie(imdb: "tt1"));
            Assert.False(after.IsEmpty);
            Assert.Equal(1, after.Version);
            Assert.Single(after.Awards);
        }

        [Fact]
        public void TryReplaceFrom_Complete_Publishes()
        {
            var svc = NewService();
            Assert.True(svc.TryReplaceFrom(new[] { Row("Academy Awards", "Best Picture", true, 2024, imdb: "tt1") }, complete: true));
            Assert.Single(svc.LookupForItem(Movie(imdb: "tt1")));
        }

        [Fact]
        public void TryReplaceFrom_PartialOverExistingIndex_IsRejected()
        {
            var svc = NewService();
            svc.TryReplaceFrom(new[] { Row("Academy Awards", "Best Picture", true, 2024, imdb: "tt1") }, complete: true);
            var versionBefore = svc.Version;

            // Partial run with different data must NOT replace the complete index.
            Assert.False(svc.TryReplaceFrom(new[] { Row("BAFTA Awards", "Best Film", true, 2024, imdb: "tt2") }, complete: false));
            Assert.Single(svc.LookupForItem(Movie(imdb: "tt1"))); // old award survives
            Assert.Empty(svc.LookupForItem(Movie(imdb: "tt2")));
            Assert.Equal(versionBefore, svc.Version);
        }

        [Fact]
        public void TryReplaceFrom_PartialOnFirstInstall_Publishes()
        {
            var svc = NewService(); // empty
            Assert.True(svc.TryReplaceFrom(new[] { Row("Academy Awards", "Best Picture", true, 2024, imdb: "tt1") }, complete: false));
            Assert.Single(svc.LookupForItem(Movie(imdb: "tt1")));
        }

        [Fact]
        public void TryReplaceFrom_CompleteEmpty_OnFirstInstall_MarksBuiltNotStuck()
        {
            var svc = NewService();
            // A complete build that legitimately yields no awards must mark the index BUILT (not
            // "never built"), so the client stops treating it as not-ready.
            Assert.True(svc.TryReplaceFrom(Array.Empty<AwardRow>(), complete: true, svc.NextRefreshGeneration()));
            Assert.False(svc.IsEmpty);
            Assert.Equal(1, svc.Version);
            Assert.False(svc.GetAwardsView(Movie(imdb: "tt1")).IsEmpty);
        }

        [Fact]
        public void TryReplaceFrom_PartialEmpty_OnFirstInstall_DoesNotPublish()
        {
            var svc = NewService();
            // A partial fetch that produced nothing is not a built index — stay empty and wait.
            Assert.False(svc.TryReplaceFrom(Array.Empty<AwardRow>(), complete: false, svc.NextRefreshGeneration()));
            Assert.True(svc.IsEmpty);
        }

        [Fact]
        public void TryReplaceFrom_EmptyRows_DoesNotPublish()
        {
            var svc = NewService();
            svc.TryReplaceFrom(new[] { Row("Academy Awards", "Best Picture", true, 2024, imdb: "tt1") }, complete: true);
            var versionBefore = svc.Version;

            Assert.False(svc.TryReplaceFrom(Array.Empty<AwardRow>(), complete: true));
            Assert.Equal(versionBefore, svc.Version); // unchanged — empty never clears
        }

        [Fact]
        public void TryReplaceFrom_StaleGeneration_IsRejected()
        {
            var svc = NewService();
            var genEarly = svc.NextRefreshGeneration(); // an earlier-started refresh
            var genLate = svc.NextRefreshGeneration();  // a later-started refresh

            // The later-started refresh completes and publishes first.
            Assert.True(svc.TryReplaceFrom(new[] { Row("Academy Awards", "Newer", true, 2024, imdb: "tt-new") }, complete: true, genLate));
            // The earlier-started refresh finishes afterwards — its stale generation is rejected.
            Assert.False(svc.TryReplaceFrom(new[] { Row("Academy Awards", "Older", true, 2024, imdb: "tt-old") }, complete: true, genEarly));

            Assert.Single(svc.LookupForItem(Movie(imdb: "tt-new")));
            Assert.Empty(svc.LookupForItem(Movie(imdb: "tt-old")));
        }

        [Fact]
        public void LoadFromDisk_DoesNotDowngradeNewerInMemoryIndex()
        {
            var svc = NewService();
            // Drive the in-memory index to v2 with a distinctive award.
            svc.ReplaceFrom(new[] { Row("Academy Awards", "First", true, 2024, imdb: "tt-new") });
            svc.ReplaceFrom(new[] { Row("Academy Awards", "Second", true, 2024, imdb: "tt-new") });
            Assert.Equal(2, svc.Version);

            // Simulate an OLDER snapshot on disk (v1) with different data — as if LoadFromDisk read
            // it before a concurrent rebuild published v2. Property names match the on-disk format.
            var path = Path.Combine(_dir, "configurations", "Jellyfin.Plugin.JellyfinElevate", "awards-cache.json");
            File.WriteAllText(
                path,
                "{\"SchemaVersion\":1,\"Version\":1,\"LastModified\":0,\"BuiltAtUtc\":null,"
                + "\"ByImdb\":{\"tt-old\":[{\"ceremony\":\"Old\",\"category\":\"Old\",\"year\":2000,\"won\":true}]},"
                + "\"ByTmdb\":{}}");

            svc.LoadFromDisk();

            // The newer in-memory index wins; the stale disk read is discarded.
            Assert.Equal(2, svc.Version);
            Assert.Empty(svc.LookupForItem(Movie(imdb: "tt-old")));
            Assert.Single(svc.LookupForItem(Movie(imdb: "tt-new")));
        }

        [Fact]
        public void MissingYear_IsPreservedAsNull_AndSortsLast()
        {
            var svc = NewService();
            svc.ReplaceFrom(new[]
            {
                Row("Academy Awards", "No Year", true, null, imdb: "tt1"),
                Row("Academy Awards", "Has Year", true, 2010, imdb: "tt1"),
            });

            var awards = svc.LookupForItem(Movie(imdb: "tt1"));
            Assert.Equal("Has Year", awards[0].Category);
            Assert.Null(awards[1].Year);
        }
    }
}
