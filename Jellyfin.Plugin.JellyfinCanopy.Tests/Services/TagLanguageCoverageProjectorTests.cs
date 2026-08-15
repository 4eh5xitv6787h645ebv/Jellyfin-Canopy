using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Jellyfin.Plugin.JellyfinCanopy.Model;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Querying;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class TagLanguageCoverageProjectorTests
{
    private static TagLanguageCoverageProjector.LanguageEpisodeEvidence Known(params string[] languages)
        => TagLanguageCoverageProjector.LanguageEpisodeEvidence.Observed(languages);

    private static TagLanguageCoverageProjector.LanguageEpisodeEvidence Unknown(params string[] languages)
        => TagLanguageCoverageProjector.LanguageEpisodeEvidence.Unknown(languages);

    [Fact]
    public void Aggregate_CompleteEvidence_ClassifiesFullAndPartial()
    {
        var result = TagLanguageCoverageProjector.Aggregate(
            new[]
            {
                Known("eng", "jpn"),
                Known("en"),
                Known("ENG"),
            },
            enumerationComplete: true);

        Assert.True(result.Complete);
        Assert.Equal(3, result.EligibleEpisodeCount);
        Assert.Equal(3, result.ObservedEpisodeCount);
        Assert.Equal(new[] { "en" }, result.FullLanguages);
        Assert.Equal(new[] { "ja" }, result.PartialLanguages);
        Assert.Empty(result.UnknownLanguages);
    }

    [Fact]
    public void Aggregate_ProjectsOnlyCanonicalOriginalsThatArePresentInAudioEvidence()
    {
        var result = TagLanguageCoverageProjector.Aggregate(
            new[]
            {
                TagLanguageCoverageProjector.LanguageEpisodeEvidence.Observed(
                    new[] { "pt-br", "eng" }, "pt-BR"),
                TagLanguageCoverageProjector.LanguageEpisodeEvidence.Observed(
                    new[] { "en" }, "ja"),
            },
            enumerationComplete: true);

        Assert.Equal(new[] { "pt-BR" }, result.OriginalLanguages);
    }

    [Fact]
    public void Aggregate_FailedProbe_NeverBecomesFullOrAbsent()
    {
        var result = TagLanguageCoverageProjector.Aggregate(
            new[] { Known("eng"), Known("eng", "jpn"), Unknown("fra") },
            enumerationComplete: true);

        Assert.False(result.Complete);
        Assert.Equal(3, result.EligibleEpisodeCount);
        Assert.Equal(2, result.ObservedEpisodeCount);
        Assert.Empty(result.FullLanguages);
        Assert.Equal(new[] { "ja" }, result.PartialLanguages);
        Assert.Equal(new[] { "en", "fr" }, result.UnknownLanguages);
    }

    [Fact]
    public void Aggregate_SuccessfulEmptyProbe_IsKnownAbsence()
    {
        var result = TagLanguageCoverageProjector.Aggregate(
            new[] { Known("eng"), Known() },
            enumerationComplete: true);

        Assert.True(result.Complete);
        Assert.Empty(result.FullLanguages);
        Assert.Equal(new[] { "en" }, result.PartialLanguages);
        Assert.Empty(result.UnknownLanguages);
    }

    [Fact]
    public void Aggregate_EmptyContainer_IsExplicitCompleteEmpty()
    {
        var result = TagLanguageCoverageProjector.Aggregate(
            Array.Empty<TagLanguageCoverageProjector.LanguageEpisodeEvidence>(),
            enumerationComplete: true);

        Assert.True(result.Complete);
        Assert.Equal(0, result.EligibleEpisodeCount);
        Assert.Equal(0, result.ObservedEpisodeCount);
        Assert.Empty(result.FullLanguages);
        Assert.Empty(result.PartialLanguages);
        Assert.Empty(result.UnknownLanguages);
    }

    [Fact]
    public void Aggregate_AllFailed_PreservesOnlyUnknownObservedLanguages()
    {
        var result = TagLanguageCoverageProjector.Aggregate(
            new[] { Unknown("pt-br"), Unknown() },
            enumerationComplete: true);

        Assert.False(result.Complete);
        Assert.Equal(2, result.EligibleEpisodeCount);
        Assert.Equal(0, result.ObservedEpisodeCount);
        Assert.Empty(result.FullLanguages);
        Assert.Empty(result.PartialLanguages);
        Assert.Equal(new[] { "pt-BR" }, result.UnknownLanguages);
    }

    [Fact]
    public void Aggregate_CollapsesBibliographicAndRegionAliasesWithoutInventingFlagTrust()
    {
        var result = TagLanguageCoverageProjector.Aggregate(
            new[]
            {
                Known("fre", "en-840", "deu"),
                Known("fra", "en-US", "ger"),
            },
            enumerationComplete: true);

        Assert.True(result.Complete);
        Assert.Equal(new[] { "de", "en-840", "fr" }, result.FullLanguages);
        Assert.Empty(result.PartialLanguages);
        Assert.Empty(result.UnknownLanguages);
    }

    [Fact]
    public void Aggregate_OmitsLanguageFormsRejectedByTheClientResolver()
    {
        var result = TagLanguageCoverageProjector.Aggregate(
            new[] { Known("bad_tag", "zh-cmn", "eng") },
            enumerationComplete: true);

        Assert.True(result.Complete);
        Assert.Equal(new[] { "en" }, result.FullLanguages);
        Assert.Empty(result.PartialLanguages);
        Assert.Empty(result.UnknownLanguages);
    }

    [Fact]
    public void Aggregate_EnumerationFailure_WithholdsCounts()
    {
        var result = TagLanguageCoverageProjector.Aggregate(
            new[] { Known("eng") },
            enumerationComplete: false);

        Assert.False(result.Complete);
        Assert.Null(result.EligibleEpisodeCount);
        Assert.Null(result.ObservedEpisodeCount);
        Assert.Empty(result.FullLanguages);
        Assert.Empty(result.PartialLanguages);
        Assert.Empty(result.UnknownLanguages);
    }

    [Fact]
    public void Aggregate_BoundsLanguageEnvelopeAfterStableTierOrdering()
    {
        var first = Enumerable.Range(0, 40)
            .Select(index => $"q{(char)('a' + (index / 26))}{(char)('a' + (index % 26))}")
            .ToArray();
        var second = first.Take(5).ToArray();
        var result = TagLanguageCoverageProjector.Aggregate(
            new[] { Known(first), Known(second) },
            enumerationComplete: true);

        Assert.True(result.Truncated);
        Assert.Equal(8, result.OmittedLanguageCount);
        Assert.Equal(5, result.FullLanguages.Length);
        Assert.Equal(27, result.PartialLanguages.Length);
        Assert.Empty(result.UnknownLanguages);
    }

    [Fact]
    public void ProjectContainers_PagesOneSeriesOnce_AndPartitionsSeasons()
    {
        var seriesId = Guid.NewGuid();
        var firstSeasonId = Guid.NewGuid();
        var secondSeasonId = Guid.NewGuid();
        var saved = new DateTime(2026, 8, 5, 0, 0, 0, DateTimeKind.Utc);
        var episodes = Enumerable.Range(0, 501)
            .Select(index => new StubEpisode
            {
                Id = Guid.NewGuid(),
                SeriesId = seriesId,
                SeasonId = index < 500 ? firstSeasonId : secondSeasonId,
                DateLastSaved = saved,
            })
            .ToArray();
        var library = new CountingLibraryManager
        {
            GetItemsResultHook = query => new QueryResult<BaseItem>(
                query.StartIndex,
                episodes.Length,
                episodes.Skip(query.StartIndex ?? 0).Take(query.Limit ?? episodes.Length).ToArray()),
        };
        using var fixture = CoverageFixture.Create(library);
        foreach (var episode in episodes)
        {
            fixture.Cache.SeedEntryForTest(episode.Id.ToString("N"), new TagCacheEntry
            {
                Type = "Episode",
                SeriesId = seriesId.ToString("N"),
                SeasonId = episode.SeasonId.ToString("N"),
                SourceRevision = saved.Ticks,
                AudioLanguages = episode.SeasonId == secondSeasonId
                    ? new[] { "eng", "jpn" }
                    : new[] { "eng" },
            });
        }

        var result = new TagLanguageCoverageProjector(
                library,
                fixture.Cache,
                NullLogger.Instance)
            .ProjectContainers(
                fixture.User,
                new BaseItem[]
                {
                    new StubSeries { Id = seriesId },
                    new StubSeason { Id = firstSeasonId, SeriesId = seriesId },
                    new StubSeason { Id = secondSeasonId, SeriesId = seriesId },
                },
                default);

        Assert.Equal(2, library.GetItemsResultCallCount);
        Assert.Equal(501, result[seriesId.ToString("N")].EligibleEpisodeCount);
        Assert.Equal(new[] { "en" }, result[seriesId.ToString("N")].FullLanguages);
        Assert.Equal(new[] { "ja" }, result[seriesId.ToString("N")].PartialLanguages);
        Assert.Equal(500, result[firstSeasonId.ToString("N")].EligibleEpisodeCount);
        Assert.Equal(new[] { "en" }, result[firstSeasonId.ToString("N")].FullLanguages);
        Assert.Equal(new[] { "en", "ja" }, result[secondSeasonId.ToString("N")].FullLanguages);
    }

    [Fact]
    public void ProjectContainers_UsesOnlyCallerScopedRowsAndCounts()
    {
        var seriesId = Guid.NewGuid();
        var allowed = new[]
        {
            new StubEpisode { Id = Guid.NewGuid(), SeriesId = seriesId, DateLastSaved = DateTime.UtcNow },
            new StubEpisode { Id = Guid.NewGuid(), SeriesId = seriesId, DateLastSaved = DateTime.UtcNow },
        };
        var inaccessibleId = Guid.NewGuid();
        var library = new CountingLibraryManager
        {
            GetItemsResultHook = query => new QueryResult<BaseItem>(query.StartIndex, allowed.Length, allowed),
        };
        using var fixture = CoverageFixture.Create(library);
        foreach (var episode in allowed)
        {
            fixture.Cache.SeedEntryForTest(episode.Id.ToString("N"), new TagCacheEntry
            {
                Type = "Episode",
                SeriesId = seriesId.ToString("N"),
                SourceRevision = episode.DateLastSaved.Ticks,
                AudioLanguages = new[] { "eng" },
            });
        }
        fixture.Cache.SeedEntryForTest(inaccessibleId.ToString("N"), new TagCacheEntry
        {
            Type = "Episode",
            SeriesId = seriesId.ToString("N"),
            SourceRevision = 1,
            AudioLanguages = new[] { "jpn" },
        });

        var result = new TagLanguageCoverageProjector(library, fixture.Cache, NullLogger.Instance)
            .ProjectContainers(fixture.User, new[] { new StubSeries { Id = seriesId } }, default)
            [seriesId.ToString("N")];

        Assert.Equal(2, result.EligibleEpisodeCount);
        Assert.Equal(new[] { "en" }, result.FullLanguages);
        Assert.DoesNotContain("ja", result.FullLanguages.Concat(result.PartialLanguages).Concat(result.UnknownLanguages));
    }

    [Fact]
    public void ProjectContainers_OverRequestBudget_ReturnsExplicitTruncatedUnknown()
    {
        var seriesId = Guid.NewGuid();
        var library = new CountingLibraryManager
        {
            GetItemsResultHook = query => new QueryResult<BaseItem>(
                query.StartIndex,
                TagLanguageCoverageProjector.MaximumEpisodesPerRequest + 1,
                Array.Empty<BaseItem>()),
        };
        using var fixture = CoverageFixture.Create(library);

        var result = new TagLanguageCoverageProjector(library, fixture.Cache, NullLogger.Instance)
            .ProjectContainers(fixture.User, new[] { new StubSeries { Id = seriesId } }, default)
            [seriesId.ToString("N")];

        Assert.False(result.Complete);
        Assert.True(result.Truncated);
        Assert.Null(result.EligibleEpisodeCount);
        Assert.Null(result.ObservedEpisodeCount);
        Assert.Equal(1, library.GetItemsResultCallCount);
    }

    [Fact]
    public void ProjectAccessibleSnapshot_OverRequestBudget_ReturnsBoundedUnknown()
    {
        var seriesId = Guid.NewGuid();
        var entries = new Dictionary<string, TagCacheEntry>(StringComparer.Ordinal)
        {
            [seriesId.ToString("N")] = new TagCacheEntry { Type = "Series" },
        };
        foreach (var index in Enumerable.Range(0, TagLanguageCoverageProjector.MaximumEpisodesPerRequest + 1))
        {
            entries[Guid.NewGuid().ToString("N")] = new TagCacheEntry
            {
                Type = "Episode",
                SeriesId = seriesId.ToString("N"),
                SourceRevision = index + 1,
                AudioLanguages = new[] { "eng" },
            };
        }

        using var fixture = CoverageFixture.Create(new CountingLibraryManager());
        var result = new TagLanguageCoverageProjector(
                new CountingLibraryManager(),
                fixture.Cache,
                NullLogger.Instance)
            .ProjectAccessibleSnapshot(entries, default)
            [seriesId.ToString("N")];

        Assert.False(result.Complete);
        Assert.True(result.Truncated);
        Assert.Null(result.EligibleEpisodeCount);
        Assert.Null(result.ObservedEpisodeCount);
        Assert.Empty(result.FullLanguages);
        Assert.Empty(result.PartialLanguages);
        Assert.Empty(result.UnknownLanguages);
    }

    private sealed class CoverageFixture : IDisposable
    {
        private readonly string _directory;

        private CoverageFixture(string directory, CountingLibraryManager library)
        {
            _directory = directory;
            User = new Jellyfin.Database.Implementations.Entities.User(
                "coverage-user",
                "provider",
                "password-provider")
            {
                Id = Guid.NewGuid(),
            };
            Cache = new TagCacheService(
                library,
                new StubAppPaths(directory),
                NullLogger<TagCacheService>.Instance);
        }

        internal Jellyfin.Database.Implementations.Entities.User User { get; }

        internal TagCacheService Cache { get; }

        internal static CoverageFixture Create(CountingLibraryManager library)
            => new(Path.Combine(Path.GetTempPath(), "canopy-language-coverage-" + Guid.NewGuid().ToString("N")), library);

        public void Dispose()
        {
            Cache.Dispose();
            try { Directory.Delete(_directory, recursive: true); } catch { }
        }
    }
}
