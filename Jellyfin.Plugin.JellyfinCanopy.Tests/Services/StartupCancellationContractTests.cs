using System.Runtime.CompilerServices;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

/// <summary>
/// Pins the scheduled-task cancellation chain for the potentially large first-install
/// tag-cache reconcile.
/// </summary>
public sealed class StartupCancellationContractTests
{
    [Fact]
    public void StartupTask_ThreadsItsCancellationTokenIntoTheInitialTagCacheBuild()
    {
        var startupSource = File.ReadAllText(Path.Combine(
            SourceRoot(), "Services", "StartupService.cs"));
        var executeStart = startupSource.IndexOf(
            "public async Task ExecuteAsync", StringComparison.Ordinal);
        Assert.True(executeStart >= 0);
        var executeEnd = startupSource.IndexOf(
            "private void EnsureScriptInjected", executeStart, StringComparison.Ordinal);
        Assert.True(executeEnd > executeStart);
        var executeBody = startupSource[executeStart..executeEnd];

        Assert.Contains("await Task.Run(() =>", executeBody);
        Assert.Contains("}, cancellationToken);", executeBody);
        Assert.Contains(
            "_tagCacheService.BuildFullCache(null, cancellationToken);",
            executeBody);
        Assert.DoesNotContain("CancellationToken.None", executeBody);

        var tagCacheSource = File.ReadAllText(Path.Combine(
            SourceRoot(), "Services", "TagCacheService.cs"));
        Assert.Contains(
            "cancellationToken.ThrowIfCancellationRequested();",
            tagCacheSource);
    }

    private static string SourceRoot([CallerFilePath] string sourceFile = "")
        => Path.GetFullPath(Path.Combine(
            Path.GetDirectoryName(sourceFile)!, "..", "..", "Jellyfin.Plugin.JellyfinCanopy"));
}
