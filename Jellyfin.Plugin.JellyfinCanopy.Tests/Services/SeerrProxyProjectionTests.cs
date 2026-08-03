using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class SeerrProxyProjectionTests
{
    [Fact]
    public void Watchlist_AddsUniformIdWithoutRemovingTmdbIdOrReplacingExistingId()
    {
        const string json = """
            {"results":[{"tmdbId":42},{"id":9,"tmdbId":99},{"tmdbId":"17"}]}
            """;

        Assert.True(SeerrProxyProjection.TryProject(
            json,
            "/api/v1/discover/watchlist?page=1",
            out var projected));

        using var document = JsonDocument.Parse(projected);
        var results = document.RootElement.GetProperty("results");
        Assert.Equal(42, results[0].GetProperty("id").GetInt32());
        Assert.Equal(42, results[0].GetProperty("tmdbId").GetInt32());
        Assert.Equal(9, results[1].GetProperty("id").GetInt32());
        Assert.Equal("17", results[2].GetProperty("tmdbId").GetString());
        Assert.Equal(17, results[2].GetProperty("id").GetInt32());
    }

    [Fact]
    public void TvDetail_PreservesExplicitStatusAndDerivesMissing4kSeasonStates()
    {
        const string json = """
            {
              "mediaInfo": {
                "seasons": [
                  {"seasonNumber":1,"status4k":4},
                  {"seasonNumber":2},
                  {"seasonNumber":3},
                  {"seasonNumber":4}
                ],
                "requests": [
                  {"is4k":true,"status":1,"seasons":[{"seasonNumber":2}]},
                  {"is4k":true,"status":2,"seasons":[{"seasonNumber":3}]},
                  {"is4k":true,"status":5,"seasons":[{"seasonNumber":3}]},
                  {"is4k":false,"status":5,"seasons":[{"seasonNumber":4}]}
                ]
              }
            }
            """;

        Assert.True(SeerrProxyProjection.TryProject(json, "/api/v1/tv/123", out var projected));

        using var document = JsonDocument.Parse(projected);
        var seasons = document.RootElement.GetProperty("mediaInfo").GetProperty("seasons");
        Assert.Equal(4, seasons[0].GetProperty("status4k").GetInt32());
        Assert.Equal(2, seasons[1].GetProperty("status4k").GetInt32());
        Assert.Equal(5, seasons[2].GetProperty("status4k").GetInt32());
        Assert.Equal(1, seasons[3].GetProperty("status4k").GetInt32());
    }

    [Fact]
    public void UnknownOrLegitimatelySparseShape_IsByteIdentical()
    {
        const string json = "{ \"results\" : [] }";

        Assert.True(SeerrProxyProjection.TryProject(json, "/api/v1/search", out var unchanged));
        Assert.Equal(json, unchanged);
        Assert.True(SeerrProxyProjection.TryProject("{}", "/api/v1/discover/watchlist", out var watchlist));
        Assert.Equal("{}", watchlist);
        Assert.True(SeerrProxyProjection.TryProject("{}", "/api/v1/tv/123", out var tv));
        Assert.Equal("{}", tv);
        Assert.False(SeerrProxyProjection.TryProject("[]", "/api/v1/tv/123", out _));
    }
}
