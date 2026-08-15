namespace Jellyfin.Plugin.JellyfinCanopy.Model.Qbittorrent;

/// <summary>Closed, browser-safe qBittorrent state vocabulary.</summary>
public enum QbittorrentTelemetryState
{
    Unknown,
    Downloading,
    Seeding,
    Stalled,
    Queued,
    Paused,
    Checking,
    Error,
}

/// <summary>
/// Strict allowlist returned to an already-authorized caller. This type must
/// never gain a torrent name, hash, path, raw tracker URL, or client detail.
/// </summary>
public sealed class QbittorrentTelemetryResponse
{
    public required string State { get; init; }

    public double? ProgressPercent { get; init; }

    public double? Ratio { get; init; }

    public string? TrackerIdentity { get; init; }

    public DateTimeOffset? AddedAt { get; init; }

    public DateTimeOffset? CompletedAt { get; init; }

    public DateTimeOffset? LastActivityAt { get; init; }
}

public enum QbittorrentTelemetryResultKind
{
    Success,
    Disabled,
    InvalidConfiguration,
    Unavailable,
    NoMatch,
    Ambiguous,
}

public readonly record struct QbittorrentTelemetryResult(
    QbittorrentTelemetryResultKind Kind,
    QbittorrentTelemetryResponse? Telemetry = null);
