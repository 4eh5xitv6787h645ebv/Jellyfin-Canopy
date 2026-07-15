using System.Runtime.CompilerServices;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers;

public class ArrCalendarUserDataAccessGuardTests
{
    [Fact]
    public void UserDataEndpoint_UsesSafeOrderUserAccessQueryOwner()
    {
        var source = File.ReadAllText(Path.Combine(
            SourceRoot(), "Controllers", "ArrCalendarController.cs"));
        var methodStart = source.IndexOf("GetCalendarUserDataForEvents", StringComparison.Ordinal);
        var method = source[methodStart..];

        Assert.Contains("UserAccessQuery.BuildItemIds(_libraryManager, user, ids)", method);
        Assert.DoesNotContain("ItemIds = ids.ToArray()", method);
    }

    private static string SourceRoot([CallerFilePath] string sourceFile = "")
        => Path.GetFullPath(Path.Combine(
            Path.GetDirectoryName(sourceFile)!, "..", "..", "Jellyfin.Plugin.JellyfinCanopy"));
}
