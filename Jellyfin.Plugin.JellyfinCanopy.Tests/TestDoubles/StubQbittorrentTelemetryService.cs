using Jellyfin.Plugin.JellyfinCanopy.Model.Qbittorrent;
using Jellyfin.Plugin.JellyfinCanopy.Services.Qbittorrent;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;

internal sealed class StubQbittorrentTelemetryService : IQbittorrentTelemetryService
{
    public int InvalidationCount { get; private set; }

    public void InvalidateCachedState() => InvalidationCount++;

    public Task<QbittorrentTelemetryResult> GetForItemPathAsync(
        string itemPath,
        CancellationToken cancellationToken)
        => Task.FromResult(new QbittorrentTelemetryResult(QbittorrentTelemetryResultKind.Disabled));

    public Task<QbittorrentTelemetryResultKind> TestConnectionAsync(
        CancellationToken cancellationToken)
        => Task.FromResult(QbittorrentTelemetryResultKind.Disabled);
}
