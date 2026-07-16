using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Model.Arr;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Arr
{
    /// <summary>
    /// Result of collecting one complete Sonarr/Radarr QueueResource. Items may contain the
    /// successfully projected prefix when <see cref="IsComplete"/> is false, but callers must not
    /// publish that prefix as a complete queue snapshot.
    /// </summary>
    public sealed class ArrQueueCollection<T>
        where T : class
    {
        public List<T> Items { get; } = new();

        public bool IsComplete { get; internal set; }

        public string? Error { get; internal set; }
    }

    /// <summary>
    /// Shared Sonarr/Radarr fetch plumbing (moved verbatim from
    /// <c>JellyfinCanopyControllerBase.FetchAndMapAsync</c>): SSRF-guarded GET
    /// against an instance, per-request API key, per-endpoint timeout, and the
    /// error taxonomy the queue/calendar/links endpoints render per instance.
    /// DI singleton; consumers are the Arr controllers.
    /// </summary>
    public sealed class ArrFetchService
    {
        // QueueResource can legitimately be much larger than the default 100/200-row action pages.
        // These aggregate guards permit up to 100,000 records while bounding retained identities /
        // projections, HTTP round trips, and wall-clock collection time. A page is capped at 1,000
        // records so a single response cannot defeat the collection's memory bound.
        public const int MaxQueueRecords = 100_000;
        public const int MaxQueuePages = 1_000;
        public const int MaxQueuePageSize = 1_000;
        public static readonly TimeSpan MaxQueueCollectionDuration = TimeSpan.FromSeconds(45);

        private readonly IHttpClientFactory _httpClientFactory;
        private readonly ILogger<ArrFetchService> _logger;

        public ArrFetchService(IHttpClientFactory httpClientFactory, ILogger<ArrFetchService> logger)
        {
            _httpClientFactory = httpClientFactory;
            _logger = logger;
        }

        // Async URL guard so the DNS resolution inside the shared guard doesn't
        // block the request thread before the first await — otherwise N
        // instances serialize their DNS lookups in the Select() prelude.
        private async Task<bool> IsAllowedUrlAsync(string url, CancellationToken ct)
        {
            var allowed = await Helpers.ArrUrlGuard.IsAllowedUrlAsync(url, ct).ConfigureAwait(false);
            if (!allowed && !string.IsNullOrWhiteSpace(url))
            {
                // Log at Error so admins can diagnose "instance doesn't return data"
                // issues caused by a URL that hits the block list (e.g. metadata endpoints, loopback).
                _logger.LogError($"IsAllowedUrl rejected outbound URL: {url}");
            }

            return allowed;
        }

        public Task<(T Result, string? Error)> FetchAndMapAsync<T>(
            ArrInstance instance,
            string endpointPath,
            Func<JsonNode?, T> mapper,
            T emptyResult,
            TimeSpan timeout,
            string contextLabel,
            CancellationToken ct)
            => SendAndMapAsync(instance, HttpMethod.Get, endpointPath, jsonBody: null, mapper, emptyResult, timeout, contextLabel, ct);

        /// <summary>
        /// Collects a complete typed Arr QueueResource using its page metadata. Stable record ids
        /// drive deduplication and forward-progress checks; projection happens a page at a time so
        /// filtered consumers retain only their own rows. Any failed page, changing/non-advancing
        /// metadata, duplicate-only page, or aggregate limit returns an explicit incomplete result.
        /// </summary>
        public async Task<ArrQueueCollection<T>> FetchQueueCollectionAsync<T>(
            ArrInstance instance,
            Func<int, int, string> endpointPath,
            int pageSize,
            Func<JsonNode, string?> identity,
            Func<JsonNode, T?> projector,
            TimeSpan requestTimeout,
            string contextLabel,
            CancellationToken ct)
            where T : class
        {
            var result = new ArrQueueCollection<T>();
            if (pageSize is < 1 or > MaxQueuePageSize)
            {
                result.Error = $"invalid queue page size {pageSize}";
                return result;
            }

            var identities = new HashSet<string>(StringComparer.Ordinal);
            int? expectedTotal = null;
            using var collectionCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            collectionCts.CancelAfter(MaxQueueCollectionDuration);

            try
            {
                for (var requestedPage = 1; requestedPage <= MaxQueuePages; requestedPage++)
                {
                    var (page, pageError) = await FetchAndMapAsync<ArrQueuePage?>(
                        instance,
                        endpointPath(requestedPage, pageSize),
                        ParseQueuePage,
                        emptyResult: null,
                        timeout: requestTimeout,
                        contextLabel: $"{contextLabel} page {requestedPage}",
                        ct: collectionCts.Token).ConfigureAwait(false);

                    if (pageError != null)
                    {
                        result.Error = $"page {requestedPage}: {pageError}";
                        return result;
                    }

                    if (page == null)
                    {
                        result.Error = $"page {requestedPage}: invalid queue pagination metadata";
                        return result;
                    }

                    if (page.Page != requestedPage || page.PageSize != pageSize)
                    {
                        result.Error = $"page {requestedPage}: non-advancing queue pagination metadata";
                        return result;
                    }

                    if (page.TotalRecords is < 0 or > MaxQueueRecords)
                    {
                        result.Error = $"page {requestedPage}: queue exceeds the {MaxQueueRecords}-record safety limit";
                        return result;
                    }

                    if (page.Records.Count > pageSize)
                    {
                        result.Error = $"page {requestedPage}: response exceeds its declared page size";
                        return result;
                    }

                    if (expectedTotal.HasValue && expectedTotal.Value != page.TotalRecords)
                    {
                        result.Error = $"page {requestedPage}: totalRecords changed during queue collection";
                        return result;
                    }

                    expectedTotal ??= page.TotalRecords;
                    var newRecords = 0;
                    try
                    {
                        foreach (var record in page.Records)
                        {
                            var recordIdentity = identity(record);
                            if (string.IsNullOrWhiteSpace(recordIdentity))
                            {
                                result.Error = $"page {requestedPage}: queue record has no stable identity";
                                return result;
                            }

                            if (!identities.Add(recordIdentity))
                                continue;

                            newRecords++;
                            var projected = projector(record);
                            if (projected != null)
                                result.Items.Add(projected);
                        }
                    }
                    catch (OperationCanceledException) when (ct.IsCancellationRequested)
                    {
                        throw;
                    }
                    catch (JsonException ex)
                    {
                        _logger.LogError($"Invalid queue record in {contextLabel} from {instance.Name}, page {requestedPage}: {ex.Message}");
                        result.Error = $"page {requestedPage}: invalid response";
                        return result;
                    }
                    catch (InvalidOperationException ex)
                    {
                        _logger.LogError($"Invalid queue record in {contextLabel} from {instance.Name}, page {requestedPage}: {ex.Message}");
                        result.Error = $"page {requestedPage}: invalid response";
                        return result;
                    }
                    catch (FormatException ex)
                    {
                        _logger.LogError($"Invalid queue record in {contextLabel} from {instance.Name}, page {requestedPage}: {ex.Message}");
                        result.Error = $"page {requestedPage}: invalid response";
                        return result;
                    }
                    catch (OverflowException ex)
                    {
                        _logger.LogError($"Invalid queue record in {contextLabel} from {instance.Name}, page {requestedPage}: {ex.Message}");
                        result.Error = $"page {requestedPage}: invalid response";
                        return result;
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError($"Unexpected queue projection error in {contextLabel} from {instance.Name}, page {requestedPage}: {ex.Message}");
                        result.Error = $"page {requestedPage}: internal error";
                        return result;
                    }

                    if (identities.Count > MaxQueueRecords)
                    {
                        result.Error = $"page {requestedPage}: queue exceeds the {MaxQueueRecords}-record safety limit";
                        return result;
                    }

                    if (identities.Count == page.TotalRecords)
                    {
                        result.IsComplete = true;
                        return result;
                    }

                    if (identities.Count > page.TotalRecords)
                    {
                        result.Error = $"page {requestedPage}: queue contains more identities than totalRecords";
                        return result;
                    }

                    if (page.Records.Count == 0 || newRecords == 0)
                    {
                        result.Error = $"page {requestedPage}: queue records did not advance";
                        return result;
                    }

                    if (page.Records.Count < pageSize)
                    {
                        result.Error = $"page {requestedPage}: partial page ended before totalRecords";
                        return result;
                    }
                }

                result.Error = $"queue exceeds the {MaxQueuePages}-page safety limit";
                return result;
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested && collectionCts.IsCancellationRequested)
            {
                result.Error = $"queue collection exceeded {MaxQueueCollectionDuration.TotalSeconds:0} seconds";
                return result;
            }
        }

        private static ArrQueuePage? ParseQueuePage(JsonNode? node)
        {
            if (node is not JsonObject obj
                || !TryReadInt(obj["page"], out var page)
                || !TryReadInt(obj["pageSize"], out var pageSize)
                || !TryReadInt(obj["totalRecords"], out var totalRecords)
                || obj["records"] is not JsonArray records)
            {
                return null;
            }

            var rows = new List<JsonNode>(records.Count);
            foreach (var record in records)
            {
                if (record != null)
                    rows.Add(record);
            }

            return new ArrQueuePage(page, pageSize, totalRecords, rows);
        }

        private static bool TryReadInt(JsonNode? node, out int value)
        {
            value = 0;
            return node is JsonValue jsonValue && jsonValue.TryGetValue(out value);
        }

        private sealed record ArrQueuePage(int Page, int PageSize, int TotalRecords, List<JsonNode> Records);

        /// <summary>
        /// Generalized SSRF-guarded arr call for any verb, sharing the exact error taxonomy
        /// and per-request-API-key hygiene of <see cref="FetchAndMapAsync{T}"/>. A non-null
        /// <paramref name="jsonBody"/> is serialized as <c>application/json</c> (used by the
        /// Search feature's command/grab/monitor/add POST+PUT endpoints). Sonarr/Radarr return
        /// 200/201/202 for these; every 2xx is treated as success and its body handed to the
        /// mapper (which may ignore it for fire-and-forget calls).
        /// </summary>
        public async Task<(T Result, string? Error)> SendAndMapAsync<T>(
            ArrInstance instance,
            HttpMethod method,
            string endpointPath,
            object? jsonBody,
            Func<JsonNode?, T> mapper,
            T emptyResult,
            TimeSpan timeout,
            string contextLabel,
            CancellationToken ct)
        {
            if (!await IsAllowedUrlAsync(instance.Url, ct).ConfigureAwait(false))
                return (emptyResult, "URL rejected by SSRF guard");

            try
            {
                var url = instance.Url.TrimEnd('/');
                // Named arr client (redirects followed — see PluginHttpClients for why
                // that differs from the Seerr client). The API key rides on the request,
                // never on DefaultRequestHeaders. The caller-supplied timeout is applied
                // to this factory-created instance (instance-scoped, so this is safe) to
                // keep each endpoint's historical deadline (10s links/requests, 15s calendar).
                var client = Helpers.PluginHttpClients.CreateArrClient(_httpClientFactory);
                client.Timeout = timeout;

                using var request = Helpers.PluginHttpClients.BuildArrRequest(method, $"{url}{endpointPath}", instance.ApiKey);
                if (jsonBody != null)
                {
                    var payload = JsonSerializer.Serialize(jsonBody);
                    request.Content = new StringContent(payload, System.Text.Encoding.UTF8, "application/json");
                }

                var response = await client.SendAsync(request, ct);

                if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized
                    || response.StatusCode == System.Net.HttpStatusCode.Forbidden)
                {
                    // Before the FetchAndMapAsync consolidation this path only surfaced via the
                    // response envelope, so a bad API key would leave no server-side trail. Log
                    // at Error to keep diagnosability on par with the exception branches below.
                    _logger.LogError($"Authentication failed for {contextLabel} from {instance.Name}: HTTP {(int)response.StatusCode}");
                    return (emptyResult, $"authentication failed ({(int)response.StatusCode})");
                }

                if (!response.IsSuccessStatusCode)
                {
                    _logger.LogError($"Upstream error fetching {contextLabel} from {instance.Name}: HTTP {(int)response.StatusCode}");
                    return (emptyResult, $"HTTP {(int)response.StatusCode}");
                }

                var json = await response.Content.ReadAsStringAsync(ct);
                // Empty body maps like Newtonsoft's DeserializeObject("") — a null
                // document handed to the mapper, not a parse error.
                var data = string.IsNullOrWhiteSpace(json) ? null : JsonNode.Parse(json);
                return (mapper(data), null);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (HttpRequestException ex)
            {
                _logger.LogError($"Network error fetching {contextLabel} from {instance.Name}: {ex.Message}");
                return (emptyResult, "network error");
            }
            catch (TaskCanceledException ex)
            {
                _logger.LogError($"Timeout fetching {contextLabel} from {instance.Name}: {ex.Message}");
                return (emptyResult, "timeout");
            }
            catch (JsonException ex)
            {
                _logger.LogError($"Invalid JSON from {contextLabel} {instance.Name}: {ex.Message}");
                return (emptyResult, "invalid response");
            }
            catch (Exception ex)
            {
                _logger.LogError($"Unexpected error fetching {contextLabel} from {instance.Name}: {ex.Message}");
                return (emptyResult, "internal error");
            }
        }

        /// <summary>Extracts the root-folder portion of an Arr on-disk path (everything before the last segment).</summary>
        public static string? GetRootFolderFromPath(string? path)
        {
            if (string.IsNullOrWhiteSpace(path))
                return null;

            var trimmed = path.TrimEnd('/', '\\');
            if (trimmed.Length == 0 && (path[0] == '/' || path[0] == '\\'))
                return path[0].ToString();
            if (trimmed.Length == 2 && path.Length >= 3 && path[1] == ':'
                && (path[2] == '/' || path[2] == '\\'))
                return path.Substring(0, 3);
            var lastSlash = Math.Max(trimmed.LastIndexOf('/'), trimmed.LastIndexOf('\\'));
            if (lastSlash == 0)
                return trimmed.Substring(0, 1);
            if (lastSlash == 2 && trimmed.Length >= 3 && trimmed[1] == ':')
                return trimmed.Substring(0, 3);
            if (lastSlash <= 0)
                return trimmed;

            return trimmed.Substring(0, lastSlash);
        }
    }
}
