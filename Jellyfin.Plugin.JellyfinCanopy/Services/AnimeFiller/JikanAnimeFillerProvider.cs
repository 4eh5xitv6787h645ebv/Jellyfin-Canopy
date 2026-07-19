using System.Net.Http.Json;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.AnimeFiller;

/// <summary>
/// Credential-free provider backed by the documented Jikan v4 REST API. AniList is
/// used only to translate an existing Jellyfin AniList provider ID to a MAL ID.
/// Origins are fixed by named-client base addresses; no configured URL is accepted.
/// </summary>
public sealed class JikanAnimeFillerProvider : IAnimeFillerProvider
{
    private const int MaximumResponseBytes = 1024 * 1024;
    private const int MaximumEpisodePages = 50;
    private static readonly TimeSpan DefaultOperationTimeout = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan DefaultRequestTimeout = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan UnadvisedRateLimitBackoff = TimeSpan.FromMinutes(1);
    // Jikan publishes 60 requests/minute and 3 requests/second. A 1.01 second
    // origin spacing stays below both ceilings, including rolling-window edges.
    private static readonly TimeSpan MinimumJikanSpacing = TimeSpan.FromMilliseconds(1010);
    // AniList's documented degraded-state ceiling is 30 requests/minute.
    private static readonly TimeSpan MinimumAniListSpacing = TimeSpan.FromMilliseconds(2010);
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<JikanAnimeFillerProvider> _logger;
    private readonly ProviderRateGate _jikanRate;
    private readonly ProviderRateGate _aniListRate;
    private readonly TimeSpan _operationTimeout;
    private readonly TimeSpan _requestTimeout;

    public JikanAnimeFillerProvider(IHttpClientFactory httpClientFactory, ILogger<JikanAnimeFillerProvider> logger)
        : this(
            httpClientFactory,
            logger,
            new ProviderRateGate(MinimumJikanSpacing, unadvisedTooManyRequestsBackoff: UnadvisedRateLimitBackoff),
            new ProviderRateGate(MinimumAniListSpacing, unadvisedTooManyRequestsBackoff: UnadvisedRateLimitBackoff))
    {
    }

    internal JikanAnimeFillerProvider(
        IHttpClientFactory httpClientFactory,
        ILogger<JikanAnimeFillerProvider> logger,
        ProviderRateGate jikanRate,
        ProviderRateGate aniListRate,
        TimeSpan? requestTimeout = null,
        TimeSpan? operationTimeout = null)
    {
        _httpClientFactory = httpClientFactory;
        _logger = logger;
        _jikanRate = jikanRate;
        _aniListRate = aniListRate;
        _requestTimeout = requestTimeout ?? DefaultRequestTimeout;
        _operationTimeout = operationTimeout ?? DefaultOperationTimeout;
        if (_requestTimeout <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(requestTimeout));
        if (_operationTimeout <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(operationTimeout));
    }

    public async Task<int?> ResolveAniListIdAsync(int aniListId, CancellationToken cancellationToken)
    {
        if (aniListId <= 0) return null;
        using var operation = CreateOperation(cancellationToken);
        var client = _httpClientFactory.CreateClient(PluginHttpClients.AniListClient);
        using var request = new HttpRequestMessage(HttpMethod.Post, string.Empty)
        {
            Content = JsonContent.Create(new
            {
                query = "query ($id: Int) { Media(id: $id, type: ANIME) { idMal } }",
                variables = new { id = aniListId },
            }),
        };
        await _aniListRate.WaitAsync(operation.Token).ConfigureAwait(false);
        using var requestDeadline = CreateRequest(operation.Token);
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, requestDeadline.Token).ConfigureAwait(false);
        _aniListRate.Observe(response);
        using var document = await ReadJsonAsync(response, requestDeadline.Token).ConfigureAwait(false);
        return document.RootElement.TryGetProperty("data", out var data)
            && data.TryGetProperty("Media", out var media)
            && media.ValueKind == JsonValueKind.Object
            && media.TryGetProperty("idMal", out var idMal)
            && idMal.TryGetInt32(out var value)
            && value > 0
                ? value
                : null;
    }

    public async Task<IReadOnlyList<AnimeProviderCandidate>> SearchAsync(string title, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(title)) return Array.Empty<AnimeProviderCandidate>();
        using var operation = CreateOperation(cancellationToken);
        var path = $"anime?q={Uri.EscapeDataString(title)}&type=tv&limit=10&sfw=true";
        using var document = await GetJikanJsonAsync(path, operation.Token).ConfigureAwait(false);
        if (!document.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array)
        {
            return Array.Empty<AnimeProviderCandidate>();
        }

        var candidates = new List<AnimeProviderCandidate>();
        foreach (var item in data.EnumerateArray())
        {
            if (!item.TryGetProperty("mal_id", out var idElement) || !idElement.TryGetInt32(out var malId) || malId <= 0) continue;
            int? year = item.TryGetProperty("year", out var yearElement) && yearElement.TryGetInt32(out var parsedYear) ? parsedYear : null;
            AddTitle(item, "title", malId, year, candidates);
            AddTitle(item, "title_english", malId, year, candidates);
            AddTitle(item, "title_japanese", malId, year, candidates);
            if (item.TryGetProperty("title_synonyms", out var synonyms) && synonyms.ValueKind == JsonValueKind.Array)
            {
                foreach (var synonym in synonyms.EnumerateArray())
                {
                    if (synonym.ValueKind == JsonValueKind.String && synonym.GetString() is { Length: > 0 } text)
                    {
                        candidates.Add(new AnimeProviderCandidate(malId, text, year));
                    }
                }
            }
        }

        return candidates
            .DistinctBy(candidate => (candidate.MyAnimeListId, candidate.Title), CandidateTitleComparer.Instance)
            .ToArray();
    }

    public async Task<AnimeProviderEpisodes?> GetEpisodesAsync(int myAnimeListId, CancellationToken cancellationToken)
    {
        if (myAnimeListId <= 0) return null;
        using var operation = CreateOperation(cancellationToken);
        var episodes = new Dictionary<int, bool>();
        for (var page = 1; page <= MaximumEpisodePages; page++)
        {
            using var document = await GetJikanJsonAsync($"anime/{myAnimeListId}/episodes?page={page}", operation.Token).ConfigureAwait(false);
            if (!document.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array) return null;
            foreach (var item in data.EnumerateArray())
            {
                if (!item.TryGetProperty("mal_id", out var idElement) || !idElement.TryGetInt32(out var episodeNumber) || episodeNumber <= 0) continue;
                if (!item.TryGetProperty("filler", out var fillerElement)
                    || fillerElement.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                {
                    continue;
                }

                episodes[episodeNumber] = fillerElement.ValueKind == JsonValueKind.True;
            }

            var hasNext = document.RootElement.TryGetProperty("pagination", out var pagination)
                && pagination.TryGetProperty("has_next_page", out var next)
                && next.ValueKind == JsonValueKind.True;
            if (!hasNext) return AnimeProviderEpisodes.Create(myAnimeListId, episodes);
        }

        _logger.LogWarning("Jikan episode pagination exceeded the {MaximumPages}-page safety bound for MAL {MalId}.", MaximumEpisodePages, myAnimeListId);
        return null;
    }

    private async Task<JsonDocument> GetJikanJsonAsync(string relativePath, CancellationToken cancellationToken)
    {
        await _jikanRate.WaitAsync(cancellationToken).ConfigureAwait(false);
        var client = _httpClientFactory.CreateClient(PluginHttpClients.JikanClient);
        using var requestDeadline = CreateRequest(cancellationToken);
        using var response = await client.GetAsync(relativePath, HttpCompletionOption.ResponseHeadersRead, requestDeadline.Token).ConfigureAwait(false);
        _jikanRate.Observe(response);
        return await ReadJsonAsync(response, requestDeadline.Token).ConfigureAwait(false);
    }

    private CancellationTokenSource CreateOperation(CancellationToken cancellationToken)
    {
        var operation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        operation.CancelAfter(_operationTimeout);
        return operation;
    }

    private CancellationTokenSource CreateRequest(CancellationToken cancellationToken)
    {
        var request = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        request.CancelAfter(_requestTimeout);
        return request;
    }

    private static async Task<JsonDocument> ReadJsonAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        response.EnsureSuccessStatusCode();
        if (response.Content.Headers.ContentLength > MaximumResponseBytes) throw new HttpRequestException("Anime provider response exceeded the size limit.");
        await using var source = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        using var buffer = new MemoryStream();
        var chunk = new byte[16 * 1024];
        while (true)
        {
            var read = await source.ReadAsync(chunk.AsMemory(0, chunk.Length), cancellationToken).ConfigureAwait(false);
            if (read == 0) break;
            if (buffer.Length + read > MaximumResponseBytes) throw new HttpRequestException("Anime provider response exceeded the size limit.");
            buffer.Write(chunk, 0, read);
        }

        buffer.Position = 0;
        return await JsonDocument.ParseAsync(buffer, cancellationToken: cancellationToken).ConfigureAwait(false);
    }

    private static void AddTitle(JsonElement item, string property, int malId, int? year, ICollection<AnimeProviderCandidate> candidates)
    {
        if (item.TryGetProperty(property, out var element) && element.ValueKind == JsonValueKind.String && element.GetString() is { Length: > 0 } title)
        {
            candidates.Add(new AnimeProviderCandidate(malId, title, year));
        }
    }

    private sealed class CandidateTitleComparer : IEqualityComparer<(int MyAnimeListId, string Title)>
    {
        internal static CandidateTitleComparer Instance { get; } = new();

        public bool Equals((int MyAnimeListId, string Title) x, (int MyAnimeListId, string Title) y)
            => x.MyAnimeListId == y.MyAnimeListId && string.Equals(x.Title, y.Title, StringComparison.OrdinalIgnoreCase);

        public int GetHashCode((int MyAnimeListId, string Title) obj)
            => HashCode.Combine(obj.MyAnimeListId, StringComparer.OrdinalIgnoreCase.GetHashCode(obj.Title));
    }
}
