using System;
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
    /// Shared Sonarr/Radarr fetch plumbing (moved verbatim from
    /// <c>JellyfinCanopyControllerBase.FetchAndMapAsync</c>): SSRF-guarded GET
    /// against an instance, per-request API key, per-endpoint timeout, and the
    /// error taxonomy the queue/calendar/links endpoints render per instance.
    /// DI singleton; consumers are the Arr controllers.
    /// </summary>
    public sealed class ArrFetchService
    {
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

            var trimmed = path.TrimEnd('/');
            var lastSlash = trimmed.LastIndexOf('/');
            if (lastSlash <= 0)
                return trimmed;

            return trimmed.Substring(0, lastSlash);
        }
    }
}
