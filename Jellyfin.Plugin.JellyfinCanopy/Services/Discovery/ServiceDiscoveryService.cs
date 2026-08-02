using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Discovery
{
    /// <summary>A confirmed connected service found by a discovery scan.</summary>
    /// <param name="Service">Stable service id: <c>sonarr</c>, <c>radarr</c>, <c>bazarr</c>, <c>seerr</c> or <c>maintainerr</c>.</param>
    /// <param name="Url">The confirmed internal base URL (server-reachable, never probe-page content).</param>
    public sealed record DiscoveredService(string Service, string Url);

    /// <summary>One probe target: a service id expected at <c>http://Host:Port</c>.</summary>
    internal sealed record DiscoveryCandidate(string Service, string Host, int Port)
    {
        public string Url => $"http://{Host}:{Port}";
    }

    /// <summary>
    /// Admin-triggered auto-discovery of the plugin's connected services
    /// (Sonarr, Radarr, Bazarr, Seerr family, Maintainerr).
    ///
    /// The scan is stateless and strictly bounded: a server-built candidate list
    /// (well-known Docker DNS names and default ports, loopback, the default
    /// Docker bridge gateway, <c>host.docker.internal</c>, plus hosts the admin
    /// already configured for sibling services) is filtered through
    /// <see cref="ArrUrlGuard"/>, probed with capped concurrency/timeouts/reads,
    /// and only service-confirmed hits are returned. Probes are credential-free:
    /// no configured API key is ever attached to a discovery request. This is an
    /// on-demand admin action — no background, scheduled, or startup work.
    /// </summary>
    public sealed class ServiceDiscoveryService
    {
        // Bounds. MaxCandidates caps the whole scan even if an admin configures
        // many cross-pollination hosts; the per-probe timeout covers DNS+connect+read.
        internal const int MaxCandidates = 64;
        internal const int MaxConcurrentProbes = 6;
        internal const int MaxResultsPerService = 5;
        internal static readonly TimeSpan PerProbeTimeout = TimeSpan.FromSeconds(3);
        internal static readonly TimeSpan OverallTimeout = TimeSpan.FromSeconds(15);
        internal const int MaxStatusBodyBytes = 8 * 1024;
        internal const int MaxTitleBodyBytes = 64 * 1024;

        /// <summary>
        /// A known connected service. <paramref name="StatusPath"/> non-null means
        /// "confirm via an unauthenticated JSON status endpoint carrying a string
        /// <c>version</c>"; null means "confirm via the served page &lt;title&gt;
        /// containing <paramref name="TitleToken"/>" (the arr web UIs and their
        /// login pages both title themselves with the product name).
        /// </summary>
        internal sealed record KnownService(string Id, int DefaultPort, string[] WellKnownHosts, string? StatusPath, string TitleToken);

        internal static readonly KnownService[] KnownServices =
        {
            new("sonarr", 8989, new[] { "sonarr" }, null, "sonarr"),
            new("radarr", 7878, new[] { "radarr" }, null, "radarr"),
            new("bazarr", 6767, new[] { "bazarr" }, null, "bazarr"),
            // Seerr (current name) plus its legacy Jellyseerr/Overseerr hostnames
            // all serve GET /api/v1/status without authentication; any flavour
            // satisfies the plugin's Seerr integration. "seerr" first so the
            // current product name wins when aliases resolve to one container.
            new("seerr", 5055, new[] { "seerr", "jellyseerr", "overseerr" }, "/api/v1/status", "seerr"),
            // Maintainerr's unauthenticated status route (the same one the
            // Maintainerr integration's capability audit uses).
            new("maintainerr", 6246, new[] { "maintainerr" }, "/api/app/status", "maintainerr"),
        };

        // Non-Docker-DNS fallbacks: same-host installs (loopback), the default
        // Docker bridge gateway (host-published ports seen from a container),
        // and Docker Desktop's host alias. Unresolvable entries fail closed fast.
        internal static readonly string[] GenericHosts = { "127.0.0.1", "172.17.0.1", "host.docker.internal" };

        // Title extraction is bounded (capped body + regex match timeout) because
        // the response body is untrusted LAN content.
        private static readonly Regex _titleRegex = new(
            "<title[^>]*>([^<]{0,256})",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant,
            TimeSpan.FromMilliseconds(250));

        // Instance-level (the service is a DI singleton): concurrent admin
        // clicks share one scan; a fresh scan starts once the last completes.
        private readonly ConcurrentDictionary<string, Lazy<Task<IReadOnlyList<DiscoveredService>>>> _inFlight = new();

        private readonly IHttpClientFactory _httpClientFactory;
        private readonly IPluginConfigProvider _configProvider;
        private readonly ILogger<ServiceDiscoveryService> _logger;
        private readonly Func<string, CancellationToken, Task<bool>> _urlGuard;
        private readonly Func<string, CancellationToken, Task<IPAddress[]>> _resolveHost;

        public ServiceDiscoveryService(
            IHttpClientFactory httpClientFactory,
            IPluginConfigProvider configProvider,
            ILogger<ServiceDiscoveryService> logger)
            : this(httpClientFactory, configProvider, logger, ArrUrlGuard.IsAllowedUrlAsync, ResolveAsync)
        {
        }

        /// <summary>
        /// Test seam: the guard/resolver injections only replace the cheap
        /// pre-filter — in production the guarded handler's connect-time IP check
        /// (<see cref="ArrUrlGuard.CreateGuardedHandler"/>) remains the
        /// authoritative SSRF fence for every actual probe connection.
        /// </summary>
        internal ServiceDiscoveryService(
            IHttpClientFactory httpClientFactory,
            IPluginConfigProvider configProvider,
            ILogger<ServiceDiscoveryService> logger,
            Func<string, CancellationToken, Task<bool>> urlGuard,
            Func<string, CancellationToken, Task<IPAddress[]>> resolveHost)
        {
            _httpClientFactory = httpClientFactory;
            _configProvider = configProvider;
            _logger = logger;
            _urlGuard = urlGuard;
            _resolveHost = resolveHost;
        }

        /// <summary>
        /// Runs (or joins) one bounded discovery scan. Concurrent admin clicks
        /// share a single scan via single-flight; the scan runs under its own
        /// overall timeout rather than the caller's request token so an admin
        /// navigating away cannot strand a half-observed shared result.
        /// </summary>
        public Task<IReadOnlyList<DiscoveredService>> DiscoverAsync()
            => AsyncSingleFlight.GetOrAdd(_inFlight, "scan", RunScanAsync);

        private async Task<IReadOnlyList<DiscoveredService>> RunScanAsync()
        {
            var config = _configProvider.ConfigurationOrNull;
            if (config == null)
            {
                return Array.Empty<DiscoveredService>();
            }

            var candidates = BuildCandidates(config);
            if (candidates.Count == 0)
            {
                return Array.Empty<DiscoveredService>();
            }

            using var overallCts = new CancellationTokenSource(OverallTimeout);
            var client = PluginHttpClients.CreateDiscoveryClient(_httpClientFactory);
            using var gate = new SemaphoreSlim(MaxConcurrentProbes, MaxConcurrentProbes);

            var probes = candidates
                .Select(candidate => ProbeCandidateAsync(client, gate, candidate, overallCts.Token))
                .ToArray();
            var outcomes = await Task.WhenAll(probes).ConfigureAwait(false);

            // Keep the first confirmed hit per (service, resolved endpoint) in
            // candidate order, so the well-known Docker DNS name wins over a
            // cross-pollinated alias of the same container, then cap per service.
            var seenEndpoints = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var perServiceCounts = new Dictionary<string, int>(StringComparer.Ordinal);
            var results = new List<DiscoveredService>();
            foreach (var outcome in outcomes)
            {
                if (outcome == null)
                {
                    continue;
                }

                var count = perServiceCounts.GetValueOrDefault(outcome.Candidate.Service);
                if (count >= MaxResultsPerService
                    || !seenEndpoints.Add($"{outcome.Candidate.Service}|{outcome.EndpointKey}"))
                {
                    continue;
                }

                perServiceCounts[outcome.Candidate.Service] = count + 1;
                results.Add(new DiscoveredService(outcome.Candidate.Service, outcome.Candidate.Url));
            }

            _logger.LogInformation(
                $"Service discovery scan probed {candidates.Count} candidates and confirmed {results.Count} service(s).");
            return results;
        }

        private sealed record ProbeOutcome(DiscoveryCandidate Candidate, string EndpointKey);

        private async Task<ProbeOutcome?> ProbeCandidateAsync(
            HttpClient client,
            SemaphoreSlim gate,
            DiscoveryCandidate candidate,
            CancellationToken overallToken)
        {
            try
            {
                await gate.WaitAsync(overallToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return null;
            }

            try
            {
                using var probeCts = CancellationTokenSource.CreateLinkedTokenSource(overallToken);
                probeCts.CancelAfter(PerProbeTimeout);
                var ct = probeCts.Token;

                if (!await _urlGuard(candidate.Url, ct).ConfigureAwait(false))
                {
                    return null;
                }

                // Resolve once for the duplicate-endpoint key. Failure fails the
                // candidate closed, matching the guard's resolver policy.
                var addresses = await _resolveHost(candidate.Host, ct).ConfigureAwait(false);
                var address = addresses.FirstOrDefault(a => !ArrUrlGuard.IsBlockedIp(a));
                if (address == null)
                {
                    return null;
                }

                var service = KnownServices.First(s => s.Id == candidate.Service);
                var confirmed = service.StatusPath != null
                    ? await ProbeStatusAsync(client, candidate.Url + service.StatusPath, ct).ConfigureAwait(false)
                    : await ProbeTitleAsync(client, candidate.Url + "/", service.TitleToken, ct).ConfigureAwait(false);
                return confirmed
                    ? new ProbeOutcome(candidate, $"{address}:{candidate.Port}")
                    : null;
            }
            catch (Exception ex) when (
                ex is HttpRequestException
                    or OperationCanceledException
                    or SocketException
                    or IOException
                    or ArgumentException
                    or InvalidOperationException)
            {
                // An unreachable or non-matching candidate is simply "not found";
                // it must never fail the scan.
                _logger.LogDebug(
                    $"Discovery probe for {candidate.Service} at {candidate.Url} did not confirm ({ex.GetType().Name}).");
                return null;
            }
            finally
            {
                gate.Release();
            }
        }

        internal const int MaxRedirects = 3;

        /// <summary>
        /// Issues a probe GET with redirects followed explicitly and ONLY within
        /// the exact candidate origin: same host, same port, and same scheme or
        /// an http→https upgrade. Any cross-origin redirect aborts the probe
        /// (returns null) without the destination ever being requested — a
        /// hostile responder on a well-known candidate must not be able to
        /// steer the scan anywhere else (SEC-REDIRECT-SCOPE).
        /// </summary>
        private static async Task<HttpResponseMessage?> FetchWithinCandidateOriginAsync(
            HttpClient client,
            string url,
            CancellationToken ct)
        {
            var current = new Uri(url, UriKind.Absolute);
            for (var hop = 0; hop <= MaxRedirects; hop++)
            {
                var response = await client.GetAsync(current, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
                var status = (int)response.StatusCode;
                if (status is not (301 or 302 or 303 or 307 or 308))
                {
                    return response;
                }

                var location = response.Headers.Location;
                response.Dispose();
                if (location == null)
                {
                    return null;
                }

                var target = location.IsAbsoluteUri ? location : new Uri(current, location);
                if (!IsSameOriginRedirectTarget(current, target))
                {
                    return null;
                }

                current = target;
            }

            return null;
        }

        internal static bool IsSameOriginRedirectTarget(Uri current, Uri target)
        {
            if (!string.Equals(target.Host, current.Host, StringComparison.OrdinalIgnoreCase)
                || target.Port != current.Port)
            {
                return false;
            }

            // Same scheme, or an upgrade to https; never a downgrade and never
            // a non-http(s) scheme.
            return string.Equals(target.Scheme, current.Scheme, StringComparison.OrdinalIgnoreCase)
                ? target.Scheme is "http" or "https"
                : string.Equals(current.Scheme, "http", StringComparison.OrdinalIgnoreCase)
                    && string.Equals(target.Scheme, "https", StringComparison.OrdinalIgnoreCase);
        }

        private static async Task<bool> ProbeStatusAsync(HttpClient client, string url, CancellationToken ct)
        {
            using var response = await FetchWithinCandidateOriginAsync(client, url, ct).ConfigureAwait(false);
            if (response == null || response.StatusCode != HttpStatusCode.OK)
            {
                return false;
            }

            // Parse leniently regardless of Content-Type: Maintainerr serves its
            // status JSON as text/html.
            var body = await ReadCappedAsync(response, MaxStatusBodyBytes, ct).ConfigureAwait(false);
            try
            {
                using var doc = JsonDocument.Parse(body);
                return doc.RootElement.ValueKind == JsonValueKind.Object
                    && doc.RootElement.TryGetProperty("version", out var version)
                    && version.ValueKind == JsonValueKind.String;
            }
            catch (JsonException)
            {
                return false;
            }
        }

        private static async Task<bool> ProbeTitleAsync(HttpClient client, string url, string titleToken, CancellationToken ct)
        {
            using var response = await FetchWithinCandidateOriginAsync(client, url, ct).ConfigureAwait(false);
            if (response == null || response.StatusCode != HttpStatusCode.OK)
            {
                return false;
            }

            var body = await ReadCappedAsync(response, MaxTitleBodyBytes, ct).ConfigureAwait(false);
            try
            {
                var match = _titleRegex.Match(body);
                return match.Success
                    && match.Groups[1].Value.Contains(titleToken, StringComparison.OrdinalIgnoreCase);
            }
            catch (RegexMatchTimeoutException)
            {
                return false;
            }
        }

        private static async Task<string> ReadCappedAsync(HttpResponseMessage response, int maxBytes, CancellationToken ct)
        {
            await using var stream = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            var buffer = new byte[maxBytes];
            var total = 0;
            while (total < maxBytes)
            {
                var read = await stream.ReadAsync(buffer.AsMemory(total, maxBytes - total), ct).ConfigureAwait(false);
                if (read <= 0)
                {
                    break;
                }

                total += read;
            }

            // Anything past the cap is deliberately ignored — identification data
            // (status JSON / <title>) always fits well inside the cap.
            return Encoding.UTF8.GetString(buffer, 0, total);
        }

        private static Task<IPAddress[]> ResolveAsync(string host, CancellationToken ct)
            => IPAddress.TryParse(host, out var literal)
                ? Task.FromResult(new[] { literal.IsIPv4MappedToIPv6 ? literal.MapToIPv4() : literal })
                : Dns.GetHostAddressesAsync(host, ct);

        /// <summary>
        /// Builds the ordered, deduplicated, capped candidate list for a
        /// configuration snapshot: well-known service hostnames first, then the
        /// generic same-host fallbacks, then hosts cross-pollinated from already
        /// configured sibling services. Candidates whose host:port the admin has
        /// already configured for that same service are omitted — discovery only
        /// reports new endpoints.
        /// </summary>
        internal static List<DiscoveryCandidate> BuildCandidates(PluginConfiguration config)
        {
            var configuredByService = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
            var configuredHosts = new List<string>();

            void AddConfigured(string service, string? rawUrl)
            {
                if (!ServiceUrlResolver.TryNormalizeHttpBaseUrl(rawUrl, out var normalized)
                    || !Uri.TryCreate(normalized, UriKind.Absolute, out var uri))
                {
                    return;
                }

                var host = uri.Host.ToLowerInvariant();
                if (!configuredByService.TryGetValue(service, out var endpoints))
                {
                    endpoints = new HashSet<string>(StringComparer.Ordinal);
                    configuredByService[service] = endpoints;
                }

                endpoints.Add($"{host}:{uri.Port}");
                if (!configuredHosts.Contains(host))
                {
                    configuredHosts.Add(host);
                }
            }

            foreach (var instance in config.GetSonarrInstances())
            {
                AddConfigured("sonarr", instance?.Url);
            }

            foreach (var instance in config.GetRadarrInstances())
            {
                AddConfigured("radarr", instance?.Url);
            }

            AddConfigured("bazarr", config.BazarrUrl);
            foreach (var line in (config.SeerrUrls ?? string.Empty)
                .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
            {
                AddConfigured("seerr", line);
            }

            AddConfigured("maintainerr", config.MaintainerrUrl);

            var candidates = new List<DiscoveryCandidate>();
            var seen = new HashSet<string>(StringComparer.Ordinal);

            void AddCandidate(string service, string host, int port)
            {
                if (candidates.Count >= MaxCandidates)
                {
                    return;
                }

                var hostKey = host.ToLowerInvariant();
                if (!seen.Add($"{service}|{hostKey}:{port}"))
                {
                    return;
                }

                if (configuredByService.TryGetValue(service, out var endpoints)
                    && endpoints.Contains($"{hostKey}:{port}"))
                {
                    return;
                }

                candidates.Add(new DiscoveryCandidate(service, hostKey, port));
            }

            foreach (var service in KnownServices)
            {
                foreach (var host in service.WellKnownHosts)
                {
                    AddCandidate(service.Id, host, service.DefaultPort);
                }
            }

            foreach (var service in KnownServices)
            {
                foreach (var host in GenericHosts)
                {
                    AddCandidate(service.Id, host, service.DefaultPort);
                }
            }

            foreach (var host in configuredHosts)
            {
                foreach (var service in KnownServices)
                {
                    AddCandidate(service.Id, host, service.DefaultPort);
                }
            }

            return candidates;
        }
    }
}
