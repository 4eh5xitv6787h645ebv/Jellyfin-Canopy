using Jellyfin.Plugin.JellyfinCanopy.Services.Arr;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public class ArrRootPathTests
{
    [Theory]
    [InlineData("/media/movies/Foo", "/media/movies")]
    [InlineData("/media/movies/Foo/", "/media/movies")]
    [InlineData("C:\\media\\movies\\Foo", "C:\\media\\movies")]
    [InlineData("C:\\media\\movies\\Foo\\", "C:\\media\\movies")]
    [InlineData("/Movie", "/")]
    [InlineData("C:\\Movie", "C:\\")]
    [InlineData("/", "/")]
    [InlineData("C:\\", "C:\\")]
    public void GetRootFolderFromPath_SupportsNativeSeparators(string path, string expected)
        => Assert.Equal(expected, ArrFetchService.GetRootFolderFromPath(path));
}
