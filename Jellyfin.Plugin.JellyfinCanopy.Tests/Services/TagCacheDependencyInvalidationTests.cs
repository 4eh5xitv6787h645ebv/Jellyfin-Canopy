using System.Diagnostics;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinCanopy.Model;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class TagCacheDependencyInvalidationTests
{
    private static readonly DateTime SavedAt = new(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void FieldDependencyInventory_CoversEveryTagCacheEntryField()
    {
        var properties = typeof(TagCacheEntry)
            .GetProperties()
            .Select(property => property.Name)
            .OrderBy(name => name, StringComparer.Ordinal);

        Assert.Equal(
            properties,
            TagCacheDependencyGraph.FieldDependencies.Keys.OrderBy(name => name, StringComparer.Ordinal));
        Assert.Equal(
            TagCacheFieldDependency.OwnItem | TagCacheFieldDependency.ParentSeries,
            TagCacheDependencyGraph.FieldDependencies[nameof(TagCacheEntry.SeriesTmdbId)]);
        Assert.Equal(
            TagCacheFieldDependency.OwnItem | TagCacheFieldDependency.FirstEpisode,
            TagCacheDependencyGraph.FieldDependencies[nameof(TagCacheEntry.StreamData)]);
        Assert.Equal(
            TagCacheFieldDependency.OwnItem | TagCacheFieldDependency.ParentSeries,
            TagCacheDependencyGraph.FieldDependencies[nameof(TagCacheEntry.OriginalLanguage)]);
        Assert.Equal(
            TagCacheFieldDependency.OwnItem
                | TagCacheFieldDependency.FirstEpisode
                | TagCacheFieldDependency.ParentSeries,
            TagCacheDependencyGraph.FieldDependencies[nameof(TagCacheEntry.Genres)]);
        Assert.Equal(
            TagCacheDependencyGraph.FieldDependencies
                .Where(pair => pair.Value.HasFlag(TagCacheFieldDependency.ParentSeries))
                .Select(pair => pair.Key)
                .OrderBy(name => name, StringComparer.Ordinal),
            TagCacheDependencyGraph.ParentSeriesConsumers.Keys.OrderBy(name => name, StringComparer.Ordinal));
        Assert.Equal(
            new[] { BaseItemKind.Season },
            TagCacheDependencyGraph.ParentSeriesConsumers[nameof(TagCacheEntry.Genres)]);
        Assert.Equal(
            new[] { BaseItemKind.Episode, BaseItemKind.Season },
            TagCacheDependencyGraph.ParentSeriesConsumers[nameof(TagCacheEntry.SeriesTmdbId)]);
        Assert.Equal(
            new[] { BaseItemKind.Episode, BaseItemKind.Season },
            TagCacheDependencyGraph.DescendantKinds());
    }

    [Fact]
    public void ParentSeriesGraph_UpdatesEveryAndOnlyDeclaredEpisodeField()
    {
        var series = new StubSeries
        {
            Id = Guid.NewGuid(),
            CommunityRating = 9,
            CriticRating = 90,
            OriginalLanguage = "pt-BR",
            ProviderIds = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Tmdb"] = "new-parent" },
        };
        var episode = new StubEpisode { Id = Guid.NewGuid(), SeriesId = series.Id };
        var streamData = new TagStreamData { ItemName = "unchanged" };
        var existing = new TagCacheEntry
        {
            Type = "Episode",
            TmdbId = "own-tmdb",
            SeriesTmdbId = "old-parent",
            SeasonNumber = 2,
            EpisodeNumber = 3,
            Genres = new[] { "Own" },
            CommunityRating = 1,
            CriticRating = 10,
            AudioLanguages = new[] { "eng" },
            OriginalLanguage = "ja",
            StreamData = streamData,
            LastUpdated = 5,
            SeriesId = Key(series.Id),
            SeasonId = Key(Guid.NewGuid()),
            StreamSourceId = Key(episode.Id),
            SourceRevision = 123,
        };

        var refreshed = TagCacheDependencyGraph.ApplyParentSeriesRefresh(
            series,
            episode,
            existing,
            _ => throw new InvalidOperationException("Episode refresh must not inspect first Episode"),
            lastUpdated: 6);

        Assert.Equal("new-parent", refreshed.SeriesTmdbId);
        Assert.Equal(9, refreshed.CommunityRating);
        Assert.Equal(90, refreshed.CriticRating);
        Assert.Equal(6, refreshed.LastUpdated);
        Assert.Equal(existing.Type, refreshed.Type);
        Assert.Equal(existing.TmdbId, refreshed.TmdbId);
        Assert.Equal(existing.SeasonNumber, refreshed.SeasonNumber);
        Assert.Equal(existing.EpisodeNumber, refreshed.EpisodeNumber);
        Assert.Same(existing.Genres, refreshed.Genres);
        Assert.Same(existing.AudioLanguages, refreshed.AudioLanguages);
        Assert.Equal("pt-BR", refreshed.OriginalLanguage);
        Assert.Same(streamData, refreshed.StreamData);
        Assert.Equal(existing.SeriesId, refreshed.SeriesId);
        Assert.Equal(existing.SeasonId, refreshed.SeasonId);
        Assert.Equal(existing.StreamSourceId, refreshed.StreamSourceId);
        Assert.Equal(existing.SourceRevision, refreshed.SourceRevision);
    }

    [Fact]
    public void EpisodeChange_CapturesExactlySelfSeasonAndSeriesWithoutDiscovery()
    {
        var episode = new StubEpisode
        {
            Id = Guid.NewGuid(),
            SeriesId = Guid.NewGuid(),
            SeasonId = Guid.NewGuid(),
        };

        var oldSeriesId = Guid.NewGuid();
        var oldSeasonId = Guid.NewGuid();
        var change = TagCacheDependencyGraph.Capture(
            episode,
            removed: false,
            new TagCacheEntry
            {
                SeriesId = Key(oldSeriesId),
                SeasonId = Key(oldSeasonId),
            });
        var targets = new[] { change.Id }
            .Concat(TagCacheDependencyGraph.DirectDerivedTargets(change).Select(static target => target.Id))
            .ToHashSet();

        Assert.Equal(
            new[]
            {
                episode.Id,
                episode.SeasonId,
                episode.SeriesId,
                oldSeriesId,
                oldSeasonId,
            }.ToHashSet(),
            targets);
        Assert.False(TagCacheDependencyGraph.NeedsSeriesDescendantDiscovery(change));
    }

    [Fact]
    public void SeriesEvent_RecordsOnScanThreadWithoutLibraryQuery()
    {
        var queryCount = 0;
        var series = new StubSeries { Id = Guid.NewGuid(), DateLastSaved = SavedAt };
        var library = new CountingLibraryManager
        {
            GetItemListHook = _ =>
            {
                queryCount++;
                throw new InvalidOperationException("library discovery must not run on the event thread");
            },
        };
        using var service = NewService(library);
        using var monitor = new TagCacheMonitor(library, service, NullLogger<TagCacheMonitor>.Instance);
        monitor.Initialize();

        library.RaiseItemUpdated(series);

        Assert.Equal(0, queryCount);
        Assert.Equal(1, service.PendingChangeCountForTest);
    }

    [Fact]
    public void LargeSeriesEventBurst_StaysOnConstantTimeRecordPath()
    {
        const int EventCount = 10_000;
        var series = new StubSeries { Id = Guid.NewGuid(), DateLastSaved = SavedAt };
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = _ => throw new InvalidOperationException("event intake must not resolve items"),
            GetItemListHook = _ => throw new InvalidOperationException("event intake must not scan the library"),
        };
        using var service = NewService(library);
        using var monitor = new TagCacheMonitor(library, service, NullLogger<TagCacheMonitor>.Instance);
        monitor.Initialize();

        var elapsed = Stopwatch.StartNew();
        for (var i = 0; i < EventCount; i++)
        {
            library.RaiseItemUpdated(series);
        }

        elapsed.Stop();

        Assert.Equal(1, service.PendingChangeCountForTest);
        Assert.Equal(0, library.GetItemByIdCallCount);
        Assert.Equal(0, library.GetItemListCallCount);
        Assert.True(
            elapsed.Elapsed < TimeSpan.FromSeconds(5),
            $"Recording {EventCount} synchronous Series events took {elapsed.Elapsed}; expected under 5 seconds.");
    }

    [Fact]
    public void LargeSeriesDistinctEpisodeBurst_HasBoundedQueryFreeEventIntake()
    {
        const int EventCount = 10_000;
        var seriesId = Guid.NewGuid();
        var seasonId = Guid.NewGuid();
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = _ => throw new InvalidOperationException("event intake must not resolve items"),
            GetItemListHook = _ => throw new InvalidOperationException("event intake must not scan the library"),
        };
        using var service = NewService(library);
        using var monitor = new TagCacheMonitor(library, service, NullLogger<TagCacheMonitor>.Instance);
        monitor.Initialize();

        var elapsed = Stopwatch.StartNew();
        for (var i = 0; i < EventCount; i++)
        {
            library.RaiseItemUpdated(new StubEpisode
            {
                Id = Guid.NewGuid(),
                SeriesId = seriesId,
                SeasonId = seasonId,
            });
        }

        elapsed.Stop();

        Assert.Equal(EventCount, service.PendingChangeCountForTest);
        Assert.Equal(0, library.GetItemByIdCallCount);
        Assert.Equal(0, library.GetItemListCallCount);
        Assert.True(
            elapsed.Elapsed < TimeSpan.FromSeconds(5),
            $"Recording {EventCount} distinct synchronous Episode events took {elapsed.Elapsed}; expected under 5 seconds.");
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void EpisodeAddOrUpdate_RebuildsExactlyEpisodeSeasonAndSeries(bool added)
    {
        var seriesId = Guid.NewGuid();
        var seasonId = Guid.NewGuid();
        var episodeId = Guid.NewGuid();
        var unrelatedId = Guid.NewGuid();
        var series = new StubSeries
        {
            Id = seriesId,
            DateLastSaved = SavedAt,
            Genres = Array.Empty<string>(),
        };
        var season = new StubSeason
        {
            Id = seasonId,
            SeriesId = seriesId,
            DateLastSaved = SavedAt,
            CommunityRating = 7,
        };
        var episode = new StubEpisode
        {
            Id = episodeId,
            SeriesId = seriesId,
            SeasonId = seasonId,
            DateLastSaved = SavedAt,
            Genres = new[] { "Episode" },
        };
        var resolvedIds = new List<Guid>();
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id =>
            {
                resolvedIds.Add(id);
                return id == seriesId ? series : id == seasonId ? season : id == episodeId ? episode : null;
            },
            GetItemListHook = query => query.ParentId == seriesId || query.ParentId == seasonId
                ? new BaseItem[] { episode }
                : Array.Empty<BaseItem>(),
        };
        using var service = NewService(library);
        var unrelated = new TagCacheEntry { Type = "Movie" };
        service.SeedEntryForTest(Key(unrelatedId), unrelated);
        using var monitor = new TagCacheMonitor(library, service, NullLogger<TagCacheMonitor>.Instance);
        monitor.Initialize();

        if (added) library.RaiseItemAdded(episode);
        else library.RaiseItemUpdated(episode);
        service.FlushPendingForTest();

        Assert.True(service.ContainsKeyForTest(Key(episodeId)));
        Assert.True(service.ContainsKeyForTest(Key(seasonId)));
        Assert.True(service.ContainsKeyForTest(Key(seriesId)));
        Assert.Equal(new[] { episodeId, seasonId, seriesId }.ToHashSet(), resolvedIds.ToHashSet());
        Assert.Same(unrelated, service.GetEntryForTest(Key(unrelatedId)));
    }

    [Fact]
    public void EpisodeReparenting_RebuildsOldAndNewSeriesAndSeasons()
    {
        var oldSeriesId = Guid.NewGuid();
        var oldSeasonId = Guid.NewGuid();
        var newSeriesId = Guid.NewGuid();
        var newSeasonId = Guid.NewGuid();
        var episodeId = Guid.NewGuid();
        var oldReplacement = new StubEpisode
        {
            Id = Guid.NewGuid(),
            SeriesId = oldSeriesId,
            SeasonId = oldSeasonId,
            Genres = new[] { "Old replacement" },
            Name = "Old replacement",
            Path = "/library/old-replacement.mkv",
            DateLastSaved = SavedAt,
        };
        var movedEpisode = new StubEpisode
        {
            Id = episodeId,
            SeriesId = newSeriesId,
            SeasonId = newSeasonId,
            Genres = new[] { "Moved" },
            Name = "Moved",
            Path = "/library/moved.mkv",
            DateLastSaved = SavedAt,
        };
        var items = new Dictionary<Guid, BaseItem>
        {
            [oldSeriesId] = new StubSeries { Id = oldSeriesId, Genres = new[] { "Stable" }, DateLastSaved = SavedAt },
            [oldSeasonId] = new StubSeason { Id = oldSeasonId, SeriesId = oldSeriesId, CommunityRating = 1, Genres = new[] { "Stable" }, DateLastSaved = SavedAt },
            [newSeriesId] = new StubSeries { Id = newSeriesId, Genres = new[] { "Stable" }, DateLastSaved = SavedAt },
            [newSeasonId] = new StubSeason { Id = newSeasonId, SeriesId = newSeriesId, CommunityRating = 1, Genres = new[] { "Stable" }, DateLastSaved = SavedAt },
            [episodeId] = movedEpisode,
        };
        var resolved = new List<Guid>();
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id =>
            {
                resolved.Add(id);
                return items.GetValueOrDefault(id);
            },
            GetItemListHook = query => query.ParentId == oldSeriesId || query.ParentId == oldSeasonId
                ? new BaseItem[] { oldReplacement }
                : query.ParentId == newSeriesId || query.ParentId == newSeasonId
                    ? new BaseItem[] { movedEpisode }
                    : Array.Empty<BaseItem>(),
        };
        using var service = NewService(library);
        service.SeedEntryForTest(Key(episodeId), new TagCacheEntry
        {
            Type = "Episode",
            SeriesId = Key(oldSeriesId),
            SeasonId = Key(oldSeasonId),
            StreamSourceId = Key(episodeId),
        });
        foreach (var parentId in new[] { oldSeriesId, oldSeasonId, newSeriesId, newSeasonId })
        {
            service.SeedEntryForTest(Key(parentId), new TagCacheEntry
            {
                Type = parentId == oldSeriesId || parentId == newSeriesId ? "Series" : "Season",
                Genres = new[] { "Stable" },
                StreamData = new TagStreamData { ItemPath = "stale.mkv" },
            });
        }
        using var monitor = new TagCacheMonitor(library, service, NullLogger<TagCacheMonitor>.Instance);
        monitor.Initialize();

        library.RaiseItemUpdated(movedEpisode);
        service.FlushPendingForTest();

        Assert.Contains(oldSeriesId, resolved);
        Assert.Contains(oldSeasonId, resolved);
        Assert.Contains(newSeriesId, resolved);
        Assert.Contains(newSeasonId, resolved);
        Assert.Equal("old-replacement.mkv", service.GetEntryForTest(Key(oldSeriesId))!.StreamData!.ItemPath);
        Assert.Equal("old-replacement.mkv", service.GetEntryForTest(Key(oldSeasonId))!.StreamData!.ItemPath);
        Assert.Equal("moved.mkv", service.GetEntryForTest(Key(newSeriesId))!.StreamData!.ItemPath);
        Assert.Equal("moved.mkv", service.GetEntryForTest(Key(newSeasonId))!.StreamData!.ItemPath);
        Assert.Equal(Key(newSeriesId), service.GetEntryForTest(Key(episodeId))!.SeriesId);
        Assert.Equal(Key(newSeasonId), service.GetEntryForTest(Key(episodeId))!.SeasonId);
    }

    [Fact]
    public void RemovingSeason_TombstonesRecursiveEpisodesAndRepairsSeries()
    {
        var seriesId = Guid.NewGuid();
        var seasonId = Guid.NewGuid();
        var episodeIds = new[] { Guid.NewGuid(), Guid.NewGuid() };
        var replacement = new StubEpisode
        {
            Id = Guid.NewGuid(),
            SeriesId = seriesId,
            Name = "Remaining",
            Path = "/library/remaining.mkv",
            DateLastSaved = SavedAt,
        };
        var series = new StubSeries { Id = seriesId, DateLastSaved = SavedAt };
        var removedSeason = new StubSeason { Id = seasonId, SeriesId = seriesId };
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => id == seriesId ? series : null,
            GetItemListHook = query => query.ParentId == seriesId
                ? new BaseItem[] { replacement }
                : Array.Empty<BaseItem>(),
        };
        using var service = NewService(library);
        service.SeedEntryForTest(Key(seriesId), new TagCacheEntry { Type = "Series", StreamData = new TagStreamData { ItemPath = "removed-season.mkv" } });
        service.SeedEntryForTest(Key(seasonId), new TagCacheEntry { Type = "Season", SeriesId = Key(seriesId) });
        foreach (var episodeId in episodeIds)
        {
            service.SeedEntryForTest(Key(episodeId), new TagCacheEntry
            {
                Type = "Episode",
                SeriesId = Key(seriesId),
                SeasonId = Key(seasonId),
            });
        }
        using var monitor = new TagCacheMonitor(library, service, NullLogger<TagCacheMonitor>.Instance);
        monitor.Initialize();

        library.RaiseItemRemoved(removedSeason);
        service.FlushPendingForTest();

        Assert.False(service.ContainsKeyForTest(Key(seasonId)));
        Assert.All(episodeIds, id => Assert.False(service.ContainsKeyForTest(Key(id))));
        Assert.Equal("remaining.mkv", service.GetEntryForTest(Key(seriesId))!.StreamData!.ItemPath);
        Assert.Equal(1, service.Version);
    }

    [Fact]
    public void RemovingSeries_TombstonesEveryCachedSeasonAndEpisodeButNotUnrelatedItems()
    {
        var seriesId = Guid.NewGuid();
        var seasonId = Guid.NewGuid();
        var episodeId = Guid.NewGuid();
        var unrelatedId = Guid.NewGuid();
        var removedSeries = new StubSeries { Id = seriesId };
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = _ => throw new InvalidOperationException("removal must use the local relationship index"),
            GetItemListHook = _ => throw new InvalidOperationException("removal must use the local relationship index"),
        };
        using var service = NewService(library);
        service.SeedEntryForTest(Key(seriesId), new TagCacheEntry { Type = "Series" });
        service.SeedEntryForTest(Key(seasonId), new TagCacheEntry { Type = "Season", SeriesId = Key(seriesId) });
        service.SeedEntryForTest(Key(episodeId), new TagCacheEntry { Type = "Episode", SeriesId = Key(seriesId), SeasonId = Key(seasonId) });
        var unrelated = new TagCacheEntry { Type = "Movie" };
        service.SeedEntryForTest(Key(unrelatedId), unrelated);
        using var monitor = new TagCacheMonitor(library, service, NullLogger<TagCacheMonitor>.Instance);
        monitor.Initialize();

        library.RaiseItemRemoved(removedSeries);
        service.FlushPendingForTest();

        Assert.False(service.ContainsKeyForTest(Key(seriesId)));
        Assert.False(service.ContainsKeyForTest(Key(seasonId)));
        Assert.False(service.ContainsKeyForTest(Key(episodeId)));
        Assert.Same(unrelated, service.GetEntryForTest(Key(unrelatedId)));
        Assert.Equal(0, library.GetItemByIdCallCount);
        Assert.Equal(0, library.GetItemListCallCount);
        Assert.Equal(1, service.Version);
    }

    [Fact]
    public void RecursiveSeriesRemoval_OverridesSameBatchUpdateStillInsideRemovedSeries()
    {
        var seriesId = Guid.NewGuid();
        var episode = new StubEpisode { Id = Guid.NewGuid(), SeriesId = seriesId };
        var removedSeries = new StubSeries { Id = seriesId };
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = _ => null,
            GetItemListHook = _ => Array.Empty<BaseItem>(),
        };
        using var service = NewService(library);
        service.SeedEntryForTest(Key(seriesId), new TagCacheEntry { Type = "Series" });
        service.SeedEntryForTest(Key(episode.Id), new TagCacheEntry { Type = "Episode", SeriesId = Key(seriesId) });

        service.EnqueueItemChange(episode, removed: false);
        service.EnqueueItemChange(removedSeries, removed: true);
        service.FlushPendingForTest();

        Assert.False(service.ContainsKeyForTest(Key(episode.Id)));
        Assert.Equal(0, service.PendingChangeCountForTest);
    }

    [Fact]
    public void RecursiveSeriesRemoval_PreservesSameBatchEpisodeMovedOutsideSeries()
    {
        var removedSeriesId = Guid.NewGuid();
        var newSeriesId = Guid.NewGuid();
        var episode = new StubEpisode
        {
            Id = Guid.NewGuid(),
            SeriesId = newSeriesId,
            DateLastSaved = SavedAt,
        };
        var removedSeries = new StubSeries { Id = removedSeriesId };
        var newSeries = new StubSeries { Id = newSeriesId, DateLastSaved = SavedAt };
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => id == episode.Id ? episode : id == newSeriesId ? newSeries : null,
            GetItemListHook = query => query.ParentId == newSeriesId
                ? new BaseItem[] { episode }
                : Array.Empty<BaseItem>(),
        };
        using var service = NewService(library);
        service.SeedEntryForTest(Key(removedSeriesId), new TagCacheEntry { Type = "Series" });
        service.SeedEntryForTest(Key(episode.Id), new TagCacheEntry
        {
            Type = "Episode",
            SeriesId = Key(removedSeriesId),
        });

        service.EnqueueItemChange(episode, removed: false);
        service.EnqueueItemChange(removedSeries, removed: true);
        service.FlushPendingForTest();

        Assert.False(service.ContainsKeyForTest(Key(removedSeriesId)));
        Assert.Equal(Key(newSeriesId), service.GetEntryForTest(Key(episode.Id))!.SeriesId);
    }

    [Fact]
    public void RecursiveSeriesRemoval_PreservesSameBatchEpisodeDetachedFromAnySeries()
    {
        var removedSeriesId = Guid.NewGuid();
        var episode = new StubEpisode
        {
            Id = Guid.NewGuid(),
            SeriesId = Guid.Empty,
            DateLastSaved = SavedAt,
        };
        var removedSeries = new StubSeries { Id = removedSeriesId };
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => id == episode.Id ? episode : null,
            GetItemListHook = _ => Array.Empty<BaseItem>(),
        };
        using var service = NewService(library);
        service.SeedEntryForTest(Key(removedSeriesId), new TagCacheEntry { Type = "Series" });
        service.SeedEntryForTest(Key(episode.Id), new TagCacheEntry
        {
            Type = "Episode",
            SeriesId = Key(removedSeriesId),
        });

        service.EnqueueItemChange(episode, removed: false);
        service.EnqueueItemChange(removedSeries, removed: true);
        service.FlushPendingForTest();

        Assert.False(service.ContainsKeyForTest(Key(removedSeriesId)));
        Assert.True(service.ContainsKeyForTest(Key(episode.Id)));
        Assert.Null(service.GetEntryForTest(Key(episode.Id))!.SeriesId);
    }

    [Fact]
    public void RecursiveSeasonRemoval_PreservesSameBatchEpisodeDetachedFromAnySeason()
    {
        var seriesId = Guid.NewGuid();
        var removedSeasonId = Guid.NewGuid();
        var series = new StubSeries { Id = seriesId, DateLastSaved = SavedAt };
        var episode = new StubEpisode
        {
            Id = Guid.NewGuid(),
            SeriesId = seriesId,
            SeasonId = Guid.Empty,
            DateLastSaved = SavedAt,
        };
        var removedSeason = new StubSeason { Id = removedSeasonId, SeriesId = seriesId };
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => id == episode.Id ? episode : id == seriesId ? series : null,
            GetItemListHook = query => query.ParentId == seriesId
                ? new BaseItem[] { episode }
                : Array.Empty<BaseItem>(),
        };
        using var service = NewService(library);
        service.SeedEntryForTest(Key(seriesId), new TagCacheEntry { Type = "Series" });
        service.SeedEntryForTest(Key(removedSeasonId), new TagCacheEntry
        {
            Type = "Season",
            SeriesId = Key(seriesId),
        });
        service.SeedEntryForTest(Key(episode.Id), new TagCacheEntry
        {
            Type = "Episode",
            SeriesId = Key(seriesId),
            SeasonId = Key(removedSeasonId),
        });

        service.EnqueueItemChange(episode, removed: false);
        service.EnqueueItemChange(removedSeason, removed: true);
        service.FlushPendingForTest();

        Assert.False(service.ContainsKeyForTest(Key(removedSeasonId)));
        Assert.True(service.ContainsKeyForTest(Key(episode.Id)));
        Assert.Null(service.GetEntryForTest(Key(episode.Id))!.SeasonId);
    }

    [Fact]
    public void InFlightSecondReparent_CannotStrandTheIntermediateSeriesAfterChildFirstApply()
    {
        var oldSeriesId = Guid.Parse("10000000-0000-0000-0000-000000000000");
        var intermediateSeriesId = Guid.Parse("00000000-0000-0000-0000-000000000001");
        var finalSeriesId = Guid.Parse("20000000-0000-0000-0000-000000000000");
        var episodeId = Guid.Parse("ffffffff-ffff-ffff-ffff-ffffffffffff");
        var oldSeries = new StubSeries { Id = oldSeriesId, DateLastSaved = SavedAt };
        var intermediateSeries = new StubSeries { Id = intermediateSeriesId, DateLastSaved = SavedAt };
        var finalSeries = new StubSeries { Id = finalSeriesId, DateLastSaved = SavedAt };
        StubEpisode liveEpisode = new()
        {
            Id = episodeId,
            SeriesId = intermediateSeriesId,
            Name = "Intermediate",
            Path = "/library/intermediate.mkv",
            DateLastSaved = SavedAt,
        };
        var movedAgain = false;
        var library = new CountingLibraryManager();
        using var service = NewService(library);
        library.GetItemByIdHook = id =>
        {
            if (id == episodeId)
            {
                if (!movedAgain)
                {
                    movedAgain = true;
                    liveEpisode = new StubEpisode
                    {
                        Id = episodeId,
                        SeriesId = finalSeriesId,
                        Name = "Final",
                        Path = "/library/final.mkv",
                        DateLastSaved = SavedAt,
                    };
                    service.EnqueueItemChange(liveEpisode, removed: false);
                }

                return liveEpisode;
            }

            return id == oldSeriesId
                ? oldSeries
                : id == intermediateSeriesId
                    ? intermediateSeries
                    : id == finalSeriesId
                        ? finalSeries
                        : null;
        };
        library.GetItemListHook = query =>
            query.ParentId == liveEpisode.SeriesId
                ? new BaseItem[] { liveEpisode }
                : Array.Empty<BaseItem>();
        service.SeedEntryForTest(Key(episodeId), new TagCacheEntry
        {
            Type = "Episode",
            SeriesId = Key(oldSeriesId),
        });
        service.SeedEntryForTest(Key(oldSeriesId), StaleContainer());
        service.SeedEntryForTest(Key(intermediateSeriesId), StaleContainer());
        service.SeedEntryForTest(Key(finalSeriesId), StaleContainer());

        service.EnqueueItemChange(new StubEpisode
        {
            Id = episodeId,
            SeriesId = intermediateSeriesId,
            DateLastSaved = SavedAt,
        }, removed: false);
        service.FlushPendingForTest();
        service.FlushPendingForTest();

        Assert.Null(service.GetEntryForTest(Key(intermediateSeriesId))!.StreamData);
        Assert.Equal("final.mkv", service.GetEntryForTest(Key(finalSeriesId))!.StreamData!.ItemPath);
        Assert.Equal(Key(finalSeriesId), service.GetEntryForTest(Key(episodeId))!.SeriesId);
    }

    [Fact]
    public void BatchedRecursiveSeriesRemoval_ScansCacheOnceAndJournalsEveryTombstone()
    {
        const int SeriesCount = 50;
        const int EpisodesPerSeries = 10;
        var removedSeries = Enumerable.Range(0, SeriesCount)
            .Select(_ => new StubSeries { Id = Guid.NewGuid() })
            .ToArray();
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = _ => throw new InvalidOperationException("recursive removal must be cache-indexed"),
            GetItemListHook = _ => throw new InvalidOperationException("recursive removal must be cache-indexed"),
        };
        using var service = NewService(library);
        foreach (var series in removedSeries)
        {
            service.SeedEntryForTest(Key(series.Id), new TagCacheEntry { Type = "Series" });
            for (var index = 0; index < EpisodesPerSeries; index++)
            {
                var episodeId = Guid.NewGuid();
                service.SeedEntryForTest(Key(episodeId), new TagCacheEntry
                {
                    Type = "Episode",
                    SeriesId = Key(series.Id),
                });
            }
        }
        var cachedCount = SeriesCount * (EpisodesPerSeries + 1);

        foreach (var series in removedSeries)
        {
            service.EnqueueItemChange(series, removed: true);
        }
        service.FlushPendingForTest();

        Assert.Equal(0, service.Count);
        Assert.Equal(cachedCount, service.RemovedDependencyEntriesVisitedForTest);
        Assert.Equal(cachedCount, service.ContentRevision);
        Assert.Equal(1, service.Version);
    }

    [Fact]
    public void SeasonReparenting_RebuildsOldAndNewSeries()
    {
        var oldSeriesId = Guid.NewGuid();
        var newSeriesId = Guid.NewGuid();
        var seasonId = Guid.NewGuid();
        var oldFirst = new StubEpisode { Id = Guid.NewGuid(), SeriesId = oldSeriesId, Name = "Old remaining", Path = "/library/old-remaining.mkv" };
        var newFirst = new StubEpisode { Id = Guid.NewGuid(), SeriesId = newSeriesId, SeasonId = seasonId, Name = "Moved season", Path = "/library/moved-season.mkv" };
        var movedEpisode = new StubEpisode
        {
            Id = Guid.NewGuid(),
            SeriesId = newSeriesId,
            SeasonId = seasonId,
            DateLastSaved = SavedAt,
        };
        var oldSeries = new StubSeries { Id = oldSeriesId, DateLastSaved = SavedAt };
        var newSeries = new StubSeries { Id = newSeriesId, DateLastSaved = SavedAt };
        var movedSeason = new StubSeason { Id = seasonId, SeriesId = newSeriesId, CommunityRating = 1, DateLastSaved = SavedAt };
        var items = new Dictionary<Guid, BaseItem>
        {
            [oldSeriesId] = oldSeries,
            [newSeriesId] = newSeries,
            [seasonId] = movedSeason,
            [movedEpisode.Id] = movedEpisode,
        };
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => items.GetValueOrDefault(id),
            GetItemListHook = query => query.AncestorIds?.Contains(seasonId) == true
                ? new BaseItem[] { movedEpisode }
                : query.ParentId == oldSeriesId
                ? new BaseItem[] { oldFirst }
                : query.ParentId == newSeriesId || query.ParentId == seasonId
                    ? new BaseItem[] { newFirst }
                    : Array.Empty<BaseItem>(),
        };
        using var service = NewService(library);
        service.SeedEntryForTest(Key(seasonId), new TagCacheEntry { Type = "Season", SeriesId = Key(oldSeriesId) });
        service.SeedEntryForTest(Key(movedEpisode.Id), new TagCacheEntry
        {
            Type = "Episode",
            SeriesId = Key(oldSeriesId),
            SeasonId = Key(seasonId),
            CommunityRating = 1,
        });
        service.SeedEntryForTest(Key(oldSeriesId), new TagCacheEntry { Type = "Series" });
        service.SeedEntryForTest(Key(newSeriesId), new TagCacheEntry { Type = "Series" });
        using var monitor = new TagCacheMonitor(library, service, NullLogger<TagCacheMonitor>.Instance);
        monitor.Initialize();

        library.RaiseItemUpdated(movedSeason);
        service.FlushPendingForTest();

        Assert.Equal("old-remaining.mkv", service.GetEntryForTest(Key(oldSeriesId))!.StreamData!.ItemPath);
        Assert.Equal("moved-season.mkv", service.GetEntryForTest(Key(newSeriesId))!.StreamData!.ItemPath);
        Assert.Equal(Key(newSeriesId), service.GetEntryForTest(Key(seasonId))!.SeriesId);
        Assert.Equal(Key(newSeriesId), service.GetEntryForTest(Key(movedEpisode.Id))!.SeriesId);
    }

    [Fact]
    public void SeasonReparenting_OutOfRemovedSeriesPreservesAndRepairsItsCachedEpisodes()
    {
        var oldSeriesId = Guid.NewGuid();
        var newSeriesId = Guid.NewGuid();
        var seasonId = Guid.NewGuid();
        var newSeries = new StubSeries
        {
            Id = newSeriesId,
            CommunityRating = 9,
            ProviderIds = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Tmdb"] = "new" },
            DateLastSaved = SavedAt,
        };
        var movedSeason = new StubSeason
        {
            Id = seasonId,
            SeriesId = newSeriesId,
            CommunityRating = 1,
            DateLastSaved = SavedAt,
        };
        var episodes = Enumerable.Range(0, 3)
            .Select(_ => new StubEpisode
            {
                Id = Guid.NewGuid(),
                SeriesId = newSeriesId,
                SeasonId = seasonId,
                DateLastSaved = SavedAt,
            })
            .ToArray();
        var removedSeries = new StubSeries { Id = oldSeriesId };
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => id == newSeriesId
                ? newSeries
                : id == seasonId
                    ? movedSeason
                    : null,
            GetItemListHook = query => query.AncestorIds?.Contains(seasonId) == true
                || query.ParentId == seasonId
                || query.ParentId == newSeriesId
                    ? episodes
                    : Array.Empty<BaseItem>(),
        };
        using var service = NewService(library);
        service.SeedEntryForTest(Key(oldSeriesId), new TagCacheEntry { Type = "Series" });
        service.SeedEntryForTest(Key(newSeriesId), new TagCacheEntry { Type = "Series" });
        service.SeedEntryForTest(Key(seasonId), new TagCacheEntry
        {
            Type = "Season",
            SeriesId = Key(oldSeriesId),
        });
        foreach (var episode in episodes)
        {
            service.SeedEntryForTest(Key(episode.Id), new TagCacheEntry
            {
                Type = "Episode",
                SeriesId = Key(oldSeriesId),
                SeasonId = Key(seasonId),
                SeriesTmdbId = "old",
                SourceRevision = SavedAt.Ticks,
            });
        }

        service.EnqueueItemChange(movedSeason, removed: false);
        service.EnqueueItemChange(removedSeries, removed: true);
        service.FlushPendingForTest();

        Assert.False(service.ContainsKeyForTest(Key(oldSeriesId)));
        Assert.Equal(Key(newSeriesId), service.GetEntryForTest(Key(seasonId))!.SeriesId);
        Assert.All(episodes, episode =>
        {
            var entry = service.GetEntryForTest(Key(episode.Id));
            Assert.NotNull(entry);
            Assert.Equal(Key(newSeriesId), entry!.SeriesId);
            Assert.Equal("new", entry.SeriesTmdbId);
        });
    }

    [Fact]
    public void SeasonMoveOutOfRemovedSeries_IncompleteDiscoveryKeepsCachedEpisodesAndRetries()
    {
        var oldSeriesId = Guid.NewGuid();
        var newSeriesId = Guid.NewGuid();
        var seasonId = Guid.NewGuid();
        var episodeId = Guid.NewGuid();
        var newSeries = new StubSeries { Id = newSeriesId, DateLastSaved = SavedAt };
        var movedSeason = new StubSeason
        {
            Id = seasonId,
            SeriesId = newSeriesId,
            CommunityRating = 1,
            DateLastSaved = SavedAt,
        };
        var movedEpisode = new StubEpisode
        {
            Id = episodeId,
            SeriesId = newSeriesId,
            SeasonId = seasonId,
            DateLastSaved = SavedAt,
        };
        var removedSeries = new StubSeries { Id = oldSeriesId };
        var descendantQueries = 0;
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => id == newSeriesId ? newSeries : id == seasonId ? movedSeason : null,
            GetItemListHook = query => query.AncestorIds?.Contains(seasonId) == true
                && ++descendantQueries >= 3
                    ? new BaseItem[] { movedEpisode }
                    : Array.Empty<BaseItem>(), // first two snapshots are transiently incomplete
        };
        using var service = NewService(library);
        service.SeedEntryForTest(Key(oldSeriesId), new TagCacheEntry { Type = "Series" });
        service.SeedEntryForTest(Key(newSeriesId), new TagCacheEntry { Type = "Series" });
        service.SeedEntryForTest(Key(seasonId), new TagCacheEntry
        {
            Type = "Season",
            SeriesId = Key(oldSeriesId),
        });
        var cachedEpisode = new TagCacheEntry
        {
            Type = "Episode",
            SeriesId = Key(oldSeriesId),
            SeasonId = Key(seasonId),
            SourceRevision = SavedAt.Ticks,
        };
        service.SeedEntryForTest(Key(episodeId), cachedEpisode);

        service.EnqueueItemChange(movedSeason, removed: false);
        service.EnqueueItemChange(removedSeries, removed: true);
        service.FlushPendingForTest();

        Assert.False(service.ContainsKeyForTest(Key(oldSeriesId)));
        Assert.Same(cachedEpisode, service.GetEntryForTest(Key(episodeId)));
        Assert.Equal(1, service.PendingChangeCountForTest);

        service.FlushPendingForTest();

        Assert.Same(cachedEpisode, service.GetEntryForTest(Key(episodeId)));
        Assert.Equal(1, service.PendingChangeCountForTest);

        service.FlushPendingForTest();

        Assert.Equal(Key(newSeriesId), service.GetEntryForTest(Key(episodeId))!.SeriesId);
        Assert.Equal(0, service.PendingChangeCountForTest);
        Assert.Equal(3, descendantQueries);
    }

    [Fact]
    public void VerifiedSeriesSnapshot_OverridesSyntheticRemovalForConcurrentReparent()
    {
        var oldSeriesId = Guid.NewGuid();
        var newSeriesId = Guid.NewGuid();
        var episodeId = Guid.NewGuid();
        var oldSeries = new StubSeries { Id = oldSeriesId };
        var newSeries = new StubSeries { Id = newSeriesId, DateLastSaved = SavedAt };
        var episode = new StubEpisode
        {
            Id = episodeId,
            SeriesId = newSeriesId,
            DateLastSaved = SavedAt,
        };
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => id == newSeriesId ? newSeries : null,
            GetItemListHook = query => query.AncestorIds?.Contains(newSeriesId) == true
                || query.ParentId == newSeriesId
                    ? new BaseItem[] { episode }
                    : Array.Empty<BaseItem>(),
        };
        using var service = NewService(library);
        service.SeedEntryForTest(Key(oldSeriesId), new TagCacheEntry { Type = "Series" });
        service.SeedEntryForTest(Key(newSeriesId), new TagCacheEntry { Type = "Series" });
        service.SeedEntryForTest(Key(episodeId), new TagCacheEntry
        {
            Type = "Episode",
            SeriesId = Key(oldSeriesId),
            SourceRevision = SavedAt.Ticks,
        });

        service.EnqueueItemChange(oldSeries, removed: true);
        service.EnqueueItemChange(newSeries, removed: false);
        service.FlushPendingForTest();

        Assert.False(service.ContainsKeyForTest(Key(oldSeriesId)));
        Assert.Equal(Key(newSeriesId), service.GetEntryForTest(Key(episodeId))!.SeriesId);
        Assert.Equal(0, service.PendingChangeCountForTest);
    }

    [Fact]
    public void SeriesSnapshot_RepairsEpisodeMoveBetweenSeasonsInTheSameSeries()
    {
        var seriesId = Guid.NewGuid();
        var oldSeasonId = Guid.NewGuid();
        var newSeasonId = Guid.NewGuid();
        var episodeId = Guid.NewGuid();
        var series = new StubSeries { Id = seriesId, DateLastSaved = SavedAt };
        var oldSeason = new StubSeason { Id = oldSeasonId, SeriesId = seriesId, DateLastSaved = SavedAt };
        var newSeason = new StubSeason { Id = newSeasonId, SeriesId = seriesId, DateLastSaved = SavedAt };
        var episode = new StubEpisode
        {
            Id = episodeId,
            SeriesId = seriesId,
            SeasonId = newSeasonId,
            DateLastSaved = SavedAt,
        };
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => id == seriesId
                ? series
                : id == oldSeasonId
                    ? oldSeason
                    : id == newSeasonId
                        ? newSeason
                        : null,
            GetItemListHook = query => query.AncestorIds?.Contains(seriesId) == true
                ? new BaseItem[] { oldSeason, newSeason, episode }
                : query.ItemIds?.Contains(oldSeasonId) == true
                    ? new BaseItem[] { oldSeason }
                    : query.ParentId == seriesId || query.ParentId == newSeasonId
                        ? new BaseItem[] { episode }
                        : query.ParentId == oldSeasonId
                            ? Array.Empty<BaseItem>()
                            : throw new InvalidOperationException("unexpected same-Series Season-move query"),
        };
        using var service = NewService(library);
        service.SeedEntryForTest(Key(seriesId), new TagCacheEntry { Type = "Series" });
        service.SeedEntryForTest(Key(oldSeasonId), new TagCacheEntry { Type = "Season", SeriesId = Key(seriesId) });
        service.SeedEntryForTest(Key(newSeasonId), new TagCacheEntry { Type = "Season", SeriesId = Key(seriesId) });
        service.SeedEntryForTest(Key(episodeId), new TagCacheEntry
        {
            Type = "Episode",
            SeriesId = Key(seriesId),
            SeasonId = Key(oldSeasonId),
            SourceRevision = SavedAt.Ticks,
        });

        service.EnqueueItemChange(series, removed: false);
        service.FlushPendingForTest();

        Assert.Equal(Key(newSeasonId), service.GetEntryForTest(Key(episodeId))!.SeasonId);
        Assert.Equal(0, service.PendingChangeCountForTest);
    }

    [Fact]
    public void UnchangedEpisodeParents_AreRebuiltWhenTheirCacheRowsAreMissing()
    {
        var seriesId = Guid.NewGuid();
        var seasonId = Guid.NewGuid();
        var episode = new StubEpisode
        {
            Id = Guid.NewGuid(),
            SeriesId = seriesId,
            SeasonId = seasonId,
            DateLastSaved = SavedAt,
        };
        var series = new StubSeries { Id = seriesId, DateLastSaved = SavedAt };
        var season = new StubSeason { Id = seasonId, SeriesId = seriesId, DateLastSaved = SavedAt };
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => id == episode.Id ? episode : id == seriesId ? series : id == seasonId ? season : null,
            GetItemListHook = query => query.ParentId == seriesId || query.ParentId == seasonId
                ? new BaseItem[] { episode }
                : Array.Empty<BaseItem>(),
        };
        using var service = NewService(library);
        service.SeedEntryForTest(Key(episode.Id), new TagCacheEntry
        {
            Type = "Episode",
            SeriesId = Key(seriesId),
            SeasonId = Key(seasonId),
            SourceRevision = SavedAt.Ticks,
        });

        service.EnqueueItemChange(episode, removed: false);
        service.FlushPendingForTest();

        Assert.Equal("Series", service.GetEntryForTest(Key(seriesId))!.Type);
        Assert.Equal("Season", service.GetEntryForTest(Key(seasonId))!.Type);
    }

    [Fact]
    public void RemovingFirstEpisode_RebuildsSeriesAndSeasonFromReplacement()
    {
        var seriesId = Guid.NewGuid();
        var seasonId = Guid.NewGuid();
        var removedId = Guid.NewGuid();
        var replacementId = Guid.NewGuid();
        var series = new StubSeries { Id = seriesId, Genres = Array.Empty<string>(), DateLastSaved = SavedAt };
        var season = new StubSeason
        {
            Id = seasonId,
            SeriesId = seriesId,
            Genres = Array.Empty<string>(),
            CommunityRating = 7.5f,
            DateLastSaved = SavedAt,
        };
        var replacement = new ControlledEpisode
        {
            Id = replacementId,
            SeriesId = seriesId,
            SeasonId = seasonId,
            Name = "Replacement",
            Path = "/library/replacement.mkv",
            Genres = new[] { "Fresh" },
            DateLastSaved = SavedAt,
            MediaSources = new[]
            {
                new MediaSourceInfo
                {
                    Name = "Replacement source",
                    Path = "/library/replacement-source.mkv",
                    MediaStreams = new[]
                    {
                        new MediaStream
                        {
                            Type = MediaStreamType.Audio,
                            Language = "eng",
                            Codec = "aac",
                            Channels = 2,
                        },
                    },
                },
            },
        };
        var removed = new StubEpisode
        {
            Id = removedId,
            SeriesId = seriesId,
            SeasonId = seasonId,
        };
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => id == seriesId
                ? series
                : id == seasonId
                    ? season
                    : id == replacementId
                        ? replacement
                        : null,
            GetItemListHook = query => query.ParentId == seriesId || query.ParentId == seasonId
                ? new BaseItem[] { replacement }
                : Array.Empty<BaseItem>(),
        };

        using var service = NewService(library);
        service.SeedEntryForTest(Key(removedId), new TagCacheEntry { Type = "Episode" });
        service.SeedEntryForTest(Key(seriesId), StaleContainer());
        service.SeedEntryForTest(Key(seasonId), StaleContainer());
        using var monitor = new TagCacheMonitor(library, service, NullLogger<TagCacheMonitor>.Instance);
        monitor.Initialize();

        library.RaiseItemRemoved(removed);
        service.FlushPendingForTest();

        Assert.False(service.ContainsKeyForTest(Key(removedId)));
        AssertReplacement(service.GetEntryForTest(Key(seriesId)));
        AssertReplacement(service.GetEntryForTest(Key(seasonId)));
    }

    [Fact]
    public void FirstEpisodeReplacementProbeFailure_ClearsRemovedEpisodeMedia()
    {
        var seriesId = Guid.NewGuid();
        var removedId = Guid.NewGuid();
        var replacement = new ControlledEpisode
        {
            Id = Guid.NewGuid(),
            SeriesId = seriesId,
            Name = "Replacement",
            Path = "/library/replacement.mkv",
            Genres = new[] { "Fresh" },
            DateLastSaved = SavedAt,
            ThrowOnProbe = true,
        };
        var series = new StubSeries { Id = seriesId, Genres = Array.Empty<string>(), DateLastSaved = SavedAt };
        var removed = new StubEpisode { Id = removedId, SeriesId = seriesId };
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => id == seriesId ? series : null,
            GetItemListHook = query => query.ParentId == seriesId
                ? new BaseItem[] { replacement }
                : Array.Empty<BaseItem>(),
        };
        using var service = NewService(library);
        service.SeedEntryForTest(Key(removedId), new TagCacheEntry { Type = "Episode" });
        service.SeedEntryForTest(Key(seriesId), new TagCacheEntry
        {
            Type = "Series",
            StreamSourceId = Key(removedId),
            StreamData = new TagStreamData
            {
                ItemName = "Removed",
                ItemPath = "removed.mkv",
                Streams = new List<TagMediaStream> { new() { Codec = "old-codec" } },
                Sources = new List<TagMediaSource> { new() { Path = "removed-source.mkv" } },
            },
            AudioLanguages = new[] { "old" },
        });
        using var monitor = new TagCacheMonitor(library, service, NullLogger<TagCacheMonitor>.Instance);
        monitor.Initialize();

        library.RaiseItemRemoved(removed);
        service.FlushPendingForTest();

        var entry = service.GetEntryForTest(Key(seriesId));
        Assert.NotNull(entry);
        Assert.Equal(Key(replacement.Id), entry!.StreamSourceId);
        Assert.Equal("Replacement", entry.StreamData!.ItemName);
        Assert.Equal("replacement.mkv", entry.StreamData.ItemPath);
        Assert.Null(entry.StreamData.Streams);
        Assert.Null(entry.StreamData.Sources);
        Assert.Null(entry.AudioLanguages);
        Assert.Equal(new[] { "Fresh" }, entry.Genres);
        Assert.Equal(0, entry.SourceRevision);
    }

    [Fact]
    public void RemovingOnlyEpisode_ClearsAllFirstEpisodeDerivedFields()
    {
        var seriesId = Guid.NewGuid();
        var removed = new StubEpisode { Id = Guid.NewGuid(), SeriesId = seriesId };
        var series = new StubSeries { Id = seriesId, Genres = Array.Empty<string>(), DateLastSaved = SavedAt };
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => id == seriesId ? series : null,
            GetItemListHook = _ => Array.Empty<BaseItem>(),
        };
        using var service = NewService(library);
        service.SeedEntryForTest(Key(removed.Id), new TagCacheEntry { Type = "Episode" });
        service.SeedEntryForTest(Key(seriesId), new TagCacheEntry
        {
            Type = "Series",
            Genres = new[] { "Removed" },
            StreamSourceId = Key(removed.Id),
            StreamData = new TagStreamData
            {
                ItemName = "Removed",
                ItemPath = "removed.mkv",
                Streams = new List<TagMediaStream> { new() },
                Sources = new List<TagMediaSource> { new() },
            },
            AudioLanguages = new[] { "eng" },
        });
        using var monitor = new TagCacheMonitor(library, service, NullLogger<TagCacheMonitor>.Instance);
        monitor.Initialize();

        library.RaiseItemRemoved(removed);
        service.FlushPendingForTest();

        var entry = service.GetEntryForTest(Key(seriesId));
        Assert.NotNull(entry);
        Assert.Empty(entry!.Genres!);
        Assert.Null(entry.StreamSourceId);
        Assert.Null(entry.StreamData);
        Assert.Null(entry.AudioLanguages);
    }

    [Fact]
    public void FirstEpisodeLookupFailure_PreservesParentAndRetries()
    {
        var seriesId = Guid.NewGuid();
        var removed = new StubEpisode { Id = Guid.NewGuid(), SeriesId = seriesId };
        var replacement = new StubEpisode
        {
            Id = Guid.NewGuid(),
            SeriesId = seriesId,
            Name = "Recovered",
            Path = "/library/recovered.mkv",
            DateLastSaved = SavedAt,
        };
        var series = new StubSeries { Id = seriesId, DateLastSaved = SavedAt };
        var queryFails = true;
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => id == seriesId ? series : null,
            GetItemListHook = query => query.ParentId == seriesId
                ? queryFails
                    ? throw new InvalidOperationException("transient first-Episode query failure")
                    : new BaseItem[] { replacement }
                : Array.Empty<BaseItem>(),
        };
        using var service = NewService(library);
        var old = StaleContainer();
        old.Genres = Array.Empty<string>();
        old.StreamSourceId = Key(removed.Id);
        service.SeedEntryForTest(Key(removed.Id), new TagCacheEntry { Type = "Episode" });
        service.SeedEntryForTest(Key(seriesId), old);
        using var monitor = new TagCacheMonitor(library, service, NullLogger<TagCacheMonitor>.Instance);
        monitor.Initialize();

        library.RaiseItemRemoved(removed);
        service.FlushPendingForTest();

        Assert.Same(old, service.GetEntryForTest(Key(seriesId)));
        Assert.Equal(1, service.PendingChangeCountForTest);

        queryFails = false;
        service.FlushPendingForTest();

        Assert.Equal(0, service.PendingChangeCountForTest);
        Assert.Equal("recovered.mkv", service.GetEntryForTest(Key(seriesId))!.StreamData!.ItemPath);
    }

    [Fact]
    public void SameSourceProbeFailure_KeepsStreamsButPublishesFreshNameAndPath()
    {
        var seriesId = Guid.NewGuid();
        var firstEpisode = new ControlledEpisode
        {
            Id = Guid.NewGuid(),
            SeriesId = seriesId,
            Name = "Renamed",
            Path = "/moved/renamed.mkv",
            ThrowOnProbe = true,
            DateLastSaved = SavedAt,
        };
        var series = new StubSeries { Id = seriesId, DateLastSaved = SavedAt };
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => id == seriesId ? series : null,
            GetItemListHook = query => query.ParentId == seriesId
                ? new BaseItem[] { firstEpisode }
                : Array.Empty<BaseItem>(),
        };
        using var service = NewService(library);
        service.SeedEntryForTest(Key(seriesId), new TagCacheEntry
        {
            Type = "Series",
            StreamSourceId = Key(firstEpisode.Id),
            StreamData = new TagStreamData
            {
                ItemName = "Old name",
                ItemPath = "old-path.mkv",
                Streams = new List<TagMediaStream> { new() { Codec = "h264" } },
                Sources = new List<TagMediaSource> { new() { Path = "old-source.mkv" } },
            },
            AudioLanguages = new[] { "eng" },
        });
        using var monitor = new TagCacheMonitor(library, service, NullLogger<TagCacheMonitor>.Instance);
        monitor.Initialize();

        library.RaiseItemUpdated(series);
        service.FlushPendingForTest();

        var entry = service.GetEntryForTest(Key(seriesId));
        Assert.Equal("Renamed", entry!.StreamData!.ItemName);
        Assert.Equal("renamed.mkv", entry.StreamData.ItemPath);
        Assert.Equal("h264", Assert.Single(entry.StreamData.Streams!).Codec);
        Assert.Equal("old-source.mkv", Assert.Single(entry.StreamData.Sources!).Path);
        Assert.Equal(new[] { "eng" }, entry.AudioLanguages);
    }

    [Fact]
    public void UpdatingSeries_RebuildsOnlyDescendantsThatCaptureSeriesFields()
    {
        var seriesId = Guid.NewGuid();
        var seasonId = Guid.NewGuid();
        var episodeId = Guid.NewGuid();
        var unrelatedId = Guid.NewGuid();
        var series = new StubSeries
        {
            Id = seriesId,
            CommunityRating = 9.1f,
            CriticRating = 91,
            Genres = new[] { "Updated" },
            DateLastSaved = SavedAt,
            ProviderIds = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["Tmdb"] = "new-series-tmdb",
            },
        };
        var season = new StubSeason
        {
            Id = seasonId,
            SeriesId = seriesId,
            IndexNumber = 1,
            Genres = Array.Empty<string>(),
            DateLastSaved = SavedAt,
        };
        var episode = new StubEpisode
        {
            Id = episodeId,
            SeriesId = seriesId,
            SeasonId = seasonId,
            ParentIndexNumber = 1,
            IndexNumber = 2,
            Genres = Array.Empty<string>(),
            DateLastSaved = SavedAt,
        };
        var resolvedIds = new List<Guid>();
        var queries = new List<InternalItemsQuery>();
        var unrelatedEpisode = new StubEpisode
        {
            Id = unrelatedId,
            SeriesId = Guid.NewGuid(),
            SeasonId = seasonId,
            Genres = new[] { "Foreign" },
            DateLastSaved = SavedAt,
        };
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id =>
            {
                resolvedIds.Add(id);
                return id == seriesId ? series : id == seasonId ? season : id == episodeId ? episode : null;
            },
            GetItemListHook = query =>
            {
                queries.Add(query);
                if (query.AncestorIds?.Contains(seriesId) == true)
                {
                    return new BaseItem[] { season, unrelatedEpisode, episode };
                }

                if (query.ParentId == seriesId || query.ParentId == seasonId)
                {
                    return new BaseItem[] { episode };
                }

                return Array.Empty<BaseItem>();
            },
        };

        using var service = NewService(library);
        service.SeedEntryForTest(Key(seriesId), new TagCacheEntry { Type = "Series" });
        var staleSeasonInherited = StaleInherited();
        staleSeasonInherited.SeriesId = Key(seriesId);
        service.SeedEntryForTest(Key(seasonId), staleSeasonInherited);
        var staleEpisodeInherited = StaleInherited();
        staleEpisodeInherited.SeriesId = Key(seriesId);
        staleEpisodeInherited.SeasonId = Key(seasonId);
        staleEpisodeInherited.Genres = Array.Empty<string>();
        service.SeedEntryForTest(Key(episodeId), staleEpisodeInherited);
        var unrelated = new TagCacheEntry { Type = "Movie", Genres = new[] { "Untouched" } };
        service.SeedEntryForTest(Key(unrelatedId), unrelated);
        using var monitor = new TagCacheMonitor(library, service, NullLogger<TagCacheMonitor>.Instance);
        monitor.Initialize();

        library.RaiseItemUpdated(series);
        service.FlushPendingForTest();

        AssertInheritedSeriesFields(service.GetEntryForTest(Key(seasonId)));
        AssertInheritedSeriesFields(service.GetEntryForTest(Key(episodeId)));
        Assert.Same(unrelated, service.GetEntryForTest(Key(unrelatedId)));
        Assert.DoesNotContain(unrelatedId, resolvedIds);
        Assert.Contains(queries, query => query.AncestorIds?.SequenceEqual(new[] { seriesId }) == true);
        Assert.DoesNotContain(
            queries,
            query => query.ParentId == Guid.Empty && (query.AncestorIds == null || query.AncestorIds.Length == 0));
        Assert.Equal(1, service.PendingChangeCountForTest); // inconsistent foreign row retains retry ownership

        var seasonEntry = service.GetEntryForTest(Key(seasonId));
        var episodeEntry = service.GetEntryForTest(Key(episodeId));
        Assert.Equal(new[] { "Updated" }, seasonEntry!.Genres);
        Assert.Empty(episodeEntry!.Genres!); // Episode Genres are own-item data, not Series-inherited.
    }

    [Fact]
    public void SeriesGenreOnlyChange_RebuildsSeasonsButNotEpisodes()
    {
        var seriesId = Guid.NewGuid();
        var seasonId = Guid.NewGuid();
        var episodeId = Guid.NewGuid();
        var series = new StubSeries
        {
            Id = seriesId,
            CommunityRating = 8,
            CriticRating = 80,
            Genres = new[] { "Updated" },
            DateLastSaved = SavedAt,
            ProviderIds = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["Tmdb"] = "stable-series-tmdb",
            },
        };
        var season = new StubSeason
        {
            Id = seasonId,
            SeriesId = seriesId,
            Genres = Array.Empty<string>(),
            DateLastSaved = SavedAt,
        };
        var episode = new StubEpisode
        {
            Id = episodeId,
            SeriesId = seriesId,
            SeasonId = seasonId,
            Genres = Array.Empty<string>(),
            DateLastSaved = SavedAt,
        };
        var queries = new List<InternalItemsQuery>();
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => id == seriesId ? series : id == seasonId ? season : id == episodeId ? episode : null,
            GetItemListHook = query =>
            {
                queries.Add(query);
                if (query.AncestorIds?.Contains(seriesId) == true)
                {
                    // Return a broader result deliberately: relation/type verification must still
                    // exclude Episodes for a Series genre-only change.
                    return new BaseItem[] { season, episode };
                }

                return query.ParentId == seriesId || query.ParentId == seasonId
                    ? new BaseItem[] { episode }
                    : Array.Empty<BaseItem>();
            },
        };
        using var service = NewService(library);
        service.SeedEntryForTest(Key(seriesId), new TagCacheEntry
        {
            Type = "Series",
            TmdbId = "stable-series-tmdb",
            CommunityRating = 8,
            CriticRating = 80,
            Genres = new[] { "Old" },
        });
        service.SeedEntryForTest(Key(seasonId), new TagCacheEntry
        {
            Type = "Season",
            SeriesId = Key(seriesId),
            Genres = new[] { "Old" },
        });
        var episodeEntry = new TagCacheEntry
        {
            Type = "Episode",
            SeriesId = Key(seriesId),
            SeasonId = Key(seasonId),
            Genres = Array.Empty<string>(),
            CommunityRating = 8,
            CriticRating = 80,
            SeriesTmdbId = "stable-series-tmdb",
            SourceRevision = SavedAt.Ticks,
        };
        service.SeedEntryForTest(Key(episodeId), episodeEntry);
        using var monitor = new TagCacheMonitor(library, service, NullLogger<TagCacheMonitor>.Instance);
        monitor.Initialize();

        library.RaiseItemUpdated(series);
        service.FlushPendingForTest();

        Assert.Equal(new[] { "Updated" }, service.GetEntryForTest(Key(seasonId))!.Genres);
        Assert.Same(episodeEntry, service.GetEntryForTest(Key(episodeId)));
        var descendantQuery = Assert.Single(queries, query => query.AncestorIds?.Contains(seriesId) == true);
        Assert.Equal(new[] { BaseItemKind.Episode, BaseItemKind.Season }, descendantQuery.IncludeItemTypes);
    }

    [Fact]
    public void SeriesRatingChange_RebuildsOnlyDescendantsWithoutOwnRatings()
    {
        var seriesId = Guid.NewGuid();
        var inheritingEpisodeId = Guid.NewGuid();
        var ownEpisodeId = Guid.NewGuid();
        var inheritingSeasonId = Guid.NewGuid();
        var ownSeasonId = Guid.NewGuid();
        var criticZeroEpisodeId = Guid.NewGuid();
        var criticSevenSeasonId = Guid.NewGuid();
        var series = new StubSeries
        {
            Id = seriesId,
            CommunityRating = 9,
            CriticRating = 90,
            Genres = new[] { "Stable" },
            ProviderIds = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Tmdb"] = "stable" },
            DateLastSaved = SavedAt,
        };
        var inheritingEpisode = new StubEpisode { Id = inheritingEpisodeId, SeriesId = seriesId, DateLastSaved = SavedAt };
        var ownEpisode = new StubEpisode { Id = ownEpisodeId, SeriesId = seriesId, CommunityRating = 6, CriticRating = 60, DateLastSaved = SavedAt };
        var inheritingSeason = new StubSeason { Id = inheritingSeasonId, SeriesId = seriesId, Genres = new[] { "Stable" }, DateLastSaved = SavedAt };
        var ownSeason = new StubSeason { Id = ownSeasonId, SeriesId = seriesId, CommunityRating = 7, CriticRating = 70, Genres = new[] { "Stable" }, DateLastSaved = SavedAt };
        var criticZeroEpisode = new StubEpisode { Id = criticZeroEpisodeId, SeriesId = seriesId, CriticRating = 0, DateLastSaved = SavedAt };
        var criticSevenSeason = new StubSeason { Id = criticSevenSeasonId, SeriesId = seriesId, CriticRating = 7, Genres = new[] { "Stable" }, DateLastSaved = SavedAt };
        var items = new Dictionary<Guid, BaseItem>
        {
            [seriesId] = series,
            [inheritingEpisodeId] = inheritingEpisode,
            [ownEpisodeId] = ownEpisode,
            [inheritingSeasonId] = inheritingSeason,
            [ownSeasonId] = ownSeason,
            [criticZeroEpisodeId] = criticZeroEpisode,
            [criticSevenSeasonId] = criticSevenSeason,
        };
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => items.GetValueOrDefault(id),
            GetItemListHook = query => query.AncestorIds?.Contains(seriesId) == true
                ? new BaseItem[] { inheritingEpisode, ownEpisode, inheritingSeason, ownSeason, criticZeroEpisode, criticSevenSeason }
                : Array.Empty<BaseItem>(),
        };
        using var service = NewService(library);
        service.SeedEntryForTest(Key(seriesId), new TagCacheEntry
        {
            Type = "Series",
            TmdbId = "stable",
            CommunityRating = 1,
            CriticRating = 10,
            Genres = new[] { "Stable" },
        });
        service.SeedEntryForTest(Key(inheritingEpisodeId), new TagCacheEntry { Type = "Episode", SeriesId = Key(seriesId), SeriesTmdbId = "stable", CommunityRating = 1, CriticRating = 10, SourceRevision = SavedAt.Ticks });
        service.SeedEntryForTest(Key(inheritingSeasonId), new TagCacheEntry { Type = "Season", SeriesId = Key(seriesId), SeriesTmdbId = "stable", CommunityRating = 1, CriticRating = 10, Genres = new[] { "Stable" }, SourceRevision = SavedAt.Ticks });
        var ownEpisodeEntry = new TagCacheEntry { Type = "Episode", SeriesId = Key(seriesId), SeriesTmdbId = "stable", CommunityRating = 6, CriticRating = 60, SourceRevision = SavedAt.Ticks };
        var ownSeasonEntry = new TagCacheEntry { Type = "Season", SeriesId = Key(seriesId), SeriesTmdbId = "stable", CommunityRating = 7, CriticRating = 70, Genres = new[] { "Stable" }, SourceRevision = SavedAt.Ticks };
        var criticZeroEpisodeEntry = new TagCacheEntry { Type = "Episode", SeriesId = Key(seriesId), SeriesTmdbId = "stable", CommunityRating = null, CriticRating = 0, SourceRevision = SavedAt.Ticks };
        var criticSevenSeasonEntry = new TagCacheEntry { Type = "Season", SeriesId = Key(seriesId), SeriesTmdbId = "stable", CommunityRating = null, CriticRating = 7, Genres = new[] { "Stable" }, SourceRevision = SavedAt.Ticks };
        service.SeedEntryForTest(Key(ownEpisodeId), ownEpisodeEntry);
        service.SeedEntryForTest(Key(ownSeasonId), ownSeasonEntry);
        service.SeedEntryForTest(Key(criticZeroEpisodeId), criticZeroEpisodeEntry);
        service.SeedEntryForTest(Key(criticSevenSeasonId), criticSevenSeasonEntry);
        using var monitor = new TagCacheMonitor(library, service, NullLogger<TagCacheMonitor>.Instance);
        monitor.Initialize();

        library.RaiseItemUpdated(series);
        service.FlushPendingForTest();

        Assert.Equal(9, service.GetEntryForTest(Key(inheritingEpisodeId))!.CommunityRating);
        Assert.Equal(9, service.GetEntryForTest(Key(inheritingSeasonId))!.CommunityRating);
        Assert.Same(ownEpisodeEntry, service.GetEntryForTest(Key(ownEpisodeId)));
        Assert.Same(ownSeasonEntry, service.GetEntryForTest(Key(ownSeasonId)));
        Assert.Same(criticZeroEpisodeEntry, service.GetEntryForTest(Key(criticZeroEpisodeId)));
        Assert.Same(criticSevenSeasonEntry, service.GetEntryForTest(Key(criticSevenSeasonId)));
    }

    [Theory]
    [InlineData("pt-BR")]
    [InlineData(null)]
    public void SeriesOriginalLanguageOnlyChange_RefreshesInheritingEpisodeAndSeason(
        string? replacementLanguage)
    {
        var seriesId = Guid.NewGuid();
        var seasonId = Guid.NewGuid();
        var episodeId = Guid.NewGuid();
        var series = new StubSeries
        {
            Id = seriesId,
            OriginalLanguage = replacementLanguage,
            CommunityRating = 8,
            CriticRating = 80,
            Genres = new[] { "Stable" },
            ProviderIds = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Tmdb"] = "stable" },
            DateLastSaved = SavedAt.AddMinutes(1),
        };
        var season = new StubSeason
        {
            Id = seasonId,
            SeriesId = seriesId,
            CommunityRating = 8,
            CriticRating = 80,
            Genres = new[] { "Stable" },
            DateLastSaved = SavedAt,
        };
        var episode = new StubEpisode
        {
            Id = episodeId,
            SeriesId = seriesId,
            SeasonId = seasonId,
            CommunityRating = 8,
            CriticRating = 80,
            Genres = new[] { "Own" },
            DateLastSaved = SavedAt,
        };
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => id == seriesId ? series : id == seasonId ? season : id == episodeId ? episode : null,
            GetItemListHook = query => query.AncestorIds?.Contains(seriesId) == true
                ? new BaseItem[] { season, episode }
                : query.ParentId == seriesId || query.ParentId == seasonId
                    ? new BaseItem[] { episode }
                    : Array.Empty<BaseItem>(),
        };
        using var service = NewService(library);
        service.SeedEntryForTest(Key(seriesId), new TagCacheEntry
        {
            Type = "Series",
            TmdbId = "stable",
            CommunityRating = 8,
            CriticRating = 80,
            Genres = new[] { "Stable" },
            OriginalLanguage = "ja",
        });
        var seasonGenres = new[] { "Stable" };
        var episodeGenres = new[] { "Own" };
        var episodeLanguages = new[] { "ja", "pt-br" };
        var seasonStream = new TagStreamData { ItemName = "season sentinel" };
        var episodeStream = new TagStreamData { ItemName = "episode sentinel" };
        service.SeedEntryForTest(Key(seasonId), new TagCacheEntry
        {
            Type = "Season",
            SeriesId = Key(seriesId),
            SeriesTmdbId = "stable",
            CommunityRating = 8,
            CriticRating = 80,
            Genres = seasonGenres,
            OriginalLanguage = "ja",
            StreamData = seasonStream,
            SourceRevision = SavedAt.Ticks,
        });
        service.SeedEntryForTest(Key(episodeId), new TagCacheEntry
        {
            Type = "Episode",
            SeriesId = Key(seriesId),
            SeasonId = Key(seasonId),
            SeriesTmdbId = "stable",
            CommunityRating = 8,
            CriticRating = 80,
            Genres = episodeGenres,
            AudioLanguages = episodeLanguages,
            OriginalLanguage = "ja",
            StreamData = episodeStream,
            SourceRevision = SavedAt.Ticks,
        });
        using var monitor = new TagCacheMonitor(library, service, NullLogger<TagCacheMonitor>.Instance);
        monitor.Initialize();

        library.RaiseItemUpdated(series);
        service.FlushPendingForTest();

        var refreshedSeason = service.GetEntryForTest(Key(seasonId))!;
        var refreshedEpisode = service.GetEntryForTest(Key(episodeId))!;
        Assert.Equal(replacementLanguage, refreshedSeason.OriginalLanguage);
        Assert.Equal(replacementLanguage, refreshedEpisode.OriginalLanguage);
        Assert.Same(seasonGenres, refreshedSeason.Genres);
        Assert.Same(episodeGenres, refreshedEpisode.Genres);
        Assert.Same(episodeLanguages, refreshedEpisode.AudioLanguages);
        Assert.Same(seasonStream, refreshedSeason.StreamData);
        Assert.Same(episodeStream, refreshedEpisode.StreamData);
        Assert.Equal(SavedAt.Ticks, refreshedSeason.SourceRevision);
        Assert.Equal(SavedAt.Ticks, refreshedEpisode.SourceRevision);

        var accessible = new Dictionary<string, TagCacheEntry>(StringComparer.Ordinal)
        {
            [Key(seriesId)] = service.GetEntryForTest(Key(seriesId))!,
            [Key(seasonId)] = refreshedSeason,
            [Key(episodeId)] = refreshedEpisode,
        };
        var coverage = new TagLanguageCoverageProjector(
                library,
                service,
                NullLogger.Instance)
            .ProjectAccessibleSnapshot(accessible, CancellationToken.None);
        var expectedOriginals = replacementLanguage == null
            ? Array.Empty<string>()
            : new[] { replacementLanguage };
        Assert.Equal(expectedOriginals, coverage[Key(seriesId)].OriginalLanguages);
        Assert.Equal(expectedOriginals, coverage[Key(seasonId)].OriginalLanguages);
    }

    [Fact]
    public void SeriesOriginalLanguageOnlyChange_PreservesExplicitDescendantOverrides()
    {
        var seriesId = Guid.NewGuid();
        var season = new StubSeason
        {
            Id = Guid.NewGuid(), SeriesId = seriesId, OriginalLanguage = "fr", CommunityRating = 8,
            CriticRating = 80, Genres = new[] { "Stable" }, DateLastSaved = SavedAt,
        };
        var episode = new StubEpisode
        {
            Id = Guid.NewGuid(), SeriesId = seriesId, SeasonId = season.Id, OriginalLanguage = "de",
            CommunityRating = 8, CriticRating = 80, Genres = new[] { "Own" }, DateLastSaved = SavedAt,
        };
        var series = new StubSeries
        {
            Id = seriesId, OriginalLanguage = "pt-BR", CommunityRating = 8, CriticRating = 80,
            Genres = new[] { "Stable" }, DateLastSaved = SavedAt.AddMinutes(1),
            ProviderIds = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Tmdb"] = "stable" },
        };
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => id == seriesId ? series : null,
            GetItemListHook = query => query.AncestorIds?.Contains(seriesId) == true
                ? new BaseItem[] { season, episode }
                : query.ParentId == seriesId || query.ParentId == season.Id
                    ? new BaseItem[] { episode }
                    : Array.Empty<BaseItem>(),
        };
        using var service = NewService(library);
        service.SeedEntryForTest(Key(seriesId), new TagCacheEntry
        {
            Type = "Series", TmdbId = "stable", CommunityRating = 8, CriticRating = 80,
            Genres = new[] { "Stable" }, OriginalLanguage = "ja",
        });
        var seasonEntry = new TagCacheEntry
        {
            Type = "Season", SeriesId = Key(seriesId), SeriesTmdbId = "stable", CommunityRating = 8,
            CriticRating = 80, Genres = new[] { "Stable" }, OriginalLanguage = "fr", SourceRevision = SavedAt.Ticks,
        };
        var episodeEntry = new TagCacheEntry
        {
            Type = "Episode", SeriesId = Key(seriesId), SeasonId = Key(season.Id), SeriesTmdbId = "stable",
            CommunityRating = 8, CriticRating = 80, Genres = new[] { "Own" }, OriginalLanguage = "de",
            SourceRevision = SavedAt.Ticks,
        };
        service.SeedEntryForTest(Key(season.Id), seasonEntry);
        service.SeedEntryForTest(Key(episode.Id), episodeEntry);
        using var monitor = new TagCacheMonitor(library, service, NullLogger<TagCacheMonitor>.Instance);
        monitor.Initialize();

        library.RaiseItemUpdated(series);
        service.FlushPendingForTest();

        Assert.Same(seasonEntry, service.GetEntryForTest(Key(season.Id)));
        Assert.Same(episodeEntry, service.GetEntryForTest(Key(episode.Id)));
        Assert.Equal("fr", seasonEntry.OriginalLanguage);
        Assert.Equal("de", episodeEntry.OriginalLanguage);
    }

    [Fact]
    public void SeriesOwnGenreChange_RepairsSeasonWhenEffectiveSeriesGenreWasAlreadyEqual()
    {
        var seriesId = Guid.NewGuid();
        var seasonId = Guid.NewGuid();
        var seriesFirst = new StubEpisode { Id = Guid.NewGuid(), SeriesId = seriesId, Genres = new[] { "Drama" } };
        var seasonFirst = new StubEpisode { Id = Guid.NewGuid(), SeriesId = seriesId, SeasonId = seasonId, Genres = Array.Empty<string>() };
        var series = new StubSeries { Id = seriesId, Genres = new[] { "Drama" }, DateLastSaved = SavedAt };
        var season = new StubSeason { Id = seasonId, SeriesId = seriesId, Genres = Array.Empty<string>(), DateLastSaved = SavedAt };
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => id == seriesId ? series : id == seasonId ? season : null,
            GetItemListHook = query => query.AncestorIds?.Contains(seriesId) == true
                ? new BaseItem[] { season }
                : query.ParentId == seasonId
                    ? new BaseItem[] { seasonFirst }
                    : query.ParentId == seriesId
                        ? new BaseItem[] { seriesFirst }
                        : Array.Empty<BaseItem>(),
        };
        using var service = NewService(library);
        // The old Series entry's effective genre came from its first Episode. Its value is
        // already "Drama", but the raw Series genre newly becoming "Drama" must still flow to
        // a different Season whose own/first-Episode genres are empty.
        service.SeedEntryForTest(Key(seriesId), new TagCacheEntry { Type = "Series", Genres = new[] { "Drama" } });
        service.SeedEntryForTest(Key(seasonId), new TagCacheEntry { Type = "Season", Genres = Array.Empty<string>() });
        using var monitor = new TagCacheMonitor(library, service, NullLogger<TagCacheMonitor>.Instance);
        monitor.Initialize();

        library.RaiseItemUpdated(series);
        service.FlushPendingForTest();

        Assert.Equal(new[] { "Drama" }, service.GetEntryForTest(Key(seasonId))!.Genres);
    }

    [Fact]
    public void NoOpSeriesUpdate_DoesNotDiscoverOrRebuildDescendants()
    {
        var seriesId = Guid.NewGuid();
        var seasonId = Guid.NewGuid();
        var episodeId = Guid.NewGuid();
        var series = new StubSeries
        {
            Id = seriesId,
            CommunityRating = 8,
            CriticRating = 80,
            Genres = Array.Empty<string>(),
            DateLastSaved = SavedAt,
            ProviderIds = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["Tmdb"] = "stable-series-tmdb",
            },
        };
        var episode = new StubEpisode
        {
            Id = episodeId,
            SeriesId = seriesId,
            SeasonId = seasonId,
            Genres = new[] { "Fallback" },
            DateLastSaved = SavedAt,
        };
        var resolvedIds = new List<Guid>();
        var queries = new List<InternalItemsQuery>();
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id =>
            {
                resolvedIds.Add(id);
                return id == seriesId ? series : null;
            },
            GetItemListHook = query =>
            {
                queries.Add(query);
                return query.ParentId == seriesId ? new BaseItem[] { episode } : Array.Empty<BaseItem>();
            },
        };

        using var service = NewService(library);
        service.SeedEntryForTest(Key(seriesId), new TagCacheEntry
        {
            Type = "Series",
            TmdbId = "stable-series-tmdb",
            CommunityRating = 8,
            CriticRating = 80,
            Genres = new[] { "Fallback" },
        });
        var seasonEntry = StaleInherited();
        var episodeEntry = StaleInherited();
        service.SeedEntryForTest(Key(seasonId), seasonEntry);
        service.SeedEntryForTest(Key(episodeId), episodeEntry);
        using var monitor = new TagCacheMonitor(library, service, NullLogger<TagCacheMonitor>.Instance);
        monitor.Initialize();

        library.RaiseItemUpdated(series);
        service.FlushPendingForTest();

        Assert.All(resolvedIds, id => Assert.Equal(seriesId, id));
        Assert.Single(queries, query => query.AncestorIds?.Contains(seriesId) == true);
        Assert.Same(seasonEntry, service.GetEntryForTest(Key(seasonId)));
        Assert.Same(episodeEntry, service.GetEntryForTest(Key(episodeId)));
        Assert.Equal(1, service.ContentRevision);
    }

    [Fact]
    public void LargeSeriesWorker_UsesOneAncestorQueryAndRebuildsOnlyOneInheritor()
    {
        const int DescendantCount = 1_000;
        var seriesId = Guid.NewGuid();
        var series = new StubSeries
        {
            Id = seriesId,
            CommunityRating = 9,
            CriticRating = 90,
            ProviderIds = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Tmdb"] = "stable" },
            DateLastSaved = SavedAt,
        };
        var descendants = Enumerable.Range(0, DescendantCount)
            .Select(index => new StubEpisode
            {
                Id = Guid.NewGuid(),
                SeriesId = seriesId,
                CommunityRating = index == 0 ? null : 5,
                CriticRating = index == 0 ? null : 50,
                DateLastSaved = SavedAt,
            })
            .ToArray();
        var items = descendants.ToDictionary<BaseItem, Guid, BaseItem>(item => item.Id, item => item);
        items[seriesId] = series;
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => items.GetValueOrDefault(id),
            GetItemListHook = query => query.AncestorIds?.Contains(seriesId) == true
                ? descendants
                : Array.Empty<BaseItem>(),
        };
        using var service = NewService(library);
        service.SeedEntryForTest(Key(seriesId), new TagCacheEntry { Type = "Series", TmdbId = "stable", CommunityRating = 1, CriticRating = 10 });
        TagCacheEntry? ownRatingSentinel = null;
        for (var index = 0; index < descendants.Length; index++)
        {
            var entry = new TagCacheEntry
            {
                Type = "Episode",
                SeriesId = Key(seriesId),
                SeriesTmdbId = "stable",
                CommunityRating = index == 0 ? 1 : 5,
                CriticRating = index == 0 ? 10 : 50,
                SourceRevision = SavedAt.Ticks,
            };
            service.SeedEntryForTest(Key(descendants[index].Id), entry);
            if (index == 1) ownRatingSentinel = entry;
        }
        using var monitor = new TagCacheMonitor(library, service, NullLogger<TagCacheMonitor>.Instance);
        monitor.Initialize();

        library.RaiseItemUpdated(series);
        service.FlushPendingForTest();

        Assert.Equal(2, library.GetItemListCallCount); // one ancestor query + Series first-Episode probe
        Assert.Equal(2, library.GetItemByIdCallCount); // Series discovery + Series rebuild; descendant uses snapshot
        Assert.Equal(9, service.GetEntryForTest(Key(descendants[0].Id))!.CommunityRating);
        Assert.Same(ownRatingSentinel, service.GetEntryForTest(Key(descendants[1].Id)));
    }

    [Fact]
    public void EpisodeRelationshipRefresh_PreservesCriticOnlyChildRating()
    {
        var oldSeriesId = Guid.NewGuid();
        var newSeriesId = Guid.NewGuid();
        var newSeasonId = Guid.NewGuid();
        var series = new StubSeries
        {
            Id = newSeriesId,
            CommunityRating = 9,
            CriticRating = 90,
            ProviderIds = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Tmdb"] = "new-series" },
        };
        var episode = new StubEpisode
        {
            Id = Guid.NewGuid(),
            SeriesId = newSeriesId,
            SeasonId = newSeasonId,
            ParentIndexNumber = 2,
            CommunityRating = null,
            CriticRating = 7,
        };
        var existing = new TagCacheEntry
        {
            Type = "Episode",
            SeriesId = Key(oldSeriesId),
            CommunityRating = null,
            CriticRating = 7,
        };

        var refreshed = TagCacheDependencyGraph.ApplySeasonRelationshipRefresh(
            series,
            episode,
            existing,
            lastUpdated: 123);

        Assert.Equal(Key(newSeriesId), refreshed.SeriesId);
        Assert.Equal(Key(newSeasonId), refreshed.SeasonId);
        Assert.Equal("new-series", refreshed.SeriesTmdbId);
        Assert.Equal(2, refreshed.SeasonNumber);
        Assert.Null(refreshed.CommunityRating);
        Assert.Equal(7, refreshed.CriticRating);
    }

    [Fact]
    public void ParentSeriesCacheRefresh_CriticOnlyChildIgnoresParentRatingChanges()
    {
        var series = new TagCacheEntry
        {
            TmdbId = "stable-series",
            CommunityRating = 9,
            CriticRating = 90,
        };
        var episode = new StubEpisode
        {
            CommunityRating = null,
            CriticRating = 7,
        };
        var existing = new TagCacheEntry
        {
            Type = "Episode",
            SeriesTmdbId = "stable-series",
            CommunityRating = null,
            CriticRating = 7,
        };

        var changed = TagCacheDependencyGraph.TryPrepareParentSeriesRefreshFromCache(
            series,
            episode,
            existing,
            lastUpdated: 123,
            out var refreshed);

        Assert.False(changed);
        Assert.Null(refreshed);
    }

    [Fact]
    public void ParentSeriesCacheRefresh_TmdbChangePreservesCriticOnlyChildRating()
    {
        var series = new TagCacheEntry
        {
            TmdbId = "new-series",
            CommunityRating = 9,
            CriticRating = 90,
        };
        var episode = new StubEpisode
        {
            CommunityRating = null,
            CriticRating = 7,
        };
        var existing = new TagCacheEntry
        {
            Type = "Episode",
            SeriesTmdbId = "old-series",
            CommunityRating = null,
            CriticRating = 7,
        };

        var changed = TagCacheDependencyGraph.TryPrepareParentSeriesRefreshFromCache(
            series,
            episode,
            existing,
            lastUpdated: 123,
            out var refreshed);

        Assert.True(changed);
        Assert.NotNull(refreshed);
        Assert.Equal("new-series", refreshed!.SeriesTmdbId);
        Assert.Null(refreshed.CommunityRating);
        Assert.Equal(7, refreshed.CriticRating);
        Assert.Equal(123, refreshed.LastUpdated);
    }

    [Fact]
    public void EpisodeRelationshipCacheRefresh_PreservesCriticOnlyChildRating()
    {
        var newSeriesId = Guid.NewGuid();
        var newSeasonId = Guid.NewGuid();
        var series = new TagCacheEntry
        {
            TmdbId = "new-series",
            CommunityRating = 9,
            CriticRating = 90,
        };
        var episode = new StubEpisode
        {
            SeriesId = newSeriesId,
            SeasonId = newSeasonId,
            ParentIndexNumber = 2,
            CommunityRating = null,
            CriticRating = 0,
        };
        var existing = new TagCacheEntry
        {
            Type = "Episode",
            CommunityRating = null,
            CriticRating = 0,
        };

        var refreshed = TagCacheDependencyGraph.ApplySeasonRelationshipRefreshFromCache(
            series,
            episode,
            existing,
            lastUpdated: 123);

        Assert.Equal(Key(newSeriesId), refreshed.SeriesId);
        Assert.Equal(Key(newSeasonId), refreshed.SeasonId);
        Assert.Equal("new-series", refreshed.SeriesTmdbId);
        Assert.Equal(2, refreshed.SeasonNumber);
        Assert.Null(refreshed.CommunityRating);
        Assert.Equal(0, refreshed.CriticRating);
        Assert.Equal(123, refreshed.LastUpdated);
    }

    [Fact]
    public void LargeSeriesEvent_RepairsOneThousandStaleEpisodeRelationshipsWithoutScalarRebuilds()
    {
        const int EpisodeCount = 1_000;
        var oldSeriesId = Guid.NewGuid();
        var newSeriesId = Guid.NewGuid();
        var probeCount = 0;
        var oldSeries = new StubSeries { Id = oldSeriesId, DateLastSaved = SavedAt };
        var newSeries = new StubSeries
        {
            Id = newSeriesId,
            ProviderIds = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Tmdb"] = "stable" },
            DateLastSaved = SavedAt,
        };
        var episodes = Enumerable.Range(0, EpisodeCount)
            .Select(_ => new CountingEpisode
            {
                Id = Guid.NewGuid(),
                SeriesId = newSeriesId,
                CommunityRating = 5,
                CriticRating = 50,
                DateLastSaved = SavedAt,
                OnProbe = () => probeCount++,
            })
            .ToArray();
        var oldFirst = new CountingEpisode
        {
            Id = Guid.NewGuid(),
            SeriesId = oldSeriesId,
            DateLastSaved = SavedAt,
            OnProbe = () => probeCount++,
        };
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => id == oldSeriesId
                ? oldSeries
                : id == newSeriesId
                    ? newSeries
                    : throw new InvalidOperationException("relationship repair must not resolve Episodes individually"),
            GetItemListHook = query => query.AncestorIds?.Contains(newSeriesId) == true
                || query.ParentId == newSeriesId
                    ? episodes
                    : query.ItemIds?.Contains(oldSeriesId) == true
                        ? new BaseItem[] { oldSeries }
                    : query.ParentId == oldSeriesId
                        ? new BaseItem[] { oldFirst }
                        : throw new InvalidOperationException("unexpected relationship repair query"),
        };
        using var service = NewService(library);
        service.SeedEntryForTest(Key(oldSeriesId), new TagCacheEntry { Type = "Series" });
        service.SeedEntryForTest(Key(newSeriesId), new TagCacheEntry { Type = "Series", TmdbId = "stable" });
        foreach (var episode in episodes)
        {
            service.SeedEntryForTest(Key(episode.Id), new TagCacheEntry
            {
                Type = "Episode",
                SeriesId = Key(oldSeriesId),
                SeriesTmdbId = "stable",
                CommunityRating = 5,
                CriticRating = 50,
                StreamSourceId = Key(episode.Id),
                SourceRevision = SavedAt.Ticks,
            });
        }

        var allocatedBefore = GC.GetAllocatedBytesForCurrentThread();
        service.EnqueueItemChange(newSeries, removed: false);
        service.FlushPendingForTest();
        var workerAllocatedBytes = GC.GetAllocatedBytesForCurrentThread() - allocatedBefore;

        Assert.Equal(3, library.GetItemByIdCallCount); // discovery + old/new Series rebuilds
        Assert.Equal(4, library.GetItemListCallCount); // subtree + old-owner confirmation + old/new first Episodes
        Assert.Equal(2, probeCount); // old/new Series projections; no descendant probe
        Assert.All(
            episodes,
            episode => Assert.Equal(Key(newSeriesId), service.GetEntryForTest(Key(episode.Id))!.SeriesId));
        Assert.True(
            workerAllocatedBytes < 1_650_000,
            $"Large-Series worker allocated {workerAllocatedBytes:N0} bytes (budget: 1,650,000)");
    }

    [Fact]
    public void PartialLargeSeriesSnapshot_RepairsTheOmittedStaleRelationshipByBulkId()
    {
        const int EpisodeCount = 1_000;
        var oldSeriesId = Guid.NewGuid();
        var newSeriesId = Guid.NewGuid();
        var oldSeries = new StubSeries { Id = oldSeriesId, DateLastSaved = SavedAt };
        var newSeries = new StubSeries { Id = newSeriesId, DateLastSaved = SavedAt };
        var episodes = Enumerable.Range(0, EpisodeCount)
            .Select(_ => new StubEpisode
            {
                Id = Guid.NewGuid(),
                SeriesId = newSeriesId,
                DateLastSaved = SavedAt,
            })
            .ToArray();
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => id == oldSeriesId ? oldSeries : id == newSeriesId ? newSeries : null,
            GetItemListHook = query => query.AncestorIds?.Contains(newSeriesId) == true
                ? episodes.Take(EpisodeCount - 1).ToArray()
                : query.ItemIds?.Contains(oldSeriesId) == true
                    ? new BaseItem[] { oldSeries }
                    : query.ItemIds?.Length > 0
                        ? episodes.Where(episode => query.ItemIds.Contains(episode.Id)).ToArray()
                        : query.ParentId == newSeriesId
                            ? episodes
                            : query.ParentId == oldSeriesId
                                ? Array.Empty<BaseItem>()
                                : throw new InvalidOperationException("unexpected partial stale-relationship query"),
        };
        using var service = NewService(library);
        service.SeedEntryForTest(Key(oldSeriesId), new TagCacheEntry { Type = "Series" });
        service.SeedEntryForTest(Key(newSeriesId), new TagCacheEntry { Type = "Series" });
        foreach (var episode in episodes)
        {
            service.SeedEntryForTest(Key(episode.Id), new TagCacheEntry
            {
                Type = "Episode",
                SeriesId = Key(oldSeriesId),
                SourceRevision = SavedAt.Ticks,
            });
        }

        service.EnqueueItemChange(newSeries, removed: false);
        service.FlushPendingForTest();

        Assert.Equal(3, library.GetItemByIdCallCount); // new discovery + old/new rebuilds
        Assert.Equal(5, library.GetItemListCallCount); // subtree + omitted id + owner + old/new probes
        Assert.All(
            episodes,
            episode => Assert.Equal(Key(newSeriesId), service.GetEntryForTest(Key(episode.Id))!.SeriesId));
        Assert.Equal(0, service.PendingChangeCountForTest);
    }

    [Fact]
    public void PartialSeriesSnapshot_RetainsRetryUntilEveryCachedDescendantIsDiscovered()
    {
        var seriesId = Guid.NewGuid();
        var series = new StubSeries
        {
            Id = seriesId,
            CommunityRating = 9,
            DateLastSaved = SavedAt,
        };
        var episodes = Enumerable.Range(0, 2)
            .Select(_ => new StubEpisode
            {
                Id = Guid.NewGuid(),
                SeriesId = seriesId,
                DateLastSaved = SavedAt,
            })
            .ToArray();
        var ancestorQueries = 0;
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => id == seriesId ? series : null,
            GetItemListHook = query => query.AncestorIds?.Contains(seriesId) == true
                ? ancestorQueries++ == 0 ? episodes.Take(1).ToArray() : episodes
                : query.ParentId == seriesId
                    ? episodes
                    : Array.Empty<BaseItem>(),
        };
        using var service = NewService(library);
        service.SeedEntryForTest(Key(seriesId), new TagCacheEntry
        {
            Type = "Series",
            CommunityRating = 1,
        });
        foreach (var episode in episodes)
        {
            service.SeedEntryForTest(Key(episode.Id), new TagCacheEntry
            {
                Type = "Episode",
                SeriesId = Key(seriesId),
                CommunityRating = 1,
                SourceRevision = SavedAt.Ticks,
            });
        }

        service.EnqueueItemChange(series, removed: false);
        service.FlushPendingForTest();

        Assert.Equal(9, service.GetEntryForTest(Key(episodes[0].Id))!.CommunityRating);
        Assert.Equal(1, service.GetEntryForTest(Key(episodes[1].Id))!.CommunityRating);
        Assert.Equal(1, service.PendingChangeCountForTest);

        service.FlushPendingForTest();

        Assert.All(episodes, episode => Assert.Equal(9, service.GetEntryForTest(Key(episode.Id))!.CommunityRating));
        Assert.Equal(0, service.PendingChangeCountForTest);
        Assert.Equal(2, ancestorQueries);
    }

    [Fact]
    public void MissingOldSeriesOwner_IsTombstonedWithoutAnUnboundedSyntheticRetry()
    {
        var oldSeriesId = Guid.NewGuid();
        var newSeriesId = Guid.NewGuid();
        var episodeId = Guid.NewGuid();
        var orphanSeasonId = Guid.NewGuid();
        var orphanEpisodeId = Guid.NewGuid();
        var newSeries = new StubSeries { Id = newSeriesId, DateLastSaved = SavedAt };
        var episode = new StubEpisode
        {
            Id = episodeId,
            SeriesId = newSeriesId,
            DateLastSaved = SavedAt,
        };
        var oldOwnerQueries = 0;
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => id == newSeriesId ? newSeries : null,
            GetItemListHook = query =>
            {
                if (query.AncestorIds?.Contains(newSeriesId) == true || query.ParentId == newSeriesId)
                {
                    return new BaseItem[] { episode };
                }

                if (query.ItemIds?.Contains(oldSeriesId) == true)
                {
                    oldOwnerQueries++;
                    return Array.Empty<BaseItem>();
                }

                if (query.ItemIds?.Length > 0)
                {
                    return Array.Empty<BaseItem>();
                }

                throw new InvalidOperationException("unexpected missing-owner query");
            },
        };
        using var service = NewService(library);
        service.SeedEntryForTest(Key(oldSeriesId), new TagCacheEntry { Type = "Series" });
        service.SeedEntryForTest(Key(newSeriesId), new TagCacheEntry { Type = "Series" });
        service.SeedEntryForTest(Key(orphanSeasonId), new TagCacheEntry
        {
            Type = "Season",
            SeriesId = Key(oldSeriesId),
        });
        service.SeedEntryForTest(Key(orphanEpisodeId), new TagCacheEntry
        {
            Type = "Episode",
            SeriesId = Key(oldSeriesId),
            SeasonId = Key(orphanSeasonId),
        });
        service.SeedEntryForTest(Key(episodeId), new TagCacheEntry
        {
            Type = "Episode",
            SeriesId = Key(oldSeriesId),
            SourceRevision = SavedAt.Ticks,
        });

        service.EnqueueItemChange(newSeries, removed: false);
        service.FlushPendingForTest();

        Assert.False(service.ContainsKeyForTest(Key(oldSeriesId)));
        Assert.False(service.ContainsKeyForTest(Key(orphanSeasonId)));
        Assert.False(service.ContainsKeyForTest(Key(orphanEpisodeId)));
        Assert.Equal(Key(newSeriesId), service.GetEntryForTest(Key(episodeId))!.SeriesId);
        Assert.Equal(0, service.PendingChangeCountForTest);
        Assert.Equal(1, oldOwnerQueries);
    }

    [Fact]
    public void MissingOldSeasonOwner_IsTombstonedWithoutRetryingTheSyntheticTarget()
    {
        var seriesId = Guid.NewGuid();
        var oldSeasonId = Guid.NewGuid();
        var newSeasonId = Guid.NewGuid();
        var episodeId = Guid.NewGuid();
        var series = new StubSeries { Id = seriesId, DateLastSaved = SavedAt };
        var newSeason = new StubSeason { Id = newSeasonId, SeriesId = seriesId, DateLastSaved = SavedAt };
        var episode = new StubEpisode
        {
            Id = episodeId,
            SeriesId = seriesId,
            SeasonId = newSeasonId,
            DateLastSaved = SavedAt,
        };
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => id == seriesId ? series : id == newSeasonId ? newSeason : null,
            GetItemListHook = query => query.AncestorIds?.Contains(seriesId) == true
                ? new BaseItem[] { newSeason, episode }
                : query.ItemIds?.Contains(oldSeasonId) == true
                    ? Array.Empty<BaseItem>()
                    : query.ParentId == seriesId || query.ParentId == newSeasonId
                        ? new BaseItem[] { episode }
                        : throw new InvalidOperationException("unexpected missing-Season query"),
        };
        using var service = NewService(library);
        service.SeedEntryForTest(Key(seriesId), new TagCacheEntry { Type = "Series" });
        service.SeedEntryForTest(Key(oldSeasonId), new TagCacheEntry { Type = "Season", SeriesId = Key(seriesId) });
        service.SeedEntryForTest(Key(newSeasonId), new TagCacheEntry { Type = "Season", SeriesId = Key(seriesId) });
        service.SeedEntryForTest(Key(episodeId), new TagCacheEntry
        {
            Type = "Episode",
            SeriesId = Key(seriesId),
            SeasonId = Key(oldSeasonId),
            SourceRevision = SavedAt.Ticks,
        });

        service.EnqueueItemChange(series, removed: false);
        service.FlushPendingForTest();

        Assert.False(service.ContainsKeyForTest(Key(oldSeasonId)));
        Assert.Equal(Key(newSeasonId), service.GetEntryForTest(Key(episodeId))!.SeasonId);
        Assert.Equal(0, service.PendingChangeCountForTest);
    }

    [Fact]
    public void PartialOldOwnerBulkResult_FallsBackBeforeRemovingALiveSeries()
    {
        var oldSeriesId = Guid.NewGuid();
        var newSeriesId = Guid.NewGuid();
        var episodeId = Guid.NewGuid();
        var oldSeries = new StubSeries { Id = oldSeriesId, DateLastSaved = SavedAt };
        var newSeries = new StubSeries { Id = newSeriesId, DateLastSaved = SavedAt };
        var episode = new StubEpisode
        {
            Id = episodeId,
            SeriesId = newSeriesId,
            DateLastSaved = SavedAt,
        };
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => id == oldSeriesId ? oldSeries : id == newSeriesId ? newSeries : null,
            GetItemListHook = query => query.AncestorIds?.Contains(newSeriesId) == true
                ? new BaseItem[] { episode }
                : query.ItemIds?.Contains(oldSeriesId) == true
                    ? Array.Empty<BaseItem>() // transiently partial owner lookup
                    : query.ParentId == newSeriesId
                        ? new BaseItem[] { episode }
                        : query.ParentId == oldSeriesId
                            ? Array.Empty<BaseItem>()
                            : throw new InvalidOperationException("unexpected partial-owner query"),
        };
        using var service = NewService(library);
        service.SeedEntryForTest(Key(oldSeriesId), new TagCacheEntry { Type = "Series" });
        service.SeedEntryForTest(Key(newSeriesId), new TagCacheEntry { Type = "Series" });
        service.SeedEntryForTest(Key(episodeId), new TagCacheEntry
        {
            Type = "Episode",
            SeriesId = Key(oldSeriesId),
            SourceRevision = SavedAt.Ticks,
        });

        service.EnqueueItemChange(newSeries, removed: false);
        service.FlushPendingForTest();

        Assert.True(service.ContainsKeyForTest(Key(oldSeriesId)));
        Assert.Equal(Key(newSeriesId), service.GetEntryForTest(Key(episodeId))!.SeriesId);
        Assert.Equal(0, service.PendingChangeCountForTest);
    }

    [Fact]
    public void LargeSeriesRelationshipRepair_RebuildsOnlyTheOneRevisedDescendant()
    {
        const int EpisodeCount = 1_000;
        var oldSeriesId = Guid.NewGuid();
        var newSeriesId = Guid.NewGuid();
        var probeCount = 0;
        var oldSeries = new StubSeries { Id = oldSeriesId, DateLastSaved = SavedAt };
        var newSeries = new StubSeries { Id = newSeriesId, DateLastSaved = SavedAt };
        var episodes = Enumerable.Range(0, EpisodeCount)
            .Select(index => new CountingEpisode
            {
                Id = Guid.NewGuid(),
                SeriesId = newSeriesId,
                DateLastSaved = index == 0 ? SavedAt.AddMinutes(1) : SavedAt,
                OnProbe = () => probeCount++,
            })
            .ToArray();
        var revisedEpisode = episodes[0];
        var oldFirst = new CountingEpisode
        {
            Id = Guid.NewGuid(),
            SeriesId = oldSeriesId,
            DateLastSaved = SavedAt,
            OnProbe = () => probeCount++,
        };
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => id == oldSeriesId
                ? oldSeries
                : id == newSeriesId
                    ? newSeries
                    : id == revisedEpisode.Id
                        ? revisedEpisode
                        : throw new InvalidOperationException("unchanged descendants must use prepared repairs"),
            GetItemListHook = query => query.AncestorIds?.Contains(newSeriesId) == true
                || query.ParentId == newSeriesId
                    ? episodes
                    : query.ItemIds?.Contains(oldSeriesId) == true
                        ? new BaseItem[] { oldSeries }
                        : query.ParentId == oldSeriesId
                            ? new BaseItem[] { oldFirst }
                            : throw new InvalidOperationException("unexpected mixed relationship-repair query"),
        };
        using var service = NewService(library);
        service.SeedEntryForTest(Key(oldSeriesId), new TagCacheEntry { Type = "Series" });
        service.SeedEntryForTest(Key(newSeriesId), new TagCacheEntry { Type = "Series" });
        foreach (var episode in episodes)
        {
            service.SeedEntryForTest(Key(episode.Id), new TagCacheEntry
            {
                Type = "Episode",
                SeriesId = Key(oldSeriesId),
                StreamSourceId = Key(episode.Id),
                SourceRevision = SavedAt.Ticks,
            });
        }

        service.EnqueueItemChange(newSeries, removed: false);
        service.FlushPendingForTest();

        Assert.Equal(5, library.GetItemByIdCallCount); // discovery + revised Episode/parent + old/new rebuilds
        Assert.Equal(4, library.GetItemListCallCount); // subtree + old-owner confirmation + old/new probes
        Assert.Equal(3, probeCount); // one revised Episode and the two Series projections
        Assert.All(
            episodes,
            episode => Assert.Equal(Key(newSeriesId), service.GetEntryForTest(Key(episode.Id))!.SeriesId));
        Assert.Equal(revisedEpisode.DateLastSaved.Ticks, service.GetEntryForTest(Key(revisedEpisode.Id))!.SourceRevision);
    }

    [Fact]
    public void LargeSeriesGenreRepair_UpdatesOneThousandInheritingSeasonsWithinConstantQueryBudget()
    {
        const int SeasonCount = 1_000;
        var seriesId = Guid.NewGuid();
        var series = new StubSeries { Id = seriesId, Genres = new[] { "Series" }, DateLastSaved = SavedAt };
        var seasons = Enumerable.Range(0, SeasonCount)
            .Select(_ => new StubSeason { Id = Guid.NewGuid(), SeriesId = seriesId, Genres = Array.Empty<string>() })
            .ToArray();
        var episodes = seasons
            .Select(season => new StubEpisode
            {
                Id = Guid.NewGuid(),
                SeriesId = seriesId,
                SeasonId = season.Id,
                Genres = Array.Empty<string>(),
            })
            .ToArray();
        var descendants = seasons.Cast<BaseItem>().Concat(episodes).ToArray();
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => id == seriesId ? series : null,
            GetItemListHook = query => query.AncestorIds?.Contains(seriesId) == true
                ? descendants
                : query.ParentId == seriesId
                    ? new BaseItem[] { episodes[0] }
                    : throw new InvalidOperationException("per-Season dependency query is forbidden"),
        };
        using var service = NewService(library);
        service.SeedEntryForTest(Key(seriesId), new TagCacheEntry { Type = "Series", Genres = new[] { "Old" } });
        foreach (var season in seasons)
        {
            service.SeedEntryForTest(Key(season.Id), new TagCacheEntry
            {
                Type = "Season",
                SeriesId = Key(seriesId),
                Genres = new[] { "Old" },
            });
        }
        foreach (var episode in episodes)
        {
            service.SeedEntryForTest(Key(episode.Id), new TagCacheEntry
            {
                Type = "Episode",
                SeriesId = Key(seriesId),
                SeasonId = Key(episode.SeasonId),
                Genres = Array.Empty<string>(),
            });
        }
        using var monitor = new TagCacheMonitor(library, service, NullLogger<TagCacheMonitor>.Instance);
        monitor.Initialize();

        library.RaiseItemUpdated(series);
        service.FlushPendingForTest();

        Assert.Equal(2, library.GetItemListCallCount); // one subtree snapshot + Series rebuild probe
        Assert.Equal(2, library.GetItemByIdCallCount); // Series discovery + Series rebuild
        Assert.All(
            seasons,
            season => Assert.Equal(new[] { "Series" }, service.GetEntryForTest(Key(season.Id))!.Genres));
        Assert.Equal(SeasonCount + 1, service.ContentRevision); // Series + every inheriting Season
    }

    [Fact]
    public void LargeSeasonReparent_RepairsOneThousandEpisodesWithinConstantLookupAndProbeBudget()
    {
        const int EpisodeCount = 1_000;
        var oldSeriesId = Guid.NewGuid();
        var newSeriesId = Guid.NewGuid();
        var seasonId = Guid.NewGuid();
        var probeCount = 0;
        var oldSeries = new StubSeries { Id = oldSeriesId, DateLastSaved = SavedAt };
        var newSeries = new StubSeries
        {
            Id = newSeriesId,
            CommunityRating = 9,
            CriticRating = 90,
            ProviderIds = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Tmdb"] = "new" },
            DateLastSaved = SavedAt,
        };
        var season = new StubSeason
        {
            Id = seasonId,
            SeriesId = newSeriesId,
            CommunityRating = 1,
            DateLastSaved = SavedAt,
        };
        var episodes = Enumerable.Range(0, EpisodeCount)
            .Select(_ => new CountingEpisode
            {
                Id = Guid.NewGuid(),
                SeriesId = newSeriesId,
                SeasonId = seasonId,
                DateLastSaved = SavedAt,
                OnProbe = () => probeCount++,
            })
            .ToArray();
        var oldFirst = new CountingEpisode
        {
            Id = Guid.NewGuid(),
            SeriesId = oldSeriesId,
            DateLastSaved = SavedAt,
            OnProbe = () => probeCount++,
        };
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => id == oldSeriesId
                ? oldSeries
                : id == newSeriesId
                    ? newSeries
                    : id == seasonId
                        ? season
                        : throw new InvalidOperationException("Season reparent must not resolve Episodes individually"),
            GetItemListHook = query => query.AncestorIds?.Contains(seasonId) == true
                ? episodes
                : query.ParentId == seasonId || query.ParentId == newSeriesId
                    ? episodes
                    : query.ParentId == oldSeriesId
                        ? new BaseItem[] { oldFirst }
                        : throw new InvalidOperationException("unexpected dependency query"),
        };
        using var service = NewService(library);
        service.SeedEntryForTest(Key(oldSeriesId), new TagCacheEntry { Type = "Series" });
        service.SeedEntryForTest(Key(newSeriesId), new TagCacheEntry { Type = "Series" });
        service.SeedEntryForTest(Key(seasonId), new TagCacheEntry
        {
            Type = "Season",
            SeriesId = Key(oldSeriesId),
        });
        foreach (var episode in episodes)
        {
            service.SeedEntryForTest(Key(episode.Id), new TagCacheEntry
            {
                Type = "Episode",
                SeriesId = Key(oldSeriesId),
                SeasonId = Key(seasonId),
                SeriesTmdbId = "old",
                CommunityRating = 1,
                CriticRating = 10,
                StreamSourceId = Key(episode.Id),
                SourceRevision = SavedAt.Ticks,
            });
        }

        service.EnqueueItemChange(season, removed: false);
        service.FlushPendingForTest();

        Assert.Equal(5, library.GetItemByIdCallCount);
        Assert.Equal(4, library.GetItemListCallCount);
        Assert.Equal(3, probeCount); // old Series + moved Season + new Series container projections only
        Assert.All(episodes, episode =>
        {
            var entry = service.GetEntryForTest(Key(episode.Id))!;
            Assert.Equal(Key(newSeriesId), entry.SeriesId);
            Assert.Equal("new", entry.SeriesTmdbId);
            Assert.Equal(9, entry.CommunityRating);
            Assert.Equal(90, entry.CriticRating);
        });
    }

    [Fact]
    public void LargeReconcile_ParentOnlySeriesChangeDoesNotReprobeOneThousandEpisodes()
    {
        const int EpisodeCount = 1_000;
        var dir = Path.Combine(Path.GetTempPath(), "jc-tagcache-large-reconcile-" + Guid.NewGuid().ToString("N"));
        try
        {
            var seriesId = Guid.NewGuid();
            var probeCount = 0;
            var series = new StubSeries
            {
                Id = seriesId,
                CommunityRating = 9,
                CriticRating = 90,
                ProviderIds = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Tmdb"] = "new" },
                DateLastSaved = SavedAt,
            };
            var episodes = Enumerable.Range(0, EpisodeCount)
                .Select(_ => new CountingEpisode
                {
                    Id = Guid.NewGuid(),
                    SeriesId = seriesId,
                    DateLastSaved = SavedAt,
                    OnProbe = () => probeCount++,
                })
                .ToArray();
            var allItems = new BaseItem[] { series }.Concat(episodes).ToArray();
            var library = new CountingLibraryManager
            {
                GetItemByIdHook = _ => throw new InvalidOperationException("reconcile snapshot must avoid scalar lookups"),
                GetItemListHook = query => query.ParentId == Guid.Empty
                    ? allItems
                        .Where(item => query.IncludeItemTypes.Contains(item.GetBaseItemKind()))
                        .Skip(query.StartIndex ?? 0)
                        .Take(query.Limit ?? allItems.Length)
                        .ToArray()
                    : query.ParentId == seriesId
                        ? episodes
                        : throw new InvalidOperationException("unexpected reconcile query"),
                GetItemsResultHook = query =>
                {
                    var filtered = allItems
                        .Where(item => query.IncludeItemTypes.Contains(item.GetBaseItemKind()))
                        .ToArray();
                    var page = filtered
                        .Skip(query.StartIndex ?? 0)
                        .Take(query.Limit ?? filtered.Length)
                        .ToArray();
                    return new MediaBrowser.Model.Querying.QueryResult<BaseItem>(
                        query.StartIndex,
                        filtered.Length,
                        page);
                },
            };
            using var service = new TagCacheService(
                library,
                new StubAppPaths(dir),
                NullLogger<TagCacheService>.Instance);
            service.SeedEntryForTest(Key(seriesId), new TagCacheEntry
            {
                Type = "Series",
                TmdbId = "old",
                CommunityRating = 1,
                CriticRating = 10,
                SourceRevision = SavedAt.Ticks,
            });
            foreach (var episode in episodes)
            {
                service.SeedEntryForTest(Key(episode.Id), new TagCacheEntry
                {
                    Type = "Episode",
                    SeriesId = Key(seriesId),
                    SeriesTmdbId = "old",
                    CommunityRating = 1,
                    CriticRating = 10,
                    StreamSourceId = Key(episode.Id),
                    StreamData = new TagStreamData { ItemPath = "unchanged.mkv" },
                    SourceRevision = SavedAt.Ticks,
                });
            }

            service.BuildFullCache(progress: null, CancellationToken.None);

            Assert.Equal(1, library.GetItemListCallCount); // Series first-Episode projection
            Assert.Equal(3, library.GetItemsResultCallCount); // one Series page + two fixed 500-row Episode pages
            Assert.Equal(0, library.GetItemByIdCallCount);
            Assert.Equal(1, probeCount); // Series projection only
            Assert.All(episodes, episode =>
            {
                var entry = service.GetEntryForTest(Key(episode.Id))!;
                Assert.Equal("new", entry.SeriesTmdbId);
                Assert.Equal(9, entry.CommunityRating);
                Assert.Equal(90, entry.CriticRating);
                Assert.Equal("unchanged.mkv", entry.StreamData!.ItemPath);
                Assert.Equal(SavedAt.Ticks, entry.SourceRevision);
            });
        }
        finally
        {
            try { Directory.Delete(dir, recursive: true); } catch { }
        }
    }

    [Fact]
    public void ExplicitEpisodeRemoval_WinsOverSameBatchSeriesDerivedUpdate()
    {
        var seriesId = Guid.NewGuid();
        var episodeId = Guid.NewGuid();
        var series = new StubSeries { Id = seriesId, DateLastSaved = SavedAt };
        var episode = new StubEpisode
        {
            Id = episodeId,
            SeriesId = seriesId,
            DateLastSaved = SavedAt,
        };
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => id == seriesId ? series : id == episodeId ? episode : null,
            // Simulate a stale descendant read that still returns the just-removed Episode.
            GetItemListHook = query => query.AncestorIds?.Contains(seriesId) == true
                ? new BaseItem[] { episode }
                : Array.Empty<BaseItem>(),
        };
        using var service = NewService(library);
        service.SeedEntryForTest(Key(seriesId), new TagCacheEntry { Type = "Series" });
        service.SeedEntryForTest(Key(episodeId), new TagCacheEntry { Type = "Episode" });
        using var monitor = new TagCacheMonitor(library, service, NullLogger<TagCacheMonitor>.Instance);
        monitor.Initialize();

        library.RaiseItemUpdated(series);
        library.RaiseItemRemoved(episode);
        service.FlushPendingForTest();

        Assert.False(service.ContainsKeyForTest(Key(episodeId)));
    }

    [Fact]
    public void DerivedSeriesRefresh_RetainsDirtyOwnershipAcrossProlongedOutage()
    {
        var episodeId = Guid.Parse("00000000-0000-0000-0000-000000000001");
        var seriesId = Guid.Parse("00000000-0000-0000-0000-000000000002");
        var oldSeries = new StubSeries
        {
            Id = seriesId,
            CommunityRating = 1,
            DateLastSaved = SavedAt,
        };
        var newSeries = new StubSeries
        {
            Id = seriesId,
            CommunityRating = 9,
            DateLastSaved = SavedAt.AddMinutes(1),
        };
        var episode = new StubEpisode
        {
            Id = episodeId,
            SeriesId = seriesId,
            CommunityRating = null,
            DateLastSaved = SavedAt,
        };
        var seriesReads = 0;
        var ancestorQueries = 0;
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => id == episodeId
                ? episode
                : id == seriesId
                    ? seriesReads++ == 0 ? oldSeries : newSeries
                    : null,
            GetItemListHook = query =>
            {
                if (query.AncestorIds?.Contains(seriesId) == true)
                {
                    ancestorQueries++;
                    if (ancestorQueries <= 5)
                    {
                        throw new InvalidOperationException("transient descendant discovery failure");
                    }

                    return new BaseItem[] { episode };
                }

                return query.ParentId == seriesId
                    ? new BaseItem[] { episode }
                    : Array.Empty<BaseItem>();
            },
        };
        using var service = NewService(library);
        service.SeedEntryForTest(Key(seriesId), new TagCacheEntry
        {
            Type = "Series",
            CommunityRating = 1,
        });
        service.SeedEntryForTest(Key(episodeId), new TagCacheEntry
        {
            Type = "Episode",
            CommunityRating = 1,
        });
        using var monitor = new TagCacheMonitor(library, service, NullLogger<TagCacheMonitor>.Instance);
        monitor.Initialize();

        library.RaiseItemUpdated(episode);
        service.FlushPendingForTest();

        Assert.Equal(1, service.PendingChangeCountForTest);
        Assert.Equal(1, service.GetEntryForTest(Key(episodeId))!.CommunityRating);
        Assert.Equal(9, service.GetEntryForTest(Key(seriesId))!.CommunityRating);

        // Five consecutive failures exceed the old three-attempt cap. Ownership remains queued
        // after every pass and the sixth attempt repairs the inheriting Episode.
        for (var attempt = 0; attempt < 5; attempt++)
        {
            service.FlushPendingForTest();
            Assert.Equal(1, service.PendingChangeCountForTest);
            Assert.Equal(1, service.GetEntryForTest(Key(episodeId))!.CommunityRating);
        }

        service.FlushPendingForTest();

        Assert.Equal(0, service.PendingChangeCountForTest);
        Assert.Equal(6, ancestorQueries);
        Assert.Equal(9, service.GetEntryForTest(Key(episodeId))!.CommunityRating);
    }

    [Fact]
    public void ItemAddedBeforeLibraryVisibility_IsRetriedUntilResolvable()
    {
        var episodeId = Guid.NewGuid();
        var visible = false;
        var episode = new StubEpisode { Id = episodeId, DateLastSaved = SavedAt };
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => visible && id == episodeId ? episode : null,
            GetItemListHook = _ => Array.Empty<BaseItem>(),
        };
        using var service = NewService(library);
        using var monitor = new TagCacheMonitor(library, service, NullLogger<TagCacheMonitor>.Instance);
        monitor.Initialize();

        library.RaiseItemAdded(episode);
        service.FlushPendingForTest();

        Assert.Equal(1, service.PendingChangeCountForTest);
        Assert.False(service.ContainsKeyForTest(Key(episodeId)));

        visible = true;
        service.FlushPendingForTest();

        Assert.Equal(0, service.PendingChangeCountForTest);
        Assert.True(service.ContainsKeyForTest(Key(episodeId)));
    }

    [Theory]
    [InlineData(1, 3)]
    [InlineData(2, 6)]
    [InlineData(3, 12)]
    [InlineData(8, 300)]
    [InlineData(255, 300)]
    public void RetryDelay_UsesBoundedExponentialBackoff(byte attempts, int expectedSeconds)
        => Assert.Equal(
            TimeSpan.FromSeconds(expectedSeconds),
            TagCacheService.ComputeRetryDelay(attempts));

    [Fact]
    public void Dispose_DoesNotResurrectFlushTimerWhenSeriesDiscoveryFails()
    {
        var seriesId = Guid.NewGuid();
        var series = new StubSeries { Id = seriesId, CommunityRating = 9, DateLastSaved = SavedAt };
        var library = new CountingLibraryManager
        {
            GetItemByIdHook = id => id == seriesId ? series : null,
            GetItemListHook = query => query.AncestorIds?.Contains(seriesId) == true
                ? throw new InvalidOperationException("shutdown discovery outage")
                : Array.Empty<BaseItem>(),
        };
        var service = NewService(library);
        service.SeedEntryForTest(Key(seriesId), new TagCacheEntry { Type = "Series", CommunityRating = 1 });
        using var monitor = new TagCacheMonitor(library, service, NullLogger<TagCacheMonitor>.Instance);
        monitor.Initialize();

        library.RaiseItemUpdated(series);
        Assert.True(service.HasFlushTimerForTest);

        service.Dispose();

        Assert.False(service.HasFlushTimerForTest);
        Assert.Equal(0, service.PendingChangeCountForTest);
        service.FlushPendingForTest();
        Assert.False(service.HasFlushTimerForTest);
    }

    [Fact]
    public void Dispose_UnresolvedRepairMarksDiskSnapshotIncompleteSoStartupDiscardsIt()
    {
        var dir = Path.Combine(Path.GetTempPath(), "jc-tagcache-incomplete-" + Guid.NewGuid().ToString("N"));
        try
        {
            var seriesId = Guid.NewGuid();
            var retainedId = Guid.NewGuid();
            var series = new StubSeries { Id = seriesId, CommunityRating = 9, DateLastSaved = SavedAt };
            var library = new CountingLibraryManager
            {
                GetItemByIdHook = id => id == seriesId ? series : null,
                GetItemListHook = query => query.AncestorIds?.Contains(seriesId) == true
                    ? throw new InvalidOperationException("shutdown discovery outage")
                    : Array.Empty<BaseItem>(),
            };
            var service = new TagCacheService(
                library,
                new StubAppPaths(dir),
                NullLogger<TagCacheService>.Instance);
            service.SeedEntryForTest(Key(retainedId), new TagCacheEntry { Type = "Movie" });
            service.EnqueueItemChange(series, removed: false);

            service.Dispose();

            using var loaded = new TagCacheService(
                library,
                new StubAppPaths(dir),
                NullLogger<TagCacheService>.Instance);
            loaded.LoadFromDisk();
            Assert.Equal(0, loaded.Count);
        }
        finally
        {
            try { Directory.Delete(dir, recursive: true); } catch { }
        }
    }

    [Fact]
    public async Task DisposeGuardTimeout_DuringCancelledReconcileMarksSnapshotIncomplete()
    {
        var dir = Path.Combine(Path.GetTempPath(), "jc-tagcache-reconcile-shutdown-" + Guid.NewGuid().ToString("N"));
        try
        {
            var movie = new StubMovie { Id = Guid.NewGuid(), DateLastSaved = SavedAt };
            using var entered = new ManualResetEventSlim();
            using var release = new ManualResetEventSlim();
            var library = new CountingLibraryManager
            {
                GetItemListHook = query => query.IncludeItemTypes.Contains(BaseItemKind.Movie)
                    ? new BaseItem[] { movie }
                    : Array.Empty<BaseItem>(),
                GetItemByIdHook = id => id == movie.Id ? movie : null,
            };
            var service = new TagCacheService(
                library,
                new StubAppPaths(dir),
                NullLogger<TagCacheService>.Instance);
            service.SeedEntryForTest(Key(movie.Id), new TagCacheEntry { Type = "Movie" });
            service.SaveToDisk();
            var cachePath = Path.Combine(
                dir,
                "configurations",
                "Jellyfin.Plugin.JellyfinCanopy",
                "tag-cache.json");
            var lastCompleteDisk = File.ReadAllBytes(cachePath);
            service.SetDisposeFlushGuardSpinsForTest(0);
            service.OnBeforeSwapForTest = () =>
            {
                entered.Set();
                Assert.True(release.Wait(TimeSpan.FromSeconds(10)));
                throw new OperationCanceledException("shutdown cancelled reconcile");
            };
            var reconcile = Task.Run(() => Assert.Throws<OperationCanceledException>(
                () => service.BuildFullCache(progress: null, CancellationToken.None)));
            Assert.True(entered.Wait(TimeSpan.FromSeconds(10)));

            service.Dispose();
            Assert.Equal(lastCompleteDisk, File.ReadAllBytes(cachePath));
            release.Set();
            await reconcile.WaitAsync(TimeSpan.FromSeconds(10));

            using var loaded = new TagCacheService(
                library,
                new StubAppPaths(dir),
                NullLogger<TagCacheService>.Instance);
            loaded.LoadFromDisk();
            Assert.Equal(0, loaded.Count);
            Assert.True(File.Exists(cachePath + ".incomplete"));

            loaded.BuildFullCache(progress: null, CancellationToken.None);
            Assert.Equal(1, loaded.Count);
            Assert.False(File.Exists(cachePath + ".incomplete"));
        }
        finally
        {
            try { Directory.Delete(dir, recursive: true); } catch { }
        }
    }

    [Fact]
    public async Task DisposeGuardTimeout_MarksSnapshotIncompleteEvenWhenFlushFinishesItsHandoff()
    {
        var dir = Path.Combine(Path.GetTempPath(), "jc-tagcache-dispose-" + Guid.NewGuid().ToString("N"));
        try
        {
            var movie = new StubMovie { Id = Guid.NewGuid(), DateLastSaved = SavedAt };
            var arrivedAfterDrain = new StubMovie { Id = Guid.NewGuid(), DateLastSaved = SavedAt };
            using var entered = new ManualResetEventSlim();
            using var release = new ManualResetEventSlim();
            var library = new CountingLibraryManager
            {
                GetItemByIdHook = id =>
                {
                    if (id == movie.Id)
                    {
                        entered.Set();
                        Assert.True(release.Wait(TimeSpan.FromSeconds(10)));
                        return movie;
                    }

                    return id == arrivedAfterDrain.Id ? arrivedAfterDrain : null;
                },
                GetItemListHook = _ => Array.Empty<BaseItem>(),
            };
            var service = new TagCacheService(
                library,
                new StubAppPaths(dir),
                NullLogger<TagCacheService>.Instance);
            service.SetDisposeFlushGuardSpinsForTest(0);
            service.EnqueueItemChange(movie, removed: false);
            var flushTask = Task.Run(service.FlushPendingForTest);
            Assert.True(entered.Wait(TimeSpan.FromSeconds(10)));

            service.EnqueueItemChange(arrivedAfterDrain, removed: false);
            service.Dispose();
            release.Set();
            await flushTask.WaitAsync(TimeSpan.FromSeconds(10));

            using var loaded = new TagCacheService(
                library,
                new StubAppPaths(dir),
                NullLogger<TagCacheService>.Instance);
            loaded.LoadFromDisk();
            Assert.Equal(0, loaded.Count); // startup rebuilds instead of trusting the timed-out handoff
            Assert.Equal(0, service.PendingChangeCountForTest);
        }
        finally
        {
            try { Directory.Delete(dir, recursive: true); } catch { }
        }
    }

    private static TagCacheService NewService(CountingLibraryManager library)
        => new(library, new StubAppPaths(Path.GetTempPath()), NullLogger<TagCacheService>.Instance);

    private static string Key(Guid id) => id.ToString("N").ToLowerInvariant();

    private static TagCacheEntry StaleContainer() => new()
    {
        Type = "Series",
        Genres = new[] { "Stale" },
        StreamData = new TagStreamData
        {
            ItemPath = "removed.mkv",
            Streams = new List<TagMediaStream> { new() { Codec = "old-codec" } },
            Sources = new List<TagMediaSource> { new() { Path = "/library/removed.mkv" } },
        },
        AudioLanguages = new[] { "old" },
    };

    private static TagCacheEntry StaleInherited() => new()
    {
        CommunityRating = 1,
        CriticRating = 2,
        Genres = new[] { "Stale" },
        SeriesTmdbId = "old-series-tmdb",
    };

    private static void AssertReplacement(TagCacheEntry? entry)
    {
        Assert.NotNull(entry);
        Assert.Equal(new[] { "Fresh" }, entry!.Genres);
        Assert.Equal("replacement.mkv", entry.StreamData?.ItemPath);
        var stream = Assert.Single(entry.StreamData!.Streams!);
        Assert.Equal("Audio", stream.Type);
        Assert.Equal("aac", stream.Codec);
        var source = Assert.Single(entry.StreamData.Sources!);
        Assert.Equal("replacement-source.mkv", source.Path);
        Assert.Equal("Replacement source", source.Name);
        Assert.Equal(new[] { "eng" }, entry.AudioLanguages);
    }

    private static void AssertInheritedSeriesFields(TagCacheEntry? entry)
    {
        Assert.NotNull(entry);
        Assert.Equal(9.1f, entry!.CommunityRating);
        Assert.Equal(91, entry.CriticRating);
        Assert.Equal("new-series-tmdb", entry.SeriesTmdbId);
    }

    private sealed class ControlledEpisode : MediaBrowser.Controller.Entities.TV.Episode
    {
        public bool ThrowOnProbe { get; init; }

        public IReadOnlyList<MediaSourceInfo> MediaSources { get; init; } = Array.Empty<MediaSourceInfo>();

        public override string GetClientTypeName() => "Episode";

        public override IReadOnlyList<MediaSourceInfo> GetMediaSources(bool enablePathSubstitution)
            => ThrowOnProbe
                ? throw new InvalidOperationException("transient replacement probe failure")
                : MediaSources;
    }

    private sealed class CountingEpisode : MediaBrowser.Controller.Entities.TV.Episode
    {
        public Action? OnProbe { get; init; }

        public override string GetClientTypeName() => "Episode";

        public override IReadOnlyList<MediaSourceInfo> GetMediaSources(bool enablePathSubstitution)
        {
            OnProbe?.Invoke();
            return Array.Empty<MediaSourceInfo>();
        }
    }
}
