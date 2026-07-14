using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services
{
    // Debounced bridge from Jellyfin's library ItemAdded event to Seerr's
    // /api/v1/settings/jobs/jellyfin-recently-added-scan/run endpoint, so admins can
    // disable Seerr's 5-minute cron and have the scan run only when Jellyfin actually
    // ingests new content.
    public class SeerrScanTriggerService : IDisposable
    {
        private const string ScanJobId = "jellyfin-recently-added-scan";
        private const int MinDebounceSeconds = 5;
        private const int MaxDebounceSeconds = 3600;

        private readonly ILibraryManager _libraryManager;
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly ILogger<SeerrScanTriggerService> _logger;
        private readonly IPluginConfigProvider _configProvider;

        private readonly object _stateLock = new();
        private readonly Timer _debounceTimer;
        private int _pendingCount;
        private bool _subscribed;
        private bool _disposed;

        public SeerrScanTriggerService(
            ILibraryManager libraryManager,
            IHttpClientFactory httpClientFactory,
            ILogger<SeerrScanTriggerService> logger,
            IPluginConfigProvider configProvider)
        {
            _libraryManager = libraryManager;
            _httpClientFactory = httpClientFactory;
            _logger = logger;
            _configProvider = configProvider;
            _debounceTimer = new Timer(OnDebounceElapsed, null, Timeout.Infinite, Timeout.Infinite);
        }

        public void Initialize()
        {
            // Always subscribe; the per-event handler re-checks config at fire time so
            // an admin toggling the feature on doesn't require a Jellyfin restart.
            // Mirrors the WatchlistMonitor pattern.
            lock (_stateLock)
            {
                if (_subscribed) return;
                _libraryManager.ItemAdded += OnItemAdded;
                _subscribed = true;
            }
            _logger.LogInformation("[SeerrScan] Subscribed to library ItemAdded events");
        }

        private void OnItemAdded(object? sender, ItemChangeEventArgs e)
        {
            // PERF(S1): fires synchronously on Jellyfin's library-scan thread — only cheap config/kind
            // checks then a counter bump + debounce-timer reset here; the Seerr HTTP POST runs off the
            // timer thread. See docs/advanced/performance-rules.md (S1).
            try
            {
                if (_configProvider.ConfigurationOrNull is not PluginConfiguration config) return;
                if (!config.TriggerSeerrScanOnItemAdded) return;
                if (!config.SeerrEnabled) return;

                // Seerr's recently-added scan only inspects movies and series (and crawls
                // their seasons/episodes itself). Filtering on the parent kinds avoids
                // triggering on metadata noise (BoxSet, Folder, Audio, Photo, etc).
                var kind = e.Item?.GetBaseItemKind();
                if (kind != BaseItemKind.Movie
                    && kind != BaseItemKind.Series
                    && kind != BaseItemKind.Season
                    && kind != BaseItemKind.Episode)
                {
                    return;
                }

                var debounce = ClampDebounceSeconds(config.SeerrScanDebounceSeconds);
                lock (_stateLock)
                {
                    if (_disposed) return;
                    _pendingCount++;
                    // Reset the timer on every event — the actual POST runs `debounce`
                    // seconds after the LAST event in the burst.
                    _debounceTimer.Change(TimeSpan.FromSeconds(debounce), Timeout.InfiniteTimeSpan);
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"[SeerrScan] OnItemAdded handler threw: {ex.Message}");
            }
        }

        private void OnDebounceElapsed(object? state)
        {
            int batchSize;
            lock (_stateLock)
            {
                if (_disposed) return;
                batchSize = Interlocked.Exchange(ref _pendingCount, 0);
            }
            if (batchSize <= 0) return;

            // Fire-and-forget; the timer thread should not block on HTTP.
            _ = DispatchAsync(batchSize);
        }

        // Public so the admin "Trigger scan now" button (controller endpoint) can
        // bypass the debounce and force a scan immediately.
        public Task<IReadOnlyList<DispatchResult>> TriggerNowAsync()
        {
            return DispatchAsync(0);
        }

        internal async Task<IReadOnlyList<DispatchResult>> DispatchAsync(int batchSize)
        {
            var results = new List<DispatchResult>();
            try
            {
                if (_configProvider.ConfigurationOrNull is not PluginConfiguration config)
                {
                    _logger.LogWarning("[SeerrScan] Cannot dispatch: plugin configuration is null");
                    return results;
                }

                var configurationRevision = _configProvider.ConfigurationRevision;
                var configStamp = SeerrMutationConfigStamp.Capture(
                    config,
                    configurationRevision);
                bool IsConfigurationCurrent() => configStamp.Matches(
                    _configProvider.ConfigurationOrNull,
                    _configProvider.ConfigurationRevision);

                // A debounced timer is only authorization to reconsider the
                // event under the current configuration. Disabling either the
                // integration or this trigger while the timer is pending must
                // cancel the queued side effect. Manual calls retain their
                // explicit semantics but still use one stamped source/key set.
                if (batchSize > 0
                    && (!config.SeerrEnabled || !config.TriggerSeerrScanOnItemAdded))
                {
                    _logger.LogInformation(
                        "[SeerrScan] Discarded a pending scan trigger because the feature is no longer enabled");
                    return results;
                }

                var apiKey = config.SeerrApiKey;
                var urls = ParseUrls(config.SeerrUrls);
                if (urls.Count == 0 || string.IsNullOrEmpty(apiKey) || !IsConfigurationCurrent())
                {
                    _logger.LogWarning("[SeerrScan] Cannot dispatch: Seerr URL(s) or API key not configured");
                    return results;
                }

                // Each normalized distinct URL is its own Seerr identity domain,
                // not a failover candidate. PostScanTrigger contains failures so
                // every configured domain is attempted exactly once per batch.
                foreach (var url in urls)
                {
                    // Never continue a multi-domain mutation batch with a
                    // retired URL/key snapshot after an admin save lands while
                    // an earlier domain is in flight.
                    if (!IsConfigurationCurrent())
                    {
                        _logger.LogWarning(
                            "[SeerrScan] Configuration changed during dispatch; remaining Seerr domains were not triggered");
                        break;
                    }

                    var result = await PostScanTrigger(url, apiKey).ConfigureAwait(false);
                    results.Add(result);
                    if (result.Success)
                    {
                        if (batchSize > 0)
                            _logger.LogInformation($"[SeerrScan] Triggered Seerr recently-added scan after {batchSize} library item(s) — {url}");
                        else
                            _logger.LogInformation($"[SeerrScan] Triggered Seerr recently-added scan (manual) — {url}");
                    }
                    else
                    {
                        _logger.LogWarning($"[SeerrScan] Trigger failed for {url}: HTTP {result.StatusCode} — {result.Body}");
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.LogError($"[SeerrScan] Dispatch threw: {ex.Message}");
            }
            return results;
        }

        private async Task<DispatchResult> PostScanTrigger(string url, string apiKey)
        {
            // previously reported `Success = response.IsSuccessStatusCode`,
            // which is true for a 200 + Cloudflare HTML challenge body — the
            // background trigger logged "scan dispatched" when the request was
            // actually intercepted by a reverse-proxy auth challenge. Use the
            // helper so HTML responses are classified as failures.
            var endpoint = $"{url.TrimEnd('/')}/api/v1/settings/jobs/{ScanJobId}/run";
            try
            {
                var http = Helpers.Seerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
                http.Timeout = TimeSpan.FromSeconds(15);
                using var request = Helpers.Seerr.SeerrHttpHelper.BuildRequest(
                    HttpMethod.Post, endpoint, apiKey, bodyJson: "{}");

                using var response = await http.SendAsync(request).ConfigureAwait(false);
                var (json, error) = await Helpers.Seerr.SeerrHttpHelper.ReadResponseAsync(response, endpoint).ConfigureAwait(false);
                return new DispatchResult
                {
                    Url = url,
                    Success = error == null,
                    StatusCode = error?.HttpStatus ?? (int)response.StatusCode,
                    Body = Truncate(error?.Message ?? (json ?? string.Empty), 256)
                };
            }
            catch (Exception ex)
            {
                return new DispatchResult
                {
                    Url = url,
                    Success = false,
                    StatusCode = 0,
                    Body = ex.Message
                };
            }
        }

        // Keep background dispatch on the same comma/newline/trailing-slash
        // alias rules as all other Seerr source selection.
        internal static List<string> ParseUrls(string? raw)
            => Seerr.SeerrClient.GetConfiguredUrls(raw).ToList();

        private static int ClampDebounceSeconds(int requested)
        {
            if (requested < MinDebounceSeconds) return MinDebounceSeconds;
            if (requested > MaxDebounceSeconds) return MaxDebounceSeconds;
            return requested;
        }

        private static string Truncate(string s, int max)
        {
            if (string.IsNullOrEmpty(s)) return string.Empty;
            return s.Length <= max ? s : s.Substring(0, max) + "…";
        }

        public void Dispose()
        {
            lock (_stateLock)
            {
                if (_disposed) return;
                _disposed = true;
                if (_subscribed)
                {
                    _libraryManager.ItemAdded -= OnItemAdded;
                    _subscribed = false;
                }
                _debounceTimer.Dispose();
            }
            GC.SuppressFinalize(this);
        }

        public class DispatchResult
        {
            public string Url { get; set; } = string.Empty;
            public bool Success { get; set; }
            public int StatusCode { get; set; }
            public string Body { get; set; } = string.Empty;
        }
    }
}
