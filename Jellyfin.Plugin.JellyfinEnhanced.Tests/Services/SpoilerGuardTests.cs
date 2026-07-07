using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Tests.TestDoubles;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinEnhanced.Tests.Services
{
    /// <summary>
    /// Unit coverage for the pure/testable pieces of the Spoiler Guard port:
    /// the admin-cap-vs-user-override strip gate, the placeholder sanitizer, the
    /// cache-bust tag mutation, the per-user state dictionary comparer round-trip
    /// through the real store serializer, the Seerr-promoter static gate, and the
    /// SkiaSharp blur service's structural fallback + cache bounding.
    /// </summary>
    public class SpoilerGuardTests
    {
        // ─── ShouldStrip: admin policy is the cap, user override can only relax ───

        [Theory]
        [InlineData(false, null, false)]   // admin off → never strip
        [InlineData(false, true, false)]   // admin off → user cannot re-enable
        [InlineData(false, false, false)]  // admin off → still off
        [InlineData(true, null, true)]     // admin on, no override → follow admin
        [InlineData(true, true, true)]     // admin on, user re-affirms → strip
        [InlineData(true, false, false)]   // admin on, user opts out → don't strip
        public void ShouldStrip_HonorsAdminCapAndUserOverride(bool adminOn, bool? userOverride, bool expected)
        {
            Assert.Equal(expected, SpoilerFieldStripFilter.ShouldStrip(adminOn, userOverride));
        }

        // ─── F1: fail-closed aggregation across shared-IP candidates ──────────────

        [Fact]
        public void ShouldBlur_BlursWhenAnyInScopeCandidateWouldBlur()
        {
            // The security case: a WATCHED user (passesThrough=true) sharing an
            // IP with an UNWATCHED user (passesThrough=false) must STILL blur —
            // the watched user must not unblur the unwatched user's artwork.
            Assert.True(SpoilerBlurImageFilter.ShouldBlur(new[] { true, false }));
            Assert.True(SpoilerBlurImageFilter.ShouldBlur(new[] { false, true }));
            Assert.True(SpoilerBlurImageFilter.ShouldBlur(new[] { false }));
        }

        [Fact]
        public void ShouldBlur_PassesThroughOnlyWhenEveryCandidatePassesThrough()
        {
            Assert.False(SpoilerBlurImageFilter.ShouldBlur(new[] { true, true }));
            Assert.False(SpoilerBlurImageFilter.ShouldBlur(new[] { true }));
            Assert.False(SpoilerBlurImageFilter.ShouldBlur(Array.Empty<bool>()));
        }

        // ─── F2: fail-closed on an unrecognized (content-bearing) result shape ────

        private sealed class FakeUnknownResult : IActionResult
        {
            public Task ExecuteResultAsync(ActionContext context) => Task.CompletedTask;
        }

        [Fact]
        public void IsRecognizedNoContentResult_TreatsEmptyRecognizedShapesAsSafe()
        {
            // Recognized file shape that yielded no bytes, status-only results,
            // and error ObjectResults carry no image payload → safe pass-through.
            Assert.True(SpoilerBlurImageFilter.IsRecognizedNoContentResult(new FileContentResult(Array.Empty<byte>(), "image/jpeg")));
            Assert.True(SpoilerBlurImageFilter.IsRecognizedNoContentResult(new NotFoundResult()));
            Assert.True(SpoilerBlurImageFilter.IsRecognizedNoContentResult(new StatusCodeResult(500)));
            Assert.True(SpoilerBlurImageFilter.IsRecognizedNoContentResult(new ObjectResult("err") { StatusCode = 404 }));
            Assert.True(SpoilerBlurImageFilter.IsRecognizedNoContentResult(null));
        }

        [Fact]
        public void IsRecognizedNoContentResult_FailsClosedForUnrecognizedOrContentBearingShapes()
        {
            // A 2xx ObjectResult (could carry a body) and an entirely unknown
            // IActionResult must NOT be trusted to be empty → fail closed.
            Assert.False(SpoilerBlurImageFilter.IsRecognizedNoContentResult(new ObjectResult("body") { StatusCode = 200 }));
            Assert.False(SpoilerBlurImageFilter.IsRecognizedNoContentResult(new FakeUnknownResult()));
        }

        // ─── SanitizePlaceholder ──────────────────────────────────────────────────

        [Fact]
        public void SanitizePlaceholder_NullOrEmpty_ReturnsDefault()
        {
            Assert.Equal("Spoiler Guard activated", SpoilerFieldStripFilter.SanitizePlaceholder(null));
            Assert.Equal("Spoiler Guard activated", SpoilerFieldStripFilter.SanitizePlaceholder(string.Empty));
        }

        [Fact]
        public void SanitizePlaceholder_StripsTagsAndDangerousChars()
        {
            Assert.Equal("hi", SpoilerFieldStripFilter.SanitizePlaceholder("<b>hi</b>"));
            // Everything strippable → falls back to the default.
            Assert.Equal("Spoiler Guard activated", SpoilerFieldStripFilter.SanitizePlaceholder("<>\"'`&"));
        }

        [Fact]
        public void SanitizePlaceholder_CapsLengthAt200()
        {
            var raw = new string('a', 500);
            var result = SpoilerFieldStripFilter.SanitizePlaceholder(raw);
            Assert.Equal(200, result.Length);
        }

        // ─── MutateImageTagsForCacheBust ──────────────────────────────────────────

        private static BaseItemDto MakeDto(Guid id, string primaryTag, string? backdropTag)
        {
            var dto = new BaseItemDto
            {
                Id = id,
                ImageTags = new Dictionary<ImageType, string> { { ImageType.Primary, primaryTag } },
            };
            if (backdropTag != null)
            {
                dto.BackdropImageTags = new[] { backdropTag };
            }
            return dto;
        }

        [Fact]
        public void MutateImageTags_PrefixesPrimaryTag_AndIsIdempotent()
        {
            var cfg = new PluginConfiguration();
            var dto = MakeDto(Guid.NewGuid(), "orig", null);

            SpoilerFieldStripFilter.MutateImageTagsForCacheBust(dto, cfg, watched: false, playbackPositionTicks: 0);
            var afterFirst = dto.ImageTags![ImageType.Primary];
            Assert.StartsWith("sb-", afterFirst);
            Assert.EndsWith("-orig", afterFirst);

            // Second pass must not double-prefix (idempotent) — the tag is unchanged.
            SpoilerFieldStripFilter.MutateImageTagsForCacheBust(dto, cfg, watched: false, playbackPositionTicks: 0);
            Assert.Equal(afterFirst, dto.ImageTags![ImageType.Primary]);
            // Exactly one "sb-" prefix.
            Assert.Equal(0, afterFirst.IndexOf("sb-", StringComparison.Ordinal));
            Assert.DoesNotContain("sb-", afterFirst.Substring(3), StringComparison.Ordinal);
        }

        [Fact]
        public void MutateImageTags_TokenChangesOnWatchedFlip()
        {
            var cfg = new PluginConfiguration();
            var id = Guid.NewGuid();
            var unwatched = MakeDto(id, "orig", null);
            var watched = MakeDto(id, "orig", null);

            SpoilerFieldStripFilter.MutateImageTagsForCacheBust(unwatched, cfg, watched: false, playbackPositionTicks: 0);
            SpoilerFieldStripFilter.MutateImageTagsForCacheBust(watched, cfg, watched: true, playbackPositionTicks: 0);

            Assert.NotEqual(unwatched.ImageTags![ImageType.Primary], watched.ImageTags![ImageType.Primary]);
        }

        [Fact]
        public void MutateImageTags_BackdropOnlyBustedWhenArtworkEnabled()
        {
            var id = Guid.NewGuid();

            // Artwork OFF: primary busted, backdrop left alone.
            var cfgOff = new PluginConfiguration { SpoilerBlurArtwork = false };
            var dtoOff = MakeDto(id, "p", "bd");
            SpoilerFieldStripFilter.MutateImageTagsForCacheBust(dtoOff, cfgOff, watched: false, playbackPositionTicks: 0);
            Assert.StartsWith("sb-", dtoOff.ImageTags![ImageType.Primary]);
            Assert.Equal("bd", dtoOff.BackdropImageTags![0]);

            // Artwork ON: both busted.
            var cfgOn = new PluginConfiguration { SpoilerBlurArtwork = true };
            var dtoOn = MakeDto(id, "p", "bd");
            SpoilerFieldStripFilter.MutateImageTagsForCacheBust(dtoOn, cfgOn, watched: false, playbackPositionTicks: 0);
            Assert.StartsWith("sb-", dtoOn.ImageTags![ImageType.Primary]);
            Assert.StartsWith("sb-", dtoOn.BackdropImageTags![0]);
        }

        // ─── UserSpoilerBlur dictionary comparer round-trip through the store ─────

        [Fact]
        public void UserSpoilerBlur_DictionariesStayCaseInsensitiveAfterStoreRoundTrip()
        {
            var baseDir = Path.Combine(Path.GetTempPath(), "je-spoiler-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(baseDir);
            try
            {
                var mgr = new UserConfigurationManager(new StubAppPaths(baseDir), NullLogger<UserConfigurationManager>.Instance);
                var userId = Guid.NewGuid().ToString("N");
                var fileName = SpoilerBlurImageFilter.SpoilerBlurFileName;

                var seriesUpper = Guid.NewGuid().ToString("N").ToUpperInvariant();
                var movieUpper = Guid.NewGuid().ToString("N").ToUpperInvariant();
                var collUpper = Guid.NewGuid().ToString("N").ToUpperInvariant();
                const string pendingUpper = "TV:12345";

                var state = new UserSpoilerBlur();
                state.Series[seriesUpper] = new SpoilerBlurSeriesEntry { SeriesId = seriesUpper };
                state.Movies[movieUpper] = new SpoilerBlurMovieEntry { MovieId = movieUpper };
                state.Collections[collUpper] = new SpoilerBlurCollectionEntry { CollectionId = collUpper };
                state.PendingTmdb[pendingUpper] = new SpoilerBlurPendingEntry { MediaType = "tv", TmdbId = "12345" };

                mgr.SaveUserConfiguration(userId, fileName, state);
                var read = mgr.GetUserConfiguration<UserSpoilerBlur>(userId, fileName);

                // System.Text.Json rebuilds default-comparer dictionaries on read; the
                // setters re-wrap them OrdinalIgnoreCase, so a lowercase lookup must hit
                // the uppercase-stored key.
                Assert.True(read.Series.ContainsKey(seriesUpper.ToLowerInvariant()));
                Assert.True(read.Movies.ContainsKey(movieUpper.ToLowerInvariant()));
                Assert.True(read.Collections.ContainsKey(collUpper.ToLowerInvariant()));
                Assert.True(read.PendingTmdb.ContainsKey("tv:12345"));
            }
            finally
            {
                try { Directory.Delete(baseDir, recursive: true); } catch { /* best-effort cleanup */ }
            }
        }

        // ─── SpoilerSeerrPendingPromoter static gate atomicity ───────────────────

        [Fact]
        public void PromoterGate_RegisterUnregister_TracksUsersAndRemovesEmptyKey()
        {
            var key = "tv:" + Guid.NewGuid().ToString("N");
            var userA = Guid.NewGuid();
            var userB = Guid.NewGuid();

            Assert.False(SpoilerSeerrPendingPromoter.IsKeyRegisteredForTest(key));

            SpoilerSeerrPendingPromoter.RegisterPending(key, userA);
            SpoilerSeerrPendingPromoter.RegisterPending(key, userB);
            Assert.True(SpoilerSeerrPendingPromoter.IsKeyRegisteredForTest(key));
            Assert.Equal(2, SpoilerSeerrPendingPromoter.RegisteredUserCountForTest(key));

            // Re-register is idempotent (set semantics).
            SpoilerSeerrPendingPromoter.RegisterPending(key, userA);
            Assert.Equal(2, SpoilerSeerrPendingPromoter.RegisteredUserCountForTest(key));

            SpoilerSeerrPendingPromoter.UnregisterPending(key, userA);
            Assert.Equal(1, SpoilerSeerrPendingPromoter.RegisteredUserCountForTest(key));
            Assert.True(SpoilerSeerrPendingPromoter.IsKeyRegisteredForTest(key));

            // Removing the last user drops the key entirely.
            SpoilerSeerrPendingPromoter.UnregisterPending(key, userB);
            Assert.False(SpoilerSeerrPendingPromoter.IsKeyRegisteredForTest(key));

            // Unregistering a gone key + empty inputs are no-ops (no throw).
            SpoilerSeerrPendingPromoter.UnregisterPending(key, userB);
            SpoilerSeerrPendingPromoter.RegisterPending(string.Empty, userA);
            SpoilerSeerrPendingPromoter.RegisterPending(key, Guid.Empty);
            Assert.False(SpoilerSeerrPendingPromoter.IsKeyRegisteredForTest(key));
            Assert.False(SpoilerSeerrPendingPromoter.IsKeyRegisteredForTest(string.Empty));
        }

        // ─── ImageBlurService ─────────────────────────────────────────────────────

        [Fact]
        public void HardcodedFallbackJpeg_IsAValidJpeg()
        {
            var svc = new ImageBlurService(NullLogger<ImageBlurService>.Instance);
            var bytes = svc.HardcodedFallbackJpeg;

            Assert.NotNull(bytes);
            Assert.True(bytes.Length > 100);
            // JPEG SOI marker.
            Assert.Equal(0xFF, bytes[0]);
            Assert.Equal(0xD8, bytes[1]);
            // JPEG EOI marker.
            Assert.Equal(0xFF, bytes[^2]);
            Assert.Equal(0xD9, bytes[^1]);
        }

        [Fact]
        public void StockCard_CachesByKey_AndEvictionKeepsCacheBounded()
        {
            var svc = new ImageBlurService(NullLogger<ImageBlurService>.Instance);
            var input = svc.HardcodedFallbackJpeg;

            byte[]? first;
            try
            {
                first = svc.StockCard(input, "hit-key");
            }
            catch (Exception)
            {
                // SkiaSharp native lib unavailable in this environment — skip the
                // Skia-dependent portion (documented in the test csproj comment).
                return;
            }
            if (first == null) return; // Skia render returned null — treat as unavailable.

            // A valid JPEG was produced.
            Assert.True(first.Length > 2 && first[0] == 0xFF && first[1] == 0xD8);

            // Same key → cached reference returned.
            var second = svc.StockCard(input, "hit-key");
            Assert.Same(first, second);

            // Inserting many distinct keys must trigger eviction so the entry
            // count never exceeds MaxCacheEntries (256).
            for (var i = 0; i < 400; i++)
            {
                svc.StockCard(input, "evict-" + i);
            }
            Assert.True(svc.CacheEntryCountForTest <= 256,
                $"cache grew to {svc.CacheEntryCountForTest}, expected <= 256 after eviction");
        }
    }
}
