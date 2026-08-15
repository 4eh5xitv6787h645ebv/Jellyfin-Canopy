using Jellyfin.Plugin.JellyfinCanopy.Model.Qbittorrent;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Qbittorrent;

public interface IQbittorrentTelemetryService
{
    void InvalidateCachedState();

    Task<QbittorrentTelemetryResult> GetForItemPathAsync(
        string itemPath,
        CancellationToken cancellationToken);

    Task<QbittorrentTelemetryResultKind> TestConnectionAsync(
        CancellationToken cancellationToken);
}
