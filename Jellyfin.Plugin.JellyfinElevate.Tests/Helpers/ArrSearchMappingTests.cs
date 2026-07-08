using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinElevate.Helpers.Arr;
using Jellyfin.Plugin.JellyfinElevate.Model.Arr;
using Xunit;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.Helpers;

/// <summary>
/// Pure Sonarr/Radarr JSON → DTO mapping and request-body building for the Search feature.
/// These pin the exact command names/payloads and interactive-search paths the arr APIs expect.
/// </summary>
public class ArrSearchMappingTests
{
    private static ArrResolvedItem Movie(int tmdb = 27205) => new() { Kind = ArrMediaKind.Movie, TmdbId = tmdb };
    private static ArrResolvedItem Series(int tvdb = 81189) => new() { Kind = ArrMediaKind.Series, SeriesTvdbId = tvdb };
    private static ArrResolvedItem Season(int season) => new() { Kind = ArrMediaKind.Season, SeriesTvdbId = 81189, SeasonNumber = season };
    private static ArrResolvedItem Episode(int season, int ep) => new() { Kind = ArrMediaKind.Episode, SeriesTvdbId = 81189, SeasonNumber = season, EpisodeNumber = ep };

    // ── release normalization ────────────────────────────────────────────────

    [Fact]
    public void MapRelease_NormalizesAllFields()
    {
        var node = JsonNode.Parse("""
        {
          "guid":"nzb://abc","indexerId":4,"indexer":"NZBgeek",
          "title":"Show.S01.2160p.BluRay","quality":{"quality":{"id":19,"name":"Bluray-2160p"}},
          "qualityWeight":1500,"size":21128010988,"ageHours":688.5,
          "seeders":null,"leechers":null,"protocol":"usenet","approved":true,"downloadAllowed":true,
          "rejections":["Not a preferred protocol"],"seasonNumber":1,"fullSeason":true,
          "releaseGroup":"R&H","customFormatScore":25,
          "languages":[{"id":1,"name":"English"}],"indexerFlags":["freeleech"]
        }
        """);

        var dto = ArrSearchMapping.MapRelease(node);

        Assert.Equal("nzb://abc", dto.Guid);
        Assert.Equal(4, dto.IndexerId);
        Assert.Equal("NZBgeek", dto.Indexer);
        Assert.Equal("Bluray-2160p", dto.Quality);
        Assert.Equal(1500, dto.QualityWeight);
        Assert.Equal(21128010988L, dto.Size);
        Assert.Equal(688.5, dto.AgeHours);
        Assert.Null(dto.Seeders);
        Assert.Equal("usenet", dto.Protocol);
        Assert.True(dto.DownloadAllowed);
        Assert.Equal(new[] { "Not a preferred protocol" }, dto.Rejections);
        Assert.True(dto.FullSeason);
        Assert.Equal(1, dto.SeasonNumber);
        Assert.Equal("R&H", dto.ReleaseGroup);
        Assert.Equal(25, dto.CustomFormatScore);
        Assert.Equal(new[] { "English" }, dto.Languages);
        Assert.Equal(new[] { "freeleech" }, dto.IndexerFlags);
    }

    [Fact]
    public void MapRelease_TorrentSeedersLeechers_ParsedAsIntegers()
    {
        var node = JsonNode.Parse("""{"guid":"g","indexerId":1,"protocol":"torrent","seeders":42,"leechers":7}""");
        var dto = ArrSearchMapping.MapRelease(node);
        Assert.Equal(42, dto.Seeders);
        Assert.Equal(7, dto.Leechers);
        Assert.Equal("torrent", dto.Protocol);
    }

    [Fact]
    public void MapRelease_MissingFields_YieldDefaultsNeverThrows()
    {
        var dto = ArrSearchMapping.MapRelease(JsonNode.Parse("""{"guid":"only"}"""));
        Assert.Equal("only", dto.Guid);
        Assert.Equal(0, dto.IndexerId);
        Assert.Empty(dto.Rejections);
        Assert.Empty(dto.Languages);
        Assert.Null(dto.Quality);
    }

    // ── automatic-search command selection ───────────────────────────────────

    [Fact]
    public void AutoSearchCommand_Movie_MoviesSearchWithMovieIds()
    {
        var cmd = ArrSearchMapping.AutoSearchCommand(Movie(), arrId: 42, episodeId: null)!;
        Assert.Equal("MoviesSearch", cmd.Name);
        Assert.Equal("MoviesSearch", (string?)cmd.Body["name"]);
        Assert.Equal(42, (int?)cmd.Body["movieIds"]!.AsArray()[0]);
    }

    [Fact]
    public void AutoSearchCommand_Series_SeriesSearchWithSeriesId()
    {
        var cmd = ArrSearchMapping.AutoSearchCommand(Series(), arrId: 7, episodeId: null)!;
        Assert.Equal("SeriesSearch", cmd.Name);
        Assert.Equal(7, (int?)cmd.Body["seriesId"]);
    }

    [Fact]
    public void AutoSearchCommand_Season_SeasonSearchWithSeriesIdAndSeason()
    {
        var cmd = ArrSearchMapping.AutoSearchCommand(Season(3), arrId: 7, episodeId: null)!;
        Assert.Equal("SeasonSearch", cmd.Name);
        Assert.Equal(7, (int?)cmd.Body["seriesId"]);
        Assert.Equal(3, (int?)cmd.Body["seasonNumber"]);
    }

    [Fact]
    public void AutoSearchCommand_Episode_EpisodeSearchWithEpisodeIds()
    {
        var cmd = ArrSearchMapping.AutoSearchCommand(Episode(1, 5), arrId: 7, episodeId: 501)!;
        Assert.Equal("EpisodeSearch", cmd.Name);
        Assert.Equal(501, (int?)cmd.Body["episodeIds"]!.AsArray()[0]);
    }

    [Fact]
    public void AutoSearchCommand_EpisodeWithoutEpisodeId_ReturnsNull()
    {
        Assert.Null(ArrSearchMapping.AutoSearchCommand(Episode(1, 5), arrId: 7, episodeId: null));
    }

    // ── interactive-search path ──────────────────────────────────────────────

    [Theory]
    [InlineData(ArrMediaKind.Movie, 0, "/api/v3/release?movieId=42")]
    public void InteractiveReleasePath_Movie(ArrMediaKind kind, int season, string expected)
    {
        _ = kind; _ = season;
        Assert.Equal(expected, ArrSearchMapping.InteractiveReleasePath(Movie(), 42, null));
    }

    [Fact]
    public void InteractiveReleasePath_Season_UsesSeriesIdAndSeason()
        => Assert.Equal("/api/v3/release?seriesId=7&seasonNumber=2", ArrSearchMapping.InteractiveReleasePath(Season(2), 7, null));

    [Fact]
    public void InteractiveReleasePath_Episode_UsesEpisodeId()
        => Assert.Equal("/api/v3/release?episodeId=501", ArrSearchMapping.InteractiveReleasePath(Episode(1, 5), 7, 501));

    [Fact]
    public void InteractiveReleasePath_Series_NotSupported_ReturnsNull()
        => Assert.Null(ArrSearchMapping.InteractiveReleasePath(Series(), 7, null));

    // ── queue progress ───────────────────────────────────────────────────────

    [Fact]
    public void MapQueueRow_ComputesProgressFromSizeAndSizeleft()
    {
        var node = JsonNode.Parse("""{"title":"Show","status":"downloading","trackedDownloadState":"downloading","size":1000,"sizeleft":250,"timeleft":"00:05:00"}""");
        var row = ArrSearchMapping.MapQueueRow(node, "sonarr", "test-tv");
        Assert.Equal("test-tv", row.InstanceName);
        Assert.Equal("sonarr", row.Service);
        Assert.Equal(75.0, row.Progress);
        Assert.Equal("00:05:00", row.TimeRemaining);
    }

    [Fact]
    public void MapQueueRow_ZeroSize_ProgressZero_NoDivideByZero()
    {
        var row = ArrSearchMapping.MapQueueRow(JsonNode.Parse("""{"size":0,"sizeleft":0}"""), "radarr", "x");
        Assert.Equal(0, row.Progress);
    }

    // ── defensive accessors ──────────────────────────────────────────────────

    [Fact]
    public void DefensiveAccessors_HandleStringNumbersAndNulls()
    {
        Assert.Equal(5, ArrSearchMapping.IntN(JsonNode.Parse("\"5\"")));
        Assert.Null(ArrSearchMapping.IntN(null));
        Assert.Equal(1234567890123L, ArrSearchMapping.Long(JsonNode.Parse("\"1234567890123\"")));
        Assert.Equal(3.5, ArrSearchMapping.Dbl(JsonNode.Parse("\"3.5\"")));
        Assert.True(ArrSearchMapping.Bool(JsonNode.Parse("\"true\"")));
        Assert.False(ArrSearchMapping.Bool(null));
    }
}
