using System;
using System.Collections.Generic;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinElevate.Configuration;
using Jellyfin.Plugin.JellyfinElevate.Services;
using Jellyfin.Plugin.JellyfinElevate.Tests.TestDoubles;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Model.Search;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.Services
{
    /// <summary>
    /// BI-SEC-010 F1: the Spoiler Guard field-strip filter's non-BaseItemDto
    /// response-shape extractors (ImageInfo, PlaybackInfoResponse, SearchHintResult)
    /// must honor the FailClosed sentinel — a cold-start policy fault that produced
    /// an empty policy would otherwise fail their membership checks and leak raw
    /// image paths, media-source/subtitle filenames, and episode titles.
    ///
    /// These fail against the pre-fix implementation, which honored FailClosed only
    /// in StripItem (BaseItemDto).
    /// </summary>
    public sealed class SpoilerFailClosedStripTests
    {
        private static UserSpoilerBlur FailClosed() => new UserSpoilerBlur { FailClosed = true };

        private static PluginConfiguration StripCfg() => new PluginConfiguration
        {
            SpoilerBlurEnabled = true,
            SpoilerStripOverview = true,
            SpoilerReplaceTitle = true,
        };

        private static SpoilerFieldStripFilter NewFilter(CountingLibraryManager lib, PluginConfiguration cfg)
        {
            var markers = new SpoilerIdentityService(new StubUserManager(), NullLogger<SpoilerIdentityService>.Instance);
            var identity = new RequestIdentityService(
                new CountingSessionManager(), new StubUserManager(), markers, NullLogger<RequestIdentityService>.Instance);
            // These FailClosed strip paths never touch per-user config or identity,
            // so the resolver's config manager is not exercised here.
            var resolver = new SpoilerUserResolver(
                userConfigManager: null!, lib, NullLogger<SpoilerUserResolver>.Instance, identity);
            return new SpoilerFieldStripFilter(resolver, lib, new StubUserManager(), new StubUserDataManager(), new FakePluginConfigProvider(cfg));
        }

        [Fact]
        public void FailClosed_StripsImageInfoPaths_RegardlessOfScope()
        {
            var lib = new CountingLibraryManager();
            var cfg = StripCfg();
            var filter = NewFilter(lib, cfg);

            var imgs = new List<ImageInfo> { new ImageInfo { Path = "/media/Show/S01E05 The Big Reveal.jpg" } };
            filter.StripImageInfosForTest(imgs, FailClosed(), cfg);

            Assert.Null(imgs[0].Path);
        }

        [Fact]
        public void FailClosed_StripsPlaybackInfoTitleBearingFields_RegardlessOfScope()
        {
            var lib = new CountingLibraryManager();
            var cfg = StripCfg();
            var filter = NewFilter(lib, cfg);

            var pbi = new PlaybackInfoResponse
            {
                MediaSources = new List<MediaSourceInfo>
                {
                    new MediaSourceInfo
                    {
                        Path = "/media/Show/S01E05 The Big Reveal.mkv",
                        Name = "S01E05 The Big Reveal",
                        MediaStreams = new List<MediaStream>
                        {
                            new MediaStream { Type = MediaStreamType.Subtitle, Title = "The Big Reveal", Comment = "spoiler" },
                        },
                    },
                },
            };

            filter.StripPlaybackInfoForTest(pbi, FailClosed(), cfg);

            var ms = pbi.MediaSources[0];
            Assert.Null(ms.Path);
            Assert.Null(ms.Name);
            Assert.Null(ms.MediaStreams[0].Title);
            Assert.Null(ms.MediaStreams[0].Comment);
        }

        [Fact]
        public void FailClosed_StripsSearchHint_EvenWhenLibraryLookupReturnsNull()
        {
            // The removed/stale/mismatched-item case the pre-fix guard missed:
            // GetItemById returns null, yet a cold-start fault must still strip the
            // hint by its declared Type rather than fall through and leak the title.
            var lib = new CountingLibraryManager
            {
                GetItemByIdNonGenericHook = _ => null,
            };
            var cfg = StripCfg();
            var filter = NewFilter(lib, cfg);

            var hint = new SearchHint
            {
                Id = Guid.NewGuid(),
                Type = BaseItemKind.Episode,
                Name = "The Big Reveal",
                MatchedTerm = "Reveal",
            };
            var shr = new SearchHintResult(new List<SearchHint> { hint }, 1);

            filter.StripSearchHintsForTest(shr, FailClosed(), cfg);

            Assert.NotEqual("The Big Reveal", hint.Name);
            Assert.Null(hint.MatchedTerm);
        }

        [Fact]
        public void FailClosed_StripsEpisodeHintName_WhenReplaceTitleOnButIndexNumbersMissing()
        {
            // The narrowest leak: title replacement is the ONLY enabled sensitive-
            // field policy, and the hint has no episode numbering to build the
            // "Season X, Episode Y" form. Fail-closed must still replace the raw
            // Name with the placeholder rather than leave it visible.
            var lib = new CountingLibraryManager { GetItemByIdNonGenericHook = _ => null };
            var cfg = new PluginConfiguration
            {
                SpoilerBlurEnabled = true,
                SpoilerReplaceTitle = true,
                SpoilerStripOverview = false,
            };
            var filter = NewFilter(lib, cfg);

            var hint = new SearchHint
            {
                Id = Guid.NewGuid(),
                Type = BaseItemKind.Episode,
                Name = "The Big Reveal",
                MatchedTerm = "Reveal",
                IndexNumber = null,
                ParentIndexNumber = null,
            };
            var shr = new SearchHintResult(new List<SearchHint> { hint }, 1);

            filter.StripSearchHintsForTest(shr, FailClosed(), cfg);

            Assert.NotEqual("The Big Reveal", hint.Name);
            Assert.Null(hint.MatchedTerm);
        }
    }
}
