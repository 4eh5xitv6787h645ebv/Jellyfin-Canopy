using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Model.Search;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services
{
    /// <summary>
    /// Privacy contract for SearchHint DTOs, which omit SeriesId. These tests
    /// intentionally cover hierarchy decisions only. Global filtered totals,
    /// backfill, and cursor/page reachability remain owned by issue #151.
    /// </summary>
    public sealed class HiddenContentSearchHintHierarchyTests : IDisposable
    {
        private readonly string _baseDir;
        private readonly UserConfigurationManager _configManager;

        public HiddenContentSearchHintHierarchyTests()
        {
            _baseDir = Path.Combine(Path.GetTempPath(), "jc-hidden-search-hierarchy-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_baseDir);
            _configManager = new UserConfigurationManager(
                new StubAppPaths(_baseDir),
                NullLogger<UserConfigurationManager>.Instance);
        }

        public void Dispose()
        {
            try { Directory.Delete(_baseDir, recursive: true); } catch { /* best effort */ }
        }

        [Theory]
        [InlineData("global")]
        [InlineData("search")]
        public void HiddenSeries_RemovesSeriesSeasonAndEpisodeHints_InOneUserScopedBatch(string scope)
        {
            var user = NewUser();
            var seriesId = Guid.NewGuid();
            var seasonId = Guid.NewGuid();
            var episodeId = Guid.NewGuid();
            var queryCount = 0;
            var library = new CountingLibraryManager
            {
                GetItemListHook = query =>
                {
                    queryCount++;
                    Assert.Same(user, query.User);
                    Assert.True(query.Recursive);
                    Assert.Equal(2, query.Limit);
                    Assert.Equal(
                        new[] { episodeId, seasonId }.OrderBy(static id => id),
                        query.ItemIds.OrderBy(static id => id));
                    return new BaseItem[]
                    {
                        new Season { Id = seasonId, SeriesId = seriesId },
                        new Episode { Id = episodeId, SeriesId = seriesId },
                    };
                },
            };
            var filter = NewFilter(library, user);
            var result = filter.FilterSearchHintsForTest(
                Result(
                    Hint(seriesId, BaseItemKind.Series),
                    Hint(seasonId, BaseItemKind.Season),
                    Hint(episodeId, BaseItemKind.Episode)),
                SeriesPolicy(seriesId, scope),
                user.Id);

            Assert.Empty(result.SearchHints);
            Assert.Equal(0, result.TotalRecordCount);
            Assert.Equal(1, queryCount);
        }

        [Fact]
        public void ExplicitItemOnlyHide_DoesNotCascadeOrResolveSiblingHierarchy()
        {
            var user = NewUser();
            var hiddenEpisodeId = Guid.NewGuid();
            var siblingEpisodeId = Guid.NewGuid();
            var seriesId = Guid.NewGuid();
            var library = new CountingLibraryManager
            {
                GetItemListHook = _ => throw new Xunit.Sdk.XunitException("item-only policy must not query hierarchy"),
            };
            var filter = NewFilter(library, user);
            var policy = EnabledSearchPolicy();
            policy.Items["episode"] = new HiddenContentItem
            {
                ItemId = hiddenEpisodeId.ToString(),
                Type = "Episode",
                HideScope = "global",
            };

            var result = filter.FilterSearchHintsForTest(
                Result(
                    Hint(hiddenEpisodeId, BaseItemKind.Episode),
                    Hint(siblingEpisodeId, BaseItemKind.Episode),
                    Hint(seriesId, BaseItemKind.Series)),
                policy,
                user.Id);

            Assert.Equal(new[] { siblingEpisodeId, seriesId }, result.SearchHints.Select(static hint => hint.Id));
        }

        [Fact]
        public void MixedHints_KeepUnrelatedShapesAndDropSuccessfullyUnresolvedDescendant()
        {
            var user = NewUser();
            var hiddenSeriesId = Guid.NewGuid();
            var allowedSeriesId = Guid.NewGuid();
            var allowedEpisodeId = Guid.NewGuid();
            var inaccessibleOrDeletedSeasonId = Guid.NewGuid();
            var movieId = Guid.NewGuid();
            var personId = Guid.NewGuid();
            var audioId = Guid.NewGuid();
            var library = new CountingLibraryManager
            {
                // A successful user-scoped query omits the Season: whether it
                // was deleted or inaccessible, its parent cannot be trusted.
                GetItemListHook = query =>
                {
                    Assert.Same(user, query.User);
                    return new BaseItem[]
                    {
                        new Episode { Id = allowedEpisodeId, SeriesId = allowedSeriesId },
                    };
                },
            };
            var filter = NewFilter(library, user);

            var result = filter.FilterSearchHintsForTest(
                Result(
                    Hint(movieId, BaseItemKind.Movie),
                    Hint(personId, BaseItemKind.Person),
                    Hint(audioId, BaseItemKind.Audio),
                    Hint(inaccessibleOrDeletedSeasonId, BaseItemKind.Season),
                    Hint(allowedEpisodeId, BaseItemKind.Episode)),
                SeriesPolicy(hiddenSeriesId),
                user.Id);

            Assert.Equal(
                new[] { movieId, personId, audioId, allowedEpisodeId },
                result.SearchHints.Select(static hint => hint.Id));
        }

        [Fact]
        public void QueryFailure_DropsCompletePayloadWithoutPublishingDirectPartialResult()
        {
            var user = NewUser();
            var seriesId = Guid.NewGuid();
            var library = new CountingLibraryManager
            {
                GetItemListHook = _ => throw new IOException("transient library fault"),
            };
            var filter = NewFilter(library, user);

            var result = filter.FilterSearchHintsForTest(
                Result(
                    Hint(Guid.NewGuid(), BaseItemKind.Movie),
                    Hint(Guid.NewGuid(), BaseItemKind.Episode)),
                SeriesPolicy(seriesId),
                user.Id);

            Assert.Empty(result.SearchHints);
            Assert.Equal(0, result.TotalRecordCount);
        }

        [Fact]
        public void CandidateCapFailure_DropsCompletePayloadWithoutQuerying()
        {
            var user = NewUser();
            var queryCount = 0;
            var library = new CountingLibraryManager
            {
                GetItemListHook = _ =>
                {
                    queryCount++;
                    return Array.Empty<BaseItem>();
                },
            };
            var filter = NewFilter(library, user);
            var hints = Enumerable.Range(0, HiddenContentHierarchyResolver.MaximumItemIds + 1)
                .Select(_ => Hint(Guid.NewGuid(), BaseItemKind.Episode))
                .ToArray();

            var result = filter.FilterSearchHintsForTest(
                new SearchHintResult(hints, hints.Length),
                SeriesPolicy(Guid.NewGuid()),
                user.Id);

            Assert.Empty(result.SearchHints);
            Assert.Equal(0, queryCount);
        }

        [Fact]
        public void CandidateCap_AllowsExactlyMaximumUniqueIdsAndDeduplicatesTheBatch()
        {
            var user = NewUser();
            var allowedSeriesId = Guid.NewGuid();
            var ids = Enumerable.Range(0, HiddenContentHierarchyResolver.MaximumItemIds)
                .Select(_ => Guid.NewGuid())
                .ToArray();
            var queryCount = 0;
            var library = new CountingLibraryManager
            {
                GetItemListHook = query =>
                {
                    queryCount++;
                    Assert.Equal(HiddenContentHierarchyResolver.MaximumItemIds, query.Limit);
                    Assert.Equal(
                        ids.OrderBy(static id => id),
                        query.ItemIds.OrderBy(static id => id));
                    return ids
                        .Select(id => (BaseItem)new Episode { Id = id, SeriesId = allowedSeriesId })
                        .ToArray();
                },
            };
            var filter = NewFilter(library, user);
            var hints = ids
                .Select(id => Hint(id, BaseItemKind.Episode))
                .Append(Hint(ids[0], BaseItemKind.Episode))
                .ToArray();

            var result = filter.FilterSearchHintsForTest(
                new SearchHintResult(hints, hints.Length),
                SeriesPolicy(Guid.NewGuid()),
                user.Id);

            Assert.Equal(hints.Length, result.SearchHints.Count);
            Assert.Equal(1, queryCount);
        }

        [Fact]
        public void PreQueryCancellation_DropsCompletePayloadWithoutQuerying()
        {
            var user = NewUser();
            var queryCount = 0;
            var library = new CountingLibraryManager
            {
                GetItemListHook = _ =>
                {
                    queryCount++;
                    return Array.Empty<BaseItem>();
                },
            };
            var filter = NewFilter(library, user);
            using var cancelled = new CancellationTokenSource();
            cancelled.Cancel();

            var result = filter.FilterSearchHintsForTest(
                Result(Hint(Guid.NewGuid(), BaseItemKind.Episode)),
                SeriesPolicy(Guid.NewGuid()),
                user.Id,
                cancelled.Token);

            Assert.Empty(result.SearchHints);
            Assert.Equal(0, queryCount);
        }

        [Fact]
        public void PostQueryCancellation_DropsCompletePayloadWithoutPublishingResolvedPartialResult()
        {
            var user = NewUser();
            var seriesId = Guid.NewGuid();
            var episodeId = Guid.NewGuid();
            using var cancelled = new CancellationTokenSource();
            var library = new CountingLibraryManager
            {
                GetItemListHook = _ =>
                {
                    cancelled.Cancel();
                    return new BaseItem[] { new Episode { Id = episodeId, SeriesId = seriesId } };
                },
            };
            var filter = NewFilter(library, user);

            var result = filter.FilterSearchHintsForTest(
                Result(
                    Hint(Guid.NewGuid(), BaseItemKind.Movie),
                    Hint(episodeId, BaseItemKind.Episode)),
                SeriesPolicy(seriesId),
                user.Id,
                cancelled.Token);

            Assert.Empty(result.SearchHints);
            Assert.Equal(0, result.TotalRecordCount);
        }

        [Fact]
        public void MissingRequestUser_DropsCompletePayloadWithoutQuerying()
        {
            var queryCount = 0;
            var library = new CountingLibraryManager
            {
                GetItemListHook = _ =>
                {
                    queryCount++;
                    return Array.Empty<BaseItem>();
                },
            };
            var filter = NewFilter(library, Array.Empty<User>());

            var result = filter.FilterSearchHintsForTest(
                Result(Hint(Guid.NewGuid(), BaseItemKind.Episode)),
                SeriesPolicy(Guid.NewGuid()),
                Guid.NewGuid());

            Assert.Empty(result.SearchHints);
            Assert.Equal(0, queryCount);
        }

        private HiddenContentResponseFilter NewFilter(CountingLibraryManager library, params User[] users)
        {
            var hierarchy = new HiddenContentHierarchyResolver(library, new StubUserManager(users));
            return new HiddenContentResponseFilter(
                _configManager,
                NullLogger<HiddenContentResponseFilter>.Instance,
                new FakePluginConfigProvider(new PluginConfiguration()),
                hierarchy);
        }

        private static User NewUser()
            => new("search-hint-user", "Provider", "PasswordProvider") { Id = Guid.NewGuid() };

        private static UserHiddenContent EnabledSearchPolicy()
            => new()
            {
                Settings = new HiddenContentSettings
                {
                    Enabled = true,
                    FilterSearch = true,
                },
            };

        private static UserHiddenContent SeriesPolicy(Guid seriesId, string scope = "global")
        {
            var policy = EnabledSearchPolicy();
            policy.Items["series"] = new HiddenContentItem
            {
                ItemId = seriesId.ToString(),
                Type = "Series",
                HideScope = scope,
            };
            return policy;
        }

        private static SearchHint Hint(Guid id, BaseItemKind type)
            => new() { Id = id, Type = type, Name = type.ToString() };

        private static SearchHintResult Result(params SearchHint[] hints)
            => new(hints, hints.Length);
    }
}
