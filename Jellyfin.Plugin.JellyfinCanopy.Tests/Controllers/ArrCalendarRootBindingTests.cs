using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Data;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers;

public class ArrCalendarRootBindingTests
{
    [Fact]
    public void MapArrRootBindings_PreservesExactInstanceTypeAndDistinctPaths()
    {
        var payload = JsonNode.Parse("""
            [
              { "id": 1, "path": "/media/tv" },
              { "id": 2, "path": "/media/anime" },
              { "id": 3, "path": "/media/tv" },
              { "id": 4, "path": " " }
            ]
            """);

        var bindings = ArrCalendarController.MapArrRootBindings(
            payload, "sonarr:3", ItemLookupKind.Series);

        Assert.Equal(2, bindings.Count);
        Assert.All(bindings, binding =>
        {
            Assert.Equal("sonarr:3", binding.InstanceKey);
            Assert.Equal(ItemLookupKind.Series, binding.Kind);
        });
        Assert.Contains(bindings, binding => binding.RootPath == "/media/tv");
        Assert.Contains(bindings, binding => binding.RootPath == "/media/anime");
    }

    [Theory]
    [InlineData("null")]
    [InlineData("{}")]
    public void MapArrRootBindings_MalformedOrMissingArrayFailsEmpty(string json)
    {
        var bindings = ArrCalendarController.MapArrRootBindings(
            JsonNode.Parse(json), "radarr:0", ItemLookupKind.Movie);

        Assert.Empty(bindings);
    }
}
