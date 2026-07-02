using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Jellyseerr
{
    /// <summary>
    /// Resolves Jellyfin user ids to Jellyseerr user ids, with a TTL cache.
    /// Hoisted from byte-identical private helpers in AutoMovieRequestService and
    /// AutoSeasonRequestService (only the log prefixes differed). The cache is static
    /// so both singleton services share one process-wide cache, matching the previous
    /// effective semantics (two identical per-singleton dicts).
    ///
    /// Note: the controller base's own Seerr user resolution (SeerrCache) is a
    /// separate copy consolidated in a later phase.
    /// </summary>
    internal class JellyseerrUserResolver
    {
        // Process-wide cache shared by all resolver instances.
        private static readonly Dictionary<string, (string JellyseerrUserId, DateTime CachedAt)> _jellyseerrUserIdCache = new();
        private static readonly object _userIdCacheLock = new();

        private readonly IHttpClientFactory _httpClientFactory;
        private readonly ILogger _logger;
        private readonly IPluginConfigProvider _configProvider;
        private readonly string _logPrefix;

        public JellyseerrUserResolver(IHttpClientFactory httpClientFactory, ILogger logger, IPluginConfigProvider configProvider, string logPrefix)
        {
            _httpClientFactory = httpClientFactory;
            _logger = logger;
            _configProvider = configProvider;
            _logPrefix = logPrefix;
        }

        /// <summary>Splits the configured Jellyseerr URL list (newline/comma separated) into trimmed base URLs.</summary>
        public static string[] GetConfiguredUrls(string? urls)
        {
            return (urls ?? string.Empty)
                .Split(new[] { '\r', '\n', ',' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(url => url.Trim().TrimEnd('/'))
                .Where(url => !string.IsNullOrWhiteSpace(url))
                .ToArray();
        }

        /// <summary>Normalizes a Jellyfin user id for comparison (dashes removed, lowercase).</summary>
        public static string NormalizeUserId(string userId)
        {
            return userId.Replace("-", string.Empty).ToLowerInvariant();
        }

        private TimeSpan GetJellyseerrUserIdCacheTtl()
        {
            var minutes = _configProvider.ConfigurationOrNull?.JellyseerrUserIdCacheTtlMinutes ?? 30;
            return TimeSpan.FromMinutes(Math.Max(1, minutes));
        }

        // Gets the Jellyseerr user ID for a Jellyfin user
        public async Task<string?> GetJellyseerrUserId(string jellyfinUserId)
        {
            var config = _configProvider.ConfigurationOrNull;
            if (config == null || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.JellyseerrApiKey))
            {
                return null;
            }

            var normalizedJellyfinUserId = NormalizeUserId(jellyfinUserId);

            lock (_userIdCacheLock)
            {
                if (_jellyseerrUserIdCache.TryGetValue(normalizedJellyfinUserId, out var cached) &&
                    DateTime.UtcNow - cached.CachedAt < GetJellyseerrUserIdCacheTtl())
                {
                    return cached.JellyseerrUserId;
                }
            }

            var urls = GetConfiguredUrls(config.JellyseerrUrls);
            var httpClient = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);

            foreach (var url in urls)
            {
                try
                {
                    var requestUri = $"{url.Trim().TrimEnd('/')}/api/v1/user?take=1000";
                    using var request = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(
                        HttpMethod.Get, requestUri, config.JellyseerrApiKey);
                    using var response = await httpClient.SendAsync(request);
                    var (content, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, requestUri);

                    if (error == null && content != null)
                    {
                        var usersResponse = JsonSerializer.Deserialize<JsonElement>(content);

                        if (usersResponse.TryGetProperty("results", out var usersArray))
                        {
                            foreach (var userElement in usersArray.EnumerateArray())
                            {
                                if (userElement.TryGetProperty("jellyfinUserId", out var jfUserId) &&
                                    userElement.TryGetProperty("id", out var id))
                                {
                                    var jellyseerrJfUserId = jfUserId.GetString();
                                    if (!string.IsNullOrEmpty(jellyseerrJfUserId))
                                    {
                                        // Normalize both IDs for comparison (remove dashes)
                                        var normalizedJellyseerrId = jellyseerrJfUserId.Replace("-", "").ToLowerInvariant();

                                        if (normalizedJellyseerrId == normalizedJellyfinUserId)
                                        {
                                            var jellyseerrUserId = id.GetInt32().ToString();
                                            lock (_userIdCacheLock)
                                            {
                                                _jellyseerrUserIdCache[normalizedJellyfinUserId] = (jellyseerrUserId, DateTime.UtcNow);
                                            }
                                            return jellyseerrUserId;
                                        }
                                    }
                                }
                            }
                            _logger.LogWarning($"{_logPrefix} No Jellyseerr user found for Jellyfin user {jellyfinUserId}");
                        }
                    }
                    else if (error != null)
                    {
                        _logger.LogWarning($"{_logPrefix} Failed to fetch users from Jellyseerr: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay} — {error.Message}");
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogError($"{_logPrefix} Exception while trying to get Jellyseerr user ID from {url}: {ex.Message}");
                }
            }

            return null;
        }
    }
}
