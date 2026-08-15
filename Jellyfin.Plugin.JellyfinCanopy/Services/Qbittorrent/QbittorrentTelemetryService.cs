using System.Buffers;
using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Jellyfin.Plugin.JellyfinCanopy.Model.Qbittorrent;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Qbittorrent;

/// <summary>
/// Bounded, strictly read-only qBittorrent Web API transport and path mapper.
/// One process-wide snapshot is shared by every caller; authorization remains
/// in the controller and always runs before this service sees an item path.
/// </summary>
public sealed class QbittorrentTelemetryService : IQbittorrentTelemetryService
{
    public const string HttpClientName = "JellyfinCanopyQbittorrentTelemetry";
    internal const int MaximumTorrents = 2_000;
    internal const int MaximumResponseBytes = 2 * 1024 * 1024;
    internal const int MaximumMappings = 32;
    internal static readonly TimeSpan SnapshotTtl = TimeSpan.FromSeconds(30);
    internal static readonly TimeSpan FailureTtl = TimeSpan.FromSeconds(2);
    internal static readonly TimeSpan OperationDeadline = TimeSpan.FromSeconds(12);

    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IPluginConfigProvider _configProvider;
    private readonly TimeProvider _timeProvider;
    private readonly SemaphoreSlim _upstreamGate = new(1, 1);
    private readonly object _cacheLock = new();
    private CachedSnapshot? _cache;
    private CachedFailure? _failure;
    private SnapshotFlight? _flight;

    public QbittorrentTelemetryService(
        IHttpClientFactory httpClientFactory,
        IPluginConfigProvider configProvider)
        : this(httpClientFactory, configProvider, TimeProvider.System)
    {
    }

    internal QbittorrentTelemetryService(
        IHttpClientFactory httpClientFactory,
        IPluginConfigProvider configProvider,
        TimeProvider timeProvider)
    {
        _httpClientFactory = httpClientFactory;
        _configProvider = configProvider;
        _timeProvider = timeProvider;
    }

    public async Task<QbittorrentTelemetryResult> GetForItemPathAsync(
        string itemPath,
        CancellationToken cancellationToken)
    {
        var capture = ConfigurationCapture.TryCreate(_configProvider, requireEnabled: true);
        if (capture.Error != null)
        {
            return new QbittorrentTelemetryResult(capture.Error.Value);
        }

        var normalizedItemPath = NormalizeAbsolutePath(itemPath);
        if (normalizedItemPath == null)
        {
            return new QbittorrentTelemetryResult(QbittorrentTelemetryResultKind.NoMatch);
        }

        var snapshot = await GetSnapshotAsync(capture.Value!, cancellationToken).ConfigureAwait(false);
        if (snapshot.Kind != QbittorrentTelemetryResultKind.Success)
        {
            return new QbittorrentTelemetryResult(snapshot.Kind);
        }

        return Match(normalizedItemPath, capture.Value!.Mappings, snapshot.Torrents!);
    }

    public async Task<QbittorrentTelemetryResultKind> TestConnectionAsync(
        CancellationToken cancellationToken)
    {
        var capture = ConfigurationCapture.TryCreate(_configProvider, requireEnabled: false);
        if (capture.Error != null)
        {
            return capture.Error.Value;
        }

        var result = await FetchSnapshotAsync(capture.Value!, cancellationToken).ConfigureAwait(false);
        return result.Kind;
    }

    private async Task<SnapshotResult> GetSnapshotAsync(
        ConfigurationCapture capture,
        CancellationToken cancellationToken)
    {
        SnapshotFlight flight;
        lock (_cacheLock)
        {
            var now = _timeProvider.GetUtcNow();
            if (_cache is { } cached
                && cached.Revision == capture.Revision
                && cached.ExpiresAt > now)
            {
                return SnapshotResult.Success(cached.Torrents);
            }

            if (_failure is { } failed
                && failed.Revision == capture.Revision
                && failed.ExpiresAt > now)
            {
                return SnapshotResult.Failure(failed.Kind);
            }

            if (_flight is { } existing
                && existing.Revision == capture.Revision
                && !existing.Task.IsCompleted)
            {
                flight = existing;
            }
            else
            {
                var task = FetchAndPublishAsync(capture);
                flight = new SnapshotFlight(capture.Revision, task);
                _flight = flight;
            }
        }

        return await flight.Task.WaitAsync(cancellationToken).ConfigureAwait(false);
    }

    private async Task<SnapshotResult> FetchAndPublishAsync(ConfigurationCapture capture)
    {
        var result = await FetchSnapshotAsync(capture, CancellationToken.None).ConfigureAwait(false);
        lock (_cacheLock)
        {
            var now = _timeProvider.GetUtcNow();
            if (result.Kind == QbittorrentTelemetryResultKind.Success)
            {
                _cache = new CachedSnapshot(
                    capture.Revision,
                    now + SnapshotTtl,
                    result.Torrents!);
                _failure = null;
            }
            else
            {
                _failure = new CachedFailure(capture.Revision, now + FailureTtl, result.Kind);
            }

            if (_flight?.Revision == capture.Revision)
            {
                _flight = null;
            }
        }

        return result;
    }

    private async Task<SnapshotResult> FetchSnapshotAsync(
        ConfigurationCapture capture,
        CancellationToken cancellationToken)
    {
        using var operation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        operation.CancelAfter(OperationDeadline);
        try
        {
            await _upstreamGate.WaitAsync(operation.Token).ConfigureAwait(false);
            try
            {
                if (!await ArrUrlGuard.IsAllowedUrlAsync(capture.BaseUrl, operation.Token).ConfigureAwait(false))
                {
                    return SnapshotResult.Failure(QbittorrentTelemetryResultKind.InvalidConfiguration);
                }

                var client = _httpClientFactory.CreateClient(HttpClientName);
                var sid = await LoginAsync(client, capture, operation.Token).ConfigureAwait(false);
                if (sid == null)
                {
                    return SnapshotResult.Failure(QbittorrentTelemetryResultKind.Unavailable);
                }

                using var request = BuildRequest(
                    HttpMethod.Get,
                    capture,
                    "api/v2/torrents/info",
                    sid);
                using var response = await client.SendAsync(
                    request,
                    HttpCompletionOption.ResponseHeadersRead,
                    operation.Token).ConfigureAwait(false);
                if (response.StatusCode != HttpStatusCode.OK)
                {
                    return SnapshotResult.Failure(QbittorrentTelemetryResultKind.Unavailable);
                }

                var bytes = await ReadBoundedAsync(response, MaximumResponseBytes, operation.Token)
                    .ConfigureAwait(false);
                if (bytes == null)
                {
                    return SnapshotResult.Failure(QbittorrentTelemetryResultKind.Unavailable);
                }

                return TryParseTorrents(bytes, out var torrents)
                    ? SnapshotResult.Success(torrents)
                    : SnapshotResult.Failure(QbittorrentTelemetryResultKind.Unavailable);
            }
            finally
            {
                _upstreamGate.Release();
            }
        }
        catch (OperationCanceledException)
        {
            return SnapshotResult.Failure(QbittorrentTelemetryResultKind.Unavailable);
        }
        catch (HttpRequestException)
        {
            return SnapshotResult.Failure(QbittorrentTelemetryResultKind.Unavailable);
        }
        catch (JsonException)
        {
            return SnapshotResult.Failure(QbittorrentTelemetryResultKind.Unavailable);
        }
    }

    private static async Task<string?> LoginAsync(
        HttpClient client,
        ConfigurationCapture capture,
        CancellationToken cancellationToken)
    {
        using var request = BuildRequest(HttpMethod.Post, capture, "api/v2/auth/login", sid: null);
        request.Content = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["username"] = capture.Username,
            ["password"] = capture.Password,
        });
        using var response = await client.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken).ConfigureAwait(false);
        if (response.StatusCode != HttpStatusCode.OK)
        {
            return null;
        }

        var body = await ReadBoundedAsync(response, 64, cancellationToken).ConfigureAwait(false);
        if (body == null || !Encoding.ASCII.GetString(body).Trim().Equals("Ok.", StringComparison.Ordinal))
        {
            return null;
        }

        foreach (var header in response.Headers.TryGetValues("Set-Cookie", out var values)
            ? values
            : Array.Empty<string>())
        {
            var first = header.Split(';', 2)[0].Trim();
            if (!first.StartsWith("SID=", StringComparison.Ordinal)) continue;
            var sid = first[4..];
            if (sid.Length is > 0 and <= 256
                && sid.All(character => character > 0x20 && character < 0x7f
                    && character is not ';' and not ','))
            {
                return sid;
            }
        }

        return null;
    }

    private static HttpRequestMessage BuildRequest(
        HttpMethod method,
        ConfigurationCapture capture,
        string relativePath,
        string? sid)
    {
        var request = new HttpRequestMessage(method, new Uri(capture.BaseUri, relativePath));
        request.Headers.Referrer = capture.BaseUri;
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        if (sid != null)
        {
            request.Headers.TryAddWithoutValidation("Cookie", $"SID={sid}");
        }

        return request;
    }

    private static async Task<byte[]?> ReadBoundedAsync(
        HttpResponseMessage response,
        int maximumBytes,
        CancellationToken cancellationToken)
    {
        if (response.Content.Headers.ContentLength is > 0
            && response.Content.Headers.ContentLength > maximumBytes)
        {
            return null;
        }

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken)
            .ConfigureAwait(false);
        using var memory = new MemoryStream(Math.Min(maximumBytes, 64 * 1024));
        var buffer = ArrayPool<byte>.Shared.Rent(16 * 1024);
        try
        {
            while (true)
            {
                var read = await stream.ReadAsync(buffer.AsMemory(0, buffer.Length), cancellationToken)
                    .ConfigureAwait(false);
                if (read == 0) break;
                if (memory.Length + read > maximumBytes) return null;
                memory.Write(buffer, 0, read);
            }

            return memory.ToArray();
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }

    internal static bool TryParseTorrents(byte[] bytes, out IReadOnlyList<TorrentSnapshot> torrents)
    {
        torrents = Array.Empty<TorrentSnapshot>();
        using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions
        {
            AllowTrailingCommas = false,
            CommentHandling = JsonCommentHandling.Disallow,
            MaxDepth = 16,
        });
        if (document.RootElement.ValueKind != JsonValueKind.Array
            || document.RootElement.GetArrayLength() > MaximumTorrents)
        {
            return false;
        }

        var parsed = new List<TorrentSnapshot>(document.RootElement.GetArrayLength());
        foreach (var row in document.RootElement.EnumerateArray())
        {
            if (row.ValueKind != JsonValueKind.Object) return false;
            var contentPath = BoundedString(row, "content_path", 4096);
            var savePath = BoundedString(row, "save_path", 4096);
            var name = BoundedString(row, "name", 512);
            var state = BoundedString(row, "state", 64);
            var tracker = BoundedString(row, "tracker", 2048);
            if (contentPath == InvalidString || savePath == InvalidString || name == InvalidString
                || state == InvalidString || tracker == InvalidString)
            {
                return false;
            }

            var effectivePath = !string.IsNullOrWhiteSpace(contentPath)
                ? contentPath
                : JoinPath(savePath, name);
            if (string.IsNullOrWhiteSpace(effectivePath)) continue;
            parsed.Add(new TorrentSnapshot(
                effectivePath,
                state ?? string.Empty,
                Number(row, "progress"),
                Number(row, "ratio"),
                tracker,
                Integer(row, "added_on"),
                Integer(row, "completion_on"),
                Integer(row, "last_activity")));
        }

        torrents = parsed;
        return true;
    }

    private const string InvalidString = "\0invalid";

    private static string? BoundedString(JsonElement row, string name, int maximumLength)
    {
        if (!row.TryGetProperty(name, out var value) || value.ValueKind == JsonValueKind.Null)
            return null;
        if (value.ValueKind != JsonValueKind.String) return InvalidString;
        var text = value.GetString();
        return text != null && text.Length <= maximumLength ? text : InvalidString;
    }

    private static double? Number(JsonElement row, string name)
    {
        if (!row.TryGetProperty(name, out var value) || value.ValueKind == JsonValueKind.Null)
            return null;
        return value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var result)
            && double.IsFinite(result)
                ? result
                : null;
    }

    private static long? Integer(JsonElement row, string name)
    {
        if (!row.TryGetProperty(name, out var value) || value.ValueKind == JsonValueKind.Null)
            return null;
        return value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var result)
            ? result
            : null;
    }

    internal static QbittorrentTelemetryResult Match(
        string normalizedItemPath,
        IReadOnlyList<PathMapping> mappings,
        IReadOnlyList<TorrentSnapshot> torrents)
    {
        var candidates = new List<(int Specificity, TorrentSnapshot Torrent)>();
        foreach (var torrent in torrents)
        {
            var mapped = MapTorrentPath(torrent.Path, mappings);
            if (mapped == null || !ContainsPath(mapped, normalizedItemPath)) continue;
            candidates.Add((mapped.Length, torrent));
        }

        if (candidates.Count == 0)
            return new QbittorrentTelemetryResult(QbittorrentTelemetryResultKind.NoMatch);
        var specificity = candidates.Max(candidate => candidate.Specificity);
        var strongest = candidates.Where(candidate => candidate.Specificity == specificity).ToArray();
        if (strongest.Length != 1)
            return new QbittorrentTelemetryResult(QbittorrentTelemetryResultKind.Ambiguous);

        var selected = strongest[0].Torrent;
        return new QbittorrentTelemetryResult(
            QbittorrentTelemetryResultKind.Success,
            new QbittorrentTelemetryResponse
            {
                State = NormalizeState(selected.State).ToString().ToLowerInvariant(),
                ProgressPercent = BoundedPercent(selected.Progress),
                Ratio = BoundedRatio(selected.Ratio),
                TrackerIdentity = RedactTracker(selected.Tracker),
                AddedAt = UnixTime(selected.AddedOn),
                CompletedAt = UnixTime(selected.CompletionOn),
                LastActivityAt = UnixTime(selected.LastActivity),
            });
    }

    internal static string? MapTorrentPath(string path, IReadOnlyList<PathMapping> mappings)
    {
        var normalized = NormalizeAbsolutePath(path);
        if (normalized == null) return null;
        var matching = mappings
            .Where(mapping => ContainsPath(mapping.QbittorrentRoot, normalized))
            .OrderByDescending(mapping => mapping.QbittorrentRoot.Length)
            .ToArray();
        if (matching.Length == 0) return null;
        var bestLength = matching[0].QbittorrentRoot.Length;
        var best = matching.Where(mapping => mapping.QbittorrentRoot.Length == bestLength).ToArray();
        var results = best.Select(mapping => mapping.JellyfinRoot
                + normalized[mapping.QbittorrentRoot.Length..])
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        return results.Length == 1 ? results[0] : null;
    }

    internal static IReadOnlyList<PathMapping>? ParseMappings(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return Array.Empty<PathMapping>();
        var lines = value.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
        if (lines.Length > MaximumMappings) return null;
        var mappings = new List<PathMapping>(lines.Length);
        foreach (var raw in lines)
        {
            var parts = raw.Split('|');
            if (parts.Length != 2) return null;
            var source = NormalizeAbsolutePath(parts[0].Trim());
            var target = NormalizeAbsolutePath(parts[1].Trim());
            if (source == null || target == null) return null;
            mappings.Add(new PathMapping(source, target));
        }

        return mappings;
    }

    internal static string? NormalizeAbsolutePath(string? path)
    {
        if (string.IsNullOrWhiteSpace(path) || path.Length > 4096) return null;
        var replaced = path.Trim().Replace('\\', '/');
        var windows = replaced.Length >= 3
            && char.IsAsciiLetter(replaced[0])
            && replaced[1] == ':'
            && replaced[2] == '/';
        if (!windows && !replaced.StartsWith("/", StringComparison.Ordinal)) return null;
        var prefix = windows ? char.ToUpperInvariant(replaced[0]) + ":" : string.Empty;
        var remainder = windows ? replaced[2..] : replaced;
        var segments = remainder.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Any(segment => segment is "." or ".." || segment.Contains('\0'))) return null;
        var normalized = prefix + "/" + string.Join('/', segments);
        return normalized.Length > 1 ? normalized.TrimEnd('/') : normalized;
    }

    private static bool ContainsPath(string parent, string child)
    {
        var comparison = parent.Length >= 2 && parent[1] == ':'
            ? StringComparison.OrdinalIgnoreCase
            : StringComparison.Ordinal;
        return child.Equals(parent, comparison)
            || (child.Length > parent.Length
                && child.StartsWith(parent, comparison)
                && child[parent.Length] == '/');
    }

    private static string? JoinPath(string? root, string? name)
        => string.IsNullOrWhiteSpace(root) || string.IsNullOrWhiteSpace(name)
            ? null
            : root.TrimEnd('/', '\\') + "/" + name.TrimStart('/', '\\');

    internal static QbittorrentTelemetryState NormalizeState(string? state)
    {
        var value = (state ?? string.Empty).ToLowerInvariant();
        if (value.Contains("error", StringComparison.Ordinal)) return QbittorrentTelemetryState.Error;
        if (value.Contains("check", StringComparison.Ordinal)) return QbittorrentTelemetryState.Checking;
        if (value.Contains("stalled", StringComparison.Ordinal)) return QbittorrentTelemetryState.Stalled;
        if (value.Contains("paused", StringComparison.Ordinal)
            || value.Contains("stopped", StringComparison.Ordinal)) return QbittorrentTelemetryState.Paused;
        if (value.Contains("queued", StringComparison.Ordinal)) return QbittorrentTelemetryState.Queued;
        if (value.Contains("upload", StringComparison.Ordinal)
            || value.EndsWith("up", StringComparison.Ordinal)) return QbittorrentTelemetryState.Seeding;
        if (value.Contains("download", StringComparison.Ordinal)
            || value.EndsWith("dl", StringComparison.Ordinal)) return QbittorrentTelemetryState.Downloading;
        return QbittorrentTelemetryState.Unknown;
    }

    internal static string? RedactTracker(string? tracker)
    {
        if (string.IsNullOrWhiteSpace(tracker)
            || !Uri.TryCreate(tracker, UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttp
                && uri.Scheme != Uri.UriSchemeHttps
                && uri.Scheme != "udp")) return null;
        var host = uri.IdnHost.TrimEnd('.').ToLowerInvariant();
        if (host.Length == 0) return null;
        if (host.Equals("localhost", StringComparison.OrdinalIgnoreCase)
            || IPAddress.TryParse(host, out var address)
                && (IPAddress.IsLoopback(address) || IsPrivate(address)))
        {
            return "private tracker";
        }

        var labels = host.Split('.', StringSplitOptions.RemoveEmptyEntries);
        if (labels.Length < 2 || labels.Any(label => label.Length > 63)) return "tracker";
        return "…" + string.Join('.', labels[^2], labels[^1]);
    }

    private static bool IsPrivate(IPAddress address)
    {
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        var bytes = address.GetAddressBytes();
        return bytes.Length == 4
            ? bytes[0] == 10
                || bytes[0] == 127
                || bytes[0] == 192 && bytes[1] == 168
                || bytes[0] == 172 && bytes[1] is >= 16 and <= 31
            : address.IsIPv6LinkLocal || address.IsIPv6SiteLocal;
    }

    private static double? BoundedPercent(double? progress)
        => progress is >= 0 and <= 1
            ? Math.Round(progress.Value * 100, 1, MidpointRounding.AwayFromZero)
            : null;

    private static double? BoundedRatio(double? ratio)
        => ratio is >= 0
            ? Math.Round(Math.Min(ratio.Value, 9_999), 2, MidpointRounding.AwayFromZero)
            : null;

    private static DateTimeOffset? UnixTime(long? seconds)
    {
        if (seconds is not > 0) return null;
        try
        {
            var value = DateTimeOffset.FromUnixTimeSeconds(seconds.Value);
            return value.Year <= 3000 ? value : null;
        }
        catch (ArgumentOutOfRangeException)
        {
            return null;
        }
    }

    internal sealed record TorrentSnapshot(
        string Path,
        string State,
        double? Progress,
        double? Ratio,
        string? Tracker,
        long? AddedOn,
        long? CompletionOn,
        long? LastActivity);

    internal sealed record PathMapping(string QbittorrentRoot, string JellyfinRoot);

    private sealed record CachedSnapshot(
        long Revision,
        DateTimeOffset ExpiresAt,
        IReadOnlyList<TorrentSnapshot> Torrents);

    private sealed record CachedFailure(
        long Revision,
        DateTimeOffset ExpiresAt,
        QbittorrentTelemetryResultKind Kind);

    private sealed record SnapshotFlight(long Revision, Task<SnapshotResult> Task);

    private readonly record struct SnapshotResult(
        QbittorrentTelemetryResultKind Kind,
        IReadOnlyList<TorrentSnapshot>? Torrents)
    {
        public static SnapshotResult Success(IReadOnlyList<TorrentSnapshot> torrents)
            => new(QbittorrentTelemetryResultKind.Success, torrents);

        public static SnapshotResult Failure(QbittorrentTelemetryResultKind kind)
            => new(kind, null);
    }

    private sealed record ConfigurationCapture(
        long Revision,
        string BaseUrl,
        Uri BaseUri,
        string Username,
        string Password,
        IReadOnlyList<PathMapping> Mappings)
    {
        public QbittorrentTelemetryResultKind? Error { get; private init; }

        public ConfigurationCapture? Value => Error == null ? this : null;

        public static ConfigurationCapture TryCreate(
            IPluginConfigProvider provider,
            bool requireEnabled)
        {
            var configuration = provider.ConfigurationOrNull;
            if (configuration == null)
            {
                return Failed(QbittorrentTelemetryResultKind.InvalidConfiguration);
            }

            if (requireEnabled && !configuration.QbittorrentTelemetryEnabled)
            {
                return Failed(QbittorrentTelemetryResultKind.Disabled);
            }

            var mappings = ParseMappings(configuration.QbittorrentPathMappings);
            if (mappings == null
                || mappings.Count == 0
                || string.IsNullOrWhiteSpace(configuration.QbittorrentUsername)
                || configuration.QbittorrentUsername.Length > 256
                || string.IsNullOrEmpty(configuration.QbittorrentPassword)
                || configuration.QbittorrentPassword.Length > 512
                || !ServiceUrlResolver.TryNormalizeHttpBaseUrl(
                    configuration.QbittorrentUrl,
                    out var normalized)
                || !Uri.TryCreate(normalized.TrimEnd('/') + "/", UriKind.Absolute, out var baseUri))
            {
                return Failed(QbittorrentTelemetryResultKind.InvalidConfiguration);
            }

            return new ConfigurationCapture(
                provider.ConfigurationRevision,
                normalized,
                baseUri,
                configuration.QbittorrentUsername,
                configuration.QbittorrentPassword,
                mappings);
        }

        private static ConfigurationCapture Failed(QbittorrentTelemetryResultKind error)
            => new(0, string.Empty, new Uri("http://127.0.0.1/"), string.Empty, string.Empty,
                Array.Empty<PathMapping>())
            {
                Error = error,
            };
    }
}
