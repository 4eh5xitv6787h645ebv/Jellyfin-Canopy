using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Model;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class TagCacheRelationshipStringTests
{
    [Theory]
    [InlineData("captured", "same", true)]
    [InlineData("captured", "different", true)]
    [InlineData("captured", "empty", true)]
    [InlineData("captured", "same", false)]
    [InlineData("default", "same", true)]
    [InlineData("default", "empty", false)]
    [InlineData("absent", "same", true)]
    [InlineData("absent", "empty", false)]
    [InlineData("mismatch", "same", true)]
    [InlineData("empty", "same", true)]
    public void EpisodeRefresh_PreservesLiveRelationshipAndCompleteEntry(
        string contextMode, string liveMode, bool hasParent)
    {
        var series = NewSeries();
        var capturedId = series.Id;
        var context = Context(contextMode, capturedId);
        var episode = new Episode
        {
            Id = Guid.NewGuid(), SeriesId = capturedId, SeasonId = Guid.NewGuid(),
            ParentIndexNumber = 4, CommunityRating = null, CriticRating = 7,
            OriginalLanguage = "fr",
        };
        var existing = Existing("Episode");
        var original = JsonSerializer.Serialize(existing);
        // A previously admitted descendant can expose a new relationship before refresh.
        var liveId = LiveId(liveMode, capturedId);
        episode.SeriesId = liveId;
        var parent = hasParent ? series : null;
        var actual = contextMode == "absent"
            ? TagCacheDependencyGraph.ApplySeasonRelationshipRefresh(parent, episode, existing, 456)
            : TagCacheDependencyGraph.ApplySeasonRelationshipRefresh(parent, episode, existing, 456, context);

        var expected = existing.Clone();
        expected.SeriesId = liveId == Guid.Empty ? null : liveId.ToString("N");
        expected.SeasonId = episode.SeasonId.ToString("N");
        expected.SeasonNumber = 4;
        expected.SeriesTmdbId = hasParent ? "new-series" : null;
        expected.OriginalLanguage = "fr";
        expected.LastUpdated = 456;
        Assert.Equal(JsonSerializer.Serialize(expected), JsonSerializer.Serialize(actual));
        Assert.Equal(original, JsonSerializer.Serialize(existing));
        Assert.NotSame(existing, actual);
        Assert.Same(existing.StreamData, actual.StreamData);
        Assert.Same(existing.AudioLanguages, actual.AudioLanguages);
        if (contextMode == "captured" && liveMode == "same")
        {
            Assert.Same(context.Formatted, actual.SeriesId);
        }
    }

    [Theory]
    [InlineData("captured", "same")]
    [InlineData("captured", "different")]
    [InlineData("captured", "empty")]
    [InlineData("default", "same")]
    [InlineData("default", "empty")]
    [InlineData("absent", "same")]
    [InlineData("absent", "empty")]
    [InlineData("mismatch", "same")]
    [InlineData("empty", "empty")]
    public void SeasonRefresh_ReadsSeriesIdAfterParentRefreshAndPreservesEmptyFormatting(
        string contextMode, string liveMode)
    {
        var series = NewSeries();
        var capturedId = series.Id;
        var context = Context(contextMode, capturedId);
        var season = new NamedSeason
        {
            Id = Guid.NewGuid(), SeriesId = capturedId,
            CommunityRating = null, CriticRating = null, Genres = Array.Empty<string>(),
        };
        var existing = Existing("Season");
        var original = JsonSerializer.Serialize(existing);
        var liveId = LiveId(liveMode, capturedId);
        var callbacks = 0;
        BaseItem? FirstEpisode(BaseItem item)
        {
            Assert.Same(season, item);
            callbacks++;
            series.Id = liveId;
            return null;
        }

        var actual = contextMode == "absent"
            ? TagCacheDependencyGraph.ApplySeriesRelationshipRefresh(series, season, existing, FirstEpisode, 456)
            : TagCacheDependencyGraph.ApplySeriesRelationshipRefresh(series, season, existing, FirstEpisode, 456, context);
        Assert.True(callbacks > 0);
        var expected = existing.Clone();
        // Unlike the Episode relationship, an empty Series object's ID stays 32 zeroes.
        expected.SeriesId = liveId.ToString("N");
        expected.SeriesTmdbId = "new-series";
        expected.CommunityRating = 9;
        expected.CriticRating = 90;
        expected.Genres = series.Genres;
        expected.OriginalLanguage = "de";
        expected.LastUpdated = 456;
        Assert.Equal(JsonSerializer.Serialize(expected), JsonSerializer.Serialize(actual));
        Assert.Equal(original, JsonSerializer.Serialize(existing));
        Assert.NotSame(existing, actual);
        Assert.Same(existing.StreamData, actual.StreamData);
        Assert.Same(existing.AudioLanguages, actual.AudioLanguages);
        if (contextMode == "captured" && liveMode == "same")
        {
            Assert.Same(context.Formatted, actual.SeriesId);
        }
    }

    private static TagCacheRelationshipId Context(string mode, Guid id)
        => mode switch
        {
            "captured" => new(id),
            "mismatch" => new(Guid.NewGuid()),
            "empty" => new(Guid.Empty),
            _ => default,
        };

    private static Guid LiveId(string mode, Guid captured)
        => mode switch { "empty" => Guid.Empty, "different" => Guid.NewGuid(), _ => captured };

    private static Series NewSeries() => new()
    {
        Id = Guid.NewGuid(), CommunityRating = 9, CriticRating = 90,
        Genres = new[] { "Parent genre" }, OriginalLanguage = "de",
        ProviderIds = new Dictionary<string, string> { ["Tmdb"] = "new-series" },
    };

    private static TagCacheEntry Existing(string type) => new()
    {
        Type = type, TmdbId = "own-tmdb", SeriesTmdbId = "old-series",
        SeriesId = Guid.NewGuid().ToString("N"), SeasonId = Guid.NewGuid().ToString("N"),
        SeasonNumber = 2, EpisodeNumber = 3, CommunityRating = null, CriticRating = 7,
        Genres = new[] { "Own genre" }, AudioLanguages = new[] { "eng" }, OriginalLanguage = "ja",
        StreamData = new TagStreamData { ItemName = "retained stream" },
        StreamSourceId = Guid.NewGuid().ToString("N"), SourceRevision = 123, LastUpdated = 1,
    };

    private sealed class NamedSeason : Season
    {
        public override string GetClientTypeName() => "Season";
    }
}
