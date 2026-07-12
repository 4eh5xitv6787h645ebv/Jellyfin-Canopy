using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinElevate.Configuration;
using Jellyfin.Plugin.JellyfinElevate.Model;
using Jellyfin.Plugin.JellyfinElevate.Services;
using Jellyfin.Plugin.JellyfinElevate.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.Services
{
    /// <summary>
    /// Pins the Spoiler Guard per-user tag-cache strip (F3): the pure gating
    /// decision, the clone-not-mutate contract on the shared cache, and the
    /// schema-version discard-on-mismatch. The runtime facts the controller reads
    /// from the live library (played-state, season index / any-watched) are the
    /// resolver's injected delegates, so these run with no live library manager.
    /// </summary>
    public sealed class TagCacheSpoilerStripTests
    {
        private static readonly Func<Guid, bool> NeverInScope = _ => false;
        private static readonly Func<Guid, bool> NeverPlayed = _ => false;
        private static readonly Func<Guid, int?> NotASeason = _ => null;
        private static readonly Action<string> IgnoreKey = _ => { };

        private static UserSpoilerBlur StateWithSeries(string seriesIdN)
        {
            var st = new UserSpoilerBlur();
            st.Series[seriesIdN] = new SpoilerBlurSeriesEntry { SeriesId = seriesIdN };
            return st;
        }

        // ── ApplyTagStrip: clone, never mutate the shared entry ──────────────────

        [Fact]
        public void ApplyTagStrip_FullStrip_ClonesAndLeavesSharedEntryUntouched()
        {
            var seriesN = Guid.NewGuid().ToString("N");
            var original = new TagCacheEntry
            {
                Type = "Episode",
                SeriesId = seriesN,
                Genres = new[] { "Spoiler-Tag" },
                CommunityRating = 9.9f,
                CriticRating = 88f,
                AudioLanguages = new[] { "eng" },
                StreamData = new TagStreamData { ItemName = "The Death of X" },
            };

            var served = TagCacheService.ApplyTagStrip(
                original, TagCacheService.TagStripDecision.Strip,
                stripGenres: true, stripRatings: true, sanitizeTitleStreams: false);

            Assert.NotSame(original, served);

            // Shared cache entry must be byte-for-byte untouched.
            Assert.Equal(new[] { "Spoiler-Tag" }, original.Genres);
            Assert.Equal(9.9f, original.CommunityRating);
            Assert.Equal(88f, original.CriticRating);
            Assert.Equal(new[] { "eng" }, original.AudioLanguages);
            Assert.NotNull(original.StreamData);
            Assert.Equal(seriesN, original.SeriesId);

            // Served clone is stripped.
            Assert.Empty(served.Genres!);
            Assert.Null(served.CommunityRating);
            Assert.Null(served.CriticRating);
            Assert.Null(served.AudioLanguages);
            Assert.Null(served.StreamData);
            // SeriesId is metadata the cache keeps (rating fallback is suppressed by
            // nulling the rating itself, not the id).
            Assert.Equal(seriesN, served.SeriesId);
        }

        [Fact]
        public void ApplyTagStrip_SeasonRatingOnly_StripsRatingKeepsGenres()
        {
            var e = new TagCacheEntry { Type = "Season", Genres = new[] { "Drama" }, CommunityRating = 8f, CriticRating = 70f };

            var served = TagCacheService.ApplyTagStrip(
                e, TagCacheService.TagStripDecision.SeasonRatingOnly,
                stripGenres: true, stripRatings: true, sanitizeTitleStreams: false);

            Assert.NotSame(e, served);
            Assert.Null(served.CommunityRating);
            Assert.Null(served.CriticRating);
            Assert.Equal(new[] { "Drama" }, served.Genres); // exempt season keeps its tags
            // original untouched
            Assert.Equal(8f, e.CommunityRating);
        }

        [Fact]
        public void ApplyTagStrip_SeasonRatingOnly_NoRating_ReturnsSharedInstance()
        {
            var e = new TagCacheEntry { Type = "Season", Genres = new[] { "Drama" } };

            var served = TagCacheService.ApplyTagStrip(
                e, TagCacheService.TagStripDecision.SeasonRatingOnly,
                stripGenres: true, stripRatings: true, sanitizeTitleStreams: false);

            // Nothing to strip → no needless clone.
            Assert.Same(e, served);
        }

        [Fact]
        public void ApplyTagStrip_TitleSanitize_ClonesStreamDataNullsTitleFieldsKeepsQuality()
        {
            var e = new TagCacheEntry
            {
                Type = "Movie",
                StreamData = new TagStreamData
                {
                    ItemName = "The Death of X",
                    ItemPath = "S05E14 - The Death of X.mkv",
                    Streams = new List<TagMediaStream> { new() { DisplayTitle = "The Death of X", Codec = "hevc", Height = 1080 } },
                    Sources = new List<TagMediaSource> { new() { Path = "leaky.mkv", Name = "leaky" } },
                },
            };

            var served = TagCacheService.ApplyTagStrip(
                e, TagCacheService.TagStripDecision.Strip,
                stripGenres: false, stripRatings: false, sanitizeTitleStreams: true);

            Assert.NotSame(e.StreamData, served.StreamData);
            Assert.Null(served.StreamData!.ItemName);
            Assert.Null(served.StreamData.ItemPath);
            Assert.Null(served.StreamData.Streams![0].DisplayTitle);
            Assert.Equal("hevc", served.StreamData.Streams[0].Codec); // quality-bearing fields survive
            Assert.Equal(1080, served.StreamData.Streams[0].Height);
            Assert.Null(served.StreamData.Sources![0].Path);
            Assert.Null(served.StreamData.Sources[0].Name);

            // Shared StreamData untouched.
            Assert.Equal("The Death of X", e.StreamData!.ItemName);
            Assert.Equal("The Death of X", e.StreamData.Streams![0].DisplayTitle);
        }

        // ── StripCacheForUser: replaces the served key, not the shared entry ─────

        [Fact]
        public void StripCacheForUser_ReplacesGuardedEntryWithCloneLeavingSharedInstanceIntact()
        {
            var seriesN = Guid.NewGuid().ToString("N");
            var key = Guid.NewGuid().ToString("N");
            var shared = new TagCacheEntry { Type = "Episode", SeriesId = seriesN, Genres = new[] { "Spoiler" }, CommunityRating = 9.9f };
            var items = new Dictionary<string, TagCacheEntry> { [key] = shared };

            TagCacheService.StripCacheForUser(
                items, stripGenres: true, stripRatings: true, sanitizeTitleStreams: false,
                resolve: (_, _) => TagCacheService.TagStripDecision.Strip);

            Assert.NotSame(shared, items[key]);
            // shared instance (still referenced elsewhere by the live cache) untouched
            Assert.Equal(new[] { "Spoiler" }, shared.Genres);
            Assert.Equal(9.9f, shared.CommunityRating);
            Assert.Equal(seriesN, shared.SeriesId);
            // served copy stripped
            Assert.Empty(items[key].Genres!);
            Assert.Null(items[key].CommunityRating);
        }

        [Fact]
        public void StripCacheForUser_KeepDecision_LeavesEntryReferenceUnchanged()
        {
            var key = Guid.NewGuid().ToString("N");
            var shared = new TagCacheEntry { Type = "Episode", Genres = new[] { "X" } };
            var items = new Dictionary<string, TagCacheEntry> { [key] = shared };

            TagCacheService.StripCacheForUser(
                items, stripGenres: true, stripRatings: true, sanitizeTitleStreams: false,
                resolve: (_, _) => TagCacheService.TagStripDecision.Keep);

            Assert.Same(shared, items[key]);
        }

        // ── ResolveTagStripDecision: scope + watched gating ──────────────────────

        [Fact]
        public void Resolve_GuardedUnwatchedEpisode_Strips()
        {
            var seriesN = Guid.NewGuid().ToString("N");
            var entry = new TagCacheEntry { Type = "Episode", SeriesId = seriesN };
            var d = TagCacheService.ResolveTagStripDecision(
                Guid.NewGuid().ToString("N"), entry, StateWithSeries(seriesN),
                NeverInScope, NeverPlayed, NotASeason, NeverPlayed, IgnoreKey);
            Assert.Equal(TagCacheService.TagStripDecision.Strip, d);
        }

        [Fact]
        public void Resolve_FailClosed_StripsEveryRecognizedEntry_RegardlessOfScopeOrWatched()
        {
            // BI-SEC-010 FINAL-F1: a cold-start policy fault (FailClosed sentinel with
            // empty dicts) must strip every recognized entry rather than fail open.
            var failClosed = new UserSpoilerBlur { FailClosed = true };
            foreach (var type in new[] { "Episode", "Season", "Movie", "Series" })
            {
                var entry = new TagCacheEntry { Type = type, SeriesId = Guid.NewGuid().ToString("N") };
                var d = TagCacheService.ResolveTagStripDecision(
                    Guid.NewGuid().ToString("N"), entry, failClosed,
                    // Out of scope, never played, not-a-season — the OLD behavior Keeps.
                    NeverInScope, NeverPlayed, NotASeason, NeverPlayed, IgnoreKey);
                Assert.Equal(TagCacheService.TagStripDecision.Strip, d);
            }
            // A non-media entry is still Keep even under fail-closed.
            var boxset = new TagCacheEntry { Type = "BoxSet" };
            Assert.Equal(
                TagCacheService.TagStripDecision.Keep,
                TagCacheService.ResolveTagStripDecision(
                    Guid.NewGuid().ToString("N"), boxset, failClosed,
                    NeverInScope, NeverPlayed, NotASeason, NeverPlayed, IgnoreKey));
        }

        [Fact]
        public void Resolve_WatchedEpisode_Keeps()
        {
            var seriesN = Guid.NewGuid().ToString("N");
            var entry = new TagCacheEntry { Type = "Episode", SeriesId = seriesN };
            var d = TagCacheService.ResolveTagStripDecision(
                Guid.NewGuid().ToString("N"), entry, StateWithSeries(seriesN),
                NeverInScope, isPlayed: _ => true, NotASeason, NeverPlayed, IgnoreKey);
            Assert.Equal(TagCacheService.TagStripDecision.Keep, d);
        }

        [Fact]
        public void Resolve_OutOfScopeEpisode_Keeps()
        {
            var entry = new TagCacheEntry { Type = "Episode", SeriesId = Guid.NewGuid().ToString("N") };
            // spoiler list holds a DIFFERENT series
            var d = TagCacheService.ResolveTagStripDecision(
                Guid.NewGuid().ToString("N"), entry, StateWithSeries(Guid.NewGuid().ToString("N")),
                NeverInScope, NeverPlayed, NotASeason, NeverPlayed, IgnoreKey);
            Assert.Equal(TagCacheService.TagStripDecision.Keep, d);
        }

        [Fact]
        public void Resolve_EpisodeWithNoSeriesId_Keeps()
        {
            var entry = new TagCacheEntry { Type = "Episode", SeriesId = null };
            var d = TagCacheService.ResolveTagStripDecision(
                Guid.NewGuid().ToString("N"), entry, StateWithSeries(Guid.NewGuid().ToString("N")),
                NeverInScope, NeverPlayed, NotASeason, NeverPlayed, IgnoreKey);
            Assert.Equal(TagCacheService.TagStripDecision.Keep, d);
        }

        [Fact]
        public void Resolve_MovieInScopeUnwatched_Strips()
        {
            var entry = new TagCacheEntry { Type = "Movie" };
            var d = TagCacheService.ResolveTagStripDecision(
                Guid.NewGuid().ToString("N"), entry, new UserSpoilerBlur(),
                isMovieInScope: _ => true, NeverPlayed, NotASeason, NeverPlayed, IgnoreKey);
            Assert.Equal(TagCacheService.TagStripDecision.Strip, d);
        }

        [Fact]
        public void Resolve_MovieInScopeWatched_Keeps()
        {
            var entry = new TagCacheEntry { Type = "Movie" };
            var d = TagCacheService.ResolveTagStripDecision(
                Guid.NewGuid().ToString("N"), entry, new UserSpoilerBlur(),
                isMovieInScope: _ => true, isPlayed: _ => true, NotASeason, NeverPlayed, IgnoreKey);
            Assert.Equal(TagCacheService.TagStripDecision.Keep, d);
        }

        [Fact]
        public void Resolve_MovieOutOfScope_Keeps()
        {
            var entry = new TagCacheEntry { Type = "Movie" };
            var d = TagCacheService.ResolveTagStripDecision(
                Guid.NewGuid().ToString("N"), entry, new UserSpoilerBlur(),
                isMovieInScope: _ => false, NeverPlayed, NotASeason, NeverPlayed, IgnoreKey);
            Assert.Equal(TagCacheService.TagStripDecision.Keep, d);
        }

        [Fact]
        public void Resolve_GuardedSeasonOne_ExemptRatingOnly()
        {
            var seriesN = Guid.NewGuid().ToString("N");
            var entry = new TagCacheEntry { Type = "Season", SeriesId = seriesN };
            var d = TagCacheService.ResolveTagStripDecision(
                Guid.NewGuid().ToString("N"), entry, StateWithSeries(seriesN),
                NeverInScope, NeverPlayed, seasonIndexNumber: _ => 1, seasonAnyWatched: _ => false, IgnoreKey);
            Assert.Equal(TagCacheService.TagStripDecision.SeasonRatingOnly, d);
        }

        [Fact]
        public void Resolve_GuardedSeasonTwoUnwatched_Strips()
        {
            var seriesN = Guid.NewGuid().ToString("N");
            var entry = new TagCacheEntry { Type = "Season", SeriesId = seriesN };
            var d = TagCacheService.ResolveTagStripDecision(
                Guid.NewGuid().ToString("N"), entry, StateWithSeries(seriesN),
                NeverInScope, NeverPlayed, seasonIndexNumber: _ => 2, seasonAnyWatched: _ => false, IgnoreKey);
            Assert.Equal(TagCacheService.TagStripDecision.Strip, d);
        }

        [Fact]
        public void Resolve_GuardedSeasonTwoAnyWatched_ExemptRatingOnly()
        {
            var seriesN = Guid.NewGuid().ToString("N");
            var entry = new TagCacheEntry { Type = "Season", SeriesId = seriesN };
            var d = TagCacheService.ResolveTagStripDecision(
                Guid.NewGuid().ToString("N"), entry, StateWithSeries(seriesN),
                NeverInScope, NeverPlayed, seasonIndexNumber: _ => 2, seasonAnyWatched: _ => true, IgnoreKey);
            Assert.Equal(TagCacheService.TagStripDecision.SeasonRatingOnly, d);
        }

        [Fact]
        public void Resolve_UntaggableType_Keeps()
        {
            var entry = new TagCacheEntry { Type = "BoxSet" };
            var d = TagCacheService.ResolveTagStripDecision(
                Guid.NewGuid().ToString("N"), entry, new UserSpoilerBlur(),
                isMovieInScope: _ => true, NeverPlayed, NotASeason, NeverPlayed, IgnoreKey);
            Assert.Equal(TagCacheService.TagStripDecision.Keep, d);
        }

        [Fact]
        public void Resolve_NonGuidKey_InvokesCallbackAndStrips()
        {
            var seriesN = Guid.NewGuid().ToString("N");
            var entry = new TagCacheEntry { Type = "Episode", SeriesId = seriesN };
            var flagged = new List<string>();
            var d = TagCacheService.ResolveTagStripDecision(
                "not-a-guid", entry, StateWithSeries(seriesN),
                NeverInScope, NeverPlayed, NotASeason, NeverPlayed, onKeyNotGuid: flagged.Add);
            Assert.Equal(TagCacheService.TagStripDecision.Strip, d);
            Assert.Equal(new[] { "not-a-guid" }, flagged);
        }

        // ── LoadFromDisk: schema-version discard-on-mismatch ─────────────────────

        private static TagCacheService NewServiceAt(string dir) =>
            new(null!, new StubAppPaths(dir), NullLogger<TagCacheService>.Instance);

        private static string WriteCache(string dir, int schemaVersion, string entryKey, TagCacheEntry entry)
        {
            var cacheDir = Path.Combine(dir, "configurations", "Jellyfin.Plugin.JellyfinElevate");
            Directory.CreateDirectory(cacheDir);
            var path = Path.Combine(cacheDir, "tag-cache.json");
            // Shape matches the private TagCacheDiskFormat (PascalCase, STJ default).
            var doc = new
            {
                SchemaVersion = schemaVersion,
                Version = 7L,
                LastModified = 123L,
                Items = new Dictionary<string, TagCacheEntry> { [entryKey] = entry },
            };
            File.WriteAllText(path, JsonSerializer.Serialize(doc));
            return path;
        }

        [Fact]
        public void LoadFromDisk_OldSchema_DiscardsEntries()
        {
            var dir = Path.Combine(Path.GetTempPath(), "je-tagcache-" + Guid.NewGuid().ToString("N"));
            try
            {
                var key = Guid.NewGuid().ToString("N");
                WriteCache(dir, schemaVersion: 1, key, new TagCacheEntry { Type = "Episode", SeriesId = null });

                using var svc = NewServiceAt(dir);
                svc.LoadFromDisk();

                // v1 cache lacks SeriesId → discarded, so the strip can't be defeated by stale data.
                Assert.Equal(0, svc.Count);
            }
            finally
            {
                Directory.Delete(dir, recursive: true);
            }
        }

        [Fact]
        public void LoadFromDisk_CurrentSchema_LoadsEntries()
        {
            var dir = Path.Combine(Path.GetTempPath(), "je-tagcache-" + Guid.NewGuid().ToString("N"));
            try
            {
                var key = Guid.NewGuid().ToString("N");
                var seriesN = Guid.NewGuid().ToString("N");
                WriteCache(dir, schemaVersion: 2, key, new TagCacheEntry { Type = "Episode", SeriesId = seriesN });

                using var svc = NewServiceAt(dir);
                svc.LoadFromDisk();

                Assert.Equal(1, svc.Count);
                Assert.True(svc.ContainsKeyForTest(key));
            }
            finally
            {
                Directory.Delete(dir, recursive: true);
            }
        }
    }
}
